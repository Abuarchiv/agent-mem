# Architecture

The authoritative design document is `docs/PLAN.md` (decisions D1 to D13, measurements in appendix B). This file is the short version.

## Processes

```
Harness hook ──► agent-mem hook <harness> [event]        short-lived, standard library only, ~60 ms
                   normalize → redact → capture.apply → optional context/deny
                   Stop/SessionEnd: enqueue the turn, spawn the observer if none holds the lock
                   on deadline/lock/error: write the event to the spool, print nothing

agent-mem observe  detached, one at a time (observe.lock), low priority, exits after 90 s idle
                   lease turns → bundle (≤ 5 turns, ≤ 6000 tokens, tool output ≤ 800 chars)
                   → mem0.add through the harness CLI of the turn's vendor
                   → mirror facts into SQLite (dedupe_key = mem0:<id>)
                   → contradiction check: similar old facts → one model verdict per bundle
                     (KEEP | SUPERSEDE | DUPLICATE) → store.supersede + forget in Qdrant
                   no stage available → raw summary (kind = summary, trust = raw)

agent-mem index    detached, one at a time: spool replay → stale turns → embeddings
                   → consolidation (daily) → retention → backups

agent-mem mcp      one per agent session (stdio): mem_search, mem_timeline, mem_get, mem_remember, mem_forget
agent-mem view     on demand: one self-contained HTML page, no server

SQLite (WAL)       the truth: sessions, turns, events, memories (facts), queue, calls
<data>/mem0/       derived: Qdrant (local path mode), entity store, history.db; rebuilt by `observe --reindex`
```

## Guarantees

- The hook never calls a model and never imports mem0, qdrant, fastembed or numpy (tested).
- No turn is lost: it stays in `observe_queue` until extraction succeeds or the raw stage stored it. Failures back off (1 min, 5 min, 30 min, 6 h) and end in `failed`, retryable with `observe --retry-failed`.
- A turn only goes to the vendor that already saw it (Claude turn to Claude, Codex turn to Codex, Copilot turn to Copilot). `observe.cross_vendor` opens the full chain. Ollama is an opt-in stage.
- SQLite is the truth. Everything in `mem0/` can be rebuilt from valid facts without a model call. A changed embedder triggers that rebuild on the next worker run and a full re-embedding on the next indexer run.

## Package layout

```
src/agent_mem/
  core/      config, db + schema/, events, identity, privacy, signals, spool, timeutil, logutil
             standard library only; shared by every path
  hooks/     hook (entry point), normalize/ (Claude Code, Codex, Copilot CLI, OpenCode), capture, inject
             the hook path: payload in, SQLite write, context out; standard library only
  memory/    store, search, semantic, learn, consolidate, views, indexer
             memories, retrieval, embeddings, learning, background indexer
  observe/   queue, bundle, providers, mem0_adapter, contradiction, worker, coding_instructions.md
             the background fact worker; the only place that imports mem0 and qdrant
  mcp/       server: the stdio MCP server used by the plugins
  cli/       argument parsing, commands, install (setup --write, uninstall), health (status, doctor)
  ui/        the self-contained HTML page written by `agent-mem view`
  bench/     evaluate: fixture and LongMemEval-S runner (not used at runtime)
```

Dependency direction: `core` ← `hooks`, `memory` ← `observe`, `mcp`, `ui`, `bench` ← `cli`. Nothing in `core`, `hooks` or `memory` imports from `observe`, `cli` or `ui`.

| Module | Responsibility |
| --- | --- |
| `hooks/normalize/` | Harness payload to `Event` |
| `hooks/capture.py` | Single write path: sessions, turns, events, recipes, rules, dead ends; enqueues finished turns |
| `hooks/inject.py` | Context blocks within budgets, facts included as `[M<id> · fact]` |
| `core/signals.py` | Deterministic signals: tool categories, command keys, error signatures, corrections, decisions |
| `core/privacy.py` | Redaction, private sections, exclude globs, size limits |
| `core/identity.py` | Project identity (remote URL or repository root, worktrees shared) |
| `memory/store.py` | Memories, search keys, entities, links, deletion (queues `observe_forget` for facts) |
| `memory/search.py` | FTS5 + graph candidates, RRF, scoring, abstention (standard library) |
| `memory/semantic.py` | fastembed embeddings (MiniLM default, e5 prefixes for e5 models), vector search, PageRank, time windows |
| `memory/learn.py`, `memory/consolidate.py` | ACT-R activation, usefulness, Hebbian edges; decay, superseding, anchors |
| `observe/queue.py` | `observe_queue`: lease, finish, fail with backoff, retry, status |
| `observe/bundle.py` | Turns to model input: prompt, answer, tool names/commands/files/errors, subagent answers, bounded; no `tool_external` |
| `observe/providers.py` | Stages `claude`, `codex`, `copilot`, `ollama`, `fake`; quota and login detection; vendor-faithful chain |
| `observe/mem0_adapter.py` | The only import point of mem0: `extract`, `add_raw`, `search`, `forget`, `reindex` |
| `observe/contradiction.py` | Candidate pairs, one judge call, verdicts applied in SQLite and Qdrant |
| `observe/worker.py` | The loop, stats, `observe_calls`, forget propagation, reindex on embedder change |
| `cli/install.py` | `setup --write` and `uninstall`: hook files with the absolute binary path, MCP entries, detection |
| `cli/health.py` | `status`, `doctor` (observer queue, providers, index size, hook binary paths) |

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
```

Automatic injection (prompt hook) is lexical and also requires a minimum score and term coverage; question words and filler verbs are not terms, hyphenated words are searched as their parts, and one inflection ending is dropped. Vector candidates (MCP server, CLI) count only above `retrieval.min_vector_score` (0.3 for MiniLM, calibrated in `docs/PLAN.md` B.23). `mem_search` applies the same gate; a hit with vector support needs a third of the content words. Without a confident hit it lists three weak candidates under "No confident match". `agent-mem eval --fixture` reports both paths (`hit@1`, `abstention` and `injected_*`, B.28).

## Why mem0 search is not the retrieval path

Measured in `docs/PLAN.md` B.9 and B.23: mem0's hybrid search always returns results and scores unrelated hits above true ones, so it cannot abstain (fixture abstention 0.0 against 0.6 for the SQLite path at equal hit@1). Qdrant therefore serves deduplication and contradiction candidates; the hook and the MCP server search SQLite.
