import asyncio
import json
import sqlite3
from pathlib import Path

import pytest

from agent_mem import cli, db, importers, summarize
from agent_mem import config as config_module
from agent_mem.config import Config
from tests.conftest import Driver


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")


def test_import_claude_transcript(conn, config: Config, project: Path, tmp_path: Path):
    transcript = tmp_path / "claude" / "s.jsonl"
    cwd = str(project)
    _write_jsonl(
        transcript,
        [
            {
                "type": "user",
                "sessionId": "old1",
                "cwd": cwd,
                "timestamp": "2026-08-01T10:00:00Z",
                "message": {"role": "user", "content": "Why does the build fail on CI?"},
            },
            {
                "type": "assistant",
                "sessionId": "old1",
                "cwd": cwd,
                "timestamp": "2026-08-01T10:00:05Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "npm run build"}}
                    ],
                },
            },
            {
                "type": "user",
                "sessionId": "old1",
                "cwd": cwd,
                "timestamp": "2026-08-01T10:00:09Z",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tu1",
                            "content": "error TS2307: Cannot find module",
                            "is_error": True,
                        }
                    ],
                },
            },
            {
                "type": "assistant",
                "sessionId": "old1",
                "cwd": cwd,
                "timestamp": "2026-08-01T10:01:00Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "A path alias was missing in tsconfig."}],
                },
            },
        ],
    )
    stats = importers.import_claude(conn, config, tmp_path / "claude")
    assert stats["events"] == 4
    turn = conn.execute("SELECT * FROM turns").fetchone()
    assert "build fail" in turn["prompt"] and "tsconfig" in turn["answer"]
    assert conn.execute("SELECT COUNT(*) FROM events WHERE error_sig IS NOT NULL").fetchone()[0] == 1
    assert importers.import_claude(conn, config, tmp_path / "claude")["skipped_sessions"] == 1


def test_import_codex_rollout(conn, config: Config, project: Path, tmp_path: Path):
    rollout = tmp_path / "codex" / "2026" / "rollout-x.jsonl"
    _write_jsonl(
        rollout,
        [
            {
                "timestamp": "2026-08-02T09:00:00Z",
                "type": "session_meta",
                "payload": {"id": "cx1", "cwd": str(project)},
            },
            {
                "timestamp": "2026-08-02T09:00:01Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "<environment_context>ignored</environment_context>"}],
                },
            },
            {
                "timestamp": "2026-08-02T09:00:02Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Run the go tests"}],
                },
            },
            {
                "timestamp": "2026-08-02T09:00:03Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "shell",
                    "arguments": json.dumps({"command": ["bash", "-lc", "go test ./..."]}),
                    "call_id": "c1",
                },
            },
            {
                "timestamp": "2026-08-02T09:00:09Z",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "c1",
                    "output": json.dumps({"output": "ok  pkg 0.1s", "metadata": {"exit_code": 0}}),
                },
            },
            {
                "timestamp": "2026-08-02T09:00:10Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "All go tests pass."}],
                },
            },
        ],
    )
    stats = importers.import_codex(conn, config, tmp_path / "codex")
    assert stats["files"] == 1
    turn = conn.execute("SELECT * FROM turns").fetchone()
    assert turn["prompt"] == "Run the go tests" and "pass" in turn["answer"]
    assert conn.execute("SELECT id FROM sessions").fetchone()[0] == "codex:cx1"


def test_import_claude_mem_and_agentmemory(conn, config: Config, tmp_path: Path):
    source = tmp_path / "claude-mem.db"
    other = sqlite3.connect(source)
    other.execute("CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, title TEXT, narrative TEXT)")
    other.execute("INSERT INTO observations VALUES (1, 'demo', 'Auth uses JWT', 'Tokens rotate daily')")
    other.commit()
    other.close()
    assert importers.import_claude_mem(conn, config, source)["memories"] == 1
    export = tmp_path / "am.json"
    export.write_text(
        json.dumps({"memories": [{"id": "a1", "type": "lesson", "content": "Run migrations before seeding"}]})
    )
    assert importers.import_agentmemory(conn, config, export)["memories"] == 1
    assert importers.import_agentmemory(conn, config, export)["memories"] == 0  # idempotent
    kinds = [r[0] for r in conn.execute("SELECT origin FROM memories ORDER BY id")]
    assert kinds == ["claude-mem", "agentmemory"]


def test_mcp_tools(conn, config: Config, project: Path, driver: Driver, monkeypatch: pytest.MonkeyPatch):
    from agent_mem import mcp_server

    driver.prompt("s1", "Set up the nightly backup job with restic")
    driver.edit("s1", "backup.sh")
    driver.stop("s1", "Nightly restic job configured in backup.sh")
    monkeypatch.chdir(project)
    server = mcp_server.build(config)

    def call(name: str, args: dict) -> str:
        result = asyncio.run(server.call_tool(name, args))
        return result.content[0].text

    tools = asyncio.run(server.list_tools())
    assert [t.name for t in tools] == ["mem_search", "mem_timeline", "mem_get", "mem_remember", "mem_forget"]
    assert "T1" in call("mem_search", {"query": "restic backup"})
    assert "backup.sh" in call("mem_get", {"ids": ["T1"]})
    assert "▶ T1" in call("mem_timeline", {"id": "T1"})
    stored = call("mem_remember", {"text": "Backups go to the B2 bucket", "kind": "decision"})
    memory_id = stored.split()[-1].rstrip(".")
    assert "B2 bucket" in call("mem_get", {"ids": [memory_id]})
    assert call("mem_forget", {"id": memory_id}).startswith("Deleted")
    assert "not found" in call("mem_get", {"ids": [memory_id]})
    assert db.get_meta(conn, "backups_dirty") == "1"
    assert conn.execute("SELECT COUNT(*) FROM accesses WHERE kind = 'get'").fetchone()[0] >= 1


def test_config_validation(tmp_path: Path):
    data = tmp_path / "d"
    data.mkdir()
    (data / "config.json").write_text(
        json.dumps({"budgets": {"prompt": "lots"}, "capture": False, "nope": 1, "retrieval": {"inject_min_score": 0.5}})
    )
    cfg = config_module.load(data)
    assert cfg.capture is False
    assert cfg.budgets.prompt == 200
    assert cfg.retrieval.inject_min_score == 0.5
    assert any("nope" in w for w in cfg.warnings) and any("budgets.prompt" in w for w in cfg.warnings)
    (data / "config.json").write_text("{broken")
    assert config_module.load(data).warnings


def test_cli_commands(config: Config, project: Path, driver: Driver, capsys, monkeypatch: pytest.MonkeyPatch):
    base = ["--data-dir", str(config.data_dir)]
    driver.prompt("s1", "nein, pnpm statt npm")
    driver.prompt("s1", "nein, pnpm statt npm")
    monkeypatch.chdir(project)
    assert cli.main([*base, "status", "--json"]) == 0
    status = json.loads(capsys.readouterr().out)
    assert status["turns"] == 2 and status["rules_proposed"] == 1
    assert cli.main([*base, "rules"]) == 0
    assert "pnpm" in capsys.readouterr().out
    assert cli.main([*base, "rules", "enable", "1"]) == 0
    assert cli.main([*base, "lessons"]) == 0
    assert "pnpm" in capsys.readouterr().out
    assert cli.main([*base, "pause", "--for", "1h"]) == 0
    assert not driver.prompt("s1", "paused now").stored
    assert cli.main([*base, "resume"]) == 0
    assert cli.main([*base, "backup"]) == 0
    assert cli.main([*base, "search", "pnpm npm", "--json"]) == 0
    capsys.readouterr()
    cli.main([*base, "doctor"])
    report = capsys.readouterr().out
    assert "database integrity" in report and "claude capture" in report


def test_optional_summaries_use_the_harness(conn, config: Config, driver: Driver, monkeypatch: pytest.MonkeyPatch):
    for text in ("Design the cache layer", "Implement the cache layer"):
        driver.prompt("s1", text)
        driver.stop("s1", "done")
    driver.send("s1", "session_end", raw_kind="SessionEnd")
    assert summarize.summarize_pending(conn, config) == 0  # disabled by default
    config.summarize.enabled = True
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["env"] = kwargs["env"]

        class Done:
            returncode = 0
            stdout = json.dumps(
                {
                    "summary": "Built a cache layer.",
                    "decisions": ["Use LRU eviction"],
                    "dead_ends": [],
                    "open_items": [],
                    "lessons": [],
                }
            )

        return Done()

    monkeypatch.setattr(summarize.subprocess, "run", fake_run)
    assert summarize.summarize_pending(conn, config) == 1
    assert seen["env"]["AGENT_MEM_INTERNAL"] == "1"
    kinds = {r[0] for r in conn.execute("SELECT kind FROM memories WHERE source = 'harness_summary'")}
    assert kinds == {"summary", "decision"}
    assert summarize.summarize_pending(conn, config) == 0  # each session only once


def test_eval_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agent_mem import evaluate

    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(tmp_path / "evaldata"))
    dataset = tmp_path / "lme.json"
    dataset.write_text(
        json.dumps(
            [
                {
                    "question_id": "q1",
                    "question_type": "single-session-user",
                    "question": "Which database did I pick for the blog?",
                    "haystack_session_ids": ["a", "b"],
                    "answer_session_ids": ["b"],
                    "haystack_sessions": [
                        [
                            {"role": "user", "content": "I like hiking in the alps"},
                            {"role": "assistant", "content": "Nice!"},
                        ],
                        [
                            {"role": "user", "content": "For my blog I picked the SQLite database"},
                            {"role": "assistant", "content": "Good choice"},
                        ],
                    ],
                }
            ]
        )
    )
    report = evaluate.longmemeval(dataset, semantic_search=False)
    assert report["overall"]["R@5"] == 1.0


def test_imported_and_summarized_memories_are_redacted(conn, config: Config, tmp_path: Path):
    secret = "gh" + "p_" + "A" * 36
    export = tmp_path / "am.json"
    export.write_text(json.dumps([{"id": "s1", "content": f"deploy token {secret} <private>hidden plan</private>"}]))
    importers.import_agentmemory(conn, config, export)
    body = conn.execute("SELECT body FROM memories").fetchone()[0]
    assert secret not in body and "hidden plan" not in body
