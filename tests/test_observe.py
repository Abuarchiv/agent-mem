"""Observer package: privacy guarantees that must hold without any model (docs/PLAN.md §6)."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

if importlib.util.find_spec("mem0") is None:  # find_spec does not import; importing would fix the env too early
    pytest.skip("observer extra not installed", allow_module_level=True)


def test_mem0_telemetry_is_off_and_home_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(tmp_path / "data"))
    # Order matters: the package sets the env, and only then may mem0 be imported.
    observe = importlib.import_module("agent_mem.observe")
    mem0_adapter = importlib.import_module("agent_mem.observe.mem0_adapter")
    telemetry = importlib.import_module("mem0.memory.telemetry")
    assert observe is not None
    assert telemetry.MEM0_TELEMETRY is False  # read once at import; the package set the env first

    mem0_adapter._ensure_env(tmp_path / "data" / "mem0")
    assert os.environ["MEM0_TELEMETRY"] == "False"
    main = importlib.import_module("mem0.memory.main")
    setup = importlib.import_module("mem0.memory.setup")

    assert main.MEM0_TELEMETRY is False
    assert setup.mem0_dir == str(tmp_path / "data" / "mem0")
    assert main.mem0_dir == str(tmp_path / "data" / "mem0")
    assert (tmp_path / "data" / "mem0").stat().st_mode & 0o777 == 0o700


def test_hook_path_does_not_import_observer() -> None:
    import subprocess
    import sys

    code = (
        "import sys, agent_mem.hook, agent_mem.capture, agent_mem.inject, agent_mem.store, agent_mem.search;"
        "bad = [m for m in sys.modules if m.startswith(('mem0', 'qdrant_client', 'fastembed', 'agent_mem.observe'))];"
        "print(','.join(bad))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert out == "", f"hook path imported: {out}"
