"""Turns closed outside a live Stop hook (spool replay, stale turns) still reach the fact worker."""

import json
from pathlib import Path

from agent_mem.core import spool
from agent_mem.core.config import Config
from agent_mem.core.events import Event
from agent_mem.hooks import hook
from agent_mem.memory import indexer


def test_a_stop_replayed_from_the_spool_starts_the_observer(config: Config, project: Path, monkeypatch) -> None:
    """Under load most hook events wait in the spool; a replayed Stop still starts the observer for its turn."""
    started: list[Config] = []
    monkeypatch.setattr(hook, "spawn_observer", lambda cfg: started.append(cfg) or True)
    prompt = Event(
        harness="claude",
        kind="prompt",
        session_id="s1",
        ts="2026-10-12T10:00:00.000Z",
        cwd=str(project),
        prompt="fix the parser",
        raw_kind="UserPromptSubmit",
    )
    spool.write(config.spool_dir, {"type": "event", "event": prompt.to_dict()}, spool.session_tag("claude", "s1"))
    stop = {"session_id": "s1", "cwd": str(project), "hook_event_name": "Stop", "last_assistant_message": "fixed"}
    hook.run("claude", None, json.dumps(stop), config)  # queued behind the spooled prompt
    assert not started

    indexer.run(config, allow_download=False)
    assert started == [config]

    indexer.run(config, allow_download=False)  # nothing replayed, nothing new to extract
    assert len(started) == 1
