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
  COPILOT_CLI_ADAPTER_VERSION,
  COPILOT_CLI_PROMPT_MAX_BYTES,
  COPILOT_CLI_VERSION,
  CopilotCliHostAdapter,
  createCopilotCliAdapterConfig,
  renderCopilotCliHookEntry,
  renderCopilotCliHookFile,
  resolveProjectScope,
  type CopilotCliBrokerClient,
  type CopilotCliEventName,
} from "../adapters/copilot-cli/index.js";
import { parseModelContextWrapper, type EvidenceContextWrapper } from "../src/context/packet.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import {
  createNativeSessionBinding,
  createTrustedBinding,
  parseEvidencePacket,
  type CaptureAck,
  type EvidencePacket,
  type TrustedBinding,
} from "../src/host/contract.js";
import { normalizeNativeEvent, type NormalizedNativeEvent } from "../src/host/events.js";
import { AgentMemoryBroker, BrokerError } from "../src/host/broker.js";
import { captureWithImmutableRetry, readBoundedStream, runBoundedCommandHook } from "../src/host/command-hook.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

function eventText(event: NormalizedNativeEvent | undefined): unknown {
  return (event?.event as { text?: unknown } | undefined)?.text;
}

const scopeId = "41414141-4141-4141-8141-414141414141";
const bindingId = "42424242-4242-4242-8242-424242424242";
const setupId = "43434343-4343-4343-8343-434343434343";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const sourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;
const TIMESTAMP_MS = 1757208002000;

interface Fixture {
  readonly dir: string;
  readonly projectDir: string;
  readonly outsideDir: string;
  readonly db: AgentMemoryDatabase;
  readonly broker: AgentMemoryBroker;
  readonly config: ReturnType<typeof createCopilotCliAdapterConfig>;
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
    host_kind: "copilot",
    surface: "copilot_cli",
    execution_domain: { kind: "local", id: "copilot-cli-test" },
    host_instance_id: "copilot-installation-test",
    host_session_id: "installation-session",
    allowed_scope_ids: [scopeId],
    egress: {
      reader_targets: ["reader:copilot_cli"],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function bindingInput(binding: TrustedBinding): Record<string, unknown> {
  return {
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
  };
}

function fixtureInput(binding: TrustedBinding, projectDir: string, runtimeDir: string): Record<string, unknown> {
  return {
    version: 1,
    cli_version: COPILOT_CLI_VERSION,
    socket_path: join(runtimeDir, "broker.sock"),
    surface: "copilot_cli",
    binding: bindingInput(binding),
    broker_secret_hex: secret.toString("hex"),
    projects: [{ scope_id: scopeId, workspace_roots: [projectDir] }],
    session_start_query: "recent project context",
    adapter_version: COPILOT_CLI_ADAPTER_VERSION,
  };
}

async function setup(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "am-copilot-cli-"));
  const projectDir = join(dir, "project");
  const outsideDir = join(dir, "outside");
  const runtimeDir = join(dir, "runtime");
  privateDirectory(projectDir);
  privateDirectory(outsideDir);
  privateDirectory(runtimeDir);
  const db = new AgentMemoryDatabase(join(dir, "vault.sqlite"));
  const binding = bindingFor();
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:copilot_cli"],
  });
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "copilot-cli-hook-test", created_at: "2026-09-07T20:00:00Z" });
  setScopeOutputGrants(db, policy, scopeId, [{ target: "reader:copilot_cli", source_classes: [...sourceClasses] }], "2026-09-07T20:00:01Z");
  const broker = new AgentMemoryBroker({
    database: db,
    runtimeDirectory: runtimeDir,
    credentials: [{ binding, secret, allowNativeSessions: true }],
  });
  await broker.start();
  return { dir, projectDir, outsideDir, db, broker, binding, config: createCopilotCliAdapterConfig(fixtureInput(binding, projectDir, runtimeDir)) };
}

async function cleanup(fixture: Fixture, adapter?: CopilotCliHostAdapter): Promise<void> {
  await adapter?.close();
  await fixture.broker.stop();
  if (!fixture.db.isClosed()) fixture.db.close();
  rmSync(fixture.dir, { recursive: true, force: true });
}

function hookInput(event: CopilotCliEventName, projectDir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "native-cli-session",
    timestamp: TIMESTAMP_MS,
    cwd: projectDir,
    ...extra,
  };
}

function suffixWrapper(modified: string, prefix: string): EvidenceContextWrapper {
  assert.ok(modified.startsWith(prefix));
  const suffix = modified.slice(prefix.length);
  assert.ok(suffix.startsWith("\n\n"));
  return parseModelContextWrapper(suffix.slice(2));
}

test("pins the native CLI contract and renders ordinary version-1 exec/args hooks", async () => {
  const fixture = await setup();
  try {
    assert.equal(COPILOT_CLI_VERSION, "1.0.83");
    assert.equal(COPILOT_CLI_ADAPTER_VERSION, "1.0.0");
    assert.equal(COPILOT_CLI_PROMPT_MAX_BYTES, 64 * 1024);
    const configPath = join(fixture.dir, "cli config.json");
    const helperPath = fileURLToPath(new URL("../adapters/copilot-cli/index.js", import.meta.url));
    const entry = renderCopilotCliHookEntry({ nodePath: process.execPath, helperPath, configPath, event: "userPromptTransformed" });
    assert.equal(entry.type, "command");
    assert.equal(entry.type, "command");
    assert.equal(typeof entry.bash, "string");
    assert.equal(typeof entry.powershell, "string");
    assert.equal(entry.timeoutSec, 15);
    assert.match(entry.bash as string, /userPromptTransformed/);
    assert.match(entry.powershell as string, /userPromptTransformed/);
    const rendered = JSON.parse(renderCopilotCliHookFile({ nodePath: process.execPath, helperPath, configPath })) as {
      version: number;
      hooks: Record<string, unknown>;
    };
    assert.equal(rendered.version, 1);
    assert.deepEqual(Object.keys(rendered.hooks).sort(), [
      "agentStop",
      "postToolUse",
      "postToolUseFailure",
      "preCompact",
      "preToolUse",
      "sessionStart",
      "subagentStart",
      "subagentStop",
      "userPromptSubmitted",
      "userPromptTransformed",
    ].sort());
    assert.throws(() => renderCopilotCliHookEntry({ nodePath: "node", helperPath, configPath, event: "userPromptSubmitted" }), /node_path_must_be_absolute/);
    assert.throws(() => resolveProjectScope(process.cwd(), [
      { scope_id: scopeId, workspace_roots: [process.cwd()] },
      { scope_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", workspace_roots: [process.cwd()] },
    ]), /cwd_route_ambiguous/);
  } finally {
    await cleanup(fixture);
  }
});

test("captures submitted original with its own ACK and returns exactly {}", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const result = await adapter.handleHook(
      hookInput("userPromptSubmitted", fixture.projectDir, { prompt: "Remember the release window" }),
      "userPromptSubmitted",
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(result.response, {});
    assert.equal(result.event?.event.stage, "prompt_submitted");
    assert.equal(eventText(result.event), "Remember the release window");
    assert.equal(result.event?.event.provenance?.correlation.status, "correlation_unknown");
    assert.equal(result.captureAck?.capture_id, result.event?.capture_id);
    assert.equal(fixture.db.getCounts().source_count, 1n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("captures transformed with its own ACK and preserves native prefix in modifiedTransformedPrompt", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const submitted = await adapter.handleHook(
      hookInput("userPromptSubmitted", fixture.projectDir, { prompt: "original user text" }),
      "userPromptSubmitted",
    );
    const transformed = await adapter.handleHook(
      hookInput("userPromptTransformed", fixture.projectDir, {
        prompt: "original user text",
        transformedPrompt: "runtime-transformed model content",
      }),
      "userPromptTransformed",
    );
    assert.equal(submitted.status, "completed");
    assert.equal(transformed.status, "completed");
    assert.equal(transformed.event?.event.stage, "prompt_transformed");
    assert.equal(eventText(transformed.event), "runtime-transformed model content");
    assert.equal(transformed.event?.event.provenance?.correlation.status, "correlation_unknown");
    // Separate evidence: own capture IDs, own ACKs, no borrowed readiness.
    assert.notEqual(submitted.event?.capture_id, transformed.event?.capture_id);
    assert.notEqual(submitted.captureAck?.capture_id, transformed.captureAck?.capture_id);
    assert.equal(transformed.captureAck?.capture_id, transformed.event?.capture_id);
    const modified = (transformed.response as { modifiedTransformedPrompt?: unknown }).modifiedTransformedPrompt;
    assert.equal(typeof modified, "string");
    assert.ok((modified as string).startsWith("runtime-transformed model content"));
    const wrapper = suffixWrapper(modified as string, "runtime-transformed model content");
    assert.equal(wrapper.kind, "agent_memory_context");
    assert.equal(fixture.db.getCounts().source_count, 2n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("recognizes only exact owned context wrappers across native sessions", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    await adapter.handleHook(
        { ...hookInput("userPromptSubmitted", fixture.projectDir, { prompt: "current transformed prompt from prior session" }), sessionId: "native-cli-source" },
      "userPromptSubmitted",
    );
    const transformed = await adapter.handleHook(
      hookInput("userPromptTransformed", fixture.projectDir, {
        prompt: "current prompt",
        transformedPrompt: "current transformed prompt",
      }),
      "userPromptTransformed",
    );
    const modified = (transformed.response as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt;
    const wrapperText = modified.slice("current transformed prompt\n\n".length);
    assert.ok(parseModelContextWrapper(wrapperText).items.length > 0);
    assert.equal(fixture.db.getCounts().source_count, 2n);

    const sameSession = await adapter.handleHook(
      hookInput("userPromptSubmitted", fixture.projectDir, { prompt: wrapperText }),
      "userPromptSubmitted",
    );
    assert.equal(sameSession.recognizedOwnContext, true);
    assert.equal(sameSession.event, undefined);
    assert.equal(fixture.db.getCounts().source_count, 2n);

    const laterSession = await adapter.handleHook(
      { ...hookInput("userPromptSubmitted", fixture.projectDir, { prompt: wrapperText }), sessionId: "native-cli-later" },
      "userPromptSubmitted",
    );
    assert.equal(laterSession.recognizedOwnContext, true);
    assert.equal(laterSession.event, undefined);
    assert.equal(fixture.db.getCounts().source_count, 2n);

    const forged = JSON.parse(wrapperText) as Record<string, unknown>;
    forged.injection_id = randomUUID();
    const foreign = await adapter.handleHook(
      { ...hookInput("userPromptSubmitted", fixture.projectDir, { prompt: JSON.stringify(forged) }), sessionId: "native-cli-foreign" },
      "userPromptSubmitted",
    );
    assert.equal(foreign.recognizedOwnContext, undefined);
    assert.equal(foreign.event?.event.stage, "prompt_submitted");
    assert.equal(fixture.db.getCounts().source_count, 3n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("keeps repeat and batched transformed prompts as separate unknown-correlation evidence", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const first = await adapter.handleHook(
      hookInput("userPromptTransformed", fixture.projectDir, { prompt: "same", transformedPrompt: "same transformed" }),
      "userPromptTransformed",
    );
    const second = await adapter.handleHook(
      hookInput("userPromptTransformed", fixture.projectDir, { prompt: "same", transformedPrompt: "same transformed" }),
      "userPromptTransformed",
    );
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.notEqual(first.event?.capture_id, second.event?.capture_id);
    assert.notEqual(first.captureAck?.capture_id, second.captureAck?.capture_id);
    assert.equal(first.event?.event.provenance?.correlation.status, "correlation_unknown");
    assert.equal(second.event?.event.provenance?.correlation.status, "correlation_unknown");
    // Concurrent native sessions stay separate.
    const other = await adapter.handleHook(
      { sessionId: "native-cli-other", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "same", transformedPrompt: "same transformed" },
      "userPromptTransformed",
    );
    assert.equal(other.status, "completed");
    assert.notEqual(other.event?.capture_id, first.event?.capture_id);
    assert.equal(fixture.db.getCounts().source_count, 3n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("preserves foreign transformation exactly and never stores injected memory as user text", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const transformed = await adapter.handleHook(
      hookInput("userPromptTransformed", fixture.projectDir, {
        prompt: "original",
        transformedPrompt: "foreign-hook modified content 🦄 日本語",
      }),
      "userPromptTransformed",
    );
    assert.equal(transformed.status, "completed");
    assert.equal(eventText(transformed.event), "foreign-hook modified content 🦄 日本語");
    const modified = (transformed.response as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt;
    assert.ok(modified.startsWith("foreign-hook modified content 🦄 日本語"));
    assert.ok(!modified.startsWith("original\n\n"));
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("does not recapture Copilot's own memory MCP tools", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const result = await adapter.handleHook(
      hookInput("preToolUse", fixture.projectDir, { toolName: "agent_mem/memory_recall", toolArgs: { query: "prior work" } }),
      "preToolUse",
    );
    assert.equal(result.status, "completed");
    assert.equal(result.event, undefined);
    assert.equal(fixture.db.getCounts().source_count, 0n);
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("maps start/tool/stop contracts conservatively without importing finals", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    const start = await adapter.handleHook(
      hookInput("sessionStart", fixture.projectDir, { source: "startup", initialPrompt: "hello" }),
      "sessionStart",
    );
    assert.equal(start.status, "completed");
    assert.equal(start.event?.event.stage, "session_start");
    const additionalContext = (start.response as { additionalContext?: unknown }).additionalContext;
    assert.equal(typeof additionalContext, "string");
    assert.equal(parseModelContextWrapper(additionalContext as string).kind, "agent_memory_context");

    const resume = await adapter.handleHook(
      hookInput("sessionStart", fixture.projectDir, { source: "resume" }),
      "sessionStart",
    );
    assert.equal(resume.event?.event.stage, "resume");

    const preTool = await adapter.handleHook(
      hookInput("preToolUse", fixture.projectDir, { toolName: "bash", toolArgs: { command: "ls" } }),
      "preToolUse",
    );
    assert.equal(preTool.event?.event.stage, "tool_started");
    assert.deepEqual(preTool.response, {});

    const postTool = await adapter.handleHook(
      hookInput("postToolUse", fixture.projectDir, {
        toolName: "bash",
        toolArgs: { command: "ls" },
        toolResult: { resultType: "success", textResultForLlm: "synthetic output" },
      }),
      "postToolUse",
    );
    assert.equal(postTool.event?.event.stage, "tool_result");
    assert.equal(postTool.event?.event.outcome, "succeeded");
    assert.deepEqual(postTool.response, {});

    const failure = await adapter.handleHook(
      hookInput("postToolUseFailure", fixture.projectDir, { toolName: "bash", toolArgs: { command: "ls" }, error: "synthetic failure" }),
      "postToolUseFailure",
    );
    assert.equal(failure.event?.event.stage, "tool_result");
    assert.equal(failure.event?.event.outcome, "failed");
    assert.deepEqual(failure.response, {});

    const stop = await adapter.handleHook(
      hookInput("agentStop", fixture.projectDir, { transcriptPath: join(fixture.dir, "transcript.jsonl"), stopReason: "end_turn", stop_hook_active: false }),
      "agentStop",
    );
    assert.equal(stop.event?.event.stage, "stop");
    assert.equal(eventText(stop.event), undefined);
    assert.deepEqual(stop.coverage, { status: "coverage_gap", reason: "event_not_observed" });
    assert.deepEqual(stop.response, {});

    const subagentStop = await adapter.handleHook(
      hookInput("subagentStop", fixture.projectDir, {
        transcriptPath: join(fixture.dir, "transcript.jsonl"),
        agentId: "agent-1",
        agentType: "explore",
        agentName: "explore",
        response: "subagent final text",
        stopReason: "end_turn",
      }),
      "subagentStop",
    );
    assert.equal(subagentStop.event?.event.stage, "stop");
    assert.equal(eventText(subagentStop.event), "subagent final text");
    assert.deepEqual(subagentStop.response, {});

    const compact = await adapter.handleHook(
      hookInput("preCompact", fixture.projectDir, {
        transcriptPath: join(fixture.dir, "transcript.jsonl"),
        trigger: "auto",
        customInstructions: "",
      }),
      "preCompact",
    );
    assert.equal(compact.event?.event.stage, "compaction");
    assert.deepEqual(compact.response, {});
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("requires native session and workspace identity and ignores event scope suggestions", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config, {
    clientFactory: () => {
      throw new Error("unexpected client construction");
    },
  });
  try {
    const missingSession = await adapter.handleHook({ timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "x" }, "userPromptSubmitted");
    assert.equal(missingSession.status, "unsupported");
    const missingCwd = await adapter.handleHook({ sessionId: "s", timestamp: TIMESTAMP_MS, prompt: "x" }, "userPromptSubmitted");
    assert.equal(missingCwd.status, "unsupported");
    const outside = await adapter.handleHook(
      hookInput("userPromptSubmitted", fixture.outsideDir, { prompt: "outside" }),
      "userPromptSubmitted",
    );
    assert.equal(outside.status, "degraded");
    assert.deepEqual(outside.response, {});
    assert.equal(fixture.db.getCounts().source_count, 0n);

    const validAdapter = new CopilotCliHostAdapter(fixture.config);
    try {
      const suggested = await validAdapter.handleHook(
        { ...hookInput("userPromptSubmitted", fixture.projectDir, { prompt: "scoped" }), scope_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
        "userPromptSubmitted",
      );
      assert.equal(suggested.status, "completed");
      assert.equal(suggested.event?.scope_id, scopeId);
    } finally {
      await validAdapter.close();
    }
  } finally {
    await cleanup(fixture, adapter);
  }
});

test("uses the transformed capture ACK for recall and replays a lost ACK immutably", async () => {
  const fixture = await setup();
  const calls: string[] = [];
  let preparationInput: unknown;
  const effectiveBinding = createNativeSessionBinding(fixture.binding, "native-order");
  const ack: CaptureAck = {
    version: 1,
    capture_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    commit_seq: "1",
    coverage: { status: "complete", stages: ["prompt_transformed"], truncated: false },
  };
  const packet = parseEvidencePacket({
    version: 1,
    query_id: "dededede-dede-4ded-8ded-dededededede",
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
    delivery: { format: "agent_memory_evidence_v1", injection_id: "dfdfdfdf-dfdf-4dfd-8dfd-dfdfdfdfdfdf" },
  });
  const fake: CopilotCliBrokerClient = {
    connectedBinding: effectiveBinding,
    registeredSessionIds: new Map([[scopeId, "abababab-abab-4aba-8aba-abababababab"]]),
    connect: async () => {
      calls.push("connect");
    },
    capture: async () => {
      calls.push("capture");
      return ack;
    },
    recognizeContext: async () => false,
    recall: async (_request, context) => {
      calls.push("recall");
      preparationInput = context;
      return packet;
    },
    close: async () => undefined,
  };
  const adapter = new CopilotCliHostAdapter(fixture.config, { clientFactory: () => fake });
  try {
    const result = await adapter.handleHook(
      { sessionId: "native-order", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "p", transformedPrompt: "t" },
      "userPromptTransformed",
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["connect", "capture", "recall"]);
    const context = preparationInput as { capture_status: { capture_id: string }; exclude_current_session_prompts?: unknown };
    assert.equal(context.capture_status.capture_id, ack.capture_id);
    // The transformed recall opts into the narrow trusted-context exclusion
    // (unprovable submitted↔transformed identity); the server derives the
    // session from the authenticated binding.
    assert.equal(context.exclude_current_session_prompts, true);
    assert.equal(Object.hasOwn(preparationInput as object, "binding_id"), false);
  } finally {
    await cleanup(fixture, adapter);
  }

  const binding = bindingFor();
  const event = normalizeNativeEvent({
    version: 1,
    capture_id: "abababab-abab-4aba-8aba-abababababab",
    scope_id: scopeId,
    adapter_version: "1.0.0",
    stage: "prompt_transformed",
    native_ids: { session_id: "retry-session" },
    text: "retry transformed",
    payload: { transformedPrompt: "retry transformed" },
    captured_at: "2026-09-07T20:00:00Z",
    truncation: { truncated: false },
    coverage: { status: "complete" },
    correlation: { status: "correlation_unknown", reason: "missing_native_id" },
  }, binding);
  const seen: NormalizedNativeEvent[] = [];
  const retryAck: CaptureAck = { version: 1, capture_id: event.capture_id, commit_seq: "1", coverage: { status: "complete", stages: ["prompt_transformed"], truncated: false } };
  const retryFake = {
    capture: async (candidate: unknown): Promise<CaptureAck> => {
      seen.push(candidate as NormalizedNativeEvent);
      if (seen.length === 1) throw new BrokerError("transport_closed");
      return retryAck;
    },
    connect: async () => undefined,
  };
  const replayed = await captureWithImmutableRetry(retryFake, event);
  assert.equal(replayed.capture_id, event.capture_id);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
});

test("deadline failures preserve native content with exactly {}", async () => {
  const fixture = await setup();
  const hanging: CopilotCliBrokerClient = {
    connectedBinding: createNativeSessionBinding(fixture.binding, "native-slow"),
    registeredSessionIds: new Map([[scopeId, "abababab-abab-4aba-8aba-abababababab"]]),
    connect: async () => undefined,
    capture: async () => new Promise<CaptureAck>(() => undefined),
    recognizeContext: async () => false,
    recall: async () => new Promise<EvidencePacket>(() => undefined),
    close: async () => undefined,
  };
  const adapter = new CopilotCliHostAdapter(fixture.config, { clientFactory: () => hanging });
  try {
    const controller = new AbortController();
    controller.abort();
    const degraded = await adapter.handleHook(
      { sessionId: "native-slow", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "p", transformedPrompt: "t" },
      "userPromptTransformed",
      { signal: controller.signal, deadlineAt: Date.now(), remainingMs: () => 0, throwIfExpired: () => { throw new Error("expired"); } },
    );
    assert.equal(degraded.status, "degraded");
    assert.deepEqual(degraded.response, {});
  } finally {
    await cleanup(fixture, adapter);
  }

  const stream = new PassThrough();
  let fallbackWrites = 0;
  let successWrites = 0;
  await runBoundedCommandHook({
    timeoutMs: 40,
    readInput: (deadline) => readBoundedStream(stream, deadline, 128, { destroyOnFailure: true }),
    handle: async () => ({ ok: true }),
    cleanup: async () => undefined,
    writeOutput: () => {
      successWrites += 1;
    },
    writeFallback: () => {
      fallbackWrites += 1;
    },
  });
  assert.equal(stream.destroyed, true);
  assert.equal(successWrites, 0);
  assert.equal(fallbackWrites, 1);
});

test("executes the compiled helper with synthetic native JSON and exactly one stdout line", async () => {
  const fixture = await setup();
  try {
    const configPath = join(fixture.dir, "copilot cli config.json");
    writeFileSync(configPath, JSON.stringify(fixtureInput(fixture.binding, fixture.projectDir, join(fixture.dir, "runtime"))));
    const helperPath = fileURLToPath(new URL("../adapters/copilot-cli/index.js", import.meta.url));

    const submittedInput = JSON.stringify({ sessionId: "native-helper", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "helper prompt 🦄" });
    const submitted = spawn(process.execPath, [helperPath, "--config", configPath, "--event", "userPromptSubmitted"], {
      cwd: fixture.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const submittedOut: Buffer[] = [];
    const submittedErr: Buffer[] = [];
    submitted.stdout.on("data", (chunk: Buffer) => submittedOut.push(Buffer.from(chunk)));
    submitted.stderr.on("data", (chunk: Buffer) => submittedErr.push(Buffer.from(chunk)));
    submitted.stdin.end(submittedInput);
    const submittedExit = await new Promise<number | null>((resolveExit, rejectExit) => {
      submitted.once("error", rejectExit);
      submitted.once("close", resolveExit);
    });
    assert.equal(submittedExit, 0);
    const submittedText = Buffer.concat(submittedOut).toString("utf8");
    assert.equal(submittedText, "{}\n");
    assert.equal(Buffer.concat(submittedErr).toString("utf8"), "");

    const transformedInput = JSON.stringify({
      sessionId: "native-helper",
      timestamp: TIMESTAMP_MS,
      cwd: fixture.projectDir,
      prompt: "helper prompt 🦄",
      transformedPrompt: "helper transformed 🦄",
    });
    const transformed = spawn(process.execPath, [helperPath, "--config", configPath, "--event", "userPromptTransformed"], {
      cwd: fixture.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transformedOut: Buffer[] = [];
    const transformedErr: Buffer[] = [];
    transformed.stdout.on("data", (chunk: Buffer) => transformedOut.push(Buffer.from(chunk)));
    transformed.stderr.on("data", (chunk: Buffer) => transformedErr.push(Buffer.from(chunk)));
    transformed.stdin.end(transformedInput);
    const transformedExit = await new Promise<number | null>((resolveExit, rejectExit) => {
      transformed.once("error", rejectExit);
      transformed.once("close", resolveExit);
    });
    assert.equal(transformedExit, 0);
    const transformedText = Buffer.concat(transformedOut).toString("utf8");
    assert.ok(transformedText.endsWith("\n"));
    assert.equal(transformedText.trim().split("\n").length, 1);
    const parsed = JSON.parse(transformedText) as { modifiedTransformedPrompt?: unknown };
    assert.equal(typeof parsed.modifiedTransformedPrompt, "string");
    assert.ok((parsed.modifiedTransformedPrompt as string).startsWith("helper transformed 🦄"));
    assert.equal(Buffer.concat(transformedErr).toString("utf8"), "");
    assert.equal(fixture.db.getCounts().source_count, 2n);
  } finally {
    await cleanup(fixture);
  }
});

test("rejects stale native pins before broker construction", () => {
  const binding = bindingFor();
  const base = fixtureInput(binding, "/tmp/project", "/tmp/runtime");
  assert.throws(() => createCopilotCliAdapterConfig({ ...base, cli_version: "1.0.82" }), /copilot-cli-adapter-config/);
  assert.throws(() => createCopilotCliAdapterConfig({ ...base, surface: "copilot_vscode_agent" }), /copilot-cli-adapter-config/);
});

test("transformed recall excludes current-session prompts but keeps previous-session memory", async () => {
  const fixture = await setup();
  const adapter = new CopilotCliHostAdapter(fixture.config);
  try {
    // Allowed memory from a previous native session sharing query tokens.
    const previous = await adapter.handleHook(
      { sessionId: "native-previous", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "alpha deploy checklist" },
      "userPromptSubmitted",
    );
    assert.equal(previous.status, "completed");
    const previousCaptureId = previous.captureAck?.capture_id;
    if (previousCaptureId === undefined) throw new Error("previous capture ack missing");

    // Current session: submitted original, then the transformed event with its
    // own ACK. The current-only marker qzxwv matches lexically and heads the
    // timeline, so only the trusted session exclusion can suppress the echo.
    const submitted = await adapter.handleHook(
      { sessionId: "native-current", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "alpha deploy qzxwv" },
      "userPromptSubmitted",
    );
    assert.equal(submitted.status, "completed");
    const submittedCaptureId = submitted.captureAck?.capture_id;
    if (submittedCaptureId === undefined) throw new Error("submitted capture ack missing");

    const transformed = await adapter.handleHook(
      {
        sessionId: "native-current",
        timestamp: TIMESTAMP_MS,
        cwd: fixture.projectDir,
        prompt: "alpha deploy qzxwv",
        transformedPrompt: "alpha deploy qzxwv",
      },
      "userPromptTransformed",
    );
    assert.equal(transformed.status, "completed");
    const transformedCaptureId = transformed.captureAck?.capture_id;
    if (transformedCaptureId === undefined) throw new Error("transformed capture ack missing");
    const modified = (transformed.response as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt;
    assert.ok(modified.startsWith("alpha deploy qzxwv"));

    const wrapper = suffixWrapper(modified, "alpha deploy qzxwv");
    const packetCaptureIds = new Set(wrapper.items.map((item) => item.capture_id));
    // Neither the submitted original nor the current transformed prompt echoes
    // as historical evidence.
    assert.ok(!packetCaptureIds.has(submittedCaptureId));
    assert.ok(!packetCaptureIds.has(transformedCaptureId));
    assert.equal(JSON.stringify(wrapper).includes("qzxwv"), false);
    // Allowed previous-session memory remains retrievable as candidate evidence.
    assert.ok(packetCaptureIds.has(previousCaptureId));
    assert.ok(wrapper.items.length >= 1);
    for (const item of wrapper.items) assert.equal(item.scope_id, scopeId);

    // A duplicate transformed prompt in the same session stays excluded while
    // previous-session memory keeps flowing.
    const repeat = await adapter.handleHook(
      {
        sessionId: "native-current",
        timestamp: TIMESTAMP_MS,
        cwd: fixture.projectDir,
        prompt: "alpha deploy qzxwv",
        transformedPrompt: "alpha deploy qzxwv",
      },
      "userPromptTransformed",
    );
    assert.equal(repeat.status, "completed");
    const repeatCaptureId = repeat.captureAck?.capture_id;
    if (repeatCaptureId === undefined) throw new Error("repeat capture ack missing");
    const repeatModified = (repeat.response as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt;
    const repeatWrapper = suffixWrapper(repeatModified, "alpha deploy qzxwv");
    const repeatIds = new Set(repeatWrapper.items.map((item) => item.capture_id));
    assert.ok(!repeatIds.has(submittedCaptureId));
    assert.ok(!repeatIds.has(transformedCaptureId));
    assert.ok(!repeatIds.has(repeatCaptureId));
    assert.ok(repeatIds.has(previousCaptureId));

    // Control: session-start recall in the same session deliberately omits the
    // flag, so its packet still sees current-session prompts (timeline head).
    // This bounds the exclusion to transformed recall only.
    const start = await adapter.handleHook(
      { sessionId: "native-current", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, source: "startup" },
      "sessionStart",
    );
    assert.equal(start.status, "completed");
    const startContext = (start.response as { additionalContext: string }).additionalContext;
    assert.equal(typeof startContext, "string");
    const startWrapper = parseModelContextWrapper(startContext);
    const startIds = new Set(startWrapper.items.map((item) => item.capture_id));
    assert.ok(startIds.has(repeatCaptureId));

    // A parallel native session excludes only its own prompts: its packet
    // never echoes its own captures, while cross-session candidates remain
    // eligible (retrieval stays candidate-only; the tight 1500-unit
    // conservative budget decides how many fit, so no single distant capture
    // is pinned here).
    const parallelSubmitted = await adapter.handleHook(
      { sessionId: "native-parallel", timestamp: TIMESTAMP_MS, cwd: fixture.projectDir, prompt: "parallel session widget note" },
      "userPromptSubmitted",
    );
    const parallelSubmittedId = parallelSubmitted.captureAck?.capture_id;
    if (parallelSubmittedId === undefined) throw new Error("parallel submitted ack missing");
    const parallel = await adapter.handleHook(
      {
        sessionId: "native-parallel",
        timestamp: TIMESTAMP_MS,
        cwd: fixture.projectDir,
        prompt: "alpha deploy qzxwv",
        transformedPrompt: "alpha deploy qzxwv",
      },
      "userPromptTransformed",
    );
    assert.equal(parallel.status, "completed");
    const parallelCaptureId = parallel.captureAck?.capture_id;
    if (parallelCaptureId === undefined) throw new Error("parallel capture ack missing");
    const parallelModified = (parallel.response as { modifiedTransformedPrompt: string }).modifiedTransformedPrompt;
    const parallelWrapper = suffixWrapper(parallelModified, "alpha deploy qzxwv");
    const parallelIds = new Set(parallelWrapper.items.map((item) => item.capture_id));
    assert.ok(!parallelIds.has(parallelSubmittedId));
    assert.ok(!parallelIds.has(parallelCaptureId));
    // Cross-session candidates still flow: the exclusion is session-scoped,
    // not a global prompt blackout. At least one prompt-class item proves
    // user/prompt evidence as a class is unaffected.
    assert.ok(parallelWrapper.items.length >= 1);
    assert.ok(parallelWrapper.items.some((item) => item.role === "user"));
    for (const item of parallelWrapper.items) assert.equal(item.scope_id, scopeId);
  } finally {
    await cleanup(fixture, adapter);
  }
});
