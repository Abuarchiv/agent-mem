"""The tokens the agent spent on each turn, read from the harness's own transcript (claude-mem calls this "work").

Claude Code writes every assistant message with its ``usage``; Codex writes a ``token_count`` event per model call.
A turn's work is the fresh tokens of the calls between its prompt and its end: input, cache writes and output,
subagents included. Cache reads stay out: every step re-reads the whole context, and counting that would make a
30-step turn look like millions of tokens. The indexer measures closed turns, never the hook path.

A memory's share is its turn's work divided by the memories that turn produced, so a block that names several
memories of one turn counts that turn once. claude-mem's number is the tokens its own observer read; this one is
what the agent itself spent, so "read 400 tokens built from 30,000" compares what an injection costs with what
finding it out again took. It is not a measured saving: nobody knows what the agent would have redone.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

from agent_mem.core import db, timeutil

LOOKBACK_DAYS = 30  # Claude Code deletes transcripts after 30 days by default
_ID = re.compile(r"\b([MT])(\d+)\b")


def _claude_files(native_id: str) -> list[Path]:
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser() / "projects"
    main = sorted(home.glob(f"*/{native_id}.jsonl"))
    if not main:
        return []
    return [main[0], *sorted(main[0].with_suffix("").glob("subagents/*.jsonl"))]


def _codex_files(native_id: str, started_at: str) -> list[Path]:
    """Codex files its rollouts by local date; a session started near midnight may sit in the next day."""
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser() / "sessions"
    start = timeutil.parse(started_at)
    if start is None:
        return []
    found: list[Path] = []
    for offset in (-1, 0, 1):
        day = (start.astimezone() + timedelta(days=offset)).strftime("%Y/%m/%d")
        found += sorted((root / day).glob(f"*{native_id}.jsonl"))
    return found[:1]


Call = tuple[str, int, int]  # (timestamp, fresh tokens, byte offset of its line)


def _lines(path: Path, offset: int) -> Iterator[tuple[int, int, str]]:
    """(offset, offset after it, text) of each complete line from ``offset``; a transcript only grows, so a file
    shorter than the offset was replaced and is read from the start. A line still being written is left for later."""
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(offset if offset <= fh.tell() else 0)
        position = fh.tell()
        for raw in iter(fh.readline, b""):
            if not raw.endswith(b"\n"):
                return
            yield position, position + len(raw), raw.decode("utf-8", errors="replace")
            position += len(raw)


def _claude_usage(path: Path, offset: int = 0) -> tuple[list[Call], int]:
    """Fresh tokens per assistant message (a message streamed over several lines counts once), and where the
    complete lines end."""
    calls: dict[str, Call] = {}
    end = offset
    for position, after, line in _lines(path, offset):
        end = after
        if '"usage"' not in line or '"assistant"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") if isinstance(entry, dict) else None
        usage = message.get("usage") if isinstance(message, dict) else None
        if not isinstance(message, dict) or not isinstance(usage, dict) or entry.get("type") != "assistant":
            continue
        if not entry.get("timestamp"):
            continue
        fresh = sum(
            int(usage.get(key) or 0) for key in ("input_tokens", "cache_creation_input_tokens", "output_tokens")
        )
        key = str(message.get("id") or entry.get("uuid"))
        calls[key] = (str(entry["timestamp"]), fresh, calls[key][2] if key in calls else position)
    return list(calls.values()), end


def _codex_usage(path: Path, offset: int = 0) -> tuple[list[Call], int]:
    """Fresh tokens per model call (Codex repeats an event when only its rate limits change), and where the complete
    lines end."""
    calls: list[Call] = []
    total = -1
    end = offset
    for position, after, line in _lines(path, offset):
        end = after
        if '"token_count"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        payload = entry.get("payload") if isinstance(entry, dict) else None
        info = payload.get("info") if isinstance(payload, dict) else None
        if not isinstance(info, dict) or not entry.get("timestamp"):
            continue
        running = int((info.get("total_token_usage") or {}).get("total_tokens") or 0)
        last = info.get("last_token_usage") or {}
        if running <= total or not isinstance(last, dict):
            continue
        total = running
        fresh = int(last.get("input_tokens") or 0) - int(last.get("cached_input_tokens") or 0)
        calls.append((str(entry["timestamp"]), max(fresh, 0) + int(last.get("output_tokens") or 0), position))
    return calls, end


def measure(conn: sqlite3.Connection) -> int:
    """Fill ``turns.work_tokens`` for closed turns of Claude Code and Codex sessions whose transcript exists.
    A turn without a model call in its window gets 0 (measured, nothing spent). Returns the turns measured.

    Each file is read from where the earliest turn still open began (``meta work.offset:<path>``): a 220 MB session
    took 2.1 s to read, and the indexer read it again after every turn."""
    since = timeutil.iso(timeutil.now() - timedelta(days=LOOKBACK_DAYS))
    sessions = conn.execute(
        "SELECT DISTINCT s.id, s.harness, s.native_id, s.started_at FROM turns t JOIN sessions s ON s.id = t.session_id "
        "WHERE t.work_tokens IS NULL AND t.ended_at IS NOT NULL AND s.harness IN ('claude', 'codex') "
        "AND s.last_event_at >= ?",
        (since,),
    ).fetchall()
    measured = 0
    for session_id, harness, native_id, started_at in sessions:
        files = _claude_files(native_id) if harness == "claude" else _codex_files(native_id, started_at)
        if not files:
            continue
        read = _claude_usage if harness == "claude" else _codex_usage
        try:
            per_file = {path: read(path, int(db.get_meta(conn, f"work.offset:{path}") or 0)) for path in files}
        except OSError:
            continue
        calls = [call for found, _ in per_file.values() for call in found]
        turns = conn.execute(
            "SELECT id, started_at, ended_at, work_tokens FROM turns WHERE session_id = ? ORDER BY started_at, id",
            (session_id,),
        ).fetchall()
        still_open: list[str] = []
        with db.transaction(conn):
            for index, (turn_id, start, end, done) in enumerate(turns):
                if done is not None:
                    continue
                if end is None:
                    still_open.append(start)
                    continue
                # A turn closed late (stale, or by the next prompt) must not take the next turn's calls.
                if index + 1 < len(turns):
                    end = min(end, turns[index + 1][1])
                spent = sum(tokens for ts, tokens, _ in calls if start <= ts <= end)
                conn.execute("UPDATE turns SET work_tokens = ? WHERE id = ?", (spent, turn_id))
                measured += 1
            for path, (found, end) in per_file.items():
                # Resume at the first call an open turn may own; with none, after the last complete line read.
                needed = [position for ts, _, position in found if still_open and ts >= min(still_open)]
                db.set_meta(conn, f"work.offset:{path}", str(min(needed) if needed else end))
    return measured


def behind(conn: sqlite3.Connection, text: str) -> int:
    """Measured work behind the memories (``M12``) and turns (``T5``) a block names. A named turn counts whole and
    once; a memory brings its turn's share unless that turn is named itself."""
    memories: set[int] = set()
    turns: set[int] = set()
    for kind, number in _ID.findall(text):
        (memories if kind == "M" else turns).add(int(number))
    total = 0
    if turns:
        marks = ",".join("?" * len(turns))
        total += int(
            conn.execute(
                f"SELECT COALESCE(SUM(work_tokens), 0) FROM turns WHERE id IN ({marks})", tuple(turns)
            ).fetchone()[0]
        )
    if memories:
        marks = ",".join("?" * len(memories))
        for turn_id, work, siblings in conn.execute(
            "SELECT m.turn_id, t.work_tokens, (SELECT COUNT(*) FROM memories s WHERE s.turn_id = m.turn_id "
            f"AND s.kind != 'native_note') FROM memories m JOIN turns t ON t.id = m.turn_id WHERE m.id IN ({marks})",
            tuple(memories),
        ):
            if turn_id not in turns and work:
                total += int(work) // max(int(siblings), 1)
    return total
