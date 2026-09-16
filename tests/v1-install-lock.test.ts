import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensurePrivateDirectory } from "../src/v1/config.js";
import { acquireOwnerLock } from "../src/v1/lock.js";

function setupRuntime(): { readonly root: string; readonly runtime: string } {
  const root = mkdtempSync(join(tmpdir(), "v1-install-lock-"));
  ensurePrivateDirectory(root);
  const runtime = join(root, "ipc");
  ensurePrivateDirectory(runtime);
  return { root, runtime };
}

test("install command lock serializes concurrent installers without colliding with owner/config locks", () => {
  const { root, runtime } = setupRuntime();
  try {
    const releaseInstall = acquireOwnerLock(runtime, "agent-mem-install", "install.lock");
    assert.equal(existsSync(join(runtime, "install.lock")), true);
    assert.throws(() => acquireOwnerLock(runtime, "agent-mem-install", "install.lock"), /install_busy_retry/);
    const releaseOwner = acquireOwnerLock(runtime, "some-installation-id");
    const releaseConfig = acquireOwnerLock(runtime, "agent-mem-config", "config.lock");
    releaseOwner();
    releaseConfig();
    releaseInstall();
    releaseInstall();
    assert.equal(existsSync(join(runtime, "install.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner and config locks keep their stable busy codes", () => {
  const { root, runtime } = setupRuntime();
  try {
    const releaseOwner = acquireOwnerLock(runtime, "some-installation-id");
    assert.throws(() => acquireOwnerLock(runtime, "some-installation-id"), /v1_backend_already_running/);
    releaseOwner();
    const releaseConfig = acquireOwnerLock(runtime, "agent-mem-config", "config.lock");
    assert.throws(() => acquireOwnerLock(runtime, "agent-mem-config", "config.lock"), /configuration_busy_retry/);
    releaseConfig();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install lock recovers a clearly-owned dead-PID lock and rejects a foreign lock", () => {
  const { root, runtime } = setupRuntime();
  try {
    writeFileSync(join(runtime, "install.lock"), JSON.stringify({ installation_id: "agent-mem-install", pid: 2147483647 }) + "\n", { mode: 0o600 });
    const releaseRecovered = acquireOwnerLock(runtime, "agent-mem-install", "install.lock");
    releaseRecovered();
    assert.equal(existsSync(join(runtime, "install.lock")), false);
    writeFileSync(join(runtime, "install.lock"), JSON.stringify({ installation_id: "someone-else", pid: 2147483647 }) + "\n", { mode: 0o600 });
    assert.throws(() => acquireOwnerLock(runtime, "agent-mem-install", "install.lock"), /install_lock_unverified/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
