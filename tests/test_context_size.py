"""Context fills what each harness passes on in one hook output, and no more (hooks/inject.HOST_TOKENS)."""

from __future__ import annotations

import json
from pathlib import Path

from agent_mem.cli import install
from agent_mem.core.config import Config
from agent_mem.hooks import inject
from agent_mem.memory import store
from tests.conftest import Driver


def _many(conn, driver: Driver, n: int = 120) -> str:
    driver.prompt("seed", "seed the project")
    project_id = conn.execute("SELECT project_id FROM sessions LIMIT 1").fetchone()[0]
    for i in range(n):
        store.add_memory(
            conn,
            project_id=project_id,
            kind=("decision", "fact", "lesson")[i % 3],
            title=f"Deployment rule {i}: the release script signs artifacts before upload",
            body=f"Deployment rule {i}. " + "The release script signs every artifact before upload, with reasons. " * 6,
            source="agent",
            trust="observer",
        )
    return project_id


def test_claude_gets_everything_that_fits_ten_thousand_characters(conn, config: Config, project: Path):
    driver = Driver(conn, config, project, harness="claude")
    _many(conn, driver)
    start = driver.start("s1").context or ""
    assert 7_000 < len(start) <= 10_000  # filled, but never moved to a file Claude is not told to read
    hints = driver.prompt("s1", "how does the release script sign the artifacts before upload").context or ""
    assert len(hints) <= 10_000
    assert hints.count("- [M") >= 5 and "with reasons" in hints  # several hits, with their bodies


def test_codex_gets_more_and_its_hooks_raise_the_limit(conn, config: Config, project: Path):
    driver = Driver(conn, config, project, harness="codex")
    _many(conn, driver)
    start = driver.start("x1").context or ""
    assert len(start) > 10_000 and inject.tokens(start) <= 7_800
    handlers = json.loads((install.plugins_dir() / "codex" / "hooks.json").read_text())
    limits = {e: g["hooks"][0].get("additionalContextLimit") for e, groups in handlers["hooks"].items() for g in groups}
    assert limits["SessionStart"] == limits["UserPromptSubmit"] == limits["PostToolUse"] == 8000


def test_before_a_tool_call_warning_and_history_share_one_output(config: Config):
    config.budgets.warning = 2_000
    cut = inject.for_host(config, "claude", "pre_tool").budgets
    assert cut.warning + cut.file_history <= 2_400
    assert inject.for_host(config, "opencode", "session_start").budgets.session_start == config.budgets.session_start


def test_a_copilot_subagent_gets_a_short_start_block(conn, config: Config, project: Path):
    driver = Driver(conn, config, project, harness="copilot")
    _many(conn, driver)
    main = driver.start("c1").context or ""
    sub = driver.start("c1", source="subagent").context or ""
    assert inject.tokens(main) > 2_400 >= inject.tokens(sub) > 0
