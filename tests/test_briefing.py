"""The session-start block names the current time and what opening a longer entry costs."""

from __future__ import annotations

import re

from agent_mem.memory import store
from tests.conftest import Driver


def test_briefing_names_the_time_and_the_cost_of_long_entries(driver: Driver, conn):
    driver.prompt("s1", "set things up")
    project_id = conn.execute("SELECT project_id FROM sessions LIMIT 1").fetchone()[0]
    long_id = store.add_memory(
        conn,
        project_id=project_id,
        kind="decision",
        title="The worker drains the queue before exit",
        body="The worker drains the queue before exit. " + "Reason and measurements follow. " * 40,
        source="agent",
        trust="observer",
    )
    short_id = store.add_memory(
        conn,
        project_id=project_id,
        kind="fact",
        title="Port 37778",
        body="Port 37778",
        source="agent",
        trust="observer",
    )
    context = driver.start("s2").context or ""
    assert re.search(r"Current: \d{4}-\d{2}-\d{2} \d{2}:\d{2}", context)
    long_line = next(line for line in context.splitlines() if f"M{long_id} " in line)
    short_line = next(line for line in context.splitlines() if f"M{short_id} " in line)
    assert re.search(r"\(\+\d+ tok\)$", long_line)
    assert "tok)" not in short_line


def test_empty_briefing_stays_empty(driver: Driver):
    assert driver.start("s1").context is None
