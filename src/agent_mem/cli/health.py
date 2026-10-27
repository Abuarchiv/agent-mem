"""``agent-mem doctor``: checks with a fix for each failure."""

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

from agent_mem.core import db, logutil, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.core.harness import HARNESS_NAMES, HARNESSES
from agent_mem.core.signals import first_line
from agent_mem.ui.status import harness_installed


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    fix: str | None = None
    warn_only: bool = False


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

        try:
            indexer.run(config, allow_download=False)
        except Exception as error:  # the indexer records it in health too; doctor shows it instead of crashing
            checks.append(Check("index after fix", False, logutil.describe(error), "Run `agent-mem index`."))
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
    from agent_mem.ui import autostart, server

    if not config.viewer.enabled:
        return [Check("viewer", True, "disabled in config.json")]
    login = autostart.autostart_path()
    if fix and (login is None or not login.exists()):
        autostart.install_autostart(config)
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


FAILED_CALLS = 3
# Codex and Copilot run only when the stages before them fail, often in the same outage: older failures say
# nothing about now (both answered again in the evening of calls that failed in the morning).
FAILED_HOURS = 6


def _provider_check(conn: sqlite3.Connection, config: Config) -> Check:
    """Which harness CLIs can run the observer, with their model and any pause after a quota or login error."""
    from agent_mem.observe import providers

    stages = [name for name in config.observe.providers if shutil.which(name)]
    now = timeutil.iso()
    shown = []
    logged_out = []
    failing = []
    for name in stages:
        until = providers.paused_until(conn, name)
        paused = ""
        if until and until > now:
            kind = db.get_meta(conn, f"observe.pause_kind.{name}")
            login = kind == "login"
            reason = {"login": "not logged in, retry at", "timeout": "no answer twice, paused until"}
            paused = f", {reason.get(kind or '', 'usage limit, paused until')} {until}"
            logged_out += [name] if login else []
        # A pause runs out and an error that is no limit (Codex: "workspace routing discovery failed") never pauses:
        # a CLI that failed its last calls stayed green while every turn fell through to the next stage.
        last = conn.execute(
            "SELECT ok, error FROM observe_calls WHERE provider = ? AND ts >= ? ORDER BY id DESC LIMIT ?",
            (name, timeutil.iso(timeutil.now() - timedelta(hours=FAILED_HOURS)), FAILED_CALLS),
        ).fetchall()
        if not paused and len(last) == FAILED_CALLS and not any(row["ok"] for row in last):
            lines = [line.strip() for line in str(last[0]["error"] or "").splitlines() if line.strip()]
            paused = f", last {FAILED_CALLS} calls failed: {first_line(lines[-1] if lines else 'no message', 80)}"
            failing.append(name)
        shown.append(f"{name} ({providers.model_for(config, name) or 'CLI default'}{paused})")
    remedy = 'Install Claude Code, Codex, Copilot CLI or OpenCode, or add "ollama" to observe.providers.'
    if failing:
        remedy = "Start " + " and ".join(f"`{name}`" for name in failing) + " once and check that it answers."
    if logged_out:
        from agent_mem.core import config as config_module

        remedy = config_module.login_hint(logged_out)
    return Check(
        "facts model",
        bool(stages) and not logged_out and not failing,
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
