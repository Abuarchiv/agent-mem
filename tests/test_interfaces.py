import asyncio
import json
from pathlib import Path

import pytest

from agent_mem import cli
from agent_mem.core import config as config_module
from agent_mem.core import timeutil
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
    found = call("mem_search", {"query": "restic backup"})
    assert "T1" in found and "No confident match" not in found
    # One generic word of five: shown as a weak candidate, labeled as such, never as a match.
    weak = call("mem_search", {"query": "who approves the nightly invoice export budget"})
    assert weak.startswith("No confident match") or weak == "No matching memories."
    assert "backup.sh" in call("mem_get", {"ids": ["T1"]})
    assert "▶ T1" in call("mem_timeline", {"id": "T1"})
    stored = call("mem_remember", {"text": "Backups go to the B2 bucket", "kind": "decision"})
    memory_id = stored.split()[-1].rstrip(".")
    assert "B2 bucket" in call("mem_get", {"ids": [memory_id]})
    assert call("mem_forget", {"id": memory_id}).startswith("Deleted")
    assert "not found" in call("mem_get", {"ids": [memory_id]})
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('other', 'other', '/elsewhere', 't')")
    foreign = conn.execute(
        "INSERT INTO memories(project_id, kind, title, body, source, trust, valid_from, created_at) "
        "VALUES ('other', 'fact', 'Other project', 'x', 'agent', 'agent', 't', 't')"
    ).lastrowid
    assert "belongs to another project" in call("mem_forget", {"id": f"M{foreign}"})
    assert conn.execute("SELECT 1 FROM memories WHERE id = ?", (foreign,)).fetchone()

    # Agents call tools in parallel; the server runs them in threads on one shared connection.
    async def burst() -> list:
        calls = [("mem_search", {"query": "restic backup"}), ("mem_get", {"ids": ["T1"]})] * 6
        calls += [("mem_remember", {"text": f"Parallel note {n}"}) for n in range(6)]
        return await asyncio.gather(*(server.call_tool(name, args) for name, args in calls))

    texts = [result.content[0].text for result in asyncio.run(burst())]
    assert not any("Error executing tool" in text or "transaction" in text for text in texts)
    assert sum(text.startswith("Stored M") for text in texts) == 6
    assert conn.execute("SELECT COUNT(*) FROM accesses WHERE kind = 'get'").fetchone()[0] >= 1


def test_config_validation(tmp_path: Path):
    data = tmp_path / "d"
    data.mkdir()
    (data / "config.json").write_text(
        json.dumps({"budgets": {"prompt": "lots"}, "capture": False, "nope": 1, "retrieval": {"inject_min_score": 0.5}})
    )
    cfg = config_module.load(data)
    assert cfg.capture is False
    assert cfg.budgets.prompt == config_module.Budgets().prompt
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
    assert cli.main([*base, "search", "pnpm npm", "--json"]) == 0
    capsys.readouterr()
    cli.main([*base, "doctor"])
    report = capsys.readouterr().out
    assert "database integrity" in report and "Claude Code recording" in report


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
    """The coding corpus runs as is; the fixture reports what the prompt hook would inject."""
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


def test_doctor_says_when_an_agent_that_recorded_has_no_hooks_any_more(driver: Driver, conn, monkeypatch):
    """Hooks removed (by hand or by another tool) leave the last recording behind: it must not read as working."""
    from agent_mem.cli import health

    driver.prompt("s1", "hallo")
    conn.execute("INSERT OR REPLACE INTO health(component, last_ok_at) VALUES ('hook:claude', ?)", (timeutil.iso(),))
    monkeypatch.setattr(health, "harness_installed", lambda harness: False)
    check = next(c for c in health._capture_checks(conn) if c.name == "Claude Code recording")
    assert not check.ok and check.warn_only and check.detail.startswith("off, no agent-mem hooks")
    monkeypatch.setattr(health, "harness_installed", lambda harness: True)
    assert next(c for c in health._capture_checks(conn) if c.name == "Claude Code recording").ok


def test_retrieval_does_not_fall_below_its_measured_floor(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The anonymous fixed questions in CI: bench/check.py measures the developer's own database before a push, which CI
    does not have. Word search only (no model download); raise the floor when a change lifts it."""
    from agent_mem.bench import evaluate

    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(tmp_path / "evaldata"))
    fixtures = Path(__file__).parent / "fixtures"
    runner = evaluate.Runner("sqlite", semantic_search=False)
    report = runner.fixture(fixtures / "memory_cases.json")
    floor = {"hit@1": 1.0, "abstention": 0.7, "injected_hit@1": 0.9, "injected_abstention": 1.0, "mcp_hit@1": 0.9}
    assert all(report[key] >= value for key, value in floor.items()), report
    life = runner.longmemeval(fixtures / "coding_agent_life_v1.json")["overall"]
    assert life["R@5"] == 1.0 and life["All@5"] == 1.0, life
