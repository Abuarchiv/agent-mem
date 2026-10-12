"""Build the message bundle for one extraction call (docs/PLAN.md §4.3 point 4).

Content per turn: the user's prompt, the agent's answer, and one compact line with the commands,
files and error lines the turn touched (from the ``turns`` columns, already cleaned by capture), plus
the final answers of subagents that ran in the turn (``SubagentStop``).
Events with ``trust = 'tool_external'`` never contribute text (§6 point 2). The whole bundle is
capped at ``observe.bundle_tokens`` (4 characters per token); a bundle that would exceed it is split
at turn boundaries, a single oversized turn is truncated.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from dataclasses import dataclass

from agent_mem.core import privacy
from agent_mem.core.config import Config

CHARS_PER_TOKEN = 4


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


def _turn_messages(row: sqlite3.Row, config: Config, subagents: list[str]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    prompt = privacy.clean_text(str(row["prompt"] or ""), config.limits.prompt_chars)
    if prompt.strip():
        messages.append({"role": "user", "content": prompt})
    answer = privacy.clean_text(str(row["answer"] or ""), config.limits.answer_chars)
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
    cap = config.observe.bundle_tokens * CHARS_PER_TOKEN
    bundles: list[Bundle] = []
    current: Bundle | None = None
    for row in rows:
        messages = _turn_messages(row, config, subagents.get(int(row["id"]), []))
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
        if current is not None and (current.chars + size > cap or current.session_id != row["session_id"]):
            bundles.append(current)
            current = None
        if current is None:
            current = Bundle([], str(row["session_id"]), row["project_id"], str(row["harness"]), [])
        current.turn_ids.append(int(row["id"]))
        current.messages.extend(messages)
    if current is not None:
        bundles.append(current)
    return bundles
