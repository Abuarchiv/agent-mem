import { z } from "zod";

const positiveIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const periodSchema = z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/);
const usageUnitSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/);
const budgetTagSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/);
export const creditUsageSchema = z
  .object({
    // This is a provider-reported integer in the named unit. It is never
    // derived from input/output tokens or converted to currency.
    amount: nonNegativeIntegerSchema,
    unit: usageUnitSchema,
    scale: positiveIntegerSchema,
  })
  .strict();
const creditLimitSchema = creditUsageSchema.extend({ amount: positiveIntegerSchema });

export const usageLimitsSchema = z
  .object({
    input_tokens: positiveIntegerSchema.optional(),
    output_tokens: positiveIntegerSchema.optional(),
    provider_requests: positiveIntegerSchema.optional(),
    credits: creditLimitSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.input_tokens === undefined && value.output_tokens === undefined && value.provider_requests === undefined && value.credits === undefined) {
      context.addIssue({ code: "custom", path: [], message: "usage_limit_required" });
    }
  });

export const executionBudgetPolicySchema = z
  .object({
    version: z.literal(1),
    budget_tag: budgetTagSchema,
    provider_target: z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/),
    daily_start_limit: positiveIntegerSchema,
    monthly_start_limit: positiveIntegerSchema,
    daily_active_ms_limit: positiveIntegerSchema.optional(),
    monthly_active_ms_limit: positiveIntegerSchema.optional(),
    daily_usage_limits: usageLimitsSchema,
    monthly_usage_limits: usageLimitsSchema,
    usage_reservation_per_phase: usageLimitsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.daily_start_limit > value.monthly_start_limit) {
      context.addIssue({ code: "custom", path: ["daily_start_limit"], message: "daily_limit_exceeds_monthly_limit" });
    }
    if (value.daily_active_ms_limit !== undefined && value.monthly_active_ms_limit !== undefined && value.daily_active_ms_limit > value.monthly_active_ms_limit) {
      context.addIssue({ code: "custom", path: ["daily_active_ms_limit"], message: "daily_limit_exceeds_monthly_limit" });
    }
    const daily = value.daily_usage_limits;
    const monthly = value.monthly_usage_limits;
    for (const dimension of ["input_tokens", "output_tokens", "provider_requests"] as const) {
      const dailyLimit = daily?.[dimension];
      const monthlyLimit = monthly?.[dimension];
      const reservation = value.usage_reservation_per_phase[dimension];
      if ((dailyLimit !== undefined || monthlyLimit !== undefined) && reservation === undefined) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", dimension], message: "usage_reservation_required" });
      }
      if (dailyLimit !== undefined && reservation !== undefined && reservation > dailyLimit) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", dimension], message: "usage_reservation_exceeds_daily_limit" });
      }
      if (monthlyLimit !== undefined && reservation !== undefined && reservation > monthlyLimit) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", dimension], message: "usage_reservation_exceeds_monthly_limit" });
      }
      if (dailyLimit === undefined && monthlyLimit === undefined && reservation !== undefined) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", dimension], message: "usage_limit_required_for_reservation" });
      }
    }
    const dailyCredits = daily.credits;
    const monthlyCredits = monthly.credits;
    const reservedCredits = value.usage_reservation_per_phase.credits;
    if (dailyCredits !== undefined && monthlyCredits !== undefined && (dailyCredits.unit !== monthlyCredits.unit || dailyCredits.scale !== monthlyCredits.scale)) {
      context.addIssue({ code: "custom", path: ["monthly_usage_limits", "credits"], message: "periodic_credit_unit_mismatch" });
    }
    if ((dailyCredits !== undefined || monthlyCredits !== undefined) && reservedCredits === undefined) {
      context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_reservation_required" });
    }
    if (dailyCredits !== undefined && reservedCredits !== undefined) {
      if (dailyCredits.unit !== reservedCredits.unit || dailyCredits.scale !== reservedCredits.scale) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_unit_mismatch" });
      } else if (reservedCredits.amount > dailyCredits.amount) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_reservation_exceeds_daily_limit" });
      }
    }
    if (monthlyCredits !== undefined && reservedCredits !== undefined) {
      if (monthlyCredits.unit !== reservedCredits.unit || monthlyCredits.scale !== reservedCredits.scale) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_unit_mismatch" });
      } else if (reservedCredits.amount > monthlyCredits.amount) {
        context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_reservation_exceeds_monthly_limit" });
      }
    }
    if (dailyCredits === undefined && monthlyCredits === undefined && reservedCredits !== undefined) {
      context.addIssue({ code: "custom", path: ["usage_reservation_per_phase", "credits"], message: "usage_limit_required_for_reservation" });
    }
  });

export type ExecutionUsageLimits = z.infer<typeof usageLimitsSchema>;

export interface ExecutionBudgetPolicy {
  readonly version: 1;
  readonly budget_tag: string;
  readonly provider_target: string;
  readonly daily_start_limit: number;
  readonly monthly_start_limit: number;
  readonly daily_active_ms_limit?: number;
  readonly monthly_active_ms_limit?: number;
  readonly daily_usage_limits: ExecutionUsageLimits;
  readonly monthly_usage_limits: ExecutionUsageLimits;
  readonly usage_reservation_per_phase: ExecutionUsageLimits;
}

export function usageLimitsForPeriod(policy: ExecutionBudgetPolicy, period: "day" | "month"): ExecutionUsageLimits {
  return period === "day" ? policy.daily_usage_limits : policy.monthly_usage_limits;
}

export const EXECUTION_BATCH_LIMITS = Object.freeze({
  max_starts_per_phase: 2,
  max_starts_total: 4,
  max_active_ms_per_phase: 60_000,
  max_active_ms_total: 120_000,
} as const);

export const executionPhaseSchema = z.enum(["extract", "verify"]);
export type ExecutionPhase = z.infer<typeof executionPhaseSchema>;

export interface BudgetReservationPlan {
  readonly phase: ExecutionPhase;
  readonly reserved_starts: 2;
  readonly reserved_active_ms: 60_000;
  readonly reserved_usage: ExecutionUsageLimits;
}

export function parseExecutionBudgetPolicy(input: unknown): ExecutionBudgetPolicy {
  return executionBudgetPolicySchema.parse(input) as ExecutionBudgetPolicy;
}

export function reservationPlans(policy: ExecutionBudgetPolicy): readonly [BudgetReservationPlan, BudgetReservationPlan] {
  return [
    { phase: "extract", reserved_starts: 2, reserved_active_ms: 60_000, reserved_usage: policy.usage_reservation_per_phase },
    { phase: "verify", reserved_starts: 2, reserved_active_ms: 60_000, reserved_usage: policy.usage_reservation_per_phase },
  ];
}

export function periodKeys(now: string): { readonly day: string; readonly month: string } {
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw new Error("budget_clock_invalid");
  const iso = parsed.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

export function parsePeriod(value: unknown, kind: "day" | "month"): string {
  const parsed = periodSchema.parse(value);
  if (kind === "day" && parsed.length !== 10) throw new Error("budget_period_invalid");
  if (kind === "month" && parsed.length !== 7) throw new Error("budget_period_invalid");
  return parsed;
}

export function safeCounter(value: unknown, field: string): number {
  const parsed = nonNegativeIntegerSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${field}_invalid`);
  return parsed.data;
}
