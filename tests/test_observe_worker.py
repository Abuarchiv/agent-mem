"""Observer worker end to end with the fake provider.

Needs the observer extra (mem0, qdrant) and the semantic extra (fastembed model in the cache);
skipped otherwise. No harness binary and no network beyond a cached embedding model.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from agent_mem.core import db
from agent_mem.core.config import Config, load
from agent_mem.hooks import hook

if importlib.util.find_spec("mem0") is None:
    pytest.skip("observer extra not installed", allow_module_level=True)

pytestmark = pytest.mark.local  # runs only by hand: loads the embedding model
_REAL = load()  # the user's model cache, read at import: the fixtures point HOME and the data dir at tmp


def _payload(project: Path, session: str, **fields: object) -> str:
    return json.dumps({"session_id": session, "cwd": str(project), **fields})


def _turn(config: Config, project: Path, session: str, prompt: str, answer: str) -> None:
    hook.run("claude", None, _payload(project, session, hook_event_name="UserPromptSubmit", prompt=prompt), config)
    hook.run("claude", None, _payload(project, session, hook_event_name="Stop", last_assistant_message=answer), config)


@pytest.fixture
def observe_config(config: Config, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    config.semantic.enabled = True
    config.semantic.model = _REAL.semantic.model
    model_dir = _REAL.model_dir  # read before patching, or the property would call itself
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
    history = sqlite3.connect(observe_config.mem0_dir / "history.db")
    assert history.execute("SELECT COUNT(*) FROM history WHERE memory_id = ?", (mem0_id,)).fetchone()[0] == 0
    history.close()
    worker.close()
    conn.close()


def test_tags_become_kinds_and_rules(observe_config: Config, project: Path, tmp_path: Path, monkeypatch) -> None:
    answers = tmp_path / "fake.json"
    facts = [
        {"text": "[rule] Use pnpm instead of npm."},
        {"text": "[decision] SQLite instead of Postgres because the tool is single-user."},
        {"text": "[dead_end] pytest-xdist broke the fixtures; tests run serially."},
        {"text": "The API runs on Fly.io in fra."},
    ]
    answers.write_text(json.dumps([{"memory": facts}]))
    monkeypatch.setenv("AGENT_MEM_FAKE_LLM", str(answers))
    _turn(observe_config, project, "s1", "hör auf mit npm, wir sind auf pnpm", "ok")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    worker.close()
    kinds = dict(conn.execute("SELECT body, kind FROM memories WHERE source = 'agent'").fetchall())
    assert kinds == {
        "Use pnpm instead of npm.": "preference",
        "SQLite instead of Postgres because the tool is single-user.": "decision",
        "pytest-xdist broke the fixtures; tests run serially.": "dead_end",
        "The API runs on Fly.io in fra.": "fact",
    }
    rule = conn.execute("SELECT pattern, message FROM rules").fetchone()
    assert (rule["pattern"], rule["message"]) == ("npm", "Use `pnpm` instead of `npm`")
    conn.close()


def test_a_bundle_yields_facts_only_from_its_own_turns(
    observe_config: Config, project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """mem0 puts the project's last 10 bundle messages into the extraction prompt; facts of earlier sessions must not
    come back filed under this turn (out of reach of `purge --id` on the turn they came from)."""
    from agent_mem.observe import providers

    prompts: list[str] = []
    real = providers.FakeLLM.generate_response

    def record(self, messages, *args, **kwargs):
        prompts.append("\n".join(str(m.get("content", "")) for m in messages))
        return real(self, messages, *args, **kwargs)

    monkeypatch.setattr(providers.FakeLLM, "generate_response", record)
    _turn(observe_config, project, "s1", "Tests laufen jetzt über nox.", "noxfile.py angelegt.")
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    _turn(observe_config, project, "s2", "Der Hauptbranch heißt jetzt main.", "Umbenannt.")
    worker.run(drain=False)
    worker.close()
    extraction = [p for p in prompts if "Hauptbranch" in p and "## New Messages" in p]
    assert extraction
    history = extraction[0].split("## Last k Messages")[-1].split("## Recently Extracted Memories")[0]
    assert "nox" not in history  # another session's dialogue is no context for this bundle
    conn.close()


def test_facts_stored_in_mem0_before_a_failure_reach_sqlite_on_retry(
    observe_config: Config, project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """mem0 keeps the facts before SQLite takes them. After a failure in between (a long write lock, a killed worker)
    the retry shows the model its own facts as existing memories and extracts nothing; the facts still reach SQLite."""
    import sqlite3 as sqlite

    from agent_mem.observe import worker as worker_mod

    answers = tmp_path / "answers.json"
    answers.write_text(
        json.dumps([{"memory": [{"text": "[decision] Deploys go to Fly.io in region fra."}]}, {"memory": []}])
    )
    monkeypatch.setenv("AGENT_MEM_FAKE_LLM", str(answers))
    _turn(observe_config, project, "s1", "Wir deployen auf Fly.io in fra.", "fly.toml angelegt.")
    real = worker_mod.mirror
    calls = {"n": 0}

    def locked_once(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise sqlite.OperationalError("database is locked")
        return real(*args, **kwargs)

    monkeypatch.setattr(worker_mod, "mirror", locked_once)
    conn = db.connect(observe_config)
    worker = _worker(observe_config, conn)
    worker.run(drain=False)
    conn.execute("UPDATE observe_queue SET next_try = '2000-01-01T00:00:00.000Z'")  # the backoff is over
    worker.run(drain=False)
    worker.close()
    assert conn.execute("SELECT state FROM observe_queue").fetchone()[0] == "done"
    bodies = [r[0] for r in conn.execute("SELECT body FROM memories WHERE dedupe_key LIKE 'mem0:%'")]
    assert bodies == ["Deploys go to Fly.io in region fra."]
    conn.close()
