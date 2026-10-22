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
