"""Project identity: one project per repository, shared by clones and worktrees.

Standard library only (hook path). Git is only invoked the first time a directory
is seen; afterwards the mapping comes from ``project_paths``.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import timeutil


@dataclass(frozen=True)
class Project:
    id: str
    root: Path
    name: str
    remote: str | None


def normalize_remote(url: str) -> str:
    text = url.strip()
    text = re.sub(r"^[a-z][a-z0-9+.-]*://", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^[^@/]+@", "", text)
    text = text.replace(":", "/", 1) if re.match(r"^[^/]+:[^/]", text) else text
    text = re.sub(r"\.git/?$", "", text).rstrip("/")
    host, _, rest = text.partition("/")
    return f"{host.lower()}/{rest.lower()}" if rest else host.lower()


def _git(cwd: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _canonical(path: Path) -> str:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path.absolute()
    text = str(resolved)
    return text.lower() if os.name == "nt" else text


def find(conn: sqlite3.Connection, cwd: str | Path) -> Project | None:
    """Known project for ``cwd`` without registering a new one."""
    path = Path(cwd)
    return _lookup(conn, path) if path.is_absolute() else None


def _lookup(conn: sqlite3.Connection, cwd: Path) -> Project | None:
    candidates = [_canonical(cwd), *(_canonical(parent) for parent in cwd.parents)]
    placeholders = ",".join("?" for _ in candidates)
    rows = conn.execute(
        f"SELECT pp.path, p.id, p.root, p.name, p.remote FROM project_paths pp "
        f"JOIN projects p ON p.id = pp.project_id WHERE pp.path IN ({placeholders})",
        candidates,
    ).fetchall()
    if not rows:
        return None
    best = max(rows, key=lambda row: len(row["path"]))
    return Project(id=best["id"], root=Path(best["path"]), name=best["name"], remote=best["remote"])


def resolve(conn: sqlite3.Connection, cwd: str | Path | None) -> Project | None:
    if not cwd:
        return None
    path = Path(cwd)
    if not path.is_absolute():
        return None
    found = _lookup(conn, path)
    if found is not None:
        return found
    if not path.exists():
        return None
    toplevel = _git(path, "rev-parse", "--show-toplevel")
    root = Path(toplevel) if toplevel else path
    remote_raw = _git(root, "config", "--get", "remote.origin.url") if toplevel else None
    remote = normalize_remote(remote_raw) if remote_raw else None
    if remote:
        identity_source = f"remote:{remote}"
    elif toplevel:
        common = _git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
        main_root = Path(common).parent if common else root
        identity_source = f"path:{_canonical(main_root)}"
    else:
        identity_source = f"path:{_canonical(root)}"
    project_id = hashlib.sha256(identity_source.encode("utf-8")).hexdigest()[:16]
    name = (remote.rsplit("/", 1)[-1] if remote else root.name) or "project"
    conn.execute(
        "INSERT INTO projects(id, remote, name, root, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        (project_id, remote, name, _canonical(root), timeutil.iso()),
    )
    conn.execute(
        "INSERT INTO project_paths(path, project_id) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
        (_canonical(root), project_id),
    )
    return Project(id=project_id, root=root, name=name, remote=remote)


def is_within(path: str | Path, root: str | Path) -> bool:
    """True if ``path`` is ``root`` or inside it (case-insensitive on Windows, symlinks resolved)."""
    candidate = _canonical(Path(path))
    base = _canonical(Path(root)).rstrip("/\\")
    return candidate == base or candidate.startswith(base + os.sep) or candidate.startswith(base + "/")


def read_branch(root: Path) -> str | None:
    """Read the current branch from .git/HEAD without spawning git."""
    dot_git = root / ".git"
    try:
        if dot_git.is_file():
            pointer = dot_git.read_text(encoding="utf-8").strip()
            if not pointer.startswith("gitdir:"):
                return None
            git_dir = Path(pointer[7:].strip())
            if not git_dir.is_absolute():
                git_dir = (root / git_dir).resolve()
        elif dot_git.is_dir():
            git_dir = dot_git
        else:
            return None
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if head.startswith("ref: refs/heads/"):
        return head[len("ref: refs/heads/") :]
    return head[:12] if head else None


def relative_path(root: Path, path: str) -> str:
    """Store file paths relative to the project root when possible."""
    candidate = Path(path)
    if not candidate.is_absolute():
        return path.replace("\\", "/")
    try:
        return candidate.resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return candidate.as_posix()


def git_blob_hash(path: Path) -> str | None:
    """Git's blob hash of a file, computed without spawning git."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data, usedforsecurity=False).hexdigest()
