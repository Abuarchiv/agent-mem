# Security

## Reporting

Please report vulnerabilities privately through GitHub security advisories on this repository, not in public issues.

## Threat model

| Threat | Mitigation |
|---|---|
| Secrets in prompts or tool output | Redaction before storage (API keys and tokens of common providers, JWTs, private keys, bearer tokens, credentials in URLs, secret-like assignments). Tests cover a corpus of token formats and check that a secret never reaches the raw database file. |
| Secret files | Default exclude globs (`.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`, `secrets/**`, …): only the path is stored. |
| Private text | `<private>…</private>` is never stored. |
| Projects that must not be recorded | `excluded_projects` in `config.json`, `.agent-mem.json` with `{"capture": false}`, `agent-mem pause`. |
| Prompt injection through recalled text | Injected context is framed as data, bounded in size, control characters removed. |
| Memory poisoning (e.g. MINJA, OWASP ASI06) | Trust levels per source. Web and third-party MCP content is never injected automatically, never searchable through turn keys and never turned into rules or preferences. Provenance is shown by `mem_get`. |
| Cross-project leakage | Project memories stay in their project. Global are only: preferences from the user's own prompts that repeat across projects, notes from `~/.codex/memories`, and memories an agent stores explicitly as global. `mem_search` looks into other projects only when asked (`all_projects`). |
| Other local users | Data directory `0700` on macOS/Linux; on Windows the per-user `%LOCALAPPDATA%`. |
| Command injection via hooks | Hook commands are fixed strings; payloads are passed on stdin and never interpolated into shell commands. |
| Supply chain | Few dependencies, lockfile, `pip-audit` in CI; the release workflow builds in CI and publishes with PyPI trusted publishing. |
| Viewer page | `agent-mem view` escapes all stored text, embeds data as JSON that cannot close its script block and sets a Content Security Policy that allows only the page's own script (by hash) and no network requests. The page is written owner-only to `view/agent-mem.html` in the data directory; `purge` deletes it. With `--output` the user chooses another location. |
| Resource exhaustion | Size limits for stdin, prompts, outputs and payloads; hook deadline; bounded result counts. |
| Data exfiltration | No telemetry. Agent Mem itself only goes online for the optional model download. The optional summaries (off by default) run through the harness the user already uses. |

## Not covered

- **Encryption at rest.** Anyone who can read the data directory or its backups can read the stored history.
- A harness sending recalled text to its own model provider is outside Agent Mem's control.

## Deleting data

`agent-mem purge --id|--project|--before|--all` deletes rows, search keys, vectors and links, vacuums the database, deletes matching spooled events (for `--project`, `--before` and `--all`), deletes the page written by `agent-mem view` and replaces all backups with a fresh one. `mem_forget` deletes one item; the next indexer run then replaces the backups.
