"""Codex CLI hook payloads.

Codex uses the same snake_case shape as Claude Code (``hook_event_name``,
``session_id``, ``tool_name``, ``tool_input``, ``tool_response``,
``last_assistant_message``). Differences handled here: ``tool_call_id`` and the
``PostCompact``/``Compact`` event names. Failures are inferred from exit codes; Codex 0.162 sends a shell
call's output without one, so clear signs in the output stand in for it.
"""

from __future__ import annotations

import re
from typing import Any

from agent_mem.core.events import Event
from agent_mem.core.signals import classify_tool
from agent_mem.hooks.normalize import claude


def normalize(payload: dict[str, Any], event_name: str | None = None) -> Event | None:
    name = payload.get("hook_event_name")
    name = name if isinstance(name, str) and name else event_name
    if name in {"PostCompact", "Compact"}:
        payload = {**payload, "hook_event_name": "PreCompact"}
    event = claude.normalize(payload, event_name, harness="codex")
    if (
        event is not None
        and event.kind == "tool"
        and event.exit_code is None
        and not event.tool_failed
        and classify_tool(event.tool or "") == "shell"
        and _FAILED.search(event.tool_output or "")
    ):
        event.tool_failed = True
    return event


# Signs that a command failed, where no exit code says so: a traceback, a test summary with failures, a line that
# starts with an error, a missing command. Words like "error" or "failed" inside ordinary output are not enough.
_FAILED = re.compile(
    r"(?m)^Traceback \(most recent call last\):|^=*\s*[1-9]\d* failed\b|^(?:error|fatal|npm ERR!)\b[:!\[ ]"
    r"|command not found\s*$"
)
