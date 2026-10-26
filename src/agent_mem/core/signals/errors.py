"""Error lines and their stable signatures, so the same failure is recognised across runs. Pure functions, standard library only."""

from __future__ import annotations

import hashlib
import re

from agent_mem.core.privacy import strip_control

_ERROR_START = re.compile(
    r"(?i)(error[:\[ ]|exception|traceback|failed|failure|fatal:|panic:|ERR!|cannot find|not found|"
    r"undefined reference|segmentation fault|no such file|permission denied|assert)"
)
# Lines that frame an error without naming it: a traceback header, a pytest section rule, a progress row.
_ERROR_FRAME = re.compile(
    r"(?i)^(?:traceback\b.*|during handling of the above exception.*|the above exception was the direct cause.*"
    r"|[=_-]{3,}.*[=_-]{3,}|[.FEsxX]+\s*\[\s*\d+%\].*)$"
)
# A test runner's summary line names the failing test, the most specific thing a run says.
_TEST_FAILED = re.compile(r"^(?:FAILED|ERROR)\s+\S+::\S+")
# The line that ends a Python traceback ("KeyError: 'x'", pytest's "E   AssertionError: ...").
_EXCEPTION = re.compile(r"^(?:E\s+)?(?:[A-Za-z_]\w*\.)*[A-Z]\w*(?:Error|Exception|Exit|Interrupt|Warning)\b(?::|$)")
_RAISED_IN = re.compile(r'^File ".*", line \d+, in (\S+)')
_SIG_PATH = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}|[\w.-]+\.[a-z]{1,5}:\d+(?::\d+)?")
_SIG_HEX = re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{7,40}\b", re.IGNORECASE)
_SIG_NUM = re.compile(r"\b\d+(?:\.\d+)?\b")
_SIG_QUOTED = re.compile(r"'[^']{1,80}'|\"[^\"]{1,80}\"|`[^`]{1,80}`")
_SIG_SPACE = re.compile(r"\s+")


def looks_like_error(line: str) -> bool:
    """True when the line names an error; a bare non-zero exit (grep without match, `| head`) does not."""
    return bool(_ERROR_START.search(line)) and not _ERROR_FRAME.match(line.strip())


def error_signature(text: str | None) -> tuple[str, str] | None:
    """Stable signature of an error: (hash, representative line)."""
    if not text:
        return None
    lines = [line.strip() for line in strip_control(text).splitlines() if line.strip()]
    if not lines:
        return None
    representative = _representative(lines)
    # pytest cuts the reason after " - " to the terminal width: the test alone is the error.
    key = representative.split(" - ", 1)[0] if _TEST_FAILED.match(representative) else representative
    normalized = _SIG_QUOTED.sub("<q>", key)
    normalized = _SIG_PATH.sub("<path>", normalized)
    normalized = _SIG_HEX.sub("<hex>", normalized)
    normalized = _SIG_NUM.sub("<n>", normalized)
    normalized = _SIG_SPACE.sub(" ", normalized).strip().lower()[:300]
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return digest, representative[:300]


def _representative(lines: list[str]) -> str:
    """The line that names the error: the failing test, else the last exception of a traceback (the cause a chained
    traceback ends with), else the first line that reads as an error. Headers never: every pytest run and every
    traceback starts with the same one."""
    content = [line for line in lines if not _ERROR_FRAME.match(line)] or lines
    test = next((line for line in content if _TEST_FAILED.match(line)), None)
    if test:
        return test
    exception = next((line for line in reversed(content) if _EXCEPTION.match(line)), None)
    if exception:
        exception = re.sub(r"^E\s+", "", exception)
        # A bare `AssertionError` says nothing: the function it was raised in tells two of them apart.
        where = next((m[1] for line in reversed(content) if (m := _RAISED_IN.match(line))), None)
        return f"{exception} in {where}" if where and ":" not in exception else exception
    return next((line for line in content if _ERROR_START.search(line)), content[-1])
