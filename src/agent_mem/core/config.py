"""Configuration and data locations.

Standard library only (hook path). Invalid values never crash: they fall back to
the default and are reported through ``Config.warnings``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

from agent_mem.core.paths import default_data_dir

PROJECT_FILE = ".agent-mem.json"

DEFAULT_EXCLUDE_GLOBS = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    "id_ecdsa*",
    ".npmrc",
    ".netrc",
    ".pypirc",
    "secrets/**",
    "**/secrets/**",
    "*.kdbx",
    "credentials*",
]


@dataclass
class Budgets:
    """Maximum injected tokens per moment (estimated as characters / 4)."""

    session_start: int = 1000
    prompt: int = 200
    failure: int = 120
    warning: int = 80
    compact: int = 400


@dataclass
class Retrieval:
    inject_min_score: float = 0.35
    min_term_coverage: float = 0.5
    max_per_session: int = 3
    rrf_k: int = 60
    current_project_boost: float = 1.2
    # Cosine similarity floor for vector candidates, calibrated per embedder (docs/PLAN.md B.23):
    # MiniLM-L12-v2 0.3 (fixture abstention 0.6, LongMemEval R@5 0.925); multilingual-e5-small needs 0.78.
    min_vector_score: float = 0.3


@dataclass
class Retention:
    payload_days: int = 30
    access_days: int = 180
    backup_keep: int = 7
    backup_every_hours: int = 24
    max_db_mb: int = 1024
    stale_turn_minutes: int = 30


@dataclass
class Limits:
    prompt_chars: int = 16_000
    answer_chars: int = 16_000
    tool_output_chars: int = 8_000
    tool_input_chars: int = 4_000
    stdin_bytes: int = 4_194_304


@dataclass
class Rules:
    auto_enable: bool = False
    min_corrections: int = 2
    expire_days: int = 90


@dataclass
class Semantic:
    enabled: bool = True
    # E2 (docs/PLAN.md B.19): same Recall@5 as embeddinggemma at a fifth of the size; e5-small needs a custom registration.
    model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    batch_size: int = 32
    # A new fact this close to an older one of the same project replaces it (B.32: on real facts every pair
    # from 0.90 up was the same statement, reworded or updated). 1.0 turns it off.
    duplicate_min_cosine: float = 0.90


@dataclass
class Observe:
    """Background observer (docs/PLAN.md §4.3 to §4.6)."""

    enabled: bool = True
    # Provider chain in order; a stage is skipped when its binary is missing, paused or over budget.
    # "ollama" (local model) is opt-in: add it here to use it as a fallback stage (B.20).
    providers: list[str] = field(default_factory=lambda: ["claude", "codex", "copilot"])
    # Default: a turn only goes to the vendor that already saw it, then raw (D12).
    cross_vendor: bool = False
    claude_model: str = "haiku"
    # Cheapest per CLI (2026-10-12); a plan without the model falls back to the CLI's default.
    codex_model: str = "gpt-6-luna"
    copilot_model: str = "auto"
    ollama_model: str = "qwen3.5:4b-mlx"
    # spaCy model for mem0's entity linking (the concepts in the viewer's graph). mem0's default is English;
    # use the language your facts are written in, e.g. "de_core_news_sm". Installed with the tool (README).
    entity_model: str = "en_core_web_sm"
    daily_limit: int = 300
    idle_seconds: int = 90
    lease_seconds: int = 900
    bundle_turns: int = 5
    bundle_tokens: int = 6_000
    tool_output_chars: int = 800
    pause_minutes: int = 60

    def stage_for(self, harness: str) -> tuple[str, str] | None:
        """The stage and model turns from ``harness`` go to first, as in ``observe.providers.chain`` (without
        pauses, which live in the database). Each harness CLI is its own vendor (D12)."""
        import shutil

        if not self.enabled:
            return None
        for name in self.providers:
            if (self.cross_vendor or name in {"ollama", harness}) and shutil.which(name):
                return name, getattr(self, f"{name}_model", "") or "CLI default"
        return None


@dataclass
class Viewer:
    """``agent-mem serve``: the read-only page on 127.0.0.1, started by the SessionStart hook."""

    enabled: bool = True
    port: int = 37778
    refresh_seconds: int = 10


@dataclass
class Config:
    data_dir: Path
    capture: bool = True
    hook_deadline_ms: int = 400
    exclude_globs: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE_GLOBS))
    excluded_projects: list[str] = field(default_factory=list)
    budgets: Budgets = field(default_factory=Budgets)
    retrieval: Retrieval = field(default_factory=Retrieval)
    retention: Retention = field(default_factory=Retention)
    limits: Limits = field(default_factory=Limits)
    rules: Rules = field(default_factory=Rules)
    semantic: Semantic = field(default_factory=Semantic)
    observe: Observe = field(default_factory=Observe)
    viewer: Viewer = field(default_factory=Viewer)
    warnings: list[str] = field(default_factory=list)

    @property
    def db_path(self) -> Path:
        return self.data_dir / "memory.db"

    @property
    def spool_dir(self) -> Path:
        return self.data_dir / "spool"

    @property
    def quarantine_dir(self) -> Path:
        return self.data_dir / "quarantine"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def log_dir(self) -> Path:
        return self.data_dir / "logs"

    @property
    def model_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def lock_path(self) -> Path:
        return self.data_dir / "indexer.lock"

    @property
    def observe_lock_path(self) -> Path:
        return self.data_dir / "observe.lock"

    @property
    def mem0_dir(self) -> Path:
        return self.data_dir / "mem0"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "config.json"


def _merge(target: Any, values: dict[str, Any], prefix: str, warnings: list[str]) -> None:
    known = {f.name: f for f in fields(target)}
    for key, value in values.items():
        name = f"{prefix}{key}"
        if key in {"data_dir", "warnings"} or key not in known:
            warnings.append(f"config: unknown key '{name}' ignored")
            continue
        current = getattr(target, key)
        if is_dataclass(current):
            if isinstance(value, dict):
                _merge(current, value, f"{name}.", warnings)
            else:
                warnings.append(f"config: '{name}' must be an object")
            continue
        if isinstance(current, bool):
            ok = isinstance(value, bool)
        elif isinstance(current, int):
            ok = isinstance(value, int) and not isinstance(value, bool) and value >= 0
        elif isinstance(current, float):
            ok = isinstance(value, int | float) and not isinstance(value, bool) and value >= 0
            value = float(value) if ok else value
        elif isinstance(current, str):
            ok = isinstance(value, str) and len(value) < 1024
        elif isinstance(current, list):
            ok = isinstance(value, list) and all(isinstance(item, str) for item in value)
        else:
            ok = False
        if ok:
            setattr(target, key, value)
        else:
            warnings.append(f"config: invalid value for '{name}', default kept")


def _read_json(path: Path, warnings: list[str]) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as error:
        warnings.append(f"config: cannot read {path}: {error.strerror}")
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        warnings.append(f"config: {path} is not valid JSON")
        return {}
    if not isinstance(value, dict):
        warnings.append(f"config: {path} must contain an object")
        return {}
    return value


# A well-typed value can still break agent-mem silently: a deadline of 0 spools every event, stdin_bytes 0 records
# nothing, backup_keep 0 deletes every backup, duplicate_min_cosine 0 retires every older fact. Range checked here.
_BOUNDS: dict[str, tuple[float, float]] = {
    "hook_deadline_ms": (100, 10_000),
    "budgets.session_start": (0, 8_000),
    "budgets.prompt": (0, 4_000),
    "budgets.failure": (0, 2_000),
    "budgets.warning": (0, 2_000),
    "budgets.compact": (0, 8_000),
    "retrieval.inject_min_score": (0, 1),
    "retrieval.min_term_coverage": (0, 1),
    "retrieval.max_per_session": (1, 1_000),
    "retrieval.rrf_k": (1, 1_000),
    "retrieval.min_vector_score": (0, 1),
    "retention.payload_days": (1, 36_500),
    "retention.access_days": (1, 36_500),
    "retention.backup_keep": (1, 1_000),
    "retention.backup_every_hours": (1, 8_760),
    "retention.max_db_mb": (64, 1_048_576),
    "retention.stale_turn_minutes": (1, 10_080),
    "limits.prompt_chars": (200, 1_000_000),
    "limits.answer_chars": (200, 1_000_000),
    "limits.tool_output_chars": (200, 1_000_000),
    "limits.tool_input_chars": (200, 1_000_000),
    "limits.stdin_bytes": (65_536, 64 * 1_048_576),
    "rules.min_corrections": (1, 100),
    "rules.expire_days": (1, 36_500),
    "semantic.batch_size": (1, 1_024),
    "semantic.duplicate_min_cosine": (0.8, 1),
    "observe.lease_seconds": (60, 86_400),
    "observe.bundle_turns": (1, 50),
    "observe.bundle_tokens": (500, 200_000),
    "observe.tool_output_chars": (100, 100_000),
    "viewer.port": (1024, 65535),
    "viewer.refresh_seconds": (2, 3_600),
}


def _check_bounds(config: Config) -> None:
    defaults = Config(data_dir=config.data_dir)
    for path, (low, high) in _BOUNDS.items():
        *parents, key = path.split(".")
        target, default = config, defaults
        for part in parents:
            target, default = getattr(target, part), getattr(default, part)
        if not low <= getattr(target, key) <= high:
            config.warnings.append(f"config: '{path}' must be between {low:g} and {high:g}, default kept")
            setattr(target, key, getattr(default, key))


def load(data_dir: Path | None = None) -> Config:
    config = Config(data_dir=(data_dir or default_data_dir()).expanduser())
    _merge(config, _read_json(config.config_path, config.warnings), "", config.warnings)
    _check_bounds(config)
    return config


@dataclass
class ProjectSettings:
    capture: bool = True
    exclude_globs: list[str] = field(default_factory=list)


def load_project_settings(root: Path | None) -> ProjectSettings:
    """Per-project overrides from ``.agent-mem.json``. Only harmless keys are honored."""
    settings = ProjectSettings()
    if root is None:
        return settings
    ignored: list[str] = []
    values = _read_json(root / PROJECT_FILE, ignored)
    capture = values.get("capture")
    if isinstance(capture, bool):
        settings.capture = capture
    exclude = values.get("exclude")
    if isinstance(exclude, list):
        settings.exclude_globs = [item for item in exclude if isinstance(item, str)][:100]
    return settings


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
