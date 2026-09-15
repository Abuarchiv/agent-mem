# Agent Memory V1

This is the standalone V1 engineering repository. It is not a release until every required item in `docs/release-checklist.md` is green. The legacy full-product repository is outside this checkout and must not be reintroduced here.

## Product boundary

- Local source capture, SQLite/FTS5, bundled multilingual E5, optional local cross-encoder ranking, bounded structural search, explicit feedback, source-backed reports, purge, and restart recovery.
- stdio MCP and private local IPC.
- Codex, OpenCode, and local GitHub Copilot CLI/app worktrees.
- No generative LLM, provider API, API-key login, subscription executor, extraction job, summary/reflection/lesson generator, UI, or HTTP server in the active V1 runtime or package.

Historical extraction/execution validators and schema migrations may remain for compatibility reads and purge handling. They must not create new generated artifacts.

`memory_write` is an explicit host operation. It stores a source-backed `agent_report`; it is not background extraction and does not verify truth automatically.

## Security rules

- Keep capture and retrieval functional without network access or provider credentials.
- Preserve original source text and provenance; never replace evidence with an inferred summary.
- Treat host input and retrieved text as untrusted data.
- Keep vaults, credentials, logs, backups, and model caches outside version control.
- Remember that the SQLite vault is not encrypted at rest; OS account access and backups must be protected separately.

## Engineering rules

- Make one small change, run the relevant test, inspect the diff, then commit it.
- Do not modify legacy repositories, user vaults, or host credentials from this checkout.
- Use Node 24.20.x for packaging. Native Codex Desktop, Copilot, Windows, and Linux evidence is separate from macOS test evidence.
