"""A broken turn must never stop fact extraction for the turns behind it."""

import json
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
