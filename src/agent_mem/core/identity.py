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

from agent_mem.core import timeutil


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


def _git_backed(project: Project) -> bool:
    return project.remote is not None or (project.root / ".git").exists()


def _nested_repo(path: Path, root: Path) -> bool:
    """True when a ``.git`` lies between ``path`` and ``root`` (exclusive): its own repository. No git spawn."""
    base = _canonical(root)
    for folder in (path, *path.parents):
        if _canonical(folder) == base:
            return False
        if (folder / ".git").exists():
            return True
    return False


def resolve(conn: sqlite3.Connection, cwd: str | Path | None, *, register: bool = True) -> Project | None:
    """Project for ``cwd``. With ``register=False`` nothing is written; call :func:`register_project` later."""
    if not cwd:
        return None
    path = Path(cwd)
    if not path.is_absolute():
        return None
    found = _lookup(conn, path)
    # A parent must not swallow a repository nested below it: neither a plain directory nor a git repository
    # whose folder holds other repositories (~/Lernen with ~/Lernen/agent-mem).
    if found is not None and (
        str(found.root) == _canonical(path) or (_git_backed(found) and not _nested_repo(path, found.root))
    ):
        return found
    if not path.is_dir():  # gone, or a file sent as the working folder: no new project for it
        return found
    toplevel = _git(path, "rev-parse", "--show-toplevel")
    if not toplevel and found is not None:
        if register:
            _register_path(conn, path, found.id)
        return found
    root = Path(toplevel) if toplevel else path
    remote_raw = _git(root, "config", "--get", "remote.origin.url") if toplevel else None
    remote = normalize_remote(remote_raw) if remote_raw else None
    common = _git(root, "rev-parse", "--path-format=absolute", "--git-common-dir") if toplevel else None
    path_source = f"path:{_canonical(Path(common).parent if common else root)}"
    if remote:
        identity_source = f"remote:{remote}"
    elif toplevel and (first := _git(root, "rev-list", "--max-parents=0", "HEAD")):
        # Without a remote the path named the project, so a moved or renamed folder started over with no memory.
        # The first commit stays the same across moves, renames, clones and worktrees.
        # ponytail: in a huge history the walk can pass git's 2 s timeout and the path names it, as before.
        identity_source = f"root:{min(first.split())}"
    else:
        identity_source = path_source
    project_id = _alias(conn, identity_source) or _hash(identity_source)
    if identity_source.startswith("root:") and _held_by_other_repo(conn, project_id, common):
        # Two copies of a template share their root commit; a move leaves no repository behind at the old root.
        project_id = _hash(path_source)
    name = (remote.rsplit("/", 1)[-1] if remote else root.name) or "project"
    project = Project(id=project_id, root=root, name=name, remote=remote)
    if register:
        register_project(conn, project)
    return project


def _hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def _alias(conn: sqlite3.Connection, source: str) -> str | None:
    """The project an identity was recorded for after the fact (``record_aliases``)."""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (f"identity:{source}",)).fetchone()
    return str(row[0]) if row else None


def _held_by_other_repo(conn: sqlite3.Connection, project_id: str, common: str | None) -> bool:
    """The project with this id lives in a repository that still exists and is not this one (worktrees of one
    repository share its git directory)."""
    row = conn.execute("SELECT root FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None or not (Path(row[0]) / ".git").exists():
        return False
    other = _git(Path(row[0]), "rev-parse", "--path-format=absolute", "--git-common-dir")
    return other is not None and common is not None and _canonical(Path(other)) != _canonical(Path(common))


def record_aliases(conn: sqlite3.Connection) -> int:
    """For the indexer, outside the hook path: a project first seen before its first commit or before its remote
    was named by its path; after a move it would have started over. Record its root commit and remote as names of
    the same project. Two git calls per repository. Returns the aliases written."""
    written = 0
    for project_id, root, remote in conn.execute("SELECT id, root, remote FROM projects").fetchall():
        path = Path(root)
        if not (path / ".git").exists():
            continue
        first = _git(path, "rev-list", "--max-parents=0", "HEAD")
        found = _git(path, "config", "--get", "remote.origin.url")
        sources = [f"root:{min(first.split())}"] if first else []
        sources += [f"remote:{normalize_remote(found)}"] if found and not remote else []
        for source in sources:
            natural = _hash(source)
            if natural == project_id or _alias(conn, source) is not None:
                continue
            if conn.execute("SELECT 1 FROM projects WHERE id = ?", (natural,)).fetchone():
                continue  # that name belongs to a project of its own
            conn.execute("INSERT INTO meta(key, value) VALUES (?, ?)", (f"identity:{source}", project_id))
            written += 1
    return written


def register_project(conn: sqlite3.Connection, project: Project, cwd: str | Path | None = None) -> None:
    """Store ``project`` (idempotent). ``cwd`` inside a plain-directory project is mapped too."""
    conn.execute(
        "INSERT INTO projects(id, remote, name, root, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
        (project.id, project.remote, project.name, _canonical(project.root), timeutil.iso()),
    )
    _register_path(conn, project.root, project.id)
    if cwd and not _git_backed(project) and Path(cwd).is_absolute():
        _register_path(conn, Path(cwd), project.id)


def _register_path(conn: sqlite3.Connection, path: Path, project_id: str) -> None:
    conn.execute(
        "INSERT INTO project_paths(path, project_id) VALUES (?, ?) ON CONFLICT(path) DO NOTHING",
        (_canonical(path), project_id),
    )


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
    """Git's blob hash of a file, computed without spawning git, read in chunks (a linked file may be gigabytes)."""
    try:
        with path.open("rb") as fh:
            digest = hashlib.sha1(f"blob {os.fstat(fh.fileno()).st_size}\0".encode(), usedforsecurity=False)
            while chunk := fh.read(1 << 20):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()
