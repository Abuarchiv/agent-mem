#!/usr/bin/env sh
set -eu

base_url=${AGENT_MEMORY_V1_BASE_URL:-https://github.com/Abuarchiv/agent-memory-v1/releases/latest/download}
version=${AGENT_MEMORY_V1_VERSION:-latest}
project=
agents=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || { echo "missing_project" >&2; exit 2; }
      project=$2
      shift 2
      ;;
    --agents)
      [ "$#" -ge 2 ] || { echo "missing_agents" >&2; exit 2; }
      agents=$2
      shift 2
      ;;
    --help|-h)
      printf '%s\n' 'Agent Memory V1 native installer' '  curl -fsSL https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.sh | sh -s -- --project "$PWD"' '  --project PATH  Configure this project immediately after the verified package is installed' '  --agents LIST   auto or comma-separated codex,opencode,copilot-cli'
      exit 0
      ;;
    *)
      echo "install_argument_unexpected" >&2
      exit 2
      ;;
  esac
done

case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) target=darwin-arm64 ;;
  Darwin:x86_64|Darwin:amd64) target=darwin-x64 ;;
  Linux:aarch64|Linux:arm64) target=linux-arm64 ;;
  Linux:x86_64|Linux:amd64) target=linux-x64 ;;
  *) echo "native_platform_unsupported" >&2; exit 1 ;;
esac

case "$base_url" in
  https://*) ;;
  *) echo "installer_requires_https" >&2; exit 1 ;;
esac

command -v curl >/dev/null 2>&1 || { echo "curl_required" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then hash_command=shasum
elif command -v sha256sum >/dev/null 2>&1; then hash_command=sha256sum
else echo "sha256_tool_required" >&2; exit 1
fi

archive="agent-memory-v1-${target}.tar.gz"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-memory-v1.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base_url/$archive" -o "$tmp_dir/$archive"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$base_url/$archive.sha256" -o "$tmp_dir/$archive.sha256"
expected=$(awk 'NF { print tolower($1); exit }' "$tmp_dir/$archive.sha256")
actual=$($hash_command -a 256 "$tmp_dir/$archive" | awk '{ print tolower($1) }')
[ "$expected" = "$actual" ] || { echo "native_archive_hash_mismatch" >&2; exit 1; }

mkdir "$tmp_dir/unpacked"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir/unpacked"
package=$(find "$tmp_dir/unpacked" -mindepth 1 -maxdepth 1 -type d -print -quit)
[ -n "$package" ] && [ -f "$package/memory" ] && [ -f "$package/manifest.json" ] || { echo "native_archive_invalid" >&2; exit 1; }

install_root=${XDG_DATA_HOME:-$HOME/.local/share}/agent-memory-v1
release_root=$install_root/releases
release="$release_root/$target-$version"
mkdir -p "$release_root"
if [ -e "$release" ]; then
  old="$release.previous.$(date +%s)"
  mv "$release" "$old"
fi
mv "$package" "$release"
mkdir -p "${XDG_BIN_HOME:-$HOME/.local/bin}"
launcher="${XDG_BIN_HOME:-$HOME/.local/bin}/memory"
if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
  mv "$launcher" "$launcher.previous.$(date +%s)"
fi
ln -sfn "$release/memory" "$launcher"

printf '%s\n' "Agent Memory V1 installed: $target" "Launcher: $launcher"
case ":${PATH:-}:" in
  *":${XDG_BIN_HOME:-$HOME/.local/bin}:"*) ;;
  *) printf '%s\n' "Add ${XDG_BIN_HOME:-$HOME/.local/bin} to PATH, then run: memory install" ;;
esac

if [ -n "$project" ]; then
  if [ -n "$agents" ]; then
    "$launcher" install --project "$project" --agents "$agents" --yes
  else
    "$launcher" install --project "$project" --yes
  fi
fi
