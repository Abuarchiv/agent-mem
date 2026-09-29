# Agent Mem

Local, self-learning memory shared by **Claude Code, Codex, GitHub Copilot CLI and OpenCode**.

Agent Mem records what your agents do through their hooks, learns from it, and gives every agent the relevant part of that history at the right moment. It makes **no LLM calls of its own** and has no daemon, no server and no open ports: one SQLite file on your machine.

## What it does

| Moment | What happens automatically |
|---|---|
| Session start | A short briefing: commands that work in this project, decisions, dead ends, preferences, unresolved errors, the last session. |
| You send a prompt | Up to three matching memories, only when the match is strong. |
| Before a command or edit | A warning if it matches something you corrected before or a change that was reverted. Optionally a hard block (opt-in rules). |
| A command fails | If this error was fixed before, the agent sees how. |
| Turn ends | The turn (request, actions, result) is stored and indexed. |
| Context compaction | The session goal, decisions and open problems are re-injected. |

All harnesses write into the same memory, so what Claude Code learned is available to Codex and vice versa. Notes that Claude Code and Codex write themselves (auto memory / memories) are read in as well.

### How it learns (without an LLM)

- **Activation (ACT-R):** memories that are used often and recently rank higher; unused ones fade but are never deleted.
- **Implicit feedback:** a recalled memory counts as useful when the agent opens it, edits its files, or cites its id.
- **Error → fix recipes:** a failing command, followed by edits and the same command passing, becomes a recipe.
- **Corrections → rules:** "pnpm statt npm" / "use pnpm instead of npm" becomes a proposed rule; after enabling, `npm` is blocked with the reason shown to the agent.
- **Dead ends:** reverted changes (`git checkout --`, `git restore`, `git reset --hard`) become warnings for the same files.
- **Association graph:** files, commands, errors and packages that occur together are linked (Hebbian learning) and searched with Personalized PageRank.
- **Consolidation:** once a day in the background, edges decay, repeated preferences become global, outdated facts are superseded and memories anchored to deleted files are invalidated.

Search combines SQLite FTS5, optional multilingual E5 embeddings, and the graph, fused with reciprocal rank fusion. Time words such as "gestern" or "last week" filter by date.

## Install

Requirements: macOS, Linux or Windows and Python 3.11–3.14. [uv](https://docs.astral.sh/uv/) installs a suitable Python automatically.

```sh
curl -LsSf https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.sh | sh
# Windows: irm https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.ps1 | iex
```

or directly:

```sh
uv tool install "agent-mem[semantic] @ git+https://github.com/Abuarchiv/agent-mem"
```

Then connect your harnesses:

```sh
agent-mem setup claude     # Claude Code plugin (hooks + MCP)
agent-mem setup codex      # Codex plugin or hooks.json + config.toml
agent-mem setup copilot    # Copilot CLI plugin
agent-mem setup opencode   # OpenCode plugin + MCP entry
agent-mem models install   # optional: E5 model (~135 MB) for semantic search
agent-mem doctor
```

`agent-mem` must be on your `PATH` because the hooks call it.

Bring in history from before the install:

```sh
agent-mem import claude            # ~/.claude/projects/*/*.jsonl
agent-mem import codex             # ~/.codex/sessions/**/*.jsonl
agent-mem import claude-mem ~/.claude-mem/claude-mem.db
agent-mem import agentmemory export.json
agent-mem import v1 "<old vault>.sqlite"
```

If you used claude-mem or agentmemory, disable them afterwards; otherwise hooks run twice and context is injected twice.

## Commands

```
agent-mem status | doctor [--fix]
agent-mem search "query" [--all-projects]      agent-mem show T12 M3
agent-mem rules [list|enable|disable|delete] [ID]
agent-mem lessons                               # suggested lines for AGENTS.md / CLAUDE.md
agent-mem pause [--for 2h] | resume
agent-mem export --json | purge --id|--project|--before|--all
agent-mem backup | restore [--latest]
agent-mem consolidate | index | eval <longmemeval.json>
```

MCP tools for agents: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`.

To browse the data, open the database (`agent-mem paths`) with `datasette` or DB Browser for SQLite.

## Configuration

`config.json` in the data directory (see `agent-mem paths`). Invalid values fall back to defaults and show up in `agent-mem doctor`. Main keys:

```json
{
  "capture": true,
  "excluded_projects": ["/path/to/private/repo"],
  "exclude_globs": [".env", ".env.*", "*.pem", "secrets/**"],
  "budgets": {"session_start": 600, "prompt": 200, "failure": 120, "warning": 80, "compact": 400},
  "rules": {"auto_enable": false, "min_corrections": 2},
  "retention": {"payload_days": 30, "backup_keep": 7, "max_db_mb": 1024},
  "semantic": {"enabled": true},
  "summarize": {"enabled": false, "harness": "claude", "daily_limit": 5}
}
```

Per project, `.agent-mem.json` in the repository root can set `{"capture": false}` or extra `"exclude"` globs.

`summarize.enabled` is the only setting that causes generative model calls: once per finished session, in the background, through the harness you already use (`claude -p` or `codex exec`). It is off by default.

## Privacy and security

- Everything stays local. There is no telemetry. The only network access is the optional model download.
- Secrets are redacted before storage (API keys, tokens, private keys, passwords in assignments and URLs). `<private>…</private>` is never stored. Excluded files are recorded by path only.
- Recalled text is framed as data, not instructions. Content from web tools and third-party MCP servers is never injected automatically and never becomes a rule or preference.
- The database is **not encrypted at rest**. The data directory is created with owner-only permissions on macOS and Linux.
- `purge` removes data from the database, the backups and the spool.

See [SECURITY.md](SECURITY.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
uv sync --all-extras
uv run pytest
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

## License

MIT
