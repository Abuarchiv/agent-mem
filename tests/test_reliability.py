import json
import os
import sqlite3
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from agent_mem.core import db, spool
from agent_mem.core.config import Config
from agent_mem.hooks import capture, hook, inject
from agent_mem.memory import indexer


def _prompt_payload(project: Path, session: str, text: str) -> str:
    return json.dumps(
        {"hook_event_name": "UserPromptSubmit", "session_id": session, "cwd": str(project), "prompt": text}
    )


def test_hook_run_end_to_end(config: Config, project: Path, conn):
    start = json.dumps({"hook_event_name": "SessionStart", "session_id": "s", "cwd": str(project), "source": "startup"})
    data = json.loads(hook.run("claude", None, start, config))
    assert "hookSpecificOutput" not in data  # nothing to inject yet, but the user sees the panel
    assert "Nothing to recall here yet" in data["systemMessage"] and "1 session ·" in data["systemMessage"]
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
    # Codex shows it as a warning: the same panel, without ANSI colors
    assert data["systemMessage"].startswith("agent-mem · ") and "\x1b[" not in data["systemMessage"]
    assert "Parser" in data["systemMessage"]

    start = {"hook_event_name": "SessionStart", "session_id": "s", "cwd": str(project), "source": "compact"}
    data = json.loads(hook.run("claude", None, json.dumps(start), config))
    assert data["systemMessage"].startswith("\x1b[1;36magent-mem") and "This session" in data["systemMessage"]


def test_panel_names_the_fact_model_or_why_there_is_none(config: Config, project: Path, monkeypatch):
    import shutil

    from agent_mem.core import db

    start = {"hook_event_name": "SessionStart", "session_id": "s", "cwd": str(project), "source": "startup"}
    monkeypatch.setattr(shutil, "which", lambda name: f"/bin/{name}" if name == "claude" else None)
    panel = json.loads(hook.run("claude", None, json.dumps(start), config))["systemMessage"]
    assert "facts by haiku via claude" in panel
    conn = db.connect(config)
    db.set_meta(conn, "observe.pause.claude", "2999-01-01T10:00:00.000Z")
    conn.close()
    panel = json.loads(hook.run("claude", None, json.dumps(start), config))["systemMessage"]
    assert "facts: claude paused until" in panel and "stay queued" in panel
    monkeypatch.setattr(shutil, "which", lambda name: None)
    panel = json.loads(hook.run("claude", None, json.dumps(start), config))["systemMessage"]
    assert "facts: no model for claude turns" in panel


def test_prompt_injection_stays_out_of_the_terminal(config: Config, project: Path):
    # The terminal shows a panel at session start, compaction and session end; ordinary prompts stay quiet.
    for harness in ("claude", "codex"):
        start = {"hook_event_name": "SessionStart", "session_id": harness, "cwd": str(project), "source": "startup"}
        hook.run(harness, None, json.dumps(start), config)
        output = hook.run(harness, None, _prompt_payload(project, harness, "Build the parser"), config)
        assert "systemMessage" not in (json.loads(output) if output else {})


def test_session_end_and_failures_reach_the_terminal(config: Config, project: Path, monkeypatch):
    config.hook_deadline_ms = 10_000  # the message is what is tested, not the deadline (a slow runner misses 400 ms)
    start = {"hook_event_name": "SessionStart", "session_id": "s", "cwd": str(project), "source": "startup"}
    hook.run("claude", None, json.dumps(start), config)
    hook.run("claude", None, _prompt_payload(project, "s", "Build the parser"), config)
    end = {"hook_event_name": "SessionEnd", "session_id": "s", "cwd": str(project), "reason": "exit"}
    message = json.loads(hook.run("claude", None, json.dumps(end), config))["systemMessage"]
    assert "session saved · 1 turn · 0 files" in message

    config.db_path.write_bytes(b"not a database" * 100)
    first = json.loads(hook.run("claude", None, _prompt_payload(project, "s", "again"), config))
    assert "cannot use its database" in first["systemMessage"] and "agent-mem doctor" in first["systemMessage"]
    assert hook.run("claude", None, _prompt_payload(project, "s", "and again"), config) == ""  # once per 10 min
    # Later events of the session queue behind the spooled ones; once they wait long, the start says so.
    monkeypatch.setattr(hook, "SPOOL_STUCK_SECONDS", 0)
    panel = json.loads(hook.run("claude", None, json.dumps(start), config))["systemMessage"]
    assert "cannot save events" in panel and "agent-mem doctor" in panel


def test_invalid_payload_is_quarantined_and_silent(config: Config):
    assert hook.run("claude", None, "{not json", config) == ""
    assert hook.run("claude", None, json.dumps({"hook_event_name": "UserPromptSubmit"}), config) == ""
    assert len(list(config.quarantine_dir.glob("*.json"))) == 2


def test_quarantine_latest_says_what_was_set_aside(config: Config):
    from agent_mem.cli.health import quarantine_latest
    from agent_mem.core import spool

    assert quarantine_latest(config) is None
    hook.run("claude", None, "{not json", config)
    assert "Expecting property name" in quarantine_latest(config)["reason"]
    spool.quarantine_record(
        config.quarantine_dir,
        {"type": "event", "event": {"harness": "claude", "kind": "tool", "ts": "2026-10-12T20:00:00.000Z"}},
    )
    latest = quarantine_latest(config)
    assert latest == {"ts": "2026-10-12T20:00:00.000Z", "reason": "a saved claude tool could not be replayed"}


def test_hook_help_explains_instead_of_quarantining(config: Config, capsys: pytest.CaptureFixture[str]):
    assert hook.main(["--help"]) == 0
    assert "usage: agent-mem hook" in capsys.readouterr().out
    assert not config.quarantine_dir.exists() or not list(config.quarantine_dir.glob("*.json"))


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


def test_deadline_and_worker_error_spool_once(config: Config, project: Path, monkeypatch: pytest.MonkeyPatch):
    config.hook_deadline_ms = 50
    real_write = spool.write

    def slow_write(*args, **kwargs):
        time.sleep(0.2)
        return real_write(*args, **kwargs)

    def failing_apply(*args, **kwargs):
        time.sleep(0.06)  # fails while the main thread is spooling after the deadline
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(spool, "write", slow_write)
    monkeypatch.setattr(capture, "apply", failing_apply)
    assert hook.run("claude", None, _prompt_payload(project, "s", "racing prompt"), config) == ""
    time.sleep(0.5)
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


def test_purge_removes_data_everywhere(config: Config, project: Path, conn, monkeypatch: pytest.MonkeyPatch):
    from agent_mem import cli

    hook.run("claude", None, _prompt_payload(project, "s", "zebra-unique-marker project data"), config)
    config.backup_dir.mkdir()  # daily copies written by older releases hold the data as well
    (config.backup_dir / "memory-old.db").write_bytes(b"zebra-unique-marker")
    spool.write(config.spool_dir, {"type": "event", "event": {**_event_dict(project), "prompt": "zebra spooled"}})
    monkeypatch.chdir(project)
    assert cli.main(["--data-dir", str(config.data_dir), "purge", "--project", str(project), "--yes"]) == 0
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH '\"zebra\"'").fetchone()[0] == 0
    assert spool.count(config.spool_dir) == 0
    assert not config.backup_dir.exists()


def test_doctor_fix_deletes_backups_left_by_older_releases(config: Config, monkeypatch: pytest.MonkeyPatch):
    from agent_mem.cli import health

    # --fix would also rewrite hooks and register the viewer login item; only the backup cleanup is under test.
    monkeypatch.setattr(health, "_hook_checks", lambda fix: [])
    monkeypatch.setattr(health, "_viewer_checks", lambda config, fix: [])
    config.backup_dir.mkdir(parents=True)
    (config.backup_dir / "memory-old.db").write_bytes(b"old copy")
    [check] = [c for c in health.doctor(config) if c.name == "old backups"]
    assert not check.ok and config.backup_dir.exists()
    [check] = [c for c in health.doctor(config, fix=True) if c.name == "old backups"]
    assert check.ok and not config.backup_dir.exists()


def test_upgrade_migration_keeps_data(config: Config, monkeypatch: pytest.MonkeyPatch):
    conn = db.connect(config)
    db.set_meta(conn, "probe", "kept")
    conn.close()
    upgrade = (db.SCHEMA_VERSION + 1, "CREATE INDEX upgrade_probe ON meta(value);")
    monkeypatch.setattr(db, "MIGRATIONS", [*db.MIGRATIONS, upgrade])
    monkeypatch.setattr(db, "SCHEMA_VERSION", upgrade[0])
    conn = db.connect(config)
    assert db.user_version(conn) == upgrade[0]
    assert db.get_meta(conn, "probe") == "kept"
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'upgrade_probe'").fetchone()
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


def test_terminal_view_groups_what_the_model_got():
    context = (
        "<agent-mem>\nMemory:\n! agent-mem: claude hooks failing (x). Run `agent-mem doctor`.\n"
        "- Commands that worked here: test: `uv run pytest`\n"
        "- [M3 · 2026-10-01 · decision] use uv, not pip\n- [M4 · 2026-10-01 · dead_end] pip install broke the venv\n"
        "- [T9 · unresolved] `pytest` failed: AssertionError\n"
        "- [T7 · 2026-10-02 · last session, codex] fix parser → done, tests pass\n</agent-mem>"
    )
    view = inject.terminal(context, "shop", color=False)
    lines = view.splitlines()
    assert lines[0] == f"agent-mem · shop · 4 items · ~{inject.tokens(context)} tokens"
    # The last session leads, memories are grouped by kind (newest first, at most three per kind shown).
    assert lines.index("Last session · codex") < lines.index("Open errors") < lines.index("◆ Decisions 1")
    assert "  T7    › fix parser → done, tests pass" in lines and "  M3      use uv, not pip" in lines
    assert "✗ Dead ends 1" in lines and "  M4      pip install broke the venv" in lines
    assert "claude hooks failing" in view and "Commands  test: `uv run pytest`" in view
    assert lines[-1] == "Details: agent-mem show T7 · everything: agent-mem view"
    assert "\x1b[" not in view and "\x1b[" in inject.terminal(context, "shop")


def test_the_wal_shrinks_back_after_a_vacuum(config) -> None:
    import os

    from agent_mem.core import db

    conn = db.connect(config)
    conn.execute("CREATE TABLE big(x)")
    conn.execute(
        "INSERT INTO big SELECT randomblob(1000) FROM "
        "(WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 10000) SELECT i FROM c)"
    )
    conn.execute("DELETE FROM big")
    conn.execute("VACUUM")
    conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
    conn.execute("INSERT INTO big VALUES (1)")
    assert os.path.getsize(str(config.db_path) + "-wal") <= db.WAL_LIMIT_BYTES
    conn.close()


def test_config_values_that_would_break_silently_fall_back_and_reach_the_terminal(tmp_path, monkeypatch) -> None:
    import json

    from agent_mem.core.config import load
    from agent_mem.hooks import hook

    settings = {"hook_deadline_ms": 0, "retention": {"payload_days": 0}, "semantic": {"duplicate_min_cosine": 0.2}}
    (tmp_path / "config.json").write_text(json.dumps(settings))
    config = load(tmp_path)
    assert config.hook_deadline_ms == 400 and config.retention.payload_days == 30
    assert config.semantic.duplicate_min_cosine == 0.9
    assert config.viewer.port == 37778  # in-range values stay untouched
    monkeypatch.setenv("AGENT_MEM_NO_SPAWN", "1")
    monkeypatch.delenv("NO_COLOR", raising=False)
    start = {"hook_event_name": "SessionStart", "session_id": "s", "source": "startup", "cwd": str(tmp_path)}
    shown = json.loads(hook.run("claude", None, json.dumps(start), config))["systemMessage"]
    assert "'hook_deadline_ms' must be between 100 and 10000" in shown


def test_migration_008_lets_failure_resolution_read_only_its_session(config: Config):
    conn = db.connect(config)
    conn.execute("DROP INDEX events_session_ts")
    conn.execute("PRAGMA user_version = 7")
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 8
    plan = conn.execute(
        "EXPLAIN QUERY PLAN SELECT files_json, payload FROM events WHERE session_id = ? AND kind = 'tool' "
        "AND ts >= ? AND ts <= ?",
        ("s", "a", "b"),
    ).fetchall()
    assert "events_session_ts" in str([tuple(row) for row in plan])
    conn.close()


def test_copilot_shows_the_panel_as_progress_lines(config: Config, project: Path):
    """Copilot has no systemMessage. A {"type": "progress"} line before the output JSON shows in its timeline and
    is removed before the rest is parsed (CLI 1.0.96)."""
    start = {"sessionId": "a", "cwd": str(project), "source": "new", "timestamp": 1791902160502}
    lines = hook.run("copilot", "sessionStart", json.dumps(start), config).splitlines()
    assert len(lines) == 1  # nothing to recall yet: the panel only, no empty output JSON
    progress = json.loads(lines[0])
    assert progress["type"] == "progress" and progress["message"].startswith("agent-mem · ")
    assert "\x1b[" not in progress["message"]

    hook.run("copilot", "userPromptSubmitted", json.dumps({**start, "prompt": "Build the invoice parser"}), config)
    stop = {**start, "response": "Parser in invoices/parse.py done."}
    hook.run("copilot", "agentStop", json.dumps(stop), config)
    lines = hook.run("copilot", "sessionStart", json.dumps({**start, "sessionId": "b"}), config).splitlines()
    progress, output = (json.loads(line) for line in lines)
    assert progress["type"] == "progress" and "Parser" in output["additionalContext"]
    assert "systemMessage" not in output
    (end,) = hook.run("copilot", "sessionEnd", json.dumps({**start, "reason": "complete"}), config).splitlines()
    assert json.loads(end) == {
        "type": "progress",
        "message": "agent-mem session saved · 1 turn · 0 files · facts follow in the background",
    }
