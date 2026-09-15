import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("native Unix installer has valid shell syntax and verifies archives before activation", () => {
  const script = readFileSync(new URL("../../install.sh", import.meta.url), "utf8");
  const syntax = spawnSync("sh", ["-n", fileURLToPath(new URL("../../install.sh", import.meta.url))], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /--proto '=https' --tlsv1\.2/u);
 assert.match(script, /native_archive_hash_mismatch/u);
 assert.match(script, /native_archive_download_failed/u);
 assert.match(script, /native_archive_checksum_invalid/u);
  assert.match(script, /native_archive_invalid/u);
  assert.match(script, /installer_version_invalid/u);
  assert.match(script, /native_target_not_published \(supported: \$supported_targets\)/u);
  assert.match(script, /agent-mem/iu);
  assert.match(script, /github\.com\/Abuarchiv\/agent-memory-v1/u);
  assert.equal(script.includes("Abuarchiv/agent-mem/releases"), false);
  assert.equal(script.includes("Abuarchiv/agent-mem/main"), false);
  assert.match(script, /memory compatibility alias/u);
  assert.match(script, /darwin-arm64/u);
  assert.match(script, /native_target_not_published/u);
  assert.equal(script.includes("sudo"), false);
  assert.equal(script.includes("hash_command -a 256"), false);
});

test("native Windows installer covers both supported Node architectures", () => {
  const script = readFileSync(new URL("../../install.ps1", import.meta.url), "utf8");
  assert.match(script, /native_target_not_published/u);
  assert.match(script, /win-x64/u);
  assert.match(script, /Get-FileHash -Algorithm SHA256/u);
  assert.match(script, /installer_requires_https/u);
 assert.match(script, /native_archive_hash_mismatch/u);
 assert.match(script, /native_archive_download_failed/u);
 assert.match(script, /native_archive_checksum_invalid/u);
  assert.match(script, /native_archive_invalid/u);
  assert.match(script, /installer_version_invalid/u);
  assert.match(script, /PROCESSOR_ARCHITEW6432/u);
  assert.match(script, /LOCALAPPDATA/u);
  assert.match(script, /agent-mem\.cmd/u);
  assert.match(script, /github\.com\/Abuarchiv\/agent-memory-v1/u);
  assert.equal(script.includes("Abuarchiv/agent-mem/releases"), false);
  assert.equal(script.includes("Abuarchiv/agent-mem/main"), false);
  assert.match(script, /memory\.cmd/u);
});

test("release gate validates both archive layouts and the complete published target set", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
 assert.match(workflow, /archive="agent-mem-\$\{\{ matrix\.target \}\}\.tar\.gz"/u);
 assert.match(workflow, /agent-mem-package\/agent-mem/u);
 assert.match(workflow, /unix_archive_layout_invalid/u);
 assert.match(workflow, /windows_archive_layout_invalid/u);
  assert.match(workflow, /Verify published asset set/u);
  assert.match(workflow, /darwin-arm64 darwin-x64 linux-x64 win-x64/u);
});

test("native Unix installer serializes activation with a private dead-PID-recoverable lock", () => {
  const script = readFileSync(new URL("../../install.sh", import.meta.url), "utf8");
  assert.match(script, /install\.lock/u);
  assert.match(script, /native_install_busy/u);
  assert.match(script, /native_install_lock_unverified/u);
  assert.match(script, /acquire_install_lock/u);
  assert.match(script, /release_install_lock/u);
  assert.match(script, /kill -0/u);
  assert.match(script, /chmod 600/u);
  assert.match(script, /project_status=\$?/u);
  assert.match(script, /exit "\$project_status"/u);
  assert.match(script, /raw\.githubusercontent\.com\/Abuarchiv\/agent-memory-v1\/main\/install\.sh/u);
});

test("native Windows installer serializes activation with a bounded named mutex", () => {
  const script = readFileSync(new URL("../../install.ps1", import.meta.url), "utf8");
  assert.match(script, /System\.Threading\.Mutex/u);
  assert.match(script, /AgentMemNativeInstall/u);
  assert.match(script, /WaitOne\(0\)/u);
  assert.match(script, /native_install_busy/u);
  assert.match(script, /ReleaseMutex/u);
  assert.match(script, /\.Dispose\(\)/u);
  assert.match(script, /\$projectExit/u);
  assert.match(script, /exit \$projectExit/u);
});
