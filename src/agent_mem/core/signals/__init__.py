"""Deterministic signals extracted from tool calls and prompts. Pure functions, standard library only."""

from __future__ import annotations

from agent_mem.core.signals.errors import (
    error_signature,
    looks_like_error,
)
from agent_mem.core.signals.prompts import (
    canonical_rule,
    continues_turn,
    decision_sentences,
    from_harness,
    is_correction,
    mentions_rule,
    preference_pairs,
    request_text,
)
from agent_mem.core.signals.text import (
    about_extraction,
    first_line,
    headline,
    without_line_refs,
)
from agent_mem.core.signals.tools import (
    ToolSignal,
    analyze_tool,
    classify_tool,
    command_key,
    command_kind,
    command_of,
    commits_made,
    defined_names,
    files_of,
    fixable,
    packages_of,
    reusable_command,
    reverted_files,
    same_tool,
    shell_read_files,
    tools_run,
)

IMPORTANCE = {
    "read": 0.1,
    "command": 0.3,
    "edit": 0.5,
    "test": 0.5,
    "error": 0.6,
    "answer": 0.6,
    "decision": 0.7,
    "dead_end": 0.7,
    "commit": 0.7,
    "correction": 0.8,
    "fixed": 0.9,
}


__all__ = [
    "IMPORTANCE",
    "ToolSignal",
    "about_extraction",
    "analyze_tool",
    "canonical_rule",
    "classify_tool",
    "command_key",
    "command_kind",
    "command_of",
    "commits_made",
    "continues_turn",
    "decision_sentences",
    "defined_names",
    "error_signature",
    "files_of",
    "first_line",
    "fixable",
    "from_harness",
    "headline",
    "is_correction",
    "looks_like_error",
    "mentions_rule",
    "packages_of",
    "preference_pairs",
    "request_text",
    "reusable_command",
    "reverted_files",
    "same_tool",
    "shell_read_files",
    "tools_run",
    "without_line_refs",
]
