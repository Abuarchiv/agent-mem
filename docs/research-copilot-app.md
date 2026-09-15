# Copilot app boundary

V1 treats the GitHub Copilot app as a local host surface that can consume project MCP configuration in a local repository/worktree. It is not a cloud bridge.

Supported in this repository:

- project MCP configuration;
- task-owned Copilot CLI/app hook adapter;
- local capture, source retrieval and source-backed report tools.

Not supported:

- cloud-hosted sandbox access to the local vault;
- Copilot SDK execution or OAuth;
- Copilot VS Code integration.

The adapter contract and native execution must be validated independently on the installed host version.
