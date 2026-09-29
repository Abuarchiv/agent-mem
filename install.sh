#!/bin/sh
# Installs agent-mem with uv (uv installs a suitable Python by itself).
set -eu
if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
fi
uv tool install --upgrade "agent-mem[semantic] @ git+https://github.com/Abuarchiv/agent-mem"
uv tool update-shell >/dev/null 2>&1 || true
echo
echo "Installed. Next steps:"
echo "  agent-mem setup claude    # or: codex, copilot, opencode"
echo "  agent-mem models install  # optional: download the E5 model for semantic search"
echo "  agent-mem doctor"
