"""Read-only federation of notes that harnesses write themselves.

* Claude Code auto memory: ``~/.claude/projects/<encoded-root>/memory/*.md``
* Codex memories: ``~/.codex/memories/`` (Markdown/text files)

Notes become ``native_note`` memories so that every harness can use them.
A changed file supersedes its previous version; nothing is written back.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from pathlib import Path

from . import db, privacy, store
from .config import Config

MAX_FILES = 500
MAX_BYTES = 64_000


def claude_home() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(override).expanduser() if override else Path.home() / ".claude"


def codex_home() -> Path:
    override = os.environ.get("CODEX_HOME")
    return Path(override).expanduser() if override else Path.home() / ".codex"


def encode_claude_project(root: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", root)


def _title(text: str, fallback: str) -> str:
    match = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
    if match:
        return match.group(1).strip()[:200]
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped and stripped != "---":
            return stripped[:200]
    return fallback


def _ingest(conn: sqlite3.Connection, path: Path, project_id: str | None, origin: str, config: Config) -> bool:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_BYTES:
            return False
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    digest = hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()[:24]
    meta_key = f"fed:{origin}:{path}"
    previous = db.get_meta(conn, meta_key)
    if previous and previous.split(":", 1)[0] == digest:
        return False
    body = privacy.clean_text(raw, 8000)
    with db.transaction(conn):
        memory_id = store.add_memory(
            conn,
            project_id=project_id,
            kind="native_note",
            title=_title(body, path.stem),
            body=body,
            source="native",
            trust="agent",
            importance=0.6,
            origin=origin,
            dedupe=f"native|{origin}|{path}|{digest}",
        )
        if memory_id is None:
            return False
        if previous and ":" in previous:
            old_id = previous.split(":", 1)[1]
            if old_id.isdigit():
                store.supersede(conn, int(old_id), memory_id)
        db.set_meta(conn, meta_key, f"{digest}:{memory_id}")
    return True


def run(conn: sqlite3.Connection, config: Config) -> int:
    imported = 0
    if config.federation.claude:
        base = claude_home() / "projects"
        for row in conn.execute("SELECT id, root FROM projects").fetchall():
            folder = base / encode_claude_project(row["root"]) / "memory"
            if not folder.is_dir():
                continue
            for path in sorted(folder.glob("*.md"))[:MAX_FILES]:
                if path.name.upper() == "MEMORY.MD":
                    continue
                imported += _ingest(conn, path, row["id"], "claude-auto-memory", config)
    if config.federation.codex:
        folder = codex_home() / "memories"
        if folder.is_dir():
            files = [p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in {".md", ".txt"}]
            for path in sorted(files)[:MAX_FILES]:
                imported += _ingest(conn, path, None, "codex-memories", config)
    return imported
