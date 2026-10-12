"""``agent-mem status`` and ``agent-mem doctor``."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sqlite3
import stat
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from agent_mem.cli.install import claude_home, codex_home
from agent_mem.core import db, spool, timeutil
from agent_mem.core.config import Config

HARNESS_MARKERS = {
    "claude": [claude_home() / "plugins", claude_home() / "settings.json"],
    "codex": [codex_home() / "plugins", codex_home() / "hooks.json", codex_home() / "config.toml"],
    "copilot": [Path.home() / ".copilot" / "plugins", Path.home() / ".copilot" / "hooks"],
    "opencode": [Path.home() / ".config" / "opencode"],
}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    fix: str | None = None
    warn_only: bool = False


def _mentions(path: Path, needle: str, max_files: int = 400) -> bool:
    if path.is_file():
        with contextlib.suppress(OSError):
            return needle in path.read_text(encoding="utf-8", errors="ignore")
        return False
    if not path.is_dir():
        return False
    count = 0
    for candidate in path.rglob("*"):
        if candidate.suffix.lower() not in {".json", ".toml", ".ts", ".js", ".jsonc"} or not candidate.is_file():
            continue
        count += 1
        if count > max_files:
            break
        with contextlib.suppress(OSError):
            if candidate.stat().st_size < 1_000_000 and needle in candidate.read_text(
                encoding="utf-8", errors="ignore"
            ):
                return True
    return False


def harness_installed(harness: str) -> bool:
    needle = "agent-mem hook" if harness != "opencode" else "agent-mem"
    return any(_mentions(path, needle) for path in HARNESS_MARKERS[harness])


LABELS = {"claude": "Claude Code", "codex": "Codex", "copilot": "Copilot CLI", "opencode": "OpenCode"}


def fact_stage(conn: sqlite3.Connection, config: Config, harness: str) -> dict[str, Any]:
    """Which model turns from ``harness`` go to for facts, and whether it is paused."""
    found = config.observe.stage_for(harness)
    paused = db.get_meta(conn, f"observe.pause.{found[0]}") if found else None
    return {
        "stage": found[0] if found else None,
        "model": found[1] if found else None,
        "paused_until": paused if paused and paused > timeutil.iso() else None,
        "enabled": config.observe.enabled,
    }


def agents(conn: sqlite3.Connection, config: Config) -> list[dict[str, Any]]:
    """One row per harness for the viewer: connected, CLI on PATH, fact model, today's fact runs."""
    from agent_mem.cli import install

    today = timeutil.iso()[:10]
    calls: dict[str, tuple[int, int, str]] = {}
    with contextlib.suppress(sqlite3.OperationalError):  # observer tables come with migration 002
        for row in conn.execute(
            "SELECT provider, SUM(ok), SUM(NOT ok), MAX(ts) FROM observe_calls WHERE ts >= ? GROUP BY provider",
            (today,),
        ):
            calls[row[0]] = (int(row[1] or 0), int(row[2] or 0), row[3])
    rows = []
    for name in install.HARNESSES:
        stage = fact_stage(conn, config, name)
        ok, failed, last = calls.get(stage["stage"] or "", (0, 0, None))
        rows.append(
            {
                "harness": name,
                "label": LABELS[name],
                "cli": shutil.which(name) is not None,
                "connected": harness_installed(name),
                **stage,
                "facts_ok_today": ok,
                "facts_failed_today": failed,
                "last_fact_at": last,
            }
        )
    return rows


def quarantine_latest(config: Config) -> dict[str, Any] | None:
    """The newest record set aside, so the viewer can say what it was instead of only a count."""
    files = sorted(config.quarantine_dir.glob("*.json")) if config.quarantine_dir.exists() else []
    if not files:
        return None
    with contextlib.suppress(OSError, ValueError):
        record = json.loads(files[-1].read_text(encoding="utf-8"))
        event = record.get("event") if isinstance(record.get("event"), dict) else {}
        reason = record.get("reason") or (
            f"a saved {event.get('harness', '')} {event.get('kind', 'event')} could not be replayed" if event else ""
        )
        return {"ts": record.get("ts") or event.get("ts"), "reason": str(reason or record.get("type") or "")[:160]}
    return None


def status(conn: sqlite3.Connection, config: Config) -> dict[str, Any]:
    def count(sql: str) -> int:
        return int(conn.execute(sql).fetchone()[0])

    harnesses = {}
    for row in conn.execute(
        "SELECT component, last_ok_at, last_error_at, last_error, ok_count, error_count FROM health"
    ):
        harnesses[row["component"]] = {k: v for k, v in dict(row).items() if k != "component"}
    recurrences = count("SELECT COALESCE(SUM(recurrences), 0) FROM recipes")
    fixes = count("SELECT COALESCE(SUM(successes), 0) FROM recipes")
    return {
        "data_dir": str(config.data_dir),
        "db_mb": round(config.db_path.stat().st_size / 1_000_000, 2) if config.db_path.exists() else 0,
        "schema": db.user_version(conn),
        "projects": count("SELECT COUNT(*) FROM projects"),
        "sessions": count("SELECT COUNT(*) FROM sessions"),
        "turns": count("SELECT COUNT(*) FROM turns"),
        "memories": count("SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL"),
        "vectors": count("SELECT COUNT(*) FROM vectors"),
        "recipes": count("SELECT COUNT(*) FROM recipes"),
        "rules_enabled": count("SELECT COUNT(*) FROM rules WHERE enabled = 1"),
        "rules_proposed": count("SELECT COUNT(*) FROM rules WHERE enabled = 0"),
        "learning": {
            "errors_fixed": fixes,
            "known_errors_recurred": recurrences,
            "repetition_rate": round(recurrences / (recurrences + fixes), 3) if recurrences + fixes else None,
        },
        "semantic": db.get_meta(conn, "semantic") or "not indexed yet",
        "paused_until": db.get_meta(conn, "paused_until"),
        "spool": spool.count(config.spool_dir),
        "quarantine": len(list(config.quarantine_dir.glob("*.json"))) if config.quarantine_dir.exists() else 0,
        "last_backup_at": db.get_meta(conn, "last_backup_at"),
        "consolidated_at": db.get_meta(conn, "consolidated_at"),
        "components": harnesses,
        "config_warnings": config.warnings,
        "injected": _injected(conn),
    }


def _injected(conn: sqlite3.Connection, days: int = 7) -> dict[str, Any]:
    """Blocks and estimated tokens injected into sessions today and over the last ``days`` days."""
    today = timeutil.now()
    since = (today - timedelta(days=days - 1)).date().isoformat()
    blocks = total = today_tokens = 0
    for row in conn.execute(
        "SELECT key, value FROM meta WHERE key >= ? AND key LIKE 'injected:%'", (f"injected:{since}",)
    ):
        n, tokens = (int(x) for x in row["value"].split(","))
        blocks, total = blocks + n, total + tokens
        if row["key"] == f"injected:{today.date().isoformat()}":
            today_tokens = tokens
    sessions = int(conn.execute("SELECT COUNT(*) FROM sessions WHERE started_at >= ?", (since,)).fetchone()[0])
    return {
        "today_tokens": today_tokens,
        "days": days,
        "blocks": blocks,
        "tokens": total,
        "tokens_per_session": round(total / sessions) if sessions else None,
    }


def doctor(config: Config, *, fix: bool = False) -> list[Check]:
    checks: list[Check] = []
    checks.append(
        Check(
            "python",
            sys.version_info >= (3, 11),
            sys.version.split()[0],
            "Install Python 3.11+ (uv installs it for you).",
        )
    )
    on_path = shutil.which("agent-mem")
    checks.append(
        Check(
            "agent-mem on PATH",
            on_path is not None,
            on_path or "not found",
            'Install with the install script or `uv tool install "agent-mem[semantic] @ git+https://github.com/Abuarchiv/agent-mem"` so hooks can call it.',
        )
    )
    db.ensure_private_dir(config.data_dir)
    if fix and sys.platform != "win32":
        for folder in (config.data_dir, config.spool_dir, config.backup_dir, config.log_dir):
            if folder.exists():
                with contextlib.suppress(OSError):
                    os.chmod(folder, 0o700)
    if sys.platform != "win32":
        mode = stat.S_IMODE(config.data_dir.stat().st_mode)
        checks.append(
            Check(
                "data dir private",
                mode & 0o077 == 0,
                f"{config.data_dir} ({oct(mode)})",
                "Run `agent-mem doctor --fix` or chmod 700 the data directory.",
            )
        )
    free_mb = shutil.disk_usage(config.data_dir).free / 1_000_000
    checks.append(Check("disk space", free_mb > 200, f"{free_mb:.0f} MB free", "Free disk space."))
    for warning in config.warnings:
        checks.append(Check("config", False, warning, f"Edit {config.config_path}.", warn_only=True))
    try:
        conn = db.connect(config)
    except db.SchemaTooNewError as error:
        checks.append(Check("database", False, str(error), "Upgrade agent-mem (`uv tool upgrade agent-mem`)."))
        return checks
    except db.MigrationInProgressError as error:
        checks.append(Check("database", False, f"migration in progress: {error}", "Run `agent-mem doctor` again."))
        return checks
    except sqlite3.Error as error:
        checks.append(Check("database", False, str(error), "Run `agent-mem restore --latest`."))
        return checks
    try:
        ok = db.quick_check(conn)
        checks.append(
            Check(
                "database integrity",
                ok,
                f"schema v{db.user_version(conn)}, sqlite {sqlite3.sqlite_version}",
                "Run `agent-mem restore --latest`.",
            )
        )
        try:
            conn.execute("SELECT count(*) FROM search_fts").fetchone()
            checks.append(Check("full-text search (FTS5 trigram)", True, "available"))
        except sqlite3.Error as error:
            checks.append(
                Check("full-text search (FTS5 trigram)", False, str(error), "Use a Python with SQLite ≥ 3.34.")
            )
        from agent_mem.memory import semantic

        embedder, reason = semantic.load_embedder_verbose(config)
        checks.append(
            Check(
                "semantic search",
                embedder is not None,
                f"model {embedder.model} ready" if embedder else str(reason),
                "Run `agent-mem models install`. Lexical search works without it.",
                warn_only=True,
            )
        )
        for harness in ("claude", "codex", "copilot", "opencode"):
            installed_here = harness_installed(harness)
            row = conn.execute("SELECT * FROM health WHERE component = ?", (f"hook:{harness}",)).fetchone()
            if not installed_here and row is None:
                continue
            if row is None:
                hint = (
                    "Start a session. For Codex, trust the hooks with /hooks."
                    if harness == "codex"
                    else "Start a session in this harness."
                )
                checks.append(
                    Check(f"{harness} capture", False, "plugin found, nothing captured yet", hint, warn_only=True)
                )
                continue
            failing = row["last_error_at"] and (not row["last_ok_at"] or row["last_error_at"] > row["last_ok_at"])
            checks.append(
                Check(
                    f"{harness} capture",
                    not failing,
                    f"last ok {row['last_ok_at'] or 'never'}; errors {row['error_count']}"
                    + (f" (last: {row['last_error']})" if failing else ""),
                    "See logs in the data dir (logs/hook.log).",
                )
            )
        backlog = spool.count(config.spool_dir)
        checks.append(
            Check(
                "spool",
                backlog == 0,
                f"{backlog} pending",
                "Run `agent-mem index` (or doctor --fix).",
                warn_only=backlog < 1000,
            )
        )
        last_backup = db.get_meta(conn, "last_backup_at")
        fresh = last_backup is not None and timeutil.hours_between(last_backup) < 72
        checks.append(
            Check("backup", fresh, f"last {last_backup or 'never'}", "Run `agent-mem backup`.", warn_only=True)
        )
        indexer = conn.execute("SELECT last_ok_at, last_error FROM health WHERE component = 'indexer'").fetchone()
        checks.append(
            Check(
                "indexer",
                indexer is not None and indexer["last_ok_at"] is not None,
                f"last run {indexer['last_ok_at'] if indexer else 'never'}",
                "Run `agent-mem index`.",
                warn_only=True,
            )
        )
        checks.extend(_observer_checks(conn, config))
    finally:
        conn.close()
    checks.extend(_hook_checks())
    checks.extend(_viewer_checks(config, fix))
    if fix:
        from agent_mem.memory import indexer

        with contextlib.suppress(Exception):
            indexer.run(config, allow_download=False)
    return checks


def _viewer_checks(config: Config, fix: bool) -> list[Check]:
    from agent_mem.ui import server

    if not config.viewer.enabled:
        return [Check("viewer", True, "disabled in config.json")]
    login = server.autostart_path()
    if fix and (login is None or not login.exists()):
        server.install_autostart(config)
    up = server.running(config)
    checks = [
        Check(
            "viewer",
            up,
            server.url(config) if up else f"nothing answers on {server.url(config)}",
            "Run `agent-mem view` (starts it); `agent-mem serve` shows why it cannot start.",
            warn_only=True,
        )
    ]
    if login is not None:
        checks.append(
            Check(
                "viewer autostart",
                login.exists(),
                str(login) if login.exists() else "not registered; the viewer starts with the first agent session",
                "Run `agent-mem serve --autostart` or `agent-mem doctor --fix`.",
                warn_only=True,
            )
        )
    return checks


def _observer_checks(conn: sqlite3.Connection, config: Config) -> list[Check]:
    """docs/PLAN.md §14 I5: observer extra, queue, last worker run, providers, index size."""
    from agent_mem.cli import install

    checks: list[Check] = []
    if not install.extras()["observer"]:
        checks.append(
            Check(
                "observer",
                False,
                "extra not installed; turns are stored raw, no facts",
                "Install `agent-mem[observer]` for background fact extraction.",
                warn_only=True,
            )
        )
        return checks
    if not config.observe.enabled:
        checks.append(Check("observer", True, "disabled in config.json"))
        return checks
    try:
        states = dict(conn.execute("SELECT state, COUNT(*) FROM observe_queue GROUP BY state").fetchall())
    except sqlite3.OperationalError as error:  # schema says current, table missing: a foreign or hand-edited database
        checks.append(
            Check(
                "observer queue",
                False,
                f"{error}; schema v{db.user_version(conn)} without the observer tables",
                "Move the data directory aside (`agent-mem paths`) or run `agent-mem restore --latest`; the queue table is created by migration 002.",
            )
        )
        return checks
    pending, failed = int(states.get("pending", 0)), int(states.get("failed", 0))
    last = conn.execute("SELECT ts, provider, ok FROM observe_calls ORDER BY id DESC LIMIT 1").fetchone()
    detail = f"queue pending {pending}, done {states.get('done', 0)}, raw {states.get('raw', 0)}, failed {failed}"
    detail += f"; last call {last['ts']} via {last['provider']}" if last else "; no model call yet"
    checks.append(
        Check(
            "observer queue",
            failed == 0 and pending < 200,
            detail,
            "Run `agent-mem observe --status`, then `agent-mem observe --retry-failed`.",
            warn_only=True,
        )
    )
    from agent_mem.observe import providers

    stages = [n for n in config.observe.providers if shutil.which(n)]
    now = timeutil.iso()
    shown = []
    for name in stages:
        until = providers.paused_until(conn, name)
        paused = f", paused until {until}" if until and until > now else ""
        shown.append(f"{name} ({providers.model_for(config, name) or 'CLI default'}{paused})")
    checks.append(
        Check(
            "observer providers",
            bool(stages),
            ", ".join(shown) if stages else f"none of {config.observe.providers} on PATH",
            'Install a harness CLI (claude, codex, copilot) or add "ollama" to observe.providers.',
            warn_only=True,
        )
    )
    from agent_mem.observe import mem0_adapter

    model = config.observe.entity_model

    checks.append(
        Check(
            "entity linking",
            mem0_adapter.spacy_model_available(model),
            f"spaCy model {model} present; concepts feed the viewer's graph"
            if mem0_adapter.spacy_model_available(model)
            else f"spaCy model {model} missing; facts and search work, the graph of concepts stays empty",
            f"Install it into the tool: `uv tool install --with {model}@https://github.com/explosion/spacy-models/releases/download/{model}-3.8.0/{model}-3.8.0-py3-none-any.whl \"agent-mem[semantic,observer]\"`. Set `observe.entity_model` to the language of your facts (de_core_news_sm, en_core_web_sm, ...).",
            warn_only=True,
        )
    )
    qdrant = config.mem0_dir / "qdrant"
    if qdrant.exists():
        size_mb = sum(p.stat().st_size for p in qdrant.rglob("*") if p.is_file()) / 1_000_000
        facts = int(
            conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'fact' AND invalid_at IS NULL").fetchone()[0]
        )
        checks.append(
            Check(
                "fact index",
                facts < 50_000,
                f"{facts} facts, qdrant {size_mb:.0f} MB (opens in under a second up to about 20k facts)",
                "Run `agent-mem purge --before` to trim old facts.",
                warn_only=True,
            )
        )
    return checks


def _hook_checks() -> list[Check]:
    """docs/PLAN.md §14 I2/I5: hook commands point at an existing binary."""
    from agent_mem.cli import install

    checks: list[Check] = []
    for harness in install.HARNESSES:
        for command in install.hook_commands(harness):
            exe = command.split(" hook ", 1)[0]
            resolved = Path(exe) if os.path.isabs(exe) else Path(shutil.which(exe) or "")
            checks.append(
                Check(
                    f"{harness} hook command",
                    resolved.exists() and resolved.is_file(),
                    command if resolved.exists() else f"{command} (binary not found)",
                    f"Run `agent-mem setup {harness} --write` to rewrite the hooks with the current binary path.",
                )
            )
    return checks


def format_checks(checks: list[Check]) -> str:
    lines = []
    for check in checks:
        mark = "✓" if check.ok else ("!" if check.warn_only else "✗")
        line = f"{mark} {check.name}: {check.detail}"
        if not check.ok and check.fix:
            line += f"\n    → {check.fix}"
        lines.append(line)
    return "\n".join(lines)


def to_json(checks: list[Check]) -> str:
    return json.dumps([check.__dict__ for check in checks], indent=2)
