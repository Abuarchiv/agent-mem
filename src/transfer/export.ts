import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  readFileSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { z } from "zod";

import {
  evidenceClassSchema,
  nativeEventStageSchema,
  nativeIdsSchema,
  sourceRoleSchema,
} from "../host/contract.js";
import {
  isPolicyOutputBinding,
  isPolicySetupBinding,
  type PolicyOutputBinding,
  type PolicySetupBinding,
} from "../core/policy.js";
import {
  memoryKindSchema,
  revisionOperationSchema,
  semanticCardinalitySchema,
  canonicalizeQualifiers,
  canonicalizeRevisionMeaning,
  canonicalizeTypedValue,
} from "../core/model.js";
import { resolveTextAtPath, validateSpanExcerpt } from "../core/capture.js";
import type { AgentMemoryDatabase, TransferSnapshot } from "../store/database.js";
import { StoreError } from "../store/errors.js";
import { removeOwnedPath } from "../runtime/owned-path.js";
import type { RegisteredBackupFile } from "../store/backup-inventory.js";

export const TRANSFER_FORMAT = "agent-memory-transfer" as const;
export const TRANSFER_FORMAT_VERSION = 1 as const;
export const TRANSFER_TARGET = "export:jsonl" as const;

export const TRANSFER_MAX_BYTES = 16 * 1024 * 1024;
export const TRANSFER_MAX_LINE_BYTES = 1 * 1024 * 1024;
export const TRANSFER_MAX_RECORDS = 20_000;
export const TRANSFER_MAX_DEPENDENCY_DEPTH = 64;

const UUID = z.uuid();
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u);
const VERSION = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
const INT64 = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const JSON_OBJECT = z.record(z.string().min(1).max(256), z.json());
const DATETIME = z.iso.datetime({ offset: true });

const transferOriginSchema = z.object({
  host_kind: z.enum(["codex", "claude_code", "opencode", "copilot"]),
  surface: z.enum(["codex_cli", "codex_desktop", "claude_code_cli", "opencode_cli", "copilot_cli", "copilot_vscode_agent"]),
  execution_domain: z.object({ kind: z.enum(["local", "remote_ssh", "container", "wsl"]), id: z.string().min(1).max(256) }).strict(),
  host_instance_id: z.string().min(1).max(256),
  host_session_id: z.string().min(1).max(256),
}).strict();

const transferActorSchema = z.object({
  binding_id: UUID,
  host_kind: z.string().min(1).max(64),
  surface: z.string().min(1).max(64),
  execution_domain_kind: z.string().min(1).max(64),
  execution_domain_id: z.string().min(1).max(256),
  host_instance_id: z.string().min(1).max(256),
  host_session_id: z.string().min(1).max(256),
}).strict();

const transferRevisionClaimSchema = z.object({
  revision_id: UUID,
  item_id: UUID,
  claimed_status: z.enum(["candidate", "supported", "disputed", "superseded", "retracted"]),
  actor: transferActorSchema,
}).strict();

const originalEventSchema = z.object({
  stage: nativeEventStageSchema,
  role: sourceRoleSchema,
  evidence_class: evidenceClassSchema,
  native_ids: nativeIdsSchema,
  text: z.string().max(1_000_000).optional(),
  outcome: z.enum(["succeeded", "failed", "unknown"]).optional(),
  provenance: z.object({
    revision_id: UUID,
    revision_kind: z.enum(["initial", "update", "message_update", "part_update", "final", "correction"]),
    parent_revision_id: UUID.optional(),
    correlation: z.discriminatedUnion("status", [
      z.object({ status: z.literal("correlated"), basis: z.enum(["native_ids", "adapter_link"]), key: z.string().min(1).max(256) }).strict(),
      z.object({ status: z.literal("correlation_unknown"), reason: z.enum(["missing_native_id", "not_resolved", "adapter_gap"]) }).strict(),
      z.object({ status: z.literal("ambiguous"), candidate_keys: z.array(z.string().min(1).max(256)).min(2).max(16) }).strict(),
    ]),
    coverage: z.object({ status: z.enum(["complete", "partial", "coverage_gap"]), reason: z.enum(["truncated", "event_not_observed", "adapter_gap", "host_dropped", "correlation_unknown"]).optional() }).strict(),
    acceptance_level: z.enum(["adapter_committed", "packet_returned", "host_context_observed", "answer_verified"]).optional(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const expected: Record<string, readonly [string, string]> = {
    session_start: ["system", "lifecycle"],
    prompt_submitted: ["user", "prompt"],
    prompt_transformed: ["user", "prompt"],
    tool_started: ["tool", "tool_input"],
    tool_result: ["tool", "tool_output"],
    assistant_final: ["assistant", "assistant_output"],
    stop: ["system", "lifecycle"],
    compaction: ["system", "lifecycle"],
    resume: ["system", "lifecycle"],
    message_part: [value.role, value.evidence_class],
    error: ["system", "diagnostic"],
  };
  const pair = expected[value.stage];
  if (pair !== undefined && (value.role !== pair[0] || value.evidence_class !== pair[1])) {
    context.addIssue({ code: "custom", path: ["stage"], message: "stage_identity_mismatch" });
  }
});

const transferProvenanceSchema = z.object({
  version: z.literal(1),
  export_id: UUID,
  original_scope_id: UUID,
  original_capture_id: UUID,
  original_stage: nativeEventStageSchema,
  original_role: sourceRoleSchema,
  original_evidence_class: evidenceClassSchema,
  original_origin: transferOriginSchema,
  original_event: originalEventSchema.optional(),
  imported_by: transferActorSchema,
  revision_claims: z.array(transferRevisionClaimSchema).max(TRANSFER_MAX_RECORDS).optional(),
}).strict();

const transferEventSchema = originalEventSchema.safeExtend({
  transfer_provenance: transferProvenanceSchema.optional(),
});

const transferSpanSchema = z.object({
  span_id: UUID,
  source_id: UUID,
  scope_id: UUID,
  root: z.enum(["payload", "event"]),
  path: z.string().startsWith("/").min(1).max(512),
  start_utf16: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  end_utf16: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  digest: DIGEST,
}).strict().superRefine((value, context) => {
  if (value.end_utf16 <= value.start_utf16) context.addIssue({ code: "custom", path: ["end_utf16"], message: "span_order" });
});

const transferScopeSchema = z.object({ kind: z.literal("scope"), scope_id: UUID, scope_kind: z.enum(["project", "personal"]) }).strict();
const transferSourceSchema = z.object({
  kind: z.literal("source"),
  capture_id: UUID,
  scope_id: UUID,
  origin: transferOriginSchema,
  fingerprint: DIGEST,
  adapter_version: VERSION,
  observed_stage: nativeEventStageSchema,
  role: sourceRoleSchema,
  evidence_class: evidenceClassSchema,
  captured_at: DATETIME,
  occurred_at: DATETIME.nullable(),
  payload: JSON_OBJECT,
  event: transferEventSchema,
  truncation: z.object({ truncated: z.boolean(), omitted_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  redaction: z.object({ applied: z.boolean(), policy_version: VERSION }).strict(),
  coverage: z.object({ status: z.enum(["complete", "partial", "coverage_gap"]), stages: z.array(nativeEventStageSchema).min(1).max(32), truncated: z.boolean() }).strict(),
  spans: z.array(transferSpanSchema).max(128),
}).strict();

const transferEntitySchema = z.object({
  kind: z.literal("entity"), scope_id: UUID, entity_id: UUID, resolution_state: z.enum(["resolved", "candidate"]), canonical_key: z.string().min(1).max(512).nullable(), label: z.string().min(1).max(512), created_commit_seq: INT64,
}).strict();

const transferItemSchema = z.object({
  kind: z.literal("item"), scope_id: UUID, item_id: UUID, memory_kind: memoryKindSchema, entity_id: UUID.nullable(), predicate: z.string().min(1).max(256), qualifiers: z.array(z.unknown()).max(32), qualifiers_digest: DIGEST, cardinality: semanticCardinalitySchema, claimed_status: z.enum(["candidate", "supported", "disputed", "superseded", "retracted"]), current_revision_id: UUID.nullable(), created_commit_seq: INT64,
}).strict();

const transferRevisionSchema = z.object({
  kind: z.literal("revision"), scope_id: UUID, revision_id: UUID, item_id: UUID, parent_revision_id: UUID.nullable(), operation: revisionOperationSchema, content: z.object({ type: z.enum(["text", "integer", "number", "boolean", "date", "json"]), value: z.unknown() }).strict(), content_digest: DIGEST, meaning: z.unknown().nullable(), actor: transferActorSchema, created_commit_seq: INT64,
}).strict();

const transferRevisionSourceSchema = z.object({
  kind: z.literal("revision_source"), scope_id: UUID, revision_id: UUID, source_capture_id: UUID, source_span_id: UUID,
}).strict();

const transferDerivedSchema = z.object({
  kind: z.literal("derived_artifact"), scope_id: UUID, artifact_id: UUID, revision_id: UUID, artifact_kind: z.enum(["summary", "reflection", "search_enrichment"]), purpose: z.enum(["historical", "current"]), session_id: UUID.nullable(), content: z.string().max(1_000_000), content_digest: DIGEST, temporal_domain: z.json(), egress_targets: z.array(z.string().min(1).max(160)).max(32), claimed_status: z.enum(["active", "blocked", "purged"]), status_reason: z.string().max(128).nullable(), created_commit_seq: INT64, invalidated_commit_seq: INT64.nullable(),
}).strict();

const transferDependencySchema = z.object({
  kind: z.literal("dependency"), scope_id: UUID, child_type: z.enum(["derived_artifact", "memory_revision"]), child_revision_id: UUID, parent_type: z.enum(["derived_artifact", "memory_revision", "source_span"]), parent_revision_id: UUID, relation: z.enum(["derives", "supports"]), created_commit_seq: INT64,
}).strict();

export const transferRecordSchema = z.discriminatedUnion("kind", [transferScopeSchema, transferSourceSchema, transferEntitySchema, transferItemSchema, transferRevisionSchema, transferRevisionSourceSchema, transferDerivedSchema, transferDependencySchema]);
export type TransferRecord = z.infer<typeof transferRecordSchema>;

export const transferCountsSchema = z.object({ scope: z.number().int().nonnegative(), source: z.number().int().nonnegative(), entity: z.number().int().nonnegative(), item: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), revision_source: z.number().int().nonnegative(), derived_artifact: z.number().int().nonnegative(), dependency: z.number().int().nonnegative() }).strict();
export type TransferCounts = z.infer<typeof transferCountsSchema>;

export const transferManifestSchema = z.object({
  kind: z.literal("manifest"), format: z.literal(TRANSFER_FORMAT), format_version: z.literal(TRANSFER_FORMAT_VERSION), export_id: UUID, created_at: DATETIME, source_schema_version: z.number().int().min(1).max(26).refine((value) => value !== 21 && value !== 23), counts: transferCountsSchema, records_sha256: DIGEST,
}).strict();
export type TransferManifest = z.infer<typeof transferManifestSchema>;

export interface TransferExportOptions {
  readonly scope_ids: readonly string[];
  readonly destination: string;
  readonly export_id?: string;
  readonly created_at?: string;
}

export interface TransferExportResult {
  readonly export_id: string;
  readonly path: string;
  readonly bytes: number;
  readonly records_sha256: string;
  readonly counts: TransferCounts;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreError("transfer_invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new StoreError("transfer_invalid");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonValue(value: unknown, field: string): unknown {
  if (typeof value !== "string") throw new StoreError("transfer_invalid", new Error(field));
  try { return JSON.parse(value) as unknown; } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
}

function rowText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new StoreError("transfer_invalid", new Error(field));
  return value;
}

function rowNullableText(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  return rowText(row, field);
}

function rowNumber(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new StoreError("transfer_invalid", new Error(field));
}

function rowIntString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return value;
  throw new StoreError("transfer_invalid", new Error(field));
}

function parseRecord<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new StoreError("transfer_invalid", new Error(field));
  return result.data;
}

function sourceRecord(row: Record<string, unknown>, spans: readonly Record<string, unknown>[]): TransferRecord {
  const event = parseRecord(transferEventSchema, jsonValue(rowText(row, "event_json"), "event_json"), "source.event");
  const payload = parseRecord(JSON_OBJECT, jsonValue(rowText(row, "payload_json"), "payload_json"), "source.payload");
  return parseRecord(transferSourceSchema, {
    kind: "source",
    capture_id: rowText(row, "capture_id"),
    scope_id: rowText(row, "scope_id"),
    origin: {
      host_kind: rowText(row, "origin_host_kind"),
      surface: rowText(row, "origin_surface"),
      execution_domain: { kind: rowText(row, "origin_execution_domain_kind"), id: rowText(row, "origin_execution_domain_id") },
      host_instance_id: rowText(row, "origin_host_instance_id"),
      host_session_id: rowText(row, "origin_host_session_id"),
    },
    fingerprint: rowText(row, "fingerprint"),
    adapter_version: rowText(row, "adapter_version"),
    observed_stage: rowText(row, "observed_stage"),
    role: rowText(row, "role"),
    evidence_class: rowText(row, "evidence_class"),
    captured_at: rowText(row, "captured_at"),
    occurred_at: rowNullableText(row, "occurred_at"),
    payload,
    event,
    truncation: jsonValue(rowText(row, "truncation_json"), "truncation_json"),
    redaction: jsonValue(rowText(row, "redaction_json"), "redaction_json"),
    coverage: jsonValue(rowText(row, "coverage_json"), "coverage_json"),
    spans: spans.map((span) => ({
      span_id: rowText(span, "span_id"), source_id: rowText(span, "source_id"), scope_id: rowText(span, "scope_id"), root: rowText(span, "root"), path: rowText(span, "path"), start_utf16: rowNumber(span, "start_utf16"), end_utf16: rowNumber(span, "end_utf16"), digest: rowText(span, "digest"),
    })),
  }, "source");
}

function buildRecords(snapshot: TransferSnapshot): TransferRecord[] {
  const spansBySource = new Map<string, Record<string, unknown>[]>();
  for (const row of snapshot.spans) {
    const sourceId = rowText(row, "source_id");
    const list = spansBySource.get(sourceId) ?? [];
    list.push(row);
    spansBySource.set(sourceId, list);
  }
  const claimedRevisions = new Map<string, { readonly actor: Record<string, unknown>; readonly claimed_status: string }>();
  for (const row of snapshot.sources) {
    const event = parseRecord(transferEventSchema, jsonValue(rowText(row, "event_json"), "event_json"), "source.event");
    for (const claim of event.transfer_provenance?.revision_claims ?? []) claimedRevisions.set(`${rowText(row, "scope_id")}\u0000${claim.item_id}\u0000${claim.revision_id}`, { actor: claim.actor, claimed_status: claim.claimed_status });
  }
  const records: TransferRecord[] = [];
  for (const row of snapshot.scopes) records.push(parseRecord(transferScopeSchema, { kind: "scope", scope_id: rowText(row, "scope_id"), scope_kind: rowText(row, "kind") }, "scope"));
  for (const row of snapshot.sources) records.push(sourceRecord(row, spansBySource.get(rowText(row, "capture_id")) ?? []));
  for (const row of snapshot.entities) records.push(parseRecord(transferEntitySchema, { kind: "entity", scope_id: rowText(row, "scope_id"), entity_id: rowText(row, "entity_id"), resolution_state: rowText(row, "resolution_state"), canonical_key: rowNullableText(row, "canonical_key"), label: rowText(row, "label"), created_commit_seq: rowIntString(row, "created_commit_seq") }, "entity"));
  for (const row of snapshot.items) {
    const itemId = rowText(row, "item_id");
    const claim = [...claimedRevisions.entries()].find(([key]) => key.startsWith(`${rowText(row, "scope_id")}\u0000${itemId}\u0000`))?.[1];
    records.push(parseRecord(transferItemSchema, { kind: "item", scope_id: rowText(row, "scope_id"), item_id: itemId, memory_kind: rowText(row, "kind"), entity_id: rowNullableText(row, "entity_id"), predicate: rowText(row, "predicate"), qualifiers: jsonValue(rowText(row, "qualifiers_json"), "qualifiers_json"), qualifiers_digest: rowText(row, "qualifiers_digest"), cardinality: rowText(row, "cardinality"), claimed_status: claim?.claimed_status ?? rowText(row, "status"), current_revision_id: rowNullableText(row, "current_revision_id"), created_commit_seq: rowIntString(row, "created_commit_seq") }, "item"));
  }
  for (const row of snapshot.revisions) {
    const scopeId = rowText(row, "scope_id");
    const revisionId = rowText(row, "revision_id");
    const itemId = rowText(row, "item_id");
    const claim = [...claimedRevisions.entries()].find(([key]) => key === `${scopeId}\u0000${itemId}\u0000${revisionId}`)?.[1];
    const content = parseRecord(z.object({ type: z.enum(["text", "integer", "number", "boolean", "date", "json"]), value: z.unknown() }).strict(), jsonValue(rowText(row, "content_json"), "content_json"), "revision.content");
    records.push(parseRecord(transferRevisionSchema, { kind: "revision", scope_id: scopeId, revision_id: revisionId, item_id: itemId, parent_revision_id: rowNullableText(row, "parent_revision_id"), operation: rowText(row, "operation"), content, content_digest: rowText(row, "content_digest"), meaning: rowNullableText(row, "meaning_json") === null ? null : jsonValue(rowText(row, "meaning_json"), "meaning_json"), actor: claim?.actor ?? { binding_id: rowText(row, "actor_binding_id"), host_kind: rowText(row, "actor_host_kind"), surface: rowText(row, "actor_surface"), execution_domain_kind: rowText(row, "actor_execution_domain_kind"), execution_domain_id: rowText(row, "actor_execution_domain_id"), host_instance_id: rowText(row, "actor_host_instance_id"), host_session_id: rowText(row, "actor_host_session_id") }, created_commit_seq: rowIntString(row, "created_commit_seq") }, "revision"));
  }
  for (const row of snapshot.revisionSources) records.push(parseRecord(transferRevisionSourceSchema, { kind: "revision_source", scope_id: rowText(row, "scope_id"), revision_id: rowText(row, "revision_id"), source_capture_id: rowText(row, "source_capture_id"), source_span_id: rowText(row, "source_span_id") }, "revision_source"));
  for (const row of snapshot.derived) records.push(parseRecord(transferDerivedSchema, { kind: "derived_artifact", scope_id: rowText(row, "scope_id"), artifact_id: rowText(row, "artifact_id"), revision_id: rowText(row, "revision_id"), artifact_kind: rowText(row, "kind"), purpose: rowText(row, "purpose"), session_id: rowNullableText(row, "session_id"), content: jsonValue(rowText(row, "content_json"), "content_json"), content_digest: rowText(row, "content_digest"), temporal_domain: jsonValue(rowText(row, "temporal_domain_json"), "temporal_domain_json"), egress_targets: jsonValue(rowText(row, "egress_targets_json"), "egress_targets_json"), claimed_status: rowText(row, "status"), status_reason: rowNullableText(row, "status_reason"), created_commit_seq: rowIntString(row, "created_commit_seq"), invalidated_commit_seq: rowNullableText(row, "invalidated_commit_seq") }, "derived_artifact"));
  for (const row of snapshot.dependencies) records.push(parseRecord(transferDependencySchema, { kind: "dependency", scope_id: rowText(row, "scope_id"), child_type: rowText(row, "child_type"), child_revision_id: rowText(row, "child_revision_id"), parent_type: rowText(row, "parent_type"), parent_revision_id: rowText(row, "parent_revision_id"), relation: rowText(row, "relation"), created_commit_seq: rowIntString(row, "created_commit_seq") }, "dependency"));
  return records;
}

function counts(records: readonly TransferRecord[]): TransferCounts {
  const result: TransferCounts = { scope: 0, source: 0, entity: 0, item: 0, revision: 0, revision_source: 0, derived_artifact: 0, dependency: 0 };
  for (const record of records) result[record.kind] += 1;
  return result;
}

export function validateTransferRecords(records: readonly TransferRecord[]): void {
  const identities = new Set<string>();
  const scopes = new Map<string, Extract<TransferRecord, { kind: "scope" }>>();
  const sources = new Map<string, Extract<TransferRecord, { kind: "source" }>>();
  const spans = new Map<string, Extract<TransferRecord, { kind: "source" }>["spans"][number]>();
  const entities = new Map<string, Extract<TransferRecord, { kind: "entity" }>>();
  const items = new Map<string, Extract<TransferRecord, { kind: "item" }>>();
  const revisions = new Map<string, Extract<TransferRecord, { kind: "revision" }>>();
  const links: Extract<TransferRecord, { kind: "revision_source" }>[] = [];
  const artifacts = new Map<string, Extract<TransferRecord, { kind: "derived_artifact" }>>();
  const dependencies: Extract<TransferRecord, { kind: "dependency" }>[] = [];
  const identity = (record: TransferRecord): string => {
    switch (record.kind) {
      case "scope": return `scope\u0000${record.scope_id}`;
      case "source": return `source\u0000${record.capture_id}`;
      case "entity": return `entity\u0000${record.scope_id}\u0000${record.entity_id}`;
      case "item": return `item\u0000${record.scope_id}\u0000${record.item_id}`;
      case "revision": return `revision\u0000${record.scope_id}\u0000${record.revision_id}`;
      case "revision_source": return `revision_source\u0000${record.scope_id}\u0000${record.revision_id}\u0000${record.source_span_id}`;
      case "derived_artifact": return `derived\u0000${record.scope_id}\u0000${record.revision_id}`;
      case "dependency": return `dependency\u0000${record.scope_id}\u0000${record.child_type}\u0000${record.child_revision_id}\u0000${record.parent_type}\u0000${record.parent_revision_id}`;
    }
  };
  for (const record of records) {
    if (identities.has(identity(record))) throw new StoreError("transfer_invalid");
    identities.add(identity(record));
    switch (record.kind) {
      case "scope": scopes.set(record.scope_id, record); break;
      case "source":
        if (sources.has(record.capture_id)) throw new StoreError("transfer_invalid");
        sources.set(record.capture_id, record);
        for (const span of record.spans) {
          if (spans.has(span.span_id) || span.source_id !== record.capture_id || span.scope_id !== record.scope_id) throw new StoreError("transfer_invalid");
          spans.set(span.span_id, span);
          try { validateSpanExcerpt(resolveTextAtPath(span.root === "event" ? record.event : record.payload, span.path), span.start_utf16, span.end_utf16, span.digest); } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
        }
        break;
      case "entity": entities.set(`${record.scope_id}\u0000${record.entity_id}`, record); break;
      case "item": items.set(`${record.scope_id}\u0000${record.item_id}`, record); break;
      case "revision": revisions.set(`${record.scope_id}\u0000${record.revision_id}`, record); break;
      case "revision_source": links.push(record); break;
      case "derived_artifact": artifacts.set(`${record.scope_id}\u0000${record.revision_id}`, record); break;
      case "dependency": dependencies.push(record); break;
    }
  }
  for (const source of sources.values()) if (!scopes.has(source.scope_id)) throw new StoreError("transfer_invalid");
  for (const span of spans.values()) {
    const source = sources.get(span.source_id);
    if (source === undefined || source.scope_id !== span.scope_id) throw new StoreError("transfer_invalid");
  }
  for (const entity of entities.values()) if (!scopes.has(entity.scope_id)) throw new StoreError("transfer_invalid");
  for (const item of items.values()) {
    if (!scopes.has(item.scope_id) || (item.entity_id !== null && !entities.has(`${item.scope_id}\u0000${item.entity_id}`))) throw new StoreError("transfer_invalid");
    try {
      const qualifiers = canonicalizeQualifiers(item.qualifiers);
      if (qualifiers.digest !== item.qualifiers_digest || qualifiers.json !== canonicalJson(item.qualifiers)) throw new Error("qualifiers_digest");
    } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
    if (item.current_revision_id !== null && !revisions.has(`${item.scope_id}\u0000${item.current_revision_id}`)) throw new StoreError("transfer_invalid");
  }
  const linksByRevision = new Map<string, number>();
  for (const revision of revisions.values()) {
    const item = items.get(`${revision.scope_id}\u0000${revision.item_id}`);
    if (item === undefined) throw new StoreError("transfer_invalid");
    if (revision.parent_revision_id !== null) {
      const parent = revisions.get(`${revision.scope_id}\u0000${revision.parent_revision_id}`);
      if (parent === undefined || parent.item_id !== revision.item_id) throw new StoreError("transfer_invalid");
    }
    try {
      const content = canonicalizeTypedValue(revision.content);
      if (content.digest !== revision.content_digest || content.json !== canonicalJson(revision.content)) throw new Error("content_digest");
      if (revision.meaning !== null && canonicalizeRevisionMeaning(revision.meaning).json !== canonicalJson(revision.meaning)) throw new Error("meaning_digest");
    } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
  }
  for (const link of links) {
    const revision = revisions.get(`${link.scope_id}\u0000${link.revision_id}`);
    const source = sources.get(link.source_capture_id);
    const span = spans.get(link.source_span_id);
    if (revision === undefined || source === undefined || span === undefined || source.scope_id !== link.scope_id || span.scope_id !== link.scope_id || span.source_id !== link.source_capture_id) throw new StoreError("transfer_invalid");
    linksByRevision.set(`${link.scope_id}\u0000${link.revision_id}`, (linksByRevision.get(`${link.scope_id}\u0000${link.revision_id}`) ?? 0) + 1);
  }
  for (const revision of revisions.values()) if ((linksByRevision.get(`${revision.scope_id}\u0000${revision.revision_id}`) ?? 0) < 1) throw new StoreError("transfer_invalid");
  for (const artifact of artifacts.values()) if (!scopes.has(artifact.scope_id) || sha256(artifact.content) !== artifact.content_digest) throw new StoreError("transfer_invalid");
  const nodes = new Set<string>();
  for (const revision of revisions.values()) nodes.add(`${revision.scope_id}\u0000memory_revision\u0000${revision.revision_id}`);
  for (const artifact of artifacts.values()) nodes.add(`${artifact.scope_id}\u0000derived_artifact\u0000${artifact.revision_id}`);
  const parents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const child = `${dependency.scope_id}\u0000${dependency.child_type}\u0000${dependency.child_revision_id}`;
    const parent = `${dependency.scope_id}\u0000${dependency.parent_type}\u0000${dependency.parent_revision_id}`;
    if (!nodes.has(child) || (dependency.parent_type === "source_span" ? spans.get(dependency.parent_revision_id)?.scope_id !== dependency.scope_id : !nodes.has(parent))) throw new StoreError("transfer_invalid");
    const list = parents.get(child) ?? [];
    list.push(parent);
    parents.set(child, list);
  }
  // These are the same edges used by purge: revisions own source links,
  // items own revisions, and entities are removed with their last item.
  const itemRevisions = new Set<string>();
  const usedEntities = new Set<string>();
  for (const revision of revisions.values()) {
    itemRevisions.add(`${revision.scope_id}\u0000${revision.item_id}`);
    if (revision.parent_revision_id !== null) {
      const child = `${revision.scope_id}\u0000memory_revision\u0000${revision.revision_id}`;
      const list = parents.get(child) ?? [];
      list.push(`${revision.scope_id}\u0000memory_revision\u0000${revision.parent_revision_id}`);
      parents.set(child, list);
    }
  }
  for (const item of items.values()) {
    if (!itemRevisions.has(`${item.scope_id}\u0000${item.item_id}`)) throw new StoreError("transfer_invalid");
    if (item.current_revision_id !== null && revisions.get(`${item.scope_id}\u0000${item.current_revision_id}`)?.item_id !== item.item_id) throw new StoreError("transfer_invalid");
    if (item.entity_id !== null) usedEntities.add(`${item.scope_id}\u0000${item.entity_id}`);
  }
  for (const key of entities.keys()) if (!usedEntities.has(key)) throw new StoreError("transfer_invalid");
  for (const link of links) {
    const child = `${link.scope_id}\u0000memory_revision\u0000${link.revision_id}`;
    const list = parents.get(child) ?? [];
    list.push(`${link.scope_id}\u0000source_span\u0000${link.source_span_id}`);
    parents.set(child, list);
  }
  const active = new Set<string>();
  const depths = new Map<string, number>();
  const visit = (node: string, depth: number): number => {
    if (depth > TRANSFER_MAX_DEPENDENCY_DEPTH || active.has(node)) throw new StoreError("transfer_invalid");
    if (node.includes("\u0000source_span\u0000")) return 0;
    const known = depths.get(node);
    if (known !== undefined) return known;
    const dependencies = parents.get(node) ?? [];
    if (dependencies.length === 0) throw new StoreError("transfer_invalid");
    active.add(node);
    let longest = 0;
    for (const parent of dependencies) longest = Math.max(longest, 1 + visit(parent, depth + 1));
    active.delete(node);
    if (longest > TRANSFER_MAX_DEPENDENCY_DEPTH) throw new StoreError("transfer_invalid");
    depths.set(node, longest);
    return longest;
  };
  for (const node of nodes) visit(node, 0);
}

export function serializeTransferJsonl(exportId: string, createdAt: string, records: readonly TransferRecord[], sourceSchemaVersion = 26): Uint8Array {
  const id = parseRecord(UUID, exportId, "export-id");
  const at = parseRecord(DATETIME, createdAt, "created-at");
  if (records.length > TRANSFER_MAX_RECORDS) throw new StoreError("transfer_invalid");
  const parsed = records.map((record) => parseRecord(transferRecordSchema, record, "record"));
  validateTransferRecords(parsed);
  const recordLines = parsed.map((record) => `${canonicalJson(record)}\n`);
  if (recordLines.some((line) => Buffer.byteLength(line, "utf8") > TRANSFER_MAX_LINE_BYTES)) throw new StoreError("transfer_invalid");
  const body = recordLines.join("");
  const manifest = parseRecord(transferManifestSchema, { kind: "manifest", format: TRANSFER_FORMAT, format_version: TRANSFER_FORMAT_VERSION, export_id: id, created_at: at, source_schema_version: sourceSchemaVersion, counts: counts(parsed), records_sha256: createHash("sha256").update(body, "utf8").digest("hex") }, "manifest");
  const manifestLine = `${canonicalJson(manifest)}\n`;
  if (Buffer.byteLength(manifestLine, "utf8") > TRANSFER_MAX_LINE_BYTES) throw new StoreError("transfer_invalid");
  const output = `${manifestLine}${body}`;
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length > TRANSFER_MAX_BYTES) throw new StoreError("transfer_invalid");
  if (bytes.some((byte) => byte === 0)) throw new StoreError("transfer_invalid");
  return bytes;
}

function transferDestination(destination: string, exportId: string): { readonly path: string; readonly staging: string; readonly parent: string } {
  if (typeof destination !== "string" || destination.length < 1 || destination.length > 4_096 || destination === ":memory:") throw new StoreError("transfer_invalid");
  const requested = resolve(destination);
  const requestedParent = dirname(requested);
  try {
    if (!lstatSync(requestedParent).isDirectory() || lstatSync(requestedParent).isSymbolicLink()) throw new StoreError("transfer_invalid");
    const parent = realpathSync(requestedParent);
    const path = resolve(parent, basename(requested));
    const staging = resolve(parent, `.${basename(path)}.${exportId}.tmp`);
    if (existsSync(path) || existsSync(staging)) throw new StoreError("transfer_target_exists");
    return { path, staging, parent };
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("transfer_invalid", error);
  }
}

function writeExclusive(path: string, bytes: Uint8Array, ownedFiles: RegisteredBackupFile[]): RegisteredBackupFile {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const info = fstatSync(descriptor);
    const owned = { path, identity: { dev: String(info.dev), ino: String(info.ino) }, hash: createHash("sha256").update(bytes).digest("hex") };
    ownedFiles.push(owned);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    return owned;
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function matchesOwnedFile(file: RegisteredBackupFile): boolean {
  const info = lstatSync(file.path);
  return info.isFile() && !info.isSymbolicLink() && String(info.dev) === file.identity.dev && String(info.ino) === file.identity.ino && createHash("sha256").update(readFileSync(file.path)).digest("hex") === file.hash;
}

export type TransferExportPolicy = PolicySetupBinding | PolicyOutputBinding;

export function exportTransfer(database: AgentMemoryDatabase, policy: TransferExportPolicy, options: TransferExportOptions): TransferExportResult {
  if ((!isPolicySetupBinding(policy) && !isPolicyOutputBinding(policy)) || !Array.isArray(options.scope_ids) || options.scope_ids.length < 1) throw new StoreError("output_not_allowed");
  if (isPolicySetupBinding(policy)) {
    if (!policy.allowed_output_targets.includes(TRANSFER_TARGET) || options.scope_ids.some((scopeId) => !policy.allowed_scope_ids.includes(scopeId))) throw new StoreError("output_not_allowed");
  } else if (policy.target !== TRANSFER_TARGET || options.scope_ids.some((scopeId) => scopeId !== policy.scope_id)) {
    throw new StoreError("output_not_allowed");
  }
  const exportId = options.export_id ?? randomUUID();
  const layout = transferDestination(options.destination, exportId);
  const createdAt = options.created_at ?? new Date().toISOString();
  database.registerTransferFileIntent(exportId, options.scope_ids, [layout.staging, layout.path]);
  const ownedFiles: RegisteredBackupFile[] = [];
  try {
    const result = database.runTransferExportLocked(policy, options.scope_ids, (snapshot) => {
      const records = buildRecords(snapshot);
      const bytes = serializeTransferJsonl(exportId, createdAt, records, snapshot.schema_version);
      const staging = writeExclusive(layout.staging, bytes, ownedFiles);
      if (!matchesOwnedFile(staging)) throw new StoreError("transfer_write_failed");
      linkSync(layout.staging, layout.path);
      const published = { ...staging, path: layout.path };
      if (!matchesOwnedFile(published)) throw new StoreError("transfer_write_failed");
      ownedFiles.push(published);
      if (!matchesOwnedFile(staging) || removeOwnedPath(layout.parent, basename(layout.staging), staging.identity) !== "removed") throw new StoreError("transfer_write_failed");
      fsyncDirectory(layout.parent);
      database.finishTransferFileRegistration(exportId, ownedFiles);
      return { export_id: exportId, path: layout.path, bytes: bytes.length, records_sha256: parseRecord(transferManifestSchema, JSON.parse(Buffer.from(bytes).toString("utf8").slice(0, Buffer.from(bytes).toString("utf8").indexOf("\n"))) as unknown, "manifest").records_sha256, counts: counts(records) } satisfies TransferExportResult;
    });
    return result;
  } catch (error: unknown) {
    // Failed publication leaves an explicit managed cleanup obligation. No error
    // path unlinks a pathname which another writer may have created/replaced.
    database.finishTransferFileRegistration(exportId, ownedFiles);
    if (error instanceof StoreError) throw error;
    throw new StoreError("transfer_write_failed", error);
  }
}

export const exportJsonl = exportTransfer;
