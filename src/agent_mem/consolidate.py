"""Consolidation ("sleep"): runs in the indexer at most once per day.

1. Hebbian edges decay; weak edges are pruned.
2. Preferences seen in two or more projects become global.
3. Newer facts/decisions with the same title supersede older ones.
4. Memories anchored to deleted files are invalidated; anchors are recorded.
5. Rules that never fire expire.
6. A-MEM-style linking: new memories add their key to their nearest neighbours.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from . import db, identity, learn, store, timeutil
from .config import Config

_NORMALIZE = re.compile(r"[\W_]+")  # Unicode-aware: Cyrillic, CJK etc. keep their letters


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
    stats["anchors"] = record_anchors(conn)
    stats["invalidated"] = _invalidate_deleted(conn)
    if embedder_matrix is not None:
        stats["linked"] = embedder_matrix(conn)
    with db.transaction(conn):
        db.set_meta(conn, "consolidated_at", timeutil.iso())
    return stats


def _promote_preferences(conn: sqlite3.Connection) -> int:
    rows = conn.execute(
        "SELECT title, body, COUNT(DISTINCT project_id) AS projects FROM memories "
        "WHERE kind = 'preference' AND source = 'hook' AND trust = 'user' AND project_id IS NOT NULL "
        "AND invalid_at IS NULL GROUP BY body HAVING projects >= 2"
    ).fetchall()
    created = 0
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
            dedupe=f"global-pref|{_norm(row['body'])}",
        )
        created += memory_id is not None
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
            store.supersede(conn, latest[key], int(row["id"]))
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
    count = 0
    with db.transaction(conn):
        for row in rows:
            path = Path(row["key"])
            full = path if path.is_absolute() else Path(row["root"]) / path
            conn.execute(
                "INSERT INTO anchors(owner_type, owner_id, path, blob_hash, recorded_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT DO NOTHING",
                (row["owner_type"], row["owner_id"], row["key"], identity.git_blob_hash(full), timeutil.iso()),
            )
            count += 1
    return count


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
                conn.execute("UPDATE memories SET invalid_at = ? WHERE id = ?", (timeutil.iso(), row["id"]))
            count += 1
    return count


def link_neighbours(conn: sqlite3.Connection, model: str, since: str | None, threshold: float = 0.85) -> int:
    """New memories add their title as an extra search key to their nearest existing neighbours."""
    import numpy as np

    from .semantic import from_blob

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
