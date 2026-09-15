
import { z } from "zod";

import { RuntimeCleanupWorker, type NativeSessionRemover } from "../execution/cleanup.js";
import { nonNegativeInt64Schema, parseContract, type TrustedBinding } from "../host/contract.js";
import { type PolicySetupBinding } from "./policy.js";
import { purgeSource, type PurgeSourceResult } from "./purge-source.js";
import type { AgentMemoryDatabase, PurgeInventory } from "../store/database.js";
import { StoreError } from "../store/errors.js";

const fullPurgeRequestSchema = z
  .object({
    version: z.literal(1),
    operation_id: z.uuid(),
    scope_id: z.uuid(),
    capture_ids: z.array(z.uuid()).min(1).max(128),
    expected_privacy_epoch: nonNegativeInt64Schema,
    requested_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capture_ids).size !== value.capture_ids.length) context.addIssue({ code: "custom", path: ["capture_ids"], message: "duplicate_capture_id" });
  });

export type FullPurgeRequest = z.infer<typeof fullPurgeRequestSchema>;

export type PurgePendingReason =
  | "runtime_cleanup_pending"
  | "managed_export_cleanup_pending"
  | "managed_export_conflict"
  | "host_refresh_pending"
  | "model_reset_unavailable"
  | "model_reset_pending"
  | "physical_cleanup_pending";

export type FullPurgePhase = "barrier" | "content_deleted" | "runtime_cleanup" | "managed_export_cleanup" | "host_refresh" | "model_reset" | "physical_cleanup" | "completed";

export interface ManagedExportCleanupOptions {
  readonly host_binding: TrustedBinding;
  readonly owner?: string;
  readonly lease_until?: string;
  readonly staging_dir: string;
}

export interface FullPurgeOptions {
  readonly runtime_cleanup_worker?: RuntimeCleanupWorker;
  readonly native_session_remover?: NativeSessionRemover;
  readonly managed_export?: ManagedExportCleanupOptions;
  readonly runtime_owner?: {
    readonly id: string;
    readonly requirement: "required" | "not_required" | "unknown";
    /** Owner must quiesce work, dispose old arrays/model and verify replacement readiness. */
    readonly reset?: () => Promise<boolean>;
  };
}

export interface FullPurgeResult {
  readonly version: 1;
  readonly operation_id: string;
  readonly scope_id: string;
  readonly state: "completed" | "pending";
  readonly phase: FullPurgePhase;
  readonly privacy_epoch: string;
  readonly selected_count: number;
  readonly physical_cleanup: "complete" | "pending";
  readonly pending: readonly PurgePendingReason[];
  readonly inventory: PurgeInventory;
  readonly source: PurgeSourceResult;
}

function emptyInventory(scopeId: string, captureIds: readonly string[]): PurgeInventory {
  return {
    scope_id: scopeId,
    capture_ids: [...captureIds],
    source_count: 0,
    span_count: 0,
    revision_count: 0,
    item_count: 0,
    derived_count: 0,
    dependency_count: 0,
    vector_chunk_count: 0,
    vector_embedding_count: 0,
    graph_edge_count: 0,
    extraction_batch_count: 0,
    runtime_artifact_count: 0,
    query_trace_count: 0,
    managed_export_count: 0,
    managed_backup_count: 0,
    managed_export_states: [],
  };
}

function addPending(pending: PurgePendingReason[], reason: PurgePendingReason): void {
  if (!pending.includes(reason)) pending.push(reason);
}

function phaseFor(pending: readonly PurgePendingReason[], source: PurgeSourceResult): FullPurgePhase {
  if (source.state === "completed" && pending.length === 0) return "completed";
  if (pending.includes("runtime_cleanup_pending")) return "runtime_cleanup";
  if (pending.includes("managed_export_conflict")) return "managed_export_cleanup";
  if (pending.includes("managed_export_cleanup_pending")) return "managed_export_cleanup";
  if (pending.includes("host_refresh_pending")) return "host_refresh";
  if (pending.includes("model_reset_unavailable") || pending.includes("model_reset_pending")) return "model_reset";
  if (pending.includes("physical_cleanup_pending")) return "physical_cleanup";
  return source.physical_cleanup === "complete" ? "content_deleted" : "barrier";
}

function pendingExports(database: AgentMemoryDatabase, scopeId: string, operationId: string): ReturnType<AgentMemoryDatabase["listManagedExports"]> {
  return database.listManagedExports(scopeId).filter((row) => row.purge_operation_id === operationId && row.state !== "revoked");
}

/**
 * T21 coordinator. The durable source barrier and all content mutation remain
 * in purgeSource → database.purgeSources; this function only drives the
 * already-registered runtime/export cleanup lanes to their next checkpoint.
 */
export async function fullPurge(
  database: AgentMemoryDatabase,
  policyBinding: PolicySetupBinding,
  input: unknown,
  options: FullPurgeOptions = {},
): Promise<FullPurgeResult> {
  const parsed = parseContract(fullPurgeRequestSchema, input, "purge-full");
  let inventory: PurgeInventory;
  try {
    inventory = database.getPurgeInventory(policyBinding, parsed.scope_id, parsed.capture_ids);
  } catch (error: unknown) {
    if (!(error instanceof StoreError) || error.code !== "purge_selection_invalid") throw error;
    inventory = emptyInventory(parsed.scope_id, parsed.capture_ids);
  }

  const first = purgeSource(database, policyBinding, {
    ...parsed,
    full: true,
    defer_completion: true,
  });
  const pending: PurgePendingReason[] = [];
  if (first.state !== "completed") {
    const worker = options.runtime_cleanup_worker ?? new RuntimeCleanupWorker(database.runtimeArtifacts, options.native_session_remover === undefined ? {} : { nativeSessionRemover: options.native_session_remover });
    let runtimeClean = false;
    try {
      await worker.reconcileSource(parsed.scope_id, parsed.capture_ids);
      runtimeClean = database.runtimeArtifacts.listForSource(parsed.scope_id, parsed.capture_ids).every((row) => row.state === "removed");
    } catch { runtimeClean = false; }
    if (!runtimeClean) addPending(pending, "runtime_cleanup_pending");

    const exports = pendingExports(database, parsed.scope_id, parsed.operation_id);
    if (exports.length > 0) addPending(pending, "managed_export_cleanup_pending");
    if (exports.some((row) => row.state === "conflict")) addPending(pending, "managed_export_conflict");
    if (exports.some((row) => row.state !== "conflict" && row.state !== "host_refresh_pending")) addPending(pending, "managed_export_cleanup_pending");
    if (exports.some((row) => row.state === "host_refresh_pending")) addPending(pending, "host_refresh_pending");

    let reset = database.getPurgeRuntimeState(parsed.operation_id);
    const owner = options.runtime_owner;
    if (reset.state === "unknown" && owner !== undefined && owner.requirement !== "unknown") {
      database.recordPurgeRuntimeState(policyBinding, parsed.scope_id, parsed.operation_id, owner.id, owner.requirement);
      reset = database.getPurgeRuntimeState(parsed.operation_id);
    }
    if (reset.state === "required" && owner?.id === reset.owner && owner.reset !== undefined) {
      let confirmed = false;
      try { confirmed = await owner.reset(); } catch { /* leave the durable obligation pending */ }
      if (confirmed) database.recordPurgeRuntimeState(policyBinding, parsed.scope_id, parsed.operation_id, owner.id, "complete");
      else addPending(pending, "model_reset_pending");
    }
  }
  const source = purgeSource(database, policyBinding, {
    ...parsed,
    full: true,

  });
  if (source.physical_cleanup === "pending") addPending(pending, "physical_cleanup_pending");
  const remainingRuntime = database.runtimeArtifacts.listForSource(parsed.scope_id, parsed.capture_ids).some((row) => row.state !== "removed");
  if (remainingRuntime) addPending(pending, "runtime_cleanup_pending");
  const remainingExports = pendingExports(database, parsed.scope_id, parsed.operation_id);
  if (remainingExports.some((row) => row.state === "conflict")) addPending(pending, "managed_export_conflict");
  if (remainingExports.some((row) => row.state === "host_refresh_pending")) addPending(pending, "host_refresh_pending");
  if (remainingExports.some((row) => row.state !== "conflict" && row.state !== "host_refresh_pending")) addPending(pending, "managed_export_cleanup_pending");
  if (!["complete", "not_required"].includes(database.getPurgeRuntimeState(parsed.operation_id).state)) addPending(pending, options.runtime_owner?.reset === undefined ? "model_reset_unavailable" : "model_reset_pending");
  return {
    version: 1,
    operation_id: parsed.operation_id,
    scope_id: parsed.scope_id,
    state: source.state === "completed" && pending.length === 0 ? "completed" : "pending",
    phase: phaseFor(pending, source),
    privacy_epoch: source.privacy_epoch,
    selected_count: source.selected_count,
    physical_cleanup: source.physical_cleanup,
    pending,
    inventory,
    source,
  };
}

export const purgeFull = fullPurge;
export const purge = fullPurge;
