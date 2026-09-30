"""``agent-mem status`` and ``agent-mem doctor``."""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sqlite3
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db, spool, timeutil
from .config import Config
from .federate import claude_home, codex_home

HARNESS_MARKERS = {
    "claude": [claude_home() / "plugins", claude_home() / "settings.json"],
    "codex": [codex_home() / "plugins", codex_home() / "hooks.json", codex_home() / "config.toml"],
    "copilot": [Path.home() / ".copilot" / "plugins", Path.home() / ".copilot" / "hooks"],
    "opencode": [Path.home() / ".config" / "opencode"],
}


@dataclass
class Check:
    name: str
    ok: bool
    detail: str
    fix: str | None = None
    warn_only: bool = False


def _mentions(path: Path, needle: str, max_files: int = 400) -> bool:
    if path.is_file():
        with contextlib.suppress(OSError):
            return needle in path.read_text(encoding="utf-8", errors="ignore")
        return False
    if not path.is_dir():
        return False
    count = 0
    for candidate in path.rglob("*"):
        if candidate.suffix.lower() not in {".json", ".toml", ".ts", ".js", ".jsonc"} or not candidate.is_file():
            continue
        count += 1
        if count > max_files:
            break
        with contextlib.suppress(OSError):
            if candidate.stat().st_size < 1_000_000 and needle in candidate.read_text(
                encoding="utf-8", errors="ignore"
            ):
                return True
    return False


def harness_installed(harness: str) -> bool:
    needle = "agent-mem hook" if harness != "opencode" else "agent-mem"
    return any(_mentions(path, needle) for path in HARNESS_MARKERS[harness])


def status(conn: sqlite3.Connection, config: Config) -> dict[str, Any]:
    def count(sql: str) -> int:
        return int(conn.execute(sql).fetchone()[0])

    harnesses = {}
    for row in conn.execute(
        "SELECT component, last_ok_at, last_error_at, last_error, ok_count, error_count FROM health"
    ):
        harnesses[row["component"]] = {k: v for k, v in dict(row).items() if k != "component"}
    recurrences = count("SELECT COALESCE(SUM(recurrences), 0) FROM recipes")
    fixes = count("SELECT COALESCE(SUM(successes), 0) FROM recipes")
    return {
        "data_dir": str(config.data_dir),
        "db_mb": round(config.db_path.stat().st_size / 1_000_000, 2) if config.db_path.exists() else 0,
        "schema": db.user_version(conn),
        "projects": count("SELECT COUNT(*) FROM projects"),
        "sessions": count("SELECT COUNT(*) FROM sessions"),
        "turns": count("SELECT COUNT(*) FROM turns"),
        "memories": count("SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL"),
        "vectors": count("SELECT COUNT(*) FROM vectors"),
        "recipes": count("SELECT COUNT(*) FROM recipes"),
        "rules_enabled": count("SELECT COUNT(*) FROM rules WHERE enabled = 1"),
        "rules_proposed": count("SELECT COUNT(*) FROM rules WHERE enabled = 0"),
        "learning": {
            "errors_fixed": fixes,
            "known_errors_recurred": recurrences,
            "repetition_rate": round(recurrences / (recurrences + fixes), 3) if recurrences + fixes else None,
        },
        "semantic": db.get_meta(conn, "semantic") or "not indexed yet",
        "paused_until": db.get_meta(conn, "paused_until"),
        "spool": spool.count(config.spool_dir),
        "quarantine": len(list(config.quarantine_dir.glob("*.json"))) if config.quarantine_dir.exists() else 0,
        "last_backup_at": db.get_meta(conn, "last_backup_at"),
        "consolidated_at": db.get_meta(conn, "consolidated_at"),
        "components": harnesses,
        "config_warnings": config.warnings,
    }


def doctor(config: Config, *, fix: bool = False) -> list[Check]:
    checks: list[Check] = []
    checks.append(
        Check(
            "python",
            sys.version_info >= (3, 11),
            sys.version.split()[0],
            "Install Python 3.11+ (uv installs it for you).",
        )
    )
    on_path = shutil.which("agent-mem")
    checks.append(
        Check(
            "agent-mem on PATH",
            on_path is not None,
            on_path or "not found",
            'Install with the install script or `uv tool install "agent-mem[semantic] @ git+https://github.com/Abuarchiv/agent-mem"` so hooks can call it.',
        )
    )
    db.ensure_private_dir(config.data_dir)
    if fix and sys.platform != "win32":
        for folder in (config.data_dir, config.spool_dir, config.backup_dir, config.log_dir):
            if folder.exists():
                with contextlib.suppress(OSError):
                    os.chmod(folder, 0o700)
    if sys.platform != "win32":
        mode = stat.S_IMODE(config.data_dir.stat().st_mode)
        checks.append(
            Check(
                "data dir private",
                mode & 0o077 == 0,
                f"{config.data_dir} ({oct(mode)})",
                "Run `agent-mem doctor --fix` or chmod 700 the data directory.",
            )
        )
    free_mb = shutil.disk_usage(config.data_dir).free / 1_000_000
    checks.append(Check("disk space", free_mb > 200, f"{free_mb:.0f} MB free", "Free disk space."))
    for warning in config.warnings:
        checks.append(Check("config", False, warning, f"Edit {config.config_path}.", warn_only=True))
    try:
        conn = db.connect(config)
    except db.SchemaTooNewError as error:
        checks.append(Check("database", False, str(error), "Upgrade agent-mem (`uv tool upgrade agent-mem`)."))
        return checks
    except db.MigrationInProgressError as error:
        checks.append(Check("database", False, f"migration in progress: {error}", "Run `agent-mem doctor` again."))
        return checks
    except sqlite3.Error as error:
        checks.append(Check("database", False, str(error), "Run `agent-mem restore --latest`."))
        return checks
    try:
        ok = db.quick_check(conn)
        checks.append(
            Check(
                "database integrity",
                ok,
                f"schema v{db.user_version(conn)}, sqlite {sqlite3.sqlite_version}",
                "Run `agent-mem restore --latest`.",
            )
        )
        try:
            conn.execute("SELECT count(*) FROM search_fts").fetchone()
            checks.append(Check("full-text search (FTS5 trigram)", True, "available"))
        except sqlite3.Error as error:
            checks.append(
                Check("full-text search (FTS5 trigram)", False, str(error), "Use a Python with SQLite ≥ 3.34.")
            )
        from . import semantic

        embedder, reason = semantic.load_embedder_verbose(config)
        checks.append(
            Check(
                "semantic search",
                embedder is not None,
                f"model {embedder.model} ready" if embedder else str(reason),
                "Run `agent-mem models install`. Lexical search works without it.",
                warn_only=True,
            )
        )
        for harness in ("claude", "codex", "copilot", "opencode"):
            installed_here = harness_installed(harness)
            row = conn.execute("SELECT * FROM health WHERE component = ?", (f"hook:{harness}",)).fetchone()
            if not installed_here and row is None:
                continue
            if row is None:
                hint = (
                    "Start a session. For Codex, trust the hooks with /hooks."
                    if harness == "codex"
                    else "Start a session in this harness."
                )
                checks.append(
                    Check(f"{harness} capture", False, "plugin found, nothing captured yet", hint, warn_only=True)
                )
                continue
            failing = row["last_error_at"] and (not row["last_ok_at"] or row["last_error_at"] > row["last_ok_at"])
            checks.append(
                Check(
                    f"{harness} capture",
                    not failing,
                    f"last ok {row['last_ok_at'] or 'never'}; errors {row['error_count']}"
                    + (f" (last: {row['last_error']})" if failing else ""),
                    "See logs in the data dir (logs/hook.log).",
                )
            )
        backlog = spool.count(config.spool_dir)
        checks.append(
            Check(
                "spool",
                backlog == 0,
                f"{backlog} pending",
                "Run `agent-mem index` (or doctor --fix).",
                warn_only=backlog < 1000,
            )
        )
        last_backup = db.get_meta(conn, "last_backup_at")
        fresh = last_backup is not None and timeutil.hours_between(last_backup) < 72
        checks.append(
            Check("backup", fresh, f"last {last_backup or 'never'}", "Run `agent-mem backup`.", warn_only=True)
        )
        indexer = conn.execute("SELECT last_ok_at, last_error FROM health WHERE component = 'indexer'").fetchone()
        checks.append(
            Check(
                "indexer",
                indexer is not None and indexer["last_ok_at"] is not None,
                f"last run {indexer['last_ok_at'] if indexer else 'never'}",
                "Run `agent-mem index`.",
                warn_only=True,
            )
        )
    finally:
        conn.close()
    if fix:
        from . import indexer

        with contextlib.suppress(Exception):
            indexer.run(config, allow_download=False)
    return checks


def format_checks(checks: list[Check]) -> str:
    lines = []
    for check in checks:
        mark = "✓" if check.ok else ("!" if check.warn_only else "✗")
        line = f"{mark} {check.name}: {check.detail}"
        if not check.ok and check.fix:
            line += f"\n    → {check.fix}"
        lines.append(line)
    return "\n".join(lines)


def to_json(checks: list[Check]) -> str:
    return json.dumps([check.__dict__ for check in checks], indent=2)
