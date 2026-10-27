"""The coding agents agent-mem connects to, by the name hooks and settings use."""

import os
from pathlib import Path

HARNESS_NAMES = {"claude": "Claude Code", "codex": "Codex", "copilot": "Copilot CLI", "opencode": "OpenCode"}
HARNESSES = tuple(HARNESS_NAMES)


def claude_home() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(override).expanduser() if override else Path.home() / ".claude"


def codex_home() -> Path:
    override = os.environ.get("CODEX_HOME")
    return Path(override).expanduser() if override else Path.home() / ".codex"


def copilot_home() -> Path:
    override = os.environ.get("COPILOT_HOME")
    return Path(override).expanduser() if override else Path.home() / ".copilot"


def opencode_home() -> Path:
    override = os.environ.get("XDG_CONFIG_HOME")
    return (Path(override) if override else Path.home() / ".config") / "opencode"
