"""The single import point for mem0 (docs/PLAN.md §4.5, D1, D2, D8, D13).

``extract`` runs mem0's add pipeline (one LLM call, A.10) and returns the new facts;
``search`` is mem0's hybrid search; ``forget`` removes a fact from Qdrant, the entity store and
``history.db``; ``reindex`` re-adds facts without a model call (``infer=False``).

mem0 validates provider names in its pydantic configs (A.2). We register our own classes in mem0's
factories and set the provider name after validation, so no placeholder provider is ever
instantiated (no Ollama or OpenAI client is created for Claude-only installs).

Embeddings come from the project's own :mod:`agent_mem.memory.semantic` embedder so that the mem0 index and
the SQLite vectors use identical vectors (fair comparison in §8, one model cache, E5 prefixes kept).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mem0.configs.embeddings.base import BaseEmbedderConfig
from mem0.configs.llms.base import BaseLlmConfig
from mem0.embeddings.base import EmbeddingBase
from mem0.utils.factory import EmbedderFactory, LlmFactory

from agent_mem.core.config import Config
from agent_mem.memory import semantic

COLLECTION = "agent_mem"
EMBEDDER_PROVIDER = "agent_mem"
LLM_PROVIDERS = {
    "claude": "agent_mem_claude",
    "codex": "agent_mem_codex",
    "copilot": "agent_mem_copilot",
    "ollama": "ollama",
    "fake": "agent_mem_fake",
}

_EMBEDDERS: dict[str, semantic.Embedder] = {}


@dataclass(frozen=True)
class Fact:
    id: str
    text: str
    score: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class SemanticEmbedder(EmbeddingBase):
    """mem0 ``EmbeddingBase`` over :class:`agent_mem.memory.semantic.Embedder` (looked up by handle)."""

    def __init__(self, config: BaseEmbedderConfig) -> None:
        super().__init__(config)
        self._e = _EMBEDDERS[str(config.model)]

    def embed(self, text, memory_action=None):  # type: ignore[override]
        if memory_action == "search":
            return self._e.query(text).tolist()
        return self._e.passages([text])[0].tolist()

    def embed_batch(self, texts, memory_action="add"):  # type: ignore[override]
        if memory_action == "search":
            return [self._e.query(t).tolist() for t in texts]
        return self._e.passages(list(texts)).tolist()


def _register() -> None:
    EmbedderFactory.provider_to_class[EMBEDDER_PROVIDER] = "agent_mem.observe.mem0_adapter.SemanticEmbedder"
    LlmFactory.provider_to_class["agent_mem_claude"] = ("agent_mem.observe.providers.ClaudeCliLLM", BaseLlmConfig)
    LlmFactory.provider_to_class["agent_mem_codex"] = ("agent_mem.observe.providers.CodexCliLLM", BaseLlmConfig)
    LlmFactory.provider_to_class["agent_mem_copilot"] = ("agent_mem.observe.providers.CopilotCliLLM", BaseLlmConfig)
    LlmFactory.provider_to_class["agent_mem_fake"] = ("agent_mem.observe.providers.FakeLLM", BaseLlmConfig)


def _ensure_env(mem0_dir: Path, entity_model: str = "en_core_web_sm", model_path: Path | None = None) -> None:
    """Point mem0 at our directory. Its modules copied the value at import time, so patch those too."""
    import mem0.configs.base as mem0_configs_base
    import mem0.memory.main as mem0_main
    import mem0.memory.setup as mem0_setup
    import mem0.memory.telemetry as mem0_telemetry

    os.environ["MEM0_TELEMETRY"] = "False"
    os.environ["MEM0_DIR"] = str(mem0_dir)
    mem0_telemetry.MEM0_TELEMETRY = False
    mem0_main.MEM0_TELEMETRY = False
    for module in (mem0_setup, mem0_main, mem0_configs_base):
        setattr(module, "mem0_dir", str(mem0_dir))  # noqa: B010  (module globals read at call time)
    mem0_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(mem0_dir, 0o700)
    _use_entity_model(entity_model, model_path)


def spacy_model_available(name: str = "en_core_web_sm") -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


def _use_entity_model(name: str = "en_core_web_sm", path: Path | None = None) -> None:
    """mem0 loads ``en_core_web_sm`` for entity linking; on German facts it returns fragments ("Der", "und
    nur"). Load the configured model into mem0's loader instead. Without the model mem0 would run
    ``spacy download`` (an install into the live environment, which ends the process in a tool install), so
    mark it as failed: entity linking is skipped, facts and search are unaffected (docs/PLAN.md B.27)."""
    from mem0.utils import spacy_models

    if path is not None and spacy_models._nlp_full is None:
        import spacy

        spacy_models._nlp_full = spacy.load(path)  # downloaded by `agent-mem models install`
        return
    if not spacy_model_available(name):
        spacy_models._load_failed_full = True
        spacy_models._load_failed_lemma = True
        return
    if name != "en_core_web_sm" and spacy_models._nlp_full is None:
        import spacy

        spacy_models._nlp_full = spacy.load(name)


class Mem0Adapter:
    def __init__(
        self,
        config: Config,
        *,
        llm: str = "ollama",
        llm_model: str | None = None,
        custom_instructions: str | None = None,
        embedder: semantic.Embedder | None = None,
        mem0_dir: Path | None = None,
    ) -> None:
        self.config = config
        self.llm, self.llm_model, self.custom_instructions = llm, llm_model, custom_instructions
        self.mem0_dir = mem0_dir or (config.data_dir / "mem0")
        from agent_mem.observe import concepts

        _ensure_env(self.mem0_dir, config.observe.entity_model, concepts.model_path(config))
        _register()
        from mem0 import Memory
        from mem0.configs.base import MemoryConfig

        self.embedder = embedder or semantic.load_embedder(config, allow_download=True)
        if self.embedder is None:
            raise RuntimeError("no embedder available (install the semantic extra or configure ollama)")
        handle = f"{id(self.embedder)}:{self.embedder.model}"
        _EMBEDDERS[handle] = self.embedder
        dims = int(self.embedder.query("dimension probe").shape[0])
        if llm not in LLM_PROVIDERS:
            raise ValueError(f"unknown llm provider {llm!r}")
        llm_defaults = {
            "ollama": "qwen3.5:4b-mlx",
            "claude": "haiku",
            "codex": "gpt-6-luna",
            "copilot": "auto",
            "fake": "fake",
        }
        mem0_config = MemoryConfig(
            **{
                "llm": {
                    "provider": "ollama",  # valid placeholder name, replaced below (A.2)
                    "config": {"model": llm_model or llm_defaults[llm], "temperature": 0.0},
                },
                "embedder": {"provider": "ollama", "config": {"model": handle, "embedding_dims": dims}},
                "vector_store": {
                    "provider": "qdrant",
                    "config": {
                        "collection_name": COLLECTION,
                        "embedding_model_dims": dims,
                        "path": str(self.mem0_dir / "qdrant"),
                        "on_disk": True,
                    },
                },
                "history_db_path": str(self.mem0_dir / "history.db"),
                **({"custom_instructions": custom_instructions} if custom_instructions else {}),
            }
        )
        mem0_config.llm.provider = LLM_PROVIDERS[llm]
        mem0_config.embedder.provider = EMBEDDER_PROVIDER
        self.memory = Memory(mem0_config)

    # --- plan §4.5 -----------------------------------------------------------------
    def extract(
        self, messages: list[dict[str, str]], namespace: str, metadata: dict[str, Any] | None = None
    ) -> list[Fact]:
        result: Any = self.memory.add(messages, user_id=namespace, metadata=metadata or {})
        return [
            Fact(id=str(r["id"]), text=str(r["memory"]), metadata=dict(r.get("metadata") or {}))
            for r in result.get("results", [])
            if r.get("event", "ADD") == "ADD"
        ]

    def add_raw(self, texts: list[str], namespace: str, metadata: dict[str, Any] | None = None) -> list[Fact]:
        """Store texts as-is, without the extraction LLM call (used by ``reindex``)."""
        messages = [{"role": "user", "content": t} for t in texts]
        result: Any = self.memory.add(messages, user_id=namespace, metadata=metadata or {}, infer=False)
        return [Fact(id=str(r["id"]), text=str(r["memory"])) for r in result.get("results", [])]

    def search(self, query: str, namespace: str, k: int = 5, exclude: frozenset[str] = frozenset()) -> list[Fact]:
        result: Any = self.memory.search(query, filters={"user_id": namespace}, limit=k + len(exclude))
        facts = [
            Fact(
                id=str(r["id"]),
                text=str(r["memory"]),
                score=float(r["score"]) if r.get("score") is not None else None,
                metadata=dict(r.get("metadata") or {}),
            )
            for r in result.get("results", [])
            if str(r["id"]) not in exclude
        ]
        return facts[:k]

    def forget(self, mem0_id: str) -> bool:
        """Remove a fact from Qdrant, entity links and history. False if mem0 no longer has it."""
        try:
            self.memory.delete(mem0_id)
        except ValueError:
            return False
        return True

    def reindex(self, facts: list[tuple[str, str, dict[str, Any]]]) -> int:
        """``facts`` are (text, namespace, metadata). Wipes the index and re-adds without a model call."""
        self.close()
        shutil.rmtree(self.mem0_dir / "qdrant", ignore_errors=True)
        (self.mem0_dir / "history.db").unlink(missing_ok=True)
        self.__init__(  # type: ignore[misc]
            self.config,
            llm=self.llm,
            llm_model=self.llm_model,
            custom_instructions=self.custom_instructions,
            embedder=self.embedder,
            mem0_dir=self.mem0_dir,
        )
        count = 0
        for text, namespace, metadata in facts:
            count += len(self.add_raw([text], namespace, metadata))
        return count

    def close(self) -> None:
        client = getattr(getattr(self.memory, "vector_store", None), "client", None)
        if client is not None:
            client.close()
