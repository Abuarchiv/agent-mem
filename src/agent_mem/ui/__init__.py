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
from datetime import timedelta
from importlib import resources
from pathlib import Path
from typing import Any

from agent_mem import __version__
from agent_mem.core import timeutil
from agent_mem.core.config import Config
from agent_mem.memory import learn

LIMITS = {
    "sessions": 150,
    "turns": 250,
    "actions_per_turn": 30,
    "memories": 1500,
    "graph_entities": 70,
    "graph_memories": 260,
    "recipes": 200,
    "rules": 200,
    "profile": 200,
    "days": 14,
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


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except ValueError:
        return []
    return [str(item) for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


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


def build_snapshot(conn: sqlite3.Connection, config: Config, project_id: str | None = None) -> dict[str, Any]:
    """Bounded, JSON-safe snapshot of the database. ``project_id`` limits every list to one project."""
    from agent_mem.cli.health import agents, quarantine_latest, status

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
    turns: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, session_id, project_id, started_at, ended_at, prompt, answer, outcome, importance, trust, title, type, "
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
                "importance": row["importance"],
                "trust": row["trust"],
                "files": _json_list(row["files_json"])[:20],
                "commands": _json_list(row["commands_json"])[:10],
                "errors": _json_list(row["errors_json"])[:10],
                "work": row["work_tokens"],
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
            target, note = _action_text(str(payload.get("input") or ""))
            text, _ = _cap(target, INPUT_CHARS)
            items.append(
                {
                    "ts": event["ts"],
                    "tool": event["tool"],
                    "category": payload.get("category"),
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

    memories: list[dict[str, Any]] = []
    for row in conn.execute(
        "SELECT id, project_id, kind, title, body, source, trust, importance, turn_id, origin, valid_from, invalid_at, "
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
        entry = {**dict(row), "body": body, "truncated": body_cut}
        entry["harness"] = entry["harness"] or _ORIGIN_HARNESS.get(entry["origin"] or "", entry["origin"])
        memories.append(entry)
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
        "daily": daily,
        "graph": memory_graph(conn, project_id),
    }


# Native notes and memories saved through the MCP tool name their harness in ``origin``.
_ORIGIN_HARNESS = {"claude-auto-memory": "claude", "codex-memory": "codex"}

# The concrete things memories talk about, as agentmemory's graph extracts them (files, commands, settings,
# identifiers), read from the memory text without a model: paths and file names, and `code spans`.
_EXT = r"(?:py|md|js|ts|tsx|json|jsonl|sql|sh|ps1|toml|css|html|yaml|yml|cfg|lock|plist)"
_FILE = re.compile(rf"(?<![\w/.-])((?:[\w.-]+/)*[\w-]+(?:\.[\w-]+)*\.{_EXT})(?![\w/])")
_CODE = re.compile(r"`([^`\n]{1,60})`")
_SHELL_PLUMBING = {"cd", "ls", "cat", "echo", "mkdir", "rm", "cp", "mv", "sed", "grep", "head", "tail", "find"}
_RUNNERS = {"uv", "uvx", "npx", "npm", "pnpm", "python", "python3", "pip", "cargo", "go", "bun"}
# Scratch files of one run connect nothing later. Matched as text, nothing is created there.
_TEMP = ("/tmp/", "/private/", "scratchpad", "/var/folders/", "/tool-results/")  # noqa: S108


def _file_key(path: str) -> str:
    """A file is its name; ``__init__.py`` keeps its folder, or every package would be one node."""
    parts = path.strip("/").split("/")
    return "/".join(parts[-2:]) if parts[-1] == "__init__.py" else parts[-1]


def _command_label(words: list[str]) -> str:
    """`uv run pytest -q` and `uv run pytest tests/x.py` are one command: the runner, its verb and the tool."""
    plain = [word for word in words if not word.startswith("-")]
    size = 3 if plain and plain[0] in _RUNNERS and len(plain) > 2 else 2
    return " ".join(plain[:size])


def memory_entities(text: str) -> dict[tuple[str, str], str]:
    """(kind, key) -> label for the files, commands, settings and identifiers a memory names."""
    found: dict[tuple[str, str], str] = {}
    for match in _FILE.finditer(text):
        if not any(part in match.group(1) for part in _TEMP):
            found[("file", _file_key(match.group(1)).lower())] = _file_key(match.group(1))
    for match in _CODE.finditer(text):
        span = match.group(1).strip()
        if _FILE.fullmatch(span) or span.startswith(("-", "<")) or len(span) < 3:
            continue
        words = span.split()
        plain = [word for word in words if not word.startswith("-")]
        if len(plain) > 1:
            if plain[0] in _SHELL_PLUMBING:
                continue
            label, kind = _command_label(words), "command"
        elif len(words) > 1 or (span.startswith(("/", "~")) and span.count("/") > 1):
            continue  # a bare word with flags, or a directory of this machine
        elif re.fullmatch(r"[a-z_]+(?:\.[a-z_]+)+", span):
            label, kind = span, "setting"
        elif re.search(r"[_./()@:-]|[a-z][A-Z]", span):
            label, kind = span, "code"  # an identifier; a plain word such as `hooks` names nothing specific
        else:
            continue
        found.setdefault((kind, label.lower()), label)
    return found


def memory_graph(conn: sqlite3.Connection, project_id: str | None) -> dict[str, Any]:
    """Memories linked through the things they name. An entity becomes a node once two memories share it;
    each memory is linked to it, and to the files its turn changed when that turn changed only a few."""
    rows = conn.execute(
        "SELECT m.id, m.project_id, m.kind, m.title, m.body, m.superseded_by, t.files_json FROM memories m "
        "LEFT JOIN turns t ON t.id = m.turn_id WHERE m.invalid_at IS NULL AND m.source != 'native' "
        f"{'AND m.project_id = ?' if project_id is not None else ''} ORDER BY m.id DESC",
        (project_id,) if project_id is not None else (),
    ).fetchall()
    # The project's own name ("agent-mem") is in half its memories and would tie them all to one node.
    own = {str(name).lower() for (name,) in conn.execute("SELECT name FROM projects")}
    links: dict[tuple[str, str, str], dict[int, str]] = {}
    labels: dict[tuple[str, str, str], str] = {}
    memory_rows = {}
    for row in rows:
        memory_rows[row["id"]] = row
        project = row["project_id"] or ""
        for (kind, key), label in memory_entities(f"{row['title'] or ''}\n{row['body'] or ''}").items():
            if key in own:
                continue
            links.setdefault((project, kind, key), {})[row["id"]] = "mentions"
            labels.setdefault((project, kind, key), label)
        files = _json_list(row["files_json"])
        if 0 < len(files) <= 4:  # a turn that touched a dozen files says little about each
            for path in (f for f in files if not any(part in f for part in _TEMP)):
                key = (project, "file", _file_key(path).lower())
                links.setdefault(key, {}).setdefault(row["id"], "changed")
                labels.setdefault(key, _file_key(path))
    shared = sorted((key for key, members in links.items() if len(members) >= 2), key=lambda k: -len(links[k]))
    entities = shared[: LIMITS["graph_entities"]]
    chosen: dict[int, int] = {}
    for key in entities:
        for memory_id in links[key]:
            chosen[memory_id] = chosen.get(memory_id, 0) + 1
    # The most connected memories first, newer ones on ties.
    kept = set(sorted(chosen, key=lambda mid: (-chosen[mid], -mid))[: LIMITS["graph_memories"]])
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for index, key in enumerate(entities):
        members = {mid: how for mid, how in links[key].items() if mid in kept}
        if len(members) < 2:
            continue
        node_id = f"e{index}"
        nodes.append(
            {
                "id": node_id,
                "type": "entity",
                "kind": key[1],
                "label": labels[key],
                "project_id": key[0] or None,
                "degree": len(links[key]),
            }
        )
        edges += [{"a": node_id, "b": f"m{mid}", "kind": how} for mid, how in members.items()]
    linked = {edge["b"] for edge in edges}
    for memory_id in sorted(kept, reverse=True):
        if f"m{memory_id}" not in linked:
            continue
        row = memory_rows[memory_id]
        text = (row["body"] or "").strip() if len(row["body"] or "") > len(row["title"] or "") else row["title"]
        nodes.append(
            {
                "id": f"m{memory_id}",
                "type": "memory",
                "kind": row["kind"],
                "memory_id": memory_id,
                "label": (text or "")[:160],
                "project_id": row["project_id"] or None,
            }
        )
        if row["superseded_by"] and f"m{row['superseded_by']}" in linked:
            edges.append({"a": f"m{memory_id}", "b": f"m{row['superseded_by']}", "kind": "replaced"})
    return {"nodes": nodes, "edges": edges, "entities_total": len(shared)}


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
