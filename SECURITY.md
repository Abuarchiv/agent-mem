# Security

## Supported versions

agent-mem has no release yet. Security fixes land on `main`; install or update from there
(`agent-mem upgrade`). Once releases exist, the latest one is supported.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a
vulnerability**. Please do not open a public issue. Include the agent-mem version
(`agent-mem --version`), your operating system and the steps to reproduce.

## What agent-mem protects, and what it does not

agent-mem stores what you and your coding agents say and do, on your machine. The design keeps that
data local and treats everything it reads as untrusted.

- **Nothing listens on the network** except the read-only viewer: it binds `127.0.0.1`, answers
  `GET` only and rejects requests whose `Host` header is not local (DNS rebinding).
- **No outbound traffic** except model downloads. No telemetry. Facts are written by your agent's
  own CLI under your existing login, never by a service of ours.
- **Secrets are removed before storage**: API keys, tokens, private keys, passwords in assignments
  and URLs. Text inside `<private>…</private>` is never stored. Removal is pattern-based and can
  miss a secret in an unusual format.
- **Recalled text is data, not instructions.** It is framed as such when given to an agent. Output
  of web tools and third-party MCP servers never reaches the fact-writing model and never becomes a
  rule or preference.
- **The database is not encrypted.** On macOS and Linux the data folder is readable by your user
  only (folder `0700`, database `0600`). Anyone who can read your home folder can read your memory.
- Hooks run with your rights, like every hook your agents run.

Out of scope: what your agent provider does with a request, and attacks that already require your
user account.
