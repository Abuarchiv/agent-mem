"""On Windows no process agent-mem starts may open a console window."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from agent_mem.core import identity
from agent_mem.hooks import hook
from agent_mem.observe import providers

DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW = 0x8, 0x200, 0x08000000


@pytest.fixture
def windows(monkeypatch):
    """Windows flags and platform on any OS; every started process is recorded instead of run."""
    monkeypatch.setattr(sys, "platform", "win32")
    for name, value in (
        ("DETACHED_PROCESS", DETACHED_PROCESS),
        ("CREATE_NEW_PROCESS_GROUP", CREATE_NEW_PROCESS_GROUP),
        ("CREATE_NO_WINDOW", CREATE_NO_WINDOW),
    ):
        monkeypatch.setattr(subprocess, name, value, raising=False)
    started: list[dict] = []

    class Process:
        returncode, pid = 0, 1

        def __init__(self, argv, **kwargs):
            started.append({"argv": argv, **kwargs})

        def communicate(self, *args, **kwargs):
            return "", ""

        def kill(self):
            pass

    def run(argv, **kwargs):
        started.append({"argv": argv, **kwargs})
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "Popen", Process)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(providers.shutil, "which", lambda name: None)  # the real one needs _winapi under win32
    return started


def test_no_process_opens_a_console_window(windows, config, tmp_path: Path):
    hook.spawn_indexer(config)
    hook._spawn([sys.executable, "-m", "agent_mem", "observe", "--drain"], config)
    providers._run(["copilot", "-s"], "prompt")
    providers._kill_group(type("Running", (), {"pid": 1, "kill": lambda self: None})())  # taskkill
    identity._git(tmp_path, "rev-parse", "--show-toplevel")
    assert len(windows) >= 5
    for call in windows:
        flags = call.get("creationflags", 0)
        assert flags & CREATE_NO_WINDOW, call["argv"]
        # Without a console of its own, every console program the process starts (git, the model CLIs) opens one.
        assert not flags & DETACHED_PROCESS, call["argv"]


def test_model_clis_installed_by_npm_start_and_speak_utf8(windows, monkeypatch, tmp_path: Path):
    """npm installs copilot, codex and opencode as copilot.cmd on Windows: CreateProcess finds only .exe files by bare
    name, so the full path is passed. A Windows pipe defaults to cp1252, where "✓" cannot be written; the CLIs read
    and write UTF-8."""
    cmd = tmp_path / "copilot.cmd"
    monkeypatch.setattr(providers.shutil, "which", lambda name: str(cmd) if name == "copilot" else None)
    providers._run(["copilot", "-s"], "Prüfe ✓")
    (call,) = [c for c in windows if c["argv"][1:] == ["-s"]]
    assert call["argv"][0] == str(cmd)
    assert call["encoding"] == "utf-8" and call["errors"] == "replace"


def test_a_file_the_cli_still_holds_does_not_lose_the_answer(monkeypatch):
    """Windows cannot delete a file another process holds open; Copilot's helpers outlive it for a moment. The
    private home and working folder are then left behind instead of failing a finished call."""
    removed: list[bool] = []
    real = providers.tempfile.TemporaryDirectory

    def tracking(*args, **kwargs):
        removed.append(kwargs.get("ignore_cleanup_errors", False))
        return real(*args, **kwargs)

    monkeypatch.setattr(providers.tempfile, "TemporaryDirectory", tracking)
    monkeypatch.setattr(providers, "_run_model", lambda *args: '{"facts": []}')
    providers.CopilotCliLLM().generate_response([{"role": "user", "content": "x"}], response_format={"type": "json"})
    assert removed and all(removed)
