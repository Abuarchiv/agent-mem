"""Write-behind spool: events that cannot reach the database right now.

Each event is one small JSON file written atomically (temp file + rename). The
indexer replays them in order; replay is idempotent because every event has a
unique dedupe key. Standard library only.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import secrets
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent_mem.core.db import ensure_private_dir


class PermanentError(Exception):
    """The record can never be applied (e.g. a bug or an unsupported shape): quarantine it."""


def session_tag(harness: str, session_id: str) -> str:
    return hashlib.sha256(f"{harness}:{session_id}".encode("utf-8", "replace")).hexdigest()[:12]


def write(spool_dir: Path, record: dict[str, Any], session: str = "") -> Path:
    """``session`` (``session_tag``) goes into the name, so a hook can see that its session waits in the spool."""
    ensure_private_dir(spool_dir)
    name = f"{time.time_ns():020d}-{os.getpid()}-{session or 'x'}-{secrets.token_hex(4)}.json"
    target = spool_dir / name
    temp = spool_dir / f".{name}.tmp"
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False)
        handle.flush()
        with contextlib.suppress(OSError):
            os.fsync(handle.fileno())
    os.replace(temp, target)
    return target


def holds_session(spool_dir: Path, session: str) -> bool:
    """True while an earlier event of this session waits in the spool. Usually the directory is empty."""
    try:
        return any(f"-{session}-" in name for name in os.listdir(spool_dir) if name.endswith(".json"))
    except OSError:
        return False


def oldest_age(spool_dir: Path) -> float:
    """Seconds since the oldest waiting event was spooled (its name starts with time_ns), 0 when none waits."""
    try:
        names = [name for name in os.listdir(spool_dir) if name.endswith(".json") and not name.startswith(".")]
    except OSError:
        return 0.0
    if not names:
        return 0.0
    try:
        return max(0.0, time.time() - int(min(names).split("-", 1)[0]) / 1e9)
    except ValueError:
        return 0.0


def pending(spool_dir: Path) -> list[Path]:
    if not spool_dir.exists():
        return []
    return sorted(p for p in spool_dir.glob("*.json") if not p.name.startswith("."))


def count(spool_dir: Path) -> int:
    return len(pending(spool_dir))


def drain(
    spool_dir: Path,
    quarantine_dir: Path,
    apply: Callable[[dict[str, Any]], None],
    *,
    limit: int = 5_000,
) -> tuple[int, int]:
    """Replay spooled records. Returns (applied, quarantined). Stops at the first transient error."""
    applied = quarantined = 0
    for path in pending(spool_dir)[:limit]:
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                raise ValueError("spool record is not an object")
        except (OSError, ValueError):
            _quarantine(path, quarantine_dir)
            quarantined += 1
            continue
        try:
            apply(record)  # transient errors propagate; the file stays for the next run
        except PermanentError:
            _quarantine(path, quarantine_dir)
            quarantined += 1
            continue
        with contextlib.suppress(OSError):
            path.unlink()
        applied += 1
    return applied, quarantined


def _quarantine(path: Path, quarantine_dir: Path) -> None:
    ensure_private_dir(quarantine_dir)
    with contextlib.suppress(OSError):
        os.replace(path, quarantine_dir / path.name)


def quarantine_record(quarantine_dir: Path, record: dict[str, Any]) -> None:
    write(quarantine_dir, record)


def purge_matching(spool_dir: Path, predicate: Callable[[dict[str, Any]], bool]) -> int:
    removed = 0
    for path in pending(spool_dir):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and predicate(record):
            with contextlib.suppress(OSError):
                path.unlink()
                removed += 1
    return removed
