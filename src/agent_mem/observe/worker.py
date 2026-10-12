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
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from agent_mem.core import db, logutil, signals, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store
from agent_mem.observe import bundle as bundling
from agent_mem.observe import concepts, providers, queue, review, summary
from agent_mem.observe.mem0_adapter import Fact, Mem0Adapter

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


_TAG = re.compile(r"^\s*\[(decision|rule|dead_end|fact)\]\s*", re.IGNORECASE)
_KINDS = {"decision": "decision", "rule": "preference", "dead_end": "dead_end", "fact": "fact"}


def split_tag(text: str) -> tuple[str, str]:
    """(kind, text without tag) for a memory written with the tags of ``coding_instructions.md``."""
    match = _TAG.match(text)
    if match is None:
        return "fact", text.strip()
    return _KINDS[match.group(1).lower()], text[match.end() :].strip()


def mirror(conn: sqlite3.Connection, config: Config, b: bundling.Bundle, facts: list[Fact]) -> list[int]:
    ids = []
    for fact in facts:
        kind, text = split_tag(fact.text)
        title = signals.headline(text, 160) if text else "fact"
        memory_id = store.add_memory(
            conn,
            project_id=b.project_id,
            kind=kind,
            title=title,
            body=text,
            source="agent",
            trust="observer",
            importance=signals.IMPORTANCE.get(kind, 0.5) if kind != "preference" else 0.85,
            turn_id=b.turn_ids[-1],
            origin=b.harness,
            dedupe=f"mem0:{fact.id}",
        )
        if memory_id:
            ids.append(memory_id)
        pair = signals.canonical_rule(text) if kind == "preference" else None
        if pair is not None:
            # "Use pnpm instead of npm" becomes the same rule a typed "pnpm statt npm" creates.
            store.learn_rule(conn, config, b.project_id, pair[0], pair[1], b.turn_ids[-1])
    return ids


class Worker:
    def __init__(self, config: Config, conn: sqlite3.Connection, *, adapter: Mem0Adapter | None = None) -> None:
        self.config = config
        self.conn = conn
        self._adapter = adapter
        self.stats: dict[str, int] = {
            "bundles": 0,
            "facts": 0,
            "raw": 0,
            "failed": 0,
            "lessons": 0,
            "forgotten": 0,
            "titled": 0,
            "reviewed": 0,
        }

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
        if chain:
            try:
                self.adapter  # noqa: B018  (builds mem0 once; without an embedder there is only the raw stage)
            except RuntimeError as error:
                logutil.write(self.config.log_dir, "observe", error=f"adapter: {error}"[:200])
                with contextlib.suppress(sqlite3.Error):
                    db.record_health(self.conn, "observer", f"facts unavailable, turns kept raw: {error}")
                chain = []
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
            # Facts and `done` in one transaction, before the slow work-log call: a worker killed in between
            # extracted the bundle again, and mem0 kept both wordings of every fact.
            with db.transaction(self.conn):
                mirror(self.conn, self.config, b, facts)
                queue.finish(self.conn, b.turn_ids, "done", name)
            self.stats["facts"] += len(facts)
            self._work_log(b, llm, name)
            return name
        if last_error:
            raise providers.ProviderError(last_error)
        return "raw"

    def _work_log(self, b: bundling.Bundle, llm: Any, provider: str) -> None:
        """Titles, session summary and lessons in one call. Facts are stored already; a failure here loses none.

        There is no per-bundle contradiction check: both an old and a newer fact stay, with dates, and the agent reads
        them oldest first ("if entries disagree the newer one holds"). On LongMemEval-S every knowledge-update
        question had both versions in the top 5 (All@5 1.0, n = 72), and mem0 2.x dropped its UPDATE/DELETE phase
        for the same reason. The daily review (``observe/review.py``) retires duplicates and replaced facts."""
        started = time.perf_counter()
        try:
            titled, learned, chars = summary.summarize(self.conn, llm, b.session_id, b.turn_ids)
        except Exception as error:
            _record_call(
                self.conn,
                provider,
                "summary",
                time.perf_counter() - started,
                False,
                0,
                b.turn_ids,
                f"{type(error).__name__}: {error}"[:300],
            )
            return
        _record_call(self.conn, provider, "summary", time.perf_counter() - started, True, chars, b.turn_ids, None)
        self.stats["titled"] += titled
        self.stats["lessons"] += learned

    # --- loop ----------------------------------------------------------------------------------
    def drain_forget(self) -> None:
        rows = self.conn.execute("SELECT mem0_id FROM observe_forget").fetchall()
        purged = db.get_meta(self.conn, store.SCRUB_MESSAGES) == "1"
        if not rows and not purged:
            return
        for row in rows:
            try:
                self.adapter.forget(str(row[0]))  # False when mem0 no longer has it: done as well
            except Exception as error:
                # Keep the request: a deleted fact must not stay in the vector index because Qdrant was busy once.
                logutil.write(self.config.log_dir, "observe", error=f"forget: {type(error).__name__}: {error}"[:200])
                continue
            self.conn.execute("DELETE FROM observe_forget WHERE mem0_id = ?", (row[0],))
            self.stats["forgotten"] += 1
        try:
            self.adapter.scrub(messages=purged)
        except Exception as error:  # retried with the next forget or purge
            logutil.write(self.config.log_dir, "observe", error=f"scrub: {type(error).__name__}: {error}"[:200])
            return
        if purged:
            self.conn.execute("DELETE FROM meta WHERE key = ?", (store.SCRUB_MESSAGES,))

    def step(self) -> bool:
        """Process one leased bundle. Returns False when nothing was due."""
        queue.expire_leases(self.conn)
        rows = queue.lease_bundle(
            self.conn, max_turns=self.config.observe.bundle_turns, lease_seconds=self.config.observe.lease_seconds
        )
        if not rows:
            return False
        turn_ids = [int(r["turn_id"]) for r in rows]
        try:
            bundles = bundling.build(self.conn, self.config, turn_ids)
        except Exception as error:  # one broken turn must not stop the queue behind it
            queue.fail(self.conn, turn_ids, f"bundle: {type(error).__name__}: {error}")
            self.stats["failed"] += 1
            return True
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
            except Exception as error:
                # Storing failed (a locked database, a bad fact): back off like a provider error, then `failed`.
                # Before, the run aborted and the same bundle came first again after its lease: a poison turn
                # stopped all extraction.
                queue.fail(self.conn, b.turn_ids, f"{type(error).__name__}: {error}")
                self.stats["failed"] += 1
                continue
            if provider == "raw":
                store_raw(self.conn, b)
                queue.finish(self.conn, b.turn_ids, "raw", "raw")
                self.stats["raw"] += 1
        return True

    def _reindex_if_embedder_changed(self) -> None:
        """The mem0 index holds vectors of one embedder; after an upgrade it is rebuilt from SQLite (I7)."""
        model = self.config.semantic.model
        previous = db.get_meta(self.conn, "observe.embedder")
        if previous == model:
            return
        if previous is not None and (self.config.mem0_dir / "qdrant").exists():
            self.stats["reindexed"] = _reindex(self.config, self.conn)
        with db.transaction(self.conn):
            db.set_meta(self.conn, "observe.embedder", model)

    def run(self, *, drain: bool = True) -> dict[str, int]:
        self._reindex_if_embedder_changed()
        self.drain_forget()
        idle_since = time.monotonic()
        while True:
            if self.step():
                idle_since = time.monotonic()
                continue
            if not drain or time.monotonic() - idle_since >= self.config.observe.idle_seconds:
                break
            time.sleep(POLL_SECONDS)
        self.review_due()
        self.drain_forget()
        self.link_concepts()
        return self.stats

    def link_concepts(self) -> None:
        """Mirror mem0's concepts for new memories (``observe/concepts.py``); spaCy loads with the adapter."""
        try:
            self.adapter  # noqa: B018  (applies observe.entity_model to mem0's spaCy loader)
            while concepts.link_new(self.conn) == concepts.BATCH:
                pass
        except Exception as error:  # the graph is a view; it never stops the worker
            logutil.write(self.config.log_dir, "observe", error=f"concepts: {type(error).__name__}: {error}"[:200])

    def review_due(self) -> None:
        """The daily review per project (``observe/review.py``), through the vendor the project used last."""
        for project_id in review.due_projects(self.conn):
            if _calls_today(self.conn) >= self.config.observe.daily_limit:
                return
            row = self.conn.execute(
                "SELECT harness FROM sessions WHERE project_id = ? ORDER BY last_event_at DESC LIMIT 1", (project_id,)
            ).fetchone()
            chain = providers.chain(self.config, row[0] if row else "claude", self.conn)
            if not chain:
                continue
            name = chain[0]
            started = time.perf_counter()
            try:
                retired = review.review(
                    self.conn, providers.make_llm(name, providers.model_for(self.config, name)), project_id
                )
            except Exception as error:  # the review is housekeeping; it never stops the worker
                _record_call(
                    self.conn,
                    name,
                    "review",
                    time.perf_counter() - started,
                    False,
                    0,
                    [],
                    f"{type(error).__name__}: {error}"[:300],
                )
                continue
            _record_call(self.conn, name, "review", time.perf_counter() - started, True, 0, [], None)
            self.stats["reviewed"] += retired

    def close(self) -> None:
        if self._adapter is not None:
            self._adapter.close()


# A background process may wait for the write lock; the hooks' 150 ms made the worker abort on any longer write.
BUSY_TIMEOUT_MS = 10_000


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
    conn = db.connect(config, busy_timeout_ms=BUSY_TIMEOUT_MS)
    try:
        if retry_failed:
            queue.retry_failed(conn)
        if reprocess_raw:
            queue.reprocess_raw(conn)
        worker = Worker(config, conn)
        try:
            stats = worker.run(drain=drain)
        except BaseException as error:  # the detached process has no stderr; leave a trace (lease expires later)
            logutil.write(config.log_dir, "observe", error=f"aborted: {type(error).__name__}: {error}"[:300])
            with contextlib.suppress(sqlite3.Error):
                db.record_health(conn, "observer", f"worker aborted: {type(error).__name__}: {error}")
            raise
        finally:
            worker.close()
        if stats.get("bundles"):
            with contextlib.suppress(sqlite3.Error):
                db.record_health(conn, "observer")
        logutil.write(config.log_dir, "observe", **{k: str(v) for k, v in stats.items()})
        return stats
    finally:
        conn.close()
        lock.release()


def _reindex(config: Config, conn: sqlite3.Connection) -> int:
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
    with db.transaction(conn):
        db.set_meta(conn, "observe.embedder", config.semantic.model)
    return count


def reindex(config: Config) -> dict[str, int]:
    """Rebuild Qdrant, the entity store and history.db from the valid facts in SQLite (docs/PLAN.md §5).

    mem0 assigns new ids, so the mirror's ``dedupe_key`` is rewritten to the new id. No model call.
    """
    lock = FileLock(str(config.observe_lock_path))
    lock.acquire(timeout=30)
    conn = db.connect(config, busy_timeout_ms=BUSY_TIMEOUT_MS)
    try:
        total = int(
            conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'fact' AND invalid_at IS NULL").fetchone()[0]
        )
        count = _reindex(config, conn)
        return {"facts": count, "skipped": total - count}
    finally:
        conn.close()
        lock.release()
