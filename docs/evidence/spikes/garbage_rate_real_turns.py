"""Phase 0, §8c / E8: extract facts from 20 real turns with mem0 (default prompt vs coding prompt).

Reads the newest Claude Code transcripts on this machine, builds bundles like observe/bundle.py will
(user text, assistant text, tool names and arguments; no tool output), caps them at ~6k tokens, and
runs mem0 extraction with Haiku under the subscription login. Output: JSON with the facts per turn
for manual garbage judgement. Nothing leaves the machine except through the harness binary.

Usage: .venv/bin/python docs/evidence/spikes/garbage_rate_real_turns.py OUT_DIR [N_TURNS] [default,coding]
"""

from __future__ import annotations

import glob
import json
import os
import sys
import tempfile
import time
from pathlib import Path

from agent_mem.core.config import Config
from agent_mem.observe.mem0_adapter import Mem0Adapter

CAP_CHARS = 6000 * 4
ARG_CAP = 2000


def turns_from_transcripts(n: int) -> list[list[dict[str, str]]]:
    files = sorted(glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")), key=os.path.getmtime)[-8:]
    turns: list[list[dict[str, str]]] = []
    for f in files:
        cur: list[dict[str, str]] | None = None
        for line in open(f, errors="ignore"):
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            t, msg = o.get("type"), o.get("message") or {}
            content = msg.get("content")
            if t == "user":
                texts = [content] if isinstance(content, str) else [c["text"] for c in content or [] if c.get("type") == "text"]
                has_result = not isinstance(content, str) and any(c.get("type") == "tool_result" for c in content or [])
                if texts and not has_result:
                    if cur and len(cur) > 1:
                        turns.append(cur)
                    cur = [{"role": "user", "content": "\n".join(texts)}]
            elif t == "assistant" and cur is not None:
                for c in content or []:
                    if c.get("type") == "text" and c["text"].strip():
                        cur.append({"role": "assistant", "content": c["text"]})
                    elif c.get("type") == "tool_use":
                        args = json.dumps(c.get("input", {}), ensure_ascii=False)[:ARG_CAP]
                        cur.append({"role": "assistant", "content": f"[tool {c.get('name')}] {args}"})
        if cur and len(cur) > 1:
            turns.append(cur)
    # newest first, skip trivial turns, cap size
    picked = []
    for turn in reversed(turns):
        if sum(len(m["content"]) for m in turn) < 200:
            continue
        total = 0
        capped = []
        for m in turn:
            if total + len(m["content"]) > CAP_CHARS:
                break
            capped.append(m)
            total += len(m["content"])
        picked.append(capped)
        if len(picked) >= n:
            break
    return picked


def main() -> None:
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    turns = turns_from_transcripts(n)
    coding = (Path(__file__).resolve().parents[3] / "src/agent_mem/observe/coding_instructions.md").read_text()
    prompts = {"default": None, "coding": coding}
    wanted = sys.argv[3].split(",") if len(sys.argv) > 3 else list(prompts)
    for name, instr in ((name, prompts[name]) for name in wanted):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Mem0Adapter(Config(data_dir=Path(tmp) / "data"), llm="claude", custom_instructions=instr)
            rows = []
            for i, turn in enumerate(turns):
                started = time.perf_counter()
                facts = adapter.extract(turn, "eval|p:real", {"turn": i})
                rows.append(
                    {
                        "turn": i,
                        "chars": sum(len(m["content"]) for m in turn),
                        "seconds": round(time.perf_counter() - started, 1),
                        "user": turn[0]["content"][:200],
                        "facts": [f.text for f in facts],
                    }
                )
                print(name, i, len(facts), "facts", rows[-1]["seconds"], "s", flush=True)
            adapter.close()
        (out_dir / f"real_turns_{name}.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
