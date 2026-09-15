import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(process.argv[2] ?? join(root, "dist-v1/scripts/v1.js"));
const node = process.execPath;
const temporary = mkdtempSync(join(tmpdir(), "v1-connect-probe-"));
const project = join(temporary, "project"), directory = join(temporary, "data");
mkdirSync(project, { mode: 0o700 });
const call = (host, action = "connect", selected = project, data = directory) => new Promise((done, reject) => {
  const child = spawn(node, [entry, "--data-dir", data, action, host, "--project", selected], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.once("error", reject); child.once("exit", code => done({ code, stdout, stderr }));
});
try {
  const results = await Promise.all([call("codex"), call("opencode")]);
  for (let i = 0; i < results.length; i++) {
    if (results[i].code !== 0) {
      assert.match(results[i].stderr, /configuration_busy_retry|v1_backend_already_running/);
      assert.equal((await call(i === 0 ? "codex" : "opencode")).code, 0);
    }
  }
  const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
  assert.equal(config.connections.length, 2);
  assert.equal(new Set(config.connections.map(c => c.scope_id)).size, 1);
  const hooksPath = join(project, ".codex/hooks.json");
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) for (const hook of group.hooks) hook.command = hook.command.replace(/^.* --config /, "'/previous/package/node' '/previous/package/hook.js' --config ");
  }
  hooks.hooks.SessionStart.push({ hooks: [{ type: "command", command: "echo foreign-preserved" }] });
  writeFileSync(hooksPath, JSON.stringify(hooks));
  assert.equal((await call("codex")).code, 0);
  const refreshed = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.equal(refreshed.hooks.SessionStart.flatMap(g => g.hooks).length, 2);
  assert.equal((await call("codex", "disconnect")).code, 0);
  const disconnected = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.deepEqual(disconnected.hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo foreign-preserved" }] }]);
  assert.equal(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")).connections.length, 1);

  const malicious = join(temporary, "linked-project"), foreign = join(temporary, "foreign");
  mkdirSync(malicious); mkdirSync(foreign);
  const original = "# foreign configuration must not change\n";
  writeFileSync(join(foreign, "config.toml"), original);
  symlinkSync(foreign, join(malicious, ".codex"));
  const linked = await call("codex", "connect", malicious, join(temporary, "other-data"));
  assert.notEqual(linked.code, 0); assert.match(linked.stderr, /must_not_be_symlink/);
  assert.equal(readFileSync(join(foreign, "config.toml"), "utf8"), original);
  console.log("PASS: real CLI concurrent connect, shared project identity, package-path change, disconnect preservation and symlink rejection");
} finally { rmSync(temporary, { recursive: true, force: true }); }
