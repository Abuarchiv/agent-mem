## What was wrong

<!-- What a user saw, or the measurement that called for the change. -->

## What changed

## Checks

- [ ] `uv run pytest -m "not local"`
- [ ] `uv run ruff check && uv run ruff format --check && uv run pyright`
- [ ] A bug fix comes with a test that fails without it
- [ ] What is found or given to agents changed: `uv run python bench/check.py`
