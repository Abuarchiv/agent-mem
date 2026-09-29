"""Translate harness-specific hook payloads into :class:`agent_mem.events.Event`."""

from __future__ import annotations

from typing import Any

from ..events import Event, PayloadError
from . import claude, codex, copilot, opencode

_NORMALIZERS = {
    "claude": claude.normalize,
    "codex": codex.normalize,
    "copilot": copilot.normalize,
    "opencode": opencode.normalize,
}


def normalize(harness: str, payload: Any, event_name: str | None = None) -> Event | None:
    """Return the normalized event, ``None`` for events we deliberately ignore.

    Raises :class:`PayloadError` for payloads that do not match the expected shape.
    """
    normalizer = _NORMALIZERS.get(harness)
    if normalizer is None:
        raise PayloadError(f"unknown harness {harness!r}")
    if not isinstance(payload, dict):
        raise PayloadError("payload must be a JSON object")
    return normalizer(payload, event_name)


__all__ = ["normalize"]
