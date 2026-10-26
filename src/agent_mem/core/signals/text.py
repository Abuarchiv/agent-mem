"""Small text helpers: a fact's first line and headline, stale line references, the extractor's notes to itself. Pure functions, standard library only."""

from __future__ import annotations

import re

# A line reference is stale after the next change; the file name stays ("`cli/commands.py:302-311`" -> path).
# Only after a source file's suffix: "myhost.dev:3000" or "github.com:22" keep their port.
_LINE_REF = re.compile(
    r"(\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sql|sh|md|toml|yaml|yml|json|css|html))"
    r":\d+(?:[-–]\d+)?(?:\s*[,/]\s*\d+(?:[-–]\d+)?)*\b"
)
# The extraction model talking about its own task instead of the project ("nothing new is recorded here"): only
# whole statements of that kind, never a fact that merely mentions extraction or storage.
_ABOUT_EXTRACTION = re.compile(
    r"(?i)(hier wird nichts neues festgehalten|daher wird (hier )?nichts|keine neuen dauerhaften fakten|"
    r"^\s*(nothing|no new (durable |lasting )?facts?) (new )?(to|is|are|will be) (record|remember|stor|extract)\w*|"
    r"(enthält|contains) keine (neuen )?(dauerhaften )?(fakten|informationen)|"
    r"\bno (new )?(durable|lasting) facts?\b)"
)


def without_line_refs(text: str) -> str:
    return _LINE_REF.sub(r"\1", text)


def about_extraction(text: str) -> bool:
    return bool(_ABOUT_EXTRACTION.search(text))


def headline(text: str, limit: int = 160) -> str:
    """The first line, cut at a word boundary with an ellipsis instead of mid-word."""
    line = first_line(text, 100_000)
    if len(line) <= limit:
        return line
    cut = line[: limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,;:") + "…"


def first_line(text: str, limit: int = 160) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#>*- ").strip()
        if stripped:
            return stripped[:limit]
    return ""
