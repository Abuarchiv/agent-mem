import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { nativeReconcileCoverageSchema, type NativeReconcileCoverage, nonNegativeInt64Schema, parseCaptureAck, parseEvidencePacket, type CaptureAck, type EvidencePacket, type NativeObservationIdentity, type NativeReconcileCursor, type RecallRequest } from "../../src/host/contract.js";
import { encodeFrame, IpcProtocolError, NdjsonDecoder } from "../../src/host/ipc.js";
import type { NativeEventInput } from "../../src/host/events.js";

export const OPENCODE_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const OPENCODE_BRIDGE_MAX_FRAME_BYTES = 4_500_000;
export const OPENCODE_BRIDGE_MAX_PENDING = 32;
export const OPENCODE_BRIDGE_MAX_STDERR_BYTES = 64 * 1024;
export const OPENCODE_BRIDGE_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

const opaqueIdSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(4_096);

/** The event DTO crosses the plugin/Node boundary without a scope or timestamp. */
export type OpenCodeBridgeEvent = Omit<NativeEventInput, "version" | "scope_id" | "adapter_version" | "captured_at">;

export interface OpenCodeReconcileObservation {
  readonly identity: NativeObservationIdentity;
  readonly event: OpenCodeBridgeEvent;
}

export interface OpenCodeReconcileScan {
  readonly coverage: NativeReconcileCoverage;
  readonly scan_id: string;
  readonly scope_id: string;
  readonly binding_id: string;
  readonly native_session_id: string;
  readonly watermark: string;
  readonly cursor: NativeReconcileCursor | null;
  readonly state: "active" | "completed" | "invalidated";
}

export interface OpenCodeReconcileGap {
  readonly identity_key: string;
  readonly reason: string;
}

export interface OpenCodeReconcileResult {
  readonly scan: OpenCodeReconcileScan;
  readonly acknowledgements: readonly CaptureAck[];
  readonly cursor_committed: boolean;
  readonly gaps: readonly OpenCodeReconcileGap[];
}

export type OpenCodeBridgeRequest =
  | { readonly version: 1; readonly kind: "reconcile_start"; readonly request_id: string; readonly seq: number; readonly native_session_id: string; readonly cwd: string }

  | {
      readonly version: 1;
      readonly kind: "open_session";
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
    }
  | {
      readonly version: 1;
      readonly kind: "capture";
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
      readonly event: OpenCodeBridgeEvent;
    }
  | {
      readonly version: 1;
      readonly kind: "observe";
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
      readonly event: OpenCodeBridgeEvent;
      readonly identity: NativeObservationIdentity;
    }
  | {
      readonly version: 1;
      readonly kind: "reconcile";
      readonly scan?: OpenCodeReconcileScan | undefined;
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
      readonly observations: readonly OpenCodeReconcileObservation[];
      readonly cursor: NativeReconcileCursor | null;
      readonly complete: boolean;
      readonly gaps: readonly OpenCodeReconcileGap[];
    }
  | {
      readonly version: 1;
      readonly kind: "recall";
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
      readonly query?: string | undefined;
      readonly mode: RecallRequest["mode"];
      readonly token_budget: number;
      readonly kind_hint: "session_start" | "user_prompt";
      readonly deadline_at: string;
      readonly capture_status:
        | { readonly state: "committed"; readonly capture_id: string }
        | { readonly state: "failed" }
        | { readonly state: "not_attempted" };
    }
  | {
      readonly version: 1; readonly kind: "create_handoff"; readonly request_id: string; readonly seq: number;
      readonly native_session_id: string; readonly cwd: string; readonly target_binding_id: string; readonly context: unknown;
    }
  | {
      readonly version: 1;
      readonly kind: "recognize_context";
      readonly request_id: string;
      readonly seq: number;
      readonly native_session_id: string;
      readonly cwd: string;
      readonly context: unknown;
    }
  | {
      readonly version: 1;
      readonly kind: "close";
      readonly request_id: string;
      readonly seq: number;
    };

export interface OpenCodeBridgeCallOptions {
  /** Issued before the native read; never attach to an already-read snapshot. */
  readonly reconcileScan?: OpenCodeReconcileScan;
  readonly signal?: AbortSignal;
  /** An absolute wall-clock deadline shared by the hook and all retries. */
  readonly deadlineAt?: number;
}

export interface OpenCodeBridgeClientOptions {
  readonly nodePath: string;
  readonly bridgePath: string;
  readonly configPath: string;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  /** The only environment value permitted for the owned helper. */
  readonly helperPath?: string;
  readonly spawnProcess?: typeof spawn;
}

export interface OpenCodeBridge {
  beginReconcile?(nativeSessionId: string, cwd: string, options?: OpenCodeBridgeCallOptions): Promise<OpenCodeReconcileScan>;
  openSession(nativeSessionId: string, cwd: string, options?: OpenCodeBridgeCallOptions): Promise<void>;
  capture(nativeSessionId: string, cwd: string, event: OpenCodeBridgeEvent, options?: OpenCodeBridgeCallOptions): Promise<CaptureAck>;
  observeNative?(
    nativeSessionId: string,
    cwd: string,
    event: OpenCodeBridgeEvent,
    identity: NativeObservationIdentity,
    options?: OpenCodeBridgeCallOptions,
  ): Promise<CaptureAck>;
  reconcile?(
    nativeSessionId: string,
    cwd: string,
    observations: readonly OpenCodeReconcileObservation[],
    cursor: NativeReconcileCursor | null,
    complete: boolean,
    gaps: readonly OpenCodeReconcileGap[],
    options?: OpenCodeBridgeCallOptions,
  ): Promise<OpenCodeReconcileResult>;
  recall(
    nativeSessionId: string,
    cwd: string,
    input: {
      readonly query?: string | undefined;
      readonly mode: RecallRequest["mode"];
      readonly token_budget: number;
      readonly kind_hint: "session_start" | "user_prompt";
      readonly deadline_at: string;
      readonly capture_status:
        | { readonly state: "committed"; readonly capture_id: string }
        | { readonly state: "failed" }
        | { readonly state: "not_attempted" };
    },
    options?: OpenCodeBridgeCallOptions,
  ): Promise<EvidencePacket>;
  recognizeContext(nativeSessionId: string, cwd: string, context: unknown, options?: OpenCodeBridgeCallOptions): Promise<boolean>;
  close(): Promise<void>;
}

export class OpenCodeBridgeError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OpenCodeBridgeError";
  }
}

interface PendingResponse {
  readonly seq: number;
  readonly expected: readonly string[];
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const responseEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.string().min(1).max(64),
    request_id: z.uuid(),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .passthrough();
const reconcileScanSchema = z.object({
  scan_id: z.uuid(),
  scope_id: z.uuid(),
  binding_id: z.uuid(),
  native_session_id: opaqueIdSchema,
  watermark: nonNegativeInt64Schema,
  cursor: z.object({ message_id: opaqueIdSchema, part_id: opaqueIdSchema }).strict().nullable(),
  state: z.enum(["active", "completed", "invalidated"]),
  coverage: nativeReconcileCoverageSchema,
}).strict();
const reconcileGapSchema = z.object({ identity_key: z.string().min(1).max(1_024), reason: z.string().min(1).max(128) }).strict();
const reconcileResultSchema = z.object({
  scan: reconcileScanSchema,
  acknowledgements: z.array(z.unknown()).max(128),
  cursor_committed: z.boolean(),
  gaps: z.array(reconcileGapSchema).max(128),
}).strict();

function absoluteFile(path: string, name: string, executable: boolean): string {
  if (!isAbsolute(path)) throw new OpenCodeBridgeError(`${name}_must_be_absolute`);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (executable && (stat.mode & 0o111) === 0) || (!executable && (stat.mode & 0o444) === 0)) {
      throw new Error("file_mode_invalid");
    }
  } catch {
    throw new OpenCodeBridgeError(`${name}_unavailable`);
  }
  return path;
}

function positiveDeadline(options: OpenCodeBridgeCallOptions | undefined, fallbackMs: number): number {
  const fallback = Date.now() + fallbackMs;
  if (options?.deadlineAt === undefined) return fallback;
  if (!Number.isFinite(options.deadlineAt)) throw new OpenCodeBridgeError("deadline_invalid");
  return Math.min(fallback, options.deadlineAt);
}

function isRetryable(reason: string): boolean {
  return reason === "transport_closed" || reason === "transport_timeout" || reason === "frame_truncated";
}

function rejectError(reason: string): OpenCodeBridgeError {
  return new OpenCodeBridgeError(reason);
}

/**
 * Client-side transport for the one helper process owned by one plugin load.
 * It has no broker imports and therefore cannot open SQLite/ORT in OpenCode's
 * plugin runtime. The helper is multiplexed by native session id.
 */
export class OpenCodeBridgeClient implements OpenCodeBridge {
  private readonly nodePath: string;
  private readonly bridgePath: string;
  private readonly configPath: string;
  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly helperPath: string;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly ignoredRequestIds = new Set<string>();
  private readonly ignoredRequestOrder: string[] = [];
  private nextSeq = 1;
  private generation = 0;
  private terminationGeneration: number | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private queuedWriteBytes = 0;
  private readonly maxQueuedWriteBytes: number;
  private stderrBytes = 0;
  private closed = false;

  constructor(options: OpenCodeBridgeClientOptions) {
    this.nodePath = absoluteFile(options.nodePath, "node_path", true);
    this.bridgePath = absoluteFile(options.bridgePath, "bridge_path", false);
    this.configPath = absoluteFile(options.configPath, "config_path", false);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.maxFrameBytes = options.maxFrameBytes ?? OPENCODE_BRIDGE_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 50 || this.requestTimeoutMs > 30_000) {
      throw new OpenCodeBridgeError("request_timeout_invalid");
    }
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1_024 || this.maxFrameBytes > OPENCODE_BRIDGE_MAX_FRAME_BYTES) {
      throw new OpenCodeBridgeError("frame_limit_invalid");
    }
    this.maxQueuedWriteBytes = Math.min(OPENCODE_BRIDGE_MAX_QUEUED_BYTES, this.maxFrameBytes * 2);
    this.helperPath = options.helperPath ?? dirname(this.nodePath);
    if (!isAbsolute(this.helperPath)) throw new OpenCodeBridgeError("helper_path_must_be_absolute");
    try {
      if (!statSync(this.helperPath).isDirectory()) throw new Error("helper_path_not_directory");
    } catch {
      throw new OpenCodeBridgeError("helper_path_unavailable");
    }
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async openSession(nativeSessionId: string, cwd: string, options?: OpenCodeBridgeCallOptions): Promise<void> {
    opaqueIdSchema.parse(nativeSessionId);
    pathSchema.parse(cwd);
    await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "open_session",
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
      }),
      ["session_ready"],
      options,
    );
  }

  async capture(
    nativeSessionId: string,
    cwd: string,
    event: OpenCodeBridgeEvent,
    options?: OpenCodeBridgeCallOptions,
  ): Promise<CaptureAck> {
    const response = await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "capture",
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
        event,
      }),
      ["capture_ack"],
      options,
    );
    try {
      return parseCaptureAck(response.ack);
    } catch {
      throw new OpenCodeBridgeError("invalid_frame");
    }
  }

  async observeNative(
    nativeSessionId: string,
    cwd: string,
    event: OpenCodeBridgeEvent,
    identity: NativeObservationIdentity,
    options?: OpenCodeBridgeCallOptions,
  ): Promise<CaptureAck> {
    const response = await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "observe",
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
        event,
        identity,
      }),
      ["observe_ack"],
      options,
    );
    try {
      return parseCaptureAck(response.ack);
    } catch {
      throw new OpenCodeBridgeError("invalid_frame");
    }
  }

  async beginReconcile(nativeSessionId: string, cwd: string, options?: OpenCodeBridgeCallOptions): Promise<OpenCodeReconcileScan> {
    const response = await this.request((seq, request_id) => ({ version: 1, kind: "reconcile_start", seq, request_id, native_session_id: nativeSessionId, cwd }), ["reconcile_start_response"], options);
    const result = reconcileScanSchema.safeParse(response.scan);
    if (!result.success) throw new OpenCodeBridgeError("invalid_frame");
    return result.data;
  }

  async reconcile(
    nativeSessionId: string,
    cwd: string,
    observations: readonly OpenCodeReconcileObservation[],
    cursor: NativeReconcileCursor | null,
    complete: boolean,
    gaps: readonly OpenCodeReconcileGap[],
    options?: OpenCodeBridgeCallOptions,
  ): Promise<OpenCodeReconcileResult> {
    const response = await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "reconcile",
        ...(options?.reconcileScan === undefined ? {} : { scan: options.reconcileScan }),
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
        observations,
        cursor,
        complete,
        gaps,
      }),
      ["reconcile_response"],
      options,
    );
    const result = reconcileResultSchema.safeParse(response.result);
    if (!result.success) throw new OpenCodeBridgeError("invalid_frame");
    try {
      return {
        scan: result.data.scan,
        acknowledgements: result.data.acknowledgements.map((ack) => parseCaptureAck(ack)),
        cursor_committed: result.data.cursor_committed,
        gaps: result.data.gaps,
      };
    } catch {
      throw new OpenCodeBridgeError("invalid_frame");
    }
  }

  async recall(
    nativeSessionId: string,
    cwd: string,
    input: {
      readonly query?: string;
      readonly mode: RecallRequest["mode"];
      readonly token_budget: number;
      readonly kind_hint: "session_start" | "user_prompt";
      readonly deadline_at: string;
      readonly capture_status:
        | { readonly state: "committed"; readonly capture_id: string }
        | { readonly state: "failed" }
        | { readonly state: "not_attempted" };
    },
    options?: OpenCodeBridgeCallOptions,
  ): Promise<EvidencePacket> {
    const response = await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "recall",
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
        ...(input.query === undefined ? {} : { query: input.query }),
        mode: input.mode,
        token_budget: input.token_budget,
        kind_hint: input.kind_hint,
        deadline_at: input.deadline_at,
        capture_status: input.capture_status,
      }),
      ["recall_response"],
      options,
    );
    try {
      return parseEvidencePacket(response.packet);
    } catch {
      throw new OpenCodeBridgeError("invalid_frame");
    }
  }

  async createHandoff(nativeSessionId: string, cwd: string, targetBindingId: string, context: unknown, options?: OpenCodeBridgeCallOptions): Promise<string> {
    const response = await this.request((seq, requestId) => ({ version: 1, kind: "create_handoff", request_id: requestId,
      seq, native_session_id: nativeSessionId, cwd, target_binding_id: targetBindingId, context }), ["create_handoff_response"], options);
    if (typeof response.wire !== "string") throw new OpenCodeBridgeError("invalid_frame");
    return response.wire;
  }

  async recognizeContext(
    nativeSessionId: string,
    cwd: string,
    context: unknown,
    options?: OpenCodeBridgeCallOptions,
  ): Promise<boolean> {
    const response = await this.request(
      (seq, requestId) => ({
        version: 1,
        kind: "recognize_context",
        request_id: requestId,
        seq,
        native_session_id: nativeSessionId,
        cwd,
        context,
      }),
      ["recognize_context_response"],
      options,
    );
    return response.recognized === true;
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.rejectPending("transport_closed");
    const closing = this.closeOwnedChild();
    this.closePromise = closing;
    return closing;
  }

  private async closeOwnedChild(): Promise<void> {
    const start = this.startPromise;
    if (this.child === undefined && start !== undefined) await start.catch(() => undefined);
    const child = this.child;
    if (child === undefined) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      let settled = false;
      const generation = this.generation;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(hardTimer);
        resolveClose();
      };
      const failCleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(hardTimer);
        rejectClose(rejectError("cleanup_pending"));
      };
      const termTimer = setTimeout(() => this.terminateOwnedChild(child, generation), Math.min(200, this.requestTimeoutMs));
      const hardTimer = setTimeout(() => {
        this.terminateOwnedChild(child, generation);
        failCleanup();
      }, Math.min(500, Math.max(250, this.requestTimeoutMs)));
      termTimer.unref?.();
      hardTimer.unref?.();
      child.once("close", finish);
      try {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      } catch {
        this.terminateOwnedChild(child, generation);
      }
    });
  }

  private allocateSeq(): number {
    if (this.nextSeq > Number.MAX_SAFE_INTEGER) throw new OpenCodeBridgeError("request_replay");
    const seq = this.nextSeq;
    this.nextSeq = seq === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : seq + 1;
    return seq;
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new OpenCodeBridgeError("bridge_closed");
    const child = this.child;
    if (child !== undefined) {
      if (child.exitCode === null && child.signalCode === null) return;
      // A signal or exit code before the close event is not an absence proof;
      // never replace this owned generation while its streams are live.
      throw new OpenCodeBridgeError("transport_closed");
    }
    if (this.startPromise !== undefined) return this.startPromise;
    this.stderrBytes = 0;
    const start = new Promise<void>((resolveStart, rejectStart) => {
      let settled = false;
      let processChild: ChildProcessWithoutNullStreams;
      try {
        processChild = this.spawnProcess(
          this.nodePath,
          [this.bridgePath, "--config", this.configPath],
          {
            cwd: dirname(this.bridgePath),
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
            env: { PATH: this.helperPath },
          },
        ) as ChildProcessWithoutNullStreams;
      } catch {
        rejectStart(rejectError("bridge_spawn_failed"));
        return;
      }
      const generation = this.generation + 1;
      this.generation = generation;
      const decoder = new NdjsonDecoder(this.maxFrameBytes);
      this.child = processChild;
      const isCurrent = (): boolean => this.child === processChild && this.generation === generation;
      const fail = (reason: string): void => {
        if (!isCurrent()) return;
        this.rejectPending(reason);
        if (!settled) {
          settled = true;
          rejectStart(rejectError(reason));
        }
      };
      processChild.once("spawn", () => {
        if (settled) return;
        settled = true;
        resolveStart();
      });
      processChild.once("error", () => {
        if (!isCurrent()) return;
        this.failTransport("bridge_process_error");
        if (!settled) {
          settled = true;
          rejectStart(rejectError("bridge_process_error"));
        }
      });
      processChild.once("close", () => {
        if (isCurrent()) {
          fail("transport_closed");
          this.child = undefined;
          this.nextSeq = 1;
          this.ignoredRequestIds.clear();
          this.ignoredRequestOrder.length = 0;
          this.terminationGeneration = undefined;
          this.generation += 1;
        }
      });
      processChild.stdin.on("error", () => {
        if (isCurrent()) this.failTransport("transport_closed");
      });
      processChild.stdout.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        let frames: unknown[];
        try {
          frames = decoder.push(chunk);
        } catch (error: unknown) {
          const reason = error instanceof IpcProtocolError ? error.code : "invalid_frame";
          this.failTransport(reason);
          return;
        }
        for (const frame of frames) this.receive(frame);
      });
      processChild.stdout.once("error", () => {
        if (isCurrent()) this.failTransport("transport_closed");
      });
      processChild.stderr.on("data", (chunk: Buffer) => {
        if (!isCurrent()) return;
        this.stderrBytes += chunk.length;
        if (this.stderrBytes > OPENCODE_BRIDGE_MAX_STDERR_BYTES) {
          fail("stderr_too_large");
          this.terminateOwnedChild(processChild, generation);
        }
      });
      processChild.stderr.once("error", () => undefined);
    });
    this.startPromise = start;
    try {
      await start;
    } finally {
      if (this.startPromise === start) this.startPromise = undefined;
    }
  }

  private async request(
    build: (seq: number, requestId: string) => OpenCodeBridgeRequest,
    expected: readonly string[],
    options?: OpenCodeBridgeCallOptions,
  ): Promise<Record<string, unknown>> {
    const deadlineAt = positiveDeadline(options, this.requestTimeoutMs);
    if (deadlineAt <= Date.now() || options?.signal?.aborted === true) throw new OpenCodeBridgeError("deadline");
    await this.ensureStartedWithin(deadlineAt, options?.signal);
    if (this.pending.size >= OPENCODE_BRIDGE_MAX_PENDING) throw new OpenCodeBridgeError("pending_limit");
    const child = this.child;
    if (child === undefined || child.stdin.destroyed || child.stdin.writableEnded) throw new OpenCodeBridgeError("transport_closed");
    const generation = this.generation;
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0 || options?.signal?.aborted) throw new OpenCodeBridgeError("deadline");
    const requestId = randomUUID();
    const request = build(this.nextSeq, requestId);
    let encoded: Buffer;
    try {
      encoded = encodeFrame(request, this.maxFrameBytes);
    } catch (error: unknown) {
      throw new OpenCodeBridgeError(error instanceof IpcProtocolError ? error.code : "request_invalid");
    }
    if (this.queuedWriteBytes + encoded.length > this.maxQueuedWriteBytes) {
      throw new OpenCodeBridgeError("transport_backpressure");
    }
    const seq = request.seq;
    if (seq !== this.nextSeq) throw new OpenCodeBridgeError("request_replay");
    this.allocateSeq();
    return new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.request_id);
        if (pending === undefined) return;
        this.pending.delete(request.request_id);
        this.rememberIgnored(request.request_id);
        pending.reject(rejectError("transport_timeout"));
      }, remaining);
      timer.unref?.();
      this.pending.set(request.request_id, { seq: request.seq, expected, resolve: resolveResponse, reject: rejectResponse, timer });
      const abortListener = (): void => {
        const pending = this.pending.get(request.request_id);
        if (pending === undefined) return;
        this.pending.delete(request.request_id);
        clearTimeout(pending.timer);
        this.rememberIgnored(request.request_id);
        rejectResponse(rejectError("deadline"));
        this.failTransport("deadline");
      };
      options?.signal?.addEventListener("abort", abortListener, { once: true });
      const pending = this.pending.get(request.request_id);
      if (pending !== undefined) {
        const originalResolve = pending.resolve;
        const originalReject = pending.reject;
        pending.resolve = (value): void => {
          options?.signal?.removeEventListener("abort", abortListener);
          originalResolve(value);
        };
        pending.reject = (error): void => {
          options?.signal?.removeEventListener("abort", abortListener);
          originalReject(error);
        };
      }
      void this.enqueueWrite(child, generation, request.request_id, encoded, deadlineAt, options?.signal).catch((error: unknown) => {
        const current = this.pending.get(request.request_id);
        if (current !== undefined) {
          this.pending.delete(request.request_id);
          clearTimeout(current.timer);
          this.rememberIgnored(request.request_id);
          current.reject(error instanceof Error ? error : rejectError("transport_closed"));
        }
        // The write is bound to the child generation captured before it was
        // queued. An old write may reject after that child emitted `close`
        // and a new generation was started; it must never tear down the new
        // transport.
        if (
          this.child === child &&
          this.generation === generation &&
          error instanceof OpenCodeBridgeError &&
          (error.reason === "deadline" || error.reason === "transport_closed")
        ) {
          this.failTransport(error.reason);
        }
      });
    });
  }

  private enqueueWrite(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    requestId: string,
    encoded: Buffer,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    this.queuedWriteBytes += encoded.length;
    const prior = this.writeTail.catch(() => undefined);
    const write = prior.then(() => this.writeOne(child, generation, requestId, encoded, deadlineAt, signal));
    this.writeTail = write
      .catch(() => undefined)
      .then(() => {
        this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - encoded.length);
      });
    return write;
  }

  private async writeOne(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    requestId: string,
    encoded: Buffer,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (this.child !== child || this.generation !== generation) throw rejectError("transport_closed");
    if (!this.pending.has(requestId)) throw rejectError("transport_timeout");
    if (signal?.aborted === true || deadlineAt <= Date.now()) throw rejectError("deadline");
    let writable: boolean;
    try {
      writable = child.stdin.write(encoded);
    } catch {
      throw rejectError("transport_closed");
    }
    if (!writable) {
      await this.waitForDrain(child, generation, deadlineAt, signal);
      if (this.child !== child || this.generation !== generation) throw rejectError("transport_closed");
    }
  }

  private waitForDrain(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0 || signal?.aborted === true) return Promise.reject(rejectError("deadline"));
    return new Promise<void>((resolveDrain, rejectDrain) => {
      let settled = false;
      const timer = setTimeout(() => finishFailure("deadline"), remaining);
      timer.unref?.();
      const finish = (): void => {
        if (settled) return;
        if (this.child !== child || this.generation !== generation) {
          finishFailure("transport_closed");
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stdin.off("drain", finish);
        child.stdin.off("error", onError);
        child.stdin.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        resolveDrain();
      };
      const finishFailure = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.off("drain", finish);
        child.stdin.off("error", onError);
        child.stdin.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
        rejectDrain(rejectError(reason));
      };
      const onError = (): void => finishFailure("transport_closed");
      const onClose = (): void => finishFailure("transport_closed");
      const onAbort = (): void => finishFailure("deadline");
      if (this.child !== child || this.generation !== generation) {
        finishFailure("transport_closed");
        return;
      }
      child.stdin.once("drain", finish);
      child.stdin.once("error", onError);
      child.stdin.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private receive(frame: unknown): void {
    const parsed = responseEnvelopeSchema.safeParse(frame);
    if (!parsed.success) {
      this.failTransport("invalid_frame");
      return;
    }
    const pending = this.pending.get(parsed.data.request_id);
    if (pending === undefined) {
      if (this.ignoredRequestIds.delete(parsed.data.request_id)) return;
      this.failTransport("invalid_frame");
      return;
    }
    if (pending.seq !== parsed.data.seq) {
      this.failTransport("invalid_frame");
      return;
    }
    this.pending.delete(parsed.data.request_id);
    clearTimeout(pending.timer);
    if (parsed.data.kind === "error") {
      const code = typeof parsed.data.code === "string" ? parsed.data.code : "bridge_failed";
      pending.reject(rejectError(code));
      return;
    }
    if (!pending.expected.includes(parsed.data.kind)) {
      pending.reject(rejectError("invalid_frame"));
      this.failTransport("invalid_frame");
      return;
    }
    pending.resolve(parsed.data);
  }

  private rejectPending(reason: string): void {
    const error = rejectError(reason);
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private failTransport(reason: string): void {
    this.rejectPending(reason);
    const child = this.child;
    if (child !== undefined) this.terminateOwnedChild(child, this.generation);
  }

  private terminateOwnedChild(child: ChildProcessWithoutNullStreams, generation: number): void {
    if (this.child !== child || this.generation !== generation) return;
    if (this.terminationGeneration === generation) return;
    this.terminationGeneration = generation;
    try {
      child.stdin.destroy();
    } catch {
      // The owned stream may already be closing.
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    else if (child.exitCode === null) child.kill("SIGKILL");
    const hardTimer = setTimeout(() => {
      if (this.child !== child || this.generation !== generation) return;
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 100);
    hardTimer.unref?.();
  }

  private rememberIgnored(requestId: string): void {
    if (this.ignoredRequestIds.has(requestId)) return;
    this.ignoredRequestIds.add(requestId);
    this.ignoredRequestOrder.push(requestId);
    while (this.ignoredRequestOrder.length > 256) {
      const oldest = this.ignoredRequestOrder.shift();
      if (oldest !== undefined) this.ignoredRequestIds.delete(oldest);
    }
  }

  private async ensureStartedWithin(deadlineAt: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) throw new OpenCodeBridgeError("deadline");
    const remaining = Math.floor(deadlineAt - Date.now());
    if (remaining <= 0) throw new OpenCodeBridgeError("deadline");
    const pending = this.ensureStarted();
    void pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(rejectError("deadline")), remaining);
      timer.unref?.();
      listener = (): void => reject(rejectError("deadline"));
      signal?.addEventListener("abort", listener, { once: true });
    });
    try {
      await Promise.race([pending, expiry]);
    } catch (error: unknown) {
      if (error instanceof OpenCodeBridgeError && error.reason === "deadline") this.failTransport("deadline");
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (listener !== undefined) signal?.removeEventListener("abort", listener);
    }
  }
}

export function isRetryableOpenCodeBridgeError(error: unknown): boolean {
  return error instanceof OpenCodeBridgeError && isRetryable(error.reason);
}
