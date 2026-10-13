"""A full disk: the hook still answers, and it says what is lost instead of claiming that events wait in the spool."""

import errno
import json
import os
import stat
from pathlib import Path

import pytest

from agent_mem.core import db, spool
from agent_mem.core.config import Config
from agent_mem.hooks import hook


@pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="chmod does not deny root or Windows")
def test_a_full_disk_says_the_session_is_not_recorded(config: Config, project: Path, monkeypatch) -> None:
    db.connect(config).close()

    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(spool, "write", full)
    files = [p for p in config.data_dir.iterdir() if p.is_file() and p.name.startswith("memory.db")]
    for path in files:  # SQLite fails to write as on a full disk
        path.chmod(stat.S_IRUSR)
    try:
        base = {"session_id": "s1", "cwd": str(project)}
        start = json.loads(hook.run("claude", None, json.dumps({**base, "hook_event_name": "SessionStart"}), config))
    finally:
        for path in files:
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    out = start["systemMessage"]
    assert "not being recorded" in out and "No space left" in out
    assert "saved later" not in out and "is being recorded" not in out


def test_an_event_queued_behind_the_spool_on_a_full_disk_is_reported_lost(
    config: Config, project: Path, monkeypatch
) -> None:
    spool.write(config.spool_dir, {"type": "event", "event": {}}, spool.session_tag("claude", "s2"))

    def full(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(spool, "write", full)
    prompt = {"session_id": "s2", "cwd": str(project), "hook_event_name": "UserPromptSubmit", "prompt": "weiter"}
    out = json.loads(hook.run("claude", None, json.dumps(prompt), config))["systemMessage"]
    assert "not being recorded" in out and "No space left" in out
    log = (config.log_dir / "hook.log").read_text()
    assert "spool failed" in log and "queued behind spool" not in log
