"""Deterministic signals extracted from tool calls and prompts. Pure functions, standard library only."""

from __future__ import annotations

import hashlib
import re
import shlex
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from agent_mem.core.privacy import strip_control

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


# Segments that only prepare the shell; the command is the next one ("cd app && pytest" is pytest).
_SETUP = {"cd", "pushd", "popd", "export", "source", ".", "set", "unset", "alias", "true", ":"}
# Shell control words: "for f in …; do pytest $f; done" runs pytest.
_CONTROL = {"for", "while", "until", "if", "elif", "else", "fi", "done", "esac", "case", "select", "function"}
# Commands that only look at things. One failing ("cat: no such file") and the next one passing is not an
# error that a change fixed.
INSPECTION = {
    "cat",
    "less",
    "head",
    "tail",
    "sed",
    "awk",
    "grep",
    "egrep",
    "rg",
    "ag",
    "ls",
    "find",
    "fd",
    "tree",
    "wc",
    "echo",
    "printf",
    "which",
    "type",
    "file",
    "stat",
    "pwd",
    "diff",
    "cmp",
    "sort",
    "uniq",
    "cut",
    "tr",
    "jq",
    "sleep",
    "test",
    "[",
    "open",
    "du",
    "df",
    "ps",
    "env",
    "date",
    "rm",
    "mkdir",
    "cp",
    "mv",
    "touch",
    "chmod",
    "ln",
    "kill",
    "pkill",
    "lsof",
    "xargs",
    "tee",
    "nl",
    "strings",
}


def command_key(command: str) -> str | None:
    """The command that does the work: agents chain `cat test.py && uv run pytest | tail`, and that runs the tests.
    A chain that only looks around is keyed by its first look."""
    first_line = command.strip().splitlines()[0] if command.strip() else ""
    looked: str | None = None
    for segment in re.split(r"\s*(?:&&|\|\||;)\s*", first_line):
        key = _segment_key(segment.split("|", 1)[0])
        if key is None:
            continue
        if not looks_only(key):
            return key
        looked = looked or key
    return looked


def _segment_key(segment: str) -> str | None:
    try:
        tokens = shlex.split(segment, posix=True)
    except ValueError:
        tokens = segment.split()
    tokens = [t for t in tokens if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t)]
    while tokens and tokens[0] in {"sudo", "time", "env", "exec", "nohup", "command", "nice", "do", "then", "timeout"}:
        tokens = tokens[2:] if tokens[0] == "timeout" and len(tokens) > 1 else tokens[1:]  # timeout <seconds> cmd
    # "f=$(ls -t x | head -1)" leaves "-t": an assignment, not a command.
    if not tokens or tokens[0] in _SETUP or tokens[0] in _CONTROL or tokens[0].startswith(("-", "$", "(", ")", "@")):
        return None
    program = PurePosixPath(tokens[0].replace("\\", "/")).name.lower()
    if not re.fullmatch(r"[a-z][a-z0-9._+-]*", program):
        return None  # a number, a path fragment or a quoted word left over from an assignment
    if program == "git":  # git -C <dir> status is git status
        while len(tokens) > 2 and tokens[1] in {"-C", "-c"}:
            tokens = [tokens[0], *tokens[3:]]
    rest = [t for t in tokens[1:] if not t.startswith("-")]
    if program in {"python", "python3", "py"} and "-m" in tokens:
        index = tokens.index("-m")
        if index + 1 < len(tokens):
            return f"python -m {tokens[index + 1]}"
    if program in {"npm", "pnpm", "yarn", "bun"} and rest[:1] == ["run"] and len(rest) > 1:
        return f"{program} run {rest[1]}"
    if program in {"uv", "poetry", "pdm", "hatch"} and "run" in tokens[1:2]:
        inner = _runner_command(tokens[2:])
        if inner:
            return f"{program} run {inner}"
    if program in _MULTI and rest:
        return f"{program} {rest[0]}"
    return program


# Options of `uv run`, `poetry run`, `pdm run` and `hatch run` that take a value: `--with pytest` names no command.
_RUNNER_VALUE_OPTIONS = frozenset(
    {
        "--with",
        "--with-editable",
        "--with-requirements",
        "--python",
        "-p",
        "--project",
        "--directory",
        "-C",
        "--package",
        "--extra",
        "--group",
        "--env-file",
        "--index",
        "--default-index",
        "--index-url",
        "-e",
        "--env",
    }
)


def _runner_command(tokens: list[str]) -> str | None:
    """The program a runner starts: `--with pytest python3 -m pytest -q` runs pytest, `-m pytest` too."""
    index = 0
    while index < len(tokens) and tokens[index].startswith("-"):
        option = tokens[index]
        if option == "-m" and index + 1 < len(tokens):
            return tokens[index + 1]
        index += 2 if option in _RUNNER_VALUE_OPTIONS else 1
    if index >= len(tokens):
        return None
    program = PurePosixPath(tokens[index].replace("\\", "/")).name
    if program in {"python", "python3", "py"} and tokens[index + 1 : index + 2] == ["-m"] and len(tokens) > index + 2:
        return tokens[index + 2]
    return program


def tools_run(command: str) -> set[str]:
    """Every tool a shell line runs, as a rule names it: `cd x && python3 -m pip install` runs pip, `pip3` is pip,
    `uv pip install` runs uv, and `git push` keeps its subcommand. An echoed word runs nothing."""
    first_line = command.strip().splitlines()[0] if command.strip() else ""
    names: set[str] = set()
    for segment in re.split(r"\s*(?:&&|\|\||;|\|)\s*", first_line):
        key = _segment_key(segment)
        if key is None:
            continue
        parts = key.split()
        tool = parts[2] if parts[0] in {"python", "uv", "poetry", "pdm", "hatch"} and len(parts) == 3 else parts[0]
        names |= {key, tool, re.sub(r"[\d.]+$", "", tool) or tool}
    return names


def same_tool(a: str | None, b: str | None) -> bool:
    """Two command keys run the same tool: `python -m pytest`, `uv run pytest` and `pytest` all run pytest."""

    def tool(key: str | None) -> str | None:
        if not key:
            return None
        parts = key.split()
        if parts[:1] in (["python"], ["uv"], ["poetry"], ["pdm"], ["hatch"]) and len(parts) == 3:
            return parts[2]  # "python -m pytest", "uv run pytest"
        return key

    return tool(a) is not None and tool(a) == tool(b)


_SEGMENTS = re.compile(r"\s*(?:&&|\|\||;|\|)\s*")
_REDIRECT = re.compile(r"\s+(?:\d?>>?|&>)\s*(?:&\d|\S+)")
_ASSIGNMENTS = re.compile(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+")  # `UV_CACHE_DIR=/tmp/x uv run …`
_ONLY_ASKS = re.compile(r"(?:^|\s)(?:--version|--help|-V|-h)(?:\s|$)")


def reusable_command(command: str, kind: str) -> str | None:
    """The part of a shell line worth suggesting again as the project's ``kind`` command, or None.

    ``cd app && npm test 2>&1 | tail`` gives ``npm test``; heredocs, shortened text and ``grep … tests/`` give None.
    """
    line = command.strip()
    if "\n" in line or "[truncated]" in line:
        return None
    for segment in _SEGMENTS.split(line):
        segment = _ASSIGNMENTS.sub("", _REDIRECT.sub("", segment)).strip()
        try:
            shlex.split(segment)
        except ValueError:
            return None  # a quoted |, ; or && was cut apart
        if _ONLY_ASKS.search(segment):
            return None  # `pytest --version` asks the tool, it runs nothing
        key = command_key(segment)
        if key is not None and command_kind(key) == kind:
            return segment if len(segment) <= 100 else None
    return None


# Keys that only look, beyond INSPECTION's programs: `git commit` can fail and be fixed, `git status` cannot.
_LOOKS_ONLY = frozenset(
    {
        "git status",
        "git diff",
        "git log",
        "git show",
        "git branch",
        "git worktree",
        "git rev-parse",
        "git remote",
        "git ls-files",
        "git blame",
        "sqlite3",
        "nl",
        "ugrep",
        "xxd",
        "hexdump",
        "lsof",
    }
)


def looks_only(command_key: str) -> bool:
    """The command only looks at things; failing and then passing is no error that a change fixed."""
    return command_key.split(maxsplit=1)[0] in INSPECTION or command_key in _LOOKS_ONLY


def fixable(command_key: str | None) -> bool:
    """A failure of this command can be fixed by a change (a test, a build), not just retried with other words."""
    if not command_key:
        return False
    program = command_key.split()[0]
    # Keys recorded before command_key skipped shell setup: "cd", "-t" from "f=$(ls -t …)".
    return not looks_only(command_key) and program not in _SETUP and not program.startswith(("-", "$", "("))


def command_kind(command: str) -> str | None:
    lowered = command.lower()
    if re.search(r"\bgit\s+commit\b", lowered):
        return "commit"
    # Not `git stash`: it shelves work to come back to (agents stash, test, pop); it abandons nothing.
    if re.search(r"\bgit\s+(checkout\s+--|restore\b|revert\b|reset\s+--hard)", lowered):
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
    if sub in {"revert", "reset"}:
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
        # Codex sends apply_patch as {"command": "*** Begin Patch …"}.
        patch_text = (
            tool_input.get("patch") or tool_input.get("input") or tool_input.get("diff") or tool_input.get("command")
        )
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


# Shell programs that print a file (Codex reads with `sed -n`, `cat`, `nl`; it has no read tool).
_PRINTERS = {"cat", "head", "tail", "sed", "nl", "less", "more", "bat"}
# Options that take the next word as their value, per program (`sed -n` is a switch, `head -n` is not).
_VALUE_FLAGS = {
    "head": {"-n", "-c", "--lines", "--bytes"},
    "tail": {"-n", "-c", "--lines", "--bytes"},
    "sed": {"-e", "-f"},
}


def shell_read_files(command: str) -> list[str]:
    """Files a printing command reads: `sed -n '1,80p' src/a.py` reads src/a.py."""
    words = _split(command)
    if not words or words[0] not in _PRINTERS:
        return []
    found: list[str] = []
    skip_next = False
    script_pending = words[0] == "sed" and not any(w in {"-e", "-f"} for w in words)
    for word in words[1:]:
        if skip_next:
            skip_next = False
            continue
        if word in _VALUE_FLAGS.get(words[0], ()):
            skip_next = True
            continue
        if word.startswith("-") or word.lstrip("+").isdigit():
            continue
        if script_pending:  # sed's first operand is the script
            script_pending = False
            continue
        if len(word) < 1024:
            found.append(word)
    return found[:5]


def analyze_tool(tool: str, tool_input: Any) -> ToolSignal:
    category = classify_tool(tool)
    command = command_of(tool_input) if category == "shell" else None
    key = command_key(command) if command else None
    kind = command_kind(command) if command else None
    files = files_of(category, tool_input) if category in {"edit", "read"} else []
    if command and not files:
        files = shell_read_files(command)
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


def looks_like_error(line: str) -> bool:
    """True when the line names an error; a bare non-zero exit (grep without match, `| head`) does not."""
    return bool(_ERROR_START.search(line))


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
    r"nicht schon wieder|immer noch falsch|still wrong)\b"
    r"|\bagain\?"
)
# "immer noch", "wie immer", "noch nie", "never mind" are filler, not rules.
_ALWAYS_NEVER = re.compile(
    r"(?i)(?<!noch )(?<!wie )(?<!für )\b(immer\b(?!\s+(noch|wieder|mehr)\b)|nie(mals)?\b|always\b"
    r"|never\b(?!\s+mind\b)|stets\b|grundsätzlich\b)"
)
_INSTEAD = [
    re.compile(
        r"(?i)\b(?:nutze|verwende|benutze|nimm|use)\s+`?([\w.@/+-]+)`?\s+(?:statt|anstatt|anstelle von|instead of|not)\s+`?([\w.@/+-]+)`?"
    ),
    re.compile(r"(?i)`?([\w.@/+-]+)`?\s+(?:statt|anstatt)\s+`?([\w.@/+-]+)`?"),
    # "nicht pip benutzen, sondern uv": the verb may stand between the name and the comma.
    re.compile(
        r"(?i)\b(?:nicht|kein|not|no)\s+`?([\w.@/+-]+)`?(?:\s+(?:benutzen|verwenden|nutzen|nehmen|using))?\s*,\s*"
        r"(?:sondern|but|use)\s+`?([\w.@/+-]+)`?"
    ),
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


def _name(token: str) -> str:
    # "nutze uv statt pip." ends a sentence; the rule is about `pip`, not `pip.`.
    return token.lower().rstrip(".,:;!?")


# "nicht so, sondern anders", "nicht hier, sondern im viewer", "X statt der alten": everyday contrast in prose.
# A command rule names a tool, never one of these closed-class words.
_FILLER = frozenset(
    [
        "a",
        "an",
        "the",
        "this",
        "that",
        "these",
        "those",
        "it",
        "its",
        "one",
        "ones",
        "other",
        "some",
        "any",
        "all",
        "here",
        "there",
        "now",
        "later",
        "then",
        "so",
        "not",
        "no",
        "more",
        "again",
        "them",
        "they",
        "we",
        "you",
        "me",
        "us",
        "der",
        "die",
        "das",
        "dem",
        "den",
        "des",
        "ein",
        "eine",
        "einen",
        "einem",
        "einer",
        "eines",
        "dies",
        "diese",
        "dieser",
        "dieses",
        "hier",
        "da",
        "dort",
        "jetzt",
        "später",
        "dann",
        "anders",
        "nicht",
        "kein",
        "keine",
        "mehr",
        "wieder",
        "es",
        "er",
        "sie",
        "wir",
        "ich",
        "du",
        "ihr",
        "uns",
        "mir",
        "dir",
        "ihn",
        "im",
        "in",
        "am",
        "an",
        "auf",
        "mit",
        "für",
        "von",
        "zu",
        "bei",
        "nach",
        "vor",
        "aus",
        "um",
        "immer",
        "nie",
        "lieber",
        "bitte",
        "auch",
        "noch",
        "nur",
        "schon",
        "heute",
        "morgen",
        "alles",
        "alle",
        "etwas",
        "nichts",
        "was",
        "wie",
        "wo",
        "use",
        "nutzen",
        "benutzen",
        "verwenden",
        "nehmen",
    ]
)


# Up to this length a prompt is a typed correction ("pnpm statt npm, bitte"), not a paragraph.
BARE_SWAP_CHARS = 160


def _pair(avoid: str, prefer: str | None) -> tuple[str, str | None] | None:
    names = [avoid] if prefer is None else [avoid, prefer]
    if avoid == prefer or any(len(n) < 2 or n in _FILLER or n.isdigit() for n in names):
        return None
    return avoid, prefer


def preference_pairs(text: str) -> list[tuple[str, str | None]]:
    """Extract (avoid, prefer) pairs such as "pnpm statt npm" -> ("npm", "pnpm")."""
    pairs: list[tuple[str, str | None]] = []
    sample = text[:1000]
    for index, pattern in enumerate(_INSTEAD):
        for match in pattern.finditer(sample):
            # Bare "X statt Y" in running prose is any word swap ("Redo anstatt Reuse zu nennen" learned a rule).
            if index == 1 and len(sample) > BARE_SWAP_CHARS and "`" not in match.group(0):
                continue
            first, second = _name(match.group(1)), _name(match.group(2))
            prefer, avoid = (second, first) if index == 2 else (first, second)
            pair = _pair(avoid, prefer)
            if pair is not None and pair not in pairs:
                pairs.append(pair)
    if not pairs:
        for match in _AVOID.finditer(sample):
            token = _name(match.group(1))
            # "kein git push" avoids `git push` (a command key), not every git command.
            sub = re.match(r"\s+`?([a-z][\w-]*)", sample[match.end(1) :].lower()) if token in _MULTI else None
            if sub and sub.group(1) not in _FILLER:
                token = f"{token} {sub.group(1)}"
            pair = _pair(token, None)
            if pair is not None:
                pairs.append(pair)
    return pairs[:5]


_CANONICAL_RULE = re.compile(
    r"(?i)^\s*(?:use|nutze|verwende)\s+`?([\w.@/+-]+?)`?\s+(?:instead of|statt|anstatt)\s+`?([\w.@/+-]+?)`?(?=[\s.,;:!]|$)"
)
# "Never commit, use local commits" is no tool swap: the avoided name needs a verb ("do not use npm") or backticks.
_CANONICAL_AVOID_RULE = re.compile(
    r"(?i)^\s*(?:do not|don't|never|not|no|nicht|nie(?:mals)?)\s+"
    r"(?:(?:use|nutze|verwende|benutze)\s+`?([\w.@/+-]+?)`?|`([\w.@/+-]+?)`)\s*[,;]\s*"
    r"(?:(?:but|sondern)\s+(?:(?:use|nutze|verwende|benutze)\s+)?|"
    r"(?:use|nutze|verwende|benutze)\s+)`?([\w.@/+-]+?)`?(?=[\s.,;:!]|$)"
)


def canonical_rule(text: str) -> tuple[str, str] | None:
    """Return one explicit command substitution as (avoid, prefer)."""
    match = _CANONICAL_RULE.match(text)
    if match:
        pair = _pair(_name(match.group(2)), _name(match.group(1)))
    elif match := _CANONICAL_AVOID_RULE.match(text):
        pair = _pair(_name(match.group(1) or match.group(2)), _name(match.group(3)))
    else:
        return None
    return (pair[0], pair[1]) if pair is not None and pair[1] is not None else None


def mentions_rule(prompt: str) -> bool:
    return bool(_ALWAYS_NEVER.search(prompt[:600]))


def decision_sentences(text: str) -> list[str]:
    sentences = re.split(r"(?<=[.!?])\s+|\n+", text[:4000])
    return [s.strip()[:300] for s in sentences if _DECISION.search(s)][:3]


_NOTICE = re.compile(r"^\s*<task-notification>.*?<summary>(.*?)</summary>", re.DOTALL)


# Text the harness puts into the prompt slot itself: background-task notices, slash-command wrappers, hook feedback.
_HARNESS_PROMPT = re.compile(
    r"^\s*(?:<task-notification>|<command-(?:name|message)>|<local-command-stdout>|Stop hook feedback:|\[Request interrupted)"
)


# Harness text that continues the running turn instead of asking something new: a finished background task, the
# feedback of a blocking Stop hook, an interruption. A slash command the user typed is a new request.
_CONTINUES_TURN = re.compile(r"^\s*(?:<task-notification>|Stop hook feedback:|\[Request interrupted)")


def continues_turn(prompt: str | None) -> bool:
    return bool(_CONTINUES_TURN.match(prompt or ""))


def from_harness(prompt: str | None) -> bool:
    """True when the user did not type this prompt; it then never teaches rules, corrections or preferences."""
    return bool(_HARNESS_PROMPT.match(prompt or ""))


def request_text(prompt: str | None) -> str:
    """The prompt as a reader sees it: a background-task notice is the harness talking, so show its summary."""
    notice = _NOTICE.match(prompt or "")
    return notice.group(1).strip() if notice else (prompt or "")


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
