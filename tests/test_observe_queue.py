"""Queue, bundle and provider chain: standard library only, run in CI."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.hooks import hook


def _payload(project: Path, session: str, **fields: object) -> str:
    return json.dumps({"session_id": session, "cwd": str(project), **fields})


def _turn(config: Config, project: Path, session: str, prompt: str, answer: str, harness: str = "claude") -> None:
    hook.run(harness, None, _payload(project, session, hook_event_name="UserPromptSubmit", prompt=prompt), config)
    hook.run(harness, None, _payload(project, session, hook_event_name="Stop", last_assistant_message=answer), config)


def test_migration_002_applies_to_existing_v1_database(config: Config) -> None:
    conn = db.connect(config)
    conn.execute("PRAGMA user_version = 1")
    for table in ("observe_queue", "observe_calls", "observe_forget"):
        conn.execute(f"DROP TABLE {table}")
    for table, column in (("turns", "title"), ("turns", "type"), ("sessions", "title"), ("sessions", "summary_json")):
        conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")  # added by migration 003
    conn.close()
    conn = db.connect(config)
    assert db.user_version(conn) == db.SCHEMA_VERSION >= 2
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"observe_queue", "observe_calls", "observe_forget"} <= names
    conn.close()


def test_turn_close_enqueues_and_hook_path_stays_stdlib(config: Config, project: Path) -> None:
    _turn(config, project, "s1", "Wir nutzen uv.", "ok")
    conn = db.connect(config)
    row = conn.execute("SELECT state, attempts FROM observe_queue").fetchone()
    assert (row["state"], row["attempts"]) == ("pending", 0)
    conn.close()


def test_lease_bundle_groups_same_session_and_backs_off(config: Config, project: Path) -> None:
    from agent_mem.observe import queue

    _turn(config, project, "s1", "eins", "a")
    _turn(config, project, "s1", "zwei", "b")
    _turn(config, project, "s2", "drei", "c")
    conn = db.connect(config)
    rows = queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
    assert [r["session_id"].endswith("s1") for r in rows] == [True, True]
    assert queue.lease_bundle(conn, max_turns=5, lease_seconds=60)[0]["session_id"].endswith("s2")
    turn_ids = [int(r["turn_id"]) for r in rows]
    queue.fail(conn, turn_ids, "claude exit 1: boom")
    row = conn.execute(
        "SELECT state, attempts, next_try, last_error FROM observe_queue WHERE turn_id = ?", (turn_ids[0],)
    ).fetchone()
    assert row["state"] == "pending" and row["attempts"] == 1 and row["next_try"] > row["last_error"][:0]
    assert queue.status(conn)["queue"]["pending"] == 2  # both failed turns wait for their backoff
    assert not queue.lease_bundle(conn, max_turns=5, lease_seconds=60)  # nothing due yet
    for _ in range(queue.MAX_ATTEMPTS):
        conn.execute(
            "UPDATE observe_queue SET next_try = '2000-01-01T00:00:00Z' WHERE turn_id IN (?, ?)", tuple(turn_ids)
        )
        queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
        queue.fail(conn, turn_ids, "still failing")
    assert (
        conn.execute("SELECT state FROM observe_queue WHERE turn_id = ?", (turn_ids[0],)).fetchone()["state"]
        == "failed"
    )
    assert queue.retry_failed(conn) == 2
    conn.close()


def test_bundle_respects_token_cap_and_excludes_tool_output(config: Config, project: Path) -> None:
    from agent_mem.observe import bundle, queue

    config.observe.bundle_tokens = 100  # 400 characters
    _turn(config, project, "s1", "x" * 300, "y" * 300)
    _turn(config, project, "s1", "kurz", "knapp")
    conn = db.connect(config)
    rows = queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
    bundles = bundle.build(conn, config, [int(r["turn_id"]) for r in rows])
    assert len(bundles) == 2  # the oversized turn is truncated and stands alone
    assert bundles[0].chars <= 400
    assert bundles[1].messages[0]["content"] == "kurz"
    assert all(b.harness == "claude" for b in bundles)
    conn.close()


def test_chain_is_vendor_faithful_by_default(config: Config, monkeypatch) -> None:
    from agent_mem.observe import providers

    monkeypatch.setattr(providers, "available", lambda name: True)
    conn = db.connect(config)
    assert providers.chain(config, "claude", conn) == ["claude"]
    assert providers.chain(config, "codex", conn) == ["codex"]
    assert providers.chain(config, "opencode", conn) == []  # raw stage unless ollama is opted in
    config.observe.providers.append("ollama")
    assert providers.chain(config, "opencode", conn) == ["ollama"]
    config.observe.cross_vendor = True
    assert providers.chain(config, "claude", conn) == ["claude", "codex", "copilot", "ollama"]
    providers.note_failure(conn, config, "claude", providers.ProviderError("claude exit 1: usage limit reached"))
    assert "claude" not in providers.chain(config, "claude", conn)
    assert providers.ProviderError("Not logged in").kind == "login"
    assert providers.ProviderError("claude: timeout after 120s").kind == "timeout"
    conn.close()


def test_only_installed_cli_handles_its_own_turns(config: Config, monkeypatch) -> None:
    from agent_mem.observe import providers

    monkeypatch.setattr(providers, "available", lambda name: name == "codex")
    conn = db.connect(config)
    assert providers.chain(config, "codex", conn) == ["codex"]
    assert providers.chain(config, "claude", conn) == []  # raw, the Claude turn never goes to OpenAI
    assert providers.chain(config, "copilot", conn) == []
    conn.close()


def test_cheapest_model_falls_back_to_cli_default(monkeypatch) -> None:
    from agent_mem.observe import providers

    calls: list[list[str]] = []

    def run(cmd: list[str], prompt: str, extra_env: dict[str, str] | None = None) -> str:
        calls.append(cmd)
        if "--model" in cmd and "auto" not in cmd:
            raise providers.ProviderError(
                'copilot exit 1: Error: Model "gpt-6-luna" from --model flag is not available.'
            )
        return "ok"

    monkeypatch.setattr(providers, "_run", run)
    msgs = [{"role": "user", "content": "x"}]
    assert providers.make_llm("copilot", "auto").generate_response(msgs) == "ok"
    copilot = ["copilot", "-s", "--no-custom-instructions", "--disable-builtin-mcps"]
    assert calls[-1] == [*copilot, "--model", "auto", "--auto-tier", "efficiency"]
    assert providers.make_llm("copilot", "gpt-6-luna").generate_response(msgs) == "ok"
    assert calls[-2:] == [[*copilot, "--model", "gpt-6-luna"], copilot]
    codex_error = (
        "codex exit 1: ...\nERROR: The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."
    )
    assert providers._NO_MODEL.search(codex_error)
    assert not providers._NO_MODEL.search("claude exit 1: usage limit reached")
    assert providers._NO_MODEL.search("copilot exit 2: error: unexpected argument '--auto-tier' found")


def test_spawn_observer_is_throttled_and_respects_no_spawn(config: Config, monkeypatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(hook, "_spawn", lambda argv, cfg: calls.append(argv) or True)
    monkeypatch.delenv("AGENT_MEM_NO_SPAWN", raising=False)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    assert hook.spawn_observer(config) is True
    assert hook.spawn_observer(config) is False  # marker younger than the throttle
    assert calls and calls[0][-3:] == ["observe", "--drain", "--quiet"]
    monkeypatch.setenv("AGENT_MEM_NO_SPAWN", "1")
    (config.data_dir / ".observer-spawned").unlink()
    assert hook.spawn_observer(config) is False


def test_worker_without_embedder_stores_raw(config: Config, monkeypatch) -> None:
    """No semantic extra, no mem0 index: the stage chain collapses to raw instead of failing forever."""
    from agent_mem.observe import bundle, providers, worker

    monkeypatch.setattr(providers, "available", lambda name: True)
    conn = db.connect(config)
    w = worker.Worker(config, conn)

    def boom(self):
        raise RuntimeError("no embedder available")

    monkeypatch.setattr(worker.Worker, "adapter", property(boom))
    b = bundle.Bundle(
        turn_ids=[1], session_id="s", project_id=None, harness="claude", messages=[{"role": "user", "content": "x"}]
    )
    assert w.process(b) == "raw"
    # The fallback is no longer silent: the next session start tells the user.
    assert any("facts unavailable" in line for line in hook.problems(conn))
    conn.close()


def test_aborted_worker_is_reported_at_session_start(config: Config, monkeypatch) -> None:
    import pytest

    from agent_mem.observe import worker

    def crash(self, drain=True):
        raise ValueError("bad state")

    monkeypatch.setattr(worker.Worker, "run", crash)
    with pytest.raises(ValueError):
        worker.run(config)
    conn = db.connect(config)
    assert any("worker aborted: ValueError: bad state" in line for line in hook.problems(conn))
    conn.close()


def test_doctor_and_capture_survive_a_database_without_observer_tables(config: Config, project: Path) -> None:
    """A database whose version says current but lacks the observer tables (foreign lineage) must not crash."""
    from agent_mem.cli import health

    conn = db.connect(config)
    conn.execute("DROP TABLE observe_queue")
    conn.commit()
    conn.close()
    hook.run(
        "claude",
        None,
        json.dumps({"session_id": "s", "cwd": str(project), "hook_event_name": "UserPromptSubmit", "prompt": "hi"}),
        config,
    )
    hook.run(
        "claude",
        None,
        json.dumps({"session_id": "s", "cwd": str(project), "hook_event_name": "Stop", "last_assistant_message": "ok"}),
        config,
    )
    conn = db.connect(config)
    assert conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0] == 1
    conn.close()
    checks = health.doctor(config)
    bad = [c for c in checks if c.name == "facts queue"]
    assert bad and not bad[0].ok and "facts tables" in bad[0].detail


def test_subagent_answer_enters_the_bundle(config: Config, project: Path) -> None:
    from agent_mem.observe import bundle, queue

    hook.run(
        "claude",
        None,
        _payload(project, "s1", hook_event_name="UserPromptSubmit", prompt="Wo liegt die Retry-Logik?"),
        config,
    )
    stop = {"hook_event_name": "SubagentStop", "last_assistant_message": "Retries live in http/retry.py, max 5."}
    hook.run("claude", None, _payload(project, "s1", **stop), config)
    hook.run(
        "claude", None, _payload(project, "s1", hook_event_name="Stop", last_assistant_message="Gefunden."), config
    )
    conn = db.connect(config)
    rows = queue.lease_bundle(conn, max_turns=5, lease_seconds=60)
    text = bundle.build(conn, config, [int(r["turn_id"]) for r in rows])[0].messages[-1]["content"]
    assert "subagent: Retries live in http/retry.py, max 5." in text
    conn.close()


def test_observer_writes_corrections_the_hook_only_marks_them(config: Config, project: Path) -> None:
    conn = db.connect(config)
    _turn(config, project, "s1", "nein, falsch: nutze pnpm statt npm", "ok")
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'correction'").fetchone()[0] == 1
    conn.execute(
        "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
        "VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'claude', 'extract', 1.0, 1, 10, '[]')"
    )
    conn.commit()
    _turn(config, project, "s1", "nein, immer noch falsch: nutze uv statt pip. Wir verwenden ab jetzt ruff.", "ok")
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE kind IN ('correction', 'decision')").fetchone()[0] == 1
    assert {r[0] for r in conn.execute("SELECT pattern FROM rules")} == {"npm", "pip"}
    _turn(config, project, "s1", "nein, keine lokalen Modelle", "ok")  # bare "keine X" stays with the observer
    assert {r[0] for r in conn.execute("SELECT pattern FROM rules")} == {"npm", "pip"}
    conn.close()


def test_claude_reports_its_failures_on_stdout_and_they_are_classified(monkeypatch) -> None:
    """`claude -p` prints the readable error on stdout; stderr carries only a tag."""
    import sys

    from agent_mem.observe import providers

    script = (
        "import sys; sys.stdin.read(); "
        'print("There\'s an issue with the selected model (x). It may not exist or you may not have access to it."); '
        'print(\'[claude-code:unrecognized_model] {"model":"x"}\', file=sys.stderr); sys.exit(1)'
    )
    with pytest.raises(providers.ProviderError) as caught:
        providers._run([sys.executable, "-c", script], "prompt")
    assert providers._NO_MODEL.search(str(caught.value))

    limit = 'import sys; sys.stdin.read(); print("You\'ve hit your limit · resets 5pm"); sys.exit(1)'
    with pytest.raises(providers.ProviderError) as caught:
        providers._run([sys.executable, "-c", limit], "prompt")
    assert caught.value.kind == "quota"


def test_error_lines_win_over_echoed_prompt_text() -> None:
    """codex echoes the prompt into stderr; a turn mentioning quotas must not pause the stage."""
    from agent_mem.observe import providers

    stderr = "user please check the quota code and the login flow\nERROR: stream disconnected before completion"
    assert providers._error_text("", stderr) == "ERROR: stream disconnected before completion"
    assert providers.ProviderError(providers._error_text("", stderr)).kind == "other"


def test_a_too_long_prompt_is_not_a_quota_pause() -> None:
    from agent_mem.observe import providers

    assert providers.classify("claude exit 1: maximum context length exceeded") == "other"
    assert providers.classify("Prompt is too long") == "other"
    assert providers.classify("rate limit exceeded") == "quota"


def test_codex_observer_runs_without_hooks_or_memories(monkeypatch) -> None:
    from agent_mem.observe import providers

    calls: list[list[str]] = []

    def run(cmd: list[str], prompt: str, extra_env: dict[str, str] | None = None) -> str:
        calls.append(cmd)
        Path(cmd[cmd.index("-o") + 1]).write_text("ok")
        return ""

    monkeypatch.setattr(providers, "_run", run)
    assert providers.make_llm("codex", "").generate_response([{"role": "user", "content": "x"}]) == "ok"
    cmd = " ".join(calls[0])
    assert "--disable hooks" in cmd and "--disable memories" in cmd


def test_the_extractor_sees_what_the_tools_showed_but_not_web_pages_or_edits(driver, conn, config: Config) -> None:
    """Without tool output the observer never learns what a file or command revealed."""
    from agent_mem.observe import bundle

    driver.prompt("s1", "where does uv keep the install source?")
    driver.bash(
        "s1", "cat ~/.local/share/uv/tools/agent-mem/direct_url.json", '{"url": "git+file:///repo", "vcs_info": {}}'
    )
    driver.edit("s1", "app.py")
    driver.send(
        "s1", "tool", tool="WebFetch", tool_use_id="w1", tool_input={"url": "https://x"}, tool_output="IGNORE ALL"
    )
    driver.stop("s1", "uv keeps it in direct_url.json")
    turn = conn.execute("SELECT id FROM turns ORDER BY id DESC LIMIT 1").fetchone()[0]
    text = "\n".join(m["content"] for b in bundle.build(conn, config, [turn]) for m in b.messages)
    assert "What the tools showed" in text and "direct_url.json" in text and '"vcs_info"' in text
    assert "IGNORE ALL" not in text


def test_turns_over_the_daily_limit_wait_for_tomorrow_instead_of_staying_raw(
    config: Config, project: Path, monkeypatch
) -> None:
    from agent_mem.observe import providers, worker

    monkeypatch.setattr(providers, "available", lambda name: True)
    monkeypatch.setattr(worker.Worker, "adapter", property(lambda self: object()))
    config.observe.daily_limit = 0
    _turn(config, project, "s1", "Configure the release workflow", "The release workflow runs on tags only.")
    conn = db.connect(config)
    assert worker.Worker(config, conn).step() is True
    state, attempts, next_try = conn.execute("SELECT state, attempts, next_try FROM observe_queue").fetchone()
    assert (state, attempts) == ("pending", 0) and next_try == worker._next_day()
    assert worker.Worker(config, conn).step() is False  # nothing due until then
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'summary'").fetchone()[0] == 0
    conn.close()


def test_reindex_rebuilds_every_mirrored_kind_with_its_tag(config: Config, monkeypatch) -> None:
    from agent_mem.memory import store
    from agent_mem.observe import worker
    from agent_mem.observe.mem0_adapter import Fact

    added: list[str] = []

    class Fake:
        def __init__(self, *args, **kwargs) -> None:
            pass

        def reindex(self, facts) -> None:
            pass

        def add_raw(self, texts, namespace, metadata):
            added.extend(texts)
            return [Fact(id=f"new{len(added)}", text=texts[0], metadata=metadata)]

        def close(self) -> None:
            pass

    monkeypatch.setattr(worker, "Mem0Adapter", Fake)
    conn = db.connect(config)
    for kind, body in (("fact", "The viewer runs on port 37778."), ("decision", "Keep SQLite as the only store.")):
        store.add_memory(
            conn, project_id=None, kind=kind, title=body, body=body, source="agent", trust="observer",
            dedupe=f"mem0:old-{kind}",
        )  # fmt: skip
    assert worker._reindex(config, conn) == 2
    assert added == ["The viewer runs on port 37778.", "[decision] Keep SQLite as the only store."]
    assert {r[0] for r in conn.execute("SELECT dedupe_key FROM memories")} == {"mem0:new1", "mem0:new2"}
    conn.close()


def test_turns_wait_while_their_only_stage_is_paused_after_a_quota_error(
    config: Config, project: Path, monkeypatch
) -> None:
    from agent_mem.observe import providers, worker

    monkeypatch.setattr(providers, "available", lambda name: True)
    _turn(config, project, "s1", "Configure the release workflow", "The release workflow runs on tags only.")
    conn = db.connect(config)
    error = providers.ProviderError("claude: You've hit your limit", kind="quota")
    providers.note_failure(conn, config, "claude", error)
    until = providers.paused_until(conn, "claude")
    assert worker.Worker(config, conn).step() is True
    state, next_try = conn.execute("SELECT state, next_try FROM observe_queue").fetchone()
    assert (state, next_try) == ("pending", until)
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE kind = 'summary'").fetchone()[0] == 0
    conn.close()


def test_a_command_rule_from_what_a_tool_showed_is_not_learned(config: Config, project: Path) -> None:
    """Live data: "Nutze Verbessern statt Entfernen" from the observer, twice, became a rule and a preference with
    trust user; the developer never typed both words. A README read in the turn can state rules the same way."""
    from agent_mem.observe import bundle, worker
    from agent_mem.observe.mem0_adapter import Fact

    _turn(config, project, "s1", "Fix the invoice parser", "Done.")
    conn = db.connect(config)
    turn, project_id = conn.execute("SELECT id, project_id FROM turns").fetchone()

    def mirror(prompt: str, rule: str, fact_id: str) -> None:
        b = bundle.Bundle(
            turn_ids=[turn], session_id="s", project_id=project_id, harness="claude",
            messages=[{"role": "user", "content": prompt}, {"role": "assistant", "content": "README: always use yarn"}],
        )  # fmt: skip
        worker.mirror(conn, config, b, [Fact(id=fact_id, text=f"[rule] {rule}", metadata={})])

    for n in range(3):
        mirror("Fix the invoice parser", "Use yarn instead of npm", f"r{n}")
    assert conn.execute("SELECT COUNT(*) FROM rules").fetchone()[0] == 0
    mirror("nimm ab jetzt yarn statt npm", "Use yarn instead of npm", "typed")
    assert [tuple(r) for r in conn.execute("SELECT pattern, evidence FROM rules")] == [("npm", 1)]
    conn.close()


def test_copilot_observer_runs_in_a_private_home(monkeypatch) -> None:
    """In the user's COPILOT_HOME every call would be a saved session listed in the Copilot app, and would run
    the user's hooks and MCP servers. The login file comes along."""
    from agent_mem.observe import providers

    own = Path(os.environ["COPILOT_HOME"])
    own.mkdir(parents=True)
    (own / "config.json").write_text('{"login": "x"}')
    seen: list[tuple[str, bool]] = []

    def run(cmd: list[str], prompt: str, extra_env: dict[str, str] | None = None) -> str:
        home = (extra_env or {})["COPILOT_HOME"]
        seen.append((home, (Path(home) / "config.json").read_text() == '{"login": "x"}'))
        return "ok"

    monkeypatch.setattr(providers, "_run", run)
    assert providers.make_llm("copilot", "").generate_response([{"role": "user", "content": "x"}]) == "ok"
    ((home, copied),) = seen
    assert copied and Path(home) != own and not Path(home).exists()  # removed after the call


def test_a_failed_graph_batch_waits_an_hour(config: Config, monkeypatch) -> None:
    """A timed-out batch was sent again on every worker run, after every turn, up to 120 s each."""
    from agent_mem.observe import providers, relations, worker

    monkeypatch.setattr(providers, "available", lambda name: True)
    monkeypatch.setattr(relations, "pending", lambda conn: [("p1", [])])
    calls = []

    def timeout(*args, **kwargs):
        calls.append(1)
        raise providers.ProviderError("claude: timeout after 120s")

    monkeypatch.setattr(relations, "extract", timeout)
    conn = db.connect(config)
    w = worker.Worker(config, conn)
    for _ in range(3):
        w.graph_due()
    assert len(calls) == 1
    conn.close()


def test_one_statement_counts_once_although_hook_and_observer_both_read_it(config: Config, project: Path) -> None:
    """Real Copilot session: "Use uv instead of pip" typed once became "(corrected 2x)" and a preference for every
    session, because the prompt hook and then the observer each counted the same turn."""
    from agent_mem.observe import bundle, worker
    from agent_mem.observe.mem0_adapter import Fact

    prompt = "Run the tests. Use uv instead of pip if you need to install anything."
    _turn(config, project, "s1", prompt, "Done.")
    conn = db.connect(config)
    turn, project_id = conn.execute("SELECT id, project_id FROM turns").fetchone()
    b = bundle.Bundle(turn_ids=[turn], session_id="s1", project_id=project_id, harness="claude",
                      messages=[{"role": "user", "content": prompt}])  # fmt: skip
    for attempt in range(2):  # the observer also retries a bundle after an error
        worker.mirror(conn, config, b, [Fact(id=f"p{attempt}", text="[rule] Use uv instead of pip", metadata={})])
    assert [tuple(r) for r in conn.execute("SELECT pattern, evidence FROM rules")] == [("pip", 1)]
    assert (
        conn.execute("SELECT COUNT(*) FROM memories WHERE source = 'hook' AND kind = 'preference'").fetchone()[0] == 0
    )
    conn.close()
    _turn(config, project, "s2", "Again: use uv instead of pip.", "Done.")
    conn = db.connect(config)
    assert [tuple(r) for r in conn.execute("SELECT pattern, evidence FROM rules")] == [("pip", 2)]
    conn.close()
