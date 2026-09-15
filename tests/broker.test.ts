import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTlsServer, connect as tlsConnect, type TLSSocket } from "node:tls";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createNativeSessionBinding, createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import {
  AgentMemoryBroker,
  AgentMemoryBrokerClient,
  BrokerError,
  type BrokerBindingCredential,
} from "../src/host/broker.js";
import {
  IPC_PSK_CIPHER,
  IPC_TLS_VERSION,
  NdjsonDecoder,
  encodeFrame,
  writeFrame,
} from "../src/host/ipc.js";
import { createPolicyOutputBinding, createPolicySetupBinding, readSourceForOutput, setScopeOutputGrants } from "../src/core/policy.js";
import { AgentMemoryDatabase } from "../src/store/database.js";
import { createPreparationContext, serializeModelContext } from "../src/context/packet.js";
import { prepareSourceEvidencePacket as prepareEvidencePacket } from "../src/context/source-only.js";
import { loadE5Embedder, type E5EmbedderReport, type LocalE5Embedder } from "../src/models/embedding.js";
import { E5_MODEL_MANIFEST } from "../src/models/manifest.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bindingBId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secretA = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const secretB = Buffer.from("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "hex");
const brokerPolicy = createPolicySetupBinding({
  version: 1,
  setup_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  allowed_scope_ids: [scopeId],
  allowed_output_targets: ["local_ui"],
});
const brokerOutput = createPolicyOutputBinding(brokerPolicy, {
  version: 1,
  output_binding_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  setup_id: brokerPolicy.setup_id,
  scope_id: scopeId,
  target: "local_ui",
});
const brokerSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

interface Fixture {
  readonly dir: string;
  readonly runtimeDir: string;
  readonly dbPath: string;
  readonly db: AgentMemoryDatabase;
  readonly bindingA: TrustedBinding;
  readonly bindingB: TrustedBinding;
  readonly credentialA: BrokerBindingCredential;
  readonly credentialB: BrokerBindingCredential;
}

function bindingFor(bindingId: string, instanceId: string, sessionId: string): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "local-macos" },
    host_instance_id: instanceId,
    host_session_id: sessionId,
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:xp-copilot"] },
  });
}

function envelope(binding: TrustedBinding, captureId = randomUUID(), text = "Broker source 🦄", capturedAt = "2026-09-07T20:00:00Z"): unknown {
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: binding.host_kind,
      surface: binding.surface,
      execution_domain: { ...binding.execution_domain },
      host_instance_id: binding.host_instance_id,
      host_session_id: binding.host_session_id,
    },
    adapter_version: "0.1.0",
    event: {
      stage: "prompt_submitted",
      role: "user",
      evidence_class: "prompt",
      native_ids: { session_id: "native-session", turn_id: "native-turn" },
      text,
    },
    payload: { text, marker: "synthetic" },
    captured_at: capturedAt,
    occurred_at: "2026-09-07T19:59:59Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-broker-"));
  const runtimeDir = join(dir, "runtime");
  const dbPath = join(dir, "vault.sqlite");
  const db = new AgentMemoryDatabase(dbPath);
  const bindingA = bindingFor(bindingAId, "broker-host-a", "broker-session-a");
  const bindingB = bindingFor(bindingBId, "broker-host-b", "broker-session-b");
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "synthetic", created_at: "2026-09-07T19:00:00Z" });
  db.registerSession(scopeId, bindingA, "2026-09-07T19:00:00Z");
  db.registerSession(scopeId, bindingB, "2026-09-07T19:00:00Z");
  setScopeOutputGrants(
    db,
    brokerPolicy,
    scopeId,
    [{ target: "local_ui", source_classes: [...brokerSourceClasses] }],
    "2026-09-07T19:00:01Z",
  );
  mkdirPrivate(runtimeDir);
  return {
    dir,
    runtimeDir,
    dbPath,
    db,
    bindingA,
    bindingB,
    credentialA: { binding: bindingA, secret: secretA },
    credentialB: { binding: bindingB, secret: secretB },
  };
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function cleanup(fixture: Fixture): void {
  if (!fixture.db.isClosed()) fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function seedCleanupInventory(fixtureValue: Fixture): void {
  const attempt = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const batch = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const job = "12121212-1212-4121-8121-121212121212";
  const reservation = "13131313-1313-4131-8131-131313131313";
  const now = "2026-09-07T20:00:00.000Z";
  const raw = new DatabaseSync(fixtureValue.dbPath);
  try {
    raw.exec(`INSERT INTO execution_batch (batch_id, job_id, scope_id, source_capture_id, task_version, input_fingerprint, input_privacy_epoch, request_digest, binding_id, profile_hash, profile_id, runtime_id, model_id, reasoning, provider_id, provider_target, account_ref, auth_epoch, auth_generation, auth_entry_id, job_owner, job_fence, job_lease_until, state, created_at, updated_at) VALUES ('${batch}', '${job}', '${scopeId}', '${bindingAId}', 'v1', '${"a".repeat(64)}', '0', '${"b".repeat(64)}', '${bindingAId}', '${"c".repeat(64)}', 'XP-Copilot', 'runtime', 'model', 'high', 'copilot', 'provider:copilot', 'cleanup-account', '0', NULL, NULL, 'owner', 1, '${now}', 'active', '${now}', '${now}');`);
    raw.exec(`INSERT INTO budget_reservation (reservation_id, batch_id, phase, period_day, period_month, budget_key, daily_start_limit, monthly_start_limit, daily_usage_limits_json, monthly_usage_limits_json, usage_reservation_json, reserved_input_tokens, reserved_output_tokens, reserved_provider_requests, reserved_credits, reserved_starts, reserved_active_ms, state, created_at, updated_at) VALUES ('${reservation}', '${batch}', 'extract', '2026-09-07', '2026-09', '{"version":1,"budget_tag":"broker-cleanup","provider_id":"copilot","provider_target":"provider:copilot","account_ref":"cleanup-account"}', 2, 2, '{}', '{}', '{}', 0, 0, 0, 0, 2, 60000, 'active', '${now}', '${now}');`);
    raw.exec(`INSERT INTO execution_attempt (attempt_id, batch_id, job_id, phase, ordinal, request_digest, input_fingerprint, input_privacy_epoch, binding_id, profile_hash, profile_id, runtime_id, model_id, reasoning, provider_id, account_ref, auth_epoch, auth_generation, auth_entry_id, owner, job_fence, lease_until, reservation_id, deadline_at, state, terminal_at, usage_status, usage_complete_json, cleanup_state, active_ms, created_at, updated_at) VALUES ('${attempt}', '${batch}', '${job}', 'extract', 1, '${"b".repeat(64)}', '${"a".repeat(64)}', '0', '${bindingAId}', '${"c".repeat(64)}', 'XP-Copilot', 'runtime', 'model', 'high', 'copilot', 'cleanup-account', '0', NULL, NULL, 'owner', 1, '${now}', '${reservation}', '2026-09-07T20:01:00.000Z', 'terminal_observed', '${now}', 'unknown', '[]', 'pending', 0, '${now}', '${now}');`);
  } finally { raw.close(); }
  for (let index = 0; index < 32; index += 1) {
    fixtureValue.db.runtimeArtifacts.register({ attempt_id: attempt, batch_id: batch, job_id: job, scope_id: scopeId, source_capture_id: bindingAId, profile_id: "XP-Copilot", account_ref: "cleanup-account", kind: "file", trusted_root: fixtureValue.runtimeDir, relative_path: `never/${String(index).padStart(2, "0")}` }, now);
  }
}

function brokerFor(fixture: Fixture, credentials: readonly BrokerBindingCredential[] = [fixture.credentialA], extra: Record<string, unknown> = {}): AgentMemoryBroker {
  return new AgentMemoryBroker({ database: fixture.db, runtimeDirectory: fixture.runtimeDir, credentials, ...extra });
}

function warmEmbeddingOwner(onDispose: () => void): LocalE5Embedder {
  let state: E5EmbedderReport["state"] = "ready";
  return {
    manifest: E5_MODEL_MANIFEST,
    embed: async () => [],
    dispose: async () => {
      state = "disposed";
      onDispose();
    },
    report: () => ({
      state,
      model_root: "/synthetic/model",
      model_id: E5_MODEL_MANIFEST.model_id,
      revision: E5_MODEL_MANIFEST.revision,
      dimensions: 384,
      max_tokens: 512,
      dtype: "q8",
      device: "cpu",
      batch_strategy: "rowwise_batch1",
      input_count: 0,
      completed_batches: 0,
    }),
  };
}

function tlsOptions(socketPath: string, bindingId: string, secret: Uint8Array) {
  return {
    path: socketPath,
    ciphers: IPC_PSK_CIPHER,
    minVersion: IPC_TLS_VERSION,
    maxVersion: IPC_TLS_VERSION,
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: bindingId, psk: Buffer.from(secret) }),
  } as const;
}

interface RawConnection {
  readonly socket: TLSSocket;
  readonly nextFrame: () => Promise<unknown>;
}

async function rawConnection(
  socketPath: string,
  bindingId: string,
  secret: Uint8Array,
  helloBindingId = bindingId,
): Promise<RawConnection> {
  const socket = tlsConnect(tlsOptions(socketPath, bindingId, secret));
  const decoder = new NdjsonDecoder();
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const queueFrame = (frame: unknown): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  };
  socket.on("data", (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) queueFrame(frame);
    } catch (error: unknown) {
      const failure = failures.shift();
      failure?.(error instanceof Error ? error : new Error("frame_failure"));
    }
  });
  socket.once("close", () => {
    const error = new BrokerError("transport_closed");
    while (failures.length > 0) failures.shift()?.(error);
  });
  await new Promise<void>((resolveConnect, rejectConnect) => {
    socket.once("secureConnect", resolveConnect);
    socket.once("error", rejectConnect);
  });
  writeFrame(socket, { version: 1, kind: "hello", binding_id: helloBindingId });
  const nextFrame = (): Promise<unknown> => {
    const queued = frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolveFrame, rejectFrame) => {
      waiters.push(resolveFrame);
      failures.push(rejectFrame);
    });
  };
  const ready = (await nextFrame()) as { kind: string };
  assert.equal(ready.kind, "ready");
  return { socket, nextFrame };
}

function waitForClose(socket: TLSSocket | import("node:net").Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
}

function waitForCloseWithin(socket: TLSSocket | import("node:net").Socket, timeoutMs: number): Promise<boolean> {
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise<boolean>((resolveClose) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveClose(false);
    }, timeoutMs);
    socket.once("close", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveClose(true);
    });
  });
}

test("captures through TLS-PSK broker and reopens the durable ACK", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, expectedServerId: address.serverId });
    await client.connect();
    const ack = await client.capture(envelope(fixture.bindingA));
    assert.equal(ack.commit_seq, "1");
    await client.close();
    await broker.stop();
    fixture.db.close();
    const reopened = new AgentMemoryDatabase(fixture.dbPath);
    try {
      const source = readSourceForOutput(reopened, brokerOutput, ack.capture_id);
      assert.equal(source?.commit_seq, "1");
      assert.ok(source);
      const raw = new DatabaseSync(fixture.dbPath, { readBigInts: true });
      try {
        const jobs = raw
          .prepare("SELECT source_capture_id, input_fingerprint, state, pause_reason FROM job WHERE scope_id = ? AND source_capture_id = ? AND task_kind = 'extract'")
          .all(scopeId, ack.capture_id);
        assert.equal(jobs.length, 1, "the durable ACK owns exactly one extract job");
        const job = jobs[0];
        assert.ok(job);
        assert.equal(job.source_capture_id, ack.capture_id);
        assert.equal(job.input_fingerprint, source.fingerprint);
        // The scheduler may advance this durable job while the broker is
        // running; that worker state is independent of ACK durability.
        assert.equal(
          job.state === "pending_extraction" || (job.state === "paused" && (job.pause_reason === "handler_unavailable" || job.pause_reason === "shutdown")),
          true,
          `unexpected post-stop worker state: ${job.state}/${job.pause_reason ?? "none"}`,
        );
      } finally {
        raw.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("propagates an explicit event-root span through the broker and defaults legacy spans to payload", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  const clients: AgentMemoryBrokerClient[] = [];
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA });
    clients.push(client);
    await client.connect();
    const eventText = "event-root broker needle";
    const eventCaptureId = randomUUID();
    const eventAck = await client.capture(envelope(fixture.bindingA, eventCaptureId, eventText), [
      {
        span_id: randomUUID(),
        root: "event",
        path: "/text",
        start_utf16: 0,
        end_utf16: eventText.length,
        digest: createHash("sha256").update(eventText, "utf8").digest("hex"),
      },
    ]);
    assert.equal(fixture.db.getSourceSpansForOutput(eventAck.capture_id, brokerOutput).find((span) => span.root === "event")?.path, "/text");

    const legacyCaptureId = randomUUID();
    const payloadText = "payload-root broker needle";
    const legacyAck = await client.capture(
      envelope(fixture.bindingA, legacyCaptureId, payloadText),
      [
        {
          span_id: randomUUID(),
          path: "/text",
          start_utf16: 0,
          end_utf16: payloadText.length,
          digest: createHash("sha256").update(payloadText, "utf8").digest("hex"),
        },
      ],
    );
    assert.equal(fixture.db.getSourceSpansForOutput(legacyAck.capture_id, brokerOutput).find((span) => span.root === "payload")?.path, "/text");
  } finally {
    for (const client of clients) await client.close();
    await broker.stop();
    cleanup(fixture);
  }
});

test("binds each PSK to its binding and never grants a second binding over the wire", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA, fixture.credentialB]);
  try {
    const address = await broker.start();
    const clientA = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA });
    assert.equal((await clientA.capture(envelope(fixture.bindingA))).commit_seq, "1");
    await clientA.close();
    const wrongKey = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: { binding: fixture.bindingA, secret: Buffer.alloc(32, 7) } });
    await assert.rejects(() => wrongKey.connect(), (error: unknown) => error instanceof BrokerError);
    const mismatchedHello = tlsConnect(tlsOptions(address.socketPath, fixture.bindingA.binding_id, secretA));
    await new Promise<void>((resolveConnect, rejectConnect) => {
      mismatchedHello.once("secureConnect", resolveConnect);
      mismatchedHello.once("error", rejectConnect);
    });
    writeFrame(mismatchedHello, { version: 1, kind: "hello", binding_id: fixture.bindingB.binding_id });
    const decoder = new NdjsonDecoder();
    const reply = await new Promise<{ kind: string; code?: string }>((resolveReply, rejectReply) => {
      mismatchedHello.once("data", (chunk: Buffer) => {
        try {
          resolveReply(decoder.push(chunk)[0] as { kind: string; code?: string });
        } catch (error: unknown) {
          rejectReply(error);
        }
      });
      mismatchedHello.once("error", rejectReply);
    });
    assert.deepEqual(reply, { code: "authentication_failed", kind: "error", version: 1 });
    mismatchedHello.destroy();
    assert.equal(fixture.db.getCounts().source_count, 1n);
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("rejects one PSK credential being registered for two binding IDs", () => {
  const fixture = setup();
  try {
    assert.throws(
      () => brokerFor(fixture, [fixture.credentialA, { binding: fixture.bindingB, secret: secretA }]),
      (error: unknown) => error instanceof BrokerError && error.code === "request_invalid",
    );
  } finally {
    cleanup(fixture);
  }
});

test("does not send source data when the expected server identity fails", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({
      socketPath: address.socketPath,
      credential: fixture.credentialA,
      expectedServerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    await assert.rejects(() => client.connect(), (error: unknown) => error instanceof BrokerError && error.code === "server_identity_mismatch");
    assert.equal(fixture.db.getCounts().source_count, 0n);
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("rejects replayed request frames without a second source or job", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const connection = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    const request = { version: 1, kind: "capture", seq: 1, request_id: randomUUID(), event: envelope(fixture.bindingA), source_spans: [] };
    const frame = encodeFrame(request);
    connection.socket.write(Buffer.concat([frame, frame]));
    const first = (await connection.nextFrame()) as { kind: string };
    const second = (await connection.nextFrame()) as { kind: string; code?: string };
    assert.equal(first.kind, "capture_ack");
    assert.equal(second.kind, "error");
    assert.equal(second.code, "request_replay");
    assert.equal(fixture.db.getCounts().source_count, 1n);
    assert.equal(fixture.db.getCounts().job_count, 1n);
    connection.socket.destroy();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("handles UTF-8 fragmentation and multiple NDJSON frames", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const connection = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    const first = { version: 1, kind: "capture", seq: 1, request_id: randomUUID(), event: envelope(fixture.bindingA, randomUUID(), "A🦄Z"), source_spans: [] };
    const second = { version: 1, kind: "capture", seq: 2, request_id: randomUUID(), event: envelope(fixture.bindingA, randomUUID(), "B🦄Y"), source_spans: [] };
    const bytes = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
    const emojiBytes = Buffer.from("🦄", "utf8");
    const split = bytes.indexOf(emojiBytes) + 1;
    connection.socket.write(bytes.subarray(0, split));
    connection.socket.write(bytes.subarray(split));
    assert.equal((await connection.nextFrame() as { kind: string }).kind, "capture_ack");
    assert.equal((await connection.nextFrame() as { kind: string }).kind, "capture_ack");
    assert.equal(fixture.db.getCounts().source_count, 2n);
    connection.socket.destroy();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("rejects malformed and oversized frames without a source write", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { maxFrameBytes: 4096 });
  try {
    const address = await broker.start();
    const malformed = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    malformed.socket.write(Buffer.from("{\"version\":1\n", "utf8"));
    assert.equal((await malformed.nextFrame() as { code?: string }).code, "invalid_json");
    await waitForClose(malformed.socket);
    const invalidUtf8 = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    invalidUtf8.socket.write(Buffer.from([0xff, 0x0a]));
    assert.equal((await invalidUtf8.nextFrame() as { code?: string }).code, "invalid_utf8");
    await waitForClose(invalidUtf8.socket);
    const oversized = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    oversized.socket.write(Buffer.concat([Buffer.from("x".repeat(4097), "utf8"), Buffer.from("\n", "utf8")]));
    assert.equal((await oversized.nextFrame() as { code?: string }).code, "frame_too_large");
    await waitForClose(oversized.socket);
    assert.equal(fixture.db.getCounts().source_count, 0n);
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("expires an incomplete frame from a ready client without expiring idle clients", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { handshakeTimeoutMs: 500, frameTimeoutMs: 100 });
  try {
    const address = await broker.start();
    const connection = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    const started = Date.now();
    connection.socket.write(Buffer.from('{"version":1,"kind":"capture"', "utf8"));
    await waitForClose(connection.socket);
    assert.ok(Date.now() - started < 500);
    assert.equal(fixture.db.getCounts().source_count, 0n);
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("starts a fresh absolute deadline when a completed frame is followed by a partial one", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { handshakeTimeoutMs: 1_000, frameTimeoutMs: 500 });
  try {
    const address = await broker.start();
    const connection = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    const first = encodeFrame({ version: 1, kind: "capture", seq: 1, request_id: randomUUID(), event: envelope(fixture.bindingA), source_spans: [] });
    const second = encodeFrame({ version: 1, kind: "capture", seq: 2, request_id: randomUUID(), event: envelope(fixture.bindingA), source_spans: [] });
    connection.socket.write(first.subarray(0, 10));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 180));
    connection.socket.write(Buffer.concat([first.subarray(10), second.subarray(0, 10)]));
    assert.equal((await connection.nextFrame() as { kind: string }).kind, "capture_ack");
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 380));
    connection.socket.write(second.subarray(10));
    assert.equal((await connection.nextFrame() as { kind: string }).kind, "capture_ack");
    assert.equal(fixture.db.getCounts().source_count, 2n);
    connection.socket.destroy();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("serves parallel clients with independent connection request sequences", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const clients = Array.from({ length: 3 }, () => new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, expectedServerId: address.serverId }));
    const acks = await Promise.all(clients.map((client) => client.capture(envelope(fixture.bindingA))));
    assert.equal(new Set(acks.map((ack) => ack.capture_id)).size, 3);
    assert.equal(fixture.db.getCounts().source_count, 3n);
    await Promise.all(clients.map((client) => client.close()));
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("reports live, unverified and stale endpoints without unlinking them", async () => {
  const fixture = setup();
  const first = brokerFor(fixture);
  try {
    const address = await first.start();
    const second = brokerFor(fixture);
    await assert.rejects(() => second.start(), (error: unknown) => error instanceof BrokerError && error.code === "already_running");
    assert.equal(existsSync(address.socketPath), true);
    await first.stop();
    const foreign = createNetServer();
    foreign.on("connection", (socket) => socket.destroy());
    await new Promise<void>((resolveListen) => foreign.listen(address.socketPath, resolveListen));
    const unverified = brokerFor(fixture);
    await assert.rejects(() => unverified.start(), (error: unknown) => error instanceof BrokerError && error.code === "endpoint_unverified");
    await new Promise<void>((resolveClose) => foreign.close(() => resolveClose()));
    writeFileSync(address.socketPath, "owned-by-someone-else", { mode: 0o600 });
    const stale = brokerFor(fixture);
    await assert.rejects(() => stale.start(), (error: unknown) => error instanceof BrokerError && error.code === "stale_endpoint");
    assert.equal(statSync(address.socketPath).isFile(), true);
  } finally {
    await first.stop();
    cleanup(fixture);
  }
});

test("concurrent starts share one full listen operation", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const [first, second] = await Promise.all([broker.start(), broker.start()]);
    assert.deepEqual(first, second);
    const client = new AgentMemoryBrokerClient({ socketPath: first.socketPath, credential: fixture.credentialA });
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "1");
    await client.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("owns the scheduler lifecycle and keeps an explicit degraded fallback after scheduler failure", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  const client = new AgentMemoryBrokerClient({ socketPath: join(fixture.runtimeDir, "broker.sock"), credential: fixture.credentialA });
  const originalStatus = fixture.db.jobs.status;
  try {
    const address = await broker.start();
    assert.equal(broker.schedulerStatus.admission, "open");
    const readerPolicy = createPolicySetupBinding({
      version: 1,
      setup_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      allowed_scope_ids: [scopeId],
      allowed_output_targets: ["reader:codex_cli"],
    });
    setScopeOutputGrants(
      fixture.db,
      readerPolicy,
      scopeId,
      [{ target: "reader:codex_cli", source_classes: [...brokerSourceClasses] }],
      "2026-09-07T20:00:02Z",
    );
    await client.capture(envelope(fixture.bindingA, "abababab-abab-4bab-8bab-abababababab", "scheduler fallback source"));
    fixture.db.jobs.status = () => {
      throw new Error("synthetic scheduler status failure");
    };
    const packet = await client.recall(
      { query: "scheduler", scope_ids: [scopeId], mode: "current", token_budget: 600 },
      {
        version: 1,
        kind: "session_start",
        deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" },
      },
    );
    assert.equal(packet.mode, "degraded");
    assert.ok(packet.diagnostics?.some((diagnostic) => diagnostic.code === "degraded_lexical"));
    await client.close();
    await broker.stop();
    assert.equal(broker.schedulerStatus.admission, "closed");
    assert.notEqual(broker.schedulerStatus.failure, "none");
    assert.equal(address.serverId.length, 36);
  } finally {
    fixture.db.jobs.status = originalStatus;
    await client.close();
    await broker.stop();
    cleanup(fixture);
  }
});

test("default broker cleanup pump drains 32 artifacts while keeping recall available with the 33rd pending", async () => {
  const fixture = setup();
  const attempt = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const batch = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const job = "12121212-1212-4121-8121-121212121212";
  const source = bindingAId;
  const broker = brokerFor(fixture);
  const client = new AgentMemoryBrokerClient({ socketPath: join(fixture.runtimeDir, "broker.sock"), credential: fixture.credentialA });
  try {
    seedCleanupInventory(fixture);
    fixture.db.runtimeArtifacts.register({ attempt_id: attempt, batch_id: batch, job_id: job, scope_id: scopeId, source_capture_id: source, profile_id: "XP-Copilot", account_ref: "cleanup-account", kind: "session", trusted_root: fixture.runtimeDir, native_session_id: "pending-33" }, "2026-09-07T20:00:01.000Z");
    const readerPolicy = createPolicySetupBinding({ version: 1, setup_id: "14141414-1414-4141-8141-141414141414", allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:codex_cli"] });
    setScopeOutputGrants(fixture.db, readerPolicy, scopeId, [{ target: "reader:codex_cli", source_classes: [...brokerSourceClasses] }], "2026-09-07T20:00:02Z");
    const address = await broker.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const raw = new DatabaseSync(fixture.dbPath, { readBigInts: true });
    try {
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM runtime_artifact WHERE state = 'removed'").get() as { count: bigint }).count, 32n);
      assert.equal((raw.prepare("SELECT state FROM runtime_artifact WHERE native_session_id = 'pending-33'").get() as { state: string }).state, "cleanup_pending");
    } finally { raw.close(); }
    assert.equal(broker.schedulerStatus.admission, "open");
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "1");
    assert.ok(["current", "degraded"].includes((await client.recall({ query: "Broker", scope_ids: [scopeId], mode: "current", token_budget: 200 }, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z", capture_status: { state: "not_attempted" } })).mode));
    assert.equal(address.serverId.length, 36);
  } finally { await client.close(); await broker.stop(); cleanup(fixture); }
});

test("passes one trusted warm embedding owner through broker shutdown", async () => {
  const fixture = setup();
  let disposeCalls = 0;
  const broker = brokerFor(fixture, [fixture.credentialA], {
    schedulerOptions: { embedding: warmEmbeddingOwner(() => { disposeCalls += 1; }) },
  });
  try {
    await broker.start();
    await broker.stop();
    assert.equal(disposeCalls, 1);
    assert.equal(broker.schedulerStatus.admission, "closed");
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("routes broker recall through the warm E5 hybrid path", async () => {
  const fixture = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network disabled by broker hybrid test"); }) as typeof fetch;
  const modelRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.models/e5/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78");
  let embedding: Awaited<ReturnType<typeof loadE5Embedder>> | undefined;
  let broker: AgentMemoryBroker | undefined;
  const taskVersion = "embed-e5-761b726-gen1";
  try {
    const readerPolicy = createPolicySetupBinding({
      version: 1,
      setup_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      allowed_scope_ids: [scopeId],
      allowed_output_targets: ["reader:codex_cli"],
    });
    setScopeOutputGrants(fixture.db, readerPolicy, scopeId, [{ target: "reader:codex_cli", source_classes: [...brokerSourceClasses] }], "2026-09-07T20:00:02Z");
    embedding = await loadE5Embedder({ modelRoot });
    broker = brokerFor(fixture, [fixture.credentialA], { schedulerOptions: { embedding, background_poll_ms: 10 } });
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA });
    const captureId = "abababab-abab-4bab-8bab-abababababab";
    await client.capture(envelope(fixture.bindingA, captureId, "broker hybrid E5 source"));
    fixture.db.enqueueEmbedJob(scopeId, captureId, taskVersion);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (fixture.db.getEmbedJobByCaptureId(captureId, taskVersion)?.state === "completed") break;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.equal(fixture.db.getEmbedJobByCaptureId(captureId, taskVersion)?.state, "completed");
    const packet = await client.recall(
      { query: "broker hybrid E5", scope_ids: [scopeId], mode: "current", token_budget: 600 },
      { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z", capture_status: { state: "not_attempted" } },
    );
    assert.ok(packet.items.some((item) => item.content.includes("broker hybrid E5 source")));
    await client.close();
  } finally {
    if (broker !== undefined) await broker.stop();
    if (embedding !== undefined) await embedding.dispose();
    globalThis.fetch = originalFetch;
    cleanup(fixture);
  }
});

test("keeps scheduler queue saturation bounded instead of running an out-of-queue recall", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], {
    schedulerOptions: { interactive_queue_limit: 1 },
  });
  let raw: RawConnection | undefined;
  const originalSnapshot = fixture.db.getRecallSnapshot;
  let snapshotCalls = 0;
  try {
    const readerPolicy = createPolicySetupBinding({
      version: 1,
      setup_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      allowed_scope_ids: [scopeId],
      allowed_output_targets: ["reader:codex_cli"],
    });
    setScopeOutputGrants(
      fixture.db,
      readerPolicy,
      scopeId,
      [{ target: "reader:codex_cli", source_classes: [...brokerSourceClasses] }],
      "2026-09-07T20:00:02Z",
    );
    fixture.db.getRecallSnapshot = (scopeIds, binding) => {
      snapshotCalls += 1;
      return originalSnapshot.call(fixture.db, scopeIds, binding);
    };
    const address = await broker.start();
    raw = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    const context = {
      version: 1,
      kind: "session_start",
      deadline_at: "2099-01-01T00:00:00Z",
      capture_status: { state: "not_attempted" },
    };
    const first = { version: 1, kind: "recall", seq: 1, request_id: randomUUID(), request: { query: "no-match", scope_ids: [scopeId], mode: "current", token_budget: 600 }, context };
    const second = { version: 1, kind: "recall", seq: 2, request_id: randomUUID(), request: { query: "no-match", scope_ids: [scopeId], mode: "current", token_budget: 600 }, context };
    raw.socket.write(Buffer.concat([encodeFrame(first), encodeFrame(second)]));
    const responses = await Promise.all([raw.nextFrame(), raw.nextFrame()]);
    const error = responses.find((response) => typeof response === "object" && response !== null && "code" in response) as { code?: string } | undefined;
    const success = responses.find((response) => typeof response === "object" && response !== null && "kind" in response && response.kind === "recall_response") as { kind?: string } | undefined;
    assert.equal(error?.code, "pending_limit");
    assert.equal(success?.kind, "recall_response");
    assert.equal(snapshotCalls, 1);
  } finally {
    fixture.db.getRecallSnapshot = originalSnapshot;
    raw?.socket.destroy();
    await broker.stop();
    cleanup(fixture);
  }
});

test("reconnect starts a fresh request sequence and decoder", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture);
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA });
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "1");
    await client.close();
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "2");
    await client.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("does not consume a request sequence when encoding rejects an oversized capture", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { maxFrameBytes: 2_048 });
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, maxFrameBytes: 2_048 });
    await assert.rejects(
      () => client.capture(envelope(fixture.bindingA, randomUUID(), "x".repeat(5_000))),
      (error: unknown) => error instanceof BrokerError && error.code === "frame_too_large",
    );
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "1");
    await client.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("keeps an authenticated idle connection usable after the handshake deadline", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { handshakeTimeoutMs: 100 });
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, handshakeTimeoutMs: 500 });
    await client.connect();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 180));
    assert.equal((await client.capture(envelope(fixture.bindingA))).commit_seq, "1");
    await broker.stop();
    await client.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("bounds the combined raw and authenticated connection count", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { maxConnections: 1, handshakeTimeoutMs: 150 });
  try {
    const address = await broker.start();
    const first = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, handshakeTimeoutMs: 500 });
    await first.connect();
    const second = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, handshakeTimeoutMs: 500 });
    await assert.rejects(() => second.connect(), (error: unknown) => error instanceof BrokerError);
    await first.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("bounds pending requests and rejects requests that miss their deadline", async () => {
  const fixture = setup();
  const socketPath = join(fixture.runtimeDir, "silent.sock");
  const fake = createTlsServer(
    {
      ciphers: IPC_PSK_CIPHER,
      minVersion: IPC_TLS_VERSION,
      maxVersion: IPC_TLS_VERSION,
      rejectUnauthorized: false,
      pskCallback: (_socket, identity) => identity === fixture.bindingA.binding_id ? secretA : null,
    },
    (socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (typeof frame === "object" && frame !== null && "kind" in frame && frame.kind === "hello") {
            writeFrame(socket, { version: 1, kind: "ready", binding_id: fixture.bindingA.binding_id, server_id: randomUUID() });
          }
        }
      });
    },
  );
  try {
    await new Promise<void>((resolveListen) => fake.listen(socketPath, resolveListen));
    const client = new AgentMemoryBrokerClient({
      socketPath,
      credential: fixture.credentialA,
      requestTimeoutMs: 100,
      maxPendingRequests: 1,
    });
    const first = client.capture(envelope(fixture.bindingA));
    await assert.rejects(() => client.capture(envelope(fixture.bindingA)), (error: unknown) => error instanceof BrokerError && error.code === "pending_limit");
    await assert.rejects(() => first, (error: unknown) => error instanceof BrokerError && error.code === "transport_timeout");
    await client.close();
  } finally {
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    cleanup(fixture);
  }
});

test("disconnects a slow reader after the bounded output queue while keeping the durable retry idempotent", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { maxFrameBytes: 1_024, handshakeTimeoutMs: 1_000 });
  try {
    const address = await broker.start();
    const slow = await rawConnection(address.socketPath, fixture.bindingA.binding_id, secretA);
    slow.socket.pause();
    const durableCaptureId = randomUUID();
    const requests = Array.from({ length: 1_000 }, (_, index) => ({
      version: 1,
      kind: "capture",
      seq: index + 1,
      request_id: randomUUID(),
      event: envelope(fixture.bindingA, index === 0 ? durableCaptureId : randomUUID(), `slow-${index}`),
      source_spans: [],
    }));
    slow.socket.write(Buffer.concat(requests.map((request) => encodeFrame(request, 1_024))));
    assert.equal(await waitForCloseWithin(slow.socket, 2_000), true);
    const persisted = readSourceForOutput(fixture.db, brokerOutput, durableCaptureId);
    assert.ok(persisted);
    const retry = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credentialA, maxFrameBytes: 1_024, requestTimeoutMs: 1_000 });
    const retryAck = await retry.capture(envelope(fixture.bindingA, durableCaptureId, "slow-0"));
    assert.equal(retryAck.commit_seq, persisted.commit_seq);
    await retry.close();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("closes a client connection on malformed post-handshake responses", async () => {
  const fixture = setup();
  const socketPath = join(fixture.runtimeDir, "malformed.sock");
  const fake = createTlsServer(
    {
      ciphers: IPC_PSK_CIPHER,
      minVersion: IPC_TLS_VERSION,
      maxVersion: IPC_TLS_VERSION,
      rejectUnauthorized: false,
      pskCallback: (_socket, identity) => identity === fixture.bindingA.binding_id ? secretA : null,
    },
    (socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (typeof frame !== "object" || frame === null || !("kind" in frame) || frame.kind !== "hello") continue;
          writeFrame(socket, { version: 1, kind: "ready", binding_id: fixture.bindingA.binding_id, server_id: randomUUID() });
          socket.once("data", () => socket.write(Buffer.from("{bad\n", "utf8")));
        }
      });
    },
  );
  try {
    await new Promise<void>((resolveListen) => fake.listen(socketPath, resolveListen));
    const client = new AgentMemoryBrokerClient({ socketPath, credential: fixture.credentialA, requestTimeoutMs: 500 });
    await assert.rejects(() => client.capture(envelope(fixture.bindingA)), (error: unknown) => error instanceof BrokerError && error.code === "invalid_json");
    await client.close();
  } finally {
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    cleanup(fixture);
  }
});

test("rejects an invalid ACK before removing its pending request", async () => {
  const fixture = setup();
  const socketPath = join(fixture.runtimeDir, "invalid-ack.sock");
  const fake = createTlsServer(
    {
      ciphers: IPC_PSK_CIPHER,
      minVersion: IPC_TLS_VERSION,
      maxVersion: IPC_TLS_VERSION,
      rejectUnauthorized: false,
      pskCallback: (_socket, identity) => identity === fixture.bindingA.binding_id ? secretA : null,
    },
    (socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (typeof frame !== "object" || frame === null || !("kind" in frame)) continue;
          if (frame.kind === "hello") {
            writeFrame(socket, { version: 1, kind: "ready", binding_id: fixture.bindingA.binding_id, server_id: randomUUID() });
          } else if (frame.kind === "capture" && "request_id" in frame && "seq" in frame) {
            writeFrame(socket, { version: 1, kind: "capture_ack", request_id: frame.request_id, seq: frame.seq, ack: {} });
          }
        }
      });
    },
  );
  try {
    await new Promise<void>((resolveListen) => fake.listen(socketPath, resolveListen));
    const client = new AgentMemoryBrokerClient({ socketPath, credential: fixture.credentialA, requestTimeoutMs: 500 });
    const started = Date.now();
    await assert.rejects(() => client.capture(envelope(fixture.bindingA)), (error: unknown) => error instanceof BrokerError && error.code === "invalid_frame");
    assert.ok(Date.now() - started < 300);
    await client.close();
  } finally {
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    cleanup(fixture);
  }
});

test("reports a truncated post-handshake response and closes the connection", async () => {
  const fixture = setup();
  const socketPath = join(fixture.runtimeDir, "truncated.sock");
  const fake = createTlsServer(
    {
      ciphers: IPC_PSK_CIPHER,
      minVersion: IPC_TLS_VERSION,
      maxVersion: IPC_TLS_VERSION,
      rejectUnauthorized: false,
      pskCallback: (_socket, identity) => identity === fixture.bindingA.binding_id ? secretA : null,
    },
    (socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (typeof frame !== "object" || frame === null || !("kind" in frame)) continue;
          if (frame.kind === "hello") writeFrame(socket, { version: 1, kind: "ready", binding_id: fixture.bindingA.binding_id, server_id: randomUUID() });
          if (frame.kind === "capture") {
            socket.write(Buffer.from('{"version":1,"kind":"capture_ack"', "utf8"));
            socket.end();
          }
        }
      });
    },
  );
  try {
    await new Promise<void>((resolveListen) => fake.listen(socketPath, resolveListen));
    const client = new AgentMemoryBrokerClient({ socketPath, credential: fixture.credentialA, requestTimeoutMs: 500 });
    await assert.rejects(() => client.capture(envelope(fixture.bindingA)), (error: unknown) => error instanceof BrokerError && error.code === "frame_truncated");
    await client.close();
  } finally {
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    cleanup(fixture);
  }
});

test("stop destroys a raw incomplete TLS handshake within its bound", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA], { handshakeTimeoutMs: 150 });
  try {
    const address = await broker.start();
    const raw = netConnect(address.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      raw.once("connect", resolveConnect);
      raw.once("error", rejectConnect);
    });
    const started = Date.now();
    await broker.stop();
    assert.ok(Date.now() - started < 1_000);
    assert.equal(existsSync(address.socketPath), false);
    raw.destroy();
  } finally {
    await broker.stop();
    cleanup(fixture);
  }
});

test("rejects a non-private runtime directory", () => {
  const fixture = setup();
  const publicDir = join(fixture.dir, "public-runtime");
  mkdirPrivate(publicDir);
  chmodSync(publicDir, 0o755);
  assert.throws(
    () => brokerFor({ ...fixture, runtimeDir: publicDir }),
    (error: unknown) => error instanceof BrokerError && error.code === "runtime_directory_not_private",
  );
  cleanup(fixture);
});

test("keeps wire framing bounded without splitting a UTF-8 code point", () => {
  const decoder = new NdjsonDecoder(256);
  const frame = encodeFrame({ text: "🦄" });
  const emoji = Buffer.from("🦄", "utf8");
  const split = frame.indexOf(emoji) + 1;
  assert.deepEqual(decoder.push(frame.subarray(0, split)), []);
  assert.deepEqual(decoder.push(frame.subarray(split)), [{ text: "🦄" }]);
  decoder.finish();
  assert.throws(() => new NdjsonDecoder(4).push(Buffer.from("12345", "utf8")), (error: unknown) => error instanceof Error && "code" in error && error.code === "frame_too_large");
  const largePayload = "x".repeat(120_000);
  const largeDecoder = new NdjsonDecoder(130_000);
  const largeFrame = encodeFrame({ payload: largePayload }, 130_000);
  const largeFrames: unknown[] = [];
  for (let offset = 0; offset < largeFrame.length; offset += 7) {
    largeFrames.push(...largeDecoder.push(largeFrame.subarray(offset, offset + 7)));
  }
  assert.deepEqual(largeFrames, [{ payload: largePayload }]);
  largeDecoder.finish();
  const truncated = new NdjsonDecoder();
  truncated.push(Buffer.from("{", "utf8"));
  assert.throws(() => truncated.finish(), (error: unknown) => error instanceof Error && "code" in error && error.code === "frame_truncated");
});

test("derives and registers an effective native session binding before ready", async () => {
  const fixture = setup();
  const credential = { ...fixture.credentialA, allowNativeSessions: true } satisfies BrokerBindingCredential;
  const broker = brokerFor(fixture, [credential]);
  const client = new AgentMemoryBrokerClient({
    socketPath: join(fixture.runtimeDir, "broker.sock"),
    credential,
    nativeSessionId: "codex-native-session-a",
  });
  const resumed = new AgentMemoryBrokerClient({
    socketPath: join(fixture.runtimeDir, "broker.sock"),
    credential,
    nativeSessionId: "codex-native-session-a",
  });
  try {
    const address = await broker.start();
    // The socket path is fixed by brokerFor; using the returned address also
    // makes the test independent of the runtime-directory naming.
    const connected = new AgentMemoryBrokerClient({
      socketPath: address.socketPath,
      credential,
      nativeSessionId: "codex-native-session-a",
    });
    await connected.connect();
    const expected = createNativeSessionBinding(fixture.bindingA, "codex-native-session-a");
    assert.equal(connected.connectedBinding.binding_id, expected.binding_id);
    assert.equal(connected.connectedBinding.host_session_id, "codex-native-session-a");
    assert.deepEqual(connected.connectedBinding.allowed_scope_ids, fixture.bindingA.allowed_scope_ids);
    const internalSessionId = connected.registeredSessionIds.get(scopeId);
    assert.ok(internalSessionId);
    assert.equal(fixture.db.findSessionForBinding(scopeId, connected.connectedBinding), internalSessionId);

    await resumed.connect();
    assert.equal(resumed.registeredSessionIds.get(scopeId), internalSessionId);
    await connected.close();
  } finally {
    await client.close();
    await resumed.close();
    await broker.stop();
    cleanup(fixture);
  }
});

test("keeps fixed-credential compatibility and denies native sessions without explicit capability", async () => {
  const fixture = setup();
  const broker = brokerFor(fixture, [fixture.credentialA]);
  const client = new AgentMemoryBrokerClient({
    socketPath: join(fixture.runtimeDir, "broker.sock"),
    credential: fixture.credentialA,
    nativeSessionId: "native-denied",
  });
  try {
    await broker.start();
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof BrokerError && error.code === "authentication_failed",
    );
  } finally {
    await client.close();
    await broker.stop();
    cleanup(fixture);
  }
});

test("does not emit ready when native scope registration fails", async () => {
  const fixture = setup();
  const missingScope = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const binding = createTrustedBinding({
    version: 1,
    binding_id: "edededed-eded-4ede-8ded-edededededed",
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "local-macos" },
    host_instance_id: "missing-scope-host",
    host_session_id: "installation",
    allowed_scope_ids: [missingScope],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:xp-copilot"] },
  });
  const credential = { binding, secret: secretA, allowNativeSessions: true } satisfies BrokerBindingCredential;
  const broker = brokerFor(fixture, [credential]);
  const client = new AgentMemoryBrokerClient({
    socketPath: join(fixture.runtimeDir, "broker.sock"),
    credential,
    nativeSessionId: "native-missing-scope",
  });
  try {
    await broker.start();
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof BrokerError && error.code === "store_unavailable",
    );
  } finally {
    await client.close();
    await broker.stop();
    cleanup(fixture);
  }
});

test("rejects a ready frame whose effective native authority was tampered", async () => {
  const fixture = setup();
  const socketPath = join(fixture.runtimeDir, "tampered-ready.sock");
  const effective = createNativeSessionBinding(fixture.bindingA, "native-tampered");
  const fake = createTlsServer(
    {
      ciphers: IPC_PSK_CIPHER,
      minVersion: IPC_TLS_VERSION,
      maxVersion: IPC_TLS_VERSION,
      rejectUnauthorized: false,
      pskCallback: (_socket, identity) => identity === fixture.bindingA.binding_id ? secretA : null,
    },
    (socket) => {
      const decoder = new NdjsonDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (typeof frame !== "object" || frame === null || !("kind" in frame) || frame.kind !== "hello") continue;
          writeFrame(socket, {
            version: 1,
            kind: "ready",
            binding_id: fixture.bindingA.binding_id,
            server_id: randomUUID(),
            native_session_id: "native-tampered",
            effective_binding: { ...effective, host_instance_id: "foreign-host" },
            registered_sessions: { [scopeId]: randomUUID() },
          });
        }
      });
    },
  );
  const client = new AgentMemoryBrokerClient({
    socketPath,
    credential: { binding: fixture.bindingA, secret: secretA },
    nativeSessionId: "native-tampered",
  });
  try {
    await new Promise<void>((resolveListen) => fake.listen(socketPath, resolveListen));
    await assert.rejects(
      () => client.connect(),
      (error: unknown) => error instanceof BrokerError && error.code === "authentication_failed",
    );
  } finally {
    await client.close();
    await new Promise<void>((resolveClose) => fake.close(() => resolveClose()));
    cleanup(fixture);
  }
});

test("recognize_context returns only persisted own-packet recognition", async () => {
  const fixture = setup();
  const readerPolicy = createPolicySetupBinding({
    version: 1,
    setup_id: "abababab-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:codex_cli"],
  });
  setScopeOutputGrants(
    fixture.db,
    readerPolicy,
    scopeId,
    [{ target: "reader:codex_cli", source_classes: [...brokerSourceClasses] }],
    "2026-09-07T20:00:02Z",
  );
  const broker = brokerFor(fixture);
  const client = new AgentMemoryBrokerClient({
    socketPath: join(fixture.runtimeDir, "broker.sock"),
    credential: fixture.credentialA,
  });
  try {
    await broker.start();
    const packet = await prepareEvidencePacket(
      fixture.db,
      { query: "unmatched synthetic query", scope_ids: [scopeId], mode: "current", token_budget: 600 },
      fixture.bindingA,
      createPreparationContext(fixture.bindingA, {
        version: 1,
        kind: "session_start",
        deadline_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        capture_status: { state: "not_attempted" },
      }),
    );
    const wrapper = serializeModelContext(packet);
    await client.connect();
    assert.equal(await client.recognizeContext(wrapper), true);
    const altered = JSON.parse(wrapper) as Record<string, unknown>;
    altered.injection_id = randomUUID();
    assert.equal(await client.recognizeContext(altered), false);
    assert.equal(await client.recognizeContext("agent_memory_context ordinary user text"), false);
  } finally {
    await client.close();
    await broker.stop();
    cleanup(fixture);
  }
});
