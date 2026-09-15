# Compatibility boundary

Some deterministic store code remains because existing SQLite vaults contain historical schema versions:

- `src/extraction/` validates old source-linked candidate and verification records; it does not call a model.
- `src/execution/protocol.ts`, `types.ts`, `profile.ts` and `dispatch.ts` validate or digest historical execution records; they do not execute a provider.
- `src/store/` retains migrations and read/purge handling for historical extraction, derived and auth tables.
- `src/transfer/` and the pause helpers are deterministic maintenance/test utilities, not active host or LLM paths.

The V1 runtime never creates new extraction, summary, reflection or lesson artifacts. The package graph is checked separately from these compatibility modules, and no generative executor or provider SDK is bundled.
