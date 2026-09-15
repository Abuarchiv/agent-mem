import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer as createTlsServer, connect as tlsConnect, type Server as TlsServer, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { resolve } from "node:path";

import { ipcEndpointPath } from "./ipc-path.js";

import { z } from "zod";

import { capture, observeNative, sourceSpanInputSchema, type SourceSpanInput } from "../core/capture.js";
import { createPreparationContext, type PreparationContext } from "../context/packet.js";
import { ContextPreparationError, prepareEvidencePacket } from "../context/source-only.js";
import { createDirectedEvidenceHandoff, serializeDirectedEvidenceHandoff, recognizePersistedEvidencePacket } from "../context/packet.js";
import { createJobScheduler, SchedulerError, type InteractiveRunOptions, type JobScheduler, type JobSchedulerOptions, type SchedulerStatus } from "../worker/main.js";
import { RuntimeCleanupWorker } from "../execution/cleanup.js";
import {
  ContractValidationError,
  createNativeSessionBinding,
  createTrustedBinding,
  nativeObservationSchema,
  nativeReconcileCoverageSchema,
  nativeReconcileCursorSchema,
  parseCaptureAck,
  validateBoundEvidencePacket,
  type CaptureAck,
  type EvidencePacket,
  type TrustedBinding,
} from "../host/contract.js";
import type { AgentMemoryDatabase } from "../store/database.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  IPC_PSK_CIPHER,
  IPC_TLS_VERSION,
  IpcProtocolError,
  NdjsonDecoder,
} from "./ipc.js";

const sourceSpanWireSchema = sourceSpanInputSchema;
const helloSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("hello"),
    binding_id: z.uuid(),
    native_session_id: z.string().min(1).max(256).optional(),
  })
  .strict();
const readySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("ready"),
    binding_id: z.uuid(),
    server_id: z.uuid(),
    native_session_id: z.string().min(1).max(256).optional(),
    effective_binding: z.unknown().optional(),
    registered_sessions: z.record(z.uuid(), z.uuid()).optional(),
  })
  .strict();
const captureRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("capture"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    event: z.unknown(),
    source_spans: z.array(sourceSpanWireSchema).max(128),
  })
  .strict();
const captureResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("capture_ack"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    ack: z.unknown(),
  })
  .strict();
const recallRequestWireSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recall"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    request: z.unknown(),
    context: z.unknown(),
  })
  .strict();
const recallResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recall_response"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    packet: z.unknown(),
  })
  .strict();
const rpcRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("rpc_request"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    payload: z.unknown(),
  })
  .strict();
const rpcResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("rpc_response"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    result: z.unknown(),
  })
  .strict();
const createHandoffRequestSchema = z.object({
  version: z.literal(1), kind: z.literal("create_handoff"),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(),
  target_binding_id: z.uuid(), context: z.unknown(),
}).strict();
const createHandoffResponseSchema = z.object({
  version: z.literal(1), kind: z.literal("create_handoff_response"),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(), wire: z.string().max(4_000_000),
}).strict();
const recognizeContextRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recognize_context"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    context: z.unknown(),
  })
  .strict();
const recognizeContextResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("recognize_context_response"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    request_id: z.uuid(),
    recognized: z.boolean(),
  })
  .strict();
const nativeCoverageSchema = nativeReconcileCoverageSchema;
const nativeObserveRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    version: z.literal(1), kind: z.literal("native_observe"), operation: z.literal("scan_start"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(), scope_id: z.uuid(),
  }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal("native_observe"), operation: z.literal("capture"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(), scope_id: z.uuid(),
    event: z.unknown(), observation: nativeObservationSchema,
  }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal("native_observe"), operation: z.literal("advance_cursor"),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(), scan_id: z.uuid(),
    cursor: nativeReconcileCursorSchema.nullable(), capture_ids: z.array(z.uuid()).max(128), complete: z.boolean(),
    coverage: nativeCoverageSchema.optional(),
  }).strict(),
]);
const nativeObserveResponseSchema = z.object({
  version: z.literal(1), kind: z.literal("native_observe_response"),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), request_id: z.uuid(), result: z.unknown(),
}).strict();
const errorResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("error"),
    code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    request_id: z.uuid().optional(),
  })
  .strict();

export type BrokerErrorCode =
  | "platform_unsupported"
  | "runtime_directory_invalid"
  | "runtime_directory_not_private"
  | "socket_path_invalid"
  | "already_running"
  | "stale_endpoint"
  | "endpoint_unverified"
  | "broker_not_started"
  | "broker_stopping"
  | "handshake_timeout"
  | "binding_unknown"
  | "authentication_failed"
  | "server_identity_mismatch"
  | "request_replay"
  | "request_invalid"
  | "rpc_unavailable"
  | "pending_limit"
  | "capture_failed"
  | "forbidden"
  | "deadline"
  | "store_unavailable"
  | "budget_exhausted"
  | "transport_closed"
  | "transport_timeout"
  | "frame_too_large"
  | "frame_truncated"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_frame"
  | "native_observation_conflict"
  | "native_observation_blocked"
  | "native_scan_invalid"
  | "native_cursor_conflict"
  | "contract_invalid";

const brokerErrorCodes: ReadonlySet<string> = new Set<BrokerErrorCode>([
  "platform_unsupported",
  "runtime_directory_invalid",
  "runtime_directory_not_private",
  "socket_path_invalid",
  "already_running",
  "stale_endpoint",
  "endpoint_unverified",
  "broker_not_started",
  "broker_stopping",
  "handshake_timeout",
  "binding_unknown",
  "authentication_failed",
  "server_identity_mismatch",
  "request_replay",
  "request_invalid",
  "rpc_unavailable",
  "pending_limit",
  "capture_failed",
  "forbidden",
  "deadline",
  "store_unavailable",
  "budget_exhausted",
  "transport_closed",
  "transport_timeout",
  "frame_too_large",
  "frame_truncated",
  "invalid_utf8",
  "invalid_json",
  "invalid_frame",
  "native_observation_conflict",
  "native_observation_blocked",
  "native_scan_invalid",
  "native_cursor_conflict",
  "contract_invalid",
]);

const MAX_SEEN_REQUEST_IDS = 256;
const DEFAULT_MAX_CONNECTIONS = 64;
const MAX_CONFIGURED_CONNECTIONS = 1_024;
const MAX_CONFIGURED_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_OUTGOING_BYTES = 16 * 1024 * 1024;

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode) {
    super(code);
    this.name = "BrokerError";
    this.code = code;
  }
}

/** A credential is a setup-time pairing of one trusted binding and one PSK. */
export interface BrokerBindingCredential {
  readonly binding: TrustedBinding;
  readonly secret: Uint8Array;
  /** Native hook session registration is an explicit setup-time capability. */
  readonly allowNativeSessions?: boolean;
}

/** Runtime-owned execution facade. The scheduler property may be a getter. */
export interface BrokerOwner {
  readonly database: AgentMemoryDatabase;
  readonly scheduler: JobScheduler;
  readonly runInteractive: <T>(options: InteractiveRunOptions, operation: (signal: AbortSignal) => T | PromiseLike<T>) => Promise<T>;
  readonly runMutation: <T>(operation: () => T) => Promise<T>;
  readonly embedQuery: JobScheduler["embedQuery"];
  readonly runDegraded?: <T>(operation: () => T) => Promise<T>;
}

export interface BrokerOptions {
  /** Required for standalone mode; borrowed mode gets it from `owner`. */
  readonly database?: AgentMemoryDatabase;
  readonly runtimeDirectory: string;
  readonly credentials: readonly BrokerBindingCredential[];
  /** A stable runtime facade or a getter for future post-reservation lazy ownership. */
  readonly owner?: BrokerOwner | (() => BrokerOwner | undefined);
  /** Narrow, authenticated pass-through for owner-provided MCP/operator calls. */
  readonly rpcHandler?: (binding: TrustedBinding, payload: unknown, signal?: AbortSignal, client?: object) => unknown | Promise<unknown>;
  /** Owner-lane source recall preparation shared by native and MCP callers. */
  readonly prepareRecall?: (input: unknown, binding: TrustedBinding, context: PreparationContext, queryVector?: Float32Array, signal?: AbortSignal) => Promise<EvidencePacket>;
  /** Scheduler tuning is setup-only; fixture handlers are intentionally not broker-configurable. */
  readonly schedulerOptions?: Omit<JobSchedulerOptions, "handlers" | "repository">;
  readonly maxFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly frameTimeoutMs?: number;
  readonly maxConnections?: number;
}

export interface BrokerAddress {
  readonly socketPath: string;
  readonly serverId: string;
}

export interface BrokerClientOptions {
  readonly socketPath: string;
  readonly credential: BrokerBindingCredential;
  readonly expectedServerId?: string;
  readonly maxFrameBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  /** Optional native session id sent in hello; never selects authority. */
  readonly nativeSessionId?: string;
}

interface CredentialRecord {
  readonly binding: TrustedBinding;
  readonly secret: Buffer;
  readonly allowNativeSessions: boolean;
}

interface ServerConnection {
  readonly socket: TLSSocket;
  readonly decoder: NdjsonDecoder;
  readonly handshakeTimer: ReturnType<typeof setTimeout>;
  readonly seenRequestIds: Set<string>;
  readonly seenRequestOrder: string[];
  phase: "hello" | "authenticating" | "ready";
  binding?: TrustedBinding;
  pskIdentity: string | undefined;
  expectedSeq: number;
  frameTimer: ReturnType<typeof setTimeout> | undefined;
  readonly recallControllers: Set<AbortController>;
}

interface PendingRequest {
  readonly kind: "capture" | "recall" | "rpc" | "recognize_context" | "native_observe" | "create_handoff";
  readonly seq: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isFrameKind(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && "kind" in value && (value as { kind?: unknown }).kind === kind;
}

function mapTransportError(error: IpcProtocolError): BrokerErrorCode {
  return error.code;
}

function brokerErrorFromWire(code: string): BrokerError {
  return new BrokerError(brokerErrorCodes.has(code) ? (code as BrokerErrorCode) : "request_invalid");
}

function mapScheduledRecallError(error: unknown, brokerStopping: boolean): BrokerErrorCode {
  if (error instanceof ContextPreparationError) return error.code;
  if (error instanceof ContractValidationError) return "forbidden";
  if (error instanceof SchedulerError) {
    switch (error.code) {
      case "scheduler_queue_full":
        return "pending_limit";
      case "deadline":
        return "deadline";
      case "aborted":
        return brokerStopping ? "broker_stopping" : "transport_closed";
      case "scheduler_not_started":
        return "broker_not_started";
      case "scheduler_closed":
        return brokerStopping ? "broker_stopping" : "store_unavailable";
    }
  }
  return "store_unavailable";
}

function mapOwnerOperationError(error: unknown, fallback: BrokerErrorCode): BrokerErrorCode {
  if (error instanceof BrokerError) return error.code;
  if (error instanceof SchedulerError) return mapScheduledRecallError(error, false);
  if (error instanceof ContractValidationError) return "forbidden";
  if (error instanceof Error && [
    "runtime_maintenance_pending",
    "offline_runtime_closing",
    "offline_runtime_closed",
    "offline_runtime_reset_pending",
  ].includes(error.message)) return "store_unavailable";
  if (error instanceof Error && "code" in error && typeof error.code === "string" && brokerErrorCodes.has(error.code)) return error.code as BrokerErrorCode;
  return fallback;
}

function bindingAuthorityKey(binding: TrustedBinding): string {
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

function removeOwnedSocket(socketPath: string, identity: { dev: number; ino: number } | undefined): void {
  if (process.platform === "win32") return;
  if (identity === undefined) return;
  try {
    const current = lstatSync(socketPath);
    if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(socketPath);
  } catch {
    // The path may be gone or may belong to a newer owner.
  }
}

function socketIdentity(socketPath: string): { dev: number; ino: number } | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const stat = lstatSync(socketPath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function existingPath(socketPath: string): ReturnType<typeof lstatSync> | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return lstatSync(socketPath);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new BrokerError("stale_endpoint");
  }
}

function tlsServerOptions(pskCallback: (socket: TLSSocket, identity: string) => Buffer | null, handshakeTimeoutMs: number) {
  return {
    ciphers: IPC_PSK_CIPHER,
    minVersion: IPC_TLS_VERSION,
    maxVersion: IPC_TLS_VERSION,
    pskCallback,
    handshakeTimeout: handshakeTimeoutMs,
    // This is a local PSK-only transport; no certificate or remote hostname is used.
    rejectUnauthorized: false,
  } as const;
}

function tlsClientOptions(socketPath: string, bindingId: string, secret: Buffer) {
  return {
    path: socketPath,
    ciphers: IPC_PSK_CIPHER,
    minVersion: IPC_TLS_VERSION,
    maxVersion: IPC_TLS_VERSION,
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: bindingId, psk: secret }),
  } as const;
}

function writeBoundedFrame(socket: TLSSocket, value: unknown, maxFrameBytes: number, maxQueuedBytes: number): void {
  writeEncodedFrame(socket, encodeFrame(value, maxFrameBytes), maxQueuedBytes);
}

function writeEncodedFrame(socket: TLSSocket, frame: Buffer, maxQueuedBytes: number): void {
  if (socket.writableLength + frame.length > maxQueuedBytes) {
    socket.destroy();
    throw new BrokerError("transport_closed");
  }
  socket.write(frame);
  if (socket.writableLength > maxQueuedBytes) {
    socket.destroy();
    throw new BrokerError("transport_closed");
  }
}

async function probeEndpoint(
  socketPath: string,
  credentials: readonly CredentialRecord[],
  timeoutMs: number,
): Promise<"authenticated" | "unverified"> {
  for (const credential of credentials) {
    let authenticated = false;
    try {
      const socket = tlsConnect(tlsClientOptions(socketPath, credential.binding.binding_id, credential.secret));
      authenticated = await new Promise<boolean>((resolveResult) => {
        let settled = false;
        const timer = setTimeout(() => settle(false), timeoutMs);
        const settle = (result: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolveResult(result);
        };
        socket.once("secureConnect", () => settle(true));
        socket.once("error", () => settle(false));
        socket.once("close", () => settle(false));
      });
    } catch {
      authenticated = false;
    }
    if (authenticated) return "authenticated";
  }
  return "unverified";
}

function closeServer(server: TlsServer): Promise<void> {
  return new Promise<void>((resolveClose) => {
    try {
      server.close(() => resolveClose());
    } catch {
      resolveClose();
    }
  });
}

function waitBounded(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveWait) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolveWait(false);
    }, timeoutMs);
    promise.then(
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveWait(true);
      },
      () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveWait(true);
      },
    );
  });
}

export class AgentMemoryBroker {
  readonly socketPath: string;
  readonly serverId: string;
  private readonly standaloneDatabase: AgentMemoryDatabase | undefined;
  private readonly ownerProvider: (() => BrokerOwner | undefined) | undefined;
  private readonly standaloneScheduler: JobScheduler | undefined;
  private ownerDatabase: AgentMemoryDatabase | undefined;
  private readonly credentials: ReadonlyMap<string, CredentialRecord>;
  private readonly maxFrameBytes: number;
  private readonly handshakeTimeoutMs: number;
  private readonly frameTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxOutgoingBytes: number;
  private readonly rpcHandler: BrokerOptions["rpcHandler"];
  private readonly prepareRecall: BrokerOptions["prepareRecall"];
  private readonly connections = new Set<ServerConnection>();
  private readonly rawSockets = new Set<Socket>();
  private readonly pskIdentities = new WeakMap<TLSSocket, string>();
  private server: TlsServer | undefined;
  private socketFileIdentity: { dev: number; ino: number } | undefined;
  private stopping = false;
  private starting: Promise<BrokerAddress> | undefined;
  private stoppingPromise: Promise<void> | undefined;

  constructor(options: BrokerOptions) {
    if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") throw new BrokerError("platform_unsupported");
    if (options.rpcHandler !== undefined && typeof options.rpcHandler !== "function") throw new BrokerError("request_invalid");
    if (options.prepareRecall !== undefined && typeof options.prepareRecall !== "function") throw new BrokerError("request_invalid");
    this.rpcHandler = options.rpcHandler;
    this.prepareRecall = options.prepareRecall;
    const configuredOwner = options.owner;
    this.ownerProvider = configuredOwner === undefined
      ? undefined
      : typeof configuredOwner === "function"
        ? configuredOwner
        : () => configuredOwner;
    const initialOwner = this.ownerProvider?.();
    if (initialOwner !== undefined && options.database !== undefined && initialOwner.database !== options.database) throw new BrokerError("request_invalid");
    this.ownerDatabase = initialOwner?.database;
    this.standaloneDatabase = this.ownerProvider === undefined ? options.database : undefined;
    if (this.ownerProvider === undefined && this.standaloneDatabase === undefined) throw new BrokerError("request_invalid");
    this.standaloneScheduler = this.standaloneDatabase === undefined
      ? undefined
      : createJobScheduler(this.standaloneDatabase, {
          ...(options.schedulerOptions ?? {}),
      repository: this.standaloneDatabase.jobs,
          cleanupWorker: new RuntimeCleanupWorker(this.standaloneDatabase.runtimeArtifacts),
        });
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024 || this.maxFrameBytes > MAX_CONFIGURED_FRAME_BYTES) {
      throw new BrokerError("request_invalid");
    }
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.handshakeTimeoutMs) || this.handshakeTimeoutMs < 100) throw new BrokerError("request_invalid");
    this.frameTimeoutMs = options.frameTimeoutMs ?? this.handshakeTimeoutMs;
    if (!Number.isSafeInteger(this.frameTimeoutMs) || this.frameTimeoutMs < 100) throw new BrokerError("request_invalid");
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    if (!Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > MAX_CONFIGURED_CONNECTIONS) {
      throw new BrokerError("request_invalid");
    }
    this.maxOutgoingBytes = Math.min(MAX_OUTGOING_BYTES, this.maxFrameBytes * 2);
    const credentials = new Map<string, CredentialRecord>();
    for (const credential of options.credentials) {
      const secret = Buffer.from(credential.secret);
      if (secret.length < 32) throw new BrokerError("authentication_failed");
      if (credentials.has(credential.binding.binding_id)) throw new BrokerError("request_invalid");
      for (const existing of credentials.values()) {
        if (existing.secret.length === secret.length && existing.secret.equals(secret)) throw new BrokerError("request_invalid");
      }
      credentials.set(credential.binding.binding_id, {
        binding: credential.binding,
        secret,
        allowNativeSessions: credential.allowNativeSessions === true,
      });
    }
    if (credentials.size === 0) throw new BrokerError("request_invalid");
    this.credentials = credentials;
    const runtimeDirectory = resolve(options.runtimeDirectory);
    let runtimeStat;
    try {
      runtimeStat = lstatSync(runtimeDirectory);
    } catch {
      throw new BrokerError("runtime_directory_invalid");
    }
    if (!runtimeStat.isDirectory()) throw new BrokerError("runtime_directory_invalid");
    if (process.platform !== "win32" && (runtimeStat.mode & 0o077) !== 0) throw new BrokerError("runtime_directory_not_private");
    this.socketPath = ipcEndpointPath(runtimeDirectory);
    if (Buffer.byteLength(this.socketPath, "utf8") > 100) throw new BrokerError("socket_path_invalid");
    this.serverId = randomUUID();
  }

  get schedulerStatus(): SchedulerStatus {
    return this.currentScheduler().status();
  }

  private currentOwner(): BrokerOwner | undefined {
    const owner = this.ownerProvider?.();
    if (owner !== undefined) {
      if (this.ownerDatabase !== undefined && owner.database !== this.ownerDatabase) throw new BrokerError("store_unavailable");
      this.ownerDatabase ??= owner.database;
    }
    return owner;
  }

  private currentDatabase(): AgentMemoryDatabase {
    const owner = this.currentOwner();
    if (owner !== undefined) return owner.database;
    if (this.ownerProvider !== undefined) throw new BrokerError("store_unavailable");
    if (this.standaloneDatabase === undefined) throw new BrokerError("store_unavailable");
    return this.standaloneDatabase;
  }

  private currentScheduler(): JobScheduler {
    const owner = this.currentOwner();
    if (owner !== undefined) return owner.scheduler;
    if (this.ownerProvider !== undefined) throw new BrokerError("store_unavailable");
    if (this.standaloneScheduler === undefined) throw new BrokerError("store_unavailable");
    return this.standaloneScheduler;
  }

  private runInteractive<T>(options: InteractiveRunOptions, operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
    const owner = this.currentOwner();
    if (owner !== undefined) return owner.runInteractive(options, operation);
    if (this.ownerProvider !== undefined) return Promise.reject(new BrokerError("store_unavailable"));
    return this.currentScheduler().runInteractive(options, operation);
  }

  private runMutation<T>(operation: () => T): Promise<T> {
    const owner = this.currentOwner();
    if (owner !== undefined) return owner.runMutation(operation);
    if (this.ownerProvider !== undefined) return Promise.reject(new BrokerError("store_unavailable"));
    try { return Promise.resolve(operation()); } catch (error: unknown) { return Promise.reject(error); }
  }

  private embedQuery(options: InteractiveRunOptions, text: string): Promise<readonly Float32Array[] | undefined> {
    const owner = this.currentOwner();
    if (owner !== undefined) return owner.embedQuery(options, text);
    if (this.ownerProvider !== undefined) return Promise.reject(new BrokerError("store_unavailable"));
    return this.currentScheduler().embedQuery(options, text);
  }

  private runDegraded<T>(operation: () => T): Promise<T> {
    const owner = this.currentOwner();
    if (owner?.runDegraded !== undefined) return owner.runDegraded(operation);
    if (this.ownerProvider !== undefined) return Promise.reject(new BrokerError("store_unavailable"));
    try { return Promise.resolve(operation()); } catch (error: unknown) { return Promise.reject(error); }
  }


  async start(): Promise<BrokerAddress> {
    if (this.stopping) throw new BrokerError("broker_stopping");
    if (this.starting !== undefined) return this.starting;
    if (this.server !== undefined) return { socketPath: this.socketPath, serverId: this.serverId };
    const starting = this.startInternal();
    this.starting = starting;
    starting
      .finally(() => {
        if (this.starting === starting) this.starting = undefined;
      })
      .catch(() => undefined);
    return starting;
  }

  private async startInternal(): Promise<BrokerAddress> {
    const existing = process.platform === "win32" ? undefined : existingPath(this.socketPath);
    if (existing !== undefined) {
      if (existing.isSocket()) {
        const probe = await probeEndpoint(this.socketPath, [...this.credentials.values()], this.handshakeTimeoutMs);
        if (probe === "authenticated") throw new BrokerError("already_running");
        throw new BrokerError("endpoint_unverified");
      }
      throw new BrokerError("stale_endpoint");
    }

    const server = createTlsServer(
      tlsServerOptions((socket, identity) => {
        const credential = this.credentials.get(identity);
        if (credential !== undefined) this.pskIdentities.set(socket, identity);
        return credential?.secret ?? null;
      }, this.handshakeTimeoutMs),
      (socket) => this.acceptConnection(socket),
    );
    server.maxConnections = this.maxConnections;
    server.on("connection", (socket) => this.trackRawSocket(socket));
    server.on("tlsClientError", (_error, socket) => {
      if (socket !== undefined) {
        socket.destroy();
      }
    });
    this.server = server;
    try {
      // Standalone mode owns its scheduler; borrowed mode starts it with the runtime.
      this.standaloneScheduler?.start();
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => {
          server.off("error", onError);
          rejectListen(error);
        };
        server.once("error", onError);
        server.listen(this.socketPath, () => {
          server.off("error", onError);
          resolveListen();
        });
      });
      this.socketFileIdentity = socketIdentity(this.socketPath);
      if (process.platform !== "win32") {
        if (this.socketFileIdentity === undefined) throw new BrokerError("stale_endpoint");
        chmodSync(this.socketPath, 0o600);
      }
      return { socketPath: this.socketPath, serverId: this.serverId };
    } catch (error: unknown) {
      this.server = undefined;
      if (this.standaloneScheduler !== undefined) {
        try {
          await this.standaloneScheduler.stop({ timeoutMs: Math.min(60_000, this.handshakeTimeoutMs) });
        } catch {
          // Preserve the listen failure while keeping admission closed.
        }
      }
      const closePromise = closeServer(server);
      await waitBounded(closePromise, this.handshakeTimeoutMs);
      this.destroyRawSockets();
      removeOwnedSocket(this.socketPath, this.socketFileIdentity);
      this.socketFileIdentity = undefined;
      if (isCode(error, "EADDRINUSE")) {
        const path = existingPath(this.socketPath);
        if (process.platform === "win32" || path?.isSocket()) {
          const probe = await probeEndpoint(this.socketPath, [...this.credentials.values()], this.handshakeTimeoutMs);
          if (probe === "authenticated") throw new BrokerError("already_running");
        }
        throw new BrokerError("endpoint_unverified");
      }
      throw error instanceof BrokerError ? error : new BrokerError("stale_endpoint");
    }
  }

  async stop(): Promise<void> {
    if (this.stoppingPromise !== undefined) return this.stoppingPromise;
    const startInFlight = this.starting;
    if (startInFlight !== undefined) {
      try {
        await startInFlight;
      } catch {
        return;
      }
    }
    const server = this.server;
    if (server === undefined) {
      if (this.standaloneScheduler !== undefined) {
        try {
          await this.standaloneScheduler.stop({ timeoutMs: Math.min(60_000, this.handshakeTimeoutMs) });
        } catch {
          // The scheduler may never have been started; there is no transport to close.
        }
      }
      return;
    }
    this.stopping = true;
    const stopping = this.stopInternal(server);
    this.stoppingPromise = stopping;
    stopping
      .finally(() => {
        if (this.stoppingPromise === stopping) this.stoppingPromise = undefined;
      })
      .catch(() => undefined);
    return stopping;
  }

  private async stopInternal(server: TlsServer): Promise<void> {
    this.abortRecallControllers();
    if (this.standaloneScheduler !== undefined) {
      try {
        await this.standaloneScheduler.stop({ timeoutMs: Math.min(60_000, this.handshakeTimeoutMs) });
      } catch {
        // Transport shutdown must still complete if the scheduler reports a store failure.
      }
    }
    const closePromise = closeServer(server);
    for (const connection of this.connections) connection.socket.end();
    const closed = await waitBounded(closePromise, this.handshakeTimeoutMs);
    for (const connection of this.connections) connection.socket.destroy();
    this.destroyRawSockets();
    if (!closed) await waitBounded(closePromise, this.handshakeTimeoutMs);
    removeOwnedSocket(this.socketPath, this.socketFileIdentity);
    this.socketFileIdentity = undefined;
    if (this.server === server) this.server = undefined;
    this.stopping = false;
  }

  private abortRecallControllers(): void {
    for (const connection of this.connections) {
      for (const controller of connection.recallControllers) controller.abort();
      connection.recallControllers.clear();
    }
  }

  private trackRawSocket(socket: Socket): void {
    this.rawSockets.add(socket);
    socket.once("close", () => this.untrackRawSocket(socket));
  }

  private untrackRawSocket(socket: Socket): void {
    this.rawSockets.delete(socket);
  }

  private destroyRawSockets(): void {
    for (const socket of [...this.rawSockets]) {
      this.untrackRawSocket(socket);
      socket.destroy();
    }
  }

  private acceptConnection(socket: TLSSocket): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const pskIdentity = this.pskIdentities.get(socket);
    this.pskIdentities.delete(socket);
    if (pskIdentity === undefined) {
      socket.destroy();
      return;
    }
    const connection: ServerConnection = {
      socket,
      decoder: new NdjsonDecoder(this.maxFrameBytes),
      handshakeTimer: setTimeout(() => {
        if (connection.phase !== "ready") {
          this.sendError(connection, "handshake_timeout");
          socket.destroy();
        }
      }, this.handshakeTimeoutMs),
      seenRequestIds: new Set(),
      seenRequestOrder: [],
      phase: "hello",
      pskIdentity,
      expectedSeq: 1,
      frameTimer: undefined,
      recallControllers: new Set(),
    };
    this.connections.add(connection);
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("end", () => {
      try {
        connection.decoder.finish();
      } catch {
        this.handleProtocolFailure(connection, "frame_truncated");
      }
    });
    socket.on("error", () => {
      // Do not expose source or secret values through transport diagnostics.
    });
    socket.on("close", () => {
      clearTimeout(connection.handshakeTimer);
      this.clearFrameDeadline(connection);
      for (const controller of connection.recallControllers) controller.abort();
      connection.recallControllers.clear();
      this.connections.delete(connection);
    });
  }

  private receive(connection: ServerConnection, chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = connection.decoder.push(chunk);
    } catch (error: unknown) {
      const code = error instanceof IpcProtocolError ? mapTransportError(error) : "invalid_frame";
      this.handleProtocolFailure(connection, code);
      return;
    }
    if (frames.length > 0) this.clearFrameDeadline(connection);
    for (const frame of frames) {
      if (connection.socket.destroyed || connection.socket.writableEnded) return;
      if (connection.phase === "authenticating") {
        this.sendError(connection, "authentication_failed");
        connection.socket.end();
        return;
      }
      if (connection.phase === "hello") void this.handleHello(connection, frame);
      else if (isFrameKind(frame, "recall")) void this.handleRecall(connection, frame);
      else if (isFrameKind(frame, "rpc_request")) void this.handleRpc(connection, frame);
      else if (isFrameKind(frame, "create_handoff")) void this.handleCreateHandoff(connection, frame);
      else if (isFrameKind(frame, "recognize_context")) void this.handleRecognizeContext(connection, frame);
      else if (isFrameKind(frame, "native_observe")) void this.handleNativeObserve(connection, frame);
      else void this.handleCapture(connection, frame);
    }
    this.updateFrameDeadline(connection);
  }

  private updateFrameDeadline(connection: ServerConnection): void {
    if (connection.socket.destroyed || connection.socket.writableEnded || connection.phase !== "ready") return;
    if (connection.decoder.hasPendingBytes()) {
      if (connection.frameTimer === undefined) {
        connection.frameTimer = setTimeout(() => {
          connection.frameTimer = undefined;
          this.handleProtocolFailure(connection, "frame_truncated");
        }, this.frameTimeoutMs);
      }
      return;
    }
    this.clearFrameDeadline(connection);
  }

  private clearFrameDeadline(connection: ServerConnection): void {
    if (connection.frameTimer !== undefined) clearTimeout(connection.frameTimer);
    connection.frameTimer = undefined;
  }

  private async handleHello(connection: ServerConnection, frame: unknown): Promise<void> {
    connection.phase = "authenticating";
    const hello = helloSchema.safeParse(frame);
    if (!hello.success) {
      this.sendError(connection, "authentication_failed");
      connection.socket.end();
      return;
    }
    // TLS selected the PSK before this frame. The wire id can only confirm that selection.
    if (connection.pskIdentity !== hello.data.binding_id) {
      this.sendError(connection, "authentication_failed");
      connection.socket.end();
      return;
    }
    const credential = this.credentials.get(hello.data.binding_id);
    if (credential === undefined) {
      this.sendError(connection, "binding_unknown");
      connection.socket.end();
      return;
    }
    let binding = credential.binding;
    let registeredSessions: Record<string, string> | undefined;
    if (hello.data.native_session_id !== undefined) {
      if (!credential.allowNativeSessions) {
        this.sendError(connection, "authentication_failed");
        connection.socket.end();
        return;
      }
      try {
        binding = createNativeSessionBinding(credential.binding, hello.data.native_session_id);
        const registeredAt = new Date().toISOString();
        registeredSessions = await this.runMutation(() => {
          if (connection.socket.destroyed || connection.socket.writableEnded || this.stopping) throw new BrokerError("authentication_failed");
          const sessions: Record<string, string> = {};
          const database = this.currentDatabase();
          for (const scopeId of binding.allowed_scope_ids) sessions[scopeId] = database.registerSession(scopeId, binding, registeredAt);
          return sessions;
        });
      } catch {
        // No ready frame is emitted until every allowed scope is registered.
        this.sendError(connection, "store_unavailable");
        connection.socket.end();
        return;
      }
    }
    if (connection.socket.destroyed || connection.socket.writableEnded || this.stopping) return;
    connection.binding = binding;
    connection.phase = "ready";
    clearTimeout(connection.handshakeTimer);
    try {
      writeBoundedFrame(
        connection.socket,
        {
          version: 1,
          kind: "ready",
          binding_id: credential.binding.binding_id,
          server_id: this.serverId,
          ...(hello.data.native_session_id === undefined
            ? {}
            : {
                native_session_id: hello.data.native_session_id,
                effective_binding: binding,
                registered_sessions: registeredSessions,
              }),
        },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch {
      connection.socket.destroy();
    }
  }

  private async handleCapture(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = captureRequestSchema.safeParse(frame);
    if (!request.success) {
      this.sendError(connection, "request_invalid");
      return;
    }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const binding = connection.binding;
    if (binding === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    try {
      const ack = await this.runMutation(() => {
        const database = this.currentDatabase();
        const registeredAt = new Date().toISOString();
        for (const scopeId of binding.allowed_scope_ids) database.registerSession(scopeId, binding, registeredAt);
        return capture(request.data.event, binding, database, { source_spans: request.data.source_spans });
      });
      writeBoundedFrame(
        connection.socket,
        { version: 1, kind: "capture_ack", seq: request.data.seq, request_id: request.data.request_id, ack },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch (error: unknown) {
      const code = error instanceof ContractValidationError ? "contract_invalid" : mapOwnerOperationError(error, "capture_failed");
      this.sendError(connection, code, request.data.seq, request.data.request_id);
    }
  }

  private async handleNativeObserve(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = nativeObserveRequestSchema.safeParse(frame);
    if (!request.success) {
      this.sendError(connection, "request_invalid");
      return;
    }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const binding = connection.binding;
    if (binding === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    try {
      const result = await this.runMutation(() => {
        const database = this.currentDatabase();
        const registeredAt = new Date().toISOString();
        for (const scopeId of binding.allowed_scope_ids) database.registerSession(scopeId, binding, registeredAt);
        if (request.data.operation === "scan_start") {
          return database.beginNativeReconcileScan(binding, request.data.scope_id, new Date().toISOString());
        }
        if (request.data.operation === "capture") {
          const event = request.data.event;
          const eventScope = typeof event === "object" && event !== null && "scope_id" in event ? (event as { scope_id?: unknown }).scope_id : undefined;
          if (eventScope !== request.data.scope_id) throw new BrokerError("contract_invalid");
          return observeNative(event, binding, database, request.data.observation);
        }
        const coverage = request.data.coverage === undefined
          ? undefined
          : { status: request.data.coverage.status, ...(request.data.coverage.reason === undefined ? {} : { reason: String(request.data.coverage.reason) }), ...(request.data.coverage.gaps === undefined ? {} : { gaps: request.data.coverage.gaps }) };
        return database.advanceNativeReconcileCursor({
          binding,
          scan_id: request.data.scan_id,
          cursor: request.data.cursor,
          capture_ids: request.data.capture_ids,
          complete: request.data.complete,
          ...(coverage === undefined ? {} : { coverage }),
          updated_at: new Date().toISOString(),
        });
      });
      writeBoundedFrame(
        connection.socket,
        { version: 1, kind: "native_observe_response", seq: request.data.seq, request_id: request.data.request_id, result },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch (error: unknown) {
      const code = error instanceof ContractValidationError ? "contract_invalid" : mapOwnerOperationError(error, "capture_failed");
      this.sendError(connection, code, request.data.seq, request.data.request_id);
    }
  }

  private async handleRecall(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = recallRequestWireSchema.safeParse(frame);
    if (!request.success) {
      this.sendError(connection, "request_invalid");
      return;
    }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const binding = connection.binding;
    if (binding === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    let context: ReturnType<typeof createPreparationContext>;
    try {
      context = createPreparationContext(binding, request.data.context);
    } catch (error: unknown) {
      const code = error instanceof ContractValidationError ? "forbidden" : "store_unavailable";
      this.sendError(connection, code, request.data.seq, request.data.request_id);
      return;
    }
    const controller = new AbortController();
    connection.recallControllers.add(controller);
    let scheduled: Promise<EvidencePacket>;
    try {
      scheduled = (async () => {
        let queryVector: Float32Array | undefined;
        const queryText = typeof request.data.request === "object" && request.data.request !== null && "query" in request.data.request
          ? (request.data.request as { readonly query?: unknown }).query
          : undefined;
        try {
          const vectors = await this.embedQuery(
            { deadlineAt: context.deadline_at, signal: controller.signal },
            typeof queryText === "string" ? queryText : "",
          );
          queryVector = vectors?.[0];
        } catch (error: unknown) {
          if (error instanceof SchedulerError && (error.code === "aborted" || error.code === "deadline")) throw error;
          // Model unavailability is an honest lexical fallback; the context
          // packet remains fully scope/egress/time checked.
        }
        return this.runInteractive(
          { deadlineAt: context.deadline_at, signal: controller.signal },
          (signal) => {
            if (signal.aborted) throw new SchedulerError("aborted");
            return this.prepareRecall === undefined
              ? prepareEvidencePacket(this.currentDatabase(), request.data.request, binding, context, queryVector)
              : this.prepareRecall(request.data.request, binding, context, queryVector, signal);
          },
        );
      })();
    } catch (error: unknown) {
      connection.recallControllers.delete(controller);
      void this.respondRecallFailure(connection, request.data, binding, context, controller, error);
      return;
    }
    void scheduled
      .then(
        (packet) => {
          connection.recallControllers.delete(controller);
          if (connection.socket.destroyed || connection.socket.writableEnded || this.stopping || controller.signal.aborted) return;
          try {
            writeBoundedFrame(
              connection.socket,
              { version: 1, kind: "recall_response", seq: request.data.seq, request_id: request.data.request_id, packet },
              this.maxFrameBytes,
              this.maxOutgoingBytes,
            );
          } catch {
            connection.socket.destroy();
          }
        },
        (error: unknown) => {
          connection.recallControllers.delete(controller);
          void this.respondRecallFailure(connection, request.data, binding, context, controller, error);
        },
      )
      .catch(() => {
        // Response delivery is best-effort after the request has been admitted.
      });
  }

  private async respondRecallFailure(
    connection: ServerConnection,
    request: { readonly seq: number; readonly request_id: string; readonly request: unknown },
    binding: TrustedBinding,
    context: ReturnType<typeof createPreparationContext>,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (connection.socket.destroyed || connection.socket.writableEnded) return;
    if (controller.signal.aborted && !this.stopping) return;
    if (!this.stopping && !controller.signal.aborted && this.canUseRecallFallback(error)) {
      try {
        // The direct path is an explicit degraded lexical/timeline fallback;
        // prepareEvidencePacket still enforces scope, egress, purge and epoch
        // checks before producing its mode=degraded packet.
        const packet = await this.runDegraded(() => prepareEvidencePacket(this.currentDatabase(), request.request, binding, context));
        writeBoundedFrame(
          connection.socket,
          { version: 1, kind: "recall_response", seq: request.seq, request_id: request.request_id, packet },
          this.maxFrameBytes,
          this.maxOutgoingBytes,
        );
        return;
      } catch (fallbackError: unknown) {
        error = fallbackError;
      }
    }
    if (this.stopping) {
      this.sendError(connection, "broker_stopping", request.seq, request.request_id);
      return;
    }
    this.sendError(connection, mapScheduledRecallError(error, this.stopping), request.seq, request.request_id);
  }

  private async handleRpc(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = rpcRequestSchema.safeParse(frame);
    if (!request.success) {
      this.sendError(connection, "request_invalid");
      return;
    }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const binding = connection.binding;
    if (binding === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    const handler = this.rpcHandler;
    if (handler === undefined) {
      this.sendError(connection, "rpc_unavailable", request.data.seq, request.data.request_id);
      return;
    }
    const controller = new AbortController();
    connection.recallControllers.add(controller);
    try {
      const result = await handler(binding, request.data.payload, controller.signal, connection);
      if (connection.socket.destroyed || connection.socket.writableEnded || this.stopping) return;
      writeBoundedFrame(
        connection.socket,
        { version: 1, kind: "rpc_response", seq: request.data.seq, request_id: request.data.request_id, result },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch (error: unknown) {
      if (connection.socket.destroyed || connection.socket.writableEnded) return;
      this.sendError(connection, mapOwnerOperationError(error, "store_unavailable"), request.data.seq, request.data.request_id);
    } finally {
      connection.recallControllers.delete(controller);
    }
  }

  private canUseRecallFallback(error: unknown): boolean {
    if (!(error instanceof SchedulerError)) return false;
    // Queue saturation is deliberate admission backpressure. Falling through
    // to synchronous recall here would defeat the bound and starve queued work.
    if (error.code === "scheduler_queue_full") return false;
    if (error.code !== "scheduler_closed") return false;
    try { return this.currentScheduler().status().failure !== "none"; } catch { return false; }
  }

  private async handleCreateHandoff(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = createHandoffRequestSchema.safeParse(frame);
    if (!request.success) { this.sendError(connection, "request_invalid"); return; }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const source = connection.binding;
    if (source === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    // Native/model input selects only an already authenticated live endpoint;
    // authority, scopes and egress are never deserialized from the request.
    const target = [...this.connections].find((candidate) => candidate.phase === "ready" &&
      !candidate.socket.destroyed && candidate.binding?.binding_id === request.data.target_binding_id)?.binding;
    if (target === undefined) { this.sendError(connection, "forbidden", request.data.seq, request.data.request_id); return; }
    try {
      await this.runMutation(() => {
        const database = this.currentDatabase();
        const handoff = createDirectedEvidenceHandoff(database, source, target, request.data.context);
        const serialized = serializeDirectedEvidenceHandoff(handoff);
        writeBoundedFrame(connection.socket, { version: 1, kind: "create_handoff_response", seq: request.data.seq,
          request_id: request.data.request_id, wire: serialized }, this.maxFrameBytes, this.maxOutgoingBytes);
        database.markQueryTraceReturned(handoff.handoff_id);
      });
    } catch (error: unknown) {
      this.sendError(connection, mapOwnerOperationError(error, "forbidden"), request.data.seq, request.data.request_id);
    }
  }

  private async handleRecognizeContext(connection: ServerConnection, frame: unknown): Promise<void> {
    const request = recognizeContextRequestSchema.safeParse(frame);
    if (!request.success) {
      this.sendError(connection, "request_invalid");
      return;
    }
    if (!this.acceptRequest(connection, request.data.seq, request.data.request_id)) return;
    const binding = connection.binding;
    if (binding === undefined || this.stopping) {
      this.sendError(connection, this.stopping ? "broker_stopping" : "authentication_failed", request.data.seq, request.data.request_id);
      return;
    }
    try {
      const recognized = await this.runMutation(() => recognizePersistedEvidencePacket(this.currentDatabase(), binding, request.data.context) !== undefined);
      writeBoundedFrame(
        connection.socket,
        {
          version: 1,
          kind: "recognize_context_response",
          seq: request.data.seq,
          request_id: request.data.request_id,
          recognized,
        },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch (error: unknown) {
      this.sendError(connection, mapOwnerOperationError(error, "store_unavailable"), request.data.seq, request.data.request_id);
    }
  }

  private acceptRequest(connection: ServerConnection, seq: number, requestId: string): boolean {
    if (seq !== connection.expectedSeq || connection.seenRequestIds.has(requestId)) {
      queueMicrotask(() => {
        this.sendError(connection, "request_replay", seq, requestId);
        setImmediate(() => connection.socket.end());
      });
      return false;
    }
    connection.expectedSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    connection.seenRequestIds.add(requestId);
    connection.seenRequestOrder.push(requestId);
    if (connection.seenRequestOrder.length > MAX_SEEN_REQUEST_IDS) {
      const oldest = connection.seenRequestOrder.shift();
      if (oldest !== undefined) connection.seenRequestIds.delete(oldest);
    }
    return true;
  }

  private handleProtocolFailure(connection: ServerConnection, code: BrokerErrorCode): void {
    if (connection.socket.destroyed) return;
    this.clearFrameDeadline(connection);
    this.sendError(connection, code);
    connection.socket.destroy();
  }

  private sendError(connection: ServerConnection, code: BrokerErrorCode, seq?: number, requestId?: string): void {
    if (connection.socket.destroyed) return;
    try {
      writeBoundedFrame(
        connection.socket,
        {
          version: 1,
          kind: "error",
          code,
          ...(seq === undefined ? {} : { seq }),
          ...(requestId === undefined ? {} : { request_id: requestId }),
        },
        this.maxFrameBytes,
        this.maxOutgoingBytes,
      );
    } catch {
      connection.socket.destroy();
    }
  }
}

export class AgentMemoryBrokerClient {
  private readonly socketPath: string;
  private readonly credential: CredentialRecord;
  private readonly maxFrameBytes: number;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;
  private readonly maxOutgoingBytes: number;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: TLSSocket | undefined;
  private decoder: NdjsonDecoder | undefined;
  private connecting: Promise<void> | undefined;
  private nextSeq = 1;
  private serverId: string | undefined;
  private readonly expectedServerId: string | undefined;
  private readonly nativeSessionId: string | undefined;
  private effectiveBinding: TrustedBinding | undefined;
  private registeredSessions = new Map<string, string>();

  constructor(options: BrokerClientOptions) {
    this.socketPath = options.socketPath;
    this.credential = { binding: options.credential.binding, secret: Buffer.from(options.credential.secret), allowNativeSessions: false };
    if (this.credential.secret.length < 32) throw new BrokerError("authentication_failed");
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 2_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.maxPendingRequests = options.maxPendingRequests ?? 64;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1024 || this.maxFrameBytes > MAX_CONFIGURED_FRAME_BYTES) {
      throw new BrokerError("request_invalid");
    }
    if (!Number.isSafeInteger(this.handshakeTimeoutMs) || this.handshakeTimeoutMs < 100) throw new BrokerError("request_invalid");
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 50) throw new BrokerError("request_invalid");
    if (!Number.isSafeInteger(this.maxPendingRequests) || this.maxPendingRequests < 1 || this.maxPendingRequests > 1_024) {
      throw new BrokerError("request_invalid");
    }
    this.maxOutgoingBytes = Math.min(MAX_OUTGOING_BYTES, this.maxFrameBytes * 2);
    this.expectedServerId = options.expectedServerId;
    if (options.nativeSessionId !== undefined) {
      try {
        createNativeSessionBinding(this.credential.binding, options.nativeSessionId);
      } catch {
        throw new BrokerError("request_invalid");
      }
    }
    this.nativeSessionId = options.nativeSessionId;
  }

  get connectedServerId(): string | undefined {
    return this.serverId;
  }

  get connectedBinding(): TrustedBinding {
    return this.effectiveBinding ?? this.credential.binding;
  }

  get registeredSessionIds(): ReadonlyMap<string, string> {
    return new Map(this.registeredSessions);
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined && !this.socket.destroyed && this.serverId !== undefined) return;
    if (this.connecting !== undefined) return this.connecting;
    if (this.socket?.destroyed === true) {
      this.rejectPending(new BrokerError("transport_closed"));
      this.socket = undefined;
      this.decoder = undefined;
      this.serverId = undefined;
      this.effectiveBinding = undefined;
      this.registeredSessions = new Map();
      this.nextSeq = 1;
    }
    let socket: TLSSocket;
    try {
      socket = tlsConnect(tlsClientOptions(this.socketPath, this.credential.binding.binding_id, this.credential.secret));
    } catch {
      throw new BrokerError("transport_closed");
    }
    this.socket = socket;
    this.decoder = new NdjsonDecoder(this.maxFrameBytes);
    this.serverId = undefined;
    this.effectiveBinding = undefined;
    this.registeredSessions = new Map();
    this.nextSeq = 1;
    const state = { settled: false };
    let resolveConnect!: () => void;
    let rejectConnect!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveConnect = (): void => {
        if (state.settled) return;
        state.settled = true;
        resolvePromise();
      };
      rejectConnect = (error: Error): void => {
        if (state.settled) return;
        state.settled = true;
        rejectPromise(error);
      };
    });
    this.connecting = promise;
    promise
      .finally(() => {
        if (this.connecting === promise) this.connecting = undefined;
      })
      .catch(() => undefined);

    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    const clearFrameTimer = (): void => {
      if (frameTimer !== undefined) clearTimeout(frameTimer);
      frameTimer = undefined;
    };
    const updateFrameTimer = (): void => {
      if (this.socket !== socket || socket.destroyed || this.serverId === undefined) return;
      if (this.decoder?.hasPendingBytes() === true) {
        if (frameTimer === undefined) {
          frameTimer = setTimeout(() => {
            frameTimer = undefined;
            failConnection(new BrokerError("frame_truncated"));
          }, this.requestTimeoutMs);
        }
        return;
      }
      clearFrameTimer();
    };
    const failConnection = (error: BrokerError): void => {
      clearFrameTimer();
      rejectConnect(error);
      if (this.socket === socket) this.rejectPending(error);
      socket.destroy();
    };
    socket.setTimeout(this.handshakeTimeoutMs, () => failConnection(new BrokerError("transport_timeout")));
    socket.once("secureConnect", () => {
      try {
        writeBoundedFrame(
          socket,
          {
            version: 1,
            kind: "hello",
            binding_id: this.credential.binding.binding_id,
            ...(this.nativeSessionId === undefined ? {} : { native_session_id: this.nativeSessionId }),
          },
          this.maxFrameBytes,
          this.maxOutgoingBytes,
        );
      } catch {
        failConnection(new BrokerError("request_invalid"));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (this.socket !== socket) return;
      let frames: unknown[];
      try {
        frames = this.decoder?.push(chunk) ?? [];
      } catch (error: unknown) {
        const code = error instanceof IpcProtocolError ? mapTransportError(error) : "invalid_frame";
        failConnection(new BrokerError(code));
        return;
      }
      if (frames.length > 0) clearFrameTimer();
      for (const frame of frames) {
        if (this.socket !== socket || socket.destroyed) return;
        if (this.serverId === undefined) {
          const ready = readySchema.safeParse(frame);
          if (!ready.success) {
            const error = errorResponseSchema.safeParse(frame);
            failConnection(error.success ? brokerErrorFromWire(error.data.code) : new BrokerError("authentication_failed"));
            return;
          }
          if (ready.data.binding_id !== this.credential.binding.binding_id) {
            failConnection(new BrokerError("authentication_failed"));
            return;
          }
          if (this.expectedServerId !== undefined && ready.data.server_id !== this.expectedServerId) {
            failConnection(new BrokerError("server_identity_mismatch"));
            return;
          }
          if (this.nativeSessionId === undefined) {
            if (
              ready.data.native_session_id !== undefined ||
              ready.data.effective_binding !== undefined ||
              ready.data.registered_sessions !== undefined
            ) {
              failConnection(new BrokerError("authentication_failed"));
              return;
            }
          } else {
            if (
              ready.data.native_session_id !== this.nativeSessionId ||
              ready.data.effective_binding === undefined ||
              ready.data.registered_sessions === undefined
            ) {
              failConnection(new BrokerError("authentication_failed"));
              return;
            }
            try {
              const received = createTrustedBinding(ready.data.effective_binding);
              const expected = createNativeSessionBinding(this.credential.binding, this.nativeSessionId);
              if (bindingAuthorityKey(received) !== bindingAuthorityKey(expected)) {
                failConnection(new BrokerError("authentication_failed"));
                return;
              }
              const expectedScopeIds = [...expected.allowed_scope_ids].sort();
              const receivedScopeIds = Object.keys(ready.data.registered_sessions).sort();
              if (
                expectedScopeIds.length !== receivedScopeIds.length ||
                expectedScopeIds.some((scopeId, index) => scopeId !== receivedScopeIds[index])
              ) {
                failConnection(new BrokerError("authentication_failed"));
                return;
              }
              this.effectiveBinding = received;
              this.registeredSessions = new Map(Object.entries(ready.data.registered_sessions));
            } catch {
              failConnection(new BrokerError("authentication_failed"));
              return;
            }
          }
          this.serverId = ready.data.server_id;
          socket.setTimeout(0);
          resolveConnect();
          continue;
        }
        const error = errorResponseSchema.safeParse(frame);
        if (error.success) {
          if (error.data.request_id === undefined) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          const pending = this.pending.get(error.data.request_id);
          if (pending === undefined || (error.data.seq !== undefined && error.data.seq !== pending.seq)) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          this.clearPending(error.data.request_id, pending);
          pending.reject(brokerErrorFromWire(error.data.code));
          continue;
        }
        const rpcResponse = rpcResponseSchema.safeParse(frame);
        if (rpcResponse.success) {
          const pending = this.pending.get(rpcResponse.data.request_id);
          if (pending === undefined || pending.kind !== "rpc" || pending.seq !== rpcResponse.data.seq) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          this.clearPending(rpcResponse.data.request_id, pending);
          pending.resolve(rpcResponse.data.result);
          continue;
        }
        const recallResponse = recallResponseSchema.safeParse(frame);
        if (recallResponse.success) {
          const pending = this.pending.get(recallResponse.data.request_id);
          if (pending === undefined || pending.kind !== "recall" || pending.seq !== recallResponse.data.seq) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          let packet: EvidencePacket;
          try {
            packet = validateBoundEvidencePacket(recallResponse.data.packet, this.connectedBinding);
          } catch {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          this.clearPending(recallResponse.data.request_id, pending);
          pending.resolve(packet);
          continue;
        }
        const handoffResponse = createHandoffResponseSchema.safeParse(frame);
        if (handoffResponse.success) {
          const pending = this.pending.get(handoffResponse.data.request_id);
          if (pending === undefined || pending.kind !== "create_handoff" || pending.seq !== handoffResponse.data.seq) {
            failConnection(new BrokerError("invalid_frame")); return;
          }
          this.clearPending(handoffResponse.data.request_id, pending);
          pending.resolve(handoffResponse.data.wire);
          continue;
        }
        const recognizeResponse = recognizeContextResponseSchema.safeParse(frame);
        if (recognizeResponse.success) {
          const pending = this.pending.get(recognizeResponse.data.request_id);
          if (pending === undefined || pending.kind !== "recognize_context" || pending.seq !== recognizeResponse.data.seq) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          this.clearPending(recognizeResponse.data.request_id, pending);
          pending.resolve(recognizeResponse.data.recognized);
          continue;
        }
        const nativeObserveResponse = nativeObserveResponseSchema.safeParse(frame);
        if (nativeObserveResponse.success) {
          const pending = this.pending.get(nativeObserveResponse.data.request_id);
          if (pending === undefined || pending.kind !== "native_observe" || pending.seq !== nativeObserveResponse.data.seq) {
            failConnection(new BrokerError("invalid_frame"));
            return;
          }
          this.clearPending(nativeObserveResponse.data.request_id, pending);
          pending.resolve(nativeObserveResponse.data.result);
          continue;
        }
        const response = captureResponseSchema.safeParse(frame);
        if (!response.success) {
          failConnection(new BrokerError("invalid_frame"));
          return;
        }
        const pending = this.pending.get(response.data.request_id);
        if (pending === undefined || pending.kind !== "capture" || pending.seq !== response.data.seq) {
          failConnection(new BrokerError("invalid_frame"));
          return;
        }
        let ack: CaptureAck;
        try {
          ack = parseCaptureAck(response.data.ack);
        } catch {
          failConnection(new BrokerError("invalid_frame"));
          return;
        }
        this.clearPending(response.data.request_id, pending);
        pending.resolve(ack);
      }
      updateFrameTimer();
    });
    socket.once("end", () => {
      if (this.socket !== socket) return;
      try {
        this.decoder?.finish();
      } catch (error: unknown) {
        const code = error instanceof IpcProtocolError ? mapTransportError(error) : "frame_truncated";
        failConnection(new BrokerError(code));
      }
    });
    socket.once("error", () => {
      if (this.socket === socket) failConnection(new BrokerError("transport_closed"));
    });
    socket.once("close", () => {
      // A delayed close from an old socket must not tear down a newer connection.
      if (this.socket !== socket) return;
      clearFrameTimer();
      if (!state.settled) rejectConnect(new BrokerError("transport_closed"));
      this.rejectPending(new BrokerError("transport_closed"));
      this.socket = undefined;
      this.decoder = undefined;
      this.serverId = undefined;
      this.effectiveBinding = undefined;
      this.registeredSessions = new Map();
      this.nextSeq = 1;
    });
    return promise;
  }

  async capture(
    event: unknown,
    sourceSpans: readonly SourceSpanInput[] = [],
  ): Promise<CaptureAck> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame(
        { version: 1, kind: "capture", seq, request_id: requestId, event, source_spans: sourceSpans },
        this.maxFrameBytes,
      );
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<CaptureAck>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = { kind: "capture", seq, resolve: (value) => resolveResult(value as CaptureAck), reject: rejectResult, timer };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  async recall(request: unknown, context: unknown): Promise<EvidencePacket> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame(
        { version: 1, kind: "recall", seq, request_id: requestId, request, context },
        this.maxFrameBytes,
      );
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<EvidencePacket>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = { kind: "recall", seq, resolve: (value) => resolveResult(value as EvidencePacket), reject: rejectResult, timer };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  async rpc(payload: unknown): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame(
        { version: 1, kind: "rpc_request", seq, request_id: requestId, payload },
        this.maxFrameBytes,
      );
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<unknown>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = { kind: "rpc", seq, resolve: resolveResult, reject: rejectResult, timer };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  /** Create target-bound wire for delivery through the target's existing context input. */
  async createHandoff(targetBindingId: string, context: unknown): Promise<string> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame(
        { version: 1, kind: "create_handoff", seq, request_id: requestId, target_binding_id: targetBindingId, context },
        this.maxFrameBytes,
      );
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<string>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = {
        kind: "create_handoff",
        seq,
        resolve: (value) => resolveResult(value as string),
        reject: rejectResult,
        timer,
      };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  async recognizeContext(context: unknown): Promise<boolean> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame(
        { version: 1, kind: "recognize_context", seq, request_id: requestId, context },
        this.maxFrameBytes,
      );
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<boolean>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = {
        kind: "recognize_context",
        seq,
        resolve: (value) => resolveResult(value as boolean),
        reject: rejectResult,
        timer,
      };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  async nativeObserve(operation: unknown): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || this.serverId === undefined) throw new BrokerError("broker_not_started");
    if (this.pending.size >= this.maxPendingRequests) throw new BrokerError("pending_limit");
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new BrokerError("request_replay");
    const seq = this.nextSeq;
    const requestId = randomUUID();
    let encoded: Buffer;
    try {
      encoded = encodeFrame({ ...operation as Record<string, unknown>, version: 1, kind: "native_observe", seq, request_id: requestId }, this.maxFrameBytes);
    } catch (error: unknown) {
      throw error instanceof IpcProtocolError ? new BrokerError(mapTransportError(error)) : new BrokerError("request_invalid");
    }
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return new Promise<unknown>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (pending === undefined) return;
        this.clearPending(requestId, pending);
        rejectResult(new BrokerError("transport_timeout"));
        if (this.socket === socket) socket.destroy();
      }, this.requestTimeoutMs);
      const pending: PendingRequest = { kind: "native_observe", seq, resolve: resolveResult, reject: rejectResult, timer };
      this.pending.set(requestId, pending);
      try {
        writeEncodedFrame(socket, encoded, this.maxOutgoingBytes);
      } catch (error: unknown) {
        this.clearPending(requestId, pending);
        rejectResult(error instanceof Error ? error : new BrokerError("request_invalid"));
      }
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      if (this.connecting !== undefined) {
        try {
          await this.connecting;
        } catch {
          // The connection attempt has already reported its failure.
        }
      }
      return;
    }
    this.rejectPending(new BrokerError("transport_closed"));
    await new Promise<void>((resolveClose) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolveClose();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
        finish();
      }, this.handshakeTimeoutMs);
      socket.once("close", finish);
      if (socket.destroyed) finish();
      else socket.end();
    });
    if (this.socket === socket) {
      this.socket = undefined;
      this.decoder = undefined;
      this.serverId = undefined;
      this.effectiveBinding = undefined;
      this.registeredSessions = new Map();
      this.nextSeq = 1;
    }
  }

  private clearPending(requestId: string, pending: PendingRequest): void {
    if (this.pending.get(requestId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.clearPending(requestId, pending);
      pending.reject(error);
    }
  }
}
