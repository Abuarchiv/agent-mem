"""Turn queue for the observer (docs/PLAN.md §4.2). Standard library only: ``capture`` enqueues on the hook path."""

from __future__ import annotations

import sqlite3
from datetime import timedelta

from .. import timeutil

BACKOFF = (timedelta(minutes=1), timedelta(minutes=5), timedelta(minutes=30), timedelta(hours=6))
MAX_ATTEMPTS = len(BACKOFF)


def enqueue(conn: sqlite3.Connection, turn_id: int, ts: str | None = None) -> None:
    now = ts or timeutil.iso()
    conn.execute(
        "INSERT OR IGNORE INTO observe_queue(turn_id, state, next_try, updated_at) VALUES (?, 'pending', ?, ?)",
        (turn_id, now, now),
    )


def expire_leases(conn: sqlite3.Connection) -> int:
    now = timeutil.iso()
    cursor = conn.execute(
        "UPDATE observe_queue SET state = 'pending', lease_until = NULL, updated_at = ? "
        "WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until < ?",
        (now, now),
    )
    return cursor.rowcount


def lease_bundle(conn: sqlite3.Connection, *, max_turns: int, lease_seconds: int) -> list[sqlite3.Row]:
    """Lease the oldest due turn plus following due turns of the same session (order kept)."""
    now = timeutil.now()
    first = conn.execute(
        "SELECT q.turn_id, t.session_id, t.project_id FROM observe_queue q JOIN turns t ON t.id = q.turn_id "
        "WHERE q.state = 'pending' AND q.next_try <= ? ORDER BY q.turn_id LIMIT 1",
        (timeutil.iso(now),),
    ).fetchone()
    if first is None:
        return []
    rows = conn.execute(
        "SELECT q.turn_id, t.session_id, t.project_id FROM observe_queue q JOIN turns t ON t.id = q.turn_id "
        "WHERE q.state = 'pending' AND q.next_try <= ? AND t.session_id = ? AND q.turn_id >= ? "
        "ORDER BY q.turn_id LIMIT ?",
        (timeutil.iso(now), first["session_id"], first["turn_id"], max_turns),
    ).fetchall()
    lease = timeutil.iso(now + timedelta(seconds=lease_seconds))
    for row in rows:
        conn.execute(
            "UPDATE observe_queue SET state = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ? "
            "WHERE turn_id = ?",
            (lease, timeutil.iso(now), row["turn_id"]),
        )
    return rows


def finish(conn: sqlite3.Connection, turn_ids: list[int], state: str, provider: str | None) -> None:
    now = timeutil.iso()
    for turn_id in turn_ids:
        conn.execute(
            "UPDATE observe_queue SET state = ?, provider = ?, lease_until = NULL, last_error = NULL, updated_at = ? "
            "WHERE turn_id = ?",
            (state, provider, now, turn_id),
        )


def fail(conn: sqlite3.Connection, turn_ids: list[int], error: str) -> None:
    """Back off 1 min, 5 min, 30 min, 6 h; after that the turn is ``failed`` until ``--retry-failed``."""
    now = timeutil.now()
    for turn_id in turn_ids:
        attempts = int(conn.execute("SELECT attempts FROM observe_queue WHERE turn_id = ?", (turn_id,)).fetchone()[0])
        if attempts > MAX_ATTEMPTS:
            state, next_try = "failed", timeutil.iso(now)
        else:
            state, next_try = "pending", timeutil.iso(now + BACKOFF[min(attempts, MAX_ATTEMPTS) - 1])
        conn.execute(
            "UPDATE observe_queue SET state = ?, next_try = ?, lease_until = NULL, last_error = ?, updated_at = ? "
            "WHERE turn_id = ?",
            (state, next_try, error[:300], timeutil.iso(now), turn_id),
        )


def retry_failed(conn: sqlite3.Connection) -> int:
    now = timeutil.iso()
    cursor = conn.execute(
        "UPDATE observe_queue SET state = 'pending', attempts = 0, next_try = ?, updated_at = ? WHERE state = 'failed'",
        (now, now),
    )
    return cursor.rowcount


def reprocess_raw(conn: sqlite3.Connection) -> int:
    now = timeutil.iso()
    cursor = conn.execute(
        "UPDATE observe_queue SET state = 'pending', attempts = 0, next_try = ?, updated_at = ? WHERE state = 'raw'",
        (now, now),
    )
    return cursor.rowcount


def pending_count(conn: sqlite3.Connection) -> int:
    return int(
        conn.execute(
            "SELECT COUNT(*) FROM observe_queue WHERE state = 'pending' AND next_try <= ?", (timeutil.iso(),)
        ).fetchone()[0]
    )


def status(conn: sqlite3.Connection) -> dict[str, object]:
    counts = {
        str(row[0]): int(row[1])
        for row in conn.execute("SELECT state, COUNT(*) FROM observe_queue GROUP BY state").fetchall()
    }
    errors = [
        dict(row)
        for row in conn.execute(
            "SELECT turn_id, state, attempts, provider, last_error, updated_at FROM observe_queue "
            "WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 5"
        ).fetchall()
    ]
    today = timeutil.iso()[:10]
    calls = [
        dict(row)
        for row in conn.execute(
            "SELECT provider, purpose, COUNT(*) AS n, SUM(ok) AS ok, ROUND(SUM(seconds), 1) AS seconds, "
            "SUM(prompt_chars) AS prompt_chars FROM observe_calls WHERE ts >= ? GROUP BY provider, purpose",
            (today,),
        ).fetchall()
    ]
    forget = int(conn.execute("SELECT COUNT(*) FROM observe_forget").fetchone()[0])
    return {"queue": counts, "recent_errors": errors, "calls_today": calls, "forget_pending": forget}
