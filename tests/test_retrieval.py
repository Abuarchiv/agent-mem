import json
from datetime import UTC, datetime, timedelta

import numpy as np

from agent_mem.core import db, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import consolidate, search, semantic, store
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
    assert by_file[0].label == "T1"  # the graph ties T1 to exporter.py and orders it first (B.33)


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
    for _ in range(2):  # project a takes it back: the global copy follows
        D(conn, config, tmp_path / "a").prompt("sa", "nein, nutze npm statt pnpm")
    consolidate.run(conn, config, None)
    globals_ = "SELECT body FROM memories WHERE project_id IS NULL AND kind = 'preference' AND invalid_at IS NULL"
    assert [r[0] for r in conn.execute(globals_)] == []


def test_a_reversed_command_rule_replaces_the_old_one(driver: Driver, conn, config: Config):
    """Saying "pnpm statt npm" twice, later "npm statt pnpm" twice: both rules stayed and, enabled, blocked both tools."""
    config.rules.auto_enable = True
    for _ in range(2):
        driver.prompt("s1", "nutze pnpm statt npm")
    for _ in range(2):
        driver.prompt("s1", "nutze npm statt pnpm")
    rules = [tuple(r) for r in conn.execute("SELECT pattern, enabled FROM rules ORDER BY pattern")]
    assert rules == [("npm", 0), ("pnpm", 1)]
    valid = "SELECT body FROM memories WHERE kind = 'preference' AND invalid_at IS NULL"
    assert [r[0] for r in conn.execute(valid)] == ["Use `npm` instead of `pnpm`"]


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


def test_a_decision_about_a_deleted_file_leaves_mem0_too(driver: Driver, conn, config: Config, project):
    driver.prompt("s1", "edit app")
    driver.edit("s1", "app.py")
    driver.stop("s1", "done")
    pid, turn = conn.execute("SELECT project_id, id FROM turns").fetchone()
    store.add_memory(
        conn, project_id=pid, kind="decision", title="app.py keeps the retry", body="",
        source="agent", trust="agent", turn_id=turn, dedupe="mem0:abc",
    )  # fmt: skip
    (project / "app.py").write_text("x = 1\n")
    consolidate.record_anchors(conn)
    (project / "app.py").unlink()
    assert consolidate.run(conn, config)["invalidated"] == 1
    assert [r[0] for r in conn.execute("SELECT mem0_id FROM observe_forget")] == ["abc"]


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


def test_semantic_hit_needs_a_third_of_the_terms(config: Config):
    from agent_mem.memory import search

    hit = search.Hit(owner=("t", 1), score=1.0, sources={"fts", "vector"})
    terms = ["test", "account", "staging", "shop", "team"]
    hit.coverage, hit.matched_terms = search.coverage("the tests run with pytest", terms)
    assert hit.matched_terms == 1 and not search.confident(hit, config, terms)  # 1 of 5: unrelated
    terms = ["logging", "bibliothek"]
    hit.coverage, hit.matched_terms = search.coverage("logging with structlog", terms)
    assert search.confident(hit, config, terms)  # 1 of 2 with vector support
    assert search.query_terms("Welche Datei enthält den Vertrag?") == ["datei", "vertrag"]


def test_prompt_hint_ignores_chat_filler_project_name_and_command_lines(driver: Driver, conn):
    driver.start("s1")
    name = conn.execute("SELECT name FROM projects").fetchone()[0]
    driver.prompt("s1", f"Nun schaue ich mir das gesamte {name} an")
    driver.bash("s1", "pytest tests/test_start.py && ./start.sh")
    driver.stop("s1", "Drei Module gefunden.")
    other = Driver(conn, driver.config, driver.cwd)
    assert not other.prompt("s2", f"nun schaue dir das gesamte {name} an").context  # only filler and the name
    assert not other.prompt("s2", "wie starte ich die tests").context  # matched only the command line
    assert other.prompt("s2", "welche module hast du gefunden").context


def test_graph_keeps_working_commands_and_merges_old_command_lines(driver: Driver, conn, config: Config):
    from agent_mem.memory import consolidate, store

    driver.prompt("s1", "run the parser tests")
    driver.bash("s1", "cd app && uv run pytest -q tests/test_parse.py 2>&1 | tail -3", "3 passed")
    driver.bash("s1", "cat app/parse.py", "def parse(): ...")
    driver.edit("s1", "parse.py")
    driver.stop("s1", "Tests pass.")
    keys = {r[0] for r in conn.execute("SELECT key FROM entities WHERE kind = 'command'")}
    assert keys == {"uv run pytest"}  # the working part; reading a file is no topic

    project = conn.execute("SELECT project_id FROM entities WHERE kind = 'command'").fetchone()[0]
    old = store.entity_id(conn, project, "command", "S=/tmp; cd $S && uv run pytest -x")
    scratch = store.entity_id(conn, project, "file", "/private/tmp/x/scratchpad/out.txt")
    turn = conn.execute("SELECT id FROM turns").fetchone()[0]
    conn.execute(
        "INSERT INTO links(owner_type, owner_id, entity_id) VALUES ('t', ?, ?), ('t', ?, ?)", (turn, old, turn, scratch)
    )
    consolidate.run(conn, config)
    keys = {r[0] for r in conn.execute("SELECT key FROM entities WHERE kind IN ('command', 'file')")}
    assert "uv run pytest" in keys and not any(k.startswith(("S=", "/private/tmp")) for k in keys)
    target = conn.execute("SELECT id FROM entities WHERE key = 'uv run pytest'").fetchone()[0]
    assert (
        conn.execute("SELECT COUNT(*) FROM links WHERE entity_id = ? AND owner_id = ?", (target, turn)).fetchone()[0]
        == 1
    )


def test_a_long_report_does_not_match_every_question(driver: Driver, conn):
    driver.prompt("s1", "Refactor the invoice exporter")
    report = "Moved the exporter into its own module and renamed the helpers. " * 12
    driver.stop("s1", report + "Next time start the tests before the release.")
    other = Driver(conn, driver.config, driver.cwd)
    assert not other.prompt("s2", "how do I start the tests").context  # only the end of a long report says so
    assert other.prompt("s2", "how did we refactor the invoice exporter").context


def test_facts_from_one_long_session_are_not_capped(driver: Driver, conn, config: Config):
    from agent_mem.memory import search, store

    driver.start("s1")
    driver.prompt("s1", "Set up the parser project")
    driver.stop("s1", "done")
    project, turn = conn.execute("SELECT project_id, id FROM turns").fetchone()
    for i in range(6):
        store.add_memory(
            conn,
            project_id=project,
            kind="fact",
            title="",
            body=f"Parser rule {i}: tokens are split on spaces.",
            source="agent",
            trust="observer",
            turn_id=turn,
        )
    query = search.Query(text="parser tokens", project_id=project, limit=10)
    facts = [h for h in search.search(conn, config, query) if h.owner[0] == "m"]
    assert len(facts) == 6  # the per-session cap is for turns; six facts of one session are six things


def test_a_newer_near_duplicate_retires_the_older_fact(conn, config: Config):
    import numpy as np

    from agent_mem.memory import semantic, store

    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p', 'p', '/p', 't')")

    def fact(body: str, vector: list[float], trust: str = "observer") -> int:
        memory = store.add_memory(conn, project_id="p", kind="fact", title="", body=body, source="agent", trust=trust)
        conn.execute(
            "INSERT INTO vectors(owner_type, owner_id, model, vec) VALUES ('m', ?, 'm1', ?)",
            (memory, semantic.to_blob(np.array(vector, dtype=np.float32))),
        )
        return memory

    old = fact("Tests run with uv run pytest.", [1.0, 0.0, 0.1])
    mine = fact("Tests run with make test.", [1.0, 0.0, 0.12], trust="user")  # the user's own note
    other = fact("The viewer listens on port 37778.", [0.0, 1.0, 0.0])
    new = fact("Tests run with uv run --frozen pytest.", [1.0, 0.0, 0.11])
    assert semantic.merge_duplicates(conn, config, "m1") == 1
    rows = dict(conn.execute("SELECT id, superseded_by FROM memories").fetchall())
    assert rows[old] == new and rows[mine] is None and rows[other] is None and rows[new] is None
    assert semantic.merge_duplicates(conn, config, "m1") == 0  # only new memories are compared next time


def test_day_words_are_no_topic(driver: Driver, conn):
    driver.start("s1")
    driver.prompt("s1", "Heute läuft der Viewer neu auf Port 37778, was läuft sonst noch heute")
    driver.stop("s1", "Der Viewer läuft heute stabil.")
    other = Driver(conn, driver.config, driver.cwd)
    assert not other.prompt("s2", "was läuft heute im kino").context  # only "läuft" and "heute" in common
    assert other.prompt("s2", "auf welchem port läuft der viewer").context


def test_an_exact_match_is_not_outvoted_by_recent_work_on_a_file_with_the_word_in_its_path(
    driver: Driver, conn, config: Config
):
    """The graph used to vote like a text match with whatever touched such a file last (am2 in B.33)."""
    from agent_mem.memory import store

    driver.prompt("s0", "seed")
    project_id = conn.execute("SELECT project_id FROM sessions LIMIT 1").fetchone()[0]
    exact = store.add_memory(
        conn,
        project_id=project_id,
        kind="fact",
        title="Die Viewer-Timeline blendet Sessions ohne Turns aus und nennt nur deren Anzahl",
        body="Die Viewer-Timeline blendet Sessions ohne Turns aus und nennt nur deren Anzahl",
        source="agent",
        trust="observer",
    )
    timeline = store.entity_id(conn, project_id, "file", "src/ui/timeline.py")
    for n in range(6):  # newer memories naming one word of the question, linked to a file named like another
        store.add_memory(
            conn,
            project_id=project_id,
            kind="fact",
            title=f"Viewer-Farben Runde {n}: Akzentfarbe angepasst",
            body=f"Viewer-Farben Runde {n}: Akzentfarbe angepasst",
            source="agent",
            trust="observer",
            entity_ids=[timeline],
        )
    query = search.Query(text="Wie geht die Viewer-Timeline mit Sessions ohne Turns um?", project_id=project_id)
    hits = search.search(conn, config, query)
    assert hits and hits[0].owner == ("m", exact)
