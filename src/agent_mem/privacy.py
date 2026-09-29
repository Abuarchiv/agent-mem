"""Redaction, private sections, excluded paths and size limits.

Everything that is stored passes through :func:`clean_text`. Standard library only.
"""

from __future__ import annotations

import fnmatch
import re
from collections.abc import Iterable
from pathlib import PurePosixPath

REDACTED = "[REDACTED:{kind}]"

# (kind, pattern). Ordered from most to least specific.
_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "private_key",
        re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)"),
    ),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}")),
    ("openai_key", re.compile(r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})")),
    ("gitlab_token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}")),
    ("stripe_key", re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("npm_token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("pypi_token", re.compile(r"\bpypi-[A-Za-z0-9_-]{50,}")),
    ("hf_token", re.compile(r"\bhf_[A-Za-z0-9]{30,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{12,}")),
    ("url_credentials", re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s:/@]+:[^\s@/]+@")),
    (
        "assignment",
        re.compile(
            r"(?i)\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|passphrase|"
            r"client[_-]?secret|private[_-]?key|access[_-]?key|auth[_-]?token|credential)[A-Za-z0-9_]*)"
            r"(\s*[:=]\s*|\"\s*:\s*\")(\"[^\"\r\n]{4,}\"|'[^'\r\n]{4,}'|[^\s,;\"'}\]]{6,})"
        ),
    ),
]

_PRIVATE_BLOCK = re.compile(r"<private>[\s\S]*?(?:</private>|$)", re.IGNORECASE)
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_ERROR_LINE = re.compile(
    r"(?i)(error|exception|traceback|failed|failure|fatal|panic|denied|not found|cannot|undefined|"
    r"ERR!|assert|✗|✘)"
)


_HARMLESS_VALUES = {"true", "false", "null", "none", "undefined", "required", "optional", "string", "redacted"}


def _redact_assignment(match: re.Match[str]) -> str:
    value = match.group(3).strip("\"'")
    if value.isdigit() or value.lower() in _HARMLESS_VALUES or value.startswith(("[REDACTED", "$", "{{", "<")):
        return match.group(0)
    return f"{match.group(1)}{match.group(2)}{REDACTED.format(kind='secret')}"


def redact(text: str) -> tuple[str, int]:
    """Replace known secret formats. Returns the new text and the number of replacements."""
    count = 0
    for kind, pattern in _SECRET_PATTERNS:
        if kind == "url_credentials":
            text, n = pattern.subn(lambda m, k=kind: f"{m.group(1)}{REDACTED.format(kind=k)}@", text)
        elif kind == "assignment":
            text, n = pattern.subn(_redact_assignment, text)
        else:
            text, n = pattern.subn(REDACTED.format(kind=kind), text)
        count += n
    return text, count


def strip_private(text: str) -> str:
    return _PRIVATE_BLOCK.sub("[private]", text)


def strip_control(text: str) -> str:
    return _CONTROL.sub("", _ANSI.sub("", text))


def clean_text(text: str, limit: int) -> str:
    """Private sections removed, control characters removed, secrets redacted, size bounded."""
    if not text:
        return ""
    text = strip_control(strip_private(text))
    text, _ = redact(text)
    return truncate(text, limit)


def truncate(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    marker = "\n…[truncated]…\n"
    head = int(limit * 0.6)
    tail = max(limit - head - len(marker), 0)
    return text[:head] + marker + (text[-tail:] if tail else "")


def denoise_output(text: str, limit: int) -> str:
    """Keep head, error lines and tail of long tool output (SeCom-style denoising)."""
    text = strip_control(text)
    if len(text) <= limit:
        return text
    lines = text.splitlines()
    head = lines[:15]
    tail = lines[-15:]
    middle = lines[15:-15]
    errors = [line for line in middle if _ERROR_LINE.search(line)][:40]
    kept = [*head, "…", *errors, "…", *tail] if errors else [*head, "…", *tail]
    return truncate("\n".join(kept), limit)


def error_lines(text: str, limit: int = 5) -> list[str]:
    found = [line.strip() for line in strip_control(text).splitlines() if _ERROR_LINE.search(line)]
    return [line[:300] for line in found[:limit]]


def path_excluded(path: str, globs: Iterable[str]) -> bool:
    normalized = path.replace("\\", "/")
    name = PurePosixPath(normalized).name
    for pattern in globs:
        if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(normalized, pattern):
            return True
        if pattern.startswith("**/") and fnmatch.fnmatch(normalized, pattern[3:]):
            return True
    return False
