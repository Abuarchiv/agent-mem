import { createHash } from "node:crypto";

import {
  assertDispatchMode,
  parseRequest,
  requireActiveExecutionBinding,
  validateDispatch,
  type DispatchMode,
  type TrustedExecutionBinding,
} from "./profile.js";
import type { ExecutionResult } from "./types.js";
import type { AgentMemoryDatabase, ExecutionSourceReference } from "../store/database.js";
import type { JobClaim } from "../store/job-repository.js";
import {
  type AttemptBindingSnapshot,
  type AttemptCompletionInput,
  type AttemptCompletionResult,
  type AttemptControlInput,
  type AttemptUsageInput,
  type BeginExecutionBatchInput,
  type ExecutionAttemptRecord,
  type ExecutionBatchRecord,
  type PrepareExecutionAttemptInput,
} from "../store/attempt-repository.js";
import { executionPhaseSchema, type ExecutionBudgetPolicy, type ExecutionPhase } from "./budget.js";
import type { RegisterRuntimeArtifactInput, RuntimeArtifactRecord } from "../store/runtime-artifact-repository.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export interface ExecutionLifecycleCallbacks {
  /**
   * The durable attempt intent must settle before the runtime is created. A
   * provider that has an owned credential envelope supplies its actual
   * identity here so the lifecycle can bind it to the reserved attempt.
   */
  readonly beforeRuntimeStart?: (authIdentity?: ExecutionAuthIdentity, artifact?: RegisterRuntimeArtifactInput) => Promise<void>;
  readonly runtimeArtifactPresent?: () => Promise<void>;
  readonly runtimeArtifactCreationAttempted?: () => Promise<void>;
  readonly executionClosed?: () => Promise<void>;
  /** Record the provider/runtime session identity before sending model input. */
  readonly sessionObserved?: (runtimeSessionId: string) => Promise<void>;
  /** The durable prompt checkpoint must settle before the provider call. */
  readonly beforePromptDispatch?: () => Promise<void>;
  /** Record terminal state and any observed counters; this is not semantic verification. */
  readonly terminalObserved?: (status: ExecutionResult["status"], usage?: AttemptUsageInput, providerAttemptId?: string) => Promise<void>;
  /**
   * The executor failed before any dispatch intent was committed, so the
   * prepared attempt is a known failure: record it and release the unused
   * reservation. Never called after a dispatch intent exists.
   */
  readonly dispatchCancelled?: (reason: string) => Promise<void>;
  /** Cleanup is only confirmed when the executor has actually observed it. */
  readonly cleanupCompleted?: (input: { readonly confirmed: boolean; readonly reason?: string }) => Promise<void>;
  readonly nativeSessionRemoved?: (runtimeSessionId: string) => Promise<void>;
}

/** A lifecycle admission check rejected before dispatch intent was committed. */
export class ExecutionLifecycleAdmissionError extends Error {
  override readonly name = "ExecutionLifecycleAdmissionError";
}

/** Provider auth identity carried only across the pre-runtime checkpoint. */
export interface ExecutionAuthIdentity {
  readonly account_ref: string;
  readonly auth_epoch: string;
  readonly auth_generation: string;
  readonly auth_entry_id: string;
}

/**
 * Checkpoints are awaited, but a broken store must not hold a provider lane
 * forever. The operation remains observed by the promise chain if it settles
 * after the bound; callers must then keep the attempt conservative.
 */
export async function awaitLifecycleCheckpoint<T>(
  operation: () => Promise<T> | T,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeout:lifecycle_checkpoint");
  if (signal?.aborted) throw new Error("aborted:lifecycle_checkpoint");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout:lifecycle_checkpoint")), timeoutMs);
    timer.unref?.();
  });
  const abortPromise = signal === undefined
    ? new Promise<T>(() => undefined)
    : new Promise<T>((_, reject) => {
        const onAbort = (): void => reject(new Error("aborted:lifecycle_checkpoint"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      });
  try {
    return await Promise.race([operationPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

export interface DispatchBatchInput {
  readonly batch_id?: string;
  readonly claim: JobClaim;
  readonly request: unknown;
  readonly binding: unknown;
  readonly budget: ExecutionBudgetPolicy;
  readonly dispatch_mode: DispatchMode;
  /** Generation read from the owned auth envelope after its current-state check. */
  readonly auth_generation?: string | null;
  /** Entry ID read from the owned auth envelope; binds the actual credential to the reservation. */
  readonly auth_entry_id?: string | null;
  /** T11 extraction batches may contain the registered source closure. */
  readonly source_closure?: boolean;
}

export interface PreparedExecutionBatch {
  readonly batch: ExecutionBatchRecord;
  readonly request: ReturnType<typeof parseRequest>;
  readonly claim: JobClaim;
  readonly dispatch_mode: DispatchMode;
  readonly binding: TrustedExecutionBinding;
  readonly binding_snapshot: AttemptBindingSnapshot;
  readonly source_closure: boolean;
}

export interface DispatchAttemptInput {
  readonly batch: PreparedExecutionBatch;
  readonly request: unknown;
  readonly attempt_id?: string;
}

export interface PreparedExecutionAttempt {
  readonly batch: PreparedExecutionBatch;
  readonly request: ReturnType<typeof parseRequest>;
  readonly attempt: ExecutionAttemptRecord;
  readonly control: AttemptControlInput;
}

function bindingSnapshot(
  binding: TrustedExecutionBinding,
  authGeneration: string | null,
  authEntryId: string | null,
): AttemptBindingSnapshot {
  return {
    binding_id: binding.binding_id,
    profile_hash: binding.profile_hash,
    profile_id: binding.profile.profile_id,
    runtime_id: binding.profile.runtime_id,
    model_id: binding.profile.model_id,
    reasoning: binding.profile.reasoning ?? null,
    provider_id: binding.provider_id,
    provider_target: `provider:${binding.provider_id}`,
    account_ref: binding.account_ref,
    auth_epoch: binding.profile.auth_epoch,
    auth_generation: authGeneration,
    auth_entry_id: authEntryId,
    allowed_scope_ids: [...binding.profile.allowed_scope_ids],
  };
}

function validatePhase(value: string): ExecutionPhase {
  const parsed = executionPhaseSchema.safeParse(value);
  if (!parsed.success || (parsed.data !== "extract" && parsed.data !== "verify")) throw new Error("attempt_phase_invalid");
  return parsed.data;
}

export function prepareExecutionBatch(database: AgentMemoryDatabase, input: DispatchBatchInput): PreparedExecutionBatch {
  const binding = requireActiveExecutionBinding(input.binding);
  const mode = assertDispatchMode(input.dispatch_mode);
  if (mode === "live" && (input.auth_generation === undefined || input.auth_generation === null)) {
    throw new Error("auth_generation_required");
  }
  const request = validateDispatch(input.request, binding, new Date(), mode);
  // Require explicit entry binding for live after qualification checks so the
  // existing live-qualification gate keeps precedence in tests.
  if (mode === "live" && input.auth_entry_id === undefined) {
    throw new Error("auth_entry_required");
  }
  validatePhase(request.phase);
  if (request.job_id !== input.claim.job_id) throw new Error("attempt_job_mismatch");
  if (input.source_closure === true) {
    assertExecutionSourceClosure(database, input.claim.scope_id, `provider:${binding.provider_id}`, request.source_spans);
  } else {
    assertPrimaryExecutionSources(database, input.claim.scope_id, input.claim.source_capture_id, `provider:${binding.provider_id}`, request.source_spans);
  }
  const snapshot = bindingSnapshot(binding, input.auth_generation ?? null, input.auth_entry_id ?? null);
  const requestDigest = digest({ request, input_fingerprint: input.claim.input_fingerprint, input_privacy_epoch: input.claim.input_privacy_epoch });
  const begin: BeginExecutionBatchInput = {
    ...(input.batch_id === undefined ? {} : { batch_id: input.batch_id }),
    claim: input.claim,
    request_digest: requestDigest,
    binding: snapshot,
    budget: input.budget,
  };
  const batch = database.attempts!.beginBatch(begin);
  return { batch, request, claim: input.claim, dispatch_mode: mode, binding, binding_snapshot: snapshot, source_closure: input.source_closure === true };
}

export function prepareExecutionAttempt(database: AgentMemoryDatabase, input: DispatchAttemptInput): PreparedExecutionAttempt {
  const binding = requireActiveExecutionBinding(input.batch.binding);
  const mode = assertDispatchMode(input.batch.dispatch_mode);
  const validated = validateDispatch(input.request, binding, new Date(), mode);
  const deadline = database.attempts!.boundAttemptDeadline({ batch_id: input.batch.batch.batch_id, attempt_id: validated.attempt_id, phase: validatePhase(validated.phase), deadline: validated.deadline, claim: input.batch.claim, binding: input.batch.binding_snapshot });
  const request = { ...validated, deadline };
  const phase = validatePhase(request.phase);
  if (request.job_id !== input.batch.batch.job_id) throw new Error("attempt_job_mismatch");
  if (input.batch.source_closure) {
    assertExecutionSourceClosure(database, input.batch.batch.scope_id, `provider:${binding.provider_id}`, request.source_spans);
  } else {
    assertPrimaryExecutionSources(database, input.batch.batch.scope_id, input.batch.batch.source_capture_id, `provider:${binding.provider_id}`, request.source_spans);
  }
  const requestDigest = digest({ request, input_fingerprint: input.batch.batch.input_fingerprint, input_privacy_epoch: input.batch.batch.input_privacy_epoch });
  const attemptId = input.attempt_id ?? request.attempt_id;
  if (attemptId !== request.attempt_id) throw new Error("attempt_id_mismatch");
  const prepare: PrepareExecutionAttemptInput = {
    batch_id: input.batch.batch.batch_id,
    attempt_id: attemptId,
    phase,
    request_digest: requestDigest,
    deadline: request.deadline,
    claim: input.batch.claim,
    binding: input.batch.binding_snapshot,
  };
  const attempt = database.attempts!.prepareAttempt(prepare);
  return {
    batch: input.batch,
    request,
    attempt,
    control: { attempt, claim: input.batch.claim, binding: input.batch.binding_snapshot },
  };
}

function assertPrimaryExecutionSources(
  database: AgentMemoryDatabase,
  scopeId: string,
  captureId: string,
  providerTarget: string,
  references: ReadonlyArray<ExecutionSourceReference>,
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.capture_id}\u0000${reference.source_span_id}`;
    if (seen.has(key) || reference.scope_id !== scopeId || reference.capture_id !== captureId) throw new Error("attempt_source_mismatch");
    seen.add(key);
  }
  database.assertExecutionSourceReferences(scopeId, captureId, providerTarget, references);
}

function assertExecutionSourceClosure(
  database: AgentMemoryDatabase,
  scopeId: string,
  providerTarget: string,
  references: ReadonlyArray<ExecutionSourceReference>,
): void {
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.capture_id}\u0000${reference.source_span_id}`;
    if (seen.has(key) || reference.scope_id !== scopeId) throw new Error("attempt_source_mismatch");
    seen.add(key);
  }
  database.assertExecutionSourceClosure(scopeId, providerTarget, references);
}

export function executionResultDigest(result: ExecutionResult): string {
  return digest(result);
}

export function executionResultUsage(result: ExecutionResult): AttemptUsageInput {
  if (result.usage.status === "unknown") return { status: "unknown" };
  const usage: AttemptUsageInput = {
    status: result.usage.status,
    ...(result.usage.input_tokens === undefined ? {} : { input_tokens: result.usage.input_tokens }),
    ...(result.usage.output_tokens === undefined ? {} : { output_tokens: result.usage.output_tokens }),
  };
  return usage.input_tokens === undefined && usage.output_tokens === undefined ? { status: "unknown" } : usage;
}

export function executionResultProviderAttemptId(result: ExecutionResult): string | undefined {
  return result.attempt.status === "observed" ? result.attempt.provider_attempt_id : undefined;
}

export function executionResultCompletion(result: ExecutionResult, receivedAt: string): AttemptCompletionInput {
  return {
    status: result.status,
    result_digest: executionResultDigest(result),
    received_at: receivedAt,
    provider_id: result.model.provider_id,
    model_id: result.model.model_id,
    ...(result.model.requested_model_id === undefined ? {} : { requested_model_id: result.model.requested_model_id }),
    reasoning: result.model.reasoning ?? null,
    runtime_session_id: result.model.runtime_session_id ?? null,
    ...(result.attempt.status === "observed" ? { provider_attempt_id: result.attempt.provider_attempt_id } : {}),
    usage: executionResultUsage(result),
  };
}

export function createAttemptLifecycle(database: AgentMemoryDatabase, control: AttemptControlInput): ExecutionLifecycleCallbacks {
  let current = control.attempt;
  let rootArtifact: RuntimeArtifactRecord | undefined;
  let rootPlan: RegisterRuntimeArtifactInput | undefined;
  let sessionArtifact: RuntimeArtifactRecord | undefined;
  const currentControl = (): AttemptControlInput => ({ ...control, attempt: current });
  return {
    beforeRuntimeStart: async (authIdentity, artifact) => {
      if (authIdentity === undefined) {
        if (current.auth_generation !== null || current.auth_entry_id !== null) {
          throw new ExecutionLifecycleAdmissionError("attempt_auth_binding_required");
        }
      } else if (
        authIdentity.account_ref !== current.account_ref ||
        authIdentity.auth_epoch !== current.auth_epoch ||
        authIdentity.auth_generation !== current.auth_generation ||
        authIdentity.auth_entry_id !== current.auth_entry_id
      ) {
        throw new ExecutionLifecycleAdmissionError("attempt_auth_binding_mismatch");
      }
      if (artifact !== undefined) {
        rootPlan = {
          ...artifact,
          batch_id: current.batch_id,
          job_id: current.job_id,
          scope_id: control.claim.scope_id,
          source_capture_id: control.claim.source_capture_id,
        };
        rootArtifact = database.runtimeArtifacts.register(rootPlan);
      }
      current = database.attempts!.markDispatchIntent(currentControl());
    },
    runtimeArtifactPresent: async () => {
      if (rootArtifact !== undefined) rootArtifact = database.runtimeArtifacts.markPresent(rootArtifact.artifact_id);
    },
    runtimeArtifactCreationAttempted: async () => {
      if (rootArtifact !== undefined) rootArtifact = database.runtimeArtifacts.markCreationAttempted(rootArtifact.artifact_id);
    },
    executionClosed: async () => {
      if (rootArtifact !== undefined) rootArtifact = database.runtimeArtifacts.confirmExecutionClosed(rootArtifact.artifact_id);
    },
    sessionObserved: async (runtimeSessionId) => {
      if (rootPlan !== undefined && sessionArtifact === undefined) {
        sessionArtifact = database.runtimeArtifacts.register({
          attempt_id: rootPlan.attempt_id,
          batch_id: rootPlan.batch_id,
          job_id: rootPlan.job_id,
          scope_id: rootPlan.scope_id,
          source_capture_id: rootPlan.source_capture_id,
          profile_id: rootPlan.profile_id,
          account_ref: rootPlan.account_ref,
          trusted_root: rootPlan.trusted_root,
          kind: "session",
          native_session_id: runtimeSessionId,
        });
      }
      // Cleanup-only registration intentionally precedes the semantic
      // recordSession CAS: purge/auth/fence loss may reject that CAS, but the
      // observed provider session must still remain durably cleanable.
      current = database.attempts!.recordSession(currentControl(), runtimeSessionId);
    },
    beforePromptDispatch: async () => {
      current = database.attempts!.recordPromptDispatch(currentControl());
    },
    terminalObserved: async (status, usage, providerAttemptId) => {
      if (status === "completed" || status === "refused" || status === "invalid_output" || status === "timeout" || status === "aborted" || status === "failed") {
        current = database.attempts!.recordTerminal(currentControl(), {
          status,
          ...(usage === undefined ? {} : { usage }),
          ...(providerAttemptId === undefined ? {} : { provider_attempt_id: providerAttemptId }),
        });
      }
    },
    dispatchCancelled: async (reason) => {
      current = database.attempts!.cancelPrepared(currentControl(), reason);
    },
    cleanupCompleted: async (input) => {
      if (rootArtifact !== undefined && input.confirmed) rootArtifact = await database.runtimeArtifacts.reconcile(rootArtifact.artifact_id);
      current = database.attempts!.recordCleanup(currentControl(), input);
    },
    nativeSessionRemoved: async (runtimeSessionId) => {
      if (sessionArtifact?.native_session_id === runtimeSessionId) {
        sessionArtifact = database.runtimeArtifacts.confirmNativeRemoved(sessionArtifact.artifact_id);
      }
    },
  };
}

export function completeExecutionAttempt(database: AgentMemoryDatabase, control: AttemptControlInput, result: ExecutionResult, receivedAt: string): AttemptCompletionResult {
  return database.attempts!.complete(control, executionResultCompletion(result, receivedAt));
}
