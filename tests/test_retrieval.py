import json
from datetime import UTC, datetime, timedelta

import numpy as np

from agent_mem import consolidate, db, federate, semantic, store, timeutil
from agent_mem.config import Config
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


def test_time_filtered_search(driver: Driver, conn, config: Config):
    driver.prompt("s1", "rotate the signing keys")
    driver.stop("s1", "done")
    conn.execute("UPDATE turns SET started_at = ?", (timeutil.iso(timeutil.now() - timedelta(days=1)),))
    retriever = semantic.Retriever(conn, config)
    assert retriever.search("gestern signing keys", _pid(conn), record_shown=False)
    assert not retriever.search("heute signing keys", _pid(conn), record_shown=False)


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


def test_federation_reads_claude_auto_memory(driver: Driver, conn, config: Config, project, tmp_path):
    driver.prompt("s1", "hello")
    root = conn.execute("SELECT root FROM projects").fetchone()[0]
    folder = federate.claude_home() / "projects" / federate.encode_claude_project(root) / "memory"
    folder.mkdir(parents=True)
    (folder / "MEMORY.md").write_text("- index")
    (folder / "feedback_testing.md").write_text(
        "---\nname: Always run tox before pushing\ntype: feedback\n---\nUse tox.\n"
    )
    assert federate.run(conn, config) == 1
    assert federate.run(conn, config) == 0  # unchanged file is skipped
    (folder / "feedback_testing.md").write_text("---\nname: Always run nox before pushing\n---\nUse nox.\n")
    assert federate.run(conn, config) == 1
    rows = conn.execute("SELECT title, invalid_at FROM memories WHERE kind = 'native_note' ORDER BY id").fetchall()
    assert rows[0]["invalid_at"] is not None and rows[1]["title"] == "Always run nox before pushing"
    codex = Driver(conn, config, project, harness="codex")
    claude = Driver(conn, config, project, harness="claude")
    assert "nox" in (codex.start("c1").context or "")
    assert "nox" not in (claude.start("s9").context or "")  # Claude already loads its own auto memory


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
