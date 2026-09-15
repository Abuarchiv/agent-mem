import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTALLABLE_HOSTS,
  InstallError,
  createInstallPlan,
  detectInstallHosts,
  ensureOwnedService,
  parseInstallArgs,
 stopOwnedService,
 validateMcpToolList,
  type InstallHostProbe,
} from "../src/v1/install.js";

const allDetected: InstallHostProbe = { codex: true, opencode: true, "copilot-cli": true };

test("install defaults to the current project, all detected V1 hosts, and recommended extras", () => {
  assert.deepEqual(parseInstallArgs([], "/work/project"), {
    project: "/work/project",
    hosts: "auto",
    rerank: true,
    nonInteractive: false,
  });
  assert.deepEqual(detectInstallHosts("auto", allDetected), [...INSTALLABLE_HOSTS]);
});

test("install accepts explicit hosts and an explicit core-only opt-out", () => {
  assert.deepEqual(parseInstallArgs([
    "--project", "/tmp/my project", "--agents", "codex,opencode", "--core-only", "--yes",
  ], "/work"), {
    project: "/tmp/my project",
    hosts: ["codex", "opencode"],
    rerank: false,
    nonInteractive: true,
  });
});

test("install rejects unknown, duplicate, and conflicting options", () => {
  assert.throws(() => parseInstallArgs(["--agents", "codex,unknown"], "/work"), (error: unknown) => error instanceof InstallError && error.code === "install_host_invalid");
  assert.throws(() => parseInstallArgs(["--agents", "codex,codex"], "/work"), (error: unknown) => error instanceof InstallError && error.code === "install_host_duplicate");
  assert.throws(() => parseInstallArgs(["--core-only", "--rerank"], "/work"), (error: unknown) => error instanceof InstallError && error.code === "install_feature_conflict");
});

test("explicit host selection remains authoritative before the host app is detected", () => {
  assert.deepEqual(detectInstallHosts(["codex"], { codex: false, opencode: false, "copilot-cli": false }), ["codex"]);
});

test("install plan preserves selected hosts and reports missing host applications", () => {
  assert.deepEqual(createInstallPlan({
    project: "/work/project", hosts: ["codex", "opencode"], rerank: true, nonInteractive: false,
  }, { codex: true, opencode: false, "copilot-cli": false }), {
    project: "/work/project", hosts: ["codex", "opencode"], detectedHosts: ["codex"],
    notDetectedHosts: ["opencode"], rerank: true, nonInteractive: false,
  });
});

test("auto host selection fails clearly when no supported host is detected", () => {
  assert.throws(() => detectInstallHosts("auto", { codex: false, opencode: false, "copilot-cli": false }), (error: unknown) => error instanceof InstallError && error.code === "install_no_host_detected");
});

test("owned service recovery never starts a second owner", async () => {
  let starts = 0;
  const result = await ensureOwnedService({
    isRunning: async () => true,
    start: async () => { starts += 1; return 42; },
  });
  assert.deepEqual(result, { state: "already_running" });
  assert.equal(starts, 0);
});

test("owned service recovery waits for an existing starting owner", async () => {
  let probes = 0;
  let starts = 0;
  const result = await ensureOwnedService({
    isRunning: async () => ++probes >= 3,
    isStarting: async () => true,
    start: async () => { starts += 1; return 42; },
  }, { timeoutMs: 100, pollMs: 1 });
  assert.deepEqual(result, { state: "already_running" });
  assert.equal(starts, 0);
});

test("owned service recovery reports a stable error when readiness never arrives", async () => {
  await assert.rejects(ensureOwnedService({ isRunning: async () => false, start: async () => 42 }, { timeoutMs: 2, pollMs: 1 }), (error: unknown) => error instanceof InstallError && error.code === "install_broker_not_ready");
});

test("owned service stop is safe, bounded, and ownership-aware", async () => {
  let alive = true;
  let owner = { pid: 42, owned: true };
  const signals: NodeJS.Signals[] = [];
  const result = await stopOwnedService({
    findOwner: async () => owner,
    isAlive: async () => alive,
    signal: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
  }, { timeoutMs: 2, pollMs: 1 });
  assert.deepEqual(result, { state: "stopped", pid: 42 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  alive = true;
  owner = { pid: 42, owned: false };
  await assert.rejects(stopOwnedService({
    findOwner: async () => owner, isAlive: async () => alive, signal: () => undefined,
  }, { timeoutMs: 2, pollMs: 1 }), (error: unknown) => error instanceof InstallError && error.code === "install_owner_not_owned");
});
test("MCP install smoke requires every V1 core tool", () => {
 assert.equal(validateMcpToolList([
  { name: "memory_recall" },
  { name: "memory_get" },
  { name: "memory_forget" },
  { name: "memory_write" },
  { name: "extra_tool" },
 ]), 5);
 assert.throws(() => validateMcpToolList([{ name: "memory_recall" }]), (error: unknown) => error instanceof InstallError && error.code === "install_mcp_tools_failed");
 assert.throws(() => validateMcpToolList([{ name: "memory_recall" }, null]), (error: unknown) => error instanceof InstallError && error.code === "install_mcp_tools_failed");
});
