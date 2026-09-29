import json

from agent_mem import capture, db
from agent_mem.events import Event
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


def test_compaction_context(driver: Driver, conn):
    driver.prompt("s1", "Refactor the auth module")
    driver.edit("s1", "auth.py")
    response = driver.start("s1", source="compact")
    assert response.context and "Refactor the auth module" in response.context and "auth.py" in response.context


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
