"""Apply a normalized event to the database: sessions, turns, signals, recipes, rules, context.

This is the write path for every event: live hooks, spool replay and transcript
imports. It is idempotent per event (dedupe key) and standard library only.
Memories from other sources (MCP, federation, summaries, memory imports) go
through ``store.add_memory``, which cleans them the same way.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import timedelta
from pathlib import PurePosixPath

from . import db, identity, inject, learn, privacy, signals, store, timeutil
from .config import Config, env_flag, load_project_settings
from .events import Event

_CITED = re.compile(r"\b([TM])(\d{1,9})\b")
_OVERRIDE = re.compile(r"(?i)\b(trotzdem|egal|ignore (the|that) rule|anyway|do it anyway|mach es trotzdem)\b")


@dataclass
class Response:
    context: str | None = None
    deny: str | None = None
    wants_indexer: bool = False
    stored: bool = False


def dedupe_key(event: Event) -> str:
    if event.native_event_id:
        suffix = event.native_event_id
    else:
        material = "|".join(
            str(part or "")
            for part in (
                event.ts,
                event.tool_use_id,
                event.tool,
                (event.prompt or "")[:500],
                (event.answer or "")[:500],
                (event.tool_output or "")[:200],
                event.source,
            )
        )
        suffix = hashlib.sha256(material.encode("utf-8", "replace")).hexdigest()[:24]
    return f"{event.harness}|{event.session_id}|{event.kind}|{suffix}"


def capture_allowed(conn: sqlite3.Connection, config: Config, project: identity.Project | None) -> bool:
    if not config.capture or env_flag("AGENT_MEM_DISABLE"):
        return False
    paused = db.get_meta(conn, "paused_until")
    if paused and (paused == "forever" or (timeutil.parse(paused) or timeutil.now()) > timeutil.now()):
        return False
    if project is not None:
        for excluded in config.excluded_projects:
            if identity.is_within(project.root, excluded):
                return False
        if not load_project_settings(project.root).capture:
            return False
    return True


def exclude_globs(config: Config, project: identity.Project | None) -> list[str]:
    extra = load_project_settings(project.root).exclude_globs if project else []
    return [*config.exclude_globs, *extra]


def apply(conn: sqlite3.Connection, config: Config, event: Event, *, with_context: bool = True) -> Response:
    if event.kind in {"pre_tool", "tool"} and event.is_own_tool:
        return Response()
    _bound_host_strings(event)
    # Resolve without writing: excluded, paused or opted-out projects leave no trace.
    project = identity.resolve(conn, event.cwd, register=False)
    if not capture_allowed(conn, config, project):
        return Response()
    with db.transaction(conn):
        if project is not None:
            identity.register_project(conn, project, event.cwd)
        response = _apply(conn, config, event, project, with_context)
        db.record_health(conn, f"hook:{event.harness}")
    return response


def _bound_host_strings(event: Event) -> None:
    """Short identifiers from the host are stored in columns too; clean and bound them like all text."""

    def bounded(value: str | None, limit: int) -> str | None:
        return privacy.clean_text(value, limit) or None if value else None

    event.tool = bounded(event.tool, 200)
    event.tool_use_id = bounded(event.tool_use_id, 128)
    event.source = bounded(event.source, 64)
    event.raw_kind = bounded(event.raw_kind, 64) or ""


def _apply(
    conn: sqlite3.Connection,
    config: Config,
    event: Event,
    project: identity.Project | None,
    with_context: bool,
) -> Response:
    session_id = _upsert_session(conn, event, project)
    project_id = project.id if project else None
    payload = _payload(config, event, project)
    inserted = conn.execute(
        "INSERT INTO events(session_id, turn_id, ts, kind, tool, tool_use_id, payload, trust, dedupe_key) "
        "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING",
        (
            session_id,
            event.ts,
            event.kind,
            event.tool,
            event.tool_use_id,
            json.dumps(payload, ensure_ascii=False),
            payload.get("trust", "user"),
            dedupe_key(event),
        ),
    )
    if inserted.rowcount == 0:
        return Response()
    event_id = int(inserted.lastrowid or 0)
    response = Response(stored=True)
    handler = {
        "session_start": _on_session_start,
        "prompt": _on_prompt,
        "pre_tool": _on_pre_tool,
        "tool": _on_tool,
        "stop": _on_stop,
        "subagent_stop": _on_subagent_stop,
        "compact": _on_compact,
        "session_end": _on_session_end,
    }[event.kind]
    handler(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context)
    if not with_context:
        response.context = None
        response.deny = None
    return response


# --- helpers -----------------------------------------------------------------


def _upsert_session(conn: sqlite3.Connection, event: Event, project: identity.Project | None) -> str:
    session_id = f"{event.harness}:{event.session_id}"
    branch = identity.read_branch(project.root) if project else None
    conn.execute(
        "INSERT INTO sessions(id, harness, native_id, project_id, branch, started_at, last_event_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET "
        "last_event_at = MAX(sessions.last_event_at, excluded.last_event_at), "
        "project_id = COALESCE(sessions.project_id, excluded.project_id), "
        "branch = COALESCE(excluded.branch, sessions.branch)",
        (session_id, event.harness, event.session_id, project.id if project else None, branch, event.ts, event.ts),
    )
    return session_id


def _payload(config: Config, event: Event, project: identity.Project | None) -> dict[str, object]:
    limits = config.limits
    data: dict[str, object] = {"raw_kind": event.raw_kind, "trust": "user"}
    if event.source:
        data["source"] = event.source
    if event.prompt is not None:
        data["prompt"] = privacy.clean_text(event.prompt, limits.prompt_chars)
    if event.answer is not None:
        data["answer"] = privacy.clean_text(event.answer, limits.answer_chars)
    if event.tool:
        tool_signal = signals.analyze_tool(event.tool, event.tool_input)
        data["category"] = tool_signal.category
        data["trust"] = "tool_external" if tool_signal.category in {"web", "mcp"} else "tool_local"
        globs = exclude_globs(config, project)
        excluded = [f for f in tool_signal.files if privacy.path_excluded(f, globs)]
        try:
            raw_input = (
                event.tool_input
                if isinstance(event.tool_input, str)
                else json.dumps(event.tool_input, ensure_ascii=False)
            )
        except (TypeError, ValueError):
            raw_input = str(event.tool_input)
        if excluded and tool_signal.category == "edit":
            raw_input = json.dumps({"files": list(tool_signal.files), "content": "[excluded by privacy rules]"})
        data["input"] = privacy.clean_text(raw_input or "", limits.tool_input_chars)
        if event.tool_output is not None:
            output = (
                "[excluded by privacy rules]"
                if excluded
                else privacy.denoise_output(event.tool_output, limits.tool_output_chars)
            )
            data["output"] = privacy.clean_text(output, limits.tool_output_chars)
        if event.tool_failed:
            data["failed"] = True
            error_text = event.error or event.tool_output or ""
            signature = signals.error_signature(privacy.clean_text(error_text, 4000))
            if signature:
                data["error_sig"], data["error_line"] = signature
        if event.exit_code is not None:
            data["exit_code"] = event.exit_code
    return data


def _open_turn(conn: sqlite3.Connection, session_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM turns WHERE session_id = ? AND outcome = 'open' ORDER BY id DESC LIMIT 1", (session_id,)
    ).fetchone()


def _new_turn(conn: sqlite3.Connection, session_id: str, project_id: str | None, ts: str, prompt: str) -> int:
    cursor = conn.execute(
        "INSERT INTO turns(session_id, project_id, started_at, prompt, trust) VALUES (?, ?, ?, ?, 'user')",
        (session_id, project_id, ts, prompt),
    )
    return int(cursor.lastrowid or 0)


def _close_turn(conn: sqlite3.Connection, turn_id: int, outcome: str, ts: str) -> None:
    unresolved = conn.execute(
        "SELECT COUNT(*) FROM events WHERE turn_id = ? AND error_sig IS NOT NULL AND resolved = 0", (turn_id,)
    ).fetchone()[0]
    final = "error" if outcome == "ok" and unresolved else outcome
    conn.execute("UPDATE turns SET outcome = ?, ended_at = ? WHERE id = ?", (final, ts, turn_id))
    store.index_turn(conn, turn_id)


def _turn_for_tool(conn: sqlite3.Connection, session_id: str, project_id: str | None, ts: str) -> int:
    turn = _open_turn(conn, session_id)
    if turn is not None:
        return int(turn["id"])
    return _new_turn(conn, session_id, project_id, ts, "")


def _append_json(conn: sqlite3.Connection, turn_id: int, column: str, values: list[str], cap: int = 40) -> None:
    if not values:
        return
    row = conn.execute(f"SELECT {column} FROM turns WHERE id = ?", (turn_id,)).fetchone()
    current = json.loads(row[0] or "[]") if row else []
    for value in values:
        if value and value not in current:
            current.append(value)
    conn.execute(
        f"UPDATE turns SET {column} = ? WHERE id = ?", (json.dumps(current[-cap:], ensure_ascii=False), turn_id)
    )


def _raise_importance(conn: sqlite3.Connection, turn_id: int, value: float) -> None:
    conn.execute("UPDATE turns SET importance = MAX(importance, ?) WHERE id = ?", (value, turn_id))


def _rel_files(project: identity.Project | None, files: tuple[str, ...]) -> list[str]:
    if project is None:
        return [f.replace("\\", "/") for f in files]
    return [identity.relative_path(project.root, f) for f in files]


# --- handlers ----------------------------------------------------------------


def _on_session_start(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    if not with_context or project_id is None:
        return
    if event.source == "compact":
        block = inject.compact(conn, config, session_id)
    else:
        block = inject.session_start(conn, config, project_id, session_id, event.harness)
    if block:
        response.context = block.text
        learn.record_access(conn, block.owners, "injected", session_id)


def _on_prompt(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    prompt = str(payload.get("prompt") or "")
    previous = _open_turn(conn, session_id)
    if previous is not None:
        _close_turn(conn, int(previous["id"]), "unknown", event.ts)
    last = conn.execute(
        "SELECT id, prompt, commands_json FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1", (session_id,)
    ).fetchone()
    turn_id = _new_turn(conn, session_id, project_id, event.ts, prompt)
    conn.execute("UPDATE events SET turn_id = ? WHERE id = ?", (turn_id, event_id))

    corrective = signals.is_correction(prompt) or signals.mentions_rule(prompt)
    if not corrective:
        # "X statt Y" / "use X instead of Y" is an explicit preference even without a correction.
        for avoid, prefer in signals.preference_pairs(prompt):
            if prefer is not None:
                _learn_rule(conn, config, project_id, avoid, prefer, turn_id)
    if corrective:
        context = ""
        if last is not None:
            commands = json.loads(last["commands_json"] or "[]")
            context = f"\nPrevious request (T{last['id']}): {signals.first_line(last['prompt'], 200)}"
            if commands:
                context += f"\nPrevious commands: {' | '.join(commands[-3:])}"
        store.add_memory(
            conn,
            project_id=project_id,
            kind="correction",
            title=signals.first_line(prompt, 200),
            body=prompt[:1500] + context,
            source="hook",
            trust="user",
            importance=signals.IMPORTANCE["correction"],
            turn_id=int(last["id"]) if last is not None else turn_id,
        )
        _raise_importance(conn, turn_id, signals.IMPORTANCE["correction"])
        for avoid, prefer in signals.preference_pairs(prompt):
            _learn_rule(conn, config, project_id, avoid, prefer, turn_id)
    for sentence in signals.decision_sentences(prompt):
        store.add_memory(
            conn,
            project_id=project_id,
            kind="decision",
            title=sentence,
            body=sentence,
            source="hook",
            trust="user",
            importance=signals.IMPORTANCE["decision"],
            turn_id=turn_id,
        )
        _raise_importance(conn, turn_id, signals.IMPORTANCE["decision"])
    if _OVERRIDE.search(prompt):
        conn.execute(
            "UPDATE rules SET overrides = overrides + 1, enabled = CASE WHEN overrides + 1 >= 2 THEN 0 ELSE enabled END "
            "WHERE (project_id IS ? OR project_id IS NULL) AND last_hit_at IS NOT NULL AND last_hit_at >= ?",
            (project_id, timeutil.iso(timeutil.now() - timedelta(minutes=15))),
        )
    if with_context and project_id is not None:
        block = inject.prompt_hints(conn, config, project_id, session_id, prompt, event.harness)
        if block:
            response.context = block.text
            learn.record_access(conn, block.owners, "injected", session_id)


def _learn_rule(
    conn: sqlite3.Connection, config: Config, project_id: str | None, avoid: str, prefer: str | None, turn_id: int
) -> None:
    message = f"Use `{prefer}` instead of `{avoid}`" if prefer else f"Avoid `{avoid}`"
    # UPDATE first with ``IS``: a UNIQUE constraint never matches NULL project ids, so an upsert would
    # insert a new row for every correction made outside a project.
    updated = conn.execute(
        "UPDATE rules SET evidence = evidence + 1, message = ? "
        "WHERE project_id IS ? AND kind = 'avoid_command' AND pattern = ?",
        (message, project_id, avoid),
    )
    if updated.rowcount == 0:
        conn.execute(
            "INSERT INTO rules(project_id, kind, pattern, message, evidence, enabled, created_at) "
            "VALUES (?, 'avoid_command', ?, ?, 1, 0, ?)",
            (project_id, avoid, message, timeutil.iso()),
        )
    row = conn.execute(
        "SELECT id, evidence FROM rules WHERE project_id IS ? AND kind = 'avoid_command' AND pattern = ?",
        (project_id, avoid),
    ).fetchone()
    if row is None:
        return
    if row["evidence"] >= config.rules.min_corrections:
        if config.rules.auto_enable:
            conn.execute("UPDATE rules SET enabled = 1 WHERE id = ?", (row["id"],))
        prefix = f"pref|{project_id}|{avoid}|"
        new_id = store.add_memory(
            conn,
            project_id=project_id,
            kind="preference",
            title=message + f" (corrected {row['evidence']}x)",
            body=message,
            source="hook",
            trust="user",
            importance=0.85,
            turn_id=turn_id,
            dedupe=f"{prefix}{row['evidence']}",
        )
        if new_id is not None:
            # One valid preference per correction: the new count supersedes the earlier ones.
            for old in conn.execute(
                "SELECT id, dedupe_key FROM memories WHERE kind = 'preference' AND project_id IS ? "
                "AND invalid_at IS NULL AND id != ?",
                (project_id, new_id),
            ).fetchall():
                if str(old["dedupe_key"] or "").startswith(prefix):
                    store.supersede(conn, int(old["id"]), new_id)


def _matching_rules(conn: sqlite3.Connection, project_id: str | None, command: str) -> list[sqlite3.Row]:
    key = signals.command_key(command) or ""
    program = key.split(" ")[0] if key else ""
    rows = conn.execute(
        "SELECT * FROM rules WHERE (project_id IS ? OR project_id IS NULL) AND kind = 'avoid_command'", (project_id,)
    ).fetchall()
    tokens = set(re.split(r"\s+", command.strip().lower())[:3])
    return [r for r in rows if r["pattern"] in {program, key} or r["pattern"] in tokens]


def _on_pre_tool(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    if not with_context:
        return
    tool_signal = signals.analyze_tool(event.tool or "", event.tool_input)
    lines: list[tuple[str, tuple[str, int] | None]] = []
    if tool_signal.command:
        for rule in _matching_rules(conn, project_id, tool_signal.command):
            conn.execute("UPDATE rules SET hits = hits + 1, last_hit_at = ? WHERE id = ?", (timeutil.iso(), rule["id"]))
            if rule["enabled"]:
                response.deny = (
                    f"agent-mem rule R{rule['id']}: {rule['message']} (you were corrected {rule['evidence']}x)."
                )
                return
            lines.append(
                (f"- Note (R{rule['id']}): earlier correction — {rule['message']} ({rule['evidence']}x).", None)
            )
    if tool_signal.category == "edit" and project_id is not None:
        for path in _rel_files(project, tool_signal.files):
            entity = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND kind = 'file' AND key = ?", (project_id, path)
            ).fetchone()
            if entity is None:
                continue
            for memory in conn.execute(
                "SELECT m.id, m.title, m.created_at FROM memories m JOIN links l ON l.owner_type = 'm' AND l.owner_id = m.id "
                "WHERE l.entity_id = ? AND m.kind = 'dead_end' AND m.invalid_at IS NULL ORDER BY m.id DESC LIMIT 2",
                (entity["id"],),
            ):
                warned = conn.execute(
                    "SELECT 1 FROM accesses WHERE owner_type = 'm' AND owner_id = ? AND kind = 'warned' AND session_id = ?",
                    (memory["id"], session_id),
                ).fetchone()
                if warned:
                    continue
                learn.record_access(conn, [("m", int(memory["id"]))], "warned", session_id)
                lines.append(
                    (
                        f"- Caution [M{memory['id']} · {timeutil.day(memory['created_at'])}]: {memory['title']}",
                        ("m", int(memory["id"])),
                    )
                )
    block = inject.warnings_block(lines, config)
    if block:
        response.context = block.text


def _on_tool(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    tool_signal = signals.analyze_tool(event.tool or "", event.tool_input)
    turn_id = _turn_for_tool(conn, session_id, project_id, event.ts)
    files = _rel_files(project, tool_signal.files)
    error_sig = payload.get("error_sig")
    conn.execute(
        "UPDATE events SET turn_id = ?, command_key = ?, exit_code = ?, error_sig = ?, files_json = ? WHERE id = ?",
        (turn_id, tool_signal.command_key, event.exit_code, error_sig, json.dumps(files), event_id),
    )
    if tool_signal.category in {"edit", "read"}:
        _append_json(conn, turn_id, "files_json", files)
    if tool_signal.command:
        _append_json(conn, turn_id, "commands_json", [privacy.clean_text(tool_signal.command, 200)])
    if payload.get("error_line") and payload.get("trust") != "tool_external":
        _append_json(conn, turn_id, "errors_json", [str(payload["error_line"])[:200]], cap=10)

    importance = signals.IMPORTANCE["read"]
    if tool_signal.category == "edit":
        importance = signals.IMPORTANCE["edit"]
    elif tool_signal.command:
        importance = signals.IMPORTANCE["command"]
    if tool_signal.command_kind == "commit" and not event.tool_failed:
        importance = signals.IMPORTANCE["commit"]
    if event.tool_failed:
        importance = max(importance, signals.IMPORTANCE["error"])
    _raise_importance(conn, turn_id, importance)

    if tool_signal.packages and project_id is not None:
        ids = [store.entity_id(conn, project_id, "package", name) for name in tool_signal.packages]
        store.link(conn, "t", turn_id, ids)

    if event.tool_failed and error_sig and tool_signal.command_key:
        recipe = conn.execute(
            "SELECT * FROM recipes WHERE project_id IS ? AND error_sig = ? ORDER BY command_key = ? DESC, successes DESC LIMIT 1",
            (project_id, error_sig, tool_signal.command_key),
        ).fetchone()
        if recipe is not None:
            conn.execute("UPDATE recipes SET recurrences = recurrences + 1 WHERE id = ?", (recipe["id"],))
            if with_context:
                block = inject.recipe_hint(recipe, config)
                if block:
                    response.context = block.text
    elif not event.tool_failed and tool_signal.command_key:
        _resolve_failures(conn, project_id, session_id, turn_id, tool_signal.command_key, event.ts)
        if (
            tool_signal.command_kind in {"test", "build", "lint", "install"}
            and project_id is not None
            and tool_signal.command
        ):
            conn.execute(
                "INSERT INTO profile(project_id, key, value, count, updated_at) VALUES (?, ?, ?, 1, ?) "
                "ON CONFLICT(project_id, key, value) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at",
                (project_id, f"cmd:{tool_signal.command_kind}", privacy.clean_text(tool_signal.command, 120), event.ts),
            )

    if tool_signal.command_kind == "revert" and not event.tool_failed:
        _record_dead_end(conn, project_id, session_id, turn_id, tool_signal)

    if tool_signal.category == "edit" and files and project_id is not None:
        _feedback_used(conn, project_id, session_id, files)


def _resolve_failures(
    conn: sqlite3.Connection, project_id: str | None, session_id: str, turn_id: int, command_key: str, ts: str
) -> None:
    failures = conn.execute(
        "SELECT id, ts, error_sig, payload FROM events WHERE session_id = ? AND command_key = ? "
        "AND error_sig IS NOT NULL AND resolved = 0 ORDER BY ts",
        (session_id, command_key),
    ).fetchall()
    if not failures:
        return
    first_ts = failures[0]["ts"]
    changed: list[str] = []
    for row in conn.execute(
        "SELECT files_json, payload FROM events WHERE session_id = ? AND kind = 'tool' AND ts >= ? AND ts <= ?",
        (session_id, first_ts, ts),
    ):
        category = json.loads(row["payload"]).get("category")
        if category == "edit":
            for path in json.loads(row["files_json"] or "[]"):
                if path not in changed:
                    changed.append(path)
    for failure in failures:
        error_line = str(json.loads(failure["payload"]).get("error_line") or "")[:300]
        updated = conn.execute(
            "UPDATE recipes SET successes = successes + 1, files_json = ?, last_turn_id = ?, updated_at = ? "
            "WHERE project_id IS ? AND error_sig = ? AND command_key = ?",
            (json.dumps(changed[:10]), turn_id, ts, project_id, failure["error_sig"], command_key),
        )
        if updated.rowcount == 0:
            conn.execute(
                "INSERT INTO recipes(project_id, error_sig, error_text, command_key, files_json, successes, "
                "last_turn_id, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                (project_id, failure["error_sig"], error_line, command_key, json.dumps(changed[:10]), turn_id, ts),
            )
    conn.executemany("UPDATE events SET resolved = 1 WHERE id = ?", [(f["id"],) for f in failures])
    _raise_importance(conn, turn_id, signals.IMPORTANCE["fixed"])


def _record_dead_end(
    conn: sqlite3.Connection, project_id: str | None, session_id: str, turn_id: int, tool_signal: signals.ToolSignal
) -> None:
    edited: list[str] = []
    for row in conn.execute(
        "SELECT files_json, payload FROM events WHERE session_id = ? AND kind = 'tool' ORDER BY id DESC LIMIT 200",
        (session_id,),
    ):
        if json.loads(row["payload"]).get("category") == "edit":
            for path in json.loads(row["files_json"] or "[]"):
                if path not in edited:
                    edited.append(path)
    targets = (
        edited
        if "*" in tool_signal.reverted_files
        else [
            f
            for f in edited
            if any(
                f == r.lstrip("./") or PurePosixPath(f).name == PurePosixPath(r).name
                for r in tool_signal.reverted_files
            )
        ]
    )
    if not targets:
        return
    turn = conn.execute("SELECT prompt FROM turns WHERE id = ?", (turn_id,)).fetchone()
    context = signals.first_line(turn["prompt"], 160) if turn and turn["prompt"] else "earlier work"
    title = f"Changes to {', '.join(targets[:3])} were reverted (`{tool_signal.command_key}`) — context: {context}"
    ids = [store.entity_id(conn, project_id, "file", path) for path in targets[:10]]
    store.add_memory(
        conn,
        project_id=project_id,
        kind="dead_end",
        title=title,
        body=f"Command: {privacy.clean_text(tool_signal.command or '', 300)}\nFiles: {', '.join(targets[:10])}",
        source="hook",
        trust="agent",
        importance=signals.IMPORTANCE["dead_end"],
        turn_id=turn_id,
        entity_ids=ids,
    )
    _raise_importance(conn, turn_id, signals.IMPORTANCE["dead_end"])


def _feedback_used(conn: sqlite3.Connection, project_id: str, session_id: str, files: list[str]) -> None:
    placeholders = ",".join("?" for _ in files)
    entity_ids = [
        row[0]
        for row in conn.execute(
            f"SELECT id FROM entities WHERE project_id = ? AND kind = 'file' AND key IN ({placeholders})",
            (project_id, *files),
        )
    ]
    if not entity_ids:
        return
    id_placeholders = ",".join("?" for _ in entity_ids)
    rows = conn.execute(
        f"SELECT DISTINCT a.owner_type, a.owner_id FROM accesses a JOIN links l "
        f"ON l.owner_type = a.owner_type AND l.owner_id = a.owner_id "
        f"WHERE a.session_id = ? AND a.kind IN ('shown', 'injected') AND l.entity_id IN ({id_placeholders})",
        (session_id, *entity_ids),
    ).fetchall()
    fresh = []
    for row in rows:
        already = conn.execute(
            "SELECT 1 FROM accesses WHERE owner_type = ? AND owner_id = ? AND session_id = ? AND kind = 'used'",
            (row["owner_type"], row["owner_id"], session_id),
        ).fetchone()
        if not already:
            fresh.append((row["owner_type"], int(row["owner_id"])))
    learn.record_access(conn, fresh, "used", session_id)


def _on_stop(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    turn = _open_turn(conn, session_id)
    if turn is None:
        turn = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1", (session_id,)
        ).fetchone()
        if turn is None:
            return
    turn_id = int(turn["id"])
    conn.execute("UPDATE events SET turn_id = ? WHERE id = ?", (turn_id, event_id))
    answer = str(payload.get("answer") or "")
    if answer:
        conn.execute("UPDATE turns SET answer = ? WHERE id = ?", (answer, turn_id))
        _raise_importance(conn, turn_id, signals.IMPORTANCE["answer"] if len(answer) > 200 else 0.3)
        cited = {(kind.lower(), int(number)) for kind, number in _CITED.findall(answer)}
        existing = [o for o in cited if _owner_exists(conn, o)]
        learn.record_access(conn, existing, "cited", session_id)
    if turn["outcome"] == "open":
        _close_turn(conn, turn_id, "ok", event.ts)
    else:
        store.index_turn(conn, turn_id)
    response.wants_indexer = True


def _owner_exists(conn: sqlite3.Connection, owner: tuple[str, int]) -> bool:
    table = "turns" if owner[0] == "t" else "memories"
    return conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (owner[1],)).fetchone() is not None


def _on_subagent_stop(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    turn = _open_turn(conn, session_id)
    if turn is not None:
        conn.execute("UPDATE events SET turn_id = ? WHERE id = ?", (turn["id"], event_id))


def _on_compact(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    turn = _open_turn(conn, session_id)
    if turn is not None:
        conn.execute("UPDATE events SET turn_id = ? WHERE id = ?", (turn["id"], event_id))
    if with_context:
        # Harnesses that accept context before compaction (OpenCode) keep the essentials in the summary.
        block = inject.compact(conn, config, session_id)
        if block:
            response.context = block.text


def _on_session_end(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    turn = _open_turn(conn, session_id)
    if turn is not None:
        _close_turn(conn, int(turn["id"]), "ok" if turn["answer"] else "unknown", event.ts)
    conn.execute("UPDATE sessions SET ended_at = ? WHERE id = ?", (event.ts, session_id))
    response.wants_indexer = True


def close_stale_turns(conn: sqlite3.Connection, config: Config) -> int:
    """Close turns without activity (crash, missing Stop). Called by the indexer."""
    cutoff_hours = config.retention.stale_turn_minutes / 60.0
    closed = 0
    for turn in conn.execute(
        "SELECT t.id, s.last_event_at FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.outcome = 'open'"
    ).fetchall():
        if timeutil.hours_between(turn["last_event_at"]) >= cutoff_hours:
            with db.transaction(conn):
                _close_turn(conn, int(turn["id"]), "unknown", turn["last_event_at"])
            closed += 1
    return closed
