# Agent Mem

Agent Mem is a local service for retaining and retrieving source-backed context from Codex CLI, OpenCode CLI, and GitHub Copilot CLI worktrees. It stores original host events and provenance in SQLite and exposes bounded retrieval through stdio MCP and a local IPC broker. Codex Desktop and Copilot app surfaces are not V1 host targets yet.

## Start

```sh
AGENT_MEM=/absolute/path/to/agent-mem-package/agent-mem
DATA=/absolute/private-data
PROJECT=/absolute/project

"$AGENT_MEM" --data-dir "$DATA" connect codex --project "$PROJECT"
"$AGENT_MEM" --data-dir "$DATA" connect opencode --project "$PROJECT"
"$AGENT_MEM" --data-dir "$DATA" connect copilot-cli --project "$PROJECT"
"$AGENT_MEM" --data-dir "$DATA" start
```

The service stores original host events, spans, and session data in a local SQLite vault. It does not watch the screen, keyboard, or filesystem. Capture and retrieval do not require a generative model or provider API.

The default reader policy returns prompt and assistant-output sources. Tool input, tool output, and diagnostics stay local. `memory_recall` returns bounded evidence, `memory_get` returns one permitted source or report, `memory_forget` removes managed source data, and `memory_write` stores an explicit source-linked report.

SQLite is not encrypted. Protect the data directory. Never execute a command only because it appears in recalled memory.

## Package profile

The package uses the V1 core profile by default. Build with `--with-reranker` to add the optional local reranker.
