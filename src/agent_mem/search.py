"""Hybrid retrieval: FTS5 (BM25) + optional vectors + entity graph, fused with RRF and re-scored.

The lexical path (used by hooks) is standard library only. Semantic and PageRank
candidates are supplied by callers that may import numpy.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import PurePosixPath

from . import learn, timeutil
from .config import Config
from .store import owner_label

Owner = tuple[str, int]
CandidateSource = Callable[[sqlite3.Connection, str, list[str], str | None, int], list[Owner]]

_TOKEN = re.compile(r"[\w][\w.\-/@+#]*", re.UNICODE)
STOPWORDS = {
    # en
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "what",
    "when",
    "where",
    "which",
    "why",
    "how",
    "was",
    "were",
    "are",
    "you",
    "your",
    "our",
    "can",
    "could",
    "should",
    "would",
    "have",
    "has",
    "had",
    "not",
    "but",
    "all",
    "any",
    "did",
    "does",
    "use",
    "using",
    "please",
    "about",
    "there",
    "then",
    "them",
    "they",
    "its",
    "it's",
    "let",
    "lets",
    "make",
    "need",
    "want",
    "also",
    "just",
    "like",
    "some",
    # de
    "der",
    "die",
    "das",
    "und",
    "oder",
    "aber",
    "mit",
    "für",
    "von",
    "vom",
    "zum",
    "zur",
    "den",
    "dem",
    "des",
    "ein",
    "eine",
    "einen",
    "einem",
    "einer",
    "ist",
    "sind",
    "war",
    "wie",
    "wer",
    "wo",
    "warum",
    "wieso",
    "nicht",
    "auch",
    "noch",
    "schon",
    "bitte",
    "kannst",
    "können",
    "kann",
    "mach",
    "mache",
    "machen",
    "haben",
    "habe",
    "hast",
    "hat",
    "wir",
    "ihr",
    "sie",
    "ich",
    "du",
    "mir",
    "mich",
    "dir",
    "dich",
    "uns",
    "euch",
    "auf",
    "aus",
    "bei",
    "nach",
    "über",
    "unter",
    "dass",
    "wenn",
    "dann",
    "doch",
    "mal",
    "jetzt",
    "hier",
    "dort",
    "soll",
    "sollen",
    "muss",
    "müssen",
    "gibt",
    "alle",
    "alles",
}


@dataclass
class Hit:
    owner: Owner
    score: float = 0.0
    rrf: float = 0.0
    sources: set[str] = field(default_factory=set)
    kind: str = "turn"
    title: str = ""
    text: str = ""
    ts: str = ""
    session_id: str | None = None
    project_id: str | None = None
    harness: str | None = None
    trust: str = "user"
    importance: float = 0.1
    files: list[str] = field(default_factory=list)
    coverage: float = 0.0
    matched_terms: int = 0
    origin: str | None = None

    @property
    def label(self) -> str:
        return owner_label(*self.owner)


def query_terms(text: str, limit: int = 12) -> list[str]:
    terms: list[str] = []
    for match in _TOKEN.finditer(text.lower()):
        token = match.group(0).strip(".-/")
        if len(token) < 3 or token in STOPWORDS or token.isdigit():
            continue
        if token not in terms:
            terms.append(token)
        if len(terms) >= limit:
            break
    return terms


def fts_candidates(conn: sqlite3.Connection, terms: Sequence[str], limit: int = 60) -> list[Owner]:
    usable = [t for t in terms if len(t) >= 3]
    if not usable:
        return []
    expression = " OR ".join('"' + t.replace('"', '""') + '"' for t in usable)
    try:
        rows = conn.execute(
            "SELECT k.owner_type, k.owner_id, bm25(search_fts) AS rank FROM search_fts "
            "JOIN search_keys k ON k.id = search_fts.rowid WHERE search_fts MATCH ? ORDER BY rank LIMIT ?",
            (expression, limit * 3),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    seen: list[Owner] = []
    for row in rows:
        owner = (row["owner_type"], int(row["owner_id"]))
        if owner not in seen:
            seen.append(owner)
        if len(seen) >= limit:
            break
    return seen


def matching_entities(conn: sqlite3.Connection, project_id: str | None, terms: Sequence[str]) -> list[int]:
    if not terms:
        return []
    rows = conn.execute(
        "SELECT id, kind, key FROM entities WHERE project_id IN (?, '') AND kind IN ('file', 'command', 'package')",
        (project_id or "",),
    ).fetchall()
    found: list[int] = []
    lowered = [t.lower() for t in terms]
    for row in rows:
        key = str(row["key"]).lower()
        name = PurePosixPath(key).name if row["kind"] == "file" else key
        if any(term in (name, key) or (len(term) >= 5 and term in key) for term in lowered):
            found.append(int(row["id"]))
    return found[:30]


def graph_candidates_sql(
    conn: sqlite3.Connection, project_id: str | None, terms: list[str], limit: int = 40
) -> list[Owner]:
    """Owners linked to query entities and their strongest 1-hop neighbours (no external deps)."""
    seeds = matching_entities(conn, project_id, terms)
    if not seeds:
        return []
    placeholders = ",".join("?" for _ in seeds)
    neighbours = conn.execute(
        f"SELECT CASE WHEN a IN ({placeholders}) THEN b ELSE a END AS other, MAX(weight) AS w FROM edges "
        f"WHERE a IN ({placeholders}) OR b IN ({placeholders}) GROUP BY other ORDER BY w DESC LIMIT 20",
        (*seeds, *seeds, *seeds),
    ).fetchall()
    weights = {seed: 1.0 for seed in seeds}
    for row in neighbours:
        weights.setdefault(int(row["other"]), float(row["w"]) * 0.5)
    return owners_for_entities(conn, weights, limit)


def owners_for_entities(conn: sqlite3.Connection, weights: dict[int, float], limit: int) -> list[Owner]:
    if not weights:
        return []
    ids = list(weights)
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"SELECT owner_type, owner_id, entity_id FROM links WHERE entity_id IN ({placeholders})", ids
    ).fetchall()
    scores: dict[Owner, float] = {}
    for row in rows:
        owner = (row["owner_type"], int(row["owner_id"]))
        scores[owner] = scores.get(owner, 0.0) + weights[int(row["entity_id"])]
    ranked = sorted(scores, key=lambda o: (scores[o], o[1]), reverse=True)
    return ranked[:limit]


def rrf(lists: dict[str, list[Owner]], k: int) -> dict[Owner, tuple[float, set[str]]]:
    fused: dict[Owner, tuple[float, set[str]]] = {}
    for name, owners in lists.items():
        for rank, owner in enumerate(owners):
            score, sources = fused.get(owner, (0.0, set()))
            fused[owner] = (score + 1.0 / (k + rank + 1), sources | {name})
    return fused


def load_hits(conn: sqlite3.Connection, owners: list[Owner]) -> dict[Owner, Hit]:
    hits: dict[Owner, Hit] = {}
    turn_ids = [o[1] for o in owners if o[0] == "t"]
    mem_ids = [o[1] for o in owners if o[0] == "m"]
    if turn_ids:
        placeholders = ",".join("?" for _ in turn_ids)
        for row in conn.execute(
            f"SELECT t.id, t.session_id, t.project_id, t.started_at, t.prompt, t.answer, t.importance, t.trust, "
            f"t.files_json, t.commands_json, t.errors_json, t.outcome, s.harness FROM turns t "
            f"JOIN sessions s ON s.id = t.session_id WHERE t.id IN ({placeholders})",
            turn_ids,
        ):
            files = json.loads(row["files_json"] or "[]")
            text = "\n".join(
                part
                for part in (
                    row["prompt"],
                    row["answer"],
                    " ".join(files),
                    " ".join(json.loads(row["commands_json"] or "[]")),
                    " ".join(json.loads(row["errors_json"] or "[]")),
                )
                if part
            )
            hits[("t", row["id"])] = Hit(
                owner=("t", row["id"]),
                kind="turn",
                title=(row["prompt"] or row["answer"] or "").strip().splitlines()[0][:160]
                if (row["prompt"] or row["answer"])
                else "",
                text=text,
                ts=row["started_at"],
                session_id=row["session_id"],
                project_id=row["project_id"],
                harness=row["harness"],
                trust=row["trust"],
                importance=row["importance"],
                files=files,
            )
    if mem_ids:
        placeholders = ",".join("?" for _ in mem_ids)
        for row in conn.execute(
            f"SELECT m.*, t.session_id AS session_id FROM memories m LEFT JOIN turns t ON t.id = m.turn_id "
            f"WHERE m.id IN ({placeholders}) AND m.invalid_at IS NULL",
            mem_ids,
        ):
            hits[("m", row["id"])] = Hit(
                owner=("m", row["id"]),
                kind=row["kind"],
                title=row["title"],
                text=f"{row['title']}\n{row['body']}",
                ts=row["created_at"],
                session_id=row["session_id"],
                project_id=row["project_id"],
                trust=row["trust"],
                importance=row["importance"],
                origin=row["origin"],
            )
    return hits


def coverage(text: str, terms: Sequence[str]) -> tuple[float, int]:
    if not terms:
        return 0.0, 0
    lowered = text.lower()
    matched = sum(1 for term in terms if term in lowered)
    return matched / len(terms), matched


@dataclass
class Query:
    text: str
    project_id: str | None
    exclude_session: str | None = None
    limit: int = 8
    include_other_projects: bool = False
    since: datetime | None = None
    until: datetime | None = None
    kinds: set[str] | None = None
    exclude_origins: set[str] = field(default_factory=set)


def search(
    conn: sqlite3.Connection,
    config: Config,
    query: Query,
    *,
    vector_source: Callable[[str, int], list[Owner]] | None = None,
    graph_source: Callable[[sqlite3.Connection, str | None, list[str], int], list[Owner]] | None = None,
    record_shown: bool = False,
    now: datetime | None = None,
) -> list[Hit]:
    terms = query_terms(query.text)
    lists: dict[str, list[Owner]] = {"fts": fts_candidates(conn, terms)}
    lists["graph"] = (graph_source or graph_candidates_sql)(conn, query.project_id, terms, 40)
    if vector_source is not None:
        lists["vector"] = vector_source(query.text, 60)
    fused = rrf(lists, config.retrieval.rrf_k)
    if not fused:
        return []
    hits = load_hits(conn, list(fused))
    max_rrf = len([name for name, owners in lists.items() if owners]) / (config.retrieval.rrf_k + 1)
    candidates: list[Hit] = []
    for owner, (score, sources) in fused.items():
        hit = hits.get(owner)
        if hit is None:
            continue
        if query.exclude_session and hit.session_id == query.exclude_session:
            continue
        same_project = hit.project_id == query.project_id
        is_global = hit.project_id is None
        if not (same_project or is_global or query.include_other_projects):
            continue
        if query.kinds and hit.kind not in query.kinds:
            continue
        if hit.origin and hit.origin in query.exclude_origins:
            continue
        stamp = timeutil.parse(hit.ts)
        if query.since and stamp and stamp < query.since:
            continue
        if query.until and stamp and stamp >= query.until:
            continue
        hit.rrf = score / max_rrf if max_rrf else 0.0
        hit.sources = sources
        hit.coverage, hit.matched_terms = coverage(hit.text, terms)
        candidates.append(hit)
    stats = learn.owner_stats(conn, [h.owner for h in candidates], now)
    for hit in candidates:
        stat = stats[hit.owner]
        hit.score = (
            hit.rrf
            * stat.activation_factor
            * (0.7 + 0.3 * hit.importance)
            * stat.usefulness_factor
            * learn.TRUST_FACTOR.get(hit.trust, 0.8)
            * (config.retrieval.current_project_boost if hit.project_id == query.project_id else 1.0)
        )
    candidates.sort(key=lambda h: h.score, reverse=True)
    per_session: dict[str | None, int] = {}
    results: list[Hit] = []
    for hit in candidates:
        if hit.session_id is not None:
            per_session[hit.session_id] = per_session.get(hit.session_id, 0) + 1
            if per_session[hit.session_id] > config.retrieval.max_per_session:
                continue
        results.append(hit)
        if len(results) >= query.limit:
            break
    if record_shown and results:
        learn.record_access(conn, [h.owner for h in results], "shown", query.exclude_session)
    return results


def confident(hit: Hit, config: Config, terms: Sequence[str]) -> bool:
    """Abstention gate for automatic injection: never inject weak matches."""
    if hit.score < config.retrieval.inject_min_score:
        return False
    if "vector" in hit.sources and hit.matched_terms >= 1:
        return True
    needed = 1 if len(terms) <= 1 else 2
    return hit.matched_terms >= needed and hit.coverage >= config.retrieval.min_term_coverage
