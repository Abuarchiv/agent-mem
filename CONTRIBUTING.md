# Contributing

Bug reports, fixes and measurements are welcome. Open an issue first for larger changes, so the
approach can be agreed before the work.

## Set up

```sh
git clone https://github.com/Abuarchiv/agent-mem && cd agent-mem
uv sync --all-extras
git config core.hooksPath .githooks   # commit message check, retrieval measurement before a push
```

## Before you commit

```sh
uv run pytest -m "not local"
uv run ruff check && uv run ruff format --check && uv run pyright
```

- A bug fix comes with a test that fails without the fix.
- A change to what is found or given to agents runs `uv run python bench/check.py`; the pre-push
  hook does it for you. It measures on a frozen copy of your local agent-mem database and skips
  without one.
- Tests marked `local` need the observer extra and a cached embedding model; they run by hand
  before a release.

## Commits and pull requests

One logical change per commit. The subject reads `area: what changed`, in English, imperative, at
most 72 characters; the body says why. `.githooks/commit-msg` checks the form.

Pull requests target `main` and fill in the template. CI runs on Linux, macOS (arm64, Intel) and
Windows and must be green.

The binding rules for the code (hook path, write paths, privacy, schema changes) are in
[AGENTS.md](AGENTS.md); the design is in [ARCHITECTURE.md](ARCHITECTURE.md).
