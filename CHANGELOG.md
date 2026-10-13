# Changelog

## Unreleased (2.0 track)

### More context

- Budgets fill what each harness passes on in one hook output (Claude Code 10,000 characters, Codex 8,000 tokens with `additionalContextLimit`, Copilot 10 KB after a tool, OpenCode unlimited): session start 8,000 tokens, prompt 2,400, compaction 4,000, file history 1,200, cut per harness. The briefing grows its slots until the budget is used; on real data Claude gets about 9,000 characters (49 entries) instead of about 4,000, Codex about 29,000 (198 entries). The prompt hook shows up to 10 confident hits with an excerpt of their text instead of 3 titles. Codex hooks changed: confirm them once with `/hooks`.

### From claude-mem's documentation

- Observer failures from `claude -p` were read from stderr only, which carries just a tag; the readable error is on stdout. The model fallback now works for Claude and a usage limit pauses the stage. Explicit `ERROR` lines win, because codex echoes the prompt into stderr. "exceeded" alone (context length) no longer pauses a stage.
- The codex observer runs with `--disable hooks --disable memories`: plugin hooks (including claude-mem's) captured the observer's own bundles.
- Reading or editing a file shows up to three earlier memories about it (dead ends, decisions, lessons, facts), once per session, specific ones first; facts older than the file's last change are left out. Works in Claude Code (`Read`), Codex (`sed`/`cat`), Copilot (`view`) and OpenCode (`read`). Budget `budgets.file_history` (160 tokens).
- The notes Claude Code and Codex keep themselves are stored as `native_note` without a model call; each harness sees only the other one's notes, with two slots of their own in the briefing. `native_notes: false` turns it off.
- The briefing names the current time and shows `(+N tok)` after entries whose full text is clearly longer.

### Memory hygiene

- The review that retires duplicates and outdated facts read only 150 of a project's facts and ran once in 20 hours; on 333 real facts it found 15 retirements while one rule sat there 13 times in different words. It now reads 300 (the newest 250 plus a rotating 50 older ones, about 70 s per Haiku call), and also runs after 50 new facts. On the same copy of the live database: 39 retirements, 38 of them right (outdated install advice, a wrong database path, duplicate rules, and plain facts that only recorded an event or a snapshot such as "pushed", "135 tests", "commits exist only locally").
- A rule or lesson gives way only to another rule or lesson: the model had dropped "never measure on the live database" for a fact about `AGENT_MEM_DATA_DIR`. The prompt keeps the statement that still holds and helps next time, and drops a fact only when the kept one names every command, flag, path and reason it names.
- Expired facts are retired without a successor; decisions, rules, lessons and dead ends never expire. Retired facts keep their row and show in the viewer as invalid.

### Install and upgrade

- `agent-mem upgrade` installs the newest commit of the source this copy came from (extras and a branch or tag kept, a pinned commit dropped), then runs `doctor --fix` with the new code. It uses `uv tool install --upgrade`, which swaps the environment in place; `--reinstall` deletes it first, and in a measured run 258 of 332 hook calls during those 2.6 s found no binary.
- `doctor` compares the hooks `setup --write` registered with the ones this release ships; `doctor --fix` rewrites them at the binary path they already use. Before, a changed event, matcher or timeout (such as the Codex SessionEnd timeout of 3 s) never reached existing installs.
- Running the install script over an existing install prints old and new version and runs `doctor --fix`.
- `agent-mem upgrade --extras semantic observer` adds extras to an existing install, keeping its source, and downloads the models they need; error messages about a missing extra point to it instead of `uv tool install --reinstall` from PyPI.
- agent-mem is not on PyPI: the README installed it by its bare name, which fails today and would install whatever someone registers under that name. It now installs from the repository.
- The install script connects every harness on PATH on a fresh machine (`agent-mem uninstall all` undoes it), using the copy it just installed even before PATH knows it.
- `doctor` and `setup claude --write` report when the Claude Code plugin and `setup --write` are both active, because both then run every hook.
- Hooks of an older release now announce themselves even after a plain `uv tool upgrade`: the indexer the hooks start (and `doctor`) records them as `setup:<harness>` in `health`, so the session-start panel says to run `agent-mem doctor --fix`; the line goes away once they match.
- The install scripts stop with a clear message when git is missing (uv needs it for the repository source); the README names the order for a complete removal.
- `agent-mem --version` names the commit of a git install (`1.0.0 (9436f94)`), because the version number stays the same between releases.

### Facts in the background (new)

- A detached worker (`agent-mem observe`) extracts facts from finished turns with mem0 2.2.1 and the harness CLI you are already logged into: `claude -p` (Haiku), `codex exec`, `copilot -s`. No API key is read or stored. The worker holds one lock, runs at low priority and exits after 90 s without work. Turns go only to the vendor that already saw them; Ollama is an opt-in fallback stage.
- Coding-specific extraction prompt (conventions, decisions, dead ends, preferences; the developer's language; at most 8 facts per bundle). Measured garbage rate 14 % against 27 % with mem0's default prompt on 20 real turns.
- Contradiction and duplicate handling on top of mem0's add-only store: one model verdict per bundle (KEEP, SUPERSEDE, DUPLICATE); superseded facts get `invalid_at` and are removed from the vector index. 9 of 10 fixture corrections resolved, 1.9 model calls per bundle.
- New tables `observe_queue`, `observe_calls`, `observe_forget` (migration 002). `mem_forget` and `purge` remove facts from Qdrant as well. `agent-mem observe --status|--retry-failed|--reprocess-raw|--reindex`.
- Facts appear in the next session's briefing as `[M<id> · fact]` without changes to the injection path.

### Quality against claude-mem and agentmemory (Phase 6)

- The prompt hook injected the right memory for 9 of 20 answerable fixture questions; now 18 of 20, with 19 of 20 unanswerable questions still silent. Question words and filler verbs are no search terms, hyphenated words are searched as their parts, one inflection ending is dropped ("deployt" finds "deploy").
- Dates: "April 8th 2026", "8. April" and "3.4.2026" (day first) are understood; a named day is that day in UTC instead of the evening before. A named time now ranks the turns of that time first and excludes nothing; as a hard filter it hid every memory for questions such as "tips for this weekend". agentmemory's coding benchmark `coding-agent-life-v1` (in `tests/fixtures/`, Apache-2.0): 15 of 15 with all gold sessions in the top 5.
- Injection lists memories oldest first and says that the newer entry holds when two disagree. If the budget is short, the weakest hit is dropped, not the newest.
- Claude Code shows one terminal line at session start with the number of injected items and tokens. `status` shows injected tokens today, over seven days and per session.
- With a working observer, corrections and decisions in prompts are no longer stored by pattern; the model writes them. Facts are tagged ([decision], [rule], [dead_end], [fact]); "Use X instead of Y" becomes a rule. The prompt excludes states that change soon (test counts, commits, scores, next steps); on 20 real turns garbage without duplicates fell from 29 to 1 to 3 facts of about 110. Subagent answers enter the bundle.
- `mem_search` returns only confident hits (the hook's gate; a semantic hit must share a third of the question's content words). Without one it says "No confident match" and lists three weak candidates as such. On the fixture: right answer 20 of 20, silent on 20 of 20 unanswerable questions (before 10). "enthält" and "contains" are filler verbs, not search terms.
- `eval` reports `All@k` and what the prompt hook would inject (`injected_hit@1`, `injected_abstention`); the fixture has 20 abstention cases instead of 5.

### Viewer

- Connections shows what the memories are about instead of files, commands and errors used together: the concepts mem0's entity linking extracts (spaCy), mirrored into SQLite by the worker (tables `concepts`, `concept_links`, migration 005). Only concrete things (names, code, compound terms) that link at least two memories are drawn; plain nouns such as "Fehler" stay out. `observe.entity_model` picks the spaCy model; German facts need `de_core_news_sm`.
- `agent-mem view --watch [SECONDS]` rewrites the page every 10 s (minimum 2) until Ctrl+C; the open page reloads itself and keeps search, filters and scroll position. It waits while you click, type, select text or use the graph. Still no server and no open port.
- Every memory opens a detail panel with its full text, validity, recall counts, source turn and successor, plus copy buttons for `agent-mem show` and `agent-mem purge --id`. Commands in turn details and rules copy with one click.
- Observer facts show their whole sentence instead of the 120-character title.
- The graph labels only the strongest nodes and skips overlapping labels; preferences are grouped by command kind.

### Retrieval

- Default embedder is now `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (same Recall@5 on LongMemEval as embeddinggemma at a fifth of the size, better than e5-small). `retrieval.min_vector_score` default 0.3, calibrated for it; `query:`/`passage:` prefixes are applied only to e5 models. An embedder change re-embeds everything on the next indexer run and rebuilds the mem0 index on the next worker run.
- `agent-mem eval` gained `--backend sqlite|mem0`, `--fixture`, `--subset`, `--embedder`, `--vector-floor`, `--llm none|claude|codex|copilot|ollama`, `--progress`. New fixture with 25 cases and 10 contradiction pairs under `tests/fixtures/`.

### Installation

- `agent-mem setup <harness> --write` registers hooks and the MCP server with the absolute path of the binary (Claude Code `settings.json`, Codex `hooks.json` and `config.toml`, Copilot `hooks/agent-mem.json` and `mcp-config.json`, OpenCode plugin and `opencode.json`), downloads the embedding model and prints what it detected. `agent-mem uninstall <harness>` removes exactly that.
- `doctor` checks the observer extra, queue and last model call, available provider stages, index size and whether every hook command points at an existing binary.
- Extras: `semantic` (fastembed) and `observer` (mem0, qdrant). Install scripts install both.
- Codex shows the session-start panel too (as a hook message, without colors) and failures as they happen. The panel names the model that turns requests into facts, a pause, or why there is none. The viewer's health page lists every agent: connected, fact model, runs today, and the setup command for an installed but unconnected one.
- `agent-mem setup all --write` sets up every harness on PATH at once; `uninstall all` removes them. `doctor` lists each provider stage with its model and whether it is paused.
- Each stage uses the cheapest model of its CLI: Claude Haiku, Codex `gpt-6-luna` at low effort, Copilot `auto` on the efficiency tier. A plan without the model, or an older CLI without the flag, falls back to the CLI default.
- Manifests no longer claim "No LLM calls". Issue template asks for `doctor --json` and the last log lines.

### Structure

- The flat module list became packages: `core/` (config, database, schema, privacy, signals), `hooks/` (hook entry, normalizers, capture, inject), `memory/` (store, search, embeddings, learning, indexer), `observe/`, `mcp/`, `cli/`, `ui/`, `bench/`. All imports are absolute. The console script and `python -m agent_mem` are unchanged.

### Removed

- `summarize` (session summaries through the harness; facts from the observer replace them), `federate` (reading Claude Code auto memory and Codex memories into the briefing) and `importers` (`agent-mem import` from Claude Code, Codex, claude-mem, agentmemory). The config keys `summarize` and `federation` are gone; unknown keys are reported by `doctor`.

### Fixes

- "immer noch", "wie immer", "noch nie" and "never mind" no longer count as a rule or correction. Rule names lose a sentence-final period ("pip." never matched `pip install`).
- Compaction context: the session goal is the first turn with text, "still failing" only lists failures of the last three turns.
- A worker without an embedder (no semantic extra) falls back to the raw stage instead of failing every bundle.
- The nearest old fact is always judged for a contradiction; in a young index mem0's normalised scores fell under any threshold and the first correction of a project was missed.
- mem0 telemetry and home directory are fixed before import, so no `~/.mem0` is created and two processes no longer collide on a migration store.

## 1.0.0 (2026-09-29)

First release: capture through native hooks for Claude Code, Codex, Copilot CLI and OpenCode; turn-based episodic memory; learning without model calls (ACT-R activation, implicit feedback, error-fix recipes, rules from corrections, Hebbian graph with Personalized PageRank, daily consolidation); context injection within budgets; hybrid retrieval (FTS5, embeddings, graph, RRF, time filters); stdio MCP server with five tools; reliability (deadline, spool, migrations with backup, corruption recovery); privacy (redaction, private sections, exclude globs, purge); CLI; read-only HTML viewer; plugins and marketplaces for all four harnesses; Python 3.11 to 3.14 on Linux, macOS and Windows.
