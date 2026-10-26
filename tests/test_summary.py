"""Turn titles and session summaries (schema v3): parsing, storage, briefing, terminal and viewer."""

import json
import sqlite3

import pytest

from agent_mem import ui
from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.hooks import inject
from agent_mem.observe import summary
from tests.conftest import Driver


class Answer:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.prompts: list[str] = []

    def generate_response(self, messages, **kwargs):
        self.prompts.append(messages[0]["content"])
        return self.payload if isinstance(self.payload, str) else json.dumps(self.payload)


def _session(driver: Driver, conn) -> tuple[str, list[int]]:
    driver.prompt("s1", "Der Parser stürzt bei leeren Rechnungen ab")
    driver.bash("s1", "pytest tests/test_parse.py", "FAILED test_empty - IndexError", failed=True)
    driver.edit("s1", "invoices/parse.py")
    driver.bash("s1", "pytest tests/test_parse.py", "3 passed")
    driver.stop("s1", "Leere Rechnungen ergeben jetzt eine leere Liste; Tests grün.")
    driver.prompt("s1", "<task-notification><summary>Background build finished</summary></task-notification>")
    driver.stop("s1", "Build ok.")
    turn_ids = [int(r[0]) for r in conn.execute("SELECT id FROM turns ORDER BY id")]
    return "claude:s1", turn_ids


def test_summary_titles_turns_and_keeps_a_running_session_summary(driver: Driver, conn):
    session_id, (first, second) = _session(driver, conn)
    llm = Answer(
        {
            "turns": [
                {"id": first, "type": "bugfix", "title": "Parser-Absturz bei leeren Rechnungen behoben"},
                {"id": second, "type": "nonsense", "title": "Build geprüft"},
                {"id": 999, "type": "feature", "title": "not in this bundle"},
            ],
            "session": {
                "title": "Rechnungsparser robust gemacht",
                "learned": ["Leere Rechnungen kommen aus dem Import"],
                "completed": ["Parser gibt leere Liste zurück"],
                "next_steps": ["Import-Validierung ergänzen", "", "x", "y", "z"],
            },
        }
    )
    assert summary.summarize(conn, llm, session_id, [first, second])[0] == 2
    prompt = llm.prompts[0]
    assert "harness notice: Background build finished" in prompt and "Previous summary: none" in prompt
    rows = conn.execute("SELECT id, type, title FROM turns ORDER BY id").fetchall()
    assert [(r["type"], r["title"]) for r in rows] == [
        ("bugfix", "Parser-Absturz bei leeren Rechnungen behoben"),
        ("change", "Build geprüft"),
    ]
    session = conn.execute("SELECT title, summary_json, summarized_at FROM sessions").fetchone()
    stored = json.loads(session["summary_json"])
    assert session["title"] == "Rechnungsparser robust gemacht" and session["summarized_at"]
    assert stored["next_steps"] == ["Import-Validierung ergänzen", "x", "y", "z"]

    # The next bundle sees the summary so far.
    summary.summarize(conn, Answer({"turns": []}), session_id, [second])
    assert conn.execute("SELECT title FROM sessions").fetchone()[0] == "Rechnungsparser robust gemacht"


def test_garbage_answers_change_nothing(driver: Driver, conn):
    session_id, turn_ids = _session(driver, conn)
    with pytest.raises(ValueError):
        summary.summarize(conn, Answer("not json"), session_id, turn_ids)
    assert summary.summarize(conn, Answer({"memory": []}), session_id, turn_ids)[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE title IS NOT NULL").fetchone()[0] == 0


def test_a_one_turn_bundle_keeps_its_title_when_the_model_copies_the_example_id(driver: Driver, conn):
    """A model may answer with the prompt example's id (12 instead of 2); a one-turn bundle keeps its title and
    lesson anyway."""
    session_id, (first, _second) = _session(driver, conn)
    lesson = (
        "When the default uv cache is blocked by a sandbox, set UV_CACHE_DIR to a writable folder, because uv aborts."
    )
    llm = Answer(
        {"turns": [{"id": 12, "type": "bugfix", "title": "Parser fixed"}], "lessons": [{"turn": 12, "text": lesson}]}
    )
    assert summary.summarize(conn, llm, session_id, [first])[:2] == (1, 1)
    assert conn.execute("SELECT title FROM turns WHERE id = ?", (first,)).fetchone()[0] == "Parser fixed"
    assert conn.execute("SELECT turn_id FROM memories WHERE kind = 'lesson'").fetchone()[0] == first


def test_next_session_starts_with_the_summary(driver: Driver, conn, config: Config):
    session_id, turn_ids = _session(driver, conn)
    summary.summarize(
        conn,
        Answer(
            {
                "turns": [{"id": turn_ids[0], "type": "bugfix", "title": "Parser-Absturz behoben"}],
                "session": {"title": "Parser robust", "completed": ["Leere Liste"], "next_steps": ["Import prüfen"]},
            }
        ),
        session_id,
        turn_ids,
    )
    driver.start("s2")
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]
    block = inject.session_start(conn, config, project_id, "claude:s2", "claude")
    assert block is not None
    assert "last session, claude] Parser robust" in block.text
    assert "- Done: Leere Liste" in block.text and "- Next steps: Import prüfen" in block.text

    view = inject.terminal(block.text, "proj", color=False, recent=inject.recent_work(conn, "claude:s2"))
    lines = view.splitlines()
    assert "Recent work" in lines and any("● Parser-Absturz behoben" in line for line in lines)
    assert "Last session · Claude Code" in lines
    assert any("→ next steps Import prüfen" in line for line in lines)

    snapshot = ui.build_snapshot(conn, config)
    turn = next(t for t in snapshot["turns"] if t["id"] == turn_ids[0])
    assert (turn["type"], turn["title"]) == ("bugfix", "Parser-Absturz behoben")
    assert snapshot["sessions"][-1]["summary"]["next_steps"] == ["Import prüfen"] or any(
        s["summary"].get("next_steps") == ["Import prüfen"] for s in snapshot["sessions"]
    )


def test_migration_003_adds_the_columns_to_a_v2_database(config: Config):
    conn = db.connect(config)
    for table, column in (("turns", "title"), ("turns", "type"), ("sessions", "title"), ("sessions", "summary_json")):
        conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    conn.execute("PRAGMA user_version = 2")
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 3
    assert {"title", "type"} <= {r[1] for r in conn.execute("PRAGMA table_info(turns)")}
    assert {"title", "summary_json"} <= {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    conn.close()


def test_migration_004_keeps_the_call_log_and_allows_the_new_purposes(config: Config):
    conn = db.connect(config)
    # A v3 database: the call log as migration 002 created it.
    conn.execute("DROP TABLE observe_calls")
    conn.execute(
        "CREATE TABLE observe_calls (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, provider TEXT NOT NULL, "
        "purpose TEXT NOT NULL CHECK (purpose IN ('extract', 'judge')), seconds REAL NOT NULL, ok INTEGER NOT NULL, "
        "prompt_chars INTEGER NOT NULL, turn_ids TEXT NOT NULL, error TEXT)"
    )
    conn.execute(
        "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
        "VALUES ('2026-10-12', 'claude', 'extract', 1.0, 1, 10, '[1]')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
            "VALUES ('2026-10-12', 'claude', 'summary', 1.0, 1, 0, '[]')"
        )
    conn.execute("PRAGMA user_version = 3")
    conn.close()
    conn = db.connect(config)
    for purpose in ("summary", "review"):
        conn.execute(
            "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
            "VALUES ('2026-10-12', 'claude', ?, 1.0, 1, 0, '[]')",
            (purpose,),
        )
    assert [r[0] for r in conn.execute("SELECT purpose FROM observe_calls ORDER BY id")] == [
        "extract",
        "summary",
        "review",
    ]
    conn.close()


def test_a_bundle_never_mixes_projects(conn, config: Config, tmp_path):
    import subprocess

    from agent_mem.observe import bundle
    from tests.conftest import Driver as Fresh

    parent = tmp_path / "work"
    nested = parent / "agent-mem"
    nested.mkdir(parents=True)
    for root in (parent, nested):
        subprocess.run(["git", "init", "-q", str(root)], check=True)
    (nested / "app.py").write_text("x = 1\n")
    driver = Fresh(conn, config, parent)
    driver.prompt("s1", "What is in this folder?")
    driver.stop("s1", "Several projects.")
    driver.prompt("s1", "Fix agent-mem")
    driver.cwd = str(nested)
    driver.edit("s1", "app.py")
    driver.stop("s1", "Fixed.")
    turn_ids = [int(r[0]) for r in conn.execute("SELECT id FROM turns ORDER BY id")]
    bundles = bundle.build(conn, config, turn_ids)
    names = [conn.execute("SELECT name FROM projects WHERE id = ?", (b.project_id,)).fetchone()[0] for b in bundles]
    assert names == ["work", "agent-mem"] and [len(b.turn_ids) for b in bundles] == [1, 1]


def test_headline_cuts_at_a_word_boundary():
    from agent_mem.core.signals import headline

    text = "Injected memories come oldest first so that a change reads as a change, and a note tells the model " * 2
    cut = headline(text, 80)
    assert len(cut) <= 80 and cut.endswith("…") and not cut[:-1].endswith(" ")
    assert text.startswith(cut[:-1]) and text[len(cut) - 1] == " "
    assert headline("short line\nsecond", 80) == "short line"


def test_last_session_is_found_through_its_turns(conn, config: Config, tmp_path):
    import subprocess

    from tests.conftest import Driver as Fresh

    parent = tmp_path / "work"
    nested = parent / "agent-mem"
    nested.mkdir(parents=True)
    for root in (parent, nested):
        subprocess.run(["git", "init", "-q", str(root)], check=True)
    (nested / "app.py").write_text("x = 1\n")
    driver = Fresh(conn, config, parent)  # the session starts in the parent folder
    driver.prompt("s1", "Fix agent-mem")
    driver.cwd = str(nested)
    driver.edit("s1", "app.py")
    driver.stop("s1", "Fixed.")
    summary.summarize(
        conn,
        Answer({"turns": [], "session": {"title": "Viewer repariert", "next_steps": ["Doku"]}}),
        "claude:s1",
        [1],
    )
    driver.start("s2")
    project_id = conn.execute("SELECT id FROM projects WHERE name = 'agent-mem'").fetchone()[0]
    block = inject.session_start(conn, config, project_id, "claude:s2", "claude")
    assert block is not None and "last session, claude] Viewer repariert" in block.text


def _memory(conn, project_id: str, text: str, kind: str = "preference") -> int:
    from agent_mem.memory import store

    memory_id = store.add_memory(
        conn, project_id=project_id, kind=kind, title=text, body=text, source="agent", trust="observer"
    )
    assert memory_id is not None
    return memory_id


def test_briefing_rotates_what_is_injected_but_never_used(driver: Driver, conn, config: Config):
    from agent_mem.memory import learn

    config.budgets.session_start = 1000  # the briefing fills its budget; 60 memories still have to take turns
    driver.prompt("s1", "setup")
    driver.stop("s1", "ok")
    project_id = conn.execute("SELECT project_id FROM sessions").fetchone()[0]
    ids = [_memory(conn, project_id, f"Preference number {n} about formatting") for n in range(60)]
    first = inject.session_start(conn, config, project_id, "claude:x", "claude")
    assert first is not None
    shown = {owner for owner in first.owners if owner[0] == "m"}
    assert 5 <= len(shown) < len(ids)
    for n in range(4):  # injected at four starts, never opened, cited or edited
        learn.record_access(conn, list(shown), "injected", f"claude:s{n}")
    later = inject.session_start(conn, config, project_id, "claude:y", "claude")
    assert later is not None
    assert any(owner[0] == "m" and owner not in shown for owner in later.owners)  # others get their turn
    # Injections do not raise activation; otherwise stale items keep coming back.
    stats = learn.owner_stats(conn, list(shown))
    assert all(stat.injected == 4 and stat.briefing_factor < 1.0 for stat in stats.values())


def test_briefing_leaves_out_what_was_injected_often_and_never_used(driver: Driver, conn, config: Config):
    """The briefing fills its budget: ranking alone kept the same old lessons in it at 40 to 50 starts
    without one use (14 of 50 entries in the Lernen project). A preference the user stated stays: it is followed
    without being cited."""
    from agent_mem.memory import learn

    driver.prompt("s1", "setup")
    driver.stop("s1", "ok")
    project_id = conn.execute("SELECT project_id FROM sessions").fetchone()[0]
    worn = _memory(conn, project_id, "Lesson about an old release check", "lesson")
    opened = _memory(conn, project_id, "Lesson about the viewer port", "lesson")
    stated = _memory(conn, project_id, "Always answer in German")
    for n in range(learn.WORN_OUT):
        learn.record_access(conn, [("m", worn), ("m", opened), ("m", stated)], "injected", f"claude:s{n}")
    learn.record_access(conn, [("m", opened)], "get", "claude:s3")

    block = inject.session_start(conn, config, project_id, "claude:y", "claude")

    assert block is not None
    assert ("m", worn) not in block.owners
    assert {("m", opened), ("m", stated)} <= set(block.owners)


def test_briefing_pulls_in_memories_about_the_open_next_steps(driver: Driver, conn, config: Config):
    session_id, turn_ids = _session(driver, conn)
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]
    for n in range(6):
        _memory(conn, project_id, f"Unrelated preference {n} about colors")
    target = _memory(
        conn, project_id, "The import validation lives in importer/validate.py and rejects empty rows", "fact"
    )
    summary.summarize(
        conn,
        Answer(
            {"turns": [], "session": {"title": "Parser robust", "next_steps": ["Import validation for empty rows"]}}
        ),
        session_id,
        turn_ids,
    )
    block = inject.session_start(conn, config, project_id, "claude:s9", "claude")
    assert block is not None and ("m", target) in block.owners
    assert f"[M{target} · " in block.text and "· fact] The import validation" in block.text


def test_lessons_need_evidence_and_reach_the_next_briefing(driver: Driver, conn, config: Config):
    session_id, (first, second) = _session(driver, conn)
    lesson = "When pytest fails with IndexError on empty invoices, guard the parser before indexing, because imports send empty rows."
    llm = Answer(
        {
            "turns": [{"id": first, "type": "bugfix", "title": "Parser fixed"}],
            "lessons": [
                {"turn": first, "text": lesson},
                {"turn": 999, "text": "When anything happens, do something useful, because evidence is missing."},
                {"turn": second, "text": "short"},
            ],
        }
    )
    assert summary.summarize(conn, llm, session_id, [first, second])[1] == 1
    assert "errors: FAILED test_empty - IndexError" in llm.prompts[0]
    row = conn.execute("SELECT kind, trust, turn_id, body FROM memories WHERE kind = 'lesson'").fetchone()
    assert (row["kind"], row["trust"], row["turn_id"], row["body"]) == ("lesson", "observer", first, lesson)
    assert summary.summarize(conn, llm, session_id, [first, second])[1] == 0  # the same lesson twice: kept once

    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]
    for n in range(6):
        _memory(conn, project_id, f"Unrelated preference {n} about colors")
    block = inject.session_start(conn, config, project_id, "claude:s9", "claude")
    assert block is not None and "· lesson] When pytest fails with IndexError" in block.text


def test_the_model_gets_the_work_log_and_the_terminal_shows_it_from_there(driver: Driver, conn, config: Config):
    session_id, (first, second) = _session(driver, conn)
    summary.summarize(
        conn,
        Answer(
            {
                "turns": [
                    {"id": first, "type": "bugfix", "title": "Parser-Absturz behoben"},
                    {"id": second, "type": "change", "title": "Build geprüft"},
                ],
            }
        ),
        session_id,
        [first, second],
    )
    driver.prompt("s2", "Rename the invoice module")  # a later session: it is the "last session" now
    driver.stop("s2", "Renamed.")
    driver.start("s3")
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]
    block = inject.session_start(conn, config, project_id, "claude:s3", "claude")
    assert block is not None
    assert f"[T{first} · " in block.text and "· work, bugfix] Parser-Absturz behoben" in block.text
    assert block.text.count("Rename the invoice module") == 1  # shown as the last session, not twice
    lines = inject.terminal(block.text, "proj", color=False).splitlines()
    assert lines.index("Last session · Claude Code") < lines.index("Recent work")
    assert any("● Parser-Absturz behoben" in line for line in lines)


def test_work_log_budget_keeps_the_newest_turn(driver: Driver, conn):
    session_id, (first, second) = _session(driver, conn)
    summary.summarize(
        conn,
        Answer(
            {
                "turns": [
                    {"id": first, "type": "change", "title": "Older work"},
                    {"id": second, "type": "bugfix", "title": "Newest work"},
                ],
            }
        ),
        session_id,
        [first, second],
    )
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]
    lines = inject._work_lines(conn, project_id, "claude:s2", set(), limit=2)
    assert lines

    block = inject.render(lines, 55)

    assert block is not None
    assert f"[T{second} · " in block.text
    assert f"[T{first} · " not in block.text


def test_the_panel_counts_in_singular_for_one(driver: Driver, conn):
    """One of each reads "1 memory · 1 session · 1 turn", not "1 memories"."""
    from agent_mem.memory import store

    driver.prompt("s1", "Der Parser stürzt bei leeren Rechnungen ab")
    driver.stop("s1", "Behoben.")
    project_id = conn.execute("SELECT project_id FROM sessions").fetchone()[0]
    store.add_memory(conn, project_id=project_id, kind="fact", title="t", body="b", source="agent", trust="observer")
    assert inject.overview(conn, "claude:s1")[0] == "This project: 1 memory (1 new today) · 1 session · 1 request"


def test_a_memory_found_by_two_parts_of_the_briefing_is_shown_once():
    """A lesson picked for its slot and again as an open step must not cost its tokens twice."""
    lines = [("- [M7 · lesson] Rename queue.py", ("m", 7)), ("- [M7 · lesson] Rename queue.py", ("m", 7))]

    block = inject.render(lines, 200)

    assert block is not None
    assert block.text.count("[M7 ") == 1
    assert block.owners == [("m", 7)]


def test_the_work_log_leaves_out_turns_with_no_answer_and_no_change(driver: Driver, conn):
    """ "Bug hunt asked for, nothing recorded" was 61 of 325 work log titles: tokens at every start, nothing to open."""
    session_id, (first, second) = _session(driver, conn)
    conn.execute("UPDATE turns SET answer = '', files_json = '[]' WHERE id = ?", (second,))
    conn.execute("UPDATE turns SET title = 'Real work', answer = 'Done.' WHERE id = ?", (first,))
    conn.execute("UPDATE turns SET title = 'Nothing recorded' WHERE id = ?", (second,))
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id = ?", (session_id,)).fetchone()[0]

    lines = " ".join(line for line, _ in inject._work_lines(conn, project_id, "claude:s9", set(), limit=5))

    assert "Real work" in lines and "Nothing recorded" not in lines
    assert [t for _, _, _, t in inject.recent_work(conn, session_id)] == ["Real work"]
