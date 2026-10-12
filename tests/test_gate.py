"""The pre-tool gate: Bash and Edit calls skip the hook's work while there is nothing to warn about or deny."""

import json
import os
import subprocess
import sys
from pathlib import Path

from agent_mem.core import paths
from agent_mem.core.config import Config
from agent_mem.memory import indexer, store
from tests.conftest import Driver

PRE = {"hook_event_name": "PreToolUse", "session_id": "g", "tool_name": "Bash", "tool_input": {"command": "npm test"}}


def _hook(config: Config, project: Path, payload: dict, *argv: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(config.data_dir), "AGENT_MEM_NO_SPAWN": "1"}
    return subprocess.run(
        [sys.executable, "-m", "agent_mem", "hook", *argv],
        input=json.dumps({**payload, "cwd": str(project)}).encode(),
        capture_output=True,
        env=env,
        timeout=60,
        check=True,
    )


def _guards(config: Config, rules: bool, files: list[str]) -> None:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    (config.data_dir / paths.GUARDS).write_text(json.dumps({"rules": rules, "files": files}))


def test_gate_skips_only_what_has_nothing_to_check(config: Config, monkeypatch):
    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(config.data_dir))
    command = json.dumps(PRE).encode()
    edit = json.dumps({**PRE, "tool_name": "Edit", "tool_input": {"file_path": "/repo/src/app.py"}}).encode()
    assert not paths.pre_tool_has_nothing_to_check(None, command)  # no guards file yet (fresh install, upgrade)
    _guards(config, rules=False, files=["src/app.py"])
    assert paths.pre_tool_has_nothing_to_check(None, command)
    assert not paths.pre_tool_has_nothing_to_check(None, edit)  # this file has a dead end
    other = json.dumps({**PRE, "tool_name": "Edit", "tool_input": {"file_path": "/repo/src/other.py"}}).encode()
    assert paths.pre_tool_has_nothing_to_check(None, other)
    _guards(config, rules=True, files=[])
    assert not paths.pre_tool_has_nothing_to_check(None, command)
    assert paths.pre_tool_has_nothing_to_check(None, edit)
    copilot = json.dumps({"toolName": "edit", "toolArgs": json.dumps({"path": "/repo/x.py"})}).encode()
    assert paths.pre_tool_has_nothing_to_check("preToolUse", copilot)  # Copilot: event in argv, args as a string
    assert not paths.pre_tool_has_nothing_to_check(None, json.dumps({**PRE, "hook_event_name": "PostToolUse"}).encode())
    assert not paths.pre_tool_has_nothing_to_check(None, json.dumps({**PRE, "tool_input": {}}).encode())
    assert not paths.pre_tool_has_nothing_to_check(None, b"not json")


def test_guards_follow_rules_and_dead_ends(conn, config: Config, driver: Driver):
    guards = config.data_dir / paths.GUARDS
    indexer.run(config, allow_download=False)
    assert json.loads(guards.read_text()) == {"rules": False, "files": []}
    driver.prompt("s1", "nein, nutze pnpm statt npm")  # a rule appears: look again until the next run
    assert not guards.exists()
    indexer.run(config, allow_download=False)
    assert json.loads(guards.read_text())["rules"] is True
    driver.edit("s1", "app.py")
    driver.bash("s1", "git checkout -- app.py", "")  # a revert records a dead end on app.py
    assert not guards.exists()
    indexer.run(config, allow_download=False)
    assert json.loads(guards.read_text())["files"] == ["app.py"]
    store.guards_exist(config)
    assert not guards.exists()


def test_skipped_pre_tool_event_is_not_stored_but_a_rule_still_denies(conn, config: Config, project: Path):
    indexer.run(config, allow_download=False)
    assert _hook(config, project, PRE, "claude").stdout == b""
    assert conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'pre_tool'").fetchone()[0] == 0
    _hook(
        config,
        project,
        {**PRE, "hook_event_name": "UserPromptSubmit", "prompt": "nein, nutze pnpm statt npm"},
        "claude",
    )
    conn.execute("UPDATE rules SET enabled = 1")
    denied = json.loads(_hook(config, project, PRE, "claude").stdout)
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny" and "pnpm" in json.dumps(denied)


def test_hook_help_needs_no_stdin():
    result = subprocess.run(
        [sys.executable, "-m", "agent_mem", "hook", "--help"],
        capture_output=True,
        timeout=30,
        stdin=subprocess.DEVNULL,
        check=False,
    )
    assert result.returncode == 0 and b"usage: agent-mem hook" in result.stdout


def test_retention_bounds_exposures_call_log_and_quarantine(conn, config: Config, driver: Driver):
    import time as clock

    from agent_mem.core import spool

    driver.prompt("s1", "anything")
    old, new = "2020-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"
    for kind in ("injected", "used", "created"):
        conn.execute("INSERT INTO accesses(owner_type, owner_id, ts, kind) VALUES ('t', 1, ?, ?)", (old, kind))
    conn.execute("INSERT INTO accesses(owner_type, owner_id, ts, kind) VALUES ('t', 1, ?, 'injected')", (new,))
    for ts in (old, new):
        conn.execute(
            "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
            "VALUES (?, 'claude', 'extract', 1, 1, 1, '[]')",
            (ts,),
        )
    spool.quarantine_record(config.quarantine_dir, {"type": "old"})
    (stale,) = config.quarantine_dir.glob("*.json")
    os.utime(stale, (clock.time() - 400 * 86400,) * 2)
    spool.quarantine_record(config.quarantine_dir, {"type": "fresh"})

    stats = indexer.retention(conn, config)
    assert stats["calls_deleted"] == 1 and stats["quarantine_deleted"] == 1
    kinds = sorted(r[0] for r in conn.execute("SELECT kind FROM accesses WHERE ts IN (?, ?)", (old, new)))
    assert kinds == ["created", "injected", "used"]  # the old injection went, use and creation stay
    assert len(list(config.quarantine_dir.glob("*.json"))) == 1
