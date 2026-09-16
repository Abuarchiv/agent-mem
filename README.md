# Agent Mem

Agent Mem is a local service for retaining and retrieving context from coding-agent sessions. V1 captures source events from configured Codex CLI, OpenCode CLI, and GitHub Copilot CLI worktrees, stores original text and provenance in SQLite, and exposes bounded retrieval through stdio MCP and a local IPC broker.

![Agent Mem architecture overview](assets/agent-mem-readme-hero.png)

## Scope

- Captures events delivered by the configured hosts.
- Preserves original text, spans, timestamps, scope, and provenance.
- Provides lexical search with SQLite/FTS5 and semantic indexing with a bundled multilingual E5 model.
- Supports bounded structural search, explicit feedback, and an optional local reranker.
- Provides four stdio MCP tools: `memory_recall`, `memory_get`, `memory_forget`, and `memory_write`.

## Runtime boundaries

- Capture and retrieval do not require a generative model or provider API.
- The runtime does not perform subscription login, telemetry, background extraction, or automatic truth verification.
- The local viewer, when enabled, is read-only and bound to the local service.
- Historical schema and validation code is retained only for reading and purging older vaults.

The SQLite vault is not encrypted at rest. Anyone who can read the data directory or one of its backups can read the vault. A host can also send recalled text to its own provider.

## Requirements

- Node.js 24.20.x and npm 11.
- A local project or worktree for each connected host.
- Pinned E5 artifacts. The reranker is optional.

## Installation

### Native installers

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.sh | sh -s -- --project "$PWD"
```

Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.ps1))) -Project (Get-Location)
```

The installer selects the OS/CPU bundle, verifies its SHA-256 checksum, installs it in user space, and with `--project` runs `agent-mem install`. The `memory` command remains a compatibility alias. Installation configures selected hosts, writes MCP and hook files, starts the owned broker, verifies `initialize` and `tools/list`, and records an install journal.

The installer can use a bundled reranker or download the pinned local extra with a timeout. If the extra is unavailable, the E5/FTS core remains usable and reports `extra.state=unavailable`; retry it with `agent-mem extras install reranker`.

The release workflow defines targets for macOS ARM64/x64, Linux x64, and Windows x64. Unsupported ARM targets fail explicitly instead of requesting an artifact that has not been released. Codex Desktop and Copilot app surfaces are not auto-configured by V1 until their native delivery is verified.

### Homebrew

After the release tap is published:

```sh
brew install Abuarchiv/tap/agent-mem
agent-mem install --project "$PWD"
```

### WinGet

After the signed WinGet manifest is published:

```powershell
winget install Abuarchiv.AgentMem
agent-mem install --project (Get-Location)
```

The release workflow defines one target-specific, checksum-verified package contract for all three channels. Homebrew and WinGet become usable after their public entries are published. No installer writes provider credentials or installs a generative model.

## Development setup

```sh
npm ci --ignore-scripts
npm run models:download
npm run models:verify
npm test
```

`models:download`/`models:verify` default to the lean core profile (E5 only). Use `npm run models:download:all` and `npm run models:verify:all` for the full package (E5 plus optional reranker), or `npm run models:download:reranker` and `npm run models:verify:reranker` for the optional reranker only.

`models:download` and `runtime:download` use the network. Capture and model loading do not.

## Package

```sh
npm run package -- --output /absolute/path/agent-mem-package
```

The command downloads and verifies the official Node 24.20.0 runtime when it is not cached. The package contains the launcher, local broker, E5 model, native sqlite-vec asset, and licenses. Add `--with-reranker` to include the optional local reranker.

## Manual recovery

```sh
agent-mem --data-dir /absolute/private-data repair --project /absolute/project
agent-mem --data-dir /absolute/private-data repair --reset
agent-mem --data-dir /absolute/private-data extras list
agent-mem --data-dir /absolute/private-data extras install reranker
```

Use `repair --reset` only after the journal has reached its three-attempt safety cap; it moves the old journal aside before starting a fresh bounded attempt. Use `connect` and `start` only for manual diagnostics. The normal install path keeps the data directory, vault, credentials, and IPC directory private. Cloud sessions cannot access this local vault.

## Status

This checkout is an engineering preview. The macOS ARM64 package probe passes with Node 24.20.0. Full CI targets Linux and macOS 14; a separate Windows job checks the build and platform code. The Windows private-data runtime, Codex Desktop, native Copilot, and concurrent OpenCode runs still require direct verification.
