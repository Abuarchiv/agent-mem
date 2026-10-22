#!/bin/sh
# Installs agent-mem as a Docker container and connects the agents on this computer to it (macOS, Linux).
# Run it again to update; the memory stays in the Docker volume agent-mem-data.
set -eu

image=${AGENT_MEM_IMAGE:-agent-mem}
source=${AGENT_MEM_SOURCE:-https://github.com/Abuarchiv/agent-mem.git}
bin=${AGENT_MEM_BIN_DIR:-$HOME/.local/bin}
port=${AGENT_MEM_PORT:-37778}
launcher="$bin/agent-mem"

fail() {
  echo "agent-mem install failed: $1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 \
  || fail "Docker is missing. macOS: Docker Desktop or OrbStack. Linux: Docker Engine. Then run this again."
docker info >/dev/null 2>&1 || fail "Docker is not running. Start it and run this again."
if [ -e "$launcher" ] && ! grep -q "install-docker.sh" "$launcher" 2>/dev/null; then
  fail "$launcher is a normal agent-mem install. Keep using it, or remove it first: uv tool uninstall agent-mem"
fi

echo "Building the agent-mem image from $source (a few minutes the first time)..."
docker build -t "$image" "$source" || fail "the image did not build. The error above names the cause."

# The container reads your home folder (agent transcripts, git) but cannot change it; memory lives in the volume.
docker rm -f agent-mem >/dev/null 2>&1 || true
docker run -d --name agent-mem --init --restart unless-stopped \
  -e HOME="$HOME" -v "$HOME:$HOME:ro" -v agent-mem-data:/data -p "127.0.0.1:$port:37778" "$image" >/dev/null \
  || fail "the container did not start. The error above names the cause."

mkdir -p "$bin"
cat > "$launcher" <<EOF
#!/bin/sh
# agent-mem in Docker, written by install-docker.sh: every command runs in the agent-mem container.
image="$image"
bin="$bin"
port="$port"
EOF
cat >> "$launcher" <<'EOF'
case "${1:-}" in
  hook)
    # Docker closed or the container stopped: the session goes on without memory.
    docker exec -i agent-mem agent-mem "$@" 2>/dev/null
    exit 0 ;;
  mcp)
    exec docker exec -i agent-mem agent-mem mcp ;;
  login)
    case "${2:-}" in
      claude) exec docker exec -it agent-mem claude auth login ;;
      codex) exec docker exec -it agent-mem codex login --device-auth ;;
      copilot) exec docker exec -it agent-mem copilot login --device-code ;;
      *) echo "usage: agent-mem login claude|codex|copilot (the agent that writes facts in the container)" >&2; exit 2 ;;
    esac ;;
  setup|uninstall)
    # These write your agents' settings: the home folder writable, the hooks pointing at this file.
    command=$1; shift
    if [ "${1:-all}" = all ]; then
      [ $# -gt 0 ] && shift
      names=""
      for name in claude codex copilot opencode; do
        command -v "$name" >/dev/null 2>&1 && names="$names $name"
      done
      [ -n "$names" ] || { echo "No agent found here (claude, codex, copilot, opencode)." >&2; exit 1; }
    else
      names=$1; shift
    fi
    err=$(mktemp)
    for name in $names; do
      # As you, so the files stay yours; without the agent CLIs, so Claude Code's MCP list is edited here below.
      docker run --rm -i --user "$(id -u):$(id -g)" -e HOME="$HOME" -e AGENT_MEM_EXE="$bin/agent-mem" \
        -e AGENT_MEM_DATA_DIR=/tmp/agent-mem -e PATH=/opt/uv/bin:/usr/bin:/bin -v "$HOME:$HOME" -v "$bin:$bin" \
        "$image" agent-mem "$command" "$name" "$@" 2>"$err" || { cat "$err" >&2; rm -f "$err"; exit 1; }
      grep -v "claude mcp add" "$err" >&2 || true
      if [ "$name" = claude ] && command -v claude >/dev/null 2>&1; then
        # Claude Code's own CLI edits its MCP list; the one on this computer, not a copy in the container.
        claude mcp remove --scope user agent-mem >/dev/null 2>&1 || true
        if [ "$command" = setup ]; then
          claude mcp add --scope user agent-mem -- "$bin/agent-mem" mcp >/dev/null && echo "  MCP server registered in Claude Code."
        fi
      fi
    done
    rm -f "$err"
    exit 0 ;;
  view)
    if [ $# -eq 1 ]; then
      open "http://localhost:$port/" 2>/dev/null || xdg-open "http://localhost:$port/" 2>/dev/null || echo "http://localhost:$port/"
      exit 0
    fi ;;
  upgrade)
    echo "Run install-docker.sh again: it builds the new image and keeps your memory."
    exit 0 ;;
esac
case "$PWD/" in "$HOME"/*) dir=$PWD ;; *) dir=/ ;; esac
tty=""
[ -t 0 ] && [ -t 1 ] && tty=-t
docker exec -i $tty -w "$dir" agent-mem agent-mem "$@" && exit 0
code=$?
[ "$(docker inspect -f '{{.State.Running}}' agent-mem 2>/dev/null)" = true ] \
  || echo "The agent-mem container is not running. Start it: docker start agent-mem" >&2
exit $code
EOF
chmod +x "$launcher"

echo
echo "agent-mem runs in Docker. Connecting the agents on this computer..."
"$launcher" setup all --write || echo "No agent connected yet. Later: agent-mem setup all --write"
echo
echo "Facts are written by your agent's CLI inside the container. Log it in once there:"
for name in claude codex copilot; do
  command -v "$name" >/dev/null 2>&1 && echo "  agent-mem login $name"
done
echo
echo "Viewer: http://localhost:$port/  Check: agent-mem doctor  Undo: agent-mem uninstall all, then docker rm -f agent-mem"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH to use the agent-mem command." ;; esac
