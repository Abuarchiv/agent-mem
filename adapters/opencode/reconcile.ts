import { createHash } from "node:crypto";

import type { Message, Part } from "@opencode-ai/sdk";

import { validateBoundedJson, type NativeObservationIdentity, type NativeReconcileCursor, type SourceCoverage } from "../../src/host/contract.js";
import { MEMORY_MCP_SERVER_NAME, memoryToolNames } from "../../src/host/tool-schemas.js";
import type {
  OpenCodeBridgeEvent,
  OpenCodeReconcileObservation,
} from "./bridge-client.js";

export const OPENCODE_RECONCILE_MAX_PARTS = 96;
const OPENCODE_RECONCILE_OVERLAP = 8;
const OPENCODE_RECONCILE_MAX_CANDIDATES = 4_096;

export interface OpenCodeReconcileGap {
  readonly identity_key: string;
  readonly reason: "part_text_unavailable" | "history_truncated" | "assistant_final_unobserved";
}

export interface OpenCodeReconcilePlan {
  readonly observations: readonly OpenCodeReconcileObservation[];
  readonly cursor: { readonly message_id: string; readonly part_id: string } | null;
  readonly complete: boolean;
  readonly gaps: readonly OpenCodeReconcileGap[];
}

export interface OpenCodeReconcilePlanOptions {
  readonly ownContextDigests?: ReadonlySet<string>;
  readonly recognizedPartKeys?: ReadonlySet<string>;
  readonly cursor?: NativeReconcileCursor | null;
}

const ownMemoryMcpServerNames = [MEMORY_MCP_SERVER_NAME, "agent_memory_v1", "agent-memory", "agentmemory"] as const;
const ownMemoryMcpSeparators = [".", "_", ":", "/", "__"] as const;

/** Match OpenCode's common MCP tool-name renderings without filtering foreign tools. */
export function isOwnMemoryMcpTool(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const tool = value.trim();
  return ownMemoryMcpServerNames.some((server) =>
    memoryToolNames.some((name) =>
      ownMemoryMcpSeparators.some((separator) => tool === `${server}${separator}${name}`) ||
      tool === `mcp__${server}__${name}` ||
      tool === `mcp.${server}.${name}`,
    ),
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safePart(value: unknown): Record<string, unknown> | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  try {
    validateBoundedJson(input, { max_depth: 32, max_bytes: 1_000_000, max_nodes: 100_000 }, "opencode-reconcile-part");
    const serialized = JSON.stringify(input);
    return serialized === undefined ? undefined : JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function identityKey(sessionId: string, messageId: string, partId: string): string {
  return `${sessionId}\u0000${messageId}\u0000${partId}`;
}

function ownContextPart(part: Record<string, unknown>, partKey: string, options: OpenCodeReconcilePlanOptions): boolean {
  if (part.synthetic !== true) return false;
  const metadata = record(part.metadata);
  if (metadata?.agent_memory !== "context" && metadata?.agent_memory !== "handoff") return false;
  if (typeof metadata.injection_id !== "string") return false;
  if (options.recognizedPartKeys?.has(partKey) === true) return true;
  if (options.ownContextDigests !== undefined) {
    return options.ownContextDigests.has(createHash("sha256").update(typeof part.text === "string" ? part.text : JSON.stringify(part), "utf8").digest("hex"));
  }
  return false;
}

function occurredAt(part: Record<string, unknown>): string | undefined {
  const time = record(part.time);
  const start = time?.start;
  if (typeof start !== "number" || !Number.isFinite(start) || start < 0) return undefined;
  const date = new Date(start);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function partEvent(
  sessionId: string,
  messageId: string,
  messageRole: string,
  partValue: unknown,
  partKey: string,
  options: OpenCodeReconcilePlanOptions,
): { readonly observation?: OpenCodeReconcileObservation; readonly gap?: OpenCodeReconcileGap } | undefined {
  const part = safePart(partValue);
  if (part === undefined || ownContextPart(part, partKey, options) || (part.type === "tool" && isOwnMemoryMcpTool(part.tool))) return undefined;
  const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
  if (partId === undefined) return undefined;
  const key = identityKey(sessionId, messageId, partId);
  let role: "user" | "assistant" | "tool" | "system";
  let evidenceClass: "prompt" | "assistant_output" | "tool_input" | "tool_output" | "lifecycle" | "diagnostic";
  let text: string | undefined;
  let coverage: SourceCoverage = { status: "complete" };
  if (part.type === "tool") {
    role = "tool";
    evidenceClass = "tool_output";
    const state = record(part.state) ?? {};
    const status = state?.status;
    if (status === "completed") text = typeof state.output === "string" ? state.output : undefined;
    else if (status === "error") text = typeof state.error === "string" ? state.error : undefined;
    else coverage = { status: "coverage_gap", reason: "event_not_observed" };
  } else if (part.type === "text" || part.type === "reasoning") {
    role = messageRole === "user" ? "user" : messageRole === "assistant" ? "assistant" : "system";
    evidenceClass = role === "user" ? "prompt" : role === "assistant" ? "assistant_output" : "lifecycle";
    text = typeof part.text === "string" && part.text.length > 0 ? part.text : undefined;
    const time = record(part.time);
    if (time?.end === undefined && messageRole === "assistant") coverage = { status: "partial", reason: "adapter_gap" };
  } else {
    return { gap: { identity_key: key, reason: "part_text_unavailable" } };
  }
  if (text === undefined) {
    return { gap: { identity_key: key, reason: "part_text_unavailable" } };
  }
  const identity: NativeObservationIdentity = {
    kind: "part_snapshot",
    session_id: sessionId,
    message_id: messageId,
    part_id: partId,
  };
  const event: OpenCodeBridgeEvent = {
    stage: "message_part",
    role,
    evidence_class: evidenceClass,
    native_ids: { session_id: sessionId, message_id: messageId, part_id: partId },
    text,
    payload: { session_id: sessionId, message_id: messageId, part_id: partId, native_part: part },
    ...(occurredAt(part) === undefined ? {} : { occurred_at: occurredAt(part) }),
    coverage,
    correlation: {
      status: "correlated",
      basis: "native_ids",
      key: createHash("sha256").update(key, "utf8").digest("hex"),
    },
  };
  return { observation: { identity, event } };
}

/** Build bounded, identity-keyed observations from the native message history. */
export function createOpenCodeReconcilePlan(
  messages: readonly { readonly info: Message; readonly parts: Part[] }[],
  options: OpenCodeReconcilePlanOptions = {},
): OpenCodeReconcilePlan {
  const candidates: OpenCodeReconcileObservation[] = [];
  const gaps: OpenCodeReconcileGap[] = [];
  let candidateLimitReached = false;
  let sessionId: string | undefined;
  for (const [messageIndex, message] of messages.entries()) {
    const info = record(message.info);
    const currentSession = typeof info?.sessionID === "string" ? info.sessionID : undefined;
    const messageId = typeof info?.id === "string" ? info.id : undefined;
    if (currentSession === undefined || messageId === undefined || !Array.isArray(message.parts)) {
      continue;
    }
    if (sessionId === undefined) sessionId = currentSession;
    if (sessionId !== currentSession) continue;
    const messageRole = typeof info?.role === "string" ? info.role : "system";
    for (const [partIndex, part] of message.parts.entries()) {
      const result = partEvent(currentSession, messageId, messageRole, part, `${messageIndex}:${partIndex}`, options);
      if (result === undefined) continue;
      if (result.observation !== undefined) {
        if (candidates.length >= OPENCODE_RECONCILE_MAX_CANDIDATES) {
          candidateLimitReached = true;
          break;
        }
        candidates.push(result.observation);
      }
      if (result.gap !== undefined) gaps.push(result.gap);
    }
    if (candidateLimitReached) break;
  }
  const cursorIndex = options.cursor === null || options.cursor === undefined
    ? -1
    : candidates.findIndex((entry) => entry.identity.kind === "part_snapshot" && entry.identity.message_id === options.cursor?.message_id && entry.identity.part_id === options.cursor?.part_id);
  const start = cursorIndex < 0 ? 0 : Math.max(0, cursorIndex - OPENCODE_RECONCILE_OVERLAP);
  const observations = candidates.slice(start, start + OPENCODE_RECONCILE_MAX_PARTS);
  const last = observations.at(-1)?.identity;
  const cursor = last?.kind === "part_snapshot" ? { message_id: last.message_id, part_id: last.part_id } : null;
  const complete = !candidateLimitReached && start + observations.length >= candidates.length;
  if (!complete || (cursorIndex > OPENCODE_RECONCILE_OVERLAP && cursorIndex >= 0)) gaps.push({ identity_key: "history", reason: "history_truncated" });
  if (messages.some((message) => record(message.info)?.role === "assistant")) {
    gaps.push({ identity_key: "assistant_final", reason: "assistant_final_unobserved" });
  }
  return { observations, cursor, complete, gaps };
}

export function createOpenCodePartObservation(
  sessionId: string,
  messageId: string,
  part: Part,
  role: string,
): OpenCodeReconcileObservation | undefined {
  return partEvent(sessionId, messageId, role, part, "0:0", {})?.observation;
}
