"""Heavier retrieval parts: sentence embeddings (fastembed), vector search (numpy), Personalized PageRank
and temporal query parsing (dateparser). Only used by the MCP server, the indexer and the CLI.
"""

from __future__ import annotations

import contextlib
import logging
import re
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import numpy as np

from agent_mem.core import db, logutil, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import search, store

Owner = tuple[str, int]


class Embedder(Protocol):
    model: str

    def passages(self, texts: list[str]) -> np.ndarray: ...

    def query(self, text: str) -> np.ndarray: ...


# Models fastembed does not ship: (Hugging Face repository, ONNX file, dimension).
# The int8-quantized export keeps the download small (~120 MB) and runs fast on CPU.
CUSTOM_MODELS = {
    "intfloat/multilingual-e5-small": ("Xenova/multilingual-e5-small", "onnx/model_quantized.onnx", 384),
}


def _prefixes(model: str) -> tuple[str, str]:
    """E5 models were trained with ``query:``/``passage:`` prefixes; other models get none."""
    return ("query: ", "passage: ") if "e5" in model.lower() else ("", "")


class FastEmbedEmbedder:
    """Sentence embeddings via fastembed (ONNX Runtime, no PyTorch). Default: MiniLM-L12-v2."""

    def __init__(self, config: Config, *, allow_download: bool) -> None:
        # The Hub's "You are sending unauthenticated requests ... set a HF_TOKEN" reads like a setup step left to do;
        # the public model needs no token. Errors still show.
        logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
        from fastembed import TextEmbedding  # lazy: optional dependency

        self.model = config.semantic.model
        self._register_if_needed(TextEmbedding)
        kwargs: dict[str, Any] = {"model_name": self.model, "cache_dir": str(config.model_dir)}
        if not allow_download:
            kwargs["local_files_only"] = True
        self._impl = TextEmbedding(**kwargs)
        self.batch_size = config.semantic.batch_size
        self._query_prefix, self._passage_prefix = _prefixes(self.model)

    def _register_if_needed(self, text_embedding: Any) -> None:
        if self.model not in CUSTOM_MODELS:
            return
        if any(m["model"] == self.model for m in text_embedding.list_supported_models()):
            return
        from fastembed.common.model_description import ModelSource, PoolingType

        repository, model_file, dim = CUSTOM_MODELS[self.model]
        with contextlib.suppress(ValueError):  # already registered in this process
            text_embedding.add_custom_model(
                model=self.model,
                pooling=PoolingType.MEAN,
                normalization=True,
                sources=ModelSource(hf=repository),
                dim=dim,
                model_file=model_file,
                size_in_gb=0.12,
            )

    def passages(self, texts: list[str]) -> np.ndarray:
        vectors = list(self._impl.embed([self._passage_prefix + t for t in texts], batch_size=self.batch_size))
        return _normalize(np.asarray(vectors, dtype=np.float32))

    def query(self, text: str) -> np.ndarray:
        vector = next(iter(self._impl.embed([self._query_prefix + text])))
        return _normalize(np.asarray([vector], dtype=np.float32))[0]


def _normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def model_cached(config: Config) -> bool:
    name = config.semantic.model.split("/")[-1]
    return config.model_dir.is_dir() and any(name in path.name for path in config.model_dir.iterdir())


def load_embedder_verbose(config: Config, *, allow_download: bool = False) -> tuple[Embedder | None, str | None]:
    """Return the embedder or a human-readable reason why semantic search is unavailable."""
    if not config.semantic.enabled:
        return None, "semantic search is disabled in config.json"
    try:
        import fastembed  # noqa: F401
    except ImportError:
        return None, "the optional dependency is missing: run `agent-mem upgrade --extras semantic`"
    if not allow_download and not model_cached(config):
        return None, "the model is not downloaded yet: run `agent-mem models install`"
    with contextlib.suppress(Exception):
        from loguru import logger

        logger.disable("fastembed")
    try:
        return FastEmbedEmbedder(config, allow_download=allow_download), None
    except Exception as error:  # network, unsupported platform, corrupt cache
        return None, f"loading {config.semantic.model} failed: {logutil.describe(error)[:200]}"


def load_embedder(config: Config, *, allow_download: bool = False) -> Embedder | None:
    return load_embedder_verbose(config, allow_download=allow_download)[0]


def to_blob(vector: np.ndarray) -> bytes:
    return np.asarray(vector, dtype=np.float16).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float16).astype(np.float32)


def owner_text(conn: sqlite3.Connection, owner: Owner) -> str | None:
    if owner[0] == "t":
        row = conn.execute("SELECT prompt, answer, files_json FROM turns WHERE id = ?", (owner[1],)).fetchone()
        if row is None:
            return None
        return f"{row['prompt'][:1500]}\n{row['answer'][:1500]}\n{row['files_json']}".strip()
    row = conn.execute("SELECT kind, title, body FROM memories WHERE id = ?", (owner[1],)).fetchone()
    return None if row is None else f"{row['kind']}: {row['title']}\n{row['body'][:2000]}"


def pending_owners(conn: sqlite3.Connection, model: str, limit: int) -> list[Owner]:
    rows = conn.execute(
        "SELECT 't' AS owner_type, id FROM turns WHERE indexed_at IS NOT NULL AND id NOT IN "
        "(SELECT owner_id FROM vectors WHERE owner_type = 't' AND model = ?) "
        "UNION ALL SELECT 'm', id FROM memories WHERE invalid_at IS NULL AND id NOT IN "
        "(SELECT owner_id FROM vectors WHERE owner_type = 'm' AND model = ?) LIMIT ?",
        (model, model, limit),
    ).fetchall()
    return [(row[0], int(row[1])) for row in rows]


def embed_pending(conn: sqlite3.Connection, embedder: Embedder, limit: int = 512) -> int:
    owners = pending_owners(conn, embedder.model, limit)
    done = 0
    for start in range(0, len(owners), 32):
        batch = owners[start : start + 32]
        texts: list[str] = []
        kept: list[Owner] = []
        for owner in batch:
            text = owner_text(conn, owner)
            if text:
                texts.append(text)
                kept.append(owner)
        if not texts:
            continue
        vectors = embedder.passages(texts)
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.executemany(
                "INSERT INTO vectors(owner_type, owner_id, model, vec) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(owner_type, owner_id) DO UPDATE SET model = excluded.model, vec = excluded.vec",
                [(o[0], o[1], embedder.model, to_blob(v)) for o, v in zip(kept, vectors, strict=True)],
            )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        done += len(kept)
    return done


DUPLICATE_KINDS = ("fact", "decision", "preference", "dead_end", "lesson")


def merge_duplicates(conn: sqlite3.Connection, config: Config, model: str) -> int:
    """Retire an older memory when a newer one of the same project says the same thing (cosine at or above
    ``semantic.duplicate_min_cosine``). The newer one stays: it is the current wording. Only the observer's and
    agents' memories take part; what the user wrote is never retired. Returns the number retired."""
    threshold = config.semantic.duplicate_min_cosine
    if threshold >= 1.0:
        return 0
    marks = ",".join("?" for _ in DUPLICATE_KINDS)
    last = int(db.get_meta(conn, "duplicates.last_memory_id") or 0)
    rows = conn.execute(
        f"SELECT m.id, m.project_id, v.vec FROM memories m JOIN vectors v ON v.owner_type = 'm' AND v.owner_id = m.id "
        f"AND v.model = ? WHERE m.invalid_at IS NULL AND m.project_id IS NOT NULL AND m.trust IN ('observer', 'agent') "
        f"AND m.kind IN ({marks}) ORDER BY m.id",
        (model, *DUPLICATE_KINDS),
    ).fetchall()
    if not rows:
        return 0
    ids = np.array([int(row[0]) for row in rows])
    projects = np.array([str(row[1]) for row in rows])
    matrix = np.stack([from_blob(row[2]) for row in rows])
    matrix /= np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)
    retired: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for index in np.flatnonzero(ids > last):
        if int(ids[index]) in retired:
            continue
        older = np.flatnonzero((ids < ids[index]) & (projects == projects[index]))
        if not len(older):
            continue
        scores = matrix[older] @ matrix[index]
        for position in np.flatnonzero(scores >= threshold):
            old = int(ids[older[position]])
            if old not in retired:
                retired.add(old)
                pairs.append((old, int(ids[index])))
    with db.transaction(conn):
        for old, new in pairs:
            store.supersede(conn, old, new)
        db.set_meta(conn, "duplicates.last_memory_id", str(int(ids.max())))
    return len(pairs)


@dataclass
class _VectorCache:
    key: tuple[int, int]
    owners: list[Owner]
    matrix: np.ndarray


class Retriever:
    """Full hybrid retrieval for the MCP server and CLI."""

    def __init__(self, conn: sqlite3.Connection, config: Config, embedder: Embedder | None = None) -> None:
        self.conn = conn
        self.config = config
        self.embedder = embedder
        self._vectors: dict[str | None, _VectorCache] = {}
        self._graphs: dict[str | None, tuple[tuple[int, str], dict[int, list[tuple[int, float]]]]] = {}

    # vectors ------------------------------------------------------------------
    def _vector_matrix(self, project_id: str | None) -> _VectorCache | None:
        if self.embedder is None:
            return None
        stats = self.conn.execute("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM vectors").fetchone()
        key = (int(stats[0]), int(stats[1]))
        cached = self._vectors.get(project_id)
        if cached and cached.key == key:
            return cached
        projects = search.scope(self.conn, project_id)
        turn_where, turn_params = search._in("t.project_id", projects)
        memory_where, memory_params = search._in("m.project_id", projects)
        rows = self.conn.execute(
            "SELECT v.owner_type, v.owner_id, v.vec FROM vectors v "
            "LEFT JOIN turns t ON v.owner_type = 't' AND t.id = v.owner_id "
            "LEFT JOIN memories m ON v.owner_type = 'm' AND m.id = v.owner_id "
            f"WHERE v.model = ? AND ((v.owner_type = 't' AND {turn_where}) "
            f"OR (v.owner_type = 'm' AND ({memory_where} OR m.project_id IS NULL)))",
            (self.embedder.model, *turn_params, *memory_params),
        ).fetchall()
        if not rows:
            return None
        owners = [(r[0], int(r[1])) for r in rows]
        matrix = np.vstack([from_blob(r[2]) for r in rows])
        cache = _VectorCache(key=key, owners=owners, matrix=matrix)
        self._vectors[project_id] = cache
        return cache

    def vector_source(self, project_id: str | None) -> Callable[[str, int], list[Owner]]:
        def source(text: str, limit: int) -> list[Owner]:
            cache = self._vector_matrix(project_id)
            if cache is None or self.embedder is None:
                return []
            query = self.embedder.query(text)
            scores = cache.matrix @ query
            top = np.argsort(-scores)[:limit]
            floor = self.config.retrieval.min_vector_score
            return [cache.owners[i] for i in top if scores[i] >= floor]

        return source

    # graph ----------------------------------------------------------------------
    def graph_source(
        self, conn: sqlite3.Connection, project_id: str | None, terms: list[str], limit: int
    ) -> list[Owner]:
        seeds = list(search.seed_strengths(conn, project_id, terms))
        if not seeds:
            return []
        graph = self._graph(project_id)
        if not graph:
            return search.owners_for_entities(conn, dict.fromkeys(seeds, 1.0), limit)
        ranks = personalized_pagerank(graph, seeds)
        top = dict(sorted(ranks.items(), key=lambda item: item[1], reverse=True)[:30])
        for seed in seeds:
            top.setdefault(seed, max(top.values(), default=1.0))
        return search.owners_for_entities(conn, top, limit)

    def _graph(self, project_id: str | None) -> dict[int, list[tuple[int, float]]]:
        stats = self.conn.execute("SELECT COUNT(*), COALESCE(MAX(updated_at), '') FROM edges").fetchone()
        key = (int(stats[0]), str(stats[1]))
        cached = self._graphs.get(project_id)
        if cached and cached[0] == key:
            return cached[1]
        graph: dict[int, list[tuple[int, float]]] = {}
        for row in self.conn.execute(
            "SELECT e.a, e.b, e.weight FROM edges e JOIN entities x ON x.id = e.a WHERE x.project_id IN (?, '')",
            (project_id or "",),
        ):
            a, b, weight = int(row[0]), int(row[1]), float(row[2])
            graph.setdefault(a, []).append((b, weight))
            graph.setdefault(b, []).append((a, weight))
        self._graphs[project_id] = (key, graph)
        return graph

    # search -----------------------------------------------------------------------
    def search(
        self,
        text: str,
        project_id: str | None,
        *,
        limit: int = 8,
        include_other_projects: bool = False,
        exclude_session: str | None = None,
        record_shown: bool = True,
        now: datetime | None = None,
    ) -> list[search.Hit]:
        """``now`` anchors relative times ("last week") and recency; the clock by default."""
        window = time_window(text, now)
        query = search.Query(
            text=strip_time_words(text) if window else text,
            project_id=project_id,
            exclude_session=exclude_session,
            limit=limit,
            include_other_projects=include_other_projects,
            window=window,
        )
        return search.search(
            self.conn,
            self.config,
            query,
            vector_source=self.vector_source(project_id) if self.embedder else None,
            graph_source=self.graph_source,
            tool_outputs=True,
            record_shown=record_shown,
            now=now,
        )


def personalized_pagerank(
    graph: dict[int, list[tuple[int, float]]], seeds: list[int], alpha: float = 0.5, iterations: int = 30
) -> dict[int, float]:
    """Personalized PageRank (HippoRAG-style) by power iteration on a weighted undirected graph.

    ``alpha`` is the probability of following an edge; with 1 - alpha the walk restarts at a seed.
    """
    present = [s for s in seeds if s in graph] or list(seeds)
    restart = {s: 1.0 / len(present) for s in present}
    totals = {node: sum(w for _, w in edges) or 1.0 for node, edges in graph.items()}
    rank = dict(restart)
    for _ in range(iterations):
        spread: dict[int, float] = {}
        for node, value in rank.items():
            edges = graph.get(node)
            if not edges:
                spread[node] = spread.get(node, 0.0) + alpha * value
                continue
            for other, weight in edges:
                spread[other] = spread.get(other, 0.0) + alpha * value * weight / totals[node]
        for seed, share in restart.items():
            spread[seed] = spread.get(seed, 0.0) + (1 - alpha) * share
        rank = spread
    return rank


# --- time ------------------------------------------------------------------------

_MONTHS = (
    "january|february|march|april|may|june|july|august|september|october|november|december|"
    "januar|februar|märz|mai|juni|juli|oktober|dezember"
)
_TIME_HINT = re.compile(
    r"(?i)\b(heute|gestern|vorgestern|letzte[nrs]?\s+(woche|monat|jahr)|vorige[nrs]?\s+(woche|monat)|"
    r"diese[nrs]?\s+(woche|monat)|vor\s+\d+\s+(tag(en)?|wochen?|monat(en)?|stunden?)|"
    r"am\s+(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)|"
    r"today|yesterday|last\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"this\s+(week|month)|\d+\s+(days?|weeks?|months?|hours?)\s+ago|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"\d{4}-\d{2}-\d{2}|(?<![\d.])\d{1,2}\.\d{1,2}\.(?:\d{2,4})?(?![\d.])|"  # 3.4. / 3.4.2026, not 1.2.3
    rf"(?:{_MONTHS})\s+\d{{1,2}}(?:st|nd|rd|th)?\b(?:,?\s+\d{{4}})?|"  # April 8th 2026
    rf"\d{{1,2}}(?:st|nd|rd|th|\.)?\s+(?:{_MONTHS})\b(?:\s+\d{{4}})?)"  # 8. April 2026, 8 April
)


def time_window(text: str, now: datetime | None = None) -> tuple[datetime, datetime] | None:
    match = _TIME_HINT.search(text)
    if not match:
        return None
    phrase = match.group(0)
    current = now or timeutil.now()
    lowered = phrase.lower()
    start: datetime | None = None
    if lowered in {"heute", "today"}:
        start = current
    elif lowered in {"gestern", "yesterday"}:
        start = current - timedelta(days=1)
    elif lowered == "vorgestern":
        start = current - timedelta(days=2)
    elif numeric := re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(\d{2,4})?", lowered):
        # German day.month.: dateparser reads 3.4.2026 as 4 March.
        day, month, year = int(numeric[1]), int(numeric[2]), numeric[3]
        full_year = (2000 + int(year) if len(year) == 2 else int(year)) if year else current.year
        with contextlib.suppress(ValueError):
            start = datetime(full_year, month, day, tzinfo=UTC)
            if not year and start > current:
                start = start.replace(year=full_year - 1)
    else:
        with contextlib.suppress(Exception):
            import dateparser

            parsed = dateparser.parse(
                phrase,
                languages=["de", "en"],
                settings={
                    "PREFER_DATES_FROM": "past",
                    "RETURN_AS_TIMEZONE_AWARE": True,
                    # A named day is that day in UTC like the stored timestamps; read as local time and
                    # converted, "8 April" would become 7 April 22:00 and the window would miss the day.
                    "TIMEZONE": "UTC",
                    "TO_TIMEZONE": "UTC",
                    "RELATIVE_BASE": current.replace(tzinfo=None),
                },
            )
            if parsed is not None:
                start = parsed
    if start is None:
        return None
    if re.search(r"(?i)woche|week", lowered):
        begin = (start - timedelta(days=start.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
        return begin, begin + timedelta(days=7)
    if re.search(r"(?i)monat|month", lowered):
        begin = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end = begin.replace(year=begin.year + 1, month=1) if begin.month == 12 else begin.replace(month=begin.month + 1)
        return begin, end
    begin = start.replace(hour=0, minute=0, second=0, microsecond=0)
    return begin, begin + timedelta(days=1)


def confident_hits(hits: list[search.Hit], config: Config, text: str) -> list[search.Hit]:
    """The hits that pass :func:`search.confident` for ``text``, with time words removed as in the search."""
    terms = search.query_terms(strip_time_words(text) if time_window(text) else text)
    return [h for h in hits if search.confident(h, config, terms)]


def strip_time_words(text: str) -> str:
    return _TIME_HINT.sub(" ", text).strip() or text
