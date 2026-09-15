import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ContractValidationError,
  CURRENT_REDACTION_POLICY_VERSION,
  acceptanceLevelSchema,
  correlationSchema,
  evidenceClassSchema,
  nativeEventStageSchema,
  nativeIdsSchema,
  parseContract,
  sourceCoverageSchema,
  sourceEnvelopeSchema,
  sourceRevisionKindSchema,
  sourceRoleSchema,
  validateBoundedJson,
  validateBoundSourceEnvelope,
  type SourceEnvelope,
  type TrustedBinding,
} from "./contract.js";

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const boundedTextSchema = z.string().max(1_000_000);
const toolOutcomeSchema = z.enum(["succeeded", "failed", "unknown"]);
const truncationSchema = z
  .object({
    truncated: z.boolean(),
    omitted_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const revisionInputSchema = z
  .object({
    revision_id: z.uuid().optional(),
    revision_kind: sourceRevisionKindSchema,
    parent_revision_id: z.uuid().optional(),
  })
  .strict();
const payloadSchema = z.unknown();

export const nativeEventInputSchema = z
  .object({
    version: z.literal(1),
    capture_id: z.uuid().optional(),
    scope_id: z.uuid(),
    adapter_version: versionSchema,
    stage: nativeEventStageSchema,
    role: sourceRoleSchema.optional(),
    evidence_class: evidenceClassSchema.optional(),
    native_ids: nativeIdsSchema.optional(),
    text: boundedTextSchema.optional(),
    outcome: toolOutcomeSchema.optional(),
    payload: payloadSchema,
    captured_at: z.iso.datetime({ offset: true }),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
    truncation: truncationSchema.optional(),
    coverage: sourceCoverageSchema,
    correlation: correlationSchema.optional(),
    revision: revisionInputSchema.optional(),
    acceptance_level: acceptanceLevelSchema.optional(),
  })
  .strict();

export type NativeEventInput = z.infer<typeof nativeEventInputSchema>;
export type NativeEventStage = z.infer<typeof nativeEventStageSchema>;
export type NormalizedNativeEvent = SourceEnvelope;

const fixedStageIdentity: Readonly<Record<NativeEventStage, { readonly role: z.infer<typeof sourceRoleSchema>; readonly evidence_class: z.infer<typeof evidenceClassSchema> }>> = {
  session_start: { role: "system", evidence_class: "lifecycle" },
  prompt_submitted: { role: "user", evidence_class: "prompt" },
  prompt_transformed: { role: "user", evidence_class: "prompt" },
  tool_started: { role: "tool", evidence_class: "tool_input" },
  tool_result: { role: "tool", evidence_class: "tool_output" },
  assistant_final: { role: "assistant", evidence_class: "assistant_output" },
  stop: { role: "system", evidence_class: "lifecycle" },
  compaction: { role: "system", evidence_class: "lifecycle" },
  resume: { role: "system", evidence_class: "lifecycle" },
  message_part: { role: "system", evidence_class: "lifecycle" },
  error: { role: "system", evidence_class: "diagnostic" },
};

const requiredTextStages: ReadonlySet<NativeEventStage> = new Set([
  "prompt_submitted",
  "prompt_transformed",
  "assistant_final",
]);
const optionalTextStages: ReadonlySet<NativeEventStage> = new Set(["tool_started", "tool_result", "stop", "message_part", "error"]);

function invalid(path: string, code: string): never {
  throw new ContractValidationError("native-event", [{ path, code }]);
}

function explicitIdentity(
  input: NativeEventInput,
  identity: { readonly role: z.infer<typeof sourceRoleSchema>; readonly evidence_class: z.infer<typeof evidenceClassSchema> },
): { readonly role: z.infer<typeof sourceRoleSchema>; readonly evidence_class: z.infer<typeof evidenceClassSchema> } {
  if (input.stage === "message_part") {
    if (input.role === undefined) invalid("role", "role_required");
    if (input.evidence_class === undefined) invalid("evidence_class", "evidence_class_required");
    return { role: input.role, evidence_class: input.evidence_class };
  }
  if (input.role !== undefined && input.role !== identity.role) invalid("role", "stage_role_mismatch");
  if (input.evidence_class !== undefined && input.evidence_class !== identity.evidence_class) {
    invalid("evidence_class", "stage_evidence_class_mismatch");
  }
  return identity;
}

function normalizeText(input: NativeEventInput): string | undefined {
  const text = input.text;
  if (requiredTextStages.has(input.stage)) {
    if (text === undefined || text.length === 0) invalid("text", "text_required");
    return text;
  }
  if (!optionalTextStages.has(input.stage) && text !== undefined) invalid("text", "text_not_allowed");
  return text;
}

function normalizeOutcome(input: NativeEventInput): z.infer<typeof toolOutcomeSchema> | undefined {
  if (input.stage === "tool_result") {
    if (input.outcome === undefined) invalid("outcome", "outcome_required");
    return input.outcome;
  }
  if (input.outcome !== undefined) invalid("outcome", "outcome_not_allowed");
  return undefined;
}

function normalizeTruncation(input: NativeEventInput): NativeEventInput["truncation"] {
  if (input.truncation !== undefined) return input.truncation;
  return { truncated: input.coverage.reason === "truncated" };
}

/**
 * Converts one adapter-neutral event into a bound SourceEnvelope. The adapter
 * must state correlation and revision links; absent links become explicit
 * unknowns rather than being inferred from similar native IDs.
 */
export function normalizeNativeEvent(inputValue: unknown, binding: TrustedBinding): NormalizedNativeEvent {
  const input = parseContract(nativeEventInputSchema, inputValue, "native-event");
  validateBoundedJson(input.payload, { max_depth: 32, max_bytes: 4_000_000, max_nodes: 100_000 }, "native-event", "payload");
  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) invalid("payload", "object_required");
  const identity = explicitIdentity(input, fixedStageIdentity[input.stage]);
  const text = normalizeText(input);
  const outcome = normalizeOutcome(input);
  const nativeIds = input.native_ids ?? {};
  const correlation = input.correlation ?? {
    status: "correlation_unknown",
    reason: Object.keys(nativeIds).length === 0 ? "missing_native_id" : "not_resolved",
  };
  const revision = input.revision;
  const captureId = input.capture_id ?? randomUUID();
  // A retry without an explicit revision must retain the same identity; parent
  // links remain adapter-supplied and are never inferred from native IDs.
  const revisionId = revision?.revision_id ?? captureId;
  const revisionKind = revision?.revision_kind ?? "initial";
  if (revisionKind === "initial" && revision?.parent_revision_id !== undefined) invalid("revision.parent_revision_id", "initial_revision_has_parent");
  const provenance = {
    revision_id: revisionId,
    revision_kind: revisionKind,
    ...(revision?.parent_revision_id === undefined ? {} : { parent_revision_id: revision.parent_revision_id }),
    correlation,
    coverage: input.coverage,
    ...(input.acceptance_level === undefined ? {} : { acceptance_level: input.acceptance_level }),
  };
  const event: Record<string, unknown> = {
    stage: input.stage,
    role: identity.role,
    evidence_class: identity.evidence_class,
    native_ids: nativeIds,
    provenance,
    ...(text === undefined ? {} : { text }),
    ...(outcome === undefined ? {} : { outcome }),
  };
  const envelope = {
    version: 1,
    capture_id: captureId,
    scope_id: input.scope_id,
    origin: {
      host_kind: binding.host_kind,
      surface: binding.surface,
      execution_domain: { ...binding.execution_domain },
      host_instance_id: binding.host_instance_id,
      host_session_id: binding.host_session_id,
    },
    adapter_version: input.adapter_version,
    event,
    payload: input.payload,
    captured_at: input.captured_at,
    ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    truncation: normalizeTruncation(input),
    redaction: { applied: false, policy_version: CURRENT_REDACTION_POLICY_VERSION },
  };
  // Final contract parsing keeps this neutral boundary aligned with the one
  // persistence path and rejects any shape that a later host adapter guessed.
  let parsed: SourceEnvelope;
  try {
    parsed = parseContract(sourceEnvelopeSchema, envelope, "native-event");
  } catch (error: unknown) {
    if (!(error instanceof ContractValidationError)) throw error;
    throw new ContractValidationError(
      "native-event",
      error.issues.map((issue) => (issue.path === "payload" || issue.path.startsWith("payload.") ? { path: "payload", code: issue.code } : issue)),
    );
  }
  return validateBoundSourceEnvelope(parsed, binding);
}
