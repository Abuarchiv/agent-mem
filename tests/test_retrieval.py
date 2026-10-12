import json
from datetime import UTC, datetime, timedelta

import numpy as np

from agent_mem.core import db, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import consolidate, semantic, store
from tests.conftest import Driver


class FakeEmbedder:
    """Deterministic bag-of-words embedder for tests (no model download)."""

    model = "fake"

    def _vec(self, text: str) -> np.ndarray:
        vector = np.zeros(64, dtype=np.float32)
        for word in text.lower().replace(":", " ").split():
            vector[hash(word) % 64] += 1.0
        norm = np.linalg.norm(vector)
        return vector / norm if norm else vector

    def passages(self, texts):
        return np.vstack([self._vec(t.replace("passage: ", "")) for t in texts])

    def query(self, text):
        return self._vec(text)


def _pid(conn):
    return conn.execute("SELECT id FROM projects").fetchone()[0]


def test_personalized_pagerank_prefers_seed_neighbourhood():
    graph = {1: [(2, 1.0)], 2: [(1, 1.0), (3, 1.0)], 3: [(2, 1.0)], 4: [(5, 1.0)], 5: [(4, 1.0)]}
    ranks = semantic.personalized_pagerank(graph, [1])
    assert ranks[2] > ranks.get(4, 0.0)
    assert ranks[1] > ranks[3]


def test_time_window_parsing():
    now = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
    start, end = semantic.time_window("was haben wir gestern gemacht", now)
    assert start.date().isoformat() == "2026-09-28" and end - start == timedelta(days=1)
    start, end = semantic.time_window("what did we do last week", now)
    assert end - start == timedelta(days=7) and start < now - timedelta(days=6)
    assert semantic.time_window("fix the parser", now) is None
    assert semantic.strip_time_words("gestern parser bug").strip() == "parser bug"
    # Named and German dates are that day in UTC, not the evening before (local time converted).
    for phrase in ("what shipped on April 8th 2026", "was lief am 8. April 2026", "am 8.4.2026", "on 2026-04-08"):
        start, end = semantic.time_window(phrase, now)
        assert start == datetime(2026, 4, 8, tzinfo=UTC) and end - start == timedelta(days=1), phrase
    assert semantic.time_window("am 24.12.", now)[0].year == 2025  # type: ignore[index]  # past, not future
    assert semantic.time_window("may i ask three things", now) is None


def test_time_window_lists_every_turn_of_that_day(driver: Driver, conn, config: Config):
    driver.prompt("s1", "standup: shipped the auth fix")
    driver.stop("s1", "noted")
    driver.prompt("s2", "ship it")
    driver.stop("s2", "PR #11 opened")
    conn.execute("UPDATE turns SET started_at = '2026-04-08T09:00:00.000Z'")
    driver.prompt("s3", "unrelated later work")
    hits = semantic.Retriever(conn, config).search("what shipped on April 8th 2026?", _pid(conn), record_shown=False)
    assert {h.session_id for h in hits} >= {"claude:s1", "claude:s2"}


def test_query_terms_drop_question_words_and_split_compounds():
    from agent_mem.memory import search

    assert search.query_terms("Welche Logging-Bibliothek verwenden wir in diesem Projekt?") == ["logging", "bibliothek"]
    assert search.query_terms("bump node-version, keep LIN-482 and parse.py") == [
        "bump",
        "node",
        "version",
        "keep",
        "lin-482",
        "parse.py",
    ]
    assert search.stem("deployt") == "deploy" and search.stem("installiere") == "installier"
    assert search.stem("branches") == "branch" and search.stem("code") == "code" and search.stem("v1.2") == "v1.2"


def test_prompt_hint_finds_inflected_words(driver: Driver, conn):
    driver.prompt("s1", "Deploy the API to Fly.io, region fra")
    driver.stop("s1", "Deployed, v12 active in fra")
    other = Driver(conn, driver.config, driver.cwd, harness="codex")
    response = other.prompt("c1", "Wohin wird die API deployt?")
    assert response.context and "fly.io" in response.context.lower()


def test_hybrid_search_with_vectors_and_graph(driver: Driver, conn, config: Config):
    driver.prompt("s1", "Speed up the invoice exporter")
    driver.edit("s1", "exporter.py")
    driver.stop("s1", "Batched writes in exporter.py")
    driver.prompt("s2", "Fix typo in README")
    driver.edit("s2", "README.md")
    driver.stop("s2", "Typo fixed")
    embedder = FakeEmbedder()
    config.retrieval.min_vector_score = 0.3
    assert semantic.embed_pending(conn, embedder) >= 2
    retriever = semantic.Retriever(conn, config, embedder)
    hits = retriever.search("invoice exporter performance", _pid(conn), record_shown=False)
    assert hits[0].label == "T1"
    assert {"fts", "vector"} <= hits[0].sources
    by_file = retriever.search("exporter.py", _pid(conn), record_shown=False)
    assert by_file[0].label == "T1" and "graph" in by_file[0].sources


def test_named_time_ranks_first_and_excludes_nothing(driver: Driver, conn, config: Config):
    driver.prompt("s1", "rotate the signing keys")
    driver.stop("s1", "rotated the old signing keys")
    conn.execute("UPDATE turns SET started_at = ?", (timeutil.iso(timeutil.now() - timedelta(days=1)),))
    driver.prompt("s2", "rotate the signing keys again")
    driver.stop("s2", "rotated the new signing keys")
    retriever = semantic.Retriever(conn, config)
    yesterday = retriever.search("gestern signing keys", _pid(conn), record_shown=False)
    today = retriever.search("heute signing keys", _pid(conn), record_shown=False)
    assert yesterday[0].session_id == "claude:s1" and today[0].session_id == "claude:s2"
    # A future or misread time ("tips for this weekend") must not hide every memory.
    assert len(retriever.search("signing keys tips for next weekend", _pid(conn), record_shown=False)) >= 2


def test_superseded_memories_are_hidden(conn, config: Config, driver: Driver):
    driver.prompt("s1", "setup")
    pid = _pid(conn)
    with db.transaction(conn):
        old = store.add_memory(
            conn,
            project_id=pid,
            kind="decision",
            title="Deploy target is heroku",
            body="heroku",
            source="agent",
            trust="agent",
        )
        new = store.add_memory(
            conn,
            project_id=pid,
            kind="decision",
            title="Deploy target is fly.io",
            body="fly.io",
            source="agent",
            trust="agent",
        )
        store.supersede(conn, old, new)
    hits = semantic.Retriever(conn, config).search("deploy target", pid, record_shown=False)
    labels = [h.label for h in hits]
    assert f"M{new}" in labels and f"M{old}" not in labels


def test_consolidation_promotes_and_expires(tmp_path, conn, config: Config):
    from tests.conftest import Driver as D

    for name in ("a", "b"):
        root = tmp_path / name
        root.mkdir()
        D(conn, config, root).prompt("s" + name, "nein, nutze pnpm statt npm")
        D(conn, config, root).prompt("s" + name, "nein, nutze pnpm statt npm")
    conn.execute("UPDATE rules SET enabled = 1, created_at = '2020-01-01T00:00:00.000Z'")
    stats = consolidate.run(conn, config)
    assert stats["global_preferences"] == 1
    assert stats["rules_expired"] >= 1
    assert (
        conn.execute("SELECT COUNT(*) FROM memories WHERE project_id IS NULL AND kind = 'preference'").fetchone()[0]
        == 1
    )


def test_anchors_detect_changed_and_deleted_files(driver: Driver, conn, project):
    driver.prompt("s1", "edit app")
    driver.edit("s1", "app.py")
    driver.stop("s1", "done")
    consolidate.record_anchors(conn)
    assert consolidate.anchor_status(conn, ("t", 1)) == [("app.py", "unchanged")]
    (project / "app.py").write_text("changed\n")
    assert consolidate.anchor_status(conn, ("t", 1))[0][1].startswith("changed since")
    (project / "app.py").unlink()
    assert consolidate.anchor_status(conn, ("t", 1)) == [("app.py", "deleted")]


def test_link_neighbours_adds_related_keys(driver: Driver, conn, config: Config):
    driver.prompt("s1", "setup")
    pid = _pid(conn)
    with db.transaction(conn):
        store.add_memory(
            conn,
            project_id=pid,
            kind="fact",
            title="database uses postgres",
            body="postgres",
            source="agent",
            trust="agent",
        )
        store.add_memory(
            conn,
            project_id=pid,
            kind="fact",
            title="database uses postgres replicas",
            body="postgres replicas",
            source="agent",
            trust="agent",
        )
    embedder = FakeEmbedder()
    semantic.embed_pending(conn, embedder)
    assert consolidate.link_neighbours(conn, embedder.model, None, threshold=0.5) >= 1


def test_export_is_valid_json(driver: Driver, conn, config: Config, project, capsys, monkeypatch):
    from agent_mem import cli

    driver.prompt("s1", "export me")
    driver.stop("s1", "ok")
    monkeypatch.chdir(project)
    cli.main(["--data-dir", str(config.data_dir), "export", "--project", str(project)])
    data = json.loads(capsys.readouterr().out)
    assert data["version"] == 2 and data["turns"][0]["prompt"] == "export me"
