"""Observer package: privacy guarantees that must hold without any model (docs/PLAN.md §6)."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

if importlib.util.find_spec("mem0") is None:  # find_spec does not import; importing would fix the env too early
    pytest.skip("observer extra not installed", allow_module_level=True)


def test_mem0_telemetry_is_off_and_home_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_MEM_DATA_DIR", str(tmp_path / "data"))
    # Order matters: the package sets the env, and only then may mem0 be imported.
    observe = importlib.import_module("agent_mem.observe")
    mem0_adapter = importlib.import_module("agent_mem.observe.mem0_adapter")
    telemetry = importlib.import_module("mem0.memory.telemetry")
    assert observe is not None
    assert telemetry.MEM0_TELEMETRY is False  # read once at import; the package set the env first

    mem0_adapter._ensure_env(tmp_path / "data" / "mem0")
    assert os.environ["MEM0_TELEMETRY"] == "False"
    main = importlib.import_module("mem0.memory.main")
    setup = importlib.import_module("mem0.memory.setup")

    assert main.MEM0_TELEMETRY is False
    assert setup.mem0_dir == str(tmp_path / "data" / "mem0")
    assert main.mem0_dir == str(tmp_path / "data" / "mem0")
    assert (tmp_path / "data" / "mem0").stat().st_mode & 0o777 == 0o700


def test_hook_path_does_not_import_observer() -> None:
    import subprocess
    import sys

    code = (
        "import sys, agent_mem.hooks.hook, agent_mem.hooks.capture, agent_mem.hooks.inject, agent_mem.memory.store, agent_mem.memory.search;"
        "bad = [m for m in sys.modules if m.startswith(('mem0', 'qdrant_client', 'fastembed', 'agent_mem.observe'))];"
        "print(','.join(bad))"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert out == "", f"hook path imported: {out}"


def test_missing_spacy_model_disables_entity_linking_instead_of_installing(monkeypatch: pytest.MonkeyPatch) -> None:
    import importlib.util

    mem0_adapter = importlib.import_module("agent_mem.observe.mem0_adapter")
    spacy_models = importlib.import_module("mem0.utils.spacy_models")
    real = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None if name == "en_core_web_sm" else real(name))
    monkeypatch.setattr(spacy_models, "_load_failed_full", False)
    monkeypatch.setattr(spacy_models, "_load_failed_lemma", False)
    mem0_adapter._use_entity_model()
    assert spacy_models._load_failed_full is True and spacy_models._load_failed_lemma is True
    assert spacy_models.get_nlp_full() is None  # no download attempt


def test_the_configured_model_also_lemmatizes_so_mem0_downloads_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """With ``agent-mem models install``'s model only the entity loader was set; mem0's BM25 lemmatizer then ran
    ``spacy download en_core_web_sm``, a pip install from the network into the tool environment, after every
    upgrade again."""
    import importlib.util

    import spacy
    import spacy.cli

    mem0_adapter = importlib.import_module("agent_mem.observe.mem0_adapter")
    spacy_models = importlib.import_module("mem0.utils.spacy_models")
    real = importlib.util.find_spec
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None if name == "en_core_web_sm" else real(name))
    monkeypatch.setattr(spacy.util, "is_package", lambda name: False)
    monkeypatch.setattr(spacy.cli, "download", lambda *a, **k: pytest.fail("mem0 tried to download a model"))
    loaded = object()
    monkeypatch.setattr(spacy, "load", lambda *a, **k: loaded)
    for attr in ("_nlp_full", "_nlp_lemma"):
        monkeypatch.setattr(spacy_models, attr, None)
    for attr in ("_load_failed_full", "_load_failed_lemma"):
        monkeypatch.setattr(spacy_models, attr, False)

    for _ in range(2):  # a second adapter in the same process must not switch entity linking off
        mem0_adapter._use_entity_model("de_core_news_sm", tmp_path / "de_core_news_sm")
        assert spacy_models.get_nlp_full() is loaded
        assert spacy_models.get_nlp_lemma() is loaded


def test_migration_005_adds_concept_tables_to_a_v4_database(config) -> None:
    from agent_mem.core import db

    conn = db.connect(config)
    conn.execute("DROP TABLE concept_links")
    conn.execute("DROP TABLE concepts")
    conn.execute("PRAGMA user_version = 4")
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 5
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p', 'p', '/p', 't')")
    memory = conn.execute(
        "INSERT INTO memories(project_id, kind, title, body, source, trust, importance, valid_from, created_at, "
        "dedupe_key) VALUES ('p', 'fact', '', 'x', 'agent', 'user', 0.5, 't', 't', 'k') RETURNING id"
    ).fetchone()[0]
    concept = conn.execute(
        "INSERT INTO concepts(project_id, key, label, type) VALUES ('p', 'viewer', 'Viewer', 'proper') RETURNING id"
    ).fetchone()[0]
    conn.execute("INSERT INTO concept_links VALUES (?, ?)", (concept, memory))
    conn.execute("DELETE FROM memories WHERE id = ?", (memory,))
    assert conn.execute("SELECT COUNT(*) FROM concept_links").fetchone()[0] == 0  # a purged memory takes its links
    conn.close()


def test_concept_model_downloads_into_the_model_dir_and_checks_its_checksum(config, tmp_path, monkeypatch) -> None:
    import hashlib
    import zipfile

    import pytest

    from agent_mem.observe import spacy_model

    config.observe.entity_model = "de_core_news_sm"
    wheel = tmp_path / "w.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("de_core_news_sm/de_core_news_sm-3.8.0/config.cfg", "[nlp]")
        archive.writestr("de_core_news_sm-3.8.0.dist-info/METADATA", "x")
    monkeypatch.setattr(spacy_model, "_fetch", lambda url, path: path.write_bytes(wheel.read_bytes()))
    assert spacy_model.model_path(config) is None
    with pytest.raises(ValueError, match="checksum"):
        spacy_model.download_model(config)  # the pinned hash is the real wheel's
    monkeypatch.setitem(spacy_model.SPACY_SHA256, "de_core_news_sm", hashlib.sha256(wheel.read_bytes()).hexdigest())
    path = spacy_model.download_model(config)
    assert (
        path
        == config.model_dir / "spacy" / "de_core_news_sm" / "de_core_news_sm-3.8.0"
        == spacy_model.model_path(config)
    )
    config.observe.entity_model = "../../etc"
    with pytest.raises(ValueError, match="not a spaCy model name"):
        spacy_model.download_model(config)
