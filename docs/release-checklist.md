# Release checklist

## Build and package

- [x] `npm run models:verify` passes offline before packaging.
- [x] `npm ci` succeeds with no high/critical audit findings.
- [x] `npm test` passes with no skipped V1 tests.
- [x] `npm run package -- --output <new-directory>` succeeds.
- [x] Package manifest hashes, model manifests, and native sqlite-vec asset verify.
- [x] Package smoke passes with provider keys unset and runtime model downloads disabled; the package bundles and relinks the macOS Node runtime dependencies.
- [x] MIT License is present in the repository and copied into release packages.

## Functional gates

- [x] Capture → restart → recall returns the exact original source.
- [x] E5 failure falls back to FTS without losing capture.
- [x] Optional reranker failure falls back to baseline fusion.
- [x] Graph expansion remains bounded and scope/purge-safe.
- [x] `memory_write` stores and replaces only source-backed `agent_report` records.
- [x] Forget removes source, FTS, vectors, reports, and feedback without resurrection after restart.

## Host/platform gates

- [x] Codex CLI capture and fresh-session recall (Codex CLI `0.154.0`).
- [x] Codex Desktop is explicitly outside the V1 release boundary.
- [x] OpenCode capture and authenticated fresh-session recall trace (OpenCode `1.18.30`).
- [x] Copilot CLI/app runtime capture is explicitly outside the V1 release boundary.
- [x] Native Linux and Windows package smoke passed in the hosted release-gate workflow.
- [x] Required Linux/Windows release-gate workflow passed before tagging.
- [x] OpenCode's upstream snapshot-lock limitation is documented; V1 requires serial sessions per repository.

## Release discipline

Release verification completed on `main`: local Node 24 tests pass, and the hosted Linux, macOS, and Windows CI/release gates pass. The V1.0.0 tag is the immutable release source.

Tag only when every checklist item is green. Keep the legacy repository and old vaults unchanged. The V1.0.0 release is built from this `main` commit.
