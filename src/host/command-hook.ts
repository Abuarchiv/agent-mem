import { realpathSync, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { isAbsolute, relative } from "node:path";

import { BrokerError, type BrokerClientOptions } from "./broker.js";
import type { CaptureAck } from "./contract.js";
import type { TrustedBinding } from "./contract.js";

export interface CommandHookWorkspaceRoute {
  readonly scope_id: string;
  readonly workspace_roots: readonly string[];
}

export class CommandHookBoundaryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CommandHookBoundaryError";
  }
}

function canonicalDirectory(path: string, name: string): string {
  if (!isAbsolute(path)) throw new CommandHookBoundaryError(`${name}_must_be_absolute`);
  try {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not_directory");
    return canonical;
  } catch {
    throw new CommandHookBoundaryError(`${name}_unavailable`);
  }
}

function contained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder));
}

/** Match a native cwd against explicit canonical workspace routes only. */
export function resolveConfiguredWorkspace<T extends CommandHookWorkspaceRoute>(cwd: string, routes: readonly T[]): T {
  const canonicalCwd = canonicalDirectory(cwd, "cwd");
  const matches: T[] = [];
  for (const route of routes) {
    const roots = route.workspace_roots.map((root) => canonicalDirectory(root, "workspace_root"));
    if (roots.some((root) => contained(root, canonicalCwd))) matches.push(route);
  }
  if (matches.length === 0) throw new CommandHookBoundaryError("cwd_outside_configured_workspace");
  if (matches.length !== 1) throw new CommandHookBoundaryError("cwd_route_ambiguous");
  const [match] = matches;
  if (match === undefined) throw new CommandHookBoundaryError("cwd_route_missing");
  return match;
}

export interface NativeSessionClient {
  readonly connectedBinding: TrustedBinding;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeSessionClientPoolOptions<Client extends NativeSessionClient> {
  readonly clientFactory: (options: BrokerClientOptions) => Client;
  readonly clientOptions: Omit<BrokerClientOptions, "nativeSessionId">;
  readonly maxSessions?: number;
}

/** Owns one authenticated connection per native session and closes all of them. */
export class NativeSessionClientPool<Client extends NativeSessionClient> {
  private readonly clientFactory: (options: BrokerClientOptions) => Client;
  private readonly clientOptions: Omit<BrokerClientOptions, "nativeSessionId">;
  private readonly maxSessions: number;
  private readonly clients = new Map<string, Client>();

  constructor(options: NativeSessionClientPoolOptions<Client>) {
    this.clientFactory = options.clientFactory;
    this.clientOptions = options.clientOptions;
    this.maxSessions = options.maxSessions ?? 32;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 1_024) {
      throw new CommandHookBoundaryError("native_session_limit_invalid");
    }
  }

  async get(nativeSessionId: string): Promise<Client> {
    let client = this.clients.get(nativeSessionId);
    if (client === undefined) {
      if (this.clients.size >= this.maxSessions) throw new CommandHookBoundaryError("native_session_limit");
      client = this.clientFactory({ ...this.clientOptions, nativeSessionId });
      this.clients.set(nativeSessionId, client);
    }
    await client.connect();
    if (client.connectedBinding.host_session_id !== nativeSessionId) {
      throw new CommandHookBoundaryError("native_session_binding_mismatch");
    }
    return client;
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }
}

export interface ImmutableCaptureClient {
  connect(): Promise<void>;
  capture(event: unknown): Promise<CaptureAck>;
}

export interface ImmutableCaptureRetryOptions {
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void | Promise<void>;
}

function retryableTransport(error: unknown): boolean {
  if (!(error instanceof BrokerError)) return false;
  return error.code === "transport_closed" || error.code === "transport_timeout" || error.code === "frame_truncated";
}

/** Retry one lost ACK without regenerating any part of the normalized event. */
export async function captureWithImmutableRetry<Client extends ImmutableCaptureClient>(
  client: Client,
  event: unknown,
  options: ImmutableCaptureRetryOptions = {},
): Promise<CaptureAck> {
  ensureRetryActive(options);
  try {
    const ack = await awaitWithAbort(client.capture(event), options);
    ensureRetryActive(options);
    return ack;
  } catch (error: unknown) {
    if (!retryableTransport(error)) throw error;
    ensureRetryActive(options);
    await awaitWithAbort(client.connect(), options);
    ensureRetryActive(options);
    const ack = await awaitWithAbort(client.capture(event), options);
    ensureRetryActive(options);
    return ack;
  }
}

function invokeAbort(options: ImmutableCaptureRetryOptions): void {
  try {
    const result = options.onAbort?.();
    if (result !== undefined && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Cleanup is retried/diagnosed by the owning hook boundary.
  }
}

function ensureRetryActive(options: ImmutableCaptureRetryOptions): void {
  if (options.signal?.aborted === true) {
    invokeAbort(options);
    throw new CommandHookTimeout();
  }
}

async function awaitWithAbort<Result>(promise: Promise<Result>, options: ImmutableCaptureRetryOptions): Promise<Result> {
  ensureRetryActive(options);
  const signal = options.signal;
  if (signal === undefined) return promise;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = (): void => {
      invokeAbort(options);
      reject(new CommandHookTimeout());
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
}

export class CommandHookTimeout extends Error {
  constructor() {
    super("command_hook_timeout");
    this.name = "CommandHookTimeout";
  }
}

export interface CommandHookDeadline {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  remainingMs(): number;
  throwIfExpired(): void;
}

function makeDeadline(timeoutMs: number, signal: AbortSignal): CommandHookDeadline {
  const deadlineAt = Date.now() + timeoutMs;
  return {
    signal,
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    throwIfExpired: () => {
      if (Date.now() >= deadlineAt || signal.aborted) throw new CommandHookTimeout();
    },
  };
}

export interface BoundedCommandHookOptions<Result> {
  readonly timeoutMs: number;
  readonly maxInputBytes?: number;
  readonly cleanupTimeoutMs?: number;
  readonly readInput?: (deadline: CommandHookDeadline) => Promise<string>;
  readonly handle: (input: string, deadline: CommandHookDeadline) => Promise<Result>;
  readonly cleanup: () => Promise<void>;
  readonly writeOutput: (result: Result) => void;
  readonly writeFallback: () => void;
}

/** Run one synchronous command-hook invocation under one deadline and cleanup boundary. */
export async function runBoundedCommandHook<Result>(options: BoundedCommandHookOptions<Result>): Promise<void> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000) {
    throw new CommandHookBoundaryError("hook_timeout_invalid");
  }
  const controller = new AbortController();
  const deadline = makeDeadline(options.timeoutMs, controller.signal);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutTimer = setTimeout(() => {
      controller.abort();
      reject(new CommandHookTimeout());
    }, options.timeoutMs);
  });
  const readInput = options.readInput ?? ((currentDeadline) => readBoundedStdin(currentDeadline, options.maxInputBytes ?? 1_000_000));
  let result: Result | undefined;
  let succeeded = false;
  let outputWritten = false;
  try {
    const operation = (async (): Promise<Result> => {
      const input = await readInput(deadline);
      deadline.throwIfExpired();
      return options.handle(input, deadline);
    })();
    result = await Promise.race([operation, timeout]);
    deadline.throwIfExpired();
    succeeded = true;
    if (result !== undefined) {
      options.writeOutput(result);
      outputWritten = true;
    }
  } catch {
    succeeded = false;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? Math.min(500, Math.max(50, options.timeoutMs));
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupDeadline = new Promise<boolean>((resolveCleanup) => {
      cleanupTimer = setTimeout(() => resolveCleanup(false), cleanupTimeoutMs);
      cleanupTimer.unref?.();
    });
    const cleanupResult = options.cleanup().then(
      () => true,
      () => false,
    );
    await Promise.race([cleanupResult, cleanupDeadline]);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    controller.abort();
  }
  if (!succeeded || !outputWritten) options.writeFallback();
}

function readBoundedStdin(deadline: CommandHookDeadline, maxBytes: number): Promise<string> {
  return readBoundedStream(process.stdin, deadline, maxBytes, { destroyOnFailure: true });
}

export interface BoundedStreamOptions {
  readonly destroyOnFailure?: boolean;
}

export function readBoundedStream(
  stream: Readable,
  deadline: CommandHookDeadline,
  maxBytes: number,
  options: BoundedStreamOptions = {},
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Promise.reject(new CommandHookBoundaryError("input_bound_invalid"));
  return new Promise<string>((resolveInput, rejectInput) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      deadline.signal.removeEventListener("abort", onAbort);
    };
    const stopOwnedStream = (): void => {
      try {
        stream.pause();
      } catch {
        // The stream may already be closed.
      }
      if (options.destroyOnFailure !== true || typeof stream.destroy !== "function") return;
      const swallowDestroyError = (): void => undefined;
      stream.once("error", swallowDestroyError);
      stream.once("close", () => stream.off("error", swallowDestroyError));
      try {
        stream.destroy();
      } catch {
        stream.off("error", swallowDestroyError);
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      stopOwnedStream();
      cleanup();
      rejectInput(error);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveInput(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        fail(new CommandHookBoundaryError("input_too_large"));
        return;
      }
      chunks.push(buffer);
      try {
        deadline.throwIfExpired();
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new CommandHookTimeout());
      }
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => fail(error);
    const onAbort = (): void => fail(new CommandHookTimeout());
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new CommandHookTimeout()), Math.max(1, deadline.remainingMs()));
    try {
      deadline.throwIfExpired();
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new CommandHookTimeout());
    }
  });
}
