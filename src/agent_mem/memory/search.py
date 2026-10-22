"""Hybrid retrieval: FTS5 (BM25) + optional vectors + entity graph, fused with RRF and re-scored.

The lexical path (used by hooks) is standard library only. Semantic and PageRank
candidates are supplied by callers that may import numpy.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime

from agent_mem.core import identity, timeutil
from agent_mem.core.config import Config
from agent_mem.core.signals import first_line, request_text
from agent_mem.memory import learn
from agent_mem.memory.store import owner_label

Owner = tuple[str, int]

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
    "sollten",
    "bleibt",
    "bleiben",
    "lange",
    "geht",
    "muss",
    "müssen",
    "gibt",
    "alle",
    "alles",
    # question words and filler verbs: they lower coverage without naming anything
    "who",
    "will",
    "been",
    "these",
    "those",
    "used",
    "uses",
    "project",
    "welche",
    "welcher",
    "welches",
    "welchem",
    "welchen",
    "womit",
    "worauf",
    "wofür",
    "woran",
    "wovon",
    "wann",
    "heißt",
    "heißen",
    "diese",
    "dieser",
    "dieses",
    "diesem",
    "diesen",
    "wird",
    "werden",
    "wurde",
    "wurden",
    "gilt",
    "nutzt",
    "nutzen",
    "verwenden",
    "verwendet",
    "achten",
    "enthält",
    "enthalten",
    "contains",
    "contain",
    "man",
    "unser",
    "unsere",
    "unseren",
    "unserem",
    "projekt",
    # Day words: a named time is read by the time window (semantic.time_window), not as a search word.
    "heute",
    "gestern",
    "morgen",
    "today",
    # chat filler: a question made of these would match any long turn
    "nun",
    "schau",
    "schaue",
    "schauen",
    "guck",
    "gucke",
    "hey",
    "halt",
    "eben",
    "eigentlich",
    "einfach",
    "immer",
    "wieder",
    "mehr",
    "viel",
    "viele",
    "paar",
    "sachen",
    "ganz",
    "ganze",
    "gesamte",
    "gesamten",
    "gerade",
    "sehr",
    "nur",
    "denn",
    "weil",
    "damit",
    "dabei",
    "dazu",
    "dafür",
    "sein",
    "bin",
    "bist",
    "kein",
    "keine",
    "keinen",
    "mein",
    "meine",
    "meinen",
    "dein",
    "deine",
    "deinen",
    "sollte",
    "würde",
    "könnte",
    "möchte",
    "okay",
    "bzw",
    "etc",
    "etwas",
    "now",
    "look",
    "more",
    "much",
    "very",
    "really",
    "still",
    "again",
    "only",
    "whole",
    "entire",
    "thing",
    "things",
    "stuff",
    "thanks",
    "get",
    "got",
    # function words a question uses around its topic
    "als",
    "ans",
    "aufs",
    "beim",
    "bis",
    "bereits",
    "deren",
    "dessen",
    "durch",
    "eines",
    "gegen",
    "ihre",
    "ihrem",
    "ihren",
    "ins",
    "jede",
    "jedem",
    "jeden",
    "jeder",
    "jedes",
    "jeweils",
    "ohne",
    "pro",
    "seit",
    "seine",
    "seinem",
    "seinen",
    "seiner",
    "sich",
    "sondern",
    "sowie",
    "während",
    "wobei",
    "wodurch",
    "woher",
    "wohin",
    "wonach",
    "worin",
    "worüber",
    "wozu",
    "zwischen",
    "after",
    "before",
    "each",
    "every",
    "other",
    "than",
    "via",
    "per",
    "onto",
    "upon",
    "while",
    "whose",
}
# "Logging-Bibliothek", "node-version": letters joined by hyphens are searched as their parts.
_COMPOUND = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)+")
_SUFFIXES = ("ing", "ed", "es", "en", "er", "e", "s", "t")


def stem(term: str) -> str:
    """Drop one inflection ending so "deployt", "installiere", "branches" find "deploy", "installiert",
    "branch". FTS5 uses trigrams, so the stem still matches every longer form as a substring."""
    if not term.isalpha():
        return term
    for suffix in _SUFFIXES:
        if term.endswith(suffix) and len(term) - len(suffix) >= 4:
            return term[: -len(suffix)]
    return term


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
    commits: list[str] = field(default_factory=list)  # "hash subject" of the commits a turn made
    coverage: float = 0.0
    matched_terms: int = 0
    origin: str | None = None
    answer: str = ""
    # What a turn is about: request, answer, files, errors. Command lines are left out: their paths and
    # flags match almost any two words of a question ("tests" in tests/test_x.py).
    topic: str = ""

    @property
    def label(self) -> str:
        return owner_label(*self.owner)


def query_terms(text: str, limit: int = 12) -> list[str]:
    terms: list[str] = []
    for match in _TOKEN.finditer(text.lower()):
        token = match.group(0).strip(".-/")
        for part in token.split("-") if _COMPOUND.fullmatch(token) else [token]:
            # A number is a count or a year, not a topic; from seven digits on it is an id (a commit like 8760496).
            if len(part) < 3 or part in STOPWORDS or (part.isdigit() and len(part) < 7) or part in terms:
                continue
            terms.append(part)
            if len(terms) >= limit:
                return terms
    return terms


def fts_candidates(conn: sqlite3.Connection, terms: Sequence[str], limit: int = 60) -> list[Owner]:
    usable = [t for t in terms if len(t) >= 3]
    if not usable:
        return []
    expression = " OR ".join('"' + stem(t).replace('"', '""') + '"' for t in usable)
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
    """Entities named in the query, strongest first (``seed_strengths``)."""
    return list(seed_strengths(conn, project_id, terms))


def seed_strengths(conn: sqlite3.Connection, project_id: str | None, terms: Sequence[str]) -> dict[int, float]:
    """Entities named in the query and how surely: the exact key or a file's name 1.0, a word inside a path 0.3
    ("viewer" inside every path of the viewer package says little about which file is meant). Matched in SQL."""
    usable = [t.lower() for t in terms if len(t) >= 3][:12]
    found: dict[int, float] = {}
    for term in usable:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        for row in conn.execute(
            "SELECT id, lower(key) AS k FROM entities WHERE project_id IN (?, '') AND kind IN ('file', 'command', "
            "'package') AND (lower(key) = ? OR lower(key) LIKE ? ESCAPE '\\' OR (length(?) >= 5 AND "
            "instr(lower(key), ?) > 0)) LIMIT 60",
            (project_id or "", term, f"%/{escaped}", term, term),
        ):
            name = row["k"].rsplit("/", 1)[-1]
            strength = 1.0 if term in {row["k"], name, name.rsplit(".", 1)[0]} else 0.3
            found[int(row["id"])] = max(found.get(int(row["id"]), 0.0), strength)
    return dict(sorted(found.items(), key=lambda item: -item[1])[:30])


def graph_candidates_sql(
    conn: sqlite3.Connection, project_id: str | None, terms: list[str], limit: int = 40
) -> list[Owner]:
    """Owners linked to query entities and their strongest 1-hop neighbours (no external deps)."""
    strengths = seed_strengths(conn, project_id, terms)
    seeds = list(strengths)
    if not seeds:
        return []
    placeholders = ",".join("?" for _ in seeds)
    neighbours = conn.execute(
        f"SELECT CASE WHEN a IN ({placeholders}) THEN b ELSE a END AS other, MAX(weight) AS w FROM edges "
        f"WHERE a IN ({placeholders}) OR b IN ({placeholders}) GROUP BY other ORDER BY w DESC LIMIT 20",
        (*seeds, *seeds, *seeds),
    ).fetchall()
    weights = dict(strengths)
    for row in neighbours:
        weights.setdefault(int(row["other"]), float(row["w"]) * 0.5)
    return owners_for_entities(conn, weights, limit)


LINKS_PER_ENTITY = 50
GRAPH_CANDIDATES = 200
# Tuned on the retrieval fixture, coding-agent-life and LongMemEval.
COVERAGE_WEIGHT = 0.5
GRAPH_WEIGHT = 0.3


def owners_for_entities(conn: sqlite3.Connection, weights: dict[int, float], limit: int) -> list[Owner]:
    """Rank owners by linked entity weight. Frequent "hub" entities (e.g. a test command used in every
    turn) are down-weighted like IDF, and only their most recent links are read."""
    scores: dict[Owner, float] = {}
    for entity, weight in weights.items():
        degree = conn.execute("SELECT COUNT(*) FROM links WHERE entity_id = ?", (entity,)).fetchone()[0]
        if not degree:
            continue
        adjusted = weight / (1.0 + math.log1p(degree))
        for row in conn.execute(
            "SELECT owner_type, owner_id FROM links WHERE entity_id = ? ORDER BY owner_id DESC LIMIT ?",
            (entity, LINKS_PER_ENTITY),
        ):
            owner = (row["owner_type"], int(row["owner_id"]))
            scores[owner] = scores.get(owner, 0.0) + adjusted
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
            f"t.files_json, t.commands_json, t.errors_json, t.commits_json, t.outcome, s.harness FROM turns t "
            f"JOIN sessions s ON s.id = t.session_id WHERE t.id IN ({placeholders})",
            turn_ids,
        ):
            files = json.loads(row["files_json"] or "[]")
            commits = json.loads(row["commits_json"] or "[]")
            commands = " ".join(json.loads(row["commands_json"] or "[]"))
            topic = "\n".join(
                part
                for part in (
                    row["prompt"],
                    # The opening of the answer says what was done; a long report mentions almost any two words.
                    (row["answer"] or "")[:TOPIC_ANSWER_CHARS],
                    " ".join(files),
                    " ".join(json.loads(row["errors_json"] or "[]")),
                    " ".join(commits),
                )
                if part
            )
            text = "\n".join(part for part in (topic, commands) if part)
            hits[("t", row["id"])] = Hit(
                owner=("t", row["id"]),
                kind="turn",
                title=first_line(request_text(row["prompt"]), 160) or first_line(row["answer"] or "", 160),
                text=text,
                topic=topic,
                answer=row["answer"] or "",
                ts=row["started_at"],
                session_id=row["session_id"],
                project_id=row["project_id"],
                harness=row["harness"],
                trust=row["trust"],
                importance=row["importance"],
                files=files,
                commits=commits,
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


TOPIC_ANSWER_CHARS = 600


def coverage(text: str, terms: Sequence[str]) -> tuple[float, int]:
    if not terms:
        return 0.0, 0
    lowered = text.lower()
    matched = sum(1 for term in terms if stem(term) in lowered or _head(term) in lowered)
    return matched / len(terms), matched


def _head(term: str) -> str:
    """The first word of a long compound: "installationsskripte" is about "install", "projektpfade" about
    "projekt". Shorter words stay whole (the result never matches anything then)."""
    return term[:COMPOUND_HEAD] if term.isalpha() and len(term) >= COMPOUND_MIN else "\0"


COMPOUND_MIN, COMPOUND_HEAD = 12, 7


def scope(conn: sqlite3.Connection, project_id: str | None) -> list[str | None]:
    """The project, every project nested inside it and the projects around it. A session started in ~/work that
    works in ~/work/app has its turns and facts filed under app (``capture._narrow_turn``); searching from ~/work
    must find them. The other way round, what a session in ~/work learned about app stays filed under ~/work, so
    app looks there too. The home folder is around everything and no project of its own, in either direction."""
    if project_id is None:
        return [None]
    rows = conn.execute("SELECT id, root FROM projects").fetchall()
    root = next((r[1] for r in rows if r[0] == project_id), None)
    if not root:
        return [project_id]
    others = [r for r in rows if r[0] != project_id]
    home = os.path.expanduser("~")
    # A session in the home folder is in no project: it does not see every project below it.
    nested = [r[0] for r in others if identity.is_within(r[1], root)] if root not in {home, os.sep} else []
    around = [r[0] for r in others if r[1] not in {home, os.sep} and identity.is_within(root, r[1])]
    return [project_id, *nested, *around]


def _in(column: str, ids: list[str | None]) -> tuple[str, tuple[str | None, ...]]:
    """``column IN (...)`` that also matches NULL (a turn outside any project)."""
    if ids == [None]:
        return f"{column} IS NULL", ()
    return f"{column} IN ({','.join('?' for _ in ids)})", tuple(ids)


@dataclass
class Query:
    text: str
    project_id: str | None
    exclude_session: str | None = None
    limit: int = 8
    include_other_projects: bool = False
    # A time named in the question ("last week", "8. April"). It adds candidates and never excludes:
    # a misread or future time ("tips for this weekend") must not hide every memory.
    window: tuple[datetime, datetime] | None = None
    kinds: set[str] | None = None
    exclude_origins: set[str] = field(default_factory=set)


def _time_candidates(
    conn: sqlite3.Connection, projects: list[str | None], window: tuple[datetime, datetime]
) -> list[Owner]:
    """ "What did we do on 8 April?" names a time, not a topic: every turn in the window is a candidate."""
    where, params = _in("project_id", projects)
    return [
        ("t", int(row[0]))
        for row in conn.execute(
            f"SELECT id FROM turns WHERE {where} AND started_at >= ? AND started_at < ? "
            "ORDER BY started_at DESC LIMIT 40",
            (*params, timeutil.iso(window[0]), timeutil.iso(window[1])),
        )
    ]


def _admissible(hit: Hit, query: Query, projects: list[str | None]) -> bool:
    """The query's filters: not this session, this project or a global memory, the asked kinds and origins."""
    if query.exclude_session and hit.session_id == query.exclude_session:
        return False
    if not (hit.project_id in projects or hit.project_id is None or query.include_other_projects):
        return False
    if query.kinds and hit.kind not in query.kinds:
        return False
    return not (hit.origin and hit.origin in query.exclude_origins)


def _capped(candidates: list[Hit], limit: int, max_per_session: int) -> list[Hit]:
    """The first ``limit`` hits with at most ``max_per_session`` turns per session, so one long session cannot fill
    the list; facts from that session are separate things (a day of work leaves dozens) and are not capped."""
    per_session: dict[str | None, int] = {}
    results: list[Hit] = []
    for hit in candidates:
        if hit.session_id is not None and hit.owner[0] == "t":
            per_session[hit.session_id] = per_session.get(hit.session_id, 0) + 1
            if per_session[hit.session_id] > max_per_session:
                continue
        results.append(hit)
        if len(results) >= limit:
            break
    return results


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
    projects = scope(conn, query.project_id)
    lists: dict[str, list[Owner]] = {"fts": fts_candidates(conn, terms)}
    # The graph says how strongly a hit is tied to the files and commands the question names. It only reorders the
    # hits the text and the vectors found: as a list of its own in the fusion it would outvote exact matches with
    # whatever touched such a file last.
    tied = (graph_source or graph_candidates_sql)(conn, query.project_id, terms, GRAPH_CANDIDATES)
    tie = {owner: 1.0 - rank / len(tied) for rank, owner in enumerate(tied)}
    if vector_source is not None:
        lists["vector"] = vector_source(query.text, 60)
    if query.window:
        lists["time"] = _time_candidates(conn, projects, query.window)
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
        if not _admissible(hit, query, projects):
            continue
        hit.rrf = score / max_rrf if max_rrf else 0.0
        hit.sources = sources
        # A long memory (another harness's session summary) contains nearly any word; like a turn it is judged by its
        # start.
        hit.coverage, hit.matched_terms = coverage(hit.topic if hit.owner[0] == "t" else hit.text[:800], terms)
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
    # Order, not score: a hit that names more of the question's words comes first, and so does one tied to the files
    # it names. The score itself stays what the abstention gate was calibrated on.
    candidates.sort(
        key=lambda h: (
            h.score * (1 - COVERAGE_WEIGHT + COVERAGE_WEIGHT * h.coverage) * (1 + GRAPH_WEIGHT * tie.get(h.owner, 0))
        ),
        reverse=True,
    )
    results = _capped(candidates, query.limit, config.retrieval.max_per_session)
    if record_shown and results:
        learn.record_access(conn, [h.owner for h in results], "shown", query.exclude_session)
    return results


def confident(hit: Hit, config: Config, terms: Sequence[str]) -> bool:
    """Abstention gate for automatic injection: never inject weak matches."""
    if hit.score < config.retrieval.inject_min_score:
        return False
    # A semantic hit still has to share a third of the question's content words: unrelated questions share one
    # generic word of five or more, related ones at least one of three.
    if "vector" in hit.sources and hit.matched_terms >= 1 and hit.coverage >= 1 / 3:
        return True
    needed = 1 if len(terms) <= 1 else 2
    return hit.matched_terms >= needed and hit.coverage >= config.retrieval.min_term_coverage
