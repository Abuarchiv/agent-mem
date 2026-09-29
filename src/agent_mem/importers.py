"""Importers for history that existed before Agent Mem was installed.

All importers are idempotent (dedupe keys), apply the same redaction as live capture,
skip sessions that already exist, and support ``dry_run``.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import capture, store, timeutil
from .config import Config
from .events import Event, exit_code_of, output_text
from .federate import claude_home, codex_home


def _session_exists(conn: sqlite3.Connection, harness: str, native_id: str) -> bool:
    return conn.execute("SELECT 1 FROM sessions WHERE id = ?", (f"{harness}:{native_id}",)).fetchone() is not None


def _read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict):
                    yield value
    except OSError:
        return


def _apply_all(conn: sqlite3.Connection, config: Config, events: list[Event], dry_run: bool) -> int:
    if dry_run:
        return len(events)
    for event in events:
        capture.apply(conn, config, event, with_context=False)
    return len(events)


# --- Claude Code transcripts ---------------------------------------------------


def claude_events(path: Path) -> list[Event]:
    events: list[Event] = []
    pending_tools: dict[str, tuple[str, Any]] = {}
    session_id: str | None = None
    cwd: str | None = None
    last_answer: list[str] = []
    started = False

    def flush_stop(ts: str) -> None:
        if session_id and started:
            events.append(
                Event(
                    "claude",
                    "stop",
                    session_id,
                    ts,
                    cwd=cwd,
                    answer="\n".join(last_answer)[-8000:] or None,
                    raw_kind="Stop",
                )
            )

    for record in _read_jsonl(path):
        kind = record.get("type")
        if kind not in {"user", "assistant"}:
            continue
        session_id = str(record.get("sessionId") or session_id or path.stem)
        cwd = record.get("cwd") or cwd
        ts = timeutil.from_any(record.get("timestamp"))
        message = record.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if kind == "user":
            if isinstance(content, str) and not record.get("isMeta"):
                if started:
                    flush_stop(ts)
                if not started:
                    events.append(
                        Event(
                            "claude",
                            "session_start",
                            session_id,
                            ts,
                            cwd=cwd,
                            source="startup",
                            raw_kind="SessionStart",
                        )
                    )
                started = True
                last_answer = []
                events.append(
                    Event("claude", "prompt", session_id, ts, cwd=cwd, prompt=content, raw_kind="UserPromptSubmit")
                )
            elif isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "tool_result":
                        continue
                    tool_id = str(block.get("tool_use_id") or "")
                    name, tool_input = pending_tools.pop(tool_id, ("unknown", None))
                    text = output_text(block.get("content"))
                    failed = bool(block.get("is_error"))
                    events.append(
                        Event(
                            "claude",
                            "tool",
                            session_id,
                            ts,
                            cwd=cwd,
                            tool=name,
                            tool_use_id=tool_id or None,
                            tool_input=tool_input,
                            tool_output=text,
                            tool_failed=failed,
                            error=text if failed else None,
                            raw_kind="PostToolUse",
                        )
                    )
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    last_answer.append(block["text"])
                elif block.get("type") == "tool_use":
                    pending_tools[str(block.get("id") or "")] = (
                        str(block.get("name") or "unknown"),
                        block.get("input"),
                    )
    if session_id and started:
        flush_stop(events[-1].ts if events else timeutil.iso())
    return events


def import_claude(
    conn: sqlite3.Connection, config: Config, root: Path | None = None, *, dry_run: bool = False
) -> dict[str, int]:
    base = root or claude_home() / "projects"
    files = sorted(base.rglob("*.jsonl")) if base.is_dir() else ([base] if base.is_file() else [])
    stats = {"files": 0, "events": 0, "skipped_sessions": 0}
    for path in files:
        events = claude_events(path)
        if not events:
            continue
        if _session_exists(conn, "claude", events[0].session_id):
            stats["skipped_sessions"] += 1
            continue
        stats["files"] += 1
        stats["events"] += _apply_all(conn, config, events, dry_run)
    return stats


# --- Codex sessions ----------------------------------------------------------------


def _codex_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text")) for b in content if isinstance(b, dict) and isinstance(b.get("text"), str))
    return ""


def codex_events(path: Path) -> list[Event]:
    events: list[Event] = []
    session_id = path.stem
    cwd: str | None = None
    calls: dict[str, tuple[str, Any]] = {}
    answer: list[str] = []
    started = False
    for record in _read_jsonl(path):
        inner = record.get("payload")
        payload: dict[str, Any] = inner if isinstance(inner, dict) else record
        ts = timeutil.from_any(record.get("timestamp"))
        record_type = record.get("type")
        if record_type == "session_meta":
            session_id = str(payload.get("id") or session_id)
            cwd = payload.get("cwd") or cwd
            continue
        if record_type == "turn_context":
            cwd = payload.get("cwd") or cwd
            continue
        if record_type not in {"response_item", None}:
            continue
        item_type = payload.get("type")
        if item_type == "message":
            text = _codex_text(payload.get("content"))
            if payload.get("role") == "user":
                if not text or text.lstrip().startswith(
                    ("<environment_context>", "<user_instructions>", "# AGENTS.md")
                ):
                    continue
                if started:
                    events.append(
                        Event(
                            "codex",
                            "stop",
                            session_id,
                            ts,
                            cwd=cwd,
                            answer="\n".join(answer)[-8000:] or None,
                            raw_kind="Stop",
                        )
                    )
                else:
                    events.append(
                        Event(
                            "codex", "session_start", session_id, ts, cwd=cwd, source="startup", raw_kind="SessionStart"
                        )
                    )
                started = True
                answer = []
                events.append(
                    Event("codex", "prompt", session_id, ts, cwd=cwd, prompt=text, raw_kind="UserPromptSubmit")
                )
            elif payload.get("role") == "assistant" and text:
                answer.append(text)
        elif item_type in {"function_call", "custom_tool_call", "local_shell_call"}:
            arguments = payload.get("arguments") or payload.get("input") or payload.get("action")
            if isinstance(arguments, str):
                with contextlib.suppress(ValueError):
                    arguments = json.loads(arguments)
            calls[str(payload.get("call_id") or "")] = (str(payload.get("name") or "shell"), arguments)
        elif item_type in {"function_call_output", "custom_tool_call_output", "local_shell_call_output"}:
            call_id = str(payload.get("call_id") or "")
            name, arguments = calls.pop(call_id, ("shell", None))
            output = payload.get("output")
            if isinstance(output, str):
                with contextlib.suppress(ValueError):
                    output = json.loads(output)
            text = output_text(output)
            exit_code = exit_code_of(output, text)
            events.append(
                Event(
                    "codex",
                    "tool",
                    session_id,
                    ts,
                    cwd=cwd,
                    tool=name,
                    tool_use_id=call_id or None,
                    tool_input=arguments,
                    tool_output=text,
                    exit_code=exit_code,
                    tool_failed=exit_code not in (None, 0),
                    error=text if exit_code not in (None, 0) else None,
                    raw_kind="PostToolUse",
                )
            )
    if started:
        events.append(
            Event(
                "codex",
                "stop",
                session_id,
                events[-1].ts,
                cwd=cwd,
                answer="\n".join(answer)[-8000:] or None,
                raw_kind="Stop",
            )
        )
    for event in events:
        event.session_id = session_id
    return events


def import_codex(
    conn: sqlite3.Connection, config: Config, root: Path | None = None, *, dry_run: bool = False
) -> dict[str, int]:
    base = root or codex_home() / "sessions"
    files = sorted(base.rglob("*.jsonl")) if base.is_dir() else ([base] if base.is_file() else [])
    stats = {"files": 0, "events": 0, "skipped_sessions": 0}
    for path in files:
        events = codex_events(path)
        if not events:
            continue
        if _session_exists(conn, "codex", events[0].session_id):
            stats["skipped_sessions"] += 1
            continue
        stats["files"] += 1
        stats["events"] += _apply_all(conn, config, events, dry_run)
    return stats


# --- claude-mem and agentmemory (best effort) -------------------------------------------


def _project_by_name(conn: sqlite3.Connection, name: str | None) -> str | None:
    if not name:
        return None
    row = conn.execute("SELECT id FROM projects WHERE lower(name) = lower(?)", (name.rsplit("/", 1)[-1],)).fetchone()
    return None if row is None else str(row[0])


def import_claude_mem(conn: sqlite3.Connection, config: Config, path: Path, *, dry_run: bool = False) -> dict[str, int]:
    """Import observations and summaries from a claude-mem SQLite database (read-only, schema detected)."""
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    stats = {"memories": 0}
    try:
        tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        plans = [
            ("observations", "lesson", ["title", "subtitle", "narrative", "text", "facts"]),
            ("session_summaries", "summary", ["request", "investigated", "learned", "completed", "next_steps"]),
        ]
        for table, kind, columns in plans:
            if table not in tables:
                continue
            present = {r[1] for r in source.execute(f"PRAGMA table_info({table})")}
            usable = [c for c in columns if c in present]
            if not usable:
                continue
            project_column = "project" if "project" in present else None
            for row in source.execute(f"SELECT * FROM {table}"):
                parts = [str(row[c]) for c in usable if row[c]]
                if not parts:
                    continue
                body = "\n".join(parts)
                if dry_run:
                    stats["memories"] += 1
                    continue
                project_id = _project_by_name(conn, row[project_column] if project_column else None)
                conn.execute("BEGIN IMMEDIATE")
                try:
                    created = store.add_memory(
                        conn,
                        project_id=project_id,
                        kind=kind,
                        title=parts[0][:200],
                        body=body,
                        source="import",
                        trust="agent",
                        importance=0.5,
                        origin="claude-mem",
                        dedupe=f"claude-mem|{table}|{row['id'] if 'id' in present else hashlib.sha256(body.encode()).hexdigest()}",
                    )
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                stats["memories"] += created is not None
    finally:
        source.close()
    return stats


def import_agentmemory(
    conn: sqlite3.Connection, config: Config, path: Path, *, dry_run: bool = False
) -> dict[str, int]:
    """Import an agentmemory JSON export (array of memories or ``{"memories": [...]}``)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("memories") if isinstance(data, dict) else data
    stats = {"memories": 0}
    if not isinstance(items, list):
        raise ValueError("unrecognized agentmemory export")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        text = item.get("content") or item.get("text") or item.get("body") or item.get("narrative")
        if not isinstance(text, str) or not text.strip():
            continue
        title = item.get("title") if isinstance(item.get("title"), str) else text.strip().splitlines()[0]
        kind_raw = str(item.get("type") or item.get("kind") or "").lower()
        kind = (
            "lesson"
            if "lesson" in kind_raw or "procedur" in kind_raw
            else "summary"
            if "summar" in kind_raw
            else "fact"
        )
        if dry_run:
            stats["memories"] += 1
            continue
        project_id = _project_by_name(conn, item.get("project") if isinstance(item.get("project"), str) else None)
        conn.execute("BEGIN IMMEDIATE")
        try:
            created = store.add_memory(
                conn,
                project_id=project_id,
                kind=kind,
                title=str(title)[:200],
                body=text,
                source="import",
                trust="agent",
                importance=0.5,
                origin="agentmemory",
                dedupe=f"agentmemory|{item.get('id', index)}",
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        stats["memories"] += created is not None
    return stats
