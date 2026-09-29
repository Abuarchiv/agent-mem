from __future__ import annotations

import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from agent_mem import capture, db
from agent_mem.config import Config
from agent_mem.events import Event


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGENT_MEM_NO_SPAWN", "1")
    monkeypatch.delenv("AGENT_MEM_INTERNAL", raising=False)
    monkeypatch.delenv("AGENT_MEM_DISABLE", raising=False)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))


@pytest.fixture
def config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Config:
    cfg = Config(data_dir=tmp_path / "data")
    cfg.semantic.enabled = False
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

        from agent_mem import timeutil

        self.counter += 1
        return timeutil.iso(timeutil.now() - timedelta(minutes=500) + timedelta(seconds=self.counter))

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
