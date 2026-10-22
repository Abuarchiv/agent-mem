"""Background indexer, started detached by hooks (one instance at a time).

Order of work: integrity check, spool replay, stale turns, embeddings,
consolidation, optional summaries, retention, housekeeping.
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from agent_mem.core import db, identity, logutil, paths, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.core.events import Event, PayloadError
from agent_mem.hooks import capture
from agent_mem.memory import consolidate, notes, store, work


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
    """Returns True if a corrupt database was moved aside; the next connection starts a fresh one."""
    if not config.db_path.exists():
        return False
    # Read-only: a writable connection checkpoints and deletes the WAL when it closes, even on a damaged database.
    probe = sqlite3.connect(f"{config.db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        ok = probe.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    except sqlite3.OperationalError:
        # Locked or busy (a migration, a VACUUM, a long write) is not damage. Moving the database aside would
        # throw away everything in it; look again next run.
        return False
    except sqlite3.DatabaseError:
        ok = False
    finally:
        probe.close()  # an open handle would block the rename on Windows
    if ok:
        return False
    stamp = timeutil.iso().replace(":", "")
    # The WAL holds committed writes: keep it next to the damaged copy for a manual rescue, never delete it.
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            os.replace(Path(f"{config.db_path}{suffix}"), Path(f"{config.db_path}.corrupt-{stamp}{suffix}"))
    logutil.write(config.log_dir, "indexer", event="recovered_corrupt_db", kept=f"{config.db_path}.corrupt-{stamp}")
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
        # Exposures only: created, get, used and cited feed activation and stay. "injected" adds about twenty rows per
        # session start.
        accesses = conn.execute(
            "DELETE FROM accesses WHERE kind IN ('shown', 'warned', 'injected') AND ts < ?", (access_cutoff,)
        ).rowcount
        # The model-call log only serves today's budget and recent errors.
        calls = conn.execute("DELETE FROM observe_calls WHERE ts < ?", (access_cutoff,)).rowcount
    size_mb = config.db_path.stat().st_size / 1_000_000 if config.db_path.exists() else 0
    last_vacuum = db.get_meta(conn, "vacuumed_at")
    # Above the limit the database may stay large, so VACUUM, which locks every hook out, runs once a day at most and
    # only after trimming freed something.
    if size_mb > config.retention.max_db_mb and (last_vacuum is None or timeutil.hours_between(last_vacuum) >= 24):
        with db.transaction(conn):
            freed = conn.execute(
                "UPDATE events SET payload = json_object('raw_kind', json_extract(payload, '$.raw_kind'), "
                "'category', json_extract(payload, '$.category'), 'error_line', json_extract(payload, '$.error_line'), "
                "'trust', json_extract(payload, '$.trust')), trimmed = 1 WHERE trimmed = 0 AND id IN "
                "(SELECT id FROM events WHERE trimmed = 0 ORDER BY ts LIMIT 5000)"
            ).rowcount
        if freed:
            conn.execute("VACUUM")
        with db.transaction(conn):
            db.set_meta(conn, "vacuumed_at", timeutil.iso())
    # Quarantined events hold full payloads (privacy); kept as long as payloads are, for `doctor` to show.
    quarantined = 0
    if config.quarantine_dir.exists():
        horizon = time.time() - config.retention.payload_days * 86400
        for path in config.quarantine_dir.glob("*.json"):
            with contextlib.suppress(OSError):
                if path.stat().st_mtime < horizon:
                    path.unlink()
                    quarantined += 1
    return {
        "payloads_trimmed": trimmed,
        "accesses_deleted": accesses,
        "calls_deleted": calls,
        "quarantine_deleted": quarantined,
    }


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
        except sqlite3.OperationalError as error:
            if "locked" not in str(error) and "busy" not in str(error):
                raise
            # Another process held the database longer than the busy timeout: not a failure to report; the spool
            # stays and the next run replays it.
            logutil.write(config.log_dir, "indexer", error="busy", detail=str(error)[:200])
            stats["skipped"] = "database busy"
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


def _mark_guards(conn: sqlite3.Connection, config: Config) -> None:
    """What the pre-tool hook can check, so it skips the rest (``core/paths.pre_tool_has_nothing_to_check``)."""
    rules = conn.execute("SELECT EXISTS (SELECT 1 FROM rules)").fetchone()[0]
    files = [
        str(row[0])
        for row in conn.execute(
            "SELECT DISTINCT e.key FROM entities e JOIN links l ON l.entity_id = e.id AND l.owner_type = 'm' "
            "JOIN memories m ON m.id = l.owner_id WHERE e.kind = 'file' AND m.invalid_at IS NULL "
            "AND m.kind IN ('dead_end', 'decision', 'lesson', 'fact')"
        )
    ]
    target = config.data_dir / paths.GUARDS
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    with contextlib.suppress(OSError):
        temporary.write_text(json.dumps({"rules": bool(rules), "files": files}), encoding="utf-8")
        os.replace(temporary, target)


def _work(conn: sqlite3.Connection, config: Config, force_consolidate: bool, allow_download: bool) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    stats["spool_applied"], stats["spool_quarantined"] = _drain_spool(conn, config)
    stats["stale_turns_closed"] = capture.close_stale_turns(conn, config)
    stats["work_measured"] = work.measure(conn)
    stats["native_notes"] = notes.ingest(conn, config)
    with db.transaction(conn):
        stats["retired_unindexed"] = store.drop_retired_keys(conn)
        stats["commits_backfilled"] = store.backfill_commits(conn)
        stats["defines_backfilled"] = store.backfill_defines(conn)
        stats["observer_facts_cleaned"] = store.clean_observer_facts(conn)
    # Outside the transaction: it runs git (about 25 ms per repository), and hooks wait 150 ms for the write lock.
    stats["identity_aliases"] = identity.record_aliases(conn)
    _mark_guards(conn, config)

    embedder = _semantic(conn, config, allow_download, stats)
    if force_consolidate or consolidate.due(conn, config):
        stats["consolidation"] = consolidate.run(conn, config, _neighbour_linker(conn, embedder))
    stats["retention"] = retention(conn, config)

    # Events spooled while this run worked (embeddings, consolidation) would wait for the next run, and
    # every later event of their session queues behind them (hooks.hook): replay them before leaving.
    for _ in range(5):
        if not spool.count(config.spool_dir):
            break
        applied, quarantined = _drain_spool(conn, config)
        stats["spool_applied"] += applied
        stats["spool_quarantined"] += quarantined

    if stats["spool_applied"] or stats["stale_turns_closed"]:
        _start_observer_if_pending(conn, config)

    conn.execute("PRAGMA optimize")
    with contextlib.suppress(sqlite3.OperationalError):
        conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
    return stats


def _drain_spool(conn: sqlite3.Connection, config: Config) -> tuple[int, int]:
    return spool.drain(config.spool_dir, config.quarantine_dir, lambda record: _apply_record(conn, config, record))


def _semantic(conn: sqlite3.Connection, config: Config, allow_download: bool, stats: dict[str, Any]) -> Any:
    """Load the embedder, record whether it works, embed what is new and merge duplicate facts. Returns it or None."""
    if not config.semantic.enabled:
        return None
    from agent_mem.memory import semantic

    embedder = semantic.load_embedder(config, allow_download=allow_download)
    previous = db.get_meta(conn, "semantic")
    with db.transaction(conn):
        db.set_meta(conn, "semantic", embedder.model if embedder else "unavailable")
        if embedder is not None:
            db.record_health(conn, "semantic")
        elif semantic.model_cached(config):
            # The model is present but failed to load: a real problem worth reporting.
            db.record_health(conn, "semantic", "embedding model failed to load (lexical search only)")
    if embedder is not None:
        # A new embedder (upgrade) re-embeds everything in one run; vectors are upserted per owner.
        limit = 100_000 if previous not in (None, "unavailable", embedder.model) else 512
        stats["embedded"] = semantic.embed_pending(conn, embedder, limit=limit)
        stats["duplicates_retired"] = semantic.merge_duplicates(conn, config, embedder.model)
    return embedder


def _neighbour_linker(conn: sqlite3.Connection, embedder: Any) -> Callable[[sqlite3.Connection], int] | None:
    """Consolidation links memories to their nearest neighbours since the last run, when vectors exist."""
    if embedder is None:
        return None
    model, since = embedder.model, db.get_meta(conn, "consolidated_at")
    return lambda c: consolidate.link_neighbours(c, model, since)


def _start_observer_if_pending(conn: sqlite3.Connection, config: Config) -> None:
    # Turns closed here (a replayed Stop, a stale turn) had no live Stop hook to start the fact worker; under load
    # most Stops wait in the spool.
    from agent_mem.hooks import hook

    if conn.execute("SELECT 1 FROM observe_queue WHERE state = 'pending' LIMIT 1").fetchone():
        hook.spawn_observer(config)
