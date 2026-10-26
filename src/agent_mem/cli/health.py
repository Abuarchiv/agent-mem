"""``agent-mem status`` and ``agent-mem doctor``."""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import sqlite3
import stat
import sys
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from agent_mem.cli.install import claude_home, codex_home, copilot_home, opencode_home
from agent_mem.core import db, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.core.harness import HARNESS_NAMES, HARNESSES
from agent_mem.memory import work

HARNESS_MARKERS = {
    "claude": [claude_home() / "plugins", claude_home() / "settings.json"],
    "codex": [codex_home() / "plugins", codex_home() / "hooks.json", codex_home() / "config.toml"],
    "copilot": [copilot_home() / "plugins", copilot_home() / "hooks"],
}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    fix: str | None = None
    warn_only: bool = False


def _mentions(path: Path, needle: re.Pattern[str], max_files: int = 400) -> bool:
    if path.is_file():
        with contextlib.suppress(OSError):
            return bool(needle.search(path.read_text(encoding="utf-8", errors="ignore")))
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
            if candidate.stat().st_size < 1_000_000 and needle.search(
                candidate.read_text(encoding="utf-8", errors="ignore")
            ):
                return True
    return False


# On Windows the command is `...\agent-mem.exe hook claude`; a path with spaces is quoted ("…/agent-mem" hook).
_HOOK_COMMAND = re.compile(r"agent-mem(?:\.exe)?['\"]? hook")


def harness_installed(harness: str) -> bool:
    if harness == "opencode":  # read now: XDG_CONFIG_HOME moves its folder
        return _mentions(opencode_home(), re.compile("agent-mem"))
    return any(_mentions(path, _HOOK_COMMAND) for path in HARNESS_MARKERS[harness])


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

    today = timeutil.iso()[:10]
    calls: dict[str, tuple[int, int, str]] = {}
    with contextlib.suppress(sqlite3.OperationalError):  # observer tables come with migration 002
        for row in conn.execute(
            "SELECT provider, SUM(ok), SUM(NOT ok), MAX(ts) FROM observe_calls WHERE ts >= ? GROUP BY provider",
            (today,),
        ):
            calls[row[0]] = (int(row[1] or 0), int(row[2] or 0), row[3])
    rows = []
    for name in HARNESSES:
        stage = fact_stage(conn, config, name)
        ok, failed, last = calls.get(stage["stage"] or "", (0, 0, None))
        rows.append(
            {
                "harness": name,
                "label": HARNESS_NAMES[name],
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
        "consolidated_at": db.get_meta(conn, "consolidated_at"),
        "components": harnesses,
        "config_warnings": config.warnings,
        "injected": _injected(conn),
    }


def _injected(conn: sqlite3.Connection, days: int = 7) -> dict[str, Any]:
    """Blocks and estimated tokens injected into sessions today and over the last ``days`` days, the measured agent
    work behind what they named, each memory once (memory/work.py), and all work the memory was built from."""
    today = timeutil.now()
    since = (today - timedelta(days=days - 1)).date().isoformat()
    blocks = total = today_tokens = today_work = 0
    for row in conn.execute(
        "SELECT key, value FROM meta WHERE key >= ? AND key LIKE 'injected:%'", (f"injected:{since}",)
    ):
        n, tokens, behind = [*(int(x) for x in row["value"].split(",")), 0][:3]  # older days have no work column
        blocks, total = blocks + n, total + tokens
        if row["key"] == f"injected:{today.date().isoformat()}":
            today_tokens, today_work = tokens, behind
    sessions = int(conn.execute("SELECT COUNT(*) FROM sessions WHERE started_at >= ?", (since,)).fetchone()[0])
    spent = work.reused(conn, since)
    turns, built = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(work_tokens), 0) FROM turns WHERE work_tokens IS NOT NULL"
    ).fetchone()
    return {
        "today_tokens": today_tokens,
        "today_work": today_work,
        "days": days,
        "blocks": blocks,
        "tokens": total,
        "tokens_per_session": round(total / sessions) if sessions else None,
        "work": spent,
        "saved_percent": (spent - total) * 100 // spent if spent > total else None,  # floor: 99.9 is not 100
        "measured_turns": int(turns),
        "built_from": int(built),
    }


def doctor(config: Config, *, fix: bool = False) -> list[Check]:
    checks = _install_checks(config, fix)
    try:
        conn = db.connect(config)
    except db.SchemaTooNewError as error:
        checks.append(Check("database", False, str(error), "Run `agent-mem upgrade`."))
        return checks
    except db.MigrationInProgressError as error:
        checks.append(Check("database", False, f"migration in progress: {error}", "Run `agent-mem doctor` again."))
        return checks
    except sqlite3.Error as error:
        checks.append(
            Check(
                "database",
                False,
                str(error),
                "Run `agent-mem index`: it keeps the damaged file as memory.db.corrupt-<time> and starts a new one.",
            )
        )
        return checks
    try:
        checks += _database_checks(conn, config)
        checks += _capture_checks(conn)
        checks += _housekeeping_checks(conn, config, fix)
        checks += _observer_checks(conn, config)
    finally:
        conn.close()
    checks.extend(_hook_checks(fix))
    record_setup_health(config)
    checks.extend(_viewer_checks(config, fix))
    if fix:
        from agent_mem.memory import indexer

        with contextlib.suppress(Exception):
            indexer.run(config, allow_download=False)
    return checks


def _install_checks(config: Config, fix: bool) -> list[Check]:
    """Python, the binary on PATH, a private data directory, disk space and the config file."""
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
            "agent-mem command",
            on_path is not None,
            on_path or "not found",
            'Install with the install script or `uv tool install "agent-mem[semantic] @ git+https://github.com/Abuarchiv/agent-mem"` so hooks can call it.',
        )
    )
    db.ensure_private_dir(config.data_dir)
    if fix and sys.platform != "win32":
        for folder in (config.data_dir, config.spool_dir, config.log_dir):
            if folder.exists():
                with contextlib.suppress(OSError):
                    os.chmod(folder, 0o700)
    if sys.platform != "win32":
        mode = stat.S_IMODE(config.data_dir.stat().st_mode)
        checks.append(
            Check(
                "data folder private",
                mode & 0o077 == 0,
                str(config.data_dir),
                "Run `agent-mem doctor --fix` or chmod 700 the data folder.",
            )
        )
    free_mb = shutil.disk_usage(config.data_dir).free / 1_000_000
    checks.append(Check("disk space", free_mb > 200, f"{free_mb:.0f} MB free", "Free disk space."))
    for warning in config.warnings:
        checks.append(Check("config", False, warning, f"Edit {config.config_path}.", warn_only=True))
    return checks


def _database_checks(conn: sqlite3.Connection, config: Config) -> list[Check]:
    """Integrity, full-text search and the embedding model."""
    checks: list[Check] = []
    ok = db.quick_check(conn)
    checks.append(
        Check(
            "database integrity",
            ok,
            "ok" if ok else "damaged",
            "Run `agent-mem index`: it keeps the damaged file as memory.db.corrupt-<time> and starts a new one.",
        )
    )
    try:
        conn.execute("SELECT count(*) FROM search_fts").fetchone()
        checks.append(Check("word search", True, "available"))
    except sqlite3.Error as error:
        checks.append(Check("word search", False, str(error), "Use a Python with SQLite 3.34 or newer."))
    from agent_mem.memory import semantic

    embedder, reason = semantic.load_embedder_verbose(config)
    checks.append(
        Check(
            "search by meaning",
            embedder is not None,
            "ready" if embedder else str(reason),
            "Run `agent-mem models install`. Word search works without it.",
            warn_only=True,
        )
    )
    return checks


def _capture_checks(conn: sqlite3.Connection) -> list[Check]:
    """Whether each agent that is installed here has delivered events, and its last error."""
    checks: list[Check] = []
    for harness in HARNESSES:
        installed_here = harness_installed(harness)
        row = conn.execute("SELECT * FROM health WHERE component = ?", (f"hook:{harness}",)).fetchone()
        if not installed_here and row is None:
            continue
        if row is None:
            hint = (
                "Start a session. For Codex, trust the hooks with /hooks."
                if harness == "codex"
                else f"Start a session in {HARNESS_NAMES.get(harness, harness)}."
            )
            checks.append(
                Check(
                    f"{HARNESS_NAMES[harness]} recording",
                    False,
                    "connected, nothing recorded yet",
                    hint,
                    warn_only=True,
                )
            )
            continue
        if not installed_here:
            # Recorded once, hooks gone since (removed by hand or by another tool rewriting the settings).
            checks.append(
                Check(
                    f"{HARNESS_NAMES[harness]} recording",
                    False,
                    f"off, no agent-mem hooks; last {timeutil.local(row['last_ok_at'])}",
                    f"Run `agent-mem setup {harness} --write` to record it again.",
                    warn_only=True,
                )
            )
            continue
        failing = row["last_error_at"] and (not row["last_ok_at"] or row["last_error_at"] > row["last_ok_at"])
        checks.append(
            Check(
                f"{HARNESS_NAMES[harness]} recording",
                not failing,
                f"last {timeutil.local(row['last_ok_at'])}" + (f" (last: {row['last_error']})" if failing else ""),
                "See logs/hook.log in the data folder (`agent-mem paths`).",
            )
        )
    return checks


def _housekeeping_checks(conn: sqlite3.Connection, config: Config, fix: bool) -> list[Check]:
    """Spool backlog, backups left by older releases (deleted with ``fix``) and the indexer's last run."""
    checks: list[Check] = []
    backlog = spool.count(config.spool_dir)
    checks.append(
        Check(
            "events not saved yet",
            backlog == 0,
            str(backlog),
            "Run `agent-mem index` (or doctor --fix).",
            warn_only=backlog < 1000,
        )
    )
    if config.backup_dir.exists():
        if fix:
            shutil.rmtree(config.backup_dir, ignore_errors=True)
        gone = not config.backup_dir.exists()
        checks.append(
            Check(
                "old backups",
                gone,
                "deleted" if gone else f"{config.backup_dir} left by an older release",
                "Run `agent-mem doctor --fix` to delete it.",
                warn_only=True,
            )
        )
    indexer = conn.execute("SELECT last_ok_at, last_error FROM health WHERE component = 'indexer'").fetchone()
    checks.append(
        Check(
            "search index",
            indexer is not None and indexer["last_ok_at"] is not None,
            f"last update {timeutil.local(indexer['last_ok_at'] if indexer else None)}",
            "Run `agent-mem index`.",
            warn_only=True,
        )
    )
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
                "viewer starts at login",
                login.exists(),
                "yes" if login.exists() else "no; it starts with the first agent session",
                "Run `agent-mem serve --autostart` or `agent-mem doctor --fix`.",
                warn_only=True,
            )
        )
    return checks


def _observer_checks(conn: sqlite3.Connection, config: Config) -> list[Check]:
    """Observer extra, queue, last worker run, providers, index size."""
    from agent_mem.cli import install

    if not install.extras()["observer"]:
        return [
            Check(
                "facts",
                False,
                "not installed; requests are saved word for word, no facts are written",
                "Install `agent-mem[observer]` to get facts from your requests.",
                warn_only=True,
            )
        ]
    if not config.observe.enabled:
        return [Check("facts", True, "off in config.json")]
    try:
        queue = _observer_queue_check(conn)
    except sqlite3.OperationalError as error:
        return [_missing_queue_check(conn, error)]
    checks = [queue, _provider_check(conn, config), _entity_model_check(config)]
    index = _fact_index_check(conn, config)
    return [*checks, index] if index else checks


def _missing_queue_check(conn: sqlite3.Connection, error: sqlite3.Error) -> Check:
    # The schema says current but the table is missing: a foreign or hand-edited database.
    return Check(
        "facts queue",
        False,
        f"{error}; database version {db.user_version(conn)} without the facts tables",
        "Move the data folder aside (`agent-mem paths` shows where); agent-mem then starts a new one.",
    )


def _observer_queue_check(conn: sqlite3.Connection) -> Check:
    states = dict(conn.execute("SELECT state, COUNT(*) FROM observe_queue GROUP BY state").fetchall())
    pending, failed = int(states.get("pending", 0)), int(states.get("failed", 0))
    last = conn.execute("SELECT ts, provider, ok FROM observe_calls ORDER BY id DESC LIMIT 1").fetchone()
    detail = f"{pending} waiting, {states.get('done', 0)} done, {states.get('raw', 0)} without facts, {failed} failed"
    detail += f"; last run {timeutil.local(last['ts'])} via {last['provider']}" if last else ""
    return Check(
        "facts queue",
        failed == 0 and pending < 200,
        detail,
        "Run `agent-mem observe --status`, then `agent-mem observe --retry-failed`.",
        warn_only=True,
    )


def _provider_check(conn: sqlite3.Connection, config: Config) -> Check:
    """Which harness CLIs can run the observer, with their model and any pause after a quota or login error."""
    from agent_mem.observe import providers

    stages = [name for name in config.observe.providers if shutil.which(name)]
    now = timeutil.iso()
    shown = []
    logged_out = []
    for name in stages:
        until = providers.paused_until(conn, name)
        paused = ""
        if until and until > now:
            login = db.get_meta(conn, f"observe.pause_kind.{name}") == "login"
            paused = f", not logged in, retry at {until}" if login else f", usage limit, paused until {until}"
            logged_out += [name] if login else []
        shown.append(f"{name} ({providers.model_for(config, name) or 'CLI default'}{paused})")
    remedy = 'Install Claude Code, Codex, Copilot CLI or OpenCode, or add "ollama" to observe.providers.'
    if logged_out:
        from agent_mem.core import config as config_module

        remedy = config_module.login_hint(logged_out)
    return Check(
        "facts model",
        bool(stages) and not logged_out,
        ", ".join(shown) if stages else f"none installed of {', '.join(config.observe.providers)}",
        remedy,
        warn_only=True,
    )


def _entity_model_check(config: Config) -> Check:
    from agent_mem.observe import mem0_adapter, spacy_model

    model = config.observe.entity_model
    present = spacy_model.model_path(config) is not None or mem0_adapter.spacy_model_available(model)
    return Check(
        "topic links",
        present,
        f"ready ({model})" if present else f"{model} missing; facts work without topic links",
        "Run `agent-mem models install`. Set `observe.entity_model` to the language of your facts "
        "(de_core_news_sm, en_core_web_sm, ...).",
        warn_only=True,
    )


def _fact_index_check(conn: sqlite3.Connection, config: Config) -> Check | None:
    qdrant = config.mem0_dir / "qdrant"
    if not qdrant.exists():
        return None
    size_mb = sum(p.stat().st_size for p in qdrant.rglob("*") if p.is_file()) / 1_000_000
    facts = int(conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'fact' AND invalid_at IS NULL").fetchone()[0])
    return Check(
        "fact store",
        facts < 50_000,
        f"{facts} facts, {size_mb:.0f} MB",
        "Run `agent-mem purge --before` to trim old facts.",
        warn_only=True,
    )


def record_setup_health(config: Config) -> None:
    """Hooks may not import ``cli``, so the indexer they spawn (and ``doctor``) notes hooks an older release wrote,
    e.g. after a plain ``uv tool upgrade``; the session-start panel shows failing ``health`` rows."""
    from agent_mem.cli import install

    with contextlib.suppress(OSError, ValueError, sqlite3.Error):
        conn = db.connect(config)
        try:
            for harness in HARNESSES:
                if install.hook_commands(harness):
                    stale = install.stale(harness)
                    error = "hooks come from an older agent-mem release (`agent-mem doctor --fix` rewrites them)"
                    db.record_health(conn, f"setup:{harness}", error if stale else None)
        finally:
            conn.close()


def _hook_checks(fix: bool) -> list[Check]:
    """Hook commands point at an existing binary and match this release."""
    from agent_mem.cli import install

    checks: list[Check] = []
    for harness in HARNESSES:
        commands = install.hook_commands(harness)
        if not commands:
            continue
        exe = install.hook_binary(commands[0])
        fixed = False
        if fix and (install.stale(harness) or not Path(exe).is_file()):
            # The path they already use (a checkout's `uv run` must not take them over), unless it is gone.
            install.write(harness, install.plugins_dir(), exe if Path(exe).is_file() else None)
            commands, fixed = install.hook_commands(harness), True
        if harness == "claude" and install.claude_plugin_enabled():
            checks.append(
                Check(
                    "Claude Code connected once",
                    False,
                    "hooks in settings.json and the agent-mem plugin both run on every event",
                    "Keep one: `agent-mem uninstall claude`, or `/plugin uninstall agent-mem@agent-mem` in Claude Code.",
                )
            )
        stale = install.stale(harness)
        detail = "yes" + (", rewritten" if fixed else "")
        if fixed and harness == "codex":
            detail += "; trust them again in Codex with /hooks"
        checks.append(
            Check(
                f"{HARNESS_NAMES[harness]} hooks up to date",
                not stale,
                "from an older agent-mem release (events, matchers or timeouts changed)" if stale else detail,
                "Run `agent-mem doctor --fix`.",
            )
        )
        # Copilot names the event in each command: one line per binary, not one per event.
        by_binary: dict[str, list[str]] = {}
        for command in commands:
            by_binary.setdefault(install.hook_binary(command), []).append(command)
        for exe, same in by_binary.items():
            resolved = Path(exe) if os.path.isabs(exe) else Path(shutil.which(exe) or "")
            command = same[0] if len(same) == 1 else f"{exe} hook {harness} ({len(same)} events)"
            checks.append(
                Check(
                    f"{HARNESS_NAMES[harness]} hook command",
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
