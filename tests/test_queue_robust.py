"""A broken turn must never stop fact extraction for the turns behind it."""

import json
import types
from pathlib import Path

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.hooks import hook


def _turn(config: Config, project: Path, session: str, prompt: str) -> None:
    base = {"session_id": session, "cwd": str(project)}
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "UserPromptSubmit", "prompt": prompt}), config)
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "Stop", "last_assistant_message": "ok"}), config)


def test_an_unexpected_error_backs_off_the_bundle_instead_of_aborting_the_run(
    config: Config, project: Path, monkeypatch
):
    from agent_mem.observe import worker

    _turn(config, project, "s1", "poison")
    _turn(config, project, "s2", "healthy")
    conn = db.connect(config)
    seen: list[str] = []

    def process(self, bundle):
        seen.append(bundle.session_id)
        if bundle.session_id.endswith("s1"):
            raise ValueError("a fact the store rejects")
        return "raw"

    monkeypatch.setattr(worker.Worker, "process", process)
    w = worker.Worker(config, conn)
    assert w.step() and w.step()  # no exception escapes
    assert [s[-2:] for s in seen] == ["s1", "s2"]  # the turn behind the broken one was processed
    states = dict(conn.execute("SELECT t.prompt, q.state FROM observe_queue q JOIN turns t ON t.id = q.turn_id"))
    assert states == {"poison": "pending", "healthy": "raw"}
    error = conn.execute("SELECT last_error FROM observe_queue WHERE state = 'pending'").fetchone()[0]
    assert error.startswith("ValueError: a fact the store rejects")
    conn.close()


def test_a_turn_whose_worker_keeps_dying_ends_as_failed(config: Config, project: Path):
    from agent_mem.observe import queue

    _turn(config, project, "s1", "kills the worker")
    _turn(config, project, "s2", "fine")
    conn = db.connect(config)
    past = "2000-01-01T00:00:00.000Z"
    conn.execute(
        "UPDATE observe_queue SET state = 'running', lease_until = ?, attempts = ?", (past, queue.MAX_ATTEMPTS + 1)
    )
    conn.execute("UPDATE observe_queue SET attempts = 1 WHERE turn_id = (SELECT id FROM turns WHERE prompt = 'fine')")
    queue.expire_leases(conn)
    states = dict(conn.execute("SELECT t.prompt, q.state FROM observe_queue q JOIN turns t ON t.id = q.turn_id"))
    assert states == {"kills the worker": "failed", "fine": "pending"}
    conn.close()


def test_a_forget_request_survives_a_failed_delete_in_mem0(config: Config):
    from agent_mem.observe import worker

    conn = db.connect(config)
    conn.execute("INSERT INTO observe_forget(mem0_id, ts) VALUES ('m1', '2026-10-12'), ('m2', '2026-10-12')")

    class Adapter:
        def forget(self, mem0_id: str) -> bool:
            if mem0_id == "m1":
                raise RuntimeError("Qdrant storage is locked")
            return False  # already gone

    w = worker.Worker(config, conn, adapter=Adapter())  # type: ignore[arg-type]
    w.drain_forget()
    assert [r[0] for r in conn.execute("SELECT mem0_id FROM observe_forget")] == ["m1"]  # retried next run
    conn.close()


def test_mem_search_does_not_hold_the_write_lock_hooks_wait_for(config: Config, project: Path, monkeypatch):
    import asyncio
    import sqlite3

    from agent_mem.mcp import server as mcp_server

    _turn(config, project, "s1", "configure the viewer launch agent")
    monkeypatch.chdir(project)
    server = mcp_server.build(config)
    real = mcp_server.semantic.Retriever.search
    writes: list[bool] = []

    def search(self, *args, **kwargs):
        other = sqlite3.connect(config.db_path, timeout=0, isolation_level=None)  # a hook in another session
        try:
            other.execute("BEGIN IMMEDIATE")
            other.execute("ROLLBACK")
            writes.append(True)
        except sqlite3.OperationalError:
            writes.append(False)
        finally:
            other.close()
        return real(self, *args, **kwargs)

    monkeypatch.setattr(mcp_server.semantic.Retriever, "search", search)
    asyncio.run(server.call_tool("mem_search", {"query": "viewer launch agent"}))
    assert writes == [True]


def test_a_replayed_stop_answers_the_turn_it_happened_in(config: Config, project: Path):
    from agent_mem.core import spool
    from agent_mem.core.events import Event
    from agent_mem.memory import indexer

    base = {"session_id": "s1", "cwd": str(project)}
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "UserPromptSubmit", "prompt": "first"}), config)
    # The Stop of the first turn hit a locked database and went to the spool ...
    late = Event(
        harness="claude",
        kind="stop",
        session_id="s1",
        ts="2000-01-01T00:00:00.000Z",
        cwd=str(project),
        answer="answer to the first",
        raw_kind="Stop",
    )
    conn = db.connect(config)
    first_started = conn.execute("SELECT started_at FROM turns").fetchone()[0]
    late.ts = first_started  # it happened while the first turn was open
    tool = Event(
        harness="claude",
        kind="tool",
        session_id="s1",
        ts=first_started,
        cwd=str(project),
        tool="Bash",
        tool_input={"command": "pytest -q"},
        tool_output="1 passed",
        raw_kind="PostToolUse",
        tool_use_id="t1",
    )
    spool.write(config.spool_dir, {"type": "event", "event": tool.to_dict()})
    spool.write(config.spool_dir, {"type": "event", "event": late.to_dict()})
    # ... and the next prompt came first.
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "UserPromptSubmit", "prompt": "second"}), config)
    indexer.run(config, allow_download=False)
    rows = {r["prompt"]: (r["answer"], r["commands_json"]) for r in conn.execute("SELECT * FROM turns")}
    assert rows["first"][0] == "answer to the first" and "pytest" in rows["first"][1]
    assert rows["second"] == ("", "[]")
    conn.close()


def test_tools_of_a_spooled_prompt_never_land_in_the_finished_turn_before(config: Config, project: Path):
    base = {"session_id": "s1", "cwd": str(project)}
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "UserPromptSubmit", "prompt": "first"}), config)
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "Stop", "last_assistant_message": "done"}), config)
    # The second prompt is in the spool; its tool call arrives live.
    tool = {**base, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "t9"}
    tool |= {"tool_input": {"command": "pytest -q"}, "tool_response": {"stdout": "1 passed"}}
    hook.run("claude", None, json.dumps(tool), config)
    conn = db.connect(config)
    first = conn.execute("SELECT commands_json FROM turns WHERE prompt = 'first'").fetchone()[0]
    assert first == "[]"
    conn.close()


def test_a_replayed_prompt_does_not_close_the_turn_running_now(config: Config, project: Path):
    from agent_mem.core import spool
    from agent_mem.core.events import Event
    from agent_mem.memory import indexer

    late = Event(
        harness="claude",
        kind="prompt",
        session_id="s1",
        ts="2000-01-01T00:00:00.000Z",
        cwd=str(project),
        prompt="spooled earlier",
        raw_kind="UserPromptSubmit",
    )
    spool.write(config.spool_dir, {"type": "event", "event": late.to_dict()})
    base = {"session_id": "s1", "cwd": str(project)}
    hook.run(
        "claude", None, json.dumps({**base, "hook_event_name": "UserPromptSubmit", "prompt": "running now"}), config
    )
    indexer.run(config, allow_download=False)
    hook.run("claude", None, json.dumps({**base, "hook_event_name": "Stop", "last_assistant_message": "done"}), config)
    conn = db.connect(config)
    rows = {r["prompt"]: (r["outcome"], r["answer"]) for r in conn.execute("SELECT * FROM turns")}
    assert rows["running now"] == ("ok", "done")
    conn.close()


def test_a_model_cli_that_hangs_is_killed_with_its_helpers(tmp_path: Path, monkeypatch):
    import os
    import sys
    import time

    import pytest

    from agent_mem.observe import providers

    if sys.platform == "win32":
        pytest.skip("process groups via taskkill; checked on POSIX")
    pid_file = tmp_path / "helper.pid"
    child = (
        "import subprocess, sys, time; "
        "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
        f"open({str(pid_file)!r}, 'w').write(str(p.pid)); time.sleep(60)"
    )
    monkeypatch.setattr(providers, "TIMEOUT_S", 2)
    started = time.monotonic()
    with pytest.raises(providers.ProviderError, match="timeout after 2s"):
        providers._run([sys.executable, "-c", child], "prompt")
    assert time.monotonic() - started < 15
    helper = int(pid_file.read_text())
    time.sleep(0.5)
    with pytest.raises(ProcessLookupError):
        os.kill(helper, 0)  # the helper process is gone as well


def test_a_locked_database_is_never_moved_aside(config: Config):
    import sqlite3

    from agent_mem.memory import indexer

    conn = db.connect(config)
    conn.execute("INSERT INTO meta(key, value) VALUES ('after_backup', 'written')")
    conn.close()
    locker = sqlite3.connect(config.db_path, isolation_level=None, timeout=0)
    locker.execute("PRAGMA locking_mode=EXCLUSIVE")
    locker.execute("BEGIN EXCLUSIVE")
    locker.execute("UPDATE meta SET value = 'x' WHERE key = 'after_backup'")
    try:
        assert indexer.recover_if_corrupt(config) is False
    finally:
        locker.execute("ROLLBACK")
        locker.close()
    check = db.connect(config)
    assert check.execute("SELECT value FROM meta WHERE key = 'after_backup'").fetchone()[0] == "written"
    check.close()


def test_a_damaged_database_is_moved_aside_with_its_wal_and_replaced_by_a_fresh_one(config: Config):
    from agent_mem.memory import indexer

    db.connect(config).close()
    config.db_path.write_bytes(b"not a database" * 200)
    wal = config.db_path.with_name(config.db_path.name + "-wal")
    wal.write_bytes(b"committed pages")
    assert indexer.recover_if_corrupt(config) is True
    [wal_copy] = config.data_dir.glob("memory.db.corrupt-*-wal")  # kept for a manual rescue, never deleted
    assert wal_copy.read_bytes() == b"committed pages"
    restored = db.connect(config)
    assert db.quick_check(restored)
    restored.close()


def test_an_oversized_database_is_vacuumed_once_a_day_not_on_every_run(config: Config, project: Path, monkeypatch):
    from agent_mem.memory import indexer

    _turn(config, project, "s1", "something to trim")
    config.retention.max_db_mb = 0  # always "too large"
    conn = db.connect(config)
    conn.execute("UPDATE events SET ts = '2000-01-01T00:00:00.000Z'")  # old enough to trim
    statements: list[str] = []
    conn.set_trace_callback(statements.append)
    for _ in range(3):
        indexer.retention(conn, config)
    assert sum(s.strip().upper() == "VACUUM" for s in statements) <= 1
    conn.close()


def test_forgetting_a_turn_takes_what_was_drawn_from_it(config: Config, project: Path):
    from agent_mem import cli
    from agent_mem.memory import store

    _turn(config, project, "s1", "the staging password policy is secret-ish")
    _turn(config, project, "s1", "something unrelated")
    conn = db.connect(config)
    first, second = (int(r[0]) for r in conn.execute("SELECT id FROM turns ORDER BY id"))
    for turn_id, kind, mem0 in ((first, "fact", "a1"), (first, "lesson", None), (second, "fact", "b2")):
        store.add_memory(
            conn,
            project_id=None,
            kind=kind,
            title=f"{kind} of T{turn_id}",
            body="x",
            source="agent",
            trust="observer",
            turn_id=turn_id,
            dedupe=f"mem0:{mem0}" if mem0 else f"lesson:{turn_id}",
        )
    conn.execute("UPDATE sessions SET title = 'Staging policy', summary_json = '{\"learned\": [\"policy\"]}'")
    conn.close()
    assert cli.main(["--data-dir", str(config.data_dir), "purge", "--id", f"T{first}", "--yes"]) == 0
    conn = db.connect(config)
    assert [r[0] for r in conn.execute("SELECT title FROM memories")] == [f"fact of T{second}"]
    assert [r[0] for r in conn.execute("SELECT mem0_id FROM observe_forget")] == ["a1"]
    assert tuple(conn.execute("SELECT title, summary_json FROM sessions").fetchone()) == (None, None)
    conn.close()


def test_forgetting_a_memory_removes_concepts_no_other_memory_names(config: Config):
    from agent_mem.memory import store

    conn = db.connect(config)
    secret = store.add_memory(
        conn, project_id=None, kind="fact", title="Client Muellerbau pays", body="x", source="agent", trust="observer"
    )
    store.add_memory(
        conn, project_id=None, kind="fact", title="Codex reads it", body="y", source="agent", trust="observer"
    )
    other = conn.execute("SELECT id FROM memories WHERE id != ?", (secret,)).fetchone()[0]
    # Concepts mirrored by releases with the graph view stay until no memory names them.
    for key, memory_ids in (("muellerbau", [secret]), ("codex", [secret, other])):
        concept = conn.execute(
            "INSERT INTO concepts(project_id, key, label, type) VALUES ('', ?, ?, 'proper') RETURNING id",
            (key, key.capitalize()),
        ).fetchone()[0]
        for memory_id in memory_ids:
            conn.execute("INSERT INTO concept_links VALUES (?, ?)", (concept, memory_id))
    with db.transaction(conn):
        store.delete_owner(conn, "m", int(secret or 0))
    assert [r[0] for r in conn.execute("SELECT label FROM concepts")] == ["Codex"]  # still named by the other one
    conn.close()


def test_events_of_a_session_with_spooled_events_queue_behind_them(config: Config, project: Path):
    from agent_mem.core import spool
    from agent_mem.core.events import Event
    from agent_mem.memory import indexer

    first = Event(
        harness="claude",
        kind="prompt",
        session_id="s1",
        ts="2026-10-12T10:00:00.000Z",
        cwd=str(project),
        prompt="first, spooled while the database was locked",
        raw_kind="UserPromptSubmit",
    )
    spool.write(config.spool_dir, {"type": "event", "event": first.to_dict()}, spool.session_tag("claude", "s1"))
    base = {"session_id": "s1", "cwd": str(project)}
    stop = json.dumps({**base, "hook_event_name": "Stop", "last_assistant_message": "answer to the first"})
    assert hook.run("claude", None, stop, config) == ""  # queued, not processed ahead of the prompt
    other = {"session_id": "s2", "cwd": str(project), "hook_event_name": "UserPromptSubmit", "prompt": "other session"}
    hook.run("claude", None, json.dumps(other), config)  # another session is not held up
    conn = db.connect(config)
    assert [r[0] for r in conn.execute("SELECT prompt FROM turns")] == ["other session"]
    assert spool.count(config.spool_dir) == 2
    indexer.run(config, allow_download=False)
    turns = {r["prompt"]: (r["answer"], r["outcome"]) for r in conn.execute("SELECT * FROM turns")}
    assert turns["first, spooled while the database was locked"] == ("answer to the first", "ok")
    conn.close()


def test_a_busy_database_is_no_indexer_failure(config: Config, monkeypatch):
    import sqlite3

    from agent_mem.memory import indexer

    db.connect(config).close()

    def busy(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(indexer, "_work", busy)
    assert indexer.run(config, allow_download=False)["skipped"] == "database busy"
    conn = db.connect(config)
    assert conn.execute("SELECT COUNT(*) FROM health WHERE component = 'indexer'").fetchone()[0] == 0
    conn.close()


def test_a_worker_killed_during_the_work_log_does_not_extract_the_bundle_again(
    config: Config, project: Path, monkeypatch
):
    import pytest

    from agent_mem.observe import providers, summary, worker
    from agent_mem.observe.mem0_adapter import Fact

    _turn(config, project, "s1", "nutze uv")
    conn = db.connect(config)
    monkeypatch.setattr(providers, "chain", lambda *a: ["claude"])
    monkeypatch.setattr(providers, "make_llm", lambda *a: object())

    class Adapter:
        memory = type("M", (), {"llm": None, "get_all": lambda self, **kw: {"results": []}})()

        def extract(self, *a):
            return [Fact(id="f1", text="[fact] The project uses uv.")]

    def killed(*a):
        raise KeyboardInterrupt  # SIGTERM/logout while the slow title call runs

    monkeypatch.setattr(summary, "summarize", killed)
    w = worker.Worker(config, conn, adapter=Adapter())  # type: ignore[arg-type]
    with pytest.raises(KeyboardInterrupt):
        w.step()
    assert conn.execute("SELECT state FROM observe_queue").fetchone()[0] == "done"
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE dedupe_key = 'mem0:f1'").fetchone()[0] == 1
    conn.close()


def test_forgotten_and_purged_text_leaves_mem0_history(config: Config, project: Path, tmp_path: Path):
    import types

    import pytest

    storage = pytest.importorskip("mem0.memory.storage")
    from agent_mem.memory import store
    from agent_mem.observe import worker
    from agent_mem.observe.mem0_adapter import Mem0Adapter

    history = storage.SQLiteManager(str(tmp_path / "history.db"))
    history.add_history("f1", None, "secret fact", "ADD")
    history.add_history("f1", "secret fact", None, "DELETE")
    history.add_history("f2", None, "kept fact", "ADD")
    history.save_messages([{"role": "user", "content": "purged prompt"}], "user_id=me")
    adapter = object.__new__(Mem0Adapter)
    adapter.memory = types.SimpleNamespace(db=history, delete=lambda mem0_id: None)  # type: ignore[assignment]

    _turn(config, project, "s1", "purged prompt")
    conn = db.connect(config)
    store.delete_owner(conn, "t", int(conn.execute("SELECT id FROM turns").fetchone()[0]))
    worker.Worker(config, conn, adapter=adapter).drain_forget()
    texts = [r[0] for r in history.connection.execute("SELECT COALESCE(new_memory, old_memory) FROM history")]
    assert texts == ["kept fact"]
    assert history.connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 0
    assert db.get_meta(conn, store.SCRUB_MESSAGES) is None
    conn.close()


def test_with_the_observer_off_no_turn_waits_to_be_sent_later(config: Config, project: Path, monkeypatch):
    from agent_mem.observe import worker

    config.observe.enabled = False
    _turn(config, project, "s1", "captured while model calls are off")
    conn = db.connect(config)
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1  # still captured and searchable
    assert conn.execute("SELECT COUNT(*) FROM observe_queue").fetchone()[0] == 0
    monkeypatch.setattr(worker.Worker, "step", lambda self: (_ for _ in ()).throw(AssertionError("model call")))
    worker.Worker(config, conn).run(drain=False)
    conn.close()


def test_a_usage_limit_wrapped_by_mem0_pauses_the_stage(config: Config, project: Path, monkeypatch):
    """mem0 re-raises a provider's error as ``LLMError(...) from error``. Caught as a generic error, a usage limit
    never paused the stage: every turn spent its attempts and ended in `failed` (sandbox install, 2026-10-13)."""
    from mem0.exceptions import LLMError

    from agent_mem.observe import providers, worker

    monkeypatch.setattr(providers, "available", lambda name: name == "claude")
    _turn(config, project, "s1", "Configure the release workflow")
    conn = db.connect(config)

    class Adapter:
        memory = types.SimpleNamespace(llm=None)

        def extract(self, *args, **kwargs):
            try:
                raise providers.ProviderError("claude exit 1: You've hit your limit · resets 6pm")
            except providers.ProviderError as error:
                raise LLMError(f"LLM extraction failed: {error}") from error

    worker.Worker(config, conn, adapter=Adapter()).step()  # type: ignore[arg-type]
    until = providers.paused_until(conn, "claude")
    assert until
    # The turn that hit the limit waits for the pause too, without spending an attempt.
    assert tuple(conn.execute("SELECT state, attempts, next_try FROM observe_queue").fetchone()) == (
        "pending",
        0,
        until,
    )
    conn.close()


def test_a_logged_out_cli_is_named_in_the_panel_and_in_doctor(config: Config, project: Path, monkeypatch):
    """`claude` logged out kept doctor green; the panel said "1 turn waiting" without saying why."""
    from agent_mem.cli import health
    from agent_mem.hooks import inject
    from agent_mem.observe import providers

    monkeypatch.setattr(providers, "available", lambda name: name == "claude")
    monkeypatch.setattr(health.shutil, "which", lambda name: f"/bin/{name}" if name == "claude" else None)
    conn = db.connect(config)
    providers.note_failure(conn, config, "claude", providers.ProviderError("claude exit 1: Not logged in"))
    assert "`claude` is not logged in" in (inject._facts_line(conn, config, "claude") or "")
    check = health._provider_check(conn, config)
    assert not check.ok and "not logged in" in check.detail and "log in" in (check.fix or "")
    providers.note_failure(conn, config, "claude", providers.ProviderError("claude exit 1: usage limit reached"))
    assert "usage limit" in (inject._facts_line(conn, config, "claude") or "")
    assert health._provider_check(conn, config).ok
    conn.close()
