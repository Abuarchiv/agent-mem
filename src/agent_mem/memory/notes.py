"""Notes the harnesses keep themselves, stored as memories without a model call.

Claude Code writes one Markdown file per fact under ``~/.claude/projects/<folder>/memory/``; Codex writes one
summary per session under ``~/.codex/memories/rollout_summaries/``. Both are already distilled, so they are
stored as they are (``kind = native_note``). Each harness loads its own notes itself, so a note is shown only
to the other harnesses (``OWN_NOTES``): Codex learns what Claude Code noted and the other way round.

A changed note replaces the stored one (the old version stays, marked superseded). A deleted Claude Code note is
retired: Claude deletes a note that turned out wrong, and Codex would keep reading it. A deleted Codex summary
stays; Codex prunes those by age, not because they were wrong. Symlinks, hidden files and files over 64 KB are
skipped; source files are never written. Files are read before the write lock is taken (hooks wait on it).
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

from agent_mem.core import db, identity, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store

# The origin each harness's own notes carry; that harness already has them in its context.
OWN_NOTES = {"claude": "claude-auto-memory", "codex": "codex-memory"}
MAX_BYTES = 64 * 1024
# New notes per write transaction: hooks wait 150 ms for the lock, 130 notes in one held it for 300 ms.
BATCH = 20
_FRONT = re.compile(r"\A---\n(.*?)\n---\n?", re.S)
_FIELD = re.compile(r"^\s*(name|description|type):\s*(.+?)\s*$", re.M)
_HEADING = re.compile(r"^#\s+(.+)$", re.M)


def own_notes(harness: str) -> set[str]:
    origin = OWN_NOTES.get(harness)
    return {origin} if origin else set()


def _read(path: Path) -> tuple[str, float] | None:
    """Text and modification time; None for hidden, linked, oversized or vanished files."""
    if path.name.startswith(".") or path.is_symlink():
        return None
    try:
        stat = path.stat()
        if not path.is_file() or stat.st_size > MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace"), stat.st_mtime
    except OSError:
        return None


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _key(path: Path) -> str:
    return hashlib.sha256(str(path).encode()).hexdigest()[:16]


def _transcript_cwd(folder: Path) -> str | None:
    """The working directory Claude Code ran in, from a transcript next to the memory folder: the folder name
    replaces every non-alphanumeric character with '-' and cannot be turned back into a path."""
    for transcript in sorted(folder.glob("*.jsonl"), key=_mtime, reverse=True)[:3]:
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


def claude_notes(root: Path, scanned: set[str] | None = None) -> Iterator[tuple[str, Path, str, float]]:
    """(cwd, path, text, mtime) for Claude Code's topic files; ``MEMORY.md`` is only an index of links. ``scanned``
    collects the folders read completely: a note missing there was deleted. A folder whose transcripts are gone
    (Claude Code removes them after 30 days) cannot be placed in a project and does not count."""
    # Resolved: an Orca profile's ``projects`` links to ~/.claude/projects, and a note keyed by both paths is two notes.
    for folder in sorted((root / "projects").resolve().glob("*/memory")):
        cwd = _transcript_cwd(folder.parent)
        if cwd is None:
            continue
        if scanned is not None:
            scanned.add(_key(folder))
        files = [p for p in sorted(folder.glob("*.md")) if p.name != "MEMORY.md"]
        for path in files:
            read = _read(path)
            if read and read[0].strip():
                yield cwd, path, *read


def codex_notes(root: Path) -> Iterator[tuple[str, Path, str, float]]:
    """(cwd, path, text, mtime) for Codex's per-session summaries; the header names the session's ``cwd``."""
    for path in sorted((root / "memories" / "rollout_summaries").glob("*.md")):
        read = _read(path)
        match = re.search(r"^cwd:\s*(.+?)\s*$", read[0], re.M) if read else None
        if read and match:
            yield match.group(1), path, *read


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
    """Store new and changed notes, retire deleted Claude notes. Returns counts: stored, unchanged, retired, skipped
    (no project, excluded). Takes its own write transaction, only when something changed."""
    from agent_mem.hooks import capture

    counts = {"stored": 0, "unchanged": 0, "retired": 0, "skipped": 0}
    if not config.native_notes:
        return counts
    # Dedupe key note:<path>:<content>:<folder>; the folder says which scan can tell that a note was deleted (another
    # CLAUDE_CONFIG_DIR is another folder). Keys from before the folder part get it on their next scan.
    rows = conn.execute(
        "SELECT id, dedupe_key, origin, invalid_at, superseded_by FROM memories WHERE kind = 'native_note' "
        "AND dedupe_key LIKE 'note:%'"
    ).fetchall()
    stored = {":".join(str(r[1]).split(":")[:3]): (int(r[0]), str(r[1]), r[2], r[3] is None) for r in rows}
    source_of = {int(r[0]): str(r[1]).split(":")[1] for r in rows}
    # Retired here, not by the review or a duplicate merge: deleted (nothing replaces it) or an older version of
    # the same file. Only those come back when the file does; the others stay retired while the text is the same.
    mine = {int(r[0]) for r in rows if r[4] is None or source_of.get(int(r[4])) == source_of[int(r[0])]}
    fresh, rekeyed, revived, scanned, seen = [], [], [], set(), set()
    for origin, found in (
        ("claude-auto-memory", claude_notes(_home("CLAUDE_CONFIG_DIR", ".claude"), scanned)),
        ("codex-memory", codex_notes(_home("CODEX_HOME", ".codex"))),
    ):
        for cwd, path, text, mtime in found:
            source, folder = _key(path), _key(path.parent)
            seen.add(source)
            dedupe = f"note:{source}:{hashlib.sha256(text.encode()).hexdigest()[:16]}"
            if dedupe not in stored:
                fresh.append((origin, cwd, path, text, mtime, f"{dedupe}:{folder}"))
                continue
            counts["unchanged"] += 1
            memory_id, key, _, valid = stored[dedupe]
            if key != f"{dedupe}:{folder}":
                rekeyed.append((f"{dedupe}:{folder}", memory_id))
            if not valid and memory_id in mine:  # restored after a deletion, or changed back to an earlier version
                revived.append((memory_id, source))
    gone = [
        memory_id
        for memory_id, key, origin, valid in stored.values()
        if valid
        and origin == "claude-auto-memory"
        and (parts := key.split(":"))[1] not in seen
        and len(parts) == 4
        and parts[3] in scanned
    ]
    # Git (project lookup) and file reads stay outside the write lock: every hook waits on it.
    new = []
    for origin, cwd, path, text, mtime, dedupe in fresh:
        project = identity.resolve(conn, cwd, register=False)
        if project is None or not capture.capture_allowed(conn, config, project):
            counts["skipped"] += 1
        else:
            new.append((project, origin, cwd, path, text, mtime, dedupe))
    if not (new or rekeyed or revived or gone):
        return counts
    for start in range(0, max(len(new), 1), BATCH):
        with db.transaction(conn):
            if start == 0:
                for key, memory_id in rekeyed:
                    conn.execute("UPDATE memories SET dedupe_key = ? WHERE id = ?", (key, memory_id))
                for memory_id in gone:
                    store.supersede(conn, memory_id, None)
                    counts["retired"] += 1
                for memory_id, source in revived:
                    _revive(conn, memory_id, source)
            for project, origin, cwd, path, text, mtime, dedupe in new[start : start + BATCH]:
                identity.register_project(conn, project, cwd)
                stored_id = _store(conn, project.id, origin, path, text, mtime, dedupe)
                counts["stored" if stored_id is not None else "unchanged"] += 1
    return counts


def _revive(conn: sqlite3.Connection, memory_id: int, source: str) -> None:
    """A note that came back (restored, or changed back to an earlier version) is current again."""
    _replace(conn, source, memory_id)
    conn.execute("UPDATE memories SET invalid_at = NULL, superseded_by = NULL WHERE id = ?", (memory_id,))
    title, body = conn.execute("SELECT title, body FROM memories WHERE id = ?", (memory_id,)).fetchone()
    store.set_search_key(conn, "m", memory_id, f"native_note: {title}\n{body}")


def _store(
    conn: sqlite3.Connection, project_id: str, origin: str, path: Path, text: str, mtime: float, dedupe: str
) -> int | None:
    """Store a new note version and retire the older ones; None when the same version is already stored."""
    title, body = _title_body(text, path)
    memory_id = store.add_memory(
        conn,
        project_id=project_id,
        kind="native_note",
        title=title,
        body=body,
        source="native",
        trust="agent",
        importance=0.4,
        origin=origin,
        dedupe=dedupe,
        at=timeutil.iso(datetime.fromtimestamp(mtime, UTC)),
    )
    if memory_id is not None:
        _replace(conn, dedupe.split(":")[1], memory_id)
    return memory_id


def _replace(conn: sqlite3.Connection, source: str, memory_id: int) -> None:
    """The other stored versions of the note at ``source`` give way to ``memory_id``."""
    for (old,) in conn.execute(
        "SELECT id FROM memories WHERE dedupe_key LIKE ? AND id != ? AND invalid_at IS NULL",
        (f"note:{source}:%", memory_id),
    ).fetchall():
        store.supersede(conn, old, memory_id)
