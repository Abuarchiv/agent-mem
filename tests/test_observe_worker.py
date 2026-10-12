"""Observer worker end to end with the fake provider (docs/PLAN.md §4.2 to §4.6, §9 Phase 1).

Needs the observer extra (mem0, qdrant) and the semantic extra (fastembed model in the cache);
skipped otherwise. No harness binary and no network beyond a cached embedding model.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.hooks import hook

if importlib.util.find_spec("mem0") is None:
    pytest.skip("observer extra not installed", allow_module_level=True)

pytestmark = pytest.mark.local  # runs only by hand: loads the embedding model (R9)


def _payload(project: Path, session: str, **fields: object) -> str:
    return json.dumps({"session_id": session, "cwd": str(project), **fields})


def _turn(config: Config, project: Path, session: str, prompt: str, answer: str) -> None:
    hook.run("claude", None, _payload(project, session, hook_event_name="UserPromptSubmit", prompt=prompt), config)
    hook.run("claude", None, _payload(project, session, hook_event_name="Stop", last_assistant_message=answer), config)


@pytest.fixture
def observe_config(config: Config, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    from agent_mem.core.config import load

    real = load()  # the user's model cache, so no download happens in tests
    config.semantic.enabled = True
    config.semantic.model = real.semantic.model
    model_dir = real.model_dir  # read before patching, or the property would call itself
    monkeypatch.setattr(Config, "model_dir", property(lambda self: model_dir))
    config.observe.providers = ["fake"]
    config.observe.idle_seconds = 0
    return config


def _worker(config: Config, conn):
    from agent_mem.observe.worker import Worker

    return Worker(config, conn)


def test_stop_hook_enqueues_turn_and_marks_spawn(observe_config: Config, project: Path) -> None:
    _turn(observe_config, project, "s1", "Wir nutzen uv als Paketmanager.", "Eingerichtet.")
    conn = db.connect(observe_config)
    rows = conn.execute("SELECT turn_id, state FROM observe_queue").fetchall()
    assert [r["state"] for r in rows] == ["pending"]
    conn.close()


def test_worker_extracts_mirrors_and_finishes(observe_config: Config, project: Path) -> None:
    _turn(observe_config, project, "s1", "Wir nutzen uv als Paketmanager.", "Eingerichtet, uv sync läuft.")
    _turn(observe_config, project, "s1", "Deployment läuft auf Fly.io in fra.", "fly.toml angelegt.")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    try:
        stats = worker.run(drain=False)
    finally:
        worker.close()
    assert stats["bundles"] == 1  # two turns of one session, one add
    assert stats["facts"] == 2
    facts = conn.execute("SELECT title, dedupe_key, trust, source FROM memories WHERE kind = 'fact'").fetchall()
    assert len(facts) == 2
    assert all(f["dedupe_key"].startswith("mem0:") for f in facts)
    assert all(f["trust"] == "observer" and f["source"] == "agent" for f in facts)
    assert {r["state"] for r in conn.execute("SELECT state FROM observe_queue")} == {"done"}
    calls = conn.execute("SELECT provider, purpose, ok FROM observe_calls").fetchall()
    assert next(tuple(c) for c in calls) == ("fake", "extract", 1)
    conn.close()


def test_contradiction_supersedes_old_fact(observe_config: Config, project: Path, tmp_path: Path, monkeypatch) -> None:
    answers = tmp_path / "fake.json"
    answers.write_text(
        json.dumps(
            [
                {"memory": [{"text": "Tests laufen mit pytest über uv run pytest."}]},
                {"memory": [{"text": "Tests laufen jetzt mit nox -s tests, nicht mehr mit pytest."}]},
                {"verdicts": [{"pair": 1, "verdict": "SUPERSEDE"}]},
            ]
        )
    )
    monkeypatch.setenv("AGENT_MEM_FAKE_LLM", str(answers))
    _turn(observe_config, project, "s1", "Tests laufen mit pytest.", "ok")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    _turn(observe_config, project, "s2", "Korrektur: nox statt pytest.", "ok")
    worker.run(drain=False)
    worker.close()
    rows = conn.execute(
        "SELECT body, invalid_at, superseded_by FROM memories WHERE kind = 'fact' ORDER BY id"
    ).fetchall()
    assert len(rows) == 2
    assert rows[0]["invalid_at"] is not None and rows[0]["superseded_by"] == 2
    assert rows[1]["invalid_at"] is None
    judge = conn.execute("SELECT COUNT(*) FROM observe_calls WHERE purpose = 'judge' AND ok = 1").fetchone()[0]
    assert judge == 1
    conn.close()


def test_raw_stage_when_no_provider(observe_config: Config, project: Path) -> None:
    observe_config.observe.providers = ["copilot-that-does-not-exist"]
    _turn(observe_config, project, "s1", "Wir nutzen pnpm workspaces.", "pnpm-workspace.yaml angelegt.")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    worker.close()
    assert conn.execute("SELECT state FROM observe_queue").fetchone()["state"] == "raw"
    raw = conn.execute("SELECT kind, trust, body FROM memories WHERE kind = 'summary'").fetchone()
    assert raw["trust"] == "raw" and "pnpm" in raw["body"]
    conn.close()


def test_forget_reaches_mem0(observe_config: Config, project: Path) -> None:
    from agent_mem.memory import store

    _turn(observe_config, project, "s1", "Realm heißt intern.", "ok")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    fact = conn.execute("SELECT id, dedupe_key FROM memories WHERE kind = 'fact'").fetchone()
    mem0_id = fact["dedupe_key"].split(":", 1)[1]
    store.delete_owner(conn, "m", int(fact["id"]))
    assert conn.execute("SELECT mem0_id FROM observe_forget").fetchone()[0] == mem0_id
    worker.run(drain=False)  # drains observe_forget first
    assert conn.execute("SELECT COUNT(*) FROM observe_forget").fetchone()[0] == 0
    assert worker.stats["forgotten"] == 1
    worker.close()
    conn.close()
