"""Notes Claude Code and Codex keep themselves become memories for the other harnesses (memory/notes.py)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from agent_mem.core.config import Config
from agent_mem.memory import notes, search
from tests.conftest import Driver


def _claude_note(project: Path, name: str, text: str) -> Path:
    folder = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "projects" / "-proj"
    (folder / "memory").mkdir(parents=True, exist_ok=True)
    (folder / "t.jsonl").write_text(json.dumps({"type": "user", "cwd": str(project)}) + "\n")
    path = folder / "memory" / name
    path.write_text(text)
    return path


def _codex_note(project: Path, name: str, title: str) -> Path:
    folder = Path(os.environ["CODEX_HOME"]) / "memories" / "rollout_summaries"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(f"thread_id: x\ncwd: {project}\n\n# {title}\n\nDetails of the session.\n")
    return path


NOTE = """---
name: worker-drain
description: The observer drains its queue before it exits
metadata:
  type: project
---

The observer drains its queue before it exits; a restart never loses a turn.
"""


def test_notes_are_stored_once_and_a_change_supersedes(conn, config: Config, project: Path):
    path = _claude_note(project, "worker-drain.md", NOTE)
    _claude_note(project, "MEMORY.md", "- [Worker](worker-drain.md) — index only")
    assert notes.ingest(conn, config) == {"stored": 1, "unchanged": 0, "retired": 0, "skipped": 0}
    assert notes.ingest(conn, config)["unchanged"] == 1
    row = conn.execute("SELECT * FROM memories WHERE kind = 'native_note'").fetchone()
    assert row["title"] == "The observer drains its queue before it exits"
    assert row["origin"] == "claude-auto-memory" and "---" not in row["body"]
    path.write_text(NOTE.replace("before it exits", "before it exits, then vacuums"))
    assert notes.ingest(conn, config)["stored"] == 1
    rows = conn.execute(
        "SELECT invalid_at, superseded_by FROM memories WHERE kind = 'native_note' ORDER BY id"
    ).fetchall()
    assert rows[0]["invalid_at"] and rows[0]["superseded_by"] and rows[1]["invalid_at"] is None
    path.write_text(NOTE)  # changed back: the first version returns, searchable again
    assert notes.ingest(conn, config)["stored"] == 0
    first = conn.execute("SELECT invalid_at FROM memories WHERE kind = 'native_note' ORDER BY id").fetchone()
    assert first[0] is None and _valid(conn) == ["claude-auto-memory"]
    assert search.search(conn, config, _query(conn)) != []


def _query(conn) -> search.Query:
    project_id = conn.execute("SELECT project_id FROM memories LIMIT 1").fetchone()[0]
    return search.Query(text="observer drains its queue", project_id=project_id)


def _valid(conn) -> list[str]:
    return [r[0] for r in conn.execute("SELECT origin FROM memories WHERE kind = 'native_note' AND invalid_at IS NULL")]


def test_a_deleted_claude_note_is_retired_a_pruned_codex_summary_stays(conn, config: Config, project: Path):
    claude = _claude_note(project, "worker-drain.md", NOTE)
    codex = _codex_note(project, "s1.md", "Codex found the pnpm lockfile is authoritative")
    notes.ingest(conn, config)
    claude.unlink()  # Claude deletes a note that turned out wrong
    codex.unlink()  # Codex prunes old summaries by age
    assert notes.ingest(conn, config)["retired"] == 1
    assert _valid(conn) == ["codex-memory"]
    assert search.search(conn, config, _query(conn)) == []


def test_another_config_dir_does_not_retire_notes_it_never_scanned(
    conn, config: Config, project: Path, tmp_path: Path, monkeypatch
):
    _claude_note(project, "worker-drain.md", NOTE)
    notes.ingest(conn, config)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "other"))
    _claude_note(project, "other.md", NOTE.replace("drains its queue", "flushes its log"))
    notes.ingest(conn, config)
    assert _valid(conn) == ["claude-auto-memory", "claude-auto-memory"]


def test_symlinks_big_files_and_unknown_projects_are_skipped(conn, config: Config, project: Path, tmp_path: Path):
    secret = tmp_path / "secret.md"
    secret.write_text("password list")
    link = _claude_note(project, "real.md", NOTE).parent / "link.md"
    link.symlink_to(secret)
    (link.parent / "big.md").write_text("x" * (notes.MAX_BYTES + 1))
    folder = Path(os.environ["CODEX_HOME"]) / "memories" / "rollout_summaries"
    folder.mkdir(parents=True)
    (folder / "nocwd.md").write_text("# no cwd header\n")
    counts = notes.ingest(conn, config)
    assert counts["stored"] == 1
    bodies = " ".join(r[0] for r in conn.execute("SELECT body FROM memories"))
    assert "password" not in bodies


def test_each_harness_sees_the_other_harness_notes_but_not_its_own(conn, config: Config, project: Path):
    _claude_note(project, "worker-drain.md", NOTE)
    _codex_note(project, "s1.md", "Codex found the pnpm lockfile is authoritative")
    notes.ingest(conn, config)
    claude = Driver(conn, config, project, harness="claude").start("c1").context or ""
    codex = Driver(conn, config, project, harness="codex").start("x1").context or ""
    assert "pnpm lockfile" in claude and "drains its queue" not in claude
    assert "drains its queue" in codex and "pnpm lockfile" not in codex


def test_notes_can_be_switched_off(conn, config: Config, project: Path):
    _claude_note(project, "worker-drain.md", NOTE)
    config.native_notes = False
    assert notes.ingest(conn, config)["stored"] == 0
