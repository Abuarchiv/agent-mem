"""Hook entry point: ``agent-mem hook <harness> [event]``.

Contract: never block the agent, never lose an event, never print invalid output.
The work runs in a worker thread with a hard deadline. If the deadline passes or the
database is unavailable, the event goes to the spool and the hook prints nothing.
Standard library only.
"""

from __future__ import annotations

import contextlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from typing import Any

from agent_mem.core import db, logutil, spool, timeutil
from agent_mem.core.config import Config, env_flag, load
from agent_mem.core.events import Event, PayloadError
from agent_mem.hooks import capture, inject
from agent_mem.hooks.normalize import normalize

INDEXER_THROTTLE_SECONDS = 60


def _read_stdin(limit: int, preread: bytes | None = None) -> str:
    data = sys.stdin.buffer.read(limit + 1) if preread is None else preread
    if len(data) > limit:
        raise PayloadError("payload too large")
    return data.decode("utf-8", errors="replace")


def render(harness: str, event: Event, response: capture.Response) -> dict[str, Any] | None:
    if harness in {"claude", "codex"}:
        if response.deny and event.kind == "pre_tool":
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": response.deny,
                }
            }
        if response.context and event.kind in {"session_start", "prompt", "pre_tool", "tool"}:
            return {"hookSpecificOutput": {"hookEventName": event.raw_kind, "additionalContext": response.context}}
        return None
    if harness == "copilot":
        if response.deny and event.kind == "pre_tool":
            return {"permissionDecision": "deny", "permissionDecisionReason": response.deny}
        if response.context:
            return {"additionalContext": response.context}
        return None
    if harness == "opencode":
        if response.deny or response.context:
            return {"context": response.context, "deny": response.deny}
        return None
    return None


def spawn_indexer(config: Config) -> bool:
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(config.data_dir), "AGENT_MEM_INTERNAL": "1"}
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "env": env,
    }
    if sys.platform == "win32":
        flags = 0
        for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
            flags |= getattr(subprocess, name, 0)
        kwargs["creationflags"] = flags
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([sys.executable, "-m", "agent_mem", "index", "--quiet"], **kwargs)
    except OSError:
        return False
    return True


def _maybe_spawn(conn: sqlite3.Connection, config: Config, wanted: bool) -> None:
    if not wanted and spool.count(config.spool_dir) == 0:
        return
    last = db.get_meta(conn, "indexer_spawned_at")
    if last and timeutil.hours_between(last) * 3600 < INDEXER_THROTTLE_SECONDS:
        return
    db.set_meta(conn, "indexer_spawned_at", timeutil.iso())
    if not env_flag("AGENT_MEM_NO_SPAWN"):
        spawn_indexer(config)


OBSERVER_THROTTLE_SECONDS = 15


def spawn_observer(config: Config) -> bool:
    """Start ``agent-mem observe --drain`` detached (docs/PLAN.md §4.3). The worker exits at once if
    another one holds ``observe.lock``; a marker file keeps a burst of Stop hooks from spawning more
    than one process every few seconds."""
    if not config.observe.enabled or env_flag("AGENT_MEM_NO_SPAWN"):
        return False
    marker = config.data_dir / ".observer-spawned"
    with contextlib.suppress(OSError):
        if marker.exists() and time.time() - marker.stat().st_mtime < OBSERVER_THROTTLE_SECONDS:
            return False
        marker.touch()
    return _spawn([sys.executable, "-m", "agent_mem", "observe", "--drain", "--quiet"], config)


def _listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.05):
            return True
    except OSError:
        return False


def spawn_viewer(config: Config, *, force: bool = False) -> bool:
    """Start ``agent-mem serve`` detached when nothing answers on the viewer port. A refused connection on the
    loopback interface returns at once, so the check costs well under a millisecond on the hook path."""
    if not config.viewer.enabled or (env_flag("AGENT_MEM_NO_SPAWN") and not force):
        return False
    if _listening(config.viewer.port):
        return False
    return _spawn([sys.executable, "-m", "agent_mem", "serve", "--quiet"], config)


def problems(conn: sqlite3.Connection) -> list[str]:
    """Failures the user has to act on, shown in the terminal at session start (never to the model)."""
    lines: list[str] = []
    for row in conn.execute(
        "SELECT component, last_error FROM health WHERE last_error_at IS NOT NULL "
        "AND last_error_at > COALESCE(last_ok_at, '') ORDER BY last_error_at DESC LIMIT 2"
    ):
        lines.append(f"{row['component']} fails: {str(row['last_error'])[:160]}. Run `agent-mem doctor`.")
    with contextlib.suppress(sqlite3.OperationalError):  # observer tables come with migration 002
        failed = conn.execute("SELECT COUNT(*), MAX(last_error) FROM observe_queue WHERE state = 'failed'").fetchone()
        if failed and failed[0]:
            lines.append(
                f"{failed[0]} turn(s) failed fact extraction (last: {str(failed[1] or '-')[:160]}). "
                "Run `agent-mem observe --status`, then `agent-mem observe --retry-failed`."
            )
    return lines


def _spawn(argv: list[str], config: Config) -> bool:
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(config.data_dir), "AGENT_MEM_INTERNAL": "1"}
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
        "env": env,
    }
    if sys.platform == "win32":
        flags = 0
        for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_NO_WINDOW"):
            flags |= getattr(subprocess, name, 0)
        kwargs["creationflags"] = flags
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(argv, **kwargs)
    except OSError:
        return False
    return True


def _spawn_for_migration(config: Config) -> None:
    # The database cannot be written yet, so the throttle lives in a marker file instead of ``meta``.
    marker = config.data_dir / ".migration-requested"
    with contextlib.suppress(OSError):
        if marker.exists() and time.time() - marker.stat().st_mtime < INDEXER_THROTTLE_SECONDS:
            return
        marker.touch()
        if not env_flag("AGENT_MEM_NO_SPAWN"):
            spawn_indexer(config)


class _Worker(threading.Thread):
    def __init__(self, config: Config, event: Event) -> None:
        super().__init__(daemon=True)
        self.config = config
        self.event = event
        self.response: capture.Response | None = None
        self.spooled = False
        self.error: str | None = None
        self.problems: list[str] = []
        self.facts: list[str] = []
        self.recent: list[tuple[str, str, str, str]] = []
        self.summary: str | None = None
        self._spool_lock = threading.Lock()

    def run(self) -> None:
        conn: sqlite3.Connection | None = None
        try:
            conn = db.connect(self.config, fresh_only=True)
            self.response = capture.apply(conn, self.config, self.event)
            _maybe_spawn(conn, self.config, self.response.wants_indexer)
            if self.event.kind in {"stop", "session_end"}:
                spawn_observer(self.config)
            if self.event.kind == "session_start":
                spawn_viewer(self.config)
                if self.event.harness == "claude":
                    self.problems = problems(conn)
                    self.facts = inject.overview(conn, f"claude:{self.event.session_id}", self.config)
                    self.recent = inject.recent_work(conn, f"claude:{self.event.session_id}")
            elif self.event.kind == "session_end" and self.event.harness == "claude":
                self.summary = inject.session_summary(conn, f"claude:{self.event.session_id}", _color())
        except db.MigrationPendingError as error:
            # The indexer migrates (with backup) outside the deadline and then replays the spool.
            self.error = f"{type(error).__name__}: {error}"
            self._spool()
            _spawn_for_migration(self.config)
        except (
            sqlite3.OperationalError,
            db.SchemaTooNewError,
            db.MigrationInProgressError,
            sqlite3.DatabaseError,
        ) as error:
            self.error = f"{type(error).__name__}: {error}"
            self._spool()
        except Exception as error:
            self.error = f"{type(error).__name__}: {error}"
            self._spool()
            if conn is not None:
                with contextlib.suppress(sqlite3.Error):
                    db.record_health(conn, f"hook:{self.event.harness}", self.error)
        finally:
            if conn is not None:
                with contextlib.suppress(sqlite3.Error):
                    conn.close()

    def _spool(self) -> None:
        # Called by the worker on error and by the main thread on deadline; both can race.
        with self._spool_lock:
            if self.spooled:
                return
            try:
                spool.write(self.config.spool_dir, {"type": "event", "event": self.event.to_dict()})
                self.spooled = True
            except OSError as error:
                self.error = f"{self.error}; spool failed: {error}"


def run(
    harness: str,
    event_name: str | None,
    stdin_text: str | None = None,
    config: Config | None = None,
    stdin_bytes: bytes | None = None,
) -> str:
    """Process one hook invocation. Returns the text to print (possibly empty)."""
    if env_flag("AGENT_MEM_INTERNAL") or env_flag("AGENT_MEM_DISABLE"):
        return ""
    config = config or load()
    try:
        raw = stdin_text if stdin_text is not None else _read_stdin(config.limits.stdin_bytes, stdin_bytes)
        payload = json.loads(raw) if raw.strip() else {}
        event = normalize(harness, payload, event_name)
    except (PayloadError, ValueError) as error:
        logutil.write(
            config.log_dir,
            "hook",
            harness=harness,
            event=event_name or "",
            error=type(error).__name__,
            detail=str(error)[:120],
        )
        _quarantine_note(config, harness, event_name, str(error))
        return ""
    if event is None:
        return ""
    worker = _Worker(config, event)
    worker.start()
    worker.join(config.hook_deadline_ms / 1000)
    if worker.is_alive():
        worker._spool()
        logutil.write(config.log_dir, "hook", harness=harness, kind=event.kind, error="deadline")
        return ""
    if worker.error:
        logutil.write(config.log_dir, "hook", harness=harness, kind=event.kind, error=worker.error[:200])
    output = render(harness, event, worker.response) if worker.response is not None else None
    if harness == "claude":
        message = _terminal(config, event, worker)
        if message:
            output = {**(output or {}), "systemMessage": message}
    return json.dumps(output, ensure_ascii=False) if output else ""


def _color() -> bool:
    return "NO_COLOR" not in os.environ


NOTICE_SECONDS = 600


def _terminal(config: Config, event: Event, worker: _Worker) -> str | None:
    """What the user sees in Claude Code's terminal: a panel at session start and after compaction, a summary
    when the session ends, and failures as they happen. Ordinary prompts and tool calls stay quiet."""
    failure = None
    # A pending migration or a briefly locked database is routine: the indexer replays the spool later.
    routine = ("MigrationPendingError", "MigrationInProgressError", "OperationalError: database is locked")
    if worker.error and not worker.error.startswith(routine):
        # Without a database nothing is recalled or recorded live; say so instead of failing silently.
        failure = f"agent-mem cannot use its database ({worker.error[:160]}). Events wait in the spool. Run `agent-mem doctor`."
    if event.kind == "session_start":
        heading = os.path.basename(event.cwd.rstrip("/\\")) if event.cwd else "session start"
        if event.source == "compact":
            heading += " · after compaction"
        context = worker.response.context if worker.response is not None else None
        viewer = f"http://localhost:{config.viewer.port}/" if config.viewer.enabled else None
        notices = [failure] if failure else worker.problems
        return inject.terminal(
            context or "", heading, _color(), facts=worker.facts, notices=notices, viewer=viewer, recent=worker.recent
        )
    if event.kind == "session_end" and worker.summary:
        return worker.summary
    if failure and _notice_due(config, failure):
        return f"\x1b[31m{failure}\x1b[0m" if _color() else failure
    return None


def _notice_due(config: Config, text: str) -> bool:
    """The same failure is shown at most every ten minutes, not on every tool call."""
    marker = config.data_dir / ".last-notice"
    with contextlib.suppress(OSError):
        if marker.read_text(encoding="utf-8") == text and time.time() - marker.stat().st_mtime < NOTICE_SECONDS:
            return False
    with contextlib.suppress(OSError):
        marker.write_text(text, encoding="utf-8")
    return True


def _quarantine_note(config: Config, harness: str, event_name: str | None, reason: str) -> None:
    with contextlib.suppress(OSError):
        spool.quarantine_record(
            config.quarantine_dir,
            {
                "type": "invalid_payload",
                "harness": harness,
                "event": event_name,
                "reason": reason[:200],
                "ts": timeutil.iso(),
            },
        )


def main(argv: list[str], stdin_bytes: bytes | None = None) -> int:
    harness = argv[0] if argv else ""
    event_name = argv[1] if len(argv) > 1 else None
    if harness in {"", "-h", "--help"}:  # typed by a person: explain instead of waiting on stdin
        print("usage: agent-mem hook {claude,codex,copilot,opencode} [event]\n")
        print("Called by the harness hooks with the event JSON on stdin. Set up with `agent-mem setup all --write`.")
        return 0
    try:
        text = run(harness, event_name, stdin_bytes=stdin_bytes)
    except Exception as error:  # the agent must never see a crash
        with contextlib.suppress(Exception):
            logutil.write(load().log_dir, "hook", harness=harness, error=f"unexpected {type(error).__name__}")
        text = ""
    if text:
        sys.stdout.write(text)
        sys.stdout.flush()
    # Leave immediately even if a timed-out worker is still running; SQLite rolls it back.
    sys.stdout.flush()
    os._exit(0)
