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

## Installation

### Native Install (Recommended)

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.sh | sh -s -- --project "$PWD"
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.ps1))) -Project (Get-Location)
```

The native bootstrap selects the OS/CPU bundle, verifies its SHA-256 checksum, installs it in user space, and with `--project` immediately runs `memory install`. That command configures every detected V1 host, writes MCP/hooks, starts the owned broker, verifies `initialize`/`tools/list`, and records an install journal.

### Homebrew

After the release tap is published:

```sh
brew install Abuarchiv/tap/agent-memory-v1
memory install --project "$PWD"
```

### WinGet

After the signed WinGet manifest is published:

```powershell
winget install Abuarchiv.AgentMemory
memory install --project (Get-Location)
```

All three channels use the same target-specific, checksum-verified package. No channel silently installs provider credentials or a generative model.

## Development setup

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

## Manual recovery

```sh
memory --data-dir /absolute/private-data repair --project /absolute/project
memory --data-dir /absolute/private-data extras list
memory --data-dir /absolute/private-data extras install reranker
```

Use `connect` and `start` only for manual diagnostics. The normal install path keeps the data directory, vault, credentials, and IPC directory private. Cloud sessions cannot access this local vault.

## Status

This checkout is an engineering preview. The local build, tests, and macOS ARM64 package probe pass with Node 24.20.0. Full CI runs on Linux and macOS 14; a separate Windows job checks the build and platform code. The Windows private-data runtime, Codex Desktop, native Copilot, and concurrent OpenCode runs still need direct verification.
