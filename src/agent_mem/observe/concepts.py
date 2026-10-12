"""The concepts mem0 links to each memory, mirrored into SQLite for the viewer's graph (docs/PLAN.md B.31).

mem0 extracts them with spaCy when it stores a fact (its entity store). The worker runs the same extractor
(``mem0.utils.entity_extraction``) over memories it has not linked yet, user notes included, and records the
concepts per project. Two memories that share a concept are connected through it.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import tempfile
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.memory.search import STOPWORDS

BATCH = 200
_META = "concepts.last_memory_id"
# Raised when the key changes; the next run then links every memory again (a few seconds for a few hundred).
VERSION = "2"
# A concept needs a letter and three characters; numbers, ports and single symbols connect nothing.
_USEFUL = re.compile(r"(?=.*[^\W\d_]).{3,}")


_SHAPE = re.compile(r"\s|[-._/0-9]|[A-Z].*[A-Z]")


def specific(surface: str, kind: str, names: set[str]) -> bool:
    """A concrete thing, as agentmemory asks its model for: code, a quoted term, a compound or named thing.
    German capitalises every noun, so mem0 calls "Fehler" a proper noun; only spaCy's proper-noun tag in the
    sentence (``names``) or the word's shape tells "Codex" from "Fehler"."""
    return kind.lower() in {"identifier", "quoted"} or bool(_SHAPE.search(surface)) or surface.lower() in names


# spaCy's packaged models, downloaded into agent-mem's model directory so a reinstall of the tool keeps them.
SPACY_VERSION = "3.8.0"
SPACY_URL = "https://github.com/explosion/spacy-models/releases/download/{name}-{v}/{name}-{v}-py3-none-any.whl"
SPACY_SHA256 = {
    "de_core_news_sm": "fec69fec52b1780f2d269d5af7582a5e28028738bd3190532459aeb473bfa3e7",
    "en_core_web_sm": "1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85",
}


def model_path(config: Config) -> Path | None:
    """The downloaded model for ``observe.entity_model``, or None."""
    name = config.observe.entity_model
    path = config.model_dir / "spacy" / name / f"{name}-{SPACY_VERSION}"
    return path if (path / "config.cfg").is_file() else None


def download_model(config: Config) -> Path:
    """Fetch the wheel of ``observe.entity_model`` from spaCy's releases and unpack the model directory.
    Known models are checked against a pinned SHA-256."""
    name = config.observe.entity_model
    if not re.fullmatch(r"[a-z]{2,3}_[a-z_]+_(sm|md|lg|trf)", name):
        raise ValueError(f"{name!r} is not a spaCy model name such as de_core_news_sm")
    target = config.model_dir / "spacy" / name
    with tempfile.TemporaryDirectory() as tmp:
        wheel = Path(tmp) / "model.whl"
        urllib.request.urlretrieve(SPACY_URL.format(name=name, v=SPACY_VERSION), wheel)
        expected = SPACY_SHA256.get(name)
        if expected and hashlib.sha256(wheel.read_bytes()).hexdigest() != expected:
            raise ValueError(f"{name}: download does not match the pinned checksum")
        prefix = f"{name}/{name}-{SPACY_VERSION}/"
        with zipfile.ZipFile(wheel) as archive:
            for member in archive.namelist():
                if member.startswith(prefix) and ".." not in member:
                    archive.extract(member, target.parent)
    path = model_path(config)
    if path is None:
        raise ValueError(f"{name}: the download holds no model directory")
    return path


def normalize(text: str) -> str:
    """mem0's own normalisation (``Memory._normalize_entity_text``), plus code quotes removed; "agent_mem",
    "agent-mem" and "Agent Mem" are one concept."""
    key = " ".join(text.strip().strip("`'\"").lower().split())
    return key if "/" in key or "." in key else re.sub(r"[\s_-]+", "-", key)


def link_new(
    conn: sqlite3.Connection,
    extract: Callable[[str], list[tuple[str, str]]] | None = None,
    base: Callable[[str], str] = str,
    names: Callable[[str], set[str]] = lambda text: set(),
) -> int:
    """Link concepts for up to ``BATCH`` memories newer than the last run. Returns memories processed.

    Without an extractor (spaCy model missing) nothing is marked as done, so the memories are linked once the
    model is installed."""
    if extract is None:
        from mem0.utils import spacy_models
        from mem0.utils.entity_extraction import extract_entities

        nlp = spacy_models.get_nlp_full()
        if nlp is None:
            return 0
        extract = extract_entities
        # "Hooks" and "Hook" are one concept: the model's base form of each word.
        base = lambda text: " ".join(token.lemma_ for token in nlp(text))  # noqa: E731
        names = lambda text: {token.text.lower() for token in nlp(text) if token.pos_ == "PROPN"}  # noqa: E731

    if db.get_meta(conn, "concepts.version") != VERSION:
        with db.transaction(conn):
            conn.execute("DELETE FROM concept_links")
            conn.execute("DELETE FROM concepts")
            db.set_meta(conn, _META, "0")
            db.set_meta(conn, "concepts.version", VERSION)
    last = int(db.get_meta(conn, _META) or 0)
    rows = conn.execute(
        "SELECT id, project_id, title, body FROM memories WHERE id > ? ORDER BY id LIMIT ?", (last, BATCH)
    ).fetchall()
    with db.transaction(conn):
        for row in rows:
            seen: set[str] = set()
            text_of_memory = f"{row['title'] or ''}\n{row['body'] or ''}".strip()
            proper = names(text_of_memory)
            for kind, text in extract(text_of_memory):
                surface = text.strip().strip("`'\"")
                # Only a single plain word gets its base form; the lemmatizer splits paths ("src -- agent_mem")
                # and cuts compounds ("SQLite-Such").
                label = (base(surface) or surface) if surface.isalpha() else surface
                if label.lower() == surface.lower():
                    label = surface  # same word, keep its spelling ("Viewer", not "viewer")
                key = normalize(label)
                # "When" opening an English sentence is tagged as a proper noun; question and filler words never
                # name a thing.
                if key in seen or key in STOPWORDS or not _USEFUL.fullmatch(key) or len(key) > 80:
                    continue
                seen.add(key)
                conn.execute(
                    "INSERT INTO concepts(project_id, key, label, type, specific) VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(project_id, key) DO UPDATE SET specific = max(specific, excluded.specific)",
                    (row["project_id"] or "", key, label, kind.lower(), int(specific(surface, kind, proper))),
                )
                concept = conn.execute(
                    "SELECT id FROM concepts WHERE project_id = ? AND key = ?", (row["project_id"] or "", key)
                ).fetchone()[0]
                conn.execute(
                    "INSERT OR IGNORE INTO concept_links(concept_id, memory_id) VALUES (?, ?)", (concept, row["id"])
                )
        if rows:
            db.set_meta(conn, _META, str(rows[-1]["id"]))
    return len(rows)
