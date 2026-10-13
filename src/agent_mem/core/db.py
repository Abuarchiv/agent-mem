"""SQLite access: connection setup, migrations and integrity checks.

Standard library only (hook path).
"""

from __future__ import annotations

import contextlib
import os
import re
import sqlite3
import sys
from collections.abc import Iterator
from pathlib import Path

from agent_mem.core import timeutil
from agent_mem.core.config import Config

BUSY_TIMEOUT_MS = 150


class SchemaTooNewError(RuntimeError):
    """The database was written by a newer Agent Mem version."""


class MigrationInProgressError(RuntimeError):
    """Another process is migrating the database."""


class MigrationPendingError(RuntimeError):
    """The database needs a migration that is too slow for the hook path."""


def _migrations() -> list[tuple[int, str]]:
    # Plain file reads: importlib.resources alone cost every hook call 11 ms (it pulls in inspect and tempfile).
    found: list[tuple[int, str]] = []
    for entry in (Path(__file__).resolve().parent / "schema").iterdir():
        name = entry.name
        if name.endswith(".sql") and name[:3].isdigit():
            found.append((int(name[:3]), entry.read_text(encoding="utf-8")))
    return sorted(found)


MIGRATIONS = _migrations()
SCHEMA_VERSION = MIGRATIONS[-1][0] if MIGRATIONS else 0


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        with contextlib.suppress(OSError):
            os.chmod(path, 0o700)


def _private_file(path: Path) -> None:
    if sys.platform != "win32" and path.exists():
        with contextlib.suppress(OSError):
            os.chmod(path, 0o600)


WAL_LIMIT_BYTES = 4 * 1024 * 1024


def connect(
    config: Config, *, busy_timeout_ms: int = BUSY_TIMEOUT_MS, migrate: bool = True, fresh_only: bool = False
) -> sqlite3.Connection:
    """Open the database. ``fresh_only`` (hook path) creates a new schema but refuses to migrate an
    existing database, because migrating a large file would outlast the deadline."""
    ensure_private_dir(config.data_dir)
    conn = sqlite3.connect(
        config.db_path, timeout=busy_timeout_ms / 1000, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {int(busy_timeout_ms)}")
    conn.execute("PRAGMA foreign_keys = ON")
    mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    if str(mode).lower() != "wal":
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # The WAL keeps its peak size (a VACUUM writes the whole database into it) unless a limit truncates it.
    conn.execute(f"PRAGMA journal_size_limit = {WAL_LIMIT_BYTES}")
    _private_file(config.db_path)
    if migrate:
        current = user_version(conn)
        if fresh_only and 0 < current < SCHEMA_VERSION:
            conn.close()
            raise MigrationPendingError(f"database schema {current} needs migration to {SCHEMA_VERSION}")
        migrate_database(conn)
    return conn


def user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def migrate_database(conn: sqlite3.Connection) -> None:
    current = user_version(conn)
    if current == SCHEMA_VERSION:
        return
    if current > SCHEMA_VERSION:
        raise SchemaTooNewError(f"database schema {current} is newer than supported {SCHEMA_VERSION}")
    try:
        conn.execute("BEGIN EXCLUSIVE")
    except sqlite3.OperationalError as error:
        raise MigrationInProgressError(str(error)) from error
    try:
        current = user_version(conn)  # re-check inside the lock
        for version, sql in MIGRATIONS:
            if version <= current:
                continue
            for statement in _split_sql(sql):
                if not _adds_existing_column(conn, statement):
                    conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {version}")
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


_ADD_COLUMN = re.compile(r"\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)", re.IGNORECASE)


def _adds_existing_column(conn: sqlite3.Connection, statement: str) -> bool:
    """``ADD COLUMN`` has no ``IF NOT EXISTS``: a database that already has the column (a schema number rewound by
    hand or by a test) skips the statement instead of failing the whole migration."""
    match = _ADD_COLUMN.match(statement)
    return bool(match) and match[2] in {row[1] for row in conn.execute(f"PRAGMA table_info({match[1]})")}


def _split_sql(sql: str) -> list[str]:
    statements: list[str] = []
    buffer: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("--"):
            continue
        buffer.append(line)
        candidate = "\n".join(buffer)
        if stripped.endswith(";") and sqlite3.complete_statement(candidate):
            statements.append(candidate)
            buffer = []
    if buffer:
        statements.append("\n".join(buffer))
    return statements


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection, *, immediate: bool = True) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def quick_check(conn: sqlite3.Connection) -> bool:
    try:
        return conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    except sqlite3.DatabaseError:
        return False


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else str(row[0])


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def record_health(conn: sqlite3.Connection, component: str, error: str | None = None) -> None:
    now = timeutil.iso()
    if error is None:
        conn.execute(
            "INSERT INTO health(component, last_ok_at, ok_count) VALUES (?, ?, 1) "
            "ON CONFLICT(component) DO UPDATE SET last_ok_at = excluded.last_ok_at, ok_count = ok_count + 1",
            (component, now),
        )
    else:
        conn.execute(
            "INSERT INTO health(component, last_error_at, last_error, error_count) VALUES (?, ?, ?, 1) "
            "ON CONFLICT(component) DO UPDATE SET last_error_at = excluded.last_error_at, "
            "last_error = excluded.last_error, error_count = error_count + 1",
            (component, now, error[:500]),
        )
