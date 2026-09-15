import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  parseDirectedEvidenceHandoff,
  parseEvidencePacketWrapper,
  parseModelContextWrapper,
  serializeModelContext,
  serializeModelContextWithStatus,
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
  type ImmutableCaptureRetryOptions,
  NativeSessionClientPool,
  resolveConfiguredWorkspace,
  runBoundedCommandHook,
} from "../../src/host/command-hook.js";
import {
  normalizeNativeEvent,
  type NativeEventInput,
  type NormalizedNativeEvent,
} from "../../src/host/events.js";
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
import { connectedSessionStatus, formatSessionStatus, sessionStatusFromBackend, type AgentMemorySessionStatus, type SessionHost } from "../../src/v1/session-status.js";
import { ensureOwnedBrokerForConnection } from "../../src/v1/recovery.js";
import { MEMORY_MCP_LEGACY_SERVER_KEYS, MEMORY_MCP_SERVER_KEY, MEMORY_MCP_SERVER_NAME } from "../../src/host/tool-schemas.js";

export const CODEX_ADAPTER_VERSION = "1.0.0" as const;
export const CODEX_SESSION_START_UTF8_BYTES = 4_000;
export const CODEX_PROMPT_UTF8_BYTES = 8_000;
export const CODEX_SESSION_START_MAX_BYTES = 24 * 1024;
export const CODEX_PROMPT_MAX_BYTES = 64 * 1024;
const ownMemoryMcpServerNames = [MEMORY_MCP_SERVER_KEY, MEMORY_MCP_SERVER_NAME, ...MEMORY_MCP_LEGACY_SERVER_KEYS] as const;
/** Native hook names accepted by this adapter's versioned input contract. */
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "PostCompact"] as const;

const MAX_HOOK_BYTES = 1_000_000;
const MAX_HOOK_NODES = 50_000;
const MAX_HOOK_DEPTH = 20;
const DEFAULT_HOOK_TIMEOUT_MS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEGRADED_MESSAGE = "Agent Mem unavailable; Codex continued without memory context.";

const codexSurfaceSchema = z.enum(["codex_cli", "codex_desktop"]);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const opaqueIdSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(4_096);
const projectRouteSchema = z
  .object({
    scope_id: z.uuid(),
    workspace_roots: z.array(pathSchema).min(1).max(32),
  })
  .strict();

const codexConfigFileSchema = z
  .object({
    version: z.literal(1),
    socket_path: pathSchema,
    expected_server_id: z.uuid().optional(),
    surface: codexSurfaceSchema,
    binding: z.unknown(),
    broker_secret_hex: z.string().regex(/^[a-fA-F0-9]+$/).refine((value) => value.length >= 64 && value.length % 2 === 0, {
      message: "broker_secret_hex must contain at least 32 bytes",
    }),
    projects: z.array(projectRouteSchema).min(1).max(32),
    session_start_query: z.string().min(1).max(100_000),
    adapter_version: versionSchema.default(CODEX_ADAPTER_VERSION),
    hook_timeout_ms: z.number().int().min(100).max(30_000).default(DEFAULT_HOOK_TIMEOUT_MS),
    request_timeout_ms: z.number().int().min(50).max(30_000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  })
  .strict();

const hookCommonShape = {
  session_id: opaqueIdSchema,
  cwd: pathSchema,
  transcript_path: pathSchema.optional(),
  model: z.string().min(1).max(256).optional(),
  event_id: opaqueIdSchema.optional(),
  hook_event_id: opaqueIdSchema.optional(),
  turn_id: opaqueIdSchema.optional(),
  message_id: opaqueIdSchema.optional(),
  part_id: opaqueIdSchema.optional(),
  permission_mode: z.string().min(1).max(128).optional(),
};

const sessionStartHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("SessionStart"),
    source: z.enum(["startup", "resume", "clear", "compact"]),
  })
  .passthrough();
const promptHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("UserPromptSubmit"),
    prompt: z.string().max(1_000_000),
  })
  .passthrough();
const postToolHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("PostToolUse"),
    tool_name: z.string().min(1).max(256),
    tool_use_id: opaqueIdSchema.optional(),
    tool_call_id: opaqueIdSchema.optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
  })
  .passthrough();
const stopHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("Stop"),
    stop_hook_active: z.boolean().optional(),
    last_assistant_message: z.string().max(1_000_000).nullable().optional(),
  })
  .passthrough();
const preCompactHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("PreCompact"),
    trigger: z.enum(["manual", "auto"]).optional(),
  })
  .passthrough();
const postCompactHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("PostCompact"),
  })
  .passthrough();
const compactHookSchema = z
  .object({
    ...hookCommonShape,
    hook_event_name: z.literal("Compact"),
    trigger: z.enum(["manual", "auto"]).optional(),
  })
  .passthrough();
const codexHookSchema = z.union([
  sessionStartHookSchema,
  promptHookSchema,
  postToolHookSchema,
  stopHookSchema,
  preCompactHookSchema,
  postCompactHookSchema,
  compactHookSchema,
]);

type CodexHook = z.infer<typeof codexHookSchema>;
type CodexSurface = z.infer<typeof codexSurfaceSchema>;

export interface CodexProjectRoute {
  readonly scope_id: string;
  readonly workspace_roots: readonly string[];
}

export interface CodexAdapterConfig {
  readonly version: 1;
  readonly socketPath: string;
  readonly expectedServerId?: string;
  readonly surface: CodexSurface;
  readonly binding: TrustedBinding;
  readonly credential: BrokerBindingCredential;
  readonly projects: readonly CodexProjectRoute[];
  readonly sessionStartQuery: string;
  readonly adapterVersion: string;
  readonly hookTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface CodexHookOutput {
  readonly continue?: true;
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: string;
    readonly additionalContext: string;
  };
}

export interface CodexAdapterResult {
  readonly status: "completed" | "degraded" | "unsupported";
  readonly response: CodexHookOutput;
  readonly hookEventName?: string;
  readonly captureAck?: CaptureAck;
  readonly event?: NormalizedNativeEvent;
  readonly coverage: SourceCoverage;
  readonly recognizedOwnContext?: boolean;
}

export interface CodexBrokerClient {
  readonly connectedBinding: TrustedBinding;
  readonly registeredSessionIds: ReadonlyMap<string, string>;
  connect(): Promise<void>;
  capture(event: unknown): Promise<CaptureAck>;
  recall(request: unknown, context: unknown): Promise<EvidencePacket>;
  recognizeContext(context: unknown): Promise<boolean>;
  readonly rpc?: (payload: unknown) => Promise<unknown>;
  close(): Promise<void>;
}

export interface CodexHostAdapterOptions {
  readonly clientFactory?: (options: BrokerClientOptions) => CodexBrokerClient;
  readonly clock?: () => Date;
}

export class CodexAdapterError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CodexAdapterError";
  }
}

function assertAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new CodexAdapterError(`${name}_must_be_absolute`);
  return value;
}

function parseSecret(value: string): Buffer {
  const secret = Buffer.from(value, "hex");
  if (secret.length < 32) throw new CodexAdapterError("broker_secret_too_short");
  return secret;
}

function duplicateValues(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function createCodexAdapterConfig(input: unknown): CodexAdapterConfig {
  const parsed = parseContract(codexConfigFileSchema, input, "codex-adapter-config");
  const binding = createTrustedBinding(parsed.binding);
  if (binding.host_kind !== "codex" || binding.surface !== parsed.surface) {
    throw new CodexAdapterError("binding_surface_mismatch");
  }
  if (binding.execution_domain.kind !== "local") throw new CodexAdapterError("execution_domain_unsupported");
  const projectScopeIds = parsed.projects.map((project) => project.scope_id);
  if (duplicateValues(projectScopeIds)) throw new CodexAdapterError("duplicate_project_scope");
  const configuredScopes = [...binding.allowed_scope_ids].sort();
  const routedScopes = [...projectScopeIds].sort();
  if (configuredScopes.length !== routedScopes.length || configuredScopes.some((scopeId, index) => scopeId !== routedScopes[index])) {
    throw new CodexAdapterError("binding_scope_route_mismatch");
  }
  assertAbsolutePath(parsed.socket_path, "socket_path");
  const projects = Object.freeze(parsed.projects.map((project) => Object.freeze({
    scope_id: project.scope_id,
    workspace_roots: Object.freeze(project.workspace_roots.map((root) => assertAbsolutePath(root, "workspace_root"))),
  })));
  return Object.freeze({
    version: 1,
    socketPath: parsed.socket_path,
    ...(parsed.expected_server_id === undefined ? {} : { expectedServerId: parsed.expected_server_id }),
    surface: parsed.surface,
    binding,
    credential: {
      binding,
      secret: parseSecret(parsed.broker_secret_hex),
    },
    projects,
    sessionStartQuery: parsed.session_start_query,
    adapterVersion: parsed.adapter_version,
    hookTimeoutMs: parsed.hook_timeout_ms,
    requestTimeoutMs: parsed.request_timeout_ms,
  });
}

export function loadCodexAdapterConfig(path: string): CodexAdapterConfig {
  const configPath = assertAbsolutePath(path, "config_path");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch {
    throw new CodexAdapterError("config_unreadable");
  }
  return createCodexAdapterConfig(parsed);
}

/** Resolve one native cwd against the fixed setup-time route table. */
export function resolveProjectScope(cwd: string, routes: readonly CodexProjectRoute[]): CodexProjectRoute {
  try {
    return resolveConfiguredWorkspace(cwd, routes);
  } catch (error: unknown) {
    if (error instanceof CommandHookBoundaryError) throw new CodexAdapterError(error.reason);
    throw error;
  }
}

function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

function correlationFor(hook: CodexHook): { readonly status: "correlated"; readonly basis: "native_ids"; readonly key: string } | { readonly status: "correlation_unknown"; readonly reason: "missing_native_id" | "not_resolved" } {
  const record = hook as Record<string, unknown>;
  const eventId = typeof record.event_id === "string" ? record.event_id : typeof record.hook_event_id === "string" ? record.hook_event_id : undefined;
  const turnId = typeof record.turn_id === "string" ? record.turn_id : undefined;
  const messageId = typeof record.message_id === "string" ? record.message_id : undefined;
  const toolId = typeof record.tool_use_id === "string" ? record.tool_use_id : typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
  let stable: string | undefined = eventId;
  if (stable === undefined && hook.hook_event_name === "PostToolUse") {
    // A turn can contain several tool calls; without the native tool id their
    // fingerprints must remain explicitly unknown instead of colliding.
    stable = toolId;
  } else if (stable === undefined && hook.hook_event_name !== "SessionStart" && hook.hook_event_name !== "Compact" && hook.hook_event_name !== "PreCompact" && hook.hook_event_name !== "PostCompact") {
    stable = turnId ?? messageId;
  }
  if (stable === undefined) return { status: "correlation_unknown", reason: "missing_native_id" };
  const key = createHash("sha256")
    .update(`${hook.session_id}\0${hook.hook_event_name}\0${stable}${toolId === undefined ? "" : `\0${toolId}`}`, "utf8")
    .digest("hex");
  return { status: "correlated", basis: "native_ids", key };
}

function nativeIdsFor(hook: CodexHook): Record<string, string> {
  const record = hook as Record<string, unknown>;
  const ids: Record<string, string> = { session_id: hook.session_id };
  for (const [sourceKey, nativeKey] of [
    ["turn_id", "turn_id"],
    ["message_id", "message_id"],
    ["part_id", "part_id"],
    ["tool_use_id", "tool_call_id"],
    ["tool_call_id", "tool_call_id"],
  ] as const) {
    const value = record[sourceKey];
    if (typeof value === "string" && ids[nativeKey] === undefined) ids[nativeKey] = value;
  }
  return ids;
}

function serializedToolResponse(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
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
  readonly query?: string;
}

function mapHook(hook: CodexHook, coverage: SourceCoverage): MappedHook {
  switch (hook.hook_event_name) {
    case "SessionStart":
      return {
        stage: hook.source === "compact" ? "compaction" : hook.source === "resume" ? "resume" : "session_start",
        coverage,
        shouldRecall: true,
      };
    case "UserPromptSubmit":
      if (hook.prompt.length === 0) throw new CodexAdapterError("prompt_text_missing");
      return { stage: "prompt_submitted", text: hook.prompt, coverage, shouldRecall: true, query: hook.prompt };
    case "PostToolUse":
      {
        const text = serializedToolResponse(hook.tool_response);
      return {
        stage: "tool_result",
        ...(text === undefined ? {} : { text }),
        outcome: "unknown",
        coverage,
        shouldRecall: false,
      };
      }
    case "Stop":
      return {
        stage: hook.last_assistant_message ? "assistant_final" : "stop",
        ...(hook.last_assistant_message === undefined || hook.last_assistant_message === null || hook.last_assistant_message.length === 0
          ? {}
          : { text: hook.last_assistant_message }),
        coverage:
          hook.last_assistant_message === undefined || hook.last_assistant_message === null || hook.last_assistant_message.length === 0
            ? { status: "coverage_gap", reason: "event_not_observed" }
            : coverage,
        shouldRecall: false,
      };
    case "PreCompact":
    case "PostCompact":
    case "Compact":
      return { stage: "compaction", coverage, shouldRecall: false };
  }
}

function parseCodexHook(input: unknown): CodexHook {
  try {
    parseBoundedHook(input);
    return parseContract(codexHookSchema, input, "codex-hook");
  } catch (error: unknown) {
    if (error instanceof CodexAdapterError) throw error;
    throw new CodexAdapterError("hook_invalid");
  }
}

function parseBoundedHook(input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new CodexAdapterError("hook_object_required");
  // The event remains untrusted even after shape parsing; this check prevents
  // a permissive passthrough schema from accepting an oversized object.
  if (Object.keys(input).length > 256) throw new CodexAdapterError("hook_too_large");
  validateBoundedJson(input, { max_depth: MAX_HOOK_DEPTH, max_bytes: MAX_HOOK_BYTES, max_nodes: MAX_HOOK_NODES }, "codex-hook");
  const serialized = JSON.stringify(input);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_HOOK_BYTES) throw new CodexAdapterError("hook_too_large");
}

export async function captureWithRetry(
  client: CodexBrokerClient,
  event: NormalizedNativeEvent,
  options?: ImmutableCaptureRetryOptions,
): Promise<CaptureAck> {
  return captureWithImmutableRetry(client, event, options);
}

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

function outputForPacket(hookEventName: string, packet: EvidencePacket, maxBytes: number, status?: string): CodexHookOutput {
  const additionalContext = status === undefined ? serializeModelContext(packet) : serializeModelContextWithStatus(packet, status);
  if (Buffer.byteLength(additionalContext, "utf8") > maxBytes) throw new CodexAdapterError("additional_context_too_large");
  return {
    ...(status === undefined ? {} : { systemMessage: status }),
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

async function sessionStatusFor(client: CodexBrokerClient, host: SessionHost): Promise<AgentMemorySessionStatus> {
  if (client.rpc === undefined) return connectedSessionStatus(host);
  try {
    return sessionStatusFromBackend(host, await client.rpc({ kind: "control", operation: "status" }));
  } catch {
    return connectedSessionStatus(host);
  }
}

function degradedResult(hookEventName: string | undefined, coverage: SourceCoverage, recognizedOwnContext?: boolean): CodexAdapterResult {
  return {
    status: "degraded",
    response: { continue: true, systemMessage: DEGRADED_MESSAGE },
    ...(hookEventName === undefined ? {} : { hookEventName }),
    coverage,
    ...(recognizedOwnContext === undefined ? {} : { recognizedOwnContext }),
  };
}

function unsupportedResult(hookEventName: string | undefined): CodexAdapterResult {
  return {
    status: "unsupported",
    response: { continue: true, systemMessage: DEGRADED_MESSAGE },
    ...(hookEventName === undefined ? {} : { hookEventName }),
    coverage: emptyCoverage,
  };
}

const emptyCoverage: SourceCoverage = { status: "coverage_gap", reason: "adapter_gap" };

export class CodexHostAdapter {
  private readonly config: CodexAdapterConfig;
  private readonly clientPool: NativeSessionClientPool<CodexBrokerClient>;
  private readonly clock: () => Date;

  constructor(config: CodexAdapterConfig, options: CodexHostAdapterOptions = {}) {
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

  async handleHook(input: unknown, deadline?: CommandHookDeadline): Promise<CodexAdapterResult> {
    let hook: CodexHook;
    try {
      hook = parseCodexHook(input);
      deadline?.throwIfExpired();
    } catch (error: unknown) {
      return unsupportedResult(undefined);
    }
    let route: CodexProjectRoute;
    try {
      route = resolveProjectScope(hook.cwd, this.config.projects);
      deadline?.throwIfExpired();
    } catch {
      return degradedResult(hook.hook_event_name, { status: "coverage_gap", reason: "adapter_gap" });
    }
    let client: CodexBrokerClient;
    // These results already come from this memory store. Saving them again
    // would turn retrieved evidence into increasingly duplicated new evidence.
    if (hook.hook_event_name === "PostToolUse" &&
      ["memory_recall", "memory_get", "memory_forget", "memory_write"].some(name => ownMemoryMcpServerNames.some(server => hook.tool_name === `mcp__${server}__${name}`))) {
      return { status: "completed", response: {}, hookEventName: hook.hook_event_name, coverage: { status: "complete" } };
    }
    try {
      client = await this.clientFor(hook.session_id);
      deadline?.throwIfExpired();
    } catch {
      return degradedResult(hook.hook_event_name, { status: "coverage_gap", reason: "host_dropped" });
    }
    const mapped = (() => {
      try {
        return mapHook(hook, { status: "complete" });
      } catch {
        return undefined;
      }
    })();
    if (mapped === undefined) return unsupportedResult(hook.hook_event_name);
    if (hook.hook_event_name === "UserPromptSubmit") {
      const ownCandidate = ownWrapperCandidate(hook.prompt);
      if (ownCandidate !== undefined) {
        try {
          deadline?.throwIfExpired();
          if (await client.recognizeContext(ownCandidate)) {
            deadline?.throwIfExpired();
            return {
              status: "completed",
              response: {},
              hookEventName: hook.hook_event_name,
              coverage: mapped.coverage,
              recognizedOwnContext: true,
            };
          }
        } catch {
          // A failed recognition must never suppress the actual user prompt.
        }
      }
    }
    const stableCorrelation = correlationFor(hook);
    const stableFingerprint = stableCorrelation.status === "correlated"
      ? `${this.config.binding.binding_id}\0${route.scope_id}\0${stableCorrelation.key}`
      : undefined;
    const captureId = stableFingerprint === undefined ? randomUUID() : deterministicUuid(`codex-capture:v1\0${stableFingerprint}`);
    const capturedAt = this.clock().toISOString();
    const nativeInput: NativeEventInput = {
      version: 1,
      capture_id: captureId,
      scope_id: route.scope_id,
      adapter_version: this.config.adapterVersion,
      stage: mapped.stage,
      native_ids: nativeIdsFor(hook),
      ...(mapped.text === undefined ? {} : { text: mapped.text }),
      ...(mapped.outcome === undefined ? {} : { outcome: mapped.outcome }),
      payload: hook,
      captured_at: capturedAt,
      truncation: { truncated: false },
      coverage: mapped.coverage,
      correlation: stableCorrelation,
    };
    let event: NormalizedNativeEvent;
    try {
      deadline?.throwIfExpired();
      event = normalizeNativeEvent(nativeInput, client.connectedBinding);
      const registeredSessionId = client.registeredSessionIds.get(route.scope_id);
      if (registeredSessionId === undefined || registeredSessionId.length === 0) throw new CodexAdapterError("session_registration_missing");
      deadline?.throwIfExpired();
      const ack = await captureWithRetry(
        client,
        event,
        deadline === undefined
          ? undefined
          : { signal: deadline.signal, onAbort: () => client.close() },
      );
      deadline?.throwIfExpired();
      if (!mapped.shouldRecall) {
        return { status: "completed", response: {}, hookEventName: hook.hook_event_name, captureAck: ack, event, coverage: mapped.coverage };
      }
      const kind: "session_start" | "user_prompt" = hook.hook_event_name === "UserPromptSubmit" ? "user_prompt" : "session_start";
      const contextBytes = kind === "session_start" ? CODEX_SESSION_START_UTF8_BYTES : CODEX_PROMPT_UTF8_BYTES;
      const maxBytes = kind === "session_start" ? CODEX_SESSION_START_MAX_BYTES : CODEX_PROMPT_MAX_BYTES;
      const deadlineAt = new Date(this.clock().getTime() + this.config.hookTimeoutMs).toISOString();
      const contextInput = {
        version: 1 as const,
        kind,
        deadline_at: deadlineAt,
        exclude_current_session_prompts: true,
        capture_status: { state: "committed" as const, capture_id: ack.capture_id },
        budget: {
          profile: { unit: "utf8_bytes" as const, limit: contextBytes },
          automatic_tokens: CODEX_PROMPT_UTF8_BYTES,
          session_start_tokens: CODEX_SESSION_START_UTF8_BYTES,
          max_bytes: CODEX_PROMPT_MAX_BYTES,
          session_start_max_bytes: CODEX_SESSION_START_MAX_BYTES,
          reserve_bytes: 1_024,
        },
      };
      const query = mapped.query ?? this.config.sessionStartQuery;
      const request = {
        query,
        scope_ids: [route.scope_id],
        mode: "current" as const,
        token_budget: contextBytes,
      };
      // Send only the strict wire DTO. The broker validates and brands its
      // own PreparationContext against the authenticated effective binding;
      // a local branded object would carry binding_id and be rejected by the
      // wire schema.
      const packet = await client.recall(request, contextInput);
      deadline?.throwIfExpired();
      const status = kind === "session_start"
        ? formatSessionStatus(await sessionStatusFor(client, this.config.surface === "codex_desktop" ? "Codex Desktop" : "Codex CLI"))
        : undefined;
      const response = outputForPacket(hook.hook_event_name, packet, maxBytes, status);
      return { status: "completed", response, hookEventName: hook.hook_event_name, captureAck: ack, event, coverage: mapped.coverage };
    } catch {
      return degradedResult(hook.hook_event_name, mapped.coverage);
    }
  }

  async close(): Promise<void> {
    await this.clientPool.close();
  }

  private async clientFor(nativeSessionId: string): Promise<CodexBrokerClient> {
    const client = await this.clientPool.get(nativeSessionId);
    const expected = createNativeSessionBinding(this.config.binding, nativeSessionId);
    if (authorityKey(client.connectedBinding) !== authorityKey(expected)) {
      throw new CodexAdapterError("native_session_binding_mismatch");
    }
    return client;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderCodexHookCommand(options: { readonly nodePath: string; readonly helperPath: string; readonly configPath: string }): string {
  const nodePath = assertAbsolutePath(options.nodePath, "node_path");
  const helperPath = assertAbsolutePath(options.helperPath, "helper_path");
  const configPath = assertAbsolutePath(options.configPath, "config_path");
  try {
    const nodeStat = statSync(nodePath);
    const helperStat = statSync(helperPath);
    if (!nodeStat.isFile() || (nodeStat.mode & 0o111) === 0 || !helperStat.isFile() || (helperStat.mode & 0o444) === 0) {
      throw new Error("not_executable_file");
    }
  } catch {
    throw new CodexAdapterError("helper_path_unavailable");
  }
  return `${shellQuote(nodePath)} ${shellQuote(helperPath)} --config ${shellQuote(configPath)}`;
}

export async function runCodexHookFromStdin(configPath: string): Promise<void> {
  let config: CodexAdapterConfig;
  try {
    config = loadCodexAdapterConfig(configPath);
  } catch {
    process.stdout.write(`${JSON.stringify({ continue: true, systemMessage: DEGRADED_MESSAGE })}\n`);
    return;
  }
  try {
    const project = config.projects[0]?.workspace_roots[0];
    if (project !== undefined) await ensureOwnedBrokerForConnection(configPath, project, "codex");
  } catch {
    // The adapter remains fail-open; the normal hook path reports degraded.
  }
  const adapter = new CodexHostAdapter(config);
  await runBoundedCommandHook({
    timeoutMs: config.hookTimeoutMs,
    maxInputBytes: MAX_HOOK_BYTES,
    handle: async (text, deadline) => {
      const input = JSON.parse(text) as unknown;
      return adapter.handleHook(input, deadline);
    },
    cleanup: () => adapter.close(),
    writeOutput: (result) => process.stdout.write(`${JSON.stringify(result.response)}\n`),
    writeFallback: () => process.stdout.write(`${JSON.stringify({ continue: true, systemMessage: DEGRADED_MESSAGE })}\n`),
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--config" || argv[1] === undefined || !isAbsolute(argv[1])) {
    process.stdout.write(`${JSON.stringify({ continue: true, systemMessage: DEGRADED_MESSAGE })}\n`);
    return;
  }
  await runCodexHookFromStdin(argv[1]);
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  void main();
}
