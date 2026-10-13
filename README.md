# Agent Mem

One local memory for **Claude Code, Codex, GitHub Copilot CLI and OpenCode**.

Agent Mem records what your coding agents do, writes short facts from it in the background, and reminds every agent of what matters at the right moment. Nothing leaves your computer: no telemetry, no cloud, no API key. Everything sits in one database file on your machine, and you can browse it at `http://localhost:37778`. To write facts, Agent Mem uses the agent's own command-line tool you are already logged into.

## Install

```sh
uv tool install "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"
agent-mem setup all --write                         # every agent installed here; or one: claude, codex, copilot, opencode
agent-mem doctor
```

agent-mem is not on PyPI; install it from the repository, never by its bare name (a package registered there under that name would not be ours). `pipx install "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"` works too.

`setup --write` connects each agent (hooks and MCP server) with the **full path** of the `agent-mem` command, so sessions started from an editor find it too. It downloads the search model (about 220 MB) and prints what it found. Start a session, send one request, and the next session begins with what the first one learned.

Alternatives: `curl -LsSf https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.sh | sh` (installs uv first; on Windows in PowerShell: `irm https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.ps1 | iex`), the Claude Code marketplace (`/plugin marketplace add Abuarchiv/agent-mem`, `/plugin install agent-mem@agent-mem`; the plugin only registers the hooks, so install the `agent-mem` command first with the `uv tool install` line above and skip `setup --write`, or every hook fails with "command not found"), or `agent-mem setup <agent>` without `--write` to see the steps to do by hand.

Three sizes:

| Install | Size | You get |
| --- | --- | --- |
| `agent-mem` | about 10 MB | recording, search by words, reminders for the agent, MCP server, requests saved word for word |
| `agent-mem[semantic]` | plus 220 MB model | search by meaning (`paraphrase-multilingual-MiniLM-L12-v2`, ONNX, no PyTorch) |
| `agent-mem[semantic,observer]` | plus about 400 MB | background facts, work log, lessons, daily review of duplicates and outdated facts (mem0, Qdrant local mode, spaCy) |

Update with `agent-mem upgrade` (`--extras observer` adds an extra): it installs the newest commit of the source you installed from (extras kept), downloads a model the new release needs, then runs `agent-mem doctor --fix`, which migrates the database and rewrites hooks that an older release wrote (Codex asks you to trust changed hooks once more with `/hooks`). Running the install script again does the same. On a fresh machine the script also runs `agent-mem setup all --write` (every agent installed here; `agent-mem uninstall all` undoes it). Avoid `uv tool install --reinstall`: it deletes the environment first, and hooks firing in those seconds find no binary.

Uninstall with `agent-mem uninstall <agent>` (removes hooks and MCP entries, keeps data) and `agent-mem purge --all` (deletes data). To remove everything, run `agent-mem uninstall all`, then `agent-mem purge --all`, then `uv tool uninstall agent-mem`; removing the tool first leaves hooks that call a missing binary on every event.

## What it does

| Moment | What happens |
| --- | --- |
| Session start | A short briefing: facts about this project, commands that work, decisions, failed attempts, preferences, and the last session with what was done and what is still open, oldest first so an update reads as one. Claude Code and Codex show a panel in your terminal: the project's memory size, which model turns your requests into facts (or why none does), the recent work (time, type, title), what the agent was given (grouped by day, with ids), anything that needs your attention, and the viewer address. Copilot CLI and the Copilot app show the same panel, uncoloured, as progress lines in their timeline, and a short summary when a session ends. |
| You send a request | Matching memories, only when the match is strong (search by words, no model call; question words do not count). The terminal stays quiet. |
| Before a command or edit | A warning if it matches something you corrected before or a change that was reverted. Optional hard block (opt-in rules). |
| A command fails | If this error was fixed before, the agent sees how. |
| The agent finishes a request | The request is saved. A background process writes facts from it, gives it a type and a title, updates the session summary (learned, done, next steps), writes a lesson when something went wrong and was fixed or you corrected the agent, and stops when nothing is left to do. |
| Once a day | The background process reads all facts and lessons of a project and removes duplicates and facts that a newer one replaced. Your own notes are never touched. A newer fact and an older one it contradicts are both shown with dates until then; the agent reads the newer one as current. |
| Context compaction | Session goal, decisions and open problems are given to the agent again (Claude Code, Codex) or added to the compaction prompt (OpenCode). Claude Code shows the panel again. |
| Session ends | Claude Code and Copilot show what was saved: requests, files, errors. |
| Something breaks | Claude Code and Codex show it in the terminal right away (at most every ten minutes per failure) with the command that helps, usually `agent-mem doctor`. |

All agents write into the same memory. What Claude Code learned is available to Codex and vice versa.

### Facts, without an API key

After each request the Stop hook starts `agent-mem observe` in the background. It takes up to five requests of a session at a time, runs mem0's extraction with a prompt tuned for coding work (conventions, decisions, failed attempts, preferences; no generic knowledge, no secrets, in your language), and stores the facts in SQLite with a mirror in a local Qdrant index. Each fact is tagged as decision, rule, failed attempt or fact; a rule written as "Use pnpm instead of npm" becomes the same rule as a typed correction. Final answers of subagents are part of the bundle. For every new fact it checks similar old facts once per bundle and asks the model: KEEP, SUPERSEDE or DUPLICATE. A correction such as "we switched from pytest to nox" invalidates the old fact and removes it from the index.

The model is the CLI you already pay for, started under your login with no tools, no MCP servers and no settings:

| Request came from | Model | Command |
| --- | --- | --- |
| Claude Code | Claude Haiku | `claude -p --restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence --model haiku` |
| Codex | GPT-6-Luna, low effort | `codex exec --ephemeral --ignore-user-config -s read-only -m gpt-6-luna -c model_reasoning_effort=low` |
| Copilot CLI | Auto, efficiency tier (resolves to GPT-6-Luna) | `copilot -s --model auto --auto-tier efficiency` |
| OpenCode, or no CLI found | none | the request is saved word for word |

A request never leaves its vendor (a Claude request is not sent to OpenAI). Each uses the cheapest model of its CLI (as of 2026-10-12). If your plan does not offer that model, it tries once more with the CLI's own default. With only one CLI installed, its requests get facts and the others are saved word for word; with all three, each request goes to the CLI it came from. A usage limit or a missing login pauses facts for an hour; the request waits. Ollama can be added as a local fallback (`"observe": {"providers": ["claude", "codex", "copilot", "ollama"]}`); it is off by default because local models load the machine. Measured on this project's fixtures: 9 of 10 corrections resolved, 1.9 model calls per bundle, hook overhead with the worker spawn 63 ms p95 (see `docs/PLAN.md`, appendix B).

### How ranking learns (no model needed)

- **Activation (ACT-R):** memories used often and recently rank higher; unused ones fade but are never deleted.
- **Implicit feedback:** a recalled memory counts as useful when the agent opens it, edits its files or cites its id.
- **Error to fix recipes:** a failing command, edits, the same command passing: that becomes a recipe.
- **Corrections to rules:** "use pnpm instead of npm" (typed, or extracted by the worker) becomes a proposed rule: a note before the next `npm` command; enabled, it blocks `npm` with the reason shown to the agent.
- **Failed attempts:** reverted changes become warnings for the same files.
- **Association graph:** files, commands, errors and packages that occur together are linked and searched with Personalized PageRank.
- **Cleanup:** daily, in the background: old unused memories rank lower, preferences that hold everywhere become global, replaced facts are retired.

Search fuses SQLite FTS5, MiniLM vectors and the graph with reciprocal rank fusion. Time words such as "gestern", "last week", "8. April" or "April 8th 2026" rank the requests of that time first.

### Tokens: what reading costs against what finding out took

Like claude-mem, Agent Mem compares what a memory costs the agent to read with the work it took to find it out. The work is measured, not estimated: after a request ends, the indexer reads the agent's own transcript (Claude Code's message `usage`, subagents included; Codex's `token_count` events) and stores the fresh tokens the agent spent on that request: input, cache writes and output. Cache reads are left out, because every step re-reads the whole context. A memory carries its request's share (the request's work divided by the memories it produced), so several memories of one request count that request once. Copilot requests are measured from `~/.copilot/session-state/<id>/events.jsonl`; OpenCode requests stay unmeasured.

- Terminal (session start): `Reading this: ~1,240 tokens · working it out again: ~86,000 tokens`, shown only when measured work stands behind it.
- `agent-mem status`: the same for the last 7 days, plus the total work the memory was built from.
- Viewer: a Tokens block on the overview, a line on the Health page, and `Work` in every request and memory detail.

This is a comparison, not a measured saving: nobody knows how much of that work an agent would have repeated without the memory.

## Commands

```
agent-mem status [--json] | doctor [--fix] [--json] | paths
agent-mem setup all|<agent> [--write] [--no-models] | uninstall all|<agent> | upgrade [--extras ...]
agent-mem observe [--drain] [--once] [--status] [--retry-failed] [--reprocess-raw] [--reindex]
agent-mem search "query" [--project DIR] [--all-projects] [--limit N] [--json]
agent-mem show T12 M3 | view [--project DIR] [--output FILE|FOLDER] [--no-open]
agent-mem serve [--quiet] [--autostart | --no-autostart]
agent-mem rules [list|enable|disable|delete] [ID] | lessons
agent-mem pause [--for 2h] | resume
agent-mem export [--project DIR] [--output FILE]
agent-mem purge --id ID | --project DIR | --before DATE | --all  [--yes]
agent-mem consolidate | index [--no-download]
agent-mem models [status|install]
agent-mem eval <longmemeval.json> [--subset FILE] [--backend sqlite|mem0] | eval --fixture FILE
```

MCP tools for agents: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`. `mem_forget` removes a fact from SQLite and from the vector index.

## Viewer

Open **http://localhost:37778** (or run `agent-mem view`). It runs in the background, starts with every agent session, and `setup --write` also registers it as a login item (macOS LaunchAgent, systemd user service, Windows Startup folder), so it is reachable after a restart. The page is built fresh on every reload; an open tab reloads itself every ten seconds.

**Overview** shows activity and the latest requests. **Timeline** lists every session under its title with its summary (done, learned, next steps) and its requests; a request shows each step with the agent's own description, and failed commands stand out. **Memories** is sorted by agent, then by session, preferences and lessons first; the agents' own memory files get their own group. **Learned** explains lessons, error fixes, rules and commands and links each to the request it came from. **Graph** shows how your files, tools, libraries, settings and errors relate ("search.py uses SQLite FTS5"), read from the memories by the background model; click a thing to read each relation and the memory it comes from. **Health** shows whether the hooks and background jobs work. Facts are linked by topic with a spaCy model: set `observe.entity_model` to a spaCy model in the language of your facts, for example `de_core_news_sm` (mem0's default is `en_core_web_sm`), then run `agent-mem models install`: it downloads the model from spaCy's releases into agent-mem's model directory (checksum pinned for the German and English models), so updating or reinstalling the tool keeps it. `agent-mem doctor` says when it is missing.

It listens on this machine only (no login; turn it off on shared machines). `agent-mem view --output FILE` writes an offline snapshot instead. Change the port with `"viewer": {"port": 37778}`, turn it off with `"viewer": {"enabled": false}`, remove the login item with `agent-mem serve --no-autostart`.

## When something is missing

| You see | Do |
| --- | --- |
| `agent-mem: the database is damaged` | `agent-mem index` moves it aside as `memory.db.corrupt-<time>` (with its WAL) and starts a new database |
| `Search by meaning: unavailable` in `status` | `agent-mem upgrade --extras semantic` (installs it and downloads the model) |
| facts never appear | `agent-mem observe --status`; the agent's command (`claude`, `codex`, `copilot`) must be installed and logged in |
| Codex records nothing | start `codex`, run `/hooks` and trust the agent-mem hooks once |
| `Cannot start the viewer on 127.0.0.1:37778` | another program uses the port; set `"viewer": {"port": <free port>}` |
| any other error | `agent-mem doctor`; `AGENT_MEM_DEBUG=1 agent-mem <command>` prints the full traceback |

## Configuration

`config.json` in the data folder (`agent-mem paths`). Invalid values fall back to defaults and show up in `agent-mem doctor`.

```json
{
  "capture": true,
  "native_notes": true,
  "excluded_projects": ["/path/to/private/repo"],
  "exclude_globs": [".env", ".env.*", "*.pem", "secrets/**"],
  "budgets": {"session_start": 8000, "prompt": 2400, "failure": 400, "warning": 300, "file_history": 1200, "compact": 4000},
  "semantic": {"enabled": true, "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"},
  "observe": {
    "enabled": true,
    "providers": ["claude", "codex", "copilot"],
    "cross_vendor": false,
    "claude_model": "haiku",
    "codex_model": "gpt-6-luna",
    "copilot_model": "auto",
    "entity_model": "en_core_web_sm",
    "daily_limit": 300,
    "bundle_turns": 5,
    "bundle_tokens": 6000
  },
  "viewer": {"enabled": true, "port": 37778, "refresh_seconds": 10}
}
```

`observe.enabled: false` stops all model calls; requests are still recorded and searchable. Budgets are tokens per hook output; each agent is cut to what it passes to the model in one piece (Claude Code 10,000 characters, Codex 8,000 tokens). `native_notes: false` stops reading the notes Claude Code (`~/.claude/projects/*/memory/*.md`) and Codex (`~/.codex/memories/rollout_summaries/`) keep themselves; each agent is shown only the other one's notes. `cross_vendor: true` lets any installed CLI write facts for any request. Per project, `.agent-mem.json` in the repository root can set `{"capture": false}` or extra `"exclude"` globs.

## Privacy and security

- **No network except model downloads.** No telemetry; mem0's telemetry is switched off and verified by a test. The only outbound traffic is your agent's own CLI talking to its own provider, under your login.
- Secrets are removed before storage (API keys, tokens, private keys, passwords in assignments and URLs). `<private>…</private>` is never stored. Excluded files are recorded by path only. Output of web tools and third-party MCP servers never enters a bundle.
- The extraction process runs in an empty temporary directory with `AGENT_MEM_INTERNAL=1`, so its own session is never recorded.
- Recalled text is framed as data, not instructions. Facts never become rules or preferences by themselves.
- The database is **not encrypted**. The data folder is created with owner-only permissions on macOS and Linux.
- `purge` deletes matching data from the database, the search index and events not saved yet.

See [SECURITY.md](SECURITY.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Support matrix

| | Status |
| --- | --- |
| Python | 3.11 to 3.14 |
| OS | Ubuntu, macOS arm64, macOS Intel (no fastembed wheels: search by words and graph only), Windows |
| Agents tested | Claude Code 2.x, Codex CLI 0.x, Copilot CLI 1.0.96 and the Copilot app 1.1.29 (macOS), OpenCode 1.18 |
| CI | lint, types, tests, wheel smoke test on all four OS |

Agent notes: Codex asks you to trust plugin hooks once (`/hooks`). Copilot CLI and the Copilot app read the hooks `agent-mem setup copilot --write` puts in `~/.copilot/hooks`; plugin-defined `preToolUse` hooks do not fire there ([copilot-cli#2540](https://github.com/github/copilot-cli/issues/2540)), so use `setup` rather than a Copilot plugin. Sessions the app runs in its worktrees (`~/.copilot/copilot-worktrees`) count for their repository; plain app chats are not recorded. Run OpenCode sessions serially per repository.

## Development

```sh
uv sync --all-extras
uv run pytest -m "not local"
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Design decisions and every measurement live in `docs/PLAN.md`.

## License

MIT
