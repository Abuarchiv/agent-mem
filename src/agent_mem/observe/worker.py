"""The observer worker: ``agent-mem observe``.

Started detached by the Stop hook. Holds ``observe.lock`` for its whole run (one worker at a time,
Qdrant opened once), drains the queue in bundles, waits ``idle_seconds`` for new work and exits.
No daemon. Every model call is recorded in ``observe_calls``. A bundle that no provider can
handle is stored raw (``kind='summary'``) so nothing is lost.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import re
import sqlite3
import sys
import time
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout

from agent_mem.core import db, logutil, signals, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store, work
from agent_mem.observe import bundle as bundling
from agent_mem.observe import providers, queue, relations, review, summary
from agent_mem.observe.mem0_adapter import Fact, Mem0Adapter

POLL_SECONDS = 2.0
GRAPH_BATCHES = 3
RECENT_CALLS = 10  # the calls per stage and purpose that decide which stage does housekeeping


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
        (
            timeutil.iso(),
            provider,
            purpose,
            round(seconds, 3),
            int(ok),
            chars,
            json.dumps(turn_ids),
            error and error[:300],
        ),
    )


def _calls_today(conn: sqlite3.Connection) -> int:
    return int(conn.execute("SELECT COUNT(*) FROM observe_calls WHERE ts >= ?", (timeutil.iso()[:10],)).fetchone()[0])


def _next_day() -> str:
    """When ``_calls_today`` starts again from zero (UTC midnight)."""
    return timeutil.iso((timeutil.now() + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0))


class Deferred(Exception):
    """No model may be called now: a quota or login failure paused the harness's stages, or the day's calls are
    used up. The turn waits until ``until`` instead of being kept raw without facts."""

    def __init__(self, until: str) -> None:
        super().__init__(until)
        self.until = until


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


def said_by_user(b: bundling.Bundle, pair: tuple[str, str]) -> bool:
    """A command rule ("use pnpm instead of npm") may come only from the developer's prompts (AGENTS.md R5): the
    bundle also holds what tools showed, and a README that says "always use yarn" must not grow into a rule that
    blocks npm. Both names have to appear in what the developer typed. The preference memory itself stays; it is
    shown as data."""
    said = " ".join(
        m["content"] for m in b.messages if m["role"] == "user" and not m["content"].startswith("[harness notice")
    ).lower()
    return all(name.lower() in said for name in pair)


def mirror(conn: sqlite3.Connection, config: Config, b: bundling.Bundle, facts: list[Fact]) -> list[int]:
    ids = []
    for fact in facts:
        kind, text = split_tag(fact.text)
        if signals.about_extraction(text):
            continue
        text = signals.without_line_refs(text)
        title = signals.headline(text) if text else "fact"
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
        if pair is not None and said_by_user(b, pair):
            # "Use pnpm instead of npm" becomes the same rule a typed "pnpm statt npm" creates.
            store.learn_rule(conn, config, b.project_id, pair[0], pair[1], b.turn_ids[-1])
    return ids


def _with_stored(adapter: Mem0Adapter, namespace: str, turn_ids: list[int], facts: list[Fact]) -> list[Fact]:
    """``facts`` plus what mem0 already holds for ``turn_ids`` (its metadata names the turn), new ones first."""
    stored = adapter.memory.get_all(filters={"user_id": namespace, "turn_id": {"in": turn_ids}}, top_k=200)
    seen = {fact.id for fact in facts}
    return facts + [
        Fact(id=str(r["id"]), text=str(r["memory"]), metadata=dict(r.get("metadata") or {}))
        for r in stored.get("results", [])
        if str(r["id"]) not in seen
    ]


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
            "graph_relations": 0,
        }

    @property
    def adapter(self) -> Mem0Adapter:
        if self._adapter is None:
            instructions = (Path(__file__).with_name("coding_instructions.md")).read_text(encoding="utf-8")
            # The initial LLM is replaced per stage in process(); "claude" needs no client or server.
            self._adapter = Mem0Adapter(
                self.config, llm="claude", llm_model=self.config.observe.claude_model, custom_instructions=instructions
            )
        return self._adapter

    # --- one bundle --------------------------------------------------------------------------
    def process(self, b: bundling.Bundle) -> str:
        chain = providers.chain(self.config, b.harness, self.conn)
        if not chain and (until := providers.resumes_at(self.config, b.harness, self.conn)):
            raise Deferred(until)
        if chain:
            try:
                self.adapter  # noqa: B018  (builds mem0 once; without an embedder there is only the raw stage)
            except RuntimeError as error:
                logutil.write(self.config.log_dir, "observe", error=f"adapter: {error}")
                with contextlib.suppress(sqlite3.Error):
                    db.record_health(self.conn, "observer", f"facts unavailable, turns kept raw: {error}")
                chain = []
        if chain and _calls_today(self.conn) >= self.config.observe.daily_limit:
            chain = [name for name in chain if name == "ollama"]
            if not chain:
                raise Deferred(_next_day())
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
            except Exception as error:  # provider, mem0 or JSON failure: try the next stage, keep the turn
                # mem0 raises the provider's error as the cause of its own LLMError; unwrapped, a usage limit or
                # a logged-out CLI pauses the stage instead of failing every turn.
                failure = providers.provider_error(error)
                text = str(failure) if failure else logutil.describe(error)
                _record_call(
                    self.conn, name, "extract", time.perf_counter() - started, False, b.chars, b.turn_ids, text
                )
                if failure:
                    providers.note_failure(self.conn, self.config, name, failure)
                last_error = f"{name}: {text}"
                continue
            # mem0 stores the facts before SQLite takes them. After a failure in between (a long write lock, a killed
            # worker) the retry shows the model its own facts as existing memories and extracts nothing, so take every
            # fact mem0 holds for these turns; the dedupe key skips the ones already mirrored.
            facts = _with_stored(self.adapter, namespace, b.turn_ids, facts)
            _record_call(self.conn, name, "extract", time.perf_counter() - started, True, b.chars, b.turn_ids, None)
            # Facts and `done` in one transaction, before the slow work-log call: a worker killed in between would
            # extract the bundle again and leave both wordings of every fact in mem0.
            with db.transaction(self.conn):
                added = mirror(self.conn, self.config, b, facts)
                queue.finish(self.conn, b.turn_ids, "done", name)
            self.stats["facts"] += len(added)
            self._work_log(b, llm, name)
            return name
        if last_error:
            raise providers.ProviderError(last_error)
        return "raw"

    def _work_log(self, b: bundling.Bundle, llm: Any, provider: str) -> None:
        """Titles, session summary and lessons in one call. Facts are stored already; a failure here loses none.

        There is no per-bundle contradiction check: both an old and a newer fact stay, with dates, and the agent reads
        them oldest first ("if entries disagree the newer one holds"). The daily review (``observe/review.py``) retires duplicates and replaced facts."""
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
                logutil.describe(error),
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
                logutil.write(self.config.log_dir, "observe", error=f"forget: {logutil.describe(error)}")
                continue
            self.conn.execute("DELETE FROM observe_forget WHERE mem0_id = ?", (row[0],))
            self.stats["forgotten"] += 1
        try:
            self.adapter.scrub(messages=purged)
        except Exception as error:  # retried with the next forget or purge
            logutil.write(self.config.log_dir, "observe", error=f"scrub: {logutil.describe(error)}")
            return
        if purged:
            db.delete_meta(self.conn, store.SCRUB_MESSAGES)

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
            # A turn cut off without a Stop has only its request: the transcript still says what it did.
            work.fill_answers(self.conn, turn_ids, self.config.limits.answer_chars)
            bundles = bundling.build(self.conn, self.config, turn_ids)
        except Exception as error:  # one broken turn must not stop the queue behind it
            queue.fail(self.conn, turn_ids, f"bundle: {logutil.describe(error)}")
            self.stats["failed"] += 1
            return True
        if not bundles:
            queue.finish(self.conn, turn_ids, "done", None)
            return True
        for b in bundles:
            self.stats["bundles"] += 1
            try:
                provider = self.process(b)
            except Deferred as wait:
                queue.defer(self.conn, b.turn_ids, wait.until)
                continue
            except providers.ProviderError as error:
                if until := providers.resumes_at(self.config, b.harness, self.conn):
                    queue.defer(self.conn, b.turn_ids, until)  # the failure paused the stage: wait, keep the attempt
                elif providers.any_left(self.config, b.harness):
                    queue.fail(self.conn, b.turn_ids, str(error))
                    self.stats["failed"] += 1
                else:
                    store_raw(self.conn, b)
                    queue.finish(self.conn, b.turn_ids, "raw", "raw")
                    self.stats["raw"] += 1
                continue
            except Exception as error:
                # Storing failed (a locked database, a bad fact): back off like a provider error, then `failed`, so
                # one poison turn cannot stop all extraction.
                queue.fail(self.conn, b.turn_ids, logutil.describe(error))
                self.stats["failed"] += 1
                continue
            if provider == "raw":
                store_raw(self.conn, b)
                queue.finish(self.conn, b.turn_ids, "raw", "raw")
                self.stats["raw"] += 1
        return True

    def _reindex_if_embedder_changed(self) -> None:
        """The mem0 index holds vectors of one embedder; after an upgrade it is rebuilt from SQLite."""
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
        if not self.config.observe.enabled:  # "stops all model calls" (README); deletions above still reach mem0
            return self.stats
        idle_since = time.monotonic()
        while True:
            if self.step():
                idle_since = time.monotonic()
                continue
            if not drain or time.monotonic() - idle_since >= self.config.observe.idle_seconds:
                break
            time.sleep(POLL_SECONDS)
        self.review_due()
        self.graph_due()
        self.drain_forget()
        return self.stats

    def review_due(self) -> None:
        """The daily review per project (``observe/review.py``), through the vendor the project used last."""
        for project_id in review.due_projects(self.conn):
            if _calls_today(self.conn) >= self.config.observe.daily_limit:
                return
            name = self._provider_for(project_id, "review")
            if name is None:
                continue
            retired = self._housekeeping(
                name, "review", functools.partial(review.review, self.conn, project_id=project_id)
            )
            self.stats["reviewed"] += retired or 0

    def graph_due(self, batches: int = GRAPH_BATCHES) -> None:
        """Read new memories into the graph (``observe/relations.py``), a few batches per run so a backlog
        fills over several runs instead of holding the worker for minutes."""
        held = db.get_meta(self.conn, "observe.graph_hold")
        if held and held > timeutil.iso():
            return
        for _ in range(batches):
            todo = relations.pending(self.conn)
            if not todo or _calls_today(self.conn) >= self.config.observe.daily_limit:
                return
            project_id, rows = todo[0]
            name = self._provider_for(project_id, "graph")
            if name is None:
                return
            extract = functools.partial(relations.extract, self.conn, project_id=project_id, rows=rows)
            stored = self._housekeeping(name, "graph", extract)
            if stored is None:
                # Hold the graph for an hour: a timed-out batch would otherwise be sent again on every worker run.
                db.set_meta(self.conn, "observe.graph_hold", timeutil.iso(timeutil.now() + timedelta(hours=1)))
                return
            self.stats["graph_relations"] += stored

    def _provider_for(self, project_id: str, purpose: str) -> str | None:
        """Of the stages open to the vendors the project already used, the one whose last calls for ``purpose`` failed
        least; the vendor used last on a tie. The vendor used last alone ran OpenCode's free model on the project's
        whole memory: 7 of 26 graph and 12 of 21 review calls a week timed out, against 1 of 16 graph calls with
        claude."""
        harnesses = [
            str(h)
            for (h,) in self.conn.execute(
                "SELECT harness FROM sessions WHERE project_id = ? GROUP BY harness ORDER BY MAX(last_event_at) DESC",
                (project_id,),
            )
        ] or ["claude"]
        names = list(dict.fromkeys(n for h in harnesses for n in providers.chain(self.config, h, self.conn)))

        def success(name: str) -> float:
            rows = self.conn.execute(
                "SELECT ok FROM observe_calls WHERE provider = ? AND purpose = ? ORDER BY id DESC LIMIT ?",
                (name, purpose, RECENT_CALLS),
            ).fetchall()
            return (sum(int(r[0]) for r in rows) + 1) / (len(rows) + 2)  # an untried stage counts as one in two

        return max(names, key=lambda n: (success(n), -names.index(n)), default=None)

    def _housekeeping(self, name: str, purpose: str, call: Callable[[Any], int]) -> int | None:
        """One model call outside extraction (review, graph), recorded like any other. None when it failed: housekeeping
        never stops the worker, and a usage limit or logout still pauses the stage."""
        started = time.perf_counter()
        try:
            result = call(providers.make_llm(name, providers.model_for(self.config, name)))
        except Exception as error:
            text = logutil.describe(error)
            _record_call(self.conn, name, purpose, time.perf_counter() - started, False, 0, [], text)
            if failure := providers.provider_error(error):  # after the record: two timeouts in a row pause the stage
                providers.note_failure(self.conn, self.config, name, failure)
            return None
        _record_call(self.conn, name, purpose, time.perf_counter() - started, True, 0, [], None)
        return result

    def close(self) -> None:
        if self._adapter is not None:
            self._adapter.close()


# A background process may wait for the write lock; with the hooks' 150 ms the worker would abort on any longer write.
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
            logutil.write(config.log_dir, "observe", error=f"aborted: {logutil.describe(error)}")
            with contextlib.suppress(sqlite3.Error):
                db.record_health(conn, "observer", f"worker aborted: {logutil.describe(error)}")
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
    # Every kind the observer mirrors (``mirror``), with the tag it was extracted with: without decisions, dead ends
    # and rules in mem0 the next extraction writes them again as new.
    tags = {kind: tag for tag, kind in _KINDS.items() if kind != "fact"}
    rows = conn.execute(
        "SELECT id, project_id, kind, body, turn_id, origin FROM memories "
        "WHERE invalid_at IS NULL AND dedupe_key LIKE 'mem0:%' ORDER BY id"
    ).fetchall()
    adapter = Mem0Adapter(config, llm="fake")  # no extraction; add_raw only embeds
    try:
        adapter.reindex([])  # wipe
        count = 0
        for row in rows:
            tag = tags.get(str(row["kind"]))
            facts = adapter.add_raw(
                [f"[{tag}] {row['body']}" if tag else str(row["body"])],
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
    """Rebuild Qdrant, the entity store and history.db from the valid facts in SQLite.

    mem0 assigns new ids, so the mirror's ``dedupe_key`` is rewritten to the new id. No model call.
    """
    lock = FileLock(str(config.observe_lock_path))
    lock.acquire(timeout=30)
    conn = db.connect(config, busy_timeout_ms=BUSY_TIMEOUT_MS)
    try:
        total = int(
            conn.execute(
                "SELECT COUNT(*) FROM memories WHERE invalid_at IS NULL AND dedupe_key LIKE 'mem0:%'"
            ).fetchone()[0]
        )
        count = _reindex(config, conn)
        return {"facts": count, "skipped": total - count}
    finally:
        conn.close()
        lock.release()
