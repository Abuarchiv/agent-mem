"""Contradiction and duplicate layer on top of mem0 (docs/PLAN.md §4.6, D7).

mem0 only adds. For every new fact we look up similar existing facts in the same namespace and ask
the model once per bundle which pairs are a KEEP, a SUPERSEDE (new replaces old) or a DUPLICATE
(new repeats old). Verdicts are applied in SQLite (``store.supersede`` / ``invalid_at``) and in
mem0 (``forget``), so neither search nor the next extraction sees the stale fact again.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass

from .. import store, timeutil
from .mem0_adapter import Fact, Mem0Adapter

PROMPT = """You check a coding project's memory for contradictions and duplicates.
Each line below pairs a NEW fact with an OLD fact that is similar to it. For every pair decide:
- SUPERSEDE: the new fact replaces the old one (a correction, an upgrade, a changed decision, a changed value).
- DUPLICATE: the new fact repeats the old one without adding information.
- KEEP: both are true at the same time (different subjects, compatible details, or unrelated).
Answer with JSON only: {"verdicts": [{"pair": <number>, "verdict": "SUPERSEDE"|"DUPLICATE"|"KEEP"}]}.

"""

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@dataclass(frozen=True)
class Pair:
    number: int
    new: Fact
    old: Fact


@dataclass(frozen=True)
class Verdict:
    pair: Pair
    verdict: str  # SUPERSEDE | DUPLICATE | KEEP


def candidates(
    adapter: Mem0Adapter, new_facts: list[Fact], namespace: str, *, min_score: float, max_pairs: int
) -> list[Pair]:
    exclude = frozenset(f.id for f in new_facts)
    pairs: list[Pair] = []
    for fact in new_facts:
        for hit in adapter.search(fact.text, namespace, k=3, exclude=exclude):
            if (hit.score or 0.0) >= min_score:
                pairs.append(Pair(len(pairs) + 1, fact, hit))
            if len(pairs) >= max_pairs:
                return pairs
    return pairs


def render(pairs: list[Pair]) -> str:
    lines = [f"{p.number}. NEW: {p.new.text}\n   OLD: {p.old.text}" for p in pairs]
    return PROMPT + "\n".join(lines)


def parse(text: str, pairs: list[Pair]) -> list[Verdict]:
    data = json.loads(_FENCE.sub("", text.strip()).strip())
    by_number = {p.number: p for p in pairs}
    verdicts = []
    for item in data.get("verdicts", []):
        pair = by_number.get(int(item.get("pair", 0)))
        verdict = str(item.get("verdict", "KEEP")).upper()
        if pair is not None and verdict in {"SUPERSEDE", "DUPLICATE", "KEEP"}:
            verdicts.append(Verdict(pair, verdict))
    return verdicts


def judge(llm, pairs: list[Pair]) -> list[Verdict]:
    """One model call for all pairs of a bundle."""
    if not pairs:
        return []
    text = llm.generate_response([{"role": "user", "content": render(pairs)}], response_format={"type": "json_object"})
    return parse(text, pairs)


def memory_id_for(conn: sqlite3.Connection, mem0_id: str) -> int | None:
    row = conn.execute("SELECT id FROM memories WHERE dedupe_key = ?", (f"mem0:{mem0_id}",)).fetchone()
    return int(row[0]) if row else None


def apply(conn: sqlite3.Connection, adapter: Mem0Adapter, verdicts: list[Verdict]) -> dict[str, int]:
    counts = {"SUPERSEDE": 0, "DUPLICATE": 0, "KEEP": 0}
    seen_new: set[str] = set()
    gone: set[str] = set()  # the same old fact may lose to several new facts in one bundle
    for v in verdicts:
        counts[v.verdict] += 1
        new_id = memory_id_for(conn, v.pair.new.id)
        old_id = memory_id_for(conn, v.pair.old.id)
        if v.verdict == "SUPERSEDE" and new_id is not None and old_id is not None:
            store.supersede(conn, old_id, new_id)
            if v.pair.old.id not in gone:
                gone.add(v.pair.old.id)
                adapter.forget(v.pair.old.id)
        elif v.verdict == "DUPLICATE" and new_id is not None and v.pair.new.id not in seen_new:
            seen_new.add(v.pair.new.id)
            conn.execute(
                "UPDATE memories SET invalid_at = ?, superseded_by = ? WHERE id = ? AND invalid_at IS NULL",
                (timeutil.iso(), old_id, new_id),
            )
            if v.pair.new.id not in gone:
                gone.add(v.pair.new.id)
                adapter.forget(v.pair.new.id)
    return counts
