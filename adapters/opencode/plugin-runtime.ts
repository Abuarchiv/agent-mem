import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";
import type { Hooks, PluginOptions, PluginInput } from "@opencode-ai/plugin";
import type { Event, Message, Part, TextPart, UserMessage } from "@opencode-ai/sdk";

import {
  OpenCodeBridgeClient,
  OpenCodeBridgeError,
  isRetryableOpenCodeBridgeError,
  type OpenCodeBridge,
  type OpenCodeBridgeCallOptions,
  type OpenCodeBridgeEvent,
} from "./bridge-client.js";
import { parseDirectedEvidenceHandoff, parseModelContextWrapper, serializeModelContext } from "../../src/context/packet.js";
import { validateBoundedJson, type CaptureAck, type NativeObservationIdentity, type NativeReconcileCursor, type SourceCoverage, type NativeReconcileCoverage } from "../../src/host/contract.js";
import { createOpenCodePartObservation, createOpenCodeReconcilePlan, isOwnMemoryMcpTool } from "./reconcile.js";

export const OPENCODE_PLUGIN_VERSION = "1.0.0" as const;
export const OPENCODE_NATIVE_VERSION = "1.18.30" as const;
// Common Development profile: measured UTF-8 bytes, not estimated model tokens.
export const OPENCODE_CONTEXT_UTF8_BYTES = 8_000;
export const OPENCODE_CONTEXT_TOKENS = 4_000;
export const OPENCODE_PROMPT_TOKENS = OPENCODE_CONTEXT_UTF8_BYTES;
export const OPENCODE_CONTEXT_MAX_BYTES = 24 * 1024;
export const OPENCODE_PROMPT_MAX_BYTES = 64 * 1024;
// Compatibility exports retain historical token-shaped names; the runtime
// uses the explicit UTF-8 byte profiles above for every transform.
export const OPENCODE_SESSION_START_TOKENS = OPENCODE_CONTEXT_TOKENS;
export const OPENCODE_SESSION_START_MAX_BYTES = OPENCODE_CONTEXT_MAX_BYTES;
export const OPENCODE_DEFAULT_HOOK_TIMEOUT_MS = 4_000;
export const OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
export const OPENCODE_MAX_PAYLOAD_BYTES = 1_000_000;
export const OPENCODE_MAX_TOOL_TEXT_BYTES = 1_000_000;
export const OPENCODE_MAX_SESSIONS = 32;
export const OPENCODE_MAX_TRANSFORM_PENDING = 2;

const opaqueIdSchema = z.string().min(1).max(256);
const pathSchema = z.string().min(1).max(4_096);
const pluginOptionsSchema = z
  .object({
    version: z.literal(1),
    // Accept the previous setup tag while all newly generated options use 1.18.30.
    native_version: z.union([z.literal(OPENCODE_NATIVE_VERSION), z.literal("1.18.29")]),
    node_path: pathSchema,
    bridge_path: pathSchema,
    config_path: pathSchema,
    hook_timeout_ms: z.number().int().min(100).max(30_000).default(OPENCODE_DEFAULT_HOOK_TIMEOUT_MS),
    request_timeout_ms: z.number().int().min(50).max(30_000).default(OPENCODE_DEFAULT_REQUEST_TIMEOUT_MS),
    max_frame_bytes: z.number().int().min(1_024).max(4_500_000).default(4_500_000),
  })
  .strict();

export interface OpenCodePluginConfig {
  readonly version: 1;
  readonly nativeVersion: typeof OPENCODE_NATIVE_VERSION;
  readonly nodePath: string;
  readonly bridgePath: string;
  readonly configPath: string;
  readonly workspaceDirectory: string;
  readonly hookTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxFrameBytes: number;
}

export interface OpenCodePluginRuntimeOptions {
  readonly readMessages?: (sessionId: string, signal: AbortSignal) => Promise<MessageWithParts[]>;
  readonly bridgeFactory?: (config: OpenCodePluginConfig) => OpenCodeBridge;
  readonly clock?: () => Date;
}

export class OpenCodePluginError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OpenCodePluginError";
  }
}

function requireAbsoluteFile(value: string, name: string, executable: boolean): string {
  if (!isAbsolute(value)) throw new OpenCodePluginError(`${name}_must_be_absolute`);
  try {
    const stat = statSync(value);
    if (!stat.isFile() || (executable && (stat.mode & 0o111) === 0) || (!executable && (stat.mode & 0o444) === 0)) {
      throw new Error("invalid_file");
    }
  } catch {
    throw new OpenCodePluginError(`${name}_unavailable`);
  }
  return value;
}

function requireAbsoluteDirectory(value: string, name: string): string {
  if (!isAbsolute(value)) throw new OpenCodePluginError(`${name}_must_be_absolute`);
  return value;
}

/** Parse only fixed setup values; the native project route stays in the helper config. */
export function createOpenCodePluginConfig(input: unknown, workspaceDirectory: string): OpenCodePluginConfig {
  let parsed: z.infer<typeof pluginOptionsSchema>;
  try {
    parsed = pluginOptionsSchema.parse(input);
  } catch {
    throw new OpenCodePluginError("setup_required");
  }
  requireAbsoluteDirectory(workspaceDirectory, "workspace_directory");
  return Object.freeze({
    version: 1,
    nativeVersion: OPENCODE_NATIVE_VERSION,
    nodePath: requireAbsoluteFile(parsed.node_path, "node_path", true),
    bridgePath: requireAbsoluteFile(parsed.bridge_path, "bridge_path", false),
    configPath: requireAbsoluteFile(parsed.config_path, "config_path", false),
    workspaceDirectory,
    hookTimeoutMs: parsed.hook_timeout_ms,
    requestTimeoutMs: parsed.request_timeout_ms,
    maxFrameBytes: parsed.max_frame_bytes,
  });
}

interface SessionState {
  readonly captureAcks: Map<string, Promise<CaptureAck>>;
  readonly messageRoles: Map<string, "user" | "assistant">;
  reconcileCoverage: NativeReconcileCoverage;
  readonly ownedInjectionDigests: Set<string>;
  reconcileCursor: NativeReconcileCursor | null;
  opened: boolean;
  opening: Promise<void> | undefined;
  transformTail: Promise<void>;
  transformPending: number;
}

interface MessageWithParts {
  readonly info: Message;
  readonly parts: Part[];
}

interface TextPartWithIndex {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly part: TextPart;
}

interface HookDeadline {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  throwIfExpired(): void;
  clear(): void;
}

const completeCoverage: SourceCoverage = { status: "complete" };
const missingEventCoverage: SourceCoverage = { status: "coverage_gap", reason: "event_not_observed" };

interface BoundedToolText {
  readonly text?: string;
  readonly truncated: boolean;
  readonly omittedBytes?: number;
}

function makeDeadline(clock: () => Date, timeoutMs: number): HookDeadline {
  const deadlineAt = clock().getTime() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  return {
    controller,
    signal: controller.signal,
    deadlineAt,
    throwIfExpired: (): void => {
      if (controller.signal.aborted || clock().getTime() >= deadlineAt) throw new OpenCodePluginError("deadline");
    },
    clear: () => clearTimeout(timer),
  };
}

function assertSessionId(value: unknown): string | undefined {
  return typeof value === "string" && opaqueIdSchema.safeParse(value).success ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    validateBoundedJson(value, { max_depth: 32, max_bytes: OPENCODE_MAX_PAYLOAD_BYTES, max_nodes: 100_000 }, "opencode-plugin-payload");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    if (Buffer.byteLength(serialized, "utf8") > OPENCODE_MAX_PAYLOAD_BYTES) {
      throw new OpenCodePluginError("payload_too_large");
    }
    return JSON.parse(serialized) as unknown;
  } catch (error: unknown) {
    if (error instanceof OpenCodePluginError) throw error;
    throw new OpenCodePluginError("payload_invalid");
  }
}

function extractToolText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const chunks = value.flatMap((entry) => {
      const record = asRecord(entry);
      if (record?.type === "text" && typeof record.text === "string") return [record.text];
      if (record?.content !== undefined) {
        const nested = extractToolText(record.content);
        return nested === undefined ? [] : [nested];
      }
      return [];
    });
    return chunks.length === 0 ? undefined : chunks.join("\n");
  }
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["output", "content", "text"] as const) {
    const candidate = record[key];
    const text = extractToolText(candidate);
    if (text !== undefined) return text;
  }
  return undefined;
}

function boundToolText(value: unknown): BoundedToolText {
  const text = extractToolText(value);
  if (text === undefined) return { truncated: false };
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= OPENCODE_MAX_TOOL_TEXT_BYTES) return { text, truncated: false };
  let prefix = encoded.subarray(0, OPENCODE_MAX_TOOL_TEXT_BYTES);
  let decoded: string;
  for (;;) {
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
      break;
    } catch {
      prefix = prefix.subarray(0, Math.max(0, prefix.length - 1));
    }
  }
  return {
    text: decoded,
    truncated: true,
    omittedBytes: encoded.length - prefix.length,
  };
}

function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function textParts(message: MessageWithParts): TextPartWithIndex[] {
  if (!Array.isArray(message.parts)) return [];
  return message.parts.flatMap((part, partIndex) =>
    asRecord(part)?.type === "text" && typeof asRecord(part)?.text === "string" ? [{ messageIndex: -1, partIndex, part: part as TextPart }] : [],
  );
}

function allTextParts(messages: readonly MessageWithParts[]): TextPartWithIndex[] {
  const result: TextPartWithIndex[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const candidate of textParts(message)) result.push({ ...candidate, messageIndex });
  }
  return result;
}

function sessionFromMessages(messages: readonly MessageWithParts[]): string | undefined {
  let sessionId: string | undefined;
  for (const message of messages) {
    const messageRecord = asRecord(message);
    if (messageRecord === undefined || !Array.isArray(messageRecord.parts)) return undefined;
    const current = assertSessionId(asRecord(messageRecord.info)?.sessionID);
    if (current === undefined) return undefined;
    if (sessionId === undefined) sessionId = current;
    else if (sessionId !== current) return undefined;
  }
  return sessionId;
}

function messageIdentity(message: MessageWithParts, text: string): { readonly captureId: string; readonly key: string; readonly nativeIds: Record<string, string> } {
  const info = asRecord(message.info) ?? {};
  const sessionId = assertSessionId(info.sessionID) ?? "unknown";
  const messageId = typeof info.id === "string" ? info.id : undefined;
  const textDigest = createHash("sha256").update(text, "utf8").digest("hex");
  const stable = messageId === undefined ? `${sessionId}\0${textDigest}` : `${sessionId}\0${messageId}\0${textDigest}`;
  const captureId = messageId === undefined ? randomUUID() : deterministicUuid(`opencode:capture:v1\0prompt\0${stable}`);
  return {
    captureId,
    key: `prompt\0${stable}`,
    nativeIds: {
      session_id: sessionId,
      ...(messageId === undefined ? {} : { message_id: messageId }),
    },
  };
}

function identityForEvent(stage: string, sessionId: string, ids: Record<string, string>): { readonly captureId: string; readonly correlation: OpenCodeBridgeEvent["correlation"] } {
  const meaningful = Object.entries(ids).filter(([key]) => key !== "session_id");
  if (meaningful.length === 0) {
    return { captureId: randomUUID(), correlation: { status: "correlation_unknown", reason: "not_resolved" } };
  }
  const key = `${sessionId}\0${stage}\0${meaningful.map(([name, value]) => `${name}=${value}`).join("\0")}`;
  return {
    captureId: deterministicUuid(`opencode:capture:v1\0${key}`),
    correlation: { status: "correlated", basis: "native_ids", key: createHash("sha256").update(key, "utf8").digest("hex") },
  };
}

function textForPrompt(message: MessageWithParts): { readonly text: string; readonly partId?: string } | undefined {
  const parts = textParts(message).filter(({ part }) => part.synthetic !== true && part.text.length > 0);
  const last = parts[parts.length - 1]?.part;
  if (last === undefined) return undefined;
  return {
    text: parts.map(({ part }) => part.text).join("\n"),
    ...(typeof last.id === "string" ? { partId: last.id } : {}),
  };
}

function currentUserMessage(messages: readonly MessageWithParts[]): { readonly message: MessageWithParts; readonly index: number } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && Array.isArray(message.parts) && asRecord(message.info)?.role === "user") return { message, index };
  }
  return undefined;
}

function optionsFor(deadline: HookDeadline): OpenCodeBridgeCallOptions {
  return { signal: deadline.signal, deadlineAt: deadline.deadlineAt };
}

function ownSyntheticPart(sessionId: string, messageId: string, wrapper: string): TextPart {
  let injectionId = "unknown";
  try {
    injectionId = parseModelContextWrapper(wrapper).injection_id;
  } catch {
    try {
      injectionId = parseDirectedEvidenceHandoff(wrapper).source_injection_id;
    } catch {
      // Keep a bounded id if a future packet representation changes.
    }
  }
  return {
    id: deterministicUuid(`opencode:synthetic-part:v1\0${sessionId}\0${messageId}\0${injectionId}`),
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text: wrapper,
    synthetic: true,
    metadata: {
      agent_memory: "context",
      injection_id: injectionId,
    },
  };
}

function locallyOwnedContextPart(part: TextPart, knownDigests: ReadonlySet<string>): boolean {
  const digest = createHash("sha256").update(part.text, "utf8").digest("hex");
  return knownDigests.has(digest);
}

function wrapperCandidate(part: TextPart): boolean {
  if (part.synthetic === true) return true;
  try {
    const parsed = JSON.parse(part.text) as unknown;
    const kind = asRecord(parsed)?.kind;
    return kind === "agent_memory_context" || kind === "agent_memory_evidence" || kind === "agent_memory_handoff";
  } catch {
    return false;
  }
}

function eventPayload(stage: string, value: unknown): Record<string, unknown> {
  return { stage, native: jsonSafe(value) };
}

/**
 * OpenCode's plugin-side runtime. It owns one child bridge for the plugin
 * installation and keeps all state scoped to the native session id.
 */
export class OpenCodePluginRuntime {
  private readonly config: OpenCodePluginConfig;
  private readonly clock: () => Date;
  private readonly bridge: OpenCodeBridge;
  private readonly readMessages: OpenCodePluginRuntimeOptions["readMessages"];
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingHooks = new Set<Promise<unknown>>();
  private closing = false;
  private closed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(config: OpenCodePluginConfig, options: OpenCodePluginRuntimeOptions = {}) {
    this.config = config;
    this.readMessages = options.readMessages;
    this.clock = options.clock ?? (() => new Date());
    this.bridge = options.bridgeFactory?.(config) ?? new OpenCodeBridgeClient({
      nodePath: config.nodePath,
      bridgePath: config.bridgePath,
      configPath: config.configPath,
      requestTimeoutMs: config.requestTimeoutMs,
      maxFrameBytes: config.maxFrameBytes,
    });
  }

  getReconcileCoverage(sessionId: string): NativeReconcileCoverage | undefined {
    return this.sessions.get(sessionId)?.reconcileCoverage;
  }

  private rememberRole(sessionId: string, message: Message): void {
    if (message.sessionID !== sessionId || (message.role !== "user" && message.role !== "assistant")) return;
    const roles = this.sessionState(sessionId).messageRoles;
    roles.set(message.id, message.role);
    while (roles.size > 4_096) roles.delete(roles.keys().next().value!);
  }

  hooks(): Hooks {
    return {
      "chat.message": async (input, output): Promise<void> => {
        if (this.closing) return;
        const sessionId = assertSessionId(input.sessionID);
        if (sessionId === undefined) return;
        await this.trackHook(this.capturePrompt(sessionId, output.message, output.parts, undefined));
      },
      "tool.execute.before": async (input, output): Promise<void> => {
        if (this.closing) return;
        const sessionId = assertSessionId(input.sessionID);
        if (sessionId === undefined) return;
        if (isOwnMemoryMcpTool(input.tool)) return;
        await this.trackHook(this.captureToolStarted(sessionId, input.tool, input.callID, output.args));
      },
      "tool.execute.after": async (input, output): Promise<void> => {
        if (this.closing) return;
        const sessionId = assertSessionId(input.sessionID);
        if (sessionId === undefined) return;
        if (isOwnMemoryMcpTool(input.tool)) return;
        await this.trackHook(this.captureToolResult(sessionId, input.tool, input.callID, input.args, output));
      },
      "experimental.text.complete": async (input, output): Promise<void> => {
        if (this.closing) return;
        const sessionId = assertSessionId(input.sessionID);
        if (sessionId === undefined) return;
        await this.trackHook(this.captureTextPart(sessionId, input.messageID, input.partID, output.text));
      },
      "experimental.session.compacting": async (input): Promise<void> => {
        if (this.closing) return;
        const sessionId = assertSessionId(input.sessionID);
        if (sessionId === undefined) return;
        await this.trackHook(this.captureCompaction(sessionId));
      },
      "experimental.chat.messages.transform": async (_input, output): Promise<void> => {
        if (this.closing) return;
        const messages = asRecord(output)?.messages;
        if (!Array.isArray(messages)) return;
        const sessionId = sessionFromMessages(messages as MessageWithParts[]);
        if (sessionId === undefined) return;
        const state = this.sessionState(sessionId);
        const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
        if (state.transformPending >= OPENCODE_MAX_TRANSFORM_PENDING) {
          deadline.clear();
          return;
        }
        state.transformPending += 1;
        const queued = state.transformTail.then(() => {
          deadline.throwIfExpired();
          return this.transform(output as { messages: MessageWithParts[] }, deadline);
        });
        const settled = queued.catch(() => undefined);
        state.transformTail = settled.finally(() => {
          state.transformPending -= 1;
          deadline.clear();
        });
        await this.trackHook(state.transformTail);
      },
      event: async ({ event }): Promise<void> => {
        // OpenCode dispatches general event hooks without awaiting them. Keep
        // their captures best-effort; the awaited transform is the model
        // context barrier.
        if (this.closing) return;
        void this.trackHook(this.captureEvent(event));
      },
      dispose: async (): Promise<void> => {
        await this.dispose();
      },
    };
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise;
    this.closing = true;
    this.disposePromise = this.drainAndClose();
    return this.disposePromise;
  }

  private async trackHook(work: Promise<unknown>): Promise<void> {
    const settled = work.catch(() => undefined);
    this.pendingHooks.add(settled);
    try { await settled; } finally { this.pendingHooks.delete(settled); }
  }

  private async drainAndClose(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.pendingHooks]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.config.hookTimeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.closed = true;
      this.sessions.clear();
      await this.bridge.close();
    }
  }

  private assertNotClosed(): void {
    if (this.closed) throw new OpenCodePluginError("closed");
  }

  private sessionState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      if (this.sessions.size >= OPENCODE_MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (typeof oldest === "string") this.sessions.delete(oldest);
      }
      state = {
        captureAcks: new Map(),
        messageRoles: new Map(),
        reconcileCoverage: { status: "coverage_gap", reason: "not_observed" },
        ownedInjectionDigests: new Set(),
        reconcileCursor: null,
        opened: false,
        opening: undefined,
        transformTail: Promise.resolve(),
        transformPending: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async openSession(sessionId: string, deadline: HookDeadline, cwd = this.config.workspaceDirectory): Promise<void> {
    this.assertNotClosed();
    const state = this.sessionState(sessionId);
    if (state.opened) return;
    if (state.opening !== undefined) return state.opening;
    const opening = this.bridge.openSession(sessionId, cwd, optionsFor(deadline));
    state.opening = opening;
    try {
      await opening;
      this.assertNotClosed();
      deadline.throwIfExpired();
      state.opened = true;
    } catch (error: unknown) {
      state.opened = false;
      throw error;
    } finally {
      if (state.opening === opening) state.opening = undefined;
    }
  }

  private async captureOnce(
    sessionId: string,
    key: string,
    event: OpenCodeBridgeEvent,
    deadline: HookDeadline,
    cwd = this.config.workspaceDirectory,
    nativeIdentity?: NativeObservationIdentity,
  ): Promise<CaptureAck> {
    const state = this.sessionState(sessionId);
    const existing = nativeIdentity?.kind === "part_snapshot" ? undefined : state.captureAcks.get(key);
    if (existing !== undefined) {
      const ack = await existing;
      deadline.throwIfExpired();
      return ack;
    }
    const operation = (async (): Promise<CaptureAck> => {
      await this.openSession(sessionId, deadline, cwd);
      this.assertNotClosed();
      deadline.throwIfExpired();
      try {
        const ack = nativeIdentity === undefined || this.bridge.observeNative === undefined
          ? await this.bridge.capture(sessionId, cwd, event, optionsFor(deadline))
          : await this.bridge.observeNative(sessionId, cwd, event, nativeIdentity, optionsFor(deadline));
        deadline.throwIfExpired();
        return ack;
      } catch (error: unknown) {
        if (!isRetryableOpenCodeBridgeError(error)) throw error;
        state.opened = false;
        await this.openSession(sessionId, deadline, cwd);
        this.assertNotClosed();
        deadline.throwIfExpired();
        const ack = nativeIdentity === undefined || this.bridge.observeNative === undefined
          ? await this.bridge.capture(sessionId, cwd, event, optionsFor(deadline))
          : await this.bridge.observeNative(sessionId, cwd, event, nativeIdentity, optionsFor(deadline));
        deadline.throwIfExpired();
        return ack;
      }
    })();
    if (nativeIdentity?.kind !== "part_snapshot") state.captureAcks.set(key, operation);
    try {
      return await operation;
    } catch (error: unknown) {
      state.captureAcks.delete(key);
      state.reconcileCoverage = { status: "coverage_gap", reason: "native_reconcile_gap",
        gaps: [{ identity_key: key.slice(0, 1024), reason: error instanceof OpenCodeBridgeError ? error.reason : "capture_failed" }] };
      throw error;
    } finally {
      while (state.captureAcks.size > 128) {
        const oldest = state.captureAcks.keys().next().value;
        if (typeof oldest !== "string") break;
        state.captureAcks.delete(oldest);
      }
    }
  }

  private async capturePrompt(
    sessionId: string,
    message: UserMessage,
    parts: Part[],
    deadline: HookDeadline | undefined,
  ): Promise<CaptureAck | undefined> {
    this.rememberRole(sessionId, message);
    const prompt = textForPrompt({ info: message, parts });
    if (prompt === undefined) return undefined;
    const identity = messageIdentity({ info: message, parts }, prompt.text);
    const actualSession = assertSessionId(message.sessionID);
    if (actualSession === undefined || actualSession !== sessionId) return undefined;
    const currentDeadline = deadline ?? makeDeadline(this.clock, this.config.hookTimeoutMs);
    const event: OpenCodeBridgeEvent = {
      capture_id: identity.captureId,
      stage: "prompt_submitted",
      native_ids: {
        ...identity.nativeIds,
        ...(prompt.partId === undefined ? {} : { part_id: prompt.partId }),
      },
      text: prompt.text,
      payload: {
        session_id: sessionId,
        message_id: message.id,
        text: prompt.text,
        part_ids: textParts({ info: message, parts }).flatMap(({ part }) =>
          part.synthetic !== true && part.text.length > 0 ? [part.id] : []),
      },
      coverage: completeCoverage,
      correlation: {
        status: "correlated",
        basis: "native_ids",
        key: identity.key.slice(0, 256),
      },
    };
    try {
      return await this.captureOnce(sessionId, identity.key, event, currentDeadline, this.config.workspaceDirectory, {
        kind: "event",
        key: `prompt\0${sessionId}\0${message.id}`,
      });
    } finally {
      if (deadline === undefined) currentDeadline.clear();
    }
  }

  private async captureCompaction(sessionId: string): Promise<CaptureAck> {
    const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
    const ids = { session_id: sessionId };
    const identity = identityForEvent("compaction", sessionId, ids);
    const event: OpenCodeBridgeEvent = {
      capture_id: identity.captureId,
      stage: "compaction",
      native_ids: ids,
      payload: { session_id: sessionId, source: "experimental.session.compacting" },
      coverage: completeCoverage,
      correlation: identity.correlation,
    };
    try {
      // This ACK proves only that the lifecycle event was captured. OpenCode
      // exposes no run token tying it to a later messages.transform call, so
      // it must never become a generic prompt barrier or context source.
      return await this.captureOnce(sessionId, `compaction\0${identity.captureId}`, event, deadline);
    } finally {
      deadline.clear();
    }
  }

  private async captureToolStarted(sessionId: string, tool: string, callId: string, args: unknown): Promise<void> {
    const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
    const ids = { session_id: sessionId, tool_call_id: callId };
    const identity = identityForEvent("tool_started", sessionId, ids);
    const event: OpenCodeBridgeEvent = {
      capture_id: identity.captureId,
      stage: "tool_started",
      native_ids: ids,
      payload: { tool, call_id: callId, args: jsonSafe(args) },
      coverage: completeCoverage,
      correlation: identity.correlation,
    };
    try {
      await this.captureOnce(sessionId, `tool_started\0${callId}`, event, deadline, this.config.workspaceDirectory, {
        kind: "event",
        key: identity.correlation?.status === "correlated" ? identity.correlation.key : `tool_started\0${callId}`,
      });
    } finally {
      deadline.clear();
    }
  }

  private async captureToolResult(sessionId: string, tool: string, callId: string, args: unknown, output: unknown): Promise<void> {
    const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
    const ids = { session_id: sessionId, tool_call_id: callId };
    const identity = identityForEvent("tool_result", sessionId, ids);
    const outputPresent = output !== undefined;
    const safeOutput = outputPresent ? jsonSafe(output) : null;
    const extracted = boundToolText(safeOutput);
    const coverage = !outputPresent
      ? missingEventCoverage
      : extracted.text === undefined
        ? { status: "partial" as const, reason: "adapter_gap" as const }
        : extracted.truncated
          ? { status: "partial" as const, reason: "truncated" as const }
          : completeCoverage;
    const event: OpenCodeBridgeEvent = {
      capture_id: identity.captureId,
      stage: "tool_result",
      native_ids: ids,
      outcome: "unknown",
      ...(extracted.text === undefined ? {} : { text: extracted.text }),
      payload: {
        tool,
        call_id: callId,
        args: jsonSafe(args),
        output_present: outputPresent,
        output: safeOutput,
      },
      ...(extracted.truncated
        ? { truncation: { truncated: true, ...(extracted.omittedBytes === undefined ? {} : { omitted_bytes: extracted.omittedBytes }) } }
        : {}),
      coverage,
      correlation: identity.correlation,
    };
    try {
      await this.captureOnce(sessionId, `tool_result\0${callId}`, event, deadline, this.config.workspaceDirectory, {
        kind: "event",
        key: identity.correlation?.status === "correlated" ? identity.correlation.key : `tool_result\0${callId}`,
      });
    } finally {
      deadline.clear();
    }
  }

  private async captureTextPart(sessionId: string, messageId: string, partId: string, text: string): Promise<void> {
    const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
    const ids = { session_id: sessionId, message_id: messageId, part_id: partId };
    const identity = identityForEvent("message_part", sessionId, ids);
    const event: OpenCodeBridgeEvent = {
      stage: "message_part",
      role: "assistant",
      evidence_class: "assistant_output",
      native_ids: ids,
      text,
      payload: { session_id: sessionId, message_id: messageId, part_id: partId, text },
      coverage: completeCoverage,
      correlation: identity.correlation,
    };
    try {
      await this.captureOnce(sessionId, `message_part\0${messageId}\0${partId}\0${createHash("sha256").update(text, "utf8").digest("hex")}`, event, deadline, this.config.workspaceDirectory, {
        kind: "part_snapshot",
        session_id: sessionId,
        message_id: messageId,
        part_id: partId,
      });
    } finally {
      deadline.clear();
    }
  }

  private async captureEvent(eventInput: Event): Promise<void> {
    const record = asRecord(eventInput);
    if (record === undefined || typeof record.type !== "string") return;
    const properties = asRecord(record.properties);
    if (properties === undefined) return;
    if (record.type === "message.updated") {
      const info = asRecord(properties.info);
      const sessionId = assertSessionId(info?.sessionID);
      if (sessionId !== undefined && typeof info?.id === "string") this.rememberRole(sessionId, properties.info as Message);
      return;
    }
    if (record.type === "message.part.updated") {
      const partRecord = asRecord(properties.part);
      const sessionId = assertSessionId(partRecord?.sessionID);
      const messageId = typeof partRecord?.messageID === "string" ? partRecord.messageID : undefined;
      if (sessionId === undefined || messageId === undefined || this.bridge.reconcile === undefined) return;
      if (isOwnMemoryMcpTool(partRecord?.tool)) return;
      const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
      try {
        await this.openSession(sessionId, deadline);
        if (partRecord?.synthetic === true && typeof partRecord.text === "string" &&
            await this.bridge.recognizeContext(sessionId, this.config.workspaceDirectory, partRecord.text, optionsFor(deadline))) return;
        const role = this.sessionState(sessionId).messageRoles.get(messageId);
        const part = role === undefined ? undefined : createOpenCodePartObservation(sessionId, messageId, properties.part as Part, role);
        if (part !== undefined) {
          await this.captureOnce(sessionId, `part_update\0${messageId}\0${partRecord?.id}`, part.event, deadline, this.config.workspaceDirectory, part.identity);
        } else {
          const result = await this.bridge.reconcile(sessionId, this.config.workspaceDirectory, [], null, true,
            [{ identity_key: `${messageId}:${partRecord?.id}`, reason: role === undefined ? "parent_role_unobserved" : "part_text_unavailable" }], optionsFor(deadline));
          this.sessionState(sessionId).reconcileCoverage = result.gaps.length === 0 ? result.scan.coverage : { status: result.cursor_committed ? "partial" : "coverage_gap", reason: "native_reconcile_gap", gaps: [...result.gaps] };
        }
      } finally {
        deadline.clear();
      }
      return;
    }
    let stage: OpenCodeBridgeEvent["stage"];
    let sessionId: string | undefined;
    let cwd = this.config.workspaceDirectory;
    let text: string | undefined;
    switch (record.type) {
      case "session.created": {
        const info = asRecord(properties.info);
        sessionId = assertSessionId(info?.id);
        if (typeof info?.directory === "string") cwd = info.directory;
        stage = "session_start";
        break;
      }
      case "session.idle":
        sessionId = assertSessionId(properties.sessionID);
        stage = "stop";
        break;
      case "session.compacted":
        sessionId = assertSessionId(properties.sessionID);
        stage = "compaction";
        break;
      case "session.error": {
        sessionId = assertSessionId(properties.sessionID);
        stage = "error";
        const error = asRecord(properties.error);
        const data = asRecord(error?.data);
        if (typeof data?.message === "string") text = data.message;
        break;
      }
      default:
        return;
    }
    if (sessionId === undefined) return;
    const ids = { session_id: sessionId };
    const identity = identityForEvent(stage, sessionId, ids);
    const deadline = makeDeadline(this.clock, this.config.hookTimeoutMs);
    const event: OpenCodeBridgeEvent = {
      capture_id: identity.captureId,
      stage,
      native_ids: ids,
      ...(text === undefined ? {} : { text }),
      payload: eventPayload(record.type, properties),
      coverage: stage === "error" && text === undefined ? missingEventCoverage : completeCoverage,
      correlation: identity.correlation,
    };
    try {
      // General events are explicitly best-effort; no model context is built
      // from this path and no callback output is changed.
      await this.captureOnce(sessionId, `event\0${stage}\0${identity.captureId}`, event, deadline, cwd);
    } finally {
      deadline.clear();
    }
  }

  private async recognizedParts(
    sessionId: string,
    candidates: readonly TextPartWithIndex[],
    deadline: HookDeadline,
  ): Promise<Set<string>> {
    const recognized = new Set<string>();
    if (candidates.length === 0) return recognized;
    await this.openSession(sessionId, deadline);
    for (const candidate of candidates.slice(0, 32)) {
      if (this.closing) return recognized;
      const own = await this.bridge.recognizeContext(
        sessionId,
        this.config.workspaceDirectory,
        candidate.part.text,
        optionsFor(deadline),
      );
      deadline.throwIfExpired();
      if (own) recognized.add(`${candidate.messageIndex}:${candidate.partIndex}`);
    }
    return recognized;
  }

  private async captureAckForTransform(
    sessionId: string,
    user: { readonly message: MessageWithParts },
    prompt: { readonly text: string },
    deadline: HookDeadline,
  ): Promise<CaptureAck | undefined> {
    const state = this.sessionState(sessionId);
    // Only an exact, already observed chat.message may authorize model
    // context. A compaction lifecycle ACK has no shared native run token with
    // this hook and is deliberately not consumable here.
    const identity = messageIdentity(user.message, prompt.text);
    const promptCapture = state.captureAcks.get(identity.key);
    if (promptCapture === undefined) return undefined;
    const ack = await promptCapture;
    deadline.throwIfExpired();
    return ack;
  }

  private async transform(output: { messages: MessageWithParts[] }, deadline: HookDeadline): Promise<void> {
    if (this.closing) return;
    const outputRecord = asRecord(output);
    const messages = outputRecord?.messages;
    if (!Array.isArray(messages)) return;
    const sessionId = sessionFromMessages(messages);
    if (sessionId === undefined) return;
    const state = this.sessionState(sessionId);
    try {
      deadline.throwIfExpired();
      const ownCandidates = allTextParts(messages).filter((candidate) => wrapperCandidate(candidate.part));
      let recognized: Set<string>;
      try {
        recognized = await this.recognizedParts(sessionId, ownCandidates, deadline);
      } catch (error: unknown) {
        if (
          (error instanceof OpenCodeBridgeError && error.reason === "deadline") ||
          (error instanceof OpenCodePluginError && error.reason === "deadline")
        ) {
          throw error;
        }
        // A recognition failure must not remove arbitrary text. The transform
        // can still capture the native prompt and continue without replacement.
        recognized = new Set();
      }
      if (this.closing) return;
      const unrecognizedLocalOwn = ownCandidates.some(
        (candidate) => locallyOwnedContextPart(candidate.part, state.ownedInjectionDigests) && !recognized.has(`${candidate.messageIndex}:${candidate.partIndex}`),
      );
      if (unrecognizedLocalOwn) return;
      if (this.bridge.reconcile !== undefined) {
        let history = messages as MessageWithParts[];
        let historyRecognized = recognized;
        let scan: Awaited<ReturnType<NonNullable<OpenCodeBridge["beginReconcile"]>>> | undefined;
        const readGaps: { identity_key: string; reason: string }[] = [];
        if (this.readMessages !== undefined && this.bridge.beginReconcile !== undefined) {
          await this.openSession(sessionId, deadline);
          scan = await this.bridge.beginReconcile(sessionId, this.config.workspaceDirectory, optionsFor(deadline));
          try {
            history = await this.readMessages(sessionId, deadline.signal);
            deadline.throwIfExpired();
            historyRecognized = await this.recognizedParts(sessionId, allTextParts(history).filter((candidate) => wrapperCandidate(candidate.part)), deadline);
            if (history.length >= 128) readGaps.push({ identity_key: "history", reason: "history_truncated" });
          } catch {
            // The fallback input was read before the scan token. Never attach it.
            scan = undefined;
            history = messages as MessageWithParts[];
            historyRecognized = recognized;
            readGaps.push({ identity_key: "history", reason: "native_history_read_failed" });
          }
        }
        for (const message of history) this.rememberRole(sessionId, message.info);
        const plan = createOpenCodeReconcilePlan(history, {
          recognizedPartKeys: historyRecognized,
          cursor: state.reconcileCursor ?? scan?.cursor ?? null,
        });
        if (plan.observations.length > 0 || plan.gaps.length > 0) {
          const result = await this.bridge.reconcile(
            sessionId,
            this.config.workspaceDirectory,
            plan.observations,
            plan.cursor,
            plan.complete,
            [...plan.gaps, ...readGaps].slice(0, 128),
            { ...optionsFor(deadline), ...(scan === undefined ? {} : { reconcileScan: scan }) },
          );
          state.reconcileCursor = result.cursor_committed && !plan.complete ? result.scan.cursor : null;
          state.reconcileCoverage = result.gaps.length === 0 ? result.scan.coverage : { status: result.cursor_committed ? "partial" : "coverage_gap", reason: "native_reconcile_gap", gaps: [...result.gaps] };
          deadline.throwIfExpired();
        }
      }
      const user = currentUserMessage(messages);
      if (user === undefined) return;
      const prompt = textForPrompt(user.message);
      if (prompt === undefined) return;
      const ack = await this.captureAckForTransform(sessionId, user, prompt, deadline);
      if (ack === undefined || this.closing) return;
      const deadlineAt = new Date(deadline.deadlineAt).toISOString();
      const packet = await this.bridge.recall(
        sessionId,
        this.config.workspaceDirectory,
        {
          query: prompt.text,
          mode: "current",
          // Legacy wire field carries the requested units of the explicit byte profile.
          token_budget: OPENCODE_CONTEXT_UTF8_BYTES,
          kind_hint: "user_prompt",
          deadline_at: deadlineAt,
          capture_status: { state: "committed", capture_id: ack.capture_id },
        },
        optionsFor(deadline),
      );
      deadline.throwIfExpired();
      if (this.closing) return;
      const wrapper = serializeModelContext(packet);
      deadline.throwIfExpired();
      if (Buffer.byteLength(wrapper, "utf8") > OPENCODE_CONTEXT_MAX_BYTES) throw new OpenCodePluginError("context_too_large");
      const target = currentUserMessage(messages);
      if (target === undefined) return;
      const sessionInfo = asRecord(target.message.info);
      const messageId = typeof sessionInfo?.id === "string" ? sessionInfo.id : undefined;
      if (messageId === undefined) return;
      const mutableParts = messages.every((message) => Array.isArray(message.parts) && !Object.isFrozen(message.parts));
      const targetParts = target.message.parts;
      if (!mutableParts || !Object.isExtensible(targetParts)) return;
      // Remove only complete wrappers already authenticated by the broker,
      // across the whole history. Foreign/native text and non-recognized
      // synthetic parts retain their original positions and content.
      for (const [messageIndex, message] of messages.entries()) {
        for (let index = message.parts.length - 1; index >= 0; index -= 1) {
          if (recognized.has(`${messageIndex}:${index}`)) message.parts.splice(index, 1);
        }
      }
      targetParts.push(ownSyntheticPart(sessionId, messageId, wrapper));
      state.ownedInjectionDigests.add(createHash("sha256").update(wrapper, "utf8").digest("hex"));
      while (state.ownedInjectionDigests.size > 64) {
        const oldest = state.ownedInjectionDigests.values().next().value;
        if (typeof oldest !== "string") break;
        state.ownedInjectionDigests.delete(oldest);
      }
    } catch (error: unknown) {
      if (
        (error instanceof OpenCodeBridgeError && error.reason === "deadline") ||
        (error instanceof OpenCodePluginError && error.reason === "deadline")
      ) deadline.controller.abort();
      // Host model execution continues with its untouched native messages if
      // memory capture/recall is unavailable.
    }
  }
}

export function createOpenCodeHooks(config: OpenCodePluginConfig, options?: OpenCodePluginRuntimeOptions): Hooks {
  return new OpenCodePluginRuntime(config, options).hooks();
}

export async function createOpenCodePluginHooks(
  input: { readonly directory: string; readonly client?: PluginInput["client"] },
  options: PluginOptions | undefined,
  runtimeOptions?: OpenCodePluginRuntimeOptions,
): Promise<Hooks> {
  const config = createOpenCodePluginConfig(options, input.directory);
  return createOpenCodeHooks(config, {
    ...runtimeOptions,
    ...(runtimeOptions?.readMessages !== undefined || input.client === undefined ? {} : {
      readMessages: async (sessionId: string, signal: AbortSignal): Promise<MessageWithParts[]> => {
        const result = await input.client!.session.messages({ path: { id: sessionId }, query: { directory: input.directory, limit: 128 }, signal, throwOnError: true });
        return result.data;
      },
    }),
  });
}
