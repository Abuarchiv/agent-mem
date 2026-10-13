"""Consolidation ("sleep"): runs in the indexer at most once per day.

1. Hebbian edges decay; weak edges are pruned.
2. Preferences seen in two or more projects become global.
3. Newer facts/decisions with the same title supersede older ones.
4. Memories anchored to deleted files are invalidated; anchors are recorded.
5. Rules that never fire expire.
6. A-MEM-style linking: new memories add their key to their nearest neighbours.
7. Recorded test/build/lint/install commands keep only the part that does the job; scripts are dropped.
8. Error fixes whose "error" names no error (grep without a match, `| head`) are dropped.
"""

from __future__ import annotations

import re
import shlex
import sqlite3
from pathlib import Path

from agent_mem.core import db, identity, signals, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import learn, store

_NORMALIZE = re.compile(r"[\W_]+")  # Unicode-aware: Cyrillic, CJK etc. keep their letters
_SEGMENTS = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")
_REDIRECT = re.compile(r"\s+(?:\d?>>?|&>)\s*(?:&\d|\S+)")


def _norm(text: str) -> str:
    return _NORMALIZE.sub(" ", text.lower()).strip()


def due(conn: sqlite3.Connection, config: Config) -> bool:
    last = db.get_meta(conn, "consolidated_at")
    return last is None or timeutil.hours_between(last) >= 24


def run(conn: sqlite3.Connection, config: Config, embedder_matrix=None) -> dict[str, int]:
    stats: dict[str, int] = {}
    last = db.get_meta(conn, "consolidated_at")
    days = timeutil.hours_between(last) / 24.0 if last else 0.0
    with db.transaction(conn):
        stats["edges_pruned"] = learn.decay_edges(conn, days)
        stats["global_preferences"] = _promote_preferences(conn)
        stats["superseded"] = _supersede_duplicates(conn)
        stats["rules_expired"] = _expire_rules(conn, config)
        stats["commands_cleaned"] = _clean_commands(conn)
        stats["fixes_dropped"] = _drop_non_error_fixes(conn)
        stats["entities_dropped"] = _drop_noise_entities(conn)
    stats["anchors"] = record_anchors(conn)
    stats["invalidated"] = _invalidate_deleted(conn)
    if embedder_matrix is not None:
        stats["linked"] = embedder_matrix(conn)
    with db.transaction(conn):
        db.set_meta(conn, "consolidated_at", timeutil.iso())
    return stats


def reusable_command(command: str, kind: str) -> str | None:
    """The part of a shell line worth suggesting again as the project's ``kind`` command, or None.

    ``cd app && npm test 2>&1 | tail`` gives ``npm test``; heredocs, shortened text and ``grep … tests/`` give None.
    """
    line = command.strip()
    if "\n" in line or "[truncated]" in line:
        return None
    for segment in _SEGMENTS.split(line):
        segment = _REDIRECT.sub("", segment).strip()
        try:
            shlex.split(segment)
        except ValueError:
            return None  # a quoted |, ; or && was cut apart
        key = signals.command_key(segment)
        if key is not None and signals.command_kind(key) == kind:
            return segment if len(segment) <= 100 else None
    return None


def _clean_commands(conn: sqlite3.Connection) -> int:
    """Rewrite recorded commands to their reusable part, merging variants; drop what is not a command."""
    changed = 0
    rows = conn.execute(
        "SELECT project_id, key, value, count, updated_at FROM profile WHERE key LIKE 'cmd:%'"
    ).fetchall()
    for row in rows:
        value = reusable_command(row["value"], row["key"][4:])
        if value == row["value"]:
            continue
        conn.execute(
            "DELETE FROM profile WHERE project_id = ? AND key = ? AND value = ?",
            (row["project_id"], row["key"], row["value"]),
        )
        if value is not None:
            conn.execute(
                "INSERT INTO profile(project_id, key, value, count, updated_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(project_id, key, value) DO UPDATE SET count = count + excluded.count, "
                "updated_at = max(updated_at, excluded.updated_at)",
                (row["project_id"], row["key"], value, row["count"], row["updated_at"]),
            )
        changed += 1
    return changed


def _drop_noise_entities(conn: sqlite3.Connection) -> int:
    """Whole command lines, reading commands and temporary files recorded before ``store.index_turn`` kept only
    the working part; they made the connections graph a hairball. A command line is merged into its working
    part (links kept, the strongest edge wins), the rest is removed."""
    changed = 0
    rows = conn.execute("SELECT id, project_id, kind, key FROM entities WHERE kind IN ('command', 'file')").fetchall()
    for row in rows:
        old, key = int(row["id"]), row["key"]
        if row["kind"] == "file":
            if not store.scratch_path(key):
                continue
            target = None
        else:
            core = signals.command_key(key)
            if core == key and signals.fixable(key):
                continue
            target = (
                store.entity_id(conn, row["project_id"], "command", core) if core and signals.fixable(core) else None
            )
        if target is not None:
            conn.execute(
                "INSERT OR IGNORE INTO links(owner_type, owner_id, entity_id) "
                "SELECT owner_type, owner_id, ? FROM links WHERE entity_id = ?",
                (target, old),
            )
            for edge in conn.execute(
                "SELECT a, b, weight, updated_at FROM edges WHERE a = ? OR b = ?", (old, old)
            ).fetchall():
                other = edge["b"] if edge["a"] == old else edge["a"]
                if other == target:
                    continue
                conn.execute(
                    "INSERT INTO edges(a, b, weight, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET "
                    "weight = max(weight, excluded.weight), updated_at = max(updated_at, excluded.updated_at)",
                    (min(other, target), max(other, target), edge["weight"], edge["updated_at"]),
                )
        conn.execute("DELETE FROM links WHERE entity_id = ?", (old,))
        conn.execute("DELETE FROM edges WHERE a = ? OR b = ?", (old, old))
        conn.execute("DELETE FROM entities WHERE id = ?", (old,))
        changed += 1
    return changed


def _drop_non_error_fixes(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT id, error_text, command_key FROM recipes").fetchall()
    junk = [
        (row["id"],)
        for row in rows
        if not signals.looks_like_error(row["error_text"] or "") or not signals.fixable(row["command_key"])
    ]
    conn.executemany("DELETE FROM recipes WHERE id = ?", junk)
    return len(junk)


def _promote_preferences(conn: sqlite3.Connection) -> int:
    """A preference stated in two projects holds everywhere. It follows its projects: when they take it back (a
    reversed rule, ``store.learn_rule``), the global copy goes too, and a newer statement makes a newer copy."""
    rows = conn.execute(
        "SELECT body, COUNT(DISTINCT project_id) AS projects, MAX(id) AS newest FROM memories "
        "WHERE kind = 'preference' AND source = 'hook' AND trust = 'user' AND project_id IS NOT NULL "
        "AND invalid_at IS NULL GROUP BY body HAVING projects >= 2"
    ).fetchall()
    created = 0
    current: set[int] = set()
    for row in rows:
        memory_id = store.add_memory(
            conn,
            project_id=None,
            kind="preference",
            title=row["body"] + " (across projects)",
            body=row["body"],
            source="hook",
            trust="user",
            importance=0.9,
            dedupe=f"global-pref|{_norm(row['body'])}|{row['newest']}",
        )
        created += memory_id is not None
        key = conn.execute(
            "SELECT id FROM memories WHERE dedupe_key = ?", (f"global-pref|{_norm(row['body'])}|{row['newest']}",)
        ).fetchone()
        current.add(int(key[0]))
    for (old,) in conn.execute(
        "SELECT id FROM memories WHERE dedupe_key LIKE 'global-pref|%' AND invalid_at IS NULL"
    ).fetchall():
        if old not in current:
            store.supersede(conn, int(old), None)
    return created


def _supersede_duplicates(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        "SELECT id, project_id, kind, title FROM memories WHERE kind IN ('fact', 'decision', 'summary') "
        "AND invalid_at IS NULL ORDER BY id"
    ).fetchall()
    latest: dict[tuple[str | None, str, str], int] = {}
    count = 0
    for row in rows:
        normalized = _norm(row["title"])[:120]
        if not normalized:
            continue
        key = (row["project_id"], row["kind"], normalized)
        if key in latest:
            store.retire(conn, latest[key], int(row["id"]))  # the mem0 copy goes too
            count += 1
        latest[key] = int(row["id"])
    return count


def _expire_rules(conn: sqlite3.Connection, config: Config) -> int:
    count = 0
    for row in conn.execute("SELECT id, created_at, last_hit_at FROM rules WHERE enabled = 1").fetchall():
        reference = row["last_hit_at"] or row["created_at"]
        if timeutil.hours_between(reference) / 24 > config.rules.expire_days:
            conn.execute("UPDATE rules SET enabled = 0 WHERE id = ?", (row["id"],))
            count += 1
    return count


def record_anchors(conn: sqlite3.Connection, limit: int = 2000) -> int:
    """Record git blob hashes for files linked to turns and memories that have no anchor yet."""
    rows = conn.execute(
        "SELECT l.owner_type, l.owner_id, e.key, p.root FROM links l JOIN entities e ON e.id = l.entity_id "
        "JOIN projects p ON p.id = e.project_id "
        "LEFT JOIN anchors a ON a.owner_type = l.owner_type AND a.owner_id = l.owner_id AND a.path = e.key "
        "WHERE e.kind = 'file' AND a.path IS NULL LIMIT ?",
        (limit,),
    ).fetchall()
    # Files are hashed before the write lock is taken: up to 2000 reads would hold every hook back.
    anchors = []
    for row in rows:
        path = Path(row["key"])
        full = path if path.is_absolute() else Path(row["root"]) / path
        anchors.append((row["owner_type"], row["owner_id"], row["key"], identity.git_blob_hash(full), timeutil.iso()))
    with db.transaction(conn):
        conn.executemany(
            "INSERT INTO anchors(owner_type, owner_id, path, blob_hash, recorded_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT DO NOTHING",
            anchors,
        )
    return len(anchors)


def anchor_status(conn: sqlite3.Connection, owner: tuple[str, int]) -> list[tuple[str, str]]:
    """For each anchored file: 'unchanged', 'changed' or 'deleted'."""
    rows = conn.execute(
        "SELECT a.path, a.blob_hash, a.recorded_at, p.root FROM anchors a "
        "LEFT JOIN turns t ON a.owner_type = 't' AND t.id = a.owner_id "
        "LEFT JOIN memories m ON a.owner_type = 'm' AND m.id = a.owner_id "
        "JOIN projects p ON p.id = COALESCE(t.project_id, m.project_id) "
        "WHERE a.owner_type = ? AND a.owner_id = ?",
        owner,
    ).fetchall()
    result = []
    for row in rows:
        path = Path(row["path"])
        full = path if path.is_absolute() else Path(row["root"]) / path
        if not full.exists():
            result.append((row["path"], "deleted"))
            continue
        current = identity.git_blob_hash(full)
        state = "unchanged" if current == row["blob_hash"] else f"changed since {timeutil.day(row['recorded_at'])}"
        result.append((row["path"], state))
    return result


def _invalidate_deleted(conn: sqlite3.Connection) -> int:
    """Hard invalidation only with clear evidence: every anchored file of a dead end/decision is gone."""
    count = 0
    rows = conn.execute(
        "SELECT id FROM memories WHERE kind IN ('dead_end', 'decision') AND invalid_at IS NULL"
    ).fetchall()
    for row in rows:
        states = anchor_status(conn, ("m", int(row["id"])))
        if states and all(state == "deleted" for _, state in states):
            with db.transaction(conn):
                store.retire(conn, int(row["id"]), None)  # its mem0 copy goes too, or extraction keeps it current
            count += 1
    return count


def link_neighbours(conn: sqlite3.Connection, model: str, since: str | None, threshold: float = 0.85) -> int:
    """New memories add their title as an extra search key to their nearest existing neighbours."""
    import numpy as np

    from agent_mem.memory.semantic import from_blob

    new_rows = conn.execute(
        "SELECT m.id, m.title, m.project_id, v.vec FROM memories m JOIN vectors v ON v.owner_type = 'm' AND v.owner_id = m.id "
        "WHERE v.model = ? AND m.invalid_at IS NULL AND m.created_at >= ?",
        (model, since or ""),
    ).fetchall()
    if not new_rows:
        return 0
    all_rows = conn.execute(
        "SELECT v.owner_type, v.owner_id, v.vec, COALESCE(t.project_id, m.project_id) AS project_id FROM vectors v "
        "LEFT JOIN turns t ON v.owner_type = 't' AND t.id = v.owner_id "
        "LEFT JOIN memories m ON v.owner_type = 'm' AND m.id = v.owner_id WHERE v.model = ?",
        (model,),
    ).fetchall()
    if len(all_rows) < 2:
        return 0
    matrix = np.vstack([from_blob(r["vec"]) for r in all_rows])
    linked = 0
    with db.transaction(conn):
        for row in new_rows:
            scores = matrix @ from_blob(row["vec"])
            for index in np.argsort(-scores)[:4]:
                other = all_rows[int(index)]
                if (other["owner_type"], int(other["owner_id"])) == ("m", int(row["id"])):
                    continue
                if scores[index] < threshold or other["project_id"] != row["project_id"]:
                    continue
                store.add_search_key(conn, other["owner_type"], int(other["owner_id"]), f"related: {row['title']}")
                linked += 1
    return linked
