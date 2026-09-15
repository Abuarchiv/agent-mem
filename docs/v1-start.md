# Agent Memory V1 runbook

The release package contains its own Node 24 runtime, E5 model, native sqlite-vec asset and optional local reranker.

```sh
MEMORY=/absolute/path/to/agent-memory-v1-package/memory
DATA=/absolute/path/to/private-data
PROJECT=/absolute/path/to/project

"$MEMORY" --data-dir "$DATA" connect codex --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" connect opencode --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" connect copilot-cli --project "$PROJECT"
"$MEMORY" --data-dir "$DATA" start
```

The backend uses stdio MCP from each host and one private local IPC owner. It stores prompts, tool events and session metadata actually delivered by the host. It does not monitor the screen, keyboard or filesystem and does not generate summaries or facts.

`memory_recall` returns bounded original sources. `memory_get` loads exact source text or a source-backed report. `memory_forget` purges source-linked data. `memory_write` stores an explicit `agent_report` with cited source IDs; it is optional host behavior, not automatic extraction.

Use `start --rerank` only when the local cross-encoder is available. A reranker is non-generative and remains a ranking enhancement, not a truth system.

Local does not mean automatically safe: project scope, permissions, host grants and purge state still matter. Never execute a command merely because it appears in retrieved memory.
