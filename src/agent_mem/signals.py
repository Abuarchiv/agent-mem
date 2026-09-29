"""Deterministic signals extracted from tool calls and prompts. Pure functions, standard library only."""

from __future__ import annotations

import hashlib
import re
import shlex
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from .privacy import strip_control

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

_SHELL = {
    "bash",
    "shell",
    "exec_command",
    "local_shell",
    "run_terminal_cmd",
    "powershell",
    "shell_command",
    "run_shell_command",
    "terminal",
    "execute_command",
    "run_in_terminal",
    "container.exec",
}
_EDIT = {
    "edit",
    "write",
    "multiedit",
    "apply_patch",
    "str_replace_editor",
    "str_replace_based_edit_tool",
    "create",
    "notebookedit",
    "patch",
    "edit_file",
    "write_file",
    "create_file",
    "replace",
    "insert_edit_into_file",
    "update_file",
}
_READ = {"read", "view", "read_file", "cat", "open_file", "notebookread", "read_many_files"}
_WEB = {"webfetch", "websearch", "web_fetch", "web_search", "fetch", "browser", "search_web", "fetch_url"}

_MULTI = {
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "npx",
    "cargo",
    "go",
    "make",
    "git",
    "uv",
    "poetry",
    "pip",
    "pip3",
    "docker",
    "kubectl",
    "dotnet",
    "mvn",
    "gradle",
    "./gradlew",
    "gradlew",
    "deno",
    "just",
    "task",
    "rake",
    "bundle",
    "mix",
    "swift",
    "composer",
    "hatch",
    "tox",
    "nox",
    "pdm",
    "rye",
    "turbo",
    "nx",
}
_TEST = re.compile(
    r"(?i)(\btest\b|pytest|jest|vitest|mocha|rspec|phpunit|ctest|\btox\b|\bnox\b|go test|cargo test|playwright|cypress|unittest)"
)
_BUILD = re.compile(
    r"(?i)(\bbuild\b|\bcompile\b|\btsc\b|\bmake\b|cargo build|go build|webpack|vite build|gradle assemble)"
)
_LINT = re.compile(
    r"(?i)(\blint\b|ruff|eslint|flake8|pylint|clippy|biome|prettier --check|mypy|pyright|golangci|typecheck|type-check)"
)
_INSTALL = re.compile(
    r"(?i)^(npm (i|install|add|ci)|pnpm (i|install|add)|yarn (add|install)|bun (add|install)|pip3? install|uv (add|pip install|sync)|poetry (add|install)|cargo add|go get|gem install|composer (require|install))\b"
)

_ERROR_START = re.compile(
    r"(?i)(error[:\[ ]|exception|traceback|failed|failure|fatal:|panic:|ERR!|cannot find|not found|"
    r"undefined reference|segmentation fault|no such file|permission denied|assert)"
)
_SIG_PATH = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}|[\w.-]+\.[a-z]{1,5}:\d+(?::\d+)?")
_SIG_HEX = re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{7,40}\b", re.IGNORECASE)
_SIG_NUM = re.compile(r"\b\d+(?:\.\d+)?\b")
_SIG_QUOTED = re.compile(r"'[^']{1,80}'|\"[^\"]{1,80}\"|`[^`]{1,80}`")
_SIG_SPACE = re.compile(r"\s+")

_PATCH_FILE = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", re.MULTILINE)
_DIFF_FILE = re.compile(r"^\+\+\+ b/(.+)$", re.MULTILINE)


@dataclass(frozen=True)
class ToolSignal:
    category: str  # shell | edit | read | web | mcp | other
    command: str | None
    command_key: str | None
    command_kind: str | None  # test | build | lint | install | commit | revert | None
    files: tuple[str, ...]
    reverted_files: tuple[str, ...]
    packages: tuple[str, ...]


def _short(name: str) -> str:
    lowered = name.lower()
    if lowered.startswith("mcp__") or lowered.startswith("mcp_"):
        return "mcp"
    return lowered.rsplit(".", 1)[-1] if "." in lowered and lowered not in _SHELL else lowered


def classify_tool(name: str) -> str:
    short = _short(name)
    if short == "mcp":
        return "mcp"
    if short in _SHELL:
        return "shell"
    if short in _EDIT:
        return "edit"
    if short in _READ:
        return "read"
    if short in _WEB:
        return "web"
    return "other"


def command_of(tool_input: Any) -> str | None:
    if isinstance(tool_input, str):
        return tool_input.strip() or None
    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script", "commandLine", "input"):
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
                parts = list(value)
                if (
                    len(parts) >= 3
                    and parts[0] in {"bash", "sh", "zsh", "pwsh", "powershell"}
                    and parts[1] in {"-c", "-lc", "-Command"}
                ):
                    return parts[2]
                return shlex.join(parts)
    return None


def _split(command: str) -> list[str]:
    first_line = command.strip().splitlines()[0] if command.strip() else ""
    segment = re.split(r"\s*(?:&&|\|\||;|\|)\s*", first_line)[0]
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def command_key(command: str) -> str | None:
    tokens = [t for t in _split(command) if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)]
    while tokens and tokens[0] in {"sudo", "time", "env", "exec", "nohup", "command"}:
        tokens = tokens[1:]
    if not tokens:
        return None
    program = PurePosixPath(tokens[0].replace("\\", "/")).name.lower()
    rest = [t for t in tokens[1:] if not t.startswith("-")]
    if program in {"python", "python3", "py"} and "-m" in tokens:
        index = tokens.index("-m")
        if index + 1 < len(tokens):
            return f"python -m {tokens[index + 1]}"
    if program in {"npm", "pnpm", "yarn", "bun"} and rest[:1] == ["run"] and len(rest) > 1:
        return f"{program} run {rest[1]}"
    if program in {"uv", "poetry", "pdm", "hatch"} and rest[:1] == ["run"] and len(rest) > 1:
        return f"{program} run {PurePosixPath(rest[1]).name}"
    if program in _MULTI and rest:
        return f"{program} {rest[0]}"
    return program


def command_kind(command: str) -> str | None:
    lowered = command.lower()
    if re.search(r"\bgit\s+commit\b", lowered):
        return "commit"
    if re.search(r"\bgit\s+(checkout\s+--|restore\b|revert\b|reset\s+--hard|stash\b(?!\s+(list|show)))", lowered):
        return "revert"
    if _INSTALL.search(lowered.strip()):
        return "install"
    if _TEST.search(lowered):
        return "test"
    if _LINT.search(lowered):
        return "lint"
    if _BUILD.search(lowered):
        return "build"
    return None


def reverted_files(command: str) -> list[str]:
    tokens = _split(command)
    if len(tokens) < 2 or PurePosixPath(tokens[0]).name != "git":
        return []
    sub = tokens[1]
    if sub == "checkout" and "--" in tokens:
        return tokens[tokens.index("--") + 1 :]
    if sub == "restore":
        return [t for t in tokens[2:] if not t.startswith("-")]
    if sub in {"revert", "reset", "stash"}:
        return ["*"]
    return []


def files_of(category: str, tool_input: Any) -> list[str]:
    found: list[str] = []
    if isinstance(tool_input, dict):
        for key in ("file_path", "path", "filePath", "filename", "notebook_path", "target_file", "file"):
            value = tool_input.get(key)
            if isinstance(value, str) and value and len(value) < 1024:
                found.append(value)
        for key in ("paths", "files", "file_paths"):
            value = tool_input.get(key)
            if isinstance(value, list):
                found.extend(item for item in value if isinstance(item, str) and len(item) < 1024)
        edits = tool_input.get("edits")
        if isinstance(edits, list):
            for item in edits:
                if isinstance(item, dict):
                    value = item.get("file_path") or item.get("path")
                    if isinstance(value, str):
                        found.append(value)
        patch_text = tool_input.get("patch") or tool_input.get("input") or tool_input.get("diff")
        if isinstance(patch_text, str):
            found.extend(_PATCH_FILE.findall(patch_text))
            found.extend(_DIFF_FILE.findall(patch_text))
    elif isinstance(tool_input, str) and category == "edit":
        found.extend(_PATCH_FILE.findall(tool_input))
        found.extend(_DIFF_FILE.findall(tool_input))
    unique: list[str] = []
    for item in found:
        cleaned = item.strip()
        if cleaned and cleaned not in unique:
            unique.append(cleaned)
    return unique[:50]


def packages_of(command: str) -> list[str]:
    if not _INSTALL.search(command.lower().strip()):
        return []
    tokens = _split(command)
    names = [t for t in tokens[2:] if not t.startswith("-") and t not in {"install", "add", "pip", "require"}]
    return [re.split(r"[=<>@~^]", name, maxsplit=1)[0] or name for name in names][:20]


def analyze_tool(tool: str, tool_input: Any) -> ToolSignal:
    category = classify_tool(tool)
    command = command_of(tool_input) if category == "shell" else None
    key = command_key(command) if command else None
    kind = command_kind(command) if command else None
    files = files_of(category, tool_input) if category in {"edit", "read"} else []
    reverted = reverted_files(command) if command and kind == "revert" else []
    packages = packages_of(command) if command and kind == "install" else []
    return ToolSignal(
        category=category,
        command=command,
        command_key=key,
        command_kind=kind,
        files=tuple(files),
        reverted_files=tuple(reverted),
        packages=tuple(packages),
    )


def error_signature(text: str | None) -> tuple[str, str] | None:
    """Stable signature of an error: (hash, representative line)."""
    if not text:
        return None
    lines = [line.strip() for line in strip_control(text).splitlines() if line.strip()]
    if not lines:
        return None
    representative = next((line for line in lines if _ERROR_START.search(line)), lines[-1])
    normalized = _SIG_QUOTED.sub("<q>", representative)
    normalized = _SIG_PATH.sub("<path>", normalized)
    normalized = _SIG_HEX.sub("<hex>", normalized)
    normalized = _SIG_NUM.sub("<n>", normalized)
    normalized = _SIG_SPACE.sub(" ", normalized).strip().lower()[:300]
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return digest, representative[:300]


# --- prompts ---------------------------------------------------------------

_CORRECTION = re.compile(
    r"(?i)^\s*(nein|no\b|nope|falsch|wrong|stop\b|halt\b|nicht so|not like that|that's not|das ist nicht|"
    r"das stimmt nicht|incorrect|undo|rückgängig|mach das rückgängig)"
    r"|\b(ich hab(e)? (doch )?gesagt|i (already )?(told|said)|hör auf|don't do that|do not do that|"
    r"nicht schon wieder|again\?|immer noch falsch|still wrong)\b"
)
_ALWAYS_NEVER = re.compile(r"(?i)\b(immer|nie(mals)?|always|never|stets|grundsätzlich)\b")
_INSTEAD = [
    re.compile(
        r"(?i)\b(?:nutze|verwende|benutze|nimm|use)\s+`?([\w.@/+-]+)`?\s+(?:statt|anstatt|anstelle von|instead of|not)\s+`?([\w.@/+-]+)`?"
    ),
    re.compile(r"(?i)`?([\w.@/+-]+)`?\s+(?:statt|anstatt)\s+`?([\w.@/+-]+)`?"),
    re.compile(r"(?i)\b(?:nicht|kein|not|no)\s+`?([\w.@/+-]+)`?\s*,\s*(?:sondern|but|use)\s+`?([\w.@/+-]+)`?"),
]
_AVOID = re.compile(
    r"(?i)\b(?:never use|don't use|do not use|nie|niemals|kein|keine|nicht)\s+`?([\w.@/+-]{2,40})`?\s+(?:benutzen|verwenden|nutzen|nehmen|use)?"
)
_DECISION = re.compile(
    r"(?i)\b(wir nehmen|wir verwenden|wir nutzen|entschieden|entscheidung|we(?:'ll| will)? use|we decided|decided to|"
    r"let's use|lass uns .{1,40} (nehmen|verwenden|nutzen)|going with|we're going with|from now on|ab jetzt|ab sofort)\b"
)


def is_correction(prompt: str) -> bool:
    return bool(_CORRECTION.search(prompt[:600]))


def preference_pairs(text: str) -> list[tuple[str, str | None]]:
    """Extract (avoid, prefer) pairs such as "pnpm statt npm" -> ("npm", "pnpm")."""
    pairs: list[tuple[str, str | None]] = []
    sample = text[:1000]
    for index, pattern in enumerate(_INSTEAD):
        for match in pattern.finditer(sample):
            first, second = match.group(1), match.group(2)
            prefer, avoid = (second, first) if index == 2 else (first, second)
            pair = (avoid.lower(), prefer.lower())
            if pair not in pairs and avoid.lower() != prefer.lower():
                pairs.append(pair)
    if not pairs:
        for match in _AVOID.finditer(sample):
            token = match.group(1).lower()
            if token not in {"so", "das", "the", "that", "this", "mehr", "more", "wieder", "again"}:
                pairs.append((token, None))
    return pairs[:5]


def mentions_rule(prompt: str) -> bool:
    return bool(_ALWAYS_NEVER.search(prompt[:600]))


def decision_sentences(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text[:4000])
    return [s.strip()[:300] for s in sentences if _DECISION.search(s)][:3]


def first_line(text: str, limit: int = 160) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#>*- ").strip()
        if stripped:
            return stripped[:limit]
    return ""
