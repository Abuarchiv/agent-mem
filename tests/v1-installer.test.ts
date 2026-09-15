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
  assert.match(script, /darwin-arm64/u);
  assert.match(script, /linux-arm64/u);
  assert.equal(script.includes("sudo"), false);
  assert.equal(script.includes("hash_command -a 256"), false);
});

test("native Windows installer covers both supported Node architectures", () => {
  const script = readFileSync(new URL("../../install.ps1", import.meta.url), "utf8");
  assert.match(script, /win-arm64/u);
  assert.match(script, /win-x64/u);
  assert.match(script, /Get-FileHash -Algorithm SHA256/u);
  assert.match(script, /installer_requires_https/u);
  assert.match(script, /native_archive_hash_mismatch/u);
});
