# Architecture

This file describes the design in short.

## Processes

```
Harness hook ──► agent-mem hook <harness> [event]        short-lived, standard library only, ~70 ms
                   normalize → redact → capture.apply → optional context/deny
                   Stop/SessionEnd: enqueue the turn, spawn the observer if none holds the lock
                   on deadline/lock/error: write the event to the spool, print nothing

agent-mem observe  detached, one at a time (observe.lock), low priority, exits after 90 s idle
                   lease turns → bundle (≤ 5 turns, ≤ 20 000 tokens, tool output ≤ 1 200 chars)
                   → mem0.add through the harness CLI of the turn's vendor
                   → mirror facts into SQLite (dedupe_key = mem0:<id>)
                   → work log: type and title per turn, running session summary, lessons with an evidence turn
                     (one call per bundle)
                   → once a day per project: review of all facts, duplicates and outdated ones retired
                   no stage available → raw summary (kind = summary, trust = raw)

agent-mem index    detached, one at a time: spool replay → stale turns → embeddings
                   → consolidation (daily) → retention

agent-mem mcp      one per agent session (stdio): mem_search, mem_timeline, mem_get, mem_remember, mem_forget
agent-mem serve    detached, one per machine: read-only viewer on localhost:37778, page built
                   per request; started by the SessionStart hook, `agent-mem view` and the login item

SQLite (WAL)       the truth: sessions, turns, events, memories (facts), queue, calls
<data>/mem0/       derived: Qdrant (local path mode), entity store, history.db; rebuilt by `observe --reindex`
```

## Guarantees

- The hook never calls a model and never imports mem0, qdrant, fastembed or numpy (tested).
- No turn is lost: it stays in `observe_queue` until extraction succeeds or the raw stage stored it. Failures back off (1 min, 5 min, 30 min, 6 h) and end in `failed`, retryable with `observe --retry-failed`.
- A turn only goes to the vendor that already saw it (Claude turn to Claude, Codex turn to Codex, Copilot turn to Copilot). `observe.cross_vendor` opens the full chain. Ollama is an opt-in stage.
- SQLite is the truth. Everything in `mem0/` can be rebuilt from valid facts without a model call. A changed embedder triggers that rebuild on the next worker run and a full re-embedding on the next indexer run.

## Repository layout

```
src/agent_mem/        the package (below)
plugins/              per agent: hook definitions, MCP entry, OpenCode plugin; shipped inside the wheel
.claude-plugin/       marketplace entries that point at plugins/ (Claude Code, Codex, Copilot CLI)
.agents/plugins/
.github/plugin/
tests/                pytest; `-m "not local"` runs everything that needs no cached model
bench/                retrieval measurement before a push (check.py), agent-mem vs claude-mem (versus.py)
.githooks/            commit-msg (AGENTS.md R11) and pre-push (bench/check.py); `git config core.hooksPath .githooks`
install.sh, install.ps1, install-docker.sh, Dockerfile   the install lines from the README
hatch_build.py        build hook: compiles ui/app.ts to app.js for the wheel
```

## Package layout

```
src/agent_mem/
  core/      config, db + schema/, events, identity, paths, privacy, proc, signals/, spool, timeutil, logutil
             standard library only; shared by every path
  hooks/     hook (entry point), normalize/ (Claude Code, Codex, Copilot CLI, OpenCode), capture, inject
             the hook path: payload in, SQLite write, context out; standard library only
  memory/    store, search, semantic, learn, consolidate, views, notes, work, indexer
             memories, retrieval, embeddings, learning, background indexer
  observe/   queue, bundle, providers, mem0_adapter, summary, review, relations, spacy_model, worker,
             coding_instructions.md
             the background fact worker; the only place that imports mem0 and qdrant
  mcp/       server: the stdio MCP server used by the plugins
  cli/       argument parsing, commands (data, servers, jobs), lifecycle (models, setup, uninstall, upgrade),
             install (hook files, detection), health (doctor)
  ui/        what status and the page show, the self-contained HTML page, its loopback server, its login item
  bench/     evaluate: fixture and LongMemEval-S runner (not used at runtime)
```

Dependency direction: `core` ← `hooks`, `memory` ← `observe`, `mcp`, `ui`, `bench` ← `cli`. Nothing in `core`, `hooks` or `memory` imports from `observe`, `cli` or `ui`.

| Module | Responsibility |
| --- | --- |
| `hooks/normalize/` | Harness payload to `Event` |
| `hooks/capture.py` | Single write path: sessions, turns, events, recipes, rules, dead ends; enqueues finished turns |
| `hooks/inject.py` | Context blocks within budgets, facts included as `[M<id> · fact]` |
| `core/signals/` | Deterministic signals: `tools` (categories, command keys, files), `errors` (signatures), `prompts` (corrections, preferences, decisions), `text` |
| `core/privacy.py` | Redaction, private sections, exclude globs, size limits |
| `core/identity.py` | Project identity (remote URL or repository root, worktrees shared) |
| `memory/store.py` | Memories, search keys, entities, links, deletion (queues `observe_forget` for facts) |
| `memory/search.py` | FTS5 + graph candidates, RRF, scoring, abstention (standard library) |
| `memory/semantic.py` | fastembed embeddings (MiniLM default, e5 prefixes for e5 models), vector search, PageRank, time windows |
| `memory/notes.py` | Notes Claude Code and Codex keep themselves, stored as `native_note` without a model (indexer); shown only to the other harnesses |
| `memory/learn.py`, `memory/consolidate.py` | ACT-R activation, usefulness, Hebbian edges; decay, superseding, anchors |
| `observe/queue.py` | `observe_queue`: lease, finish, fail with backoff, retry, status |
| `observe/bundle.py` | Turns to model input: prompt, what the tools showed (command or file and the start of the output), answer, commands/files/errors, subagent answers, bounded; no `tool_external` |
| `observe/providers.py` | Stages `claude`, `codex`, `copilot`, `ollama`, `fake`; quota and login detection; vendor-faithful chain |
| `observe/mem0_adapter.py` | The only import point of mem0: `extract`, `add_raw`, `search`, `forget`, `reindex` |
| `observe/summary.py` | Work log per bundle: turn titles and types, session summary, lessons with evidence |
| `observe/review.py` | Daily per project: duplicates and outdated facts and lessons retired with evidence |
| `observe/worker.py` | The loop, stats, `observe_calls`, forget propagation, reindex on embedder change |
| `cli/lifecycle.py` | `models`, `setup`, `uninstall`, `upgrade` (on Windows through a script that runs after the command ends) |
| `cli/install.py` | `setup --write` and `uninstall`: hook files with the absolute binary path, MCP entries, detection |
| `ui/status.py` | `status` and the viewer's agent rows (connected, fact model, runs today) |
| `cli/health.py` | `doctor` (observer queue, providers, index size, hook binary paths) |

## Data model

Owners are turns (`T<id>`) and memories (`M<id>`).

- `sessions`, `turns`, `events`: episodic memory with provenance.
- `memories`: semantic memory, append-only with `valid_from`, `invalid_at`, `superseded_by`. Observer facts: `kind = fact`, `source = agent`, `trust = observer`, `dedupe_key = mem0:<uuid>`. Raw summaries: `kind = summary`, `trust = raw`.
- `observe_queue` (turn state: pending, running, done, raw, failed), `observe_calls` (every model call: provider, purpose, seconds, ok, prompt size), `observe_forget` (ids to remove from Qdrant).
- `search_keys` + `search_fts` (FTS5 trigram), `vectors` (one row per owner and model, upserted on model change).
- `entities`, `links`, `edges`: association graph. `accesses`: shown/used/cited, the basis for activation.
- `recipes`, `rules`, `profile`, `anchors`, `health`, `meta`.

mem0 side: Qdrant collection `agent_mem` (one namespace per project, `user_id = <user>|p:<project_id>`), `agent_mem_entities` (spaCy), `history.db` (mem0's add log; contains the bundle messages, so it is deleted by `purge` and `reindex`).

## Ranking

```
score = rrf_norm × (0.5 + 0.5·σ(B)) × (0.7 + 0.3·importance) × (0.5 + usefulness) × trust × project_boost
B = ln Σ t_j^-0.5            (ACT-R, hours since each access)
usefulness = (used + 1) / (shown + 2)
order = score × (0.5 + 0.5·coverage) × (1 + 0.3·tie)
```

`score` is what the abstention gate compares; `order` only sorts. `coverage` is the share of the question's words in a hit (a turn's request and the start of its answer, a memory's first 800 characters). `tie` (0 to 1) is how strongly the graph ties a hit to the files, commands and packages the question names: seeds by exact name 1.0, by a word inside a path 0.3. The graph reorders what text and vectors found and adds no candidates of its own; as a separate list in the fusion it would outvote exact matches with whatever touched such a file last. A project's search includes the projects nested in it and the projects around it (`~/work` around `~/work/app`), never the home folder.

Automatic injection (prompt hook) is lexical and also requires a minimum score and term coverage; question words and filler verbs are not terms, hyphenated words are searched as their parts, and one inflection ending is dropped. Vector candidates (MCP server, CLI) count only above `retrieval.min_vector_score` (0.3 for MiniLM, calibrated on the retrieval fixture). `mem_search` applies the same gate; a hit with vector support needs a third of the content words. Without a confident hit it lists three weak candidates under "No confident match". `agent-mem eval --fixture` reports both paths (`hit@1`, `abstention` and `injected_*`).

## Why mem0 search is not the retrieval path

mem0's hybrid search always returns results and scores unrelated hits above true ones, so it cannot abstain. Qdrant therefore only serves mem0's deduplication during extraction; the hook and the MCP server search SQLite.
