"""Turn titles and session summaries (schema v3): parsing, storage, briefing, terminal and viewer."""

import json

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
    assert summary.summarize(conn, llm, session_id, [first, second]) == 2
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
    assert summary.summarize(conn, Answer({"memory": []}), session_id, turn_ids) == 0
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE title IS NOT NULL").fetchone()[0] == 0


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
    assert "Last session · claude" in lines
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
