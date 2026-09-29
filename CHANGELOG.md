# Changelog

## 2.0.0 — 2026-09-29

Complete rewrite in Python. V1 (TypeScript) remains available under the tag `v1.0.0`.

### Added

- Automatic capture through native hooks for Claude Code, Codex, Copilot CLI and OpenCode; one shared memory for all of them.
- Turn-based episodic memory with provenance; decisions, dead ends, corrections, preferences and lessons as semantic memory.
- Learning without LLM calls: ACT-R activation, implicit feedback, error→fix recipes, rules learned from corrections (opt-in blocking), Hebbian association graph with Personalized PageRank, daily consolidation.
- Context injection at session start, prompt, before risky actions, after failures and after compaction, always within token budgets and behind an abstention threshold.
- Hybrid retrieval: SQLite FTS5 (trigram), optional multilingual E5 embeddings (fastembed, no PyTorch), graph, reciprocal rank fusion, time filters ("gestern", "last week").
- Federation: reads Claude Code auto memory and Codex memories so every harness can use them.
- stdio MCP server with five tools: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`.
- Reliability: hook deadline, write-behind spool, idempotent replay, migrations with automatic backup, downgrade protection, daily backups, corruption recovery.
- Privacy: redaction, private sections, exclude globs, per-project opt-out, pause, purge including backups and spool.
- CLI: `status`, `doctor`, `search`, `show`, `rules`, `lessons`, `pause`, `resume`, `import` (Claude, Codex, V1, claude-mem, agentmemory), `export`, `purge`, `backup`, `restore`, `consolidate`, `models`, `setup`, `eval`.
- Plugins and marketplaces for Claude Code (`.claude-plugin`), Codex (`.agents/plugins`), Copilot CLI (`.github/plugin`) and an OpenCode plugin.
- Supports Python 3.11–3.14; built on the MCP Python SDK 2.x.
- Optional, off by default: session summaries through the user's own harness.

### Removed

- V1 IPC broker, TLS transport, custom MCP implementation, bundled Node runtime, viewer and legacy extraction code.
