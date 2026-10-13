# Working in this repository

Binding rules for every agent and contributor.

- **R1 Boundary.** No network service except the read-only viewer (`agent-mem serve`): loopback
  only, GET only, foreign Host headers rejected (SECURITY.md). Nothing else listens on a port. Generative model calls are made only by the `observe` worker, always with `AGENT_MEM_INTERNAL=1` so the child session is never captured.
  Agent Mem goes online only to download models.
- **R2 Hook path.** `core/*`, `hooks/*` and the `memory` modules they use (`store`, `search`,
  `learn`) import only the standard library. mem0, qdrant, fastembed, numpy, dateparser and mcp are imported lazily outside the
  hook path (`tests/test_observe.py` checks this). Hooks never block or crash the agent: deadline,
  spool on error, silent output on error.
- **R3 Write paths.** Events are written only through `capture.apply` (live hooks, spool replay,
  imports), idempotent via dedupe keys. Memories only through `store.add_memory`, which cleans title
  and body. Facts from the observer carry `dedupe_key = mem0:<id>`.
- **R4 Privacy.** Everything stored passes `privacy.clean_text`. Raw host payloads are never stored.
  Runtime data, credentials, logs, backups and model caches live outside git. Raw measurement data
  from real sessions stays under `~/.cache/agent-mem/eval/`, never in `docs/evidence/runs/`.
- **R5 Trust.** Host input and retrieved text are untrusted; injected context is framed as data.
  External content (`tool_external`) is never injected automatically, never becomes a rule or
  preference, and never enters an observer bundle. Rules and preferences come only from the user's
  prompts. Packets stay within `config.Budgets`.
- **R6 Schema.** Every schema change is a new numbered file in `src/agent_mem/core/schema/` with a
  migration test.
- **R7 Plugins.** Manifests in `plugins/` carry the package version (a test checks this).
- **R8 Viewer.** `ui/` (the `agent-mem view` page) is loaded only by `cli/`, escapes every stored string; `purge` deletes
  written pages. The page script is `ui/app.ts`, erasable TypeScript only; the package build turns it into `app.js` (`hatch_build.py`), which is never committed. No JavaScript in the repository.
- **R9 Development.** `uv sync --all-extras`, `uv run pytest -m "not local"`, `uv run ruff check src
  tests && uv run ruff format --check src tests && uv run pyright`. Tests marked `local` need the
  observer extra and a cached embedding model; run them by hand before a release. `uv.lock` is
  committed so pins are reproducible. Never run `uv sync` while a measurement is running against the
  same venv. Before a release: CI green on Linux, macOS (arm64, x64) and Windows, plus one real
  session per harness by hand (capture, recall in a new session, compaction, uninstall).
- **R10 Git.** Local commits only, no push, no releases, until the user explicitly allows it. No AI
  attributions in commits, PRs, tags or files. Never commit the user's own uncommitted deletions or
  edits in the working tree; stage explicit paths.
