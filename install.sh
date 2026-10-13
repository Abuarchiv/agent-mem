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
before=$(agent-mem --version 2>/dev/null || true)
uv tool install --upgrade "agent-mem[semantic,observer] @ git+https://github.com/Abuarchiv/agent-mem" \
  || fail "uv could not install agent-mem (network or git missing?). The error above names the cause."
uv tool update-shell >/dev/null 2>&1 || true
exe="$(uv tool dir --bin)/agent-mem"  # the copy just installed, even before PATH knows it
if [ -n "$before" ]; then
  echo "Updated: $before -> $("$exe" --version)"
  "$exe" doctor --fix || true  # migrates the database, rewrites hooks an older release wrote
  exit 0
fi
echo
echo "Installed $("$exe" --version). Connecting every harness on PATH..."
"$exe" setup all --write || echo "No harness connected yet. Later: agent-mem setup all --write (or: claude, codex, copilot, opencode)"
echo
echo "Undo with: agent-mem uninstall all. Check with: agent-mem doctor"
echo "If 'agent-mem' is not found, open a new terminal (uv added it to your PATH)."
