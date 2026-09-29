# Changelog

## Unreleased

### Added

- `agent-mem view`: a read-only HTML page of the local memory with overview, timeline (turns with their actions and results), memories, learned rules, error fixes and preferences, the association graph, and capture health. It is one self-contained file in the private data directory, opened in the browser; no server, no open port, and a Content Security Policy that blocks all network requests. Light and dark mode, narrow screens, bundled fonts (SIL Open Font License). `purge` deletes the page as well.

### Fixed

- Corruption recovery on Windows: the integrity probe kept the damaged database open, so it could not be moved aside and the backup was not restored.
- `purge --project` on Windows left spooled events behind because paths were compared without normalising case and separators. Paths are now compared by whole segments on every platform, so `/proj` no longer matches `/proj2`.
- `agent-mem view --project` no longer registers an unknown directory as a new project.
- CI: the dependency audit no longer tries to look up `agent-mem` itself on PyPI; the retired `macos-13` runner is replaced by `macos-15-intel`; `setup-uv` moves to v7 (Node 24).

### Removed

- V1 release notes and implementation notes under `docs/`; V1 lives on under the tag `v1.0.0`.

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
- Plugins for Claude Code (marketplace), Codex, Copilot CLI and OpenCode.
- Optional, off by default: session summaries through the user's own harness.

### Removed

- V1 IPC broker, TLS transport, custom MCP implementation, bundled Node runtime, viewer and legacy extraction code.
