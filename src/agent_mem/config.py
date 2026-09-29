"""Configuration and data locations.

Standard library only (hook path). Invalid values never crash: they fall back to
the default and are reported through ``Config.warnings``.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

APP_NAME = "agent-mem"
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

    session_start: int = 600
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
    # Cosine similarity floor for vector candidates (E5 similarities are high; tuned for multilingual-e5-small).
    min_vector_score: float = 0.78


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
class Summarize:
    enabled: bool = False
    harness: str = "claude"
    daily_limit: int = 5
    timeout_seconds: int = 120
    max_input_chars: int = 16_000


@dataclass
class Semantic:
    enabled: bool = True
    model: str = "intfloat/multilingual-e5-small"
    batch_size: int = 32


@dataclass
class Federation:
    claude: bool = True
    codex: bool = True


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
    summarize: Summarize = field(default_factory=Summarize)
    semantic: Semantic = field(default_factory=Semantic)
    federation: Federation = field(default_factory=Federation)
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
    def config_path(self) -> Path:
        return self.data_dir / "config.json"


def default_data_dir() -> Path:
    override = os.environ.get("AGENT_MEM_DATA_DIR")
    if override:
        return Path(override).expanduser()
    home = Path.home()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) / APP_NAME if base else home / "AppData" / "Local" / APP_NAME
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP_NAME
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg) if xdg else home / ".local" / "share") / APP_NAME


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


def load(data_dir: Path | None = None) -> Config:
    config = Config(data_dir=(data_dir or default_data_dir()).expanduser())
    _merge(config, _read_json(config.config_path, config.warnings), "", config.warnings)
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
