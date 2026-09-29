"""Claude Code hook payloads (snake_case, ``hook_event_name`` present).

Reference: https://code.claude.com/docs/en/hooks
"""

from __future__ import annotations

from typing import Any

from .. import timeutil
from ..events import Event, PayloadError, exit_code_of, get, output_text, require_session, text_of

_KINDS = {
    "SessionStart": "session_start",
    "SubagentStart": "session_start",
    "UserPromptSubmit": "prompt",
    "PreToolUse": "pre_tool",
    "PostToolUse": "tool",
    "PostToolUseFailure": "tool",
    "Stop": "stop",
    "SubagentStop": "subagent_stop",
    "PreCompact": "compact",
    "SessionEnd": "session_end",
}


def normalize(payload: dict[str, Any], event_name: str | None = None, harness: str = "claude") -> Event | None:
    name = text_of(get(payload, "hook_event_name")) or event_name or ""
    kind = _KINDS.get(name)
    if kind is None:
        return None
    event = Event(
        harness=harness,
        kind=kind,
        session_id=require_session(payload, "session_id"),
        ts=timeutil.from_any(get(payload, "timestamp")),
        cwd=text_of(get(payload, "cwd")),
        raw_kind=name,
    )
    if name == "SubagentStart":
        # Subagents get the same briefing as a new session; one event per subagent.
        event.source = "subagent"
        event.native_event_id = text_of(get(payload, "agent_id")) or None
    elif kind == "session_start":
        event.source = text_of(get(payload, "source")) or "startup"
    elif kind == "prompt":
        prompt = get(payload, "prompt")
        if not isinstance(prompt, str):
            raise PayloadError("UserPromptSubmit without prompt")
        event.prompt = prompt
    elif kind in {"pre_tool", "tool"}:
        tool = get(payload, "tool_name")
        if not isinstance(tool, str) or not tool:
            raise PayloadError(f"{name} without tool_name")
        event.tool = tool
        event.tool_use_id = text_of(get(payload, "tool_use_id", "tool_call_id"))
        event.tool_input = get(payload, "tool_input")
        if kind == "tool":
            response = get(payload, "tool_response", "tool_output")
            event.tool_output = output_text(response)
            event.exit_code = exit_code_of(response, event.tool_output)
            error = text_of(get(payload, "tool_error", "error"))
            if name == "PostToolUseFailure" or error:
                event.tool_failed = True
                event.error = error or event.tool_output
            elif event.exit_code not in (None, 0):
                event.tool_failed = True
            elif isinstance(response, dict) and response.get("interrupted") is True:
                event.tool_failed = True
                event.error = "interrupted"
    elif kind in {"stop", "subagent_stop"}:
        event.answer = text_of(get(payload, "last_assistant_message"))
    elif kind == "compact":
        event.source = text_of(get(payload, "trigger"))
    elif kind == "session_end":
        event.source = text_of(get(payload, "reason"))
    return event
