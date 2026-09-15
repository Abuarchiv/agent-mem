import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { redactCaptureInput } from "../core/redact.js";
import { capture } from "../core/capture.js";
import { fullPurge, type FullPurgeRequest, type FullPurgeResult } from "../core/purge.js";
import { createPreparationContext, type PreparationContext } from "../context/packet.js";
import { prepareSourceEvidencePacket } from "../context/source-only.js";
import { createJobScheduler, type InteractiveRunOptions } from "../worker/main.js";
import { RuntimeCleanupWorker } from "../runtime/cleanup.js";
import { E5ModelError, loadE5Embedder, type LocalE5Embedder } from "../models/embedding.js";
import type { LocalReranker } from "../models/rerank.js";
import { E5_MODEL_MANIFEST, ModelArtifactError } from "../models/manifest.js";
import { activateRestore, resumeRestoreActivation, createBackup, restoreBackup } from "../store/backup.js";
import { AgentMemoryDatabase, StoreError } from "../store/database.js";
import { retrievalQuery, type SourceIntelligenceOptions } from "../retrieval/source-intelligence.js";
import { VECTOR_CHUNKER_VERSION } from "../retrieval/vector.js";
import {
  isPolicyOutputBinding,
  isPolicySetupBinding,
  type PolicyOutputBinding,
  type PolicySetupBinding,
} from "../core/policy.js";
import { createTrustedBinding, isTrustedBinding, type EvidencePacket, type TrustedBinding } from "../host/contract.js";
import type { SearchState } from "../v1/search-state.js";
import { assertPrivatePath, ensurePrivateDirectory } from "../v1/private-files.js";
import type { BrokerOwner } from "../host/broker.js";

const textSchema = z.string().trim().min(1).max(6_000).refine((text) => Buffer.byteLength(text, "utf8") <= 6_000, "text_exceeds_source_batch");
const MAINTENANCE_DEADLINE_MS = 60_000;
const defaultVaultPath = resolve(homedir(), "Library/Application Support/Agent Memory System/vault.sqlite");

export interface RuntimeScope {
  readonly scope_id: string;
  readonly kind: "project" | "personal";
  readonly owner_ref: string;
  readonly created_at: string;
}

export interface RuntimeOwnerOptions {
  readonly vaultPath?: string;
  /** Existing initialized vaults must be opened read/write, never recreated. */
  readonly requireExisting?: boolean;
  readonly embeddingModelRoot?: string;
  /** One caller-owned warm E5 instance. The owner disposes it at terminal close. */
  readonly embedding?: LocalE5Embedder;
  readonly reloadEmbedding?: () => Promise<LocalE5Embedder>;
  readonly embeddingTaskVersion?: string;
  /** One caller-owned warm local source reranker. The owner disposes it at terminal close. */
  readonly sourceReranker?: () => Promise<LocalReranker>;
  /** Optional private feedback/procedure state shared by source retrieval. */
  readonly searchState?: SearchState;
  /** Scope, policy and output bindings are supplied by the selected owner. */
  readonly scope: RuntimeScope;
  readonly policyBinding: PolicySetupBinding;
  readonly outputBinding: PolicyOutputBinding;
  /** Manual capture/query require this actual trusted host binding. */
  readonly hostBinding?: TrustedBinding;
  /** Explicit setup grants; the shared owner never invents grants. */
  readonly initialize?: (database: AgentMemoryDatabase, updatedAt: string) => void;
}

export type RuntimeOwner = Awaited<ReturnType<typeof createRuntime>>;

function validateOptions(options: RuntimeOwnerOptions): void {
  if (typeof options !== "object" || options === null) throw new Error("runtime_options_invalid");
  if (options.sourceReranker !== undefined && typeof options.sourceReranker !== "function") throw new Error("runtime_source_reranker_invalid");
  if (!z.uuid().safeParse(options.scope.scope_id).success || !z.iso.datetime({ offset: true }).safeParse(options.scope.created_at).success) {
    throw new Error("runtime_scope_invalid");
  }
  if (!isPolicySetupBinding(options.policyBinding) || !isPolicyOutputBinding(options.outputBinding)) throw new Error("runtime_policy_invalid");
  if (!options.policyBinding.allowed_scope_ids.includes(options.scope.scope_id) || options.outputBinding.scope_id !== options.scope.scope_id || options.outputBinding.setup_id !== options.policyBinding.setup_id) {
    throw new Error("runtime_policy_invalid");
  }
  if (options.hostBinding !== undefined) {
    if (!isTrustedBinding(options.hostBinding) || !options.hostBinding.allowed_scope_ids.includes(options.scope.scope_id)) throw new Error("runtime_host_binding_invalid");
  }
}

function lifecycleErrorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { readonly code?: unknown }).code === "string") {
    return (error as { readonly code: string }).code;
  }
  if (error instanceof Error && /^[A-Za-z0-9_.:-]+$/.test(error.message)) return error.message;
  return fallback;
}

/** One shared source database, E5 owner and deterministic scheduler. */
export async function createRuntime(options: RuntimeOwnerOptions) {
  validateOptions(options);
  const vaultPath = resolve(options.vaultPath ?? defaultVaultPath);
  ensurePrivateDirectory(dirname(vaultPath));
  if (existsSync(vaultPath)) assertPrivatePath(vaultPath, undefined, "vault_file_must_be_owned_and_private");
  if ((options.requireExisting ?? false) && !existsSync(vaultPath)) throw new StoreError("restore_quarantined");
  if (existsSync(vaultPath)) resumeRestoreActivation(vaultPath);

  let embedding = options.embedding;
  let embeddingError: string | null = null;
  let sourceReranker: LocalReranker | undefined;
  let sourceRerankerError: string | null = options.sourceReranker === undefined ? "source_reranker_not_configured" : null;
  const sourceRerankerFactory = options.sourceReranker;
  const loadSourceReranker = async (): Promise<LocalReranker | undefined> => {
    if (sourceRerankerFactory === undefined) {
      sourceRerankerError = "source_reranker_not_configured";
      return undefined;
    }
    let loaded: LocalReranker | undefined;
    try {
      loaded = await sourceRerankerFactory();
      if (loaded === undefined || typeof loaded.report !== "function") throw new Error("source_reranker_invalid");
      if (loaded.report().state !== "ready") throw new Error("source_reranker_not_ready");
      sourceRerankerError = null;
      return loaded;
    } catch (error: unknown) {
      if (loaded !== undefined) {
        try { await loaded.dispose({ timeout_ms: 5_000 }); } catch { /* preserve the load failure */ }
      }
      sourceRerankerError = lifecycleErrorCode(error, "source_reranker_unavailable");
      return undefined;
    }
  };
  if (sourceRerankerFactory !== undefined) sourceReranker = await loadSourceReranker();
  if (embedding === undefined) {
    try {
      embedding = await loadE5Embedder({ modelRoot: options.embeddingModelRoot ?? fileURLToPath(new URL(`../../../.models/e5/${E5_MODEL_MANIFEST.model_id}/${E5_MODEL_MANIFEST.revision}`, import.meta.url)) });
    } catch (error) {
      if (!(error instanceof E5ModelError) && !(error instanceof ModelArtifactError)) {
        try { await sourceReranker?.dispose({ timeout_ms: 5_000 }); } catch { /* preserve the E5 failure */ }
        throw error;
      }
      embeddingError = error.code;
    }
  }

  let openingDatabase: AgentMemoryDatabase | undefined;
  let openingReader: DatabaseSync | undefined;
  try {
    const embeddingTaskVersion = options.embeddingTaskVersion ?? "offline-e5-v1";
    const database = new AgentMemoryDatabase(vaultPath, {
      require_existing: options.requireExisting ?? false,
      embedding_task_version: embeddingTaskVersion,
      extraction_enabled: false,
      job_lease_ms: 150_000,
    });
    openingDatabase = database;
    const scopeId = options.scope.scope_id;
    const stamp = () => new Date().toISOString();
    database.registerScope(options.scope);
    if (options.hostBinding !== undefined) database.registerSession(scopeId, options.hostBinding, stamp());
    if (options.initialize !== undefined) options.initialize(database, stamp());
    const reader = new DatabaseSync(vaultPath, { readOnly: true });
    openingReader = reader;
    // Recover the DB/sidecar crash gap before admitting any search or capture.
    // A newly observed purge epoch resets feedback once; its historical
    // tombstones do not reset newer feedback again on restart.
    if (options.searchState) {
      const tombstoneExists = reader.prepare("SELECT 1 AS present FROM purge_tombstone WHERE scope_id = ? LIMIT 1");
      for (const scope of options.policyBinding.allowed_scope_ids) {
        if (tombstoneExists.get(scope) === undefined) continue;
        const registered = [...new Set(options.searchState.procedures(scope).map((rule) => rule.capture_id))];
        const ids = registered.length === 0
          ? []
          : reader.prepare(`SELECT capture_id FROM purge_tombstone WHERE scope_id = ? AND capture_id IN (${registered.map(() => "?").join(", ")})`).all(scope, ...registered).map((row) => String(row.capture_id));
        options.searchState.reconcilePurges(scope, database.getScopePrivacyEpoch(scope), ids);
      }
    }
    for (const row of reader.prepare("SELECT job_id, CAST(fence AS TEXT) AS fence FROM job WHERE task_kind = 'embed' AND state = 'paused' AND pause_reason = 'shutdown'").all()) {
      database.jobs.resume({ job_id: String(row.job_id), expected_fence: String(row.fence), expected_reason: "shutdown", now: stamp() });
    }
    database.ensureVectorIndexCurrent(embeddingTaskVersion, VECTOR_CHUNKER_VERSION, stamp());
    let closed = false;
    let closing = false;
    let closeInFlight: Promise<void> | undefined;
    let activeMaintenance = 0;
    let maintenanceIdle = Promise.resolve();
    let resolveMaintenanceIdle: (() => void) | undefined;
    let schedulerStopInFlight: Promise<void> | undefined;
    const runtimeHost = options.hostBinding;
    const cleanupWorker = new RuntimeCleanupWorker(database.runtimeArtifacts);
    const newScheduler = () => createJobScheduler(database, {
      ...(embedding === undefined ? {} : { embedding }),
      background_poll_ms: 50,
      cleanupWorker,
    });
    let scheduler = newScheduler();
    let resetting = false;
    let resetInFlight: Promise<boolean> | undefined;
    function sourceRerankerStatus(): { readonly state: "disabled" | "ready" | "disposing" | "disposed" | "unavailable"; readonly reason: string | null } {
      if (sourceReranker === undefined) return { state: sourceRerankerFactory === undefined ? "disabled" : "unavailable", reason: sourceRerankerError };
      try {
        return { state: sourceReranker.report().state, reason: sourceRerankerError };
      } catch (error: unknown) {
        sourceRerankerError = lifecycleErrorCode(error, "source_reranker_unavailable");
        return { state: "unavailable", reason: sourceRerankerError };
      }
    }
    async function disposeSourceReranker(): Promise<boolean> {
      if (sourceReranker === undefined) return true;
      try {
        await sourceReranker.dispose({ timeout_ms: 5_000 });
        if (sourceReranker.report().state !== "disposed") throw new Error("source_reranker_disposal_pending");
        sourceReranker = undefined;
        sourceRerankerError = sourceRerankerFactory === undefined ? "source_reranker_not_configured" : "source_reranker_reset_pending";
        return true;
      } catch (error: unknown) {
        sourceRerankerError = lifecycleErrorCode(error, "source_reranker_disposal_failed");
        return false;
      }
    }
    function reconcileSearchStatePurge(scopeId: string, captureIds: readonly string[]): void {
      if (options.searchState === undefined) return;
      const registered = new Set(options.searchState.procedures(scopeId).map((rule) => rule.capture_id));
      const relevant = [...new Set(captureIds.filter((captureId) => registered.has(captureId)))];
      options.searchState.reconcilePurges(scopeId, database.getScopePrivacyEpoch(scopeId), relevant);
    }
    async function resetOwnedRuntime(request: FullPurgeRequest): Promise<boolean> {
      if (resetInFlight !== undefined) return resetInFlight;
      resetting = true;
      if (sourceRerankerFactory !== undefined) sourceRerankerError = "source_reranker_reset_pending";
      resetInFlight = (async () => {
        const stopped = await scheduler.stop({ timeoutMs: 5_000 });
        if (stopped.interactive_active !== 0 || stopped.background_active !== 0 || (stopped.cleanup_active ?? 0) !== 0 || (embedding !== undefined && embedding.report().state !== "disposed")) return false;
        const previousSourceReranker = sourceReranker;
        if (!(await disposeSourceReranker())) return false;
        reconcileSearchStatePurge(request.scope_id, request.capture_ids);
        if (options.embedding !== undefined && options.reloadEmbedding === undefined) return false;
        const replacement = options.reloadEmbedding !== undefined ? await options.reloadEmbedding() : embedding === undefined ? undefined : await loadE5Embedder({ modelRoot: options.embeddingModelRoot ?? fileURLToPath(new URL(`../../../.models/e5/${E5_MODEL_MANIFEST.model_id}/${E5_MODEL_MANIFEST.revision}`, import.meta.url)) });
        if (replacement !== undefined && (replacement === embedding || replacement.report().state !== "ready")) return false;
        embedding = replacement;
        options.searchState?.clearReports();
        const replacementSourceReranker = await loadSourceReranker();
        if (replacementSourceReranker !== undefined && replacementSourceReranker === previousSourceReranker) {
          sourceRerankerError = "source_reranker_factory_reused";
          try { await replacementSourceReranker.dispose({ timeout_ms: 5_000 }); } catch { /* fallback remains available */ }
          sourceReranker = undefined;
        } else {
          sourceReranker = replacementSourceReranker;
        }
        scheduler = newScheduler();
        if (!closing) scheduler.start();
        const ready = !closing && scheduler.status().admission === "open";
        resetting = !ready;
        return ready;
      })();
      try { return await resetInFlight; } finally { resetInFlight = undefined; }
    }

    scheduler.start();

    const readable = () => { assert.ok(!closed, "offline_runtime_closed"); database.getSchemaVersion(); };
    const open = () => { readable(); assert.ok(!closing, "offline_runtime_closing"); };
    function brokerAdmissionError(): Error | undefined {
      if (closed) return new Error("offline_runtime_closed");
      if (closing) return new Error("offline_runtime_closing");
      if (resetting) return new Error("offline_runtime_reset_pending");
      if (activeMaintenance !== 0) return new Error("runtime_maintenance_pending");
      return undefined;
    }
    function runBrokerInteractive<T>(options: InteractiveRunOptions, operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
      const before = brokerAdmissionError();
      if (before !== undefined) return Promise.reject(before);
      const current = scheduler;
      return current.runInteractive(options, (signal) => {
        const during = brokerAdmissionError();
        if (during !== undefined) throw during;
        return operation(signal);
      });
    }
    function runBrokerMutation<T>(operation: () => T): Promise<T> {
      const admission = brokerAdmissionError();
      if (admission !== undefined) return Promise.reject(admission);
      try { return Promise.resolve(scheduler.runSynchronous(operation)); } catch (error: unknown) { return Promise.reject(error); }
    }
    function brokerEmbedQuery(options: InteractiveRunOptions, text: string): Promise<readonly Float32Array[] | undefined> {
      const before = brokerAdmissionError();
      if (before !== undefined) return Promise.reject(before);
      return scheduler.embedQuery(options, retrievalQuery(text));
    }
    function runBrokerDegraded<T>(operation: () => T): Promise<T> {
      const admission = brokerAdmissionError();
      if (admission !== undefined) return Promise.reject(admission);
      const state = scheduler.status();
      if (state.interactive_queued !== 0 || state.interactive_active !== 0 || state.background_active !== 0 || (state.cleanup_active ?? 0) !== 0) {
        return Promise.reject(new Error("runtime_admission_pending"));
      }
      try { return Promise.resolve(operation()); } catch (error: unknown) { return Promise.reject(error); }
    }
    const brokerOwner: BrokerOwner = {
      database,
      get scheduler() { return scheduler; },
      runInteractive: runBrokerInteractive,
      runMutation: runBrokerMutation,
      embedQuery: brokerEmbedQuery,
      runDegraded: runBrokerDegraded,
    };
    function enterMaintenance(): void {
      if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
      if (activeMaintenance === 0) maintenanceIdle = new Promise<void>((resolve) => { resolveMaintenanceIdle = resolve; });
      activeMaintenance += 1;
    }
    function leaveMaintenance(): void {
      activeMaintenance -= 1;
      if (activeMaintenance === 0) {
        const resolveIdle = resolveMaintenanceIdle;
        resolveMaintenanceIdle = undefined;
        resolveIdle?.();
      }
    }
    async function stopAdmissionAfterMaintenance(): Promise<void> {
      await maintenanceIdle;
      if (closed) return;
      if (schedulerStopInFlight !== undefined) { await schedulerStopInFlight; return; }
      const stopping = (async () => { await scheduler.stop({ timeoutMs: 5_000 }); })();
      schedulerStopInFlight = stopping.finally(() => { schedulerStopInFlight = undefined; });
      await schedulerStopInFlight;
    }
    async function runMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
      const schedulerState = scheduler.status();
      if ((schedulerState.cleanup_active ?? 0) !== 0) throw new Error("runtime_maintenance_pending");
      enterMaintenance();
      let operationStarted = false;
      let operationDone = false;
      let resolveOperationDone: (() => void) | undefined;
      const operationSettled = new Promise<void>((resolve) => { resolveOperationDone = resolve; });
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        leaveMaintenance();
      };
      try {
        const deadlineAt = new Date(Date.now() + MAINTENANCE_DEADLINE_MS).toISOString();
        return await scheduler.runInteractive({ deadlineAt }, async (signal) => {
          operationStarted = true;
          try {
            const schedulerState = scheduler.status();
            if (schedulerState.background_active !== 0 || (schedulerState.cleanup_active ?? 0) !== 0) throw new Error("runtime_maintenance_pending");
            return await operation(signal);
          } finally { operationDone = true; resolveOperationDone?.(); }
        });
      } finally {
        if (!operationStarted || operationDone) release();
        else void operationSettled.then(release);
      }
    }
    async function prepareSourceRecall(
      input: unknown,
      binding: TrustedBinding,
      context: PreparationContext,
      queryVector?: Float32Array,
      signal?: AbortSignal,
    ): Promise<EvidencePacket> {
      open();
      assert.ok(!resetting, "offline_runtime_reset_pending");
      const current = sourceReranker;
      const sourceOptions = {
        ...(current === undefined
          ? { rerankerState: sourceRerankerFactory === undefined ? "disabled" as const : "unavailable" as const }
          : { reranker: current }),
        ...(options.searchState === undefined ? {} : { state: options.searchState }),
        ...(signal === undefined ? {} : { signal }),
      } as SourceIntelligenceOptions;
      return await prepareSourceEvidencePacket(database, input, binding, context, queryVector, sourceOptions);
    }
    function closeOwnedRuntime(): Promise<void> {
      if (closeInFlight !== undefined) return closeInFlight;
      if (closed) return Promise.resolve();
      closing = true;
      if (activeMaintenance > 0) {
        void stopAdmissionAfterMaintenance().catch(() => undefined);
        return Promise.reject(new Error("restore_runtime_drain_pending"));
      }
      closeInFlight = (async () => {
        await (schedulerStopInFlight ?? Promise.resolve());
        const stopped = await scheduler.stop({ timeoutMs: 5_000 });
        assert.equal(stopped.interactive_active + stopped.background_active + (stopped.cleanup_active ?? 0), 0, "restore_runtime_drain_pending");
        const closingReranker = sourceReranker;
        if (closingReranker !== undefined) {
          try {
            await closingReranker.dispose({ timeout_ms: 5_000 });
            if (closingReranker.report().state !== "disposed") throw new Error("source_reranker_disposal_pending");
          } catch (error: unknown) {
            sourceRerankerError = lifecycleErrorCode(error, "source_reranker_disposal_failed");
            throw error;
          }
        }
        assert.ok(embedding === undefined || embedding.report().state === "disposed", "restore_model_disposal_pending");
        reader.close();
        database.close();
        closed = true;
      })().finally(() => { closeInFlight = undefined; });
      return closeInFlight;
    }

    const runtime = {
      database,
      policyBinding: options.policyBinding,
      outputBinding: options.outputBinding,
      scopeId,
      brokerOwner,
      prepareSourceRecall,
      async createBackup(destination: string) {
        open();
        const path = z.string().min(1).max(4_096).parse(destination);
        return runMaintenance((signal) => createBackup(database, path, { signal }));
      },
      async restoreBackup(input: unknown) {
        open();
        const request = z.object({ backup_path: z.string().min(1).max(4_096), output_path: z.string().min(1).max(4_096) }).strict().parse(input);
        return runMaintenance((signal) => restoreBackup({ ...request, signal }, database));
      },
      async ingest(input: string) {
        return runBrokerMutation(() => {
          open();
          if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
          assert.ok(runtimeHost !== undefined, "runtime_native_binding_unavailable");
          assert.ok(!resetting, "offline_runtime_reset_pending");
          const rawText = textSchema.parse(input);
          const redacted = redactCaptureInput({ payload: { text: rawText } });
          const text = textSchema.parse(z.object({ payload: z.object({ text: z.string() }) }).parse(redacted.value).payload.text);
          const captureId = randomUUID();
          const spanId = randomUUID();
          const now = stamp();
          database.registerSession(scopeId, runtimeHost, now);
          capture({ version: 1, capture_id: captureId, scope_id: scopeId, origin: { host_kind: runtimeHost.host_kind, surface: runtimeHost.surface, execution_domain: runtimeHost.execution_domain, host_instance_id: runtimeHost.host_instance_id, host_session_id: runtimeHost.host_session_id }, adapter_version: "0.1.0", event: { stage: "prompt_submitted", role: "user", evidence_class: "prompt", native_ids: { session_id: runtimeHost.host_session_id, turn_id: captureId }, text: rawText }, payload: { text: rawText }, captured_at: now, occurred_at: now, truncation: { truncated: false }, redaction: { applied: true, policy_version: "1" } }, runtimeHost, database, { source_spans: [{ span_id: spanId, root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length, digest: createHash("sha256").update(text).digest("hex") }] });
          const job = database.getJobByCaptureId(captureId);
          return { capture_id: captureId, job_id: job?.job_id ?? null, state: job?.state ?? "stored" };
        });
      },
      async query(input: string) {
        if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
        open();
        assert.ok(runtimeHost !== undefined, "runtime_native_binding_unavailable");
        assert.ok(!resetting, "offline_runtime_reset_pending");
        const text = z.string().trim().min(1).max(2_000).parse(input);
        const deadlineAt = new Date(Date.now() + 15_000).toISOString();
        let vector: Float32Array | undefined;
        try {
          vector = (await brokerEmbedQuery({ deadlineAt }, text))?.[0];
          if (embedding !== undefined) embeddingError = vector === undefined ? "model_output_invalid" : null;
        } catch (error) {
          if (!(error instanceof E5ModelError) && !(error instanceof ModelArtifactError)) throw error;
          embeddingError = error.code;
        }
        return runBrokerInteractive({ deadlineAt }, async (signal) => {
          if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
          open();
          assert.ok(!resetting, "offline_runtime_reset_pending");
          const queryHost = createTrustedBindingForQuery(runtimeHost);
          database.registerSession(scopeId, queryHost, stamp());
          const request = { query: text, scope_ids: [scopeId], mode: "current" as const, token_budget: 8_192 };
          const context = createPreparationContext(queryHost, { version: 1, kind: "session_start", deadline_at: deadlineAt, capture_status: { state: "not_attempted" }, exclude_current_session_prompts: true, budget: { session_start_tokens: 8_192 } });
          const packet = await prepareSourceRecall(request, queryHost, context, vector, signal);
          const captures = packet.items.filter((item) => item.kind === "source").map((item) => item.item_id);
          const sources = captures.flatMap((id) => { const source = database.getSourceForOutput(id, options.outputBinding); return source === undefined ? [] : [{ capture_id: id, text: (JSON.parse(source.payload_json) as { text: string }).text }]; });
          return { packet, facts: [], summaries: [], sources };
        });
      },
      status() {
        readable();
        const schedulerState = scheduler.status();
        const readinessError = closing ? "runtime_close_pending" : resetting ? "model_reset_pending" : schedulerState.admission !== "open" ? "runtime_admission_closed" : embedding !== undefined && embedding.report().state !== "ready" ? "model_not_ready" : embeddingError;
        return { state: readinessError === null ? "core_ready" as const : "degraded" as const, semantic_search: { state: readinessError === null ? "ready" as const : "unavailable" as const, reason: readinessError }, source_reranker: sourceRerankerStatus(), model: E5_MODEL_MANIFEST.model_id, native_binding: runtimeHost === undefined ? { state: "unavailable" as const, reason: "runtime_native_binding_unavailable" } : { state: "available" as const }, scope_id: scopeId, jobs: schedulerState.jobs, sources: reader.prepare("SELECT e.capture_id, j.job_id, j.state, j.pause_reason FROM source_event e LEFT JOIN job j ON j.source_capture_id = e.capture_id AND j.task_kind = 'embed' WHERE e.scope_id = ? ORDER BY e.commit_seq DESC LIMIT 50").all(scopeId).map((row) => ({ capture_id: String(row.capture_id), job_id: row.job_id === null || row.job_id === undefined ? null : String(row.job_id), state: row.state === null || row.state === undefined ? "stored" : String(row.state), pause_reason: row.pause_reason === null || row.pause_reason === undefined ? null : String(row.pause_reason) })) };
      },
      async purgeSources(request: FullPurgeRequest): Promise<FullPurgeResult> {
        open();
        const selectedScope = z.uuid().parse(request.scope_id);
        if (!options.policyBinding.allowed_scope_ids.includes(selectedScope)) throw new StoreError("scope_not_allowed");
        if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
        if ((scheduler.status().cleanup_active ?? 0) !== 0) throw new Error("runtime_maintenance_pending");
        enterMaintenance();
        try {
          return await scheduler.runExclusive(async () => {
            return fullPurge(database, options.policyBinding, request, { runtime_cleanup_worker: cleanupWorker, runtime_owner: { id: "runtime-owner-e5-v1", requirement: "required", reset: () => resetOwnedRuntime(request) } });
          });
        } finally { leaveMaintenance(); }
      },
      async purge(captureId: string, expectedPrivacyEpoch?: string, targetScopeId = scopeId) {
        open();
        const selectedId = z.uuid().parse(captureId);
        const selectedScope = z.uuid().parse(targetScopeId);
        if (!options.policyBinding.allowed_scope_ids.includes(selectedScope)) throw new StoreError("scope_not_allowed");
        if (activeMaintenance !== 0) throw new Error("runtime_maintenance_pending");
        if ((scheduler.status().cleanup_active ?? 0) !== 0) throw new Error("runtime_maintenance_pending");
        const request = database.getPurgeRequestForSource(options.policyBinding, selectedScope, selectedId) ?? { operation_id: randomUUID(), scope_id: selectedScope, capture_ids: [selectedId], expected_privacy_epoch: expectedPrivacyEpoch ?? database.getScopePrivacyEpoch(selectedScope), requested_at: stamp() };
        return runtime.purgeSources({ version: 1, operation_id: request.operation_id, scope_id: request.scope_id, capture_ids: [...request.capture_ids], expected_privacy_epoch: request.expected_privacy_epoch, requested_at: request.requested_at });
      },
      close: closeOwnedRuntime,
    };

    type ActiveRuntime = typeof runtime & { activateRestore(input: unknown): Promise<{ vault_path: string; backup_path: string; runtime: ActiveRuntime }> };
    let activationInFlight: Promise<{ vault_path: string; backup_path: string; runtime: ActiveRuntime }> | undefined;
    let activationPath: string | undefined;
    async function activateOwnedRestore(input: unknown): Promise<{ vault_path: string; backup_path: string; runtime: ActiveRuntime }> {
      const request = z.object({ staged_path: z.string().min(1).max(4_096) }).strict().parse(input);
      if (activationInFlight !== undefined) {
        assert.equal(request.staged_path, activationPath, "restore_activation_pending");
        return activationInFlight;
      }
      readable();
      if (options.embedding !== undefined && options.reloadEmbedding === undefined) throw new Error("restore_fresh_embedding_factory_required");
      activationPath = request.staged_path;
      activationInFlight = (async () => {
        await closeOwnedRuntime();
        const activated = await activateRestore(request.staged_path, vaultPath);
        const replacement = options.embedding === undefined ? undefined : await options.reloadEmbedding!();
        if (replacement !== undefined && (replacement === embedding || replacement.report().state !== "ready")) throw new Error("restore_fresh_embedding_required");
        const restarted = await createRuntime({ ...options, vaultPath, requireExisting: true, ...(replacement === undefined ? {} : { embedding: replacement }) });
        return { ...activated, runtime: restarted };
      })().catch((error: unknown) => { activationInFlight = undefined; throw error; });
      return activationInFlight;
    }
    return { ...runtime, activateRestore: activateOwnedRestore };
  } catch (error) {
    try { openingReader?.close(); } finally {
      try { openingDatabase?.close(); } finally {
        try { await sourceReranker?.dispose({ timeout_ms: 5_000 }); } catch { /* preserve the opening failure */ }
        await embedding?.dispose({ timeout_ms: 5_000 });
      }
    }
    throw error;
  }
}

function createTrustedBindingForQuery(host: TrustedBinding): TrustedBinding {
  return createTrustedBinding({ ...host, binding_id: randomUUID(), host_session_id: randomUUID() });
}
