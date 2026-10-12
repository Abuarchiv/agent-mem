"""The observer worker: ``agent-mem observe`` (docs/PLAN.md §4.3 to §4.6).

Started detached by the Stop hook. Holds ``observe.lock`` for its whole run (one worker at a time,
Qdrant opened once, D8), drains the queue in bundles, waits ``idle_seconds`` for new work and exits.
No daemon (R1). Every model call is recorded in ``observe_calls``. A bundle that no provider can
handle is stored raw (``kind='summary'``) so nothing is lost (§7).
"""

from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from .. import db, logutil, store, timeutil
from ..config import Config
from . import bundle as bundling
from . import contradiction, providers, queue
from .mem0_adapter import Fact, Mem0Adapter

POLL_SECONDS = 2.0


def namespace_for(project_id: str | None) -> str:
    user = os.environ.get("USER") or os.environ.get("USERNAME") or "user"
    return f"{user}|p:{project_id or 'none'}"


def _record_call(
    conn: sqlite3.Connection,
    provider: str,
    purpose: str,
    seconds: float,
    ok: bool,
    chars: int,
    turn_ids: list[int],
    error: str | None,
) -> None:
    conn.execute(
        "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids, error) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (timeutil.iso(), provider, purpose, round(seconds, 3), int(ok), chars, json.dumps(turn_ids), error),
    )


def _calls_today(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT COUNT(*) FROM observe_calls WHERE ts >= ?", (timeutil.iso()[:10],)).fetchone()[0])


def _lower_priority() -> None:
    with contextlib.suppress(Exception):
        if sys.platform == "win32":
            import ctypes

            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        else:
            os.nice(10)


def store_raw(conn: sqlite3.Connection, b: bundling.Bundle) -> int:
    """Stage 5: keep prompt and answer as a summary memory, no model."""
    text = "\n\n".join(f"{m['role']}: {m['content']}" for m in b.messages)
    title = next((m["content"].splitlines()[0][:120] for m in b.messages if m["role"] == "user"), "turn")
    memory_id = store.add_memory(
        conn,
        project_id=b.project_id,
        kind="summary",
        title=title,
        body=text[:8000],
        source="hook",
        trust="raw",
        importance=0.3,
        turn_id=b.turn_ids[-1],
        origin=b.harness,
        dedupe=f"raw:{b.turn_ids[0]}-{b.turn_ids[-1]}",
    )
    return memory_id or 0


def mirror(conn: sqlite3.Connection, b: bundling.Bundle, facts: list[Fact]) -> list[int]:
    ids = []
    for fact in facts:
        title = fact.text.strip().splitlines()[0][:120] if fact.text.strip() else "fact"
        memory_id = store.add_memory(
            conn,
            project_id=b.project_id,
            kind="fact",
            title=title,
            body=fact.text,
            source="agent",
            trust="observer",
            importance=0.5,
            turn_id=b.turn_ids[-1],
            origin=b.harness,
            dedupe=f"mem0:{fact.id}",
        )
        if memory_id:
            ids.append(memory_id)
    return ids


class Worker:
    def __init__(self, config: Config, conn: sqlite3.Connection, *, adapter: Mem0Adapter | None = None) -> None:
        self.config = config
        self.conn = conn
        self._adapter = adapter
        self.stats: dict[str, int] = {"bundles": 0, "facts": 0, "raw": 0, "failed": 0, "superseded": 0, "forgotten": 0}

    @property
    def adapter(self) -> Mem0Adapter:
        if self._adapter is None:
            instructions = (Path(__file__).with_name("coding_instructions.md")).read_text(encoding="utf-8")  # E8
            # The initial LLM is replaced per stage in process(); "claude" needs no client or server.
            self._adapter = Mem0Adapter(
                self.config, llm="claude", llm_model=self.config.observe.claude_model, custom_instructions=instructions
            )
        return self._adapter

    # --- one bundle --------------------------------------------------------------------------
    def process(self, b: bundling.Bundle) -> str:
        chain = providers.chain(self.config, b.harness, self.conn)
        if _calls_today(self.conn) >= self.config.observe.daily_limit:
            chain = [name for name in chain if name == "ollama"]
        last_error = None
        for name in chain:
            llm = providers.make_llm(name, providers.model_for(self.config, name))
            started = time.perf_counter()
            try:
                self.adapter.memory.llm = llm
                namespace = namespace_for(b.project_id)
                facts = self.adapter.extract(
                    b.messages, namespace, {"turn_id": b.turn_ids[-1], "session_id": b.session_id, "harness": b.harness}
                )
            except providers.ProviderError as error:
                _record_call(
                    self.conn,
                    name,
                    "extract",
                    time.perf_counter() - started,
                    False,
                    b.chars,
                    b.turn_ids,
                    str(error)[:300],
                )
                providers.note_failure(self.conn, self.config, name, error)
                last_error = f"{name}: {error}"
                continue
            except Exception as error:  # mem0 or JSON failure: try the next stage, keep the turn
                _record_call(
                    self.conn,
                    name,
                    "extract",
                    time.perf_counter() - started,
                    False,
                    b.chars,
                    b.turn_ids,
                    f"{type(error).__name__}: {error}"[:300],
                )
                last_error = f"{name}: {type(error).__name__}: {error}"
                continue
            _record_call(self.conn, name, "extract", time.perf_counter() - started, True, b.chars, b.turn_ids, None)
            mirror(self.conn, b, facts)
            self.stats["facts"] += len(facts)
            self._contradictions(b, facts, llm, name, namespace)
            return name
        if last_error:
            raise providers.ProviderError(last_error)
        return "raw"

    def _contradictions(self, b: bundling.Bundle, facts: list[Fact], llm: Any, provider: str, namespace: str) -> None:
        pairs = contradiction.candidates(
            self.adapter,
            facts,
            namespace,
            min_score=self.config.observe.contradiction_min_score,
            max_pairs=self.config.observe.contradiction_max_pairs,
        )
        if not pairs:
            return
        started = time.perf_counter()
        try:
            verdicts = contradiction.judge(llm, pairs)
        except Exception as error:  # a failed judgement never loses facts; stale ones stay until the next bundle
            _record_call(
                self.conn,
                provider,
                "judge",
                time.perf_counter() - started,
                False,
                len(contradiction.render(pairs)),
                b.turn_ids,
                f"{type(error).__name__}: {error}"[:300],
            )
            return
        _record_call(
            self.conn,
            provider,
            "judge",
            time.perf_counter() - started,
            True,
            len(contradiction.render(pairs)),
            b.turn_ids,
            None,
        )
        try:
            counts = contradiction.apply(self.conn, self.adapter, verdicts)
        except Exception as error:  # facts are mirrored already; a broken verdict must not lose the bundle
            logutil.write(self.config.log_dir, "observe", error=f"apply: {type(error).__name__}: {error}"[:200])
            return
        self.stats["superseded"] += counts["SUPERSEDE"]

    # --- loop ----------------------------------------------------------------------------------
    def drain_forget(self) -> None:
        rows = self.conn.execute("SELECT mem0_id FROM observe_forget").fetchall()
        if not rows:
            return
        for row in rows:
            with contextlib.suppress(Exception):
                self.adapter.forget(str(row[0]))
            self.conn.execute("DELETE FROM observe_forget WHERE mem0_id = ?", (row[0],))
            self.stats["forgotten"] += 1

    def step(self) -> bool:
        """Process one leased bundle. Returns False when nothing was due."""
        queue.expire_leases(self.conn)
        rows = queue.lease_bundle(
            self.conn, max_turns=self.config.observe.bundle_turns, lease_seconds=self.config.observe.lease_seconds
        )
        if not rows:
            return False
        turn_ids = [int(r["turn_id"]) for r in rows]
        bundles = bundling.build(self.conn, self.config, turn_ids)
        if not bundles:
            queue.finish(self.conn, turn_ids, "done", None)
            return True
        for b in bundles:
            self.stats["bundles"] += 1
            try:
                provider = self.process(b)
            except providers.ProviderError as error:
                if providers.any_left(self.config, b.harness, self.conn):
                    queue.fail(self.conn, b.turn_ids, str(error))
                    self.stats["failed"] += 1
                else:
                    store_raw(self.conn, b)
                    queue.finish(self.conn, b.turn_ids, "raw", "raw")
                    self.stats["raw"] += 1
                continue
            if provider == "raw":
                store_raw(self.conn, b)
                queue.finish(self.conn, b.turn_ids, "raw", "raw")
                self.stats["raw"] += 1
            else:
                queue.finish(self.conn, b.turn_ids, "done", provider)
        return True

    def run(self, *, drain: bool = True) -> dict[str, int]:
        self.drain_forget()
        idle_since = time.monotonic()
        while True:
            if self.step():
                idle_since = time.monotonic()
                continue
            if not drain or time.monotonic() - idle_since >= self.config.observe.idle_seconds:
                break
            time.sleep(POLL_SECONDS)
        return self.stats

    def close(self) -> None:
        if self._adapter is not None:
            self._adapter.close()


def run(
    config: Config, *, drain: bool = True, retry_failed: bool = False, reprocess_raw: bool = False
) -> dict[str, Any]:
    """Entry point for ``agent-mem observe``. Returns stats; ``{"skipped": "locked"}`` if a worker is already running."""
    lock = FileLock(str(config.observe_lock_path))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        return {"skipped": "locked"}
    _lower_priority()
    conn = db.connect(config)
    try:
        if retry_failed:
            queue.retry_failed(conn)
        if reprocess_raw:
            queue.reprocess_raw(conn)
        worker = Worker(config, conn)
        try:
            stats = worker.run(drain=drain)
        finally:
            worker.close()
        logutil.write(config.log_dir, "observe", **{k: str(v) for k, v in stats.items()})
        return stats
    finally:
        conn.close()
        lock.release()


def reindex(config: Config) -> dict[str, int]:
    """Rebuild Qdrant, the entity store and history.db from the valid facts in SQLite (docs/PLAN.md §5).

    mem0 assigns new ids, so the mirror's ``dedupe_key`` is rewritten to the new id. No model call.
    """
    lock = FileLock(str(config.observe_lock_path))
    lock.acquire(timeout=30)
    conn = db.connect(config)
    try:
        rows = conn.execute(
            "SELECT id, project_id, body, turn_id, origin FROM memories "
            "WHERE kind = 'fact' AND invalid_at IS NULL AND dedupe_key LIKE 'mem0:%' ORDER BY id"
        ).fetchall()
        adapter = Mem0Adapter(config, llm="fake")  # no extraction; add_raw only embeds
        try:
            adapter.reindex([])  # wipe
            count = 0
            for row in rows:
                facts = adapter.add_raw(
                    [str(row["body"])],
                    namespace_for(row["project_id"]),
                    {"turn_id": row["turn_id"], "harness": row["origin"], "memory_id": int(row["id"])},
                )
                if facts:
                    conn.execute("UPDATE memories SET dedupe_key = ? WHERE id = ?", (f"mem0:{facts[0].id}", row["id"]))
                    count += 1
            conn.execute("DELETE FROM observe_forget")
        finally:
            adapter.close()
        return {"facts": count, "skipped": len(rows) - count}
    finally:
        conn.close()
        lock.release()
