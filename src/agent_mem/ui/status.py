"""What `agent-mem status` and the viewer show: counts, connected agents, the fact model each one uses."""

from __future__ import annotations

import contextlib
import json
import re
import shutil
import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any

from agent_mem.core import db, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.core.harness import HARNESS_NAMES, HARNESSES, claude_home, codex_home, copilot_home, opencode_home
from agent_mem.memory import work

HARNESS_MARKERS = {
    "claude": [claude_home() / "plugins", claude_home() / "settings.json"],
    "codex": [codex_home() / "plugins", codex_home() / "hooks.json", codex_home() / "config.toml"],
    "copilot": [copilot_home() / "plugins", copilot_home() / "hooks"],
}


def _mentions(path: Path, needle: re.Pattern[str], max_files: int = 400) -> bool:
    if path.is_file():
        with contextlib.suppress(OSError):
            return bool(needle.search(path.read_text(encoding="utf-8", errors="ignore")))
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
            if candidate.stat().st_size < 1_000_000 and needle.search(
                candidate.read_text(encoding="utf-8", errors="ignore")
            ):
                return True
    return False


# On Windows the command is `...\agent-mem.exe hook claude`; a path with spaces is quoted ("…/agent-mem" hook).
_HOOK_COMMAND = re.compile(r"agent-mem(?:\.exe)?['\"]? hook")


def harness_installed(harness: str) -> bool:
    if harness == "opencode":  # read now: XDG_CONFIG_HOME moves its folder
        return _mentions(opencode_home(), re.compile("agent-mem"))
    return any(_mentions(path, _HOOK_COMMAND) for path in HARNESS_MARKERS[harness])


def fact_stage(conn: sqlite3.Connection, config: Config, harness: str) -> dict[str, Any]:
    """Which model turns from ``harness`` go to for facts now: the first stage not paused. Paused only when all are."""
    from agent_mem.observe import providers

    stages = dict(config.observe.stages_for(harness))
    running = next((name for name in providers.chain(config, harness, conn) if name in stages), None)
    name = running or next(iter(stages), None)
    return {
        "stage": name,
        "model": stages.get(name) if name else None,
        "paused_until": providers.resumes_at(config, harness, conn) if stages and not running else None,
        "enabled": config.observe.enabled,
    }


def agents(conn: sqlite3.Connection, config: Config) -> list[dict[str, Any]]:
    """One row per harness for the viewer: connected, CLI on PATH, fact model, today's fact runs."""

    today = timeutil.iso()[:10]
    calls: dict[str, tuple[int, int, str]] = {}
    with contextlib.suppress(sqlite3.OperationalError):  # observer tables come with migration 002
        for row in conn.execute(
            "SELECT provider, SUM(ok), SUM(NOT ok), MAX(ts) FROM observe_calls WHERE ts >= ? GROUP BY provider",
            (today,),
        ):
            calls[row[0]] = (int(row[1] or 0), int(row[2] or 0), row[3])
    rows = []
    for name in HARNESSES:
        stage = fact_stage(conn, config, name)
        ok, failed, last = calls.get(stage["stage"] or "", (0, 0, None))
        rows.append(
            {
                "harness": name,
                "label": HARNESS_NAMES[name],
                "cli": shutil.which(name) is not None,
                "connected": harness_installed(name),
                **stage,
                "facts_ok_today": ok,
                "facts_failed_today": failed,
                "last_fact_at": last,
            }
        )
    return rows


def quarantine_latest(config: Config) -> dict[str, Any] | None:
    """The newest record set aside, so the viewer can say what it was instead of only a count."""
    files = sorted(config.quarantine_dir.glob("*.json")) if config.quarantine_dir.exists() else []
    if not files:
        return None
    with contextlib.suppress(OSError, ValueError):
        record = json.loads(files[-1].read_text(encoding="utf-8"))
        event = record.get("event") if isinstance(record.get("event"), dict) else {}
        reason = record.get("reason") or (
            f"a saved {event.get('harness', '')} {event.get('kind', 'event')} could not be replayed" if event else ""
        )
        return {"ts": record.get("ts") or event.get("ts"), "reason": str(reason or record.get("type") or "")[:160]}
    return None


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
        "consolidated_at": db.get_meta(conn, "consolidated_at"),
        "components": harnesses,
        "config_warnings": config.warnings,
        "injected": _injected(conn),
    }


def _injected(conn: sqlite3.Connection, days: int = 7) -> dict[str, Any]:
    """Blocks and estimated tokens injected into sessions today and over the last ``days`` days, the measured agent
    work behind what they named, each memory once (memory/work.py), and all work the memory was built from."""
    today = timeutil.now()
    since = (today - timedelta(days=days - 1)).date().isoformat()
    blocks = total = today_tokens = today_work = 0
    for row in conn.execute(
        "SELECT key, value FROM meta WHERE key >= ? AND key LIKE 'injected:%'", (f"injected:{since}",)
    ):
        n, tokens, behind = [*(int(x) for x in row["value"].split(",")), 0][:3]  # older days have no work column
        blocks, total = blocks + n, total + tokens
        if row["key"] == f"injected:{today.date().isoformat()}":
            today_tokens, today_work = tokens, behind
    sessions = int(conn.execute("SELECT COUNT(*) FROM sessions WHERE started_at >= ?", (since,)).fetchone()[0])
    spent = work.reused(conn, since)
    turns, built = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(work_tokens), 0) FROM turns WHERE work_tokens IS NOT NULL"
    ).fetchone()
    return {
        "today_tokens": today_tokens,
        "today_work": today_work,
        "days": days,
        "blocks": blocks,
        "tokens": total,
        "tokens_per_session": round(total / sessions) if sessions else None,
        "work": spent,
        "saved_percent": (spent - total) * 100 // spent if spent > total else None,  # floor: 99.9 is not 100
        "measured_turns": int(turns),
        "built_from": int(built),
    }
