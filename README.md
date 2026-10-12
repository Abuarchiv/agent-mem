# Agent Mem

One local memory for **Claude Code, Codex, GitHub Copilot CLI and OpenCode**.

Agent Mem records what your coding agents do through their native hooks, turns it into facts in the background, and gives every agent the relevant part of that history at the right moment. No telemetry, no server, no open ports, no API key: one SQLite file plus a small vector index on your machine. Model calls for fact extraction go through the harness CLI you are already logged into.

## Install

```sh
uv tool install "agent-mem[semantic,observer]"      # or: pipx install "agent-mem[semantic,observer]"
agent-mem setup claude --write                      # also: codex, copilot, opencode
agent-mem doctor
```

`setup --write` registers the hooks and the MCP server with the **absolute path** of the binary, so sessions started from an IDE find it too. It downloads the embedding model (about 220 MB) and prints what it detected: harnesses, providers, extras. Start a session, finish one turn, and the next session begins with the facts from the first.

Alternatives: `curl -LsSf https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.sh | sh` (installs uv first), the Claude Code marketplace (`/plugin marketplace add Abuarchiv/agent-mem`, `/plugin install agent-mem@agent-mem`), or `agent-mem setup <harness>` without `--write` to see the manual steps.

Three sizes:

| Install | Size | You get |
| --- | --- | --- |
| `agent-mem` | about 10 MB | capture, full-text search, context injection, MCP server, raw turn summaries |
| `agent-mem[semantic]` | plus 220 MB model | vector search (`paraphrase-multilingual-MiniLM-L12-v2`, ONNX, no PyTorch) |
| `agent-mem[semantic,observer]` | plus about 400 MB | background facts, contradiction handling, deduplication (mem0, Qdrant local mode, spaCy) |

Uninstall with `agent-mem uninstall <harness>` (removes hooks and MCP entries, keeps data) and `agent-mem purge --all` (deletes data).

## What it does

| Moment | What happens |
| --- | --- |
| Session start | A short briefing: facts about this project, commands that work, decisions, dead ends, preferences, the last session, oldest first so an update reads as one. Claude Code shows one line in your terminal: `agent-mem: 5 items injected (~310 tokens)`. |
| You send a prompt | Up to three matching memories, only when the match is strong (lexical, no model call; question words do not count). Claude Code shows which ones: `agent-mem: 2 items injected (M3, T7; ~80 tokens)`. |
| Before a command or edit | A warning if it matches something you corrected before or a change that was reverted. Optional hard block (opt-in rules). |
| A command fails | If this error was fixed before, the agent sees how. |
| Turn ends | The turn is stored. A detached worker extracts facts from it in the background and exits when the queue is empty. |
| Context compaction | Session goal, decisions and open problems are re-injected (Claude Code, Codex) or added to the compaction prompt (OpenCode). |

All harnesses write into the same memory. What Claude Code learned is available to Codex and vice versa.

### Facts, without an API key

After each turn the Stop hook starts `agent-mem observe` as a detached process. The worker bundles up to five turns of a session, runs mem0's extraction with a prompt tuned for coding work (conventions, decisions, dead ends, preferences; no generic knowledge, no secrets, in your language), and stores the facts in SQLite with a mirror in a local Qdrant index. Each fact is tagged as decision, rule, dead end or fact; a rule written as "Use pnpm instead of npm" becomes the same rule as a typed correction. Final answers of subagents are part of the bundle. For every new fact it checks similar old facts once per bundle and asks the model: KEEP, SUPERSEDE or DUPLICATE. A correction such as "we switched from pytest to nox" invalidates the old fact and removes it from the index.

The model is the CLI you already pay for, started under your login with no tools, no MCP servers and no settings:

| Turn came from | Model stage | Command |
| --- | --- | --- |
| Claude Code | Claude (Haiku) | `claude -p --restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --model haiku` |
| Codex | Codex | `codex exec --ephemeral --ignore-user-config -s read-only` |
| Copilot CLI | Copilot | `copilot -s` |
| OpenCode, or no CLI found | none | the turn is kept as a raw summary |

A turn never leaves its vendor (a Claude turn is not sent to OpenAI). Quota or login errors pause the stage for an hour; the turn stays queued. Ollama can be added as a local fallback stage (`"observe": {"providers": ["claude", "codex", "copilot", "ollama"]}`); it is off by default because local models load the machine. Measured on this project's fixtures: 9 of 10 corrections resolved, 1.9 model calls per bundle, hook overhead with the worker spawn 63 ms p95 (see `docs/PLAN.md`, appendix B).

### How ranking learns (no model needed)

- **Activation (ACT-R):** memories used often and recently rank higher; unused ones fade but are never deleted.
- **Implicit feedback:** a recalled memory counts as useful when the agent opens it, edits its files or cites its id.
- **Error to fix recipes:** a failing command, edits, the same command passing: that becomes a recipe.
- **Corrections to rules:** "use pnpm instead of npm" (typed, or extracted by the worker) becomes a proposed rule: a note before the next `npm` command; enabled, it blocks `npm` with the reason shown to the agent.
- **Dead ends:** reverted changes become warnings for the same files.
- **Association graph:** files, commands, errors and packages that occur together are linked and searched with Personalized PageRank.
- **Consolidation:** daily, in the background: decay, global preferences, superseding, stale anchors.

Search fuses SQLite FTS5, MiniLM vectors and the graph with reciprocal rank fusion. Time words such as "gestern", "last week", "8. April" or "April 8th 2026" rank the turns of that time first.

## Commands

```
agent-mem status [--json] | doctor [--fix] [--json] | paths
agent-mem setup <harness> [--write] [--no-models] | uninstall <harness>
agent-mem observe [--drain] [--once] [--status] [--retry-failed] [--reprocess-raw] [--reindex]
agent-mem search "query" [--project DIR] [--all-projects] [--limit N] [--json]
agent-mem show T12 M3 | view [--project DIR] [--output FILE] [--no-open]
agent-mem rules [list|enable|disable|delete] [ID] | lessons
agent-mem pause [--for 2h] | resume
agent-mem export [--project DIR] [--output FILE]
agent-mem purge --id ID | --project DIR | --before DATE | --all  [--yes]
agent-mem backup | restore [FILE | --latest] | consolidate | index [--no-download]
agent-mem models [status|install]
agent-mem eval <longmemeval.json> [--subset FILE] [--backend sqlite|mem0] | eval --fixture FILE
```

MCP tools for agents: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`. `mem_forget` removes a fact from SQLite and from the vector index.

## Configuration

`config.json` in the data directory (`agent-mem paths`). Invalid values fall back to defaults and show up in `agent-mem doctor`.

```json
{
  "capture": true,
  "excluded_projects": ["/path/to/private/repo"],
  "exclude_globs": [".env", ".env.*", "*.pem", "secrets/**"],
  "budgets": {"session_start": 600, "prompt": 200, "failure": 120, "warning": 80, "compact": 400},
  "semantic": {"enabled": true, "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"},
  "observe": {
    "enabled": true,
    "providers": ["claude", "codex", "copilot"],
    "cross_vendor": false,
    "claude_model": "haiku",
    "daily_limit": 300,
    "bundle_turns": 5,
    "bundle_tokens": 6000
  }
}
```

`observe.enabled: false` stops all model calls; turns are still captured and searchable. `cross_vendor: true` lets any installed stage handle any turn. Per project, `.agent-mem.json` in the repository root can set `{"capture": false}` or extra `"exclude"` globs.

## Privacy and security

- **No network except model downloads.** No telemetry; mem0's telemetry is switched off and verified by a test. The only outbound traffic is your harness CLI talking to its own provider, under your login.
- Secrets are redacted before storage (API keys, tokens, private keys, passwords in assignments and URLs). `<private>…</private>` is never stored. Excluded files are recorded by path only. Output of web tools and third-party MCP servers never enters a bundle.
- The extraction process runs in an empty temporary directory with `AGENT_MEM_INTERNAL=1`, so its own session is never captured.
- Recalled text is framed as data, not instructions. Facts never become rules or preferences by themselves.
- The database is **not encrypted at rest**. The data directory is created with owner-only permissions on macOS and Linux.
- `purge` deletes matching data from SQLite, the vector index, the spool and all backups.

See [SECURITY.md](SECURITY.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Support matrix

| | Status |
| --- | --- |
| Python | 3.11 to 3.14 |
| OS | Ubuntu, macOS arm64, macOS Intel (no fastembed wheels: lexical and graph search only), Windows |
| Harnesses tested | Claude Code 2.x, Codex CLI 0.x, Copilot CLI 1.0.95, OpenCode 1.18 |
| CI | lint, types, tests, wheel smoke test on all four OS |

Harness notes: Codex asks you to trust plugin hooks once (`/hooks`). Copilot CLI ignores extra context after a successful tool call ([copilot-cli#2980](https://github.com/github/copilot-cli/issues/2980)). Run OpenCode sessions serially per repository.

## Development

```sh
uv sync --all-extras
uv run pytest -m "not local"
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Design decisions and every measurement live in `docs/PLAN.md`.

## License

MIT
