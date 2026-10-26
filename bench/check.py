"""Before a push: fixture, LongMemEval-40 and the versus questions on a fresh copy of the live database, compared with
bench/baseline.json. Exit 1 when a number drops. `--update` writes the current numbers as the new baseline.

The git hook: `ln -s ../../bench/pre-push .git/hooks/pre-push` (skip once with `git push --no-verify`).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BASELINE = REPO / "bench" / "baseline.json"
DATA = Path.home() / "Library/Application Support/agent-mem"
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


def main() -> int:
    now = measure()
    if "--update" in sys.argv or not BASELINE.exists():
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
        print("bench: worse than bench/baseline.json:\n  " + "\n  ".join(worse), file=sys.stderr)
        print(
            "The live data grows: check out the baseline commit and run this again to tell data from code.",
            file=sys.stderr,
        )
        return 1
    return 0


sys.exit(main())
