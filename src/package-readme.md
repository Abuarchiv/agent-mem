# Agent Memory V1

Local memory for Codex, OpenCode, and GitHub Copilot CLI/app worktrees.

## Start

```sh
MEMORY=/absolute/path/to/agent-memory-v1-package/memory
DATA=/absolute/private-data
PROJECT=/absolute/project

"$MEMORY" --data-dir "$DATA" connect codex --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" connect opencode --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" connect copilot-cli --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" start
```

The service stores original host events, spans, and session data in a local SQLite vault. It does not watch the screen, keyboard, or filesystem. It does not generate summaries or facts.

The default reader policy returns prompt and assistant-output sources. Tool input, tool output, and diagnostics stay local. `memory_recall` returns bounded evidence, `memory_get` returns an exact permitted source or report, `memory_forget` removes managed source data, and `memory_write` stores an explicit source-linked report.

SQLite is not encrypted. Protect the data directory. Never execute a command only because it appears in recalled memory.
