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


def _claude_usage(path: Path) -> list[tuple[str, int]]:
    """(timestamp, fresh tokens) per assistant message; a message streamed over several lines counts once."""
    calls: dict[str, tuple[str, int]] = {}
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
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
            calls[str(message.get("id") or entry.get("uuid"))] = (str(entry["timestamp"]), fresh)
    return list(calls.values())


def _codex_usage(path: Path) -> list[tuple[str, int]]:
    """(timestamp, fresh tokens) per model call; Codex repeats an event when only its rate limits change."""
    calls: list[tuple[str, int]] = []
    total = -1
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
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
            calls.append((str(entry["timestamp"]), max(fresh, 0) + int(last.get("output_tokens") or 0)))
    return calls


def measure(conn: sqlite3.Connection) -> int:
    """Fill ``turns.work_tokens`` for closed turns of Claude Code and Codex sessions whose transcript exists.
    A turn without a model call in its window gets 0 (measured, nothing spent). Returns the turns measured."""
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
            calls = [call for path in files for call in read(path)]
        except OSError:
            continue
        turns = conn.execute(
            "SELECT id, started_at, ended_at, work_tokens FROM turns WHERE session_id = ? ORDER BY started_at, id",
            (session_id,),
        ).fetchall()
        with db.transaction(conn):
            for index, (turn_id, start, end, done) in enumerate(turns):
                if done is not None or end is None:
                    continue
                # A turn closed late (stale, or by the next prompt) must not take the next turn's calls.
                if index + 1 < len(turns):
                    end = min(end, turns[index + 1][1])
                spent = sum(tokens for ts, tokens in calls if start <= ts <= end)
                conn.execute("UPDATE turns SET work_tokens = ? WHERE id = ?", (spent, turn_id))
                measured += 1
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
