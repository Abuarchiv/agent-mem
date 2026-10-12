"""Daily review: duplicates and outdated facts across a project's whole memory, retired only with evidence."""

import json

from agent_mem.core import db, timeutil
from agent_mem.memory import store
from agent_mem.observe import review


class Answer:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.prompts: list[str] = []

    def generate_response(self, messages, **kwargs):
        self.prompts.append(messages[0]["content"])
        return json.dumps(self.payload)


def _project(conn) -> str:
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p1', 'shop', '/tmp/shop', '2026-10-01')")
    return "p1"


def _facts(conn, texts: list[str], trust: str = "observer") -> list[int]:
    ids = []
    for n, text in enumerate(texts):
        memory_id = store.add_memory(
            conn,
            project_id="p1",
            kind="fact",
            title=text,
            body=text,
            source="agent",
            trust=trust,
            dedupe=f"mem0:{trust}-{text}",
        )
        assert memory_id is not None
        conn.execute(
            "UPDATE memories SET created_at = ? WHERE id = ?", (f"2026-10-{10 + n:02d}T10:00:00.000Z", memory_id)
        )
        ids.append(memory_id)
    return ids


TEXTS = [
    "agent-mem runs no server and opens no ports",
    "Tests run with uv run pytest",
    "Tests run with `uv run pytest -q`",
    "Lint runs with ruff",
    "The viewer is a static HTML file",
    "Embeddings use MiniLM",
    "Backups are kept for 7 days",
    "The viewer runs on http://localhost:37778 as a background service",
]


def test_review_retires_duplicates_and_outdated_facts_with_evidence(conn):
    _project(conn)
    ids = _facts(conn, TEXTS)
    user = _facts(conn, ["I prefer German answers"], trust="user")[0]
    llm = Answer(
        {
            "duplicates": [{"keep": f"M{ids[2]}", "drop": [ids[1], 99999]}],
            "outdated": [
                {"old": ids[0], "by": ids[7]},
                {"old": ids[4], "by": ids[7]},
                {"old": ids[7], "by": ids[4]},  # the replacing fact must be newer
                {"old": user, "by": ids[7]},  # never the user's own memory
            ],
        }
    )
    assert review.review(conn, llm, "p1") == 3
    assert f"M{ids[0]} (2026-10-10, fact): agent-mem runs no server" in llm.prompts[0]
    assert f"M{user}" not in llm.prompts[0]
    retired = dict(conn.execute("SELECT id, superseded_by FROM memories WHERE invalid_at IS NOT NULL").fetchall())
    assert retired == {ids[1]: ids[2], ids[0]: ids[7], ids[4]: ids[7]}
    forgotten = {r[0] for r in conn.execute("SELECT mem0_id FROM observe_forget")}
    assert forgotten == {f"observer-{TEXTS[n]}" for n in (0, 1, 4)}


def test_review_runs_once_a_day_and_only_with_enough_facts(conn):
    _project(conn)
    _facts(conn, TEXTS[:5])
    assert review.due_projects(conn) == []  # too few facts
    _facts(conn, ["a", "b", "c"])
    assert review.due_projects(conn) == ["p1"]
    review.review(conn, Answer({}), "p1")
    assert review.due_projects(conn) == []
    db.set_meta(conn, "reviewed_at:p1", "2026-01-01T00:00:00.000Z")
    assert review.due_projects(conn) == ["p1"]


def test_a_replacing_fact_is_never_retired_itself(conn):
    _project(conn)
    ids = _facts(conn, TEXTS)
    llm = Answer({"duplicates": [{"keep": ids[2], "drop": [ids[1]]}, {"keep": ids[1], "drop": [ids[2]]}]})
    review.review(conn, llm, "p1")
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE invalid_at IS NOT NULL").fetchone()[0] == 1
    assert timeutil.parse(db.get_meta(conn, "reviewed_at:p1")) is not None
