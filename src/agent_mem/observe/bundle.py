"""Build the message bundle for one extraction call.

Content per turn: the user's prompt, what the turn's tools showed (command or file and the start of the
output, ``observe.tool_output_chars`` each, ``observe.turn_tool_chars`` per turn), the agent's answer, and
one compact line with the commands, files and error lines the turn touched (from the ``turns`` columns,
already cleaned by capture), plus the final answers of subagents that ran in the turn (``SubagentStop``).
Without the outputs the extractor never learns what a file or command revealed ("`uv tool` keeps the
install source in `direct_url.json`"). A change itself stays out; the functions and classes it defines come as
one line each ("[edit] ui/app.js: defines drawEdges, drawNodes").
Events with ``trust = 'tool_external'`` never contribute text. The whole bundle is
capped at ``observe.bundle_tokens`` (4 characters per token); a bundle that would exceed it is split
at turn boundaries, a single oversized turn is truncated.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from agent_mem.core import privacy, signals
from agent_mem.core.config import Config
from agent_mem.memory import store

CHARS_PER_TOKEN = 4
DEFINES_CHARS = 2_000  # per turn, for the "[edit] … defines …" lines


@dataclass
class Bundle:
    turn_ids: list[int]
    session_id: str
    project_id: str | None
    harness: str
    messages: list[dict[str, str]]

    @property
    def chars(self) -> int:
        return sum(len(m["content"]) for m in self.messages)


def _defines_line(payload: dict[str, Any], files: list[str]) -> str | None:
    """The names a change defines ("[edit] ui/app.js: defines drawEdges, drawNodes"): the change itself stays out,
    but "which function does X" is answered by these names. Scripts that rewrite files count."""
    category = str(payload.get("category") or "")
    if payload.get("failed") or any(store.scratch_path(f) for f in files):
        return None
    try:
        tool_input = json.loads(payload.get("input") or "null")
    except ValueError:
        tool_input = payload.get("input")
    names = signals.defined_names(category, tool_input)
    if not names:
        return None
    where = f"[edit] {files[0]}" if category == "edit" and files else "[script]"
    return f"{where}: defines {', '.join(names[:12])}"


def _tool_line(payload: dict[str, Any], per_call: int) -> str | None:
    """One tool call as the extractor sees it: what ran or was read, then the start of what came back."""
    output = " ".join(str(payload.get("output") or "").split())
    if len(output) < 40 or payload.get("category") == "edit":  # nothing learned, or the change itself
        return None
    try:
        tool_input = json.loads(payload.get("input") or "null")
    except ValueError:
        tool_input = payload.get("input")
    category = str(payload.get("category") or "tool")
    what = signals.command_of(tool_input) if category == "shell" else None
    if what is None:
        files = signals.files_of(category, tool_input) if isinstance(tool_input, dict) else []
        what = files[0] if files else " ".join(str(payload.get("input") or "").split())[:160]
    what = " ".join(str(what).split())[:240]
    return f"[{category}] {what} → {output[:per_call]}"


def _turn_messages(
    row: sqlite3.Row, config: Config, subagents: list[str], tools: list[str] | None = None
) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    prompt = privacy.clean_text(str(row["prompt"] or ""), config.limits.prompt_chars)
    if prompt.strip():
        if signals.from_harness(prompt):
            # Not the user's words: the extractor must not turn a task notice into a preference.
            prompt = f"[harness notice, not written by the user] {signals.request_text(prompt)}"
        messages.append({"role": "user", "content": prompt})
    answer = privacy.clean_text(str(row["answer"] or ""), config.limits.answer_chars)
    if tools:
        answer = "What the tools showed:\n" + "\n".join(tools) + ("\n\nAnswer:\n" + answer if answer.strip() else "")
    extras = []
    commands = json.loads(row["commands_json"] or "[]")
    files = json.loads(row["files_json"] or "[]")
    errors = json.loads(row["errors_json"] or "[]")
    if commands:
        extras.append("commands: " + "; ".join(str(c) for c in commands[:12]))
    if files:
        extras.append("files: " + ", ".join(str(f) for f in files[:20]))
    if errors:
        extras.append("errors: " + " | ".join(str(e)[: config.observe.tool_output_chars] for e in errors[:5]))
    for answer_of_subagent in subagents[:3]:
        extras.append("subagent: " + answer_of_subagent[: config.observe.tool_output_chars])
    if extras:
        answer = (answer + "\n\n[tools] " + "\n[tools] ".join(extras)).strip()
    if answer.strip():
        messages.append({"role": "assistant", "content": answer})
    return messages


def build(conn: sqlite3.Connection, config: Config, turn_ids: list[int]) -> list[Bundle]:
    """One or more bundles for the given turns (same session), each within the token cap."""
    if not turn_ids:
        return []
    placeholders = ",".join("?" for _ in turn_ids)
    rows = conn.execute(
        f"SELECT t.*, s.harness FROM turns t JOIN sessions s ON s.id = t.session_id "
        f"WHERE t.id IN ({placeholders}) ORDER BY t.id",
        tuple(turn_ids),
    ).fetchall()
    subagents: dict[int, list[str]] = {}
    for event in conn.execute(
        f"SELECT turn_id, payload FROM events WHERE kind = 'subagent_stop' AND trust != 'tool_external' "
        f"AND turn_id IN ({placeholders}) ORDER BY id",
        tuple(turn_ids),
    ):
        with contextlib.suppress(ValueError):
            answer = str(json.loads(event["payload"]).get("answer") or "").strip()
            if answer:
                subagents.setdefault(int(event["turn_id"]), []).append(" ".join(answer.split()))
    tools: dict[int, list[str]] = {}
    used: dict[int, int] = {}
    names: dict[int, list[str]] = {}
    defined: dict[int, int] = {}
    for event in conn.execute(
        f"SELECT turn_id, payload, files_json FROM events WHERE kind = 'tool' AND trust != 'tool_external' "
        f"AND turn_id IN ({placeholders}) ORDER BY id",
        tuple(turn_ids),
    ):
        with contextlib.suppress(ValueError):
            payload = json.loads(event["payload"])
            turn = int(event["turn_id"])
            # Names are short and what outputs crowd out first: they have their own room, outputs the rest.
            defines = _defines_line(payload, json.loads(event["files_json"] or "[]"))
            if defines and defined.get(turn, 0) + len(defines) <= DEFINES_CHARS:
                names.setdefault(turn, []).append(defines)
                defined[turn] = defined.get(turn, 0) + len(defines)
            line = _tool_line(payload, config.observe.tool_output_chars)
            if line and used.get(turn, 0) + len(line) <= config.observe.turn_tool_chars:
                tools.setdefault(turn, []).append(line)
                used[turn] = used.get(turn, 0) + len(line)
    for turn, lines in names.items():
        tools[turn] = [*lines, *tools.get(turn, [])]
    cap = config.observe.bundle_tokens * CHARS_PER_TOKEN
    bundles: list[Bundle] = []
    current: Bundle | None = None
    for row in rows:
        messages = _turn_messages(row, config, subagents.get(int(row["id"]), []), tools.get(int(row["id"])))
        if not messages:
            continue
        size = sum(len(m["content"]) for m in messages)
        if size > cap:  # a single oversized turn: keep the prompt, cut the answer
            budget = cap
            trimmed = []
            for message in messages:
                text = message["content"][: max(0, budget)]
                budget -= len(text)
                if text:
                    trimmed.append({"role": message["role"], "content": text})
            messages = trimmed
            size = sum(len(m["content"]) for m in messages)
        # One bundle, one project: facts are stored under the bundle's project (a session can move into a nested one).
        if current is not None and (
            current.chars + size > cap
            or current.session_id != row["session_id"]
            or current.project_id != row["project_id"]
        ):
            bundles.append(current)
            current = None
        if current is None:
            current = Bundle([], str(row["session_id"]), row["project_id"], str(row["harness"]), [])
        current.turn_ids.append(int(row["id"]))
        current.messages.extend(messages)
    if current is not None:
        bundles.append(current)
    return bundles
