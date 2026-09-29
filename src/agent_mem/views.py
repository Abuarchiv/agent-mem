"""Text views shared by the MCP server and the CLI (search results, details, timelines)."""

from __future__ import annotations

import json
import sqlite3

from . import consolidate, learn, search, timeutil
from .signals import first_line
from .store import owner_label, parse_owner


def search_lines(hits: list[search.Hit]) -> str:
    if not hits:
        return "No matching memories."
    lines = []
    for hit in hits:
        stale = ""
        states = [state for _, state in _anchor_states(hit)]
        if any(state.startswith("changed") or state == "deleted" for state in states):
            stale = " ⚠ files changed since"
        origin = hit.harness or hit.kind
        lines.append(
            f"{hit.label} · {timeutil.day(hit.ts)} · {origin} · score {hit.score:.2f}{stale}\n  {first_line(hit.title or hit.text, 160)}"
        )
    lines.append("Use mem_get with ids for details, mem_timeline for context.")
    return "\n".join(lines)


_ANCHOR_CACHE: dict[tuple[str, int], list[tuple[str, str]]] = {}


def _anchor_states(hit: search.Hit) -> list[tuple[str, str]]:
    return _ANCHOR_CACHE.get(hit.owner, [])


def prime_anchor_states(conn: sqlite3.Connection, hits: list[search.Hit]) -> None:
    _ANCHOR_CACHE.clear()
    for hit in hits:
        _ANCHOR_CACHE[hit.owner] = consolidate.anchor_status(conn, hit.owner)


def details(conn: sqlite3.Connection, ids: list[str], session_id: str | None = None) -> str:
    blocks: list[str] = []
    owners: list[tuple[str, int]] = []
    for raw in ids[:10]:
        owner = parse_owner(raw)
        if owner is None:
            blocks.append(f"{raw}: invalid id (expected T<number> or M<number>)")
            continue
        text = _turn_details(conn, owner[1]) if owner[0] == "t" else _memory_details(conn, owner[1])
        if text is None:
            blocks.append(f"{raw}: not found")
            continue
        states = consolidate.anchor_status(conn, owner)
        if states:
            text += "\nfiles: " + ", ".join(f"{path} ({state})" for path, state in states[:8])
        blocks.append(text)
        owners.append(owner)
    if owners:
        learn.record_access(conn, owners, "get", session_id)
    return "\n\n---\n\n".join(blocks)


def _turn_details(conn: sqlite3.Connection, turn_id: int) -> str | None:
    row = conn.execute(
        "SELECT t.*, s.harness, s.branch, p.name AS project FROM turns t JOIN sessions s ON s.id = t.session_id "
        "LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
        (turn_id,),
    ).fetchone()
    if row is None:
        return None
    header = (
        f"T{row['id']} · {row['started_at']} · {row['harness']} · project {row['project'] or '-'}"
        f"{' · branch ' + row['branch'] if row['branch'] else ''} · outcome {row['outcome']} · source: recorded session"
    )
    parts = [header, f"request: {row['prompt'][:3000]}"]
    tools = conn.execute(
        "SELECT tool, command_key, exit_code, error_sig, resolved, payload FROM events WHERE turn_id = ? AND kind = 'tool' ORDER BY id LIMIT 30",
        (turn_id,),
    ).fetchall()
    if tools:
        lines = []
        for tool in tools:
            payload = json.loads(tool["payload"])
            status = "failed" if tool["error_sig"] else "ok"
            if tool["error_sig"] and tool["resolved"]:
                status = "failed, later fixed"
            detail = tool["command_key"] or payload.get("category") or ""
            error = f" — {payload.get('error_line')}" if payload.get("error_line") else ""
            trust = " [external content]" if payload.get("trust") == "tool_external" else ""
            lines.append(f"  - {tool['tool']} {detail} ({status}){error}{trust}")
        parts.append("actions:\n" + "\n".join(lines))
    if row["answer"]:
        parts.append(f"result: {row['answer'][:3000]}")
    return "\n".join(parts)


def _memory_details(conn: sqlite3.Connection, memory_id: int) -> str | None:
    row = conn.execute(
        "SELECT m.*, p.name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id = ?",
        (memory_id,),
    ).fetchone()
    if row is None:
        return None
    status = ""
    if row["invalid_at"]:
        status = f" · no longer valid since {timeutil.day(row['invalid_at'])}"
        if row["superseded_by"]:
            status += f" (superseded by M{row['superseded_by']})"
    provenance = f" · from T{row['turn_id']}" if row["turn_id"] else ""
    return (
        f"M{row['id']} · {row['kind']} · {row['created_at']} · project {row['project'] or 'global'} · "
        f"source {row['source']}/{row['origin'] or '-'} · trust {row['trust']}{provenance}{status}\n"
        f"{row['title']}" + ("" if row["body"].strip() == row["title"].strip() else f"\n{row['body'][:4000]}")
    )


def timeline(conn: sqlite3.Connection, raw_id: str, before: int = 3, after: int = 3) -> str:
    owner = parse_owner(raw_id)
    if owner is None:
        return f"{raw_id}: invalid id"
    turn_id = owner[1]
    if owner[0] == "m":
        row = conn.execute("SELECT turn_id FROM memories WHERE id = ?", (owner[1],)).fetchone()
        if row is None or row[0] is None:
            return f"{raw_id}: no session context"
        turn_id = int(row[0])
    anchor = conn.execute("SELECT session_id FROM turns WHERE id = ?", (turn_id,)).fetchone()
    if anchor is None:
        return f"{raw_id}: not found"
    rows = conn.execute(
        "SELECT * FROM (SELECT id, started_at, prompt, answer, outcome FROM turns WHERE session_id = ? AND id < ? "
        "ORDER BY id DESC LIMIT ?) UNION ALL SELECT id, started_at, prompt, answer, outcome FROM turns WHERE id = ? "
        "UNION ALL SELECT * FROM (SELECT id, started_at, prompt, answer, outcome FROM turns WHERE session_id = ? AND id > ? "
        "ORDER BY id LIMIT ?) ORDER BY id",
        (anchor[0], turn_id, max(before, 0), turn_id, anchor[0], turn_id, max(after, 0)),
    ).fetchall()
    lines = []
    for row in rows:
        marker = "▶" if row["id"] == turn_id else " "
        lines.append(
            f"{marker} T{row['id']} · {row['started_at'][:16]} · {row['outcome']}: {first_line(row['prompt'], 120)}"
            + (f"\n    → {first_line(row['answer'], 160)}" if row["answer"] else "")
        )
    return "\n".join(lines)


def label(owner: tuple[str, int]) -> str:
    return owner_label(*owner)
