"""Earlier memories about a file when an agent reads or edits it, in every harness. The history is shown
as extra information and never blocks the read."""

from __future__ import annotations

import os
import time
from pathlib import Path

from agent_mem.core import signals, timeutil
from agent_mem.memory import store
from tests.conftest import Driver

BIG = "x = 1\n" * 400  # 2.4 KB, above the reading threshold


def _remember(conn, driver: Driver, kind: str, title: str, *files: str) -> int:
    driver.prompt("seed", "seed")
    project_id = conn.execute("SELECT project_id FROM sessions WHERE id LIKE '%seed%'").fetchone()[0]
    ids = [store.entity_id(conn, project_id, "file", f) for f in files]
    memory_id = store.add_memory(
        conn,
        project_id=project_id,
        kind=kind,
        title=title,
        body=title,
        source="agent",
        trust="observer",
        entity_ids=ids,
    )
    assert memory_id is not None
    return memory_id


def _pre(driver: Driver, session: str, tool: str, tool_input: dict, raw_kind: str = "PreToolUse"):
    return driver.send(session, "pre_tool", tool=tool, tool_input=tool_input, raw_kind=raw_kind)


def _post(driver: Driver, session: str, tool: str, tool_input: dict):
    driver.counter += 1
    return driver.send(
        session, "tool", tool=tool, tool_use_id=f"r{driver.counter}", tool_input=tool_input, tool_output="..."
    )


def test_claude_read_shows_decisions_once_per_session(driver: Driver, conn, project: Path):
    (project / "db.py").write_text(BIG)
    time.sleep(0.01)
    decision = _remember(conn, driver, "decision", "Connections are pooled per thread, not per request", "db.py")
    driver.prompt("s1", "look at db.py")
    first = _pre(driver, "s1", "Read", {"file_path": str(project / "db.py")})
    assert first.context and f"M{decision}" in first.context and "pooled per thread" in first.context
    assert "history, not its current contents" in first.context
    again = _pre(driver, "s1", "Read", {"file_path": str(project / "db.py")})
    assert again.context is None
    driver.prompt("s2", "look at db.py again")
    assert _pre(driver, "s2", "Read", {"file_path": str(project / "db.py")}).context


def test_small_files_get_no_history_on_read_but_do_on_edit(driver: Driver, conn, project: Path):
    (project / "tiny.py").write_text("x = 1\n")
    _remember(conn, driver, "dead_end", "Inlining the constant broke the importer", "tiny.py")
    driver.prompt("s1", "read tiny.py")
    assert _pre(driver, "s1", "Read", {"file_path": str(project / "tiny.py")}).context is None
    edit = driver.pre_edit("s1", "tiny.py")
    assert edit.context and "Caution" in edit.context and "importer" in edit.context


def test_a_fact_older_than_the_last_change_is_left_out(driver: Driver, conn, project: Path):
    path = project / "api.py"
    path.write_text(BIG)
    fact = _remember(conn, driver, "fact", "api.py exposes three routes", "api.py")
    decision = _remember(conn, driver, "decision", "Routes stay synchronous", "api.py")
    later = timeutil.now().timestamp() + 5  # the clock agent-mem stamps memories with
    os.utime(path, (later, later))
    driver.prompt("s1", "read api.py")
    context = _pre(driver, "s1", "Read", {"file_path": str(path)}).context or ""
    assert f"M{decision}" in context and f"M{fact}" not in context


def test_specific_memories_rank_before_survey_ones(driver: Driver, conn, project: Path, config):
    (project / "core.py").write_text(BIG)
    wide = _remember(
        conn, driver, "decision", "Repo-wide formatting decision", "core.py", *[f"f{i}.py" for i in range(12)]
    )
    narrow = _remember(conn, driver, "decision", "core.py keeps its own cache", "core.py")
    driver.prompt("s1", "read core.py")
    context = _pre(driver, "s1", "Read", {"file_path": str(project / "core.py")}).context or ""
    assert context.index(f"M{narrow}") < context.index(f"M{wide}")


def test_codex_reads_with_sed_and_gets_the_history(conn, config, project: Path):
    (project / "db.py").write_text(BIG)
    codex = Driver(conn, config, project, harness="codex")
    decision = _remember(conn, codex, "decision", "Retries live in the client, not the pool", "db.py")
    codex.prompt("c1", "check the db")
    response = _pre(codex, "c1", "exec_command", {"cmd": ["bash", "-lc", "sed -n '1,80p' db.py"]})
    assert response.context and f"M{decision}" in response.context


def test_copilot_gets_the_history_after_the_call_when_pre_tool_did_not_fire(conn, config, project: Path):
    (project / "db.py").write_text(BIG)
    copilot = Driver(conn, config, project, harness="copilot")
    decision = _remember(conn, copilot, "decision", "Schema changes need a numbered file", "db.py")
    copilot.prompt("p1", "view db.py")
    response = _post(copilot, "p1", "view", {"path": str(project / "db.py")})
    assert response.context and f"M{decision}" in response.context
    assert _post(copilot, "p1", "view", {"path": str(project / "db.py")}).context is None


def test_opencode_read_tool_gets_the_history(conn, config, project: Path):
    (project / "db.py").write_text(BIG)
    opencode = Driver(conn, config, project, harness="opencode")
    lesson = _remember(conn, opencode, "lesson", "Run the migration test after touching db.py", "db.py")
    opencode.prompt("o1", "read db.py")
    response = _pre(opencode, "o1", "read", {"filePath": str(project / "db.py")}, raw_kind="tool.before")
    assert response.context and f"M{lesson}" in response.context


def test_shell_read_files() -> None:
    assert signals.shell_read_files("sed -n '1,80p' src/a.py") == ["src/a.py"]
    assert signals.shell_read_files("head -n 40 README.md") == ["README.md"]
    assert signals.shell_read_files("cat a.py b.py") == ["a.py", "b.py"]
    assert signals.shell_read_files("sed -e 's/a/b/' x.txt") == ["x.txt"]
    assert signals.shell_read_files("pytest -q") == []
    assert signals.shell_read_files("tail -n 5 log.txt") == ["log.txt"]
