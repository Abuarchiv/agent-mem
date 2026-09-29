import json
import os
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from agent_mem import capture, db, hook, indexer, spool
from agent_mem.config import Config


def _prompt_payload(project: Path, session: str, text: str) -> str:
    return json.dumps(
        {"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(project), "prompt": text}
    )


def test_hook_run_end_to_end(config: Config, project: Path, conn):
    start = json.dumps({"hook_event_name": "SessionStart", "session_id": "s", "cwd": str(project), "source": "startup"})
    assert hook.run("claude", None, start, config) == ""  # nothing to inject yet
    hook.run("claude", None, _prompt_payload(project, "s", "Build the parser for invoices"), config)
    hook.run(
        "claude",
        None,
        json.dumps(
            {
                "hook_event_name": "Stop",
                "session_id": "s",
                "cwd": str(project),
                "last_assistant_message": "Parser in invoices/parse.py done.",
            }
        ),
        config,
    )
    output = hook.run(
        "codex",
        None,
        json.dumps({"hook_event_name": "SessionStart", "session_id": "c", "cwd": str(project), "source": "startup"}),
        config,
    )
    data = json.loads(output)
    assert "Parser" in data["hookSpecificOutput"]["additionalContext"]


def test_invalid_payload_is_quarantined_and_silent(config: Config):
    assert hook.run("claude", None, "{not json", config) == ""
    assert hook.run("claude", None, json.dumps({"hook_event_name": "UserPromptSubmit"}), config) == ""
    assert len(list(config.quarantine_dir.glob("*.json"))) == 2


def test_disabled_and_internal_env(config: Config, project: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AGENT_MEM_INTERNAL", "1")
    assert hook.run("claude", None, _prompt_payload(project, "s", "hello there"), config) == ""
    assert not config.db_path.exists()


def test_deadline_spools_event_and_returns_nothing(config: Config, project: Path, monkeypatch: pytest.MonkeyPatch):
    config.hook_deadline_ms = 50

    def slow_apply(*args, **kwargs):
        time.sleep(0.5)
        raise sqlite3.OperationalError("simulated slowness")

    monkeypatch.setattr(capture, "apply", slow_apply)
    assert hook.run("claude", None, _prompt_payload(project, "s", "slow prompt"), config) == ""
    assert spool.count(config.spool_dir) == 1


def test_locked_database_spools_and_indexer_replays_once(config: Config, project: Path, conn):
    locker = sqlite3.connect(config.db_path, isolation_level=None)
    locker.execute("BEGIN EXCLUSIVE")
    try:
        assert hook.run("claude", None, _prompt_payload(project, "s", "while locked"), config) == ""
    finally:
        locker.execute("ROLLBACK")
        locker.close()
    assert spool.count(config.spool_dir) == 1
    stats = indexer.run(config, allow_download=False)
    assert stats["spool_applied"] == 1 and spool.count(config.spool_dir) == 0
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE prompt = 'while locked'").fetchone()[0] == 1
    # replaying the same record again is a no-op
    spool.write(config.spool_dir, {"type": "event", "event": json.loads(json.dumps(_event_dict(project)))})
    spool.write(config.spool_dir, {"type": "event", "event": json.loads(json.dumps(_event_dict(project)))})
    indexer.run(config, allow_download=False)
    assert conn.execute("SELECT COUNT(*) FROM turns WHERE prompt = 'replayed'").fetchone()[0] == 1


def _event_dict(project: Path) -> dict:
    return {
        "harness": "claude",
        "kind": "prompt",
        "session_id": "r",
        "ts": "2026-09-01T00:00:00.000Z",
        "cwd": str(project),
        "prompt": "replayed",
        "raw_kind": "UserPromptSubmit",
    }


def test_broken_spool_records_are_quarantined(config: Config, conn):
    spool.write(config.spool_dir, {"type": "event", "event": {"kind": "nonsense"}})
    (config.spool_dir / "0000-bad.json").write_text("{broken")
    stats = indexer.run(config, allow_download=False)
    assert stats["spool_quarantined"] == 2
    assert spool.count(config.spool_dir) == 0


def test_parallel_hook_processes_lose_nothing(config: Config, project: Path, conn):
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(config.data_dir), "AGENT_MEM_NO_SPAWN": "1"}

    def run(index: int) -> None:
        payload = _prompt_payload(project, f"p{index % 4}", f"parallel prompt number {index}")
        subprocess.run(
            [sys.executable, "-m", "agent_mem", "hook", "claude"],
            input=payload,
            text=True,
            env=env,
            capture_output=True,
            timeout=60,
            check=False,
        )

    with ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(run, range(20)))
    indexer.run(config, allow_download=False)  # replays anything that was spooled under contention
    prompts = [r[0] for r in conn.execute("SELECT prompt FROM turns")]
    assert sorted(prompts) == sorted(f"parallel prompt number {i}" for i in range(20))


def test_migrations_and_downgrade_protection(config: Config):
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION
    conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
    conn.close()
    with pytest.raises(db.SchemaTooNewError):
        db.connect(config)


def test_backup_restore_and_corruption_recovery(config: Config, project: Path):
    conn = db.connect(config)
    hook.run("claude", None, _prompt_payload(project, "s", "important memory about billing"), config)
    backup = db.backup(conn, config)
    assert backup.exists()
    conn.close()
    config.db_path.write_bytes(b"this is not a database" * 100)
    for suffix in ("-wal", "-shm"):
        Path(f"{config.db_path}{suffix}").unlink(missing_ok=True)
    assert indexer.recover_if_corrupt(config)
    restored = db.connect(config)
    assert restored.execute("SELECT COUNT(*) FROM turns WHERE prompt LIKE '%billing%'").fetchone()[0] == 1
    restored.close()


def test_purge_removes_data_everywhere(config: Config, project: Path, conn, monkeypatch: pytest.MonkeyPatch):
    from agent_mem import cli

    hook.run("claude", None, _prompt_payload(project, "s", "zebra-unique-marker project data"), config)
    db.backup(conn, config)
    spool.write(config.spool_dir, {"type": "event", "event": {**_event_dict(project), "prompt": "zebra spooled"}})
    monkeypatch.chdir(project)
    assert cli.main(["--data-dir", str(config.data_dir), "purge", "--project", str(project), "--yes"]) == 0
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH '\"zebra\"'").fetchone()[0] == 0
    assert spool.count(config.spool_dir) == 0
    for backup in config.backup_dir.glob("*.db"):
        assert b"zebra-unique-marker" not in backup.read_bytes()


def test_upgrade_from_schema_v1_keeps_data_and_backs_up(config: Config):
    config.data_dir.mkdir(parents=True)
    legacy = sqlite3.connect(config.db_path)
    for statement in db._split_sql(db.MIGRATIONS[0][1]):
        legacy.execute(statement)
    legacy.execute("INSERT INTO meta(key, value) VALUES ('probe', 'kept')")
    legacy.execute("PRAGMA user_version = 1")
    legacy.commit()
    legacy.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 2
    assert db.get_meta(conn, "probe") == "kept"
    indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert "links_entity_owner" in indexes and "links_entity" not in indexes
    assert list(config.backup_dir.glob("*pre-migration-v1*.db"))
    conn.close()


def test_subagent_start_gets_context(config: Config, project: Path, conn):
    hook.run("claude", None, _prompt_payload(project, "s", "Design the retry policy for webhooks"), config)
    hook.run(
        "claude",
        None,
        json.dumps(
            {
                "hook_event_name": "Stop",
                "session_id": "s",
                "cwd": str(project),
                "last_assistant_message": "Exponential backoff, max 5 retries.",
            }
        ),
        config,
    )
    payload = {"hook_event_name": "SubagentStart", "session_id": "s2", "cwd": str(project), "agent_id": "a1"}
    data = json.loads(hook.run("codex", None, json.dumps(payload), config))
    assert data["hookSpecificOutput"]["hookEventName"] == "SubagentStart"
    assert "retry policy" in data["hookSpecificOutput"]["additionalContext"]
