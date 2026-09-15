import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { serializeModelContext } from "../src/context/packet.js";
import { resolveTextAtPath, validateSpanExcerpt } from "../src/core/capture.js";
import { createPolicyOutputBinding, createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { lexicalSearch } from "../src/retrieval/lexical.js";
import { createNativeSessionBinding, createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryBroker, type BrokerClientOptions } from "../src/host/broker.js";
import { AgentMemoryDatabase } from "../src/store/database.js";
import {
  OpenCodeBridgeClient,
  OpenCodeBridgeError,
  OPENCODE_BRIDGE_MAX_FRAME_BYTES,
  type OpenCodeBridgeEvent,
} from "../adapters/opencode/bridge-client.js";
import { createOpenCodeBridgeConfig, OpenCodeBridgeService } from "../adapters/opencode/bridge.js";

const scopeId = "81818181-8181-4818-8818-818181818181";
const bindingId = "82828282-8282-4828-8828-828282828282";
const setupId = "83838383-8383-4838-8838-838383838383";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const bridgePath = fileURLToPath(new URL("../adapters/opencode/bridge.js", import.meta.url));

interface Fixture {
  readonly dir: string;
  readonly projectDir: string;
  readonly runtimeDir: string;
  readonly configPath: string;
  readonly db: AgentMemoryDatabase;
  readonly broker: AgentMemoryBroker;
  readonly binding: TrustedBinding;
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function bindingFor(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "opencode",
    surface: "opencode_cli",
    execution_domain: { kind: "local", id: "local-opencode-test" },
    host_instance_id: "opencode-installation-test",
    host_session_id: "installation-session",
    allowed_scope_ids: [scopeId],
    egress: {
      reader_targets: ["reader:opencode_cli"],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function configInput(binding: TrustedBinding, projectDir: string, runtimeDir: string): Record<string, unknown> {
  return {
    version: 1,
    native_version: "1.18.29",
    socket_path: join(runtimeDir, "broker.sock"),
    surface: "opencode_cli",
    binding: {
      version: binding.version,
      binding_id: binding.binding_id,
      host_kind: binding.host_kind,
      surface: binding.surface,
      execution_domain: { ...binding.execution_domain },
      host_instance_id: binding.host_instance_id,
      host_session_id: binding.host_session_id,
      allowed_scope_ids: [...binding.allowed_scope_ids],
      egress: {
        reader_targets: [...binding.egress.reader_targets],
        provider_targets: [...binding.egress.provider_targets],
      },
    },
    broker_secret_hex: secret.toString("hex"),
    projects: [{ scope_id: scopeId, workspace_roots: [projectDir] }],
    session_start_query: "synthetic OpenCode session context",
    adapter_version: "1.0.0",
    request_timeout_ms: 2_000,
    max_frame_bytes: OPENCODE_BRIDGE_MAX_FRAME_BYTES,
  };
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "am-oc-b-"));
  const projectDir = join(dir, "project");
  const runtimeDir = join(dir, "runtime");
  privateDirectory(projectDir);
  privateDirectory(runtimeDir);
  const db = new AgentMemoryDatabase(join(dir, "vault.sqlite"));
  const binding = bindingFor();
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:opencode_cli"],
  });
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "opencode-bridge-test", created_at: "2026-09-07T20:00:00Z" });
  setScopeOutputGrants(
    db,
    policy,
    scopeId,
    [{ target: "reader:opencode_cli", source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }],
    "2026-09-07T20:00:01Z",
  );
  const broker = new AgentMemoryBroker({
    database: db,
    runtimeDirectory: runtimeDir,
    credentials: [{ binding, secret, allowNativeSessions: true }],
  });
  await broker.start();
  const configPath = join(dir, "bridge-config.json");
  const input = configInput(binding, projectDir, runtimeDir);
  assert.equal(createOpenCodeBridgeConfig(input).surface, "opencode_cli");
  writeFileSync(configPath, JSON.stringify(input), { mode: 0o600 });
  return { dir, projectDir, runtimeDir, configPath, db, broker, binding };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.broker.stop();
  if (!fixture.db.isClosed()) fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function clientFor(fixture: Fixture): OpenCodeBridgeClient {
  return new OpenCodeBridgeClient({
    nodePath: process.execPath,
    bridgePath,
    configPath: fixture.configPath,
    helperPath: dirname(process.execPath),
  });
}

function promptEvent(sessionId: string, captureId: string, text: string): OpenCodeBridgeEvent {
  return {
    capture_id: captureId,
    stage: "prompt_submitted",
    native_ids: { session_id: sessionId, message_id: `message-${sessionId}` },
    text,
    payload: { session_id: sessionId, message: text, synthetic: true },
    coverage: { status: "complete" },
    correlation: { status: "correlated", basis: "native_ids", key: `message-${sessionId}` },
  };
}

function toolResultEvent(sessionId: string, captureId: string, callId: string, text: string, nativeOutput: unknown): OpenCodeBridgeEvent {
  return {
    capture_id: captureId,
    stage: "tool_result",
    native_ids: { session_id: sessionId, tool_call_id: callId },
    outcome: "unknown",
    text,
    payload: { tool: "synthetic", call_id: callId, output: nativeOutput },
    coverage: { status: "complete" },
    correlation: { status: "correlated", basis: "native_ids", key: callId },
  };
}

function outputBinding(): ReturnType<typeof createPolicyOutputBinding> {
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:opencode_cli"],
  });
  return createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: "a6464646-4646-4464-8464-646464646464",
    setup_id: setupId,
    scope_id: scopeId,
    target: "reader:opencode_cli",
  });
}

test("real Node bridge multiplexes authenticated native sessions and returns persisted context", async () => {
  const fixture = await setup();
  const client = clientFor(fixture);
  try {
    await Promise.all([
      client.openSession("opencode-session-a", fixture.projectDir),
      client.openSession("opencode-session-b", fixture.projectDir),
    ]);
    const [ackA, ackB] = await Promise.all([
      client.capture("opencode-session-a", fixture.projectDir, promptEvent("opencode-session-a", "91919191-9191-4919-8919-919191919191", "alpha memory source")),
      client.capture("opencode-session-b", fixture.projectDir, promptEvent("opencode-session-b", "92929292-9292-4929-8929-929292929292", "beta memory source")),
    ]);
    assert.equal(ackA.capture_id, "91919191-9191-4919-8919-919191919191");
    assert.equal(ackB.capture_id, "92929292-9292-4929-8929-929292929292");
    const normalToolAck = await client.capture(
      "opencode-session-a",
      fixture.projectDir,
      toolResultEvent("opencode-session-a", "a6767676-7676-4676-8676-767676767676", "call-normal", "normal tool text", "normal tool text"),
    );
    const mcpToolAck = await client.capture(
      "opencode-session-a",
      fixture.projectDir,
      toolResultEvent(
        "opencode-session-a",
        "a6868686-8686-4686-8686-868686868686",
        "call-mcp",
        "mcp tool text",
        [{ type: "text", text: "mcp tool text" }],
      ),
    );
    const spans = outputBinding();
    const normalSource = fixture.db.getSourceForOutput(normalToolAck.capture_id, spans);
    const mcpSource = fixture.db.getSourceForOutput(mcpToolAck.capture_id, spans);
    assert.ok(normalSource && mcpSource);
    for (const [source, expectedText] of [[normalSource, "normal tool text"], [mcpSource, "mcp tool text"]] as const) {
      const spansForSource = fixture.db.getSourceSpansForOutput(source.capture_id, spans);
      assert.ok(spansForSource.length > 0);
      const firstSpan = spansForSource[0];
      assert.ok(firstSpan);
      const event = JSON.parse(source.event_json) as unknown;
      const root = firstSpan.root === "event" ? event : JSON.parse(source.payload_json) as unknown;
      assert.equal(
        validateSpanExcerpt(root === undefined ? "" : resolveTextAtPath(root, firstSpan.path), Number(firstSpan.start_utf16), Number(firstSpan.end_utf16), firstSpan.digest),
        expectedText,
      );
    }
    const effective = createNativeSessionBinding(fixture.binding, "opencode-session-a");
    const normalHits = lexicalSearch(fixture.db, effective, { query: "normal tool text", scope_ids: [scopeId], mode: "current", token_budget: 1_500 }, 10);
    const mcpHits = lexicalSearch(fixture.db, effective, { query: "mcp tool text", scope_ids: [scopeId], mode: "current", token_budget: 1_500 }, 10);
    assert.ok(normalHits.some((hit) => hit.source_id === normalToolAck.capture_id));
    assert.ok(mcpHits.some((hit) => hit.source_id === mcpToolAck.capture_id));
    const packet = await client.recall("opencode-session-a", fixture.projectDir, {
      query: "alpha memory source",
      mode: "current",
      token_budget: 1_500,
      kind_hint: "user_prompt",
      deadline_at: new Date(Date.now() + 10_000).toISOString(),
      capture_status: { state: "committed", capture_id: ackA.capture_id },
    });
    const wrapper = serializeModelContext(packet);
    assert.equal(await client.recognizeContext("opencode-session-a", fixture.projectDir, wrapper), true);
    assert.equal(await client.recognizeContext("opencode-session-a", fixture.projectDir, `${wrapper} trailing text`), false);
    assert.ok(packet.items.every((item) => item.scope_id === scopeId));
  } finally {
    await client.close();
    await cleanup(fixture);
  }
});

test("bridge rejects malformed, oversized, and arbitrary action frames", async () => {
  const fixture = await setup();
  try {
    const spawnBridge = (): ReturnType<typeof spawn> => spawn(process.execPath, [bridgePath, "--config", fixture.configPath], {
      cwd: fixture.dir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: dirname(process.execPath) },
    });
    const malformed = spawnBridge();
    assert.ok(malformed.stdin);
    malformed.stdin.write("{not-json}\n");
    malformed.stdin.end();
    const malformedExit = await new Promise<number | null>((resolve) => malformed.once("close", (code) => resolve(code)));
    assert.notEqual(malformedExit, null);

    const oversized = spawnBridge();
    assert.ok(oversized.stdin);
    oversized.stdin.write(`${"x".repeat(OPENCODE_BRIDGE_MAX_FRAME_BYTES + 2)}\n`);
    oversized.stdin.end();
    const oversizedExit = await new Promise<number | null>((resolve) => oversized.once("close", (code) => resolve(code)));
    assert.notEqual(oversizedExit, null);

    const arbitrary = spawnBridge();
    const output: Buffer[] = [];
    assert.ok(arbitrary.stdout);
    assert.ok(arbitrary.stdin);
    arbitrary.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    arbitrary.stdin.write(`${JSON.stringify({ version: 1, kind: "exec", request_id: "00000000-0000-4000-8000-000000000000", seq: 1, command: "sqlite" })}\n`);
    arbitrary.stdin.end();
    await new Promise<void>((resolve) => arbitrary.once("close", () => resolve()));
    assert.match(Buffer.concat(output).toString("utf8"), /request_invalid|error/);
  } finally {
    await cleanup(fixture);
  }
});

test("bridge applies an already-expired shared deadline before starting a request", async () => {
  const fixture = await setup();
  const client = clientFor(fixture);
  try {
    await assert.rejects(
      client.openSession("opencode-session-deadline", fixture.projectDir, { deadlineAt: Date.now() - 1 }),
      /deadline/,
    );
  } finally {
    await client.close();
    await cleanup(fixture);
  }
});

test("bridge stamps the first observed time once and rejects an outside workspace before session access", async () => {
  const fixture = await setup();
  const captured: unknown[] = [];
  let factoryCalls = 0;
  const serviceConfig = createOpenCodeBridgeConfig(configInput(fixture.binding, fixture.projectDir, fixture.runtimeDir));
  try {
    const service = new OpenCodeBridgeService(serviceConfig, {
      clock: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 8, 7, 20, 0, tick++));
      })(),
      clientFactory: (options: BrokerClientOptions) => {
        factoryCalls += 1;
        const nativeSessionId = options.nativeSessionId;
        assert.ok(nativeSessionId);
        const effectiveBinding = createNativeSessionBinding(fixture.binding, nativeSessionId);
        return {
          connectedBinding: effectiveBinding,
          registeredSessionIds: new Map([[scopeId, "a5959595-9595-4595-8959-959595959595"]]),
          connect: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
          capture: async (event: unknown) => {
            captured.push(event);
            return {
              version: 1 as const,
              capture_id: (event as { capture_id: string }).capture_id,
              commit_seq: "1",
              coverage: { status: "complete" as const, stages: ["prompt_submitted" as const], truncated: false },
            };
          },
          recall: async (): Promise<never> => undefined as never,
          recognizeContext: async (): Promise<boolean> => false,
        };
      },
    });
    const request = {
      version: 1 as const,
      kind: "capture" as const,
      request_id: "a6060606-0606-4606-8606-060606060606",
      seq: 1,
      native_session_id: "native-stamp",
      cwd: fixture.projectDir,
      event: promptEvent("native-stamp", "a6161616-1616-4616-8616-161616161616", "first observed"),
    };
    await service.handle(request);
    await service.handle({ ...request, request_id: "a6262626-2626-4626-8626-262626262626", seq: 2 });
    assert.equal(captured.length, 2);
    assert.equal((captured[0] as { captured_at: string }).captured_at, (captured[1] as { captured_at: string }).captured_at);
    await assert.rejects(
      service.handle({ ...request, request_id: "a6363636-3636-4636-8636-363636363636", seq: 3, cwd: "/tmp" }),
      /cwd_outside_configured_workspace/,
    );
    assert.equal(factoryCalls, 1);
    await service.close();
  } finally {
    await cleanup(fixture);
  }
});

test("owned bridge handles a child that closes stdin without crashing the plugin caller", async () => {
  const fixture = await setup();
  const helperPath = join(fixture.dir, "close-stdin.mjs");
  writeFileSync(helperPath, "process.stdin.destroy(); setTimeout(() => {}, 5000);\n", { mode: 0o600 });
  const client = new OpenCodeBridgeClient({
    nodePath: process.execPath,
    bridgePath: helperPath,
    configPath: fixture.configPath,
    helperPath: dirname(process.execPath),
    requestTimeoutMs: 200,
  });
  try {
    await assert.rejects(client.openSession("native-closed-stdin", fixture.projectDir), (error: unknown) => {
      return error instanceof OpenCodeBridgeError && ["transport_closed", "transport_timeout"].includes(error.reason);
    });
    await client.close();
  } finally {
    await cleanup(fixture);
  }
});

test("non-reading owned child has bounded aggregate writes and cannot be replaced before close", async () => {
  const fixture = await setup();
  const helperPath = join(fixture.dir, "non-reading.mjs");
  writeFileSync(helperPath, "process.on('SIGTERM', () => {}); process.stderr.write('READY\\n'); setTimeout(() => {}, 10000);\n", { mode: 0o600 });
  let readyChild: ChildProcessWithoutNullStreams | undefined;
  try {
    const spawnedChild = spawn(process.execPath, [helperPath, "--config", fixture.configPath], {
      cwd: fixture.dir,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      env: { PATH: dirname(process.execPath) },
    }) as ChildProcessWithoutNullStreams;
    readyChild = spawnedChild;
    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      let stderrBuffer = "";
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupReadyWait = (): void => {
        if (startupTimer !== undefined) clearTimeout(startupTimer);
        spawnedChild.stderr.off("data", onData);
        spawnedChild.off("error", onError);
        spawnedChild.off("close", onClose);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanupReadyWait();
        if (error === undefined) resolveReady();
        else rejectReady(error);
      };
      const onData = (chunk: Buffer): void => {
        stderrBuffer += chunk.toString("utf8");
        if (stderrBuffer.includes("READY\n")) {
          finish();
          return;
        }
        if (stderrBuffer.length > 128) stderrBuffer = stderrBuffer.slice(-128);
      };
      const onError = (error: Error): void => finish(error);
      const onClose = (): void => finish(new Error("helper_closed_before_ready"));
      spawnedChild.stderr.on("data", onData);
      spawnedChild.once("error", onError);
      spawnedChild.once("close", onClose);
      startupTimer = setTimeout(() => finish(new Error("helper_ready_timeout")), 1_000);
      startupTimer.unref?.();
    });
    let childForClient: ChildProcessWithoutNullStreams | undefined = spawnedChild;
    let starts = 0;
    const client = new OpenCodeBridgeClient({
      nodePath: process.execPath,
      bridgePath: helperPath,
      configPath: fixture.configPath,
      helperPath: dirname(process.execPath),
      requestTimeoutMs: 150,
      spawnProcess: (() => {
        starts += 1;
        const child = childForClient;
        assert.ok(child);
        childForClient = undefined;
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }) as unknown as typeof spawn,
    });
    try {
      const oversizedText = "q".repeat(4_000_000);
      const event: OpenCodeBridgeEvent = {
        ...promptEvent("native-non-reading", "a6969696-9696-4696-8696-969696969696", "bounded payload"),
        payload: { blob: oversizedText },
      };
      const firstAttempt = client.capture("native-non-reading", fixture.projectDir, event);
      const retryBeforeClose = client.openSession("native-non-reading-after-failure", fixture.projectDir);
      const attempts = await Promise.allSettled([
        firstAttempt,
        retryBeforeClose,
        client.capture("native-non-reading", fixture.projectDir, { ...event, capture_id: "a7070707-0707-4707-8707-070707070707" }),
        client.capture("native-non-reading", fixture.projectDir, { ...event, capture_id: "a7171717-1717-4717-8717-171717171717" }),
      ]);
      const reasons = attempts.flatMap((attempt) => attempt.status === "rejected" && attempt.reason instanceof OpenCodeBridgeError ? [attempt.reason.reason] : []);
      assert.ok(reasons.includes("transport_backpressure"));
      assert.equal(starts, 1);
      await client.close();
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    if (readyChild !== undefined && readyChild.exitCode === null && readyChild.signalCode === null) readyChild.kill("SIGKILL");
    await cleanup(fixture);
  }
});

test("a rejected write from an old generation cannot terminate a replacement child", async () => {
  const fixture = await setup();
  const children: Array<ChildProcessWithoutNullStreams & { emitClose: () => void }> = [];
  let firstWrite!: () => void;
  const firstWriteSeen = new Promise<void>((resolve) => {
    firstWrite = resolve;
  });
  const makeChild = (index: number): ChildProcessWithoutNullStreams & { emitClose: () => void } => {
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { emitClose: () => void };
    const stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    Object.defineProperties(child, {
      stdin: { value: stdin },
      stdout: { value: stdout },
      stderr: { value: stderr },
      exitCode: { get: () => exitCode },
      signalCode: { get: () => signalCode },
    });
    Object.defineProperty(stdin, "write", {
      configurable: true,
      value: (chunk: Buffer | string): boolean => {
        if (index === 0) {
          firstWrite();
          return false;
        }
        const request = JSON.parse(Buffer.from(chunk).toString("utf8")) as { request_id: string; seq: number };
        stdout.write(`${JSON.stringify({ version: 1, kind: "session_ready", request_id: request.request_id, seq: request.seq })}\n`);
        return true;
      },
    });
    const emitClose = (): void => {
      if (exitCode !== null || signalCode !== null) return;
      exitCode = 0;
      child.emit("close", exitCode, null);
    };
    child.emitClose = emitClose;
    Object.defineProperty(child, "kill", {
      value: (signal?: NodeJS.Signals): boolean => {
        signalCode = signal ?? "SIGTERM";
        child.emit("close", null, signalCode);
        return true;
      },
    });
    return child;
  };
  const client = new OpenCodeBridgeClient({
    nodePath: process.execPath,
    bridgePath,
    configPath: fixture.configPath,
    helperPath: dirname(process.execPath),
    requestTimeoutMs: 1_000,
    spawnProcess: (() => {
      const child = makeChild(children.length);
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn,
  });
  try {
    const oldAttempt = client.openSession("old-generation", fixture.projectDir);
    await firstWriteSeen;
    children[0]?.emitClose();
    await assert.rejects(oldAttempt, /transport_closed/);

    const replacementAttempt = client.openSession("replacement-generation", fixture.projectDir);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
    // This rejects the queued write owned by generation one after generation
    // two is already current. The replacement request must still complete.
    children[0]?.stdin.emit("error", new Error("stale write"));
    await replacementAttempt;
    children[1]?.emitClose();
  } finally {
    await client.close().catch(() => undefined);
    await cleanup(fixture);
  }
});
