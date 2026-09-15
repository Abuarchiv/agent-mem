# Release checklist

## Build and package

- [x] `npm run models:verify` passes offline before packaging.
- [x] `npm ci` succeeds with no high/critical audit findings.
- [x] `npm test` passes with no skipped V1 tests.
- [x] `npm run package -- --output <new-directory>` succeeds.
- [x] Package manifest hashes, model manifests, and native sqlite-vec asset verify.
- [x] Package smoke passes with provider keys unset and runtime model downloads disabled.
- [ ] Select and include the project license before public publication.

## Functional gates

- [x] Capture → restart → recall returns the exact original source.
- [x] E5 failure falls back to FTS without losing capture.
- [x] Optional reranker failure falls back to baseline fusion.
- [x] Graph expansion remains bounded and scope/purge-safe.
- [x] `memory_write` stores and replaces only source-backed `agent_report` records.
- [x] Forget removes source, FTS, vectors, reports, and feedback without resurrection after restart.

## Host/platform gates

- [x] Codex CLI capture and fresh-session recall (Codex CLI `0.154.0`).
- [ ] Codex Desktop separately verified.
- [x] OpenCode capture and authenticated fresh-session recall trace (OpenCode `1.18.30`).
- [ ] Copilot CLI/app local worktree MCP capture behavior.
- [ ] Native Linux and Windows package smoke; do not infer them from macOS.

## Release discipline

Tag only when every checklist item is green. Keep the legacy repository and old vaults unchanged. Do not publish or push this local-only build without a separate release decision.
