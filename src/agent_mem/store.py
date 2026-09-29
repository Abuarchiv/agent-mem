"""Write helpers: search keys, entities, links, memories and deletion. Standard library only."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import PurePosixPath

from . import learn, privacy, timeutil

MAX_KEY_CHARS = 12_000


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except ValueError:
        return []
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


def entity_id(conn: sqlite3.Connection, project_id: str | None, kind: str, key: str) -> int:
    key = key.strip()[:500]
    project_id = project_id or ""
    conn.execute(
        "INSERT INTO entities(project_id, kind, key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        (project_id, kind, key),
    )
    row = conn.execute(
        "SELECT id FROM entities WHERE project_id = ? AND kind = ? AND key = ?", (project_id, kind, key)
    ).fetchone()
    return int(row[0])


def set_search_key(conn: sqlite3.Connection, owner_type: str, owner_id: int, text: str) -> None:
    remove_search_keys(conn, owner_type, owner_id)
    text = text.strip()
    if not text:
        return
    key_id = conn.execute(
        "INSERT INTO search_keys(owner_type, owner_id) VALUES (?, ?)", (owner_type, owner_id)
    ).lastrowid
    conn.execute("INSERT INTO search_fts(rowid, text) VALUES (?, ?)", (key_id, text[:MAX_KEY_CHARS]))


def add_search_key(conn: sqlite3.Connection, owner_type: str, owner_id: int, text: str) -> None:
    """Additional key for the same owner (key expansion)."""
    text = text.strip()
    if not text:
        return
    key_id = conn.execute(
        "INSERT INTO search_keys(owner_type, owner_id) VALUES (?, ?)", (owner_type, owner_id)
    ).lastrowid
    conn.execute("INSERT INTO search_fts(rowid, text) VALUES (?, ?)", (key_id, text[:MAX_KEY_CHARS]))


def remove_search_keys(conn: sqlite3.Connection, owner_type: str, owner_id: int) -> None:
    ids = [
        row[0]
        for row in conn.execute(
            "SELECT id FROM search_keys WHERE owner_type = ? AND owner_id = ?", (owner_type, owner_id)
        )
    ]
    if not ids:
        return
    conn.executemany("DELETE FROM search_fts WHERE rowid = ?", [(i,) for i in ids])
    conn.execute("DELETE FROM search_keys WHERE owner_type = ? AND owner_id = ?", (owner_type, owner_id))


def link(conn: sqlite3.Connection, owner_type: str, owner_id: int, entity_ids: list[int]) -> None:
    conn.executemany(
        "INSERT INTO links(owner_type, owner_id, entity_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        [(owner_type, owner_id, e) for e in set(entity_ids)],
    )


def index_turn(conn: sqlite3.Connection, turn_id: int) -> None:
    """Build search keys, entities, links and Hebbian edges for a finished turn."""
    turn = conn.execute(
        "SELECT t.*, s.harness, s.branch FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?",
        (turn_id,),
    ).fetchone()
    if turn is None:
        return
    files = _json_list(turn["files_json"])
    commands = _json_list(turn["commands_json"])
    errors = _json_list(turn["errors_json"])
    head = f"[{turn['harness']}{' · ' + turn['branch'] if turn['branch'] else ''} · {timeutil.day(turn['started_at'])}]"
    parts = [head, turn["prompt"], turn["answer"]]
    if files:
        parts.append("files: " + " ".join(files) + " " + " ".join(PurePosixPath(f).name for f in files))
    if commands:
        parts.append("commands: " + " | ".join(commands))
    if errors:
        parts.append("errors: " + " | ".join(errors))
    set_search_key(conn, "t", turn_id, "\n".join(p for p in parts if p))

    project_id = turn["project_id"]
    entity_ids: list[int] = []
    for path in files[:20]:
        entity_ids.append(entity_id(conn, project_id, "file", path))
    for command in commands[:10]:
        entity_ids.append(entity_id(conn, project_id, "command", command))
    for error in errors[:5]:
        entity_ids.append(entity_id(conn, project_id, "error", error))
    events = conn.execute(
        "SELECT DISTINCT error_sig FROM events WHERE turn_id = ? AND error_sig IS NOT NULL", (turn_id,)
    ).fetchall()
    for row in events:
        entity_ids.append(entity_id(conn, project_id, "error", "sig:" + row[0]))
    link(conn, "t", turn_id, entity_ids)
    learn.hebbian_update(conn, entity_ids)
    conn.execute("UPDATE turns SET indexed_at = ? WHERE id = ?", (timeutil.iso(), turn_id))


def add_memory(
    conn: sqlite3.Connection,
    *,
    project_id: str | None,
    kind: str,
    title: str,
    body: str,
    source: str,
    trust: str,
    importance: float = 0.5,
    turn_id: int | None = None,
    origin: str | None = None,
    dedupe: str | None = None,
    entity_ids: list[int] | None = None,
) -> int | None:
    """Insert a memory (append-only). Returns the id, or None when the dedupe key already exists.

    Title and body are always cleaned here (redaction, private sections, size), whatever the source.
    """
    title = privacy.clean_text(title, 300)
    body = privacy.clean_text(body, 8000)
    now = timeutil.iso()
    key = dedupe or hashlib.sha256(f"{project_id}|{kind}|{title}|{body}".encode()).hexdigest()
    cursor = conn.execute(
        "INSERT INTO memories(project_id, kind, title, body, source, trust, importance, turn_id, origin, "
        "valid_from, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(dedupe_key) DO NOTHING",
        (project_id, kind, title[:300], body[:8000], source, trust, importance, turn_id, origin, now, now, key),
    )
    if cursor.rowcount == 0:
        return None
    memory_id = int(cursor.lastrowid or 0)
    set_search_key(conn, "m", memory_id, f"{kind}: {title}\n{body}")
    ids = list(entity_ids or [])
    if turn_id is not None:
        ids.extend(
            row[0]
            for row in conn.execute("SELECT entity_id FROM links WHERE owner_type = 't' AND owner_id = ?", (turn_id,))
        )
    if ids:
        link(conn, "m", memory_id, ids)
    learn.record_access(conn, [("m", memory_id)], "created", ts=now)
    return memory_id


def supersede(conn: sqlite3.Connection, old_id: int, new_id: int) -> None:
    now = timeutil.iso()
    conn.execute(
        "UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL",
        (now, new_id, old_id),
    )


def delete_owner(conn: sqlite3.Connection, owner_type: str, owner_id: int) -> bool:
    """Hard delete including keys, vectors, links, anchors and access history."""
    remove_search_keys(conn, owner_type, owner_id)
    for table in ("vectors", "links", "anchors", "accesses"):
        conn.execute(f"DELETE FROM {table} WHERE owner_type = ? AND owner_id = ?", (owner_type, owner_id))
    if owner_type == "t":
        conn.execute("DELETE FROM events WHERE turn_id = ?", (owner_id,))
        cursor = conn.execute("DELETE FROM turns WHERE id = ?", (owner_id,))
    else:
        cursor = conn.execute("DELETE FROM memories WHERE id = ?", (owner_id,))
    return cursor.rowcount > 0


def parse_owner(text: str) -> tuple[str, int] | None:
    """Parse visible ids such as ``T12`` or ``M7``."""
    value = text.strip().upper().lstrip("#")
    if len(value) < 2 or value[0] not in {"T", "M"} or not value[1:].isdigit():
        return None
    return value[0].lower(), int(value[1:])


def owner_label(owner_type: str, owner_id: int) -> str:
    return f"{owner_type.upper()}{owner_id}"
