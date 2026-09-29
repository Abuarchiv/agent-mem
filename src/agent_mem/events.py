"""The normalized event that every harness payload is translated into."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any

KINDS = {
    "session_start",
    "prompt",
    "pre_tool",
    "tool",
    "stop",
    "subagent_stop",
    "compact",
    "session_end",
}

HARNESSES = {"claude", "codex", "copilot", "opencode", "import"}

OWN_TOOL_MARKERS = ("agent-mem", "agent_mem", "agentmem")
OWN_TOOL_NAMES = {"mem_search", "mem_timeline", "mem_get", "mem_remember", "mem_forget"}


class PayloadError(ValueError):
    """The payload does not match the expected shape for this harness and event."""


@dataclass
class Event:
    harness: str
    kind: str
    session_id: str
    ts: str
    cwd: str | None = None
    source: str | None = None
    prompt: str | None = None
    tool: str | None = None
    tool_use_id: str | None = None
    tool_input: Any = None
    tool_output: str | None = None
    tool_failed: bool = False
    exit_code: int | None = None
    error: str | None = None
    answer: str | None = None
    native_event_id: str | None = None
    raw_kind: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Event:
        allowed = set(cls.__dataclass_fields__)
        values = {key: value for key, value in data.items() if key in allowed}
        if values.get("kind") not in KINDS:
            raise PayloadError(f"unknown kind {values.get('kind')!r}")
        return cls(**values)

    @property
    def is_own_tool(self) -> bool:
        if not self.tool:
            return False
        name = self.tool.lower()
        if any(marker in name for marker in OWN_TOOL_MARKERS):
            return True
        return any(name == own or name.endswith(f"_{own}") or name.endswith(f"__{own}") for own in OWN_TOOL_NAMES)


def get(payload: dict[str, Any], *names: str) -> Any:
    """Look up the first present key, tolerating snake_case, camelCase and PascalCase."""
    for name in names:
        if name in payload:
            return payload[name]
    lowered = {str(key).lower().replace("_", ""): value for key, value in payload.items()}
    for name in names:
        key = name.lower().replace("_", "")
        if key in lowered:
            return lowered[key]
    return None


def text_of(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return None


def require_session(payload: dict[str, Any], *names: str) -> str:
    value = get(payload, *names)
    if not isinstance(value, str | int) or not str(value).strip():
        raise PayloadError("missing session id")
    text = str(value).strip()
    if len(text) > 256:
        raise PayloadError("session id too long")
    return text


_EXIT_RE = re.compile(
    r"(?i)(?:exit(?:ed)?(?: with)?(?: status| code|_code)?|return code|exit status)\s*[:=]?\s*(-?\d{1,3})\b"
)
_EXIT_KEYS = ("exit_code", "exitCode", "exit", "returncode", "return_code", "exit_status", "exitStatus")


def output_text(value: Any) -> str | None:
    """Best-effort text of a tool response of any shape."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [output_text(item) for item in value]
        joined = "\n".join(part for part in parts if part)
        return joined or None
    if isinstance(value, dict):
        stdout = value.get("stdout")
        stderr = value.get("stderr")
        if isinstance(stdout, str) or isinstance(stderr, str):
            return "\n".join(part for part in (stdout, stderr) if isinstance(part, str) and part)
        for key in ("textResultForLlm", "output", "content", "result", "text", "error", "message"):
            inner = value.get(key)
            if inner is not None:
                text = output_text(inner)
                if text:
                    return text
        try:
            return json.dumps(value, ensure_ascii=False)[:20_000]
        except (TypeError, ValueError):
            return None
    return str(value)


def exit_code_of(value: Any, text: str | None, depth: int = 0) -> int | None:
    if isinstance(value, dict) and depth < 4:
        for key in _EXIT_KEYS:
            candidate = value.get(key)
            if isinstance(candidate, int) and not isinstance(candidate, bool):
                return candidate
        for inner in value.values():
            if isinstance(inner, dict):
                found = exit_code_of(inner, None, depth + 1)
                if found is not None:
                    return found
    if text and depth == 0:
        match = _EXIT_RE.search(text[:2000]) or _EXIT_RE.search(text[-2000:])
        if match:
            return int(match.group(1))
    return None


def parse_json_maybe(value: Any) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in "{[":
            try:
                return json.loads(stripped)
            except ValueError:
                return value
    return value
