"""Implementations of the smaller CLI commands."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import timedelta
from pathlib import Path
from typing import Any

from . import db, identity, spool, store, timeutil, views
from .config import Config


def dispatch(ns: argparse.Namespace, config: Config) -> int:
    handler = {
        "status": cmd_status,
        "search": cmd_search,
        "show": cmd_show,
        "pause": cmd_pause,
        "resume": cmd_resume,
        "import": cmd_import,
        "export": cmd_export,
        "purge": cmd_purge,
        "backup": cmd_backup,
        "consolidate": cmd_consolidate,
        "rules": cmd_rules,
        "lessons": cmd_lessons,
        "models": cmd_models,
        "setup": cmd_setup,
    }[ns.command]
    return handler(ns, config)


def _conn(config: Config) -> sqlite3.Connection:
    return db.connect(config, busy_timeout_ms=5000)


def _project(conn: sqlite3.Connection, directory: str | None) -> identity.Project | None:
    return identity.resolve(conn, os.path.abspath(directory or os.getcwd()))


def cmd_status(ns: argparse.Namespace, config: Config) -> int:
    from .health import status

    with _conn(config) as conn:
        data = status(conn, config)
    if ns.json:
        print(json.dumps(data, indent=2, default=str))
        return 0
    learning = data["learning"]
    print(f"agent-mem · {data['data_dir']} · {data['db_mb']} MB · schema v{data['schema']}")
    print(
        f"projects {data['projects']} · sessions {data['sessions']} · turns {data['turns']} · memories {data['memories']} · vectors {data['vectors']}"
    )
    print(f"recipes {data['recipes']} · rules enabled {data['rules_enabled']} / proposed {data['rules_proposed']}")
    print(
        f"learning: errors fixed {learning['errors_fixed']} · known errors recurred {learning['known_errors_recurred']}"
        f" · repetition rate {learning['repetition_rate'] if learning['repetition_rate'] is not None else '-'}"
    )
    print(f"semantic: {data['semantic']} · spool {data['spool']} · quarantine {data['quarantine']}")
    print(f"last backup {data['last_backup_at'] or 'never'} · last consolidation {data['consolidated_at'] or 'never'}")
    if data["paused_until"]:
        print(f"capture paused until {data['paused_until']}")
    for component, info in sorted(data["components"].items()):
        print(
            f"  {component}: ok {info['ok_count']} (last {info['last_ok_at'] or '-'}), errors {info['error_count']}"
            + (f" (last: {info['last_error']})" if info["error_count"] else "")
        )
    for warning in data["config_warnings"]:
        print(f"! {warning}")
    return 0


def cmd_search(ns: argparse.Namespace, config: Config) -> int:
    from . import semantic

    with _conn(config) as conn:
        project = _project(conn, ns.project)
        retriever = semantic.Retriever(conn, config, semantic.load_embedder(config))
        hits = retriever.search(
            ns.query,
            project.id if project else None,
            limit=ns.limit,
            include_other_projects=ns.all_projects,
            record_shown=False,
        )
        if ns.json:
            print(
                json.dumps(
                    [
                        {
                            "id": h.label,
                            "score": round(h.score, 4),
                            "kind": h.kind,
                            "ts": h.ts,
                            "title": h.title,
                            "sources": sorted(h.sources),
                        }
                        for h in hits
                    ],
                    indent=2,
                )
            )
        else:
            views.prime_anchor_states(conn, hits)
            print(views.search_lines(hits))
    return 0


def cmd_show(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        print(views.details(conn, ns.ids))
    return 0


def _duration(text: str) -> timedelta:
    match = re.fullmatch(r"(\d+)\s*([mhd])", text.strip().lower())
    if not match:
        raise SystemExit("duration must look like 30m, 2h or 1d")
    value, unit = int(match.group(1)), match.group(2)
    return {"m": timedelta(minutes=value), "h": timedelta(hours=value), "d": timedelta(days=value)}[unit]


def cmd_pause(ns: argparse.Namespace, config: Config) -> int:
    until = timeutil.iso(timeutil.now() + _duration(ns.duration)) if ns.duration else "forever"
    with _conn(config) as conn, db.transaction(conn):
        db.set_meta(conn, "paused_until", until)
    print(f"Capture paused until {until}.")
    return 0


def cmd_resume(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn, db.transaction(conn):
        conn.execute("DELETE FROM meta WHERE key = 'paused_until'")
    print("Capture resumed.")
    return 0


def cmd_import(ns: argparse.Namespace, config: Config) -> int:
    from . import importers

    with _conn(config) as conn:
        if ns.source == "claude":
            stats = importers.import_claude(conn, config, ns.path, dry_run=ns.dry_run)
        elif ns.source == "codex":
            stats = importers.import_codex(conn, config, ns.path, dry_run=ns.dry_run)
        else:
            if ns.path is None:
                print(f"import {ns.source} needs a path", file=sys.stderr)
                return 2
            function = {
                "v1": importers.import_v1,
                "claude-mem": importers.import_claude_mem,
                "agentmemory": importers.import_agentmemory,
            }[ns.source]
            stats = function(conn, config, ns.path, dry_run=ns.dry_run)
    print(json.dumps({"source": ns.source, "dry_run": ns.dry_run, **stats}, indent=2))
    return 0


def _rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params)]


def cmd_export(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        project = _project(conn, ns.project) if ns.project else None
        where, params = ("WHERE project_id = ?", (project.id,)) if project else ("", ())
        data = {
            "version": 2,
            "exported_at": timeutil.iso(),
            "projects": _rows(conn, f"SELECT * FROM projects {'WHERE id = ?' if project else ''}", params),
            "sessions": _rows(conn, f"SELECT * FROM sessions {where}", params),
            "turns": _rows(
                conn,
                f"SELECT id, session_id, project_id, started_at, ended_at, prompt, answer, outcome, importance, "
                f"files_json, commands_json, errors_json FROM turns {where}",
                params,
            ),
            "memories": _rows(
                conn,
                f"SELECT id, project_id, kind, title, body, source, trust, origin, valid_from, invalid_at, "
                f"superseded_by, created_at, turn_id FROM memories {where}",
                params,
            ),
            "recipes": _rows(conn, f"SELECT * FROM recipes {where}", params),
            "rules": _rows(conn, f"SELECT * FROM rules {where}", params),
            "profile": _rows(conn, f"SELECT * FROM profile {where}", params),
        }
    text = json.dumps(data, indent=2, ensure_ascii=False)
    if ns.output:
        ns.output.write_text(text, encoding="utf-8")
        if sys.platform != "win32":
            os.chmod(ns.output, 0o600)
        print(f"Exported to {ns.output}.")
    else:
        print(text)
    return 0


def _confirm(ns: argparse.Namespace, what: str) -> bool:
    if ns.yes:
        return True
    if not sys.stdin.isatty():
        print(f"Refusing to {what} without --yes.", file=sys.stderr)
        return False
    return input(f"Really {what}? This cannot be undone. [y/N] ").strip().lower() in {"y", "yes", "j", "ja"}


def _delete_owners(conn: sqlite3.Connection, owners: list[tuple[str, int]]) -> None:
    for owner in owners:
        store.delete_owner(conn, *owner)


def cmd_purge(ns: argparse.Namespace, config: Config) -> int:
    if ns.all:
        if not _confirm(ns, "delete ALL agent-mem data"):
            return 1
        import shutil

        for path in (config.db_path, Path(f"{config.db_path}-wal"), Path(f"{config.db_path}-shm")):
            if path.exists():
                path.unlink()
        for folder in (config.backup_dir, config.spool_dir, config.quarantine_dir, config.log_dir):
            shutil.rmtree(folder, ignore_errors=True)
        print("All data deleted (config and models kept).")
        return 0
    with _conn(config) as conn:
        if ns.id:
            owner = store.parse_owner(ns.id)
            if owner is None:
                print("invalid id", file=sys.stderr)
                return 2
            with db.transaction(conn):
                deleted = store.delete_owner(conn, *owner)
            print(f"Deleted {ns.id}." if deleted else f"{ns.id} not found.")
        elif ns.project:
            project = _project(conn, ns.project)
            if project is None or not _confirm(ns, f"delete all data of project {project.name}"):
                return 1
            with db.transaction(conn):
                owners = [("t", r[0]) for r in conn.execute("SELECT id FROM turns WHERE project_id = ?", (project.id,))]
                owners += [
                    ("m", r[0]) for r in conn.execute("SELECT id FROM memories WHERE project_id = ?", (project.id,))
                ]
                _delete_owners(conn, owners)
                conn.execute("DELETE FROM entities WHERE project_id = ?", (project.id,))
                conn.execute("DELETE FROM projects WHERE id = ?", (project.id,))
            removed = spool.purge_matching(
                config.spool_dir,
                lambda r: (
                    bool((r.get("event") or {}).get("cwd")) and identity.is_within(str(r["event"]["cwd"]), project.root)
                ),
            )
            print(f"Deleted project {project.name} ({len(owners)} items, {removed} spooled events).")
        else:
            cutoff = timeutil.parse(ns.before) if ns.before else None
            if cutoff is None:
                print("--before needs an ISO date such as 2026-01-31", file=sys.stderr)
                return 2
            if not _confirm(ns, f"delete everything before {ns.before}"):
                return 1
            stamp = timeutil.iso(cutoff)
            with db.transaction(conn):
                owners = [("t", r[0]) for r in conn.execute("SELECT id FROM turns WHERE started_at < ?", (stamp,))]
                owners += [("m", r[0]) for r in conn.execute("SELECT id FROM memories WHERE created_at < ?", (stamp,))]
                _delete_owners(conn, owners)
                conn.execute("DELETE FROM events WHERE ts < ?", (stamp,))
                conn.execute("DELETE FROM sessions WHERE last_event_at < ?", (stamp,))
            print(f"Deleted {len(owners)} items before {ns.before}.")
        conn.execute("VACUUM")
        db.rebuild_backups(conn, config)
        with db.transaction(conn):
            db.set_meta(conn, "last_backup_at", timeutil.iso())
            db.set_meta(conn, "backups_dirty", "0")
    return 0


def cmd_backup(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        target = db.backup(conn, config, label="manual")
        db.prune_backups(config, max(config.retention.backup_keep, 1))
        with db.transaction(conn):
            db.set_meta(conn, "last_backup_at", timeutil.iso())
    print(f"Backup written to {target}.")
    return 0


def cmd_consolidate(ns: argparse.Namespace, config: Config) -> int:
    from .indexer import run

    print(json.dumps(run(config, force_consolidate=True, allow_download=False), indent=2, default=str))
    return 0


def cmd_rules(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        if ns.action == "list":
            rows = conn.execute(
                "SELECT r.*, p.name AS project FROM rules r LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.evidence DESC"
            ).fetchall()
            if not rows:
                print("No rules learned yet. Rules are proposed after repeated corrections such as 'pnpm statt npm'.")
            for row in rows:
                state = "enabled" if row["enabled"] else "proposed"
                print(
                    f"R{row['id']} [{state}] {row['message']} · evidence {row['evidence']} · hits {row['hits']} · "
                    f"overrides {row['overrides']} · project {row['project'] or 'global'}"
                )
            return 0
        if ns.rule_id is None:
            print("rule id required", file=sys.stderr)
            return 2
        with db.transaction(conn):
            if ns.action == "delete":
                changed = conn.execute("DELETE FROM rules WHERE id = ?", (ns.rule_id,)).rowcount
            else:
                changed = conn.execute(
                    "UPDATE rules SET enabled = ?, overrides = 0 WHERE id = ?",
                    (1 if ns.action == "enable" else 0, ns.rule_id),
                ).rowcount
        print(f"R{ns.rule_id}: {ns.action}d." if changed else f"R{ns.rule_id} not found.")
    return 0


def cmd_lessons(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        project = _project(conn, None)
        project_id = project.id if project else None
        lines: list[str] = []
        for row in conn.execute(
            "SELECT message, evidence FROM rules WHERE (project_id IS ? OR project_id IS NULL) AND evidence >= 2 ORDER BY evidence DESC",
            (project_id,),
        ):
            lines.append(f"- {row['message'].replace('`', '')} (you corrected this {row['evidence']}x)")
        for row in conn.execute(
            "SELECT command_key, error_text, files_json, successes FROM recipes WHERE project_id IS ? AND successes >= 2 "
            "ORDER BY successes DESC LIMIT 5",
            (project_id,),
        ):
            files = ", ".join(json.loads(row["files_json"] or "[]")[:3])
            lines.append(
                f'- If `{row["command_key"]}` fails with "{row["error_text"][:80]}", check {files or "recent changes"} '
                f"(fixed this way {row['successes']}x)"
            )
        for row in conn.execute(
            "SELECT title FROM memories WHERE (project_id IS ? OR project_id IS NULL) AND kind IN ('decision', 'preference') "
            "AND invalid_at IS NULL ORDER BY importance DESC, created_at DESC LIMIT 5",
            (project_id,),
        ):
            lines.append(f"- {row['title']}")
    if not lines:
        print("Nothing repeated often enough yet.")
        return 0
    print("Suggested lines for AGENTS.md / CLAUDE.md (review before adding):\n")
    print("\n".join(dict.fromkeys(lines)))
    return 0


def cmd_models(ns: argparse.Namespace, config: Config) -> int:
    from . import semantic

    embedder, reason = semantic.load_embedder_verbose(config, allow_download=ns.action == "install")
    if embedder is None:
        print(f"Semantic search unavailable: {reason}. Lexical search keeps working.")
        return 1 if ns.action == "install" else 0
    print(f"Model ready: {embedder.model} (cache {config.model_dir}).")
    return 0


def plugins_dir() -> Path:
    """Plugin files ship inside the wheel (agent_mem/plugins) and live in ./plugins in a checkout."""
    packaged = Path(__file__).resolve().parent / "plugins"
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[2] / "plugins"


SETUP = {
    "claude": """Claude Code
  1. /plugin marketplace add Abuarchiv/agent-mem
  2. /plugin install agent-mem@agent-mem
  3. Restart Claude Code. Hooks and the MCP server are registered by the plugin.
  Manual alternative: copy the "hooks" object from {plugins}/claude/hooks/hooks.json into
  ~/.claude/settings.json and run `claude mcp add agent-mem -- agent-mem mcp`.""",
    "codex": """Codex CLI
  1. codex plugin marketplace add Abuarchiv/agent-mem
  2. codex plugin add agent-mem@agent-mem
  3. Start codex and trust the hooks once with /hooks (Codex requires this review).
  Manual alternative: merge {plugins}/codex/hooks.json into ~/.codex/hooks.json and add to ~/.codex/config.toml:
    [mcp_servers.agent-mem]
    command = "agent-mem"
    args = ["mcp"]""",
    "copilot": """GitHub Copilot CLI
  1. Inside copilot: /plugin marketplace add Abuarchiv/agent-mem, then /plugin install agent-mem@agent-mem
     (or install the bundled copy by path: /plugin install {plugins}/copilot)
  Manual alternative: copy {plugins}/copilot/hooks/hooks.json to ~/.copilot/hooks/agent-mem.json and add the
  MCP server with /mcp add (command: agent-mem, args: mcp).""",
    "opencode": """OpenCode
  1. agent-mem setup opencode --write      (copies the plugin to ~/.config/opencode/plugin/agent-mem.ts)
  2. Add to ~/.config/opencode/opencode.json:
     "mcp": {{ "agent-mem": {{ "type": "local", "command": ["agent-mem", "mcp"], "enabled": true }} }}
  Run OpenCode sessions serially per repository (upstream snapshot lock).""",
}


def cmd_setup(ns: argparse.Namespace, config: Config) -> int:
    folder = plugins_dir()
    print(SETUP[ns.harness].format(plugins=folder))
    if ns.harness == "opencode" and ns.write:
        import shutil

        target_dir = Path.home() / ".config" / "opencode" / "plugin"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "agent-mem.ts"
        shutil.copyfile(folder / "opencode" / "agent-mem.ts", target)
        print(f"\nPlugin written to {target}.")
    print("\nThen run `agent-mem doctor` after your first session.")
    return 0
