"""Package layout (ARCHITECTURE.md): lower layers never import upper ones, and imports are absolute."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "agent_mem"
UPPER = {"observe", "cli", "ui", "bench", "mcp"}


def _package(path: Path) -> str:
    parts = path.relative_to(ROOT).parts
    return parts[0] if len(parts) > 1 else "(root)"


def test_core_hooks_and_memory_do_not_import_upper_layers() -> None:
    violations = []
    for path in ROOT.rglob("*.py"):
        source = _package(path)
        for match in re.finditer(r"from agent_mem\.([a-z_]+)", path.read_text(encoding="utf-8")):
            target = match.group(1)
            if source in {"core", "hooks", "memory"} and target in UPPER:
                violations.append((str(path.relative_to(ROOT)), target))
            if source == "core" and target != "core":
                violations.append((str(path.relative_to(ROOT)), target))
    assert violations == []


def test_only_cli_imports_cli() -> None:
    """The viewer, the MCP server and the observer run without the command line; cli sits on top of them."""
    offenders = [
        str(path.relative_to(ROOT))
        for path in ROOT.rglob("*.py")
        if _package(path) not in {"cli", "(root)"}
        and re.search(r"from agent_mem\.cli\b", path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_no_relative_imports() -> None:
    offenders = [
        str(p.relative_to(ROOT))
        for p in ROOT.rglob("*.py")
        if re.search(r"^\s*from \.", p.read_text(encoding="utf-8"), re.M)
    ]
    assert offenders == []
