"""Project identity across moves, late first commits, late remotes, and two repositories with one root commit."""

import shutil
import subprocess
from pathlib import Path

import pytest

from agent_mem.core import identity

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
ENV = {"GIT_AUTHOR_DATE": "2026-10-01T10:00:00Z", "GIT_COMMITTER_DATE": "2026-10-01T10:00:00Z"}


def _git(path: Path, *args: str) -> None:
    import os

    subprocess.run(
        ["git", "-C", str(path), "-c", "user.email=x@y", "-c", "user.name=x", *args],
        check=True,
        capture_output=True,
        env={**os.environ, **ENV},  # a fixed date: two repositories get the same root commit
    )


def _repo(path: Path, commit: bool = True) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    if commit:
        _git(path, "commit", "-q", "--allow-empty", "-m", "first")
    return path


def test_a_project_seen_before_its_first_commit_keeps_its_memory_after_a_move(conn, tmp_path: Path) -> None:
    shop = _repo(tmp_path / "shop", commit=False)
    before = identity.resolve(conn, shop)
    _git(shop, "commit", "-q", "--allow-empty", "-m", "first")
    identity.record_aliases(conn)  # the indexer, between the commit and the move
    moved = shop.rename(tmp_path / "shop-moved")
    after = identity.resolve(conn, moved)
    assert before is not None and after is not None and after.id == before.id


def test_a_remote_added_later_still_names_the_same_project(conn, tmp_path: Path) -> None:
    api = _repo(tmp_path / "api")
    before = identity.resolve(conn, api)
    _git(api, "remote", "add", "origin", "https://github.com/someone/api.git")
    identity.record_aliases(conn)
    clone = tmp_path / "api-clone"
    subprocess.run(["git", "clone", "-q", str(api), str(clone)], check=True, capture_output=True)
    _git(clone, "remote", "set-url", "origin", "https://github.com/someone/api.git")
    assert before is not None and identity.resolve(conn, clone).id == before.id  # type: ignore[union-attr]


def test_two_repositories_with_one_root_commit_stay_two_projects(conn, tmp_path: Path) -> None:
    """Two copies of a template without a remote share their root commit; they were one project with one memory."""
    first = identity.resolve(conn, _repo(tmp_path / "shop"))
    second = identity.resolve(conn, _repo(tmp_path / "api"))
    assert first is not None and second is not None and first.id != second.id


def test_a_worktree_is_still_the_same_project(conn, tmp_path: Path) -> None:
    main = _repo(tmp_path / "shop")
    project = identity.resolve(conn, main)
    _git(main, "worktree", "add", "-q", str(tmp_path / "shop-feature"))
    assert project is not None and identity.resolve(conn, tmp_path / "shop-feature").id == project.id  # type: ignore[union-attr]
