"""CLI commands that read or change the stored data, plus the servers (view, serve, mcp) and background jobs."""

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

from agent_mem import ui
from agent_mem.cli import lifecycle
from agent_mem.core import db, identity, spool, timeutil
from agent_mem.core.config import Config
from agent_mem.memory import store, views
from agent_mem.ui import autostart, server


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
        "models": lifecycle.cmd_models,
        "setup": lifecycle.cmd_setup,
        "uninstall": lifecycle.cmd_uninstall,
        "upgrade": lifecycle.cmd_upgrade,
        "view": cmd_view,
    }[ns.command]
    return handler(ns, config)


def _conn(config: Config) -> sqlite3.Connection:
    return db.connect(config, busy_timeout_ms=5000)


def _project(conn: sqlite3.Connection, directory: str | None) -> identity.Project | None:
    """Known project for ``directory`` (default: cwd). Read-only: commands never register projects."""
    return identity.find(conn, os.path.abspath(directory or os.getcwd()))


def _unknown_project(directory: str) -> int:
    print(f"No recorded project at {os.path.abspath(directory)}.", file=sys.stderr)
    return 2


def _times(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def cmd_status(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.ui.status import status

    with _conn(config) as conn:
        data = status(conn, config)
    if ns.json:
        print(json.dumps(data, indent=2, default=str))
        return 0
    from agent_mem.hooks.hook import job_name

    def count(n: int, word: str, many: str = "") -> str:
        return f"{n} {word if n == 1 else many or word + 's'}"

    learning = data["learning"]
    print(f"agent-mem · {data['data_dir']} · {data['db_mb']} MB")
    print(
        f"Saved: {count(data['projects'], 'project')} · {count(data['sessions'], 'session')}"
        f" · {count(data['turns'], 'request')} · {count(data['memories'], 'memory', 'memories')}"
    )
    print(
        f"Learned: {count(data['recipes'], 'error fix', 'error fixes')} · rules: {data['rules_enabled']} on,"
        f" {data['rules_proposed']} suggested · fixed errors that came back: {learning['known_errors_recurred']}"
    )
    meaning = data["semantic"] if data["semantic"] in {"unavailable", "not indexed yet"} else "on"
    print(f"Search by meaning: {meaning} ({count(data['vectors'], 'entry', 'entries')})")
    if data["spool"] or data["quarantine"]:
        print(
            f"Not saved yet: {count(data['spool'], 'event')} · could not be read: {count(data['quarantine'], 'file')}"
        )
    injected = data["injected"]
    print(
        f"Given to agents: today ~{injected['today_tokens']:,} tokens · last {injected['days']} days"
        f" ~{injected['tokens']:,} tokens in {count(injected['blocks'], 'reminder')}"
        f" (~{injected['tokens_per_session'] or 0:,} per session)"
    )
    if injected["saved_percent"] is not None:
        saved = injected["work"] - injected["tokens"]
        print(f"Your savings: ~{saved:,} tokens ({injected['saved_percent']}% reduction from reuse)")
    print(f"Last cleanup: {timeutil.local(data['consolidated_at'])}")
    if data["paused_until"]:
        print(f"Recording paused until {timeutil.local(data['paused_until'])}")
    print("Background jobs:")
    for component, info in sorted(data["components"].items()):
        failing = info["last_error_at"] and (not info["last_ok_at"] or info["last_error_at"] > info["last_ok_at"])
        state = f"failing: {info['last_error']}" if failing else f"working, last {timeutil.local(info['last_ok_at'])}"
        print(f"  {job_name(component)}: {state}")
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
            print(views.search_lines(hits, footer=f"Details: agent-mem show {hits[0].label if hits else '<id>'}"))
    return 0


def cmd_show(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.memory.store import parse_owner

    with _conn(config) as conn:
        print(views.details(conn, ns.ids))
        owners = [owner for owner in map(parse_owner, ns.ids[:10]) if owner is not None]
        found = any(
            conn.execute(f"SELECT 1 FROM {'turns' if kind == 't' else 'memories'} WHERE id = ?", (number,)).fetchone()
            for kind, number in owners
        )
    return 0 if found else 1  # like grep: a script sees that nothing was found


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
    print(f"Recording paused until {timeutil.local(until) if until != 'forever' else 'you run `agent-mem resume`'}.")
    return 0


def cmd_resume(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn, db.transaction(conn):
        db.delete_meta(conn, "paused_until")
    print("Recording again.")
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
    # A written page holds a copy of the data; it must not outlive a purge. Each branch discards it only once the
    # purge is confirmed.
    if ns.all:
        return _purge_all(ns, config)
    with _conn(config) as conn:
        if ns.id:
            code = _purge_id(ns, config, conn)
        elif ns.project:
            code = _purge_project(ns, config, conn)
        else:
            code = _purge_before(ns, config, conn)
        if code:
            return code
        conn.execute("VACUUM")
        # Copies left by older releases (``restore``'s .replaced, daily backups) hold the deleted data as well.
        with contextlib.suppress(OSError):
            Path(f"{config.db_path}.replaced").unlink()
        shutil.rmtree(config.backup_dir, ignore_errors=True)
    return 0


def _purge_all(ns: argparse.Namespace, config: Config) -> int:
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


def _purge_id(ns: argparse.Namespace, config: Config, conn: sqlite3.Connection) -> int:
    owner = store.parse_owner(ns.id)
    if owner is None:
        print("invalid id", file=sys.stderr)
        return 2
    ui.discard(config)
    with db.transaction(conn):
        deleted = store.delete_owner(conn, *owner)
    print(f"Deleted {ns.id}." if deleted else f"{ns.id} not found.")
    return 0 if deleted else 1


def _purge_project(ns: argparse.Namespace, config: Config, conn: sqlite3.Connection) -> int:
    project = _project(conn, ns.project)
    if project is None:
        return _unknown_project(ns.project)
    # Any path inside a project resolves to that project, so a typo would name the project around it. Deleting a
    # whole project takes its own folder.
    target = os.path.abspath(ns.project)
    if not (identity.is_within(target, project.root) and identity.is_within(str(project.root), target)):
        print(
            f"{target} is not a project root; it lies in project {project.name} ({project.root}). "
            f"To delete that project, pass --project {project.root}.",
            file=sys.stderr,
        )
        return 2
    if not _confirm(ns, f"delete all data of project {project.name}"):
        return 1
    ui.discard(config)
    with db.transaction(conn):
        owners = [("t", r[0]) for r in conn.execute("SELECT id FROM turns WHERE project_id = ?", (project.id,))]
        owners += [("m", r[0]) for r in conn.execute("SELECT id FROM memories WHERE project_id = ?", (project.id,))]
        _delete_owners(conn, owners)
        conn.execute("DELETE FROM entities WHERE project_id = ?", (project.id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project.id,))
    removed = _purge_spooled(
        config,
        lambda r: bool((r.get("event") or {}).get("cwd")) and identity.is_within(str(r["event"]["cwd"]), project.root),
    )
    print(f"Deleted project {project.name} ({len(owners)} items, {removed} events not saved yet).")
    return 0


def _purge_before(ns: argparse.Namespace, config: Config, conn: sqlite3.Connection) -> int:
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
    print(f"Deleted {len(owners)} items and {removed} unsaved events from before {ns.before}.")
    return 0


def cmd_consolidate(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.memory.indexer import run

    stats = run(config, force_consolidate=True, allow_download=False)
    if ns.json:
        print(json.dumps(stats, indent=2, default=str))
    else:
        print(f"Not done: {stats['skipped']}, try again shortly." if "skipped" in stats else "Cleanup done.")
    return 0


def cmd_rules(ns: argparse.Namespace, config: Config) -> int:
    with _conn(config) as conn:
        if ns.action == "list":
            rows = conn.execute(
                "SELECT r.*, p.name AS project FROM rules r LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.evidence DESC"
            ).fetchall()
            if not rows:
                print(
                    "No rules learned yet. A rule is suggested after you correct the same thing, e.g. 'pnpm statt npm'."
                )
            for row in rows:
                state = "on: can block" if row["enabled"] else "suggested: only warns"
                print(
                    f"R{row['id']} [{state}] {row['message']} · from {_times(row['evidence'], 'correction')}"
                    f" · used {_times(row['hits'], 'time')} · ignored {_times(row['overrides'], 'time')}"
                    f" · project {row['project'] or 'all'}"
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
    return 0 if changed else 1


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


def cmd_view(ns: argparse.Namespace, config: Config) -> int:
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
    if ns.json:
        print(json.dumps({name: str(path) for name, path in locations.items()}, indent=2))
        return 0
    for label, path in zip(("Data folder", "Database", "Settings", "Logs", "Models"), locations.values(), strict=True):
        print(f"{label + ':':13} {path}")
    return 0


def cmd_mcp(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.mcp.server import main as mcp_main

    return mcp_main()


def cmd_observe(ns: argparse.Namespace, config: Config) -> int:
    if ns.status:
        from agent_mem.observe import queue

        with _conn(config) as conn:
            data = queue.status(conn)
        if ns.json:
            print(json.dumps(data, indent=2, ensure_ascii=False, default=str))
            return 0
        states = data["queue"]
        print(
            f"Requests: {states.get('pending', 0) + states.get('running', 0)} waiting, {states.get('done', 0)} with facts,"
            f" {states.get('raw', 0)} saved word for word, {states.get('failed', 0)} failed"
        )
        for call in data["calls_today"]:
            failed = call["n"] - (call["ok"] or 0)
            job = {"extract": "facts", "summary": "titles", "graph": "links", "review": "cleanup"}.get(call["purpose"])
            print(
                f"  today {call['provider']}, {job or call['purpose']}: {call['n']} calls"
                + (f", {failed} failed" if failed else "")
            )
        for error in data["recent_errors"]:
            print(f"  T{error['turn_id']}: {str(error['last_error'])[:160]}")
        if data["recent_errors"]:
            print("Try them again with `agent-mem observe --retry-failed`.")
        return 0
    if ns.reindex:
        from agent_mem.observe.worker import reindex

        done = reindex(config)
        print(json.dumps(done, indent=2) if ns.json else f"Fact store rebuilt from {done['facts']} facts.")
        return 0
    from agent_mem.observe.worker import run

    stats = run(config, drain=not ns.once, retry_failed=ns.retry_failed, reprocess_raw=ns.reprocess_raw)
    if ns.json:
        print(json.dumps(stats, indent=2, default=str))
    elif "skipped" in stats:
        print("Already running in the background.")
    elif not ns.quiet:
        print(
            f"Done: {stats['facts']} new facts from {stats['bundles']} batches of requests"
            + (f", {stats['failed']} failed (`agent-mem observe --status`)" if stats["failed"] else "")
            + "."
        )
    return 0


def cmd_index(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli.health import record_setup_health
    from agent_mem.memory.indexer import run

    stats = run(config, allow_download=not ns.no_download)
    record_setup_health(config)
    if ns.json:
        print(json.dumps(stats, indent=2, default=str))
    elif not ns.quiet:
        print(
            f"Not updated: {stats['skipped']}, try again shortly."
            if "skipped" in stats
            else "Search index is up to date."
        )
    return 0


def cmd_eval(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.bench.evaluate import Runner

    if not ns.fixture and not ns.dataset:
        print("agent-mem eval: needs a dataset or --fixture", file=sys.stderr)
        return 2
    for path in (ns.fixture, ns.dataset, ns.custom_prompt):
        if path and not path.exists():  # before Runner loads, maybe downloads, the embedding model
            raise FileNotFoundError(2, "No such file", str(path))
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
    if ns.autostart:
        print(autostart.install_autostart(config))
        return 0
    if ns.no_autostart:
        removed = autostart.remove_autostart()
        print(
            f"Removed {removed}. The viewer still starts with each agent session."
            if removed
            else "No login item found."
        )
        return 0
    return server.serve(config, quiet=ns.quiet)
