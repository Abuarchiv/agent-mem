"""The JSONL log stays bounded: it rotates past MAX_BYTES and keeps KEEP files."""

import json

from agent_mem.core import logutil


def test_log_rotates_and_keeps_a_bounded_number_of_files(tmp_path, monkeypatch):
    monkeypatch.setattr(logutil, "MAX_BYTES", 200)
    for n in range(100):
        logutil.write(tmp_path, "hook", event=n, detail="x" * 50)
    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == ["hook.log", "hook.log.1", "hook.log.2", "hook.log.3", "hook.log.4"]
    newest = json.loads((tmp_path / "hook.log").read_text(encoding="utf-8").splitlines()[-1])
    assert newest["event"] == 99
    oldest = json.loads((tmp_path / "hook.log.4").read_text(encoding="utf-8").splitlines()[0])
    assert oldest["event"] < 99


def test_long_values_are_cut_and_numbers_kept(tmp_path):
    logutil.write(tmp_path, "observe", ok=True, took=1.5, error="y" * 1000)
    record = json.loads((tmp_path / "observe.log").read_text(encoding="utf-8"))
    assert record["ok"] is True and record["took"] == 1.5 and len(record["error"]) == 300
