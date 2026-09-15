import { createHash } from "node:crypto";

import { z } from "zod";

const MAX_INT64 = 9_223_372_036_854_775_807n;

const uuidSchema = z.uuid();
const scopeIdSchema = uuidSchema;
const revisionIdSchema = uuidSchema;
const opaqueIdSchema = z.string().min(1).max(256);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const dateTimeSchema = z.iso.datetime({ offset: true });
const boundedTextSchema = z.string().max(1_000_000);
const nonEmptyTextSchema = z.string().min(1).max(1_000_000);
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

function isInt64Decimal(value: string, positive: boolean): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  if (value.length > 19) return false;
  if (positive && value === "0") return false;

  try {
    return BigInt(value) <= MAX_INT64;
  } catch {
    return false;
  }
}

export const nonNegativeInt64Schema = z.string().refine((value) => isInt64Decimal(value, false), {
  message: "must be a canonical non-negative signed INT64 decimal string",
});
export const positiveInt64Schema = z.string().refine((value) => isInt64Decimal(value, true), {
  message: "must be a canonical positive signed INT64 decimal string",
});

const hostKindSchema = z.enum(["codex", "claude_code", "opencode", "copilot"]);
const surfaceSchema = z.enum([
  "codex_cli",
  "codex_desktop",
  "claude_code_cli",
  "opencode_cli",
  "copilot_cli",
  "copilot_vscode_agent",
]);
const executionDomainSchema = z
  .object({
    kind: z.enum(["local", "remote_ssh", "container", "wsl"]),
    id: opaqueIdSchema,
  })
  .strict();

export const sourceRoleSchema = z.enum(["user", "assistant", "tool", "system"]);
export const acceptanceLevelSchema = z.enum([
  "adapter_committed",
  "packet_returned",
  "host_context_observed",
  "answer_verified",
]);
export const CURRENT_REDACTION_POLICY_VERSION = "1.0.0" as const;
export const evidenceClassSchema = z.enum([
  "prompt",
  "assistant_output",
  "tool_input",
  "tool_output",
  "lifecycle",
  "diagnostic",
]);
export const nativeEventStageSchema = z.enum([
  "session_start",
  "prompt_submitted",
  "prompt_transformed",
  "tool_started",
  "tool_result",
  "assistant_final",
  "stop",
  "compaction",
  "resume",
  "message_part",
  "error",
]);

export const nativeIdsSchema = z
  .object({
    session_id: opaqueIdSchema.optional(),
    turn_id: opaqueIdSchema.optional(),
    message_id: opaqueIdSchema.optional(),
    part_id: opaqueIdSchema.optional(),
    tool_call_id: opaqueIdSchema.optional(),
  })
  .strict();

export const sourceRevisionKindSchema = z.enum([
  "initial",
  "update",
  "message_update",
  "part_update",
  "final",
  "correction",
]);

export const correlationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("correlated"),
      basis: z.enum(["native_ids", "adapter_link"]),
      key: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("correlation_unknown"),
      reason: z.enum(["missing_native_id", "not_resolved", "adapter_gap"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("ambiguous"),
      candidate_keys: z.array(opaqueIdSchema).min(2).max(16),
    })
    .strict(),
]);

export const sourceCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "coverage_gap"]),
    reason: z.enum(["truncated", "event_not_observed", "adapter_gap", "host_dropped", "correlation_unknown"]).optional(),
  })
  .strict();

export const sourceProvenanceSchema = z
  .object({
    revision_id: uuidSchema,
    revision_kind: sourceRevisionKindSchema,
    parent_revision_id: uuidSchema.optional(),
    correlation: correlationSchema,
    coverage: sourceCoverageSchema,
    acceptance_level: acceptanceLevelSchema.optional(),
  })
  .strict();

export type SourceRevisionKind = z.infer<typeof sourceRevisionKindSchema>;
export type Correlation = z.infer<typeof correlationSchema>;
export type SourceCoverage = z.infer<typeof sourceCoverageSchema>;
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;

const jsonValueSchema = z.json();
const sanitizedPayloadSchema = z.record(z.string().min(1).max(256), jsonValueSchema);

export const readerTargetSchema = z.enum([
  "reader:codex_cli",
  "reader:codex_desktop",
  "reader:claude_code_cli",
  "reader:opencode_cli",
  "reader:copilot_cli",
  "reader:copilot_vscode_agent",
]);
export const managedExportTargetKindSchema = z.enum([
  "claude_skill",
  "codex_instruction",
  "opencode_skill",
  "copilot_cli_skill",
]);
export type ManagedExportTargetKind = z.infer<typeof managedExportTargetKindSchema>;
export const managedExportTargetReaders: Readonly<Record<ManagedExportTargetKind, readonly z.infer<typeof readerTargetSchema>[]>> = {
  claude_skill: ["reader:claude_code_cli"],
  codex_instruction: ["reader:codex_cli", "reader:codex_desktop"],
  opencode_skill: ["reader:opencode_cli"],
  copilot_cli_skill: ["reader:copilot_cli"],
};
const managedSkillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const managedSkillTargetKinds = new Set<ManagedExportTargetKind>(["claude_skill", "opencode_skill", "copilot_cli_skill"]);

/** Validate the host-discoverable filename and derive its stable skill name. */
export function managedExportPathInfo(targetKind: ManagedExportTargetKind, path: string): { readonly skill_name: string | null } {
  const parts = path.replaceAll("\\", "/").split("/");
  const filename = parts.at(-1);
  if (targetKind === "codex_instruction") {
    if (filename !== "AGENTS.md") throw new Error("managed_export_path_invalid");
    return { skill_name: null };
  }
  if (!managedSkillTargetKinds.has(targetKind) || filename !== "SKILL.md") throw new Error("managed_export_path_invalid");
  const skillName = parts.at(-2);
  if (skillName === undefined || skillName.length > 64 || !managedSkillNamePattern.test(skillName)) throw new Error("managed_export_path_invalid");
  return { skill_name: skillName };
}
export const providerTargetSchema = z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/);
export const egressSchema = z
  .object({
    reader_targets: z.array(readerTargetSchema).max(32),
    provider_targets: z.array(providerTargetSchema).max(32),
  })
  .strict();

const surfacePairs: Readonly<Record<z.infer<typeof hostKindSchema>, readonly z.infer<typeof surfaceSchema>[]>> = {
  codex: ["codex_cli", "codex_desktop"],
  claude_code: ["claude_code_cli"],
  opencode: ["opencode_cli"],
  copilot: ["copilot_cli", "copilot_vscode_agent"],
};

function addSurfacePairIssue(
  value: { host_kind: z.infer<typeof hostKindSchema>; surface: z.infer<typeof surfaceSchema> },
  context: z.RefinementCtx,
): void {
  if (!surfacePairs[value.host_kind].includes(value.surface)) {
    context.addIssue({
      code: "custom",
      path: ["surface"],
      message: "host_surface_mismatch",
    });
  }
}

function addBindingPolicyIssues(
  value: {
    host_kind: z.infer<typeof hostKindSchema>;
    surface: z.infer<typeof surfaceSchema>;
    egress: z.infer<typeof egressSchema>;
  },
  context: z.RefinementCtx,
): void {
  addSurfacePairIssue(value, context);
  const expectedReaderTarget = `reader:${value.surface}`;
  for (const [index, target] of value.egress.reader_targets.entries()) {
    if (target !== expectedReaderTarget) {
      context.addIssue({
        code: "custom",
        path: ["egress", "reader_targets", index],
        message: "reader_target_surface_mismatch",
      });
    }
  }
}

const originSchema = z
  .object({
    host_kind: hostKindSchema,
    surface: surfaceSchema,
    execution_domain: executionDomainSchema,
    host_instance_id: opaqueIdSchema,
    host_session_id: opaqueIdSchema,
  })
  .strict()
  .superRefine(addSurfacePairIssue);

const bindingShapeSchema = z
  .object({
    version: z.literal(1),
    binding_id: uuidSchema,
    host_kind: hostKindSchema,
    surface: surfaceSchema,
    execution_domain: executionDomainSchema,
    host_instance_id: opaqueIdSchema,
    host_session_id: opaqueIdSchema,
    allowed_scope_ids: z.array(scopeIdSchema).min(1).max(128),
    egress: egressSchema,
  })
  .strict()
  .superRefine(addBindingPolicyIssues);

export const hostBindingSchema = bindingShapeSchema;

export type HostBinding = z.infer<typeof hostBindingSchema>;
declare const trustedBindingBrand: unique symbol;
type ReadonlyHostBinding = Readonly<Omit<HostBinding, "execution_domain" | "allowed_scope_ids" | "egress">> & {
  readonly execution_domain: Readonly<HostBinding["execution_domain"]>;
  readonly allowed_scope_ids: readonly HostBinding["allowed_scope_ids"][number][];
  readonly egress: {
    readonly reader_targets: readonly HostBinding["egress"]["reader_targets"][number][];
    readonly provider_targets: readonly HostBinding["egress"]["provider_targets"][number][];
  };
};
export type TrustedBinding = ReadonlyHostBinding & { readonly [trustedBindingBrand]: true };
// Structural copies of a binding must not inherit its authority.
const trustedBindings = new WeakSet<TrustedBinding>();
// Native sessions derive fresh binding IDs, but persisted context ownership
// must remain tied to the authenticated installation binding across sessions.
const bindingOwners = new WeakMap<TrustedBinding, string>();

export interface ContractIssue {
  readonly path: string;
  readonly code: string;
}

export class ContractValidationError extends Error {
  readonly code = "CONTRACT_INVALID";

  constructor(
    readonly contract: string,
    readonly issues: readonly ContractIssue[],
  ) {
    super(`${contract}: ${issues.map((issue) => `${issue.path}:${issue.code}`).join(";")}`);
    this.name = "ContractValidationError";
  }
}

export interface JsonBounds {
  readonly max_depth: number;
  readonly max_bytes: number;
  readonly max_nodes: number;
}

/** Bounds plain JSON before a schema or sanitizer recursively copies it. */
export function validateBoundedJson(value: unknown, bounds: JsonBounds, contract: string, path = "$"): void {
  if (
    !Number.isSafeInteger(bounds.max_depth) ||
    bounds.max_depth < 1 ||
    !Number.isSafeInteger(bounds.max_bytes) ||
    bounds.max_bytes < 1 ||
    !Number.isSafeInteger(bounds.max_nodes) ||
    bounds.max_nodes < 1
  ) {
    throw new ContractValidationError(contract, [{ path, code: "invalid_bound" }]);
  }
  let bytes = 0;
  let nodes = 0;
  const active = new WeakSet<object>();
  const invalid = (code: string): never => {
    throw new ContractValidationError(contract, [{ path, code }]);
  };
  const account = (amount: number): void => {
    bytes += amount;
    if (bytes > bounds.max_bytes) invalid("payload_too_large");
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > bounds.max_depth) invalid("max_depth");
    nodes += 1;
    if (nodes > bounds.max_nodes) invalid("payload_too_large");
    if (typeof current === "string") {
      account(Buffer.byteLength(current, "utf8"));
      return;
    }
    if (current === null || typeof current === "boolean") {
      account(1);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid("invalid_json_value");
      account(8);
      return;
    }
    if (typeof current !== "object") invalid("unsupported_value");
    const objectValue = current as object;
    if (active.has(objectValue)) invalid("cyclic_value");
    active.add(objectValue);
    try {
      let prototype: object | null = null;
      let keys: string[] = [];
      try {
        prototype = Object.getPrototypeOf(objectValue);
        keys = Object.keys(objectValue);
      } catch {
        invalid("unreadable_value");
      }
      if (Array.isArray(objectValue) && prototype !== Array.prototype && prototype !== null) invalid("unsupported_object");
      if (!Array.isArray(objectValue) && prototype !== Object.prototype && prototype !== null) invalid("unsupported_object");
      if (Array.isArray(objectValue)) {
        account(objectValue.length + 1);
        for (let index = 0; index < objectValue.length; index += 1) {
          let descriptor: PropertyDescriptor | undefined;
          try {
            descriptor = Object.getOwnPropertyDescriptor(objectValue, String(index));
          } catch {
            invalid("unreadable_value");
          }
          if (descriptor === undefined) visit(null, depth + 1);
          else {
            if (descriptor.get !== undefined || descriptor.set !== undefined) invalid("accessor_not_allowed");
            visit(descriptor.value, depth + 1);
          }
        }
      } else {
        account(1);
        for (const key of keys) {
          account(Buffer.byteLength(key, "utf8") + 1);
          let descriptor: PropertyDescriptor | undefined;
          try {
            descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
          } catch {
            invalid("unreadable_value");
          }
          const ownDescriptor = descriptor ?? invalid("accessor_not_allowed");
          if (ownDescriptor.get !== undefined || ownDescriptor.set !== undefined) invalid("accessor_not_allowed");
          visit(ownDescriptor.value, depth + 1);
        }
      }
    } finally {
      active.delete(objectValue);
    }
  };
  visit(value, 0);
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map((part) => String(part)).join(".");
}

function validationIssues(error: z.ZodError): ContractIssue[] {
  return error.issues
    .map((issue) => ({ path: issuePath(issue.path), code: issue.code }))
    .sort((left, right) => {
      const leftKey = `${left.path}:${left.code}`;
      const rightKey = `${right.path}:${right.code}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

export function parseContract<T>(schema: z.ZodType<T>, input: unknown, contract: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ContractValidationError(contract, validationIssues(result.error));
  }
  return result.data;
}

export function createTrustedBinding(input: unknown): TrustedBinding {
  const parsed = parseContract(hostBindingSchema, input, "host-binding");
  const immutableDomain = Object.freeze({ ...parsed.execution_domain });
  const immutableScopes = Object.freeze([...parsed.allowed_scope_ids]);
  const immutableEgress = Object.freeze({
    reader_targets: Object.freeze([...parsed.egress.reader_targets]),
    provider_targets: Object.freeze([...parsed.egress.provider_targets]),
  });
  const trusted = Object.freeze({
    ...parsed,
    execution_domain: immutableDomain,
    allowed_scope_ids: immutableScopes,
    egress: immutableEgress,
  }) as TrustedBinding;
  trustedBindings.add(trusted);
  bindingOwners.set(trusted, trusted.binding_id);
  return trusted;
}

export function isTrustedBinding(value: unknown): value is TrustedBinding {
  return typeof value === "object" && value !== null && trustedBindings.has(value as TrustedBinding);
}

/** Return the authenticated installation owner for a binding or native session. */
export function bindingOwnerId(binding: TrustedBinding): string {
  if (!isTrustedBinding(binding)) throw new Error("trusted_binding_required");
  return bindingOwners.get(binding) ?? binding.binding_id;
}

function deterministicUuid(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Derive a stable binding identity for one explicitly registered native session. */
export function deriveNativeSessionBindingId(binding: TrustedBinding, nativeSessionId: string): string {
  if (!isTrustedBinding(binding)) throw new Error("trusted_binding_required");
  const sessionId = parseContract(opaqueIdSchema, nativeSessionId, "native-session-id");
  return deterministicUuid(`agent-memory:native-session-binding:v1\0${binding.binding_id}\0${sessionId}`);
}

/**
 * Copy the setup-time authority into a session-specific binding. The native
 * session id changes provenance and the derived id only; it cannot select
 * scopes or egress targets.
 */
export function createNativeSessionBinding(binding: TrustedBinding, nativeSessionId: string): TrustedBinding {
  if (!isTrustedBinding(binding)) throw new Error("trusted_binding_required");
  const sessionId = parseContract(opaqueIdSchema, nativeSessionId, "native-session-id");
  const ownerId = bindingOwnerId(binding);
  const sessionBinding = createTrustedBinding({
    version: 1,
    binding_id: deriveNativeSessionBindingId(binding, sessionId),
    host_kind: binding.host_kind,
    surface: binding.surface,
    execution_domain: { ...binding.execution_domain },
    host_instance_id: binding.host_instance_id,
    host_session_id: sessionId,
    allowed_scope_ids: [...binding.allowed_scope_ids],
    egress: {
      reader_targets: [...binding.egress.reader_targets],
      provider_targets: [...binding.egress.provider_targets],
    },
  });
  bindingOwners.set(sessionBinding, ownerId);
  return sessionBinding;
}

const nativeEventCommon = {
  native_ids: nativeIdsSchema,
  provenance: sourceProvenanceSchema.optional(),
};

const nativeEventSchema = z.discriminatedUnion("stage", [
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("session_start"),
      role: z.literal("system"),
      evidence_class: z.literal("lifecycle"),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("prompt_submitted"),
      role: z.literal("user"),
      evidence_class: z.literal("prompt"),
      text: nonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("prompt_transformed"),
      role: z.literal("user"),
      evidence_class: z.literal("prompt"),
      text: nonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("tool_started"),
      role: z.literal("tool"),
      evidence_class: z.literal("tool_input"),
      text: boundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("tool_result"),
      role: z.literal("tool"),
      evidence_class: z.literal("tool_output"),
      outcome: z.enum(["succeeded", "failed", "unknown"]),
      text: boundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("assistant_final"),
      role: z.literal("assistant"),
      evidence_class: z.literal("assistant_output"),
      text: nonEmptyTextSchema,
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("stop"),
      role: z.literal("system"),
      evidence_class: z.literal("lifecycle"),
      text: boundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("compaction"),
      role: z.literal("system"),
      evidence_class: z.literal("lifecycle"),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("resume"),
      role: z.literal("system"),
      evidence_class: z.literal("lifecycle"),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("message_part"),
      role: sourceRoleSchema,
      evidence_class: evidenceClassSchema,
      text: boundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...nativeEventCommon,
      stage: z.literal("error"),
      role: z.literal("system"),
      evidence_class: z.literal("diagnostic"),
      text: boundedTextSchema.optional(),
    })
    .strict(),
]);

export const sourceEnvelopeSchema = z
  .object({
    version: z.literal(1),
    capture_id: uuidSchema,
    scope_id: scopeIdSchema,
    origin: originSchema,
    adapter_version: versionSchema,
    event: nativeEventSchema,
    payload: sanitizedPayloadSchema,
    captured_at: dateTimeSchema,
    occurred_at: dateTimeSchema.optional(),
    truncation: z
      .object({
        truncated: z.boolean(),
        omitted_bytes: nonNegativeIntegerSchema.optional(),
      })
      .strict(),
    redaction: z
      .object({
        applied: z.boolean(),
        policy_version: versionSchema,
      })
      .strict(),
  })
  .strict();

export type SourceEnvelope = z.infer<typeof sourceEnvelopeSchema>;
export type NativeEvent = z.infer<typeof nativeEventSchema>;

export function parseSourceEnvelope(input: unknown): SourceEnvelope {
  return parseContract(sourceEnvelopeSchema, input, "source-envelope");
}

function bindingIssue(path: string, code: string): never {
  throw new ContractValidationError("source-envelope", [{ path, code }]);
}

export function validateBoundSourceEnvelope(input: unknown, binding: TrustedBinding): SourceEnvelope {
  if (!isTrustedBinding(binding)) {
    throw new ContractValidationError("source-envelope", [{ path: "binding", code: "binding_not_trusted" }]);
  }

  const envelope = parseSourceEnvelope(input);
  if (!binding.allowed_scope_ids.includes(envelope.scope_id)) {
    return bindingIssue("scope_id", "scope_not_allowed");
  }

  const identity: Array<readonly [string, string, string]> = [
    ["host_kind", envelope.origin.host_kind, binding.host_kind],
    ["surface", envelope.origin.surface, binding.surface],
    ["host_instance_id", envelope.origin.host_instance_id, binding.host_instance_id],
    ["host_session_id", envelope.origin.host_session_id, binding.host_session_id],
    ["execution_domain.kind", envelope.origin.execution_domain.kind, binding.execution_domain.kind],
    ["execution_domain.id", envelope.origin.execution_domain.id, binding.execution_domain.id],
  ];
  for (const [path, actual, expected] of identity) {
    if (actual !== expected) {
      return bindingIssue(`origin.${path}`, "binding_identity_mismatch");
    }
  }

  return envelope;
}

export const captureCoverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "coverage_gap"]),
    stages: z.array(nativeEventStageSchema).min(1).max(32),
    truncated: z.boolean(),
  })
  .strict();

export const captureAckSchema = z
  .object({
    version: z.literal(1),
    capture_id: uuidSchema,
    commit_seq: positiveInt64Schema,
    coverage: captureCoverageSchema,
  })
  .strict();

export type CaptureAck = z.infer<typeof captureAckSchema>;

export function parseCaptureAck(input: unknown): CaptureAck {
  return parseContract(captureAckSchema, input, "capture-ack");
}

export const nativeReconcileCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "coverage_gap"]),
  reason: z.string().min(1).max(64).optional(),
  gaps: z.array(z.object({ identity_key: z.string().min(1).max(1_024), reason: z.string().min(1).max(128) }).strict()).max(128).optional(),
}).strict();
export type NativeReconcileCoverage = z.infer<typeof nativeReconcileCoverageSchema>;

/** Durable identity supplied by a native adapter before capture persistence. */
export const nativeObservationIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      key: z.string().min(1).max(1_024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("part_snapshot"),
      session_id: opaqueIdSchema,
      message_id: opaqueIdSchema,
      part_id: opaqueIdSchema,
      expected_generation: nonNegativeInt64Schema.optional(),
    })
    .strict(),
]);

export type NativeObservationIdentity = z.infer<typeof nativeObservationIdentitySchema>;

export const nativeObservationSchema = z
  .object({
    version: z.literal(1),
    identity: nativeObservationIdentitySchema,
    scan_id: uuidSchema.optional(),
    scan_watermark: nonNegativeInt64Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scan_id === undefined) !== (value.scan_watermark === undefined)) {
      context.addIssue({ code: "custom", path: ["scan_id"], message: "scan_identity_incomplete" });
    }
  });

export type NativeObservation = z.infer<typeof nativeObservationSchema>;

export const nativeReconcileCursorSchema = z
  .object({
    message_id: opaqueIdSchema,
    part_id: opaqueIdSchema,
  })
  .strict();

export type NativeReconcileCursor = z.infer<typeof nativeReconcileCursorSchema>;

export const acceptanceObservationSchema = z
  .object({
    version: z.literal(1),
    level: acceptanceLevelSchema,
    evidence_id: uuidSchema,
    observed_at: dateTimeSchema,
  })
  .strict();

export type AcceptanceObservation = z.infer<typeof acceptanceObservationSchema>;

export function parseAcceptanceObservation(input: unknown): AcceptanceObservation {
  return parseContract(acceptanceObservationSchema, input, "acceptance-observation");
}

export const recallRequestSchema = z
  .object({
    query: z.string().min(1).max(100_000),
    scope_ids: z.array(scopeIdSchema).min(1).max(128),
    valid_at: dateTimeSchema.optional(),
    known_at_seq: nonNegativeInt64Schema.optional(),
    mode: z.enum(["current", "historical", "timeline"]),
    token_budget: positiveIntegerSchema,
  })
  .strict();

export type RecallRequest = z.infer<typeof recallRequestSchema>;

export function parseRecallRequest(input: unknown): RecallRequest {
  return parseContract(recallRequestSchema, input, "recall-request");
}

export function validateBoundRecallRequest(input: unknown, binding: TrustedBinding): RecallRequest {
  if (!isTrustedBinding(binding)) {
    throw new ContractValidationError("recall-request", [{ path: "binding", code: "binding_not_trusted" }]);
  }

  const request = parseRecallRequest(input);
  for (const [index, scopeId] of request.scope_ids.entries()) {
    if (!binding.allowed_scope_ids.includes(scopeId)) {
      throw new ContractValidationError("recall-request", [
        { path: `scope_ids.${index}`, code: "scope_not_allowed" },
      ]);
    }
  }
  if (binding.egress.reader_targets.length === 0) {
    throw new ContractValidationError("recall-request", [{ path: "binding.egress.reader_targets", code: "reader_egress_missing" }]);
  }
  return request;
}

const evidenceItemSchema = z
  .object({
    item_id: uuidSchema,
    revision_id: revisionIdSchema,
    scope_id: scopeIdSchema,
    kind: z.enum(["source", "claim", "decision", "lesson", "summary", "procedure", "edge", "record"]),
    status: z.enum(["supported", "candidate", "disputed", "historical", "pending_extraction"]),
    content: boundedTextSchema,
    source_span_ids: z.array(uuidSchema).min(1).max(128),
    record_provenance: z.object({
      origin: z.literal("agent_report"),
      evidence_captured_at: dateTimeSchema,
      created_commit_seq: nonNegativeInt64Schema,
      sources: z.array(z.object({ capture_id: uuidSchema, span_id: uuidSchema }).strict()).min(1).max(16),
    }).strict().optional(),
    source_class: evidenceClassSchema.optional(),
    role: sourceRoleSchema.optional(),
    source_provenance: z
      .array(
        z
          .object({
            capture_id: uuidSchema,
            span_id: uuidSchema,
            scope_id: scopeIdSchema,
            revision_id: revisionIdSchema,
            root: z.enum(["payload", "event"]),
            path: z.string().min(1).max(512),
            start_utf16: nonNegativeIntegerSchema,
            end_utf16: positiveIntegerSchema,
            digest: z.string().regex(/^[a-f0-9]{64}$/i),
            quote: boundedTextSchema,
            captured_at: dateTimeSchema,
            occurred_at: dateTimeSchema.nullable(),
            commit_seq: nonNegativeInt64Schema,
            data_epoch: nonNegativeInt64Schema,
          })
          .strict()
          .superRefine((value, context) => {
            if (value.end_utf16 <= value.start_utf16) {
              context.addIssue({ code: "custom", path: ["end_utf16"], message: "span_range_invalid" });
            }
          }),
      )
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "record") {
      const refs = value.record_provenance?.sources;
      if (value.role !== "assistant" || value.source_class !== "assistant_output" || value.status !== "candidate" || !refs ||
        refs.length !== value.source_span_ids.length || new Set(refs.map(ref => ref.span_id)).size !== refs.length ||
        refs.some(ref => !value.source_span_ids.includes(ref.span_id))) {
        context.addIssue({ code: "custom", path: ["record_provenance"], message: "invalid_agent_report" });
      }
    } else if (value.record_provenance !== undefined) {
      context.addIssue({ code: "custom", path: ["record_provenance"], message: "record_provenance_forbidden" });
    }
    if (value.source_provenance === undefined) return;
    const ids = value.source_provenance.map((span) => span.span_id);
    if (new Set(ids).size !== ids.length || ids.length !== value.source_span_ids.length || ids.some((id) => !value.source_span_ids.includes(id))) {
      context.addIssue({ code: "custom", path: ["source_provenance"], message: "span_ids_mismatch" });
    }
    if (value.source_provenance.some((span) => span.scope_id !== value.scope_id || span.revision_id !== value.revision_id)) {
      context.addIssue({ code: "custom", path: ["source_provenance"], message: "source_identity_mismatch" });
    }
  });

const evidencePacketDiagnosticSchema = z
  .object({
    code: z.enum(["no_match", "budget_exhausted", "revalidation_failed", "degraded_lexical", "graph_incomplete"]),
  })
  .strict();

const evidencePacketScopeEpochSchema = z
  .object({
    scope_id: scopeIdSchema,
    data_epoch: nonNegativeInt64Schema,
    privacy_epoch: nonNegativeInt64Schema,
  })
  .strict();

/** Optional continuation for an incomplete, already authorized graph expansion. */
export const evidenceGraphContinuationSchema = z.object({
  complete: z.boolean(),
  reason: z.enum(["edge_budget_exhausted", "packet_budget_exhausted"]).optional(),
  cursor: z.object({ hop: z.number().int().min(1).max(2), scope_id: scopeIdSchema, edge_id: uuidSchema }).strict().optional(),
}).strict();

export const evidencePacketSchema = z
  .object({
    version: z.literal(1),
    query_id: uuidSchema,
    watermark: nonNegativeInt64Schema,
    data_epoch: nonNegativeInt64Schema,
    privacy_epoch: nonNegativeInt64Schema,
    valid_until: dateTimeSchema,
    items: z.array(evidenceItemSchema).max(200),
    tokens: z
      .object({
        used: nonNegativeIntegerSchema,
        budget: positiveIntegerSchema,
        unit: z.enum(["tokens", "utf8_bytes"]).optional(),
      })
      .strict()
      .refine((tokens) => tokens.used <= tokens.budget, {
        message: "used_tokens_exceed_budget",
        path: ["used"],
      }),
    mode: z.enum(["current", "historical", "timeline", "degraded"]),
    known_at_seq: nonNegativeInt64Schema.optional(),
    scope_epochs: z.array(evidencePacketScopeEpochSchema).min(1).max(128).optional(),
    diagnostics: z.array(evidencePacketDiagnosticSchema).max(8).optional(),
    graph_continuation: evidenceGraphContinuationSchema.optional(),
    delivery: z
      .object({
        format: z.literal("agent_memory_evidence_v1"),
        injection_id: uuidSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.known_at_seq !== undefined && BigInt(value.known_at_seq) > BigInt(value.watermark)) {
      context.addIssue({ code: "custom", path: ["known_at_seq"], message: "known_at_after_watermark" });
    }
    if (value.scope_epochs !== undefined) {
      const ids = value.scope_epochs.map((scope) => scope.scope_id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: "custom", path: ["scope_epochs"], message: "duplicate_scope" });
      }
      if (value.graph_continuation?.cursor !== undefined && !ids.includes(value.graph_continuation.cursor.scope_id)) {
        context.addIssue({ code: "custom", path: ["graph_continuation", "cursor"], message: "cursor_scope_outside_packet" });
      }
    }
  });

export type EvidencePacket = z.infer<typeof evidencePacketSchema>;

export function parseEvidencePacket(input: unknown): EvidencePacket {
  return parseContract(evidencePacketSchema, input, "evidence-packet");
}

export function validateBoundEvidencePacket(input: unknown, binding: TrustedBinding): EvidencePacket {
  if (!isTrustedBinding(binding)) {
    throw new ContractValidationError("evidence-packet", [{ path: "binding", code: "binding_not_trusted" }]);
  }

  const packet = parseEvidencePacket(input);
  for (const [index, item] of packet.items.entries()) {
    if (!binding.allowed_scope_ids.includes(item.scope_id)) {
      throw new ContractValidationError("evidence-packet", [
        { path: `items.${index}.scope_id`, code: "scope_not_allowed" },
      ]);
    }
  }
  if (binding.egress.reader_targets.length === 0) {
    throw new ContractValidationError("evidence-packet", [{ path: "binding.egress.reader_targets", code: "reader_egress_missing" }]);
  }
  return packet;
}

export const contractSchemas = {
  hostBinding: hostBindingSchema,
  sourceEnvelope: sourceEnvelopeSchema,
  sourceProvenance: sourceProvenanceSchema,
  sourceCoverage: sourceCoverageSchema,
  nativeEventStage: nativeEventStageSchema,
  captureAck: captureAckSchema,
  nativeObservation: nativeObservationSchema,
  nativeObservationIdentity: nativeObservationIdentitySchema,
  nativeReconcileCursor: nativeReconcileCursorSchema,
  acceptanceObservation: acceptanceObservationSchema,
  recallRequest: recallRequestSchema,
  evidencePacket: evidencePacketSchema,
} as const;
