"""Tiny size-bounded JSONL log. Never logs memory content, only ids, kinds and error types."""

from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path

from . import timeutil

MAX_BYTES = 1_000_000
KEEP = 5


def write(log_dir: Path, name: str, **fields: object) -> None:
    with contextlib.suppress(OSError):
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / f"{name}.log"
        if path.exists() and path.stat().st_size > MAX_BYTES:
            for index in range(KEEP - 1, 0, -1):
                older = log_dir / f"{name}.log.{index}"
                newer = log_dir / (f"{name}.log.{index - 1}" if index > 1 else f"{name}.log")
                if newer.exists():
                    os.replace(newer, older)
        record = {
            "ts": timeutil.iso(),
            **{k: (str(v)[:300] if not isinstance(v, int | float | bool) else v) for k, v in fields.items()},
        }
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
