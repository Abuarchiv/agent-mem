"""The read-only HTML page of the local memory, served by ``ui.server`` or written as an offline file.

The page is self-contained: it embeds a bounded snapshot, its stylesheet, script and fonts, and a Content Security
Policy that allows only its own script (by hash) and blocks every network request. Loaded by the CLI only, never on
the hook path.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from importlib import resources
from pathlib import Path
from typing import Any, NamedTuple

from agent_mem import __version__
from agent_mem.core import timeutil
from agent_mem.core.config import Config
from agent_mem.memory import learn
from agent_mem.memory.store import json_list

LIMITS = {
    "sessions": 150,
    "turns": 250,
    "actions_per_turn": 30,
    "memories": 1500,
    "graph_edges": 600,
    "recipes": 200,
    "rules": 200,
    "profile": 200,
    "recalls": 1500,
}
TEXT_CHARS = 4000
BODY_CHARS = 2000
INPUT_CHARS = 300
FONTS = (
    ("Bricolage Grotesque", "200 800", "bricolage-grotesque-latin.woff2"),
    ("Figtree", "300 900", "figtree-latin.woff2"),
    ("JetBrains Mono", "100 800", "jetbrains-mono-latin.woff2"),
)
PAGE_NAME = "agent-mem.html"


def view_dir(config: Config) -> Path:
    return config.data_dir / "view"


def discard(config: Config) -> None:
    """Remove written pages. Purge calls this so deleted data does not survive in an old page."""
    shutil.rmtree(view_dir(config), ignore_errors=True)


def _cap(text: str | None, limit: int) -> tuple[str, bool]:
    value = text or ""
    return (value, False) if len(value) <= limit else (value[:limit], True)


# The stored tool input is JSON, cut at ``limits.tool_input_chars``; read its fields even from a cut string.
_INPUT_FIELD = re.compile(
    r'"(command|cmd|file_path|filePath|path|pattern|url|query|description)":\s*"((?:[^"\\]|\\.)*)'
)


def _action_text(raw: str) -> tuple[str, str]:
    """What an action did, as (command or target, the agent's own description) instead of raw JSON."""
    fields: dict[str, str] = {}
    for key, value in _INPUT_FIELD.findall(raw):
        with contextlib.suppress(ValueError):
            fields.setdefault(key, json.loads(f'"{value}"'))
    target = next(
        (
            fields[key]
            for key in ("command", "cmd", "file_path", "filePath", "path", "pattern", "url", "query")
            if key in fields
        ),
        raw,
    )
    return target, fields.get("description", "")


def _rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params)]


def _count(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> int:
    return int(conn.execute(sql, params).fetchone()[0])


class _Scope(NamedTuple):
    """A snapshot covers all projects or one: the WHERE clause, its AND form and the parameter they need."""

    scoped: bool
    where: str
    and_scope: str
    params: tuple[Any, ...]


def _scope(project_id: str | None) -> _Scope:
    if project_id is None:
        return _Scope(False, "", "", ())
    return _Scope(True, "WHERE project_id = ?", "AND project_id = ?", (project_id,))


def _sessions(conn: sqlite3.Connection, scope: _Scope) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Latest sessions with their summary, and what the hooks put into those sessions' context."""
    scoped, params = scope.scoped, scope.params
    sessions = _rows(
        conn,
        "SELECT s.id, s.harness, s.project_id, s.branch, s.started_at, s.ended_at, s.last_event_at, "
        "s.title, s.summary_json, "
        "(SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns "
        f"FROM sessions s {'WHERE s.project_id = ?' if scoped else ''} ORDER BY s.last_event_at DESC LIMIT ?",
        (*params, LIMITS["sessions"]),
    )
    for session in sessions:
        try:
            session["summary"] = json.loads(session.pop("summary_json") or "{}")
        except ValueError:
            session["summary"] = {}
    # What the hooks put into the agent's context (briefing, prompt hints), newest sessions first.
    session_ids = [session["id"] for session in sessions]
    recalls = (
        _rows(
            conn,
            "SELECT owner_type, owner_id, ts, kind, session_id FROM accesses WHERE kind IN ('injected', 'shown') "
            f"AND session_id IN ({','.join('?' for _ in session_ids)}) ORDER BY id DESC LIMIT ?",
            (*session_ids, LIMITS["recalls"]),
        )
        if session_ids
        else []
    )
    return sessions, recalls


def _turns(conn: sqlite3.Connection, scope: _Scope) -> list[dict[str, Any]]:
    """Latest turns, long text capped."""
    where, params = scope.where, scope.params
    turns: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, session_id, project_id, started_at, ended_at, prompt, answer, outcome, title, type, "
        f"files_json, commands_json, errors_json, work_tokens FROM turns {where} ORDER BY started_at DESC, id DESC LIMIT ?",
        (*params, LIMITS["turns"]),
    ):
        prompt, prompt_cut = _cap(row["prompt"], TEXT_CHARS)
        answer, answer_cut = _cap(row["answer"], TEXT_CHARS)
        turns.append(
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "project_id": row["project_id"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "prompt": prompt,
                "answer": answer,
                "truncated": prompt_cut or answer_cut,
                "outcome": row["outcome"],
                "title": row["title"],
                "type": row["type"],
                "files": json_list(row["files_json"])[:20],
                "commands": json_list(row["commands_json"])[:10],
                "errors": json_list(row["errors_json"])[:10],
                "work": row["work_tokens"],
            }
        )
    return turns


def _actions(conn: sqlite3.Connection, turns: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """The tool calls of each turn, as a command or target plus the agent's own description."""
    actions: dict[str, list[dict[str, Any]]] = {}
    for turn in turns:
        items = []
        for event in conn.execute(
            "SELECT tool, command_key, exit_code, error_sig, resolved, payload FROM events "
            "WHERE turn_id = ? AND kind = 'tool' ORDER BY id LIMIT ?",
            (turn["id"], LIMITS["actions_per_turn"]),
        ):
            try:
                payload = json.loads(event["payload"])
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            target, note = _action_text(str(payload.get("input") or ""))
            text, _ = _cap(target, INPUT_CHARS)
            items.append(
                {
                    "tool": event["tool"],
                    "command": event["command_key"],
                    "input": text,
                    "note": note[:INPUT_CHARS],
                    "failed": bool(event["error_sig"]) or bool(payload.get("failed")),
                    "resolved": bool(event["resolved"]),
                    "error_line": payload.get("error_line"),
                    "exit_code": event["exit_code"],
                    "external": payload.get("trust") == "tool_external",
                }
            )
        if items:
            actions[str(turn["id"])] = items

    return actions


def _memories(conn: sqlite3.Connection, scope: _Scope) -> list[dict[str, Any]]:
    """Latest memories with their harness, session and use counts."""
    where, params = scope.where, scope.params
    memories: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, project_id, kind, title, body, source, turn_id, origin, valid_from, invalid_at, "
        "superseded_by, created_at, (SELECT session_id FROM turns t WHERE t.id = memories.turn_id) AS session_id, "
        "(SELECT s.harness FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = memories.turn_id) "
        "AS harness, "
        # its turn's measured work shared by the memories that turn produced (memory/work.py)
        "(SELECT t.work_tokens / MAX(1, (SELECT COUNT(*) FROM memories s WHERE s.turn_id = memories.turn_id "
        "AND s.kind != 'native_note')) FROM turns t WHERE t.id = memories.turn_id) AS work "
        f"FROM memories {where} "
        "ORDER BY invalid_at IS NOT NULL, created_at DESC, id DESC LIMIT ?",
        (*params, LIMITS["memories"]),
    ):
        body, body_cut = _cap(row["body"], BODY_CHARS)
        entry: dict[str, Any] = {**dict(row), "body": body, "truncated": body_cut}
        entry["harness"] = entry["harness"] or _ORIGIN_HARNESS.get(entry["origin"] or "", entry["origin"])
        memories.append(entry)
    stats = learn.owner_stats(conn, [("m", int(memory["id"])) for memory in memories])
    for memory in memories:
        counts = stats[("m", int(memory["id"]))]
        memory["used"] = counts.used
        memory["shown"] = counts.shown

    return memories


def _learned(
    conn: sqlite3.Connection, scope: _Scope
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Error fixes, rules and the commands that worked."""
    scoped, where, params = scope.scoped, scope.where, scope.params
    recipes = _rows(
        conn,
        "SELECT project_id, error_text, command_key, files_json, successes, recurrences, last_turn_id "
        f"FROM recipes {where} ORDER BY successes DESC, updated_at DESC LIMIT ?",
        (*params, LIMITS["recipes"]),
    )
    for recipe in recipes:
        recipe["files"] = json_list(recipe.pop("files_json"))[:10]
    rules = _rows(
        conn,
        "SELECT id, project_id, pattern, message, evidence, enabled, hits, overrides "
        f"FROM rules {'WHERE project_id = ? OR project_id IS NULL' if scoped else ''} "
        "ORDER BY enabled DESC, evidence DESC LIMIT ?",
        (*params, LIMITS["rules"]),
    )
    profile = _rows(
        conn,
        f"SELECT project_id, key, value, count FROM profile {where} ORDER BY count DESC, updated_at DESC LIMIT ?",
        (*params, LIMITS["profile"]),
    )

    return recipes, rules, profile


def _counts(conn: sqlite3.Connection, scope: _Scope) -> dict[str, Any]:
    """Totals for the overview, beyond the capped lists."""
    where, and_scope, params = scope.where, scope.and_scope, scope.params
    return {
        "sessions": _count(conn, f"SELECT COUNT(*) FROM sessions {where}", params),
        "turns": _count(conn, f"SELECT COUNT(*) FROM turns {where}", params),
        "memories": _count(conn, f"SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL {and_scope}", params),
        "memories_invalid": _count(
            conn, f"SELECT COUNT(*) FROM memories WHERE invalid_at IS NOT NULL {and_scope}", params
        ),
    }


def build_snapshot(conn: sqlite3.Connection, config: Config, project_id: str | None = None) -> dict[str, Any]:
    """Bounded, JSON-safe snapshot of the database. ``project_id`` limits every list to one project."""
    from agent_mem.cli.health import agents, quarantine_latest, status

    scope = _scope(project_id)
    where, params = scope.where, scope.params
    projects = _rows(
        conn, f"SELECT id, name, root FROM projects {where.replace('project_id', 'id')} ORDER BY name", params
    )
    sessions, recalls = _sessions(conn, scope)
    turns = _turns(conn, scope)
    actions = _actions(conn, turns)
    memories = _memories(conn, scope)
    recipes, rules, profile = _learned(conn, scope)
    counts = _counts(conn, scope)
    counts = {"projects": len(projects), **counts}
    health = status(conn, config)
    fixes = _count(conn, f"SELECT COALESCE(SUM(successes), 0) FROM recipes {where}", params)
    return {
        "agent_mem": __version__,
        "generated_at": timeutil.iso(),
        "project_id": project_id,
        "projects": projects,
        "limits": LIMITS,
        "counts": counts,
        "learning": {"errors_fixed": fixes},
        "health": {
            key: health[key]
            for key in (
                "data_dir",
                "db_mb",
                "schema",
                "semantic",
                "paused_until",
                "spool",
                "quarantine",
                "consolidated_at",
                "components",
                "config_warnings",
                "injected",
            )
        },
        "agents": agents(conn, config),
        "recalls": recalls,
        "quarantine_latest": quarantine_latest(config),
        "sessions": sessions,
        "turns": turns,
        "actions": actions,
        "memories": memories,
        "recipes": recipes,
        "rules": rules,
        "profile": profile,
        "graph": memory_graph(conn, project_id),
    }


# Native notes and memories saved through the MCP tool name their harness in ``origin``.
_ORIGIN_HARNESS = {"claude-auto-memory": "claude", "codex-memory": "codex"}


def memory_graph(conn: sqlite3.Connection, project_id: str | None) -> dict[str, Any]:
    """The graph the observer read from the memories (``observe/relations.py``): things and typed relations, each
    relation with the memories that state it. Only relations of current memories count."""
    scope = "AND r.project_id = ?" if project_id is not None else ""
    params: tuple[Any, ...] = (project_id,) if project_id is not None else ()
    rows = conn.execute(
        "SELECT r.source_id, r.target_id, r.type, GROUP_CONCAT(r.memory_id) AS ids FROM relations r "
        f"JOIN memories m ON m.id = r.memory_id AND m.invalid_at IS NULL WHERE 1 = 1 {scope} "
        "GROUP BY r.source_id, r.target_id, r.type ORDER BY COUNT(*) DESC LIMIT ?",
        (*params, LIMITS["graph_edges"]),
    ).fetchall()
    edges: list[dict[str, Any]] = [
        {
            "a": row["source_id"],
            "b": row["target_id"],
            "type": row["type"],
            "memory_ids": sorted({int(i) for i in str(row["ids"]).split(",")}, reverse=True)[:8],
        }
        for row in rows
    ]
    ids = sorted({edge["a"] for edge in edges} | {edge["b"] for edge in edges})
    nodes: list[dict[str, Any]] = []
    if ids:
        marks = ",".join("?" for _ in ids)
        for row in conn.execute(
            "SELECT c.id, c.label, c.type, c.project_id, (SELECT COUNT(*) FROM concept_links l JOIN memories m "
            "ON m.id = l.memory_id AND m.invalid_at IS NULL WHERE l.concept_id = c.id) AS memories "
            f"FROM concepts c WHERE c.id IN ({marks})",
            ids,
        ):
            nodes.append(
                {
                    "id": row["id"],
                    "label": row["label"],
                    "type": row["type"],
                    "project_id": row["project_id"] or None,
                    "memories": row["memories"],
                }
            )
    read = conn.execute(
        "SELECT COUNT(*) FROM memories m WHERE m.invalid_at IS NULL AND m.source != 'native' "
        "AND m.id <= CAST(COALESCE((SELECT value FROM meta WHERE key = 'graph.last:' || m.project_id), 0) AS INTEGER)"
    ).fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL AND source != 'native'").fetchone()[0]
    return {"nodes": nodes, "edges": edges, "read": read, "total": total}


def _asset(name: str) -> bytes:
    return resources.files("agent_mem.ui").joinpath(name).read_bytes()


def _embedded_json(snapshot: dict[str, Any]) -> str:
    text = json.dumps(snapshot, ensure_ascii=False, default=str, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def render(snapshot: dict[str, Any]) -> str:
    """The complete page. The script is allowed by its hash; nothing may be fetched."""
    faces = "".join(
        f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weights};font-display:swap;'
        f'src:url(data:font/woff2;base64,{base64.b64encode(_asset("fonts/" + file)).decode("ascii")}) format("woff2")}}'
        for family, weights, file in FONTS
    )
    css = faces + _asset("app.css").decode("utf-8")
    script = _asset("app.js").decode("utf-8")
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    policy = (
        "default-src 'none'; "
        f"script-src 'sha256-{digest}'; "
        "style-src 'unsafe-inline'; "
        "font-src data:; "
        "img-src data:; "
        "connect-src 'none'; "
        "base-uri 'none'; "
        "form-action 'none'"
    )
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        f'<meta http-equiv="Content-Security-Policy" content="{policy}">\n'
        '<meta name="referrer" content="no-referrer">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<meta name="color-scheme" content="light dark">\n'
        "<title>agent-mem</title>\n"
        f"<style>{css}</style>\n</head>\n<body>\n"
        '<div id="root"><p class="booting">Reading the snapshot…</p></div>\n'
        '<noscript><p class="booting">This page needs JavaScript. It runs locally and makes no network requests.</p></noscript>\n'
        f'<script id="agent-mem-data" type="application/json">{_embedded_json(snapshot)}</script>\n'
        f"<script>{script}</script>\n</body>\n</html>\n"
    )


def write(config: Config, html: str, output: Path | None = None) -> Path:
    """Write the page atomically; the default location is private to the user."""
    if output is None:
        folder = view_dir(config)
        from agent_mem.core.db import ensure_private_dir

        ensure_private_dir(config.data_dir)
        ensure_private_dir(folder)
        target = folder / PAGE_NAME
    else:
        target = output.expanduser().resolve()
        if target.is_dir():
            target = target / PAGE_NAME
        target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
    handle = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as file:
            file.write(html)
        if sys.platform != "win32":
            os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    return target
