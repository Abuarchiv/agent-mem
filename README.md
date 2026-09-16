# Agent Mem

Local memory for coding agents.

Agent Mem captures source events from configured Codex CLI, OpenCode CLI, and GitHub Copilot CLI worktrees. Original text, spans, timestamps, sessions, and provenance are stored in SQLite. Retrieval is available through stdio MCP and a local IPC broker.

![Agent Mem architecture overview](assets/agent-mem-readme-hero.png)

## Quick start

Requirements: Node.js 24.20.x, npm 11, and a local project or worktree. Published bundles target macOS arm64/x64, Linux x64, and Windows x64. Intel macOS uses lexical retrieval because the pinned ONNX runtime has no macOS Intel binding.

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.sh | sh -s -- --project "$PWD"
agent-mem install --project "$PWD" --agents codex --yes
agent-mem view
```

The installer verifies the package checksum, configures the selected host, starts the local broker, and verifies MCP initialization. The viewer command prints a local URL.

For Codex, open `/hooks`, trust the project hooks, and reopen the project. Capture starts after the hook is trusted.

### OpenCode concurrency

OpenCode's snapshot garbage collector uses a repository-global lock. Run OpenCode sessions serially per repository with this V1 release. This is an upstream host limitation; Agent Mem keeps capture and retrieval state separate from the snapshot store.

## Viewer

The viewer is read-only and defaults to **All projects**.

It shows:

- sessions, source events, spans, jobs, memory records, privacy state, and query traces;
- measured evidence reduction and token savings without imposing a webpage token budget;
- a real interactive knowledge graph with scope, session, source, and source-backed semantic nodes.

The page receives an embedded local snapshot. It has no REST API and does not write to the vault.

## Retrieval

The local core works without a generative model or provider API:

- SQLite FTS5 for lexical search on every published target;
- bundled multilingual E5 for semantic retrieval where the native ONNX binding is available;
- optional local reranking with the same native-runtime fallback;
- four stdio MCP tools: `memory_recall`, `memory_get`, `memory_forget`, and `memory_write`.

## Data and privacy

The vault is local, but it is not encrypted at rest. Anyone who can read the data directory or its backups can read the stored evidence. A host may also send recalled text to its own model provider.

The default data directory is:

```text
~/Library/Application Support/Agent Mem   # macOS
~/.local/share/Agent Mem                   # Linux
%LOCALAPPDATA%\Agent Mem                   # Windows
```

Use `--data-dir /absolute/path` for another location.

## Useful commands

```sh
agent-mem status --json
agent-mem pause
agent-mem resume
agent-mem extras list
agent-mem extras install reranker
agent-mem repair --project "$PWD"
```

## Development

```sh
npm ci --ignore-scripts
npm run models:download
npm run models:verify
npm run build
npm test
```

Agent Mem V1.0.0 supports the local capture and retrieval path. Codex Desktop, the Copilot app, and concurrent OpenCode sessions are outside the V1 release boundary.
