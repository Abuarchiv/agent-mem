"""Optional session summaries written by the harness the user already runs (off by default).

This is the only place where Agent Mem causes a generative model call, and only when
``summarize.enabled`` is true. It runs ``claude -p`` or ``codex exec`` in the
background with ``AGENT_MEM_INTERNAL=1`` so that the child session is not captured.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess

from . import db, store, timeutil
from .config import Config
from .signals import first_line

PROMPT = """You maintain a coding memory. Summarize the session below as JSON only, no prose:
{"summary": "<2 sentences>", "decisions": ["..."], "dead_ends": ["..."], "open_items": ["..."], "lessons": ["..."]}
Each list has at most 3 short items. Use only facts present in the session. Session:
"""

_JSON = re.compile(r"\{[\s\S]*\}")


def _command(config: Config) -> list[str]:
    if config.summarize.harness == "codex":
        return ["codex", "exec", "--skip-git-repo-check", "-"]
    return ["claude", "-p", "--model", "haiku", "--output-format", "text"]


def _session_text(conn: sqlite3.Connection, session_id: str, limit: int) -> str:
    parts: list[str] = []
    for turn in conn.execute(
        "SELECT id, prompt, answer, commands_json, errors_json, files_json FROM turns WHERE session_id = ? ORDER BY id",
        (session_id,),
    ):
        parts.append(
            f"T{turn['id']} request: {first_line(turn['prompt'], 300)}\n"
            f"files: {', '.join(json.loads(turn['files_json'] or '[]')[:8])}\n"
            f"commands: {' | '.join(json.loads(turn['commands_json'] or '[]')[:6])}\n"
            f"errors: {' | '.join(json.loads(turn['errors_json'] or '[]')[:3])}\n"
            f"result: {first_line(turn['answer'], 400)}"
        )
    text = "\n\n".join(parts)
    return text[-limit:]


def summarize_pending(conn: sqlite3.Connection, config: Config) -> int:
    if not config.summarize.enabled:
        return 0
    today = timeutil.day(timeutil.iso())
    used = db.get_meta(conn, f"summaries:{today}")
    budget = config.summarize.daily_limit - int(used or 0)
    if budget <= 0:
        return 0
    sessions = conn.execute(
        "SELECT id, project_id FROM sessions WHERE ended_at IS NOT NULL AND summarized_at IS NULL "
        "AND (SELECT COUNT(*) FROM turns WHERE session_id = sessions.id) >= 2 ORDER BY ended_at DESC LIMIT ?",
        (budget,),
    ).fetchall()
    done = 0
    for session in sessions:
        text = _session_text(conn, session["id"], config.summarize.max_input_chars)
        result = _run(config, PROMPT + text)
        with db.transaction(conn):
            conn.execute("UPDATE sessions SET summarized_at = ? WHERE id = ?", (timeutil.iso(), session["id"]))
            db.set_meta(conn, f"summaries:{today}", str(int(db.get_meta(conn, f"summaries:{today}") or 0) + 1))
            if result is not None:
                _store(conn, session["project_id"], session["id"], result)
                done += 1
    return done


def _run(config: Config, prompt: str) -> dict[str, object] | None:
    env = {**os.environ, "AGENT_MEM_INTERNAL": "1"}
    try:
        completed = subprocess.run(
            _command(config),
            input=prompt,
            capture_output=True,
            text=True,
            timeout=config.summarize.timeout_seconds,
            env=env,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    match = _JSON.search(completed.stdout)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _store(conn: sqlite3.Connection, project_id: str | None, session_id: str, result: dict[str, object]) -> None:
    last_turn = conn.execute("SELECT MAX(id) FROM turns WHERE session_id = ?", (session_id,)).fetchone()[0]
    summary = result.get("summary")
    if isinstance(summary, str) and summary.strip():
        store.add_memory(
            conn,
            project_id=project_id,
            kind="summary",
            title=first_line(summary, 200),
            body=summary[:2000],
            source="harness_summary",
            trust="agent",
            importance=0.6,
            turn_id=last_turn,
        )
    mapping = {"decisions": "decision", "dead_ends": "dead_end", "lessons": "lesson", "open_items": "fact"}
    for key, kind in mapping.items():
        items = result.get(key)
        if not isinstance(items, list):
            continue
        for item in items[:3]:
            if isinstance(item, str) and item.strip():
                title = item.strip()[:200] if kind != "fact" else f"Open: {item.strip()[:190]}"
                store.add_memory(
                    conn,
                    project_id=project_id,
                    kind=kind,
                    title=title,
                    body=item[:1000],
                    source="harness_summary",
                    trust="agent",
                    importance=0.6,
                    turn_id=last_turn,
                )
