import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CODEX_PROMPT_MAX_BYTES,
  CodexHostAdapter,
  captureWithRetry,
  createCodexAdapterConfig,
  renderCodexHookCommand,
  resolveProjectScope,
  type CodexBrokerClient,
} from "../adapters/codex/index.js";
import { parseModelContextWrapper } from "../src/context/packet.js";
import {
  createTrustedBinding,
  createNativeSessionBinding,
  parseEvidencePacket,
  type CaptureAck,
  type TrustedBinding,
} from "../src/host/contract.js";
import { normalizeNativeEvent, type NormalizedNativeEvent } from "../src/host/events.js";
import {
  readBoundedStream,
  runBoundedCommandHook,
} from "../src/host/command-hook.js";
import { AgentMemoryBroker, AgentMemoryBrokerClient, BrokerError } from "../src/host/broker.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "12121212-1212-4121-8121-121212121212";
const bindingId = "abababab-abab-4aba-8aba-abababababab";
const setupId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const sources = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

interface Fixture {
  readonly dir: string;
  readonly projectDir: string;
  readonly outsideDir: string;
  readonly db: AgentMemoryDatabase;
  readonly broker: AgentMemoryBroker;
  readonly config: ReturnType<typeof createCodexAdapterConfig>;
  readonly binding: TrustedBinding;
}

function bindingFor(surface: "codex_cli" | "codex_desktop" = "codex_cli"): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface,
    execution_domain: { kind: "local", id: "local-test" },
    host_instance_id: "codex-installation-test",
    host_session_id: "installation-session",
    allowed_scope_ids: [scopeId],
    egress: {
      reader_targets: ["reader:" + surface],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function fixtureInput(
  binding: TrustedBinding,
  projectDir: string,
  runtimeDir: string,
  surface: "codex_cli" | "codex_desktop" = "codex_cli",
): Record<string, unknown> {
  return {
    version: 1,
    socket_path: join(runtimeDir, "broker.sock"),
    surface,
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
    session_start_query: "recent project context",
    adapter_version: "1.0.0",
  };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-codex-host-"));
  const projectDir = join(dir, "project");
  const outsideDir = join(dir, "outside");
  privateDirectory(projectDir);
  privateDirectory(outsideDir);
  const runtimeDir = join(dir, "runtime");
  privateDirectory(runtimeDir);
  const db = new AgentMemoryDatabase(join(dir, "vault.sqlite"));
  const binding = bindingFor();
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:codex_cli"],
  });
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "codex-host-test", created_at: "2026-09-07T20:00:00Z" });
  setScopeOutputGrants(
    db,
    policy,
    scopeId,
    [{ target: "reader:codex_cli", source_classes: [...sources] }],
    "2026-09-07T20:00:01Z",
  );
  const broker = new AgentMemoryBroker({
    database: db,
    runtimeDirectory: runtimeDir,
    credentials: [{ binding, secret, allowNativeSessions: true }],
  });
  await broker.start();
  return { dir, projectDir, outsideDir, db, broker, config: createCodexAdapterConfig(fixtureInput(binding, projectDir, runtimeDir)), binding };
}

async function cleanup(fixture: Fixture, adapter?: CodexHostAdapter): Promise<void> {
  await adapter?.close();
  await fixture.broker.stop();
  if (!fixture.db.isClosed()) fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function hook(
  base: Record<string, unknown>,
  event: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { session_id: "native-session-a", cwd: "/does/not/matter", hook_event_name: event, ...base, ...extra };
}

function withCwd(value: Record<string, unknown>, cwd: string): Record<string, unknown> {
  return { ...value, cwd };
}

test("maps SessionStart, prompt, tool, compact and Stop with capture before recall", async () => {
  const fixture = await setup();
  const adapter = new CodexHostAdapter(fixture.config);
  try {
    const start = await adapter.handleHook(
      withCwd(hook({}, "SessionStart", { source: "startup" }), fixture.projectDir),
    );
    assert.equal(start.status, "completed");
    assert.equal(start.event?.event.stage, "session_start");
    assert.equal(start.captureAck?.capture_id, start.event?.capture_id);
    assert.equal(start.response.hookSpecificOutput?.hookEventName, "SessionStart");

    const prompt = await adapter.handleHook(
      withCwd(
        hook({}, "UserPromptSubmit", { turn_id: "turn-a", prompt: "Remember the release window 🦄" }),
        fixture.projectDir,
      ),
    );
    assert.equal(prompt.status, "completed");
    assert.equal(prompt.event?.event.stage, "prompt_submitted");
    assert.equal(prompt.event?.event.text, "Remember the release window 🦄");
    const additionalContext = prompt.response.hookSpecificOutput?.additionalContext;
    assert.ok(additionalContext);
    assert.ok(Buffer.byteLength(additionalContext, "utf8") <= CODEX_PROMPT_MAX_BYTES);
    assert.equal(parseModelContextWrapper(additionalContext).kind, "agent_memory_context");

    const tool = await adapter.handleHook(
      withCwd(
        hook({}, "PostToolUse", {
          turn_id: "turn-a",
          tool_use_id: "tool-a",
          tool_name: "Bash",
          tool_input: { command: "printf synthetic" },
          tool_response: { stdout: "synthetic", exit_code: 0 },
        }),
        fixture.projectDir,
      ),
    );
    assert.equal(tool.status, "completed");
    assert.equal(tool.event?.event.stage, "tool_result");
    assert.equal(tool.event?.event.outcome, "unknown");
    assert.equal(tool.response.hookSpecificOutput, undefined);

    const compact = await adapter.handleHook(
      withCwd(hook({}, "SessionStart", { source: "compact" }), fixture.projectDir),
    );
    assert.equal(compact.status, "completed");
    assert.equal(compact.event?.event.stage, "compaction");
    assert.equal(compact.response.hookSpecificOutput?.hookEventName, "SessionStart");
    const compactAgain = await adapter.handleHook(
      withCwd(hook({}, "SessionStart", { source: "compact" }), fixture.projectDir),
    );
    assert.equal(compactAgain.status, "completed");
    assert.notEqual(compactAgain.event?.capture_id, compact.event?.capture_id);

    const resume = await adapter.handleHook(
      withCwd(hook({}, "SessionStart", { source: "resume" }), fixture.projectDir),
    );
    const resumeAgain = await adapter.handleHook(
      withCwd(hook({}, "SessionStart", { source: "resume" }), fixture.projectDir),
    );
    assert.equal(resume.status, "completed");
    assert.equal(resumeAgain.status, "completed");
    assert.notEqual(resumeAgain.event?.capture_id, resume.event?.capture_id);

    const preCompact = await adapter.handleHook(
      withCwd(hook({}, "PreCompact", { turn_id: "turn-a", trigger: "auto" }), fixture.projectDir),
    );
    const postCompact = await adapter.handleHook(
      withCwd(hook({}, "PostCompact", { turn_id: "turn-a" }), fixture.projectDir),
    );
    assert.equal(preCompact.status, "completed");
    assert.equal(preCompact.event?.event.stage, "compaction");
    assert.equal(postCompact.status, "completed");
    assert.equal(postCompact.event?.event.stage, "compaction");

    const stop = await adapter.handleHook(
      withCwd(
        hook({}, "Stop", { turn_id: "turn-a", stop_hook_active: false, last_assistant_message: null }),
        fixture.projectDir,
      ),
    );
    assert.equal(stop.status, "completed");
    assert.equal(stop.event?.event.stage, "stop");
    assert.equal(stop.event?.event.text, undefined);
    assert.deepEqual(stop.coverage, { status: "coverage_gap", reason: "event_not_observed" });
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("attributes final Codex text to the assistant and excludes only own memory tool results", async () => {
  const fixture = await setup();
  const adapter = new CodexHostAdapter(fixture.config);
  try {
    const stopped = await adapter.handleHook(withCwd(hook({}, "Stop", {
      turn_id: "final-role", last_assistant_message: "The migration still needs review.",
    }), fixture.projectDir));
    assert.equal(stopped.event?.event.stage, "assistant_final");
    assert.equal(stopped.event?.event.role, "assistant");
    assert.equal(stopped.event?.event.evidence_class, "assistant_output");
    for (const name of ["memory_recall", "memory_get", "memory_forget", "memory_write"]) {
      const own = await adapter.handleHook(withCwd(hook({}, "PostToolUse", {
        turn_id: "memory-echo", tool_call_id: name, tool_name: `mcp__agent_memory_v1__${name}`,
        tool_response: { text: "retrieved prior evidence" },
      }), fixture.projectDir));
      assert.equal(own.status, "completed");
      assert.equal(own.captureAck, undefined);
      assert.equal(own.event, undefined);
    }
    const other = await adapter.handleHook(withCwd(hook({}, "PostToolUse", {
      turn_id: "ordinary-tool", tool_call_id: "read", tool_name: "read_file",
      tool_response: { text: "mcp__agent_memory_v1__memory_recall appears in a file" },
    }), fixture.projectDir));
    assert.equal(other.event?.event.stage, "tool_result");
  } finally { await cleanup(fixture, adapter); }
});

test("uses exact persisted wrapper recognition and never suppresses a substring echo", async () => {
  const fixture = await setup();
  const adapter = new CodexHostAdapter(fixture.config);
  try {
    const prompt = await adapter.handleHook(
      withCwd(hook({}, "UserPromptSubmit", { turn_id: "turn-context", prompt: "context seed" }), fixture.projectDir),
    );
    const wrapper = prompt.response.hookSpecificOutput?.additionalContext;
    assert.ok(wrapper);
    const before = fixture.db.getCounts().source_count;
    const recognized = await adapter.handleHook(
      withCwd(hook({}, "UserPromptSubmit", { turn_id: "turn-echo", prompt: wrapper }), fixture.projectDir),
    );
    assert.equal(recognized.status, "completed");
    assert.equal(recognized.recognizedOwnContext, true);
    assert.equal(fixture.db.getCounts().source_count, before);

    const substring = await adapter.handleHook(
      withCwd(
        hook({}, "UserPromptSubmit", { turn_id: "turn-substring", prompt: "prefix " + wrapper + " suffix" }),
        fixture.projectDir,
      ),
    );
    assert.equal(substring.status, "completed");
    assert.equal(substring.recognizedOwnContext, undefined);
    assert.equal(fixture.db.getCounts().source_count, before + 1n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("routes only configured canonical workspace scope and ignores event scope suggestions", async () => {
  const fixture = await setup();
  const adapter = new CodexHostAdapter(fixture.config);
  try {
    const outside = await adapter.handleHook(
      withCwd(hook({}, "UserPromptSubmit", { turn_id: "turn-outside", prompt: "outside" }), fixture.outsideDir),
    );
    assert.equal(outside.status, "degraded");
    assert.equal(fixture.db.getCounts().source_count, 0n);

    const suggestedScope = await adapter.handleHook(
      withCwd(
        hook({ scope_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, "UserPromptSubmit", {
          turn_id: "turn-fixed-scope",
          prompt: "scope remains configured",
        }),
        fixture.projectDir,
      ),
    );
    assert.equal(suggestedScope.status, "completed");
    assert.equal(suggestedScope.event?.scope_id, scopeId);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("supports two native sessions and reconnects with the same registered session identities", async () => {
  const fixture = await setup();
  const adapter = new CodexHostAdapter(fixture.config);
  try {
    const results = await Promise.all([
      adapter.handleHook(
        withCwd(
          hook({ session_id: "native-a" }, "UserPromptSubmit", { turn_id: "turn-a", prompt: "alpha" }),
          fixture.projectDir,
        ),
      ),
      adapter.handleHook(
        withCwd(
          hook({ session_id: "native-b" }, "UserPromptSubmit", { turn_id: "turn-b", prompt: "beta" }),
          fixture.projectDir,
        ),
      ),
    ]);
    const first = results[0];
    const second = results[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(first.event?.event.native_ids.session_id, second.event?.event.native_ids.session_id);

    await fixture.broker.stop();
    await fixture.broker.start();
    const resumed = await adapter.handleHook(
      withCwd(
        hook({ session_id: "native-a" }, "UserPromptSubmit", { turn_id: "turn-a2", prompt: "after broker restart" }),
        fixture.projectDir,
      ),
    );
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.event?.event.stage, "prompt_submitted");
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("rejects outside route, cross-surface binding, and ambiguous route setup", async () => {
  const fixture = await setup();
  try {
    assert.throws(
      () => createCodexAdapterConfig(fixtureInput(bindingFor("codex_desktop"), fixture.projectDir, join(fixture.dir, "runtime"), "codex_cli")),
      /binding_surface_mismatch/,
    );
    assert.throws(
      () => resolveProjectScope(fixture.outsideDir, [{ scope_id: scopeId, workspace_roots: [fixture.projectDir] }]),
      /cwd_outside_configured_workspace/,
    );
    assert.throws(
      () =>
        resolveProjectScope(fixture.projectDir, [
          { scope_id: scopeId, workspace_roots: [fixture.projectDir] },
          { scope_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", workspace_roots: [fixture.projectDir] },
        ]),
      /cwd_route_ambiguous/,
    );
  } finally {
    await cleanup(fixture);
  }
});

test("retries a transport loss with the exact immutable event envelope", async () => {
  const binding = bindingFor();
  const event = normalizeNativeEvent(
    {
      version: 1,
      capture_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      scope_id: scopeId,
      adapter_version: "1.0.0",
      stage: "prompt_submitted",
      native_ids: { session_id: "native-retry", turn_id: "turn-retry" },
      text: "retry",
      payload: { prompt: "retry" },
      captured_at: "2026-09-07T20:00:00Z",
      truncation: { truncated: false },
      coverage: { status: "complete" },
      correlation: { status: "correlated", basis: "native_ids", key: "retry" },
    },
    binding,
  );
  const seen: NormalizedNativeEvent[] = [];
  const ack: CaptureAck = {
    version: 1,
    capture_id: event.capture_id,
    commit_seq: "1",
    coverage: { status: "complete", stages: ["prompt_submitted"], truncated: false },
  };
  const fake: CodexBrokerClient = {
    connectedBinding: binding,
    registeredSessionIds: new Map([[scopeId, randomUUID()]]),
    connect: async () => undefined,
    capture: async (candidate) => {
      seen.push(candidate as NormalizedNativeEvent);
      if (seen.length === 1) throw new BrokerError("transport_closed");
      return ack;
    },
    recall: async () => {
      throw new Error("unused");
    },
    recognizeContext: async () => false,
    close: async () => undefined,
  };
  const result = await captureWithRetry(fake, event);
  assert.equal(result.capture_id, event.capture_id);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(seen[1], event);
});

test("sends the strict preparation DTO only after the capture ACK", async () => {
  const fixture = await setup();
  const calls: string[] = [];
  let preparationInput: unknown;
  const effectiveBinding = createNativeSessionBinding(fixture.binding, "native-order");
  const ack: CaptureAck = {
    version: 1,
    capture_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    commit_seq: "1",
    coverage: { status: "complete", stages: ["prompt_submitted"], truncated: false },
  };
  const packet = parseEvidencePacket({
    version: 1,
    query_id: randomUUID(),
    watermark: "0",
    data_epoch: "0",
    privacy_epoch: "0",
    valid_until: "2026-09-07T20:30:00Z",
    items: [],
    tokens: { used: 0, budget: 1_500, unit: "utf8_bytes" },
    mode: "degraded",
    known_at_seq: "0",
    scope_epochs: [{ scope_id: scopeId, data_epoch: "0", privacy_epoch: "0" }],
    diagnostics: [{ code: "no_match" }],
    delivery: { format: "agent_memory_evidence_v1", injection_id: randomUUID() },
  });
  const fake: CodexBrokerClient = {
    connectedBinding: effectiveBinding,
    registeredSessionIds: new Map([[scopeId, randomUUID()]]),
    connect: async () => {
      calls.push("connect");
    },
    capture: async () => {
      calls.push("capture");
      return ack;
    },
    recall: async (_request, context) => {
      calls.push("recall");
      preparationInput = context;
      return packet;
    },
    recognizeContext: async () => false,
    close: async () => undefined,
  };
  const adapter = new CodexHostAdapter(fixture.config, { clientFactory: () => fake });
  try {
    const result = await adapter.handleHook(
      withCwd(
        hook({ session_id: "native-order" }, "UserPromptSubmit", { turn_id: "turn-order", prompt: "ordered" }),
        fixture.projectDir,
      ),
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["connect", "capture", "recall"]);
    assert.ok(preparationInput);
    assert.deepEqual(Object.keys(preparationInput as object).sort(), ["budget", "capture_status", "deadline_at", "exclude_current_session_prompts", "kind", "version"]);
    assert.equal(Reflect.get(preparationInput as object, "exclude_current_session_prompts"), true);
    assert.deepEqual(Reflect.get(preparationInput as object, "budget").profile, { unit: "utf8_bytes", limit: 8_000 });
    assert.equal(Object.hasOwn(preparationInput as object, "binding_id"), false);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("reconnects after a lost real-broker ACK and replays the same durable capture", async () => {
  const fixture = await setup();
  let captureCalls = 0;
  const adapter = new CodexHostAdapter(fixture.config, {
    clientFactory: (options) => {
      const real = new AgentMemoryBrokerClient(options);
      return {
        get connectedBinding() {
          return real.connectedBinding;
        },
        get registeredSessionIds() {
          return real.registeredSessionIds;
        },
        connect: () => real.connect(),
        async capture(event) {
          captureCalls += 1;
          const ack = await real.capture(event);
          if (captureCalls === 1) {
            await real.close();
            throw new BrokerError("transport_closed");
          }
          return ack;
        },
        recall: (request, context) => real.recall(request, context),
        recognizeContext: (context) => real.recognizeContext(context),
        close: () => real.close(),
      };
    },
  });
  try {
    const result = await adapter.handleHook(
      withCwd(
        hook({ session_id: "native-ack-loss" }, "PostToolUse", {
          turn_id: "turn-ack-loss",
          tool_use_id: "tool-ack-loss",
          tool_name: "Bash",
          tool_response: "durable before simulated ACK loss",
        }),
        fixture.projectDir,
      ),
    );
    assert.equal(result.status, "completed");
    assert.equal(captureCalls, 2);
    assert.equal(fixture.db.getCounts().source_count, 1n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("bounds a nonterminating native stdin stream and emits no late success output", async () => {
  const stream = new PassThrough();
  let fallbackWrites = 0;
  let successWrites = 0;
  let cleaned = false;
  const started = Date.now();
  await runBoundedCommandHook({
    timeoutMs: 40,
    readInput: (deadline) => readBoundedStream(stream, deadline, 128, { destroyOnFailure: true }),
    handle: async () => ({ ok: true }),
    cleanup: async () => {
      cleaned = true;
    },
    writeOutput: () => {
      successWrites += 1;
    },
    writeFallback: () => {
      fallbackWrites += 1;
    },
  });
  stream.destroy();
  assert.ok(Date.now() - started < 500);
  assert.equal(cleaned, true);
  assert.equal(stream.destroyed, true);
  assert.equal(successWrites, 0);
  assert.equal(fallbackWrites, 1);
});

test("bounds slow connect and capture without allowing a late packet", async () => {
  const fixture = await setup();
  const input = JSON.stringify(
    withCwd(hook({ session_id: "native-slow" }, "SessionStart", { source: "startup" }), fixture.projectDir),
  );
  for (const mode of ["connect", "capture"] as const) {
    let cleaned = false;
    let successWrites = 0;
    let fallbackWrites = 0;
    const effectiveBinding = createNativeSessionBinding(fixture.binding, "native-slow");
    const fake: CodexBrokerClient = {
      connectedBinding: effectiveBinding,
      registeredSessionIds: new Map([[scopeId, randomUUID()]]),
      connect: mode === "connect" ? () => new Promise<void>(() => undefined) : async () => undefined,
      capture: mode === "capture" ? () => new Promise<CaptureAck>(() => undefined) : async () => ({
        version: 1,
        capture_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        commit_seq: "1",
        coverage: { status: "complete", stages: ["session_start"], truncated: false },
      }),
      recall: async () => {
        throw new Error("unused");
      },
      recognizeContext: async () => false,
      close: async () => {
        cleaned = true;
      },
    };
    const adapter = new CodexHostAdapter(fixture.config, { clientFactory: () => fake });
    await runBoundedCommandHook({
      timeoutMs: 40,
      readInput: async () => input,
      handle: async (text, deadline) => adapter.handleHook(JSON.parse(text) as unknown, deadline),
      cleanup: () => adapter.close(),
      writeOutput: () => {
        successWrites += 1;
      },
      writeFallback: () => {
        fallbackWrites += 1;
      },
    });
    assert.equal(cleaned, true);
    assert.equal(successWrites, 0);
    assert.equal(fallbackWrites, 1);
  }
  await cleanup(fixture);
});

test("does not write a successful result after cleanup crosses the hook deadline", async () => {
  let successWrites = 0;
  let fallbackWrites = 0;
  const started = Date.now();
  let successAt: number | undefined;
  await runBoundedCommandHook({
    timeoutMs: 30,
    readInput: async () => "synthetic",
    handle: async () => {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
      return { ok: true };
    },
    cleanup: async () => {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    },
    writeOutput: () => {
      successWrites += 1;
      successAt = Date.now();
    },
    writeFallback: () => {
      fallbackWrites += 1;
    },
  });
  assert.equal(successWrites, 1);
  assert.ok(successAt !== undefined && successAt - started < 30);
  assert.equal(fallbackWrites, 0);
});

test("does not reconnect or capture after retry cancellation", async () => {
  const controller = new AbortController();
  let connectCalls = 0;
  let captureCalls = 0;
  let closeCalls = 0;
  const fake: CodexBrokerClient = {
    connectedBinding: createNativeSessionBinding(bindingFor(), "native-cancelled-retry"),
    registeredSessionIds: new Map([[scopeId, randomUUID()]]),
    connect: async () => {
      connectCalls += 1;
    },
    capture: async () => {
      captureCalls += 1;
      return new Promise<CaptureAck>(() => undefined);
    },
    recall: async () => {
      throw new Error("unused");
    },
    recognizeContext: async () => false,
    close: async () => {
      closeCalls += 1;
    },
  };
  const event = normalizeNativeEvent(
    {
      version: 1,
      capture_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      scope_id: scopeId,
      adapter_version: "1.0.0",
      stage: "prompt_submitted",
      native_ids: { session_id: "native-cancelled-retry", turn_id: "turn-cancelled-retry" },
      text: "cancelled",
      payload: { prompt: "cancelled" },
      captured_at: "2026-09-07T20:00:00Z",
      truncation: { truncated: false },
      coverage: { status: "complete" },
      correlation: { status: "correlation_unknown", reason: "not_resolved" },
    },
    bindingFor(),
  );
  const pending = captureWithRetry(fake, event, { signal: controller.signal, onAbort: () => fake.close() });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /command_hook_timeout/);
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 40));
  assert.equal(connectCalls, 0);
  assert.equal(captureCalls, 1);
  assert.equal(closeCalls, 1);
});

test("renders only explicitly verified absolute helper paths with shell-safe quoting", async () => {
  const fixture = await setup();
  try {
    const configPath = join(fixture.dir, "codex config.json");
    const helperPath = fileURLToPath(new URL("../adapters/codex/index.js", import.meta.url));
    const command = renderCodexHookCommand({
      nodePath: process.execPath,
      helperPath,
      configPath,
    });
    assert.equal(command, "'" + process.execPath + "' '" + helperPath + "' --config '" + configPath.replaceAll("'", "'\\''") + "'");
    assert.throws(
      () => renderCodexHookCommand({ nodePath: "node", helperPath, configPath: "/tmp/config.json" }),
      /node_path_must_be_absolute/,
    );
  } finally {
    await cleanup(fixture);
  }
});

test("executes the compiled helper with native JSON stdin/stdout against a real broker", async () => {
  const fixture = await setup();
  try {
    const configPath = join(fixture.dir, "codex config.json");
    writeFileSync(configPath, JSON.stringify(fixtureInput(fixture.binding, fixture.projectDir, join(fixture.dir, "runtime"))));
    const helperPath = fileURLToPath(new URL("../adapters/codex/index.js", import.meta.url));
    const input = JSON.stringify(
      withCwd(
        hook({ session_id: "native-helper" }, "PostToolUse", {
          turn_id: "turn-helper",
          tool_use_id: "tool-helper",
          tool_name: "Bash",
          tool_response: "synthetic helper response",
        }),
        fixture.projectDir,
      ),
    );
    const child = spawn(process.execPath, [helperPath, "--config", configPath], {
      cwd: fixture.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.stdin.end(input);
    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", resolveExit);
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), {});
    assert.equal(Buffer.concat(stderr).toString("utf8"), "");
    assert.equal(fixture.db.getCounts().source_count, 1n);
  } finally {
    await cleanup(fixture);
  }
});

test("the helper exits naturally when its stdin pipe remains open past the deadline", async () => {
  const fixture = await setup();
  try {
    const configPath = join(fixture.dir, "codex timeout config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ ...fixtureInput(fixture.binding, fixture.projectDir, join(fixture.dir, "runtime")), hook_timeout_ms: 100 }),
    );
    const helperPath = fileURLToPath(new URL("../adapters/codex/index.js", import.meta.url));
    const child = spawn(process.execPath, [helperPath, "--config", configPath], {
      cwd: fixture.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolveClose({ code, signal }));
    });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolveTimeout) => {
      timeoutTimer = setTimeout(() => resolveTimeout(undefined), 1_000);
    });
    const result = await Promise.race([closed, timeout]);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (result === undefined) {
      child.kill("SIGKILL");
      await closed;
      assert.fail("helper did not exit naturally after stdin deadline");
    }
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    const response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { continue?: boolean };
    assert.equal(response.continue, true);
  } finally {
    await cleanup(fixture);
  }
});
