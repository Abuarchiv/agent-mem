"""Queue, bundle and provider chain: standard library only, run in CI (docs/PLAN.md §4.2, §4.3, D12)."""

from __future__ import annotations

import json
from pathlib import Path

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.hooks import hook


def _payload(project: Path, session: str, **fields: object) -> str:
    return json.dumps({"session_id": session, "cwd": str(project), **fields})


def _turn(config: Config, project: Path, session: str, prompt: str, answer: str, harness: str = "claude") -> None:
    hook.run(harness, None, _payload(project, session, hook_event_name="UserPromptSubmit", prompt=prompt), config)
    hook.run(harness, None, _payload(project, session, hook_event_name="Stop", last_assistant_message=answer), config)


def test_migration_002_applies_to_existing_v1_database(config: Config) -> None:
    conn = db.connect(config)
    conn.execute("PRAGMA user_version = 1")
    for table in ("observe_queue", "observe_calls", "observe_forget"):
        conn.execute(f"DROP TABLE {table}")
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 2
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"observe_queue", "observe_calls", "observe_forget"} <= names
    conn.close()


def test_turn_close_enqueues_and_hook_path_stays_stdlib(config: Config, project: Path) -> None:
    _turn(config, project, "s1", "Wir nutzen uv.", "ok")
    conn = db.connect(config)
    row = conn.execute("SELECT state, attempts FROM observe_queue").fetchone()
    assert (row["state"], row["attempts"]) == ("pending", 0)
    conn.close()


def test_lease_bundle_groups_same_session_and_backs_off(config: Config, project: Path) -> None:
    from agent_mem.observe import queue

    _turn(config, project, "s1", "eins", "a")
    _turn(config, project, "s1", "zwei", "b")
    _turn(config, project, "s2", "drei", "c")
    conn = db.connect(config)
    rows = queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
    assert [r["session_id"].endswith("s1") for r in rows] == [True, True]
    assert queue.lease_bundle(conn, max_turns=5, lease_seconds=60)[0]["session_id"].endswith("s2")
    turn_ids = [int(r["turn_id"]) for r in rows]
    queue.fail(conn, turn_ids, "claude exit 1: boom")
    row = conn.execute(
        "SELECT state, attempts, next_try, last_error FROM observe_queue WHERE turn_id = ?", (turn_ids[0],)
    ).fetchone()
    assert row["state"] == "pending" and row["attempts"] == 1 and row["next_try"] > row["last_error"][:0]
    assert queue.status(conn)["queue"]["pending"] == 2  # both failed turns wait for their backoff
    assert not queue.lease_bundle(conn, max_turns=5, lease_seconds=60)  # nothing due yet
    for _ in range(queue.MAX_ATTEMPTS):
        conn.execute(
            "UPDATE observe_queue SET next_try = '2000-01-01T00:00:00Z' WHERE turn_id IN (?, ?)", tuple(turn_ids)
        )
        queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
        queue.fail(conn, turn_ids, "still failing")
    assert (
        conn.execute("SELECT state FROM observe_queue WHERE turn_id = ?", (turn_ids[0],)).fetchone()["state"]
        == "failed"
    )
    assert queue.retry_failed(conn) == 2
    conn.close()


def test_bundle_respects_token_cap_and_excludes_tool_output(config: Config, project: Path) -> None:
    from agent_mem.observe import bundle, queue

    config.observe.bundle_tokens = 100  # 400 characters
    _turn(config, project, "s1", "x" * 300, "y" * 300)
    _turn(config, project, "s1", "kurz", "knapp")
    conn = db.connect(config)
    rows = queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
    bundles = bundle.build(conn, config, [int(r["turn_id"]) for r in rows])
    assert len(bundles) == 2  # the oversized turn is truncated and stands alone
    assert bundles[0].chars <= 400
    assert bundles[1].messages[0]["content"] == "kurz"
    assert all(b.harness == "claude" for b in bundles)
    conn.close()


def test_chain_is_vendor_faithful_by_default(config: Config, monkeypatch) -> None:
    from agent_mem.observe import providers

    monkeypatch.setattr(providers, "available", lambda name: True)
    conn = db.connect(config)
    assert providers.chain(config, "claude", conn) == ["claude"]
    assert providers.chain(config, "codex", conn) == ["codex"]
    assert providers.chain(config, "opencode", conn) == []  # raw stage unless ollama is opted in (B.20)
    config.observe.providers.append("ollama")
    assert providers.chain(config, "opencode", conn) == ["ollama"]
    config.observe.cross_vendor = True
    assert providers.chain(config, "claude", conn) == ["claude", "codex", "copilot", "ollama"]
    providers.note_failure(conn, config, "claude", providers.ProviderError("claude exit 1: usage limit reached"))
    assert "claude" not in providers.chain(config, "claude", conn)
    assert providers.ProviderError("Not logged in").kind == "login"
    assert providers.ProviderError("claude: timeout after 120s").kind == "timeout"
    conn.close()


def test_spawn_observer_is_throttled_and_respects_no_spawn(config: Config, monkeypatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(hook, "_spawn", lambda argv, cfg: calls.append(argv) or True)
    monkeypatch.delenv("AGENT_MEM_NO_SPAWN", raising=False)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    assert hook.spawn_observer(config) is True
    assert hook.spawn_observer(config) is False  # marker younger than the throttle
    assert calls and calls[0][-3:] == ["observe", "--drain", "--quiet"]
    monkeypatch.setenv("AGENT_MEM_NO_SPAWN", "1")
    (config.data_dir / ".observer-spawned").unlink()
    assert hook.spawn_observer(config) is False


def test_worker_without_embedder_stores_raw(config: Config, monkeypatch) -> None:
    """No semantic extra, no mem0 index: the stage chain collapses to raw instead of failing forever."""
    from agent_mem.observe import bundle, providers, worker

    monkeypatch.setattr(providers, "available", lambda name: True)
    conn = db.connect(config)
    w = worker.Worker(config, conn)

    def boom(self):
        raise RuntimeError("no embedder available")

    monkeypatch.setattr(worker.Worker, "adapter", property(boom))
    b = bundle.Bundle(
        turn_ids=[1], session_id="s", project_id=None, harness="claude", messages=[{"role": "user", "content": "x"}]
    )
    assert w.process(b) == "raw"
    conn.close()


def test_doctor_and_capture_survive_a_database_without_observer_tables(config: Config, project: Path) -> None:
    """A database whose version says current but lacks the observer tables (foreign lineage) must not crash."""
    from agent_mem.cli import health

    conn = db.connect(config)
    conn.execute("DROP TABLE observe_queue")
    conn.commit()
    conn.close()
    hook.run(
        "claude",
        None,
        json.dumps({"session_id": "s", "cwd": str(project), "hook_event_name": "UserPromptSubmit", "prompt": "hi"}),
        config,
    )
    hook.run(
        "claude",
        None,
        json.dumps({"session_id": "s", "cwd": str(project), "hook_event_name": "Stop", "last_assistant_message": "ok"}),
        config,
    )
    conn = db.connect(config)
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1
    conn.close()
    checks = health.doctor(config)
    bad = [c for c in checks if c.name == "observer queue"]
    assert bad and not bad[0].ok and "observer tables" in bad[0].detail
