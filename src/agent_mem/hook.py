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
import sqlite3
import subprocess
import sys
import threading
from typing import Any

from . import capture, db, logutil, spool, timeutil
from .config import Config, env_flag, load
from .events import Event, PayloadError
from .normalize import normalize

INDEXER_THROTTLE_SECONDS = 60


def _read_stdin(limit: int) -> str:
    data = sys.stdin.buffer.read(limit + 1)
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


class _Worker(threading.Thread):
    def __init__(self, config: Config, event: Event) -> None:
        super().__init__(daemon=True)
        self.config = config
        self.event = event
        self.response: capture.Response | None = None
        self.spooled = False
        self.error: str | None = None
        self._spool_lock = threading.Lock()

    def run(self) -> None:
        conn: sqlite3.Connection | None = None
        try:
            conn = db.connect(self.config)
            self.response = capture.apply(conn, self.config, self.event)
            _maybe_spawn(conn, self.config, self.response.wants_indexer)
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


def run(harness: str, event_name: str | None, stdin_text: str | None = None, config: Config | None = None) -> str:
    """Process one hook invocation. Returns the text to print (possibly empty)."""
    if env_flag("AGENT_MEM_INTERNAL") or env_flag("AGENT_MEM_DISABLE"):
        return ""
    config = config or load()
    try:
        raw = stdin_text if stdin_text is not None else _read_stdin(config.limits.stdin_bytes)
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
    if worker.response is None:
        return ""
    output = render(harness, event, worker.response)
    return json.dumps(output, ensure_ascii=False) if output else ""


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


def main(argv: list[str]) -> int:
    harness = argv[0] if argv else ""
    event_name = argv[1] if len(argv) > 1 else None
    try:
        text = run(harness, event_name)
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
