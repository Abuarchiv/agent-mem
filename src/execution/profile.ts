import { createHash } from "node:crypto";

import { z } from "zod";

import { nonNegativeInt64Schema, parseContract } from "../host/contract.js";
import {
  executionProfileSchema,
  parseExecutionProfile,
  parseExecutionRequest,
  type ExecutionProfile,
  type ExecutionRequest,
} from "./types.js";

const uuidSchema = z.uuid();
const opaqueIdSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const dateTimeSchema = z.iso.datetime({ offset: true });
const dispatchModeSchema = z.enum(["synthetic", "live"]);

export const executionLimitsSchema = z
  .object({
    max_output_bytes: positiveIntegerSchema,
    max_output_tokens: positiveIntegerSchema,
    max_duration_seconds: positiveIntegerSchema,
    max_source_spans: positiveIntegerSchema,
  })
  .strict();

const qualificationSnapshotSchema = z
  .object({
    profile_hash: sha256Schema,
    provider_id: opaqueIdSchema,
    account_ref: opaqueIdSchema,
    auth_epoch: nonNegativeInt64Schema,
    runtime_id: opaqueIdSchema,
    model_id: opaqueIdSchema,
    reasoning: opaqueIdSchema.nullable(),
    limits: executionLimitsSchema,
  })
  .strict();

const qualificationGateIdSchema = z.enum([
  "C1_AUTH_RESTART",
  "C2_ENTITLEMENT",
  "C3_CONFIGURATION",
  "C4_SIDE_EFFECT",
  "C5_RESULT_QUALITY",
  "C6_BUDGET_ABORT",
  "C7_RETENTION_PURGE",
  "C8_EFFICIENCY",
]);

const qualificationGateSchema = z
  .object({
    id: qualificationGateIdSchema,
    result: z.enum(["pass", "fail", "unknown"]),
    evidence_ref: z.string().regex(/^(?:T01c|G5)[.:/][A-Za-z0-9._/-]+$/),
  })
  .strict();

const qualificationGateIds = [
  "C1_AUTH_RESTART",
  "C2_ENTITLEMENT",
  "C3_CONFIGURATION",
  "C4_SIDE_EFFECT",
  "C5_RESULT_QUALITY",
  "C6_BUDGET_ABORT",
  "C7_RETENTION_PURGE",
  "C8_EFFICIENCY",
] as const;

const qualificationProofSchema = z
  .object({
    proof_ref: opaqueIdSchema,
    snapshot: qualificationSnapshotSchema,
  })
  .strict();

const qualificationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("synthetic"),
      state: z.enum(["unqualified", "qualified"]),
      method: z.literal("local_code_check"),
      evidence_scope: z.literal("synthetic_only"),
      checked_at: dateTimeSchema,
      proof: qualificationProofSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      state: z.literal("qualified"),
      method: z.literal("native_qualification"),
      evidence_scope: z.literal("native_runtime"),
      fixture_origin: z.enum(["simulated_native_fixture", "t01c_canary", "g5_verified"]),
      checked_at: dateTimeSchema,
      proof: qualificationProofSchema,
      gates: z.array(qualificationGateSchema).length(8),
    })
    .strict(),
]);

export const executionBindingSchema = z
  .object({
    version: z.literal(1),
    binding_id: uuidSchema,
    provider_id: opaqueIdSchema,
    account_ref: opaqueIdSchema,
    profile_hash: sha256Schema,
    profile: executionProfileSchema,
    limits: executionLimitsSchema,
    qualification: qualificationSchema,
  })
  .strict();

export type ExecutionBinding = z.infer<typeof executionBindingSchema>;
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export type DispatchMode = z.infer<typeof dispatchModeSchema>;

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly ReadonlyDeep<U>[]
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

declare const trustedExecutionBindingBrand: unique symbol;
export type TrustedExecutionBinding = ReadonlyDeep<ExecutionBinding> & {
  readonly [trustedExecutionBindingBrand]: true;
};

const trustedBindings = new WeakSet<TrustedExecutionBinding>();
const bindingLifecycles = new WeakMap<TrustedExecutionBinding, { state: "active" | "revoked"; replacement_binding_id: string | null }>();

export const executionBindingRevocationSchema = z
  .object({
    binding_id: uuidSchema,
    reason: z.enum(["auth_epoch_changed", "policy_changed", "replaced", "logout", "manual"]),
    revoked_at: dateTimeSchema,
    replacement_binding_id: uuidSchema.nullable(),
  })
  .strict();

export type ExecutionBindingRevocation = z.infer<typeof executionBindingRevocationSchema>;

export class ExecutionValidationError extends Error {
  readonly name = "ExecutionValidationError";

  constructor(
    readonly code: string,
    readonly path: string,
    message = code,
  ) {
    super(`${code}:${path}:${message}`);
  }
}

export function fail(code: string, path: string, message = code): never {
  throw new ExecutionValidationError(code, path, message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalProfile(profile: ExecutionProfile, limits: ExecutionLimits): string {
  return JSON.stringify({
    version: profile.version,
    profile_id: profile.profile_id,
    runtime_id: profile.runtime_id,
    model_id: profile.model_id,
    reasoning: profile.reasoning ?? null,
    account_ref: profile.account_ref ?? null,
    auth_epoch: profile.auth_epoch,
    allowed_scope_ids: [...profile.allowed_scope_ids].sort(),
    egress: {
      reader_targets: [...profile.egress.reader_targets].sort(),
      provider_targets: [...profile.egress.provider_targets].sort(),
    },
    limits: {
      max_output_bytes: limits.max_output_bytes,
      max_output_tokens: limits.max_output_tokens,
      max_duration_seconds: limits.max_duration_seconds,
      max_source_spans: limits.max_source_spans,
    },
  });
}

function canonicalLimits(limits: ExecutionLimits): string {
  return JSON.stringify({
    max_output_bytes: limits.max_output_bytes,
    max_output_tokens: limits.max_output_tokens,
    max_duration_seconds: limits.max_duration_seconds,
    max_source_spans: limits.max_source_spans,
  });
}

export function computeProfileHash(profileInput: unknown, limitsInput: unknown): string {
  const limits = executionLimitsSchema.parse(limitsInput);
  const profile = parseExecutionProfile(profileInput);
  return createHash("sha256").update(canonicalProfile(profile, limits), "utf8").digest("hex");
}

function isTrustedExecutionBinding(value: unknown): value is TrustedExecutionBinding {
  return typeof value === "object" && value !== null && trustedBindings.has(value as TrustedExecutionBinding);
}

export function requireTrustedExecutionBinding(value: unknown): TrustedExecutionBinding {
  if (!isTrustedExecutionBinding(value)) fail("binding_untrusted", "binding", "binding was not created by trusted setup");
  return value;
}

export function requireActiveExecutionBinding(value: unknown): TrustedExecutionBinding {
  const binding = requireTrustedExecutionBinding(value);
  if (bindingLifecycles.get(binding)?.state !== "active") fail("binding_revoked", "binding", "binding is revoked or replaced");
  return binding;
}

function parseBinding(input: unknown): ExecutionBinding {
  return parseContract(executionBindingSchema, input, "execution-binding");
}

export function createExecutionBinding(input: unknown): TrustedExecutionBinding {
  const parsed = parseBinding(input);
  if (parsed.profile_hash !== computeProfileHash(parsed.profile, parsed.limits)) {
    fail("profile_hash_mismatch", "profile_hash", "profile_hash does not match the configured profile");
  }
  if (!parsed.profile.egress.provider_targets.includes(`provider:${parsed.provider_id}`)) {
    fail("provider_egress_missing", "profile.egress.provider_targets", "configured provider is not an allowed egress target");
  }
  if (parsed.qualification.state === "qualified") {
    if (parsed.profile.status !== "ready") {
      fail("qualification_invalid", "qualification.state", "only a ready profile can carry qualified local evidence");
    }
    if (parsed.profile.account_ref !== parsed.account_ref) {
      fail("qualification_invalid", "account_ref", "qualified profile and binding account must match");
    }
    const proof = parsed.qualification.proof.snapshot;
    const expectedProof = {
      profile_hash: parsed.profile_hash,
      provider_id: parsed.provider_id,
      account_ref: parsed.account_ref,
      auth_epoch: parsed.profile.auth_epoch,
      runtime_id: parsed.profile.runtime_id,
      model_id: parsed.profile.model_id,
      reasoning: parsed.profile.reasoning ?? null,
      limits: parsed.limits,
    };
    if (
      proof.profile_hash !== expectedProof.profile_hash ||
      proof.provider_id !== expectedProof.provider_id ||
      proof.account_ref !== expectedProof.account_ref ||
      proof.auth_epoch !== expectedProof.auth_epoch ||
      proof.runtime_id !== expectedProof.runtime_id ||
      proof.model_id !== expectedProof.model_id ||
      proof.reasoning !== expectedProof.reasoning ||
      canonicalLimits(proof.limits) !== canonicalLimits(expectedProof.limits)
    ) {
      fail("qualification_proof_mismatch", "qualification.proof", "qualification proof does not describe this exact profile");
    }
    if (parsed.qualification.kind === "native") {
      const gateIds = parsed.qualification.gates.map((gate) => gate.id);
      if (new Set(gateIds).size !== qualificationGateIds.length || qualificationGateIds.some((id) => !gateIds.includes(id))) {
        fail("qualification_gate_mismatch", "qualification.gates", "native qualification must reference every C1-C8 gate exactly once");
      }
      if (parsed.qualification.fixture_origin === "g5_verified" && parsed.qualification.gates.some((gate) => gate.result !== "pass")) {
        fail("qualification_gate_mismatch", "qualification.gates", "g5_verified native qualification requires every C1-C8 gate to pass");
      }
    }
  }
  const trusted = deepFreeze(parsed) as unknown as TrustedExecutionBinding;
  trustedBindings.add(trusted);
  bindingLifecycles.set(trusted, { state: "active", replacement_binding_id: null });
  return trusted;
}

export function revokeExecutionBinding(input: unknown, revocationInput: unknown): ExecutionBindingRevocation {
  const binding = requireTrustedExecutionBinding(input);
  const revocation = parseContract(executionBindingRevocationSchema, revocationInput, "execution-binding-revocation");
  if (revocation.binding_id !== binding.binding_id) fail("binding_id_mismatch", "revocation.binding_id");
  if (bindingLifecycles.get(binding)?.state !== "active") fail("binding_revoked", "binding", "binding is already revoked or replaced");
  if ((revocation.reason === "replaced") !== (revocation.replacement_binding_id !== null)) {
    fail("replacement_invalid", "revocation.replacement_binding_id", "replacement ID is required only for replacement");
  }
  bindingLifecycles.set(binding, { state: "revoked", replacement_binding_id: revocation.replacement_binding_id });
  return revocation;
}

export function replaceExecutionBinding(
  currentInput: unknown,
  replacementInput: unknown,
  revokedAt: string,
): TrustedExecutionBinding {
  const current = requireActiveExecutionBinding(currentInput);
  const replacement = requireActiveExecutionBinding(replacementInput);
  if (current.binding_id === replacement.binding_id) fail("replacement_invalid", "replacement.binding_id", "replacement must have a new binding ID");
  revokeExecutionBinding(current, {
    binding_id: current.binding_id,
    reason: "replaced",
    revoked_at: revokedAt,
    replacement_binding_id: replacement.binding_id,
  });
  return replacement;
}

export function parseRequest(input: unknown): ExecutionRequest {
  try {
    return parseExecutionRequest(input);
  } catch {
    fail("request_invalid", "request", "request does not satisfy ExecutionRequest");
  }
}

export function assertValidDate(value: Date, path: string): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid_time", path, "time must be a valid Date");
  return value.getTime();
}

export function assertDispatchMode(value: unknown): DispatchMode {
  const parsed = dispatchModeSchema.safeParse(value);
  if (!parsed.success) {
    fail("dispatch_mode_invalid", "dispatchMode", "dispatch mode must be explicitly synthetic or live");
  }
  return parsed.data;
}

export function assertRequestIdentity(request: ExecutionRequest, binding: TrustedExecutionBinding): void {
  if (request.profile_hash !== binding.profile_hash) fail("profile_hash_mismatch", "request.profile_hash");
  if (request.provider_binding.provider_id !== binding.provider_id) fail("provider_mismatch", "provider_binding.provider_id");
  if (request.provider_binding.account_ref !== binding.account_ref) fail("account_mismatch", "provider_binding.account_ref");
  if (request.provider_binding.auth_epoch !== binding.profile.auth_epoch) fail("auth_epoch_mismatch", "provider_binding.auth_epoch");
}

export function assertRequestScopeAndLimits(request: ExecutionRequest, binding: TrustedExecutionBinding): void {
  for (const [index, sourceSpan] of request.source_spans.entries()) {
    if (!binding.profile.allowed_scope_ids.includes(sourceSpan.scope_id)) {
      fail("scope_not_allowed", `source_spans.${index}.scope_id`);
    }
  }
  if (request.source_spans.length > binding.limits.max_source_spans) {
    fail("source_span_limit", "source_spans");
  }
  if (
    request.output_limit.max_bytes > binding.limits.max_output_bytes ||
    request.output_limit.max_tokens > binding.limits.max_output_tokens
  ) {
    fail("output_limit_exceeded", "output_limit");
  }
}

export function validateDispatch(
  input: unknown,
  bindingInput: unknown,
  now: Date,
  dispatchMode: DispatchMode,
): ExecutionRequest {
  const request = parseRequest(input);
  const binding = requireActiveExecutionBinding(bindingInput);
  const mode = assertDispatchMode(dispatchMode);
  const nowMs = assertValidDate(now, "now");
  const profile = binding.profile;

  if (profile.status !== "ready") fail("profile_not_dispatchable", "profile.status");
  if (binding.qualification.state !== "qualified") fail("profile_unqualified", "qualification.state");
  if (mode === "live") {
    if (binding.qualification.kind !== "native" || binding.qualification.fixture_origin !== "g5_verified") {
      fail("live_qualification_required", "qualification", "live dispatch requires a native G5 qualification");
    }
    if (binding.qualification.gates.some((gate) => gate.result !== "pass")) {
      fail("qualification_gate_mismatch", "qualification.gates", "live dispatch requires every C1-C8 gate to pass");
    }
  }
  if (profile.account_ref !== binding.account_ref) fail("account_mismatch", "profile.account_ref");
  if (!profile.egress.provider_targets.includes(`provider:${binding.provider_id}`)) {
    fail("provider_egress_missing", "profile.egress.provider_targets");
  }
  assertRequestIdentity(request, binding);

  assertRequestScopeAndLimits(request, binding);

  const deadlineMs = Date.parse(request.deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= nowMs) fail("deadline_expired", "deadline");
  if (deadlineMs > nowMs + binding.limits.max_duration_seconds * 1000) {
    fail("deadline_limit_exceeded", "deadline");
  }
  return request;
}
