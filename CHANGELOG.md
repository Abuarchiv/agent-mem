# Changelog

## Unreleased

- Repeated corrections no longer pile up near-identical preference memories ("… (corrected 2x)", "… (corrected 3x)", …). The newest one supersedes the earlier ones, so briefings and search show it once.
- Removed the unused `privacy.error_lines`.

Fixes from a production-readiness review:

- **Projects:** a plain (non-git) directory registered as a project no longer swallows git repositories nested below it. Excluded, paused and opted-out projects leave no path in the database, and read-only commands (`search`, `export`, `lessons`) no longer register the current directory as a project.
- **Safety:** stored text can no longer close the `<agent-mem>` data frame (nested or case-varied tags). Error text from web and third-party MCP tools is no longer shown in compaction context or prompt hints. Agents can no longer store preferences through `mem_remember`, and they can supersede only agent memories of their own project. Only preferences learned from the user's prompts are promoted to global ones. `agent-mem import claude` skips subagent transcripts, so an agent's prompts no longer become the user's rules.
- **Hooks:** an older database is migrated by the background indexer instead of inside the hook deadline, and backups are written atomically, so an interrupted backup never counts as one. Out-of-range timestamps and malformed Codex event names no longer drop events. Repeated Copilot CLI subagents of the same type each get a briefing. Tool names and ids from hosts are cleaned and bounded like all other stored text. The OpenCode plugin decodes multi-byte output correctly.
- **Learning:** rules and error→fix recipes outside a project now gather evidence instead of adding a new row per correction. Consolidation no longer supersedes unrelated memories with non-Latin titles. "again?" is recognized as a correction.
- **Search:** version numbers such as `1.2.3` are no longer read as dates. "last month" ends on the first of the current month. A whitespace-only prompt no longer breaks search. Token budgets count CJK and other wide characters correctly.
- **CLI:** `export`/`search --project` with an unknown directory fail instead of exporting or searching everything. `purge` also deletes quarantined events and the copy kept by `restore`, and it keeps the view page when you decline the confirmation. Odd ids (`T²`, huge numbers) and durations are rejected cleanly, and `doctor` reports a migration in progress instead of crashing.
- **Summaries:** when the summarizing harness is not installed, sessions stay pending and no daily budget is used.
- **Imports:** agentmemory items without an id and claude-mem rows from different databases are no longer dropped as duplicates.
- **Packaging:** the sdist includes the marketplace manifests, so its test suite passes. CI builds the sdist and runs the tests from it, and the release workflow runs lint and type checks.

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
