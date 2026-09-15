# Security and privacy

Agent Memory V1 is designed for local-first use, but local storage is not automatically confidential. This document describes the current security boundary and its limitations.

## Data boundary

- The active V1 runtime does not call a generative model, provider API, subscription service, or telemetry endpoint.
- The service stores original host events, source spans, session metadata, local search indexes, embeddings, and explicitly written source-backed reports.
- Captured content stays in the local vault unless a host later sends returned context to its own model provider.
- The default reader policy returns only `prompt` and `assistant_output` source classes. Tool input, tool output, and diagnostics remain local-only under the default service policy. Startup reconciles existing `reader:*` grants to this policy while preserving non-reader grants.
- Cloud-hosted sessions cannot reach the local vault through this repository.

## Protections

- Vault, configuration, connection credentials, search state, and the local IPC directory are required to be owned by the current user and private to that user.
- Existing vaults with unsafe permissions or symlinked paths are rejected before opening.
- Host-to-broker communication uses an authenticated local TLS-PSK channel and a fixed workspace binding.
- Capture applies bounded JSON validation and redacts private blocks and known credential formats before persistence.
- Search and MCP egress are scope-bound, grant-bound, size-bounded, and revalidated before delivery.
- Models are bundled or loaded from hash-verified local artifacts; runtime model loading disables remote model discovery.

## Important limitations

- SQLite is not encrypted at rest. Anyone who can read the user account, the vault directory, an operating-system backup, or a manually copied backup can read the stored content.
- Redaction is not a complete data-loss-prevention system. Use the host's private-content markers and do not submit credentials or other secrets to a host session merely because capture is local.
- `memory_forget` removes managed source data and indexes, but it cannot erase copies made by the operating system, backup software, filesystem snapshots, or another process.
- A host model can still receive any context that the host itself chooses to send. Local storage therefore does not guarantee that a provider will never see a recalled source.
- The first upgraded startup changes reader-grant policy and advances the scope privacy epoch. In-flight recall packets are therefore revalidated instead of silently reusing the old grant set.
- Native Codex Desktop, Copilot, Windows, and Linux release paths remain separate verification gates until recorded in the release checklist.

## Repository hygiene

Never commit vaults, WAL/SHM files, connection files, model caches, logs, API keys, tokens, or private keys. The public source repository and a user's private runtime data are separate security boundaries.

## Reporting a vulnerability

Do not open a public issue containing credentials, private source text, exploit details, or a reproducible vault. Report security issues privately to the repository owner and include the affected version, platform, minimal reproduction, and whether any data was exposed. Rotate any credential that appeared in a report before sharing further details.
