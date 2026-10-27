"""Before a push: fixture, LongMemEval-40 and the versus questions on a frozen copy of the live database, compared with
the baseline measured on that same copy. Exit 1 when a number drops. `--update` freezes a new copy of the live database
and writes its numbers as the new baseline. Without a local agent-mem database there is nothing to measure on: skipped.

The git hook: `.githooks/pre-push`, enabled with `git config core.hooksPath .githooks` (skip once with `git push --no-verify`).
"""

from __future__ import annotations

import atexit
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from agent_mem.core.paths import default_data_dir  # noqa: E402

DATA = default_data_dir()
# The live database grows with every request: measured on it, a baseline drifts without a code change (20 -> 19 on
# 2026-10-26). `--update` freezes a copy next to the eval data; every check after measures that same copy. One copy
# per checkout: a shared one was refrozen by `--update` in another worktree. The baseline sits next to its copy; a
# committed one was compared with every other checkout's copy, and a new checkout overwrote it on its first push.
SNAPSHOT = Path(
    os.environ.get("AM_SNAPSHOT")
    or Path.home() / f".cache/agent-mem/eval/bench-snapshot-{hashlib.sha256(bytes(REPO)).hexdigest()[:8]}.db"
)
BASELINE = SNAPSHOT.with_suffix(".json")
LME = Path(os.environ.get("AM_LME") or Path.home() / ".cache/agent-mem/eval/longmemeval_s.json")
# Higher is better for all of them; prompt_chars only reported (fewer tokens for the same hits is the goal).
TRACKED = {
    "fixture": ("hit@1", "injected_hit@1", "injected_abstention", "mcp_hit@1", "mcp_abstention"),
    "lme40": ("R@5", "All@5"),
    "questions": ("auto_am", "search_am", "silent_am"),
    "questions_new": ("auto_am", "search_am", "silent_am"),
}


def _eval(work: Path, *args: str) -> dict:
    data = work / "eval"
    data.mkdir(exist_ok=True)
    if not (data / "models").exists():
        (data / "models").symlink_to(DATA / "models")
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(data), "AGENT_MEM_NO_SPAWN": "1"}
    out = subprocess.run(
        [sys.executable, "-m", "agent_mem", "eval", *args], capture_output=True, text=True, env=env, check=True
    )
    return json.loads(out.stdout)


def measure() -> dict[str, dict[str, float]]:
    work = Path(tempfile.mkdtemp())
    atexit.register(shutil.rmtree, work, ignore_errors=True)
    numbers = {"fixture": _eval(work, "--fixture", str(REPO / "tests/fixtures/memory_cases.json"))}
    if LME.exists():
        subset = str(REPO / "tests/fixtures/longmemeval_subset.json")
        numbers["lme40"] = _eval(work, str(LME), "--subset", subset)["overall"]
    else:
        print(f"bench: {LME} missing, LongMemEval-40 skipped", file=sys.stderr)
    report = work / "versus.json"
    questions = [str(REPO / "bench" / f"{name}.json") for name in ("questions", "questions_new")]
    subprocess.run([sys.executable, str(REPO / "bench/versus.py"), str(report), *questions], check=True)
    versus = json.loads(report.read_text(encoding="utf-8"))
    for name, part in versus["sets"].items():
        numbers[name] = part["summary"]
    numbers["start"] = {"prompt_chars_start": versus["start_chars"]["am"]}
    return {group: {k: v for k, v in values.items() if k in TRACKED.get(group, ()) or k.startswith("prompt_chars")}
            for group, values in numbers.items()}  # fmt: skip


def freeze() -> None:
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    source, copy = sqlite3.connect(DATA / "memory.db"), sqlite3.connect(SNAPSHOT)
    with copy:
        source.backup(copy)
    source.close()
    copy.close()
    SNAPSHOT.chmod(0o600)  # the developer's own requests and answers


def main() -> int:
    if not (DATA / "memory.db").exists():
        print(f"bench: no agent-mem database at {DATA}, nothing to measure on; skipped", file=sys.stderr)
        return 0
    update = "--update" in sys.argv or not BASELINE.exists() or not SNAPSHOT.exists()
    if update:
        freeze()
    os.environ["AM_DB"] = str(SNAPSHOT)  # bench/versus.py copies it per question
    now = measure()
    if update:
        BASELINE.write_text(json.dumps(now, indent=1) + "\n", encoding="utf-8")
        print(f"bench: baseline written to {BASELINE}")
        return 0
    before = json.loads(BASELINE.read_text(encoding="utf-8"))
    worse = []
    for group, keys in TRACKED.items():
        for key in keys:
            old, new = before.get(group, {}).get(key), now.get(group, {}).get(key)
            if old is not None and new is not None and new < old:
                worse.append(f"{group} {key}: {old} -> {new}")
            print(f"{group:14} {key:20} {old} -> {new}")
    for group, values in now.items():
        for key, value in values.items():
            if key.startswith("prompt_chars"):
                print(f"{group:14} {key:20} {before.get(group, {}).get(key)} -> {value}")
    if worse:
        print(f"bench: worse than {BASELINE}:\n  " + "\n  ".join(worse), file=sys.stderr)
        print(f"Measured on the frozen copy {SNAPSHOT}: the code made it worse, not new data.", file=sys.stderr)
        return 1
    return 0


sys.exit(main())
