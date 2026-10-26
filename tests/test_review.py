"""Daily review: duplicates and outdated facts across a project's whole memory, retired only with evidence."""

import json
from datetime import timedelta

import numpy as np

from agent_mem.core import db, timeutil
from agent_mem.memory import semantic, store
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


def _facts(conn, texts: list[str], trust: str = "observer", kind: str = "fact") -> list[int]:
    ids = []
    for n, text in enumerate(texts):
        memory_id = store.add_memory(
            conn,
            project_id="p1",
            kind=kind,
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


def test_old_facts_beyond_the_window_are_reviewed_in_turn(conn):
    _project(conn)
    texts = [f"Fact number {n} about the build" for n in range(900)]
    ids = _facts(conn, texts)
    seen: set[int] = set()
    for _ in range(-(-(len(ids) - review.RECENT) // review.OLDER) + 1):  # enough turns to reach every old fact
        llm = Answer({})
        review.review(conn, llm, "p1")
        seen |= {int(token[1:]) for token in llm.prompts[0].split() if token.startswith("M") and token[1:].isdigit()}
        lines = [line for line in llm.prompts[0].splitlines() if line.startswith("M")]
        dates = [line.split("(")[1][:10] for line in lines]
        assert dates == sorted(dates) and len(lines) <= review.MAX_FACTS  # oldest first, bounded
    assert set(ids) <= seen  # every fact came up at least once, the oldest included


def test_a_review_prompt_fits_the_providers_time_limit(conn):
    """300 facts (about 60k characters) ran into the 120 s limit in 11 of 19 real reviews; 100 took 39 s."""
    _project(conn)
    _facts(conn, [f"Fact {n}: " + "the release job signs every artifact before upload, " * 4 for n in range(400)])
    llm = Answer({})
    review.review(conn, llm, "p1")
    assert len(llm.prompts[0]) <= 30_000


def test_expired_snapshots_go_without_a_replacement_but_only_plain_facts(conn):
    _project(conn)
    _facts(conn, TEXTS)  # enough facts for a review
    ids = _facts(conn, ["Pushed main to GitHub", "The suite has 135 tests", "Formatting runs with ruff format"])
    rule = _facts(conn, ["Never push without asking"], kind="preference")[0]
    llm = Answer({"expired": [ids[0], f"M{ids[1]}", rule, 99999]})
    assert review.review(conn, llm, "p1") == 2
    retired = dict(conn.execute("SELECT id, superseded_by FROM memories WHERE invalid_at IS NOT NULL").fetchall())
    assert retired == {ids[0]: None, ids[1]: None}  # the rule stays; it is not a snapshot
    assert {r[0] for r in conn.execute("SELECT mem0_id FROM observe_forget")} == {
        "observer-Pushed main to GitHub",
        "observer-The suite has 135 tests",
    }


def test_a_rule_gives_way_only_to_another_rule(conn):
    _project(conn)
    _facts(conn, TEXTS)
    fact = _facts(conn, ["The data dir is set with AGENT_MEM_DATA_DIR"])[0]
    rules = _facts(conn, ["Never measure on the live database", "Measure on a scratch copy only"], kind="preference")
    lesson = _facts(conn, ["When measuring, copy the database first"], kind="lesson")[0]
    llm = Answer({"duplicates": [{"keep": fact, "drop": [rules[0]]}, {"keep": lesson, "drop": [rules[1]]}]})
    assert review.review(conn, llm, "p1") == 1
    retired = dict(conn.execute("SELECT id, superseded_by FROM memories WHERE invalid_at IS NOT NULL").fetchall())
    assert retired == {rules[1]: lesson}


def test_review_comes_early_after_many_new_facts(conn):
    _project(conn)
    _facts(conn, TEXTS)
    review.review(conn, Answer({}), "p1")
    db.set_meta(conn, "reviewed_at:p1", "2026-10-20T00:00:00.000Z")  # after the fixture's dates
    now = timeutil.parse("2026-10-20T02:00:00.000Z")  # within EVERY_HOURS of that review
    assert review.due_projects(conn, now=now) == []
    after = "2026-10-20T00:01:00.000Z"
    for memory_id in _facts(conn, [f"New fact {n}" for n in range(review.NEW_FACTS - 1)]):
        conn.execute("UPDATE memories SET created_at = ? WHERE id = ?", (after, memory_id))
    assert review.due_projects(conn, now=now) == []
    extra = _facts(conn, ["One more fact"])[0]
    conn.execute("UPDATE memories SET created_at = ? WHERE id = ?", (after, extra))
    assert review.due_projects(conn, now=now) == ["p1"]


def test_a_stated_replacement_brings_the_review_forward_at_most_hourly(conn):
    """After a stated replacement the review runs within the hour instead of waiting 20 hours or 50 facts."""
    _project(conn)
    _facts(conn, TEXTS)
    db.set_meta(conn, "reviewed_at:p1", "2026-10-20T10:00:00.000Z")
    plain = _facts(conn, ["Logs go to stdout"])[0]
    conn.execute("UPDATE memories SET created_at = '2026-10-20T10:30:00.000Z' WHERE id = ?", (plain,))
    now = timeutil.parse("2026-10-20T11:30:00.000Z")
    assert review.due_projects(conn, now=now) == []  # nothing replaced
    switch = _facts(conn, ["Tests run with nox instead of pytest"])[0]
    conn.execute("UPDATE memories SET created_at = '2026-10-20T10:40:00.000Z' WHERE id = ?", (switch,))
    assert review.due_projects(conn, now=now) == ["p1"]
    assert review.due_projects(conn, now=timeutil.parse("2026-10-20T10:50:00.000Z")) == []  # within the hour


def test_a_failed_review_waits_before_it_is_tried_again(conn, config, monkeypatch):
    """`reviewed_at` is set before the call, so a timed-out review is not paid for again on every worker run; a usage
    limit there pauses the stage like in extraction."""
    from agent_mem.observe import providers, worker

    _project(conn)
    _facts(conn, [*TEXTS[:5], "a", "b", "c"])
    calls: list[str] = []

    class Slow:
        def generate_response(self, messages, **kwargs):
            calls.append("review")
            raise providers.ProviderError("claude exit 1: usage limit reached")

    monkeypatch.setattr(providers, "available", lambda name: name == "claude")
    monkeypatch.setattr(providers, "make_llm", lambda name, model=None: Slow())
    w = worker.Worker(config, conn)
    w.review_due()
    w.review_due()
    assert calls == ["review"]
    assert providers.paused_until(conn, "claude")


def test_no_review_without_a_new_fact(conn):
    """A day without new facts costs no model call: nothing can have become a duplicate or outdated."""
    _project(conn)
    _facts(conn, TEXTS)
    review.review(conn, Answer({}), "p1")
    later = timeutil.now() + timedelta(hours=review.EVERY_HOURS + 1)
    assert review.due_projects(conn, now=later) == []
    fresh = _facts(conn, ["Logs go to stdout"])[0]
    conn.execute("UPDATE memories SET created_at = ? WHERE id = ?", (timeutil.iso(later - timedelta(minutes=1)), fresh))
    assert review.due_projects(conn, now=later) == ["p1"]


def test_facts_that_say_almost_the_same_are_shown_side_by_side_once_however_far_apart(conn):
    _project(conn)
    ids = _facts(conn, [f"Fact {n}" for n in range(review.MAX_FACTS * 2)])
    old_twin, unrelated, newest, a, b = ids[150], ids[151], ids[-1], ids[160], ids[175]  # beyond both slices
    conn.execute("UPDATE memories SET created_at = '2026-11-01T10:00:00.000Z' WHERE id = ?", (newest,))
    conn.execute(
        "UPDATE memories SET created_at = '2026-09-01T10:00:00.000Z' WHERE id IN (?, ?)", (old_twin, unrelated)
    )

    def vector(*values: float) -> bytes:
        return semantic.to_blob(np.array([*values, *[0.0] * (8 - len(values))], dtype=np.float32))

    for owner, vec in (
        (newest, vector(1)),
        (old_twin, vector(0.9, 0.3)),
        (unrelated, vector(0, 1)),
        (a, vector(0, 0, 1)),  # two old facts in other words
        (b, vector(0, 0, 0.9, 0.3)),
    ):
        conn.execute("INSERT INTO vectors(owner_type, owner_id, model, vec) VALUES ('m', ?, 'mini', ?)", (owner, vec))
    llm = Answer({})
    review.review(conn, llm, "p1")
    shown = {int(token[1:]) for token in llm.prompts[0].split() if token.startswith("M") and token[1:].isdigit()}
    assert {old_twin, a, b} <= shown and unrelated not in shown
    assert len(shown) == review.MAX_FACTS  # the twins take slots of the slice, no extra ones
    review.review(conn, llm, "p1")
    again = {int(token[1:]) for token in llm.prompts[1].split() if token.startswith("M") and token[1:].isdigit()}
    assert not {old_twin, a, b} & again  # a pair the model kept is not shown again
