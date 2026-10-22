# Agent Mem

One local memory for **Claude Code, Codex, GitHub Copilot CLI and OpenCode**.

Agent Mem records what your coding agents do, writes short facts from it in the background, and reminds every agent of what matters at the right moment.

- **Local.** One database file on your machine. No telemetry, no cloud.
- **No API key.** Facts are written by the agent's own command-line tool you are already logged into.
- **Shared.** What Claude Code learned is available to Codex, and the other way round.
- **Visible.** Browse everything at `http://localhost:37778`.

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [What it does](#what-it-does)
- [Viewer](#viewer)
- [Commands](#commands)
- [When something is missing](#when-something-is-missing)
- [Configuration](#configuration)
- [Privacy and security](#privacy-and-security)
- [How it works](#how-it-works)
- [Supported versions](#supported-versions)
- [Development](#development)

## Quick start

```sh
uv tool install "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"
agent-mem setup all --write
agent-mem doctor
```

1. The first line installs the `agent-mem` command.
2. `setup all --write` connects every agent installed here (or name one: `claude`, `codex`, `copilot`, `opencode`) and downloads the search model (about 220 MB).
3. `doctor` checks that everything works.

Start a session and send one request. The next session begins with what the first one learned.

## Install

### Sizes

| Install | Size | You get |
| --- | --- | --- |
| `agent-mem` | about 10 MB | recording, search by words, reminders for the agent, MCP server, requests saved word for word |
| `agent-mem[semantic]` | plus 220 MB model | search by meaning (`paraphrase-multilingual-MiniLM-L12-v2`, ONNX, no PyTorch) |
| `agent-mem[semantic,observer]` | plus about 400 MB | facts in the background, work log, lessons, daily cleanup of duplicates and outdated facts (mem0, Qdrant local mode, spaCy) |

agent-mem is not on PyPI. Always install it from the repository, never by its bare name: a package with that name on PyPI would not be ours.

### Other ways to install

| Way | Command |
| --- | --- |
| pipx | `pipx install "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem"` |
| Install script (macOS, Linux) | `curl -LsSf https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.sh \| sh` |
| Install script (Windows PowerShell) | `irm https://raw.githubusercontent.com/Abuarchiv/agent-mem/main/install.ps1 \| iex` |
| Claude Code marketplace | `/plugin marketplace add Abuarchiv/agent-mem`, then `/plugin install agent-mem@agent-mem` |
| By hand | `agent-mem setup <agent>` without `--write` prints the steps |

- The install script installs uv first and, on a fresh machine, runs `agent-mem setup all --write`.
- The marketplace plugin only registers the hooks. Install the `agent-mem` command first with `uv tool install` and skip `setup --write`, or every hook fails with "command not found".
- `setup --write` writes the **full path** of `agent-mem` into each agent's settings, so sessions started from an editor find it too.
- There is no separate agent-mem container. Your agent starts `agent-mem` on every request and it writes facts through the agent's own login, so both have to sit in the same place.

### Agent in a container (Docker, Dev Containers)

If your agent runs in a container, install agent-mem into that same image and keep its data on a volume:

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
USER node
ENV PATH=/home/node/.local/bin:$PATH AGENT_MEM_DATA_DIR=/home/node/.agent-mem
RUN uv tool install "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem" \
 && agent-mem setup claude --write
```

```sh
docker run -it -v agent-mem-data:/home/node/.agent-mem <your-image>
```

- Log in to the agent inside the container once; agent-mem writes facts through that login.
- The page from `agent-mem view` listens on 127.0.0.1 inside the container, so open it there, not from the host.

### Update

```sh
agent-mem upgrade                     # add an extra with: --extras observer
```

This installs the newest commit of the source you installed from (extras kept), downloads any model the new version needs, then runs `agent-mem doctor --fix`. That migrates the database and rewrites hooks written by an older version. Codex asks you to trust changed hooks once more with `/hooks`. Running the install script again does the same.

Avoid `uv tool install --reinstall`: it deletes the environment first, and hooks firing in those seconds find no program.

### Uninstall

```sh
agent-mem uninstall all               # disconnect every agent, keep the data
agent-mem purge --all                 # delete the data
uv tool uninstall agent-mem           # remove the program
```

Keep this order. Removing the program first leaves hooks that call a missing program on every event.

## What it does

| Moment | What happens |
| --- | --- |
| Session start | The agent gets a short briefing: facts about this project, commands that work, decisions, failed attempts, preferences, and the last session with what was done and what is still open. |
| You send a request | Matching memories are added, only when the match is strong (search by words, no model call). The terminal stays quiet. |
| Before a command or edit | A warning if it matches something you corrected before or a change that was reverted. Rules you enable can block it. |
| A command fails | If this error was fixed before, the agent sees how. |
| The agent finishes a request | The request is saved. In the background, facts are written from it, it gets a type and a title, the session summary is updated, and a lesson is written when something went wrong and was fixed. |
| Once a day | Duplicates and facts that a newer one replaced are removed. Your own notes are never touched. |
| Context compaction | Session goal, decisions and open problems are given to the agent again (Claude Code, Codex) or added to the compaction prompt (OpenCode). |
| Session ends | Claude Code and Copilot show what was saved: requests, files, errors. |
| Something breaks | Claude Code and Codex show it in the terminal right away (at most every ten minutes per failure) with the command that helps, usually `agent-mem doctor`. |

### What you see in the terminal

At session start, Claude Code and Codex show a panel with:

- the project's memory size
- which model writes facts from your requests (or why none does)
- recent work: time, type, title
- what the agent was given, grouped by day, with ids
- anything that needs your attention
- the viewer address

Copilot CLI and the Copilot app show the same panel without colour, as progress lines in their timeline. Claude Code shows the panel again after context compaction.

### Token savings

```
Your savings: ~84,760 tokens (98% reduction from reuse)
```

This line compares what a memory costs the agent to read with the work it took to find it out. It appears only when measured work stands behind it. `agent-mem status` shows the same for the last 7 days; the viewer shows it on the overview, on the Health page and in every memory. It is a comparison, not a measured saving: nobody knows how much of that work an agent would have repeated without the memory. Details in [How it works](#token-savings-measured).

## Viewer

Open **http://localhost:37778**, or run `agent-mem view`.

| Page | Shows |
| --- | --- |
| Overview | activity, latest requests, token savings |
| Timeline | every session with its title and summary (done, learned, next steps); each request step by step, failed commands stand out |
| Memories | sorted by agent, then by session; preferences and lessons first; the agents' own memory files in their own group |
| Learned | lessons, error fixes, rules and commands, each linked to the request it came from |
| Graph | how your files, tools, libraries, settings and errors relate ("search.py uses SQLite FTS5"); click a thing to read each relation and its source |
| Health | whether the hooks and background jobs work |

- It starts with every agent session. `setup --write` also registers it as a login item (macOS LaunchAgent, systemd user service, Windows Startup folder), so it is there after a restart.
- The page is built fresh on every reload; an open tab reloads itself every ten seconds.
- It listens on this machine only and has no login. Turn it off on shared machines.
- `agent-mem view --output FILE` writes an offline snapshot instead.
- Change the port with `"viewer": {"port": 37778}`, turn it off with `"viewer": {"enabled": false}`, remove the login item with `agent-mem serve --no-autostart`.

### Topics in other languages

The Graph links facts by topic with a spaCy model. The default is English (`en_core_web_sm`). For facts in another language, set `observe.entity_model`, for example to `de_core_news_sm`, then run `agent-mem models install`. The model is stored in agent-mem's own model folder (checksum pinned for German and English), so updates keep it. `agent-mem doctor` tells you when it is missing.

## Commands

| Task | Command |
| --- | --- |
| Check state | `agent-mem status`, `agent-mem doctor [--fix]`, `agent-mem paths` |
| Connect agents | `agent-mem setup all\|<agent> [--write] [--no-models]`, `agent-mem uninstall all\|<agent>` |
| Update | `agent-mem upgrade [--extras semantic observer]` |
| Search | `agent-mem search "query" [--project DIR] [--all-projects] [--limit N]` |
| Show entries | `agent-mem show T12 M3` (T = request, M = memory) |
| Viewer | `agent-mem view [--project DIR] [--output FILE\|FOLDER] [--no-open]`, `agent-mem serve [--autostart\|--no-autostart]` |
| Rules and lessons | `agent-mem rules [list\|enable\|disable\|delete] [ID]`, `agent-mem lessons` |
| Pause recording | `agent-mem pause [--for 2h]`, `agent-mem resume` |
| Export | `agent-mem export [--project DIR] [--output FILE]` |
| Delete | `agent-mem purge --id ID \| --project DIR \| --before DATE \| --all [--yes]` |
| Run background jobs now | `agent-mem observe [--drain\|--once\|--status\|--retry-failed\|--reprocess-raw\|--reindex]`, `agent-mem index`, `agent-mem consolidate` |
| Models | `agent-mem models [status\|install]` |
| Measure search quality | `agent-mem eval <longmemeval.json> [--subset FILE] [--backend sqlite\|mem0]`, `agent-mem eval --fixture FILE` |

`status`, `doctor`, `search`, `observe`, `index`, `consolidate` and `paths` print readable lines; add `--json` for machine output. `agent-mem <command> --help` lists every option.

Agents use these MCP tools: `mem_search`, `mem_timeline`, `mem_get`, `mem_remember`, `mem_forget`.

## When something is missing

| You see | Do |
| --- | --- |
| `agent-mem: the database is damaged` | `agent-mem index` moves it aside as `memory.db.corrupt-<time>` and starts a new one |
| `Search by meaning: unavailable` in `status` | `agent-mem upgrade --extras semantic` |
| Facts never appear | `agent-mem observe --status`; the agent's command (`claude`, `codex`, `copilot`) must be installed and logged in |
| Codex records nothing | start `codex`, run `/hooks` and trust the agent-mem hooks once |
| `Cannot start the viewer on 127.0.0.1:37778` | another program uses the port; set `"viewer": {"port": <free port>}` |
| Any other error | `agent-mem doctor`; `AGENT_MEM_DEBUG=1 agent-mem <command>` prints the full error |

## Configuration

`config.json` in the data folder (`agent-mem paths` shows where). Invalid values fall back to the defaults and show up in `agent-mem doctor`. The defaults:

```json
{
  "capture": true,
  "native_notes": true,
  "excluded_projects": [],
  "exclude_globs": [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*",
                    ".npmrc", ".netrc", ".pypirc", "secrets/**", "**/secrets/**", "*.kdbx", "credentials*"],
  "budgets": {"session_start": 8000, "prompt": 2400, "failure": 400, "warning": 300, "file_history": 1200, "compact": 4000},
  "semantic": {"enabled": true, "model": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"},
  "observe": {
    "enabled": true,
    "providers": ["opencode", "claude", "codex", "copilot"],
    "cross_vendor": false,
    "claude_model": "haiku",
    "codex_model": "gpt-6-luna",
    "copilot_model": "auto",
    "opencode_model": "opencode/big-pickle",
    "entity_model": "en_core_web_sm",
    "daily_limit": 300,
    "bundle_turns": 5,
    "bundle_tokens": 20000
  },
  "viewer": {"enabled": true, "port": 37778, "refresh_seconds": 10}
}
```

| Setting | Effect |
| --- | --- |
| `observe.enabled: false` | no model calls at all; requests are still recorded and searchable |
| `observe.cross_vendor: true` | any installed CLI may write facts for any request |
| `budgets` | tokens per reminder; each agent is also cut to what it passes to the model in one piece (Claude Code 10,000 characters, Codex 8,000 tokens) |
| `native_notes: false` | stop reading the notes Claude Code (`~/.claude/projects/*/memory/*.md`) and Codex (`~/.codex/memories/rollout_summaries/`) keep themselves; each agent is shown only the other one's notes |
| `.agent-mem.json` in a repository root | per project: `{"capture": false}` or extra `"exclude"` globs |

## Privacy and security

- **No network except model downloads.** No telemetry; mem0's telemetry is switched off and a test checks it. The only outbound traffic is your agent's own CLI talking to its own provider, under your login.
- **Secrets are removed before storage:** API keys, tokens, private keys, passwords in assignments and URLs. Text inside `<private>…</private>` is never stored. Excluded files are recorded by path only.
- Output of web tools and third-party MCP servers is never sent to the fact-writing model.
- The fact-writing process runs in an empty temporary folder with `AGENT_MEM_INTERNAL=1`, so its own session is never recorded.
- Recalled text is marked as data, not instructions. Facts never turn into rules or preferences by themselves.
- The database is **not encrypted**. The data folder is created readable by its owner only on macOS and Linux.
- `purge` deletes matching data from the database, the search index and events not saved yet.

## How it works

### Facts, without an API key

After each request, `agent-mem observe` starts in the background. It takes up to five requests of a session at a time, runs mem0's extraction with a prompt tuned for coding work (conventions, decisions, failed attempts, preferences; no general knowledge, no secrets, in your language) and stores the facts in SQLite, mirrored in a local Qdrant index.

- Each fact is tagged as decision, rule, failed attempt or fact.
- A rule written as "Use pnpm instead of npm" becomes the same rule as a typed correction.
- Final answers of subagents are included.
- A change such as "we switched from pytest to nox" is stored next to the old fact. Until the daily cleanup retires the old one, both are shown with dates and the agent reads the newer one as current.

The model is the CLI you already pay for, started under your login without tools, MCP servers, hooks or your settings:

| Request came from | Model |
| --- | --- |
| OpenCode | Big Pickle, free (`opencode run --standalone --agent plan --model opencode/big-pickle`) |
| Claude Code | Claude Haiku (`claude -p --model haiku`) |
| Codex | GPT-6-Luna, low effort (`codex exec -m gpt-6-luna`) |
| Copilot CLI | Auto, efficiency tier, resolves to GPT-6-Luna (`copilot -s --model auto`) |
| No CLI found | none; the request is saved word for word |

- A request never leaves its vendor: a Claude request is not sent to OpenAI.
- Each uses the cheapest model of its CLI (as of 2026-10-12). If your plan does not offer it, the CLI's own default is tried once.
- With only one CLI installed, its requests get facts and the others are saved word for word.
- A usage limit or a missing login pauses facts for an hour; the requests wait.
- Ollama can be added as a local fallback with `"observe": {"providers": ["opencode", "claude", "codex", "copilot", "ollama"]}`. It is off by default because local models put load on the machine.

### How ranking learns (no model needed)

- **Use:** memories used often and recently rank higher (ACT-R activation); unused ones fade but are never deleted.
- **Feedback:** a recalled memory counts as useful when the agent opens it, edits its files or cites its id.
- **Error fixes:** a failing command, then edits, then the same command passing becomes a recipe.
- **Rules from corrections:** "use pnpm instead of npm" becomes a proposed rule: a note before the next `npm` command. Enabled with `agent-mem rules enable`, it blocks `npm` and shows the agent why.
- **Failed attempts:** reverted changes become warnings for the same files.
- **Links:** files, commands, errors and packages that occur together are linked and searched as a graph (Personalized PageRank).
- **Cleanup:** daily: old unused memories rank lower, preferences that hold everywhere become global, replaced facts are retired.

Search combines SQLite FTS5 (words), MiniLM vectors (meaning) and the graph with reciprocal rank fusion. Time words such as "gestern", "last week", "8. April" or "April 8th 2026" rank the requests of that time first. A request keeps the commits it made (hash and subject, also after `git commit -q && git log --oneline -1`), so "which commit did X" finds the hash.

### Token savings, measured

After a request ends, agent-mem reads the agent's own transcript and stores the fresh tokens the agent spent on it: input, cache writes and output. Cache reads are left out, because every step re-reads the whole context.

| Agent | Source |
| --- | --- |
| Claude Code | message `usage`, subagents included |
| Codex | `token_count` events |
| Copilot | `~/.copilot/session-state/<id>/events.jsonl` |
| OpenCode | not measured |

A memory carries its request's share (the request's work divided by the memories it produced), so several memories from one request count that request once. Over 7 days each memory counts once, however many sessions were given it.

## Supported versions

| | Tested |
| --- | --- |
| Python | 3.11 to 3.14 |
| OS | Ubuntu, macOS arm64, macOS Intel (search by words and graph only, no fastembed wheels), Windows |
| Agents | Claude Code 2.x, Codex CLI 0.x, Copilot CLI 1.0.96, Copilot app 1.1.29 (macOS), OpenCode 1.18 |
| CI | lint, types, tests and a wheel smoke test on all four systems |

Notes per agent:

- **Codex** asks you to trust the hooks once (`/hooks`).
- **Copilot** CLI and app read the hooks `agent-mem setup copilot --write` puts in `~/.copilot/hooks`. Hooks from a Copilot plugin miss `preToolUse` ([copilot-cli#2540](https://github.com/github/copilot-cli/issues/2540)), so use `setup` instead. Sessions the app runs in its worktrees (`~/.copilot/copilot-worktrees`) count for their repository; plain app chats are not recorded.
- **OpenCode:** run one session at a time per repository.

## Development

```sh
uv sync --all-extras
uv run pytest -m "not local"
uv run ruff check src tests && uv run ruff format --check src tests && uv run pyright
```

## License

MIT
