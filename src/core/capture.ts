import { createHash } from "node:crypto";

import { z } from "zod";

import { redactCaptureInput, type RedactionOptions } from "./redact.js";
import {
  ContractValidationError,
  parseContract,
  validateBoundSourceEnvelope,
  type CaptureAck,
  type SourceEnvelope,
  type NativeObservation,
  type TrustedBinding,
} from "../host/contract.js";
import type { AgentMemoryDatabase } from "../store/database.js";

const sourceSpanRootSchema = z.enum(["payload", "event"]);

export const sourceSpanInputSchema = z
  .object({
    span_id: z.uuid(),
    root: sourceSpanRootSchema.default("payload"),
    path: z.string().min(1).max(512),
    start_utf16: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end_utf16: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    digest: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

const sourceSpanListSchema = z.array(sourceSpanInputSchema).max(128);
const MAX_CAPTURE_BYTES = 4_000_000;

export interface SourceSpanInput {
  readonly span_id: string;
  /** The JSON document addressed by path. Legacy spans are payload-relative. */
  readonly root?: "payload" | "event";
  readonly path: string;
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly digest: string;
}

export interface NormalizedSourceSpan {
  readonly span_id: string;
  readonly root: "payload" | "event";
  readonly path: string;
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly digest: string;
}

export interface CaptureOptions {
  readonly source_spans?: readonly SourceSpanInput[];
  readonly redaction?: RedactionOptions;
}

export interface PreparedCapture {
  readonly envelope: SourceEnvelope;
  readonly fingerprint: string;
  readonly source_spans: readonly NormalizedSourceSpan[];
}

const preparedCaptures = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function captureFingerprint(envelope: SourceEnvelope, sourceSpans: readonly NormalizedSourceSpan[]): string {
  // The default payload root is intentionally omitted from the fingerprint. This
  // keeps a retry prepared by the v3 code byte-for-byte compatible with a v1/v2
  // capture whose caller did not have a root field yet.
  const fingerprintSpans = [...sourceSpans].sort(compareSpans).map((span) => {
    const canonical = {
      span_id: span.span_id,
      path: span.path,
      start_utf16: span.start_utf16,
      end_utf16: span.end_utf16,
      digest: span.digest,
    };
    return span.root === "payload" ? canonical : { ...canonical, root: span.root };
  });
  const canonical = canonicalJson({ envelope, source_spans: fingerprintSpans });
  if (Buffer.byteLength(canonical, "utf8") > MAX_CAPTURE_BYTES) {
    throw new ContractValidationError("source-envelope", [{ path: "$", code: "payload_too_large" }]);
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Identity digest for replayed native snapshots; observation timestamps stay separate. */
function captureContentDigest(envelope: SourceEnvelope, sourceSpans: readonly NormalizedSourceSpan[]): string {
  const { capture_id: _captureId, captured_at: _capturedAt, occurred_at: _occurredAt, ...contentEnvelope } = envelope;
  const provenance = contentEnvelope.event.provenance;
  const contentEvent = typeof provenance === "object" && provenance !== null && !Array.isArray(provenance)
    ? {
        ...contentEnvelope.event,
        provenance: Object.fromEntries(Object.entries(provenance).filter(([key]) => key !== "revision_id")),
      }
    : contentEnvelope.event;
  return createHash("sha256")
    .update(canonicalJson({ envelope: { ...contentEnvelope, event: contentEvent }, source_spans: [...sourceSpans].sort(compareSpans) }), "utf8")
    .digest("hex");
}

function compareSpans(left: NormalizedSourceSpan, right: NormalizedSourceSpan): number {
  const leftKey = `${left.span_id}\u0000${left.root}\u0000${left.path}\u0000${left.start_utf16}\u0000${left.end_utf16}\u0000${left.digest}`;
  const rightKey = `${right.span_id}\u0000${right.root}\u0000${right.path}\u0000${right.start_utf16}\u0000${right.end_utf16}\u0000${right.digest}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("capture payload is not JSON serializable");
}

function invalidSpan(path: string, code: string): never {
  throw new ContractValidationError("source-spans", [{ path, code }]);
}

function validateSanitizedEnvelope(input: unknown, binding: TrustedBinding): SourceEnvelope {
  try {
    return validateBoundSourceEnvelope(input, binding);
  } catch (error: unknown) {
    if (!(error instanceof ContractValidationError) || error.contract !== "source-envelope") throw error;
    throw new ContractValidationError(
      "source-envelope",
      error.issues.map((issue) => (issue.path === "payload" || issue.path.startsWith("payload.") ? { path: "payload", code: issue.code } : issue)),
    );
  }
}

function decodeJsonPointer(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("must_be_json_pointer");
  return path.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) throw new Error("invalid_json_pointer_escape");
    return part.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

export function resolveTextAtPath(root: unknown, path: string): string {
  let current: unknown = root;
  for (const segment of decodeJsonPointer(path)) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      throw new Error("text_field_not_found");
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "string") throw new Error("target_not_text");
  return current;
}

/** Validate a stored span against its canonical sanitized source text. */
export function validateSpanExcerpt(text: string, start: number, end: number, expectedDigest: string): string {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) {
    throw new Error("outside_text_field");
  }
  const startUnit = text.charCodeAt(start);
  const previousStartUnit = start === 0 ? 0 : text.charCodeAt(start - 1);
  const endUnit = end === text.length ? 0 : text.charCodeAt(end);
  const previousEndUnit = end === 0 ? 0 : text.charCodeAt(end - 1);
  if (startUnit >= 0xdc00 && startUnit <= 0xdfff && previousStartUnit >= 0xd800 && previousStartUnit <= 0xdbff) {
    throw new Error("splits_surrogate_pair");
  }
  if (endUnit >= 0xdc00 && endUnit <= 0xdfff && previousEndUnit >= 0xd800 && previousEndUnit <= 0xdbff) {
    throw new Error("splits_surrogate_pair");
  }
  const excerpt = text.slice(start, end);
  const digest = createHash("sha256").update(excerpt, "utf8").digest("hex");
  if (digest !== expectedDigest.toLowerCase()) throw new Error("does_not_match_span");
  return excerpt;
}

function validateSourceSpans(envelope: SourceEnvelope, options: CaptureOptions): NormalizedSourceSpan[] {
  const spans = parseContract(sourceSpanListSchema, options.source_spans ?? [], "source-spans");
  const seen = new Set<string>();
  const validated: NormalizedSourceSpan[] = [];
  for (const span of spans) {
    if (seen.has(span.span_id)) invalidSpan("span_id", "duplicate");
    seen.add(span.span_id);
    let text: string;
    try {
      text = resolveTextAtPath(span.root === "event" ? envelope.event : envelope.payload, span.path);
      validateSpanExcerpt(text, span.start_utf16, span.end_utf16, span.digest);
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : "invalid_span";
      const path =
        code === "does_not_match_span"
          ? "digest"
          : code === "splits_surrogate_pair" || code === "outside_text_field"
            ? "start_utf16"
            : "path";
      invalidSpan(path, code);
    }
    validated.push({ ...span, root: span.root ?? "payload", digest: span.digest.toLowerCase() });
  }
  return validated;
}

export function capture(
  event: unknown,
  binding: TrustedBinding,
  database: AgentMemoryDatabase,
  options: CaptureOptions = {},
): CaptureAck {
  return database.commitCapture(prepareCaptureInput(event, binding, options));
}

export function observeNative(
  event: unknown,
  binding: TrustedBinding,
  database: AgentMemoryDatabase,
  observation: NativeObservation,
): CaptureAck {
  return database.commitNativeObservation(prepareCaptureInput(event, binding), binding, observation);
}

function declaresHandoff(text: string): boolean {
  if (!/^\s*\{/.test(text)) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "kind" in parsed && parsed.kind === "agent_memory_handoff";
  } catch {
    return /"kind"\s*:\s*"agent_memory_handoff"/.test(text);
  }
}

export function prepareCaptureInput(
  event: unknown,
  binding: TrustedBinding,
  options: CaptureOptions = {},
): PreparedCapture {
  const redacted = redactCaptureInput(event, options.redaction);
  const envelope = validateSanitizedEnvelope(redacted.value, binding);
  // A declared transport envelope is never independent source text. Rejected
  // declarations stay an explicit capture error, including forged/stale wires;
  // this guard grants no provenance and survives broker/adapter restarts.
  if ("text" in envelope.event && typeof envelope.event.text === "string" &&
      declaresHandoff(envelope.event.text)) {
    throw new ContractValidationError("capture", [{ path: "event.text", code: "handoff_requires_authenticated_delivery" }]);
  }
  const sourceSpans = validateSourceSpans(envelope, options);
  const fingerprint = captureFingerprint(envelope, sourceSpans);
  const prepared = deepFreeze({
    envelope,
    fingerprint,
    source_spans: sourceSpans.map((span) => ({ ...span })),
  });
  preparedCaptures.add(prepared);
  return prepared;
}

export function requirePreparedCapture(value: unknown): PreparedCapture {
  if (typeof value === "object" && value !== null && preparedCaptures.has(value)) {
    return value as PreparedCapture;
  }
  throw new ContractValidationError("capture", [{ path: "prepared", code: "capture_not_prepared" }]);
}

/** Rebuild only the timestamp portion of a prepared capture for durable ACK replay. */
export function rebasePreparedCaptureCapturedAt(value: PreparedCapture, capturedAt: string, captureId?: string): PreparedCapture {
  const checked = requirePreparedCapture(value);
  const parsedAt = parseContract(z.iso.datetime({ offset: true }), capturedAt, "capture-observed-at");
  const nextCaptureId = captureId === undefined ? checked.envelope.capture_id : parseContract(z.uuid(), captureId, "capture-id");
  const provenance = checked.envelope.event.provenance;
  const nextEvent = typeof provenance === "object" && provenance !== null && !Array.isArray(provenance) && provenance.revision_id === checked.envelope.capture_id
    ? { ...checked.envelope.event, provenance: { ...provenance, revision_id: nextCaptureId } }
    : checked.envelope.event;
  const envelope = {
    ...checked.envelope,
    capture_id: nextCaptureId,
    captured_at: parsedAt,
    event: nextEvent,
  };
  const prepared = deepFreeze({
    envelope,
    fingerprint: captureFingerprint(envelope, checked.source_spans),
    source_spans: checked.source_spans.map((span) => ({ ...span })),
  });
  preparedCaptures.add(prepared);
  return prepared;
}

export function preparedCaptureContentDigest(value: PreparedCapture): string {
  const checked = requirePreparedCapture(value);
  return captureContentDigest(checked.envelope, checked.source_spans);
}
