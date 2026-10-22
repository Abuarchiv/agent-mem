from __future__ import annotations

import itertools
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.core.events import Event
from agent_mem.hooks import capture


@pytest.fixture(scope="session", autouse=True)
def _viewer_script() -> None:
    """Pages render the script built from the current ``ui/app.ts``. An installed package (the sdist job) has its own."""
    try:
        from hatch_build import build_viewer_script
    except ImportError:
        return
    build_viewer_script(Path(__file__).resolve().parents[1])


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGENT_MEM_NO_SPAWN", "1")
    monkeypatch.delenv("AGENT_MEM_INTERNAL", raising=False)
    monkeypatch.delenv("AGENT_MEM_DISABLE", raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / "copilot-home"))
    # Viewer login items land here, never in the real home directory.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))  # what Windows reads instead of HOME
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "home" / ".config"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "home" / "AppData"))


@pytest.fixture
def config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    cfg = Config(data_dir=tmp_path / "data")
    cfg.semantic.enabled = False
    # Tests check what a hook writes, not its 400 ms deadline: on a slow runner the first hook (it creates the
    # schema) misses it and its event goes to the spool. Tests of the deadline set their own.
    cfg.hook_deadline_ms = 10_000
    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(cfg.data_dir))
    return cfg


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "remote", "add", "origin", "git@github.com:me/demo.git"], check=True)
    (root / "app.py").write_text("print('hi')\n")
    return root


@pytest.fixture
def conn(config: Config) -> Iterator:
    connection = db.connect(config)
    yield connection
    connection.close()


_CLOCK = itertools.count(1)  # one clock for every Driver: two of them never write the same timestamp


class Driver:
    """Feeds normalized events through the real capture path."""

    def __init__(self, conn, config: Config, cwd: Path, harness: str = "claude") -> None:
        self.conn = conn
        self.config = config
        self.cwd = str(cwd)
        self.harness = harness
        self.counter = 0

    def _ts(self) -> str:
        from datetime import timedelta

        from agent_mem.core import timeutil

        self.counter += 1
        now = timeutil.now()
        # In the past, but on today's UTC date: tests of "today" and "gestern" read the date of these events.
        # ponytail: within the first 20 minutes after UTC midnight the events still fall on yesterday.
        since_midnight = now - now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(minutes=1)
        ago = max(timedelta(minutes=20), min(timedelta(minutes=500), since_midnight))
        return timeutil.iso(now - ago + timedelta(seconds=next(_CLOCK)))

    def send(self, session: str, kind: str, **fields) -> capture.Response:
        event = Event(
            self.harness, kind, session, self._ts(), cwd=self.cwd, raw_kind=fields.pop("raw_kind", kind), **fields
        )
        return capture.apply(self.conn, self.config, event)

    def start(self, session: str, source: str = "startup") -> capture.Response:
        return self.send(session, "session_start", source=source, raw_kind="SessionStart")

    def prompt(self, session: str, text: str) -> capture.Response:
        return self.send(session, "prompt", prompt=text, raw_kind="UserPromptSubmit")

    def bash(self, session: str, command: str, output: str = "", failed: bool = False) -> capture.Response:
        self.counter += 1
        return self.send(
            session,
            "tool",
            tool="Bash",
            tool_use_id=f"b{self.counter}",
            tool_input={"command": command},
            tool_output=output,
            tool_failed=failed,
            error=output if failed else None,
            raw_kind="PostToolUseFailure" if failed else "PostToolUse",
        )

    def edit(self, session: str, path: str) -> capture.Response:
        self.counter += 1
        return self.send(
            session,
            "tool",
            tool="Edit",
            tool_use_id=f"e{self.counter}",
            tool_input={"file_path": os.path.join(self.cwd, path), "old_string": "a", "new_string": "b"},
            tool_output="ok",
            raw_kind="PostToolUse",
        )

    def pre_edit(self, session: str, path: str) -> capture.Response:
        return self.send(
            session,
            "pre_tool",
            tool="Edit",
            tool_input={"file_path": os.path.join(self.cwd, path)},
            raw_kind="PreToolUse",
        )

    def pre_bash(self, session: str, command: str) -> capture.Response:
        return self.send(session, "pre_tool", tool="Bash", tool_input={"command": command}, raw_kind="PreToolUse")

    def stop(self, session: str, answer: str) -> capture.Response:
        return self.send(session, "stop", answer=answer, raw_kind="Stop")


@pytest.fixture
def driver(conn, config: Config, project: Path) -> Driver:
    return Driver(conn, config, project)
