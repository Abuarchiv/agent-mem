import json
import os
import subprocess
from pathlib import Path

from agent_mem.core import db, identity
from agent_mem.core.events import Event
from agent_mem.hooks import capture, inject
from agent_mem.memory import consolidate, store
from tests.conftest import Driver


def test_turns_are_formed_and_indexed(driver: Driver, conn):
    driver.start("s1")
    driver.prompt("s1", "Add a health endpoint to app.py")
    driver.edit("s1", "app.py")
    driver.bash("s1", "pytest -q", "3 passed")
    driver.stop("s1", "Added /health to app.py and a test; pytest passes.")
    turn = conn.execute("SELECT * FROM turns").fetchone()
    assert turn["outcome"] == "ok"
    assert json.loads(turn["files_json"]) == ["app.py"]
    assert "pytest -q" in json.loads(turn["commands_json"])
    assert turn["indexed_at"] is not None
    assert conn.execute("SELECT COUNT(*) FROM search_keys WHERE owner_type = 't'").fetchone()[0] == 1
    profile = conn.execute("SELECT key, value FROM profile").fetchall()
    assert ("cmd:test", "pytest -q") in [(r[0], r[1]) for r in profile]


def test_new_prompt_closes_open_turn_as_unknown(driver: Driver, conn):
    driver.prompt("s1", "first request about parser")
    driver.prompt("s1", "second request about lexer")
    outcomes = [r[0] for r in conn.execute("SELECT outcome FROM turns ORDER BY id")]
    assert outcomes == ["unknown", "open"]


def test_events_are_idempotent(conn, config, project):
    event = Event("claude", "prompt", "s1", "2026-09-01T10:00:00.000Z", cwd=str(project), prompt="hello world")
    assert capture.apply(conn, config, event).stored
    assert not capture.apply(conn, config, event).stored
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1


def test_error_fix_recipe_and_hint_in_next_session(driver: Driver, conn, config, project):
    error = "E   ModuleNotFoundError: No module named 'requests'"
    driver.prompt("s1", "fix the failing tests")
    driver.bash("s1", "pytest -q", error, failed=True)
    driver.edit("s1", "requirements.txt")
    driver.bash("s1", "pytest -q", "5 passed")
    driver.stop("s1", "Added requests to requirements.txt")
    recipe = conn.execute("SELECT * FROM recipes").fetchone()
    assert recipe["command_key"] == "pytest"
    assert json.loads(recipe["files_json"]) == ["requirements.txt"]
    assert conn.execute("SELECT resolved FROM events WHERE error_sig IS NOT NULL").fetchone()[0] == 1

    other = Driver(conn, config, project, harness="codex")
    other.prompt("c1", "tests broken")
    response = other.bash("c1", "pytest -q", "E   ModuleNotFoundError: No module named 'httpx'", failed=True)
    assert response.context and "requirements.txt" in response.context
    assert conn.execute("SELECT recurrences FROM recipes").fetchone()[0] == 1


def test_failure_without_error_line_is_no_recipe(driver: Driver, conn, config):
    driver.prompt("s1", "find the parser")
    driver.bash("s1", "grep -rn parse src", "src/lexer.py: tokens = []", failed=True)
    driver.bash("s1", "grep -rn parse src", "src/parse.py: def parse():")
    assert conn.execute("SELECT COUNT(*) FROM recipes").fetchone()[0] == 0
    conn.execute(
        "INSERT INTO recipes(project_id, error_sig, error_text, command_key, files_json, successes, updated_at) "
        "VALUES (NULL, 'a', 'context.arc(p.x, p.y)', 'ls', '[]', 1, 't'), "
        "(NULL, 'b', 'Error: unable to open database', 'uv run pytest', '[]', 1, 't'), "
        "(NULL, 'c', 'cat: x.json: No such file or directory', 'cat', '[]', 1, 't')"
    )
    consolidate.run(conn, config)
    assert [r[0] for r in conn.execute("SELECT command_key FROM recipes")] == ["uv run pytest"]
    driver.bash("s1", "cat conf/app.json", "cat: conf/app.json: No such file or directory", failed=True)
    driver.edit("s1", "conf/app.json")
    driver.bash("s1", "cat conf/app.json", "{}")
    assert conn.execute("SELECT COUNT(*) FROM recipes WHERE command_key = 'cat'").fetchone()[0] == 0


def test_session_start_context_crosses_harnesses(driver: Driver, conn, config, project):
    driver.prompt("s1", "Migrate the queue to Postgres")
    driver.bash("s1", "pytest -q", "ok")
    driver.stop("s1", "Queue now uses Postgres LISTEN/NOTIFY.")
    codex = Driver(conn, config, project, harness="codex")
    response = codex.start("c1")
    assert response.context is not None
    assert "Postgres" in response.context
    assert response.context.startswith("<agent-mem>")
    assert "pytest -q" in response.context
    assert len(response.context) <= config.budgets.session_start * 4


def test_prompt_hints_respect_threshold(driver: Driver, conn, config, project):
    driver.prompt("s1", "Implement the invoice PDF renderer with weasyprint")
    driver.stop("s1", "Renderer in invoices/pdf.py uses weasyprint templates.")
    other = Driver(conn, config, project, harness="codex")
    related = other.prompt("c1", "The invoice PDF renderer crashes with weasyprint")
    unrelated = other.prompt("c1", "Rename the CLI flag --verbose to --debug")
    assert related.context and "invoice" in related.context.lower()
    assert unrelated.context is None


def test_prompt_hints_oldest_first_best_kept(driver: Driver, conn, config, project):
    driver.prompt("s1", "The staging database runs Postgres 14")
    driver.stop("s1", "Staging database on Postgres 14.")
    driver.prompt("s2", "We upgraded the staging database to Postgres 16")
    driver.stop("s2", "Staging database now on Postgres 16.")
    other = Driver(conn, config, project, harness="codex")
    context = other.prompt("c1", "Which Postgres version runs the staging database?").context or ""
    assert "oldest first" in context and context.index("Postgres 14") < context.index("Postgres 16")
    from agent_mem.cli.health import status

    injected = status(conn, config)["injected"]
    assert injected["blocks"] >= 1 and injected["today_tokens"] > 0 and injected["tokens_per_session"]

    config.budgets.prompt = 60  # room for one hit: the best-ranked one stays
    context = other.prompt("c2", "Which Postgres version runs the staging database now, after the upgrade?").context
    assert context and context.count("\n- [") == 1


def test_a_subagent_gets_a_short_start_block_with_the_users_rules(driver: Driver, conn, config, project):
    """Its parent has the full block; 30 subagents with it took a fifth of a week's injected entries."""
    driver.prompt("s1", "Build the billing export")
    project_id = identity.resolve(conn, project).id
    for n, kind in enumerate(["preference"] + ["fact"] * 30):
        text = "Never push without asking" if n == 0 else f"Export step {n} writes billing_{n}.csv with pandas " * 3
        store.add_memory(
            conn, project_id=project_id, kind=kind, title=text, body=text, source="agent", trust="agent", dedupe=str(n)
        )
    full = driver.start("c1").context or ""
    short = driver.start("c1", source="subagent").context or ""
    assert "Never push without asking" in short
    assert inject.tokens(short) <= 300 < inject.tokens(full)


def test_prompt_hints_skip_what_the_context_already_holds(driver: Driver, conn, config, project):
    driver.prompt("s1", "Implement the invoice PDF renderer with weasyprint")
    driver.stop("s1", "Renderer in invoices/pdf.py uses weasyprint templates.")
    other = Driver(conn, config, project, harness="codex")
    assert "weasyprint" in (other.prompt("c1", "The invoice PDF renderer crashes with weasyprint").context or "")
    # Shown once, it is still in the context: the same turn again costs tokens and tells nothing new.
    assert other.prompt("c1", "Does the invoice PDF renderer still use weasyprint?").context is None
    # A subagent's briefing went into the subagent's context, not into this one.
    other.start("c1", source="subagent")
    # Compaction wipes the context: from then on the turn is news again.
    other.send("c1", "compact", raw_kind="PreCompact")
    assert "weasyprint" in (other.prompt("c1", "Which library renders the invoice PDF, weasyprint?").context or "")


def test_compaction_context(driver: Driver, conn):
    driver.prompt("s1", "Refactor the auth module")
    driver.edit("s1", "auth.py")
    response = driver.start("s1", source="compact")
    assert response.context and "Refactor the auth module" in response.context and "auth.py" in response.context


def test_compaction_skips_empty_goal_and_old_failures(driver: Driver, conn):
    driver.bash("s1", "ls logs/", output="ls: logs/: No such file or directory", failed=True)  # turn without prompt
    for n in range(4):
        driver.prompt("s1", f"Step {n} of the auth refactor")
    context = driver.start("s1", source="compact").context or ""
    assert "Session goal" in context and "Step 0 of the auth refactor" in context
    assert "Still failing" not in context


def test_stale_turns_are_closed(driver: Driver, conn, config):
    driver.prompt("s1", "long running work")
    conn.execute("UPDATE sessions SET last_event_at = '2020-01-01T00:00:00.000Z'")
    assert capture.close_stale_turns(conn, config) == 1
    assert conn.execute("SELECT outcome FROM turns").fetchone()[0] == "unknown"


def test_capture_can_be_paused_and_disabled_per_project(driver: Driver, conn, project):
    with db.transaction(conn):
        db.set_meta(conn, "paused_until", "forever")
    assert not driver.prompt("s1", "paused prompt").stored
    conn.execute("DELETE FROM meta WHERE key = 'paused_until'")
    (project / ".agent-mem.json").write_text(json.dumps({"capture": False}))
    assert not driver.prompt("s1", "project disabled").stored
    (project / ".agent-mem.json").unlink()
    assert driver.prompt("s1", "now captured").stored


def test_excluded_files_do_not_store_content(driver: Driver, conn, project):
    driver.prompt("s1", "read env")
    driver.send(
        "s1",
        "tool",
        tool="Read",
        tool_use_id="r1",
        tool_input={"file_path": str(project / ".env")},
        tool_output="DATABASE_PASSWORD=supersecretvalue",
        raw_kind="PostToolUse",
    )
    payload = conn.execute("SELECT payload FROM events WHERE tool = 'Read'").fetchone()[0]
    assert "supersecretvalue" not in payload
    assert "excluded by privacy rules" in payload


def test_secrets_never_reach_the_database_file(driver: Driver, conn, config):
    secret = "sk-" + "ant-api03-" + "Z" * 30
    driver.prompt("s1", f"use key {secret} for the call")
    driver.bash("s1", f"export ANTHROPIC_API_KEY={secret}", f"key={secret}")
    driver.stop("s1", f"configured {secret}")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert secret.encode() not in config.db_path.read_bytes()


def test_own_memory_tools_are_not_captured(driver: Driver, conn):
    driver.prompt("s1", "x")
    driver.send("s1", "tool", tool="mcp__agent-mem__mem_search", tool_input={"query": "x"}, tool_output="...")
    assert conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'tool'").fetchone()[0] == 0


def test_excluded_projects_are_not_captured(driver: Driver, config, project):
    config.excluded_projects = [str(project).upper() if os.name == "nt" else str(project)]
    assert not driver.prompt("s1", "should not be stored").stored
    config.excluded_projects = [str(project) + "-other"]
    assert driver.prompt("s1", "stored now").stored


def test_is_within_handles_prefixes_and_case(tmp_path):
    root = tmp_path / "repo"
    (root / "sub").mkdir(parents=True)
    assert identity.is_within(root / "sub", root)
    assert identity.is_within(root, root)
    assert not identity.is_within(tmp_path / "repo-other", root)
    if os.name == "nt":
        assert identity.is_within(str(root / "sub").upper(), root)


def test_pre_compaction_context_for_opencode(conn, config, project):
    from agent_mem.hooks import hook

    oc = Driver(conn, config, project, harness="opencode")
    oc.prompt("o1", "Port the scheduler to asyncio")
    oc.edit("o1", "scheduler.py")
    output = hook.run("opencode", "session.compacting", json.dumps({"sessionID": "o1", "cwd": str(project)}), config)
    assert "Port the scheduler to asyncio" in json.loads(output)["context"]


def test_copilot_gets_the_essentials_back_with_the_request_after_compaction(conn, config, project):
    """Copilot fires preCompact but no session start after it (CLI 1.0.102, live): the next request carries them."""
    cp = Driver(conn, config, project, harness="copilot")
    cp.prompt("p1", "Port the scheduler to asyncio")
    cp.edit("p1", "scheduler.py")
    assert cp.send("p1", "compact", raw_kind="preCompact").context is None
    after = cp.prompt("p1", "weiter").context or ""
    assert "Port the scheduler to asyncio" in after and "scheduler.py" in after
    assert "Port the scheduler" not in (cp.prompt("p1", "weiter").context or "")  # once, not on every request


def test_copilot_app_worktrees_are_captured_but_its_own_chats_are_not(conn, config, tmp_path):
    """The Copilot app checks repositories out below ~/.copilot/copilot-worktrees; plain chats run in
    ~/.copilot/chats. Everything else below a harness home stays out (its own background agents)."""
    copilot = Path(os.environ["HOME"]) / ".copilot"
    worktree = copilot / "copilot-worktrees" / "demo" / "fix-login"
    chat = copilot / "chats" / "2026-10-13" / "stunning-doodle"
    for folder in (worktree, chat):
        folder.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(worktree)], check=True)
    Driver(conn, config, worktree, harness="copilot").prompt("w", "Fix the login redirect")
    Driver(conn, config, chat, harness="copilot").prompt("c", "hi")
    sessions = {row[0] for row in conn.execute("SELECT native_id FROM sessions")}
    assert sessions == {"w"}


def test_a_stated_rule_is_kept_once_as_its_decision_and_never_echoed_back(conn, config, project):
    """A stated rule ("… We decided to use pytest, never unittest.") is stored once, as a decision. Copilot sends the
    first prompt before the session start, which must not show it back."""
    import json as _json

    from agent_mem.hooks import hook

    base = {"sessionId": "c1", "cwd": str(project), "timestamp": 1791902160502}
    prompt = "Read parse.py and say what parse does. We decided to use pytest, never unittest."
    echoed = hook.run("copilot", "userPromptSubmitted", _json.dumps({**base, "prompt": prompt}), config)
    started = hook.run("copilot", "sessionStart", _json.dumps({**base, "source": "new"}), config)
    kinds = [r[0] for r in conn.execute("SELECT kind FROM memories ORDER BY id")]
    assert kinds == ["decision"]
    assert "pytest" not in echoed and "pytest" not in started.split("\n", 1)[-1]
    later = hook.run("copilot", "sessionStart", _json.dumps({**base, "sessionId": "c2", "source": "new"}), config)
    assert "never unittest" in later


def test_only_a_failing_project_command_makes_a_turn_an_error(driver: Driver, conn):
    """A `cat` of a missing file or a wrong query along the way does not make a turn that ended well an `error`."""
    driver.prompt("s1", "Find where the parser lives")
    driver.bash("s1", "cat docs/parser.md", "cat: docs/parser.md: No such file or directory", failed=True)
    driver.bash("s1", "ls src", "parse.py")
    driver.stop("s1", "The parser is in src/parse.py.")
    driver.prompt("s1", "Fix the parser")
    driver.bash("s1", "pytest -q", "FAILED tests/test_parse.py::test_empty - IndexError", failed=True)
    driver.stop("s1", "I could not fix it yet.")
    assert [r[0] for r in conn.execute("SELECT outcome FROM turns ORDER BY id")] == ["ok", "error"]


def test_a_failure_is_fixed_by_the_same_tool_started_another_way(driver: Driver, conn):
    """`python3 -m pytest` failing and `uv run --with pytest python3 -m pytest` passing after a fix are the same tool:
    the turn is not `error` and the fix is learned."""
    driver.prompt("s1", "Run the tests and fix calc.py")
    driver.bash("s1", "python3 -m pytest -q", "/usr/bin/python3: No module named pytest", failed=True)
    driver.edit("s1", "calc.py")
    driver.bash("s1", "uv run --with pytest python3 -m pytest -q", "1 passed")
    driver.stop("s1", "Fixed calc.add; the tests pass.")
    assert conn.execute("SELECT outcome FROM turns").fetchone()[0] == "ok"
    assert conn.execute("SELECT COUNT(*) FROM events WHERE error_sig IS NOT NULL AND resolved = 0").fetchone()[0] == 0


def test_the_test_command_is_stored_as_it_can_be_run_again(driver: Driver, conn):
    """Neither `python3 -m pytest --version` nor a whole chain with a cache path in front: the stored test command is
    the part that runs the tests."""
    driver.prompt("s1", "Run the tests")
    driver.bash("s1", "python3 -m pytest --version", "pytest 9.1.1")
    driver.bash(
        "s1", "UV_CACHE_DIR=/tmp/c uv run --with pytest python3 -m pytest -q 2>&1 | tail -30; git status", "3 passed"
    )
    driver.stop("s1", "Tests pass.")
    rows = [r[0] for r in conn.execute("SELECT value FROM profile WHERE key = 'cmd:test'")]
    assert rows == ["uv run --with pytest python3 -m pytest -q"]


def test_the_briefing_shows_an_old_recorded_command_as_it_can_be_run(driver: Driver, conn):
    """Rows recorded before capture cleaned them ("… pytest -q 2>&1 | tail -30; git status --short") are shown
    cleaned in the session-start briefing."""
    from agent_mem.hooks import inject

    driver.prompt("s1", "hi")
    project_id = conn.execute("SELECT id FROM projects").fetchone()[0]
    conn.execute(
        "INSERT INTO profile(project_id, key, value, count, updated_at) VALUES (?, 'cmd:test', ?, 5, '2026-10-13')",
        (project_id, "uv run --with pytest python3 -m pytest -q 2>&1 | tail -30; git status --short"),
    )
    assert (
        inject._profile_line(conn, project_id)
        == "- Commands that worked here: test: `uv run --with pytest python3 -m pytest -q`"
    )


def test_a_background_task_notice_continues_the_running_turn(driver: Driver, conn):
    """Claude Code delivers a finished background task as a prompt `<task-notification>…` while the turn runs; it
    must not close the user's turn or take over its actions and answer."""
    notice = "<task-notification>\n<task-id>b1</task-id>\n<summary>Background command finished</summary>\n</task-notification>"
    driver.prompt("s1", "Run the server and fix the failing test")
    driver.bash("s1", "uv run pytest -q", "1 failed", failed=True)
    driver.prompt("s1", notice)
    driver.bash("s1", "uv run pytest -q", "2 passed")
    driver.stop("s1", "Fixed; the tests pass.")
    turns = [tuple(r) for r in conn.execute("SELECT prompt, outcome, answer FROM turns")]
    assert turns == [("Run the server and fix the failing test", "ok", "Fixed; the tests pass.")]
    # with no turn running, the notice starts one: the agent works on it
    driver.prompt("s1", notice)
    driver.stop("s1", "Noted.")
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 2


def test_a_plugin_that_reads_no_context_gets_none_built(conn, config, project):
    """OpenCode's v2 plugin discards what the hook prints: no context is built, nothing counts as injected."""
    from agent_mem.hooks import hook

    oc = Driver(conn, config, project, harness="opencode")
    oc.prompt("o1", "Port the scheduler to asyncio")
    oc.stop("o1", "Ported.")
    payload = {"sessionID": "o2", "cwd": str(project), "reads_context": False}
    assert hook.run("opencode", "session.start", json.dumps(payload), config) == ""
    assert hook.run("opencode", "chat.message", json.dumps({**payload, "prompt": "scheduler asyncio"}), config) == ""
    assert conn.execute("SELECT COUNT(*) FROM accesses WHERE kind = 'injected'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE prompt = 'scheduler asyncio'").fetchone()[0] == 1


def test_names_from_an_excluded_file_are_not_kept(conn, config, project):
    config.exclude_globs.append("private/**")
    driver = Driver(conn, config, project)
    driver.prompt("s1", "rechne die Gehälter")
    driver.send(
        "s1", "tool", tool="Edit", tool_use_id="e1", raw_kind="PostToolUse", tool_output="ok",
        tool_input={"file_path": f"{project}/private/payroll.py", "old_string": "a", "new_string": "def ceo_salary(): pass"},
    )  # fmt: skip
    assert conn.execute("SELECT defines_json FROM turns").fetchone()[0] == "[]"


def test_a_project_relative_exclusion_covers_the_absolute_path_a_tool_names(conn, config, project):
    config.exclude_globs.append("private/**")
    driver = Driver(conn, config, project)
    driver.prompt("s1", "lies die Gehälter")
    driver.send(
        "s1", "tool", tool="Edit", tool_use_id="e2", raw_kind="PostToolUse", tool_output="ok",
        tool_input={"file_path": f"{project}/private/payroll.py", "old_string": "a", "new_string": "CEO = 900000"},
    )  # fmt: skip
    payload = conn.execute("SELECT payload FROM events WHERE kind = 'tool'").fetchone()[0]
    assert "900000" not in payload and "excluded by privacy rules" in payload


def test_a_turn_cut_off_by_the_usage_limit_continues_after_the_reset(driver, conn):
    driver.prompt("s", "refactor the parser")
    driver.bash("s", "pytest", "1 failed")
    turn = conn.execute("SELECT id FROM turns").fetchone()[0]
    conn.execute("UPDATE turns SET outcome = 'unknown', ended_at = started_at WHERE id = ?", (turn,))  # closed as stale
    driver.prompt(
        "s",
        "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; "
        "do not repeat work that is already complete.",
    )
    driver.stop("s", "Parser refactored, tests pass.")
    rows = conn.execute("SELECT id, prompt, answer, outcome FROM turns").fetchall()
    assert [tuple(r) for r in rows] == [(turn, "refactor the parser", "Parser refactored, tests pass.", "ok")]


def test_a_request_names_the_files_another_running_agent_changes_here(driver: Driver, conn):
    """On 2026-10-26 five sessions worked on the same agent-mem request at once, unaware of each other, and changed
    the same files twice over."""
    driver.prompt("s1", "improve the search")
    driver.edit("s1", "app.py")
    told = driver.prompt("s2", "improve everything").context or ""
    assert "Another agent" in told and "app.py" in told
    assert "Another agent" not in (driver.prompt("s2", "go on").context or "")  # told once
    driver.edit("s1", "db.py")
    assert "db.py" in (driver.prompt("s2", "and now?").context or "")  # until it changes another file
    driver.send("s1", "session_end")
    driver.edit("s1", "cli.py")
    assert "Another agent" not in (driver.prompt("s2", "next").context or "")  # an ended session is not running
    assert "Another agent" not in (driver.start("s3").context or "")
