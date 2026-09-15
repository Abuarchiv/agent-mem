import { randomUUID } from "node:crypto";

import { JobRepository, type JobClaim, type JobQueueStatus } from "../store/job-repository.js";
import {
  vectorProjectionReceiptDigest,
  type AgentMemoryDatabase,
  type VectorChunkProjection,
} from "../store/database.js";
import { StoreError } from "../store/errors.js";
import type { LocalE5Embedder } from "../models/embedding.js";
import { E5_MODEL_MANIFEST } from "../models/manifest.js";
import {
  chunkPassageForE5,
  digestText,
  vectorInputDigest,
  VECTOR_CHUNKER_VERSION,
  VECTOR_PROFILE_ID,
  VECTOR_TOKENIZER_VERSION,
} from "../retrieval/vector.js";
import { z } from "zod";
import type { JobRunnerHooks } from "./jobs.js";
import type { RuntimeCleanupWorker } from "../runtime/cleanup.js";

export type SchedulerErrorCode = "scheduler_not_started" | "scheduler_closed" | "scheduler_queue_full" | "deadline" | "aborted";

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode) {
    super(code);
    this.name = "SchedulerError";
    this.code = code;
  }
}

export interface InteractiveRunOptions {
  readonly deadlineAt: string;
  readonly signal?: AbortSignal;
}

export interface SchedulerStatus {
  readonly admission: "open" | "closed";
  readonly failure: "none" | "scheduler_error" | "store_unavailable";
  readonly interactive_queued: number;
  readonly interactive_active: number;
  readonly background_active: number;
  readonly cleanup_active?: number;
  readonly recalls_since_background: number;
  readonly jobs: JobQueueStatus;
}

export interface JobSchedulerOptions {
  /** One trusted warm local model owned by this worker; the scheduler never clones or loads it. */
  readonly embedding?: LocalE5Embedder;
  readonly repository?: JobRepository;
  readonly clock?: () => string;
  readonly interactive_queue_limit?: number;
  readonly interactive_concurrency?: number;
  readonly background_poll_ms?: number;
  /** Compatibility alias for the local fixture chunk budget. */
  readonly background_budget_ms?: number;
  readonly local_chunk_budget_ms?: number;
  readonly hooks?: JobRunnerHooks;
  readonly cleanupWorker?: RuntimeCleanupWorker;
}

export interface JobScheduler {
  start(): void;
  runInteractive<T>(
    options: InteractiveRunOptions,
    operation: (signal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T>;
  embedQuery(
    options: InteractiveRunOptions,
    text: string,
  ): Promise<readonly Float32Array[] | undefined>;
  runSynchronous<T>(operation: () => T): T;
  runExclusive<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  stop(options: { readonly timeoutMs: number }): Promise<SchedulerStatus>;
  status(): SchedulerStatus;
}

interface QueuedInteractive<T> {
  readonly deadlineAt: string;
  readonly signal: AbortSignal | undefined;
  readonly operation: (signal: AbortSignal) => T | PromiseLike<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  settled: boolean;
  started: boolean;
  deadlineTimer: (() => void) | undefined;
  callerAbort: (() => void) | undefined;
}

interface ActiveBackground {
  readonly claim: JobClaim;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly lane: "local";
}

const DEFAULT_POLL_MS = 100;
const DEFAULT_INTERACTIVE_QUEUE_LIMIT = 8;
const DEFAULT_INTERACTIVE_CONCURRENCY = 1;
const DEFAULT_LOCAL_CHUNK_BUDGET_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const dateTimeSchema = z.iso.datetime({ offset: true });

function parseTime(value: string): number {
  const parsedValue = dateTimeSchema.safeParse(value);
  if (!parsedValue.success) throw new SchedulerError("deadline");
  const parsed = Date.parse(parsedValue.data);
  if (!Number.isFinite(parsed)) throw new SchedulerError("deadline");
  return parsed;
}

function safeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) throw new SchedulerError("scheduler_closed");
  return value;
}

class DefaultJobScheduler implements JobScheduler {
  private readonly database: AgentMemoryDatabase;
  private readonly repository: JobRepository;
  private readonly embedding: LocalE5Embedder | undefined;
  private readonly clock: () => string;
  private readonly queueLimit: number;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly localChunkBudgetMs: number;
  private readonly hooks: JobRunnerHooks;
  private readonly cleanupWorker: RuntimeCleanupWorker | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private exclusiveMaintenance = false;
  private readonly interactiveQueue: QueuedInteractive<unknown>[] = [];
  private readonly activeBackground = new Map<string, ActiveBackground>();
  private readonly activeInteractiveControllers = new Set<AbortController>();
  private readonly activeInteractiveStopRejectors = new Map<AbortController, () => void>();
  private readonly activeInteractivePromises = new Set<Promise<void>>();
  private embeddingDisposePromise: Promise<void> | undefined;
  private lastJobs: JobQueueStatus = { pending: 0, due: 0, running: 0, paused: 0, failed: 0, completed: 0 };
  private failure: SchedulerStatus["failure"] = "none";
  private started = false;
  private admissionOpen = false;
  private stopping = false;
  private pumping = false;
  private completedRecallsSinceBackground = 0;
  private activeInteractive = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(database: AgentMemoryDatabase, options: JobSchedulerOptions) {
    this.database = database;
    this.repository = options.repository ?? database.jobs;
    this.embedding = options.embedding;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.queueLimit = options.interactive_queue_limit ?? DEFAULT_INTERACTIVE_QUEUE_LIMIT;
    this.concurrency = options.interactive_concurrency ?? DEFAULT_INTERACTIVE_CONCURRENCY;
    this.pollMs = options.background_poll_ms ?? DEFAULT_POLL_MS;
    this.localChunkBudgetMs = options.local_chunk_budget_ms ?? options.background_budget_ms ?? DEFAULT_LOCAL_CHUNK_BUDGET_MS;
    this.hooks = options.hooks ?? {};
    this.cleanupWorker = options.cleanupWorker;
    if (!Number.isSafeInteger(this.queueLimit) || this.queueLimit < 1 || this.queueLimit > 64) throw new SchedulerError("scheduler_queue_full");
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 4) throw new SchedulerError("scheduler_queue_full");
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 10 || this.pollMs > 10_000) throw new SchedulerError("scheduler_closed");
    if (!Number.isSafeInteger(this.localChunkBudgetMs) || this.localChunkBudgetMs < 1 || this.localChunkBudgetMs > 5_000) throw new SchedulerError("scheduler_closed");
  }

  start(): void {
    // A stopped generation may still own work and a deferred disposal callback.
    if (this.stopping) {
      const drainedModelFreeGeneration = this.embedding === undefined &&
        this.activeBackground.size === 0 &&
        this.activeInteractivePromises.size === 0 &&
        this.interactiveQueue.length === 0 &&
        this.cleanupTimer === undefined &&
        this.cleanupPromise === undefined &&
        !this.exclusiveMaintenance &&
        this.embeddingDisposePromise === undefined;
      if (!drainedModelFreeGeneration) throw new SchedulerError("scheduler_closed");
      this.stopping = false;
    }
    if (this.started) return;
    if (this.embedding !== undefined && this.embedding.report().state !== "ready") {
      throw new SchedulerError("scheduler_closed");
    }
    this.started = true;
    this.admissionOpen = true;
    this.stopping = false;
    this.failure = "none";
    if (this.cleanupWorker !== undefined) {
      try {
        const report = this.cleanupWorker.reconcileStartupSync();
        if (report.remaining > 0) {
          this.scheduleCleanupPump();
        }
      } catch (error: unknown) { this.reportFailure(error, "store_unavailable"); }
    }
    this.schedulePump(0);
  }

  runInteractive<T>(
    options: InteractiveRunOptions,
    operation: (signal: AbortSignal) => T | PromiseLike<T>,
  ): Promise<T> {
    if (!this.started) return Promise.reject(new SchedulerError("scheduler_not_started"));
    if (!this.admissionOpen) return Promise.reject(new SchedulerError("scheduler_closed"));
    if (typeof options !== "object" || options === null || typeof operation !== "function") {
      return Promise.reject(new SchedulerError("scheduler_closed"));
    }
    let deadline: number;
    try {
      deadline = parseTime(options.deadlineAt);
      if (Date.parse(this.clock()) >= deadline) return Promise.reject(new SchedulerError("deadline"));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(new SchedulerError("aborted"));
    if (this.interactiveQueue.length + this.activeInteractive >= this.queueLimit) {
      return Promise.reject(new SchedulerError("scheduler_queue_full"));
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedInteractive<T> = {
        deadlineAt: options.deadlineAt,
        signal: options.signal,
        operation,
        resolve,
        reject,
        settled: false,
        started: false,
        deadlineTimer: undefined,
        callerAbort: undefined,
      };
      this.interactiveQueue.push(queued as QueuedInteractive<unknown>);
      this.armQueuedDeadline(queued as QueuedInteractive<unknown>, deadline);
      this.schedulePump(0);
    });
  }

  embedQuery(options: InteractiveRunOptions, text: string): Promise<readonly Float32Array[] | undefined> {
    const embedding = this.embedding;
    if (embedding === undefined) return Promise.resolve(undefined);
    return this.runInteractive(options, (signal) => {
      return embedding.embed({ kind: "query", texts: [text], signal });
    });
  }

  runSynchronous<T>(operation: () => T): T {
    if (!this.started || !this.admissionOpen || this.stopping || this.failure !== "none" || this.exclusiveMaintenance || this.cleanupPromise !== undefined) throw new SchedulerError("scheduler_closed");
    return operation();
  }

  runExclusive<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (!this.started && !this.stopping) return Promise.reject(new SchedulerError("scheduler_not_started"));
    if ((this.started ? !this.admissionOpen || this.stopping : !this.stopping) || this.exclusiveMaintenance || this.activeInteractive !== 0 || this.interactiveQueue.length !== 0 || this.cleanupPromise !== undefined) {
      return Promise.reject(new SchedulerError("scheduler_closed"));
    }
    this.exclusiveMaintenance = true;
    if (this.cleanupTimer !== undefined) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    const background = [...this.activeBackground.values()];
    for (const active of background) {
      try { this.repository.pause(active.claim, "shutdown"); } catch { /* preserve the active fence */ }
      active.controller.abort();
    }
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = background.length === 0
      ? Promise.resolve(true)
      : Promise.race([
          Promise.allSettled(background.map((active) => active.done)).then(() => true),
          new Promise<boolean>((resolve) => {
            // ponytail: 5s quiesce ceiling; retry maintenance if a handler ignores abort.
            drainTimer = setTimeout(() => resolve(false), 5_000);
            drainTimer.unref?.();
          }),
        ]);
    return drained
      .then((didDrain) => {
        if (!didDrain) throw new SchedulerError("scheduler_closed");
        return operation();
      })
      .finally(() => {
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        this.exclusiveMaintenance = false;
        if (this.started && this.admissionOpen && !this.stopping && this.failure === "none") {
          this.schedulePump(0);
          this.scheduleCleanupPump();
        }
      });
  }

  async stop(options: { readonly timeoutMs: number }): Promise<SchedulerStatus> {
    const timeoutMs = safeTimeout(options.timeoutMs);
    this.admissionOpen = false;
    this.stopping = true;
    if (!this.started) {
      const activePromises = [
        ...[...this.activeBackground.values()].map((active) => active.done),
        ...this.activeInteractivePromises,
        ...(this.cleanupPromise === undefined ? [] : [this.cleanupPromise]),
      ];
      if (activePromises.length === 0) {
        await this.disposeEmbedding(timeoutMs);
      } else {
        void Promise.allSettled(activePromises)
          .then(() => this.disposeEmbedding(timeoutMs))
          .catch(() => undefined);
      }
      return this.status();
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.cleanupTimer !== undefined) { clearTimeout(this.cleanupTimer); this.cleanupTimer = undefined; }
    for (const queued of this.interactiveQueue.splice(0)) this.settleQueued(queued, new SchedulerError("scheduler_closed"));
    for (const reject of this.activeInteractiveStopRejectors.values()) reject();
    for (const controller of this.activeInteractiveControllers) controller.abort();
    for (const active of this.activeBackground.values()) {
      try {
        this.repository.pause(active.claim, "shutdown");
      } catch {
        // A concurrent expiry or takeover already fenced this claim.
      }
      active.controller.abort();
    }
    const activePromises = [
      ...[...this.activeBackground.values()].map((active) => active.done),
      ...this.activeInteractivePromises,
      ...(this.cleanupPromise === undefined ? [] : [this.cleanupPromise]),
    ];
    let activeSettled = activePromises.length === 0;
    if (activePromises.length > 0 && timeoutMs > 0) {
      activeSettled = await Promise.race([
        Promise.allSettled(activePromises).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
    }
    if (activeSettled) {
      await this.disposeEmbedding(timeoutMs);
    } else {
      // A caller operation that ignores AbortSignal still owns the model until
      // its promise settles. Dispose after that boundary instead of racing a
      // late inference call during bounded scheduler shutdown.
      void Promise.allSettled(activePromises)
        .then(() => this.disposeEmbedding(timeoutMs))
        .catch(() => undefined);
    }
    this.started = false;
    return this.status();
  }

  status(): SchedulerStatus {
    try {
      this.lastJobs = this.repository.status();
    } catch (error: unknown) {
      this.reportFailure(error, "store_unavailable");
    }
    return {
      admission: this.admissionOpen ? "open" : "closed",
      failure: this.failure,
      interactive_queued: this.interactiveQueue.length,
      interactive_active: this.activeInteractive,
      background_active: this.activeBackground.size,
      cleanup_active: this.cleanupPromise === undefined ? 0 : 1,
      recalls_since_background: this.completedRecallsSinceBackground,
      jobs: this.lastJobs,
    };
  }

  private schedulePump(delayMs: number): void {
    if (!this.started || !this.admissionOpen || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delayMs);
    this.timer.unref?.();
  }

  private pump(): void {
    if (!this.started || !this.admissionOpen || this.pumping) return;
    this.pumping = true;
    void this.pumpLoop()
      .catch((error: unknown) => {
        this.failScheduler(error);
      })
      .finally(() => {
        this.pumping = false;
        if (this.started && this.failure === "none") {
          this.schedulePump(this.pollMs);
          this.scheduleCleanupPump();
        }
      });
  }

  private async pumpLoop(): Promise<void> {
    while (this.started && this.admissionOpen && this.failure === "none" && !this.exclusiveMaintenance && this.cleanupPromise === undefined && this.activeInteractive < this.concurrency) {
      if (this.activeInteractive === 0 && this.shouldRunBackground()) {
        if (await this.runBackgroundOnce()) continue;
      }
      const next = this.interactiveQueue.shift();
      if (next === undefined) break;
      this.activeInteractive += 1;
      const running = this.runInteractiveItem(next);
      this.activeInteractivePromises.add(running);
      try {
        await running;
      } finally {
        this.activeInteractivePromises.delete(running);
        this.activeInteractive -= 1;
      }
    }
  }

  private async runInteractiveItem(item: QueuedInteractive<unknown>): Promise<void> {
    const deadline = parseTime(item.deadlineAt);
    if (item.settled) {
      this.clearQueued(item);
      return;
    }
    if (Date.parse(this.clock()) >= deadline) {
      this.settleQueued(item, new SchedulerError("deadline"));
      return;
    }
    if (item.signal?.aborted) {
      this.settleQueued(item, new SchedulerError("aborted"));
      return;
    }
    item.started = true;
    this.clearQueued(item);
    const controller = new AbortController();
    this.activeInteractiveControllers.add(controller);
    let clientSettled = false;
    const settle = (reason: unknown): void => {
      if (clientSettled) return;
      clientSettled = true;
      item.reject(reason);
    };
    const settleSuccess = (value: unknown): void => {
      if (clientSettled) return;
      clientSettled = true;
      item.resolve(value);
      this.completedRecallsSinceBackground += 1;
    };
    const cancelDeadline = this.armDeadlineTimer(deadline, () => {
      settle(new SchedulerError("deadline"));
      controller.abort();
    });
    const callerAbort = (): void => {
      settle(new SchedulerError("aborted"));
      cancelDeadline();
      controller.abort();
    };
    const stopReject = (): void => {
      settle(new SchedulerError("scheduler_closed"));
      cancelDeadline();
      controller.abort();
    };
    if (item.signal !== undefined) item.signal.addEventListener("abort", callerAbort, { once: true });
    this.activeInteractiveStopRejectors.set(controller, stopReject);
    if (controller.signal.aborted) {
      cancelDeadline();
      if (item.signal !== undefined) item.signal.removeEventListener("abort", callerAbort);
      this.activeInteractiveStopRejectors.delete(controller);
      this.activeInteractiveControllers.delete(controller);
      return;
    }
    const operation = Promise.resolve().then(() => item.operation(controller.signal));
    try {
      const value = await operation;
      if (clientSettled) return;
      if (Date.parse(this.clock()) >= deadline) {
        settle(new SchedulerError("deadline"));
      } else if (controller.signal.aborted) {
        settle(this.stopping ? new SchedulerError("scheduler_closed") : new SchedulerError("deadline"));
      } else {
        settleSuccess(value);
      }
    } catch (error: unknown) {
      if (clientSettled) return;
      if (controller.signal.aborted) settle(this.stopping ? new SchedulerError("scheduler_closed") : new SchedulerError("deadline"));
      else settle(error);
    } finally {
      cancelDeadline();
      if (item.signal !== undefined) item.signal.removeEventListener("abort", callerAbort);
      this.activeInteractiveStopRejectors.delete(controller);
      this.activeInteractiveControllers.delete(controller);
    }
  }

  private armQueuedDeadline(item: QueuedInteractive<unknown>, deadline: number): void {
    item.deadlineTimer = this.armDeadlineTimer(deadline, () => {
      if (!item.started) this.settleQueued(item, new SchedulerError("deadline"));
    });
    if (item.settled) {
      this.clearQueued(item);
      return;
    }
    if (item.signal !== undefined) {
      item.callerAbort = () => {
        if (!item.started) this.settleQueued(item, new SchedulerError("aborted"));
      };
      item.signal.addEventListener("abort", item.callerAbort, { once: true });
    }
  }

  private settleQueued(item: QueuedInteractive<unknown>, reason: unknown): void {
    if (item.started || item.settled) return;
    item.settled = true;
    const index = this.interactiveQueue.indexOf(item);
    if (index >= 0) this.interactiveQueue.splice(index, 1);
    this.clearQueued(item);
    item.reject(reason);
  }

  private clearQueued(item: QueuedInteractive<unknown>): void {
    if (item.deadlineTimer !== undefined) {
      item.deadlineTimer();
      item.deadlineTimer = undefined;
    }
    if (item.callerAbort !== undefined && item.signal !== undefined) {
      item.signal.removeEventListener("abort", item.callerAbort);
      item.callerAbort = undefined;
    }
  }

  private armDeadlineTimer(deadline: number, callback: () => void): () => void {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (cancelled) return;
      let now: number;
      try {
        now = parseTime(this.clock());
      } catch {
        callback();
        return;
      }
      const remaining = deadline - now;
      if (remaining <= 0) {
        callback();
        return;
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      // A queued or active caller is awaiting this deadline; keep Node alive.
    };
    arm();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }

  private shouldRunBackground(): boolean {
    if (this.activeBackground.size > 0) return false;
    const now = this.clock();
    const queue = this.repository.status();
    if (queue.due === 0) return false;
    if (this.interactiveQueue.length === 0) return true;
    if (this.completedRecallsSinceBackground < 10) return false;
    const next = this.interactiveQueue[0];
    if (next === undefined) return true;
    return parseTime(next.deadlineAt) - parseTime(now) > this.localChunkBudgetMs;
  }

  private async runBackgroundOnce(): Promise<boolean> {
    if (this.embedding === undefined) return false;
    const claim = this.repository.claimNext(undefined, "embed");
    if (claim === undefined) return false;
    this.completedRecallsSinceBackground = 0;
    const controller = new AbortController();
    const done = this.executeEmbeddingBackground(claim, controller);
    const active: ActiveBackground = { claim, controller, done, lane: "local" };
    this.activeBackground.set(claim.job_id, active);
    try {
      await done;
    } finally {
      this.finishBackground(claim.job_id);
    }
    return true;
  }

  private async executeEmbeddingBackground(claim: JobClaim, controller: AbortController): Promise<void> {
    const embedding = this.embedding;
    if (
      embedding === undefined ||
      typeof embedding.countTokens !== "function" ||
      embedding.manifest.model_id !== E5_MODEL_MANIFEST.model_id ||
      embedding.manifest.revision !== E5_MODEL_MANIFEST.revision ||
      embedding.manifest.dimensions !== E5_MODEL_MANIFEST.dimensions ||
      embedding.manifest.max_tokens !== E5_MODEL_MANIFEST.max_tokens
    ) {
      this.pauseBackground(claim, "handler_unavailable");
      return;
    }
    try {
      const source = this.database.getVectorProjectionSource(claim.scope_id, claim.source_capture_id);
      const generation = this.database.getActiveVectorGeneration();
      const countTokens = (formatted: string): number => {
        const prefix = "passage: ";
        if (!formatted.startsWith(prefix)) throw new Error("vector_prefix_invalid");
        return embedding.countTokens!({ kind: "passage", text: formatted.slice(prefix.length) });
      };
      const chunks: Array<{
        readonly span_id: string;
        readonly text: string;
        readonly start_utf16: number;
        readonly end_utf16: number;
        readonly span_digest: string;
        readonly revision_id?: string;
      }> = [];
      for (const span of source.spans) {
        const texts = chunkPassageForE5(span.text, countTokens);
        let cursor = 0;
        const revisionIds = span.revision_ids.length === 0 ? [undefined] : span.revision_ids;
        for (const text of texts) {
          const offset = span.text.indexOf(text, cursor);
          if (offset < 0) throw new Error("vector_chunk_source_mapping");
          cursor = offset + text.length;
          for (const revisionId of revisionIds) {
            chunks.push({
              span_id: span.span_id,
              text,
              start_utf16: span.start_utf16 + offset,
              end_utf16: span.start_utf16 + offset + text.length,
              span_digest: span.digest,
              ...(revisionId === undefined ? {} : { revision_id: revisionId }),
            });
          }
        }
      }
      if (chunks.length === 0 || chunks.length > 128) throw new Error("vector_projection_batch");
      const vectors = await embedding.embed({ kind: "passage", texts: chunks.map((chunk) => chunk.text), signal: controller.signal });
      if (vectors.length !== chunks.length) throw new Error("vector_count_mismatch");
      const projections: VectorChunkProjection[] = chunks.map((chunk, index) => {
        const vector = vectors[index];
        if (vector === undefined) throw new Error("vector_count_mismatch");
        const chunkId = randomUUID();
        return {
          chunk_id: chunkId,
          scope_id: claim.scope_id,
          source_id: claim.source_capture_id,
          span_id: chunk.span_id,
          ...(chunk.revision_id === undefined ? {} : { revision_id: chunk.revision_id }),
          chunk_index: index,
          text: chunk.text,
          input_digest: vectorInputDigest({
            scope_id: claim.scope_id,
            source_id: claim.source_capture_id,
            span_id: chunk.span_id,
            chunk_index: index,
            text: chunk.text,
            profile_id: VECTOR_PROFILE_ID,
            tokenizer_version: VECTOR_TOKENIZER_VERSION,
            chunker_version: VECTOR_CHUNKER_VERSION,
            generation,
          }),
          profile_id: VECTOR_PROFILE_ID,
          tokenizer_version: VECTOR_TOKENIZER_VERSION,
          chunker_version: VECTOR_CHUNKER_VERSION,
          generation,
          vector,
          source_digest: digestText(chunk.text),
          source_span_digest: chunk.span_digest,
          start_utf16: chunk.start_utf16,
          end_utf16: chunk.end_utf16,
        };
      });
      const resultDigest = vectorProjectionReceiptDigest(projections);
      const completed = this.database.completeVectorProjection(claim, projections, resultDigest);
      if (completed.status === "completed") this.safeHook(() => this.hooks.onCompleted?.(claim));
    } catch (error: unknown) {
      if (controller.signal.aborted) this.pauseBackground(claim, this.stopping ? "shutdown" : "execution_deadline");
      else this.retryBackground(claim);
    }
  }

  private finishBackground(jobId: string): void {
    this.activeBackground.delete(jobId);
    if (this.started && this.failure === "none") {
      this.schedulePump(0);
      this.scheduleCleanupPump();
    }
  }

  private scheduleCleanupPump(): void {
    if (
      this.cleanupTimer !== undefined ||
      this.cleanupPromise !== undefined ||
      this.exclusiveMaintenance ||
      this.cleanupWorker === undefined ||
      !this.started ||
      !this.admissionOpen ||
      this.stopping ||
      this.activeInteractive !== 0 ||
      this.interactiveQueue.length !== 0 ||
      this.activeBackground.size !== 0
    ) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      if (
        !this.started ||
        !this.admissionOpen ||
        this.stopping ||
        this.exclusiveMaintenance ||
        this.activeInteractive !== 0 ||
        this.interactiveQueue.length !== 0 ||
        this.activeBackground.size !== 0
      ) {
        this.scheduleCleanupPump();
        return;
      }
      let remaining = false;
      const cleanup = this.cleanupWorker!.reconcileStartup().then(
        (report) => { remaining = report.remaining > 0; },
        (error: unknown) => { this.reportFailure(error, "store_unavailable"); },
      );
      this.cleanupPromise = cleanup.finally(() => {
        this.cleanupPromise = undefined;
        if (this.started && this.admissionOpen && !this.stopping && this.failure === "none") {
          if (remaining) this.scheduleCleanupPump();
          else this.schedulePump(0);
        }
      });
    }, 50);
    this.cleanupTimer.unref?.();
  }

  private pauseBackground(claim: JobClaim, reason: Parameters<JobRepository["pause"]>[1]): void {
    try {
      const paused = this.repository.pause(claim, reason);
      if (paused !== undefined) this.safeHook(() => this.hooks.onPaused?.(claim, reason));
    } catch (error: unknown) {
      if (!isExpectedJobRace(error)) this.reportFailure(error, "store_unavailable");
    }
  }

  private retryBackground(claim: JobClaim): void {
    try {
      const retry = this.repository.retry(claim);
      if (retry !== undefined) this.safeHook(() => this.hooks.onRetried?.(claim, retry));
    } catch (error: unknown) {
      if (!isExpectedJobRace(error)) this.reportFailure(error, "store_unavailable");
    }
  }

  private safeHook(callback: () => void): void {
    try {
      callback();
    } catch (error: unknown) {
      this.reportFailure(error, "scheduler_error");
    }
  }

  private reportFailure(error: unknown, failure: SchedulerStatus["failure"]): void {
    const changed = this.failure !== failure;
    this.failure = failure;
    this.admissionOpen = false;
    if (changed) {
      try {
        this.hooks.onError?.(error);
      } catch {
        // Error reporting must not create another scheduler failure.
      }
    }
  }

  private async disposeEmbedding(timeoutMs: number): Promise<void> {
    if (this.embedding === undefined) return;
    if (this.embeddingDisposePromise === undefined) {
      const attempt = Promise.resolve().then(() => this.embedding?.dispose({ timeout_ms: Math.max(1, timeoutMs) }));
      this.embeddingDisposePromise = attempt.then(
        () => undefined,
        (error: unknown) => {
          this.embeddingDisposePromise = undefined;
          this.reportFailure(error, "scheduler_error");
        },
      );
    }
    await this.embeddingDisposePromise;
  }

  private failScheduler(error: unknown): void {
    this.reportFailure(error, "scheduler_error");
    for (const queued of this.interactiveQueue.splice(0)) this.settleQueued(queued, new SchedulerError("scheduler_closed"));
    for (const reject of this.activeInteractiveStopRejectors.values()) reject();
    for (const controller of this.activeInteractiveControllers) controller.abort();
    for (const active of this.activeBackground.values()) {
      this.pauseBackground(active.claim, "shutdown");
      active.controller.abort();
    }
  }
}

function isExpectedJobRace(error: unknown): boolean {
  return (
    error instanceof StoreError &&
    (error.code === "job_claim_conflict" || error.code === "job_not_found" || error.code === "job_stale" || error.code === "job_lease_expired")
  );
}

export function createJobScheduler(database: AgentMemoryDatabase, options: JobSchedulerOptions = {}): JobScheduler {
  return new DefaultJobScheduler(database, options);
}
