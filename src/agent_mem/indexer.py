"""Background indexer, started detached by hooks (one instance at a time).

Order of work: integrity check, spool replay, stale turns, embeddings, federation,
consolidation, optional summaries, retention, backups, housekeeping.
"""

from __future__ import annotations

import contextlib
import os
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from . import capture, consolidate, db, federate, logutil, spool, summarize, timeutil
from .config import Config
from .events import Event, PayloadError


def _apply_record(conn: sqlite3.Connection, config: Config, record: dict[str, Any]) -> None:
    if record.get("type") != "event" or not isinstance(record.get("event"), dict):
        raise spool.PermanentError("unknown spool record")
    try:
        event = Event.from_dict(record["event"])
    except (PayloadError, TypeError) as error:
        raise spool.PermanentError(str(error)) from error
    try:
        capture.apply(conn, config, event, with_context=False)
    except sqlite3.OperationalError:
        raise  # transient (locked); retry next run
    except Exception as error:
        raise spool.PermanentError(f"{type(error).__name__}: {error}") from error


def recover_if_corrupt(config: Config) -> bool:
    """Returns True if a corrupt database was replaced by the latest backup."""
    if not config.db_path.exists():
        return False
    try:
        probe = sqlite3.connect(config.db_path)
        ok = probe.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        probe.close()
    except sqlite3.DatabaseError:
        ok = False
    if ok:
        return False
    stamp = timeutil.iso().replace(":", "")
    with contextlib.suppress(OSError):
        os.replace(config.db_path, Path(f"{config.db_path}.corrupt-{stamp}"))
    for suffix in ("-wal", "-shm"):
        with contextlib.suppress(OSError):
            Path(f"{config.db_path}{suffix}").unlink()
    backup = db.latest_backup(config)
    if backup is not None:
        db.restore(config, backup)
    logutil.write(config.log_dir, "indexer", event="recovered_corrupt_db", backup=str(backup or "none"))
    return True


def retention(conn: sqlite3.Connection, config: Config) -> dict[str, int]:
    from datetime import timedelta

    now = timeutil.now()
    payload_cutoff = timeutil.iso(now - timedelta(days=config.retention.payload_days))
    access_cutoff = timeutil.iso(now - timedelta(days=config.retention.access_days))
    with db.transaction(conn):
        trimmed = conn.execute(
            "UPDATE events SET payload = json_object('raw_kind', json_extract(payload, '$.raw_kind'), "
            "'category', json_extract(payload, '$.category'), 'error_line', json_extract(payload, '$.error_line'), "
            "'trust', json_extract(payload, '$.trust')), trimmed = 1 WHERE trimmed = 0 AND ts < ?",
            (payload_cutoff,),
        ).rowcount
        accesses = conn.execute(
            "DELETE FROM accesses WHERE kind IN ('shown', 'warned') AND ts < ?", (access_cutoff,)
        ).rowcount
    size_mb = config.db_path.stat().st_size / 1_000_000 if config.db_path.exists() else 0
    if size_mb > config.retention.max_db_mb:
        with db.transaction(conn):
            conn.execute(
                "UPDATE events SET payload = json_object('raw_kind', json_extract(payload, '$.raw_kind'), "
                "'category', json_extract(payload, '$.category'), 'error_line', json_extract(payload, '$.error_line'), "
                "'trust', json_extract(payload, '$.trust')), trimmed = 1 WHERE trimmed = 0 AND id IN "
                "(SELECT id FROM events WHERE trimmed = 0 ORDER BY ts LIMIT 5000)"
            )
        conn.execute("VACUUM")
    return {"payloads_trimmed": trimmed, "accesses_deleted": accesses}


def run(config: Config, *, force_consolidate: bool = False, allow_download: bool = True) -> dict[str, Any]:
    db.ensure_private_dir(config.data_dir)
    lock = FileLock(str(config.lock_path), timeout=0)
    try:
        lock.acquire()
    except Timeout:
        return {"skipped": "another indexer is running"}
    stats: dict[str, Any] = {}
    try:
        stats["recovered"] = recover_if_corrupt(config)
        conn = db.connect(config, busy_timeout_ms=5000)
        try:
            stats.update(_work(conn, config, force_consolidate, allow_download))
            with db.transaction(conn):
                db.record_health(conn, "indexer")
        except Exception as error:
            with contextlib.suppress(sqlite3.Error), db.transaction(conn):
                db.record_health(conn, "indexer", f"{type(error).__name__}: {error}")
            logutil.write(config.log_dir, "indexer", error=type(error).__name__, detail=str(error)[:200])
            raise
        finally:
            conn.close()
    finally:
        lock.release()
    return stats


def _work(conn: sqlite3.Connection, config: Config, force_consolidate: bool, allow_download: bool) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    applied, quarantined = spool.drain(
        config.spool_dir, config.quarantine_dir, lambda record: _apply_record(conn, config, record)
    )
    stats["spool_applied"], stats["spool_quarantined"] = applied, quarantined
    stats["stale_turns_closed"] = capture.close_stale_turns(conn, config)

    embedder = None
    if config.semantic.enabled:
        from . import semantic

        embedder = semantic.load_embedder(config, allow_download=allow_download)
        with db.transaction(conn):
            db.set_meta(conn, "semantic", embedder.model if embedder else "unavailable")
            if embedder is None:
                db.record_health(conn, "semantic", "embedding model unavailable (lexical search only)")
            else:
                db.record_health(conn, "semantic")
        if embedder is not None:
            stats["embedded"] = semantic.embed_pending(conn, embedder)

    stats["federated"] = federate.run(conn, config)

    if force_consolidate or consolidate.due(conn, config):
        since = db.get_meta(conn, "consolidated_at")
        linker: Callable[[sqlite3.Connection], int] | None = None
        if embedder is not None:
            model = embedder.model

            def link(c: sqlite3.Connection) -> int:
                return consolidate.link_neighbours(c, model, since)

            linker = link

        stats["consolidation"] = consolidate.run(conn, config, linker)

    stats["summarized"] = summarize.summarize_pending(conn, config)
    stats["retention"] = retention(conn, config)

    if db.get_meta(conn, "backups_dirty") == "1":
        db.rebuild_backups(conn, config)
        with db.transaction(conn):
            db.set_meta(conn, "backups_dirty", "0")
            db.set_meta(conn, "last_backup_at", timeutil.iso())
    last_backup = db.get_meta(conn, "last_backup_at")
    if last_backup is None or timeutil.hours_between(last_backup) >= config.retention.backup_every_hours:
        db.backup(conn, config)
        db.prune_backups(config, config.retention.backup_keep)
        with db.transaction(conn):
            db.set_meta(conn, "last_backup_at", timeutil.iso())
        stats["backup"] = True

    conn.execute("PRAGMA optimize")
    with contextlib.suppress(sqlite3.OperationalError):
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
    return stats
