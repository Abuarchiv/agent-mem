import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { nonNegativeInt64Schema, parseContract } from "../host/contract.js";
import {
  EXECUTION_BATCH_LIMITS,
  executionBudgetPolicySchema,
  executionPhaseSchema,
  parseExecutionBudgetPolicy,
  periodKeys,
  reservationPlans,
  usageLimitsForPeriod,
  creditUsageSchema,
  usageLimitsSchema,
  type ExecutionBudgetPolicy,
  type ExecutionPhase,
  type ExecutionUsageLimits,
} from "../execution/budget.js";
import type { JobClaim } from "./job-repository.js";
import { StoreError } from "./errors.js";

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const dateTimeSchema = z.iso.datetime({ offset: true });
const opaqueIdSchema = z.string().min(1).max(256);
const ownerSchema = z.string().min(1).max(256);
const phaseStatusSchema = z.enum(["prepared", "active", "terminal_observed", "reconciled", "paused", "failed"]);
const attemptStateSchema = z.enum([
  "prepared",
  "dispatch_intent",
  "session_observed",
  "prompt_dispatched",
  "terminal_observed",
  "cleanup_pending",
  "reconciled",
  "failed",
  "aborted",
]);
const terminalStatusSchema = z.enum(["completed", "refused", "invalid_output", "timeout", "aborted", "failed"]);
const usageStatusSchema = z.enum(["unknown", "partial", "observed"]);
const usageDimensionSchema = z.enum(["input_tokens", "output_tokens", "provider_requests", "credits"]);
type UsageDimension = z.infer<typeof usageDimensionSchema>;
const cleanupStateSchema = z.enum(["not_started", "pending", "confirmed", "unknown"]);
const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recoveryTaskVersionPattern = /^extract-v1:recovery:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):part:([0-9]{1,3})$/u;
const MAX_AUTH_RECOVERY_LINEAGE = 8;

function extractionTaskPart(taskVersion: string): string | undefined {
  if (taskVersion === "extract-v1") return "0";
  return /:part:([0-9]{1,3})$/u.exec(taskVersion)?.[1];
}

const bindingSnapshotSchema = z
  .object({
    binding_id: uuidSchema,
    profile_hash: digestSchema,
    profile_id: opaqueIdSchema,
    runtime_id: opaqueIdSchema,
    model_id: opaqueIdSchema,
    reasoning: opaqueIdSchema.nullable(),
    provider_id: opaqueIdSchema,
    provider_target: z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/),
    account_ref: opaqueIdSchema,
    auth_epoch: nonNegativeInt64Schema,
    auth_generation: uuidSchema.nullable(),
    auth_entry_id: uuidSchema.nullable(),
    allowed_scope_ids: z.array(uuidSchema).max(128),
  })
  .strict();

export type AttemptBindingSnapshot = z.infer<typeof bindingSnapshotSchema>;

/** Current auth identity bound to a reservation: generation plus the actual credential entry. */
export interface CurrentAuth {
  readonly generation: string | null;
  readonly entryId: string | null;
}

const usageInputSchema = z
  .object({
    status: usageStatusSchema,
    input_tokens: nonNegativeIntegerSchema.optional(),
    output_tokens: nonNegativeIntegerSchema.optional(),
    provider_requests: nonNegativeIntegerSchema.optional(),
    credits: creditUsageSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "unknown" && (value.input_tokens !== undefined || value.output_tokens !== undefined || value.provider_requests !== undefined || value.credits !== undefined)) {
      context.addIssue({ code: "custom", path: ["status"], message: "unknown_usage_has_values" });
    }
    if (value.status !== "unknown" && value.input_tokens === undefined && value.output_tokens === undefined && value.provider_requests === undefined && value.credits === undefined) {
      context.addIssue({ code: "custom", path: ["status"], message: "known_usage_requires_value" });
    }
  });

export type AttemptUsageInput = z.infer<typeof usageInputSchema>;

export interface ExecutionBatchRecord {
  readonly version: 1;
  readonly batch_id: string;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_version: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly request_digest: string;
  readonly binding_id: string;
  readonly profile_hash: string;
  readonly profile_id: string;
  readonly runtime_id: string;
  readonly model_id: string;
  readonly reasoning: string | null;
  readonly provider_id: string;
  readonly provider_target: string;
  readonly account_ref: string;
  readonly auth_epoch: string;
  readonly auth_generation: string | null;
  readonly auth_entry_id: string | null;
  readonly job_owner: string;
  readonly job_fence: string;
  readonly job_lease_until: string;
  readonly state: z.infer<typeof phaseStatusSchema>;
  readonly extract_starts: number;
  readonly verify_starts: number;
  readonly total_starts: number;
  readonly active_ms: number;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BudgetReservationRecord {
  readonly version: 1;
  readonly reservation_id: string;
  readonly batch_id: string;
  readonly phase: ExecutionPhase;
  readonly period_day: string;
  readonly period_month: string;
  readonly budget_key: string;
  readonly daily_start_limit: number;
  readonly monthly_start_limit: number;
  readonly daily_active_ms_limit: number | null;
  readonly monthly_active_ms_limit: number | null;
  readonly daily_usage_limits: ExecutionUsageLimits;
  readonly monthly_usage_limits: ExecutionUsageLimits;
  readonly usage_reservation_per_phase: ExecutionUsageLimits;
  readonly reserved_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly reserved_provider_requests: number;
  readonly reserved_credits: number;
  readonly consumed_input_tokens: number;
  readonly consumed_output_tokens: number;
  readonly consumed_provider_requests: number;
  readonly consumed_credits: number;
  readonly reserved_starts: number;
  readonly consumed_starts: number;
  readonly reserved_active_ms: number;
  readonly consumed_active_ms: number;
  readonly state: "active" | "released" | "uncertain";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ExecutionAttemptRecord {
  readonly version: 1;
  readonly attempt_id: string;
  readonly batch_id: string;
  readonly job_id: string;
  readonly phase: ExecutionPhase;
  readonly ordinal: number;
  readonly request_digest: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly binding_id: string;
  readonly profile_hash: string;
  readonly profile_id: string;
  readonly runtime_id: string;
  readonly model_id: string;
  readonly reasoning: string | null;
  readonly provider_id: string;
  readonly account_ref: string;
  readonly auth_epoch: string;
  readonly auth_generation: string | null;
  readonly auth_entry_id: string | null;
  readonly owner: string;
  readonly job_fence: string;
  readonly lease_until: string;
  readonly reservation_id: string;
  readonly accounting_period_day: string | null;
  readonly accounting_period_month: string | null;
  readonly deadline_at: string;
  readonly state: z.infer<typeof attemptStateSchema>;
  readonly runtime_session_id: string | null;
  readonly provider_attempt_id: string | null;
  readonly terminal_status: z.infer<typeof terminalStatusSchema> | null;
  readonly result_digest: string | null;
  readonly result_receipt_json: string | null;
  readonly usage_status: z.infer<typeof usageStatusSchema>;
  readonly usage_json: string | null;
  readonly usage_complete: readonly UsageDimension[];
  readonly cleanup_state: z.infer<typeof cleanupStateSchema>;
  readonly cleanup_reason: string | null;
  readonly budget_violation: readonly string[];
  readonly started_at: string | null;
  readonly terminal_at: string | null;
  readonly cleanup_at: string | null;
  readonly active_ms: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BeginExecutionBatchInput {
  readonly batch_id?: string;
  readonly claim: JobClaim;
  readonly request_digest: string;
  readonly binding: AttemptBindingSnapshot;
  readonly budget: ExecutionBudgetPolicy;
}

export interface PrepareExecutionAttemptInput {
  readonly batch_id: string;
  readonly attempt_id: string;
  readonly phase: ExecutionPhase;
  readonly request_digest: string;
  readonly deadline: string;
  readonly claim: JobClaim;
  readonly binding: AttemptBindingSnapshot;
}

export interface AttemptControlInput {
  readonly attempt: ExecutionAttemptRecord;
  readonly claim: JobClaim;
  readonly binding: AttemptBindingSnapshot;
}

export interface TerminalCheckpointInput {
  readonly status: z.infer<typeof terminalStatusSchema>;
  readonly provider_attempt_id?: string;
  readonly usage?: AttemptUsageInput;
}

export interface CleanupCheckpointInput {
  readonly confirmed: boolean;
  readonly reason?: string;
}

export interface AttemptCompletionInput {
  readonly status: z.infer<typeof terminalStatusSchema>;
  readonly result_digest: string;
  readonly received_at: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly requested_model_id?: string;
  readonly reasoning: string | null;
  readonly runtime_session_id: string | null;
  readonly provider_attempt_id?: string;
  readonly usage?: AttemptUsageInput;
}

export interface ReleasePhaseReservationInput {
  readonly batch_id: string;
  readonly phase: ExecutionPhase;
  readonly claim: JobClaim;
  readonly binding: AttemptBindingSnapshot;
}

export interface AttemptReceipt {
  readonly version: 1;
  readonly attempt_id: string;
  readonly batch_id: string;
  readonly job_id: string;
  readonly phase: ExecutionPhase;
  readonly ordinal: number;
  readonly status: z.infer<typeof terminalStatusSchema>;
  readonly result_digest: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly requested_model_id?: string;
  readonly reasoning: string | null;
  readonly runtime_session_id: string | null;
  readonly provider_attempt_id: string | null;
  readonly usage_status: z.infer<typeof usageStatusSchema>;
  readonly received_at: string;
  readonly cleanup: "confirmed";
}

export type AttemptCompletionResult =
  | { readonly status: "completed"; readonly replayed: false; readonly receipt: AttemptReceipt; readonly attempt: ExecutionAttemptRecord }
  | { readonly status: "completed"; readonly replayed: true; readonly receipt: AttemptReceipt; readonly attempt: ExecutionAttemptRecord };

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) throw new StoreError("read_failed", new Error(`missing ${field}`));
  return (row as Record<string, unknown>)[field];
}

function sqlText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new StoreError("read_failed", new Error(`invalid ${field}`));
  return value;
}

function nullableText(row: unknown, field: string): string | null {
  const value = rowValue(row, field);
  return value === null ? null : sqlText(value, field);
}

function sqlInteger(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new StoreError("read_failed", new Error(`unsafe ${field}`));
}

function safeNumber(value: unknown, field: string): number {
  const parsed = sqlInteger(value, field);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreError("attempt_invalid");
  return Number(parsed);
}

function parseDate(value: unknown, field: string): string {
  const parsed = parseContract(dateTimeSchema, value, field);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) throw new StoreError("attempt_invalid");
  return new Date(milliseconds).toISOString();
}

function nullableDate(row: unknown, field: string): string | null {
  const value = nullableText(row, field);
  return value === null ? null : parseDate(value, field);
}

function parseDigest(value: unknown, field: string): string {
  return parseContract(digestSchema, value, field).toLowerCase();
}

function parseUuid(value: unknown, field: string): string {
  return parseContract(uuidSchema, value, field);
}

function nullableUuid(row: unknown, field: string): string | null {
  const value = nullableText(row, field);
  return value === null ? null : parseUuid(value, field);
}

function parseOwner(value: unknown, field: string): string {
  return parseContract(ownerSchema, value, field);
}

function canonicalBudgetKey(binding: AttemptBindingSnapshot, budgetTag: string): string {
  // The allowance follows the configured provider/account route. Auth
  // generation is intentionally absent: rotation invalidates attempts, but
  // it does not create a fresh local budget.
  return JSON.stringify({
    version: 1,
    budget_tag: budgetTag,
    provider_id: binding.provider_id,
    provider_target: binding.provider_target,
    account_ref: binding.account_ref,
  });
}

interface ParsedBudgetKey {
  readonly raw: string;
  readonly budget_tag: string;
  readonly provider_id: string;
  readonly provider_target: string;
  readonly account_ref: string;
}

interface BudgetTotals {
  readonly starts: bigint;
  readonly active_ms: bigint;
  readonly input_tokens: bigint;
  readonly output_tokens: bigint;
  readonly provider_requests: bigint;
  readonly credits: bigint;
}

interface BudgetAdditional {
  readonly starts: bigint;
  readonly active_ms: bigint;
  readonly input_tokens: bigint;
  readonly output_tokens: bigint;
  readonly provider_requests: bigint;
  readonly credits: bigint;
}

interface LineageUsage {
  readonly extract_starts: number;
  readonly verify_starts: number;
  readonly total_starts: number;
  readonly extract_active_ms: number;
  readonly verify_active_ms: number;
  readonly active_ms: number;
}

function parseBudgetKey(value: unknown): ParsedBudgetKey {
  const raw = sqlText(value, "reservation-budget-key");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  let shape: Omit<ParsedBudgetKey, "raw">;
  try {
    shape = z
      .object({
        version: z.literal(1),
        budget_tag: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
        provider_id: opaqueIdSchema,
        provider_target: z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/),
        account_ref: opaqueIdSchema,
      })
      .strict()
      .parse(parsed);
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  if (JSON.stringify(shape) !== raw) throw new StoreError("attempt_invalid");
  return { raw, ...shape };
}

function canonicalUsageLimits(value: ExecutionUsageLimits): string {
  const canonical: {
    input_tokens?: number;
    output_tokens?: number;
    provider_requests?: number;
    credits?: { amount: number; unit: string; scale: number };
  } = {};
  if (value.input_tokens !== undefined) canonical.input_tokens = value.input_tokens;
  if (value.output_tokens !== undefined) canonical.output_tokens = value.output_tokens;
  if (value.provider_requests !== undefined) canonical.provider_requests = value.provider_requests;
  if (value.credits !== undefined) canonical.credits = { ...value.credits };
  return JSON.stringify(canonical);
}

function parseUsageLimits(value: unknown): ExecutionUsageLimits {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sqlText(value, "usage-limits-json")) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  try {
    return usageLimitsSchema.parse(parsed);
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
}

function parseUsageInput(value: unknown): AttemptUsageInput {
  try {
    return usageInputSchema.parse(value);
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
}

function usageJson(usage: AttemptUsageInput): string | null {
  return usage.status === "unknown"
    ? null
    : JSON.stringify({
        status: usage.status,
        ...(usage.input_tokens === undefined ? {} : { input_tokens: usage.input_tokens }),
        ...(usage.output_tokens === undefined ? {} : { output_tokens: usage.output_tokens }),
        ...(usage.provider_requests === undefined ? {} : { provider_requests: usage.provider_requests }),
        ...(usage.credits === undefined ? {} : { credits: { ...usage.credits } }),
      });
}

function usageCompleteJson(dimensions: readonly UsageDimension[]): string {
  return JSON.stringify([...new Set(dimensions)].sort());
}

function parseUsageComplete(row: unknown): readonly UsageDimension[] {
  const raw = sqlText(rowValue(row, "usage_complete_json"), "attempt-usage-complete-json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  try {
    const result = z.array(usageDimensionSchema).max(4).parse(parsed);
    if (new Set(result).size !== result.length) throw new Error("duplicate_usage_dimension");
    return Object.freeze([...result]);
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
}

function usageDimensions(usage: AttemptUsageInput): readonly UsageDimension[] {
  if (usage.status !== "observed") return [];
  return [
    ...(usage.input_tokens === undefined ? [] : ["input_tokens" as const]),
    ...(usage.output_tokens === undefined ? [] : ["output_tokens" as const]),
    ...(usage.provider_requests === undefined ? [] : ["provider_requests" as const]),
    ...(usage.credits === undefined ? [] : ["credits" as const]),
  ];
}

function parseStoredUsage(row: unknown): AttemptUsageInput {
  const status = parseContract(usageStatusSchema, rowValue(row, "usage_status"), "attempt-usage-status");
  const raw = nullableText(row, "usage_json");
  if (raw === null) {
    if (status !== "unknown") throw new StoreError("attempt_invalid");
    return { status: "unknown" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  return parseUsageInput({ ...(value as Record<string, unknown>), status });
}

function parseBudgetViolation(value: unknown): readonly string[] {
  const raw = nullableText({ budget_violation: value }, "budget_violation");
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)) {
    throw new StoreError("attempt_invalid");
  }
  return Object.freeze([...new Set(parsed)]);
}

function isBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function addMilliseconds(now: string, milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 86_400_000) throw new StoreError("attempt_invalid");
  const next = Date.parse(now) + milliseconds;
  if (!Number.isSafeInteger(next)) throw new StoreError("attempt_invalid");
  return new Date(next).toISOString();
}

function parseClaim(value: JobClaim): JobClaim {
  try {
    return {
      version: 1,
      job_id: parseUuid(value.job_id, "attempt-claim-job"),
      scope_id: parseUuid(value.scope_id, "attempt-claim-scope"),
      source_capture_id: parseUuid(value.source_capture_id, "attempt-claim-source"),
      task_kind: "extract",
      task_version: z.string().min(1).max(128).parse(value.task_version),
      owner: parseOwner(value.owner, "attempt-claim-owner"),
      lease_until: parseDate(value.lease_until, "attempt-claim-lease"),
      fence: parseContract(nonNegativeInt64Schema, value.fence, "attempt-claim-fence"),
      attempts: z.number().int().min(1).max(5).parse(value.attempts),
      input_fingerprint: parseDigest(value.input_fingerprint, "attempt-claim-fingerprint"),
      input_privacy_epoch: parseContract(nonNegativeInt64Schema, value.input_privacy_epoch, "attempt-claim-privacy"),
    };
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("attempt_invalid", error);
  }
}

function parseBinding(value: AttemptBindingSnapshot): AttemptBindingSnapshot {
  try {
    return bindingSnapshotSchema.parse(value);
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
}

function parseBatchState(value: unknown): ExecutionBatchRecord["state"] {
  return parseContract(phaseStatusSchema, value, "execution-batch-state");
}

function parseAttemptState(value: unknown): ExecutionAttemptRecord["state"] {
  return parseContract(attemptStateSchema, value, "execution-attempt-state");
}

function parsePhase(value: unknown): ExecutionPhase {
  return parseContract(executionPhaseSchema, value, "execution-phase");
}

function parseTerminal(value: unknown): Exclude<ExecutionAttemptRecord["terminal_status"], null> {
  return parseContract(terminalStatusSchema, value, "attempt-terminal-status");
}

function parseUsageStatus(value: unknown): ExecutionAttemptRecord["usage_status"] {
  return parseContract(usageStatusSchema, value, "attempt-usage-status");
}

function parseCleanup(value: unknown): ExecutionAttemptRecord["cleanup_state"] {
  return parseContract(cleanupStateSchema, value, "attempt-cleanup-state");
}

function parseBatchRow(row: unknown): ExecutionBatchRecord {
  return {
    version: 1,
    batch_id: parseUuid(rowValue(row, "batch_id"), "batch-id"),
    job_id: parseUuid(rowValue(row, "job_id"), "batch-job-id"),
    scope_id: parseUuid(rowValue(row, "scope_id"), "batch-scope-id"),
    source_capture_id: parseUuid(rowValue(row, "source_capture_id"), "batch-source-id"),
    task_version: z.string().min(1).max(128).parse(rowValue(row, "task_version")),
    input_fingerprint: parseDigest(rowValue(row, "input_fingerprint"), "batch-input-fingerprint"),
    input_privacy_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "input_privacy_epoch"), "batch-privacy"), "batch-privacy"),
    request_digest: parseDigest(rowValue(row, "request_digest"), "batch-request-digest"),
    binding_id: parseUuid(rowValue(row, "binding_id"), "batch-binding-id"),
    profile_hash: parseDigest(rowValue(row, "profile_hash"), "batch-profile-hash"),
    profile_id: opaqueIdSchema.parse(rowValue(row, "profile_id")),
    runtime_id: opaqueIdSchema.parse(rowValue(row, "runtime_id")),
    model_id: opaqueIdSchema.parse(rowValue(row, "model_id")),
    reasoning: nullableText(row, "reasoning"),
    provider_id: opaqueIdSchema.parse(rowValue(row, "provider_id")),
    provider_target: z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/).parse(rowValue(row, "provider_target")),
    account_ref: opaqueIdSchema.parse(rowValue(row, "account_ref")),
    auth_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "auth_epoch"), "batch-auth-epoch"), "batch-auth-epoch"),
    auth_generation: nullableUuid(row, "auth_generation"),
    auth_entry_id: nullableUuid(row, "auth_entry_id"),
    job_owner: parseOwner(rowValue(row, "job_owner"), "batch-owner"),
    job_fence: parseContract(nonNegativeInt64Schema, sqlInteger(rowValue(row, "job_fence"), "batch-fence").toString(10), "batch-fence"),
    job_lease_until: parseDate(rowValue(row, "job_lease_until"), "batch-lease"),
    state: parseBatchState(rowValue(row, "state")),
    extract_starts: safeNumber(rowValue(row, "extract_starts"), "batch-extract-starts"),
    verify_starts: safeNumber(rowValue(row, "verify_starts"), "batch-verify-starts"),
    total_starts: safeNumber(rowValue(row, "total_starts"), "batch-total-starts"),
    active_ms: safeNumber(rowValue(row, "active_ms"), "batch-active-ms"),
    failure_reason: nullableText(row, "failure_reason"),
    created_at: parseDate(rowValue(row, "created_at"), "batch-created-at"),
    updated_at: parseDate(rowValue(row, "updated_at"), "batch-updated-at"),
  };
}

function parseReservationRow(row: unknown): BudgetReservationRecord {
  const budgetKey = parseBudgetKey(rowValue(row, "budget_key"));
  const dailyUsage = parseUsageLimits(rowValue(row, "daily_usage_limits_json"));
  const monthlyUsage = parseUsageLimits(rowValue(row, "monthly_usage_limits_json"));
  const reservation = parseUsageLimits(rowValue(row, "usage_reservation_json"));
  const rowPolicy = {
    version: 1 as const,
    budget_tag: budgetKey.budget_tag,
    provider_target: budgetKey.provider_target,
    daily_start_limit: safeNumber(rowValue(row, "daily_start_limit"), "daily-start-limit"),
    monthly_start_limit: safeNumber(rowValue(row, "monthly_start_limit"), "monthly-start-limit"),
    ...(rowValue(row, "daily_active_ms_limit") === null ? {} : { daily_active_ms_limit: safeNumber(rowValue(row, "daily_active_ms_limit"), "daily-active-limit") }),
    ...(rowValue(row, "monthly_active_ms_limit") === null ? {} : { monthly_active_ms_limit: safeNumber(rowValue(row, "monthly_active_ms_limit"), "monthly-active-limit") }),
    daily_usage_limits: dailyUsage,
    monthly_usage_limits: monthlyUsage,
    usage_reservation_per_phase: reservation,
  } satisfies ExecutionBudgetPolicy;
  let policy: ExecutionBudgetPolicy;
  try {
    policy = executionBudgetPolicySchema.parse(rowPolicy) as ExecutionBudgetPolicy;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  return {
    version: 1,
    reservation_id: parseUuid(rowValue(row, "reservation_id"), "reservation-id"),
    batch_id: parseUuid(rowValue(row, "batch_id"), "reservation-batch-id"),
    phase: parsePhase(rowValue(row, "phase")),
    period_day: sqlText(rowValue(row, "period_day"), "reservation-day"),
    period_month: sqlText(rowValue(row, "period_month"), "reservation-month"),
    budget_key: budgetKey.raw,
    daily_start_limit: policy.daily_start_limit,
    monthly_start_limit: policy.monthly_start_limit,
    daily_active_ms_limit: policy.daily_active_ms_limit ?? null,
    monthly_active_ms_limit: policy.monthly_active_ms_limit ?? null,
    daily_usage_limits: dailyUsage,
    monthly_usage_limits: monthlyUsage,
    usage_reservation_per_phase: reservation,
    reserved_input_tokens: safeNumber(rowValue(row, "reserved_input_tokens"), "reserved-input-tokens"),
    reserved_output_tokens: safeNumber(rowValue(row, "reserved_output_tokens"), "reserved-output-tokens"),
    reserved_provider_requests: safeNumber(rowValue(row, "reserved_provider_requests"), "reserved-provider-requests"),
    reserved_credits: safeNumber(rowValue(row, "reserved_credits"), "reserved-credits"),
    consumed_input_tokens: safeNumber(rowValue(row, "consumed_input_tokens"), "consumed-input-tokens"),
    consumed_output_tokens: safeNumber(rowValue(row, "consumed_output_tokens"), "consumed-output-tokens"),
    consumed_provider_requests: safeNumber(rowValue(row, "consumed_provider_requests"), "consumed-provider-requests"),
    consumed_credits: safeNumber(rowValue(row, "consumed_credits"), "consumed-credits"),
    reserved_starts: safeNumber(rowValue(row, "reserved_starts"), "reserved-starts"),
    consumed_starts: safeNumber(rowValue(row, "consumed_starts"), "consumed-starts"),
    reserved_active_ms: safeNumber(rowValue(row, "reserved_active_ms"), "reserved-active-ms"),
    consumed_active_ms: safeNumber(rowValue(row, "consumed_active_ms"), "consumed-active-ms"),
    state: parseContract(z.enum(["active", "released", "uncertain"]), rowValue(row, "state"), "reservation-state"),
    created_at: parseDate(rowValue(row, "created_at"), "reservation-created-at"),
    updated_at: parseDate(rowValue(row, "updated_at"), "reservation-updated-at"),
  };
}

function parseAttemptRow(row: unknown): ExecutionAttemptRecord {
  const receipt = nullableText(row, "result_receipt_json");
  const resultDigest = nullableText(row, "result_digest");
  if ((receipt === null) !== (resultDigest === null)) throw new StoreError("attempt_invalid");
  parseStoredUsage(row);
  const usageComplete = parseUsageComplete(row);
  if (receipt !== null) {
    const parsedReceipt = receiptFromRow(row);
    if (
      parsedReceipt.attempt_id !== parseUuid(rowValue(row, "attempt_id"), "attempt-id") ||
      parsedReceipt.batch_id !== parseUuid(rowValue(row, "batch_id"), "attempt-batch-id") ||
      parsedReceipt.job_id !== parseUuid(rowValue(row, "job_id"), "attempt-job-id") ||
      parsedReceipt.phase !== parsePhase(rowValue(row, "phase")) ||
      parsedReceipt.ordinal !== safeNumber(rowValue(row, "ordinal"), "attempt-ordinal") ||
      parsedReceipt.status !== (rowValue(row, "terminal_status") === null ? null : parseTerminal(rowValue(row, "terminal_status"))) ||
      parsedReceipt.result_digest !== parseDigest(resultDigest, "attempt-result-digest") ||
      parsedReceipt.provider_id !== opaqueIdSchema.parse(rowValue(row, "provider_id")) ||
      parsedReceipt.model_id !== opaqueIdSchema.parse(rowValue(row, "model_id")) ||
      parsedReceipt.reasoning !== nullableText(row, "reasoning") ||
      parsedReceipt.runtime_session_id !== nullableText(row, "runtime_session_id") ||
      parsedReceipt.provider_attempt_id !== nullableText(row, "provider_attempt_id") ||
      parsedReceipt.usage_status !== parseUsageStatus(rowValue(row, "usage_status"))
    ) throw new StoreError("attempt_invalid");
  }
  return {
    version: 1,
    attempt_id: parseUuid(rowValue(row, "attempt_id"), "attempt-id"),
    batch_id: parseUuid(rowValue(row, "batch_id"), "attempt-batch-id"),
    job_id: parseUuid(rowValue(row, "job_id"), "attempt-job-id"),
    phase: parsePhase(rowValue(row, "phase")),
    ordinal: safeNumber(rowValue(row, "ordinal"), "attempt-ordinal"),
    request_digest: parseDigest(rowValue(row, "request_digest"), "attempt-request-digest"),
    input_fingerprint: parseDigest(rowValue(row, "input_fingerprint"), "attempt-input-fingerprint"),
    input_privacy_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "input_privacy_epoch"), "attempt-privacy"), "attempt-privacy"),
    binding_id: parseUuid(rowValue(row, "binding_id"), "attempt-binding-id"),
    profile_hash: parseDigest(rowValue(row, "profile_hash"), "attempt-profile-hash"),
    profile_id: opaqueIdSchema.parse(rowValue(row, "profile_id")),
    runtime_id: opaqueIdSchema.parse(rowValue(row, "runtime_id")),
    model_id: opaqueIdSchema.parse(rowValue(row, "model_id")),
    reasoning: nullableText(row, "reasoning"),
    provider_id: opaqueIdSchema.parse(rowValue(row, "provider_id")),
    account_ref: opaqueIdSchema.parse(rowValue(row, "account_ref")),
    auth_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "auth_epoch"), "attempt-auth-epoch"), "attempt-auth-epoch"),
    auth_generation: nullableUuid(row, "auth_generation"),
    auth_entry_id: nullableUuid(row, "auth_entry_id"),
    owner: parseOwner(rowValue(row, "owner"), "attempt-owner"),
    job_fence: parseContract(nonNegativeInt64Schema, sqlInteger(rowValue(row, "job_fence"), "attempt-fence").toString(10), "attempt-fence"),
    lease_until: parseDate(rowValue(row, "lease_until"), "attempt-lease"),
    reservation_id: parseUuid(rowValue(row, "reservation_id"), "attempt-reservation-id"),
    accounting_period_day: nullableText(row, "accounting_period_day"),
    accounting_period_month: nullableText(row, "accounting_period_month"),
    deadline_at: parseDate(rowValue(row, "deadline_at"), "attempt-deadline"),
    state: parseAttemptState(rowValue(row, "state")),
    runtime_session_id: nullableText(row, "runtime_session_id"),
    provider_attempt_id: nullableText(row, "provider_attempt_id"),
    terminal_status: rowValue(row, "terminal_status") === null ? null : parseTerminal(rowValue(row, "terminal_status")),
    result_digest: resultDigest === null ? null : parseDigest(resultDigest, "attempt-result-digest"),
    result_receipt_json: receipt,
    usage_status: parseUsageStatus(rowValue(row, "usage_status")),
    usage_json: nullableText(row, "usage_json"),
    usage_complete: usageComplete,
    cleanup_state: parseCleanup(rowValue(row, "cleanup_state")),
    cleanup_reason: nullableText(row, "cleanup_reason"),
    budget_violation: parseBudgetViolation(rowValue(row, "budget_violation")),
    started_at: nullableDate(row, "started_at"),
    terminal_at: nullableDate(row, "terminal_at"),
    cleanup_at: nullableDate(row, "cleanup_at"),
    active_ms: safeNumber(rowValue(row, "active_ms"), "attempt-active-ms"),
    created_at: parseDate(rowValue(row, "created_at"), "attempt-created-at"),
    updated_at: parseDate(rowValue(row, "updated_at"), "attempt-updated-at"),
  };
}

function usageValues(usage: AttemptUsageInput): {
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly provider_requests: number | null;
  readonly credits: AttemptUsageInput["credits"] | null;
} {
  return {
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    provider_requests: usage.provider_requests ?? null,
    credits: usage.credits ?? null,
  };
}

function usageViolations(usage: AttemptUsageInput, dailyLimits: ExecutionUsageLimits, monthlyLimits: ExecutionUsageLimits): string[] {
  const values = usageValues(usage);
  const violations: string[] = [];
  if (
    (dailyLimits.input_tokens !== undefined && values.input_tokens !== null && values.input_tokens !== undefined && values.input_tokens > dailyLimits.input_tokens) ||
    (monthlyLimits.input_tokens !== undefined && values.input_tokens !== null && values.input_tokens !== undefined && values.input_tokens > monthlyLimits.input_tokens)
  ) violations.push("input_tokens_limit");
  if (
    (dailyLimits.output_tokens !== undefined && values.output_tokens !== null && values.output_tokens !== undefined && values.output_tokens > dailyLimits.output_tokens) ||
    (monthlyLimits.output_tokens !== undefined && values.output_tokens !== null && values.output_tokens !== undefined && values.output_tokens > monthlyLimits.output_tokens)
  ) violations.push("output_tokens_limit");
  if (
    (dailyLimits.provider_requests !== undefined && values.provider_requests !== null && values.provider_requests !== undefined && values.provider_requests > dailyLimits.provider_requests) ||
    (monthlyLimits.provider_requests !== undefined && values.provider_requests !== null && values.provider_requests !== undefined && values.provider_requests > monthlyLimits.provider_requests)
  ) violations.push("provider_requests_limit");
  if (values.credits !== null && values.credits !== undefined) {
    const configured = [dailyLimits.credits, monthlyLimits.credits].filter((limit): limit is NonNullable<ExecutionUsageLimits["credits"]> => limit !== undefined);
    if (configured.length === 0) violations.push("credits_unconfigured");
    else if (configured.some((limit) => limit.unit !== values.credits!.unit || limit.scale !== values.credits!.scale)) violations.push("credits_unit_mismatch");
    else if (configured.some((limit) => values.credits!.amount > limit.amount)) violations.push("credits_limit");
  }
  return violations;
}

function usageComplete(
  usage: AttemptUsageInput,
  completeDimensions: readonly UsageDimension[],
  dailyLimits: ExecutionUsageLimits,
  monthlyLimits: ExecutionUsageLimits,
): boolean {
  if (usage.status !== "observed") return false;
  const values = usageValues(usage);
  const completed = new Set(completeDimensions);
  const hasEveryConfiguredValue = (dimension: UsageDimension, daily: number | undefined, monthly: number | undefined, actual: number | null | undefined): boolean =>
    (daily === undefined && monthly === undefined) || completed.has(dimension) && actual !== null && actual !== undefined;
  if (!hasEveryConfiguredValue("input_tokens", dailyLimits.input_tokens, monthlyLimits.input_tokens, values.input_tokens)) return false;
  if (!hasEveryConfiguredValue("output_tokens", dailyLimits.output_tokens, monthlyLimits.output_tokens, values.output_tokens)) return false;
  if (!hasEveryConfiguredValue("provider_requests", dailyLimits.provider_requests, monthlyLimits.provider_requests, values.provider_requests)) return false;
  const creditConfigured = dailyLimits.credits ?? monthlyLimits.credits;
  if (creditConfigured === undefined) return true;
  return completed.has("credits") && values.credits !== null && values.credits !== undefined && values.credits.unit === creditConfigured.unit && values.credits.scale === creditConfigured.scale;
}

function usageUnitConflicts(current: AttemptUsageInput, incoming: AttemptUsageInput | undefined): string[] {
  if (incoming?.credits === undefined || current.credits === undefined) return [];
  return current.credits.unit === incoming.credits.unit && current.credits.scale === incoming.credits.scale ? [] : ["credits_unit_mismatch"];
}

function mergeUsage(
  current: AttemptUsageInput,
  currentComplete: readonly UsageDimension[],
  incoming: AttemptUsageInput | undefined,
): { readonly usage: AttemptUsageInput; readonly complete: readonly UsageDimension[] } {
  if (incoming === undefined || incoming.status === "unknown") return { usage: current, complete: currentComplete };
  const maximum = (left: number | undefined, right: number | undefined): number | undefined => {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return Math.max(left, right);
  };
  const credits = current.credits !== undefined && incoming.credits !== undefined
    ? current.credits.unit === incoming.credits.unit && current.credits.scale === incoming.credits.scale
      ? { ...incoming.credits, amount: Math.max(current.credits.amount, incoming.credits.amount) }
      : current.credits
    : incoming.credits ?? current.credits;
  const merged = {
    status: current.status === "observed" || incoming.status === "observed" ? "observed" : "partial",
    input_tokens: maximum(current.input_tokens, incoming.input_tokens),
    output_tokens: maximum(current.output_tokens, incoming.output_tokens),
    provider_requests: maximum(current.provider_requests, incoming.provider_requests),
    credits,
  };
  if (merged.status === "observed" && merged.input_tokens === undefined && merged.output_tokens === undefined && merged.provider_requests === undefined && merged.credits === undefined) {
    return { usage: { status: "unknown" }, complete: currentComplete };
  }
  const usage = usageInputSchema.parse(merged);
  const incomingDimensions = usageDimensions(incoming).filter(
    (dimension) => dimension !== "credits" || current.credits === undefined || incoming.credits === undefined || (current.credits.unit === incoming.credits.unit && current.credits.scale === incoming.credits.scale),
  );
  const complete = new Set(currentComplete);
  if (incoming.status === "partial") {
    // A partial report is not a per-dimension finality proof.  If it repeats
    // a dimension that had been marked complete, conservatively reopen that
    // dimension until a later observed report closes it again.
    for (const dimension of ["input_tokens", "output_tokens", "provider_requests", "credits"] as const) {
      if (incoming[dimension] !== undefined) complete.delete(dimension);
    }
  } else {
    for (const dimension of incomingDimensions) complete.add(dimension);
  }
  return {
    usage,
    complete: Object.freeze([...complete].sort()),
  };
}

function usageDelta(previous: AttemptUsageInput, next: AttemptUsageInput): {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly provider_requests: number;
  readonly credits: number;
} {
  const value = (nextValue: number | undefined, previousValue: number | undefined): number => {
    if (nextValue === undefined) return 0;
    return Math.max(0, nextValue - (previousValue ?? 0));
  };
  return {
    input_tokens: value(next.input_tokens, previous.input_tokens),
    output_tokens: value(next.output_tokens, previous.output_tokens),
    provider_requests: value(next.provider_requests, previous.provider_requests),
    credits:
      next.credits !== undefined &&
      (previous.credits === undefined || (previous.credits.unit === next.credits.unit && previous.credits.scale === next.credits.scale))
        ? value(next.credits.amount, previous.credits?.amount)
        : 0,
  };
}

function receiptFromRow(row: unknown): AttemptReceipt {
  const raw = nullableText(row, "result_receipt_json");
  if (raw === null) throw new StoreError("attempt_invalid");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StoreError("attempt_invalid", error);
  }
  const parsed = z
    .object({
      version: z.literal(1),
      attempt_id: uuidSchema,
      batch_id: uuidSchema,
      job_id: uuidSchema,
      phase: executionPhaseSchema,
      ordinal: positiveIntegerSchema,
      status: terminalStatusSchema,
      result_digest: digestSchema,
      provider_id: opaqueIdSchema,
      model_id: opaqueIdSchema,
      requested_model_id: opaqueIdSchema.optional(),
      reasoning: opaqueIdSchema.nullable(),
      runtime_session_id: opaqueIdSchema.nullable(),
      provider_attempt_id: opaqueIdSchema.nullable(),
      usage_status: usageStatusSchema,
      received_at: dateTimeSchema,
      cleanup: z.literal("confirmed"),
    })
    .strict()
    .parse(value);
  const { requested_model_id, ...rest } = parsed;
  return { ...rest, ...(requested_model_id === undefined ? {} : { requested_model_id }), result_digest: parsed.result_digest.toLowerCase(), received_at: parseDate(parsed.received_at, "receipt-received-at") };
}

export class AttemptRepository {
  private readonly clock: (() => string) | undefined;

  constructor(
    private readonly database: DatabaseSync,
    private readonly ensureOpen: () => void,
    options: { readonly clock?: () => string } = {},
  ) {
    this.clock = options.clock;
  }

  beginBatch(input: BeginExecutionBatchInput): ExecutionBatchRecord {
    const claim = parseClaim(input.claim);
    const binding = parseBinding(input.binding);
    const requestDigest = parseDigest(input.request_digest, "batch-request-digest");
    const budget = parseExecutionBudgetPolicy(input.budget);
    const batchId = parseUuid(input.batch_id ?? randomUUID(), "batch-id");
    if (!binding.allowed_scope_ids.includes(claim.scope_id)) throw new StoreError("attempt_stale");
    if (budget.provider_target !== `provider:${binding.provider_id}`) throw new StoreError("attempt_stale");
    return this.transaction(() => {
      const now = this.readNow();
          const auth = this.assertCurrentAdmission(claim, binding, now);
          if (binding.auth_generation !== null && auth.generation !== binding.auth_generation) throw new StoreError("attempt_stale");
          if (binding.auth_entry_id !== null && auth.entryId !== binding.auth_entry_id) throw new StoreError("attempt_stale");
          const existing = this.readBatch(batchId);
          if (existing !== undefined) {
            this.assertExistingBatch(existing, claim, binding, requestDigest, auth);
        this.assertReservationPolicy(existing.batch_id, canonicalBudgetKey(binding, budget.budget_tag), budget);
        return existing;
      }
      const periods = periodKeys(now);
      const budgetKey = canonicalBudgetKey(binding, budget.budget_tag);
      this.assertBudgetCapacity(periods.day, periods.month, budgetKey, budget);
      const updated = this.database
        .prepare(
          `INSERT INTO execution_batch (
             batch_id, job_id, scope_id, source_capture_id, task_version,
             input_fingerprint, input_privacy_epoch, request_digest, binding_id,
             profile_hash, profile_id, runtime_id, model_id, reasoning, provider_id,
             provider_target, account_ref, auth_epoch, auth_generation, auth_entry_id, job_owner,
             job_fence, job_lease_until, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`
        )
        .run(
          batchId,
          claim.job_id,
          claim.scope_id,
          claim.source_capture_id,
          claim.task_version,
          claim.input_fingerprint,
          claim.input_privacy_epoch,
          requestDigest,
          binding.binding_id,
          binding.profile_hash,
          binding.profile_id,
          binding.runtime_id,
          binding.model_id,
          binding.reasoning,
          binding.provider_id,
          binding.provider_target,
          binding.account_ref,
          binding.auth_epoch,
          auth.generation,
          auth.entryId,
          claim.owner,
          BigInt(claim.fence),
          claim.lease_until,
          now,
          now,
        );
      if (sqlInteger(updated.changes, "batch-insert-changes") !== 1n) throw new StoreError("attempt_conflict");
      const insert = this.database.prepare(
        `INSERT INTO budget_reservation (
           reservation_id, batch_id, phase, period_day, period_month,
           budget_key, daily_start_limit, monthly_start_limit,
           daily_active_ms_limit, monthly_active_ms_limit, daily_usage_limits_json,
           monthly_usage_limits_json, usage_reservation_json, reserved_input_tokens, reserved_output_tokens,
           reserved_provider_requests, reserved_credits, consumed_input_tokens,
           consumed_output_tokens, consumed_provider_requests, consumed_credits,
           reserved_starts, consumed_starts,
           reserved_active_ms, consumed_active_ms, state, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`
      );
      for (const plan of reservationPlans(budget)) {
        insert.run(
          randomUUID(),
          batchId,
          plan.phase,
          periods.day,
          periods.month,
          budgetKey,
          budget.daily_start_limit,
          budget.monthly_start_limit,
          budget.daily_active_ms_limit ?? null,
          budget.monthly_active_ms_limit ?? null,
          canonicalUsageLimits(usageLimitsForPeriod(budget, "day")),
          canonicalUsageLimits(usageLimitsForPeriod(budget, "month")),
          canonicalUsageLimits(plan.reserved_usage),
          plan.reserved_usage.input_tokens ?? 0,
          plan.reserved_usage.output_tokens ?? 0,
          plan.reserved_usage.provider_requests ?? 0,
          plan.reserved_usage.credits?.amount ?? 0,
          0,
          0,
          0,
          0,
          plan.reserved_starts,
          0,
          plan.reserved_active_ms,
          0,
          "active",
          now,
          now,
        );
      }
      const batch = this.readBatch(batchId);
      if (batch === undefined) throw new StoreError("attempt_write_failed");
      return batch;
    });
  }

  boundAttemptDeadline(input: Pick<PrepareExecutionAttemptInput, "batch_id" | "attempt_id" | "phase" | "deadline" | "claim" | "binding">): string {
    return this.transaction(() => {
      const now = this.readNow();
      const batch = this.requireBatch(parseUuid(input.batch_id, "attempt-batch-id"));
      this.assertBatchControl(batch, parseClaim(input.claim), parseBinding(input.binding), now);
      const deadline = parseDate(input.deadline, "attempt-deadline");
      const existing = this.readAttempt(parseUuid(input.attempt_id, "attempt-id"));
      if (existing !== undefined) {
        if (existing.batch_id !== batch.batch_id) throw new StoreError("attempt_conflict");
        return new Date(Math.min(Date.parse(deadline), Date.parse(existing.deadline_at))).toISOString();
      }
      return this.remainingDeadline(batch, parsePhase(input.phase), deadline, now);
    });
  }

  prepareAttempt(input: PrepareExecutionAttemptInput): ExecutionAttemptRecord {
    const batchId = parseUuid(input.batch_id, "attempt-batch-id");
    const attemptId = parseUuid(input.attempt_id, "attempt-id");
    const phase = parsePhase(input.phase);
    const requestDigest = parseDigest(input.request_digest, "attempt-request-digest");
    const deadline = parseDate(input.deadline, "attempt-deadline");
    const claim = parseClaim(input.claim);
    const binding = parseBinding(input.binding);
    return this.transaction(() => {
      const now = this.readNow();
      const batch = this.readBatch(batchId);
      if (batch === undefined) throw new StoreError("attempt_not_found");
      this.assertBatchControl(batch, claim, binding, now);
      const existing = this.readAttempt(attemptId);
      if (existing !== undefined) {
        this.assertAttemptIdentity(existing, { batch_id: batchId, job_id: claim.job_id, phase, request_digest: requestDigest, binding, claim });
        return existing;
      }
      if (batch.state === "failed" || batch.state === "paused" || batch.state === "reconciled") throw new StoreError("attempt_budget_paused");
      this.rolloverBatchReservations(batchId, periodKeys(now), now);
      if (!isBefore(now, deadline) || Date.parse(deadline) > Date.parse(addMilliseconds(now, EXECUTION_BATCH_LIMITS.max_active_ms_per_phase))) {
        throw new StoreError("attempt_deadline");
      }
      const phaseCount = safeNumber(
        rowValue(
          this.database.prepare("SELECT COUNT(*) AS count FROM execution_attempt WHERE batch_id = ? AND phase = ?").get(batchId, phase),
          "count",
        ),
        "phase-attempt-count",
      );
      const totalCount = safeNumber(
        rowValue(
          this.database.prepare("SELECT COUNT(*) AS count FROM execution_attempt WHERE batch_id = ?").get(batchId),
          "count",
        ),
        "total-attempt-count",
      );
      const lineage = this.lineageUsage(batch);
      const lineagePhaseCount = phase === "extract" ? lineage.extract_starts : lineage.verify_starts;
      if (
        phaseCount >= EXECUTION_BATCH_LIMITS.max_starts_per_phase ||
        totalCount >= EXECUTION_BATCH_LIMITS.max_starts_total ||
        lineagePhaseCount >= EXECUTION_BATCH_LIMITS.max_starts_per_phase ||
        lineage.total_starts >= EXECUTION_BATCH_LIMITS.max_starts_total
      ) throw new StoreError("attempt_budget_paused");
      const effectiveDeadline = this.remainingDeadline(batch, phase, deadline, now);
      const reservation = this.readReservationForPhase(batchId, phase);
      if (reservation === undefined || reservation.state !== "active" || reservation.reserved_starts <= 0) throw new StoreError("attempt_budget_paused");
      const ordinal = phaseCount + 1;
      const updated = this.database
        .prepare(
          `INSERT INTO execution_attempt (
             attempt_id, batch_id, job_id, phase, ordinal, request_digest,
             input_fingerprint, input_privacy_epoch, binding_id, profile_hash,
             profile_id, runtime_id, model_id, reasoning, provider_id, account_ref,
             auth_epoch, auth_generation, auth_entry_id, owner, job_fence, lease_until,
             reservation_id, accounting_period_day, accounting_period_month, deadline_at,
             state, usage_status, cleanup_state, usage_complete_json, active_ms,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'prepared', 'unknown', 'not_started', '[]', 0, ?, ?)`
        )
        .run(
          attemptId,
          batchId,
          claim.job_id,
          phase,
          ordinal,
          requestDigest,
          claim.input_fingerprint,
          claim.input_privacy_epoch,
          binding.binding_id,
          binding.profile_hash,
          binding.profile_id,
          binding.runtime_id,
          binding.model_id,
          binding.reasoning,
          binding.provider_id,
          binding.account_ref,
          binding.auth_epoch,
          batch.auth_generation,
          batch.auth_entry_id,
          claim.owner,
          BigInt(claim.fence),
          claim.lease_until,
          reservation.reservation_id,
          effectiveDeadline,
          now,
          now,
        );
      if (sqlInteger(updated.changes, "attempt-insert-changes") !== 1n) throw new StoreError("attempt_conflict");
      this.database.prepare("UPDATE execution_batch SET state = 'active', updated_at = ? WHERE batch_id = ? AND state IN ('prepared', 'active', 'terminal_observed')").run(now, batchId);
      const attempt = this.readAttempt(attemptId);
      if (attempt === undefined) throw new StoreError("attempt_write_failed");
      return attempt;
    });
  }

  markDispatchIntent(control: AttemptControlInput): ExecutionAttemptRecord {
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      const binding = parseBinding(control.binding);
      const claim = parseClaim(control.claim);
      const batch = this.requireBatch(current.batch_id);
      this.assertBatchControl(batch, claim, binding, now);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: control.claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding, claim });
      if (batch.state === "paused" || batch.state === "failed" || batch.state === "reconciled") throw new StoreError("attempt_budget_paused");
      this.reconcilePurgedLocalCleanup(current, now);
      this.assertRuntimeCleanupAdmission(current);
      if (current.state !== "prepared") return current;
      // Plan §11: an unreconciled cleanup_pending attempt pauses new
      // data-bearing dispatches of the same profile until reconciliation
      // succeeds. Same-batch phases are already governed by the paused batch
      // state, so only cross-batch dispatches are fenced here.
      const pendingCleanup = this.database
        .prepare(
          `SELECT 1 FROM execution_attempt
             WHERE profile_id = ? AND account_ref = ? AND attempt_id <> ? AND batch_id <> ?
               AND state = 'cleanup_pending' LIMIT 1`,
        )
        .get(current.profile_id, current.account_ref, current.attempt_id, current.batch_id);
      if (pendingCleanup !== undefined) throw new StoreError("attempt_cleanup_pending");
      if (!isBefore(now, current.deadline_at)) throw new StoreError("attempt_deadline");
      this.rolloverBatchReservations(current.batch_id, periodKeys(now), now);
      const reservation = this.requireReservation(current.reservation_id);
      if (reservation.state !== "active" || reservation.consumed_starts >= reservation.reserved_starts) throw new StoreError("attempt_budget_paused");
      if (this.aggregateBudgetViolations(reservation).length > 0) throw new StoreError("attempt_budget_paused");
      const lineage = this.lineageUsage(batch);
      const phaseActive = current.phase === "extract" ? lineage.extract_active_ms : lineage.verify_active_ms;
      const totalActive = lineage.active_ms;
      if (phaseActive >= EXECUTION_BATCH_LIMITS.max_active_ms_per_phase || totalActive >= EXECUTION_BATCH_LIMITS.max_active_ms_total) throw new StoreError("attempt_budget_paused");
      if (this.remainingDeadline(batch, current.phase, current.deadline_at, now) !== current.deadline_at) throw new StoreError("attempt_deadline");
      const updatedReservation = this.database
        .prepare("UPDATE budget_reservation SET consumed_starts = consumed_starts + 1, updated_at = ? WHERE reservation_id = ? AND state = 'active' AND consumed_starts < reserved_starts")
        .run(now, current.reservation_id);
      if (sqlInteger(updatedReservation.changes, "reservation-start-changes") !== 1n) throw new StoreError("attempt_budget_paused");
      const updatedAttempt = this.database
        .prepare("UPDATE execution_attempt SET state = 'dispatch_intent', started_at = ?, accounting_period_day = ?, accounting_period_month = ?, cleanup_state = 'pending', updated_at = ? WHERE attempt_id = ? AND state = 'prepared'")
        .run(now, reservation.period_day, reservation.period_month, now, current.attempt_id);
      if (sqlInteger(updatedAttempt.changes, "dispatch-intent-changes") !== 1n) throw new StoreError("attempt_conflict");
      const column = current.phase === "extract" ? "extract_starts" : "verify_starts";
      const updatedBatch = this.database
        .prepare(`UPDATE execution_batch SET ${column} = ${column} + 1, total_starts = total_starts + 1, state = 'active', updated_at = ? WHERE batch_id = ? AND total_starts < ? AND ${column} < ?`)
        .run(now, current.batch_id, EXECUTION_BATCH_LIMITS.max_starts_total, EXECUTION_BATCH_LIMITS.max_starts_per_phase);
      if (sqlInteger(updatedBatch.changes, "batch-start-changes") !== 1n) throw new StoreError("attempt_budget_paused");
      return this.requireAttempt(current.attempt_id);
    });
  }

  recordSession(control: AttemptControlInput, runtimeSessionId: string): ExecutionAttemptRecord {
    const sessionId = parseContract(opaqueIdSchema, runtimeSessionId, "runtime-session-id");
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      const binding = parseBinding(control.binding);
      const claim = parseClaim(control.claim);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding, claim });
      this.assertBatchControl(this.requireBatch(current.batch_id), claim, binding, now);
      if (!isBefore(now, current.deadline_at)) throw new StoreError("attempt_deadline");
      if (current.runtime_session_id !== null) {
        if (current.runtime_session_id !== sessionId) throw new StoreError("attempt_conflict");
        return current;
      }
      // Strict order is dispatch_intent -> session_observed (Copilot creates the
      // native session before dispatch). Process executors (Codex/Claude) only
      // observe their native thread/session ID from post-process output, so a
      // late binding from prompt_dispatched is honest provided the ID comes
      // from the native output and is never invented pre-prompt.
      if (current.state === "dispatch_intent") {
        const updated = this.database.prepare("UPDATE execution_attempt SET state = 'session_observed', runtime_session_id = ?, updated_at = ? WHERE attempt_id = ? AND state = 'dispatch_intent' AND runtime_session_id IS NULL").run(sessionId, now, current.attempt_id);
        if (sqlInteger(updated.changes, "session-checkpoint-changes") !== 1n) throw new StoreError("attempt_conflict");
        return this.requireAttempt(current.attempt_id);
      }
      if (current.state === "prompt_dispatched") {
        const updated = this.database.prepare("UPDATE execution_attempt SET runtime_session_id = ?, updated_at = ? WHERE attempt_id = ? AND state = 'prompt_dispatched' AND runtime_session_id IS NULL").run(sessionId, now, current.attempt_id);
        if (sqlInteger(updated.changes, "session-checkpoint-changes") !== 1n) throw new StoreError("attempt_conflict");
        return this.requireAttempt(current.attempt_id);
      }
      throw new StoreError("attempt_conflict");
    });
  }

  recordPromptDispatch(control: AttemptControlInput): ExecutionAttemptRecord {
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      const binding = parseBinding(control.binding);
      const claim = parseClaim(control.claim);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding, claim });
      const batch = this.requireBatch(current.batch_id);
      this.assertBatchControl(batch, claim, binding, now);
      if (!isBefore(now, current.deadline_at)) throw new StoreError("attempt_deadline");
      if (current.state === "prompt_dispatched" || current.state === "terminal_observed" || current.state === "cleanup_pending" || current.state === "reconciled") return current;
      if (batch.state === "paused" || batch.state === "failed" || batch.state === "reconciled") throw new StoreError("attempt_budget_paused");
      const reservation = this.requireReservation(current.reservation_id);
      if (reservation.state !== "active" || this.aggregateBudgetViolations(reservation).length > 0) throw new StoreError("attempt_budget_paused");
      // Copilot observes its SDK session before dispatch (session_observed ->
      // prompt_dispatched). Codex/Claude cannot pre-observe a native session;
      // their thread ID comes from post-process output, so dispatch from
      // dispatch_intent is the honest order. Late session binding happens via
      // recordSession from prompt_dispatched and never claims pre-prompt
      // observation from post-process parsing.
      if (current.state !== "session_observed" && current.state !== "dispatch_intent") throw new StoreError("attempt_conflict");
      const updated = this.database.prepare("UPDATE execution_attempt SET state = 'prompt_dispatched', updated_at = ? WHERE attempt_id = ? AND state IN ('dispatch_intent', 'session_observed')").run(now, current.attempt_id);
      if (sqlInteger(updated.changes, "prompt-checkpoint-changes") !== 1n) throw new StoreError("attempt_conflict");
      return this.requireAttempt(current.attempt_id);
    });
  }

  recordTerminal(control: AttemptControlInput, input: TerminalCheckpointInput): ExecutionAttemptRecord {
    const status = parseTerminal(input.status);
    const providerAttemptId = input.provider_attempt_id === undefined ? null : parseContract(opaqueIdSchema, input.provider_attempt_id, "provider-attempt-id");
    const incomingUsage = input.usage === undefined ? undefined : parseUsageInput(input.usage);
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      const binding = parseBinding(control.binding);
      const claim = parseClaim(control.claim);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding, claim });
      if (current.provider_attempt_id !== null && providerAttemptId !== null && current.provider_attempt_id !== providerAttemptId) throw new StoreError("attempt_conflict");
      if (current.terminal_status !== null) {
        if (current.terminal_status !== status || (providerAttemptId !== null && current.provider_attempt_id !== providerAttemptId)) throw new StoreError("attempt_conflict");
        return current;
      }
      // A cleanup_pending attempt without terminal evidence arose because the
      // terminal checkpoint failed after dispatch intent was already
      // committed. Recording the held terminal result here is the
      // reconciliation path; without it the attempt could never settle and
      // would pause the profile forever. It stays fenced by identity, batch
      // control and the same terminal-status CAS.
      if (!["dispatch_intent", "session_observed", "prompt_dispatched", "cleanup_pending"].includes(current.state)) throw new StoreError("attempt_conflict");
      this.assertBatchControl(this.requireBatch(current.batch_id), claim, binding, now);
      if (current.started_at === null) throw new StoreError("attempt_invalid");
      const activeMs = Math.max(0, Date.parse(now) - Date.parse(current.started_at));
      if (!Number.isSafeInteger(activeMs)) throw new StoreError("attempt_invalid");
      const reservation = this.requireReservation(current.reservation_id);
      const previousUsage = parseStoredUsage(current);
      const mergedUsage = mergeUsage(previousUsage, current.usage_complete, incomingUsage);
      const usage = mergedUsage.usage;
      const usageCompleteDimensions = mergedUsage.complete;
      const delta = usageDelta(previousUsage, usage);
      const violations = [...usageViolations(usage, reservation.daily_usage_limits, reservation.monthly_usage_limits), ...usageUnitConflicts(previousUsage, incomingUsage)];
      if (!isBefore(now, current.deadline_at)) violations.push("execution_deadline");
      const batch = this.requireBatch(current.batch_id);
      const lineage = this.lineageUsage(batch);
      const phaseActiveAfter = (current.phase === "extract" ? lineage.extract_active_ms : lineage.verify_active_ms) + activeMs;
      if (phaseActiveAfter > EXECUTION_BATCH_LIMITS.max_active_ms_per_phase) violations.push("phase_active_time");
      if (lineage.active_ms + activeMs > EXECUTION_BATCH_LIMITS.max_active_ms_total) violations.push("batch_active_time");
      const uniqueViolations = [...new Set([...current.budget_violation, ...violations])];
      const nextBatchState = batch.state === "failed" || batch.state === "paused"
        ? batch.state
        : uniqueViolations.length === 0
          ? "terminal_observed"
          : "paused";
      const violationJson = uniqueViolations.length === 0 ? null : JSON.stringify(uniqueViolations);
      const updatedAttempt = this.database
        .prepare(
          `UPDATE execution_attempt
              SET state = 'terminal_observed', terminal_status = ?, provider_attempt_id = COALESCE(?, provider_attempt_id),
                  usage_status = ?, usage_json = ?, usage_complete_json = ?, terminal_at = ?, active_ms = ?, budget_violation = ?, updated_at = ?
            WHERE attempt_id = ? AND state IN ('dispatch_intent', 'session_observed', 'prompt_dispatched', 'cleanup_pending') AND terminal_status IS NULL`,
        )
        .run(status, providerAttemptId, usage.status, usageJson(usage), usageCompleteJson(usageCompleteDimensions), now, activeMs, violationJson, now, current.attempt_id);
      if (sqlInteger(updatedAttempt.changes, "terminal-checkpoint-changes") !== 1n) throw new StoreError("attempt_conflict");
      const updatedBatch = this.database
        .prepare("UPDATE execution_batch SET active_ms = active_ms + ?, state = ?, failure_reason = ?, updated_at = ? WHERE batch_id = ?")
        .run(activeMs, nextBatchState, uniqueViolations[0] ?? batch.failure_reason, now, current.batch_id);
      if (sqlInteger(updatedBatch.changes, "batch-active-changes") !== 1n) throw new StoreError("attempt_write_failed");
      this.incrementAttemptAccountingUsage(current, delta, activeMs, now);
      const aggregateViolations = this.aggregateBudgetViolations(
        reservation,
        current.accounting_period_day ?? undefined,
        current.accounting_period_month ?? undefined,
      );
      if (aggregateViolations.length > 0) {
        const allViolations = [...new Set([...uniqueViolations, ...aggregateViolations])];
        this.database.prepare("UPDATE execution_attempt SET budget_violation = ? WHERE attempt_id = ?").run(JSON.stringify(allViolations), current.attempt_id);
        this.database.prepare("UPDATE execution_batch SET state = 'paused', failure_reason = ?, updated_at = ? WHERE batch_id = ?").run(allViolations[0] ?? "budget_violation", now, current.batch_id);
        this.setAccountingState(current, reservation, "uncertain", now);
      }
      return this.requireAttempt(current.attempt_id);
    });
  }

  recordCleanup(control: AttemptControlInput, input: CleanupCheckpointInput): ExecutionAttemptRecord {
    if (typeof input !== "object" || input === null || typeof input.confirmed !== "boolean") throw new StoreError("attempt_invalid");
    const reason = input.reason === undefined ? null : parseContract(z.string().min(1).max(128), input.reason, "cleanup-reason");
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: control.claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding: parseBinding(control.binding), claim: parseClaim(control.claim) });
      if (input.confirmed && current.cleanup_state === "confirmed") return current;
      if (!input.confirmed && current.cleanup_state === "confirmed") return current;
      if (input.confirmed && current.terminal_status === null) throw new StoreError("attempt_conflict");
      if (!input.confirmed && current.state === "prepared" && current.terminal_status === null && current.started_at === null) {
        // No dispatch intent was ever committed for this attempt, so no
        // provider work is outstanding. Moving it to cleanup_pending without
        // terminal evidence would be unreconcilable and would pause the
        // profile forever; the honest settlement is the known pre-dispatch
        // failure plus release of the unused reservation.
        const settledReason = reason ?? "cleanup_unconfirmed_pre_dispatch";
        const cancelled = this.database
          .prepare("UPDATE execution_attempt SET state = 'failed', cleanup_reason = ?, cleanup_at = ?, updated_at = ? WHERE attempt_id = ? AND state = 'prepared' AND terminal_status IS NULL")
          .run(settledReason, now, now, current.attempt_id);
        if (sqlInteger(cancelled.changes, "cleanup-pre-dispatch-changes") !== 1n) throw new StoreError("attempt_conflict");
        this.releaseUnusedReservation(current.reservation_id, now);
        return this.requireAttempt(current.attempt_id);
      }
      const nextState = input.confirmed ? "reconciled" : "cleanup_pending";
      const nextCleanup = input.confirmed ? "confirmed" : "unknown";
      const updated = this.database
        .prepare("UPDATE execution_attempt SET state = ?, cleanup_state = ?, cleanup_reason = ?, cleanup_at = ?, updated_at = ? WHERE attempt_id = ? AND state NOT IN ('failed', 'aborted')")
        .run(nextState, nextCleanup, reason, now, now, current.attempt_id);
      if (sqlInteger(updated.changes, "cleanup-checkpoint-changes") !== 1n) throw new StoreError("attempt_conflict");
      if (!input.confirmed) this.database.prepare("UPDATE execution_batch SET state = 'paused', failure_reason = ?, updated_at = ? WHERE batch_id = ?").run(reason ?? "cleanup_pending", now, current.batch_id);
      else {
        const reservation = this.requireReservation(current.reservation_id);
        const usage = parseStoredUsage(current);
        const known = usageComplete(usage, current.usage_complete, reservation.daily_usage_limits, reservation.monthly_usage_limits);
        if (!known) this.setAccountingState(current, reservation, "uncertain", now);
      }
      return this.requireAttempt(current.attempt_id);
    });
  }

  complete(control: AttemptControlInput, input: AttemptCompletionInput): AttemptCompletionResult {
    const status = parseTerminal(input.status);
    const resultDigest = parseDigest(input.result_digest, "attempt-result-digest");
    const receivedAt = parseDate(input.received_at, "attempt-received-at");
    const providerId = parseContract(opaqueIdSchema, input.provider_id, "attempt-result-provider");
    const modelId = parseContract(opaqueIdSchema, input.model_id, "attempt-result-model");
    const reasoning = input.reasoning === null ? null : parseContract(opaqueIdSchema, input.reasoning, "attempt-result-reasoning");
    const runtimeSessionId = input.runtime_session_id === null ? null : parseContract(opaqueIdSchema, input.runtime_session_id, "attempt-result-runtime-session");
    const providerAttemptId = input.provider_attempt_id === undefined ? null : parseContract(opaqueIdSchema, input.provider_attempt_id, "provider-attempt-id");
    const incomingUsage = input.usage === undefined ? undefined : parseUsageInput(input.usage);
    return this.transaction(() => {
      const current = this.requireAttempt(control.attempt.attempt_id);
      if (current.result_receipt_json !== null) {
        const receipt = receiptFromRow({ result_receipt_json: current.result_receipt_json });
        if (
          receipt.result_digest !== resultDigest ||
          receipt.status !== status ||
          receipt.provider_id !== providerId ||
          receipt.model_id !== modelId ||
          receipt.requested_model_id !== input.requested_model_id ||
          receipt.reasoning !== reasoning ||
          receipt.runtime_session_id !== runtimeSessionId ||
          (providerAttemptId !== null && receipt.provider_attempt_id !== providerAttemptId)
        ) throw new StoreError("attempt_conflict");
        return { status: "completed", replayed: true, receipt, attempt: current };
      }
      const binding = parseBinding(control.binding);
      const claim = parseClaim(control.claim);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding, claim });
      if (current.provider_attempt_id !== null && providerAttemptId !== null && current.provider_attempt_id !== providerAttemptId) throw new StoreError("attempt_conflict");
      const movingApiAlias = current.profile_id === "XP-API" && current.model_id === "openrouter/free";
      if (movingApiAlias ? input.requested_model_id !== current.model_id : modelId !== current.model_id) throw new StoreError("attempt_conflict");
      if (providerId !== current.provider_id || reasoning !== current.reasoning || runtimeSessionId !== current.runtime_session_id) throw new StoreError("attempt_conflict");
      if (current.cleanup_state !== "confirmed" || current.state !== "reconciled") throw new StoreError("attempt_cleanup_pending");
      if (current.terminal_status !== status) throw new StoreError("attempt_conflict");
      if (current.budget_violation.length > 0) throw new StoreError("attempt_budget_paused");
      const batch = this.requireBatch(current.batch_id);
      this.assertBatchControl(batch, claim, binding, this.readNow());
      if (current.started_at === null || Date.parse(receivedAt) < Date.parse(current.started_at) || !isBefore(receivedAt, current.deadline_at)) throw new StoreError("attempt_deadline");
      if (!isBefore(receivedAt, current.lease_until) && receivedAt !== current.lease_until) throw new StoreError("attempt_lease_expired");
      const reservation = this.requireReservation(current.reservation_id);
      const previousUsage = parseStoredUsage(current);
      const mergedUsage = mergeUsage(previousUsage, current.usage_complete, incomingUsage);
      const usage = mergedUsage.usage;
      const usageCompleteDimensions = mergedUsage.complete;
      const delta = usageDelta(previousUsage, usage);
      const violations = [...usageViolations(usage, reservation.daily_usage_limits, reservation.monthly_usage_limits), ...usageUnitConflicts(previousUsage, incomingUsage)];
      if (violations.length > 0) throw new StoreError("attempt_budget_paused");
      const receipt: AttemptReceipt = {
        version: 1,
        attempt_id: current.attempt_id,
        batch_id: current.batch_id,
        job_id: current.job_id,
        phase: current.phase,
        ordinal: current.ordinal,
        status,
        result_digest: resultDigest,
        provider_id: current.provider_id,
        model_id: current.model_id,
        ...(movingApiAlias ? { requested_model_id: current.model_id } : {}),
        reasoning: current.reasoning,
        runtime_session_id: current.runtime_session_id,
        provider_attempt_id: providerAttemptId ?? current.provider_attempt_id,
        usage_status: usage.status,
        received_at: receivedAt,
        cleanup: "confirmed",
      };
      const receiptJson = JSON.stringify(receipt);
      const updated = this.database
        .prepare(
          `UPDATE execution_attempt
              SET result_digest = ?, result_receipt_json = ?, provider_attempt_id = COALESCE(?, provider_attempt_id),
                  usage_status = ?, usage_json = ?, usage_complete_json = ?, state = 'reconciled', updated_at = ?
            WHERE attempt_id = ? AND result_receipt_json IS NULL AND cleanup_state = 'confirmed' AND state = 'reconciled'`,
        )
      .run(resultDigest, receiptJson, providerAttemptId, usage.status, usageJson(usage), usageCompleteJson(usageCompleteDimensions), this.readNow(), current.attempt_id);
      if (sqlInteger(updated.changes, "attempt-complete-changes") !== 1n) throw new StoreError("attempt_conflict");
      const accountingNow = this.readNow();
      this.incrementAttemptAccountingUsage(current, delta, 0, accountingNow);
      const aggregateViolations = this.aggregateBudgetViolations(
        reservation,
        current.accounting_period_day ?? undefined,
        current.accounting_period_month ?? undefined,
      );
      if (aggregateViolations.length > 0) {
        this.database.prepare("UPDATE execution_attempt SET budget_violation = ?, updated_at = ? WHERE attempt_id = ?").run(JSON.stringify(aggregateViolations), accountingNow, current.attempt_id);
        this.database.prepare("UPDATE execution_batch SET state = 'paused', failure_reason = ?, updated_at = ? WHERE batch_id = ?").run(aggregateViolations[0] ?? "budget_violation", accountingNow, current.batch_id);
        this.setAccountingState(current, reservation, "uncertain", accountingNow);
      } else if (usageComplete(usage, usageCompleteDimensions, reservation.daily_usage_limits, reservation.monthly_usage_limits) && this.isCurrentAccountingPeriod(current, reservation)) {
        this.releaseUnusedReservation(current.reservation_id, accountingNow);
      }
      return { status: "completed", replayed: false, receipt, attempt: this.requireAttempt(current.attempt_id) };
    });
  }

  recordLateUsage(attemptId: string, input: AttemptUsageInput): ExecutionAttemptRecord {
    const parsedAttemptId = parseUuid(attemptId, "late-usage-attempt-id");
    const usage = parseUsageInput(input);
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(parsedAttemptId);
      const previousUsage = parseStoredUsage(current);
      const mergedUsage = mergeUsage(previousUsage, current.usage_complete, usage);
      const merged = mergedUsage.usage;
      const usageCompleteDimensions = mergedUsage.complete;
      const delta = usageDelta(previousUsage, merged);
      const reservation = this.requireReservation(current.reservation_id);
      const violations = [...usageViolations(merged, reservation.daily_usage_limits, reservation.monthly_usage_limits), ...usageUnitConflicts(previousUsage, usage)];
      const uniqueViolations = [...new Set([...current.budget_violation, ...violations])];
      const updated = this.database
        .prepare("UPDATE execution_attempt SET usage_status = ?, usage_json = ?, usage_complete_json = ?, budget_violation = ?, updated_at = ? WHERE attempt_id = ?")
        .run(merged.status, usageJson(merged), usageCompleteJson(usageCompleteDimensions), uniqueViolations.length === 0 ? null : JSON.stringify(uniqueViolations), now, parsedAttemptId);
      if (sqlInteger(updated.changes, "late-usage-changes") !== 1n) throw new StoreError("attempt_write_failed");
      this.incrementAttemptAccountingUsage(current, delta, 0, now);
      const aggregateViolations = this.aggregateBudgetViolations(
        reservation,
        current.accounting_period_day ?? undefined,
        current.accounting_period_month ?? undefined,
      );
      const allViolations = [...new Set([...uniqueViolations, ...aggregateViolations])];
      if (allViolations.length > 0) {
        this.database.prepare("UPDATE execution_attempt SET budget_violation = ?, updated_at = ? WHERE attempt_id = ?").run(JSON.stringify(allViolations), now, parsedAttemptId);
        this.database.prepare("UPDATE execution_batch SET state = 'paused', failure_reason = ?, updated_at = ? WHERE batch_id = ?").run(allViolations[0] ?? "budget_violation", now, current.batch_id);
        this.setAccountingState(current, reservation, "uncertain", now);
      }
      if (allViolations.length === 0 && usageComplete(merged, usageCompleteDimensions, reservation.daily_usage_limits, reservation.monthly_usage_limits) && current.cleanup_state === "confirmed" && current.result_receipt_json !== null && this.isCurrentAccountingPeriod(current, reservation)) this.releaseUnusedReservation(current.reservation_id, now);
      return this.requireAttempt(parsedAttemptId);
    });
  }

  cancelPrepared(control: AttemptControlInput, reason = "pre_dispatch_persistence_failed"): ExecutionAttemptRecord {
    const parsedReason = parseContract(z.string().min(1).max(128), reason, "attempt-cancel-reason");
    return this.transaction(() => {
      const now = this.readNow();
      const current = this.requireAttempt(control.attempt.attempt_id);
      this.assertAttemptIdentity(current, { batch_id: control.attempt.batch_id, job_id: control.claim.job_id, phase: control.attempt.phase, request_digest: control.attempt.request_digest, binding: parseBinding(control.binding), claim: parseClaim(control.claim) });
      if (current.state !== "prepared") return current;
      const updated = this.database.prepare("UPDATE execution_attempt SET state = 'failed', cleanup_reason = ?, updated_at = ? WHERE attempt_id = ? AND state = 'prepared'").run(parsedReason, now, current.attempt_id);
      if (sqlInteger(updated.changes, "attempt-cancel-changes") !== 1n) throw new StoreError("attempt_conflict");
      this.releaseUnusedReservation(current.reservation_id, now);
      return this.requireAttempt(current.attempt_id);
    });
  }

  /** Release a phase that the caller has deliberately decided not to run. */
  releaseUnusedPhase(input: ReleasePhaseReservationInput): BudgetReservationRecord {
    const batchId = parseUuid(input.batch_id, "release-batch-id");
    const phase = parsePhase(input.phase);
    const claim = parseClaim(input.claim);
    const binding = parseBinding(input.binding);
    return this.transaction(() => {
      const now = this.readNow();
      const batch = this.requireBatch(batchId);
      this.assertBatchControl(batch, claim, binding, now);
      const activeAttempt = this.database
        .prepare(
          `SELECT 1 FROM execution_attempt
             WHERE batch_id = ? AND phase = ?
               AND state NOT IN ('failed', 'aborted') LIMIT 1`,
        )
        .get(batchId, phase);
      if (activeAttempt !== undefined) throw new StoreError("attempt_conflict");
      const reservation = this.readReservationForPhase(batchId, phase);
      if (reservation === undefined) throw new StoreError("attempt_not_found");
      if (reservation.state !== "active") return reservation;
      this.releaseUnusedReservation(reservation.reservation_id, now);
      return this.requireReservation(reservation.reservation_id);
    });
  }

  getBatch(batchId: string): ExecutionBatchRecord | undefined {
    this.ensureOpen();
    return this.readBatch(parseUuid(batchId, "batch-id"));
  }

  getAttempt(attemptId: string): ExecutionAttemptRecord | undefined {
    this.ensureOpen();
    return this.readAttempt(parseUuid(attemptId, "attempt-id"));
  }

  getReservation(reservationId: string): BudgetReservationRecord | undefined {
    this.ensureOpen();
    return this.readReservation(parseUuid(reservationId, "reservation-id"));
  }

  private readBatch(batchId: string): ExecutionBatchRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT batch_id, job_id, scope_id, source_capture_id, task_version,
                input_fingerprint, input_privacy_epoch, request_digest, binding_id,
                profile_hash, profile_id, runtime_id, model_id, reasoning, provider_id,
                provider_target, account_ref, auth_epoch, auth_generation, auth_entry_id, job_owner,
                job_fence, job_lease_until, state, extract_starts, verify_starts,
                total_starts, active_ms, failure_reason, created_at, updated_at
           FROM execution_batch WHERE batch_id = ?`,
      )
      .get(batchId);
    return row === undefined ? undefined : parseBatchRow(row);
  }

  private readReservation(reservationId: string): BudgetReservationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT reservation_id, batch_id, phase, period_day, period_month,
                budget_key, daily_start_limit, monthly_start_limit, daily_active_ms_limit,
                monthly_active_ms_limit, daily_usage_limits_json, monthly_usage_limits_json,
                usage_reservation_json,
                reserved_input_tokens,
                reserved_output_tokens, reserved_provider_requests, reserved_credits,
                consumed_input_tokens, consumed_output_tokens, consumed_provider_requests,
                consumed_credits, reserved_starts, consumed_starts, reserved_active_ms,
                consumed_active_ms, state,
                created_at, updated_at
           FROM budget_reservation WHERE reservation_id = ?`,
      )
      .get(reservationId);
    return row === undefined ? undefined : parseReservationRow(row);
  }

  private readReservationForPhase(batchId: string, phase: ExecutionPhase): BudgetReservationRecord | undefined {
    const row = this.database.prepare("SELECT reservation_id, batch_id, phase, period_day, period_month, budget_key, daily_start_limit, monthly_start_limit, daily_active_ms_limit, monthly_active_ms_limit, daily_usage_limits_json, monthly_usage_limits_json, usage_reservation_json, reserved_input_tokens, reserved_output_tokens, reserved_provider_requests, reserved_credits, consumed_input_tokens, consumed_output_tokens, consumed_provider_requests, consumed_credits, reserved_starts, consumed_starts, reserved_active_ms, consumed_active_ms, state, created_at, updated_at FROM budget_reservation WHERE batch_id = ? AND phase = ?").get(batchId, phase);
    return row === undefined ? undefined : parseReservationRow(row);
  }

  private readAttempt(attemptId: string): ExecutionAttemptRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT attempt_id, batch_id, job_id, phase, ordinal, request_digest,
                input_fingerprint, input_privacy_epoch, binding_id, profile_hash,
                profile_id, runtime_id, model_id, reasoning, provider_id, account_ref,
                auth_epoch, auth_generation, auth_entry_id, owner, job_fence, lease_until,
                reservation_id, accounting_period_day, accounting_period_month, deadline_at,
                state, runtime_session_id, provider_attempt_id,
                terminal_status, result_digest, result_receipt_json, usage_status,
                usage_json, usage_complete_json, cleanup_state, cleanup_reason, budget_violation,
                started_at, terminal_at, cleanup_at, active_ms, created_at, updated_at
           FROM execution_attempt WHERE attempt_id = ?`,
      )
      .get(attemptId);
    return row === undefined ? undefined : parseAttemptRow(row);
  }

  private requireBatch(batchId: string): ExecutionBatchRecord {
    const batch = this.readBatch(batchId);
    if (batch === undefined) throw new StoreError("attempt_not_found");
    return batch;
  }

  private requireAttempt(attemptId: string): ExecutionAttemptRecord {
    const attempt = this.readAttempt(attemptId);
    if (attempt === undefined) throw new StoreError("attempt_not_found");
    return attempt;
  }

  private requireReservation(reservationId: string): BudgetReservationRecord {
    const reservation = this.readReservation(reservationId);
    if (reservation === undefined) throw new StoreError("attempt_not_found");
    return reservation;
  }

  private assertExistingBatch(batch: ExecutionBatchRecord, claim: JobClaim, binding: AttemptBindingSnapshot, requestDigest: string, auth: CurrentAuth): void {
    if (
      batch.job_id !== claim.job_id ||
      batch.scope_id !== claim.scope_id ||
      batch.source_capture_id !== claim.source_capture_id ||
      batch.task_version !== claim.task_version ||
      batch.input_fingerprint !== claim.input_fingerprint ||
      batch.input_privacy_epoch !== claim.input_privacy_epoch ||
      batch.request_digest !== requestDigest ||
      batch.binding_id !== binding.binding_id ||
      batch.profile_hash !== binding.profile_hash ||
      batch.profile_id !== binding.profile_id ||
      batch.runtime_id !== binding.runtime_id ||
      batch.model_id !== binding.model_id ||
      batch.reasoning !== binding.reasoning ||
      batch.provider_id !== binding.provider_id ||
      batch.provider_target !== binding.provider_target ||
      batch.account_ref !== binding.account_ref ||
      batch.auth_epoch !== binding.auth_epoch ||
      batch.auth_generation !== auth.generation ||
      batch.auth_entry_id !== auth.entryId ||
      batch.job_owner !== claim.owner ||
      batch.job_fence !== claim.fence ||
      batch.job_lease_until !== claim.lease_until
    ) throw new StoreError("attempt_conflict");
  }

  private assertAttemptIdentity(
    current: ExecutionAttemptRecord,
    expected: {
      readonly batch_id: string;
      readonly job_id: string;
      readonly phase: ExecutionPhase;
      readonly request_digest: string;
      readonly binding: AttemptBindingSnapshot;
      readonly claim: JobClaim;
    },
  ): void {
    if (
      current.batch_id !== expected.batch_id ||
      current.job_id !== expected.job_id ||
      current.phase !== expected.phase ||
      current.request_digest !== expected.request_digest ||
      current.binding_id !== expected.binding.binding_id ||
      current.profile_hash !== expected.binding.profile_hash ||
      current.profile_id !== expected.binding.profile_id ||
      current.runtime_id !== expected.binding.runtime_id ||
      current.model_id !== expected.binding.model_id ||
      current.reasoning !== expected.binding.reasoning ||
      current.provider_id !== expected.binding.provider_id ||
      current.account_ref !== expected.binding.account_ref ||
      current.auth_epoch !== expected.binding.auth_epoch ||
      (expected.binding.auth_generation !== null && current.auth_generation !== expected.binding.auth_generation) ||
      (expected.binding.auth_entry_id !== null && current.auth_entry_id !== expected.binding.auth_entry_id) ||
      current.owner !== expected.claim.owner ||
      current.job_fence !== expected.claim.fence ||
      current.lease_until !== expected.claim.lease_until
    ) throw new StoreError("attempt_conflict");
  }

  private assertBatchControl(batch: ExecutionBatchRecord, claim: JobClaim, binding: AttemptBindingSnapshot, now: string): void {
    if (!binding.allowed_scope_ids.includes(claim.scope_id)) throw new StoreError("attempt_stale");
    if (batch.provider_target !== `provider:${binding.provider_id}`) throw new StoreError("attempt_stale");
    const expectedAuth: CurrentAuth = { generation: batch.auth_generation, entryId: batch.auth_entry_id };
    this.assertExistingBatch(batch, claim, binding, batch.request_digest, expectedAuth);
    this.assertCurrentAdmission(claim, binding, now, expectedAuth);
  }

  /** Repair only the old purge transition, using its pre-purge completion proof. */
  private reconcilePurgedLocalCleanup(current: ExecutionAttemptRecord, now: string): void {
    if (current.profile_id !== "XP-Local" || current.provider_id !== "local-endpoint") return;
    const rows = this.database.prepare(
      `SELECT a.attempt_id, t.created_at AS purged_at FROM execution_attempt a
         JOIN execution_batch b ON b.batch_id = a.batch_id
         JOIN purge_tombstone t ON t.scope_id = b.scope_id AND t.capture_id = b.source_capture_id
        WHERE a.profile_id = 'XP-Local' AND a.provider_id = 'local-endpoint' AND a.account_ref = ?
          AND a.state = 'cleanup_pending' AND a.cleanup_state = 'pending' AND a.cleanup_reason = 'source_purged'
          AND a.terminal_status = 'completed' AND a.terminal_at IS NOT NULL AND a.runtime_session_id IS NULL
          AND a.result_receipt_json IS NOT NULL AND a.cleanup_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM runtime_artifact r WHERE r.attempt_id = a.attempt_id)`,
    ).all(current.account_ref);
    for (const row of rows) {
      const attempt = this.requireAttempt(parseUuid(rowValue(row, "attempt_id"), "purged-attempt-id"));
      let receipt: AttemptReceipt;
      try { receipt = receiptFromRow(attempt); } catch { continue; }
      const purgedAt = parseDate(rowValue(row, "purged_at"), "purged-at");
      if (receipt.status !== "completed" || receipt.attempt_id !== attempt.attempt_id || receipt.batch_id !== attempt.batch_id || receipt.job_id !== attempt.job_id || receipt.phase !== attempt.phase || receipt.ordinal !== attempt.ordinal || receipt.result_digest !== attempt.result_digest || receipt.provider_id !== attempt.provider_id || receipt.model_id !== attempt.model_id || receipt.reasoning !== attempt.reasoning || receipt.provider_attempt_id !== attempt.provider_attempt_id || receipt.runtime_session_id !== null || Date.parse(receipt.received_at) > Date.parse(purgedAt) || attempt.cleanup_at === null || Date.parse(attempt.cleanup_at) > Date.parse(purgedAt)) continue;
      this.database.prepare("UPDATE execution_attempt SET state = 'reconciled', cleanup_state = 'confirmed', cleanup_reason = 'purged_stateless_receipt', updated_at = ? WHERE attempt_id = ? AND state = 'cleanup_pending' AND cleanup_state = 'pending' AND cleanup_reason = 'source_purged'").run(now, attempt.attempt_id);
    }
  }

  private assertRuntimeCleanupAdmission(attempt: ExecutionAttemptRecord): void {
    const pending = this.database.prepare(
      `SELECT 1 FROM runtime_artifact
         WHERE profile_id = ? AND account_ref = ? AND attempt_id <> ?
           AND state IN ('planned', 'present', 'cleanup_pending', 'ownership_uncertain')
         LIMIT 1`,
    ).get(attempt.profile_id, attempt.account_ref, attempt.attempt_id);
    if (pending !== undefined) throw new StoreError("attempt_cleanup_pending");
  }

  private assertCurrentAdmission(claim: JobClaim, binding: AttemptBindingSnapshot, now: string, expectedAuth?: CurrentAuth | null): CurrentAuth {
    const row = this.database
      .prepare(
        `SELECT j.scope_id, j.source_capture_id, j.task_version, j.state, j.owner,
                j.lease_until, j.fence, j.input_fingerprint, j.input_privacy_epoch,
                e.fingerprint, s.privacy_epoch,
                t.capture_id AS tombstone_capture_id
           FROM job AS j
           JOIN source_event AS e ON e.scope_id = j.scope_id AND e.capture_id = j.source_capture_id
           JOIN scope AS s ON s.scope_id = j.scope_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t ON t.scope_id = j.scope_id AND t.capture_id = j.source_capture_id
          WHERE j.job_id = ?`,
      )
      .get(`provider:${binding.provider_id}`, claim.job_id);
    if (row === undefined) throw new StoreError("attempt_not_found");
    if (
      sqlText(rowValue(row, "scope_id"), "job-scope") !== claim.scope_id ||
      sqlText(rowValue(row, "source_capture_id"), "job-source") !== claim.source_capture_id ||
      sqlText(rowValue(row, "task_version"), "job-task-version") !== claim.task_version ||
      sqlText(rowValue(row, "state"), "job-state") !== "running" ||
      nullableText(row, "owner") !== claim.owner ||
      parseContract(nonNegativeInt64Schema, sqlInteger(rowValue(row, "fence"), "job-fence").toString(10), "job-fence") !== claim.fence ||
      parseDate(rowValue(row, "lease_until"), "job-lease") !== claim.lease_until
    ) throw new StoreError("attempt_lease_expired");
    const leaseUntil = parseDate(rowValue(row, "lease_until"), "job-lease");
    if (!isBefore(now, leaseUntil)) throw new StoreError("attempt_lease_expired");
    if (parseDigest(rowValue(row, "input_fingerprint"), "job-input-fingerprint") !== claim.input_fingerprint || parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "input_privacy_epoch"), "job-input-privacy"), "job-input-privacy") !== claim.input_privacy_epoch) throw new StoreError("attempt_stale");
    if (rowValue(row, "tombstone_capture_id") !== null || parseDigest(rowValue(row, "fingerprint"), "source-fingerprint") !== claim.input_fingerprint) throw new StoreError("attempt_stale");
    if (sqlInteger(rowValue(row, "privacy_epoch"), "scope-privacy-epoch").toString(10) !== claim.input_privacy_epoch) throw new StoreError("attempt_stale");
    return this.assertCurrentAuth(binding, expectedAuth);
  }

  private assertCurrentAuth(binding: AttemptBindingSnapshot, expectedAuth?: CurrentAuth | null): CurrentAuth {
    if (binding.profile_id === "XP-Local" && binding.provider_id === "local-endpoint") {
      if (binding.auth_generation !== null || binding.auth_entry_id !== null || (expectedAuth != null && (expectedAuth.generation !== null || expectedAuth.entryId !== null))) throw new StoreError("attempt_stale");
      return { generation: null, entryId: null };
    }
    if (binding.profile_id === "XP-API" && binding.provider_id === "openrouter") {
      return this.assertCurrentApiAuth(binding, expectedAuth);
    }
    const row = this.database.prepare("SELECT auth_epoch, state, auth_generation, entry_id FROM auth_registry WHERE account_ref = ?").get(binding.account_ref);
    if (row === undefined) {
      if (expectedAuth !== undefined && expectedAuth !== null && (expectedAuth.generation !== null || expectedAuth.entryId !== null)) {
        throw new StoreError("attempt_stale");
      }
      return { generation: null, entryId: null };
    }
    if (expectedAuth !== undefined && expectedAuth !== null && expectedAuth.generation === null) throw new StoreError("attempt_stale");
    if (sqlText(rowValue(row, "state"), "auth-state") !== "ready") throw new StoreError("attempt_stale");
    if (sqlText(rowValue(row, "auth_epoch"), "auth-epoch") !== binding.auth_epoch) throw new StoreError("attempt_stale");
    const generation = parseUuid(rowValue(row, "auth_generation"), "auth-generation");
    const entryId = nullableUuid(row, "entry_id");
    if (expectedAuth !== undefined && expectedAuth !== null) {
      if (expectedAuth.generation !== null && generation !== expectedAuth.generation) throw new StoreError("attempt_stale");
      if (expectedAuth.entryId !== null && entryId !== expectedAuth.entryId) throw new StoreError("attempt_stale");
      if (expectedAuth.entryId === null && entryId !== null) throw new StoreError("attempt_stale");
    }
    if (binding.auth_generation !== null && generation !== binding.auth_generation) throw new StoreError("attempt_stale");
    if (binding.auth_entry_id !== null && entryId !== binding.auth_entry_id) throw new StoreError("attempt_stale");
    return { generation, entryId };
  }

  private assertCurrentApiAuth(binding: AttemptBindingSnapshot, expectedAuth?: CurrentAuth | null): CurrentAuth {
    const row = this.database.prepare("SELECT provider_id, account_ref, entry_id, auth_generation, auth_epoch, state FROM api_auth_registry WHERE provider_id = 'openrouter' AND account_ref = ?").get(binding.account_ref);
    if (row === undefined || sqlText(rowValue(row, "state"), "api-auth-state") !== "ready" || sqlText(rowValue(row, "provider_id"), "api-auth-provider") !== binding.provider_id || sqlText(rowValue(row, "account_ref"), "api-auth-account") !== binding.account_ref || sqlText(rowValue(row, "auth_epoch"), "api-auth-epoch") !== binding.auth_epoch) throw new StoreError("attempt_stale");
    const generation = parseUuid(rowValue(row, "auth_generation"), "api-auth-generation");
    const entryId = parseUuid(rowValue(row, "entry_id"), "api-auth-entry");
    if (expectedAuth !== undefined && expectedAuth !== null && (expectedAuth.generation !== generation || expectedAuth.entryId !== entryId)) throw new StoreError("attempt_stale");
    if (binding.auth_generation !== null && binding.auth_generation !== generation) throw new StoreError("attempt_stale");
    if (binding.auth_entry_id !== null && binding.auth_entry_id !== entryId) throw new StoreError("attempt_stale");
    return { generation, entryId };
  }

  private reservationPolicy(reservation: BudgetReservationRecord): ExecutionBudgetPolicy {
    const key = parseBudgetKey(reservation.budget_key);
    return {
      version: 1,
      budget_tag: key.budget_tag,
      provider_target: key.provider_target,
      daily_start_limit: reservation.daily_start_limit,
      monthly_start_limit: reservation.monthly_start_limit,
      ...(reservation.daily_active_ms_limit === null ? {} : { daily_active_ms_limit: reservation.daily_active_ms_limit }),
      ...(reservation.monthly_active_ms_limit === null ? {} : { monthly_active_ms_limit: reservation.monthly_active_ms_limit }),
      daily_usage_limits: reservation.daily_usage_limits,
      monthly_usage_limits: reservation.monthly_usage_limits,
      usage_reservation_per_phase: reservation.usage_reservation_per_phase,
    };
  }

  private readBudgetTotals(periodKind: "day" | "month", periodValue: string, budgetKey: string): BudgetTotals {
    const periodColumn = periodKind === "day" ? "period_day" : "period_month";
    const row = this.database
      .prepare(
        `WITH ledger AS (
           SELECT budget_key, period_day, period_month, state,
                  reserved_starts, consumed_starts, reserved_active_ms, consumed_active_ms,
                  reserved_input_tokens, consumed_input_tokens,
                  reserved_output_tokens, consumed_output_tokens,
                  reserved_provider_requests, consumed_provider_requests,
                  reserved_credits, consumed_credits
             FROM budget_reservation
           UNION ALL
           SELECT budget_key, period_day, period_month, state,
                  reserved_starts, consumed_starts, reserved_active_ms, consumed_active_ms,
                  reserved_input_tokens, consumed_input_tokens,
                  reserved_output_tokens, consumed_output_tokens,
                  reserved_provider_requests, consumed_provider_requests,
                  reserved_credits, consumed_credits
             FROM budget_reservation_period
         )
         SELECT
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_starts ELSE MAX(reserved_starts, consumed_starts) END), 0) AS starts,
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_active_ms ELSE MAX(reserved_active_ms, consumed_active_ms) END), 0) AS active_ms,
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_input_tokens ELSE MAX(reserved_input_tokens, consumed_input_tokens) END), 0) AS input_tokens,
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_output_tokens ELSE MAX(reserved_output_tokens, consumed_output_tokens) END), 0) AS output_tokens,
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_provider_requests ELSE MAX(reserved_provider_requests, consumed_provider_requests) END), 0) AS provider_requests,
           COALESCE(SUM(CASE WHEN state = 'released' THEN consumed_credits ELSE MAX(reserved_credits, consumed_credits) END), 0) AS credits
           FROM ledger WHERE ${periodColumn} = ? AND budget_key = ?`,
      )
      .get(periodValue, budgetKey);
    if (row === undefined) throw new StoreError("attempt_write_failed");
    return {
      starts: sqlInteger(rowValue(row, "starts"), `${periodKind}-budget-starts`),
      active_ms: sqlInteger(rowValue(row, "active_ms"), `${periodKind}-budget-active-ms`),
      input_tokens: sqlInteger(rowValue(row, "input_tokens"), `${periodKind}-budget-input-tokens`),
      output_tokens: sqlInteger(rowValue(row, "output_tokens"), `${periodKind}-budget-output-tokens`),
      provider_requests: sqlInteger(rowValue(row, "provider_requests"), `${periodKind}-budget-provider-requests`),
      credits: sqlInteger(rowValue(row, "credits"), `${periodKind}-budget-credits`),
    };
  }

  private assertPeriodCapacity(
    day: string,
    month: string,
    budgetKey: string,
    budget: ExecutionBudgetPolicy,
    additional: BudgetAdditional,
    monthAdditional: BudgetAdditional = additional,
  ): void {
    const dayTotals = this.readBudgetTotals("day", day, budgetKey);
    const monthTotals = this.readBudgetTotals("month", month, budgetKey);
    const within = (current: bigint, extra: bigint, limit: number | undefined): void => {
      if (limit !== undefined && current + extra > BigInt(limit)) throw new StoreError("attempt_budget_paused");
    };
    within(dayTotals.starts, additional.starts, budget.daily_start_limit);
    within(monthTotals.starts, monthAdditional.starts, budget.monthly_start_limit);
    within(dayTotals.active_ms, additional.active_ms, budget.daily_active_ms_limit);
    within(monthTotals.active_ms, monthAdditional.active_ms, budget.monthly_active_ms_limit);
    const dailyUsage = usageLimitsForPeriod(budget, "day");
    const monthlyUsage = usageLimitsForPeriod(budget, "month");
    within(dayTotals.input_tokens, additional.input_tokens, dailyUsage.input_tokens);
    within(monthTotals.input_tokens, monthAdditional.input_tokens, monthlyUsage.input_tokens);
    within(dayTotals.output_tokens, additional.output_tokens, dailyUsage.output_tokens);
    within(monthTotals.output_tokens, monthAdditional.output_tokens, monthlyUsage.output_tokens);
    within(dayTotals.provider_requests, additional.provider_requests, dailyUsage.provider_requests);
    within(monthTotals.provider_requests, monthAdditional.provider_requests, monthlyUsage.provider_requests);
    within(dayTotals.credits, additional.credits, dailyUsage.credits?.amount);
    within(monthTotals.credits, monthAdditional.credits, monthlyUsage.credits?.amount);
  }

  private aggregateBudgetViolations(
    reservation: BudgetReservationRecord,
    accountingPeriodDay = reservation.period_day,
    accountingPeriodMonth = reservation.period_month,
  ): string[] {
    const budget = this.reservationPolicy(reservation);
    const dayTotals = this.readBudgetTotals("day", accountingPeriodDay, reservation.budget_key);
    const monthTotals = this.readBudgetTotals("month", accountingPeriodMonth, reservation.budget_key);
    const violations: string[] = [];
    const over = (current: bigint, limit: number | undefined, dayCode: string, monthCode: string, period: "day" | "month"): void => {
      if (limit !== undefined && current > BigInt(limit)) violations.push(period === "day" ? dayCode : monthCode);
    };
    over(dayTotals.starts, budget.daily_start_limit, "daily_start_limit", "monthly_start_limit", "day");
    over(monthTotals.starts, budget.monthly_start_limit, "daily_start_limit", "monthly_start_limit", "month");
    over(dayTotals.active_ms, budget.daily_active_ms_limit, "daily_active_time_limit", "monthly_active_time_limit", "day");
    over(monthTotals.active_ms, budget.monthly_active_ms_limit, "daily_active_time_limit", "monthly_active_time_limit", "month");
    over(dayTotals.input_tokens, budget.daily_usage_limits.input_tokens, "daily_input_tokens_limit", "monthly_input_tokens_limit", "day");
    over(monthTotals.input_tokens, budget.monthly_usage_limits.input_tokens, "daily_input_tokens_limit", "monthly_input_tokens_limit", "month");
    over(dayTotals.output_tokens, budget.daily_usage_limits.output_tokens, "daily_output_tokens_limit", "monthly_output_tokens_limit", "day");
    over(monthTotals.output_tokens, budget.monthly_usage_limits.output_tokens, "daily_output_tokens_limit", "monthly_output_tokens_limit", "month");
    over(dayTotals.provider_requests, budget.daily_usage_limits.provider_requests, "daily_provider_requests_limit", "monthly_provider_requests_limit", "day");
    over(monthTotals.provider_requests, budget.monthly_usage_limits.provider_requests, "daily_provider_requests_limit", "monthly_provider_requests_limit", "month");
    over(dayTotals.credits, budget.daily_usage_limits.credits?.amount, "daily_credits_limit", "monthly_credits_limit", "day");
    over(monthTotals.credits, budget.monthly_usage_limits.credits?.amount, "daily_credits_limit", "monthly_credits_limit", "month");
    return [...new Set(violations)];
  }

  private rolloverBatchReservations(batchId: string, periods: { readonly day: string; readonly month: string }, now: string): void {
    const reservations = this.database
      .prepare(
        `SELECT reservation_id, batch_id, phase, period_day, period_month, budget_key,
                daily_start_limit, monthly_start_limit, daily_active_ms_limit,
                monthly_active_ms_limit, daily_usage_limits_json, monthly_usage_limits_json,
                usage_reservation_json, reserved_input_tokens, reserved_output_tokens,
                reserved_provider_requests, reserved_credits, consumed_input_tokens,
                consumed_output_tokens, consumed_provider_requests, consumed_credits,
                reserved_starts, consumed_starts, reserved_active_ms, consumed_active_ms,
                state, created_at, updated_at
           FROM budget_reservation WHERE batch_id = ? ORDER BY phase`,
      )
      .all(batchId)
      .map(parseReservationRow);
    const rollovers: Array<{ readonly reservation: BudgetReservationRecord; readonly remaining: BudgetAdditional }> = [];
    for (const reservation of reservations) {
      if (reservation.period_day === periods.day && reservation.period_month === periods.month) continue;
      if (reservation.state !== "active") continue;
      const live = this.database
        .prepare(
          `SELECT 1 FROM execution_attempt
             WHERE reservation_id = ?
               AND (state IN ('dispatch_intent', 'session_observed', 'prompt_dispatched', 'cleanup_pending')
                    OR cleanup_state IN ('pending', 'unknown')) LIMIT 1`,
        )
        .get(reservation.reservation_id);
      if (live !== undefined) throw new StoreError("attempt_budget_paused");
      const remaining: BudgetAdditional = {
        starts: BigInt(Math.max(0, reservation.reserved_starts - reservation.consumed_starts)),
        active_ms: BigInt(Math.max(0, reservation.reserved_active_ms - reservation.consumed_active_ms)),
        input_tokens: BigInt(Math.max(0, reservation.reserved_input_tokens - reservation.consumed_input_tokens)),
        output_tokens: BigInt(Math.max(0, reservation.reserved_output_tokens - reservation.consumed_output_tokens)),
        provider_requests: BigInt(Math.max(0, reservation.reserved_provider_requests - reservation.consumed_provider_requests)),
        credits: BigInt(Math.max(0, reservation.reserved_credits - reservation.consumed_credits)),
      };
      rollovers.push({ reservation, remaining });
    }
    if (rollovers.length === 0) return;
    const sumRemaining = (field: keyof BudgetAdditional): bigint => rollovers.reduce((total, entry) => total + entry.remaining[field], 0n);
    const sumOldMonthly = (field: keyof BudgetAdditional): bigint => rollovers.reduce((total, entry) => {
      if (entry.reservation.period_month !== periods.month) return total;
      const reservation = entry.reservation;
      const oldValue = field === "starts"
        ? reservation.reserved_starts
        : field === "active_ms"
          ? reservation.reserved_active_ms
          : field === "input_tokens"
            ? reservation.reserved_input_tokens
            : field === "output_tokens"
              ? reservation.reserved_output_tokens
              : field === "provider_requests"
                ? reservation.reserved_provider_requests
                : reservation.reserved_credits;
      const consumedValue = field === "starts"
        ? reservation.consumed_starts
        : field === "active_ms"
          ? reservation.consumed_active_ms
          : field === "input_tokens"
            ? reservation.consumed_input_tokens
            : field === "output_tokens"
              ? reservation.consumed_output_tokens
              : field === "provider_requests"
                ? reservation.consumed_provider_requests
                : reservation.consumed_credits;
      return total + BigInt(Math.max(oldValue, consumedValue));
    }, 0n);
    const dayAdditional: BudgetAdditional = {
      starts: sumRemaining("starts"),
      active_ms: sumRemaining("active_ms"),
      input_tokens: sumRemaining("input_tokens"),
      output_tokens: sumRemaining("output_tokens"),
      provider_requests: sumRemaining("provider_requests"),
      credits: sumRemaining("credits"),
    };
    const monthAdditional: BudgetAdditional = {
      starts: dayAdditional.starts - sumOldMonthly("starts"),
      active_ms: dayAdditional.active_ms - sumOldMonthly("active_ms"),
      input_tokens: dayAdditional.input_tokens - sumOldMonthly("input_tokens"),
      output_tokens: dayAdditional.output_tokens - sumOldMonthly("output_tokens"),
      provider_requests: dayAdditional.provider_requests - sumOldMonthly("provider_requests"),
      credits: dayAdditional.credits - sumOldMonthly("credits"),
    };
    const policy = this.reservationPolicy(rollovers[0]!.reservation);
    if (rollovers.some((entry) => entry.reservation.budget_key !== rollovers[0]!.reservation.budget_key)) throw new StoreError("attempt_conflict");
    this.assertPeriodCapacity(periods.day, periods.month, rollovers[0]!.reservation.budget_key, policy, dayAdditional, monthAdditional);
    for (const { reservation, remaining } of rollovers) {
      const history = this.database
        .prepare(
          `INSERT INTO budget_reservation_period (
             period_id, reservation_id, budget_key, period_day, period_month,
             reserved_starts, consumed_starts, reserved_active_ms, consumed_active_ms,
             reserved_input_tokens, reserved_output_tokens, reserved_provider_requests,
             reserved_credits, consumed_input_tokens, consumed_output_tokens,
             consumed_provider_requests, consumed_credits, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'released', ?, ?)`,
        )
        .run(
          randomUUID(),
          reservation.reservation_id,
          reservation.budget_key,
          reservation.period_day,
          reservation.period_month,
          reservation.consumed_starts,
          reservation.consumed_starts,
          reservation.consumed_active_ms,
          reservation.consumed_active_ms,
          reservation.consumed_input_tokens,
          reservation.consumed_output_tokens,
          reservation.consumed_provider_requests,
          reservation.consumed_credits,
          reservation.consumed_input_tokens,
          reservation.consumed_output_tokens,
          reservation.consumed_provider_requests,
          reservation.consumed_credits,
          now,
          now,
        );
      if (sqlInteger(history.changes, "reservation-period-insert-changes") !== 1n) throw new StoreError("attempt_write_failed");
      const update = this.database
        .prepare(
          `UPDATE budget_reservation
              SET period_day = ?, period_month = ?,
                  reserved_starts = ?, consumed_starts = 0,
                  reserved_active_ms = ?, consumed_active_ms = 0,
                  reserved_input_tokens = ?, consumed_input_tokens = 0,
                  reserved_output_tokens = ?, consumed_output_tokens = 0,
                  reserved_provider_requests = ?, consumed_provider_requests = 0,
                  reserved_credits = ?, consumed_credits = 0,
                  state = CASE WHEN ? > 0 THEN 'active' ELSE 'released' END,
                  updated_at = ?
            WHERE reservation_id = ? AND state = 'active'`,
        )
        .run(
          periods.day,
          periods.month,
          Number(remaining.starts),
          Number(remaining.active_ms),
          Number(remaining.input_tokens),
          Number(remaining.output_tokens),
          Number(remaining.provider_requests),
          Number(remaining.credits),
          Number(remaining.starts),
          now,
          reservation.reservation_id,
        );
      if (sqlInteger(update.changes, "reservation-rollover-changes") !== 1n) throw new StoreError("attempt_conflict");
    }
  }

  private assertBudgetCapacity(day: string, month: string, budgetKey: string, budget: ExecutionBudgetPolicy): void {
    const existingPolicy = this.database
      .prepare(
        `SELECT daily_start_limit, monthly_start_limit, daily_active_ms_limit, monthly_active_ms_limit,
                daily_usage_limits_json, monthly_usage_limits_json, usage_reservation_json
           FROM budget_reservation WHERE budget_key = ? LIMIT 1`,
      )
      .get(budgetKey);
    if (existingPolicy !== undefined) {
      const sameOptional = (column: string, expected: number | undefined): boolean => {
        const value = rowValue(existingPolicy, column);
        return (value === null ? undefined : safeNumber(value, column)) === expected;
      };
      if (
        safeNumber(rowValue(existingPolicy, "daily_start_limit"), "daily-start-limit") !== budget.daily_start_limit ||
        safeNumber(rowValue(existingPolicy, "monthly_start_limit"), "monthly-start-limit") !== budget.monthly_start_limit ||
        !sameOptional("daily_active_ms_limit", budget.daily_active_ms_limit) ||
        !sameOptional("monthly_active_ms_limit", budget.monthly_active_ms_limit) ||
        canonicalUsageLimits(parseUsageLimits(rowValue(existingPolicy, "daily_usage_limits_json"))) !== canonicalUsageLimits(usageLimitsForPeriod(budget, "day")) ||
        canonicalUsageLimits(parseUsageLimits(rowValue(existingPolicy, "monthly_usage_limits_json"))) !== canonicalUsageLimits(usageLimitsForPeriod(budget, "month")) ||
        canonicalUsageLimits(parseUsageLimits(rowValue(existingPolicy, "usage_reservation_json"))) !== canonicalUsageLimits(budget.usage_reservation_per_phase)
      ) throw new StoreError("attempt_conflict");
    }
    const doubled = (value: number | undefined): bigint => BigInt(value ?? 0) * 2n;
    this.assertPeriodCapacity(day, month, budgetKey, budget, {
      starts: BigInt(EXECUTION_BATCH_LIMITS.max_starts_total),
      active_ms: BigInt(EXECUTION_BATCH_LIMITS.max_active_ms_total),
      input_tokens: doubled(budget.usage_reservation_per_phase.input_tokens),
      output_tokens: doubled(budget.usage_reservation_per_phase.output_tokens),
      provider_requests: doubled(budget.usage_reservation_per_phase.provider_requests),
      credits: doubled(budget.usage_reservation_per_phase.credits?.amount),
    });
  }

  private assertReservationPolicy(batchId: string, expectedBudgetKey: string, budget: ExecutionBudgetPolicy): void {
    const rows = this.database.prepare("SELECT budget_key, daily_start_limit, monthly_start_limit, daily_active_ms_limit, monthly_active_ms_limit, daily_usage_limits_json, monthly_usage_limits_json, usage_reservation_json FROM budget_reservation WHERE batch_id = ? ORDER BY phase").all(batchId);
    if (rows.length !== 2) throw new StoreError("attempt_invalid");
    for (const row of rows) {
      const dailyStored = parseUsageLimits(rowValue(row, "daily_usage_limits_json"));
      const monthlyStored = parseUsageLimits(rowValue(row, "monthly_usage_limits_json"));
      const reservationStored = parseUsageLimits(rowValue(row, "usage_reservation_json"));
      if (
        sqlText(rowValue(row, "budget_key"), "budget-key") !== expectedBudgetKey ||
        safeNumber(rowValue(row, "daily_start_limit"), "daily-start-limit") !== budget.daily_start_limit ||
        safeNumber(rowValue(row, "monthly_start_limit"), "monthly-start-limit") !== budget.monthly_start_limit ||
        (rowValue(row, "daily_active_ms_limit") === null ? undefined : safeNumber(rowValue(row, "daily_active_ms_limit"), "daily-active-limit")) !== budget.daily_active_ms_limit ||
        (rowValue(row, "monthly_active_ms_limit") === null ? undefined : safeNumber(rowValue(row, "monthly_active_ms_limit"), "monthly-active-limit")) !== budget.monthly_active_ms_limit ||
        canonicalUsageLimits(dailyStored) !== canonicalUsageLimits(usageLimitsForPeriod(budget, "day")) ||
        canonicalUsageLimits(monthlyStored) !== canonicalUsageLimits(usageLimitsForPeriod(budget, "month")) ||
        canonicalUsageLimits(reservationStored) !== canonicalUsageLimits(budget.usage_reservation_per_phase)
      ) throw new StoreError("attempt_conflict");
    }
  }

  private remainingDeadline(batch: ExecutionBatchRecord, phase: ExecutionPhase, deadline: string, now: string): string {
    const usage = this.lineageUsage(batch);
    const phaseMs = phase === "extract" ? usage.extract_active_ms : usage.verify_active_ms;
    const remaining = Math.min(EXECUTION_BATCH_LIMITS.max_active_ms_per_phase - phaseMs, EXECUTION_BATCH_LIMITS.max_active_ms_total - usage.active_ms);
    if (remaining <= 0) throw new StoreError("attempt_budget_paused");
    if (!isBefore(now, deadline)) throw new StoreError("attempt_deadline");
    return new Date(Math.min(Date.parse(deadline), Date.parse(now) + remaining)).toISOString();
  }

  /** Sum starts and active time across one automatic auth-recovery lineage. */
  private lineageUsage(batch: ExecutionBatchRecord): LineageUsage {
    const jobIds = this.lineageJobIds(batch);
    const placeholders = jobIds.map(() => "?").join(", ");
    const row = this.database
      .prepare(
        `WITH batches AS (
           SELECT batch_id, extract_starts, verify_starts, total_starts
             FROM execution_batch
            WHERE job_id IN (${placeholders})
         ), attempts AS (
           SELECT a.phase, a.active_ms
             FROM execution_attempt AS a
             JOIN batches AS b ON b.batch_id = a.batch_id
         )
         SELECT
           COALESCE((SELECT SUM(extract_starts) FROM batches), 0) AS extract_starts,
           COALESCE((SELECT SUM(verify_starts) FROM batches), 0) AS verify_starts,
           COALESCE((SELECT SUM(total_starts) FROM batches), 0) AS total_starts,
           COALESCE((SELECT SUM(active_ms) FROM attempts WHERE phase = 'extract'), 0) AS extract_active_ms,
           COALESCE((SELECT SUM(active_ms) FROM attempts WHERE phase = 'verify'), 0) AS verify_active_ms,
           COALESCE((SELECT SUM(active_ms) FROM attempts), 0) AS active_ms
         FROM (SELECT 1)`,
      )
      .get(...jobIds);
    if (row === undefined) throw new StoreError("attempt_write_failed");
    return {
      extract_starts: safeNumber(rowValue(row, "extract_starts"), "lineage-extract-starts"),
      verify_starts: safeNumber(rowValue(row, "verify_starts"), "lineage-verify-starts"),
      total_starts: safeNumber(rowValue(row, "total_starts"), "lineage-total-starts"),
      extract_active_ms: safeNumber(rowValue(row, "extract_active_ms"), "lineage-extract-active-ms"),
      verify_active_ms: safeNumber(rowValue(row, "verify_active_ms"), "lineage-verify-active-ms"),
      active_ms: safeNumber(rowValue(row, "active_ms"), "lineage-active-ms"),
    };
  }

  private lineageJobIds(batch: ExecutionBatchRecord): readonly string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    let jobId = batch.job_id;
    let taskVersion = batch.task_version;
    const part = extractionTaskPart(taskVersion);
    for (let depth = 0; depth < MAX_AUTH_RECOVERY_LINEAGE; depth += 1) {
      if (seen.has(jobId)) break;
      seen.add(jobId);
      ids.push(jobId);
      const recovery = recoveryTaskVersionPattern.exec(taskVersion);
      if (recovery === null) break;
      const parentId = recovery[1];
      if (parentId === undefined || recovery[2] !== part) break;
      const parent = this.database
        .prepare("SELECT job_id, scope_id, source_capture_id, task_kind, task_version FROM job WHERE job_id = ?")
        .get(parentId);
      if (
        parent === undefined ||
        sqlText(rowValue(parent, "scope_id"), "lineage-parent-scope") !== batch.scope_id ||
        sqlText(rowValue(parent, "source_capture_id"), "lineage-parent-source") !== batch.source_capture_id ||
        sqlText(rowValue(parent, "task_kind"), "lineage-parent-kind") !== "extract"
      ) break;
      const parentTaskVersion = sqlText(rowValue(parent, "task_version"), "lineage-parent-version");
      if (extractionTaskPart(parentTaskVersion) !== part) break;
      jobId = parentId;
      taskVersion = parentTaskVersion;
    }
    if (recoveryTaskVersionPattern.test(taskVersion)) throw new StoreError("attempt_stale");
    return ids;
  }

  private releaseUnusedReservation(reservationId: string, now: string): void {
    this.database
      .prepare(
        `UPDATE budget_reservation
            SET reserved_starts = consumed_starts,
                reserved_input_tokens = consumed_input_tokens,
                reserved_output_tokens = consumed_output_tokens,
                reserved_provider_requests = consumed_provider_requests,
                reserved_credits = consumed_credits,
                reserved_active_ms = consumed_active_ms,
                state = 'released', updated_at = ?
          WHERE reservation_id = ? AND state IN ('active', 'uncertain')`,
      )
      .run(now, reservationId);
  }

  private isCurrentAccountingPeriod(current: ExecutionAttemptRecord, reservation: BudgetReservationRecord): boolean {
    return current.accounting_period_day === reservation.period_day && current.accounting_period_month === reservation.period_month;
  }

  private setAccountingState(
    current: ExecutionAttemptRecord,
    reservation: BudgetReservationRecord,
    state: "active" | "uncertain",
    now: string,
  ): void {
    if (this.isCurrentAccountingPeriod(current, reservation)) {
      this.database
        .prepare("UPDATE budget_reservation SET state = CASE WHEN state = 'released' THEN state ELSE ? END, updated_at = ? WHERE reservation_id = ?")
        .run(state, now, reservation.reservation_id);
      return;
    }
    if (current.accounting_period_day === null || current.accounting_period_month === null) throw new StoreError("attempt_invalid");
    this.database
      .prepare(
        `UPDATE budget_reservation_period
            SET state = ?, updated_at = ?
          WHERE reservation_id = ? AND period_day = ? AND period_month = ?`,
      )
      .run(state === "uncertain" ? "uncertain" : "released", now, reservation.reservation_id, current.accounting_period_day, current.accounting_period_month);
  }

  private incrementAttemptAccountingUsage(
    current: ExecutionAttemptRecord,
    delta: { readonly input_tokens: number; readonly output_tokens: number; readonly provider_requests: number; readonly credits: number },
    activeMs: number,
    now: string,
  ): void {
    if (current.accounting_period_day === null || current.accounting_period_month === null) throw new StoreError("attempt_invalid");
    if (this.isCurrentAccountingPeriod(current, this.requireReservation(current.reservation_id))) {
      const updated = this.database
        .prepare(
          `UPDATE budget_reservation
              SET consumed_input_tokens = consumed_input_tokens + ?,
                  consumed_output_tokens = consumed_output_tokens + ?,
                  consumed_provider_requests = consumed_provider_requests + ?,
                  consumed_credits = consumed_credits + ?,
                  consumed_active_ms = consumed_active_ms + ?,
                  updated_at = ?
            WHERE reservation_id = ?`,
        )
        .run(delta.input_tokens, delta.output_tokens, delta.provider_requests, delta.credits, activeMs, now, current.reservation_id);
      if (sqlInteger(updated.changes, "reservation-usage-changes") !== 1n) throw new StoreError("attempt_write_failed");
      return;
    }
    const updated = this.database
      .prepare(
        `UPDATE budget_reservation_period
            SET consumed_input_tokens = consumed_input_tokens + ?,
                consumed_output_tokens = consumed_output_tokens + ?,
                consumed_provider_requests = consumed_provider_requests + ?,
                consumed_credits = consumed_credits + ?,
                consumed_active_ms = consumed_active_ms + ?,
                updated_at = ?
          WHERE reservation_id = ? AND period_day = ? AND period_month = ?`,
      )
      .run(delta.input_tokens, delta.output_tokens, delta.provider_requests, delta.credits, activeMs, now, current.reservation_id, current.accounting_period_day, current.accounting_period_month);
    if (sqlInteger(updated.changes, "reservation-usage-changes") !== 1n) throw new StoreError("attempt_write_failed");
  }

  private readNow(): string {
    if (this.clock !== undefined) return parseDate(this.clock(), "attempt-clock-now");
    const row = this.database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get();
    return parseDate(rowValue(row, "now"), "sqlite-clock-now");
  }

  private transaction<T>(operation: () => T): T {
    this.ensureOpen();
    let committed = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.database.exec("COMMIT");
      committed = true;
      return result;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the primary attempt failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }
}
