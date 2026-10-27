"""What README.md states about the code stays true."""

import dataclasses
import json
import re
from pathlib import Path
from typing import Any

from agent_mem.core.config import Config

README = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")


def _leaves(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, dict):
        return {k: v for key, item in value.items() for k, v in _leaves(item, f"{prefix}{key}.").items()}
    return {prefix.rstrip("."): value}


def test_the_configuration_block_shows_the_defaults(tmp_path: Path) -> None:
    section = README.split("## Configuration", 1)[1]
    shown = json.loads(re.search(r"```json\n(.*?)\n```", section, re.S).group(1))
    defaults = dataclasses.asdict(Config(data_dir=tmp_path))
    actual = _leaves(defaults)
    wrong = {
        key: (value, actual.get(key, "<no such setting>"))
        for key, value in _leaves(shown).items()
        if actual.get(key) != value
    }
    assert not wrong, f"README value != default: {wrong}"
