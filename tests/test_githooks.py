"""The commit-msg hook in .githooks (AGENTS.md R10)."""

import shutil
import subprocess
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[1] / ".githooks" / "commit-msg"


@pytest.mark.skipif(shutil.which("sh") is None, reason="needs a POSIX shell")
@pytest.mark.parametrize(
    ("message", "ok"),
    [
        ("cli: run uv after upgrade exits on Windows\n\nWindows locks Scripts.\n", True),
        ("Merge branch 'mein'\n", True),
        ("Windows-Upgrade: uv läuft erst später\n", False),  # area must be lower case
        ("cli: " + "x" * 70 + "\n", False),  # longer than 72
        ("cli: stop the viewer first.\n", False),
        ("cli: stop the viewer first\nno blank line\n", False),
        ("cli: stop the viewer first\n\nCo-Authored-By: someone\n", False),
        ("stop the viewer first\n", False),
    ],
)
def test_commit_messages(tmp_path: Path, message: str, ok: bool) -> None:
    path = tmp_path / "MSG"
    path.write_text(message, encoding="utf-8")
    done = subprocess.run(["sh", str(HOOK), str(path)], capture_output=True, text=True, check=False)
    assert (done.returncode == 0) is ok, done.stderr
