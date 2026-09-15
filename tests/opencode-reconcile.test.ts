import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Message, Part } from "@opencode-ai/sdk";

import { createOpenCodeReconcilePlan } from "../adapters/opencode/reconcile.js";
import { OpenCodeBridgeClient } from "../adapters/opencode/bridge-client.js";
import { OpenCodePluginRuntime, createOpenCodePluginConfig } from "../adapters/opencode/plugin-runtime.js";
import { AgentMemoryBroker } from "../src/host/broker.js";
import { normalizeNativeEvent } from "../src/host/events.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { observeNative } from "../src/core/capture.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { fullPurge } from "../src/core/purge.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "81818181-8181-4818-8818-818181818181";
const bindingId = "82828282-8282-4828-8828-828282828282";
const setupId = "83838383-8383-4838-8838-838383838383";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const bridgePath = fileURLToPath(new URL("../adapters/opencode/bridge.js", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("../../tests/fixtures/opencode.json", import.meta.url), "utf8")) as {
  readonly session_id: string;
  readonly messages: readonly { readonly info: Message; readonly parts: Part[] }[];
};

function bindingFor(nativeSessionId = "opencode-reconcile-session"): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "opencode",
    surface: "opencode_cli",
    execution_domain: { kind: "local", id: "local-opencode-reconcile-test" },
    host_instance_id: "opencode-installation-reconcile-test",
    host_session_id: nativeSessionId,
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:opencode_cli"], provider_targets: [] },
  });
}

function eventInput(
  binding: TrustedBinding,
  text: string,
  input: { readonly capture_id?: string; readonly message_id: string; readonly part_id: string; readonly captured_at: string },
): ReturnType<typeof normalizeNativeEvent> {
  return normalizeNativeEvent({
    version: 1,
    ...(input.capture_id === undefined ? {} : { capture_id: input.capture_id }),
    scope_id: scopeId,
    adapter_version: "1.0.0",
    stage: "message_part",
    role: "assistant",
    evidence_class: "assistant_output",
    native_ids: { session_id: binding.host_session_id, message_id: input.message_id, part_id: input.part_id },
    text,
    payload: { session_id: binding.host_session_id, message_id: input.message_id, part_id: input.part_id, text },
    captured_at: input.captured_at,
    coverage: { status: "complete" },
    correlation: { status: "correlated", basis: "native_ids", key: `${input.message_id}:${input.part_id}` },
  }, binding);
}

function setupDatabase(dir: string, nativeSessionId = "opencode-reconcile-session"): { readonly db: AgentMemoryDatabase; readonly binding: TrustedBinding; readonly policy: ReturnType<typeof createPolicySetupBinding> } {
  const db = new AgentMemoryDatabase(join(dir, "vault.sqlite"));
  const binding = bindingFor(nativeSessionId);
  const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:opencode_cli"] });
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "opencode-reconcile-test", created_at: "2026-09-08T10:00:00Z" });
  setScopeOutputGrants(db, policy, scopeId, [{ target: "reader:opencode_cli", source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }], "2026-09-08T10:00:01Z");
  db.registerSession(scopeId, binding, "2026-09-08T10:00:02Z");
  return { db, binding, policy };
}

function rawDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
}

test("native receipts preserve first observation across identical replay and reject changed event content", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-receipt-"));
  const { db, binding } = setupDatabase(dir);
  const captureId = "91919191-9191-4919-8919-919191919191";
  try {
    const first = observeNative(
      eventInput(binding, "first durable part", { capture_id: captureId, message_id: "message-a", part_id: "part-a", captured_at: "2026-09-08T10:01:00Z" }),
      binding,
      db,
      { version: 1, identity: { kind: "event", key: "event-a" } },
    );
    const replay = observeNative(
      eventInput(binding, "first durable part", { capture_id: "94949494-9494-4994-8994-949494949494", message_id: "message-a", part_id: "part-a", captured_at: "2026-09-08T10:09:00Z" }),
      binding,
      db,
      { version: 1, identity: { kind: "event", key: "event-a" } },
    );
    assert.deepEqual(replay, first);
    assert.throws(
      () => observeNative(
        eventInput(binding, "changed event body", { capture_id: "95959595-9595-4959-8959-959595959595", message_id: "message-a", part_id: "part-a", captured_at: "2026-09-08T10:10:00Z" }),
        binding,
        db,
        { version: 1, identity: { kind: "event", key: "event-a" } },
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "native_observation_conflict",
    );
    const raw = rawDatabase(join(dir, "vault.sqlite"));
    try {
      const receipt = raw.prepare("SELECT capture_id, first_observed_at, content_digest, state FROM opencode_observation_receipt WHERE capture_id = ?").get(captureId) as Record<string, unknown>;
      assert.equal(receipt.capture_id, captureId);
      assert.equal(receipt.first_observed_at, "2026-09-08T10:01:00Z");
      assert.equal(receipt.state, "active");
      assert.match(String(receipt.content_digest), /^[a-f0-9]{64}$/);
    } finally {
      raw.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("part heads record A to B to A as three generations and fence a stale scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-head-"));
  const { db, binding } = setupDatabase(dir);
  try {
    const scan = db.beginNativeReconcileScan(binding, scopeId, "2026-09-08T10:02:00Z");
    const make = (text: string, scanInput?: { readonly scan_id: string; readonly scan_watermark: string }): string => {
      const normalized = eventInput(binding, text, { message_id: "message-head", part_id: "part-head", captured_at: new Date().toISOString() });
      const ack = observeNative(normalized, binding, db, {
        version: 1,
        identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-head", part_id: "part-head" },
        ...(scanInput === undefined ? {} : scanInput),
      });
      return ack.capture_id;
    };
    const first = make("A", { scan_id: scan.scan_id, scan_watermark: scan.watermark });
    const second = make("B");
    const third = make("A");
    assert.notEqual(first, second);
    assert.notEqual(second, third);
    assert.notEqual(first, third);
    const raw = rawDatabase(join(dir, "vault.sqlite"));
    try {
      const head = raw.prepare("SELECT generation, current_capture_id, state FROM opencode_observation_head WHERE message_id = ? AND part_id = ?").get("message-head", "part-head") as Record<string, unknown>;
      assert.equal(head.generation, 3n);
      assert.equal(head.current_capture_id, third);
      assert.equal(head.state, "active");
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM opencode_observation_receipt WHERE identity_kind = 'part_snapshot'").get() as Record<string, unknown>).count, 3n);
    } finally {
      raw.close();
    }
    assert.throws(
      () => observeNative(
        eventInput(binding, "late stale state", { message_id: "message-head", part_id: "part-head", captured_at: "2026-09-08T10:04:00Z" }),
        binding,
        db,
        {
          version: 1,
          identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-head", part_id: "part-head" },
          scan_id: scan.scan_id,
          scan_watermark: scan.watermark,
        },
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "native_cursor_conflict",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor advancement is accepted only after acknowledged receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-cursor-"));
  const { db, binding } = setupDatabase(dir);
  try {
    const scan = db.beginNativeReconcileScan(binding, scopeId, "2026-09-08T10:05:00Z");
    const ack = observeNative(
      eventInput(binding, "cursor source", { message_id: "message-cursor", part_id: "part-cursor", captured_at: "2026-09-08T10:05:01Z" }),
      binding,
      db,
      { version: 1, identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-cursor", part_id: "part-cursor" }, scan_id: scan.scan_id, scan_watermark: scan.watermark },
    );
    const advanced = db.advanceNativeReconcileCursor({
      binding,
      scan_id: scan.scan_id,
      cursor: { message_id: "message-cursor", part_id: "part-cursor" },
      capture_ids: [ack.capture_id],
      complete: true,
      updated_at: "2026-09-08T10:05:02Z",
    });
    assert.equal(advanced.state, "completed");
    assert.deepEqual(advanced.cursor, { message_id: "message-cursor", part_id: "part-cursor" });
    assert.throws(
      () => db.advanceNativeReconcileCursor({
        binding,
        scan_id: scan.scan_id,
        cursor: null,
        capture_ids: [],
        complete: false,
        updated_at: "2026-09-08T10:05:03Z",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "native_cursor_conflict",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile planner captures old assistant/tool parts, leaves final/history gaps explicit, and drops own context echo", () => {
  const ownContext = {
    id: "own-context-part",
    sessionID: fixture.session_id,
    messageID: "assistant-message-a",
    type: "text" as const,
    synthetic: true,
    text: JSON.stringify({ version: 1, kind: "agent_memory_context", injection_id: "a6464646-4646-4464-8464-646464646464", mode: "current", items: [] }),
    metadata: { agent_memory: "context", injection_id: "a6464646-4646-4464-8464-646464646464" },
  };
  const plan = createOpenCodeReconcilePlan([
    ...fixture.messages,
    { info: fixture.messages[0]!.info, parts: [ownContext as unknown as Part] },
  ], { recognizedPartKeys: new Set([`${fixture.messages.length}:0`]) });
  const untrusted = createOpenCodeReconcilePlan([{ info: fixture.messages[0]!.info, parts: [ownContext as unknown as Part] }]);
  assert.equal(untrusted.observations.length, 1);
  assert.equal(plan.observations.length, 2);
  assert.equal(plan.observations.some((entry) => entry.event.stage === "assistant_final"), false);
  assert.ok(plan.gaps.some((gap) => gap.reason === "assistant_final_unobserved"));
  assert.equal(plan.complete, true);
  assert.deepEqual(plan.cursor, { message_id: "tool-message-a", part_id: "tool-part-a" });
});

test("reconcile planner drops own MCP tool parts but retains foreign MCP tool parts", () => {
  const info = {
    id: "own-mcp-message",
    sessionID: fixture.session_id,
    role: "assistant",
  } as unknown as Message;
  const own = {
    id: "own-mcp-part",
    sessionID: fixture.session_id,
    messageID: "own-mcp-message",
    type: "tool",
    callID: "own-mcp-call",
    tool: "agent_memory_v1_memory_recall",
    state: { status: "completed", input: {}, output: "own memory output", title: "own", metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as Part;
  const foreign = {
    ...own,
    id: "foreign-mcp-part",
    callID: "foreign-mcp-call",
    tool: "external-server_memory_recall",
    state: { status: "completed", input: {}, output: "foreign output", title: "foreign", metadata: {}, time: { start: 1, end: 2 } },
  } as unknown as Part;

  const plan = createOpenCodeReconcilePlan([{ info, parts: [own, foreign] }]);

  assert.deepEqual(plan.observations.map((entry) => entry.identity.kind === "part_snapshot" ? entry.identity.part_id : entry.identity.kind), ["foreign-mcp-part"]);
});

test("reconcile planner pages after its durable cursor with bounded overlap", () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    info: {
      id: `message-${index}`,
      sessionID: fixture.session_id,
      role: "assistant" as const,
      time: { created: 1725729600000 + index, completed: 1725729600001 + index },
    } as unknown as Message,
    parts: [{
      id: `part-${index}`,
      sessionID: fixture.session_id,
      messageID: `message-${index}`,
      type: "text" as const,
      text: `history-${index}`,
      time: { start: 1725729600000 + index, end: 1725729600001 + index },
    } as Part],
  }));
  const first = createOpenCodeReconcilePlan(messages);
  assert.equal(first.observations.length, 96);
  assert.equal(first.complete, false);
  const second = createOpenCodeReconcilePlan(messages, { cursor: first.cursor });
  assert.equal(second.complete, true);
  assert.equal(second.observations[0]?.identity.kind, "part_snapshot");
  assert.equal(second.observations[0]?.identity.kind === "part_snapshot" ? second.observations[0].identity.part_id : undefined, "part-87");
  assert.ok(second.gaps.some((gap) => gap.reason === "history_truncated"));
});

interface BrokerFixture {
  readonly dir: string;
  readonly projectDir: string;
  readonly db: AgentMemoryDatabase;
  readonly broker: AgentMemoryBroker;
  readonly clientConfigPath: string;
}

async function brokerFixture(): Promise<BrokerFixture> {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-bridge-reconcile-"));
  const projectDir = join(dir, "project");
  const runtimeDir = join(dir, "runtime");
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(projectDir, 0o700);
  chmodSync(runtimeDir, 0o700);
  const db = new AgentMemoryDatabase(join(dir, "vault.sqlite"));
  const installationBinding = createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "opencode",
    surface: "opencode_cli",
    execution_domain: { kind: "local", id: "local-opencode-bridge-reconcile-test" },
    host_instance_id: "opencode-bridge-reconcile-installation",
    host_session_id: "installation-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:opencode_cli"], provider_targets: [] },
  });
  const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:opencode_cli"] });
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "opencode-bridge-reconcile-test", created_at: "2026-09-08T11:00:00Z" });
  setScopeOutputGrants(db, policy, scopeId, [{ target: "reader:opencode_cli", source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }], "2026-09-08T11:00:01Z");
  const broker = new AgentMemoryBroker({ database: db, runtimeDirectory: runtimeDir, credentials: [{ binding: installationBinding, secret, allowNativeSessions: true }] });
  await broker.start();
  const clientConfigPath = join(dir, "bridge-config.json");
  writeFileSync(clientConfigPath, JSON.stringify({
    version: 1,
    native_version: "1.18.29",
    socket_path: join(runtimeDir, "broker.sock"),
    surface: "opencode_cli",
    binding: installationBinding,
    broker_secret_hex: secret.toString("hex"),
    projects: [{ scope_id: scopeId, workspace_roots: [projectDir] }],
    session_start_query: "synthetic OpenCode session context",
    adapter_version: "1.0.0",
    request_timeout_ms: 2_000,
    max_frame_bytes: 4_500_000,
  }), { mode: 0o600 });
  return { dir, projectDir, db, broker, clientConfigPath };
}

function bridgeClient(fixtureValue: BrokerFixture): OpenCodeBridgeClient {
  return new OpenCodeBridgeClient({ nodePath: process.execPath, bridgePath, configPath: fixtureValue.clientConfigPath, helperPath: dirname(process.execPath) });
}

test("real broker, Node helper, and OpenCode bridge reconcile parts, persist cursor, and replay after helper restart", async () => {
  const fixtureValue = await brokerFixture();
  const plan = createOpenCodeReconcilePlan(fixture.messages);
  const firstClient = bridgeClient(fixtureValue);
  try {
    const first = await firstClient.reconcile(fixture.session_id, fixtureValue.projectDir, plan.observations, plan.cursor, plan.complete, plan.gaps);
    assert.equal(first.cursor_committed, true);
    assert.equal(first.acknowledgements.length, 2);
    assert.equal(first.scan.state, "completed");
    assert.ok(first.gaps.some((gap) => gap.reason === "assistant_final_unobserved"));
    await firstClient.close();
    const restartedClient = bridgeClient(fixtureValue);
    try {
      const replay = await restartedClient.reconcile(fixture.session_id, fixtureValue.projectDir, plan.observations, plan.cursor, plan.complete, plan.gaps);
      assert.equal(replay.cursor_committed, true);
      assert.deepEqual(replay.acknowledgements.map((ack) => ack.capture_id), first.acknowledgements.map((ack) => ack.capture_id));
    } finally {
      await restartedClient.close();
    }
    const raw = rawDatabase(join(fixtureValue.dir, "vault.sqlite"));
    try {
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM source_event").get() as Record<string, unknown>).count, 2n);
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM opencode_observation_receipt").get() as Record<string, unknown>).count, 2n);
      const scan = raw.prepare("SELECT state, cursor_json FROM opencode_reconcile_scan WHERE native_session_id = ? ORDER BY updated_at DESC LIMIT 1").get(fixture.session_id) as Record<string, unknown>;
      assert.equal(scan.state, "completed");
      assert.match(String(scan.cursor_json), /tool-part-a/);
    } finally {
      raw.close();
    }
  } finally {
    await firstClient.close();
    await fixtureValue.broker.stop();
    fixtureValue.db.close();
    rmSync(fixtureValue.dir, { recursive: true, force: true });
  }
});

test("real OpenCode plugin runtime uses the helper-backed observation and transform path without model calls", async () => {
  const fixtureValue = await brokerFixture();
  const pluginConfig = createOpenCodePluginConfig({
    version: 1,
    native_version: "1.18.29",
    node_path: process.execPath,
    bridge_path: bridgePath,
    config_path: fixtureValue.clientConfigPath,
    hook_timeout_ms: 4_000,
    request_timeout_ms: 2_000,
    max_frame_bytes: 4_500_000,
  }, fixtureValue.projectDir);
  const runtime = new OpenCodePluginRuntime(pluginConfig, { readMessages: async () => structuredClone(output.messages) });
  const hooks = runtime.hooks();
  const userInfo = {
    id: "plugin-user-message",
    sessionID: fixture.session_id,
    role: "user" as const,
    time: { created: 1725729604000 },
    agent: "default",
    model: { providerID: "synthetic", modelID: "synthetic" },
    variant: "default",
  } as unknown as Message;
  const userPart = {
    id: "plugin-user-part",
    sessionID: fixture.session_id,
    messageID: "plugin-user-message",
    type: "text" as const,
    text: "plugin durable prompt",
  } as Part;
  const output = { messages: [{ info: userInfo, parts: [userPart] }] };
  try {
    await hooks["chat.message"]?.({ sessionID: fixture.session_id }, { message: userInfo as Extract<Message, { role: "user" }>, parts: [userPart] });
    await hooks.event?.({ event: { type: "message.part.updated", properties: { part: fixture.messages[0]!.parts[0] } } as never });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    assert.equal(output.messages[0]?.parts.length, 2);
    assert.equal((output.messages[0]?.parts[1] as { synthetic?: boolean } | undefined)?.synthetic, true);
    const beforeEcho = rawDatabase(join(fixtureValue.dir, "vault.sqlite"));
    const captureCount = beforeEcho.prepare("SELECT COUNT(*) AS n FROM source_event").get()?.n;
    beforeEcho.close();
    await hooks.event?.({ event: { type: "message.part.updated", properties: { part: output.messages[0]!.parts[1] } } as never });
    await runtime.dispose();
    const raw = rawDatabase(join(fixtureValue.dir, "vault.sqlite"));
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM source_event").get()?.n, captureCount);
    try {
      assert.ok(Number((raw.prepare("SELECT COUNT(*) AS count FROM opencode_observation_receipt").get() as Record<string, unknown>).count) >= 1);
      assert.ok(Number((raw.prepare("SELECT COUNT(*) AS count FROM opencode_observation_head").get() as Record<string, unknown>).count) >= 1);
    } finally {
      raw.close();
    }
  } finally {
    await runtime.dispose();
    await fixtureValue.broker.stop();
    fixtureValue.db.close();
    rmSync(fixtureValue.dir, { recursive: true, force: true });
  }
});

test("source purge clears native digests and blocks old part replay while a new part stays eligible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-purge-"));
  const { db, binding, policy } = setupDatabase(dir);
  try {
    const old = observeNative(
      eventInput(binding, "purge me", { message_id: "message-purge", part_id: "part-purge", captured_at: "2026-09-08T12:00:00Z" }),
      binding,
      db,
      { version: 1, identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-purge", part_id: "part-purge" } },
    );
    const purge = await fullPurge(db, policy, {
      version: 1,
      operation_id: "a7575757-5757-4757-8757-575757575757",
      scope_id: scopeId,
      capture_ids: [old.capture_id],
      expected_privacy_epoch: db.getScopePrivacyEpoch(scopeId),
      requested_at: "2026-09-08T12:01:00Z",
    });
    assert.equal(purge.state, "pending");
    assert.ok(purge.pending.includes("model_reset_unavailable"));
    const raw = rawDatabase(join(dir, "vault.sqlite"));
    try {
      const receipt = raw.prepare("SELECT content_digest, state FROM opencode_observation_receipt WHERE capture_id = ?").get(old.capture_id) as Record<string, unknown>;
      assert.equal(receipt.content_digest, null);
      assert.equal(receipt.state, "purged");
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM opencode_identity_tombstone WHERE identity_kind = 'part_snapshot'").get() as Record<string, unknown>).count, 1n);
      const head = raw.prepare("SELECT state, current_digest, current_capture_id FROM opencode_observation_head WHERE message_id = ? AND part_id = ?").get("message-purge", "part-purge") as Record<string, unknown>;
      assert.equal(head.state, "blocked");
      assert.equal(head.current_digest, null);
      assert.equal(head.current_capture_id, null);
    } finally {
      raw.close();
    }
    assert.throws(
      () => observeNative(
        eventInput(binding, "changed after purge", { message_id: "message-purge", part_id: "part-purge", captured_at: "2026-09-08T12:02:00Z" }),
        binding,
        db,
        { version: 1, identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-purge", part_id: "part-purge" } },
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "native_observation_blocked",
    );
    db.registerSession(scopeId, binding, "2026-09-08T12:03:00Z");
    const fresh = observeNative(
      eventInput(binding, "purge me", { message_id: "message-purge", part_id: "part-new", captured_at: "2026-09-08T12:03:00Z" }),
      binding,
      db,
      { version: 1, identity: { kind: "part_snapshot", session_id: binding.host_session_id, message_id: "message-purge", part_id: "part-new" } },
    );
    assert.notEqual(fresh.capture_id, old.capture_id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function runtimeFor(f: BrokerFixture, options: ConstructorParameters<typeof OpenCodePluginRuntime>[1] = {}): OpenCodePluginRuntime {
  return new OpenCodePluginRuntime(createOpenCodePluginConfig({
    version: 1, native_version: "1.18.29", node_path: process.execPath, bridge_path: bridgePath,
    config_path: f.clientConfigPath, hook_timeout_ms: 4_000, request_timeout_ms: 2_000, max_frame_bytes: 4_500_000,
  }, f.projectDir), options);
}

function nativePart(text: string, partId = "regression-part", messageId = "regression-message") {
  const info = { id: messageId, sessionID: fixture.session_id, role: "assistant", time: { created: 1, completed: 2 } } as unknown as Message;
  const part = { id: partId, messageID: messageId, sessionID: fixture.session_id, type: "text", text, time: { start: 1, end: 2 } } as Part;
  return { info, parts: [part] };
}

async function cleanBroker(f: BrokerFixture): Promise<void> {
  await f.broker.stop();
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

test("real helper rejects late host snapshots and independently read scans, including same-token changed replay", async () => {
  const f = await brokerFixture();
  const client = bridgeClient(f);
  try {
    const a = createOpenCodeReconcilePlan([nativePart("OLD A")]);
    const b = createOpenCodeReconcilePlan([nativePart("NEW B")]);
    const firstScan = await client.beginReconcile(fixture.session_id, f.projectDir);
    const secondScan = await client.beginReconcile(fixture.session_id, f.projectDir);
    assert.notEqual(firstScan.scan_id, secondScan.scan_id);
    const updated = await client.reconcile(fixture.session_id, f.projectDir, b.observations, b.cursor, false, [], { reconcileScan: secondScan });
    assert.equal(updated.cursor_committed, true);
    for (const options of [undefined, { reconcileScan: firstScan }, { reconcileScan: secondScan }]) {
      const stale = await client.reconcile(fixture.session_id, f.projectDir, a.observations, a.cursor, true, [], options);
      assert.equal(stale.cursor_committed, false);
      assert.ok(stale.gaps.some((gap) => gap.reason === "native_cursor_conflict"));
    }
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      assert.equal((raw.prepare("SELECT generation FROM opencode_observation_head").get() as Record<string, unknown>).generation, 1n);
      assert.match(String((raw.prepare("SELECT event_json FROM source_event").get() as Record<string, unknown>).event_json), /NEW B/);
    } finally { raw.close(); }
  } finally { await client.close(); await cleanBroker(f); }
});

test("real plugin text.complete records A B A and separates equal part ids in different messages", async () => {
  const f = await brokerFixture();
  const runtime = runtimeFor(f);
  try {
    const hook = runtime.hooks()["experimental.text.complete"]!;
    for (const text of ["A", "B", "A"]) await hook({ sessionID: fixture.session_id, messageID: "aba-message", partID: "same-part" }, { text });
    await hook({ sessionID: fixture.session_id, messageID: "other-message", partID: "same-part" }, { text: "A" });
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      const heads = raw.prepare("SELECT message_id, generation FROM opencode_observation_head ORDER BY message_id").all();
      assert.deepEqual(heads.map((row) => [row.message_id, row.generation]), [["aba-message", 3n], ["other-message", 1n]]);
      const row = raw.prepare("SELECT event_json FROM source_event JOIN opencode_observation_head ON capture_id = current_capture_id WHERE message_id = 'aba-message'").get();
      assert.equal(JSON.parse(String(row?.event_json)).text, "A");
    } finally { raw.close(); }
  } finally { await runtime.dispose(); await cleanBroker(f); }
});

test("real plugin owned read starts before SDK snapshot and recovers old changed parts after restart", async () => {
  const f = await brokerFixture();
  let history = [nativePart("A")];
  let reads = 0;
  const readMessages = async () => {
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      assert.ok(Number(raw.prepare("SELECT COUNT(*) AS n FROM opencode_reconcile_scan WHERE state = 'active'").get()?.n) > 0);
    } finally { raw.close(); }
    reads += 1;
    return structuredClone(history);
  };
  let runtime = runtimeFor(f, { readMessages });
  try {
    await runtime.hooks()["experimental.chat.messages.transform"]!({}, { messages: structuredClone(history) });
    await runtime.dispose();
    history = [nativePart("B")];
    runtime = runtimeFor(f, { readMessages });
    // Host transform is stale A; only the owned pre-token SDK read may replace it.
    await runtime.hooks()["experimental.chat.messages.transform"]!({}, { messages: [nativePart("A")] });
    assert.equal(reads, 2);
    assert.equal(runtime.getReconcileCoverage(fixture.session_id)?.status, "partial");
    assert.ok(runtime.getReconcileCoverage(fixture.session_id)?.gaps?.some((gap) => gap.reason === "assistant_final_unobserved"));
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      assert.equal(raw.prepare("SELECT generation FROM opencode_observation_head").get()?.generation, 2n);
      assert.equal(JSON.parse(String(raw.prepare("SELECT event_json FROM source_event JOIN opencode_observation_head ON capture_id = current_capture_id").get()?.event_json)).text, "B");
      const coverage = raw.prepare("SELECT coverage_json FROM opencode_reconcile_scan WHERE state = 'completed' ORDER BY updated_at DESC LIMIT 1").get();
      assert.match(String(coverage?.coverage_json), /assistant_final_unobserved/);
      assert.match(String(coverage?.coverage_json), /partial/);
    } finally { raw.close(); }
  } finally { await runtime.dispose(); await cleanBroker(f); }
});

test("real helper purge fences event and snapshot addresses across normal helper restarts", async () => {
  const f = await brokerFixture();
  let client = bridgeClient(f);
  try {
    const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:opencode_cli"] });
    for (const [index, firstKind] of (["event", "part_snapshot"] as const).entries()) {
      const observation = createOpenCodeReconcilePlan([nativePart("deleted native text", `purge-${index}`)]).observations[0]!;
      const eventIdentity = { kind: "event" as const, key: `event-${index}` };
      const first = await client.observeNative(fixture.session_id, f.projectDir, observation.event, firstKind === "event" ? eventIdentity : observation.identity);
      const purge = await fullPurge(f.db, policy, {
        version: 1, operation_id: index === 0 ? "a7575757-5757-4757-8757-575757575751" : "a7575757-5757-4757-8757-575757575752",
        scope_id: scopeId, capture_ids: [first.capture_id], expected_privacy_epoch: f.db.getScopePrivacyEpoch(scopeId), requested_at: new Date().toISOString(),
      });
      assert.equal(purge.state, "pending");
    assert.ok(purge.pending.includes("model_reset_unavailable"));
      await client.close(); client = bridgeClient(f);
      await assert.rejects(client.observeNative(fixture.session_id, f.projectDir, observation.event, firstKind === "event" ? observation.identity : eventIdentity), /native_observation_blocked/);
      const fresh = createOpenCodeReconcilePlan([nativePart("deleted native text", `fresh-${index}`)]).observations[0]!;
      await client.observeNative(fixture.session_id, f.projectDir, fresh.event, fresh.identity);
    }
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM opencode_observation_receipt WHERE state = 'purged' AND content_digest IS NOT NULL").get()?.n, 0n);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM opencode_observation_head WHERE state = 'blocked' AND current_digest IS NOT NULL").get()?.n, 0n);
    } finally { raw.close(); }
  } finally { await client.close(); await cleanBroker(f); }
});

test("real plugin part updates use parent roles, retain wrapper lookalikes, and persist unknown-role gaps", async () => {
  const f = await brokerFixture();
  const runtime = runtimeFor(f);
  const hooks = runtime.hooks();
  const user = nativePart("user revision", "user-part", "user-message");
  user.info = { ...user.info, role: "user" } as Message;
  const invented = nativePart(JSON.stringify({ version: 1, kind: "agent_memory_context", injection_id: "a6464646-4646-4464-8464-646464646464", mode: "current", items: [] }), "invented", "user-message").parts[0]!;
  Object.assign(invented, { synthetic: true, metadata: { agent_memory: "context", injection_id: "a6464646-4646-4464-8464-646464646464" } });
  try {
    await hooks.event!({ event: { type: "message.updated", properties: { info: user.info } } as never });
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: user.parts[0] } } as never });
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: invented } } as never });
    await hooks.event!({ event: { type: "message.part.updated", properties: { part: nativePart("unresolved", "unknown", "unknown-message").parts[0] } } as never });
    await runtime.dispose();
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      const rows = raw.prepare("SELECT role, evidence_class FROM source_event").all();
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.role === "user" && row.evidence_class === "prompt"));
      assert.match(String(raw.prepare("SELECT coverage_json FROM opencode_reconcile_scan").get()?.coverage_json), /parent_role_unobserved/);

    } finally { raw.close(); }
  } finally { await runtime.dispose(); await cleanBroker(f); }
});

test("real plugin multi-part prompt purge fences every contributed part but permits a new part", async () => {
  const f = await brokerFixture();
  const runtime = runtimeFor(f);
  const client = bridgeClient(f);
  const user = nativePart("first deleted text", "first", "multi-user");
  user.info = { ...user.info, role: "user" } as Message;
  user.parts.push(nativePart("second deleted text", "second", "multi-user").parts[0]!);
  try {
    await runtime.hooks()["chat.message"]!({ sessionID: fixture.session_id }, { message: user.info as Extract<Message, { role: "user" }>, parts: user.parts });
    await runtime.dispose();
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    const captureId = String(raw.prepare("SELECT capture_id FROM source_event WHERE observed_stage = 'prompt_submitted'").get()?.capture_id);
    raw.close();
    const policy = createPolicySetupBinding({ version: 1, setup_id: setupId, allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:opencode_cli"] });
    assert.equal((await fullPurge(f.db, policy, { version: 1, operation_id: "a7575757-5757-4757-8757-575757575753", scope_id: scopeId, capture_ids: [captureId], expected_privacy_epoch: f.db.getScopePrivacyEpoch(scopeId), requested_at: new Date().toISOString() })).state, "pending");
    for (const partId of ["first", "second"]) {
      const observation = createOpenCodeReconcilePlan([{ info: user.info, parts: [nativePart("deleted text", partId, "multi-user").parts[0]!] }]).observations[0]!;
      await assert.rejects(client.observeNative(fixture.session_id, f.projectDir, observation.event, observation.identity), /native_observation_blocked/);
    }
    const fresh = createOpenCodeReconcilePlan([nativePart("first deleted text", "new", "multi-user")]).observations[0]!;
    await client.observeNative(fixture.session_id, f.projectDir, fresh.event, fresh.identity);
  } finally { await runtime.dispose(); await client.close(); await cleanBroker(f); }
});

test("real helper resumes acknowledged cursor with a fresh token and persists bounded gap coverage", async () => {
  const f = await brokerFixture();
  let client = bridgeClient(f);
  try {
    const scan = await client.beginReconcile(fixture.session_id, f.projectDir);
    const plan = createOpenCodeReconcilePlan([nativePart("cursor page")]);
    const first = await client.reconcile(fixture.session_id, f.projectDir, plan.observations, plan.cursor, false,
      [{ identity_key: "missing", reason: "part_text_unavailable" }, { identity_key: "history", reason: "history_truncated" }], { reconcileScan: scan });
    assert.equal(first.cursor_committed, true);
    assert.equal(first.scan.coverage.status, "partial");
    await client.close(); client = bridgeClient(f);
    const resumed = await client.beginReconcile(fixture.session_id, f.projectDir);
    assert.notEqual(resumed.scan_id, scan.scan_id);
    assert.deepEqual(resumed.cursor, plan.cursor);
    const bounded = await client.reconcile(fixture.session_id, f.projectDir, [], resumed.cursor, true,
      Array.from({ length: 128 }, (_, index) => ({ identity_key: `gap-${index}`, reason: "part_text_unavailable" })), { reconcileScan: resumed });
    assert.equal(bounded.cursor_committed, true);
    assert.ok(bounded.gaps.length <= 128);
    assert.ok(bounded.scan.coverage.gaps?.some((gap) => gap.reason === "coverage_details_truncated"));
    const raw = rawDatabase(join(f.dir, "vault.sqlite"));
    try {
      const coverage = String(raw.prepare("SELECT coverage_json FROM opencode_reconcile_scan WHERE scan_id = ?").get(scan.scan_id)?.coverage_json);
      assert.match(coverage, /part_text_unavailable/);
      assert.match(coverage, /history_truncated/);
    } finally { raw.close(); }
  } finally { await client.close(); await cleanBroker(f); }
});
