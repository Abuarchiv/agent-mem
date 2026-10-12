#!/bin/sh
# Installs agent-mem with uv (uv installs a suitable Python by itself).
set -eu

fail() {
  echo "agent-mem install failed: $1" >&2
  exit 1
}

if ! command -v uv >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || fail "curl is missing. Install curl, or install uv yourself (https://docs.astral.sh/uv/) and run this again."
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh || fail "could not install uv (network?). See https://docs.astral.sh/uv/ and run this again."
  PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v uv >/dev/null 2>&1 || fail "uv was installed but is not on PATH. Open a new terminal and run this again."
fi
uv tool install --upgrade "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem" \
  || fail "uv could not install agent-mem (network or git missing?). The error above names the cause."
uv tool update-shell >/dev/null 2>&1 || true
echo
echo "Installed. Next steps:"
echo "  agent-mem setup all --write       # every harness on PATH; or one: claude, codex, copilot, opencode"
echo "  agent-mem doctor"
echo "If 'agent-mem' is not found, open a new terminal (uv added it to your PATH)."
