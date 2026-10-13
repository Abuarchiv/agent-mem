"""Apply a normalized event to the database: sessions, turns, signals, recipes, rules, context.

This is the write path for every event: live hooks, spool replay and transcript
imports. It is idempotent per event (dedupe key) and standard library only.
Memories from other sources (MCP, the observer) go
through ``store.add_memory``, which cleans them the same way.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath

from agent_mem.core import db, identity, privacy, signals, timeutil
from agent_mem.core.config import Config, env_flag, load_project_settings
from agent_mem.core.events import Event
from agent_mem.hooks import inject
from agent_mem.memory import learn, store

_CITED = re.compile(r"\b([TM])(\d{1,9})\b")
_OVERRIDE = re.compile(r"(?i)\b(trotzdem|egal|ignore (the|that) rule|anyway|do it anyway|mach es trotzdem)\b")


@dataclass
class Response:
    context: str | None = None
    deny: str | None = None
    wants_indexer: bool = False
    stored: bool = False


def _reusable(command: str, kind: str) -> bool:
    """A command worth suggesting again: one short line whose program itself does the job.

    `grep … tests/` or a heredoc script mention a test but are not the project's test command.
    """
    key = signals.command_key(command)
    return "\n" not in command and len(command) <= 100 and key is not None and signals.command_kind(key) == kind


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


CORRECTION_CHARS = 400
# The harnesses run their own background agents (Codex memory consolidation, for one) inside these folders.
HARNESS_HOMES = (".codex", ".claude", ".copilot", ".config/opencode")


def _harness_home(root: str) -> bool:
    home = os.path.expanduser("~")
    return any(identity.is_within(root, os.path.join(home, folder)) for folder in HARNESS_HOMES)


def capture_allowed(conn: sqlite3.Connection, config: Config, project: identity.Project | None) -> bool:
    if not config.capture or env_flag("AGENT_MEM_DISABLE"):
        return False
    paused = db.get_meta(conn, "paused_until")
    if paused and (paused == "forever" or (timeutil.parse(paused) or timeutil.now()) > timeutil.now()):
        return False
    if project is not None:
        if _harness_home(str(project.root)):
            return False
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
    config = inject.for_host(config, event.harness, event.kind)
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
    elif response.context:
        _count_injection(conn, event.ts, inject.tokens(response.context))
    return response


def _count_injection(conn: sqlite3.Connection, ts: str, tokens: int) -> None:
    """Per day: blocks and estimated tokens injected (`agent-mem status`)."""
    key = f"injected:{timeutil.day(ts)}"
    blocks, total = (int(x) for x in (db.get_meta(conn, key) or "0,0").split(","))
    db.set_meta(conn, key, f"{blocks + 1},{total + tokens}")


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


def _close_turn(conn: sqlite3.Connection, config: Config, turn_id: int, outcome: str, ts: str) -> None:
    unresolved = conn.execute(
        "SELECT COUNT(*) FROM events WHERE turn_id = ? AND error_sig IS NOT NULL AND resolved = 0", (turn_id,)
    ).fetchone()[0]
    final = "error" if outcome == "ok" and unresolved else outcome
    conn.execute("UPDATE turns SET outcome = ?, ended_at = ? WHERE id = ?", (final, ts, turn_id))
    store.index_turn(conn, turn_id)
    # Same transaction as the close: the observer worker picks it up later (docs/PLAN.md §4.2). With the observer
    # off nothing is queued: switched on again, it would send turns captured while model calls were off.
    if not config.observe.enabled:
        return
    with contextlib.suppress(sqlite3.OperationalError):  # a database without the observer tables still captures
        conn.execute(
            "INSERT OR IGNORE INTO observe_queue(turn_id, state, next_try, updated_at) VALUES (?, 'pending', ?, ?)",
            (turn_id, ts, ts),
        )


def _turn_at(conn: sqlite3.Connection, session_id: str, ts: str) -> sqlite3.Row | None:
    """The turn an event belongs to by its time. Live, that is the open turn; replayed from the spool after the next
    prompt already arrived, it is the earlier turn the event happened in, not the one open now."""
    return conn.execute(
        "SELECT * FROM turns WHERE session_id = ? AND started_at <= ? ORDER BY started_at DESC, id DESC LIMIT 1",
        (session_id, ts),
    ).fetchone()


def _turn_for_tool(conn: sqlite3.Connection, session_id: str, project_id: str | None, ts: str) -> int:
    turn = _open_turn(conn, session_id)
    if turn is None:
        # No open turn (its prompt may still be in the spool): a turn of its own, never the finished one before it.
        return _new_turn(conn, session_id, project_id, ts, "")
    if turn["started_at"] <= ts:
        return int(turn["id"])
    earlier = _turn_at(conn, session_id, ts)  # replayed after a later prompt opened the current turn
    return int(earlier["id"] if earlier is not None else turn["id"])


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


def _narrow_turn(conn: sqlite3.Connection, turn_id: int, project: identity.Project) -> None:
    """A turn asked in a parent folder belongs to the nested project its tools work in (``cd agent-mem && …``),
    so its facts land where a session in that project finds them."""
    row = conn.execute(
        "SELECT t.project_id, p.root FROM turns t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?",
        (turn_id,),
    ).fetchone()
    if row is None or row["project_id"] == project.id:
        return
    if row["root"] is None or identity.is_within(project.root, row["root"]):
        conn.execute("UPDATE turns SET project_id = ? WHERE id = ?", (project.id, turn_id))
        # The session follows: started in ~/Lernen, it is an agent-mem session once it works there.
        conn.execute(
            "UPDATE sessions SET project_id = ? WHERE id = (SELECT session_id FROM turns WHERE id = ?) "
            "AND project_id IS ?",
            (project.id, turn_id, row["project_id"]),
        )


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
    # A prompt replayed from the spool after a later one must not close that later turn, which is still running.
    if previous is not None and previous["started_at"] <= event.ts:
        _close_turn(conn, config, int(previous["id"]), "unknown", event.ts)
    last = conn.execute(
        "SELECT id, prompt, commands_json FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1", (session_id,)
    ).fetchone()
    turn_id = _new_turn(conn, session_id, project_id, event.ts, prompt)
    conn.execute("UPDATE events SET turn_id = ? WHERE id = ?", (turn_id, event_id))

    typed = not signals.from_harness(prompt)
    corrective = typed and (signals.is_correction(prompt) or signals.mentions_rule(prompt))
    if typed and not corrective:
        # "X statt Y" / "use X instead of Y" is an explicit preference even without a correction.
        for avoid, prefer in signals.preference_pairs(prompt):
            if prefer is not None:
                store.learn_rule(conn, config, project_id, avoid, prefer, turn_id)
    # With a working observer the model reads the turn and writes corrections and decisions as facts;
    # the patterns then only raise the turn's importance (B.24: regex corrections caught complaints too).
    observed = _observer_active(conn, config)
    # A long spoken prompt is not a correction one can apply later; the turn itself stays searchable.
    if corrective and not observed and len(prompt) <= CORRECTION_CHARS:
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
    if corrective:
        _raise_importance(conn, turn_id, signals.IMPORTANCE["correction"])
        for avoid, prefer in signals.preference_pairs(prompt):
            # A bare "nicht X" is too loose to become a rule when the observer can write the rule itself.
            if prefer is not None or not observed:
                store.learn_rule(conn, config, project_id, avoid, prefer, turn_id)
    for sentence in [] if observed or not typed else signals.decision_sentences(prompt):
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


def _observer_active(conn: sqlite3.Connection, config: Config) -> bool:
    """True when the observer extracted facts in the last seven days."""
    if not config.observe.enabled:
        return False
    since = timeutil.iso(timeutil.now() - timedelta(days=7))
    with contextlib.suppress(sqlite3.OperationalError):  # database from before migration 002
        row = conn.execute(
            "SELECT 1 FROM observe_calls WHERE purpose = 'extract' AND ok = 1 AND ts >= ? LIMIT 1", (since,)
        ).fetchone()
        return row is not None
    return False


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
    block = inject.warnings_block(lines, config)
    history = _file_history(conn, config, project, project_id, session_id, tool_signal)
    response.context = "\n".join(b.text for b in (block, history) if b) or None


# Kind, label and weight in the file history: what went wrong before matters most when touching a file.
_HISTORY = {"dead_end": ("Caution", 3), "decision": ("Decision", 2), "lesson": ("Lesson", 2), "fact": ("Note", 1)}
# Below this size reading the file costs about what its history would (claude-mem File Read Gate, measured).
HISTORY_MIN_BYTES = 1_500


def _file_history(conn, config, project, project_id, session_id, tool_signal) -> inject.Block | None:
    """Memories linked to the files a tool reads or edits, once per session each.

    Specific ones first (the file was one of few the memory names), dead ends before decisions before facts.
    A fact older than the file's last change may describe code that is gone, so it is left out; dead ends,
    decisions and lessons stay true after an edit.
    """
    reading = tool_signal.category in {"read", "shell"}
    if project_id is None or project is None or not tool_signal.files:
        return None
    if tool_signal.category not in {"read", "edit", "shell"}:
        return None
    lines: list[tuple[str, tuple[str, int] | None]] = []
    for path in _rel_files(project, tool_signal.files)[:3]:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = ? AND kind = 'file' AND key = ?", (project_id, path)
        ).fetchone()
        if entity is None:
            continue
        try:
            stat = os.stat(os.path.join(project.root, path))
        except OSError:
            stat = None
        if reading and (stat is None or stat.st_size < HISTORY_MIN_BYTES):
            continue
        changed = timeutil.iso(datetime.fromtimestamp(stat.st_mtime, UTC)) if stat else None
        ranked = []
        for row in conn.execute(
            "SELECT m.id, m.kind, m.title, m.created_at, (SELECT count(*) FROM links l2 JOIN entities e2 "
            "ON e2.id = l2.entity_id AND e2.kind = 'file' WHERE l2.owner_type = 'm' AND l2.owner_id = m.id) AS spread "
            "FROM memories m JOIN links l ON l.owner_type = 'm' AND l.owner_id = m.id "
            "WHERE l.entity_id = ? AND m.invalid_at IS NULL AND m.kind IN ('dead_end', 'decision', 'lesson', 'fact') "
            "AND NOT EXISTS (SELECT 1 FROM accesses a WHERE a.owner_type = 'm' AND a.owner_id = m.id "
            "AND a.session_id = ? AND a.kind IN ('shown', 'injected', 'warned')) ORDER BY m.id DESC LIMIT 40",
            (entity["id"], session_id),
        ):
            if row["kind"] == "fact" and changed and row["created_at"] < changed:
                continue
            spread = int(row["spread"])
            weight = _HISTORY[row["kind"]][1] + (2 if spread <= 3 else 1 if spread <= 8 else 0)
            ranked.append((weight, int(row["id"]), row))
        for _, memory_id, row in sorted(ranked, key=lambda item: (-item[0], -item[1]))[:3]:
            label = _HISTORY[row["kind"]][0]
            lines.append(
                (
                    f"- {label} [M{memory_id} · {timeutil.day(row['created_at'])}] {path}: {row['title']}",
                    ("m", memory_id),
                )
            )
    block = inject.file_history_block(lines, config)
    if block:
        kind = "warned" if not reading else "shown"
        learn.record_access(conn, block.owners, kind, session_id)
    return block


def _on_tool(conn, config, event, project, project_id, session_id, event_id, payload, response, with_context):
    tool_signal = signals.analyze_tool(event.tool or "", event.tool_input)
    turn_id = _turn_for_tool(conn, session_id, project_id, event.ts)
    if project is not None:
        _narrow_turn(conn, turn_id, project)
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

    # Error-to-fix recipes only for the project's own commands: a failed `cat` or `cd` followed by one that worked
    # is looking around, not a fix worth repeating (17 of 17 recipes on real data were such noise).
    project_command = tool_signal.command_kind in {"test", "build", "lint", "install"}
    if event.tool_failed and error_sig and tool_signal.command_key and project_command:
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
        if project_command:
            _resolve_failures(conn, project_id, session_id, turn_id, tool_signal.command_key, event.ts)
        if (
            tool_signal.command_kind in {"test", "build", "lint", "install"}
            and project_id is not None
            and tool_signal.command
            and _reusable(tool_signal.command, tool_signal.command_kind)
        ):
            conn.execute(
                "INSERT INTO profile(project_id, key, value, count, updated_at) VALUES (?, ?, ?, 1, ?) "
                "ON CONFLICT(project_id, key, value) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at",
                (project_id, f"cmd:{tool_signal.command_kind}", privacy.clean_text(tool_signal.command, 120), event.ts),
            )

    if tool_signal.command_kind == "revert" and not event.tool_failed:
        _record_dead_end(conn, project_id, session_id, turn_id, tool_signal)
        store.guards_exist(config)

    if tool_signal.category == "edit" and files and project_id is not None:
        _feedback_used(conn, project_id, session_id, files)

    # Copilot does not fire plugin preToolUse hooks (copilot-cli#2540); after the call is the next chance.
    if with_context and not response.context:
        history = _file_history(conn, config, project, project_id, session_id, tool_signal)
        if history:
            response.context = history.text


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
        # A non-zero exit without an error line (grep without a match) is not an error that was fixed.
        if updated.rowcount == 0 and signals.looks_like_error(error_line) and signals.fixable(command_key):
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
    context = (
        signals.first_line(signals.request_text(turn["prompt"]), 160) if turn and turn["prompt"] else "earlier work"
    )
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
    turn = _turn_at(conn, session_id, event.ts)
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
        _close_turn(conn, config, turn_id, "ok", event.ts)
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
        _close_turn(conn, config, int(turn["id"]), "ok" if turn["answer"] else "unknown", event.ts)
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
                _close_turn(conn, config, int(turn["id"]), "unknown", turn["last_event_at"])
            closed += 1
    return closed
