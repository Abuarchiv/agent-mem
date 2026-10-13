"""A new user's first day, in real processes: setup, two sessions through the hooks, every command, uninstall, purge.

Each audit found bugs only its own angle showed (a fresh install, the CI, the Windows installer, the viewer's words).
This runs the whole path the same way on every commit and every OS."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# Words the screen no longer uses (they confused users); the model-facing context block may still use them.
JARGON = (
    "harness",
    "spool",
    "injected",
    "dead end",
    "redo",
    "lexical",
    " turn ",
    " turns ",
    "capture",
    "mem_get",
    "qdrant",
    "extract",
)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    data = tmp_path / "data"
    data.mkdir()
    # The viewer's login item would replace the real one (launchctl bootout by label).
    (data / "config.json").write_text(json.dumps({"viewer": {"enabled": False}}), encoding="utf-8")
    env = {
        **os.environ,
        "AGENT_MEM_DATA_DIR": str(data),
        "AGENT_MEM_NO_SPAWN": "1",
        "PATH": os.path.dirname(sys.executable),  # no harness CLI: the panel names why there are no facts
    }
    env.pop("AGENT_MEM_INTERNAL", None)
    return env


def _run(env: dict[str, str], *args: str, stdin: str | None = None, cwd: Path | None = None) -> str:
    done = subprocess.run(
        [sys.executable, "-m", "agent_mem", *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=cwd,
        timeout=120,
        check=False,
    )
    shown = done.stdout + done.stderr
    assert "Traceback" not in shown, shown
    assert done.returncode == 0, (args, shown)
    return shown


def _hook(env: dict[str, str], project: Path, session: str, event: str, **fields: object) -> dict:
    payload = {"hook_event_name": event, "session_id": session, "cwd": str(project), **fields}
    out = _run(env, "hook", "claude", stdin=json.dumps(payload))
    return json.loads(out) if out.strip() else {}


def _plain(text: str) -> str:
    """What a person reads: no colour codes, no file paths or commands (those may name anything)."""
    import re

    text = re.sub(r"\x1b\[[\d;]*m", "", text)
    return " ".join(word for word in text.split() if "/" not in word and "\\" not in word and "`" not in word)


def _no_jargon(text: str) -> None:
    assert not text.lstrip().startswith(("{", "[")), text  # raw JSON is for `--json`, not for people
    lowered = f" {_plain(text).lower()} "
    found = [word for word in JARGON if word in lowered]
    assert not found, (found, text)


def test_a_first_day_from_setup_to_purge(home: dict[str, str], project: Path) -> None:
    shown = _run(home, "setup", "claude", "--write", "--no-models")
    _no_jargon(shown)

    start = _hook(home, project, "s1", "SessionStart", source="startup")
    _no_jargon(start["systemMessage"])
    assert "Nothing saved for this project yet" in start["systemMessage"]
    _hook(home, project, "s1", "UserPromptSubmit", prompt="Use pnpm instead of npm in this project")
    tool = {"tool_name": "Bash", "tool_use_id": "b1", "tool_input": {"command": "npm test"}}
    _hook(home, project, "s1", "PostToolUse", **tool, tool_response={"stdout": "FAILED tests/x - boom", "exit_code": 1})
    _hook(home, project, "s1", "Stop", last_assistant_message="Switched the scripts to pnpm.")
    end = _hook(home, project, "s1", "SessionEnd")
    _no_jargon(end.get("systemMessage", ""))

    again = _hook(home, project, "s2", "SessionStart", source="startup")
    assert "pnpm" in again["systemMessage"] and "pnpm" in again["hookSpecificOutput"]["additionalContext"]
    _no_jargon(again["systemMessage"])

    snapshot = project.parent / "page.html"
    for command in (
        ["status"],
        ["doctor"],
        ["search", "pnpm"],
        ["rules"],
        ["lessons"],
        ["models"],
        ["observe", "--status"],
        ["index", "--no-download"],
        ["consolidate"],
        ["paths"],
        ["pause", "--for", "1h"],
        ["resume"],
        ["view", "--output", str(snapshot), "--no-open"],
        ["uninstall", "claude"],
    ):
        _no_jargon(_run(home, *command, cwd=project))
    assert "pnpm" in _run(home, "search", "pnpm", cwd=project)
    assert "pnpm" in _run(home, "show", "T1") and "pnpm" in _run(home, "rules")
    assert json.loads(_run(home, "export", cwd=project))["turns"]
    assert snapshot.exists()

    missing = subprocess.run(
        [sys.executable, "-m", "agent_mem", "show", "M999"], env=home, capture_output=True, check=False
    )
    assert missing.returncode == 1  # a script can tell that nothing was found
    for command in (["purge", "--id", "M999", "--yes"], ["rules", "enable", "999"]):
        gone = subprocess.run([sys.executable, "-m", "agent_mem", *command], env=home, capture_output=True, check=False)
        assert gone.returncode == 1, command

    _run(home, "purge", "--all", "--yes")
    assert "No matching memories" in _run(home, "search", "pnpm", "--all-projects")
