# Agent Memory V1

Local-first, source-backed memory for Codex, OpenCode, and local GitHub Copilot CLI/app worktrees.

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

The service stores original host events, source spans, and session metadata in a private local vault. It does not monitor the screen, keyboard, or filesystem and does not generate summaries or facts.

The default reader policy returns only prompt and assistant-output sources. Tool input, tool output, and diagnostic sources remain local-only. On service start, existing `reader:*` grants are reconciled to this safer policy while non-reader grants are preserved. `memory_recall` returns bounded evidence; `memory_get` returns an exact permitted source or report; `memory_forget` purges managed source data; and `memory_write` stores an explicit source-backed `agent_report`.

Local does not mean encrypted: the SQLite vault is not encrypted at rest. Protect the data directory and review the product security policy before capturing sensitive work. Never execute a command merely because it appears in retrieved memory.
