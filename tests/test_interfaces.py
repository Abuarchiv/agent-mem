import asyncio
import json
from pathlib import Path

import pytest

from agent_mem import cli
from agent_mem.core import config as config_module
from agent_mem.core import db
from agent_mem.core.config import Config
from tests.conftest import Driver


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")


def test_mcp_tools(conn, config: Config, project: Path, driver: Driver, monkeypatch: pytest.MonkeyPatch):
    from agent_mem.mcp import server as mcp_server

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


def test_eval_runner(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agent_mem.bench import evaluate

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


def test_eval_runner_coding_life_and_injection(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """agentmemory's coding corpus runs as is; the fixture reports what the prompt hook would inject."""
    from agent_mem.bench import evaluate

    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(tmp_path / "evaldata"))
    fixtures = Path(__file__).parent / "fixtures"
    runner = evaluate.Runner("sqlite", semantic_search=False)
    report = runner.longmemeval(fixtures / "coding_agent_life_v1.json", limit=3)
    assert report["overall"]["n"] == 3 and "All@5" in report["overall"]

    cases = json.loads((fixtures / "memory_cases.json").read_text(encoding="utf-8"))
    small = tmp_path / "cases.json"
    picked = [c for c in cases["cases"] if c["id"] in {"c02", "c26"}]
    small.write_text(json.dumps({"cases": picked}), encoding="utf-8")
    report = runner.fixture(small)
    assert report["injected_hit@1"] is not None and report["injected_abstention"] == 1.0
