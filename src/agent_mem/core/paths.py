"""Data location and the pre-tool gate. Imports only os, sys, json and pathlib: the gate runs before anything else."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

APP_NAME = "agent-mem"
# Written by the indexer: {"rules": bool, "files": [paths with a dead end]}. Removed as soon as a rule or a dead end
# appears, so the hook looks again until the next indexer run.
GUARDS = "guards.json"
# Upper bound for reading a hook payload before the configured limit (``limits.stdin_bytes``) is known.
STDIN_CAP = 64 * 1024 * 1024
_PRE_TOOL = {"PreToolUse", "preToolUse", "tool.before"}


def default_data_dir() -> Path:
    override = os.environ.get("AGENT_MEM_DATA_DIR")
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) / APP_NAME if base else home / "AppData" / "Local" / APP_NAME
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else home / ".local" / "share") / APP_NAME


def _tool_input(payload: dict[str, object]) -> object:
    value = payload.get("tool_input", payload.get("toolArgs", payload.get("args")))
    if isinstance(value, str):  # Copilot before CLI 1.0.83
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def pre_tool_has_nothing_to_check(event_name: str | None, raw: bytes) -> bool:
    """True for a pre-tool event the hook would answer with silence: a command while no rule exists and no
    remembered file is named in it, a read or edit of a file without memories. The hook then exits before loading the database code (about 45 ms per Bash or Edit
    call), and the event is not stored: nothing reads pre-tool events. In doubt it returns False."""
    try:
        guards = json.loads((default_data_dir() / GUARDS).read_text(encoding="utf-8"))
        payload = json.loads(raw or b"{}")
    except (OSError, ValueError):
        return False
    if not isinstance(guards, dict) or not isinstance(payload, dict):
        return False
    name = event_name or payload.get("hook_event_name") or payload.get("hookEventName") or payload.get("event")
    tool_input = _tool_input(payload)
    if name not in _PRE_TOOL or not isinstance(tool_input, dict):
        return False
    files = [str(f) for f in guards.get("files") or []]
    command = tool_input.get("command", tool_input.get("cmd"))
    if command is not None:
        # `sed -n '1,80p' db.py` is how Codex reads a file: its history is worth the database.
        text = command if isinstance(command, str) else " ".join(str(part) for part in command)
        return not guards.get("rules", True) and not any(f in text for f in files)
    targets = [
        str(value).replace("\\", "/")
        for key, value in tool_input.items()
        if key in {"file_path", "filePath", "path", "notebook_path"} and isinstance(value, str)
    ]
    return bool(targets) and not any(t == f or t.endswith("/" + f) for t in targets for f in files)
