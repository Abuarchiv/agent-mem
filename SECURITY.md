# Security and privacy

Agent Mem stores data locally. Local storage is not automatically private.

## Data flow

- V1 does not call a generative model, provider API, subscription service, or telemetry endpoint.
- It stores host events, source spans, sessions, indexes, embeddings, and explicit source-linked reports.
- The default reader policy returns only prompt and assistant-output sources. Tool input, tool output, and diagnostics stay local.
- A host can send recalled text to its own provider.

## Protections

- Vaults, config files, credentials, search state, and IPC paths must be owned by the current user and private.
- Symlinks and unsafe vault permissions are rejected.
- Host-to-broker traffic uses an authenticated local TLS-PSK channel.
- Capture validates bounded JSON and redacts private blocks and known credential formats.
- MCP output is scope-bound, grant-bound, size-bound, and rechecked before delivery.
- Model files are local and hash-verified. Remote model loading is disabled.

## Limits

- SQLite is not encrypted at rest.
- Redaction does not prevent every data leak. Do not send secrets to a host session.
- `memory_forget` cannot erase OS backups, snapshots, or copies made by another process.
- Native Codex Desktop, Copilot, Windows, and Linux paths need separate verification.

Never commit vaults, WAL/SHM files, connection files, model caches, logs, API keys, tokens, or private keys.
