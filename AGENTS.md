# Agent Memory V1

This repository is the standalone production V1. The legacy full-product repository is outside this checkout and must not be reintroduced here.

## Product boundary

- Local source capture, SQLite/FTS5, bundled multilingual E5, optional local cross-encoder ranking, bounded structural search, explicit feedback, source-backed reports, purge and restart recovery.
- stdio MCP plus private local IPC.
- Codex, OpenCode and local GitHub Copilot CLI/app worktrees.
- No generative LLM, provider API, API-key login, subscription executor, extraction job, summary/reflection/lesson generator, UI or HTTP server.

`memory_write` is an explicit host operation. It stores a source-backed `agent_report`; it is not background extraction and is not automatic truth verification.

## Engineering rules

- Keep capture/retrieval functional without network access or provider credentials.
- Preserve original source text and provenance; never replace evidence with an inferred summary.
- Keep graph, reranking and feedback deterministic, bounded and fail-safe.
- Treat old extraction/execution tables as compatibility data only. Do not add new generated artifacts.
- Make one small change, run `npm test`, inspect the diff, then commit it.
- Do not modify the legacy repository, user vaults or host credentials from this checkout.

## Release gates

Run with Node 24.20.x:

```sh
npm ci
npm test
npm run package -- --output /absolute/new/directory
```

The package must start without provider keys and with network disabled. Native host and Windows/Linux runs are separate evidence; do not infer them from macOS tests.
