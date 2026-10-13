"""Agent work per turn from the harness transcripts, and what an injection reads against it (memory/work.py)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from agent_mem.cli.health import _injected
from agent_mem.core import db
from agent_mem.hooks import capture, inject
from agent_mem.memory import store, work


def _lines(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")


def _assistant(ts: str, message_id: str, fresh_input: int, output: int, cache_read: int = 0) -> dict:
    usage = {"input_tokens": fresh_input, "cache_creation_input_tokens": 0, "output_tokens": output}
    usage["cache_read_input_tokens"] = cache_read
    return {"type": "assistant", "timestamp": ts, "message": {"id": message_id, "usage": usage}}


def _session(conn, harness: str, native: str, turns: list[tuple[str, str | None]]) -> list[int]:
    conn.execute("INSERT OR IGNORE INTO projects(id, name, root, created_at) VALUES ('p', 'p', '/p', 't')")
    conn.execute(
        "INSERT INTO sessions(id, harness, native_id, project_id, started_at, last_event_at) VALUES (?, ?, ?, 'p', ?, ?)",
        (f"{harness}:{native}", harness, native, turns[0][0], turns[-1][1] or turns[-1][0]),
    )
    return [
        conn.execute(
            "INSERT INTO turns(session_id, project_id, started_at, ended_at, prompt) VALUES (?, 'p', ?, ?, 'x') "
            "RETURNING id",
            (f"{harness}:{native}", start, end),
        ).fetchone()[0]
        for start, end in turns
    ]


def test_claude_turn_work_counts_fresh_tokens_once_with_subagents(conn) -> None:
    now = "2026-10-13T10:"
    turns = _session(
        conn,
        "claude",
        "s1",
        [
            (f"{now}00:00.000Z", f"{now}05:00.000Z"),
            (f"{now}06:00.000Z", f"{now}09:00.000Z"),
            (f"{now}10:00.000Z", None),
        ],
    )
    conn.execute("UPDATE sessions SET last_event_at = ?", (db.timeutil.iso(),))
    home = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-tmp-p"
    _lines(
        home / "s1.jsonl",
        [
            {"type": "user", "timestamp": f"{now}00:01.000Z", "message": {"content": "hi"}},
            _assistant(f"{now}01:00.000Z", "a", 100, 50, cache_read=400_000),  # cache reads stay out
            _assistant(f"{now}01:00.500Z", "a", 100, 50, cache_read=400_000),  # the same message streamed again
            _assistant(f"{now}07:00.000Z", "b", 10, 5),
            _assistant(f"{now}10:30.000Z", "c", 999, 999),  # the open turn is not measured
        ],
    )
    (home / "s1.jsonl").write_text((home / "s1.jsonl").read_text() + '{"usage": "assistant", broken\n')
    _lines(home / "s1" / "subagents" / "agent-x.jsonl", [_assistant(f"{now}02:00.000Z", "sub", 30, 20)])

    assert work.measure(conn) == 2
    measured = dict(conn.execute("SELECT id, work_tokens FROM turns").fetchall())
    assert measured == {turns[0]: 150 + 50, turns[1]: 15, turns[2]: None}
    assert work.measure(conn) == 0  # measured once


def test_codex_turn_work_skips_repeated_events_and_a_late_close_takes_nothing_from_the_next_turn(conn) -> None:
    turns = _session(
        conn,
        "codex",
        "019a-abc",
        [
            ("2026-10-12T21:00:00.000Z", "2026-10-12T21:30:00.000Z"),
            ("2026-10-12T21:10:00.000Z", "2026-10-12T21:20:00.000Z"),
        ],
    )
    conn.execute("UPDATE sessions SET last_event_at = ?", (db.timeutil.iso(),))
    local_day = db.timeutil.parse("2026-10-12T21:00:00.000Z").astimezone().strftime("%Y/%m/%d")  # type: ignore[union-attr]
    root = Path(os.environ["CODEX_HOME"]) / "sessions" / local_day

    def count(ts: str, total: int, fresh: int, cached: int, output: int) -> dict:
        info = {
            "total_token_usage": {"total_tokens": total},
            "last_token_usage": {
                "input_tokens": fresh + cached,
                "cached_input_tokens": cached,
                "output_tokens": output,
            },
        }
        return {"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count", "info": info}}

    _lines(
        root / "rollout-2026-10-12T23-00-00-019a-abc.jsonl",
        [
            count("2026-10-12T21:05:00.000Z", 1000, 300, 600, 100),
            count("2026-10-12T21:05:01.000Z", 1000, 300, 600, 100),  # rate-limit update repeats the event
            count("2026-10-12T21:15:00.000Z", 2000, 40, 900, 60),
        ],
    )
    assert work.measure(conn) == 2
    measured = dict(conn.execute("SELECT id, work_tokens FROM turns").fetchall())
    assert measured == {turns[0]: 400, turns[1]: 100}  # the first turn ends where the second begins


def test_an_injection_counts_a_turn_once_and_a_memory_by_its_share(conn) -> None:
    turns = _session(conn, "claude", "s2", [("2026-10-13T09:00:00.000Z", "2026-10-13T09:10:00.000Z")] * 2)
    conn.execute("UPDATE turns SET work_tokens = ? WHERE id = ?", (9_000, turns[0]))
    conn.execute("UPDATE turns SET work_tokens = ? WHERE id = ?", (500, turns[1]))
    ids = []
    for text in ("first fact", "second fact", "third fact"):
        memory = store.add_memory(
            conn, project_id="p", kind="fact", title=text, body=text, source="agent", trust="observer", dedupe=text
        )
        assert memory is not None
        conn.execute("UPDATE memories SET turn_id = ? WHERE id = ?", (turns[0], memory))
        ids.append(memory)
    assert work.behind(conn, f"- [M{ids[0]} · fact] first") == 3_000
    assert work.behind(conn, f"M{ids[0]} M{ids[1]} T{turns[0]}") == 9_000  # the turn itself, not twice
    assert work.behind(conn, f"M{ids[2]} T{turns[1]} T{turns[1]}") == 3_000 + 500
    assert work.behind(conn, "nothing named") == 0


def test_migration_006_adds_work_tokens_to_a_v5_database(config) -> None:
    conn = db.connect(config)
    conn.execute("DROP INDEX memories_turn")
    conn.execute("ALTER TABLE turns DROP COLUMN work_tokens")
    conn.execute("PRAGMA user_version = 5")
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 6
    assert "work_tokens" in {row[1] for row in conn.execute("PRAGMA table_info(turns)")}


def test_terminal_and_status_show_read_against_work(conn) -> None:
    context = "<agent-mem>\n- [M1 · 2026-10-13 · decision] Use pnpm\n</agent-mem>"
    panel = inject.terminal(context, "shop", color=False, spent=40_000)
    read = inject.tokens(context)
    assert f"Read ~{read:,} tokens · built from ~40,000 tokens of agent work" in panel
    assert f"{(40_000 - read) * 100 // 40_000}% less to read than to redo" in panel
    assert "100% less" not in inject.terminal(context, "shop", color=False, spent=10_000_000)  # 99.9 stays 99
    assert "agent work" not in inject.terminal(context, "shop", color=False)  # nothing measured: no claim

    db.set_meta(conn, f"injected:{db.timeutil.day(db.timeutil.iso())}", "2,300")  # a day written before the work column
    capture._count_injection(conn, db.timeutil.iso(), 100, 10_000)
    injected = _injected(conn)
    assert (injected["blocks"], injected["tokens"], injected["work"]) == (3, 400, 10_000)
    assert injected["saved_percent"] == 96  # 9,600 of 10,000


def test_a_growing_transcript_is_read_from_where_the_open_turn_begins(conn) -> None:
    """A 220 MB Claude Code session took 2.1 s to read, and the indexer read it again after every turn."""
    now = "2026-10-13T11:"
    turns = _session(conn, "claude", "s3", [(f"{now}00:00.000Z", f"{now}05:00.000Z"), (f"{now}06:00.000Z", None)])
    conn.execute("UPDATE sessions SET last_event_at = ?", (db.timeutil.iso(),))
    path = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-tmp-p" / "s3.jsonl"
    _lines(path, [_assistant(f"{now}01:00.000Z", "a", 100, 0), _assistant(f"{now}06:30.000Z", "b", 7, 0)])
    assert work.measure(conn) == 1  # the second turn is still open

    read: list[int] = []
    original = work._claude_usage

    def spy(file: Path, offset: int = 0):
        read.append(offset)
        return original(file, offset)

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_assistant(f"{now}07:00.000Z", "c", 3, 0)) + "\n")
    conn.execute("UPDATE turns SET ended_at = ? WHERE id = ?", (f"{now}09:00.000Z", turns[1]))
    work._claude_usage = spy  # type: ignore[assignment]
    try:
        assert work.measure(conn) == 1
    finally:
        work._claude_usage = original  # type: ignore[assignment]
    assert read and read[0] > 0  # resumed, not from the start
    assert dict(conn.execute("SELECT id, work_tokens FROM turns").fetchall()) == {turns[0]: 100, turns[1]: 10}

    _lines(path, [_assistant(f"{now}20:00.000Z", "z", 1, 0)])  # rewritten shorter: start over
    conn.execute(
        "INSERT INTO turns(session_id, project_id, started_at, ended_at, prompt) VALUES ('claude:s3', 'p', ?, ?, 'x')",
        (f"{now}19:00.000Z", f"{now}21:00.000Z"),
    )
    assert work.measure(conn) == 1
    assert conn.execute("SELECT work_tokens FROM turns ORDER BY id DESC LIMIT 1").fetchone()[0] == 1


def test_copilot_turn_work_counts_input_minus_cache_reads(conn) -> None:
    turns = _session(conn, "copilot", "19a2", [("2026-10-13T14:30:59.000Z", "2026-10-13T14:31:04.600Z")])
    conn.execute("UPDATE sessions SET last_event_at = ?", (db.timeutil.iso(),))

    def usage(ts: str, inputs: int, read: int, write: int, output: int) -> dict:
        record = {"inputTokens": inputs, "cacheReadTokens": read, "cacheWriteTokens": write, "outputTokens": output}
        return {"type": "session.usage_record", "timestamp": ts, "data": {"usage": record}}

    # Shape and numbers of a real CLI 1.0.96 transcript: inputTokens includes the cache reads and writes.
    _lines(
        Path(os.environ["COPILOT_HOME"]) / "session-state" / "19a2" / "events.jsonl",
        [
            {"type": "user.message", "timestamp": "2026-10-13T14:30:59.700Z", "data": {"content": "hi"}},
            usage("2026-10-13T14:31:03.005Z", 14115, 0, 14112, 26),
            usage("2026-10-13T14:31:04.300Z", 14168, 14112, 53, 5),
        ],
    )
    assert work.measure(conn) == 1
    assert conn.execute("SELECT work_tokens FROM turns WHERE id = ?", (turns[0],)).fetchone()[0] == 14141 + 61
