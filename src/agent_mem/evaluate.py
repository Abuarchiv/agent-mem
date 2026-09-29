"""Retrieval evaluation on LongMemEval-S style data.

Input: JSON list of items with ``question``, ``haystack_sessions``, ``haystack_session_ids``,
``answer_session_ids`` and ``question_type``. Reports session-level Recall@k per question type.
Abstention items (``*_abs``) are skipped because they have no gold session.
"""

from __future__ import annotations

import json
import tempfile
from collections import defaultdict
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import capture, db, semantic, timeutil
from .config import Config, load
from .events import Event


def _ingest_sessions(conn, config: Config, cwd: str, sessions: list[list[dict[str, Any]]], ids: list[str]) -> None:
    base = timeutil.now()
    for index, (session, session_id) in enumerate(zip(sessions, ids, strict=False)):
        ts = timeutil.iso(base.replace(microsecond=0) - timedelta(days=len(sessions) - index))
        answer: list[str] = []
        started = False
        for message in session:
            role = message.get("role")
            content = str(message.get("content") or "")
            if role == "user":
                if started:
                    capture.apply(
                        conn,
                        config,
                        Event("claude", "stop", session_id, ts, cwd=cwd, answer="\n".join(answer)),
                        with_context=False,
                    )
                capture.apply(
                    conn, config, Event("claude", "prompt", session_id, ts, cwd=cwd, prompt=content), with_context=False
                )
                started = True
                answer = []
            elif role == "assistant":
                answer.append(content)
        if started:
            capture.apply(
                conn,
                config,
                Event("claude", "stop", session_id, ts, cwd=cwd, answer="\n".join(answer)),
                with_context=False,
            )


def longmemeval(
    dataset: Path, *, ks: tuple[int, ...] = (5, 10), limit: int | None = None, semantic_search: bool = True
) -> dict[str, Any]:
    items = json.loads(dataset.read_text(encoding="utf-8"))
    if limit:
        items = items[:limit]
    per_type: dict[str, list[dict[int, float]]] = defaultdict(list)
    base_config = load()
    embedder = semantic.load_embedder(base_config, allow_download=True) if semantic_search else None
    for item in items:
        if str(item.get("question_id", "")).endswith("_abs"):
            continue
        with tempfile.TemporaryDirectory() as tmp:
            config = Config(data_dir=Path(tmp) / "data")
            config.semantic.enabled = embedder is not None
            cwd = str(Path(tmp) / "project")
            Path(cwd).mkdir()
            conn = db.connect(config)
            _ingest_sessions(
                conn, config, cwd, item["haystack_sessions"], [str(i) for i in item["haystack_session_ids"]]
            )
            if embedder is not None:
                semantic.embed_pending(conn, embedder, limit=100_000)
            project = conn.execute("SELECT id FROM projects").fetchone()[0]
            retriever = semantic.Retriever(conn, config, embedder)
            hits = retriever.search(item["question"], project, limit=max(ks) * 3, record_shown=False)
            ranked_sessions: list[str] = []
            for hit in hits:
                native = str(hit.session_id or "").split(":", 1)[-1]
                if native and native not in ranked_sessions:
                    ranked_sessions.append(native)
            gold = {str(s) for s in item["answer_session_ids"]}
            per_type[item.get("question_type", "all")].append(
                {k: float(bool(gold & set(ranked_sessions[:k]))) for k in ks}
            )
            conn.close()
    report: dict[str, Any] = {}
    all_scores: list[dict[int, float]] = []
    for kind, scores in sorted(per_type.items()):
        all_scores.extend(scores)
        report[kind] = {f"R@{k}": round(sum(s[k] for s in scores) / len(scores), 4) for k in ks} | {"n": len(scores)}
    if all_scores:
        report["overall"] = {f"R@{k}": round(sum(s[k] for s in all_scores) / len(all_scores), 4) for k in ks} | {
            "n": len(all_scores)
        }
    return report
