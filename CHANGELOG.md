# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

First public version in preparation.

### Added

- Shared memory for Claude Code, Codex, Copilot CLI and OpenCode: requests, answers, commands and
  changed files are recorded through each agent's hooks or plugin.
- Session briefing, matching memories per request, warnings before commands that failed before.
- Facts written in the background through the agent CLI you already use; no API key.
- Search by words, by meaning (optional multilingual model) and by topic graph; MCP tools
  `mem_search`, `mem_get`, `mem_remember`, `mem_forget`, `mem_timeline`.
- Local viewer at `http://localhost:37778`, `agent-mem doctor` with fixes, `upgrade`, `purge`,
  `export`.
- Install scripts for macOS, Linux and Windows, and a Docker image.
