"""Learning signals: ACT-R activation, usefulness from implicit feedback, Hebbian edges.

Pure functions plus small SQL helpers. Standard library only.
"""

from __future__ import annotations

import math
import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from . import timeutil

DECAY = 0.5
RETRIEVAL_KINDS = ("created", "injected", "get", "used", "cited")
USE_KINDS = ("get", "used", "cited")
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

    @property
    def activation_factor(self) -> float:
        return 0.5 + 0.5 * sigmoid(self.activation)

    @property
    def usefulness_factor(self) -> float:
        return 0.5 + usefulness(self.used, self.shown)


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
