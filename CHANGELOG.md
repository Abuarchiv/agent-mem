# Changelog

## Unreleased

- Bundle the verified Node 24.20.0 runtime in packages.
- Reject non-private vault files before opening them.
- Limit default reader output to prompt and assistant-output sources.
- Reconcile existing reader grants at startup.
- Document the local storage and provider boundary.

## 1.0.0

- Added local source capture and retrieval with SQLite/FTS5 and multilingual E5.
- Added bounded graph search, optional local reranking, feedback, and source-linked reports.
- Added stdio MCP and an authenticated local IPC broker.
- Added Codex, OpenCode, and Copilot CLI/app local-worktree adapters.
- Excluded generative providers, subscription login, UI, and HTTP from the V1 runtime.
