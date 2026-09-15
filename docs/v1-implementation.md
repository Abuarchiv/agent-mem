# V1 implementation status

This is the standalone V1 line; the legacy full-product repository is separate and was not modified.

## Verified local gates

- `npm run build` passes on the current checkout.
- `npm test`: **269/269** focused V1 checks pass.
- The embedded Node `v24.20.0` package contains 3,921 files, is 607,691,762 bytes, and has manifest SHA-256 `48a0eaa106e7e22037005dc84aa3869a9e450e3116f4d9963cedd0bed2ea0a7d`.
- Packaged retrieval probes pass with reranking disabled and with the local cross-encoder enabled. They cover restart, source-backed write/replacement, bounded graph search, feedback, purge, and exact-source retrieval.
- The package contains no generative provider SDK or UI runtime. Model artifacts are pinned and verified offline.

## Native host evidence (15 September 2026)

### Codex CLI

Verified with Codex CLI `0.154.0` and the standalone package:

1. After the normal project-hook trust decision, a real Codex session wrote `SessionStart`, `UserPromptSubmit`, and `Stop` source events to the V1 vault.
2. A unique prompt was captured, the memory service was stopped and restarted, and a new Codex session received the exact prior source; the controlled probe returned `RECALL_OK`.

The temporary exact project-trust entry used for this probe was removed again. No hook-trust bypass is part of the product configuration.

### OpenCode CLI

Verified with OpenCode `1.18.30` and the standalone package:

1. A real `opencode run` wrote native user and assistant parts plus the session-idle event to the V1 vault.
2. After a service restart, the native transform path produced an authenticated `query_trace` whose candidate/output set contained the exact earlier assistant text. Direct MCP recall returned the same source verbatim.

The model's final echo was deliberately not used as acceptance evidence: the probe token was also present in the new user prompt, so a model response can guess the answer. The durable acceptance signal is the authenticated recall trace and exact source provenance.

## Remaining release gates

- Codex Desktop has not been separately executed.
- Copilot is not installed on the test machine; no Copilot execution claim is made.
- Native Windows and Linux package smoke has not been run on this macOS host.
- The release checklist must remain open until those host/platform gates are independently executed.

No release tag or push was created. Old repositories, old RC artifacts, and old vaults remain untouched.
