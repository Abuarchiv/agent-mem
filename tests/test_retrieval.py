import json
import zlib
from datetime import UTC, datetime, timedelta

import numpy as np

from agent_mem.core import db, timeutil
from agent_mem.core.config import Config
from agent_mem.hooks import inject
from agent_mem.memory import consolidate, search, semantic, store, views
from tests.conftest import Driver


class FakeEmbedder:
    """Deterministic bag-of-words embedder for tests (no model download)."""

    model = "fake"

    def _vec(self, text: str) -> np.ndarray:
        vector = np.zeros(64, dtype=np.float32)
        for word in text.lower().replace(":", " ").split():
            vector[zlib.crc32(word.encode()) % 64] += 1.0  # hash() differs per process and made the test flaky
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


def test_a_commit_is_found_by_its_hash_and_its_subject(driver: Driver, conn, config: Config):
    """The hash of a commit is only in git's output; a later "which commit did X" needs it in the turn."""
    driver.prompt("s1", "teile build_snapshot auf und committe")
    driver.edit("s1", "src/ui/__init__.py")
    driver.bash(
        "s1",
        'git add -A && git commit -q -m "Viewer: build_snapshot aufgeteilt, ungenutztes CSS entfernt"',
        "[main 8760496] Viewer: build_snapshot aufgeteilt, ungenutztes CSS entfernt\n 2 files changed",
    )
    driver.bash("s1", "git commit -m wip", "[main 1a2b3c4] wip", failed=True)  # a failed commit made none
    driver.stop("s1", "Aufgeteilt und lokal committet.")
    store.index_turn(conn, conn.execute("SELECT id FROM turns").fetchone()[0])
    assert json.loads(conn.execute("SELECT commits_json FROM turns").fetchone()[0]) == [
        "8760496 Viewer: build_snapshot aufgeteilt, ungenutztes CSS entfernt"
    ]
    retriever = semantic.Retriever(conn, config)
    for question in ("In welchem Commit wurde build_snapshot aufgeteilt?", "was steht in 8760496"):
        hits = retriever.search(question, _pid(conn), record_shown=False)
        assert hits and "8760496" in hits[0].topic, question
    assert "commit 8760496" in inject.hit_line(hits[0])
    # A turn recorded before the column existed gets its commits once, from the output its events still hold.
    conn.execute("UPDATE turns SET commits_json = '[]'")
    assert store.backfill_commits(conn) == 1 and store.backfill_commits(conn) == 0
    assert "8760496" in conn.execute("SELECT commits_json FROM turns").fetchone()[0]
    assert retriever.search("was steht in 8760496", _pid(conn), record_shown=False)


def test_a_file_named_with_its_extension_finds_the_answer_that_names_it_without(driver: Driver, conn, config: Config):
    """The question says `006_work_tokens.sql`, the long answer listing the migrations `006_work_tokens`: in BM25
    it sank behind every short text with "Schema" and "Migration" (real data: rank 85 of 225)."""
    for n in range(80):  # more than the 60 word-search candidates
        driver.prompt(f"s{n}", f"Schema-Migration {n} prüfen")
        driver.stop(f"s{n}", "Schema-Migration geprüft, folgt morgen.")
    driver.prompt("long", "liste die Migrationen auf")
    report = "Bericht über den Umbau der Datenbank und der Hooks. " * 60
    driver.stop("long", report + "\n- `006_work_tokens`: Token-Arbeit pro Turn\n- `007_relations`: Graph\n" + report)
    hits = semantic.Retriever(conn, config).search(
        "Welche Schema-Migration folgt auf 006_work_tokens.sql?", _pid(conn), limit=5, record_shown=False
    )
    assert any("007_relations" in h.answer for h in hits)


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
    # Words around the topic are no topic; seven digits and more are an id.
    assert search.query_terms("Was merkt sich der Hook beim Start ohne Projekt, siehe 8760496?") == [
        "merkt",
        "hook",
        "start",
        "siehe",
        "8760496",
    ]
    # A long compound is about its first word: the install scripts are install.sh and install.ps1.
    assert search.coverage("`install.sh` und `install.ps1` liegen im sdist", ["installationsskripte"]) == (1.0, 1)
    assert search.coverage("ein anderer Text", ["installationsskripte"]) == (0.0, 0)


def test_a_rare_word_of_the_question_counts_more_than_the_project_name():
    """ "In wie viele Prüfgruppen ist agent-mem doctor aufgeteilt?" ranked the answer sixth on the real database: every
    entry of the project names "agent" and "mem", only the answer names "prüfgruppen"."""
    terms = search.query_terms("In wie viele Prüfgruppen ist agent-mem doctor aufgeteilt?")
    answer = "`doctor` in `cli/health.py` ist in vier Prüfgruppen aufgeteilt."
    others = [f"`agent-mem doctor` zeigt {what} an." for what in ("das Modell je Stufe", "Hooks", "die Datenbank")]
    weights = search.term_weights([answer, *others], terms)
    assert weights["prüfgruppen"] > weights["agent"] > weights["doctor"]
    assert search.coverage(answer, terms)[0] == search.coverage(others[0], terms)[0]
    assert search.coverage(answer, terms, weights)[0] > search.coverage(others[0], terms, weights)[0]
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
    assert by_file[0].label == "T1"  # the graph ties T1 to exporter.py and orders it first


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
    """Saying "pnpm statt npm" twice, later "npm statt pnpm" twice: the newer rule replaces the older one."""
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


def test_a_memory_whose_only_paths_are_gone_is_retired(driver: Driver, conn, config: Config, tmp_path, monkeypatch):
    """M2635 sent every session to the clone `~/Company/agent-mem-audit` after it was deleted. A path proves nothing
    when its folder is missing too (another machine, a moved tree), when it was cut at a space, or outside home
    (`/opt/models` lives in the Docker image); a dead end names the missing file as its failure."""
    home = tmp_path / "home"
    (home / "Company" / "agent-mem").mkdir(parents=True)
    (home / "Library" / "Application Support").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    driver.prompt("s1", "setup")
    texts = {
        "fact": "The audit runs in the clone `~/Company/agent-mem-audit` on branch qualitaet.",
        "lesson": f"Run checks in {home}/Company/agent-mem-audit with the workdir field.",
        "decision": "The repo moved to ~/Company/agent-mem, the clone ~/Company/agent-mem-audit is gone.",
        "preference": "The DB lives in ~/Library/Application Support/agent-mem.",
        "dead_end": "`docker info` fails: ~/.orbstack/run/docker.sock is missing while OrbStack is off.",
    }
    texts_kept = ["Models go to /opt/models in the image.", "Notes are in ~/Old/tree/notes.md."]
    with db.transaction(conn):
        for kind, text in [*texts.items(), *(("fact", t) for t in texts_kept)]:
            store.add_memory(conn, project_id=_pid(conn), kind=kind, title=text, body="", source="agent", trust="agent")

    assert consolidate.run(conn, config)["paths_gone"] == 2

    retired = "SELECT kind FROM memories WHERE invalid_at IS NOT NULL ORDER BY kind"
    assert [r[0] for r in conn.execute(retired)] == ["fact", "lesson"]


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
    """The graph does not vote like a text match; it only reorders hits that text and vectors found."""
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


def test_an_old_answer_that_names_the_question_still_passes_the_gate(config: Config):
    """Age and disuse lower the score; a hit naming most of the question's words is injected anyway."""
    terms = ["datei", "historie", "harnesses", "commit"]
    old = search.Hit(owner=("t", 1), score=0.2, matched_terms=3, coverage=0.75)
    vague = search.Hit(owner=("t", 2), score=0.2, matched_terms=2, coverage=0.5)
    assert search.confident(old, config, terms) and not search.confident(vague, config, terms)


def test_a_name_only_in_a_tool_output_is_found_by_the_agents_search(driver: Driver, conn, config: Config):
    """Which migration follows 006? The answer was only in what ls printed, never in the request or the answer."""
    driver.prompt("s1", "prüfe die Nummern im Schema-Ordner")
    driver.bash("s1", "ls src/core/schema", "001_init.sql\n005_concepts.sql\n006_work_tokens.sql\n007_relations.sql")
    driver.stop("s1", "Keine doppelte Nummer.")
    driver.prompt("s2", "räume die README auf")
    driver.stop("s2", "README gekürzt.")
    for row in conn.execute("SELECT id FROM turns").fetchall():
        store.index_turn(conn, row[0])
    question = "Welche Migration folgt auf 006_work_tokens.sql?"
    hits = semantic.Retriever(conn, config).search(question, _pid(conn), record_shown=False)
    assert hits and "007_relations.sql" in hits[0].passage
    assert "output: " in views.search_lines(hits)
    # The hook's path stays an index lookup: no scan of the events within its deadline.
    hits = search.search(conn, config, search.Query(text=question, project_id=_pid(conn)))
    assert all(not h.passage for h in hits)


def test_the_functions_a_change_defined_find_its_turn(driver: Driver, conn, config: Config):
    """Which functions did the graph drawing get split into? The names are only in the change itself."""
    driver.prompt("s1", "teile das Zeichnen im Viewer auf")
    driver.send(
        "s1",
        "tool",
        tool="Edit",
        tool_use_id="e1",
        tool_input={
            "file_path": f"{driver.cwd}/ui/app.js",
            "old_string": "const draw = () => {",
            "new_string": "const drawEdges = (focus) => {\n};\nconst drawNodes = (focus) => {\n};\nconst draw = () => {",
        },
        tool_output="ok",
        raw_kind="PostToolUse",
    )
    driver.stop("s1", "Aufgeteilt.")
    turn = conn.execute("SELECT id, defines_json FROM turns").fetchone()
    assert json.loads(turn[1]) == ["drawEdges", "drawNodes", "draw"]
    store.index_turn(conn, turn[0])
    hits = semantic.Retriever(conn, config).search("Wo steht drawEdges?", _pid(conn), record_shown=False)
    assert hits and "defines drawEdges" in inject.hit_line(hits[0])
    # A turn recorded before the column existed gets its names once, from the input its events still hold.
    conn.execute("UPDATE turns SET defines_json = '[]'")
    assert store.backfill_defines(conn) == 1 and store.backfill_defines(conn) == 0
    assert "drawEdges" in conn.execute("SELECT defines_json FROM turns").fetchone()[0]


def test_the_agents_search_finds_a_detail_deep_in_a_long_answer(driver: Driver, conn, config: Config):
    """The opening of a long report says what was done; the asked detail is pages further down."""
    filler = " ".join(f"Abschnitt {n} beschreibt Viewer, Hooks und Tests im Überblick." for n in range(40))
    driver.prompt("s1", "liste alle Befehle auf")
    driver.stop("s1", f"Hier die Liste. {filler} Mit `agent-mem view --no-open` erzeugt man die Seite, ohne Browser.")
    driver.prompt("s2", "räume die README auf")
    driver.stop("s2", "README gekürzt.")
    for row in conn.execute("SELECT id FROM turns").fetchall():
        store.index_turn(conn, row[0])
    question = "Wie erzeugt man die Seite ohne Browser?"
    hits = semantic.Retriever(conn, config).search(question, _pid(conn), record_shown=False)
    assert hits and "--no-open" in hits[0].passage and hits[0].passage_from == "answer"
    assert "answer: " in views.search_lines(hits)
    hook_hits = search.search(conn, config, search.Query(text=question, project_id=_pid(conn)))
    assert all(not h.passage for h in hook_hits)


def test_a_one_word_instruction_gets_no_memories_but_a_code_name_does(driver: Driver, conn, config: Config):
    """ "mache weiter" or "push" is an instruction: an old turn that says "weiter" is no answer to it."""
    driver.prompt("s1", "mache weiter mit dem Parser")
    driver.edit("s1", "src/parser.py")
    driver.stop("s1", "Weiter umgebaut: parseLine liest jetzt Tabs.")
    store.index_turn(conn, conn.execute("SELECT id FROM turns").fetchone()[0])
    pid = _pid(conn)
    for prompt in ("mache weiter", "push", "verbessere noch mehr"):
        assert inject.prompt_hints(conn, config, pid, "s2", prompt, "claude") is None, prompt
    assert inject.prompt_hints(conn, config, pid, "s2", "parser.py", "claude") is not None


def test_a_rare_tool_output_list_does_not_lower_the_other_hits(driver: Driver, conn, config: Config):
    """The output list joins only when some tool printed the asked file: it must not move every score."""
    driver.prompt("s1", "pytest.ini Konfiguration für die Einblendung prüfen")
    driver.stop("s1", "Konfiguration der Einblendung geprüft.")
    driver.prompt("s2", "zeige die Dateien")
    driver.bash("s2", "ls", "pytest.ini\nsetup.cfg")
    driver.stop("s2", "Gelistet.")
    for row in conn.execute("SELECT id FROM turns").fetchall():
        store.index_turn(conn, row[0])
    query = search.Query(text="pytest.ini Konfiguration Einblendung", project_id=_pid(conn))
    plain = {h.owner: h.score for h in search.search(conn, config, query)}
    with_output = {h.owner: h.score for h in search.search(conn, config, query, tool_outputs=True)}
    first = next(o for o in plain if o[0] == "t")
    assert with_output[first] >= plain[first]


def test_a_one_word_question_still_asks(driver: Driver, conn, config: Config):
    driver.prompt("s1", "lege ein Dockerfile an")
    driver.edit("s1", "Dockerfile")
    driver.stop("s1", "Dockerfile angelegt.")
    store.index_turn(conn, conn.execute("SELECT id FROM turns").fetchone()[0])
    assert inject.prompt_hints(conn, config, _pid(conn), "s2", "Dockerfile?", "claude") is not None
    assert inject.prompt_hints(conn, config, _pid(conn), "s3", "Dockerfile", "claude") is None  # an instruction


def test_a_turn_without_answer_shows_the_observer_title(driver: Driver, conn):
    """An unanswered request says nothing about what happened; the observer's title does."""
    driver.prompt("s1", "mache weiter mit dem Parser")
    turn = conn.execute("SELECT id FROM turns").fetchone()[0]
    conn.execute("UPDATE turns SET title = 'Parser für Rechnungen fertig' WHERE id = ?", (turn,))
    assert search.load_hits(conn, [("t", turn)])[("t", turn)].title == "Parser für Rechnungen fertig"
    conn.execute("UPDATE turns SET answer = 'Parser steht.' WHERE id = ?", (turn,))
    assert search.load_hits(conn, [("t", turn)])[("t", turn)].title == "mache weiter mit dem Parser"


def test_a_long_answer_shows_its_opening_and_the_part_the_question_names():
    """Injected answers cost 79 % of the prompt tokens; the detail a question asks for is often pages further down."""
    answer = "Viewer umgebaut und lokal committet. " + "Weitere Schritte am Layout. " * 60
    answer += "Exporte und Viewer-Seiten werden mit privaten Dateirechten 0o600 geschrieben. " + "Rest. " * 80
    hit = search.Hit(owner=("t", 1), kind="turn", title="Viewer umbauen", text="", answer=answer)
    line = inject.hit_line(hit, 1200, search.query_terms("Mit welchen Dateirechten werden Exporte geschrieben?"))
    assert "Viewer umgebaut" in line and "0o600" in line
    assert len(line) < 700 < len(inject.hit_line(hit, 1200))
