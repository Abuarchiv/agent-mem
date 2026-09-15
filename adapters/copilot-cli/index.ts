import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  parseDirectedEvidenceHandoff,
  parseEvidencePacketWrapper,
  parseModelContextWrapper,
  serializeModelContext,
} from "../../src/context/packet.js";
import {
  AgentMemoryBrokerClient,
  type BrokerBindingCredential,
  type BrokerClientOptions,
} from "../../src/host/broker.js";
import {
  captureWithImmutableRetry,
  CommandHookBoundaryError,
  type CommandHookDeadline,
  type ImmutableCaptureClient,
  NativeSessionClientPool,
  resolveConfiguredWorkspace,
  runBoundedCommandHook,
} from "../../src/host/command-hook.js";
import {
  createNativeSessionBinding,
  createTrustedBinding,
  parseContract,
  validateBoundedJson,
  type CaptureAck,
  type EvidencePacket,
  type SourceCoverage,
  type TrustedBinding,
} from "../../src/host/contract.js";
import {
  normalizeNativeEvent,
  type NativeEventInput,
  type NormalizedNativeEvent,
} from "../../src/host/events.js";

export const COPILOT_CLI_ADAPTER_VERSION = "1.0.0" as const;
export const COPILOT_CLI_VERSION = "1.0.83" as const;
export const COPILOT_CLI_HOOK_REFERENCE =
  "https://docs.github.com/en/copilot/reference/hooks-reference" as const;
export const COPILOT_CLI_SESSION_START_TOKEN_BUDGET = 600;
export const COPILOT_CLI_PROMPT_TOKEN_BUDGET = 1_500;
export const COPILOT_CLI_SESSION_START_MAX_BYTES = 24 * 1024;
export const COPILOT_CLI_PROMPT_MAX_BYTES = 64 * 1024;

const MAX_HOOK_BYTES = 1_000_000;
const MAX_HOOK_NODES = 50_000;
const MAX_HOOK_DEPTH = 20;
const DEFAULT_HOOK_TIMEOUT_MS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const OWN_MEMORY_TOOLS = ["memory_recall", "memory_get", "memory_forget", "memory_write"] as const;

const opaqueIdSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(4_096);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const epochMsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const projectRouteSchema = z
  .object({
    scope_id: z.uuid(),
    workspace_roots: z.array(pathSchema).min(1).max(32),
  })
  .strict();

const copilotCliConfigFileSchema = z
  .object({
    version: z.literal(1),
    cli_version: z.literal(COPILOT_CLI_VERSION),
    socket_path: pathSchema,
    expected_server_id: z.uuid().optional(),
    surface: z.literal("copilot_cli"),
    binding: z.unknown(),
    broker_secret_hex: z.string().regex(/^[a-fA-F0-9]+$/).refine((value) => value.length >= 64 && value.length % 2 === 0, {
      message: "broker_secret_hex must contain at least 32 bytes",
    }),
    projects: z.array(projectRouteSchema).min(1).max(32),
    session_start_query: z.string().min(1).max(100_000),
    adapter_version: versionSchema.default(COPILOT_CLI_ADAPTER_VERSION),
    hook_timeout_ms: z.number().int().min(100).max(30_000).default(DEFAULT_HOOK_TIMEOUT_MS),
    request_timeout_ms: z.number().int().min(50).max(30_000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  })
  .strict();

export const COPILOT_CLI_EVENTS = [
  "sessionStart",
  "userPromptSubmitted",
  "userPromptTransformed",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "agentStop",
  "subagentStart",
  "subagentStop",
  "preCompact",
] as const;

export type CopilotCliEventName = (typeof COPILOT_CLI_EVENTS)[number];

const eventNameSchema = z.enum(COPILOT_CLI_EVENTS);

const sessionStartHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    source: z.enum(["startup", "resume", "new"]),
    initialPrompt: z.string().max(1_000_000).optional(),
  })
  .passthrough();

const submittedHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    prompt: z.string().min(1).max(1_000_000),
  })
  .passthrough();

const transformedHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    prompt: z.string().min(1).max(1_000_000),
    transformedPrompt: z.string().min(1).max(1_000_000),
  })
  .passthrough();

const preToolUseHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    toolName: z.string().min(1).max(256),
    toolArgs: z.unknown(),
  })
  .passthrough();

const postToolUseHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    toolName: z.string().min(1).max(256),
    toolArgs: z.unknown(),
    toolResult: z
      .object({
        resultType: z.literal("success"),
        textResultForLlm: z.string().max(1_000_000),
      })
      .passthrough(),
  })
  .passthrough();

const postToolUseFailureHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    toolName: z.string().min(1).max(256),
    toolArgs: z.unknown(),
    error: z.string().min(1).max(1_000_000),
  })
  .passthrough();

const agentStopHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    transcriptPath: pathSchema,
    stopReason: z.literal("end_turn"),
    stop_hook_active: z.boolean(),
  })
  .passthrough();

const subagentStartHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    transcriptPath: pathSchema,
    agentName: z.string().min(1).max(256),
    agentDisplayName: z.string().max(1_000).optional(),
    agentDescription: z.string().max(1_000_000).optional(),
  })
  .passthrough();

const subagentStopHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    transcriptPath: pathSchema,
    agentId: opaqueIdSchema,
    agentType: z.string().min(1).max(256),
    agentName: z.string().min(1).max(256),
    agentDisplayName: z.string().max(1_000).optional(),
    response: z.string().min(1).max(1_000_000),
    stopReason: z.literal("end_turn"),
  })
  .passthrough();

const preCompactHookSchema = z
  .object({
    sessionId: opaqueIdSchema,
    timestamp: epochMsSchema,
    cwd: pathSchema,
    transcriptPath: pathSchema,
    trigger: z.enum(["manual", "auto"]),
    customInstructions: z.string().max(1_000_000),
  })
  .passthrough();

type SessionStartHook = z.infer<typeof sessionStartHookSchema>;
type SubmittedHook = z.infer<typeof submittedHookSchema>;
type TransformedHook = z.infer<typeof transformedHookSchema>;
type PreToolUseHook = z.infer<typeof preToolUseHookSchema>;
type PostToolUseHook = z.infer<typeof postToolUseHookSchema>;
type PostToolUseFailureHook = z.infer<typeof postToolUseFailureHookSchema>;
type AgentStopHook = z.infer<typeof agentStopHookSchema>;
type SubagentStartHook = z.infer<typeof subagentStartHookSchema>;
type SubagentStopHook = z.infer<typeof subagentStopHookSchema>;
type PreCompactHook = z.infer<typeof preCompactHookSchema>;

export type CopilotCliHook =
  | SessionStartHook
  | SubmittedHook
  | TransformedHook
  | PreToolUseHook
  | PostToolUseHook
  | PostToolUseFailureHook
  | AgentStopHook
  | SubagentStartHook
  | SubagentStopHook
  | PreCompactHook;

export interface CopilotCliProjectRoute {
  readonly scope_id: string;
  readonly workspace_roots: readonly string[];
}

export interface CopilotCliAdapterConfig {
  readonly version: 1;
  readonly cliVersion: typeof COPILOT_CLI_VERSION;
  readonly socketPath: string;
  readonly expectedServerId?: string;
  readonly surface: "copilot_cli";
  readonly binding: TrustedBinding;
  readonly credential: BrokerBindingCredential;
  readonly projects: readonly CopilotCliProjectRoute[];
  readonly sessionStartQuery: string;
  readonly adapterVersion: string;
  readonly hookTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export type CopilotCliHookOutput =
  | Record<string, never>
  | { readonly additionalContext: string }
  | { readonly modifiedTransformedPrompt: string };

export interface CopilotCliAdapterResult {
  readonly status: "completed" | "degraded" | "unsupported";
  readonly response: CopilotCliHookOutput;
  readonly hookEventName?: CopilotCliEventName;
  readonly captureAck?: CaptureAck;
  readonly event?: NormalizedNativeEvent;
  readonly coverage: SourceCoverage;
  readonly recognizedOwnContext?: boolean;
}

export interface CopilotCliBrokerClient extends ImmutableCaptureClient {
  readonly connectedBinding: TrustedBinding;
  readonly registeredSessionIds: ReadonlyMap<string, string>;
  recall(request: unknown, context: unknown): Promise<EvidencePacket>;
  recognizeContext(context: unknown): Promise<boolean>;
  close(): Promise<void>;
}

export interface CopilotCliHostAdapterOptions {
  readonly clientFactory?: (options: BrokerClientOptions) => CopilotCliBrokerClient;
  readonly clock?: () => Date;
}

export class CopilotCliAdapterError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CopilotCliAdapterError";
  }
}

function assertAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new CopilotCliAdapterError(`${name}_must_be_absolute`);
  return value;
}

function parseSecret(value: string): Buffer {
  const secret = Buffer.from(value, "hex");
  if (secret.length < 32) throw new CopilotCliAdapterError("broker_secret_too_short");
  return secret;
}

function duplicateValues(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function createCopilotCliAdapterConfig(input: unknown): CopilotCliAdapterConfig {
  const parsed = parseContract(copilotCliConfigFileSchema, input, "copilot-cli-adapter-config");
  const binding = createTrustedBinding(parsed.binding);
  if (binding.host_kind !== "copilot" || binding.surface !== "copilot_cli") {
    throw new CopilotCliAdapterError("binding_surface_mismatch");
  }
  if (binding.execution_domain.kind !== "local") throw new CopilotCliAdapterError("execution_domain_unsupported");
  if (!binding.egress.reader_targets.includes("reader:copilot_cli")) {
    throw new CopilotCliAdapterError("reader_egress_missing");
  }
  const projectScopeIds = parsed.projects.map((project) => project.scope_id);
  if (duplicateValues(projectScopeIds)) throw new CopilotCliAdapterError("duplicate_project_scope");
  const configuredScopes = [...binding.allowed_scope_ids].sort();
  const routedScopes = [...projectScopeIds].sort();
  if (configuredScopes.length !== routedScopes.length || configuredScopes.some((scopeId, index) => scopeId !== routedScopes[index])) {
    throw new CopilotCliAdapterError("binding_scope_route_mismatch");
  }
  assertAbsolutePath(parsed.socket_path, "socket_path");
  const projects = Object.freeze(
    parsed.projects.map((project) =>
      Object.freeze({
        scope_id: project.scope_id,
        workspace_roots: Object.freeze(project.workspace_roots.map((root) => assertAbsolutePath(root, "workspace_root"))),
      }),
    ),
  );
  return Object.freeze({
    version: 1,
    cliVersion: parsed.cli_version,
    socketPath: parsed.socket_path,
    ...(parsed.expected_server_id === undefined ? {} : { expectedServerId: parsed.expected_server_id }),
    surface: "copilot_cli" as const,
    binding,
    credential: {
      binding,
      secret: parseSecret(parsed.broker_secret_hex),
      allowNativeSessions: true,
    },
    projects,
    sessionStartQuery: parsed.session_start_query,
    adapterVersion: parsed.adapter_version,
    hookTimeoutMs: parsed.hook_timeout_ms,
    requestTimeoutMs: parsed.request_timeout_ms,
  });
}

export function loadCopilotCliAdapterConfig(path: string): CopilotCliAdapterConfig {
  const configPath = assertAbsolutePath(path, "config_path");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    throw new CopilotCliAdapterError("config_unreadable");
  }
  return createCopilotCliAdapterConfig(parsed);
}

export function resolveProjectScope(cwd: string, routes: readonly CopilotCliProjectRoute[]): CopilotCliProjectRoute {
  try {
    return resolveConfiguredWorkspace(cwd, routes);
  } catch (error: unknown) {
    if (error instanceof CommandHookBoundaryError) throw new CopilotCliAdapterError(error.reason);
    throw error;
  }
}

function authorityKey(binding: TrustedBinding): string {
  return JSON.stringify({
    version: binding.version,
    binding_id: binding.binding_id,
    host_kind: binding.host_kind,
    surface: binding.surface,
    execution_domain: { kind: binding.execution_domain.kind, id: binding.execution_domain.id },
    host_instance_id: binding.host_instance_id,
    host_session_id: binding.host_session_id,
    allowed_scope_ids: [...binding.allowed_scope_ids],
    egress: {
      reader_targets: [...binding.egress.reader_targets],
      provider_targets: [...binding.egress.provider_targets],
    },
  });
}

function parseBoundedHook(input: unknown, eventName: CopilotCliEventName): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CopilotCliAdapterError("hook_object_required");
  }
  if (Object.keys(input).length > 256) throw new CopilotCliAdapterError("hook_too_large");
  validateBoundedJson(input, { max_depth: MAX_HOOK_DEPTH, max_bytes: MAX_HOOK_BYTES, max_nodes: MAX_HOOK_NODES }, "copilot-cli-hook");
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_HOOK_BYTES) {
    throw new CopilotCliAdapterError("hook_too_large");
  }
  void eventName;
}

function parseCopilotCliHook(input: unknown, eventName: CopilotCliEventName): CopilotCliHook {
  try {
    parseBoundedHook(input, eventName);
    switch (eventName) {
      case "sessionStart":
        return parseContract(sessionStartHookSchema, input, "copilot-cli-hook");
      case "userPromptSubmitted":
        return parseContract(submittedHookSchema, input, "copilot-cli-hook");
      case "userPromptTransformed":
        return parseContract(transformedHookSchema, input, "copilot-cli-hook");
      case "preToolUse":
        return parseContract(preToolUseHookSchema, input, "copilot-cli-hook");
      case "postToolUse":
        return parseContract(postToolUseHookSchema, input, "copilot-cli-hook");
      case "postToolUseFailure":
        return parseContract(postToolUseFailureHookSchema, input, "copilot-cli-hook");
      case "agentStop":
        return parseContract(agentStopHookSchema, input, "copilot-cli-hook");
      case "subagentStart":
        return parseContract(subagentStartHookSchema, input, "copilot-cli-hook");
      case "subagentStop":
        return parseContract(subagentStopHookSchema, input, "copilot-cli-hook");
      case "preCompact":
        return parseContract(preCompactHookSchema, input, "copilot-cli-hook");
    }
  } catch (error: unknown) {
    if (error instanceof CopilotCliAdapterError) throw error;
    throw new CopilotCliAdapterError("hook_invalid");
  }
}

/**
 * Recognize complete memory wrappers and directed handoffs. Ordinary prompt
 * text, embedded wrappers, and forged or unauthorized handoffs continue
 * through the normal prompt capture path.
 */
function ownWrapperCandidate(text: string): unknown | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind !== "agent_memory_context" && kind !== "agent_memory_evidence" && kind !== "agent_memory_handoff") return undefined;
  try {
    if (kind === "agent_memory_handoff") return parseDirectedEvidenceHandoff(parsed);
    return kind === "agent_memory_context" ? parseModelContextWrapper(parsed) : parseEvidencePacketWrapper(parsed);
  } catch {
    return undefined;
  }
}

function occurredAt(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function serializedValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : serialized;
  } catch {
    return undefined;
  }
}

interface MappedHook {
  readonly stage: NativeEventInput["stage"];
  readonly text?: string;
  readonly outcome?: NativeEventInput["outcome"];
  readonly coverage: SourceCoverage;
  readonly shouldRecall: boolean;
  readonly recallKind?: "session_start" | "user_prompt";
  readonly query?: string;
}

function mapHook(eventName: CopilotCliEventName, hook: CopilotCliHook): MappedHook {
  switch (eventName) {
    case "sessionStart": {
      const start = hook as SessionStartHook;
      void start;
      return {
        stage: (hook as SessionStartHook).source === "resume" ? "resume" : "session_start",
        coverage: { status: "complete" },
        shouldRecall: true,
        recallKind: "session_start",
      };
    }
    case "userPromptSubmitted": {
      const submitted = hook as SubmittedHook;
      return {
        stage: "prompt_submitted",
        text: submitted.prompt,
        coverage: { status: "complete" },
        shouldRecall: false,
      };
    }
    case "userPromptTransformed": {
      const transformed = hook as TransformedHook;
      return {
        stage: "prompt_transformed",
        text: transformed.transformedPrompt,
        coverage: { status: "complete" },
        shouldRecall: true,
        recallKind: "user_prompt",
        query: transformed.transformedPrompt,
      };
    }
    case "preToolUse": {
      const pre = hook as PreToolUseHook;
      const text = serializedValue(pre.toolArgs);
      return {
        stage: "tool_started",
        ...(text === undefined ? {} : { text }),
        coverage: { status: "complete" },
        shouldRecall: false,
      };
    }
    case "postToolUse": {
      const post = hook as PostToolUseHook;
      const text = post.toolResult.textResultForLlm.length === 0 ? undefined : post.toolResult.textResultForLlm;
      return {
        stage: "tool_result",
        ...(text === undefined ? {} : { text }),
        outcome: "succeeded",
        coverage: { status: "complete" },
        shouldRecall: false,
      };
    }
    case "postToolUseFailure": {
      const failure = hook as PostToolUseFailureHook;
      return {
        stage: "tool_result",
        text: failure.error,
        outcome: "failed",
        coverage: { status: "complete" },
        shouldRecall: false,
      };
    }
    case "agentStop":
      return { stage: "stop", coverage: { status: "coverage_gap", reason: "event_not_observed" }, shouldRecall: false };
    case "subagentStart":
      return { stage: "session_start", coverage: { status: "complete" }, shouldRecall: true, recallKind: "session_start" };
    case "subagentStop": {
      const subagentStop = hook as SubagentStopHook;
      return {
        stage: "stop",
        text: subagentStop.response,
        coverage: { status: "complete" },
        shouldRecall: false,
      };
    }
    case "preCompact":
      return { stage: "compaction", coverage: { status: "complete" }, shouldRecall: false };
  }
}

function sessionIdOf(hook: CopilotCliHook): string {
  return (hook as { sessionId: string }).sessionId;
}

function isOwnMemoryTool(eventName: CopilotCliEventName, hook: CopilotCliHook): boolean {
  if (eventName !== "preToolUse" && eventName !== "postToolUse" && eventName !== "postToolUseFailure") return false;
  const toolName = (hook as { toolName?: unknown }).toolName;
  if (typeof toolName !== "string") return false;
  return OWN_MEMORY_TOOLS.some((name) => toolName === name || ["/", ".", ":", "__"].some((separator) => toolName.endsWith(`${separator}${name}`)));
}

function timestampOf(hook: CopilotCliHook): number {
  return (hook as { timestamp: number }).timestamp;
}

function outputForSessionPacket(packet: EvidencePacket, maxBytes: number): CopilotCliHookOutput {
  const { serializeModelContext: serialize } = { serializeModelContext };
  const additionalContext = serialize(packet);
  if (Buffer.byteLength(additionalContext, "utf8") > maxBytes) throw new CopilotCliAdapterError("additional_context_too_large");
  return { additionalContext };
}

function outputForTransformedPacket(transformedPrompt: string, packet: EvidencePacket, maxBytes: number): CopilotCliHookOutput {
  const additionalContext = serializeModelContext(packet);
  const modifiedTransformedPrompt = `${transformedPrompt}\n\n${additionalContext}`;
  if (modifiedTransformedPrompt.length === 0 || transformedPrompt.length === 0) {
    throw new CopilotCliAdapterError("transformed_prompt_missing");
  }
  if (!modifiedTransformedPrompt.startsWith(transformedPrompt)) throw new CopilotCliAdapterError("transformed_prefix_violated");
  if (Buffer.byteLength(modifiedTransformedPrompt, "utf8") > maxBytes) {
    throw new CopilotCliAdapterError("additional_context_too_large");
  }
  return { modifiedTransformedPrompt };
}

function degradedResult(hookEventName: CopilotCliEventName | undefined, coverage: SourceCoverage): CopilotCliAdapterResult {
  return {
    status: "degraded",
    response: {},
    ...(hookEventName === undefined ? {} : { hookEventName }),
    coverage,
  };
}

function unsupportedResult(hookEventName?: CopilotCliEventName): CopilotCliAdapterResult {
  return {
    status: "unsupported",
    response: {},
    ...(hookEventName === undefined ? {} : { hookEventName }),
    coverage: { status: "coverage_gap", reason: "adapter_gap" },
  };
}

export class CopilotCliHostAdapter {
  private readonly config: CopilotCliAdapterConfig;
  private readonly clientPool: NativeSessionClientPool<CopilotCliBrokerClient>;
  private readonly clock: () => Date;

  constructor(config: CopilotCliAdapterConfig, options: CopilotCliHostAdapterOptions = {}) {
    this.config = config;
    this.clock = options.clock ?? (() => new Date());
    const clientFactory = options.clientFactory ?? ((clientOptions) => new AgentMemoryBrokerClient(clientOptions));
    this.clientPool = new NativeSessionClientPool({
      clientFactory,
      clientOptions: {
        socketPath: config.socketPath,
        credential: config.credential,
        ...(config.expectedServerId === undefined ? {} : { expectedServerId: config.expectedServerId }),
        requestTimeoutMs: config.requestTimeoutMs,
      },
    });
  }

  async handleHook(input: unknown, eventName: unknown, deadline?: CommandHookDeadline): Promise<CopilotCliAdapterResult> {
    const parsedEvent = eventNameSchema.safeParse(eventName);
    if (!parsedEvent.success) return unsupportedResult(undefined);
    const hookEventName = parsedEvent.data;
    let hook: CopilotCliHook;
    try {
      hook = parseCopilotCliHook(input, hookEventName);
    } catch {
      return unsupportedResult(hookEventName);
    }
    if (isOwnMemoryTool(hookEventName, hook)) {
      return { status: "completed", response: {}, hookEventName, coverage: { status: "complete" } };
    }
    try {
      deadline?.throwIfExpired();
    } catch {
      return degradedResult(hookEventName, { status: "coverage_gap", reason: "host_dropped" });
    }
    const cwd = (hook as { cwd: string }).cwd;
    let route: CopilotCliProjectRoute;
    try {
      route = resolveProjectScope(cwd, this.config.projects);
      deadline?.throwIfExpired();
    } catch {
      return degradedResult(hookEventName, { status: "coverage_gap", reason: "adapter_gap" });
    }
    let client: CopilotCliBrokerClient;
    try {
      client = await this.clientFor(sessionIdOf(hook));
      deadline?.throwIfExpired();
    } catch {
      return degradedResult(hookEventName, { status: "coverage_gap", reason: "host_dropped" });
    }
    if (hookEventName === "userPromptSubmitted") {
      const ownCandidate = ownWrapperCandidate((hook as SubmittedHook).prompt);
      if (ownCandidate !== undefined) {
        try {
          deadline?.throwIfExpired();
          if (await client.recognizeContext(ownCandidate)) {
            deadline?.throwIfExpired();
            return {
              status: "completed",
              response: {},
              hookEventName,
              coverage: { status: "complete" },
              recognizedOwnContext: true,
            };
          }
        } catch {
          // Recognition failure must never suppress the actual user prompt.
        }
      }
    }
    const mapped = mapHook(hookEventName, hook);
    // Submitted and transformed payloads carry no documented message/event ID.
    // Session/text/time and FIFO order must never prove correspondence, so both
    // stay explicit correlation_unknown with fresh capture IDs. The transformed
    // recall below waits for its OWN capture ACK and never borrows the
    // submitted ACK.
    const correlation = { status: "correlation_unknown", reason: "missing_native_id" } as const;
    const captureId = randomUUID();
    const nativeInput: NativeEventInput = {
      version: 1,
      capture_id: captureId,
      scope_id: route.scope_id,
      adapter_version: this.config.adapterVersion,
      stage: mapped.stage,
      native_ids: { session_id: sessionIdOf(hook) },
      ...(mapped.text === undefined ? {} : { text: mapped.text }),
      ...(mapped.outcome === undefined ? {} : { outcome: mapped.outcome }),
      payload: hook,
      captured_at: this.clock().toISOString(),
      occurred_at: occurredAt(timestampOf(hook)),
      truncation: { truncated: false },
      coverage: mapped.coverage,
      correlation,
    };
    try {
      deadline?.throwIfExpired();
      const event = normalizeNativeEvent(nativeInput, client.connectedBinding);
      const registeredSessionId = client.registeredSessionIds.get(route.scope_id);
      if (registeredSessionId === undefined || registeredSessionId.length === 0) {
        throw new CopilotCliAdapterError("session_registration_missing");
      }
      deadline?.throwIfExpired();
      const ack = await captureWithImmutableRetry(
        client,
        event,
        deadline === undefined ? undefined : { signal: deadline.signal, onAbort: () => client.close() },
      );
      deadline?.throwIfExpired();
      if (!mapped.shouldRecall) {
        return { status: "completed", response: {}, hookEventName, captureAck: ack, event, coverage: mapped.coverage };
      }
      const kind = mapped.recallKind ?? "session_start";
      const tokenBudget = kind === "session_start" ? COPILOT_CLI_SESSION_START_TOKEN_BUDGET : COPILOT_CLI_PROMPT_TOKEN_BUDGET;
      const maxBytes = kind === "session_start" ? COPILOT_CLI_SESSION_START_MAX_BYTES : COPILOT_CLI_PROMPT_MAX_BYTES;
      const deadlineAt = deadline === undefined
        ? new Date(this.clock().getTime() + this.config.hookTimeoutMs).toISOString()
        : new Date(deadline.deadlineAt).toISOString();
      const contextInput = {
        version: 1 as const,
        kind,
        deadline_at: deadlineAt,
        capture_status: { state: "committed" as const, capture_id: ack.capture_id },
        // Narrow T05d trusted-context exclusion: the native submitted↔
        // transformed identity is unprovable (no message/event ID), so the
        // transformed recall must not echo the current native session's own
        // user/prompt sources as historical evidence. The server derives the
        // session from the authenticated binding; scopes are never widened.
        // Session-start recall intentionally omits this flag.
        ...(hookEventName === "userPromptTransformed" ? { exclude_current_session_prompts: true as const } : {}),
        budget: {
          automatic_tokens: COPILOT_CLI_PROMPT_TOKEN_BUDGET,
          session_start_tokens: COPILOT_CLI_SESSION_START_TOKEN_BUDGET,
          max_bytes: COPILOT_CLI_PROMPT_MAX_BYTES,
          session_start_max_bytes: COPILOT_CLI_SESSION_START_MAX_BYTES,
          reserve_bytes: 1_024,
        },
      };
      const query = mapped.query ?? this.config.sessionStartQuery;
      const request = {
        query,
        scope_ids: [route.scope_id],
        mode: "current" as const,
        token_budget: tokenBudget,
      };
      // Strict wire DTO only; the broker brands its own PreparationContext.
      const packet = await client.recall(request, contextInput);
      deadline?.throwIfExpired();
      if (hookEventName === "userPromptTransformed") {
        const transformed = (hook as TransformedHook).transformedPrompt;
        const response = outputForTransformedPacket(transformed, packet, maxBytes);
        return { status: "completed", response, hookEventName, captureAck: ack, event, coverage: mapped.coverage };
      }
      if (hookEventName !== "sessionStart" && hookEventName !== "subagentStart") {
        throw new CopilotCliAdapterError("recall_event_invalid");
      }
      const response = outputForSessionPacket(packet, maxBytes);
      return { status: "completed", response, hookEventName, captureAck: ack, event, coverage: mapped.coverage };
    } catch {
      return degradedResult(hookEventName, mapped.coverage);
    }
  }

  async close(): Promise<void> {
    await this.clientPool.close();
  }

  private async clientFor(nativeSessionId: string): Promise<CopilotCliBrokerClient> {
    const client = await this.clientPool.get(nativeSessionId);
    const expected = createNativeSessionBinding(this.config.binding, nativeSessionId);
    if (authorityKey(client.connectedBinding) !== authorityKey(expected)) {
      throw new CopilotCliAdapterError("native_session_binding_mismatch");
    }
    return client;
  }
}

export interface CopilotCliHookPaths {
  readonly nodePath: string;
  readonly helperPath: string;
  readonly configPath: string;
  readonly event: CopilotCliEventName;
}

function assertHelperFile(path: string, name: string, executable: boolean): string {
  const absolute = assertAbsolutePath(path, name);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile() || (executable && (stat.mode & 0o111) === 0) || (!executable && (stat.mode & 0o444) === 0)) {
      throw new Error("not_usable_file");
    }
  } catch {
    throw new CopilotCliAdapterError("helper_path_unavailable");
  }
  return absolute;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Render the documented cross-platform command hook entry. */
export function renderCopilotCliHookEntry(options: CopilotCliHookPaths): Record<string, unknown> {
  const event = parseContract(eventNameSchema, options.event, "copilot-cli-event");
  const nodePath = assertHelperFile(options.nodePath, "node_path", true);
  const helperPath = assertHelperFile(options.helperPath, "helper_path", false);
  const configPath = assertAbsolutePath(options.configPath, "config_path");
  return Object.freeze({
    type: "command",
    bash: `${shellQuote(nodePath)} ${shellQuote(helperPath)} --config ${shellQuote(configPath)} --event ${shellQuote(event)}`,
    powershell: `& ${powershellQuote(nodePath)} ${powershellQuote(helperPath)} --config ${powershellQuote(configPath)} --event ${powershellQuote(event)}`,
    timeoutSec: 15,
  });
}

/** Render the ordinary documented version-1 hooks JSON registration for Copilot CLI. */
export function renderCopilotCliHookFile(options: Omit<CopilotCliHookPaths, "event">): string {
  const hooks: Record<string, readonly unknown[]> = {};
  for (const event of COPILOT_CLI_EVENTS) {
    hooks[event] = [renderCopilotCliHookEntry({ ...options, event })];
  }
  return JSON.stringify({ version: 1, hooks }, null, 2);
}

export async function runCopilotCliHookFromStdin(configPath: string, eventName: unknown): Promise<void> {
  const parsedEvent = eventNameSchema.safeParse(eventName);
  if (!parsedEvent.success) {
    process.stdout.write("{}\n");
    return;
  }
  const event = parsedEvent.data;
  let config: CopilotCliAdapterConfig;
  try {
    config = loadCopilotCliAdapterConfig(configPath);
  } catch {
    process.stdout.write("{}\n");
    return;
  }
  const adapter = new CopilotCliHostAdapter(config);
  await runBoundedCommandHook({
    timeoutMs: config.hookTimeoutMs,
    maxInputBytes: MAX_HOOK_BYTES,
    handle: async (text, deadline) => {
      const input = JSON.parse(text) as unknown;
      return adapter.handleHook(input, event, deadline);
    },
    cleanup: () => adapter.close(),
    writeOutput: (result) => process.stdout.write(`${JSON.stringify(result.response)}\n`),
    writeFallback: () => process.stdout.write("{}\n"),
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let configPath: string | undefined;
  let eventName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      configPath = argv[index + 1];
      index += 1;
    } else if (arg === "--event") {
      eventName = argv[index + 1];
      index += 1;
    }
  }
  if (configPath === undefined || !isAbsolute(configPath) || eventName === undefined) {
    process.stdout.write("{}\n");
    return;
  }
  await runCopilotCliHookFromStdin(configPath, eventName);
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void main();
}
