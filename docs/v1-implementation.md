# V1 implementation status

Agent Mem V1.0.0 is the standalone local capture and retrieval release. The legacy full-product repository is separate and is not part of this release.

## Verified local gates

Current local verification: `npm test` passes 279/279; package construction, manifest verification, and the self-contained macOS launcher smoke pass. The optional reranker-enabled probe uses the documented baseline fallback on this ARM64 host.

- `npm run build` passes on the current checkout.
- `npm test`: **279/279** focused V1 tests pass.
- The current package build with Node `v24.19.0` contains 3,942 files, is 600,800,046 bytes, and has manifest SHA-256 `cd1b70b4512347c6b8b3ee7854eaa66750e2119557f5b1bb36d43000b472c488`.
- Packaged retrieval probes pass with reranking disabled; the reranker-enabled probe passes through the documented baseline fallback when the local model cannot load.
- The package contains no generative provider SDK or UI runtime. Model artifacts are pinned and verified offline.
- The repository and release package carry the MIT License. Hosted Linux, macOS, and Windows package gates passed on `main`.

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

## Release boundary

- Codex Desktop and the Copilot app are outside the V1 release boundary.
- OpenCode sessions must run serially per repository because its upstream snapshot garbage collector uses a global lock.
- Linux, macOS, and Windows package gates passed on the hosted release workflow.
