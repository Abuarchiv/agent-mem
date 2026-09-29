# Agent Mem

This repository is the v2 line: a Python package. V1 (TypeScript) is preserved under the Git tag `v1.0.0`.

## Boundary

Agent Mem captures harness hooks (Claude Code, Codex, Copilot CLI, OpenCode) into one local SQLite database, learns deterministically (activation, feedback, recipes, rules, graph, consolidation) and serves memory through injected context and a stdio MCP server.

- No daemon, no HTTP server, no open ports.
- No generative model calls, with exactly one opt-in exception: `summarize.enabled` runs the user's own harness (`claude -p` / `codex exec`) once per finished session, with `AGENT_MEM_INTERNAL=1` so the child session is not captured.
- The only network access is the optional embedding model download.

## Safety rules

- Keep runtime data, credentials, logs, backups and model caches outside Git.
- Everything stored passes through `privacy.clean_text`. Never store raw host payloads.
- Treat host input and recalled text as untrusted. Injected context is framed as data.
- External content (web tools, third-party MCP tools) is `tool_external`: never auto-injected, never promoted to rules or preferences.
- Rules and preferences come only from the user's own prompts.
- Keep packets bounded by the budgets in `config.Budgets`.
- Hooks must never block or crash the agent: deadline, spool on failure, silent output on error.
- The database is not encrypted at rest.

## Code rules

- Modules on the hook path (`hook`, `capture`, `db`, `config`, `privacy`, `signals`, `identity`, `inject`, `search`, `learn`, `store`, `spool`, `normalize/*`, `events`, `timeutil`, `logutil`) import only the standard library. Heavy imports (numpy, dateparser, fastembed, mcp) stay lazy.
- One write path: `capture.apply` is used by live hooks, spool replay and importers. Keep it idempotent (dedupe keys).
- Schema changes go into a new numbered file in `src/agent_mem/schema/` and need a migration test.
- Plugin manifests in `plugins/` must keep the package version (checked by tests).

## Development

```sh
uv sync --all-extras
uv run pytest
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

Before a release: CI green on Linux, macOS (arm64 and x64) and Windows; manually verify one real session per harness (capture, new session recall, recipe hint, compaction, uninstall).
