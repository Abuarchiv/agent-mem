# Agent Memory V1

Local memory for Codex, OpenCode, and GitHub Copilot CLI/app worktrees.

## What it does

- Captures events received from a configured local host.
- Keeps the original text, spans, timestamps, scope, and provenance.
- Searches with SQLite/FTS5 and a bundled multilingual E5 model.
- Supports bounded graph search, feedback, and an optional local reranker.
- Provides four stdio MCP tools: `memory_recall`, `memory_get`, `memory_forget`, and `memory_write`.
- Uses one authenticated local IPC broker.

## What it does not do

The V1 runtime makes no generative LLM or provider calls. It has no subscription login, extraction worker, summary generator, UI, or HTTP server. Old schema and validation code remains only for compatibility with older vaults.

Local storage is not encrypted. The SQLite vault is readable by anyone who can read the data directory or a backup. A host can also send recalled text to its own provider.

## Requirements

- Node.js 24.20.x and npm 11.
- A local project or worktree for each connected host.
- Pinned E5 artifacts. The reranker is optional.

## Setup

```sh
npm ci --ignore-scripts
npm run models:download
npm run models:verify
npm test
```

`models:download` and `runtime:download` use the network. Runtime capture and model loading do not.

## Package

```sh
npm run package -- --output /absolute/path/agent-memory-v1-package
```

The command downloads and verifies the official Node 24.20.0 runtime when it is not cached. The package includes the launcher, local broker, E5 model, optional reranker, native sqlite-vec asset, and licenses.

## Connect a host

```sh
memory --data-dir /absolute/private-data connect codex --project /absolute/project
memory --data-dir /absolute/private-data connect opencode --project /absolute/project
memory --data-dir /absolute/private-data connect copilot-cli --project /absolute/project
memory --data-dir /absolute/private-data start
```

Keep the data directory, vault, credentials, and IPC directory private. Cloud sessions cannot access this local vault.

## Status

The current checkout is an engineering preview. Build and tests pass. The package probe passes on macOS ARM64 with Node 24.20.0. Desktop Codex, native Copilot, Windows, Linux, and concurrent OpenCode runs still need separate verification.
