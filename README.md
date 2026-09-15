# Agent Memory V1

Agent Memory V1 is a local-first, source-backed memory service for Codex, OpenCode, and local GitHub Copilot CLI/app worktrees.

> Status: engineering preview. The release gate is intentionally open; review the local release checklist before distributing an artifact.

## What it does

- Captures host events that the configured local adapter actually receives.
- Preserves original source text, spans, timestamps, scope, and provenance.
- Searches locally with SQLite/FTS5, bundled multilingual E5 embeddings, bounded fusion, and an optional local cross-encoder.
- Exposes four stdio-MCP tools: `memory_recall`, `memory_get`, `memory_forget`, and `memory_write`.
- Connects Codex, OpenCode, and Copilot through one authenticated local broker.

## What it does not do

The active V1 runtime and release package do not make generative LLM calls, use provider APIs, perform subscription login, run an extraction or summary worker, host a UI, or expose an HTTP/REST server. Historical schema validators and compatibility code remain in the source tree so older vaults can be read and purged safely; they are not active generative features.

## Privacy boundary

V1 does not upload captured content itself. The default reader policy returns only `prompt` and `assistant_output` sources. Tool input, tool output, and diagnostics stay in the local vault under the default service policy. On service start, existing `reader:*` grants are reconciled to this safer policy while non-reader grants are preserved.

Local storage is not automatically confidential: the SQLite vault is not encrypted at rest, and a host may send recalled context to its own model provider. Use private-content markers, protect the data directory, and review [`SECURITY.md`](SECURITY.md) before capturing sensitive work.

## Requirements

- Node.js 24.20.x and npm 11 for the supported package workflow.
- The pinned E5 model and optional reranker artifacts for semantic search and reranking.
- A local project/worktree for each connected host.

## Build and test

```sh
npm ci --ignore-scripts
npm run models:download   # the only setup command that uses the network
npm run models:verify
npm test
```

The model download uses pinned public revisions and verifies every file size and SHA-256 digest. Runtime capture and retrieval disable remote model discovery.

## Create a package

```sh
npm run package -- --output /absolute/path/agent-memory-v1-package
```

The destination must not exist. Packaging is supported only on Node 24.20.x and bundles the launcher, stdio MCP, private local IPC, E5, the optional reranker, the native sqlite-vec asset, and required licenses.

## Connect a host

```sh
memory --data-dir /absolute/private-data connect codex --project /absolute/project
memory --data-dir /absolute/private-data connect opencode --project /absolute/project
memory --data-dir /absolute/private-data connect copilot-cli --project /absolute/project
memory --data-dir /absolute/private-data start
```

The data directory, vault, connection credentials, and IPC endpoint must remain private. Only local repository/worktree sessions are supported; cloud-hosted sessions cannot reach the local vault.

## Current verification

The 15 September 2026 audit passes `npm run build`, `npm test` (273 tests), `npm run models:verify`, and the production dependency audit on the current macOS Node 26.7.0 shell. The package gate still requires a fresh Node 24.20.x run. Codex Desktop, Copilot native execution, and native Windows/Linux package smoke remain separate open gates.
