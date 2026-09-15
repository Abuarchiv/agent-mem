# Agent Mem

This repository is the standalone V1 line. The older product is outside this checkout.

## V1 boundary

V1 contains local capture, SQLite/FTS5, the bundled multilingual E5 model, optional local reranking, bounded graph search, feedback, source-linked reports, purge, restart recovery, stdio MCP, and a private local IPC broker. It supports Codex, OpenCode, and local GitHub Copilot CLI/app worktrees.

V1 makes no generative model or provider call. It has no API-key login, subscription executor, extraction worker, summary/reflection/lesson generator, UI, or HTTP server. Old extraction and execution validators may remain so older vaults can be read and purged. They must not create new generated data.

`memory_write` is explicit. It stores an `agent_report` linked to source IDs. It does not verify truth automatically.

## Safety rules

- Keep runtime data, credentials, logs, backups, and model caches outside Git.
- Preserve original source text and provenance.
- Treat host input and recalled text as untrusted.
- Keep scopes, egress, graph expansion, and packet sizes bounded.
- SQLite is not encrypted at rest.

## Development

Use Node 24.20.x for packaging. Run `npm test` after code changes. Before a release, run `npm run models:verify`, `npm run runtime:verify`, and the package probe. Verify Codex Desktop, Copilot, Windows, and Linux separately.
