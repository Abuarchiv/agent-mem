"""What agent-mem (and claude-mem, when its worker runs) give an agent for fixed questions about real past work.

Runs on a fresh copy of the live database per question, so the run itself shifts no ranking (accesses count).
Usage: python bench/versus.py OUT.json QUESTIONS.json [QUESTIONS.json ...]
Env: AM_DB (database to copy), AM_CWD (project folder the questions are about), AM_MODELS (embedding models).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = Path.home() / "Library/Application Support/agent-mem"
LIVE = Path(os.environ.get("AM_DB") or DATA / "memory.db")
MODELS = Path(os.environ.get("AM_MODELS") or DATA / "models")
CWD = os.environ.get("AM_CWD") or str(Path.home() / "Lernen/agent-mem")
CM = "http://127.0.0.1:37777"


def http(path: str, body: object = None) -> str:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(CM + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode()


def claude_mem_up() -> bool:
    try:
        return json.loads(http("/api/health")).get("status") == "ok"
    except OSError:
        return False


def found(text: str, expect: list[str]) -> bool:
    return any(e.lower() in (text or "").lower() for e in expect)


def cm_search(q: str) -> str:
    raw = json.loads(http(f"/api/search?{urllib.parse.urlencode({'query': q, 'project': 'Lernen', 'limit': 5})}"))
    index = raw["content"][0]["text"]
    ids = [int(i) for i in re.findall(r"#(\d+)\b", index)][:5]
    return index + "\n" + (http("/api/observations/batch", {"ids": ids}) if ids else "")


work = Path(tempfile.mkdtemp())
master = work / "master.db"
source, target = sqlite3.connect(LIVE), sqlite3.connect(master)
source.backup(target)
source.close(), target.close()


def fresh() -> Path:
    data = Path(tempfile.mkdtemp(dir=work)) / "data"
    data.mkdir()
    shutil.copy(master, data / "memory.db")
    (data / "models").symlink_to(MODELS)  # search by meaning; without it vectors silently drop out
    return data


def am_hook(payload: dict[str, str]) -> str:
    env = {**os.environ, "AGENT_MEM_DATA_DIR": str(fresh()), "AGENT_MEM_NO_SPAWN": "1", "PYTHONPATH": str(REPO / "src")}
    out = subprocess.run(
        [sys.executable, "-m", "agent_mem", "hook", "claude"],
        input=json.dumps(payload).encode(),
        capture_output=True,
        env=env,
        timeout=60,
        check=False,
    ).stdout.decode()
    try:
        return json.loads(out)["hookSpecificOutput"]["additionalContext"]
    except (ValueError, KeyError):
        return ""


sys.path.insert(0, str(REPO / "src"))
from agent_mem.core import config as config_module  # noqa: E402
from agent_mem.core import db, identity  # noqa: E402
from agent_mem.memory import semantic  # noqa: E402

cfg = config_module.load(fresh())
conn = db.connect(cfg)
retriever = semantic.Retriever(conn, cfg, semantic.load_embedder(cfg, allow_download=False))
project = identity.resolve(conn, CWD, register=False).id


def am_search(q: str) -> str:
    hits = retriever.search(q, project, limit=5, record_shown=False)
    return "\n".join((h.text or "") + "\n" + (semantic.owner_text(conn, h.owner) or "") for h in hits)


def run(cases: list[dict], cm: bool, am_start: str, cm_start: str) -> tuple[dict, list[dict]]:
    rows = []
    for case in cases:
        q = case["q"]
        session = {"session_id": "versus-" + case["id"], "cwd": CWD}
        am_prompt = am_hook({"hook_event_name": "UserPromptSubmit", **session, "prompt": q})
        cm_prompt = (
            json.loads(http("/api/context/semantic", {"q": q, "project": "Lernen", "limit": 5})).get("context") or ""
            if cm
            else ""
        )
        row = {"id": case["id"], "src": case.get("src"), "abstain": bool(case.get("abstain"))}
        row.update(am_prompt_chars=len(am_prompt), cm_prompt_chars=len(cm_prompt))
        if row["abstain"]:
            row.update(am_prompt=bool(am_prompt.strip()), cm_prompt=bool(cm_prompt.strip()))
        else:
            e = case["expect"]
            row.update(
                am_start=found(am_start, e),
                am_prompt=found(am_prompt, e),
                am_search=found(am_search(q), e),
                cm_start=found(cm_start, e),
                cm_prompt=found(cm_prompt, e),
                cm_search=cm and found(cm_search(q), e),
            )
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), file=sys.stderr, flush=True)
    answer = [r for r in rows if not r["abstain"]]
    off = [r for r in rows if r["abstain"]]
    summary = {
        "auto_am": sum(r["am_start"] or r["am_prompt"] for r in answer),
        "search_am": sum(r["am_search"] for r in answer),
        "silent_am": sum(not r["am_prompt"] for r in off),
        "prompt_chars_am": sum(r["am_prompt_chars"] for r in rows),
        "questions": len(answer),
        "offtopic": len(off),
    }
    if cm:
        summary.update(
            auto_cm=sum(r["cm_start"] or r["cm_prompt"] for r in answer),
            search_cm=sum(r["cm_search"] for r in answer),
            silent_cm=sum(not r["cm_prompt"] for r in off),
        )
    return summary, rows


def main() -> None:
    out, sets = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    cm = claude_mem_up()
    am_start = am_hook(
        {"hook_event_name": "SessionStart", "session_id": "versus-start", "cwd": CWD, "source": "startup"}
    )
    cm_start = http("/api/context/inject?project=Lernen") if cm else ""
    report: dict = {"start_chars": {"am": len(am_start), "cm": len(cm_start)}, "sets": {}}
    for path in sets:
        summary, rows = run(json.loads(path.read_text(encoding="utf-8"))["cases"], cm, am_start, cm_start)
        report["sets"][path.stem] = {"summary": summary, "rows": rows}
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v["summary"] for k, v in report["sets"].items()} | {"start_chars": report["start_chars"]}))


main()
