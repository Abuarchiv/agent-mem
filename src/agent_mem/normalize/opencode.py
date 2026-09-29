"""Payloads sent by the bundled OpenCode plugin (``plugins/opencode/agent-mem.ts``).

The plugin already maps OpenCode's hooks to this small, stable shape:
``{event, sessionID, cwd, prompt?, tool?, callID?, args?, output?, exit?, error?, answer?, source?}``.
"""

from __future__ import annotations

from typing import Any

from .. import timeutil
from ..events import Event, PayloadError, exit_code_of, get, output_text, require_session, text_of

_KINDS = {
    "session.start": "session_start",
    "chat.message": "prompt",
    "tool.before": "pre_tool",
    "tool.after": "tool",
    "session.idle": "stop",
    "session.compacting": "compact",
    "session.end": "session_end",
}


def normalize(payload: dict[str, Any], event_name: str | None = None) -> Event | None:
    name = event_name or text_of(get(payload, "event")) or ""
    kind = _KINDS.get(name)
    if kind is None:
        return None
    event = Event(
        harness="opencode",
        kind=kind,
        session_id=require_session(payload, "sessionID", "session_id"),
        ts=timeutil.from_any(get(payload, "ts", "timestamp")),
        cwd=text_of(get(payload, "cwd")),
        raw_kind=name,
    )
    if kind == "session_start":
        event.source = text_of(get(payload, "source")) or "startup"
    elif kind == "prompt":
        prompt = get(payload, "prompt")
        if not isinstance(prompt, str):
            raise PayloadError("chat.message without prompt")
        event.prompt = prompt
    elif kind in {"pre_tool", "tool"}:
        tool = get(payload, "tool")
        if not isinstance(tool, str) or not tool:
            raise PayloadError(f"{name} without tool")
        event.tool = tool
        event.tool_use_id = text_of(get(payload, "callID"))
        event.tool_input = get(payload, "args")
        if kind == "tool":
            output = get(payload, "output")
            event.tool_output = output_text(output)
            explicit = get(payload, "exit")
            event.exit_code = (
                explicit
                if isinstance(explicit, int) and not isinstance(explicit, bool)
                else exit_code_of(output, event.tool_output)
            )
            error = text_of(get(payload, "error"))
            if error or event.exit_code not in (None, 0):
                event.tool_failed = True
                event.error = error or event.tool_output
    elif kind == "stop":
        event.answer = text_of(get(payload, "answer"))
    return event
