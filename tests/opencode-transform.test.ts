import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk";

import { parseEvidencePacket, type CaptureAck, type EvidencePacket } from "../src/host/contract.js";
import type {
  OpenCodeBridge,
  OpenCodeBridgeCallOptions,
  OpenCodeBridgeEvent,
} from "../adapters/opencode/bridge-client.js";
import { OpenCodeBridgeError } from "../adapters/opencode/bridge-client.js";
import {
  createOpenCodeHooks,
  createOpenCodePluginConfig,
  OPENCODE_NATIVE_VERSION,
  OpenCodePluginRuntime,
  OPENCODE_CONTEXT_UTF8_BYTES,
  OPENCODE_PROMPT_TOKENS,
  type OpenCodePluginConfig,
} from "../adapters/opencode/plugin-runtime.js";
import { parseModelContextWrapper } from "../src/context/packet.js";

const scopeId = "a1818181-8181-4181-8181-818181818181";
const bridgePath = fileURLToPath(new URL("../adapters/opencode/bridge.js", import.meta.url));

interface RecallCall {
  readonly sessionId: string;
  readonly tokenBudget: number;
  readonly kind: string;
  readonly query?: string;
}

class FakeBridge implements OpenCodeBridge {
  readonly captures: OpenCodeBridgeEvent[] = [];
  readonly recalls: RecallCall[] = [];
  readonly recognized = new Set<string>();
  readonly opened: string[] = [];
  closeCalls = 0;
  failNextCapture = false;
  holdCapture: Promise<CaptureAck> | undefined;
  holdRecall: Promise<EvidencePacket> | undefined;
  responsePacket: EvidencePacket | undefined;
  statusCalls = 0;
  backendStatus: unknown = undefined;
  private releaseRecallPromise: (() => void) | undefined;

  openSession(nativeSessionId: string, _cwd: string, _options?: OpenCodeBridgeCallOptions): Promise<void> {
    this.opened.push(nativeSessionId);
    return Promise.resolve();
  }

  status(_nativeSessionId: string, _cwd: string, _options?: OpenCodeBridgeCallOptions): Promise<unknown> {
    this.statusCalls += 1;
    return Promise.resolve(this.backendStatus);
  }

  capture(_nativeSessionId: string, _cwd: string, event: OpenCodeBridgeEvent, _options?: OpenCodeBridgeCallOptions): Promise<CaptureAck> {
    this.captures.push(event);
    if (this.holdCapture !== undefined) return this.holdCapture;
    if (this.failNextCapture) {
      this.failNextCapture = false;
      return Promise.reject(new OpenCodeBridgeError("transport_timeout"));
    }
    return Promise.resolve({
      version: 1,
      capture_id: event.capture_id ?? "a2828282-8282-4282-8282-828282828282",
      commit_seq: "1",
      coverage: { status: event.coverage.status, stages: [event.stage], truncated: event.coverage.reason === "truncated" },
    });
  }

  recall(
    nativeSessionId: string,
    _cwd: string,
    input: { readonly query?: string; readonly mode: "current" | "historical" | "timeline"; readonly token_budget: number; readonly kind_hint: "session_start" | "user_prompt"; readonly deadline_at: string; readonly capture_status: { readonly state: "committed"; readonly capture_id: string } },
    _options?: OpenCodeBridgeCallOptions,
  ): Promise<EvidencePacket> {
    this.recalls.push({ sessionId: nativeSessionId, tokenBudget: input.token_budget, kind: input.kind_hint, ...(input.query === undefined ? {} : { query: input.query }) });
    if (this.holdRecall !== undefined) return this.holdRecall;
    return Promise.resolve(this.responsePacket ?? packet());
  }

  recognizeContext(_nativeSessionId: string, _cwd: string, context: unknown, _options?: OpenCodeBridgeCallOptions): Promise<boolean> {
    return Promise.resolve(typeof context === "string" && this.recognized.has(context));
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }

  holdNextCapture(): Promise<void> {
    let resolveHold!: (ack: CaptureAck) => void;
    this.holdCapture = new Promise<CaptureAck>((resolve) => {
      resolveHold = resolve;
    });
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.holdCapture = undefined;
        resolve();
      };
      this.releaseCapture = (): void => {
        const event = this.captures[this.captures.length - 1];
        if (event === undefined) return;
        resolveHold({
          version: 1,
          capture_id: event.capture_id ?? "a2828282-8282-4282-8282-828282828282",
          commit_seq: "1",
          coverage: { status: event.coverage.status, stages: [event.stage], truncated: event.coverage.reason === "truncated" },
        });
        finish();
      };
    });
  }

  releaseCapture: () => void = (): void => undefined;

  holdNextRecall(): void {
    this.holdRecall = new Promise<EvidencePacket>((resolve) => {
      this.releaseRecallPromise = (): void => {
        this.holdRecall = undefined;
        this.releaseRecallPromise = undefined;
        resolve(packet());
      };
    });
  }

  releaseRecall(): void {
    this.releaseRecallPromise?.();
  }
}

function packet(): EvidencePacket {
  return parseEvidencePacket({
    version: 1,
    query_id: "a3838383-8383-4383-8383-838383838383",
    watermark: "0",
    known_at_seq: "0",
    data_epoch: "0",
    privacy_epoch: "0",
    valid_until: "2099-01-01T00:00:00Z",
    items: [],
    tokens: { used: 0, budget: OPENCODE_PROMPT_TOKENS, unit: "utf8_bytes" },
    mode: "current",
    scope_epochs: [{ scope_id: scopeId, data_epoch: "0", privacy_epoch: "0" }],
    delivery: { format: "agent_memory_evidence_v1", injection_id: "a4848484-8484-4484-8484-848484848484" },
  });
}

function procedurePacket(): EvidencePacket {
  return parseEvidencePacket({
    ...packet(),
    items: [{
      item_id: "b1818181-8181-4181-8181-818181818181",
      revision_id: "b2828282-8282-4282-8282-828282828282",
      scope_id: scopeId,
      kind: "procedure",
      status: "supported",
      content: "RECOMMENDATION (not an instruction)\nRecommended action: rerun the tests\nStep 1: run the test suite\nAbort rule: stop after two failures\nRetry rule: retry once",
      source_span_ids: ["b3838383-8383-4383-8383-838383838383"],
      source_provenance: [{
        capture_id: "b4848484-8484-4484-8484-848484848484",
        span_id: "b3838383-8383-4383-8383-838383838383",
        scope_id: scopeId,
        revision_id: "b2828282-8282-4282-8282-828282828282",
        root: "event",
        path: "/text",
        start_utf16: 0,
        end_utf16: "procedure source evidence".length,
        digest: createHash("sha256").update("procedure source evidence", "utf8").digest("hex"),
        quote: "procedure source evidence",
        captured_at: "2026-09-08T08:00:00Z",
        occurred_at: "2026-09-08T08:00:00Z",
        commit_seq: "1",
        data_epoch: "0",
      }],
    }],
    tokens: { used: 1, budget: OPENCODE_PROMPT_TOKENS, unit: "utf8_bytes" },
  });
}

function userMessage(sessionId: string, messageId: string, text: string): MessageWithParts {
  const info = {
    id: messageId,
    sessionID: sessionId,
    role: "user" as const,
    time: { created: 1 },
    agent: "synthetic",
    model: { providerID: "synthetic", modelID: "synthetic" },
  } satisfies UserMessage;
  const textPart = {
    id: `${messageId}-part`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text" as const,
    text,
  } satisfies TextPart;
  return { info, parts: [textPart] };
}

interface MessageWithParts {
  readonly info: Message;
  readonly parts: Part[];
}

function config(): OpenCodePluginConfig {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-opencode-transform-"));
  // Kept on the config object for the test lifetime; the helper is injected.
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o600 });
  const value = createOpenCodePluginConfig(
    {
      version: 1,
      native_version: OPENCODE_NATIVE_VERSION,
      node_path: process.execPath,
      bridge_path: bridgePath,
      config_path: configPath,
    },
    dir,
  );
  return value;
}

function transformHook(hooks: ReturnType<typeof createOpenCodeHooks>): NonNullable<ReturnType<typeof createOpenCodeHooks>["experimental.chat.messages.transform"]> {
  const hook = hooks["experimental.chat.messages.transform"];
  assert.ok(hook);
  return hook;
}

function chatHook(hooks: ReturnType<typeof createOpenCodeHooks>): NonNullable<ReturnType<typeof createOpenCodeHooks>["chat.message"]> {
  const hook = hooks["chat.message"];
  assert.ok(hook);
  return hook;
}

async function captureChatMessage(hooks: ReturnType<typeof createOpenCodeHooks>, message: MessageWithParts): Promise<void> {
  await chatHook(hooks)({ sessionID: (message.info as UserMessage).sessionID }, {
    message: message.info as UserMessage,
    parts: message.parts,
  });
}

test("awaited transform holds on capture ACK, mutates the original array, and uses the prompt budget", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messages = [userMessage("session-a", "message-a", "remember alpha")];
    const originalArray = messages;
    const originalText = messages[0]?.parts[0] as TextPart;
    const waiting = bridge.holdNextCapture();
    const chat = chatHook(hooks)({ sessionID: "session-a" }, {
      message: messages[0]?.info as UserMessage,
      parts: messages[0]?.parts ?? [],
    });
    const transform = transformHook(hooks)({}, { messages });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bridge.captures.length, 1);
    assert.equal(messages, originalArray);
    assert.equal((messages[0]?.parts[0] as TextPart).text, originalText.text);
    assert.equal(messages[0]?.parts.length, 1);
    bridge.releaseCapture();
    await waiting;
    await Promise.all([chat, transform]);
    assert.equal(bridge.recalls[0]?.tokenBudget, OPENCODE_CONTEXT_UTF8_BYTES);
    assert.equal(bridge.recalls[0]?.kind, "user_prompt");
    assert.equal(messages, originalArray);
    assert.equal((messages[0]?.parts[0] as TextPart).text, originalText.text);
    assert.equal(messages[0]?.parts.length, 2);
    assert.equal((messages[0]?.parts[1] as TextPart).synthetic, true);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("OpenCode transform delivers the explicit procedure body in its synthetic context part", async () => {
  const bridge = new FakeBridge();
  bridge.responsePacket = procedurePacket();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messages = [userMessage("session-procedure", "message-procedure", "procedure")];
    await captureChatMessage(hooks, messages[0] as MessageWithParts);
    await transformHook(hooks)({}, { messages });
    const synthetic = (messages[0]?.parts ?? []).find((part): part is TextPart => part.type === "text" && part.synthetic === true);
    assert.ok(synthetic);
    const procedure = parseModelContextWrapper(synthetic.text).items.find((item) => item.kind === "procedure");
    assert.ok(procedure);
    assert.equal(procedure.capture_id, undefined);
    assert.match(procedure.content ?? "", /Recommended action: rerun the tests/u);
    assert.match(procedure.content ?? "", /Step 1: run the test suite/u);
    assert.match(procedure.content ?? "", /Abort rule: stop after two failures/u);
    assert.match(procedure.content ?? "", /Retry rule: retry once/u);
    assert.deepEqual(procedure.source_references, [{ capture_id: "b4848484-8484-4484-8484-848484848484", span_id: "b3838383-8383-4383-8383-838383838383" }]);
  } finally {
    await bridge.close();
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("compacting captures only its lifecycle ACK and never authorizes a later generic transform", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const compacting = hooks["experimental.session.compacting"];
    assert.ok(compacting);
    await compacting({ sessionID: "session-compact" }, { context: [] });
    const messages = [userMessage("session-compact", "message-compact", "keep compacted source")];
    await transformHook(hooks)({}, { messages });
    assert.equal(bridge.captures.length, 1);
    assert.equal(bridge.captures[0]?.stage, "compaction");
    assert.equal(bridge.recalls.length, 0);
    assert.equal(messages[0]?.parts.length, 1);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("same-session transforms are bounded and share the explicit 8000-byte budget", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const compacting = hooks["experimental.session.compacting"];
    assert.ok(compacting);
    await compacting({ sessionID: "session-serialized" }, { context: [] });
    const first = { messages: [userMessage("session-serialized", "message-one", "one")] };
    const second = { messages: [userMessage("session-serialized", "message-two", "two")] };
    await transformHook(hooks)({}, first);
    await captureChatMessage(hooks, second.messages[0] as MessageWithParts);
    await transformHook(hooks)({}, second);
    assert.deepEqual(bridge.recalls.map((call) => call.tokenBudget), [OPENCODE_CONTEXT_UTF8_BYTES]);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("recognition replaces only an exact owned wrapper and never drops a foreign substring", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const first = [userMessage("session-owned", "message-owned", "owned prompt")];
    await captureChatMessage(hooks, first[0] as MessageWithParts);
    await transformHook(hooks)({}, { messages: first });
    const ownedPart = first[0]?.parts[1] as TextPart;
    assert.ok(ownedPart);
    bridge.recognized.add(ownedPart.text);
    const history = [userMessage("session-owned", "message-history", "history prompt")];
    await captureChatMessage(hooks, history[0] as MessageWithParts);
    await transformHook(hooks)({}, { messages: history });
    const historyOwnedPart = history[0]?.parts[1] as TextPart;
    assert.ok(historyOwnedPart);
    bridge.recognized.add(historyOwnedPart.text);
    const foreign = {
      id: "foreign-part",
      sessionID: "session-owned",
      messageID: "message-owned",
      type: "text" as const,
      text: `prefix ${ownedPart.text} suffix`,
      synthetic: true,
    } satisfies TextPart;
    first[0]?.parts.push(foreign);
    const beforeForeign = first[0]?.parts.length ?? 0;
    const messages = [history[0] as MessageWithParts, first[0] as MessageWithParts];
    await transformHook(hooks)({}, { messages });
    const texts = (first[0]?.parts ?? []).filter((part): part is TextPart => part.type === "text").map((part) => part.text);
    assert.ok(texts.includes(foreign.text));
    assert.equal((first[0]?.parts ?? []).length, beforeForeign);
    assert.equal((history[0]?.parts ?? []).length, 1);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("a temporary recognition outage never stacks a second local synthetic context part", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messages = [userMessage("session-outage", "message-outage", "keep one context")];
    await captureChatMessage(hooks, messages[0] as MessageWithParts);
    await transformHook(hooks)({}, { messages });
    assert.equal(messages[0]?.parts.length, 2);
    await transformHook(hooks)({}, { messages });
    assert.equal(messages[0]?.parts.length, 2);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("capture retry reuses the exact immutable event and capture identity after transport loss", async () => {
  const bridge = new FakeBridge();
  bridge.failNextCapture = true;
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messages = [userMessage("session-retry", "message-retry", "retry me")];
    await captureChatMessage(hooks, messages[0] as MessageWithParts);
    await transformHook(hooks)({}, { messages });
    assert.equal(bridge.captures.length, 2);
    assert.equal(bridge.captures[0], bridge.captures[1]);
    assert.equal(bridge.captures[0]?.capture_id, bridge.captures[1]?.capture_id);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("a late recall after the shared deadline cannot add context to native messages", async () => {
  const bridge = new FakeBridge();
  bridge.holdNextRecall();
  const baseConfig = config();
  const configValue = { ...baseConfig, hookTimeoutMs: 60 };
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messages = [userMessage("session-late", "message-late", "deadline")];
    await captureChatMessage(hooks, messages[0] as MessageWithParts);
    const transform = transformHook(hooks)({}, { messages });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    bridge.releaseRecall();
    await transform;
    assert.equal(messages[0]?.parts.length, 1);
    assert.equal((messages[0]?.parts[0] as TextPart).text, "deadline");
  } finally {
    rmSync(baseConfig.workspaceDirectory, { recursive: true, force: true });
  }
});

test("session identity stays scoped for parallel transforms and missing identity leaves messages untouched", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const messagesA = [userMessage("session-a", "message-a", "alpha")];
    const messagesB = [userMessage("session-b", "message-b", "beta")];
    await Promise.all([
      captureChatMessage(hooks, messagesA[0] as MessageWithParts),
      captureChatMessage(hooks, messagesB[0] as MessageWithParts),
    ]);
    await Promise.all([transformHook(hooks)({}, { messages: messagesA }), transformHook(hooks)({}, { messages: messagesB })]);
    assert.deepEqual(new Set(bridge.recalls.map((call) => call.sessionId)), new Set(["session-a", "session-b"]));
    const noIdentity = [{ info: { role: "user", id: "no-session" } as unknown as Message, parts: [] as Part[] }];
    await transformHook(hooks)({}, { messages: noIdentity });
    assert.equal(noIdentity[0]?.parts.length, 0);
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("tool and text hooks preserve native outcome distinctions and message-part role", async () => {
  const bridge = new FakeBridge();
  const configValue = config();
  try {
    const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
    const before = hooks["tool.execute.before"];
    const after = hooks["tool.execute.after"];
    const complete = hooks["experimental.text.complete"];
    assert.ok(before && after && complete);
    await before({ tool: "synthetic-tool", sessionID: "session-tools", callID: "call-1" }, { args: { x: 1 } });
    await after({ tool: "synthetic-tool", sessionID: "session-tools", callID: "call-1", args: { x: 1 } }, undefined as never);
    await after(
      { tool: "synthetic-tool", sessionID: "session-tools", callID: "call-2", args: { x: 2 } },
      { title: "normal", output: "normal tool text", metadata: {} },
    );
    await after(
      { tool: "synthetic-mcp", sessionID: "session-tools", callID: "call-3", args: { x: 3 } },
      { title: "mcp", output: [{ type: "text", text: "mcp tool text" }], metadata: {} } as never,
    );
    await before({ tool: "agent-mem_memory_recall", sessionID: "session-tools", callID: "own-call" }, { args: { query: "own" } });
    await after(
      { tool: "agent-mem_memory_recall", sessionID: "session-tools", callID: "own-call", args: { query: "own" } },
      { title: "own mcp", output: [{ type: "text", text: "own memory output" }], metadata: {} } as never,
    );
    await complete({ sessionID: "session-tools", messageID: "message-1", partID: "part-1" }, { text: "assistant output" });
    const toolResult = bridge.captures.find((event) => event.stage === "tool_result");
    assert.equal(toolResult?.outcome, "unknown");
    assert.deepEqual(toolResult?.coverage, { status: "coverage_gap", reason: "event_not_observed" });
    assert.equal(bridge.captures.find((event) => event.native_ids?.tool_call_id === "call-2")?.text, "normal tool text");
    assert.equal(bridge.captures.find((event) => event.native_ids?.tool_call_id === "call-3")?.text, "mcp tool text");
    assert.equal(bridge.captures.some((event) => event.native_ids?.tool_call_id === "own-call"), false);
    const part = bridge.captures.find((event) => event.stage === "message_part");
    assert.equal(part?.role, "assistant");
    assert.equal(part?.evidence_class, "assistant_output");
    assert.equal(part?.stage, "message_part");
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});

test("v1 entrypoint exposes the current loader object and accepts supplied options", async () => {
  const module = await import("../adapters/opencode/plugin.js");
  const entry = module.default as unknown as {
    readonly id: string;
    readonly server: (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  };
  const configValue = config();
  try {
    assert.deepEqual(Object.keys(module), ["default"]);
    assert.equal(entry.id, "agent-mem");
    assert.equal(typeof entry.server, "function");
    const hooks = await entry.server(
      { directory: configValue.workspaceDirectory },
      {
        version: 1,
        native_version: OPENCODE_NATIVE_VERSION,
        node_path: process.execPath,
        bridge_path: bridgePath,
        config_path: configValue.configPath,
      },
    );
    assert.equal(typeof hooks["chat.message"], "function");
  } finally {
    rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
  }
});


test("dispose fences every late hook and drains admitted chat, tool and general event captures", async (t) => {
  for (const kind of ["chat", "tool", "event"] as const) await t.test(kind, async () => {
    const setup = config();
    const bridge = new FakeBridge();
    const runtime = new OpenCodePluginRuntime(setup, { bridgeFactory: () => bridge });
    const hooks = runtime.hooks();
    const message = userMessage("shutdown-session", "before-close", "synthetic capture");
    const held = bridge.holdNextCapture();
    const admitted = kind === "chat" ? captureChatMessage(hooks, message)
      : kind === "tool" ? hooks["tool.execute.after"]!({ sessionID: "shutdown-session", tool: "synthetic", callID: "call-before-close", args: {} }, { title: "done", output: "synthetic output", metadata: {} })
      : hooks.event!({ event: { type: "session.idle", properties: { sessionID: "shutdown-session" } } });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(bridge.captures.length, 1);
      const disposing = runtime.dispose();
      assert.equal(runtime.dispose(), disposing, "shutdown is idempotent");
      let finished = false;
      void disposing.then(() => { finished = true; });
      await captureChatMessage(hooks, userMessage("late", "late", "must not capture"));
      await hooks["tool.execute.before"]!({ sessionID: "late", tool: "synthetic", callID: "late" }, { args: {} });
      await hooks["tool.execute.after"]!({ sessionID: "late", tool: "synthetic", callID: "late", args: {} }, { title: "late", output: "late", metadata: {} });
      await hooks["experimental.text.complete"]!({ sessionID: "late", messageID: "late", partID: "late" }, { text: "late" });
      await hooks["experimental.session.compacting"]!({ sessionID: "late" }, { context: [] });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "late" } } });
      const output = { messages: [message] };
      await transformHook(hooks)({}, output);
      assert.equal(output.messages[0]!.parts.length, 1);
      assert.equal(bridge.recalls.length, 0);
      assert.equal(bridge.captures.length, 1);
      assert.equal(bridge.closeCalls, 0);
      assert.equal(finished, false);
      bridge.releaseCapture();
      await held;
      await admitted;
      await disposing;
      assert.equal(bridge.closeCalls, 1);
      await captureChatMessage(hooks, message);
      assert.equal(bridge.captures.length, 1);
    } finally { bridge.releaseCapture(); await runtime.dispose(); rmSync(setup.workspaceDirectory, { recursive: true, force: true }); }
  });
});

test("dispose bounds a stalled capture by the existing hook deadline and prevents late reopen", async (t) => {
  const setup = { ...config(), hookTimeoutMs: 100 };
  const bridge = new FakeBridge();
  let releaseOpen!: () => void;
  t.mock.method(bridge, "openSession", () => new Promise<void>((resolve) => { releaseOpen = resolve; }));
  const runtime = new OpenCodePluginRuntime(setup, { bridgeFactory: () => bridge });
  const hooks = runtime.hooks();
  const admitted = captureChatMessage(hooks, userMessage("held-open", "before-close", "synthetic"));
  try {
    const started = performance.now();
    await runtime.dispose();
    assert.ok(performance.now() - started < 1_000);
    assert.equal(bridge.closeCalls, 1);
    releaseOpen();
    await admitted;
    assert.equal(bridge.captures.length, 0, "late session open cannot dispatch after helper close");
  } finally { releaseOpen(); await runtime.dispose(); rmSync(setup.workspaceDirectory, { recursive: true, force: true }); }
});

test("a recall resolving after dispose starts never mutates native messages", async () => {
  const setup = config();
  const bridge = new FakeBridge();
  const runtime = new OpenCodePluginRuntime(setup, { bridgeFactory: () => bridge });
  const hooks = runtime.hooks();
  const message = userMessage("recall-shutdown", "message", "synthetic prompt");
  try {
    await captureChatMessage(hooks, message);
    bridge.holdNextRecall();
    const output = { messages: [message] };
    const transforming = transformHook(hooks)({}, output);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(bridge.recalls.length, 1);
    const disposing = runtime.dispose();
    bridge.releaseRecall();
    await Promise.all([transforming, disposing]);
    assert.equal(message.parts.length, 1);
    assert.equal(bridge.closeCalls, 1);
  } finally { bridge.releaseRecall(); await runtime.dispose(); rmSync(setup.workspaceDirectory, { recursive: true, force: true }); }
});
test("OpenCode session status reflects the live broker on the first session context", async () => {
 const bridge = new FakeBridge();
 bridge.backendStatus = { state: "core_ready", embedding: { state: "ready" }, intelligence: { reranker: { state: "disabled" } } };
 const configValue = config();
 try {
  const hooks = createOpenCodeHooks(configValue, { bridgeFactory: () => bridge });
  const messages = [userMessage("session-status", "message-status", "status prompt")];
  await captureChatMessage(hooks, messages[0] as MessageWithParts);
  await transformHook(hooks)({}, { messages });
  const synthetic = (messages[0]?.parts ?? []).find((part): part is TextPart => part.type === "text" && part.synthetic === true);
  assert.ok(synthetic);
  assert.equal(parseModelContextWrapper(synthetic.text).status, "Agent Mem: connected\nHost: OpenCode CLI\nCore: ready · E5: ready · Reranker: disabled\nMCP: verified");
  assert.equal(bridge.statusCalls, 1);
 } finally {
  rmSync(configValue.workspaceDirectory, { recursive: true, force: true });
 }
});
