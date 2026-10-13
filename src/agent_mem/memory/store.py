"""Write helpers: search keys, entities, links, memories and deletion. Standard library only."""

from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
from pathlib import PurePosixPath

from agent_mem.core import paths, privacy, signals, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import learn

MAX_KEY_CHARS = 12_000


def _json_list(value: str | None) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except ValueError:
        return []
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


# Only compared against, never written to.
_SCRATCH = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")  # noqa: S108


def scratch_path(path: str) -> bool:
    """Temporary files (scratchpads, test data directories) are no part of the project's structure."""
    return path.startswith(_SCRATCH) or "/scratchpad/" in path


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
        if not scratch_path(path):
            entity_ids.append(entity_id(conn, project_id, "file", path))
    for command in commands[:10]:
        # The working part ("uv run pytest"), not the whole line; reading and listing commands are no topic.
        key = signals.command_key(command)
        if key and signals.fixable(key):
            entity_ids.append(entity_id(conn, project_id, "command", key))
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
    at: str | None = None,
) -> int | None:
    """Insert a memory (append-only). Returns the id, or None when the dedupe key already exists.

    Title and body are always cleaned here (redaction, private sections, size), whatever the source. ``at`` dates
    a memory written earlier elsewhere (a harness's own note), so its age and activation are true.
    """
    title = privacy.clean_text(title, 300)
    body = privacy.clean_text(body, 8000)
    now = at or timeutil.iso()
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
    if kind in {"dead_end", "decision", "lesson", "fact"} and ids:
        # Every writer (hook, observer, mem_remember) comes through here: the pre-tool gate must look again, a file
        # with history is shown on read and edit (hooks/capture._file_history).
        with contextlib.suppress(OSError):
            (paths.default_data_dir() / paths.GUARDS).unlink()
    return memory_id


def supersede(conn: sqlite3.Connection, old_id: int, new_id: int | None) -> None:
    """Retire ``old_id`` (``new_id`` None: expired, nothing replaces it). A mirrored fact leaves mem0 too, whoever
    retires it (the review, a duplicate, ``mem_remember(supersedes=…)``): otherwise the next extraction is shown it
    as current and keeps or rewrites it."""
    now = timeutil.iso()
    cursor = conn.execute(
        "UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL",
        (now, new_id, old_id),
    )
    if not cursor.rowcount:
        return
    _drop_keys(conn, old_id)
    key = conn.execute("SELECT dedupe_key FROM memories WHERE id = ?", (old_id,)).fetchone()
    if key and str(key[0] or "").startswith("mem0:"):
        conn.execute(
            "INSERT OR IGNORE INTO observe_forget(mem0_id, ts) VALUES (?, ?)",
            (str(key[0])[len("mem0:") :], now),
        )


def _drop_keys(conn: sqlite3.Connection, memory_id: int) -> None:
    """No search returns a replaced memory (``search.load_hits``), but its keys and vector would keep their ranks
    and push valid facts under the injection threshold. The row stays for the viewer and ``agent-mem show``."""
    remove_search_keys(conn, "m", memory_id)
    conn.execute("DELETE FROM vectors WHERE owner_type = 'm' AND owner_id = ?", (memory_id,))


def drop_retired_keys(conn: sqlite3.Connection) -> int:
    """Keys and vectors of memories retired without ``supersede`` (earlier releases, direct updates)."""
    ids = [
        int(row[0])
        for row in conn.execute(
            "SELECT m.id FROM memories m WHERE m.invalid_at IS NOT NULL AND (EXISTS (SELECT 1 FROM search_keys k "
            "WHERE k.owner_type = 'm' AND k.owner_id = m.id) OR EXISTS (SELECT 1 FROM vectors v "
            "WHERE v.owner_type = 'm' AND v.owner_id = m.id))"
        )
    ]
    for memory_id in ids:
        _drop_keys(conn, memory_id)
    return len(ids)


retire = supersede  # the name the observer's callers use


SCRUB_MESSAGES = "observe.scrub_messages"


def delete_owner(conn: sqlite3.Connection, owner_type: str, owner_id: int) -> bool:
    """Hard delete including keys, vectors, links, anchors and access history."""
    if owner_type == "m":
        # Mirrored facts: the mem0 copy is removed by the next worker run.
        row = conn.execute("SELECT dedupe_key FROM memories WHERE id = ?", (owner_id,)).fetchone()
        if row and str(row[0] or "").startswith("mem0:"):
            conn.execute(
                "INSERT OR IGNORE INTO observe_forget(mem0_id, ts) VALUES (?, ?)",
                (str(row[0])[len("mem0:") :], timeutil.iso()),
            )
    remove_search_keys(conn, owner_type, owner_id)
    for table in ("vectors", "links", "anchors", "accesses"):
        conn.execute(f"DELETE FROM {table} WHERE owner_type = ? AND owner_id = ?", (owner_type, owner_id))
    if owner_type == "t":
        # What was drawn from the turn holds its content too: facts and lessons (with their mem0 copies) and the
        # session summary. memories.turn_id is ON DELETE SET NULL, so the cascade does not reach them.
        for (memory_id,) in conn.execute("SELECT id FROM memories WHERE turn_id = ?", (owner_id,)).fetchall():
            delete_owner(conn, "m", int(memory_id))
        conn.execute(
            "UPDATE sessions SET title = NULL, summary_json = NULL WHERE id = (SELECT session_id FROM turns WHERE id = ?)",
            (owner_id,),
        )
        conn.execute("DELETE FROM events WHERE turn_id = ?", (owner_id,))
        cursor = conn.execute("DELETE FROM turns WHERE id = ?", (owner_id,))
        # mem0 keeps the latest bundle messages and reads them into the next extraction: the worker clears them.
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'", (SCRUB_MESSAGES,)
        )
    else:
        linked = [r[0] for r in conn.execute("SELECT concept_id FROM concept_links WHERE memory_id = ?", (owner_id,))]
        cursor = conn.execute("DELETE FROM memories WHERE id = ?", (owner_id,))
        # A concept is a word from the memory ("Qdrant"); once no memory names it, it goes with them.
        for concept_id in linked:
            conn.execute(
                "DELETE FROM concepts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM concept_links WHERE concept_id = ?)",
                (concept_id, concept_id),
            )
    return cursor.rowcount > 0


def parse_owner(text: str) -> tuple[str, int] | None:
    """Parse visible ids such as ``T12`` or ``M7``."""
    value = text.strip().upper().lstrip("#")
    digits = value[1:]
    if len(value) < 2 or value[0] not in {"T", "M"} or not (digits.isascii() and digits.isdigit()):
        return None
    number = int(digits)
    return (value[0].lower(), number) if number < 2**63 else None  # SQLite INTEGER range


def owner_label(owner_type: str, owner_id: int) -> str:
    return f"{owner_type.upper()}{owner_id}"


def guards_exist(config: Config) -> None:
    """A rule or a dead end may now exist: the pre-tool hook must look again (``core/paths.GUARDS``)."""
    with contextlib.suppress(OSError):
        (config.data_dir / paths.GUARDS).unlink()


def learn_rule(
    conn: sqlite3.Connection, config: Config, project_id: str | None, avoid: str, prefer: str | None, turn_id: int
) -> None:
    """Record one statement "use X instead of Y" (or "avoid X"); a preference memory follows from
    ``rules.min_corrections`` statements. Called by the prompt hook and by the observer."""
    message = f"Use `{prefer}` instead of `{avoid}`" if prefer else f"Avoid `{avoid}`"
    # One turn is one statement: the prompt hook and later the observer read the same prompt, and the observer
    # retries a bundle after an error. Counted each time, a statement typed once would become a preference.
    counted = conn.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)",
        (f"rule.turn|{project_id}|{avoid}|{prefer or ''}|{turn_id}", timeutil.iso()),
    )
    if counted.rowcount == 0:
        return
    guards_exist(config)
    if prefer:
        # "Use npm instead of pnpm" after "use pnpm instead of npm": the newer statement wins; with both rules
        # enabled, npm and pnpm would be blocked alike.
        conn.execute(
            "UPDATE rules SET enabled = 0, evidence = 0 WHERE project_id IS ? AND kind = 'avoid_command' AND pattern = ?",
            (project_id, prefer),
        )
        for old in conn.execute(
            "SELECT id FROM memories WHERE kind = 'preference' AND project_id IS ? AND invalid_at IS NULL "
            "AND substr(dedupe_key, 1, ?) = ?",
            (project_id, len(f"pref|{project_id}|{prefer}|"), f"pref|{project_id}|{prefer}|"),
        ).fetchall():
            supersede(conn, int(old["id"]), None)
    # UPDATE first with ``IS``: a UNIQUE constraint never matches NULL project ids, so an upsert would
    # insert a new row for every correction made outside a project.
    updated = conn.execute(
        "UPDATE rules SET evidence = evidence + 1, message = ? "
        "WHERE project_id IS ? AND kind = 'avoid_command' AND pattern = ?",
        (message, project_id, avoid),
    )
    if updated.rowcount == 0:
        conn.execute(
            "INSERT INTO rules(project_id, kind, pattern, message, evidence, enabled, created_at) "
            "VALUES (?, 'avoid_command', ?, ?, 1, 0, ?)",
            (project_id, avoid, message, timeutil.iso()),
        )
    row = conn.execute(
        "SELECT id, evidence FROM rules WHERE project_id IS ? AND kind = 'avoid_command' AND pattern = ?",
        (project_id, avoid),
    ).fetchone()
    if row is None:
        return
    if row["evidence"] >= config.rules.min_corrections:
        if config.rules.auto_enable:
            conn.execute("UPDATE rules SET enabled = 1 WHERE id = ?", (row["id"],))
        prefix = f"pref|{project_id}|{avoid}|"
        new_id = add_memory(
            conn,
            project_id=project_id,
            kind="preference",
            title=message + f" (corrected {row['evidence']}x)",
            body=message,
            source="hook",
            trust="user",
            importance=0.85,
            turn_id=turn_id,
            dedupe=f"{prefix}{row['evidence']}",
        )
        if new_id is not None:
            # One valid preference per correction: the new count supersedes the earlier ones.
            for old in conn.execute(
                "SELECT id, dedupe_key FROM memories WHERE kind = 'preference' AND project_id IS ? "
                "AND invalid_at IS NULL AND id != ?",
                (project_id, new_id),
            ).fetchall():
                if str(old["dedupe_key"] or "").startswith(prefix):
                    supersede(conn, int(old["id"]), new_id)
