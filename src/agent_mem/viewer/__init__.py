"""``agent-mem view``: a read-only HTML page of the local memory.

The page is one self-contained file in the private data directory. There is no server and no open port; the file
embeds a bounded snapshot, its stylesheet, script and fonts, and a Content Security Policy that allows only its own
script (by hash) and blocks every network request. Loaded by the CLI only, never on the hook path.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import shutil
import sqlite3
import sys
from datetime import timedelta
from importlib import resources
from pathlib import Path
from typing import Any

from .. import __version__, learn, timeutil
from ..config import Config

LIMITS = {
    "sessions": 150,
    "turns": 250,
    "actions_per_turn": 30,
    "memories": 400,
    "recipes": 200,
    "rules": 200,
    "profile": 200,
    "graph_nodes": 160,
    "graph_edges": 420,
    "days": 14,
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


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except ValueError:
        return []
    return [str(item) for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


def _cap(text: str | None, limit: int) -> tuple[str, bool]:
    value = text or ""
    return (value, False) if len(value) <= limit else (value[:limit], True)


def _rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params)]


def _count(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> int:
    return int(conn.execute(sql, params).fetchone()[0])


def build_snapshot(conn: sqlite3.Connection, config: Config, project_id: str | None = None) -> dict[str, Any]:
    """Bounded, JSON-safe snapshot of the database. ``project_id`` limits every list to one project."""
    from ..health import status

    scoped = project_id is not None
    where = "WHERE project_id = ?" if scoped else ""
    and_scope = "AND project_id = ?" if scoped else ""
    params: tuple[Any, ...] = (project_id,) if scoped else ()

    projects = _rows(
        conn,
        f"SELECT id, name, root, remote FROM projects {'WHERE id = ?' if scoped else ''} ORDER BY name",
        params,
    )
    sessions = _rows(
        conn,
        "SELECT s.id, s.harness, s.project_id, s.branch, s.started_at, s.ended_at, s.last_event_at, s.summarized_at, "
        "(SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turns "
        f"FROM sessions s {'WHERE s.project_id = ?' if scoped else ''} ORDER BY s.last_event_at DESC LIMIT ?",
        (*params, LIMITS["sessions"]),
    )
    turns: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, session_id, project_id, started_at, ended_at, prompt, answer, outcome, importance, trust, "
        f"files_json, commands_json, errors_json FROM turns {where} ORDER BY started_at DESC, id DESC LIMIT ?",
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
                "importance": row["importance"],
                "trust": row["trust"],
                "files": _json_list(row["files_json"])[:20],
                "commands": _json_list(row["commands_json"])[:10],
                "errors": _json_list(row["errors_json"])[:10],
            }
        )
    actions: dict[str, list[dict[str, Any]]] = {}
    for turn in turns:
        items = []
        for event in conn.execute(
            "SELECT ts, tool, command_key, exit_code, error_sig, resolved, payload FROM events "
            "WHERE turn_id = ? AND kind = 'tool' ORDER BY id LIMIT ?",
            (turn["id"], LIMITS["actions_per_turn"]),
        ):
            try:
                payload = json.loads(event["payload"])
            except ValueError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            text, _ = _cap(str(payload.get("input") or ""), INPUT_CHARS)
            items.append(
                {
                    "ts": event["ts"],
                    "tool": event["tool"],
                    "category": payload.get("category"),
                    "command": event["command_key"],
                    "input": text,
                    "failed": bool(event["error_sig"]) or bool(payload.get("failed")),
                    "resolved": bool(event["resolved"]),
                    "error_line": payload.get("error_line"),
                    "exit_code": event["exit_code"],
                    "external": payload.get("trust") == "tool_external",
                }
            )
        if items:
            actions[str(turn["id"])] = items

    memories: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, project_id, kind, title, body, source, trust, importance, turn_id, origin, valid_from, invalid_at, "
        f"superseded_by, created_at FROM memories {where} "
        "ORDER BY invalid_at IS NOT NULL, created_at DESC, id DESC LIMIT ?",
        (*params, LIMITS["memories"]),
    ):
        body, body_cut = _cap(row["body"], BODY_CHARS)
        memories.append({**dict(row), "body": body, "truncated": body_cut})
    stats = learn.owner_stats(conn, [("m", int(memory["id"])) for memory in memories])
    for memory in memories:
        entry = stats[("m", int(memory["id"]))]
        memory["activation"] = round(entry.activation_factor, 3)
        memory["used"] = entry.used
        memory["shown"] = entry.shown

    recipes = _rows(
        conn,
        "SELECT id, project_id, error_sig, error_text, command_key, files_json, successes, recurrences, last_turn_id, "
        f"updated_at FROM recipes {where} ORDER BY successes DESC, updated_at DESC LIMIT ?",
        (*params, LIMITS["recipes"]),
    )
    for recipe in recipes:
        recipe["files"] = _json_list(recipe.pop("files_json"))[:10]
    rules = _rows(
        conn,
        "SELECT id, project_id, kind, pattern, message, evidence, enabled, hits, overrides, created_at, last_hit_at "
        f"FROM rules {'WHERE project_id = ? OR project_id IS NULL' if scoped else ''} "
        "ORDER BY enabled DESC, evidence DESC LIMIT ?",
        (*params, LIMITS["rules"]),
    )
    profile = _rows(
        conn,
        f"SELECT project_id, key, value, count, updated_at FROM profile {where} ORDER BY count DESC, updated_at DESC LIMIT ?",
        (*params, LIMITS["profile"]),
    )

    days = LIMITS["days"]
    since = timeutil.iso(timeutil.now() - timedelta(days=days))
    daily = _rows(
        conn,
        "SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS turns, SUM(outcome = 'error') AS errors FROM turns "
        f"WHERE started_at >= ? {and_scope} GROUP BY day ORDER BY day",
        (since, *params),
    )

    entity_scope = "WHERE e.project_id = ?" if scoped else ""
    nodes = _rows(
        conn,
        "SELECT e.id, e.kind, e.key, e.project_id, ROUND(SUM(x.weight), 3) AS strength, COUNT(*) AS degree FROM entities e "
        "JOIN (SELECT a AS id, weight FROM edges UNION ALL SELECT b AS id, weight FROM edges) x ON x.id = e.id "
        f"{entity_scope} GROUP BY e.id ORDER BY strength DESC LIMIT ?",
        (*params, LIMITS["graph_nodes"]),
    )
    node_ids = [int(node["id"]) for node in nodes]
    edges: list[dict[str, Any]] = []
    if node_ids:
        marks = ",".join("?" for _ in node_ids)
        edges = _rows(
            conn,
            f"SELECT a, b, ROUND(weight, 3) AS weight FROM edges WHERE a IN ({marks}) AND b IN ({marks}) "
            "ORDER BY weight DESC LIMIT ?",
            (*node_ids, *node_ids, LIMITS["graph_edges"]),
        )

    counts = {
        "projects": len(projects),
        "sessions": _count(conn, f"SELECT COUNT(*) FROM sessions {where}", params),
        "turns": _count(conn, f"SELECT COUNT(*) FROM turns {where}", params),
        "turns_error": _count(conn, f"SELECT COUNT(*) FROM turns WHERE outcome = 'error' {and_scope}", params),
        "memories": _count(conn, f"SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL {and_scope}", params),
        "memories_invalid": _count(
            conn, f"SELECT COUNT(*) FROM memories WHERE invalid_at IS NOT NULL {and_scope}", params
        ),
        "recipes": _count(conn, f"SELECT COUNT(*) FROM recipes {where}", params),
        "rules_enabled": _count(
            conn,
            f"SELECT COUNT(*) FROM rules WHERE enabled = 1 {'AND (project_id = ? OR project_id IS NULL)' if scoped else ''}",
            params,
        ),
        "rules_proposed": _count(
            conn,
            f"SELECT COUNT(*) FROM rules WHERE enabled = 0 {'AND (project_id = ? OR project_id IS NULL)' if scoped else ''}",
            params,
        ),
        "entities": _count(conn, f"SELECT COUNT(*) FROM entities {where}", params),
        "edges": _count(
            conn,
            "SELECT COUNT(*) FROM edges WHERE a IN (SELECT id FROM entities WHERE project_id = ?)"
            if scoped
            else "SELECT COUNT(*) FROM edges",
            params,
        ),
    }
    health = status(conn, config)
    learning_row = conn.execute(
        f"SELECT COALESCE(SUM(successes), 0), COALESCE(SUM(recurrences), 0) FROM recipes {where}", params
    ).fetchone()
    fixes, recurrences = int(learning_row[0]), int(learning_row[1])
    return {
        "version": 1,
        "agent_mem": __version__,
        "generated_at": timeutil.iso(),
        "project_id": project_id,
        "projects": projects,
        "limits": LIMITS,
        "counts": counts,
        "learning": {
            "errors_fixed": fixes,
            "known_errors_recurred": recurrences,
            "repetition_rate": round(recurrences / (recurrences + fixes), 3) if recurrences + fixes else None,
        },
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
                "last_backup_at",
                "consolidated_at",
                "components",
                "config_warnings",
            )
        },
        "sessions": sessions,
        "turns": turns,
        "actions": actions,
        "memories": memories,
        "recipes": recipes,
        "rules": rules,
        "profile": profile,
        "daily": daily,
        "graph": {"nodes": nodes, "edges": edges},
    }


def _asset(name: str) -> bytes:
    return resources.files("agent_mem.viewer").joinpath(name).read_bytes()


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
        from ..db import ensure_private_dir

        ensure_private_dir(config.data_dir)
        ensure_private_dir(folder)
        target = folder / PAGE_NAME
    else:
        target = output.expanduser().resolve()
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
