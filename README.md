# Agent Memory V1

Local memory for Codex, OpenCode, and GitHub Copilot CLI/app worktrees.

## What it does

- Stores events from a configured host.
- Keeps the original text, spans, timestamps, scope, and provenance.
- Searches with SQLite/FTS5 and a bundled multilingual E5 model.
- Supports bounded graph search, feedback, and an optional local reranker.
- Provides four stdio MCP tools: `memory_recall`, `memory_get`, `memory_forget`, and `memory_write`.
- Uses one authenticated local IPC broker.

## What it does not do

The V1 runtime makes no generative LLM or provider calls. It has no subscription login, extraction worker, summary generator, UI, or HTTP server. Old schema and validation code remains only to read and purge older vaults.

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

`models:download` and `runtime:download` use the network. Capture and model loading do not.

## Package

```sh
npm run package -- --output /absolute/path/agent-memory-v1-package
```

The command downloads and verifies the official Node 24.20.0 runtime when it is not cached. By default, the package contains the V1 core: the launcher, local broker, E5 model, native sqlite-vec asset, and licenses. Add `--with-reranker` to include the optional local reranker.

## Connect a host

```sh
memory --data-dir /absolute/private-data connect codex --project /absolute/project
memory --data-dir /absolute/private-data connect opencode --project /absolute/project
memory --data-dir /absolute/private-data connect copilot-cli --project /absolute/project
memory --data-dir /absolute/private-data start
```

Keep the data directory, vault, credentials, and IPC directory private. Cloud sessions cannot access this local vault.

## Status

This checkout is an engineering preview. The local build, tests, and macOS ARM64 package probe pass with Node 24.20.0. The CI matrix runs on Linux, Windows, and macOS 14. Codex Desktop, native Copilot, and concurrent OpenCode runs still need direct verification.
