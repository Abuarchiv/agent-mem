"""GitHub Copilot CLI hook payloads (camelCase, event passed as CLI argument).

Reference: https://docs.github.com/en/copilot/reference/hooks-reference
``toolArgs`` arrives as an object since CLI 1.0.83 and as a JSON string before.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from agent_mem.core import timeutil
from agent_mem.core.events import (
    Event,
    PayloadError,
    exit_code_of,
    get,
    output_text,
    parse_json_maybe,
    require_session,
    shell_text,
    text_of,
)

_KINDS = {
    "sessionStart": "session_start",
    "subagentStart": "session_start",
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


TAIL_BYTES = 256 * 1024
# agentStop starts 50 to 150 ms before the final message reaches the transcript (measured twice, CLI 1.0.96).
ANSWER_TRIES = 6
ANSWER_WAIT_S = 0.05


def _answer_in(transcript: str) -> tuple[str | None, bool]:
    """The last text of the current turn (None while none is written) and whether the turn's latest message is final.
    A message that asks for tools is commentary ("Ich prüfe jetzt …"); the final answer asks for none."""
    try:
        with open(transcript, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - TAIL_BYTES))
            tail = fh.read()
    except OSError:
        return None, False
    final: bool | None = None
    for raw in reversed(tail.splitlines()):
        if b'"user.message"' in raw:
            break  # reached the prompt: the answer before it belongs to the previous turn
        if b'"assistant.message"' not in raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue  # the first line of the tail is usually cut
        data = entry.get("data") if isinstance(entry, dict) else None
        if entry.get("type") != "assistant.message" or not isinstance(data, dict):
            continue
        if final is None:
            final = not data.get("toolRequests")
        content = data.get("content")
        if isinstance(content, str) and content.strip():
            return content, final
    return None, bool(final)


def last_answer(transcript: str | None) -> str | None:
    """The agent's answer from the session transcript (``session-state/<id>/events.jsonl``): ``agentStop`` carries
    no answer, only the transcript's path. Reads only the end of the file, waiting at most 250 ms for the final
    message; if it never comes, the turn's last commentary is better than nothing."""
    if not transcript or not os.path.isfile(transcript):
        return None
    answer = None
    for attempt in range(ANSWER_TRIES):
        answer, final = _answer_in(transcript)
        if (answer is not None and final) or attempt == ANSWER_TRIES - 1:
            break
        time.sleep(ANSWER_WAIT_S)
    return answer


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
    if name == "subagentStart":
        event.source = "subagent"
        # Only a unique id may dedupe; agent names repeat for every subagent of the same type.
        event.native_event_id = text_of(get(payload, "agentId")) or None
    elif kind == "session_start":
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
        event.tool_input = parse_json_maybe(get(payload, "toolArgs", "tool_input"))
        if kind == "tool":
            result = get(payload, "toolResult", "tool_result")
            event.tool_output = output_text(result)
            event.exit_code = exit_code_of(result, shell_text(event))
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
        if event.answer is None and kind == "stop":
            event.answer = last_answer(text_of(get(payload, "transcriptPath", "transcript_path")))
    return event
