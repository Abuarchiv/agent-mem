import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import test from "node:test";

import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { capture } from "../src/core/capture.js";
import { purgeSource } from "../src/core/purge-source.js";
import { prepareSourceEvidencePacket } from "../src/context/source-only.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import {
  AgentMemoryBroker,
  AgentMemoryBrokerClient,
  BrokerError,
  type BrokerBindingCredential,
} from "../src/host/broker.js";
import { createMemoryMcpServer, createMemoryMcpStreamServer, MemoryMcpError } from "../src/host/mcp.js";
import {
  IPC_PSK_CIPHER,
  IPC_TLS_VERSION,
  NdjsonDecoder,
  encodeFrame,
  writeFrame,
} from "../src/host/ipc.js";
import {
  MEMORY_MCP_SERVER_NAME,
  MEMORY_MCP_SERVER_VERSION,
  MEMORY_TOOL_CATALOG_VERSION,
  memoryToolNames,
} from "../src/host/tool-schemas.js";
import type { FullPurgeResult } from "../src/core/purge.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const policyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secret = Buffer.alloc(32, 7);
const sourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

interface Fixture {
  readonly directory: string;
  readonly runtimeDirectory: string;
  readonly database: AgentMemoryDatabase;
  readonly binding: TrustedBinding;
  readonly credential: BrokerBindingCredential;
}

function bindingFor(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "v1-wire" },
    host_instance_id: "v1-wire-host",
    host_session_id: "v1-wire-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-wire-"));
  const runtimeDirectory = join(directory, "runtime");
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  chmodSync(runtimeDirectory, 0o700);
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"));
  const binding = bindingFor();
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: policyId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:codex_cli"],
  });
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "v1-wire", created_at: "2026-09-14T08:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-14T08:00:00Z");
  setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: [...sourceClasses] }], "2026-09-14T08:00:01Z");
  return { directory, runtimeDirectory, database, binding, credential: { binding, secret } };
}

function close(fixture: Fixture): void {
  if (!fixture.database.isClosed()) fixture.database.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function captureSource(fixture: Fixture, captureId: string, text: string): void {
  capture(
    {
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      origin: {
        host_kind: fixture.binding.host_kind,
        surface: fixture.binding.surface,
        execution_domain: { ...fixture.binding.execution_domain },
        host_instance_id: fixture.binding.host_instance_id,
        host_session_id: fixture.binding.host_session_id,
      },
      adapter_version: "0.1.0",
      event: {
        stage: "prompt_submitted",
        role: "user",
        evidence_class: "prompt",
        native_ids: { session_id: fixture.binding.host_session_id, turn_id: captureId },
        text,
      },
      payload: { text },
      captured_at: "2026-09-15T08:01:00Z",
      occurred_at: "2026-09-15T08:01:00Z",
      truncation: { truncated: false },
      redaction: { applied: true, policy_version: "1.0.0" },
    },
    fixture.binding,
    fixture.database,
  );
}

function tlsOptions(socketPath: string, binding: TrustedBinding) {
  return {
    path: socketPath,
    ciphers: IPC_PSK_CIPHER,
    minVersion: IPC_TLS_VERSION,
    maxVersion: IPC_TLS_VERSION,
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: binding.binding_id, psk: secret }),
  };
}

interface RawConnection {
  readonly socket: TLSSocket;
  readonly nextFrame: () => Promise<unknown>;
}

async function rawConnection(socketPath: string, binding: TrustedBinding): Promise<RawConnection> {
  const socket = tlsConnect(tlsOptions(socketPath, binding));
  const decoder = new NdjsonDecoder();
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter === undefined) frames.push(frame);
      else waiter(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const nextFrame = (): Promise<unknown> => {
    const queued = frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  writeFrame(socket, { version: 1, kind: "hello", binding_id: binding.binding_id });
  const ready = await nextFrame();
  assert.equal((ready as { kind?: unknown }).kind, "ready");
  return { socket, nextFrame };
}

test("V1 RPC handles two clients, malformed/replayed frames, and absent handlers", async () => {
  const fixture = setup();
  let broker: AgentMemoryBroker | undefined;
  const clients: AgentMemoryBrokerClient[] = [];
  try {
    const handled: unknown[] = [];
    const clientContexts = new Set<object>();
    broker = new AgentMemoryBroker({
      database: fixture.database,
      runtimeDirectory: fixture.runtimeDirectory,
      credentials: [fixture.credential],
      rpcHandler: (binding, payload, _signal, client) => {
        assert.ok(client);
        clientContexts.add(client);
        handled.push({ binding_id: binding.binding_id, payload });
        return { accepted: true, payload };
      },
    });
    const address = await broker.start();
    const first = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credential });
    const second = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credential });
    clients.push(first, second);
    const [firstResult, secondResult] = await Promise.all([
      first.rpc({ kind: "mcp", message: { jsonrpc: "2.0", id: 1, method: "ping" } }),
      second.rpc({ kind: "control", operation: "status" }),
    ]);
    assert.deepEqual(firstResult, { accepted: true, payload: { kind: "mcp", message: { jsonrpc: "2.0", id: 1, method: "ping" } } });
    assert.deepEqual(secondResult, { accepted: true, payload: { kind: "control", operation: "status" } });
    assert.equal(handled.length, 2);
    assert.equal(clientContexts.size, 2);

    const raw = await rawConnection(address.socketPath, fixture.binding);
    const request = { version: 1, kind: "rpc_request", seq: 1, request_id: randomUUID(), payload: { kind: "mcp", message: null } };
    raw.socket.write(Buffer.concat([encodeFrame(request), encodeFrame(request)]));
    const replayFrames = await Promise.all([raw.nextFrame(), raw.nextFrame()]);
    assert.equal(replayFrames.filter((frame) => (frame as { kind?: unknown }).kind === "rpc_response").length, 1);
    assert.equal((replayFrames.find((frame) => (frame as { kind?: unknown }).kind === "error") as { code?: string }).code, "request_replay");
    raw.socket.destroy();

    const malformed = await rawConnection(address.socketPath, fixture.binding);
    writeFrame(malformed.socket, { version: 1, kind: "rpc_request", seq: 1, request_id: randomUUID() });
    assert.deepEqual(await malformed.nextFrame(), { code: "request_invalid", kind: "error", version: 1 });
    malformed.socket.destroy();

    await Promise.all(clients.map((client) => client.close()));
    await broker.stop();
    broker = new AgentMemoryBroker({ database: fixture.database, runtimeDirectory: fixture.runtimeDirectory, credentials: [fixture.credential] });
    const unavailableAddress = await broker.start();
    const unavailable = new AgentMemoryBrokerClient({ socketPath: unavailableAddress.socketPath, credential: fixture.credential });
    await assert.rejects(() => unavailable.rpc({ kind: "mcp", message: null }), (error: unknown) => error instanceof BrokerError && error.code === "rpc_unavailable");
    await unavailable.close();
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await broker?.stop();
    close(fixture);
  }
});

test("V1 RPC keeps pending-limit and disconnect behavior bounded", async () => {
  const fixture = setup();
  const broker = new AgentMemoryBroker({
    database: fixture.database,
    runtimeDirectory: fixture.runtimeDirectory,
    credentials: [fixture.credential],
    rpcHandler: () => new Promise<never>(() => undefined),
  });
  try {
    const address = await broker.start();
    const client = new AgentMemoryBrokerClient({ socketPath: address.socketPath, credential: fixture.credential, maxPendingRequests: 1, requestTimeoutMs: 1_000 });
    const first = client.rpc({ kind: "control", operation: "status" });
    const firstFailure = assert.rejects(first, (error: unknown) => error instanceof BrokerError && error.code === "transport_closed");
    await assert.rejects(() => client.rpc({ kind: "control", operation: "pause" }), (error: unknown) => error instanceof BrokerError && error.code === "pending_limit");
    await client.close();
    await firstFailure;
  } finally {
    await broker.stop();
    close(fixture);
  }
});

test("V1 MCP exposes four tools and forwards owner callbacks", async () => {
  const fixture = setup();
  try {
    for (let index = 0; index < 4; index += 1) {
      captureSource(
        fixture,
        randomUUID(),
        `wire original decision ${index} ` + "The complete original deployment constraint must remain visible. ".repeat(4),
      );
    }
    let recallRequest: unknown;
    let forgetRequest: unknown;
    const server = createMemoryMcpServer({
      database: fixture.database,
      binding: fixture.binding,
      policyBinding: createPolicySetupBinding({
        version: 1,
        setup_id: policyId,
        allowed_scope_ids: [scopeId],
        allowed_output_targets: ["reader:codex_cli"],
      }),
      prepareRecall: async (request, context) => {
        recallRequest = request;
        return prepareSourceEvidencePacket(fixture.database, request, fixture.binding, context);
      },
      forget: async (request) => {
        forgetRequest = request;
        return {} as FullPurgeResult;
      },
    });
    assert.deepEqual(server.tools.map((tool) => tool.name), ["memory_recall", "memory_get", "memory_forget", "memory_write"]);
    assert.deepEqual(memoryToolNames, ["memory_recall", "memory_get", "memory_forget", "memory_write"]);
    const recallDescriptor = server.tools.find((tool) => tool.name === "memory_recall");
    assert.deepEqual(recallDescriptor?.inputSchema.required, ["query"]);
    assert.deepEqual(recallDescriptor?.annotations, { readOnlyHint: true, openWorldHint: false });
    assert.deepEqual(recallDescriptor?.inputSchema.properties["mode"], { enum: ["current", "historical", "timeline"], default: "current" });
    assert.deepEqual(recallDescriptor?.inputSchema.properties["max_bytes"], { type: "integer", minimum: 1, maximum: 32000, default: 8000, description: "UTF-8 byte limit; maximum 32000." });
    assert.equal((recallDescriptor?.inputSchema.properties["token_budget"] as { description?: string }).description, "Legacy name for max_bytes; uses UTF-8 bytes.");

    const initialize = await server.handleMessageObject({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const serverInfo = (initialize?.result as { serverInfo: { name: string; version: string } }).serverInfo;
    assert.deepEqual(serverInfo, { name: MEMORY_MCP_SERVER_NAME, version: MEMORY_MCP_SERVER_VERSION });
    const list = await server.handleMessageObject({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal((list?.result as { tool_catalog_version: number }).tool_catalog_version, MEMORY_TOOL_CATALOG_VERSION);
    assert.deepEqual(server.tools.find((tool) => tool.name === "memory_get")?.annotations, { readOnlyHint: true, openWorldHint: false });
    assert.deepEqual(server.tools.find((tool) => tool.name === "memory_forget")?.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false });

    const recall = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { query: "wire" }, _meta: { progressToken: 1 } },
    });
    assert.equal((recall?.result as { isError?: boolean }).isError, undefined);
    assert.deepEqual((recallRequest as { scope_ids: string[] }).scope_ids, [scopeId]);
    assert.equal((recallRequest as { token_budget: number }).token_budget, 8000);
    const recallText = ((recall?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "");
    const recallPayload = JSON.parse(recallText) as { packet: { items: readonly unknown[]; tokens: { used: number; budget: number; unit: string } } };
    assert.ok(recallPayload.packet.items.length >= 3);
    assert.equal(recallPayload.packet.tokens.unit, "utf8_bytes");
    assert.equal(recallPayload.packet.tokens.budget, 8000);
    assert.ok(recallPayload.packet.tokens.used > 600);

    const nullScopes = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { query: "wire", scope_ids: null } },
    });
    assert.equal((nullScopes?.result as { isError?: boolean }).isError, true);

    const forget = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_forget", arguments: { version: 1, scope_id: scopeId, capture_ids: [randomUUID()], expected_privacy_epoch: "0" } },
    });
    assert.equal((forget?.result as { isError?: boolean }).isError, undefined);
    assert.equal((forgetRequest as { version: number }).version, 1);
    assert.match((forgetRequest as { operation_id: string }).operation_id, /^[0-9a-f-]{36}$/);
    assert.match((forgetRequest as { requested_at: string }).requested_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    close(fixture);
  }
});

test("MCP recall exposes bounded omitted source refs for follow-up memory_get", async () => {
  const fixture = setup();
  try {
    const captureId = randomUUID();
    const sourceText = `OMITTED_SOURCE_MARKER ${"long tool payload ".repeat(2_000)}`;
    captureSource(fixture, captureId, sourceText);

    const server = createMemoryMcpServer({
      database: fixture.database,
      binding: fixture.binding,
      policyBinding: createPolicySetupBinding({
        version: 1,
        setup_id: policyId,
        allowed_scope_ids: [scopeId],
        allowed_output_targets: ["reader:codex_cli"],
      }),
    });
    const recall = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { query: "OMITTED_SOURCE_MARKER", max_bytes: 8_000 } },
    });
    const recallText = ((recall?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "");
    const recallPayload = JSON.parse(recallText) as {
      packet: { items: readonly unknown[] };
      omitted_sources?: readonly { capture_id: string; scope_id: string; [key: string]: unknown }[];
    };
    assert.equal(recallPayload.packet.items.length, 1);
    assert.match(JSON.stringify(recallPayload.packet.items[0]), /OMITTED_SOURCE_MARKER/);
    assert.equal(recallPayload.omitted_sources?.length ?? 0, 0);

    const get = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "memory_get", arguments: { scope_id: scopeId, reference: { kind: "source", capture_id: captureId } } },
    });
    const getText = ((get?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "");
    const getPayload = JSON.parse(getText) as { source: { payload: { text: string } } };
    assert.equal(getPayload.source.payload.text, sourceText);
  } finally {
    close(fixture);
  }
});

test("MCP omitted source refs preserve candidate order and cap at ten", async () => {
  const fixture = setup();
  try {
    const captureIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const captureId = randomUUID();
      captureIds.push(captureId);
      captureSource(fixture, captureId, `OMITTED_ORDER_MARKER ${index} ${"long tool payload ".repeat(2_000)}`);
    }
    const server = createMemoryMcpServer({ database: fixture.database, binding: fixture.binding, policyBinding: createPolicySetupBinding({
      version: 1,
      setup_id: policyId,
      allowed_scope_ids: [scopeId],
      allowed_output_targets: ["reader:codex_cli"],
    }) });
    const response = await server.handleMessageObject({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "memory_recall", arguments: { query: "OMITTED_ORDER_MARKER", max_bytes: 8_000 } },
    });
    const payload = JSON.parse(((response?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "")) as {
      packet: { delivery?: { injection_id: string }; items: readonly unknown[] };
      omitted_sources?: readonly { capture_id: string; scope_id: string }[];
    };
    assert.ok(payload.packet.items.length > 0);
    const trace = fixture.database.getQueryTrace(payload.packet.delivery!.injection_id);
    assert.ok(trace);
    assert.equal(payload.omitted_sources?.length, 10);
    assert.deepEqual(
      payload.omitted_sources?.map((reference) => reference.capture_id),
      trace.candidate_ids.filter((captureId) => !trace.output_ids.includes(captureId)).slice(0, 10),
    );
    assert.ok(captureIds.every((captureId) => trace.candidate_ids.includes(captureId)));
  } finally {
    close(fixture);
  }
});

test("MCP omitted source refs fail closed after grant revocation or purge", async () => {
  for (const mutation of ["grant", "purge"] as const) {
    const fixture = setup();
    try {
      const captureId = randomUUID();
      captureSource(fixture, captureId, `OMITTED_REVOKE_MARKER ${"long tool payload ".repeat(2_000)}`);
      const policy = createPolicySetupBinding({
        version: 1,
        setup_id: policyId,
        allowed_scope_ids: [scopeId],
        allowed_output_targets: ["reader:codex_cli"],
      });
      const server = createMemoryMcpServer({
        database: fixture.database,
        binding: fixture.binding,
        policyBinding: policy,
        prepareRecall: async (request, context) => {
          const packet = await prepareSourceEvidencePacket(fixture.database, request, fixture.binding, context);
          if (mutation === "grant") {
            setScopeOutputGrants(fixture.database, policy, scopeId, [], "2026-09-15T08:02:00Z");
          } else {
            purgeSource(fixture.database, policy, {
              version: 1,
              operation_id: randomUUID(),
              scope_id: scopeId,
              capture_ids: [captureId],
              expected_privacy_epoch: fixture.database.getScopePrivacyEpoch(scopeId),
              requested_at: "2026-09-15T08:02:00Z",
              full: true,
              defer_completion: true,
            });
          }
          return packet;
        },
      });
      const response = await server.handleMessageObject({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "memory_recall", arguments: { query: "OMITTED_REVOKE_MARKER", max_bytes: 8_000 } },
      });
      const payload = JSON.parse(((response?.result as { content: readonly { text: string }[] }).content[0]?.text ?? "")) as {
        omitted_sources?: readonly unknown[];
      };
      assert.deepEqual(payload.omitted_sources ?? [], [], mutation);
    } finally {
      close(fixture);
    }
  }
});

test("MCP cancellation notification reaches an in-flight stdio recall", async () => {
  const fixture = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output, crlfDelay: Infinity });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  try {
    const server = createMemoryMcpServer({
      database: fixture.database,
      binding: fixture.binding,
      policyBinding: createPolicySetupBinding({
        version: 1,
        setup_id: policyId,
        allowed_scope_ids: [scopeId],
        allowed_output_targets: ["reader:codex_cli"],
      }),
      prepareRecall: async (_request, _context, signal) => {
        resolveStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new MemoryMcpError("deadline"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
        throw new MemoryMcpError("deadline");
      },
    });
    const stream = createMemoryMcpStreamServer(server, input, output);
    const nextLine = (): Promise<string> => new Promise((resolve, reject) => {
      reader.once("line", resolve);
      reader.once("error", reject);
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "memory_recall", arguments: { query: "cancel me" } } })}\n`);
    await started;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } })}\n`);
    const response = JSON.parse(await nextLine()) as { id: number; result?: { isError?: boolean } };
    assert.equal(response.id, 41);
    assert.equal(response.result?.isError, true);
    input.end();
    await stream.done;
  } finally {
    reader.close();
    close(fixture);
  }
});
