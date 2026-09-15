import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { connect as tlsConnect } from "node:tls";
import { IPC_PSK_CIPHER, IPC_TLS_VERSION } from "../src/host/ipc.js";

import { createRuntime } from "../src/app/runtime.js";
import { RuntimeCleanupWorker } from "../src/runtime/cleanup.js";
import { createPolicyOutputBinding, createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { E5_MODEL_MANIFEST } from "../src/models/manifest.js";
import type { E5EmbedderReport, LocalE5Embedder } from "../src/models/embedding.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryBroker, AgentMemoryBrokerClient, BrokerError } from "../src/host/broker.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const setupId = "33333333-3333-4333-8333-333333333333";
const outputId = "44444444-4444-4444-8444-444444444444";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const sourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

function binding(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "broker-owner-test" },
    host_instance_id: "broker-owner-host",
    host_session_id: "broker-owner-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:xp-copilot"] },
  });
}

function envelope(host: TrustedBinding, text: string): unknown {
  const captureId = randomUUID();
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: host.host_kind,
      surface: host.surface,
      execution_domain: { ...host.execution_domain },
      host_instance_id: host.host_instance_id,
      host_session_id: host.host_session_id,
    },
    adapter_version: "0.1.0",
    event: { stage: "prompt_submitted", role: "user", evidence_class: "prompt", native_ids: { session_id: "synthetic", turn_id: captureId }, text },
    payload: { text },
    captured_at: new Date().toISOString(),
    occurred_at: new Date().toISOString(),
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function fakeEmbedding(onDispose: () => void): LocalE5Embedder {
  let state: E5EmbedderReport["state"] = "ready";
  return {
    manifest: E5_MODEL_MANIFEST,
    countTokens: () => 1,
    embed: async ({ texts }) => texts.map(() => Float32Array.from({ length: E5_MODEL_MANIFEST.dimensions }, (_, index) => index === 0 ? 1 : 0)),
    dispose: async () => { state = "disposed"; onDispose(); },
    report: () => ({
      state,
      model_root: "/synthetic/model",
      model_id: E5_MODEL_MANIFEST.model_id,
      revision: E5_MODEL_MANIFEST.revision,
      dimensions: E5_MODEL_MANIFEST.dimensions,
      max_tokens: E5_MODEL_MANIFEST.max_tokens,
      dtype: "q8",
      device: "cpu",
      batch_strategy: "rowwise_batch1",
      input_count: 0,
      completed_batches: 0,
    }),
  };
}

function runtimeOptions(directory: string, host: TrustedBinding, embedding: LocalE5Embedder, reloadEmbedding?: () => Promise<LocalE5Embedder>) {
  const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["local_ui"] });
  const output = createPolicyOutputBinding(policy, { version: 1, output_binding_id: outputId, setup_id: setupId, scope_id: scopeId, target: "local_ui" });
  return {
    vaultPath: join(directory, "vault.sqlite"),
    embedding,
    ...(reloadEmbedding === undefined ? {} : { reloadEmbedding }),
    scope: { scope_id: scopeId, kind: "project" as const, owner_ref: "broker-owner-test", created_at: "2026-09-09T08:00:00.000Z" },
    policyBinding: policy,
    outputBinding: output,
    hostBinding: host,
    initialize: (database: Parameters<typeof setScopeOutputGrants>[0], updatedAt: string) => setScopeOutputGrants(database, policy, scopeId, [{ target: "local_ui", source_classes: [...sourceClasses] }], updatedAt),
  };
}

test("borrowed TLS broker follows the runtime scheduler across reset and never owns its E5", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-reset-"));
  const host = binding();
  let disposed = 0;
  const firstModel = fakeEmbedding(() => { disposed += 1; });
  let replacementModel: LocalE5Embedder | undefined;
  const runtime = await createRuntime(runtimeOptions(directory, host, firstModel, async () => {
    replacementModel = fakeEmbedding(() => { disposed += 1; });
    return replacementModel;
  }));
  mkdirSync(join(directory, "runtime"), { mode: 0o700 });
  const broker = new AgentMemoryBroker({
    runtimeDirectory: join(directory, "runtime"),
    credentials: [{ binding: host, secret }],
    owner: runtime.brokerOwner,
  });
  const client = new AgentMemoryBrokerClient({ socketPath: join(directory, "runtime", "broker.sock"), credential: { binding: host, secret } });
  try {
    const address = await broker.start();
    const firstScheduler = runtime.brokerOwner.scheduler;
    await client.connect();
    const first = await client.capture(envelope(host, "before runtime reset"));
    assert.equal(runtime.database.getCounts().source_count, 1n);
    await client.close();
    await broker.stop();
    assert.equal(firstModel.report().state, "ready");
    await broker.start();
    await client.connect();
    await runtime.purge(first.capture_id);
    assert.notEqual(runtime.brokerOwner.scheduler, firstScheduler);
    assert.equal(disposed, 1);
    assert.equal(broker.schedulerStatus.admission, "open");
    const second = await client.capture(envelope(host, "after runtime reset"));
    assert.equal(second.capture_id.length, 36);
    assert.equal(runtime.database.getCounts().source_count, 1n);
    assert.equal(address.serverId.length, 36);
  } finally {
    await client.close();
    await broker.stop();
    await runtime.close();
    assert.equal(replacementModel?.report().state, "disposed");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("borrowed TLS broker rejects a capture during the real backup transaction before DB access", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-backup-"));
  const host = binding();
  const runtime = await createRuntime(runtimeOptions(directory, host, fakeEmbedding(() => undefined)));
  mkdirSync(join(directory, "runtime"), { mode: 0o700 });
  const broker = new AgentMemoryBroker({ runtimeDirectory: join(directory, "runtime"), credentials: [{ binding: host, secret }], owner: runtime.brokerOwner });
  const client = new AgentMemoryBrokerClient({ socketPath: join(directory, "runtime", "broker.sock"), credential: { binding: host, secret } });
  const originalExec = DatabaseSync.prototype.exec;
  let captureAttempt: Promise<unknown> | undefined;
  try {
    await broker.start();
    await client.connect();
    DatabaseSync.prototype.exec = function (sql: string) {
      const result = originalExec.call(this, sql);
      if (sql === "BEGIN EXCLUSIVE" && captureAttempt === undefined) {
        captureAttempt = client.capture(envelope(host, "must be rejected during backup")).then(() => "accepted", (error: unknown) => error);
      }
      return result;
    };
    await runtime.createBackup(join(directory, "backup"));
    const outcome = await captureAttempt;
    assert.ok(outcome instanceof BrokerError);
    assert.notEqual(outcome.code, "transport_timeout");
    assert.equal(runtime.database.getCounts().source_count, 0n);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    await client.close();
    await broker.stop();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracked cleanup keeps runtime resources open until its delayed promise settles", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-cleanup-"));
  const originalSync = RuntimeCleanupWorker.prototype.reconcileStartupSync;
  const originalAsync = RuntimeCleanupWorker.prototype.reconcileStartup;
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const cleanupStart = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  RuntimeCleanupWorker.prototype.reconcileStartupSync = () => ({ inspected: 0, removed: 0, pending: 0, ownership_uncertain: 0, remaining: 1 });
  RuntimeCleanupWorker.prototype.reconcileStartup = async () => {
    cleanupStarted();
    await cleanupGate;
    return { inspected: 1, removed: 1, pending: 0, ownership_uncertain: 0, remaining: 0 };
  };
  let disposed = 0;
  const runtime = await createRuntime(runtimeOptions(directory, binding(), fakeEmbedding(() => { disposed += 1; })));
  try {
    await cleanupStart;
    await assert.rejects(runtime.createBackup(join(directory, "blocked-backup")), /runtime_maintenance_pending/);
    const closing = runtime.close();
    await assert.rejects(closing, /restore_runtime_drain_pending/);
    assert.equal(disposed, 0);
    assert.equal(runtime.status().state, "degraded");
    releaseCleanup();
    while ((runtime.brokerOwner.scheduler.status().cleanup_active ?? 0) !== 0) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await runtime.close();
    assert.equal(disposed, 1);
  } finally {
    releaseCleanup();
    RuntimeCleanupWorker.prototype.reconcileStartupSync = originalSync;
    RuntimeCleanupWorker.prototype.reconcileStartup = originalAsync;
    await runtime.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone broker can stop and reconnect without reopening a second owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-standalone-"));
  const host = binding();
  mkdirSync(join(directory, "runtime"), { mode: 0o700 });
  const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["local_ui"] });
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"));
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "standalone", created_at: "2026-09-09T08:00:00.000Z" });
  database.registerSession(scopeId, host, "2026-09-09T08:00:00.000Z");
  setScopeOutputGrants(database, policy, scopeId, [{ target: "local_ui", source_classes: [...sourceClasses] }], "2026-09-09T08:00:01.000Z");
  const broker = new AgentMemoryBroker({ database, runtimeDirectory: join(directory, "runtime"), credentials: [{ binding: host, secret }] });
  try {
    const firstAddress = await broker.start();
    const firstClient = new AgentMemoryBrokerClient({ socketPath: firstAddress.socketPath, credential: { binding: host, secret } });
    assert.equal((await firstClient.capture(envelope(host, "standalone first"))).commit_seq, "1");
    await firstClient.close();
    await broker.stop();
    const secondAddress = await broker.start();
    const secondClient = new AgentMemoryBrokerClient({ socketPath: secondAddress.socketPath, credential: { binding: host, secret } });
    assert.equal((await secondClient.capture(envelope(host, "standalone reconnect"))).commit_seq, "2");
    await secondClient.close();
  } finally {
    await broker.stop();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("native handshake rejects pipelined hello and requests before admitting a second authority", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-hello-"));
  const host = binding();
  const runtime = await createRuntime(runtimeOptions(directory, host, fakeEmbedding(() => undefined)));
  mkdirSync(join(directory, "runtime"), { mode: 0o700 });
  const broker = new AgentMemoryBroker({ runtimeDirectory: join(directory, "runtime"), credentials: [{ binding: host, secret, allowNativeSessions: true }], owner: runtime.brokerOwner });
  try {
    const address = await broker.start();
    for (const second of [
      { version: 1, kind: "hello", binding_id: host.binding_id, native_session_id: "second" },
      { version: 1, kind: "capture", seq: 1, request_id: randomUUID(), event: envelope(host, "pipelined content") },
    ]) {
      const socket = tlsConnect({ path: address.socketPath, ciphers: IPC_PSK_CIPHER, minVersion: IPC_TLS_VERSION, maxVersion: IPC_TLS_VERSION, rejectUnauthorized: false, pskCallback: () => ({ identity: host.binding_id, psk: Buffer.from(secret) }) });
      let data = "";
      socket.on("data", (chunk: Buffer) => { data += chunk.toString("utf8"); });
      try {
        await once(socket, "secureConnect");
        const closed = once(socket, "close");
        socket.write([{ version: 1, kind: "hello", binding_id: host.binding_id, native_session_id: "first" }, second].map((frame) => JSON.stringify(frame) + "\n").join(""));
        await closed;
        const frames = data.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        assert.ok(frames.some((frame) => frame.code === "authentication_failed"));
        assert.equal(frames.some((frame) => frame.kind === "ready"), false);
        assert.equal(runtime.database.getCounts().source_count, 0n);
      } finally { socket.destroy(); }
    }
  } finally {
    await broker.stop();
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual capture rejects and query waits while owner cleanup is active", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "broker-owner-manual-"));
  const originalSync = RuntimeCleanupWorker.prototype.reconcileStartupSync;
  const originalAsync = RuntimeCleanupWorker.prototype.reconcileStartup;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  RuntimeCleanupWorker.prototype.reconcileStartupSync = () => ({ inspected: 0, removed: 0, pending: 0, ownership_uncertain: 0, remaining: 1 });
  RuntimeCleanupWorker.prototype.reconcileStartup = async () => { entered(); await gate; return { inspected: 0, removed: 0, pending: 0, ownership_uncertain: 0, remaining: 0 }; };
  const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["local_ui", "reader:codex_cli"] });
  const runtime = await createRuntime({ ...runtimeOptions(directory, binding(), fakeEmbedding(() => undefined)), policyBinding: policy,
    initialize: (database, updatedAt) => setScopeOutputGrants(database, policy, scopeId, ["local_ui", "reader:codex_cli"].map((target) => ({ target, source_classes: [...sourceClasses] })), updatedAt),
  });
  try {
    await started;
    await assert.rejects(runtime.ingest("manual capture waits for cleanup"), /scheduler_closed/);
    const query = runtime.query("manual capture");
    assert.equal(runtime.brokerOwner.scheduler.status().cleanup_active, 1);
    assert.equal(runtime.brokerOwner.scheduler.status().interactive_queued, 1);
    assert.equal(runtime.database.getCounts().source_count, 0n);
    release();
    await query;
    await runtime.ingest("manual capture resumes after cleanup");
    assert.equal(runtime.database.getCounts().source_count, 1n);
  } finally {
    release();
    RuntimeCleanupWorker.prototype.reconcileStartupSync = originalSync;
    RuntimeCleanupWorker.prototype.reconcileStartup = originalAsync;
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
