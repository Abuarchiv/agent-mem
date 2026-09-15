# Changelog

## Unreleased

### Security

- Reject existing vault files that are not private, user-owned, regular files.
- Limit default reader egress to prompt and assistant-output sources.
- Reconcile existing reader grants at startup without overwriting non-reader grants.
- Include the Copilot reader target in the V1 policy setup.
- Document the distinction between local storage, provider context, and encryption at rest.

### Documentation

- Replace historical release claims with current, reproducible verification status.
- Add repository security guidance and a CI quality gate.

## 1.0.0

- Established the standalone local-first V1 line.
- Added source-only capture and retrieval with SQLite/FTS5, multilingual E5, bounded metadata search, optional local reranking, stdio MCP, and authenticated local IPC.
- Added Codex, OpenCode, and Copilot CLI/app local-worktree adapters.
- Excluded generative provider execution, subscription login, UI, and HTTP entry points from the active V1 product path.
