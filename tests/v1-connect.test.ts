import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configureHost } from "../src/v1/connect.js";
import { socketPath } from "../src/v1/config.js";

test("OpenCode JSONC is merged, backed up, and remains idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "v1-connect-jsonc-"));
  const project = join(root, "project");
  const data = join(root, "data");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(join(project, "opencode.jsonc"), `{
    // A foreign server must survive the merge.
    "mcp": { "foreign": { "type": "local", "command": ["foreign"] }, },
    "plugin": [],
  }\n`, { mode: 0o600 });
  try {
    const first = configureHost(data, "opencode", project);
    assert.equal(first.state, "configured");
    const merged = JSON.parse(readFileSync(join(project, "opencode.jsonc"), "utf8")) as { mcp: Record<string, unknown> };
    assert.ok(merged.mcp.foreign);
    assert.ok(merged.mcp.agent_mem);
    assert.equal(readdirSync(join(data, "backups")).length, 1);
    const second = configureHost(data, "opencode", project);
    assert.equal(second.state, "configured");
    assert.equal(readdirSync(join(data, "backups")).length, 1);
    assert.equal(existsSync(join(project, "opencode.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid OpenCode JSONC fails with a stable parser error", () => {
  const root = mkdtempSync(join(tmpdir(), "v1-connect-jsonc-invalid-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  writeFileSync(join(project, "opencode.jsonc"), "{ // missing value\n \"mcp\": }\n", { mode: 0o600 });
  try { assert.throws(() => configureHost(join(root, "data"), "opencode", project), /host_config_invalid_jsonc/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
test("already configured host stays idempotent while the owned broker is running", () => {
 const root = mkdtempSync(join(tmpdir(), "v1-connect-running-"));
 const project = join(root, "project");
 const data = join(root, "data");
 mkdirSync(project, { recursive: true, mode: 0o700 });
 try {
  configureHost(data, "opencode", project);
  writeFileSync(socketPath(data), "owned broker marker", { mode: 0o600 });
  assert.doesNotThrow(() => configureHost(data, "opencode", project));
 } finally {
  rmSync(root, { recursive: true, force: true });
 }
});
