import pytest

from agent_mem.events import Event, PayloadError
from agent_mem.normalize import normalize


def test_claude_events():
    start = normalize(
        "claude", {"hook_event_name": "SessionStart", "session_id": "s", "cwd": "/r", "source": "compact"}
    )
    assert start.kind == "session_start" and start.source == "compact"
    prompt = normalize("claude", {"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "hi"})
    assert prompt.kind == "prompt" and prompt.prompt == "hi"
    ok = normalize(
        "claude",
        {
            "hook_event_name": "PostToolUse",
            "session_id": "s",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "tool_response": {"stdout": "a", "stderr": ""},
        },
    )
    assert ok.kind == "tool" and not ok.tool_failed and ok.tool_output == "a"
    failed = normalize(
        "claude",
        {
            "hook_event_name": "PostToolUseFailure",
            "session_id": "s",
            "tool_name": "Bash",
            "tool_input": {"command": "x"},
            "error": "boom",
        },
    )
    assert failed.tool_failed and failed.error == "boom"
    stop = normalize("claude", {"hook_event_name": "Stop", "session_id": "s", "last_assistant_message": "done"})
    assert stop.kind == "stop" and stop.answer == "done"
    assert normalize("claude", {"hook_event_name": "Notification", "session_id": "s"}) is None


def test_codex_events_infer_failure_from_exit_code():
    event = normalize(
        "codex",
        {
            "hook_event_name": "PostToolUse",
            "session_id": "c",
            "tool_name": "shell",
            "tool_call_id": "k",
            "tool_input": {"command": ["bash", "-lc", "pytest"]},
            "tool_response": "Exit code: 2\nerror: failed",
        },
    )
    assert event.tool_failed and event.exit_code == 2 and event.tool_use_id == "k"
    compact = normalize("codex", {"hook_event_name": "PostCompact", "session_id": "c"})
    assert compact.kind == "compact"


def test_copilot_tool_args_as_string_and_object():
    as_string = normalize(
        "copilot",
        {
            "sessionId": "p",
            "toolName": "bash",
            "toolArgs": '{"command": "npm test"}',
            "toolResult": {"resultType": "failure", "textResultForLlm": "1 failed"},
        },
        "postToolUse",
    )
    as_object = normalize(
        "copilot",
        {
            "sessionId": "p",
            "toolName": "bash",
            "toolArgs": {"command": "npm test"},
            "toolResult": {"resultType": "success", "textResultForLlm": "ok"},
        },
        "postToolUse",
    )
    assert as_string.tool_input == {"command": "npm test"} and as_string.tool_failed
    assert as_object.tool_input == {"command": "npm test"} and not as_object.tool_failed
    start = normalize("copilot", {"sessionId": "p", "source": "new", "timestamp": 1790000000000}, "sessionStart")
    assert start.source == "startup" and start.ts.startswith("2026")


def test_opencode_events():
    event = normalize(
        "opencode",
        {
            "event": "tool.after",
            "sessionID": "o",
            "tool": "bash",
            "callID": "c1",
            "args": {"command": "go test ./..."},
            "output": "FAIL",
            "exit": 1,
        },
    )
    assert event.tool_failed and event.exit_code == 1
    assert normalize("opencode", {"event": "session.idle", "sessionID": "o", "answer": "done"}).answer == "done"


def test_invalid_payloads_raise():
    with pytest.raises(PayloadError):
        normalize("claude", {"hook_event_name": "UserPromptSubmit"})
    with pytest.raises(PayloadError):
        normalize("claude", ["not", "an", "object"])
    with pytest.raises(PayloadError):
        normalize("nope", {})


def test_own_tools_are_recognized():
    for name in ("mcp__agent-mem__mem_search", "agent_mem.mem_get", "mem_search"):
        assert Event("claude", "tool", "s", "t", tool=name).is_own_tool
    assert not Event("claude", "tool", "s", "t", tool="Bash").is_own_tool


def test_event_roundtrip():
    event = normalize("claude", {"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "hi"})
    assert Event.from_dict(event.to_dict()) == event


def test_codex_payloads_from_current_schema():
    """Field names follow codex-rs/hooks/src/schema.rs (Stop carries last_assistant_message, SessionEnd a reason)."""
    base = {"session_id": "cx", "turn_id": "t1", "cwd": "/r", "model": "gpt", "permission_mode": "default"}
    stop = normalize(
        "codex",
        {**base, "hook_event_name": "Stop", "stop_hook_active": False, "last_assistant_message": "All tests pass."},
    )
    assert stop.kind == "stop" and stop.answer == "All tests pass."
    end = normalize("codex", {"session_id": "cx", "cwd": "/r", "hook_event_name": "SessionEnd", "reason": "exit"})
    assert end.kind == "session_end" and end.source == "exit"
    pre = normalize(
        "codex",
        {
            **base,
            "hook_event_name": "PreToolUse",
            "tool_name": "shell",
            "tool_input": {"command": ["bash", "-lc", "npm i"]},
            "tool_use_id": "u1",
        },
    )
    assert pre.kind == "pre_tool" and pre.tool_use_id == "u1"
    sub = normalize("codex", {**base, "hook_event_name": "SubagentStop", "last_assistant_message": "done"})
    assert sub.kind == "subagent_stop"
