"""Command line interface. ``agent-mem hook`` takes a fast path that imports only the standard library."""

from __future__ import annotations

import sys


def _rule_id(text: str) -> int:
    import argparse  # lazy: the hook fast path must not pay for it

    digits = text.strip().upper().removeprefix("R")
    if not (digits.isascii() and digits.isdigit()) or int(digits) >= 2**63:
        raise argparse.ArgumentTypeError(f"invalid rule id: {text}")
    return int(digits)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args[:1] == ["hook"]:
        from .hook import main as hook_main

        return hook_main(args[1:])
    return _main(args)


def _main(args: list[str]) -> int:
    import argparse
    import json
    from pathlib import Path

    from . import __version__
    from .config import load

    parser = argparse.ArgumentParser(prog="agent-mem", description="Local, self-learning memory for coding agents.")
    parser.add_argument(
        "--data-dir", type=Path, help="data directory (default: platform data dir or AGENT_MEM_DATA_DIR)"
    )
    parser.add_argument("--version", action="version", version=f"agent-mem {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status", help="counts, learning metrics and component health")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("doctor", help="check installation, database, harnesses and backups")
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
    p = sub.add_parser("import", help="import history")
    p.add_argument("source", choices=["claude", "codex", "claude-mem", "agentmemory"])
    p.add_argument("path", nargs="?", type=Path)
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("export", help="export memory as JSON")
    p.add_argument("--project", help="project directory")
    p.add_argument("--output", type=Path)
    p = sub.add_parser("purge", help="permanently delete data (also from backups and spool)")
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--id")
    group.add_argument("--project", help="project directory")
    group.add_argument("--before", help="ISO date; delete sessions that ended before it")
    group.add_argument("--all", action="store_true")
    p.add_argument("--yes", action="store_true")
    sub.add_parser("backup", help="create a backup now")
    p = sub.add_parser("restore", help="restore a backup")
    p.add_argument("file", nargs="?", type=Path)
    p.add_argument("--latest", action="store_true")
    p = sub.add_parser("index", help="run the background indexer once")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--no-download", action="store_true")
    sub.add_parser("consolidate", help="run consolidation now")
    p = sub.add_parser("rules", help="learned rules (avoid a command after repeated corrections)")
    p.add_argument("action", choices=["list", "enable", "disable", "delete"], nargs="?", default="list")
    p.add_argument("rule_id", nargs="?", type=_rule_id)
    sub.add_parser("lessons", help="suggest lines for AGENTS.md / CLAUDE.md from repeated lessons")
    p = sub.add_parser("models", help="embedding model status or download")
    p.add_argument("action", choices=["status", "install"], nargs="?", default="status")
    p = sub.add_parser("eval", help="retrieval evaluation (LongMemEval-S format)")
    p.add_argument("dataset", type=Path)
    p.add_argument("--limit", type=int)
    p.add_argument("--no-semantic", action="store_true")
    p = sub.add_parser("setup", help="show how to connect a harness (Claude Code, Codex, Copilot CLI, OpenCode)")
    p.add_argument("harness", choices=["claude", "codex", "copilot", "opencode"])
    p.add_argument(
        "--write", action="store_true", help="OpenCode only: copy the plugin into ~/.config/opencode/plugins/"
    )
    p = sub.add_parser("view", help="write a read-only HTML page of your memory and open it (no server)")
    p.add_argument("--project", help="only this project directory (default: all projects)")
    p.add_argument("--output", type=Path, help="write the page here instead of the private data directory")
    p.add_argument("--no-open", action="store_true", help="only write the page and print its path")
    sub.add_parser("mcp", help="run the stdio MCP server (used by plugins)")
    sub.add_parser("paths", help="show data locations")

    ns = parser.parse_args(args)
    config = load(ns.data_dir) if ns.data_dir else load()

    if ns.command == "mcp":
        from .mcp_server import main as mcp_main

        return mcp_main()
    if ns.command == "index":
        from .indexer import run

        stats = run(config, allow_download=not ns.no_download)
        if not ns.quiet:
            print(json.dumps(stats, indent=2, default=str))
        return 0
    if ns.command == "doctor":
        from .health import doctor, format_checks, to_json

        checks = doctor(config, fix=ns.fix)
        print(to_json(checks) if ns.json else format_checks(checks))
        return 0 if all(c.ok or c.warn_only for c in checks) else 1
    if ns.command == "eval":
        from .evaluate import longmemeval

        print(json.dumps(longmemeval(ns.dataset, limit=ns.limit, semantic_search=not ns.no_semantic), indent=2))
        return 0
    if ns.command == "paths":
        print(
            json.dumps(
                {
                    "data_dir": str(config.data_dir),
                    "database": str(config.db_path),
                    "config": str(config.config_path),
                    "backups": str(config.backup_dir),
                    "logs": str(config.log_dir),
                    "models": str(config.model_dir),
                },
                indent=2,
            )
        )
        return 0
    if ns.command == "restore":
        from . import db

        source = ns.file or (db.latest_backup(config) if ns.latest else None)
        if source is None:
            print("No backup given (use a path or --latest).", file=sys.stderr)
            return 2
        db.restore(config, source)
        print(f"Restored {source}.")
        return 0

    from . import commands

    return commands.dispatch(ns, config)


if __name__ == "__main__":
    raise SystemExit(main())
