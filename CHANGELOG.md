# Changelog

## Unreleased (2.0 track)

### Facts in the background (new)

- A detached worker (`agent-mem observe`) extracts facts from finished turns with mem0 2.2.1 and the harness CLI you are already logged into: `claude -p` (Haiku), `codex exec`, `copilot -s`. No API key is read or stored. The worker holds one lock, runs at low priority and exits after 90 s without work. Turns go only to the vendor that already saw them; Ollama is an opt-in fallback stage.
- Coding-specific extraction prompt (conventions, decisions, dead ends, preferences; the developer's language; at most 8 facts per bundle). Measured garbage rate 14 % against 27 % with mem0's default prompt on 20 real turns.
- Contradiction and duplicate handling on top of mem0's add-only store: one model verdict per bundle (KEEP, SUPERSEDE, DUPLICATE); superseded facts get `invalid_at` and are removed from the vector index. 9 of 10 fixture corrections resolved, 1.9 model calls per bundle.
- New tables `observe_queue`, `observe_calls`, `observe_forget` (migration 002). `mem_forget` and `purge` remove facts from Qdrant as well. `agent-mem observe --status|--retry-failed|--reprocess-raw|--reindex`.
- Facts appear in the next session's briefing as `[M<id> · fact]` without changes to the injection path.

### Retrieval

- Default embedder is now `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (same Recall@5 on LongMemEval as embeddinggemma at a fifth of the size, better than e5-small). `retrieval.min_vector_score` default 0.3, calibrated for it; `query:`/`passage:` prefixes are applied only to e5 models. An embedder change re-embeds everything on the next indexer run and rebuilds the mem0 index on the next worker run.
- `agent-mem eval` gained `--backend sqlite|mem0`, `--fixture`, `--subset`, `--embedder`, `--vector-floor`, `--llm none|claude|codex|copilot|ollama`, `--progress`. New fixture with 25 cases and 10 contradiction pairs under `tests/fixtures/`.

### Installation

- `agent-mem setup <harness> --write` registers hooks and the MCP server with the absolute path of the binary (Claude Code `settings.json`, Codex `hooks.json` and `config.toml`, Copilot `hooks/agent-mem.json` and `mcp-config.json`, OpenCode plugin and `opencode.json`), downloads the embedding model and prints what it detected. `agent-mem uninstall <harness>` removes exactly that.
- `doctor` checks the observer extra, queue and last model call, available provider stages, index size and whether every hook command points at an existing binary.
- Extras: `semantic` (fastembed) and `observer` (mem0, qdrant). Install scripts install both.
- Manifests no longer claim "No LLM calls". Issue template asks for `doctor --json` and the last log lines.

### Fixes

- A worker without an embedder (no semantic extra) falls back to the raw stage instead of failing every bundle.
- The nearest old fact is always judged for a contradiction; in a young index mem0's normalised scores fell under any threshold and the first correction of a project was missed.
- mem0 telemetry and home directory are fixed before import, so no `~/.mem0` is created and two processes no longer collide on a migration store.

## 1.0.0 (2026-09-29)

First release: capture through native hooks for Claude Code, Codex, Copilot CLI and OpenCode; turn-based episodic memory; learning without model calls (ACT-R activation, implicit feedback, error-fix recipes, rules from corrections, Hebbian graph with Personalized PageRank, daily consolidation); context injection within budgets; hybrid retrieval (FTS5, embeddings, graph, RRF, time filters); stdio MCP server with five tools; reliability (deadline, spool, migrations with backup, corruption recovery); privacy (redaction, private sections, exclude globs, purge); CLI; read-only HTML viewer; plugins and marketplaces for all four harnesses; Python 3.11 to 3.14 on Linux, macOS and Windows.
