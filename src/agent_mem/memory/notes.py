"""Notes the harnesses keep themselves, stored as memories without a model call (claude-mem `memory ingest`).

Claude Code writes one Markdown file per fact under ``~/.claude/projects/<folder>/memory/``; Codex writes one
summary per session under ``~/.codex/memories/rollout_summaries/``. Both are already distilled, so they are
stored as they are (``kind = native_note``). Each harness loads its own notes itself, so a note is shown only
to the other harnesses (``OWN_NOTES``): Codex learns what Claude Code noted and the other way round.

A changed note replaces the stored one (the old version stays, marked superseded); a deleted note stays.
Symlinks, hidden files and files over 64 KB are skipped; source files are never written.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from agent_mem.core import identity, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store

# The origin each harness's own notes carry; that harness already has them in its context.
OWN_NOTES = {"claude": "claude-auto-memory", "codex": "codex-memory"}
MAX_BYTES = 64 * 1024
_FRONT = re.compile(r"\A---\n(.*?)\n---\n?", re.S)
_FIELD = re.compile(r"^\s*(name|description|type):\s*(.+?)\s*$", re.M)
_HEADING = re.compile(r"^#\s+(.+)$", re.M)


def own_notes(harness: str) -> set[str]:
    origin = OWN_NOTES.get(harness)
    return {origin} if origin else set()


def _read(path: Path) -> str | None:
    if path.name.startswith(".") or path.is_symlink() or not path.is_file():
        return None
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _transcript_cwd(folder: Path) -> str | None:
    """The working directory Claude Code ran in, from a transcript next to the memory folder: the folder name
    replaces every non-alphanumeric character with '-' and cannot be turned back into a path."""
    for transcript in sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:3]:
        try:
            with transcript.open(encoding="utf-8", errors="replace") as fh:
                for _, line in zip(range(50), fh, strict=False):
                    if '"cwd"' not in line:
                        continue
                    cwd = json.loads(line).get("cwd")
                    if isinstance(cwd, str) and cwd:
                        return cwd
        except (OSError, ValueError):
            continue
    return None


def claude_notes(root: Path) -> Iterator[tuple[str, Path, str]]:
    """(cwd, path, text) for Claude Code's topic files; ``MEMORY.md`` is only an index of links."""
    for folder in sorted((root / "projects").glob("*/memory")):
        files = [p for p in sorted(folder.glob("*.md")) if p.name != "MEMORY.md"]
        cwd = _transcript_cwd(folder.parent) if files else None
        if cwd is None:
            continue
        for path in files:
            text = _read(path)
            if text and text.strip():
                yield cwd, path, text


def codex_notes(root: Path) -> Iterator[tuple[str, Path, str]]:
    """(cwd, path, text) for Codex's per-session summaries; the header names the session's ``cwd``."""
    for path in sorted((root / "memories" / "rollout_summaries").glob("*.md")):
        text = _read(path)
        match = re.search(r"^cwd:\s*(.+?)\s*$", text or "", re.M)
        if text and match:
            yield match.group(1), path, text


def _title_body(text: str, path: Path) -> tuple[str, str]:
    front = _FRONT.match(text)
    fields = dict(_FIELD.findall(front.group(1))) if front else {}
    body = text[front.end() :] if front else text
    heading = _HEADING.search(body)
    title = fields.get("description") or (heading.group(1) if heading else "") or fields.get("name") or path.stem
    return title.strip().strip('"'), body.strip()


def _home(variable: str, folder: str) -> Path:
    return Path(os.environ.get(variable) or os.path.join(os.path.expanduser("~"), folder))


def ingest(conn: sqlite3.Connection, config: Config) -> dict[str, int]:
    """Store new and changed notes. Returns counts: stored, unchanged, skipped (no project, excluded)."""
    from agent_mem.hooks import capture

    counts = {"stored": 0, "unchanged": 0, "skipped": 0}
    if not config.native_notes:
        return counts
    sources = [
        ("claude-auto-memory", claude_notes(_home("CLAUDE_CONFIG_DIR", ".claude"))),
        ("codex-memory", codex_notes(_home("CODEX_HOME", ".codex"))),
    ]
    for origin, notes in sources:
        for cwd, path, text in notes:
            project = identity.resolve(conn, cwd, register=False)
            if project is None or not capture.capture_allowed(conn, config, project):
                counts["skipped"] += 1
                continue
            identity.register_project(conn, project, cwd)
            source_key = hashlib.sha256(str(path).encode()).hexdigest()[:16]
            content_key = hashlib.sha256(text.encode()).hexdigest()[:16]
            dedupe = f"note:{source_key}:{content_key}"
            if conn.execute("SELECT 1 FROM memories WHERE dedupe_key = ?", (dedupe,)).fetchone():
                counts["unchanged"] += 1
                continue
            title, body = _title_body(text, path)
            memory_id = store.add_memory(
                conn,
                project_id=project.id,
                kind="native_note",
                title=title,
                body=body,
                source="native",
                trust="agent",
                importance=0.4,
                origin=origin,
                dedupe=dedupe,
                at=timeutil.iso(datetime.fromtimestamp(path.stat().st_mtime, UTC)),
            )
            if memory_id is None:
                counts["unchanged"] += 1
                continue
            conn.execute(
                "UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE dedupe_key LIKE ? AND id != ? "
                "AND invalid_at IS NULL",
                (timeutil.iso(), memory_id, f"note:{source_key}:%", memory_id),
            )
            counts["stored"] += 1
    return counts
