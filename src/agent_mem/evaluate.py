"""Retrieval evaluation (docs/PLAN.md §8).

Two data sets, two backends:

* ``longmemeval``: LongMemEval-S items (``question``, ``haystack_sessions``, ``haystack_session_ids``,
  ``answer_session_ids``, ``question_type``). Reports session-level Recall@k per question type.
  Abstention items (``*_abs``) are skipped because they have no gold session. ``subset`` restricts the
  run to the question ids listed in ``tests/fixtures/longmemeval_subset.json`` (§8: 40 questions).
* ``fixture``: ``tests/fixtures/memory_cases.json``. hit@1 (top result contains an expected substring),
  abstention (no result for unanswerable questions) and contradiction resolution (top result shows the
  current value and none of the obsolete ones).

Backends: ``sqlite`` is the existing stack (capture + FTS5 + vectors + graph), ``mem0`` is the
observer path (:mod:`agent_mem.observe.mem0_adapter`). Each item runs in a fresh data directory.
"""

from __future__ import annotations

import json
import tempfile
import time
from collections import defaultdict
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol

from . import capture, db, semantic, timeutil
from .config import Config, load
from .events import Event

Session = list[dict[str, Any]]


class Backend(Protocol):
    def ingest(self, sessions: list[Session], ids: list[str]) -> None: ...
    def ranked(self, question: str, k: int) -> list[tuple[str, str, float]]:
        """(session_id, text, score) best first."""
        ...

    def close(self) -> None: ...


# --- sqlite backend (existing stack) ----------------------------------------------------------


class SqliteBackend:
    def __init__(self, root: Path, embedder: semantic.Embedder | None) -> None:
        self.config = Config(data_dir=root / "data")
        self.config.semantic.enabled = embedder is not None
        self.cwd = str(root / "project")
        Path(self.cwd).mkdir(parents=True, exist_ok=True)
        self.conn = db.connect(self.config)
        self.embedder = embedder

    def ingest(self, sessions: list[Session], ids: list[str]) -> None:
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
                        self._stop(session_id, ts, answer)
                    capture.apply(
                        self.conn,
                        self.config,
                        Event("claude", "prompt", session_id, ts, cwd=self.cwd, prompt=content),
                        with_context=False,
                    )
                    started = True
                    answer = []
                elif role == "assistant":
                    answer.append(content)
            if started:
                self._stop(session_id, ts, answer)
        if self.embedder is not None:
            semantic.embed_pending(self.conn, self.embedder, limit=100_000)

    def _stop(self, session_id: str, ts: str, answer: list[str]) -> None:
        capture.apply(
            self.conn,
            self.config,
            Event("claude", "stop", session_id, ts, cwd=self.cwd, answer="\n".join(answer)),
            with_context=False,
        )

    def ranked(self, question: str, k: int) -> list[tuple[str, str, float]]:
        project = self.conn.execute("SELECT id FROM projects").fetchone()[0]
        retriever = semantic.Retriever(self.conn, self.config, self.embedder)
        hits = retriever.search(question, project, limit=k, record_shown=False)
        out = []
        for hit in hits:
            native = str(getattr(hit, "session_id", "") or "").split(":", 1)[-1]
            text = hit.text or semantic.owner_text(self.conn, hit.owner) or ""
            out.append((native, text, float(hit.score or 0.0)))
        return out

    def close(self) -> None:
        self.conn.close()


# --- mem0 backend (observer path) -------------------------------------------------------------


class Mem0Backend:
    NAMESPACE = "eval|p:fixture"

    def __init__(
        self,
        root: Path,
        embedder: semantic.Embedder | None,
        *,
        llm: str,
        llm_model: str | None,
        custom_instructions: str | None,
    ) -> None:
        from .observe.mem0_adapter import Mem0Adapter

        self.adapter = Mem0Adapter(
            Config(data_dir=root / "data"),
            llm=llm,
            llm_model=llm_model,
            custom_instructions=custom_instructions,
            embedder=embedder,
            mem0_dir=root / "data" / "mem0",
        )
        self.add_seconds: list[float] = []

    def ingest(self, sessions: list[Session], ids: list[str]) -> None:
        for session, session_id in zip(sessions, ids, strict=False):
            messages = [
                {"role": str(m.get("role")), "content": str(m.get("content") or "")}
                for m in session
                if m.get("role") in ("user", "assistant") and m.get("content")
            ]
            if not messages:
                continue
            started = time.perf_counter()
            self.adapter.extract(messages, self.NAMESPACE, metadata={"session_id": session_id})
            self.add_seconds.append(time.perf_counter() - started)

    def ranked(self, question: str, k: int) -> list[tuple[str, str, float]]:
        facts = self.adapter.search(question, self.NAMESPACE, k=k)
        return [(str(f.metadata.get("session_id", "")), f.text, float(f.score or 0.0)) for f in facts]

    def close(self) -> None:
        self.adapter.close()


# --- runner -----------------------------------------------------------------------------------


class Runner:
    def __init__(
        self,
        backend: str = "sqlite",
        *,
        semantic_search: bool = True,
        llm: str = "ollama",
        llm_model: str | None = None,
        custom_instructions: str | None = None,
        min_score: float = 0.0,
    ) -> None:
        self.backend = backend
        self.llm, self.llm_model, self.custom_instructions = llm, llm_model, custom_instructions
        self.min_score = min_score
        base_config = load()
        self.embedder = semantic.load_embedder(base_config, allow_download=True) if semantic_search else None
        self.add_seconds: list[float] = []

    def open(self, root: Path) -> Backend:
        if self.backend == "mem0":
            return Mem0Backend(
                root,
                self.embedder,
                llm=self.llm,
                llm_model=self.llm_model,
                custom_instructions=self.custom_instructions,
            )
        return SqliteBackend(root, self.embedder)

    def _collect(self, backend: Backend) -> None:
        self.add_seconds.extend(getattr(backend, "add_seconds", []))

    def longmemeval(
        self, dataset: Path, *, ks: tuple[int, ...] = (5, 10), limit: int | None = None, subset: Path | None = None
    ) -> dict[str, Any]:
        items = json.loads(dataset.read_text(encoding="utf-8"))
        if subset:
            wanted = {s["question_id"] for s in json.loads(subset.read_text(encoding="utf-8"))["items"]}
            items = [i for i in items if i["question_id"] in wanted]
        if limit:
            items = items[:limit]
        per_type: dict[str, list[dict[int, float]]] = defaultdict(list)
        for item in items:
            if str(item.get("question_id", "")).endswith("_abs"):
                continue
            with tempfile.TemporaryDirectory() as tmp:
                backend = self.open(Path(tmp))
                backend.ingest(item["haystack_sessions"], [str(i) for i in item["haystack_session_ids"]])
                ranked_sessions: list[str] = []
                for session_id, _text, _score in backend.ranked(item["question"], max(ks) * 3):
                    if session_id and session_id not in ranked_sessions:
                        ranked_sessions.append(session_id)
                gold = {str(s) for s in item["answer_session_ids"]}
                per_type[item.get("question_type", "all")].append(
                    {k: float(bool(gold & set(ranked_sessions[:k]))) for k in ks}
                )
                self._collect(backend)
                backend.close()
        report: dict[str, Any] = {}
        all_scores: list[dict[int, float]] = []
        for kind, scores in sorted(per_type.items()):
            all_scores.extend(scores)
            report[kind] = {f"R@{k}": round(sum(s[k] for s in scores) / len(scores), 4) for k in ks} | {
                "n": len(scores)
            }
        if all_scores:
            report["overall"] = {f"R@{k}": round(sum(s[k] for s in all_scores) / len(all_scores), 4) for k in ks} | {
                "n": len(all_scores)
            }
        report["meta"] = self._meta()
        return report

    def fixture(self, path: Path) -> dict[str, Any]:
        data = json.loads(path.read_text(encoding="utf-8"))
        hits: list[int] = []
        abstains: list[int] = []
        resolved: list[int] = []
        details: list[dict[str, Any]] = []
        for case in data["cases"]:
            with tempfile.TemporaryDirectory() as tmp:
                backend = self.open(Path(tmp))
                sessions = case["history"]
                backend.ingest(sessions, [f"{case['id']}-s{i}" for i in range(len(sessions))])
                ranked = [r for r in backend.ranked(case["question"], 5) if r[2] >= self.min_score]
                top = ranked[0][1].lower() if ranked else ""
                if case.get("abstain"):
                    ok = not ranked
                    abstains.append(int(ok))
                else:
                    ok = any(e.lower() in top for e in case["expect_any"])
                    hits.append(int(ok))
                details.append(
                    {"id": case["id"], "ok": ok, "top": top[:160], "score": ranked[0][2] if ranked else None}
                )
                self._collect(backend)
                backend.close()
        for pair in data.get("contradictions", []):
            with tempfile.TemporaryDirectory() as tmp:
                backend = self.open(Path(tmp))
                backend.ingest(pair["before"], [f"{pair['id']}-before"])
                backend.ingest(pair["after"], [f"{pair['id']}-after"])
                ranked = backend.ranked(pair["question"], 3)
                texts = [r[1].lower() for r in ranked]
                top = texts[0] if texts else ""
                has_current = any(c.lower() in top for c in pair["current"])
                # A result that states the obsolete value without the current one is a stale fact
                # still being served ("tests run with pytest"). "Switched from pytest to nox" is fine.
                stale = [
                    t
                    for t in texts
                    if any(o.lower() in t for o in pair["obsolete"])
                    and not any(c.lower() in t for c in pair["current"])
                ]
                ok = has_current and not stale
                resolved.append(int(ok))
                details.append({"id": pair["id"], "ok": ok, "top": top[:160], "stale": [s[:100] for s in stale]})
                self._collect(backend)
                backend.close()
        return {
            "hit@1": round(sum(hits) / len(hits), 4) if hits else None,
            "abstention": round(sum(abstains) / len(abstains), 4) if abstains else None,
            "contradictions_resolved": f"{sum(resolved)}/{len(resolved)}",
            "n": {"answerable": len(hits), "abstain": len(abstains), "pairs": len(resolved)},
            "details": details,
            "meta": self._meta(),
        }

    def _meta(self) -> dict[str, Any]:
        meta: dict[str, Any] = {
            "backend": self.backend,
            "embedder": getattr(self.embedder, "model", None),
            "date": timeutil.iso(timeutil.now()),
        }
        if self.backend == "mem0":
            meta |= {
                "llm": self.llm,
                "llm_model": self.llm_model,
                "custom_instructions": bool(self.custom_instructions),
            }
        if self.add_seconds:
            s = sorted(self.add_seconds)
            meta["add_seconds"] = {
                "median": round(s[len(s) // 2], 2),
                "p95": round(s[int(len(s) * 0.95) - 1], 2),
                "n": len(s),
            }
        return meta


def longmemeval(
    dataset: Path, *, ks: tuple[int, ...] = (5, 10), limit: int | None = None, semantic_search: bool = True
) -> dict[str, Any]:
    """Backwards compatible entry point (sqlite backend)."""
    return Runner("sqlite", semantic_search=semantic_search).longmemeval(dataset, ks=ks, limit=limit)
