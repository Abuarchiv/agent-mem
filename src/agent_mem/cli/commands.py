"""Implementations of the smaller CLI commands."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

from agent_mem.core import db, identity, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store, views


def dispatch(ns: argparse.Namespace, config: Config) -> int:
    handler = {
        "status": cmd_status,
        "doctor": cmd_doctor,
        "paths": cmd_paths,
        "mcp": cmd_mcp,
        "observe": cmd_observe,
        "index": cmd_index,
        "eval": cmd_eval,
        "serve": cmd_serve,
        "search": cmd_search,
        "show": cmd_show,
        "pause": cmd_pause,
        "resume": cmd_resume,
        "export": cmd_export,
        "purge": cmd_purge,
        "consolidate": cmd_consolidate,
        "rules": cmd_rules,
        "lessons": cmd_lessons,
        "models": cmd_models,
        "setup": cmd_setup,
        "uninstall": cmd_uninstall,
        "upgrade": cmd_upgrade,
        "view": cmd_view,
    }[ns.command]
    return handler(ns, config)


def _conn(config: Config) -> sqlite3.Connection:
    return db.connect(config, busy_timeout_ms=5000)


def _project(conn: sqlite3.Connection, directory: str | None) -> identity.Project | None:
    """Known project for ``directory`` (default: cwd). Read-only: commands never register projects."""
    return identity.find(conn, os.path.abspath(directory or os.getcwd()))


def _unknown_project(directory: str) -> int:
    print(f"No captured project at {os.path.abspath(directory)}.", file=sys.stderr)
    return 2


def cmd_status(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli.health import status

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
    injected = data["injected"]
    print(
        f"injected: today ~{injected['today_tokens']} tokens · last {injected['days']} days {injected['blocks']} blocks,"
        f" ~{injected['tokens']} tokens, ~{injected['tokens_per_session'] or '-'} per session"
    )
    if injected["built_from"]:
        drew = (
            f"those blocks stand for ~{injected['work']:,} tokens of agent work (-{injected['saved_percent']}% to read)"
            if injected["saved_percent"] is not None
            else "no injected memory has measured work yet"
        )
        print(
            f"work: {drew} · memory built from ~{injected['built_from']:,} tokens in {injected['measured_turns']}"
            " turns (fresh tokens from the transcripts, cache reads left out)"
        )
    print(f"last consolidation {data['consolidated_at'] or 'never'}")
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
    from agent_mem.memory import semantic

    with _conn(config) as conn:
        project = _project(conn, ns.project)
        if ns.project and project is None:
            return _unknown_project(ns.project)
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
    match = re.fullmatch(r"(\d{1,6})\s*([mhd])", text.strip().lower())
    if not match:
        raise SystemExit("duration must look like 30m, 2h or 1d")
    value, unit = int(match.group(1)), match.group(2)
    duration = {"m": timedelta(minutes=value), "h": timedelta(hours=value), "d": timedelta(days=value)}[unit]
    if duration > timedelta(days=3650):
        raise SystemExit("duration must be at most 10 years; use `agent-mem pause` without --for to pause indefinitely")
    return duration


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


def _rows(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(sql, params)]


def cmd_export(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        project = _project(conn, ns.project) if ns.project else None
        if ns.project and project is None:
            return _unknown_project(ns.project)
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
        ns.output.parent.mkdir(parents=True, exist_ok=True)
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


def _purge_spooled(config: Config, matches: Callable[[dict[str, Any]], bool]) -> int:
    """Spooled and quarantined events both hold full event copies."""
    return spool.purge_matching(config.spool_dir, matches) + spool.purge_matching(config.quarantine_dir, matches)


def cmd_purge(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem import ui

    # A written page holds a copy of the data; it must not outlive a purge. It is discarded only
    # once the purge is confirmed.
    if ns.all:
        if not _confirm(ns, "delete ALL agent-mem data"):
            return 1
        ui.discard(config)
        for path in (
            config.db_path,
            Path(f"{config.db_path}-wal"),
            Path(f"{config.db_path}-shm"),
            Path(f"{config.db_path}.replaced"),
        ):
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
            ui.discard(config)
            with db.transaction(conn):
                deleted = store.delete_owner(conn, *owner)
            print(f"Deleted {ns.id}." if deleted else f"{ns.id} not found.")
        elif ns.project:
            project = _project(conn, ns.project)
            if project is None:
                return _unknown_project(ns.project)
            if not _confirm(ns, f"delete all data of project {project.name}"):
                return 1
            ui.discard(config)
            with db.transaction(conn):
                owners = [("t", r[0]) for r in conn.execute("SELECT id FROM turns WHERE project_id = ?", (project.id,))]
                owners += [
                    ("m", r[0]) for r in conn.execute("SELECT id FROM memories WHERE project_id = ?", (project.id,))
                ]
                _delete_owners(conn, owners)
                conn.execute("DELETE FROM entities WHERE project_id = ?", (project.id,))
                conn.execute("DELETE FROM projects WHERE id = ?", (project.id,))
            removed = _purge_spooled(
                config,
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
            ui.discard(config)
            stamp = timeutil.iso(cutoff)
            with db.transaction(conn):
                owners = [("t", r[0]) for r in conn.execute("SELECT id FROM turns WHERE started_at < ?", (stamp,))]
                owners += [("m", r[0]) for r in conn.execute("SELECT id FROM memories WHERE created_at < ?", (stamp,))]
                _delete_owners(conn, owners)
                conn.execute("DELETE FROM events WHERE ts < ?", (stamp,))
                conn.execute("DELETE FROM sessions WHERE last_event_at < ?", (stamp,))
            removed = _purge_spooled(config, lambda r: str((r.get("event") or {}).get("ts") or "9999") < stamp)
            print(f"Deleted {len(owners)} items and {removed} spooled events before {ns.before}.")
        conn.execute("VACUUM")
        # Copies left by older releases (``restore``'s .replaced, daily backups) hold the deleted data as well.
        with contextlib.suppress(OSError):
            Path(f"{config.db_path}.replaced").unlink()
        shutil.rmtree(config.backup_dir, ignore_errors=True)
    return 0


def cmd_consolidate(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.memory.indexer import run

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
            "AND (kind = 'decision' OR trust = 'user') AND invalid_at IS NULL ORDER BY importance DESC, created_at DESC LIMIT 5",
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
    from agent_mem.memory import semantic

    embedder, reason = semantic.load_embedder_verbose(config, allow_download=ns.action == "install")
    if embedder is None:
        print(f"Semantic search unavailable: {reason}. Lexical search keeps working.")
        return 1 if ns.action == "install" else 0
    print(f"Model ready: {embedder.model} (cache {config.model_dir}).")
    from agent_mem.cli import install

    if not install.extras()["observer"]:
        return 0
    from agent_mem.observe import spacy_model

    name = config.observe.entity_model
    path = spacy_model.model_path(config)
    if path is None and ns.action == "install":
        try:
            path = spacy_model.download_model(config)
        except (OSError, ValueError) as error:
            print(f"Concept model {name} not downloaded: {error}. Facts work without mem0's entity linking.")
            return 1
    print(
        f"Concept model {'ready: ' + name + f' ({path})' if path else name + ' missing: run `agent-mem models install`'}."
    )
    return 0


def cmd_view(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem import ui

    with _conn(config) as conn:
        # Look the project up only; viewing must not register a directory as a new project.
        project = identity.find(conn, os.path.abspath(ns.project)) if ns.project else None
        if ns.project and project is None:
            return _unknown_project(ns.project)
        project_id = project.id if project else None
        snapshot = ui.build_snapshot(conn, config, project_id) if ns.output or ns.no_open else None
    if snapshot is None:
        address = _served_url(config, project_id)
        if address is not None:
            import webbrowser

            print(f"Viewer at {address} (always on).")
            if not webbrowser.open(address):
                print("No browser found; open the address above.")
            return 0
        with _conn(config) as conn:
            snapshot = ui.build_snapshot(conn, config, project_id)
        print("The viewer did not start (see `agent-mem serve`); writing an offline snapshot instead.")
    target = ui.write(config, ui.render({**snapshot, "refresh": None}), ns.output)
    print(f"Wrote {target}. It is a local file with a copy of your memory; it makes no network requests.")
    if not ns.no_open:
        import webbrowser

        if not webbrowser.open(target.as_uri()):
            print("Open it in a browser to view it.")
    return 0


def _served_url(config: Config, project_id: str | None) -> str | None:
    """Address of the running viewer, starting it first if needed."""
    from agent_mem.hooks.hook import spawn_viewer
    from agent_mem.ui import server

    if not config.viewer.enabled:
        return None
    if not server.running(config):
        spawn_viewer(config, force=True)
        deadline = time.monotonic() + 8
        while not server.running(config, timeout=0.5):
            if time.monotonic() > deadline:
                return None
            time.sleep(0.2)
    from urllib.parse import quote

    return server.url(config) + (f"?project={quote(project_id)}" if project_id else "")


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
  1. agent-mem setup opencode --write      (copies the plugin to ~/.config/opencode/plugins/agent-mem.ts)
  2. Add to ~/.config/opencode/opencode.json:
     "mcp": {{ "agent-mem": {{ "type": "local", "command": ["agent-mem", "mcp"], "enabled": true }} }}
  Run OpenCode sessions serially per repository (upstream snapshot lock).""",
}


def _detect_table(found: dict[str, Any]) -> str:
    rows = [f"  agent-mem binary: {found['binary']}"]
    for name, path in found["harnesses"].items():
        rows.append(f"  harness {name:9s} {'found ' + path if path else 'not on PATH'}")
    for name, path in found["providers"].items():
        if name == "ollama":
            state = "found (opt-in: add 'ollama' to observe.providers)" if path else "not installed (optional)"
        else:
            state = "found, uses your existing login" if path else "not on PATH"
        rows.append(f"  provider {name:8s} {state}")
    extras = found["extras"]
    rows.append(f"  extra semantic: {'installed' if extras['semantic'] else 'missing (lexical search only)'}")
    rows.append(f"  extra observer: {'installed' if extras['observer'] else 'missing (turns are kept raw, no facts)'}")
    return "\n".join(rows)


def _targets(harness: str, found: dict[str, Any]) -> list[str]:
    """``all`` means every harness on PATH, so someone using only Codex or all four sets up the same way."""
    if harness != "all":
        return [harness]
    return [name for name, path in found["harnesses"].items() if path]


def cmd_setup(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli import install

    folder = install.plugins_dir()
    found = install.detect()
    targets = _targets(ns.harness, found)
    if not targets:
        print(
            "No harness on PATH (claude, codex, copilot, opencode). Install one, or name it: `agent-mem setup codex`."
        )
        print("\nDetected:\n" + _detect_table(found))
        return 1
    if not ns.write:
        for name in targets:
            print(SETUP[name].format(plugins=folder) + "\n")
        print("Or let agent-mem write the files with absolute paths: `agent-mem setup " + ns.harness + " --write`.")
        print("\nDetected:\n" + _detect_table(found))
        return 0
    for name in targets:
        touched = install.write(name, folder)
        print(f"{name}: hooks and MCP server registered with {found['binary']}.")
        for path in touched:
            print(f"  wrote {path}")
        if name == "codex":
            print("  Codex asks you to trust the hooks once: start codex and run /hooks.")
        if name == "claude" and install.claude_plugin_enabled():
            print("  The agent-mem plugin is enabled too; keep one: /plugin uninstall agent-mem@agent-mem.")
        if not found["extras"]["observer"]:
            continue
        if name == "opencode":
            print('  facts: OpenCode turns are kept raw unless you add "ollama" to observe.providers.')
        elif found["providers"].get(name):
            model = getattr(config.observe, f"{name}_model") or "the CLI default"
            print(f"  facts: extracted in the background through `{name}` ({model}) under your existing login.")
        else:
            print(f"  facts: `{name}` is not on PATH; turns of this harness are kept raw until it is.")
    if found["extras"]["semantic"] and not ns.no_models:
        from agent_mem.memory import semantic

        embedder, reason = semantic.load_embedder_verbose(config, allow_download=True)
        print(f"embedding model {embedder.model} ready." if embedder else f"embedding model not available: {reason}")
    if config.viewer.enabled:
        from agent_mem.ui import server

        print(server.install_autostart(config))
    print("\nDetected:\n" + _detect_table(found))
    print("\nStart a session, then run `agent-mem doctor`. `agent-mem view` opens the viewer.")
    return 0


def cmd_uninstall(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli import install

    for name in install.HARNESSES if ns.harness == "all" else [ns.harness]:
        touched = install.remove(name)
        if touched:
            print(f"{name}: removed agent-mem hooks and MCP entries from:")
            for path in touched:
                print(f"  {path}")
        elif ns.harness != "all":
            print(f"{name}: nothing written by `setup --write` was found.")
    from agent_mem.cli.health import harness_installed
    from agent_mem.ui import server

    if not any(harness_installed(name) for name in ("claude", "codex", "copilot", "opencode")):
        removed = server.remove_autostart()
        if removed:
            print(f"  removed the viewer login item {removed} (no harness left)")
    print(f"Data stays in {config.data_dir}; `agent-mem purge --all` deletes it.")
    return 0


def cmd_upgrade(ns: argparse.Namespace, config: Config) -> int:
    import shlex
    import subprocess

    from agent_mem.cli import install

    command = install.upgrade_command(ns.extras)
    if command is None:
        print(
            "This copy was not installed with `uv tool` (the install script uses it). Upgrade it the way you "
            "installed it, then run `agent-mem doctor --fix`.",
            file=sys.stderr,
        )
        return 1
    before = install.version()
    exe = str(Path(sys.executable).with_name("agent-mem.exe" if sys.platform == "win32" else "agent-mem"))
    print("$ " + shlex.join(command), flush=True)
    if subprocess.run(command, check=False).returncode != 0:
        print("Upgrade failed; uv names the cause above.", file=sys.stderr)
        return 1
    after = subprocess.run([exe, "--version"], capture_output=True, text=True, check=False).stdout.strip()
    after = after.removeprefix("agent-mem ") or "?"
    if after == before:
        added = f", now with {' and '.join(ns.extras)}" if ns.extras else ""
        print(f"agent-mem {after} is the newest version{added}.")
    else:
        print(
            f"agent-mem {before} -> {after}. Hooks use it now; running sessions keep their MCP server until restart.",
            flush=True,
        )
    # The new code finishes the job: models a new default or a new extra needs (a no-op when cached), then the
    # database migration and hooks of an older release.
    steps = [["models", "install"]] if install.extras()["semantic"] or "semantic" in ns.extras else []
    code = 0
    for step in [*steps, ["doctor", "--fix"]]:
        print(f"$ agent-mem {' '.join(step)}", flush=True)
        code = subprocess.run([exe, "--data-dir", str(config.data_dir), *step], check=False).returncode
    return code


def cmd_doctor(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli.health import doctor, format_checks, to_json

    checks = doctor(config, fix=ns.fix)
    print(to_json(checks) if ns.json else format_checks(checks))
    return 0 if all(c.ok or c.warn_only for c in checks) else 1


def cmd_paths(ns: argparse.Namespace, config: Config) -> int:
    locations = {
        "data_dir": config.data_dir,
        "database": config.db_path,
        "config": config.config_path,
        "logs": config.log_dir,
        "models": config.model_dir,
    }
    print(json.dumps({name: str(path) for name, path in locations.items()}, indent=2))
    return 0


def cmd_mcp(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.mcp.server import main as mcp_main

    return mcp_main()


def cmd_observe(ns: argparse.Namespace, config: Config) -> int:
    if ns.status:
        from agent_mem.observe import queue

        with _conn(config) as conn:
            print(json.dumps(queue.status(conn), indent=2, ensure_ascii=False, default=str))
        return 0
    if ns.reindex:
        from agent_mem.observe.worker import reindex

        print(json.dumps(reindex(config), indent=2))
        return 0
    from agent_mem.observe.worker import run

    stats = run(config, drain=not ns.once, retry_failed=ns.retry_failed, reprocess_raw=ns.reprocess_raw)
    if not ns.quiet:
        print(json.dumps(stats, indent=2, default=str))
    return 0


def cmd_index(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli.health import record_setup_health
    from agent_mem.memory.indexer import run

    stats = run(config, allow_download=not ns.no_download)
    record_setup_health(config)
    if not ns.quiet:
        print(json.dumps(stats, indent=2, default=str))
    return 0


def cmd_eval(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.bench.evaluate import Runner

    if not ns.fixture and not ns.dataset:
        print("agent-mem eval: needs a dataset or --fixture", file=sys.stderr)
        return 2
    runner = Runner(
        ns.backend,
        semantic_search=not ns.no_semantic,
        llm=ns.llm,
        llm_model=ns.llm_model,
        custom_instructions=ns.custom_prompt.read_text(encoding="utf-8") if ns.custom_prompt else None,
        min_score=ns.min_score,
        embedder_model=ns.embedder,
        vector_floor=ns.vector_floor,
    )
    if ns.fixture:
        report = runner.fixture(ns.fixture)
    else:
        report = runner.longmemeval(ns.dataset, limit=ns.limit, subset=ns.subset, progress=ns.progress)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def cmd_serve(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.ui import server

    if ns.autostart:
        print(server.install_autostart(config))
        return 0
    if ns.no_autostart:
        removed = server.remove_autostart()
        print(
            f"Removed {removed}. The viewer still starts with each agent session."
            if removed
            else "No login item found."
        )
        return 0
    return server.serve(config, quiet=ns.quiet)
