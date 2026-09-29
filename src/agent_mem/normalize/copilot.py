"""GitHub Copilot CLI hook payloads (camelCase, event passed as CLI argument).

Reference: https://docs.github.com/en/copilot/reference/hooks-reference
``toolArgs`` arrives as an object since CLI 1.0.83 and as a JSON string before.
"""

from __future__ import annotations

from typing import Any

from .. import timeutil
from ..events import (
    Event,
    PayloadError,
    exit_code_of,
    get,
    output_text,
    parse_json_maybe,
    require_session,
    text_of,
)

_KINDS = {
    "sessionStart": "session_start",
    "userPromptSubmitted": "prompt",
    "preToolUse": "pre_tool",
    "postToolUse": "tool",
    "postToolUseFailure": "tool",
    "errorOccurred": "tool",
    "agentStop": "stop",
    "subagentStop": "subagent_stop",
    "preCompact": "compact",
    "sessionEnd": "session_end",
}


def normalize(payload: dict[str, Any], event_name: str | None = None) -> Event | None:
    name = event_name or text_of(get(payload, "hookEventName", "event")) or ""
    kind = _KINDS.get(name)
    if kind is None:
        return None
    event = Event(
        harness="copilot",
        kind=kind,
        session_id=require_session(payload, "sessionId", "session_id"),
        ts=timeutil.from_any(get(payload, "timestamp")),
        cwd=text_of(get(payload, "cwd")),
        raw_kind=name,
    )
    if kind == "session_start":
        source = text_of(get(payload, "source")) or "startup"
        event.source = "startup" if source == "new" else source
    elif kind == "prompt":
        prompt = get(payload, "prompt")
        if not isinstance(prompt, str):
            raise PayloadError("userPromptSubmitted without prompt")
        event.prompt = prompt
    elif kind in {"pre_tool", "tool"} and name != "errorOccurred":
        tool = get(payload, "toolName")
        if not isinstance(tool, str) or not tool:
            raise PayloadError(f"{name} without toolName")
        event.tool = tool
        event.tool_use_id = text_of(get(payload, "toolCallId", "toolUseId"))
        event.tool_input = parse_json_maybe(get(payload, "toolArgs"))
        if kind == "tool":
            result = get(payload, "toolResult")
            event.tool_output = output_text(result)
            event.exit_code = exit_code_of(result, event.tool_output)
            result_type = result.get("resultType") if isinstance(result, dict) else None
            if name == "postToolUseFailure" or result_type in {"failure", "error"}:
                event.tool_failed = True
                event.error = text_of(get(payload, "error")) or event.tool_output
            elif event.exit_code not in (None, 0):
                event.tool_failed = True
    elif name == "errorOccurred":
        error = get(payload, "error")
        message = error.get("message") if isinstance(error, dict) else error
        event.tool = "error"
        event.tool_failed = True
        event.error = text_of(message) or "error"
        event.tool_output = event.error
    elif kind in {"stop", "subagent_stop"}:
        event.answer = text_of(get(payload, "response", "result", "text", "lastAssistantMessage"))
    return event
