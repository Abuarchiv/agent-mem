# Changelog

## 1.0.0 — 2026-09-16

### Added

- Local capture of coding-agent sessions with source provenance in SQLite.
- Bounded lexical, semantic, graph, and optional local reranker retrieval.
- stdio MCP and local IPC interfaces for Codex CLI, OpenCode CLI, and Copilot CLI configuration.
- Checksum-verified native packages for macOS, Linux, and Windows.

### Release boundary

- Codex Desktop and the Copilot app are not part of V1.
- OpenCode sessions must run serially per repository because of an upstream snapshot garbage-collection lock.
