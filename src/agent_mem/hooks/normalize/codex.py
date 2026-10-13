"""Codex CLI hook payloads.

Codex uses the same snake_case shape as Claude Code (``hook_event_name``,
``session_id``, ``tool_name``, ``tool_input``, ``tool_response``,
``last_assistant_message``). Differences handled here: ``tool_call_id`` and the
``PostCompact``/``Compact`` event names. Codex 0.162 sends a shell call's output without its exit
code; ``claude.normalize`` reads clear signs of a failure from the output then.
"""

from __future__ import annotations

from typing import Any

from agent_mem.core.events import Event
from agent_mem.hooks.normalize import claude


def normalize(payload: dict[str, Any], event_name: str | None = None) -> Event | None:
    name = payload.get("hook_event_name")
    name = name if isinstance(name, str) and name else event_name
    if name in {"PostCompact", "Compact"}:
        payload = {**payload, "hook_event_name": "PreCompact"}
    return claude.normalize(payload, event_name, harness="codex")
