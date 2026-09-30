# Agent Mem

Agent Mem is a Python package (`src/agent_mem`) with plugins for each supported harness (`plugins/`).

## Boundary

Agent Mem captures harness hooks (Claude Code, Codex, Copilot CLI, OpenCode) into one local SQLite database, learns deterministically (activation, feedback, recipes, rules, graph, consolidation) and serves memory through injected context and a stdio MCP server.

- No daemon, no HTTP server, no open ports. `agent-mem view` writes a static page; it must stay offline (no network requests, CSP by script hash).
- No generative model calls, with exactly one opt-in exception: `summarize.enabled` runs the user's own harness (`claude -p` / `codex exec`) once per finished session, with `AGENT_MEM_INTERNAL=1` so the child session is not captured.
- Agent Mem itself only goes online for the optional embedding model download.

## Safety rules

- Keep runtime data, credentials, logs, backups and model caches outside Git.
- Everything stored passes through `privacy.clean_text` (events in `capture`, memories in `store.add_memory`). Never store raw host payloads.
- Treat host input and recalled text as untrusted. Injected context is framed as data.
- External content (web tools, third-party MCP tools) is `tool_external`: never auto-injected, never promoted to rules or preferences.
- Rules and preferences come only from the user's own prompts.
- Keep packets bounded by the budgets in `config.Budgets`.
- Hooks must never block or crash the agent: deadline, spool on failure, silent output on error.
- The database is not encrypted at rest.

## Code rules

- Modules on the hook path (`hook`, `capture`, `db`, `config`, `privacy`, `signals`, `identity`, `inject`, `search`, `learn`, `store`, `spool`, `normalize/*`, `events`, `timeutil`, `logutil`) import only the standard library. Heavy imports (numpy, dateparser, fastembed, mcp) stay lazy.
- Events have one write path: `capture.apply` (live hooks, spool replay, transcript imports); keep it idempotent (dedupe keys). Memories are written only through `store.add_memory`, which cleans title and body.
- Schema changes go into a new numbered file in `src/agent_mem/schema/` and need a migration test.
- Plugin manifests in `plugins/` must keep the package version (checked by tests).
- `viewer/` (the `agent-mem view` page) is loaded by the CLI only and follows the Agent Mem design book: colors, fonts and radii only through the tokens in the `:root` blocks of `app.css` (discs use 50%; checked by tests), every stored string escaped, no network access. `purge` must delete written pages.

## Development

```sh
uv sync --all-extras
uv run pytest
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

Before a release: CI green on Linux, macOS (arm64 and x64) and Windows; manually verify one real session per harness (capture, new session recall, recipe hint, compaction, uninstall).
