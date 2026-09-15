import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { nonNegativeInt64Schema, parseContract } from "../host/contract.js";
import { StoreError } from "./errors.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const dateTimeSchema = z.iso.datetime({ offset: true });
const jobTaskKindSchema = z.enum(["extract", "embed"]);
const jobStateSchema = z.enum(["pending_extraction", "running", "completed", "failed", "paused"]);
const pauseReasonSchema = z.enum([
  "authorization_required",
  "handler_unavailable",
  "source_purged",
  "quota_exhausted",
  "budget_unknown",
  "execution_deadline",
  "policy_changed",
  "shutdown",
  "manual",
]);
const ownerSchema = z.string().min(1).max(256);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const uuidSchema = z.uuid();
const authRecoveryTaskVersionSchema = z.string().regex(/^extract-v1:recovery:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:part:[0-9]{1,3}$/u).refine((value) => {
  const match = /:part:([0-9]{1,3})$/u.exec(value);
  return match !== null && Number(match[1]) <= 255;
}, { message: "auth_recovery_task_version_invalid" });
const authRetryTaskVersionSchema = z.string().regex(/^extract-v1:retry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:part:[0-9]{1,3}$/u).refine((value) => {
  const match = /:part:([0-9]{1,3})$/u.exec(value);
  return match !== null && Number(match[1]) <= 255;
}, { message: "auth_retry_task_version_invalid" });

export type JobState = z.infer<typeof jobStateSchema>;
export type JobTaskKind = z.infer<typeof jobTaskKindSchema>;
export type JobPauseReason = z.infer<typeof pauseReasonSchema>;

export interface JobRecord {
  readonly version: 1;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_kind: JobTaskKind;
  readonly task_version: string;
  readonly state: JobState;
  readonly dedupe_key: string;
  readonly attempts: number;
  readonly next_at: string | null;
  readonly owner: string | null;
  readonly lease_until: string | null;
  readonly fence: string;
  readonly created_commit_seq: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly pause_reason: JobPauseReason | null;
  readonly completion_receipt: JobCompletionReceipt | null;
}

export interface JobClaim {
  readonly version: 1;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_kind: JobTaskKind;
  readonly task_version: string;
  readonly owner: string;
  readonly lease_until: string;
  readonly fence: string;
  readonly attempts: number;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
}

export interface JobCompletionReceipt {
  readonly version: 1;
  readonly status: "completed";
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_version: string;
  readonly owner: string;
  readonly fence: string;
  readonly attempts: number;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly completed_at: string;
  readonly result_digest: string;
}

export type JobCompletionResult =
  | { readonly status: "completed"; readonly receipt: JobCompletionReceipt }
  | { readonly status: "already_completed"; readonly receipt: JobCompletionReceipt }
  | {
      readonly status: "rejected";
      readonly reason: "claim_invalid" | "lease_expired" | "source_changed" | "source_purged" | "policy_changed";
      readonly state: JobState;
    };

export interface JobRetryResult {
  readonly state: "pending_extraction" | "failed";
  readonly attempts: number;
  readonly next_at: string | null;
  readonly pause_reason: null;
}

export interface JobResumeRequest {
  readonly job_id: string;
  readonly expected_fence: string;
  readonly expected_reason: JobPauseReason;
  /** Compatibility field; the repository clock is authoritative. */
  readonly now: string;
}

export interface AuthRecoveryJobResult {
  readonly job_id: string;
  readonly created: boolean;
}

function taskPart(taskVersion: string): string | undefined {
  if (taskVersion === "extract-v1") return "0";
  return /:part:([0-9]{1,3})$/u.exec(taskVersion)?.[1];
}

export interface JobQueueStatus {
  readonly pending: number;
  readonly due: number;
  readonly running: number;
  readonly paused: number;
  readonly failed: number;
  readonly completed: number;
}

export interface JobRepositoryOptions {
  readonly owner_id?: string;
  readonly lease_ms?: number;
  readonly max_attempts?: number;
  readonly jitter?: () => number;
  /** Trusted fixture clock; production uses SQLite's clock after BEGIN IMMEDIATE. */
  readonly clock?: () => string;
}

interface MutableJobRow {
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_kind: JobTaskKind;
  readonly task_version: string;
  readonly state: JobState;
  readonly dedupe_key: string;
  readonly attempts: number;
  readonly next_at: string | null;
  readonly owner: string | null;
  readonly lease_until: string | null;
  readonly fence: string;
  readonly created_commit_seq: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly pause_reason: JobPauseReason | null;
  readonly completion_receipt: JobCompletionReceipt | null;
}

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) {
    throw new StoreError("read_failed", new Error(`missing ${field}`));
  }
  return (row as Record<string, unknown>)[field];
}

function sqlText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new StoreError("read_failed", new Error(`invalid ${field}`));
  return value;
}

function sqlInteger(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new StoreError("read_failed", new Error(`unsafe ${field}`));
}

function nullableText(row: unknown, field: string): string | null {
  const value = rowValue(row, field);
  return value === null ? null : sqlText(value, field);
}

function nullableDateTime(row: unknown, field: string): string | null {
  const value = nullableText(row, field);
  return value === null ? null : parseDateTime(value, field);
}

function parseDateTime(value: unknown, field: string): string {
  const parsed = parseContract(dateTimeSchema, value, field);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) throw new StoreError("job_invalid");
  return new Date(milliseconds).toISOString();
}

function parseOwner(value: unknown, field: string): string {
  return parseContract(ownerSchema, value, field);
}

function parseDigest(value: unknown, field: string): string {
  return parseContract(digestSchema, value, field).toLowerCase();
}

function parseReceipt(value: unknown): JobCompletionReceipt {
  return parseContract(
    z
      .object({
        version: z.literal(1),
        status: z.literal("completed"),
        job_id: uuidSchema,
        scope_id: uuidSchema,
        source_capture_id: uuidSchema,
        task_version: z.string().min(1).max(128),
        owner: ownerSchema,
        fence: nonNegativeInt64Schema,
        attempts: z.number().int().min(1).max(5),
        input_fingerprint: digestSchema,
        input_privacy_epoch: nonNegativeInt64Schema,
        completed_at: dateTimeSchema,
        result_digest: digestSchema,
      })
      .strict(),
    value,
    "job-completion-receipt",
  );
}

function parseStoredReceipt(value: unknown): JobCompletionReceipt | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sqlText(value, "completion_receipt_json")) as unknown;
  } catch (error: unknown) {
    throw new StoreError("job_write_failed", error);
  }
  return parseReceipt(parsed);
}

function addMilliseconds(now: string, milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 86_400_000) {
    throw new StoreError("job_invalid");
  }
  const current = Date.parse(now);
  const next = current + milliseconds;
  if (!Number.isSafeInteger(next) || next <= current) throw new StoreError("job_invalid");
  return new Date(next).toISOString();
}

function isBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

export class JobRepository {
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly jitter: () => number;
  private readonly clock: (() => string) | undefined;

  constructor(
    private readonly database: DatabaseSync,
    private readonly ensureOpen: () => void,
    options: JobRepositoryOptions = {},
  ) {
    this.ownerId = parseOwner(options.owner_id ?? randomUUID(), "job-owner");
    this.leaseMs = options.lease_ms ?? 30_000;
    this.maxAttempts = options.max_attempts ?? 5;
    this.jitter = options.jitter ?? Math.random;
    this.clock = options.clock;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 100 || this.leaseMs > 300_000) throw new StoreError("job_invalid");
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) throw new StoreError("job_invalid");
  }

  claimNext(_ignoredNow?: string, taskKind: JobTaskKind = "extract"): JobClaim | undefined {
    const kind = parseContract(jobTaskKindSchema, taskKind, "job-task-kind");
    return this.transaction(() => {
      const parsedNow = this.readNow();
      this.failExhaustedDueJobs(parsedNow, kind);
      this.pauseIneligibleDueJobs(parsedNow, kind);
      const row = this.database
        .prepare(
          `SELECT
             j.job_id, j.scope_id, j.source_capture_id, j.task_version, j.attempts,
             j.fence, j.input_fingerprint, j.input_privacy_epoch,
             e.fingerprint AS source_fingerprint,
             s.privacy_epoch AS current_privacy_epoch
            FROM job AS j
            JOIN source_event AS e
              ON e.scope_id = j.scope_id AND e.capture_id = j.source_capture_id
            JOIN scope AS s ON s.scope_id = j.scope_id
            LEFT JOIN purge_tombstone AS t
              ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
            WHERE j.task_kind = ?
              AND (
               (j.state = 'pending_extraction' AND (j.next_at IS NULL OR j.next_at <= ?)) OR
               (j.state = 'running' AND (j.lease_until IS NULL OR j.lease_until <= ?))
             )
             AND j.attempts < ?
             AND t.capture_id IS NULL
             AND e.fingerprint = j.input_fingerprint
             AND CAST(s.privacy_epoch AS TEXT) = j.input_privacy_epoch
           ORDER BY CASE WHEN j.state = 'running' THEN 0 ELSE 1 END,
                    CASE WHEN j.next_at IS NULL THEN 0 ELSE 1 END,
                    j.next_at, j.created_commit_seq, j.job_id
           LIMIT 1`,
        )
        .get(kind, parsedNow, parsedNow, this.maxAttempts);
      if (row === undefined) return undefined;
      const jobId = parseContract(uuidSchema, sqlText(rowValue(row, "job_id"), "job-id"), "job-id");
      const scopeId = parseContract(uuidSchema, sqlText(rowValue(row, "scope_id"), "job-scope"), "job-scope");
      const sourceCaptureId = parseContract(uuidSchema, sqlText(rowValue(row, "source_capture_id"), "job-source"), "job-source");
      const attempts = Number(sqlInteger(rowValue(row, "attempts"), "job-attempts"));
      if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts >= this.maxAttempts) return undefined;
      const fence = sqlInteger(rowValue(row, "fence"), "job-fence");
      if (fence >= MAX_INT64) throw new StoreError("job_write_failed");
      const nextFence = fence + 1n;
      const leaseUntil = addMilliseconds(parsedNow, this.leaseMs);
      const updated = this.database
        .prepare(
          `UPDATE job
              SET state = 'running', owner = ?, lease_until = ?, fence = ?, attempts = ?,
                  next_at = NULL, pause_reason = NULL
            WHERE job_id = ?
              AND (
                (state = 'pending_extraction' AND (next_at IS NULL OR next_at <= ?)) OR
                (state = 'running' AND (lease_until IS NULL OR lease_until <= ?))
              )
              AND fence = ? AND attempts = ?`,
        )
        .run(this.ownerId, leaseUntil, nextFence, attempts + 1, jobId, parsedNow, parsedNow, fence, attempts);
      if (sqlInteger(updated.changes, "job-claim-changes") !== 1n) throw new StoreError("job_claim_conflict");
      return {
        version: 1,
        job_id: jobId,
        scope_id: scopeId,
        source_capture_id: sourceCaptureId,
        task_kind: kind,
        task_version: z.string().min(1).max(128).parse(rowValue(row, "task_version")),
        owner: this.ownerId,
        lease_until: leaseUntil,
        fence: nextFence.toString(10),
        attempts: attempts + 1,
        input_fingerprint: parseDigest(rowValue(row, "input_fingerprint"), "job-input-fingerprint"),
        input_privacy_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "input_privacy_epoch"), "job-input-privacy"), "job-input-privacy"),
      };
    });
  }

  renew(claim: JobClaim, _ignoredNow?: string): JobClaim | undefined {
    const checked = this.parseClaim(claim);
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (current === undefined || !this.claimMatches(current, checked) || current.state !== "running" || current.lease_until === null || !isBefore(parsedNow, current.lease_until)) return undefined;
      const leaseUntil = addMilliseconds(parsedNow, this.leaseMs);
      const updated = this.database
        .prepare(
          `UPDATE job SET lease_until = ?
            WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
              AND lease_until = ?`,
        )
        .run(leaseUntil, checked.job_id, checked.owner, BigInt(checked.fence), current.lease_until);
      if (sqlInteger(updated.changes, "job-renew-changes") !== 1n) return undefined;
      return { ...checked, lease_until: leaseUntil, attempts: current.attempts };
    });
  }

  complete(claim: JobClaim, _ignoredNow: string | undefined, resultDigest: string): JobCompletionResult;
  complete(claim: JobClaim, resultDigest: string): JobCompletionResult;
  complete(claim: JobClaim, nowOrDigest: string, maybeDigest?: string): JobCompletionResult {
    const checked = this.parseClaim(claim);
    const digest = parseDigest(maybeDigest ?? nowOrDigest, "job-result-digest");
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (current === undefined) throw new StoreError("job_not_found");
      if (current.state === "completed") {
        const receipt = current.completion_receipt;
        if (receipt === null || !this.completedClaimMatches(receipt, checked)) {
          return { status: "rejected", reason: "claim_invalid", state: "completed" };
        }
        if (receipt.result_digest !== digest) throw new StoreError("job_stale");
        return { status: "already_completed", receipt };
      }
      if (!this.claimMatches(current, checked) || current.state !== "running") {
        return { status: "rejected", reason: "claim_invalid", state: current.state };
      }
      if (current.lease_until === null || !isBefore(parsedNow, current.lease_until)) {
        return { status: "rejected", reason: "lease_expired", state: current.state };
      }
      const source = this.database
        .prepare(
          `SELECT e.fingerprint, s.privacy_epoch,
                  t.capture_id AS tombstone_capture_id
             FROM scope AS s
             LEFT JOIN source_event AS e
               ON e.scope_id = s.scope_id AND e.capture_id = ?
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = s.scope_id AND t.capture_id = ?
            WHERE s.scope_id = ?`,
        )
        .get(checked.source_capture_id, checked.source_capture_id, checked.scope_id);
      if (source === undefined || rowValue(source, "fingerprint") === null || rowValue(source, "tombstone_capture_id") !== null) {
        this.pauseClaim(checked, "source_purged", parsedNow);
        return { status: "rejected", reason: "source_purged", state: "paused" };
      }
      if (parseDigest(rowValue(source, "fingerprint"), "source-fingerprint") !== checked.input_fingerprint) {
        this.pauseClaim(checked, "source_purged", parsedNow);
        return { status: "rejected", reason: "source_changed", state: "paused" };
      }
      const currentPrivacy = sqlInteger(rowValue(source, "privacy_epoch"), "current-privacy-epoch").toString(10);
      if (currentPrivacy !== checked.input_privacy_epoch) {
        this.pauseClaim(checked, "policy_changed", parsedNow);
        return { status: "rejected", reason: "policy_changed", state: "paused" };
      }
      const receipt: JobCompletionReceipt = {
        version: 1,
        status: "completed",
        job_id: checked.job_id,
        scope_id: checked.scope_id,
        source_capture_id: checked.source_capture_id,
        task_version: checked.task_version,
        owner: checked.owner,
        fence: checked.fence,
        attempts: checked.attempts,
        input_fingerprint: checked.input_fingerprint,
        input_privacy_epoch: checked.input_privacy_epoch,
        completed_at: parsedNow,
        result_digest: digest,
      };
      const updated = this.database
        .prepare(
          `UPDATE job
              SET state = 'completed', owner = NULL, lease_until = NULL, next_at = NULL,
                  pause_reason = NULL, completion_receipt_json = ?
            WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
              AND lease_until = ? AND task_version = ? AND input_fingerprint = ?
              AND input_privacy_epoch = ?`,
        )
        .run(
          JSON.stringify(receipt),
          checked.job_id,
          checked.owner,
          BigInt(checked.fence),
          current.lease_until,
          checked.task_version,
          checked.input_fingerprint,
          checked.input_privacy_epoch,
        );
      if (sqlInteger(updated.changes, "job-complete-changes") !== 1n) return { status: "rejected", reason: "claim_invalid", state: "running" };
      return { status: "completed", receipt };
    });
  }

  retry(claim: JobClaim, _ignoredNow?: string): JobRetryResult | undefined {
    const checked = this.parseClaim(claim);
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (current === undefined || !this.claimMatches(current, checked) || current.state !== "running" || current.lease_until === null || !isBefore(parsedNow, current.lease_until)) return undefined;
      if (current.attempts >= this.maxAttempts) {
        const updated = this.database
          .prepare(
            `UPDATE job SET state = 'failed', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = NULL
              WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?`,
          )
          .run(checked.job_id, checked.owner, BigInt(checked.fence));
        if (sqlInteger(updated.changes, "job-fail-changes") !== 1n) return undefined;
        return { state: "failed", attempts: current.attempts, next_at: null, pause_reason: null };
      }
      const nextAt = addMilliseconds(parsedNow, this.backoffMilliseconds(current.attempts));
      const updated = this.database
        .prepare(
          `UPDATE job SET state = 'pending_extraction', owner = NULL, lease_until = NULL,
                          next_at = ?, pause_reason = NULL
            WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
              AND lease_until = ?`,
        )
        .run(nextAt, checked.job_id, checked.owner, BigInt(checked.fence), current.lease_until);
      if (sqlInteger(updated.changes, "job-retry-changes") !== 1n) return undefined;
      return { state: "pending_extraction", attempts: current.attempts, next_at: nextAt, pause_reason: null };
    });
  }

  pause(claim: JobClaim, reason: JobPauseReason, _ignoredNow?: string): JobRecord | undefined {
    const checked = this.parseClaim(claim);
    const parsedReason = parseContract(pauseReasonSchema, reason, "job-pause-reason");
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (current === undefined || !this.claimMatches(current, checked) || current.state !== "running" || current.lease_until === null || !isBefore(parsedNow, current.lease_until)) return undefined;
      this.pauseClaim(checked, parsedReason, parsedNow);
      return this.readJob(checked.job_id);
    });
  }

  /**
   * Requeue one paused job after the caller has resolved the recorded reason.
   * The fence and reason are a CAS boundary; source identity and the current
   * privacy epoch are rechecked in the same transaction before requeueing.
   */
  resume(request: JobResumeRequest): JobRecord | undefined {
    if (typeof request !== "object" || request === null) throw new StoreError("job_invalid");
    const checked = this.parseResumeRequest(request);
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (
        current === undefined ||
        current.state !== "paused" ||
        current.fence !== checked.expected_fence ||
        current.pause_reason !== checked.expected_reason ||
        checked.expected_reason === "source_purged"
      ) {
        return undefined;
      }

      const source = this.database
        .prepare(
          `SELECT e.fingerprint, s.privacy_epoch,
                  t.capture_id AS tombstone_capture_id
             FROM scope AS s
             LEFT JOIN source_event AS e
               ON e.scope_id = s.scope_id AND e.capture_id = ?
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = s.scope_id AND t.capture_id = ?
            WHERE s.scope_id = ?`,
        )
        .get(current.source_capture_id, current.source_capture_id, current.scope_id);
      if (source === undefined || rowValue(source, "fingerprint") === null || rowValue(source, "tombstone_capture_id") !== null) {
        return undefined;
      }
      if (parseDigest(rowValue(source, "fingerprint"), "resume-source-fingerprint") !== current.input_fingerprint) {
        return undefined;
      }
      const currentPrivacy = parseContract(
        nonNegativeInt64Schema,
        sqlInteger(rowValue(source, "privacy_epoch"), "resume-privacy-epoch").toString(10),
        "resume-privacy-epoch",
      );
      const existingBatch = this.database.prepare("SELECT state FROM extraction_batch WHERE job_id = ?").get(current.job_id);
      if (checked.expected_reason === "authorization_required" && existingBatch !== undefined && sqlText(rowValue(existingBatch, "state"), "resume-extraction-state") !== "completed") {
        const part = taskPart(current.task_version);
        if (part === undefined) throw new StoreError("job_invalid");
        const retryTaskVersion = authRetryTaskVersionSchema.parse(`extract-v1:retry:${current.job_id}:part:${part}`);
        const dedupeKey = createHash("sha256")
          .update(`${current.scope_id}\u0000${current.source_capture_id}\u0000extract\u0000${retryTaskVersion}`, "utf8")
          .digest("hex");
        const retryJobId = randomUUID();
        const inserted = this.database
          .prepare(
            `INSERT OR IGNORE INTO job (
               job_id, scope_id, source_capture_id, task_kind, task_version, state,
               dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
               input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
             ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, 0, NULL, NULL, NULL, 0, ?, ?, ?, NULL, NULL)`,
          )
          .run(retryJobId, current.scope_id, current.source_capture_id, retryTaskVersion, dedupeKey, BigInt(current.created_commit_seq), current.input_fingerprint, currentPrivacy);
        if (sqlInteger(inserted.changes, "auth-retry-enqueue-changes") === 1n) return this.readJob(retryJobId);
        const existingRetry = this.database.prepare("SELECT job_id, scope_id, source_capture_id, task_kind, task_version, input_fingerprint, input_privacy_epoch FROM job WHERE dedupe_key = ?").get(dedupeKey);
        if (
          existingRetry === undefined ||
          sqlText(rowValue(existingRetry, "scope_id"), "retry-existing-scope") !== current.scope_id ||
          sqlText(rowValue(existingRetry, "source_capture_id"), "retry-existing-source") !== current.source_capture_id ||
          sqlText(rowValue(existingRetry, "task_kind"), "retry-existing-kind") !== "extract" ||
          sqlText(rowValue(existingRetry, "task_version"), "retry-existing-version") !== retryTaskVersion ||
          sqlText(rowValue(existingRetry, "input_fingerprint"), "retry-existing-fingerprint") !== current.input_fingerprint ||
          sqlText(rowValue(existingRetry, "input_privacy_epoch"), "retry-existing-privacy") !== currentPrivacy
        ) throw new StoreError("job_claim_conflict");
        return this.readJob(parseContract(uuidSchema, rowValue(existingRetry, "job_id"), "retry-existing-job"));
      }
      const updated = this.database
        .prepare(
          `UPDATE job
              SET state = 'pending_extraction', owner = NULL, lease_until = NULL,
                  next_at = ?, pause_reason = NULL, input_privacy_epoch = ?,
                  attempts = CASE WHEN task_kind = 'embed' AND pause_reason = 'shutdown'
                    THEN MAX(0, attempts - 1) ELSE attempts END,
                  completion_receipt_json = NULL
            WHERE job_id = ? AND state = 'paused' AND fence = ? AND pause_reason = ?`,
        )
        .run(parsedNow, currentPrivacy, checked.job_id, BigInt(checked.expected_fence), checked.expected_reason);
      if (sqlInteger(updated.changes, "job-resume-changes") !== 1n) return undefined;
      return this.readJob(checked.job_id);
    });
  }

  /**
   * Atomically fence an auth-rotated claim and enqueue one fresh extraction
   * job. The replacement gets its own batch and retry budget while the old
   * job and its immutable batch remain available as history.
   */
  pauseAndEnqueueAuthRecovery(claim: JobClaim, taskVersion: string): AuthRecoveryJobResult | undefined {
    const checked = this.parseClaim(claim);
    if (checked.task_kind !== "extract") throw new StoreError("job_invalid");
    let recoveryTaskVersion: string;
    try {
      recoveryTaskVersion = authRecoveryTaskVersionSchema.parse(taskVersion);
    } catch (error: unknown) {
      throw new StoreError("job_invalid", error);
    }
    const recoveryParent = /^extract-v1:recovery:([0-9a-f-]{36}):part:[0-9]{1,3}$/u.exec(recoveryTaskVersion)?.[1];
    if (recoveryParent !== checked.job_id) throw new StoreError("job_invalid");
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const current = this.readMutableJob(checked.job_id);
      if (
        current === undefined ||
        !this.claimMatches(current, checked) ||
        current.state !== "running" ||
        current.lease_until === null ||
        !isBefore(parsedNow, current.lease_until) ||
        current.attempts >= this.maxAttempts
      ) return undefined;

      const source = this.database
        .prepare(
          `SELECT e.fingerprint, s.privacy_epoch,
                  t.capture_id AS tombstone_capture_id
             FROM scope AS s
             LEFT JOIN source_event AS e
               ON e.scope_id = s.scope_id AND e.capture_id = ?
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = s.scope_id AND t.capture_id = ?
            WHERE s.scope_id = ?`,
        )
        .get(current.source_capture_id, current.source_capture_id, current.scope_id);
      if (source === undefined || rowValue(source, "fingerprint") === null || rowValue(source, "tombstone_capture_id") !== null) return undefined;
      if (parseDigest(rowValue(source, "fingerprint"), "recovery-source-fingerprint") !== checked.input_fingerprint) return undefined;
      const currentPrivacy = parseContract(
        nonNegativeInt64Schema,
        sqlInteger(rowValue(source, "privacy_epoch"), "recovery-privacy-epoch").toString(10),
        "recovery-privacy-epoch",
      );
      if (currentPrivacy !== checked.input_privacy_epoch) return undefined;

      const dedupeKey = createHash("sha256")
        .update(`${checked.scope_id}\u0000${checked.source_capture_id}\u0000extract\u0000${recoveryTaskVersion}`, "utf8")
        .digest("hex");
      const recoveryJobId = randomUUID();
      const paused = this.database
        .prepare(
          `UPDATE job
              SET state = 'paused', owner = NULL, lease_until = NULL,
                  next_at = NULL, pause_reason = 'authorization_required'
            WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
              AND lease_until = ? AND lease_until > ?`,
        )
        .run(checked.job_id, checked.owner, BigInt(checked.fence), current.lease_until, parsedNow);
      if (sqlInteger(paused.changes, "auth-recovery-pause-changes") !== 1n) return undefined;

      const inserted = this.database
        .prepare(
          `INSERT OR IGNORE INTO job (
             job_id, scope_id, source_capture_id, task_kind, task_version, state,
             dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
             input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
           ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          recoveryJobId,
          current.scope_id,
          current.source_capture_id,
          recoveryTaskVersion,
          dedupeKey,
          checked.attempts,
          0n,
          BigInt(checked.fence),
          checked.input_fingerprint,
          currentPrivacy,
        );
      if (sqlInteger(inserted.changes, "auth-recovery-enqueue-changes") === 1n) return { job_id: recoveryJobId, created: true };

      const existing = this.database
        .prepare(
          `SELECT job_id, scope_id, source_capture_id, task_kind, task_version,
                  input_fingerprint, input_privacy_epoch
             FROM job WHERE dedupe_key = ?`,
        )
        .get(dedupeKey);
      if (
        existing === undefined ||
        sqlText(rowValue(existing, "scope_id"), "recovery-existing-scope") !== current.scope_id ||
        sqlText(rowValue(existing, "source_capture_id"), "recovery-existing-source") !== current.source_capture_id ||
        sqlText(rowValue(existing, "task_kind"), "recovery-existing-kind") !== "extract" ||
        sqlText(rowValue(existing, "task_version"), "recovery-existing-version") !== recoveryTaskVersion ||
        sqlText(rowValue(existing, "input_fingerprint"), "recovery-existing-fingerprint") !== checked.input_fingerprint ||
        sqlText(rowValue(existing, "input_privacy_epoch"), "recovery-existing-privacy") !== currentPrivacy
      ) throw new StoreError("job_claim_conflict");
      return { job_id: parseContract(uuidSchema, rowValue(existing, "job_id"), "recovery-existing-job"), created: false };
    });
  }

  get(jobId: string): JobRecord | undefined {
    this.ensureOpen();
    const parsedJobId = parseContract(uuidSchema, jobId, "job-id");
    return this.readJob(parsedJobId);
  }

  status(_ignoredNow?: string, taskKind?: JobTaskKind): JobQueueStatus {
    const kind = taskKind === undefined ? undefined : parseContract(jobTaskKindSchema, taskKind, "job-task-kind");
    return this.transaction(() => {
      const parsedNow = this.readNow();
      const fromClause = kind === undefined ? "FROM job" : "FROM job WHERE task_kind = ?";
      const row = this.database
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN state = 'pending_extraction' THEN 1 ELSE 0 END), 0) AS pending,
             COALESCE(SUM(CASE WHEN (state = 'pending_extraction' AND (next_at IS NULL OR next_at <= ?)) OR
                                      (state = 'running' AND (lease_until IS NULL OR lease_until <= ?)) THEN 1 ELSE 0 END), 0) AS due,
             COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
             COALESCE(SUM(CASE WHEN state = 'paused' THEN 1 ELSE 0 END), 0) AS paused,
             COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed
            ${fromClause}`,
        )
        .get(parsedNow, parsedNow, ...(kind === undefined ? [] : [kind]));
      if (row === undefined) throw new StoreError("read_failed");
      return {
        pending: Number(sqlInteger(rowValue(row, "pending"), "pending")),
        due: Number(sqlInteger(rowValue(row, "due"), "due")),
        running: Number(sqlInteger(rowValue(row, "running"), "running")),
        paused: Number(sqlInteger(rowValue(row, "paused"), "paused")),
        failed: Number(sqlInteger(rowValue(row, "failed"), "failed")),
        completed: Number(sqlInteger(rowValue(row, "completed"), "completed")),
      };
    });
  }

  private pauseIneligibleDueJobs(now: string, taskKind: JobTaskKind): void {
    this.database
      .prepare(
        `UPDATE job
            SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL,
                pause_reason = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM source_event AS e
                     WHERE e.scope_id = job.scope_id AND e.capture_id = job.source_capture_id
                  ) OR EXISTS (
                    SELECT 1 FROM purge_tombstone AS t
                     WHERE t.scope_id = job.scope_id AND t.capture_id = job.source_capture_id
                  ) OR NOT EXISTS (
                    SELECT 1 FROM source_event AS e
                     WHERE e.scope_id = job.scope_id AND e.capture_id = job.source_capture_id
                       AND e.fingerprint = job.input_fingerprint
                  ) THEN 'source_purged'
                  ELSE 'policy_changed'
                END
          WHERE task_kind = ?
            AND (
              (state = 'pending_extraction' AND (next_at IS NULL OR next_at <= ?)) OR
              (state = 'running' AND (lease_until IS NULL OR lease_until <= ?))
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM source_event AS e
                 WHERE e.scope_id = job.scope_id AND e.capture_id = job.source_capture_id
              ) OR EXISTS (
                SELECT 1 FROM purge_tombstone AS t
                 WHERE t.scope_id = job.scope_id AND t.capture_id = job.source_capture_id
              ) OR NOT EXISTS (
                SELECT 1 FROM source_event AS e
                 WHERE e.scope_id = job.scope_id AND e.capture_id = job.source_capture_id
                   AND e.fingerprint = job.input_fingerprint
              ) OR NOT EXISTS (
                SELECT 1 FROM scope AS s
                 WHERE s.scope_id = job.scope_id
                   AND CAST(s.privacy_epoch AS TEXT) = job.input_privacy_epoch
              )
            )`,
      )
      .run(taskKind, now, now);
  }

  private failExhaustedDueJobs(now: string, taskKind: JobTaskKind): void {
    this.database
      .prepare(
        `UPDATE job
            SET state = 'failed', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = NULL
          WHERE task_kind = ? AND attempts >= ?
            AND (
              (state = 'pending_extraction' AND (next_at IS NULL OR next_at <= ?)) OR
              (state = 'running' AND (lease_until IS NULL OR lease_until <= ?))
            )`,
      )
      .run(taskKind, this.maxAttempts, now, now);
  }

  private pauseClaim(claim: JobClaim, reason: JobPauseReason, now: string): void {
    const updated = this.database
      .prepare(
        `UPDATE job
            SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = ?
          WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
            AND lease_until IS NOT NULL AND lease_until > ?`,
      )
      .run(reason, claim.job_id, claim.owner, BigInt(claim.fence), now);
    if (sqlInteger(updated.changes, "job-pause-changes") !== 1n) throw new StoreError("job_claim_conflict");
  }

  private backoffMilliseconds(attempts: number): number {
    const base = attempts <= 1 ? 1_000 : attempts === 2 ? 5_000 : 30_000;
    const jitter = this.jitter();
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new StoreError("job_invalid");
    return Math.round(base * (0.8 + jitter * 0.4));
  }

  private readNow(): string {
    if (this.clock !== undefined) return parseDateTime(this.clock(), "job-clock-now");
    const row = this.database
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now")
      .get();
    return parseDateTime(rowValue(row, "now"), "sqlite-clock-now");
  }

  private parseClaim(claim: JobClaim): JobClaim {
    if (typeof claim !== "object" || claim === null) throw new StoreError("job_invalid");
    try {
      return {
        version: 1,
        job_id: parseContract(uuidSchema, claim.job_id, "job-claim-id"),
        scope_id: parseContract(uuidSchema, claim.scope_id, "job-claim-scope"),
        source_capture_id: parseContract(uuidSchema, claim.source_capture_id, "job-claim-source"),
        task_kind: parseContract(jobTaskKindSchema, claim.task_kind, "job-claim-kind"),
        task_version: z.string().min(1).max(128).parse(claim.task_version),
        owner: parseOwner(claim.owner, "job-claim-owner"),
        lease_until: parseDateTime(claim.lease_until, "job-claim-lease"),
        fence: parseContract(nonNegativeInt64Schema, claim.fence, "job-claim-fence"),
        attempts: z.number().int().min(1).max(this.maxAttempts).parse(claim.attempts),
        input_fingerprint: parseDigest(claim.input_fingerprint, "job-claim-fingerprint"),
        input_privacy_epoch: parseContract(nonNegativeInt64Schema, claim.input_privacy_epoch, "job-claim-privacy"),
      };
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_invalid", error);
    }
  }

  private parseResumeRequest(request: JobResumeRequest): {
    readonly job_id: string;
    readonly expected_fence: string;
    readonly expected_reason: JobPauseReason;
  } {
    try {
      return {
        job_id: parseContract(uuidSchema, request.job_id, "job-resume-id"),
        expected_fence: parseContract(nonNegativeInt64Schema, request.expected_fence, "job-resume-fence"),
        expected_reason: parseContract(pauseReasonSchema, request.expected_reason, "job-resume-reason"),
      };
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_invalid", error);
    }
  }

  private claimMatches(current: MutableJobRow, claim: JobClaim): boolean {
    return (
      current.job_id === claim.job_id &&
      current.scope_id === claim.scope_id &&
      current.source_capture_id === claim.source_capture_id &&
      current.task_kind === claim.task_kind &&
      current.task_version === claim.task_version &&
      current.owner === claim.owner &&
      current.lease_until === claim.lease_until &&
      current.fence === claim.fence &&
      current.attempts === claim.attempts &&
      current.input_fingerprint === claim.input_fingerprint &&
      current.input_privacy_epoch === claim.input_privacy_epoch
    );
  }

  private completedClaimMatches(receipt: JobCompletionReceipt, claim: JobClaim): boolean {
    return (
      receipt.job_id === claim.job_id &&
      receipt.scope_id === claim.scope_id &&
      receipt.source_capture_id === claim.source_capture_id &&
      receipt.task_version === claim.task_version &&
      receipt.owner === claim.owner &&
      receipt.fence === claim.fence &&
      receipt.attempts === claim.attempts &&
      receipt.input_fingerprint === claim.input_fingerprint &&
      receipt.input_privacy_epoch === claim.input_privacy_epoch
    );
  }

  private readMutableJob(jobId: string): MutableJobRow | undefined {
    const row = this.database
      .prepare(
        `SELECT job_id, scope_id, source_capture_id, task_kind, task_version, state, dedupe_key,
                attempts, next_at, owner, lease_until, fence, created_commit_seq,
                input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
           FROM job WHERE job_id = ?`,
      )
      .get(jobId);
    if (row === undefined) return undefined;
    const attempts = sqlInteger(rowValue(row, "attempts"), "job-attempts");
    if (attempts < 0n || attempts > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreError("job_write_failed");
    const owner = nullableText(row, "owner");
    return {
      job_id: parseContract(uuidSchema, sqlText(rowValue(row, "job_id"), "job-id"), "job-id"),
      scope_id: parseContract(uuidSchema, sqlText(rowValue(row, "scope_id"), "job-scope"), "job-scope"),
      source_capture_id: parseContract(uuidSchema, sqlText(rowValue(row, "source_capture_id"), "job-source"), "job-source"),
      task_kind: parseContract(jobTaskKindSchema, rowValue(row, "task_kind"), "job-kind"),
      task_version: z.string().min(1).max(128).parse(rowValue(row, "task_version")),
      state: parseContract(jobStateSchema, rowValue(row, "state"), "job-state"),
      dedupe_key: parseDigest(rowValue(row, "dedupe_key"), "job-dedupe-key"),
      attempts: Number(attempts),
      next_at: nullableDateTime(row, "next_at"),
      owner: owner === null ? null : parseOwner(owner, "job-owner"),
      lease_until: nullableDateTime(row, "lease_until"),
      fence: parseContract(nonNegativeInt64Schema, sqlInteger(rowValue(row, "fence"), "job-fence").toString(10), "job-fence"),
      created_commit_seq: parseContract(
        nonNegativeInt64Schema,
        sqlInteger(rowValue(row, "created_commit_seq"), "job-created-commit").toString(10),
        "job-created-commit",
      ),
      input_fingerprint: parseDigest(rowValue(row, "input_fingerprint"), "job-input-fingerprint"),
      input_privacy_epoch: parseContract(nonNegativeInt64Schema, sqlText(rowValue(row, "input_privacy_epoch"), "job-input-privacy"), "job-input-privacy"),
      pause_reason: rowValue(row, "pause_reason") === null ? null : parseContract(pauseReasonSchema, rowValue(row, "pause_reason"), "job-pause-reason"),
      completion_receipt: parseStoredReceipt(rowValue(row, "completion_receipt_json")),
    };
  }

  private readJob(jobId: string): JobRecord | undefined {
    const row = this.readMutableJob(jobId);
    if (row === undefined) return undefined;
    return { version: 1, ...row };
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
          // Preserve the original job failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_write_failed", error);
    }
  }
}
