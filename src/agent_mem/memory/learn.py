"""Learning signals: ACT-R activation, usefulness from implicit feedback, Hebbian edges.

Pure functions plus small SQL helpers. Standard library only.
"""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from agent_mem.core import db, timeutil

DECAY = 0.5
# An injection is an exposure, not a retrieval: counted as one, it would raise the activation of whatever was
# injected and make it injected again.
RETRIEVAL_KINDS = ("created", "get", "used", "cited")
USE_KINDS = ("get", "used", "cited")
# Injected this often and never opened, used or cited: left out of the briefing (it stays searchable).
WORN_OUT = 20
TRUST_FACTOR = {"user": 1.0, "agent": 0.9, "tool_local": 0.8, "tool_external": 0.5}
HEBB_RATE = 0.1


def activation(ages_hours: Iterable[float], older_count: int = 0, oldest_age: float | None = None) -> float:
    """ACT-R base-level activation B = ln(sum t_j^-d); older accesses via the standard approximation."""
    total = sum(max(age, 1.0) ** -DECAY for age in ages_hours)
    if older_count > 0 and oldest_age is not None:
        total += older_count * max(oldest_age, 1.0) ** -DECAY
    if total <= 0:
        return -10.0
    return math.log(total)


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def usefulness(used: int, shown: int) -> float:
    """Laplace-smoothed ratio of shown results that were actually used. Neutral value 0.5."""
    return (used + 1) / (shown + 2)


@dataclass
class OwnerStats:
    activation: float = -10.0
    used: int = 0
    shown: int = 0
    injected: int = 0

    @property
    def activation_factor(self) -> float:
        return 0.5 + 0.5 * sigmoid(self.activation)

    @property
    def usefulness_factor(self) -> float:
        return 0.5 + usefulness(self.used, self.shown)

    @property
    def briefing_factor(self) -> float:
        """Injected at many session starts and never used: make room for something else."""
        return 0.5 + usefulness(self.used, self.injected)

    @property
    def worn_out(self) -> bool:
        return self.used == 0 and self.injected >= WORN_OUT


def owner_stats(
    conn: sqlite3.Connection, owners: list[tuple[str, int]], now: datetime | None = None
) -> dict[tuple[str, int], OwnerStats]:
    stats: dict[tuple[str, int], OwnerStats] = {owner: OwnerStats() for owner in owners}
    if not owners:
        return stats
    current = now or timeutil.now()
    for owner_type in {o[0] for o in owners}:
        ids = [o[1] for o in owners if o[0] == owner_type]
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT owner_id, kind, ts FROM accesses WHERE owner_type = ? AND owner_id IN ({placeholders}) "
            f"ORDER BY ts DESC",
            (owner_type, *ids),
        ).fetchall()
        ages: dict[int, list[float]] = {}
        older: dict[int, int] = {}
        for row in rows:
            key = (owner_type, int(row["owner_id"]))
            entry = stats[key]
            kind = row["kind"]
            if kind == "shown":
                entry.shown += 1
                continue
            if kind == "injected":
                entry.injected += 1
                continue
            if kind in USE_KINDS:
                entry.used += 1
            if kind in RETRIEVAL_KINDS:
                bucket = ages.setdefault(key[1], [])
                if len(bucket) < 20:
                    bucket.append(timeutil.hours_between(row["ts"], current))
                else:
                    older[key[1]] = older.get(key[1], 0) + 1
        for owner_id, bucket in ages.items():
            stats[(owner_type, owner_id)].activation = activation(
                bucket, older.get(owner_id, 0), max(bucket) if bucket else None
            )
    return stats


def record_access(
    conn: sqlite3.Connection,
    owners: Iterable[tuple[str, int]],
    kind: str,
    session_id: str | None = None,
    ts: str | None = None,
) -> None:
    stamp = ts or timeutil.iso()
    conn.executemany(
        "INSERT INTO accesses(owner_type, owner_id, ts, kind, session_id) VALUES (?, ?, ?, ?, ?)",
        [(owner_type, owner_id, stamp, kind, session_id) for owner_type, owner_id in owners],
    )


def seen(conn: sqlite3.Connection, owner: tuple[str, int], session_id: str | None, since: str, until: str) -> bool:
    """Whether a session saw ``owner`` before ``until``: injected into it, shown by its search or opened. MCP calls
    carry no session, so one from ``since`` (the turn's start) on counts too. An id the session never saw is an
    example in code or a test (`mem_get(["T42"])`), not a citation: 49 of 69 "cited" were such ids, and one turn
    with six of them ranked first for unrelated questions."""
    return (
        conn.execute(
            "SELECT 1 FROM accesses WHERE owner_type = ? AND owner_id = ? AND kind IN ('shown', 'injected', 'get') "
            "AND ts <= ? AND (session_id = ? OR (session_id IS NULL AND ts >= ?)) LIMIT 1",
            (owner[0], owner[1], until, session_id, since),
        ).fetchone()
        is not None
    )


def drop_unseen_citations(conn: sqlite3.Connection, since: str) -> int:
    """Once per database: citations recorded before :func:`seen` was checked lose those the session never saw.
    Only from ``since`` on, where the exposures are still kept; older ones cannot be judged."""
    if db.get_meta(conn, "unseen_citations_dropped"):
        return 0
    rows = conn.execute(
        "SELECT a.id, a.owner_type, a.owner_id, a.session_id, a.ts, (SELECT MAX(t.started_at) FROM turns t "
        "WHERE t.session_id = a.session_id AND t.started_at <= a.ts) FROM accesses a WHERE a.kind = 'cited' "
        "AND a.ts >= ?",
        (since,),
    ).fetchall()
    unseen = [(row[0],) for row in rows if not seen(conn, (row[1], int(row[2])), row[3], row[5] or row[4], row[4])]
    conn.executemany("DELETE FROM accesses WHERE id = ?", unseen)
    db.set_meta(conn, "unseen_citations_dropped", timeutil.iso())
    return len(unseen)


def hebbian_update(conn: sqlite3.Connection, entity_ids: list[int], ts: str | None = None) -> None:
    """Strengthen pairwise edges between entities that occurred together: w <- w + r(1 - w)."""
    unique = sorted(set(entity_ids))[:12]
    stamp = ts or timeutil.iso()
    pairs = [(a, b) for i, a in enumerate(unique) for b in unique[i + 1 :]]
    conn.executemany(
        "INSERT INTO edges(a, b, weight, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(a, b) DO UPDATE SET weight = weight + ? * (1 - weight), updated_at = excluded.updated_at",
        [(a, b, HEBB_RATE, stamp, HEBB_RATE) for a, b in pairs],
    )


def decay_edges(
    conn: sqlite3.Connection, days_elapsed: float, half_life_days: float = 60.0, floor: float = 0.05
) -> int:
    """Exponential decay for the time since the last decay run; prune weak edges. Returns pruned count."""
    if days_elapsed <= 0:
        return 0
    factor = math.pow(0.5, days_elapsed / half_life_days)
    conn.execute("UPDATE edges SET weight = weight * ?", (factor,))
    return conn.execute("DELETE FROM edges WHERE weight < ?", (floor,)).rowcount
