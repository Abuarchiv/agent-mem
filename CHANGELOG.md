# Changelog

## 1.0.0 — 2026-09-29

First release.

- Automatic capture through native hooks for Claude Code, Codex, Copilot CLI and OpenCode; one shared memory for all of them.
- Turn-based episodic memory with provenance; decisions, dead ends, corrections, preferences and lessons as semantic memory.
- Learning without LLM calls: ACT-R activation, implicit feedback, error→fix recipes, rules learned from corrections (opt-in blocking), Hebbian association graph with Personalized PageRank, daily consolidation.
- Context injection at session start, subagent start, prompt, before risky actions, after failures and around compaction, always within token budgets and behind an abstention threshold.
- Hybrid retrieval: SQLite FTS5 (trigram), optional multilingual E5 embeddings (fastembed, no PyTorch), graph, reciprocal rank fusion, time filters ("gestern", "last week"). Scales to large histories (prompt hook ~100 ms with 20,000 stored turns).
- Federation: reads Claude Code auto memory and Codex memories so every harness can use them.
- stdio MCP server with five tools: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget` (MCP Python SDK 2.x).
- Reliability: hook deadline, write-behind spool, idempotent replay, migrations with automatic backup, downgrade protection, daily backups, corruption recovery.
- Privacy: redaction, private sections, exclude globs, per-project opt-out, pause, purge including backups and spool.
- CLI: `status`, `doctor`, `search`, `show`, `rules`, `lessons`, `pause`, `resume`, `import` (Claude Code, Codex, claude-mem, agentmemory), `export`, `purge`, `backup`, `restore`, `consolidate`, `models`, `setup`, `eval`.
- `agent-mem view`: a read-only HTML page of the local memory (overview, timeline, memories, rules, error fixes, preferences, association graph, capture health). One self-contained file in the private data directory, no server, no open port; a Content Security Policy blocks all network requests. Bundled fonts under the SIL Open Font License. `purge` deletes the page as well.
- Plugins and marketplaces for Claude Code (`.claude-plugin`), Codex (`.agents/plugins`), Copilot CLI (`.github/plugin`) and an OpenCode plugin.
- Python 3.11–3.14 on Linux, macOS and Windows.
- Optional, off by default: session summaries through the user's own harness.
