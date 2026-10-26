"""The tokens the agent spent on each turn, read from the harness's own transcript.

Claude Code writes every assistant message with its ``usage``; Codex writes a ``token_count`` event per model call,
Copilot CLI a ``session.usage_record``.
A turn's work is the fresh tokens of the calls between its prompt and its end: input, cache writes and output,
subagents included. Cache reads stay out: every step re-reads the whole context, and counting that would make a
30-step turn look like millions of tokens. The indexer measures closed turns, never the hook path.

A turn's work is split evenly between the turn and the memories drawn from it; only what an agent used counts, each
part once, so naming the turn and all its memories adds up to the whole turn. The number is what the agent itself spent, so "read 400 tokens built from 30,000" compares what an injection costs with what
finding it out again took. It is not a measured saving: nobody knows what the agent would have redone.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TypeVar

from agent_mem.core import db, privacy, timeutil
from agent_mem.memory import learn, store

T = TypeVar("T")

LOOKBACK_DAYS = 30  # Claude Code deletes transcripts after 30 days by default
# The label an entry starts with ("- [M12 · 2026-10-13 · fact]"); an id inside its text is only a mention.
_ID = re.compile(r"\[([MT])(\d+) ·")


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


def _copilot_files(native_id: str) -> list[Path]:
    home = Path(os.environ.get("COPILOT_HOME") or Path.home() / ".copilot").expanduser()
    path = home / "session-state" / native_id / "events.jsonl"
    return [path] if path.is_file() else []


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


def _copilot_usage(path: Path, offset: int = 0) -> tuple[list[Call], int]:
    """Fresh tokens per model call, and where the complete lines end. ``inputTokens`` includes the cache reads and
    writes (CLI 1.0.96)."""
    calls: list[Call] = []
    end = offset
    for position, after, line in _lines(path, offset):
        end = after
        if '"session.usage_record"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        data = entry.get("data") if isinstance(entry, dict) else None
        usage = data.get("usage") if isinstance(data, dict) else None
        if not isinstance(usage, dict) or not entry.get("timestamp"):
            continue
        fresh = int(usage.get("inputTokens") or 0) - int(usage.get("cacheReadTokens") or 0)
        calls.append((str(entry["timestamp"]), max(fresh, 0) + int(usage.get("outputTokens") or 0), position))
    return calls, end


def measure(conn: sqlite3.Connection) -> int:
    """Fill ``turns.work_tokens`` for closed turns of Claude Code, Codex and Copilot sessions whose transcript exists.
    A turn without a model call in its window gets 0 (measured, nothing spent). Returns the turns measured.

    Each file is read from where the earliest turn still open began (``meta work.offset:<path>``), so a large
    transcript is not read again after every turn."""
    since = timeutil.iso(timeutil.now() - timedelta(days=LOOKBACK_DAYS))
    sessions = conn.execute(
        "SELECT DISTINCT s.id, s.harness, s.native_id, s.started_at FROM turns t JOIN sessions s ON s.id = t.session_id "
        "WHERE t.work_tokens IS NULL AND t.ended_at IS NOT NULL AND s.harness IN ('claude', 'codex', 'copilot') "
        "AND s.last_event_at >= ?",
        (since,),
    ).fetchall()
    measured = 0
    for session_id, harness, native_id, started_at in sessions:
        if harness == "claude":
            files, read = _claude_files(native_id), _claude_usage
        elif harness == "codex":
            files, read = _codex_files(native_id, started_at), _codex_usage
        else:
            files, read = _copilot_files(native_id), _copilot_usage
        if not files:
            continue
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
    """Measured work behind the memories (``M12``) and turns (``T5``) a block names that an agent has used before. A
    named turn counts whole and once; a memory brings its turn's share unless that turn is named itself."""
    memories: set[int] = set()
    turns: set[int] = set()
    for kind, number in _ID.findall(text):
        (memories if kind == "M" else turns).add(int(number))
    used = _used(conn, [("m", i) for i in memories] + [("t", i) for i in turns])
    return _work_of(conn, {i for t, i in used if t == "m"}, {i for t, i in used if t == "t"})


_USE_MARKS = "(" + ",".join("?" * len(learn.USE_KINDS)) + ")"


def _used(conn: sqlite3.Connection, owners: list[tuple[str, int]]) -> set[tuple[str, int]]:
    """The owners an agent fetched, cited or worked on after it was given them: shown alone, an entry saved nothing."""
    found: set[tuple[str, int]] = set()
    for chunk in _chunks(sorted(owners)):
        marks = ",".join("(?, ?)" for _ in chunk)
        found.update(
            (str(t), int(i))
            for t, i in conn.execute(
                f"SELECT DISTINCT owner_type, owner_id FROM accesses WHERE kind IN {_USE_MARKS} "
                f"AND (owner_type, owner_id) IN (VALUES {marks})",
                [*learn.USE_KINDS, *(part for owner in chunk for part in owner)],
            )
        )
    return found


def reused(conn: sqlite3.Connection, since: str) -> int:
    """Measured work behind what agents used since ``since`` (fetched, cited, worked on), each memory and turn once
    however often it was used: a fact used in ten sessions was found out once."""
    owners = conn.execute(
        f"SELECT DISTINCT owner_type, owner_id FROM accesses WHERE kind IN {_USE_MARKS} AND ts >= ?",
        (*learn.USE_KINDS, since),
    ).fetchall()
    return _work_of(conn, {int(i) for t, i in owners if t == "m"}, {int(i) for t, i in owners if t == "t"})


# A turn's work is shared by what came out of it: its own record and each memory drawn from it.
_SHARES = "1 + (SELECT COUNT(*) FROM memories s WHERE s.turn_id = t.id AND s.kind != 'native_note')"


def _work_of(conn: sqlite3.Connection, memories: set[int], turns: set[int]) -> int:
    """Each used turn and memory brings its share of the turn's work: a fact taken from a twelve-hour run did not
    save the whole run."""
    total = 0
    for chunk in _chunks(sorted(turns)):
        marks = ",".join("?" * len(chunk))
        total += int(
            conn.execute(
                f"SELECT COALESCE(SUM(t.work_tokens / ({_SHARES})), 0) FROM turns t WHERE t.id IN ({marks})", chunk
            ).fetchone()[0]
        )
    for chunk in _chunks(sorted(memories)):
        marks = ",".join("?" * len(chunk))
        total += int(
            conn.execute(
                f"SELECT COALESCE(SUM(t.work_tokens / ({_SHARES})), 0) FROM memories m JOIN turns t ON t.id = m.turn_id "
                f"WHERE m.id IN ({marks}) AND m.kind != 'native_note'",
                chunk,
            ).fetchone()[0]
        )
    return total


def _chunks(ids: list[T], size: int = 500) -> Iterator[tuple[T, ...]]:
    """SQLite allows a bounded number of ``?`` per statement; a week of injections names thousands of ids."""
    for start in range(0, len(ids), size):
        yield tuple(ids[start : start + size])


# The last messages of a turn that ended without a Stop: what it did before it was cut off.
UNFINISHED_MESSAGES = 3
LAST_TURN_HOURS = 6  # a session resumed days later has prompts agent-mem may not have seen


def fill_answers(conn: sqlite3.Connection, turn_ids: list[int], chars: int = 16_000) -> int:
    """Give closed turns without an answer (interrupted, usage limit, missing Stop) the agent's last messages from
    the transcript, marked "(unfinished)". Only the main transcript counts: a subagent's text is not the answer.
    Returns the turns filled."""
    if not turn_ids:
        return 0
    marks = ",".join("?" * len(turn_ids))
    rows = conn.execute(
        "SELECT t.id, t.started_at, (SELECT MIN(n.started_at) FROM turns n WHERE n.session_id = t.session_id "
        "AND n.started_at > t.started_at), s.harness, s.native_id, s.started_at AS session_start FROM turns t "
        f"JOIN sessions s ON s.id = t.session_id WHERE t.id IN ({marks}) AND t.ended_at IS NOT NULL "
        "AND COALESCE(t.answer, '') = '' AND s.native_id IS NOT NULL",
        turn_ids,
    ).fetchall()
    said_in: dict[tuple[str, str], list[tuple[str, str]]] = {}
    filled = 0
    for turn_id, start, until, harness, native_id, session_start in rows:
        # A turn's messages run until the next prompt, not until its end: a one-shot run (``opencode run``) is closed
        # with its prompt and answers seconds later.
        until = until or timeutil.iso((timeutil.parse(start) or timeutil.now()) + timedelta(hours=LAST_TURN_HOURS))
        if (harness, native_id) not in said_in:
            said_in[harness, native_id] = _said(harness, native_id, session_start)
        texts = [text for ts, text in said_in[harness, native_id] if start <= ts < until][-UNFINISHED_MESSAGES:]
        if not texts:
            continue
        answer = privacy.clean_text("(unfinished) " + "\n".join(texts), chars)
        with db.transaction(conn):
            conn.execute("UPDATE turns SET answer = ? WHERE id = ? AND COALESCE(answer, '') = ''", (answer, turn_id))
            store.index_turn(conn, int(turn_id))
        filled += 1
    return filled


def _said(harness: str, native_id: str, session_start: str) -> list[tuple[str, str]]:
    """(timestamp, text) of the agent's messages in a session, empty when the transcript is gone or unreadable."""
    try:
        if harness == "opencode":
            return _opencode_said(native_id)
        files = _transcripts(harness, native_id, session_start)
        return _SAID[harness](files[0]) if files else []
    except (OSError, sqlite3.Error):
        return []


def _opencode_said(native_id: str) -> list[tuple[str, str]]:
    """OpenCode keeps its sessions in a SQLite database, not in files; read-only, the running app may hold it."""
    xdg = os.environ.get("XDG_DATA_HOME")
    path = (Path(xdg) if xdg else Path.home() / ".local" / "share") / "opencode" / "opencode.db"
    if not path.is_file():
        return []
    said: list[tuple[str, str]] = []
    with contextlib.closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=1)) as oc:
        for (data,) in oc.execute(
            "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq", (native_id,)
        ):
            try:
                message = json.loads(data)
            except ValueError:
                continue
            created = (message.get("time") or {}).get("created") if isinstance(message, dict) else None
            if not isinstance(created, int | float):
                continue
            ts = timeutil.iso(datetime.fromtimestamp(created / 1000, UTC))
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text" and str(block.get("text") or "").strip():
                    said.append((ts, str(block["text"]).strip()))
    return said


def _transcripts(harness: str, native_id: str, started_at: str) -> list[Path]:
    if harness == "claude":
        return _claude_files(native_id)
    if harness == "codex":
        return _codex_files(native_id, started_at)
    if harness == "copilot":
        return _copilot_files(native_id)
    return []


def _json_lines(path: Path, needle: str) -> Iterator[dict[str, object]]:
    for _, _, line in _lines(path, 0):
        if needle not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("timestamp"):
            yield entry


def _claude_said(path: Path) -> list[tuple[str, str]]:
    said: list[tuple[str, str]] = []
    for entry in _json_lines(path, '"text"'):
        message = entry.get("message")
        if entry.get("type") != "assistant" or not isinstance(message, dict) or entry.get("isApiErrorMessage"):
            continue  # an API error is the harness reporting, not the agent's work
        if message.get("model") == "<synthetic>":
            continue  # Claude Code's own notice (spend limit), not the agent's words
        content = message.get("content")
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get("type") == "text" and str(block.get("text") or "").strip():
                said.append((str(entry["timestamp"]), str(block["text"]).strip()))
    return said


def _codex_said(path: Path) -> list[tuple[str, str]]:
    said: list[tuple[str, str]] = []
    for entry in _json_lines(path, '"agent_message"'):
        payload = entry.get("payload")
        if isinstance(payload, dict) and payload.get("type") == "agent_message" and payload.get("message"):
            said.append((str(entry["timestamp"]), str(payload["message"]).strip()))
    return said


def _copilot_said(path: Path) -> list[tuple[str, str]]:
    said: list[tuple[str, str]] = []
    for entry in _json_lines(path, '"assistant.message"'):
        data = entry.get("data")
        if (
            entry.get("type") == "assistant.message"
            and isinstance(data, dict)
            and str(data.get("content") or "").strip()
        ):
            said.append((str(entry["timestamp"]), str(data["content"]).strip()))
    return said


_SAID = {"claude": _claude_said, "codex": _codex_said, "copilot": _copilot_said}
