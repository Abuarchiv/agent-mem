"""Command line interface. ``agent-mem hook`` takes a fast path that imports only the standard library."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import argparse


def _rule_id(text: str) -> int:
    import argparse  # lazy: the hook fast path must not pay for it

    digits = text.strip().upper().removeprefix("R")
    if not (digits.isascii() and digits.isdigit()) or int(digits) >= 2**63:
        raise argparse.ArgumentTypeError(f"invalid rule id: {text}")
    return int(digits)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["hook"]:
        import os

        from agent_mem.core import paths

        raw = None
        if args[1:2] not in ([], ["-h"], ["--help"]):  # typed by a person: the hook explains itself, no stdin
            raw = sys.stdin.buffer.read(paths.STDIN_CAP + 1)
            # Before the hook module loads: most Bash and Edit calls have nothing to check.
            if paths.pre_tool_has_nothing_to_check(args[2] if len(args) > 2 else None, raw):
                os._exit(0)
        from agent_mem.hooks.hook import main as hook_main

        return hook_main(args[1:], raw)
    try:
        return _main(args)
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        import os

        if os.environ.get("AGENT_MEM_DEBUG"):
            raise
        print(f"agent-mem: {_explain(error)}", file=sys.stderr)
        return 1


def _explain(error: Exception) -> str:
    """One line with the cause and the next step instead of a traceback (AGENT_MEM_DEBUG=1 shows it)."""
    import sqlite3

    from agent_mem.core import db

    if isinstance(error, db.SchemaTooNewError):
        return f"{error}. A newer agent-mem wrote this database; upgrade agent-mem."
    if isinstance(error, db.MigrationInProgressError):
        return f"{error}. Another agent-mem process is upgrading the database; try again in a minute."
    if isinstance(error, sqlite3.DatabaseError) and not isinstance(error, sqlite3.OperationalError):
        return f"the database is damaged ({error}). `agent-mem index` keeps it as memory.db.corrupt-<time> and starts a new one."
    if isinstance(error, sqlite3.OperationalError):
        if "locked" in str(error) or "busy" in str(error):
            return f"the database is busy ({error}). Another agent-mem process holds it; try again shortly."
        return f"database error: {error}. Run `agent-mem doctor`."
    if isinstance(error, FileNotFoundError):
        return f"file not found: {error.filename}"
    if isinstance(error, IsADirectoryError):
        return f"{error.filename} is a folder; give a file path"
    if isinstance(error, NotADirectoryError | FileExistsError):
        return f"{error.filename} is a file where agent-mem needs a folder. Check --data-dir or AGENT_MEM_DATA_DIR."
    if isinstance(error, PermissionError):
        return f"no permission to access {error.filename}. Check --data-dir or AGENT_MEM_DATA_DIR and file permissions."
    if isinstance(error, OSError):
        return f"{error.strerror or error}{f': {error.filename}' if error.filename else ''}"
    if isinstance(error, ModuleNotFoundError):
        return (
            f"missing module {error.name}. Add the extras that need it: `agent-mem upgrade --extras semantic observer`."
        )
    return f"unexpected {type(error).__name__}: {error}. Run again with AGENT_MEM_DEBUG=1 for details and report it."


def _parser() -> argparse.ArgumentParser:
    import argparse
    from pathlib import Path

    from agent_mem.cli.install import version

    parser = argparse.ArgumentParser(prog="agent-mem", description="Local, self-learning memory for coding agents.")
    parser.add_argument(
        "--data-dir", type=Path, help="data directory (default: platform data dir or AGENT_MEM_DATA_DIR)"
    )
    parser.add_argument("--version", action="version", version=f"agent-mem {version()}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status", help="counts, learning metrics and component health")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("doctor", help="check installation, database and harnesses")
    p.add_argument("--fix", action="store_true", help="fix what is safe to fix")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("search", help="search memory")
    p.add_argument("query")
    p.add_argument("--project", help="project directory (default: current directory)")
    p.add_argument("--all-projects", action="store_true")
    p.add_argument("--limit", type=int, default=8)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("show", help="details for ids such as T12 or M3")
    p.add_argument("ids", nargs="+")
    p = sub.add_parser("pause", help="stop capturing")
    p.add_argument("--for", dest="duration", help="e.g. 30m, 2h, 1d (default: until resume)")
    sub.add_parser("resume", help="resume capturing")
    p = sub.add_parser("export", help="export memory as JSON")
    p.add_argument("--project", help="project directory")
    p.add_argument("--output", type=Path)
    p = sub.add_parser("purge", help="permanently delete data (also from the spool)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--id")
    group.add_argument("--project", help="project directory")
    group.add_argument("--before", help="ISO date; delete sessions that ended before it")
    group.add_argument("--all", action="store_true")
    p.add_argument("--yes", action="store_true")
    p = sub.add_parser("observe", help="run the background observer (extract facts from closed turns)")
    p.add_argument("--drain", action="store_true", help="process the queue, wait observe.idle_seconds for more, exit")
    p.add_argument("--once", action="store_true", help="process what is due and exit without waiting")
    p.add_argument("--status", action="store_true", help="show queue, errors and today's model calls")
    p.add_argument("--retry-failed", action="store_true")
    p.add_argument("--reprocess-raw", action="store_true", help="re-queue turns that were stored without a model")
    p.add_argument(
        "--reindex", action="store_true", help="rebuild the mem0 index from the facts in SQLite (no model call)"
    )
    p.add_argument("--quiet", action="store_true")
    p = sub.add_parser("index", help="run the background indexer once")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--no-download", action="store_true")
    sub.add_parser("consolidate", help="run consolidation now")
    p = sub.add_parser("rules", help="learned rules (avoid a command after repeated corrections)")
    p.add_argument("action", choices=["list", "enable", "disable", "delete"], nargs="?", default="list")
    p.add_argument("rule_id", nargs="?", type=_rule_id)
    sub.add_parser("lessons", help="suggest lines for AGENTS.md / CLAUDE.md from repeated lessons")
    p = sub.add_parser("models", help="embedding and concept model status or download")
    p.add_argument("action", choices=["status", "install"], nargs="?", default="status")
    p = sub.add_parser("eval", help="retrieval evaluation (LongMemEval-S format)")
    p.add_argument("dataset", type=Path, nargs="?", help="LongMemEval-S JSON (omit with --fixture)")
    p.add_argument("--limit", type=int)
    p.add_argument("--no-semantic", action="store_true")
    p.add_argument("--backend", choices=("sqlite", "mem0"), default="sqlite")
    p.add_argument("--subset", type=Path, help="JSON with question ids (tests/fixtures/longmemeval_subset.json)")
    p.add_argument("--fixture", type=Path, help="run tests/fixtures/memory_cases.json instead of a dataset")
    p.add_argument(
        "--llm",
        choices=("none", "ollama", "claude", "codex", "copilot"),
        default="none",
        help="mem0 backend only; none = store sessions as-is (infer=False), retrieval-only comparison (E3)",
    )
    p.add_argument("--llm-model")
    p.add_argument("--custom-prompt", type=Path, help="file with mem0 custom_instructions (E8)")
    p.add_argument("--min-score", type=float, default=0.0, help="abstain below this score (fixture)")
    p.add_argument("--embedder", help="fastembed model name (E2), default from config")
    p.add_argument("--vector-floor", type=float, help="override retrieval.min_vector_score (sqlite backend)")
    p.add_argument("--progress", type=Path, help="JSONL with one line per finished question; resumes on rerun")
    p = sub.add_parser("setup", help="connect a harness (Claude Code, Codex, Copilot CLI, OpenCode)")
    p.add_argument(
        "harness", choices=["all", "claude", "codex", "copilot", "opencode"], help="all: every harness on PATH"
    )
    p.add_argument(
        "--write",
        action="store_true",
        help="register hooks and the MCP server with the absolute path of this binary (otherwise print the steps)",
    )
    p.add_argument(
        "--no-models", action="store_true", help="with --write: skip the embedding and concept model downloads"
    )
    p = sub.add_parser("uninstall", help="remove hooks and MCP entries written by `setup --write`; data stays")
    p.add_argument("harness", choices=["all", "claude", "codex", "copilot", "opencode"])
    p = sub.add_parser("view", help="open the viewer in the browser (starts it if needed)")
    p.add_argument("--project", help="only this project directory (default: all projects)")
    p.add_argument(
        "--output", type=Path, help="write an offline snapshot page here (a file, or a folder for agent-mem.html)"
    )
    p.add_argument("--no-open", action="store_true", help="write the snapshot page and print its path, open nothing")
    p = sub.add_parser("serve", help="run the viewer on 127.0.0.1 (the hooks and `view` start it for you)")
    p.add_argument("--quiet", action="store_true")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--autostart", action="store_true", help="start the viewer at every login, and now")
    group.add_argument("--no-autostart", action="store_true", help="remove the login item")
    p = sub.add_parser("upgrade", help="install the newest version from where this one came from, then `doctor --fix`")
    p.add_argument("--extras", nargs="+", default=[], choices=["semantic", "observer"], help="also install these")
    sub.add_parser("mcp", help="run the stdio MCP server (used by plugins)")
    sub.add_parser("paths", help="show data locations")

    return parser


def _main(args: list[str]) -> int:
    from agent_mem.cli import commands
    from agent_mem.core.config import load

    ns = _parser().parse_args(args)
    config = load(ns.data_dir) if ns.data_dir else load()
    return commands.dispatch(ns, config)


if __name__ == "__main__":
    raise SystemExit(main())
