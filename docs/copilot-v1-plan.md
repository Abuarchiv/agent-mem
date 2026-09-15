# Copilot local integration

The standalone V1 supports local GitHub Copilot CLI/app repository or worktree sessions through project MCP configuration and the task-owned hook adapter.

- `copilot-cli` is a host adapter, not a memory provider.
- The Copilot model remains the user's host model.
- V1 captures delivered local events and returns local source-backed context.
- Copilot's own four memory tools are excluded from recursive capture.
- Cloud-hosted sessions and Copilot VS Code are outside this repository.
- No Copilot SDK executor, OAuth flow or background model call is included.

Native app/CLI execution must be tested separately before a release claim. Synthetic adapter tests do not prove a native hook ran.
