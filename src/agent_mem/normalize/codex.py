"""Codex CLI hook payloads.

Codex uses the same snake_case shape as Claude Code (``hook_event_name``,
``session_id``, ``tool_name``, ``tool_input``, ``tool_response``,
``last_assistant_message``). Differences handled here: ``tool_call_id`` and the
``PostCompact``/``Compact`` event names. Failures are inferred from exit codes.
"""

from __future__ import annotations

from typing import Any

from ..events import Event
from . import claude


def normalize(payload: dict[str, Any], event_name: str | None = None) -> Event | None:
    name = payload.get("hook_event_name") or event_name
    if name in {"PostCompact", "Compact"}:
        payload = {**payload, "hook_event_name": "PreCompact"}
    return claude.normalize(payload, event_name, harness="codex")
