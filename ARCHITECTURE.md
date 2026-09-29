# Architecture

## Processes

```
Harness hook ──► agent-mem hook <harness> [event]     short-lived, standard library only, ~70–90 ms
                   normalize → redact → capture.apply → optional context/deny → maybe spawn indexer
                   on deadline/lock/error: write the event to the spool, print nothing

agent-mem index    detached, one at a time (file lock)
                   corruption check → spool replay → stale turns → embeddings → federation
                   → consolidation (daily) → optional summaries → retention → backups

agent-mem mcp      one per agent session (stdio): mem_search, mem_timeline, mem_get, mem_remember, mem_forget

SQLite (WAL) ── one file in the data directory
```

## Modules

| Module | Responsibility |
|---|---|
| `normalize/` | Harness payload → `Event` (Claude Code, Codex, Copilot CLI, OpenCode) |
| `capture.py` | Single write path: sessions, turns, events, recipes, rules, dead ends, feedback, context |
| `signals.py` | Deterministic signals: tool categories, command keys, error signatures, corrections, decisions |
| `privacy.py` | Redaction, private sections, exclude globs, denoising, size limits |
| `identity.py` | Project identity (remote URL or repository root, worktrees shared) |
| `store.py` | Search keys, entities, links, memories, deletion |
| `search.py` | FTS5 + graph candidates, RRF, scoring, abstention (standard library) |
| `semantic.py` | E5 embeddings, vector search, Personalized PageRank, time windows |
| `learn.py` | ACT-R activation, usefulness, Hebbian edges |
| `inject.py` | Context blocks within budgets |
| `consolidate.py` | Decay, global preferences, superseding, anchors, rule expiry, neighbour linking |
| `federate.py` | Claude Code auto memory and Codex memories (read-only) |
| `indexer.py` | Background work and recovery |
| `db.py`, `spool.py` | Migrations, backups, integrity; write-behind spool |
| `mcp_server.py`, `cli.py`, `commands.py`, `health.py`, `views.py` | Interfaces |
| `viewer/` | `agent-mem view`: one self-contained, read-only HTML page (no server, network blocked by CSP) |
| `importers.py`, `evaluate.py`, `summarize.py` | Imports, LongMemEval runner, optional summaries |

## Data model

Owners are turns (`T<id>`) and memories (`M<id>`).

- `sessions`, `turns`, `events`: episodic memory with provenance; events carry command keys, exit codes and error signatures.
- `memories`: semantic memory (`decision`, `dead_end`, `preference`, `correction`, `lesson`, `summary`, `fact`, `native_note`), append-only with `valid_from`, `invalid_at`, `superseded_by`.
- `search_keys` + `search_fts` (FTS5 trigram): several keys per owner.
- `vectors`: float16 E5 embeddings per owner.
- `entities`, `links`, `edges`: association graph (files, commands, errors, packages).
- `accesses`: created/shown/injected/get/used/cited/warned, the basis for activation and usefulness.
- `recipes`, `rules`, `profile`: procedural memory.
- `anchors`: git blob hashes of files at recording time, for staleness hints.
- `health`, `meta`: component health, pause state, schedules.

## Ranking

```
score = rrf_norm × (0.5 + 0.5·σ(B)) × (0.7 + 0.3·importance) × (0.5 + usefulness) × trust × project_boost
B = ln Σ t_j^-0.5            (ACT-R, hours since each access)
usefulness = (used + 1) / (shown + 2)
```

Automatic injection additionally requires a minimum score and term coverage (abstention).

## Research basis

LongMemEval (turn granularity, key expansion, time-aware queries), SeCom (denoising), HippoRAG (Personalized PageRank), Zep/Graphiti and Mem0 (append-only with validity), A-MEM (neighbour linking), Agent Workflow Memory (recipes), Memento (feedback), Generative Agents and ACT-R (recency, importance, activation), Letta sleep-time compute (background consolidation), "Memory as Infrastructure" (precision over volume, anti-recurrence, health), "Impact Is Not Invalidation" (staleness hints instead of eager invalidation), MINJA (poisoning defenses).
