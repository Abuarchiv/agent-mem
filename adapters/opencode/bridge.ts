import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  AgentMemoryBrokerClient,
  BrokerError,
  type BrokerBindingCredential,
  type BrokerClientOptions,
} from "../../src/host/broker.js";
import {
  createNativeSessionBinding,
  createTrustedBinding,
  correlationSchema,
  evidenceClassSchema,
  nativeIdsSchema,
  nativeObservationIdentitySchema,
  nativeReconcileCoverageSchema,
  nativeReconcileCursorSchema,
  nonNegativeInt64Schema,
  nativeEventStageSchema,
  parseContract,
  parseCaptureAck,
  sourceCoverageSchema,
  sourceRevisionKindSchema,
  sourceRoleSchema,
  acceptanceLevelSchema,
  type CaptureAck,
  type EvidencePacket,
  type TrustedBinding,
} from "../../src/host/contract.js";
import { normalizeNativeEvent, type NativeEventInput } from "../../src/host/events.js";
import {
  CommandHookBoundaryError,
  NativeSessionClientPool,
  resolveConfiguredWorkspace,
  type CommandHookWorkspaceRoute,
  type NativeSessionClient,
} from "../../src/host/command-hook.js";
import { encodeFrame, IpcProtocolError, NdjsonDecoder } from "../../src/host/ipc.js";
import type {
  OpenCodeBridgeEvent,
  OpenCodeBridgeRequest,
  OpenCodeReconcileGap,
  OpenCodeReconcileObservation,
  OpenCodeReconcileResult,
} from "./bridge-client.js";
import { ensureOwnedBrokerForConnection } from "../../src/v1/recovery.js";

export const OPENCODE_NATIVE_VERSION = "1.18.30" as const;
export const OPENCODE_ADAPTER_VERSION = "1.0.0" as const;
export const OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
export const OPENCODE_DEFAULT_MAX_FRAME_BYTES = 4_500_000;
export const OPENCODE_MAX_PENDING = 32;
const OPENCODE_SESSION_START_CONTEXT_UTF8_BYTES = 4_000;
const OPENCODE_PROMPT_CONTEXT_UTF8_BYTES = 8_000;

const pathSchema = z.string().min(1).max(4_096);
const opaqueIdSchema = z.string().min(1).max(256);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const projectRouteSchema = z
  .object({
    scope_id: z.uuid(),
    workspace_roots: z.array(pathSchema).min(1).max(32),
  })
  .strict();

const bridgeEventSchema = z
  .object({
    capture_id: z.uuid().optional(),
    stage: nativeEventStageSchema,
    role: sourceRoleSchema.optional(),
    evidence_class: evidenceClassSchema.optional(),
    native_ids: nativeIdsSchema.optional(),
    text: z.string().max(1_000_000).optional(),
    outcome: z.enum(["succeeded", "failed", "unknown"]).optional(),
    payload: z.record(z.string().min(1).max(256), z.json()),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
    truncation: z
      .object({
        truncated: z.boolean(),
        omitted_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .optional(),
    coverage: sourceCoverageSchema,
    correlation: correlationSchema.optional(),
    revision: z
      .object({
        revision_id: z.uuid().optional(),
        revision_kind: sourceRevisionKindSchema,
        parent_revision_id: z.uuid().optional(),
      })
      .strict()
      .optional(),
    acceptance_level: acceptanceLevelSchema.optional(),
  })
  .strict();

const reconcileScanSchema = z.object({
  scan_id: z.uuid(),
  scope_id: z.uuid(),
  binding_id: z.uuid(),
  native_session_id: opaqueIdSchema,
  watermark: nonNegativeInt64Schema,
  cursor: nativeReconcileCursorSchema.nullable(),
  state: z.enum(["active", "completed", "invalidated"]),
  coverage: nativeReconcileCoverageSchema,
}).strict();

const bridgeRequestSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("create_handoff"), request_id: z.uuid(),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), native_session_id: opaqueIdSchema, cwd: pathSchema,
    target_binding_id: z.uuid(), context: z.json() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("reconcile_start"), request_id: z.uuid(), seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), native_session_id: opaqueIdSchema, cwd: pathSchema }).strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("open_session"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("capture"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
      event: bridgeEventSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("observe"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
      event: bridgeEventSchema,
      identity: nativeObservationIdentitySchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("reconcile"),
      scan: reconcileScanSchema.optional(),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
      observations: z.array(z.object({ identity: nativeObservationIdentitySchema, event: bridgeEventSchema }).strict()).max(128),
      cursor: nativeReconcileCursorSchema.nullable(),
      complete: z.boolean(),
      gaps: z.array(z.object({ identity_key: z.string().min(1).max(1_024), reason: z.string().min(1).max(128) }).strict()).max(128),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("recall"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
      query: z.string().min(1).max(100_000).optional(),
      mode: z.enum(["current", "historical", "timeline"]),
      token_budget: z.number().int().min(1).max(200_000),
      kind_hint: z.enum(["session_start", "user_prompt"]),
      deadline_at: z.iso.datetime({ offset: true }),
      capture_status: z.discriminatedUnion("state", [
        z.object({ state: z.literal("committed"), capture_id: z.uuid() }).strict(),
        z.object({ state: z.literal("failed") }).strict(),
        z.object({ state: z.literal("not_attempted") }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("recognize_context"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      native_session_id: opaqueIdSchema,
      cwd: pathSchema,
      context: z.json(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("close"),
      request_id: z.uuid(),
      seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);


const bridgeConfigSchema = z
  .object({
    version: z.literal(1),
    // Accept the previous setup tag while all newly generated configs use 1.18.30.
    native_version: z.union([z.literal(OPENCODE_NATIVE_VERSION), z.literal("1.18.29")]),
    socket_path: pathSchema,
    expected_server_id: z.uuid().optional(),
    surface: z.literal("opencode_cli"),
    binding: z.unknown(),
    broker_secret_hex: z
      .string()
      .regex(/^[a-fA-F0-9]+$/)
      .refine((value) => value.length >= 64 && value.length % 2 === 0, {
        message: "broker_secret_hex must contain at least 32 bytes",
      }),
    projects: z.array(projectRouteSchema).min(1).max(32),
    session_start_query: z.string().min(1).max(100_000),
    adapter_version: versionSchema.default(OPENCODE_ADAPTER_VERSION),
    request_timeout_ms: z.number().int().min(50).max(30_000).default(OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS),
    max_frame_bytes: z.number().int().min(1_024).max(OPENCODE_DEFAULT_MAX_FRAME_BYTES).default(OPENCODE_DEFAULT_MAX_FRAME_BYTES),
    session_start_max_bytes: z.number().int().min(1_024).max(4_000_000).default(24 * 1024),
    prompt_max_bytes: z.number().int().min(1_024).max(4_000_000).default(64 * 1024),
  })
  .strict();

export interface OpenCodeProjectRoute extends CommandHookWorkspaceRoute {
  readonly scope_id: string;
}

export interface OpenCodeBridgeConfig {
  readonly version: 1;
  readonly nativeVersion: typeof OPENCODE_NATIVE_VERSION;
  readonly socketPath: string;
  readonly expectedServerId?: string;
  readonly surface: "opencode_cli";
  readonly binding: TrustedBinding;
  readonly credential: BrokerBindingCredential;
  readonly projects: readonly OpenCodeProjectRoute[];
  readonly sessionStartQuery: string;
  readonly adapterVersion: string;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly sessionStartMaxBytes: number;
  readonly promptMaxBytes: number;
}

export class OpenCodeBridgeServerError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OpenCodeBridgeServerError";
  }
}

function assertAbsolute(path: string, name: string): string {
  if (!isAbsolute(path)) throw new OpenCodeBridgeServerError(`${name}_must_be_absolute`);
  return path;
}

function parseSecret(value: string): Buffer {
  const secret = Buffer.from(value, "hex");
  if (secret.length < 32) throw new OpenCodeBridgeServerError("broker_secret_too_short");
  return secret;
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function observationKey(identity: z.infer<typeof nativeObservationIdentitySchema>): string {
  return identity.kind === "event"
    ? identity.key
    : `${identity.session_id}\u0000${identity.message_id}\u0000${identity.part_id}`;
}

export function createOpenCodeBridgeConfig(input: unknown): OpenCodeBridgeConfig {
  let parsed: z.infer<typeof bridgeConfigSchema>;
  try {
    parsed = parseContract(bridgeConfigSchema, input, "opencode-bridge-config");
  } catch {
    throw new OpenCodeBridgeServerError("config_invalid");
  }
  let binding: TrustedBinding;
  try {
    binding = createTrustedBinding(parsed.binding);
  } catch {
    throw new OpenCodeBridgeServerError("binding_invalid");
  }
  if (binding.host_kind !== "opencode" || binding.surface !== "opencode_cli") {
    throw new OpenCodeBridgeServerError("binding_surface_mismatch");
  }
  if (binding.execution_domain.kind !== "local") throw new OpenCodeBridgeServerError("execution_domain_unsupported");
  const projectScopeIds = parsed.projects.map((project) => project.scope_id);
  if (duplicate(projectScopeIds)) throw new OpenCodeBridgeServerError("duplicate_project_scope");
  const bindingScopes = [...binding.allowed_scope_ids].sort();
  const routedScopes = [...projectScopeIds].sort();
  if (bindingScopes.length !== routedScopes.length || bindingScopes.some((scope, index) => scope !== routedScopes[index])) {
    throw new OpenCodeBridgeServerError("binding_scope_route_mismatch");
  }
  assertAbsolute(parsed.socket_path, "socket_path");
  const projects = Object.freeze(
    parsed.projects.map((project) =>
      Object.freeze({
        scope_id: project.scope_id,
        workspace_roots: Object.freeze(project.workspace_roots.map((root) => assertAbsolute(root, "workspace_root"))),
      }),
    ),
  );
  return Object.freeze({
    version: 1,
    nativeVersion: OPENCODE_NATIVE_VERSION,
    socketPath: parsed.socket_path,
    ...(parsed.expected_server_id === undefined ? {} : { expectedServerId: parsed.expected_server_id }),
    surface: "opencode_cli",
    binding,
    credential: { binding, secret: parseSecret(parsed.broker_secret_hex) },
    projects,
    sessionStartQuery: parsed.session_start_query,
    adapterVersion: parsed.adapter_version,
    requestTimeoutMs: parsed.request_timeout_ms,
    maxFrameBytes: parsed.max_frame_bytes,
    sessionStartMaxBytes: parsed.session_start_max_bytes,
    promptMaxBytes: parsed.prompt_max_bytes,
  });
}

export function loadOpenCodeBridgeConfig(path: string): OpenCodeBridgeConfig {
  assertAbsolute(path, "config_path");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new OpenCodeBridgeServerError("config_unreadable");
  }
  return createOpenCodeBridgeConfig(input);
}

interface BridgeSessionClient extends NativeSessionClient {
  readonly registeredSessionIds: ReadonlyMap<string, string>;
  capture(event: unknown): Promise<CaptureAck>;
  nativeObserve?(operation: unknown): Promise<unknown>;
  recall(request: unknown, context: unknown): Promise<EvidencePacket>;
  recognizeContext(context: unknown): Promise<boolean>;
  createHandoff?(targetBindingId: string, context: unknown): Promise<string>;
}

export interface OpenCodeBridgeServiceOptions {
  readonly clientFactory?: (options: BrokerClientOptions) => BridgeSessionClient;
  readonly clock?: () => Date;
  readonly maxSessions?: number;
}

function authorityKey(binding: TrustedBinding): string {
  return JSON.stringify({
    version: binding.version,
    binding_id: binding.binding_id,
    host_kind: binding.host_kind,
    surface: binding.surface,
    execution_domain: { ...binding.execution_domain },
    host_instance_id: binding.host_instance_id,
    host_session_id: binding.host_session_id,
    allowed_scope_ids: [...binding.allowed_scope_ids],
    egress: { ...binding.egress, reader_targets: [...binding.egress.reader_targets], provider_targets: [...binding.egress.provider_targets] },
  });
}

function firstSeenKey(binding: TrustedBinding, captureId: string): string {
  return `${binding.binding_id}\0${captureId}`;
}

/** Service implementation run only in the explicitly spawned Node helper. */
export class OpenCodeBridgeService {
  private readonly config: OpenCodeBridgeConfig;
  private readonly clock: () => Date;
  private readonly pool: NativeSessionClientPool<BridgeSessionClient>;
  private readonly firstSeen = new Map<string, string>();
  private readonly reconcileTails = new Map<string, Promise<OpenCodeReconcileResult>>();

  constructor(config: OpenCodeBridgeConfig, options: OpenCodeBridgeServiceOptions = {}) {
    this.config = config;
    this.clock = options.clock ?? (() => new Date());
    const clientFactory = options.clientFactory ?? ((clientOptions) => new AgentMemoryBrokerClient(clientOptions));
    this.pool = new NativeSessionClientPool({
      clientFactory,
      clientOptions: {
        socketPath: config.socketPath,
        credential: config.credential,
        ...(config.expectedServerId === undefined ? {} : { expectedServerId: config.expectedServerId }),
        requestTimeoutMs: config.requestTimeoutMs,
        maxFrameBytes: config.maxFrameBytes,
      },
      maxSessions: options.maxSessions ?? 32,
    });
  }

  async handle(requestInput: unknown): Promise<Record<string, unknown>> {
    const request = bridgeRequestSchema.safeParse(requestInput);
    if (!request.success) throw new OpenCodeBridgeServerError("request_invalid");
    switch (request.data.kind) {
      case "open_session": {
        this.resolveRoute(request.data.cwd);
        await this.clientFor(request.data.native_session_id);
        return { kind: "session_ready", native_session_id: request.data.native_session_id };
      }
      case "capture":
        return { kind: "capture_ack", ack: await this.capture(request.data) };
      case "observe":
        return { kind: "observe_ack", ack: await this.observe(request.data) };
      case "reconcile_start": {
        const route = this.resolveRoute(request.data.cwd);
        const client = await this.clientFor(request.data.native_session_id);
        if (client.nativeObserve === undefined) throw new OpenCodeBridgeServerError("native_observation_unavailable");
        return { kind: "reconcile_start_response", scan: await client.nativeObserve({ operation: "scan_start", scope_id: route.scope_id }) };
      }
      case "reconcile":
        return { kind: "reconcile_response", result: await this.reconcileSerial(request.data) };
      case "recall":
        return { kind: "recall_response", packet: await this.recall(request.data) };
      case "create_handoff": {
        const route = this.resolveRoute(request.data.cwd);
        const client = await this.clientFor(request.data.native_session_id);
        if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
        if (client.createHandoff === undefined) throw new OpenCodeBridgeServerError("handoff_unavailable");
        return { kind: "create_handoff_response", wire: await client.createHandoff(request.data.target_binding_id, request.data.context) };
      }
      case "recognize_context": {
        const route = this.resolveRoute(request.data.cwd);
        const client = await this.clientFor(request.data.native_session_id);
        if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
        return { kind: "recognize_context_response", recognized: await client.recognizeContext(request.data.context) };
      }
      case "close":
        await this.close();
        return { kind: "closed" };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.reconcileTails.values()]);
    await this.pool.close();
    this.firstSeen.clear();
    this.reconcileTails.clear();
  }

  private resolveRoute(cwd: string): OpenCodeProjectRoute {
    try {
      return resolveConfiguredWorkspace(cwd, this.config.projects);
    } catch (error: unknown) {
      if (error instanceof CommandHookBoundaryError) throw new OpenCodeBridgeServerError(error.reason);
      throw error;
    }
  }

  private async clientFor(nativeSessionId: string): Promise<BridgeSessionClient> {
    const client = await this.pool.get(nativeSessionId);
    const expected = createNativeSessionBinding(this.config.binding, nativeSessionId);
    if (authorityKey(client.connectedBinding) !== authorityKey(expected)) {
      throw new OpenCodeBridgeServerError("native_session_binding_mismatch");
    }
    return client;
  }

  private async capture(request: Extract<z.infer<typeof bridgeRequestSchema>, { kind: "capture" }>): Promise<CaptureAck> {
    const route = this.resolveRoute(request.cwd);
    const client = await this.clientFor(request.native_session_id);
    if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
    const normalized = this.normalizeEvent(request.native_session_id, route.scope_id, request.event, client.connectedBinding);
    return client.capture(normalized);
  }

  private async observe(request: Extract<z.infer<typeof bridgeRequestSchema>, { kind: "observe" }>): Promise<CaptureAck> {
    const route = this.resolveRoute(request.cwd);
    const client = await this.clientFor(request.native_session_id);
    if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
    if (client.nativeObserve === undefined) throw new OpenCodeBridgeServerError("native_observation_unavailable");
    const normalized = this.normalizeEvent(request.native_session_id, route.scope_id, request.event, client.connectedBinding);
    const result = await client.nativeObserve({
      operation: "capture",
      scope_id: route.scope_id,
      event: normalized,
      observation: { version: 1, identity: request.identity },
    });
    try {
      return parseCaptureAck(result);
    } catch {
      throw new OpenCodeBridgeServerError("invalid_frame");
    }
  }

  private normalizeEvent(nativeSessionId: string, scopeId: string, event: OpenCodeBridgeEvent, binding: TrustedBinding): ReturnType<typeof normalizeNativeEvent> {
    const observedAt = this.clock().toISOString();
    const providedSessionId = event.native_ids?.session_id;
    if (providedSessionId !== undefined && providedSessionId !== nativeSessionId) {
      throw new OpenCodeBridgeServerError("native_session_id_mismatch");
    }
    const captureId = event.capture_id;
    const seenKey = captureId === undefined ? undefined : firstSeenKey(binding, captureId);
    const capturedAt = seenKey === undefined ? observedAt : this.firstSeen.get(seenKey) ?? observedAt;
    const nativeInput: NativeEventInput = {
      version: 1,
      ...(captureId === undefined ? {} : { capture_id: captureId }),
      scope_id: scopeId,
      adapter_version: this.config.adapterVersion,
      stage: event.stage,
      ...(event.role === undefined ? {} : { role: event.role }),
      ...(event.evidence_class === undefined ? {} : { evidence_class: event.evidence_class }),
      native_ids: { ...(event.native_ids ?? {}), session_id: nativeSessionId },
      ...(event.text === undefined ? {} : { text: event.text }),
      ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      payload: event.payload,
      captured_at: capturedAt,
      ...(event.occurred_at === undefined ? {} : { occurred_at: event.occurred_at }),
      ...(event.truncation === undefined ? {} : { truncation: event.truncation }),
      coverage: event.coverage,
      ...(event.correlation === undefined ? {} : { correlation: event.correlation }),
      ...(event.revision === undefined ? {} : { revision: event.revision }),
      ...(event.acceptance_level === undefined ? {} : { acceptance_level: event.acceptance_level }),
    };
    let normalized: ReturnType<typeof normalizeNativeEvent>;
    try {
      normalized = normalizeNativeEvent(nativeInput, binding);
    } catch {
      throw new OpenCodeBridgeServerError("contract_invalid");
    }
    if (seenKey !== undefined && !this.firstSeen.has(seenKey)) {
      this.firstSeen.set(seenKey, capturedAt);
      if (this.firstSeen.size > 1_024) {
        const oldest = this.firstSeen.keys().next().value;
        if (typeof oldest === "string") this.firstSeen.delete(oldest);
      }
    }
    return normalized;
  }

  private async reconcile(request: Extract<z.infer<typeof bridgeRequestSchema>, { kind: "reconcile" }>): Promise<OpenCodeReconcileResult> {
    const route = this.resolveRoute(request.cwd);
    const client = await this.clientFor(request.native_session_id);
    if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
    if (client.nativeObserve === undefined) throw new OpenCodeBridgeServerError("native_observation_unavailable");
    const scanValue = request.scan ?? await client.nativeObserve({ operation: "scan_start", scope_id: route.scope_id });
    const scan = parseContract(reconcileScanSchema, scanValue, "opencode-reconcile-scan");
    if (scan.scope_id !== route.scope_id || scan.native_session_id !== request.native_session_id) {
      throw new OpenCodeBridgeServerError("native_session_binding_mismatch");
    }
    const gaps: OpenCodeReconcileGap[] = request.gaps.slice(0, 125);
    if (request.gaps.length > 125) gaps.push({ identity_key: "coverage", reason: "coverage_details_truncated" });
    if (request.scan === undefined && request.observations.length > 0) gaps.push({ identity_key: "history", reason: "snapshot_freshness_unproven" });
    const acknowledgements: CaptureAck[] = [];
    const transportGaps: OpenCodeReconcileGap[] = [];
    for (const observation of request.observations as readonly OpenCodeReconcileObservation[]) {
      const identityKey = observationKey(observation.identity);
      try {
        const normalized = this.normalizeEvent(request.native_session_id, route.scope_id, observation.event, client.connectedBinding);
        const result = await client.nativeObserve({
          operation: "capture",
          scope_id: route.scope_id,
          event: normalized,
          observation: {
            version: 1,
            // Host-supplied snapshots have no pre-read watermark. They may fill
            // an absent address or ACK the identical current state, never replace it.
            identity: request.scan === undefined && observation.identity.kind === "part_snapshot"
              ? { ...observation.identity, expected_generation: "0" }
              : observation.identity,
            scan_id: scan.scan_id,
            scan_watermark: scan.watermark,
          },
        });
        acknowledgements.push(parseCaptureAck(result));
      } catch (error: unknown) {
        transportGaps.push({
          identity_key: identityKey,
          reason: error instanceof BrokerError ? error.code : error instanceof OpenCodeBridgeServerError ? error.reason : "capture_failed",
        });
        break;
      }
    }
    if (transportGaps.length > 0) {
      try {
        const invalidated = await client.nativeObserve({
          operation: "advance_cursor",
          scan_id: scan.scan_id,
          cursor: scan.cursor,
          capture_ids: acknowledgements.map((ack) => ack.capture_id),
          complete: false,
          coverage: { status: "coverage_gap", reason: "native_reconcile_gap", gaps: [...gaps, ...transportGaps].slice(0, 128) },
        });
        return { scan: parseContract(reconcileScanSchema, invalidated, "opencode-reconcile-scan"), acknowledgements, cursor_committed: false, gaps: [...gaps, ...transportGaps] };
      } catch {
        return { scan, acknowledgements, cursor_committed: false, gaps: [...gaps, ...transportGaps] };
      }
    }
    try {
      const advanced = await client.nativeObserve({
        operation: "advance_cursor",
        scan_id: scan.scan_id,
        cursor: request.cursor,
        capture_ids: acknowledgements.map((ack) => ack.capture_id),
        complete: request.complete,
        coverage: gaps.length === 0 ? { status: "complete" } : { status: "partial", reason: "native_reconcile_gap", gaps: gaps.slice(0, 128) },
      });
      return { scan: parseContract(reconcileScanSchema, advanced, "opencode-reconcile-scan"), acknowledgements, cursor_committed: true, gaps: [...gaps, ...transportGaps] };
    } catch (error: unknown) {
      return {
        scan,
        acknowledgements,
        cursor_committed: false,
        gaps: [...gaps, ...transportGaps, { identity_key: "cursor", reason: error instanceof BrokerError ? error.code : "cursor_conflict" }],
      };
    }
  }

  private async reconcileSerial(request: Extract<z.infer<typeof bridgeRequestSchema>, { kind: "reconcile" }>): Promise<OpenCodeReconcileResult> {
    const previous = this.reconcileTails.get(request.native_session_id);
    const run = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined)).then(() => this.reconcile(request));
    const tracked = run.finally(() => {
      if (this.reconcileTails.get(request.native_session_id) === tracked) this.reconcileTails.delete(request.native_session_id);
    });
    this.reconcileTails.set(request.native_session_id, tracked);
    return run;
  }

  private async recall(request: Extract<z.infer<typeof bridgeRequestSchema>, { kind: "recall" }>): Promise<EvidencePacket> {
    const route = this.resolveRoute(request.cwd);
    const client = await this.clientFor(request.native_session_id);
    if (!client.registeredSessionIds.has(route.scope_id)) throw new OpenCodeBridgeServerError("session_registration_missing");
    const deadlineMs = Date.parse(request.deadline_at);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw new OpenCodeBridgeServerError("deadline");
    const query = request.query ?? this.config.sessionStartQuery;
    const contextInput = {
      version: 1 as const,
      kind: request.kind_hint,
      deadline_at: request.deadline_at,
      exclude_current_session_prompts: true,
      capture_status: request.capture_status,
      // The legacy token_budget request caps profile units; packet/trace units are utf8_bytes.
      budget: {
        profile: {
          unit: "utf8_bytes" as const,
          limit: request.kind_hint === "session_start" ? OPENCODE_SESSION_START_CONTEXT_UTF8_BYTES : OPENCODE_PROMPT_CONTEXT_UTF8_BYTES,
        },
        automatic_tokens: OPENCODE_PROMPT_CONTEXT_UTF8_BYTES,
        session_start_tokens: OPENCODE_SESSION_START_CONTEXT_UTF8_BYTES,
        max_bytes: this.config.promptMaxBytes,
        session_start_max_bytes: this.config.sessionStartMaxBytes,
        reserve_bytes: 1_024,
      },
    };
    const recallRequest = {
      query,
      scope_ids: [route.scope_id],
      mode: request.mode,
      token_budget: request.token_budget,
    };
    return client.recall(recallRequest, contextInput);
  }
}

interface BridgeFrameResponse {
  readonly version: 1;
  readonly kind: string;
  readonly request_id: string;
  readonly seq: number;
  readonly [key: string]: unknown;
}

function responseFrame(request: OpenCodeBridgeRequest, body: Record<string, unknown>): BridgeFrameResponse {
  return { version: 1, request_id: request.request_id, seq: request.seq, ...body } as BridgeFrameResponse;
}

function errorCode(error: unknown): string {
  const candidate = error instanceof OpenCodeBridgeServerError
    ? error.reason
    : error instanceof BrokerError
      ? error.code
      : error instanceof IpcProtocolError
        ? error.code
        : "bridge_failed";
  if (/^[a-z][a-z0-9_]{1,63}$/.test(candidate)) return candidate;
  return "bridge_failed";
}

/** Run the persistent helper's bounded NDJSON server on stdin/stdout. */
export async function runOpenCodeBridgeFromStdin(configPath: string): Promise<void> {
  let config: OpenCodeBridgeConfig;
  try {
    config = loadOpenCodeBridgeConfig(configPath);
  } catch (error: unknown) {
    const payload = { version: 1, kind: "error", code: errorCode(error) };
    try {
      process.stdout.write(encodeFrame(payload, OPENCODE_DEFAULT_MAX_FRAME_BYTES));
    } catch {
      // The helper is already unable to establish its protocol.
    }
    process.exitCode = 1;
    return;
  }
  try {
    const project = config.projects[0]?.workspace_roots[0];
    if (project !== undefined) await ensureOwnedBrokerForConnection(configPath, project, "opencode");
  } catch {
    // The bridge remains fail-open when the owner cannot be proven or repaired.
  }
  const service = new OpenCodeBridgeService(config);
  const decoder = new NdjsonDecoder(config.maxFrameBytes);
  const inFlight = new Set<Promise<void>>();
  let expectedSeq = 1;
  let shuttingDown = false;
  const send = (response: BridgeFrameResponse | Record<string, unknown>): void => {
    if (shuttingDown) return;
    try {
      process.stdout.write(encodeFrame(response, config.maxFrameBytes));
    } catch {
      shuttingDown = true;
      void service.close();
    }
  };
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await service.close().catch(() => undefined);
  };
  const onData = (chunk: Buffer): void => {
    if (shuttingDown) return;
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (error: unknown) {
      send({ version: 1, kind: "error", code: errorCode(error) });
      void shutdown();
      process.stdin.destroy();
      return;
    }
    for (const frame of frames) {
      if (inFlight.size >= OPENCODE_MAX_PENDING) {
        send({ version: 1, kind: "error", code: "pending_limit" });
        void shutdown();
        process.stdin.destroy();
        return;
      }
      const operation = (async (): Promise<void> => {
        const parsed = bridgeRequestSchema.safeParse(frame);
        if (!parsed.success) {
          send({ version: 1, kind: "error", code: "request_invalid" });
          return;
        }
        if (parsed.data.seq !== expectedSeq) {
          send(responseFrame(parsed.data, { kind: "error", code: "request_replay" }));
          void shutdown();
          process.stdin.destroy();
          return;
        }
        expectedSeq = expectedSeq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : expectedSeq + 1;
        try {
          const body = await service.handle(parsed.data);
          send(responseFrame(parsed.data, body));
          if (parsed.data.kind === "close") await shutdown();
        } catch (error: unknown) {
          send(responseFrame(parsed.data, { kind: "error", code: errorCode(error) }));
        }
      })();
      inFlight.add(operation);
      void operation.finally(() => inFlight.delete(operation)).catch(() => undefined);
    }
  };
  process.stdin.on("data", onData);
  process.stdin.once("end", () => {
    try {
      decoder.finish();
    } catch {
      // An incomplete final frame cannot be committed.
    }
    void shutdown();
  });
  process.stdin.once("error", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    process.stdin.once("close", finish);
    if (process.stdin.destroyed) finish();
  });
  await Promise.allSettled([...inFlight]);
  await service.close().catch(() => undefined);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--config" || argv[1] === undefined || !isAbsolute(argv[1])) {
    process.exitCode = 1;
    return;
  }
  await runOpenCodeBridgeFromStdin(argv[1]);
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  void main();
}
