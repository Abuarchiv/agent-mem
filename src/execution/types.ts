import { z } from "zod";

import {
  egressSchema,
  nonNegativeInt64Schema,
  parseContract,
  sourceRoleSchema,
} from "../host/contract.js";

const uuidSchema = z.uuid();
const opaqueIdSchema = z.string().min(1).max(256);
const dateTimeSchema = z.iso.datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const boundedTextSchema = z.string().max(100_000);
const nonEmptyTextSchema = z.string().min(1).max(100_000);
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// Native counters and amounts remain exact strings; no credit-to-dollar conversion occurs here.
const canonicalIntegerStringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .refine((value) => value.length <= 38, {
    message: "integer string exceeds the supported precision",
  });
const canonicalAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .refine((value) => value.length <= 64, {
    message: "amount exceeds the supported precision",
  });
const jsonObjectSchema = z.record(z.string().min(1).max(256), z.json());

export const executionProfileIdSchema = z.enum([
  "XP-Copilot",
  "XP-Codex",
  "XP-Claude",
  "XP-API",
  "XP-Local",
]);

export const profileStatusSchema = z.enum([
  "unconfigured",
  "auth_required",
  "version_unverified",
  "ready",
  "offline",
  "quota_paused",
  "budget_paused",
  "policy_blocked",
  "isolation_failed",
  "cleanup_pending",
]);

export const executionPhaseSchema = z.enum([
  "extract",
  "verify",
  "summarize",
  "consolidate",
]);

export const executionProfileSchema = z
  .object({
    version: z.literal(1),
    profile_id: executionProfileIdSchema,
    status: profileStatusSchema,
    runtime_id: opaqueIdSchema,
    model_id: opaqueIdSchema,
    reasoning: opaqueIdSchema.optional(),
    account_ref: opaqueIdSchema.optional(),
    auth_epoch: nonNegativeInt64Schema,
    allowed_scope_ids: z.array(uuidSchema).max(128),
    egress: egressSchema,
  })
  .strict();

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export function parseExecutionProfile(input: unknown): ExecutionProfile {
  return parseContract(executionProfileSchema, input, "execution-profile");
}

const executionSourceSpanSchema = z
  .object({
    source_span_id: uuidSchema,
    capture_id: uuidSchema,
    scope_id: uuidSchema,
    role: sourceRoleSchema,
    captured_at: dateTimeSchema.optional(),
    occurred_at: dateTimeSchema.optional(),
    text: nonEmptyTextSchema,
  })
  .strict();

const providerBindingSchema = z
  .object({
    provider_id: opaqueIdSchema,
    account_ref: opaqueIdSchema,
    auth_epoch: nonNegativeInt64Schema,
  })
  .strict();

const outputLimitSchema = z
  .object({
    max_bytes: positiveIntegerSchema,
    max_tokens: positiveIntegerSchema,
  })
  .strict();

export const executionRequestSchema = z
  .object({
    version: z.literal(1),
    phase: executionPhaseSchema,
    job_id: uuidSchema,
    attempt_id: uuidSchema,
    source_spans: z.array(executionSourceSpanSchema).min(1).max(256),
    /** Phase-specific immutable input, such as verifier candidates and targets. */
    phase_input: z.record(z.string().min(1).max(128), z.json()).optional(),
    schema_hash: sha256Schema,
    prompt_hash: sha256Schema,
    profile_hash: sha256Schema,
    provider_binding: providerBindingSchema,
    output_limit: outputLimitSchema,
    deadline: dateTimeSchema,
  })
  .strict();

export type ExecutionRequest = z.infer<typeof executionRequestSchema>;

export function parseExecutionRequest(input: unknown): ExecutionRequest {
  return parseContract(executionRequestSchema, input, "execution-request");
}

const modelMetadataSchema = z
  .object({
    provider_id: opaqueIdSchema,
    model_id: opaqueIdSchema,
    requested_model_id: opaqueIdSchema.optional(),
    runtime_session_id: opaqueIdSchema.optional(),
    reasoning: opaqueIdSchema.optional(),
  })
  .strict();

export const copilotUsageSchema = z
  .object({
    totalNanoAiu: canonicalIntegerStringSchema.optional(),
    credits: canonicalAmountSchema.optional(),
  })
  .strict()
  .refine((usage) => usage.totalNanoAiu !== undefined || usage.credits !== undefined, {
    message: "copilot usage must include an observed native unit",
  });

const usageFields = {
  input_tokens: nonNegativeIntegerSchema.optional(),
  output_tokens: nonNegativeIntegerSchema.optional(),
  reasoning_tokens: nonNegativeIntegerSchema.optional(),
  total_tokens: nonNegativeIntegerSchema.optional(),
  finish_reason: opaqueIdSchema.optional(),
  copilot_usage: copilotUsageSchema.optional(),
};

type UsageField =
  | "input_tokens"
  | "output_tokens"
  | "reasoning_tokens"
  | "total_tokens"
  | "finish_reason"
  | "copilot_usage";

type UsageMeasurements = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  reasoning_tokens?: number | undefined;
  total_tokens?: number | undefined;
  finish_reason?: string | undefined;
  copilot_usage?: z.infer<typeof copilotUsageSchema> | undefined;
};

function hasQuantifiedUsage(value: UsageMeasurements): boolean {
  return (
    value.input_tokens !== undefined ||
    value.output_tokens !== undefined ||
    value.reasoning_tokens !== undefined ||
    value.total_tokens !== undefined ||
    value.copilot_usage !== undefined
  );
}

function addTokenConsistencyIssue(value: UsageMeasurements, context: z.RefinementCtx): void {
  if (
    value.input_tokens !== undefined &&
    value.output_tokens !== undefined &&
    value.total_tokens !== undefined &&
    value.input_tokens > value.total_tokens - value.output_tokens
  ) {
    context.addIssue({
      code: "custom",
      path: ["total_tokens"],
      message: "total_tokens_less_than_input_plus_output",
    });
  }
}

function validateObservedUsage(value: UsageMeasurements, context: z.RefinementCtx): void {
  if (!hasQuantifiedUsage(value)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "usage_requires_quantified_counter",
    });
  }
  addTokenConsistencyIssue(value, context);
}

function isUsageFieldReported(value: UsageMeasurements, field: UsageField): boolean {
  switch (field) {
    case "input_tokens":
      return value.input_tokens !== undefined;
    case "output_tokens":
      return value.output_tokens !== undefined;
    case "reasoning_tokens":
      return value.reasoning_tokens !== undefined;
    case "total_tokens":
      return value.total_tokens !== undefined;
    case "finish_reason":
      return value.finish_reason !== undefined;
    case "copilot_usage":
      return value.copilot_usage !== undefined;
  }
}

function validatePartialUsage(
  value: UsageMeasurements & { missing: readonly UsageField[] },
  context: z.RefinementCtx,
): void {
  validateObservedUsage(value, context);
  const uniqueFields = new Set(value.missing);
  if (uniqueFields.size !== value.missing.length) {
    context.addIssue({
      code: "custom",
      path: ["missing"],
      message: "missing_usage_fields_must_be_unique",
    });
  }
  for (const [index, field] of value.missing.entries()) {
    if (isUsageFieldReported(value, field)) {
      context.addIssue({
        code: "custom",
        path: ["missing", index],
        message: "missing_usage_field_is_present",
      });
    }
  }
}

// observed records values present in this event; partial names omitted counters.
// An absent counter stays unknown and is never filled with zero.
export const executionUsageSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...usageFields,
      status: z.literal("observed"),
    })
    .strict()
    .superRefine(validateObservedUsage),
  z
    .object({
      ...usageFields,
      status: z.literal("partial"),
      missing: z
        .array(
          z.enum([
            "input_tokens",
            "output_tokens",
            "reasoning_tokens",
            "total_tokens",
            "finish_reason",
            "copilot_usage",
          ]),
        )
        .min(1)
        .max(6),
    })
    .strict()
    .superRefine(validatePartialUsage),
  z
    .object({
      status: z.literal("unknown"),
      reason: boundedTextSchema.min(1),
    })
    .strict(),
]);

export const nativeBillingUnitSchema = z.discriminatedUnion("unit", [
  z
    .object({
      unit: z.literal("copilot_credit"),
      value: canonicalAmountSchema,
    })
    .strict(),
  z
    .object({
      unit: z.literal("nano_aiu"),
      value: canonicalIntegerStringSchema,
    })
    .strict(),
  z
    .object({
      unit: z.literal("provider_request"),
      value: canonicalIntegerStringSchema,
    })
    .strict(),
]);

const observedBillingSchema = z
  .object({
    status: z.literal("observed"),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    amount: canonicalAmountSchema.optional(),
    native_units: z.array(nativeBillingUnitSchema).max(8).optional(),
  })
  .strict()
  .superRefine((billing, context) => {
    const hasCurrency = billing.currency !== undefined;
    const hasAmount = billing.amount !== undefined;
    if (hasCurrency !== hasAmount) {
      context.addIssue({
        code: "custom",
        path: [hasCurrency ? "amount" : "currency"],
        message: "currency and amount must be supplied together",
      });
    }
    if (!hasCurrency && !hasAmount && (billing.native_units === undefined || billing.native_units.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["native_units"],
        message: "observed billing must include native units or monetary amount",
      });
    }
  });

export const executionBillingSchema = z.discriminatedUnion("status", [
  observedBillingSchema,
  z
    .object({
      status: z.literal("unknown"),
      reason: boundedTextSchema.min(1),
    })
    .strict(),
]);

const attemptSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("observed"),
      provider_attempt_id: opaqueIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      reason: boundedTextSchema.min(1),
    })
    .strict(),
]);

const resultCommon = {
  version: z.literal(1),
  phase: executionPhaseSchema,
  job_id: uuidSchema,
  attempt_id: uuidSchema,
  model: modelMetadataSchema,
  usage: executionUsageSchema,
  billing: executionBillingSchema,
  attempt: attemptSchema,
};

export const executionResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...resultCommon,
      status: z.literal("completed"),
      structured_output: jsonObjectSchema,
    })
    .strict(),
  z
    .object({
      ...resultCommon,
      status: z.literal("refused"),
      refusal_reason: boundedTextSchema.min(1),
    })
    .strict(),
  z
    .object({
      ...resultCommon,
      status: z.literal("invalid_output"),
      failure_reason: boundedTextSchema.min(1),
    })
    .strict(),
  z
    .object({
      ...resultCommon,
      status: z.literal("timeout"),
      failure_reason: boundedTextSchema.min(1),
    })
    .strict(),
  z
    .object({
      ...resultCommon,
      status: z.literal("aborted"),
      failure_reason: boundedTextSchema.min(1),
    })
    .strict(),
  z
    .object({
      ...resultCommon,
      status: z.literal("failed"),
      failure_reason: boundedTextSchema.min(1),
    })
    .strict(),
]);

export type ExecutionResult = z.infer<typeof executionResultSchema>;

export function parseExecutionResult(input: unknown): ExecutionResult {
  return parseContract(executionResultSchema, input, "execution-result");
}
