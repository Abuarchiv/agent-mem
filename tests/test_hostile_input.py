"""Payloads a bug hunt sent through the hooks: each one leaked a secret, crashed the hook or lost the event."""

import json
import os
import subprocess
import sys
from pathlib import Path

from agent_mem.core import privacy, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.hooks import hook

# Fake credentials, assembled at runtime so that secret scanners do not flag this file.
KEY = "WWleak9" + "apikeyX"


def _send(config: Config, project: Path, harness: str = "claude", **fields) -> str:
    payload = {"session_id": "s", "cwd": str(project), **fields}
    return hook.run(harness, None, json.dumps(payload), config)


def _stored(conn) -> str:
    rows = conn.execute("SELECT payload FROM events UNION ALL SELECT COALESCE(prompt, '') FROM turns").fetchall()
    return "\n".join(str(row[0]) for row in rows)


def test_secrets_in_written_files_and_commands_are_not_stored(config: Config, project: Path, conn):
    """Inside JSON a value's quotes read \\" and the assignment pattern no longer matched."""
    _send(config, project, hook_event_name="UserPromptSubmit", prompt="write the config")
    for tool, tool_input in (
        ("Write", {"file_path": str(project / "a.py"), "content": f'API_KEY = "{KEY}"\n'}),
        ("Edit", {"file_path": str(project / "b.yml"), "old_string": "x", "new_string": f'client_secret: "{KEY}"'}),
        ("Bash", {"command": f'export API_TOKEN="{KEY}" && curl -d \'{{"password": "{KEY}"}}\' x'}),
    ):
        _send(config, project, hook_event_name="PostToolUse", tool_name=tool, tool_input=tool_input, tool_response="ok")
    assert KEY not in _stored(conn)


def test_private_sections_cannot_be_hidden_from_the_filter():
    for text in (
        "a <priv\x00ate>LEAK</private> z",
        "<private>one <private>two</private> LEAK</private> z",
        '<private reason="x">LEAK</private> z',
        "<private >LEAK</private > z",
        "<pri\u200bvate>LEAK</private> z",
    ):
        assert "LEAK" not in privacy.clean_text(text, 1000), text
    assert privacy.clean_text("keep <private>a</private> keep2 <private>b</private> end", 1000) == (
        "keep [private] keep2 [private] end"
    )


def test_more_secret_formats_are_redacted():
    body = "abcdefghijklmnopqrstuvwx12"
    for secret in (
        "DB_PASS=Zq81hunter22",
        "ENCRYPTION_KEY=" + body,
        "X-Custom-Auth: " + body,
        "gs" + "k_" + body,
        "SG." + body[:18] + "." + body,
        "https://hooks.slack.com/services/T000/B000/" + body,
        "postgres://u:p@ss/w0rd" + "ZZ@host/db",
    ):
        cleaned = privacy.clean_text(secret, 1000)
        assert body not in cleaned and "w0rdZZ" not in cleaned and "Zq81" not in cleaned, cleaned
    for harmless in ("bypass=foo compass=north", "Authorization: required for all endpoints"):
        assert privacy.clean_text(harmless, 1000) == harmless


def test_a_spooled_event_is_cleaned_and_private_to_its_owner(config: Config, project: Path):
    """A spool file can wait for days or end in quarantine; it held the raw prompt."""
    event = hook.normalize(
        "claude",
        {"hook_event_name": "UserPromptSubmit", "session_id": "s", "cwd": str(project),
         "prompt": f"password={KEY} <private>PRIVSECRET</private>"},
        None,
    )  # fmt: skip
    worker = hook._Worker(config, event)
    worker.spool()
    (path,) = spool.pending(config.spool_dir)
    text = path.read_text(encoding="utf-8")
    assert KEY not in text and "PRIVSECRET" not in text
    if sys.platform != "win32":
        assert path.stat().st_mode & 0o077 == 0


def test_odd_payloads_never_crash_the_hook_process(config: Config, project: Path, tmp_path: Path):
    """Run as the agents run it: a traceback or a non-zero exit shows up in the agent's terminal."""
    config.data_dir.mkdir(parents=True, exist_ok=True)
    (config.data_dir / "guards.json").write_text(json.dumps({"rules": False, "files": []}))
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(config.data_dir), "AGENT_MEM_NO_SPAWN": "1"}
    payloads = [
        b'{"hook_event_name": ["a"], "session_id": "x"}',
        b'{"hook_event_name": {"a": 1}, "session_id": "x"}',
        b"[" * 100_000 + b"]" * 100_000,
        json.dumps(
            {"hook_event_name": "PreToolUse", "session_id": "x", "tool_name": "Bash", "tool_input": {"command": 5}}
        ).encode(),
    ]
    for harness in ("claude", "codex", "copilot", "opencode"):
        for payload in payloads:
            done = subprocess.run(
                [sys.executable, "-m", "agent_mem", "hook", harness],
                input=payload,
                env=env,
                capture_output=True,
                check=False,
            )
            assert done.returncode == 0 and b"Traceback" not in done.stderr, (harness, payload[:60], done.stderr[-300:])
    closed = subprocess.run(
        [sys.executable, "-m", "agent_mem", "hook", "claude"],
        stdin=subprocess.DEVNULL,
        env=env,
        capture_output=True,
        check=False,
    )
    assert closed.returncode == 0


def test_a_byte_order_mark_does_not_drop_the_event(config: Config, project: Path, conn):
    """Windows PowerShell pipes may start with one."""
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "s", "cwd": str(project), "prompt": "with a BOM"}
    hook.run("claude", None, None, config, stdin_bytes=b"\xef\xbb\xbf" + json.dumps(payload).encode())
    assert conn.execute("SELECT prompt FROM turns").fetchone()[0] == "with a BOM"


def test_huge_exit_codes_nul_paths_and_far_timestamps_are_dropped(config: Config, project: Path, conn):
    _send(config, project, hook_event_name="UserPromptSubmit", prompt="run it", timestamp="3000-01-01T00:00:00Z")
    _send(
        config,
        project,
        hook_event_name="PostToolUse",
        tool_name="Bash",
        tool_input={"command": "make"},
        tool_response={"stdout": "x", "exit_code": 10**30},
    )
    assert conn.execute("SELECT COUNT(*) FROM events WHERE tool = 'Bash'").fetchone()[0] == 1
    assert conn.execute("SELECT MAX(last_event_at) FROM sessions").fetchone()[0][:4] == str(timeutil.now().year)
    out = hook.run(
        "claude", None, json.dumps({"hook_event_name": "SessionStart", "session_id": "n", "cwd": "/a\0b"}), config
    )
    assert "Traceback" not in out
    escape = str(project / "a\x1b]0;PWNED\x07\x1b[2Jb")
    out = hook.run(
        "claude", None, json.dumps({"hook_event_name": "SessionStart", "session_id": "e", "cwd": escape}), config
    )
    assert "\x1b]0" not in (json.loads(out)["systemMessage"] if out else "")
