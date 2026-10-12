# Security

## Reporting

Report vulnerabilities privately through GitHub security advisories on this repository, not in public issues.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Secrets in prompts or tool output | Redaction before storage (API keys and tokens of common providers, JWTs, private keys, bearer tokens, credentials in URLs, secret-like assignments). Tests cover a corpus of token formats and check that a secret never reaches the raw database file. Observer bundles are built from the cleaned text, never from raw payloads. |
| Secret files | Default exclude globs (`.env*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`, `secrets/**`): only the path is stored. |
| Private text | `<private>…</private>` is never stored. |
| Projects that must not be recorded | `excluded_projects` in `config.json`, `.agent-mem.json` with `{"capture": false}`, `agent-mem pause`. |
| Model calls with your data | Only the `observe` worker calls a model, always through the harness CLI you already use, under your login, never with a key Agent Mem reads or stores. A turn only goes to the vendor that already saw it unless `observe.cross_vendor` is set. `observe.enabled: false` stops all calls. |
| The extraction session being captured | The CLI runs in an empty temporary directory with `--restricted --setting-sources "" --tools "" --strict-mcp-config --no-session-persistence` (Claude) or the equivalent flags, and with `AGENT_MEM_INTERNAL=1`, which the hooks treat as "do not capture". |
| Prompt injection through recalled text | Injected context is framed as data, bounded in size, control characters removed. The extraction prompt tells the model to ignore instructions embedded in the input. |
| Memory poisoning (MINJA, OWASP ASI06) | Trust levels per source (`observer` for facts, `raw` for summaries). Web and third-party MCP content never enters a bundle, is never injected automatically and never becomes a rule or preference. Facts never become rules by themselves. Provenance is shown by `mem_get`. |
| Cross-project leakage | Facts live in one mem0 namespace per project; SQLite memories stay in their project. `mem_search` looks into other projects only when asked. |
| Other local users | Data directory and `mem0/` are `0700` on macOS and Linux; on Windows the per-user `%LOCALAPPDATA%`. |
| Command injection via hooks | Hook commands are fixed strings written by `setup --write` with the absolute binary path; payloads are passed on stdin and never interpolated into shell commands. |
| Viewer | `agent-mem serve` (http://localhost:37778) binds `127.0.0.1` only, answers GET only and rejects foreign `Host` headers, so websites cannot read it through DNS rebinding. There is no login, like other local dev tools: anyone with an account on this machine who can reach its loopback port can read the page. Set `"viewer": {"enabled": false}` on shared machines. Pages are not cached and cannot be framed. |
| Telemetry | None. mem0's telemetry is disabled before import and verified by `tests/test_observe.py`; no `~/.mem0` is created. |
| Supply chain | Lockfile, pinned `mem0ai`, upgrades only with a green adapter test; the release workflow builds in CI and publishes with PyPI trusted publishing. |
| Resource exhaustion | Size limits for stdin, prompts, outputs, bundles; hook deadline; one worker at a time at low priority; daily cap on model calls (`observe.daily_limit`). |

## Not covered

- **Encryption at rest.** Anyone who can read the data directory or its backups can read the stored history and facts.
- What a harness provider does with the text your CLI sends it is governed by that provider's terms, not by Agent Mem.

## Deleting data

`agent-mem purge --id|--project|--before|--all` deletes rows, search keys, vectors and links, queues the matching facts for removal from Qdrant, vacuums the database, deletes spooled events, and replaces all backups with a fresh one. `mem_forget` deletes one item in SQLite and in Qdrant. `agent-mem uninstall <harness>` removes hooks and MCP entries and leaves the data in place.
