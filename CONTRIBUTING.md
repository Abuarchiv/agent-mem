# Contributing

Read `AGENTS.md` first: it holds the binding rules (hook path is standard library only, single write paths, privacy, schema migrations, no AI attributions in commits). `docs/PLAN.md` is the design document; measurements go to its appendix B as new entries and are never edited afterwards.

## Setup

```sh
uv sync --all-extras
uv run pytest -m "not local"
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

Tests marked `local` need the observer extra and a cached embedding model. Run them by hand before a release:

```sh
uv run pytest -m local
```

Never run `uv sync` while a measurement is running against the same virtual environment.

## Testing the observer without a model

The provider `fake` answers from a JSON file named in `AGENT_MEM_FAKE_LLM` (a list of answers, consumed in order) or, without the file, extracts one fact per user message. `tests/test_observe_worker.py` shows the pattern: set `config.observe.providers = ["fake"]`, drive turns through `hook.run`, run `Worker.run(drain=False)`, assert on `memories`, `observe_queue` and `observe_calls`.

## Changing the viewer

The page script is `src/agent_mem/ui/app.ts`. The package ships the built `app.js` next to it, so installs need no Node. After an edit, type-check and rebuild, and commit both files (CI fails if they differ):

```sh
npm install --no-save typescript@^7
npx tsc -p src/agent_mem/ui
```

## Changing the schema

Add a new numbered file in `src/agent_mem/core/schema/` and a migration test. Never edit an existing file.

## Changing the embedder or mem0

A new default embedder is a minor release: calibrate `retrieval.min_vector_score` (see `docs/PLAN.md` B.23 for the method), the worker rebuilds the mem0 index and the indexer re-embeds on first start. `mem0ai` is pinned; bump it only with `tests/test_observe*.py` green.

## Measurements

`agent-mem eval --fixture tests/fixtures/memory_cases.json --backend sqlite|mem0` and `agent-mem eval <longmemeval_s.json> --subset tests/fixtures/longmemeval_subset.json`. Reports go to `docs/evidence/runs/`; raw data from real sessions stays under `~/.cache/agent-mem/eval/`.

## Fixing a bug

From claude-mem's merge rubric (`docs/evidence/claude-mem-docs-13.36.1.md`), adopted here:

- Fix the cause where it is. A guard that catches the failure and carries on, a retry, a fallback path, a sweeper or a marker file leaves the failure in place and makes it quieter. Removing such machinery is welcome.
- No second system beside the one with the bug: no new background process, poller or environment switch that keeps the old behaviour available.
- The size of the change follows the size of the mistake: one wrong line is about one changed line plus its test.
- The test comes first and fails without the change. Name the exact command in the commit message, and say what was measured live and what was not (for example "checked against `claude -p` 2.x, Copilot not run").

Hooks still never block or crash the agent (`AGENTS.md` R2). That is the contract with the harness, not a way around a bug.

## Pull requests

Local commits only until the maintainer allows pushing. One topic per commit, plain commit messages, no generated attributions.
