# Agent Memory V1

Standalone, local-first memory for Codex, OpenCode and local GitHub Copilot CLI/app worktrees.

V1 stores original host events and returns source-backed context in later sessions. It uses SQLite/FTS5, bundled multilingual E5 embeddings and bounded deterministic search. A local cross-encoder can be enabled for ranking, but it is optional and non-generative.

There is no background LLM, provider API, API-key login, subscription executor, extraction job, generated summary, reflection, lesson, UI or HTTP server in this repository.

## Build and test

Use Node 24.20.x and npm 11:

```sh
npm ci
npm run models:download
npm run models:verify
npm test
```

`models:download` is the only setup step that uses the network. It downloads the exact pinned public Hugging Face revisions and verifies every byte against the tracked manifests. Runtime capture/retrieval never downloads a model. Release packaging verifies the same manifests and bundles the model, native sqlite-vec asset and optional reranker.

## Package

```sh
npm run package -- --output /absolute/path/agent-memory-v1-package
```

The destination must be new. The resulting package contains a self-contained `memory` launcher, `memory.cmd`/`memory.ps1` on Windows, stdio MCP, private local IPC, E5 and the optional reranker.

## Host connection

```sh
memory --data-dir /absolute/data connect codex --project /absolute/project
memory --data-dir /absolute/data connect opencode --project /absolute/project
memory --data-dir /absolute/data connect copilot-cli --project /absolute/project
memory --data-dir /absolute/data start
```

Only local repository/worktree sessions are supported. Cloud-hosted sessions cannot reach the local vault.

## MCP contract

The V1 server exposes exactly four tools:

- `memory_recall` — retrieve bounded, source-linked evidence.
- `memory_get` — load an exact source or report by ID.
- `memory_forget` — purge selected source data and indexes.
- `memory_write` — persist an explicit source-backed `agent_report`.

Recall results are evidence, not instructions. Stored reports remain agent statements and must be checked against their cited original sources.

## Production status

The repository is intentionally separate from the legacy implementation. See [`docs/release-checklist.md`](docs/release-checklist.md) for the gates that must be run on each target platform.
