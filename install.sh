#!/usr/bin/env sh
set -eu

base_url=${AGENT_MEM_BASE_URL:-${AGENT_MEMORY_V1_BASE_URL:-https://github.com/Abuarchiv/agent-memory-v1/releases/latest/download}}
version=${AGENT_MEM_VERSION:-${AGENT_MEMORY_V1_VERSION:-latest}}
project=
agents=
supported_targets='darwin-arm64 darwin-x64 linux-x64 win-x64'

case "$version" in
  ""|*[!A-Za-z0-9._+-]*) echo "installer_version_invalid" >&2; exit 2 ;;
esac

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
      printf '%s\n' 'Agent Mem native installer' '  curl -fsSL https://raw.githubusercontent.com/Abuarchiv/agent-memory-v1/main/install.sh | sh -s -- --project "$PWD"' '  --project PATH  Configure this project immediately after the verified package is installed' '  --agents LIST   auto or comma-separated codex,opencode,copilot-cli'
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
  Linux:aarch64|Linux:arm64) echo "native_target_not_published (supported: $supported_targets)" >&2; exit 1 ;;
  Linux:x86_64|Linux:amd64) target=linux-x64 ;;
  *) echo "native_platform_unsupported (supported: $supported_targets)" >&2; exit 1 ;;
esac

case "$base_url" in
  https://*) ;;
  *) echo "installer_requires_https" >&2; exit 1 ;;
esac

home=${HOME:-}
[ -n "$home" ] || { echo "installer_home_required" >&2; exit 1; }
data_home=${XDG_DATA_HOME:-$home/.local/share}
bin_home=${XDG_BIN_HOME:-$home/.local/bin}
case "$data_home" in /*) ;; *) echo "installer_data_path_invalid" >&2; exit 1 ;; esac
case "$bin_home" in /*) ;; *) echo "installer_bin_path_invalid" >&2; exit 1 ;; esac

command -v curl >/dev/null 2>&1 || { echo "curl_required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar_required" >&2; exit 1; }
command -v mktemp >/dev/null 2>&1 || { echo "mktemp_required" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then
  calculate_hash() { shasum -a 256 "$1" | awk '{ print tolower($1) }'; }
elif command -v sha256sum >/dev/null 2>&1; then
  calculate_hash() { sha256sum "$1" | awk '{ print tolower($1) }'; }
else echo "sha256_tool_required" >&2; exit 1
fi

archive="agent-mem-${target}.tar.gz"
if ! tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-mem.XXXXXX"); then
  echo "native_temp_unavailable" >&2
  exit 1
fi
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

download() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$1" -o "$2" \
    || { echo "native_archive_download_failed" >&2; exit 1; }
}

download "$base_url/$archive" "$tmp_dir/$archive"
download "$base_url/$archive.sha256" "$tmp_dir/$archive.sha256"
expected=$(awk 'NF && length($1) == 64 && $1 !~ /[^[:xdigit:]]/ { print tolower($1); exit }' "$tmp_dir/$archive.sha256")
[ -n "$expected" ] || { echo "native_archive_checksum_invalid" >&2; exit 1; }
actual=$(calculate_hash "$tmp_dir/$archive") || { echo "native_archive_hash_failed" >&2; exit 1; }
[ "$expected" = "$actual" ] || { echo "native_archive_hash_mismatch" >&2; exit 1; }

mkdir "$tmp_dir/unpacked"
tar -xzf "$tmp_dir/$archive" -C "$tmp_dir/unpacked" || { echo "native_archive_invalid" >&2; exit 1; }
package="$tmp_dir/unpacked/agent-mem-package"
[ -d "$package" ] && [ ! -L "$package" ] && [ -f "$package/agent-mem" ] && [ -f "$package/manifest.json" ] || {
  echo "native_archive_invalid" >&2
  exit 1
}

install_root=$data_home/agent-mem
release_root=$install_root/releases
release="$release_root/$target-$version"
mkdir -p "$release_root" || { echo "native_install_path_unavailable" >&2; exit 1; }
previous_release=
if [ -e "$release" ] || [ -L "$release" ]; then
  previous_release="$release.previous.$(date +%s).$$"
  mv "$release" "$previous_release" || { echo "native_activation_failed" >&2; exit 1; }
fi
if ! mv "$package" "$release"; then
  if [ -n "$previous_release" ] && [ ! -e "$release" ] && [ -e "$previous_release" ]; then
    mv "$previous_release" "$release" || true
  fi
  echo "native_activation_failed" >&2
  exit 1
fi
mkdir -p "$bin_home" || { echo "native_launcher_path_unavailable" >&2; exit 1; }
launcher="$bin_home/agent-mem"
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  if [ ! -L "$launcher" ]; then
    mv "$launcher" "$launcher.previous.$(date +%s).$$" || { echo "native_launcher_backup_failed" >&2; exit 1; }
  fi
fi
ln -sfn "$release/agent-mem" "$launcher" || { echo "native_launcher_activation_failed" >&2; exit 1; }
legacy_launcher="$bin_home/memory"
if [ -e "$legacy_launcher" ] || [ -L "$legacy_launcher" ]; then
  if [ ! -L "$legacy_launcher" ]; then
    mv "$legacy_launcher" "$legacy_launcher.previous.$(date +%s).$$" || { echo "native_launcher_backup_failed" >&2; exit 1; }
  fi
fi
ln -sfn "$release/agent-mem" "$legacy_launcher" || { echo "native_launcher_activation_failed" >&2; exit 1; }

printf '%s\n' "Agent Mem installed: $target" "Launchers: $launcher (memory compatibility alias)"
case ":${PATH:-}:" in
  *":$bin_home:"*) ;;
  *) printf '%s\n' "Add $bin_home to PATH, then run: agent-mem install" ;;
esac

if [ -n "$project" ]; then
  if [ -n "$agents" ]; then
    "$launcher" install --project "$project" --agents "$agents" --yes
  else
    "$launcher" install --project "$project" --yes
  fi
fi
