import json

import pytest

from agent_mem.core.events import Event, PayloadError
from agent_mem.hooks.normalize import normalize


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


def test_exit_code_text_counts_only_for_shell_output():
    script = "#!/bin/sh\ncd /tmp || exit 1\n"
    write = normalize(
        "claude",
        {
            "hook_event_name": "PostToolUse",
            "session_id": "s",
            "tool_name": "Write",
            "tool_input": {"file_path": "/tmp/x.sh", "content": script},
            "tool_response": {"type": "create", "filePath": "/tmp/x.sh", "content": script},
        },
    )
    assert write.exit_code is None and not write.tool_failed
    shell = normalize(
        "claude",
        {
            "hook_event_name": "PostToolUse",
            "session_id": "s",
            "tool_name": "Bash",
            "tool_input": {"command": "make"},
            "tool_response": {"stdout": "make: *** [all] Error\nexit code 2", "stderr": ""},
        },
    )
    assert shell.exit_code == 2 and shell.tool_failed


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


def test_claude_post_tool_use_failure_reads_tool_error():
    event = normalize(
        "claude",
        {
            "hook_event_name": "PostToolUseFailure",
            "session_id": "s",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest"},
            "tool_use_id": "u9",
            "tool_error": "ModuleNotFoundError: No module named 'x'",
        },
    )
    assert event.tool_failed and event.error == "ModuleNotFoundError: No module named 'x'"


def test_subagent_start_is_a_briefing_per_agent():
    event = normalize(
        "claude",
        {"hook_event_name": "SubagentStart", "session_id": "s", "agent_id": "a1", "agent_type": "Explore"},
    )
    assert event.kind == "session_start" and event.source == "subagent" and event.native_event_id == "a1"


def test_copilot_snake_case_payloads():
    event = normalize(
        "copilot",
        {
            "hook_event_name": "postToolUseFailure",
            "session_id": "p",
            "tool_name": "bash",
            "tool_input": {"command": "npm test"},
            "error": "2 failed",
        },
        "postToolUseFailure",
    )
    assert event.tool_input == {"command": "npm test"} and event.tool_failed and event.error == "2 failed"
    sub = normalize("copilot", {"sessionId": "p", "agentName": "explore"}, "subagentStart")
    assert sub.kind == "session_start" and sub.source == "subagent"


def test_copilot_stop_takes_the_answer_from_the_transcript(tmp_path):
    """agentStop carries only transcriptPath (CLI 1.0.96); the answer is read from the transcript."""
    transcript = tmp_path / "events.jsonl"
    lines = [
        {"type": "user.message", "data": {"content": "What does parse do?"}},
        {"type": "assistant.message", "data": {"content": "", "toolRequests": [{"name": "bash"}]}},
        {"type": "tool.execution_complete", "data": {"result": {"content": "def parse(s): ..."}}},
        {
            "type": "assistant.message",
            "data": {"content": "parse splits the string at commas.", "phase": "final_answer"},
        },
        {"type": "assistant.turn_end", "data": {"turnId": "1"}},
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))
    payload = {
        "sessionId": "p",
        "timestamp": 1790000000000,
        "stopReason": "end_turn",
        "transcriptPath": str(transcript),
    }
    assert normalize("copilot", payload, "agentStop").answer == "parse splits the string at commas."
    assert normalize("copilot", {**payload, "transcriptPath": str(tmp_path / "gone.jsonl")}, "agentStop").answer is None
    # Read before the final message is written: the previous turn's answer must not be taken.
    transcript.write_text("".join(json.dumps(line) + "\n" for line in [*lines, lines[0]]))
    assert normalize("copilot", payload, "agentStop").answer is None


def test_copilot_stop_waits_for_the_final_answer_after_a_commentary(tmp_path, monkeypatch):
    """A message next to tool calls ("Ich prüfe jetzt die Dateien …") is commentary; agentStop waits for the final
    answer written after it (CLI 1.0.96)."""
    from agent_mem.hooks.normalize import copilot

    transcript = tmp_path / "events.jsonl"
    commentary = {"content": "Ich prüfe jetzt die Dateien.", "phase": "commentary", "toolRequests": [{"name": "bash"}]}
    lines = [
        {"type": "user.message", "data": {"content": "Füge teile(a, b) hinzu."}},
        {"type": "assistant.message", "data": commentary},
        {"type": "assistant.message", "data": {"content": "", "toolRequests": [{"name": "bash"}]}},
    ]
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))
    final = {"type": "assistant.message", "data": {"content": "teile ist fertig, 6 Tests grün.", "toolRequests": []}}

    def final_arrives(_seconds):
        with transcript.open("a") as fh:
            fh.write(json.dumps(final) + "\n")

    monkeypatch.setattr(copilot.time, "sleep", final_arrives)
    payload = {"sessionId": "p", "transcriptPath": str(transcript)}
    assert normalize("copilot", payload, "agentStop").answer == "teile ist fertig, 6 Tests grün."
    # Never written: the commentary is better than no answer.
    transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))
    monkeypatch.setattr(copilot.time, "sleep", lambda _seconds: None)
    assert normalize("copilot", payload, "agentStop").answer == "Ich prüfe jetzt die Dateien."


def test_codex_without_exit_code_infers_failure_only_from_clear_signs():
    """Codex 0.162 sends a shell call's output without its exit code. Clear signs mark a failure; ordinary output does
    not."""

    def failed(output: str) -> bool:
        payload = {"hook_event_name": "PostToolUse", "session_id": "c", "tool_name": "Bash", "tool_call_id": "k",
                   "tool_input": {"command": "uv run --with pytest python3 -m pytest -q"}, "tool_response": output}  # fmt: skip
        return normalize("codex", payload).tool_failed

    assert failed("error: Failed to initialize cache at `/Users/abu/.cache/uv`\n  Caused by: Operation not permitted")
    assert failed('Traceback (most recent call last):\n  File "<string>", line 1\nZeroDivisionError: division by zero')
    assert failed("F.\n=================== 1 failed, 1 passed in 0.03s ===================")
    assert failed("bash: pytest: command not found")
    assert not failed("..\n2 passed in 0.01s")
    assert not failed(
        "Warning: truncated output (original token count: 14267)\nTotal output lines: 314\n\nsrc/x.py:12: error handling"
    )
    assert not failed("tests/test_errors.py::test_assert_raises PASSED\n0 failed")
    assert failed("npm ERR! code ELIFECYCLE") and failed("error[E0308]: mismatched types")
    assert not failed("kind  | n  | note\nerror | 39 | from a sqlite3 table")  # a table row


def test_claude_piped_test_run_without_exit_code_counts_as_failed():
    """In `uv run … pytest -q 2>&1 | tail -30` `tail` hides the exit code; "1 failed" in the output marks the failure."""

    def failed(stdout: str) -> bool:
        payload = {"hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "Bash", "tool_use_id": "t",
                   "tool_input": {"command": "uv run --with pytest python3 -m pytest -q 2>&1 | tail -30"},
                   "tool_response": {"stdout": stdout, "stderr": "", "interrupted": False}}  # fmt: skip
        return normalize("claude", payload).tool_failed

    assert failed("..F\n=================== 1 failed, 2 passed in 0.04s ===================")
    assert not failed("...\n3 passed in 0.02s")
