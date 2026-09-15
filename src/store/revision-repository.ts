import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  isTrustedBinding,
  nonNegativeInt64Schema,
  parseContract,
  sourceRoleSchema,
  evidenceClassSchema,
  type TrustedBinding,
} from "../host/contract.js";
import { validateSpanExcerpt, resolveTextAtPath } from "../core/capture.js";
import { isPolicyOutputBinding, type PolicyOutputBinding } from "../core/policy.js";
import {
  canonicalizeRevisionMeaning,
  parseRevisionMutation,
  RevisionModelError,
  type CanonicalRevisionMutation,
  type MemoryKind,
  type RevisionOperation,
  type SemanticCardinality,
  type CanonicalRevisionMeaning,
} from "../core/model.js";
import {
  canonicalizeTemporalIntent,
  recordCommitClock,
  readDatabaseWallTime,
  normalizeTemporalDateTime,
  resolveWallTimeToSequence,
  temporalBounds,
  temporalIntervalParts,
  temporalTransition,
  unknownTemporalIntent,
  type CanonicalTemporalIntent,
  type TemporalIntervalPart,
  type WallClockResolution,
} from "../core/time.js";
import { decideRevision, isResolverDecision, isVerifiedCorrectionOperation, isVerifiedEntailmentOperation, type ResolverCurrentState, type ResolverDecision, type ResolverSourceFact } from "../core/resolve.js";
import { parseExtractionCandidate } from "../extraction/schema.js";
import { extractionBatchResultDigest } from "../extraction/extract.js";
import { StoreError } from "./errors.js";
import type { JobClaim } from "./job-repository.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_RESOLVER_SOURCE_FACTS = 128;
const memoryItemStatusSchema = z.enum(["candidate", "supported", "disputed", "superseded", "retracted"]);
const resolverDispositionSchema = z.enum(["candidate", "ignored"]);
const resolverReasonSchema = z.enum([
  "candidate_only_until_t11b",
  "duplicate_evidence",
  "explicit_ignore",
  "verified_entailment",
  "legacy_v8_candidate_status_inferred",
]);
const uuidSchema = z.uuid();

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

function digestJson(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nullableText(row: unknown, field: string): string | null {
  const value = rowValue(row, field);
  return value === null ? null : sqlText(value, field);
}

function readResolverReceipt(row: unknown): Pick<RevisionMutationResult, "status" | "disposition" | "resolution_reason"> {
  const status = nullableText(row, "result_item_status");
  const disposition = nullableText(row, "resolver_disposition");
  const reason = nullableText(row, "resolver_reason");
  const values = [status, disposition, reason];
  if (values.every((value) => value === null)) {
    // v8 never promoted a revision: legacy receipts are safely known to be
    // candidate-only. Do not derive a historical status from mutable item data.
    return {
      status: "candidate",
      disposition: "candidate",
      resolution_reason: "legacy_v8_candidate_status_inferred",
    };
  }
  if (values.some((value) => value === null)) throw new StoreError("revision_invalid");
  return {
    status: parseContract(memoryItemStatusSchema, status, "revision-result-status"),
    disposition: parseContract(resolverDispositionSchema, disposition, "resolver-disposition"),
    resolution_reason: parseContract(resolverReasonSchema, reason, "resolver-reason"),
  };
}

function jsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new StoreError("revision_invalid", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StoreError("revision_invalid", new Error(`invalid ${field}`));
  }
  return parsed as Record<string, unknown>;
}

interface NativeCorrelationData {
  readonly stage: string;
  readonly correlation_key: string | null;
  readonly native_ids_json: string | null;
  readonly native_ids: readonly (readonly [string, string])[];
}

function nativeCorrelationData(event: Record<string, unknown>): NativeCorrelationData {
  const stage = event.stage;
  if (typeof stage !== "string" || stage.length === 0) throw new StoreError("revision_invalid");
  const rawIds = event.native_ids;
  if (rawIds !== undefined && (typeof rawIds !== "object" || rawIds === null || Array.isArray(rawIds))) throw new StoreError("revision_invalid");
  const entries = Object.entries((rawIds ?? {}) as Record<string, unknown>)
    .filter((entry): entry is [string, string] => entry[0] !== "session_id" && typeof entry[1] === "string" && entry[1].length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const provenance = event.provenance;
  if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) {
    return { stage, correlation_key: null, native_ids_json: null, native_ids: entries };
  }
  const correlation = (provenance as Record<string, unknown>).correlation;
  if (typeof correlation !== "object" || correlation === null || Array.isArray(correlation)) {
    return { stage, correlation_key: null, native_ids_json: null, native_ids: entries };
  }
  const correlationRecord = correlation as Record<string, unknown>;
  if (correlationRecord.status !== "correlated" || typeof correlationRecord.key !== "string" || correlationRecord.key.length === 0 || entries.length === 0) {
    return { stage, correlation_key: null, native_ids_json: null, native_ids: entries };
  }
  return {
    stage,
    correlation_key: correlationRecord.key,
    native_ids_json: JSON.stringify(Object.fromEntries(entries)),
    native_ids: entries,
  };
}

function nativeIdentity(
  event: Record<string, unknown>,
  namespace: {
    readonly scopeId: string;
    readonly sessionId: string;
    readonly hostKind: string;
    readonly surface: string;
    readonly domainKind: string;
    readonly domainId: string;
    readonly hostInstanceId: string;
    readonly hostSessionId: string;
  },
): string | null {
  const data = nativeCorrelationData(event);
  if (data.correlation_key === null || data.native_ids.length === 0) return null;
  // JSON arrays preserve opaque IDs without delimiter ambiguity. The stage and
  // adapter correlation key keep two observations of one tool call distinct.
  return JSON.stringify({
    version: 1,
    scope_id: namespace.scopeId,
    database_session_id: namespace.sessionId,
    host_kind: namespace.hostKind,
    surface: namespace.surface,
    domain: { kind: namespace.domainKind, id: namespace.domainId },
    host_instance_id: namespace.hostInstanceId,
    host_session_id: namespace.hostSessionId,
    stage: typeof event.stage === "string" ? event.stage : null,
    correlation_key: data.correlation_key,
    native_ids: data.native_ids,
  });
}

function nativeOutcome(event: Record<string, unknown>): "succeeded" | "failed" | "unknown" | null {
  if (!Object.hasOwn(event, "outcome")) return null;
  return parseContract(z.enum(["succeeded", "failed", "unknown"]), event.outcome, "native-outcome");
}

function automationMarker(event: Record<string, unknown>): boolean {
  const provenance = event.provenance;
  return typeof provenance === "object" && provenance !== null && !Array.isArray(provenance) &&
    (provenance as Record<string, unknown>).actor_kind === "automation";
}

function mapRevisionError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  if (error instanceof RevisionModelError) return new StoreError("revision_invalid", error);
  return new StoreError("revision_invalid", error);
}

export interface RevisionMutationResult {
  readonly version: 1;
  readonly operation_id: string;
  readonly item_id: string;
  readonly revision_id: string;
  readonly entity_id: string | null;
  readonly slot_generation: string | null;
  readonly status: z.infer<typeof memoryItemStatusSchema>;
  readonly disposition: "candidate" | "ignored";
  readonly resolution_reason:
    | "candidate_only_until_t11b"
    | "duplicate_evidence"
    | "explicit_ignore"
    | "verified_entailment"
    | "legacy_v8_candidate_status_inferred";
  readonly replayed: boolean;
}

export interface RevisionActor {
  readonly binding_id: string;
  readonly host_kind: string;
  readonly surface: string;
  readonly execution_domain_kind: string;
  readonly execution_domain_id: string;
  readonly host_instance_id: string;
  readonly host_session_id: string;
}

export interface ImportedCandidateEntity {
  readonly scope_id: string;
  readonly entity_id: string;
  readonly label: string;
  readonly created_commit_seq: string;
}

export interface ImportedCandidateItem {
  readonly scope_id: string;
  readonly item_id: string;
  readonly kind: MemoryKind;
  readonly entity_id: string | null;
  readonly predicate: string;
  readonly qualifiers_json: string;
  readonly qualifiers_digest: string;
  readonly cardinality: SemanticCardinality;
  readonly current_revision_id: string | null;
  readonly created_commit_seq: string;
}

export interface ImportedCandidateRevision {
  readonly scope_id: string;
  readonly revision_id: string;
  readonly item_id: string;
  readonly parent_revision_id: string | null;
  readonly operation: RevisionOperation;
  readonly content_json: string;
  readonly content_digest: string;
  readonly meaning_json: string | null;
  readonly created_commit_seq: string;
}

export interface ImportedCandidateSource {
  readonly scope_id: string;
  readonly revision_id: string;
  readonly source_capture_id: string;
  readonly source_span_id: string;
}

export interface RevisionDetail {
  readonly version: 1;
  readonly scope_id: string;
  readonly item_id: string;
  readonly revision_id: string;
  readonly parent_revision_id: string | null;
  readonly kind: MemoryKind;
  readonly operation: RevisionOperation;
  readonly entity_id: string | null;
  readonly predicate: string;
  readonly qualifiers_json: string;
  readonly cardinality: SemanticCardinality;
  readonly status: z.infer<typeof memoryItemStatusSchema>;
  readonly content: unknown;
  readonly content_digest: string;
  readonly meaning: CanonicalRevisionMeaning | null;
  readonly source_span_ids: readonly string[];
  readonly actor: RevisionActor;
  readonly created_commit_seq: string;
  readonly temporal_intent: CanonicalTemporalIntent | null;
}

export interface TemporalReadRequest {
  readonly item_id?: string;
  readonly valid_at?: string;
  readonly known_at_seq?: string;
  readonly known_at?: string;
}

export interface TemporalProjectionSegment {
  readonly segment_id: string;
  readonly scope_id: string;
  readonly item_id: string;
  readonly value_revision_id: string | null;
  readonly change_revision_id: string;
  readonly status: "definite" | "possible" | "unknown" | "gap";
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly valid_from_precision: string | null;
  readonly valid_to_precision: string | null;
  readonly valid_timezone: string | null;
  readonly valid_from_timezone: string | null;
  readonly valid_to_timezone: string | null;
  readonly valid_from_original: string | null;
  readonly valid_to_original: string | null;
  readonly tx_from_seq: string;
  readonly tx_to_seq: string | null;
  readonly value: unknown | null;
  readonly value_digest: string | null;
  readonly value_source_span_ids: readonly string[];
  readonly change_source_span_ids: readonly string[];
}

export interface TemporalProjection {
  readonly version: 1;
  readonly scope_id: string;
  readonly item_id: string | null;
  readonly valid_at: string;
  readonly known_at_seq: string;
  readonly watermark: string;
  readonly read_time: string;
  readonly segments: readonly TemporalProjectionSegment[];
  readonly next_boundary: string | null;
  readonly clock_resolution?: WallClockResolution;
}

const temporalReadRequestSchema = z
  .object({
    item_id: z.uuid().optional(),
    valid_at: z.iso.datetime({ offset: true }).optional(),
    known_at_seq: nonNegativeInt64Schema.optional(),
    known_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.known_at_seq !== undefined && value.known_at !== undefined) {
      context.addIssue({ code: "custom", path: ["known_at"], message: "known_at_selects_one_clock" });
    }
  });

function parseTemporalReadRequest(input: unknown): z.infer<typeof temporalReadRequestSchema> {
  return parseContract(temporalReadRequestSchema, input ?? {}, "temporal-read");
}

interface SourceEvidence {
  readonly source_capture_id: string;
  readonly source_span_id: string;
  readonly session_id: string;
  readonly stage: string;
  readonly correlation_key: string | null;
  readonly native_ids_json: string | null;
  readonly role: z.infer<typeof sourceRoleSchema>;
  readonly evidence_class: z.infer<typeof evidenceClassSchema>;
  readonly native_identity: string | null;
  readonly native_outcome: "succeeded" | "failed" | "unknown" | null;
  readonly automation_marker: boolean;
}

interface SlotRow {
  readonly cardinality: SemanticCardinality;
  readonly generation: bigint;
  readonly qualifiers_json: string;
}

interface ItemRow {
  readonly item_id: string;
  readonly scope_id: string;
  readonly kind: MemoryKind;
  readonly entity_id: string | null;
  readonly predicate: string;
  readonly qualifiers_digest: string;
  readonly qualifiers_json: string;
  readonly cardinality: SemanticCardinality;
  readonly status: z.infer<typeof memoryItemStatusSchema>;
  readonly current_revision_id: string | null;
}

interface EffectiveRevision {
  readonly revision_id: string;
  readonly content_digest: string;
  readonly meaning: CanonicalRevisionMeaning | null;
  readonly temporal_intent: CanonicalTemporalIntent | null;
}

interface StoredSegment {
  readonly segment_id: string;
  readonly scope_id: string;
  readonly item_id: string;
  readonly value_revision_id: string | null;
  readonly change_revision_id: string;
  readonly status: "definite" | "possible" | "unknown" | "gap";
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly valid_from_precision: string | null;
  readonly valid_to_precision: string | null;
  readonly valid_timezone: string | null;
  readonly valid_from_timezone: string | null;
  readonly valid_to_timezone: string | null;
  readonly valid_from_original: string | null;
  readonly valid_to_original: string | null;
  readonly tx_from_seq: bigint;
  readonly tx_to_seq: bigint | null;
}

interface SegmentBounds {
  readonly from: string | null;
  readonly to: string | null;
  readonly status: StoredSegment["status"];
  readonly fromPrecision: string | null;
  readonly toPrecision: string | null;
  readonly timezone: string | null;
  readonly fromTimezone?: string | null;
  readonly toTimezone?: string | null;
  readonly originalFrom: string | null;
  readonly originalTo: string | null;
  readonly fromLatest?: string | null;
  readonly toEarliest?: string | null;
}

function nullableInteger(row: unknown, field: string): bigint | null {
  const value = rowValue(row, field);
  return value === null ? null : sqlInteger(value, field);
}

function validInterval(from: string | null, to: string | null): boolean {
  return from === null || to === null || from < to;
}

function minUpper(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function maxLower(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function unknownSegmentBounds(): SegmentBounds {
  return {
    from: null,
    to: null,
    status: "unknown",
    fromPrecision: null,
    toPrecision: null,
    timezone: null,
    originalFrom: null,
    originalTo: null,
  };
}

function unknownGapBounds(): SegmentBounds {
  return {
    from: null,
    to: null,
    status: "gap",
    fromPrecision: null,
    toPrecision: null,
    timezone: null,
    originalFrom: null,
    originalTo: null,
  };
}

function toSegmentBounds(part: TemporalIntervalPart): SegmentBounds {
  return {
    from: part.from,
    to: part.to,
    status: part.status,
    fromPrecision: part.from_precision,
    toPrecision: part.to_precision,
    timezone: part.from_timezone !== null && part.from_timezone === part.to_timezone ? part.from_timezone : null,
    fromTimezone: part.from_timezone,
    toTimezone: part.to_timezone,
    originalFrom: part.original_from,
    originalTo: part.original_to,
  };
}

export class RevisionRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly ensureOpen: () => void,
    private readonly wallClock?: () => string,
    private readonly onRevisionSourceLinked?: (scopeId: string, revisionId: string, captureId: string) => void,
    private readonly onRevisionCommitted?: (scopeId: string, revisionId: string, commitSeq: string, replacedRevisionId: string | null) => void,
  ) {}

  apply(binding: TrustedBinding, input: unknown): RevisionMutationResult {
    if (!isTrustedBinding(binding)) throw new StoreError("revision_invalid");
    let mutation: CanonicalRevisionMutation;
    try {
      mutation = parseRevisionMutation(input);
    } catch (error: unknown) {
      throw mapRevisionError(error);
    }
    if (!binding.allowed_scope_ids.includes(mutation.scope_id)) throw new StoreError("scope_not_allowed");

    return this.transaction(() => this.applyInTransaction(binding, mutation));
  }

  /**
   * Insert an imported ledger as candidate history while the owning database
   * transaction is already open. This deliberately skips resolver receipts,
   * semantic slots and temporal projections; a file cannot supply authority.
   */
  insertImportedCandidateHistory(
    binding: TrustedBinding,
    entities: readonly ImportedCandidateEntity[],
    items: readonly ImportedCandidateItem[],
    revisions: readonly ImportedCandidateRevision[],
    sources: readonly ImportedCandidateSource[],
  ): void {
    this.ensureOpen();
    if (!isTrustedBinding(binding)) throw new StoreError("revision_invalid");
    const entityIds = new Set<string>();
    for (const entity of entities) {
      if (!binding.allowed_scope_ids.includes(entity.scope_id) || !uuidSchema.safeParse(entity.scope_id).success || !uuidSchema.safeParse(entity.entity_id).success) throw new StoreError("scope_not_allowed");
      if (entityIds.has(`${entity.scope_id}\u0000${entity.entity_id}`)) throw new StoreError("revision_conflict");
      entityIds.add(`${entity.scope_id}\u0000${entity.entity_id}`);
      const existing = this.database.prepare("SELECT resolution_state, canonical_key, label FROM entity WHERE scope_id = ? AND entity_id = ?").get(entity.scope_id, entity.entity_id);
      if (existing !== undefined) {
        if (sqlText(rowValue(existing, "label"), "import-entity-label") !== entity.label) throw new StoreError("revision_conflict");
        continue;
      }
      this.database.prepare(
        `INSERT INTO entity (scope_id, entity_id, resolution_state, canonical_key, label, created_commit_seq)
         VALUES (?, ?, 'candidate', NULL, ?, ?)`,
      ).run(entity.scope_id, entity.entity_id, entity.label, BigInt(entity.created_commit_seq));
    }

    const itemIds = new Set<string>();
    for (const item of items) {
      if (!binding.allowed_scope_ids.includes(item.scope_id) || !uuidSchema.safeParse(item.scope_id).success || !uuidSchema.safeParse(item.item_id).success) throw new StoreError("scope_not_allowed");
      if (itemIds.has(`${item.scope_id}\u0000${item.item_id}`)) throw new StoreError("revision_conflict");
      itemIds.add(`${item.scope_id}\u0000${item.item_id}`);
      const existing = this.database.prepare(
        `SELECT kind, entity_id, predicate, qualifiers_json, qualifiers_digest, cardinality
           FROM memory_item WHERE scope_id = ? AND item_id = ?`,
      ).get(item.scope_id, item.item_id);
      if (existing !== undefined) {
        if (
          sqlText(rowValue(existing, "kind"), "import-item-kind") !== item.kind ||
          (rowValue(existing, "entity_id") === null ? null : sqlText(rowValue(existing, "entity_id"), "import-item-entity")) !== item.entity_id ||
          sqlText(rowValue(existing, "predicate"), "import-item-predicate") !== item.predicate ||
          sqlText(rowValue(existing, "qualifiers_json"), "import-item-qualifiers") !== item.qualifiers_json ||
          sqlText(rowValue(existing, "qualifiers_digest"), "import-item-qualifiers-digest") !== item.qualifiers_digest ||
          sqlText(rowValue(existing, "cardinality"), "import-item-cardinality") !== item.cardinality
        ) throw new StoreError("revision_conflict");
      } else {
        this.database.prepare(
          `INSERT INTO memory_item (
             scope_id, item_id, kind, entity_id, predicate, qualifiers_json,
             qualifiers_digest, cardinality, status, current_revision_id, created_commit_seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, ?)`,
        ).run(item.scope_id, item.item_id, item.kind, item.entity_id, item.predicate, item.qualifiers_json, item.qualifiers_digest, item.cardinality, BigInt(item.created_commit_seq));
      }
    }

    const revisionIds = new Set<string>();
    for (const revision of revisions) {
      if (!binding.allowed_scope_ids.includes(revision.scope_id) || !uuidSchema.safeParse(revision.scope_id).success || !uuidSchema.safeParse(revision.revision_id).success || !uuidSchema.safeParse(revision.item_id).success) throw new StoreError("scope_not_allowed");
      if (revisionIds.has(`${revision.scope_id}\u0000${revision.revision_id}`)) throw new StoreError("revision_conflict");
      revisionIds.add(`${revision.scope_id}\u0000${revision.revision_id}`);
      if (digestJson(revision.content_json) !== revision.content_digest) throw new StoreError("revision_conflict");
    }
    const pending = new Set(revisions.map((revision) => `${revision.scope_id}\u0000${revision.revision_id}`));
    const ordered: ImportedCandidateRevision[] = [];
    while (pending.size > 0) {
      let progressed = false;
      for (const revision of revisions) {
        const key = `${revision.scope_id}\u0000${revision.revision_id}`;
        if (!pending.has(key)) continue;
        if (revision.parent_revision_id !== null) {
          const parentKey = `${revision.scope_id}\u0000${revision.parent_revision_id}`;
          if (pending.has(parentKey)) continue;
          const suppliedParent = revisions.find((entry) => entry.scope_id === revision.scope_id && entry.revision_id === revision.parent_revision_id);
          if (suppliedParent === undefined || suppliedParent.item_id !== revision.item_id) throw new StoreError("revision_conflict");
        }
        ordered.push(revision);
        pending.delete(key);
        progressed = true;
      }
      if (!progressed) throw new StoreError("revision_conflict");
    }
    for (const revision of ordered) {
      const existing = this.database.prepare(
        `SELECT item_id, parent_revision_id, operation, content_json, content_digest, meaning_json
           FROM memory_revision WHERE scope_id = ? AND revision_id = ?`,
      ).get(revision.scope_id, revision.revision_id);
      if (existing !== undefined) {
        const existingParent = rowValue(existing, "parent_revision_id") === null ? null : sqlText(rowValue(existing, "parent_revision_id"), "import-revision-parent");
        const existingMeaning = rowValue(existing, "meaning_json") === null ? null : sqlText(rowValue(existing, "meaning_json"), "import-revision-meaning");
        if (sqlText(rowValue(existing, "item_id"), "import-revision-item") !== revision.item_id || existingParent !== revision.parent_revision_id || sqlText(rowValue(existing, "operation"), "import-revision-operation") !== revision.operation || sqlText(rowValue(existing, "content_json"), "import-revision-content") !== revision.content_json || sqlText(rowValue(existing, "content_digest"), "import-revision-content-digest") !== revision.content_digest || existingMeaning !== revision.meaning_json) throw new StoreError("revision_conflict");
        continue;
      }
      const item = this.database.prepare("SELECT 1 AS present FROM memory_item WHERE scope_id = ? AND item_id = ?").get(revision.scope_id, revision.item_id);
      if (item === undefined) throw new StoreError("revision_conflict");
      this.database.prepare(
        `INSERT INTO memory_revision (
           scope_id, revision_id, item_id, parent_revision_id, operation,
           content_json, content_digest, actor_binding_id, actor_host_kind,
           actor_surface, actor_execution_domain_kind, actor_execution_domain_id,
           actor_host_instance_id, actor_host_session_id, meaning_json, meaning_digest, created_commit_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(revision.scope_id, revision.revision_id, revision.item_id, revision.parent_revision_id, revision.operation, revision.content_json, revision.content_digest, binding.binding_id, binding.host_kind, binding.surface, binding.execution_domain.kind, binding.execution_domain.id, binding.host_instance_id, binding.host_session_id, revision.meaning_json, revision.meaning_json === null ? null : digestJson(revision.meaning_json), BigInt(revision.created_commit_seq));
    }

    const sourceKeys = new Set<string>();
    for (const source of sources) {
      if (!binding.allowed_scope_ids.includes(source.scope_id) || !uuidSchema.safeParse(source.scope_id).success || !uuidSchema.safeParse(source.revision_id).success || !uuidSchema.safeParse(source.source_capture_id).success || !uuidSchema.safeParse(source.source_span_id).success) throw new StoreError("scope_not_allowed");
      const key = `${source.scope_id}\u0000${source.revision_id}\u0000${source.source_span_id}`;
      if (sourceKeys.has(key)) throw new StoreError("revision_conflict");
      sourceKeys.add(key);
      const existing = this.database.prepare("SELECT source_capture_id FROM revision_source WHERE scope_id = ? AND revision_id = ? AND source_span_id = ?").get(source.scope_id, source.revision_id, source.source_span_id);
      if (existing !== undefined) {
        if (sqlText(rowValue(existing, "source_capture_id"), "import-source-capture") !== source.source_capture_id) throw new StoreError("revision_conflict");
        continue;
      }
      this.database.prepare("INSERT INTO revision_source (scope_id, revision_id, source_capture_id, source_span_id) VALUES (?, ?, ?, ?)").run(source.scope_id, source.revision_id, source.source_capture_id, source.source_span_id);
    }

    for (const item of items) {
      if (item.current_revision_id === null) continue;
      const current = this.database.prepare("SELECT current_revision_id, status FROM memory_item WHERE scope_id = ? AND item_id = ?").get(item.scope_id, item.item_id);
      if (current === undefined || rowValue(current, "current_revision_id") !== null) continue;
      if (!revisionIds.has(`${item.scope_id}\u0000${item.current_revision_id}`)) throw new StoreError("revision_conflict");
      this.database.prepare("UPDATE memory_item SET current_revision_id = ? WHERE scope_id = ? AND item_id = ? AND current_revision_id IS NULL").run(item.current_revision_id, item.scope_id, item.item_id);
    }
  }

  /**
   * Commit every candidate of a uniformly verified extraction batch and its
   * derived job receipt under one lock. Completion receipts and the result
   * digest are derived exclusively from persisted batch/verdict/attempt rows;
   * callers cannot assert acceptance evidence through this surface.
   */
  applyVerifiedBatch(
    binding: TrustedBinding,
    entries: readonly { readonly input: unknown; readonly candidate_id: string }[],
    context: { readonly batch_id: string; readonly claim: JobClaim },
  ): { readonly results: readonly RevisionMutationResult[]; readonly result_digest: string } {
    if (!isTrustedBinding(binding) || entries.length === 0 || entries.length > 128) throw new StoreError("revision_invalid");
    const mutations = entries.map((entry) => {
      try { return { candidate_id: parseContract(uuidSchema, entry.candidate_id, "verified-candidate-id"), mutation: parseRevisionMutation(entry.input) }; } catch (error: unknown) { throw mapRevisionError(error); }
    });
    if (mutations.some((entry) => !binding.allowed_scope_ids.includes(entry.mutation.scope_id))) throw new StoreError("scope_not_allowed");
    const batchId = parseContract(uuidSchema, context.batch_id, "verified-batch-id");
    const claim = context.claim;
    return this.transaction(() => {
      this.assertVerifiedBatchControl(batchId, claim);
      const batchRow = this.database.prepare("SELECT scope_id, extraction_digest, verification_digest, state FROM extraction_batch WHERE batch_id = ?").get(batchId);
      if (batchRow === undefined || sqlText(rowValue(batchRow, "state"), "verified-batch-state") !== "verified") throw new StoreError("revision_conflict");
      // The semantic acceptance rule is batch-wide: a uniformly positive
      // verifier judgment is required, so a batch with any candidate left in
      // candidate/disputed/error state is never committed.
      const unverified = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_candidate WHERE batch_id = ? AND state <> 'verified'").get(batchId);
      if (sqlInteger(rowValue(unverified, "count"), "verified-unverified-count") !== 0n) throw new StoreError("revision_conflict");
      const candidateCount = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_candidate WHERE batch_id = ?").get(batchId);
      if (sqlInteger(rowValue(candidateCount, "count"), "verified-candidate-count") !== BigInt(mutations.length) || new Set(mutations.map((entry) => entry.candidate_id)).size !== mutations.length) throw new StoreError("revision_conflict");
      const extractionDigest = sqlText(rowValue(batchRow, "extraction_digest"), "verified-batch-extraction-digest");
      const verificationDigest = sqlText(rowValue(batchRow, "verification_digest"), "verified-batch-verification-digest");
      const resultDigest = extractionBatchResultDigest(batchId, extractionDigest, verificationDigest);
      for (const entry of mutations) this.assertPersistedVerification(entry.mutation, { batch_id: batchId, candidate_id: entry.candidate_id });
      const results = mutations.map((entry) => this.applyInTransaction(binding, entry.mutation, true));
      const completedAt = this.readWallClock();
      const completionReceipt = JSON.stringify({ version: 1, status: "completed", batch_id: batchId, extraction_digest: extractionDigest, verification_digest: verificationDigest, result_digest: resultDigest, completed_at: completedAt });
      const extractionUpdated = this.database.prepare("UPDATE extraction_batch SET state = 'completed', completion_receipt_json = ?, updated_at = ? WHERE batch_id = ? AND state = 'verified'").run(completionReceipt, completedAt, batchId);
      if (sqlInteger(extractionUpdated.changes, "extraction-complete-changes") !== 1n) throw new StoreError("revision_conflict");
      const jobReceipt = JSON.stringify({ version: 1, status: "completed", job_id: claim.job_id, scope_id: claim.scope_id, source_capture_id: claim.source_capture_id, task_version: claim.task_version, owner: claim.owner, fence: claim.fence, attempts: claim.attempts, input_fingerprint: claim.input_fingerprint, input_privacy_epoch: claim.input_privacy_epoch, completed_at: completedAt, result_digest: resultDigest });
      const jobUpdated = this.database.prepare("UPDATE job SET state = 'completed', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = NULL, completion_receipt_json = ? WHERE job_id = ? AND task_kind = 'extract' AND state = 'running' AND owner = ? AND fence = ? AND input_fingerprint = ? AND input_privacy_epoch = ?").run(jobReceipt, claim.job_id, claim.owner, BigInt(claim.fence), claim.input_fingerprint, claim.input_privacy_epoch);
      if (sqlInteger(jobUpdated.changes, "extraction-job-complete-changes") !== 1n) throw new StoreError("revision_conflict");
      return { results, result_digest: resultDigest };
    });
  }

  readDetail(binding: PolicyOutputBinding, revisionId: string): RevisionDetail | undefined {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("output_not_allowed");
    const parsedRevisionId = parseContract(uuidSchema, revisionId, "revision-id");
    try {
      const row = this.database
        .prepare(
          `SELECT
             r.scope_id, r.revision_id, r.item_id, r.parent_revision_id, r.operation,
             r.content_json, r.content_digest, r.actor_binding_id, r.actor_host_kind,
             r.actor_surface, r.actor_execution_domain_kind, r.actor_execution_domain_id,
             r.actor_host_instance_id, r.actor_host_session_id, r.created_commit_seq,
             i.kind, i.entity_id, i.predicate, i.qualifiers_json, i.qualifiers_digest, i.cardinality, i.status,
             COUNT(rs.source_span_id) AS source_count,
             SUM(CASE WHEN g.scope_id IS NOT NULL AND t.capture_id IS NULL THEN 1 ELSE 0 END) AS allowed_count
           FROM memory_revision AS r
           JOIN memory_item AS i
             ON i.scope_id = r.scope_id AND i.item_id = r.item_id
           JOIN revision_source AS rs
             ON rs.scope_id = r.scope_id AND rs.revision_id = r.revision_id
           JOIN source_span AS ss
             ON ss.scope_id = rs.scope_id AND ss.source_id = rs.source_capture_id AND ss.span_id = rs.source_span_id
           JOIN source_event AS e
             ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
           LEFT JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE r.scope_id = ? AND r.revision_id = ?
          GROUP BY
             r.scope_id, r.revision_id, r.item_id, r.parent_revision_id, r.operation,
             r.content_json, r.content_digest, r.actor_binding_id, r.actor_host_kind,
             r.actor_surface, r.actor_execution_domain_kind, r.actor_execution_domain_id,
             r.actor_host_instance_id, r.actor_host_session_id, r.created_commit_seq,
             i.kind, i.entity_id, i.predicate, i.qualifiers_json, i.qualifiers_digest, i.cardinality, i.status
          HAVING source_count > 0 AND allowed_count = source_count`,
        )
        .get(binding.target, binding.scope_id, parsedRevisionId);
      if (row === undefined) return undefined;

      const sourceRows = this.database
        .prepare(
          `SELECT source_capture_id, source_span_id
             FROM revision_source
            WHERE scope_id = ? AND revision_id = ?
            ORDER BY source_span_id`,
        )
        .all(binding.scope_id, parsedRevisionId);
      const sourceSpanIds = sourceRows.map((source) => sqlText(rowValue(source, "source_span_id"), "source_span_id"));
      try {
        const evidence = this.readSourceEvidence(binding.scope_id, sourceSpanIds);
        if (evidence.length !== sourceSpanIds.length) return undefined;
      } catch (error: unknown) {
        if (error instanceof StoreError && error.code === "revision_invalid") return undefined;
        throw error;
      }
      const contentJson = sqlText(rowValue(row, "content_json"), "content_json");
      let content: unknown;
      try {
        content = JSON.parse(contentJson) as unknown;
      } catch (error: unknown) {
        throw new StoreError("read_failed", error);
      }
      if (digestJson(contentJson) !== sqlText(rowValue(row, "content_digest"), "content_digest")) return undefined;
      const qualifiersJson = sqlText(rowValue(row, "qualifiers_json"), "qualifiers_json");
      if (digestJson(qualifiersJson) !== sqlText(rowValue(row, "qualifiers_digest"), "qualifiers_digest")) return undefined;
      const temporalIntent = this.readTemporalIntent(parsedRevisionId, binding.scope_id);
      const meaning = this.readRevisionMeaning(binding.scope_id, parsedRevisionId);
      return {
        version: 1,
        scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
        item_id: sqlText(rowValue(row, "item_id"), "item_id"),
        revision_id: sqlText(rowValue(row, "revision_id"), "revision_id"),
        parent_revision_id: nullableText(row, "parent_revision_id"),
        kind: parseContract(z.enum(["observation", "plan", "fact", "decision", "preference", "lesson", "procedure"]), rowValue(row, "kind"), "memory-kind"),
        operation: parseContract(z.enum(["ADD", "SUPPORT", "SUPERSEDE", "CORRECT", "DISPUTE", "IGNORE", "RETRACT"]), rowValue(row, "operation"), "revision-operation"),
        entity_id: nullableText(row, "entity_id"),
        predicate: sqlText(rowValue(row, "predicate"), "predicate"),
        qualifiers_json: qualifiersJson,
        cardinality: parseContract(z.enum(["exclusive", "multi"]), rowValue(row, "cardinality"), "semantic-cardinality"),
        status: parseContract(memoryItemStatusSchema, rowValue(row, "status"), "memory-item-status"),
        content,
        content_digest: digestJson(contentJson),
        meaning,
        source_span_ids: sourceSpanIds,
        actor: {
          binding_id: sqlText(rowValue(row, "actor_binding_id"), "actor_binding_id"),
          host_kind: sqlText(rowValue(row, "actor_host_kind"), "actor_host_kind"),
          surface: sqlText(rowValue(row, "actor_surface"), "actor_surface"),
          execution_domain_kind: sqlText(rowValue(row, "actor_execution_domain_kind"), "actor_execution_domain_kind"),
          execution_domain_id: sqlText(rowValue(row, "actor_execution_domain_id"), "actor_execution_domain_id"),
          host_instance_id: sqlText(rowValue(row, "actor_host_instance_id"), "actor_host_instance_id"),
          host_session_id: sqlText(rowValue(row, "actor_host_session_id"), "actor_host_session_id"),
        },
        created_commit_seq: sqlInteger(rowValue(row, "created_commit_seq"), "created_commit_seq").toString(10),
        temporal_intent: temporalIntent,
      };
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  /** Read the policy-bound bitemporal projection at one immutable snapshot. */
  readTemporal(binding: PolicyOutputBinding, input: unknown = {}): TemporalProjection {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("output_not_allowed");
    const request = parseTemporalReadRequest(input);
    let validAt: string;
    let readTime: string;
    let knownAtSeq: bigint;
    let clockResolution: WallClockResolution | undefined;
    if (request.known_at !== undefined) {
      const resolution = resolveWallTimeToSequence(this.database, request.known_at);
      clockResolution = resolution;
      if (resolution.status === "unmappable") throw new StoreError("read_failed");
      knownAtSeq = BigInt(resolution.known_at_seq);
    } else if (request.known_at_seq !== undefined) {
      knownAtSeq = BigInt(request.known_at_seq);
    } else {
      knownAtSeq = -1n;
    }

    let committed = false;
    try {
      this.database.exec("BEGIN");
      readTime = readDatabaseWallTime(this.database);
      validAt = request.valid_at === undefined ? readTime : normalizeTemporalDateTime(request.valid_at);
      const counter = this.database.prepare("SELECT commit_seq FROM vault_counter WHERE id = 1").get();
      if (counter === undefined) throw new StoreError("read_failed");
      const watermark = sqlInteger(rowValue(counter, "commit_seq"), "commit-watermark");
      if (knownAtSeq < 0n) knownAtSeq = watermark;
      if (knownAtSeq > watermark) throw new StoreError("revision_conflict");
      const scope = this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(binding.scope_id);
      if (scope === undefined) throw new StoreError("scope_not_registered");
      const grant = this.database
        .prepare("SELECT 1 AS present FROM scope_output_grant WHERE scope_id = ? AND output_target = ? LIMIT 1")
        .get(binding.scope_id, binding.target);
      if (grant === undefined) throw new StoreError("output_not_allowed");

      const itemClause = request.item_id === undefined ? "" : " AND s.item_id = ?";
      const params: Array<string | bigint> = [
        binding.scope_id,
        knownAtSeq,
        knownAtSeq,
        validAt,
        validAt,
        binding.target,
        binding.target,
      ];
      if (request.item_id !== undefined) params.push(request.item_id);
      const rows = this.database
        .prepare(
          `SELECT s.segment_id, s.scope_id, s.item_id, s.value_revision_id, s.change_revision_id,
                  s.status, s.valid_from, s.valid_to, s.valid_from_precision, s.valid_to_precision,
                  s.valid_timezone, s.valid_from_timezone, s.valid_to_timezone,
                  s.valid_from_original, s.valid_to_original, s.tx_from_seq, s.tx_to_seq
             FROM state_segment AS s
            WHERE s.scope_id = ?
              AND s.tx_from_seq <= ?
              AND (s.tx_to_seq IS NULL OR ? < s.tx_to_seq)
              AND (s.valid_from IS NULL OR s.valid_from <= ?)
              AND (s.valid_to IS NULL OR ? < s.valid_to)
              AND NOT EXISTS (
                SELECT 1
                  FROM revision_source AS rs
                  JOIN source_event AS e
                    ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
                  LEFT JOIN scope_output_grant AS g
                    ON g.scope_id = e.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
                  LEFT JOIN purge_tombstone AS t
                    ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
                 WHERE rs.scope_id = s.scope_id AND rs.revision_id = s.change_revision_id
                   AND (g.scope_id IS NULL OR t.capture_id IS NOT NULL)
              )
              AND (
                s.value_revision_id IS NULL OR NOT EXISTS (
                  SELECT 1
                    FROM revision_source AS rs
                    JOIN source_event AS e
                      ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
                    LEFT JOIN scope_output_grant AS g
                      ON g.scope_id = e.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
                    LEFT JOIN purge_tombstone AS t
                      ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
                   WHERE rs.scope_id = s.scope_id AND rs.revision_id = s.value_revision_id
                     AND (g.scope_id IS NULL OR t.capture_id IS NOT NULL)
                )
              )
              ${itemClause}
            ORDER BY s.item_id, s.valid_from, s.valid_to, s.segment_id`,
        )
        .all(...params);

      const segments = rows
        .map((row) => this.readTemporalSegment(this.parseSegment(row), binding))
        .filter((segment): segment is TemporalProjectionSegment => segment !== undefined);
      const nextBoundary = this.readNextBoundary(binding, validAt, knownAtSeq);
      this.database.exec("COMMIT");
      committed = true;
      return {
        version: 1,
        scope_id: binding.scope_id,
        item_id: request.item_id ?? null,
        valid_at: validAt,
        known_at_seq: knownAtSeq.toString(10),
        watermark: watermark.toString(10),
        read_time: readTime,
        segments,
        next_boundary: nextBoundary,
        ...(clockResolution === undefined ? {} : { clock_resolution: clockResolution }),
      };
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the primary read failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  readTemporalProjection(binding: PolicyOutputBinding, input: unknown = {}): TemporalProjection {
    return this.readTemporal(binding, input);
  }

  private readTemporalSegment(segment: StoredSegment, binding: PolicyOutputBinding): TemporalProjectionSegment | undefined {
    const change = this.readDetail(binding, segment.change_revision_id);
    if (change === undefined) return undefined;
    const value = segment.value_revision_id === null ? undefined : this.readDetail(binding, segment.value_revision_id);
    if (segment.value_revision_id !== null && value === undefined) return undefined;
    return {
      segment_id: segment.segment_id,
      scope_id: segment.scope_id,
      item_id: segment.item_id,
      value_revision_id: segment.value_revision_id,
      change_revision_id: segment.change_revision_id,
      status: segment.status,
      valid_from: segment.valid_from,
      valid_to: segment.valid_to,
      valid_from_precision: segment.valid_from_precision,
      valid_to_precision: segment.valid_to_precision,
      valid_timezone: segment.valid_timezone,
      valid_from_timezone: segment.valid_from_timezone,
      valid_to_timezone: segment.valid_to_timezone,
      valid_from_original: segment.valid_from_original,
      valid_to_original: segment.valid_to_original,
      tx_from_seq: segment.tx_from_seq.toString(10),
      tx_to_seq: segment.tx_to_seq?.toString(10) ?? null,
      value: value?.content ?? null,
      value_digest: value?.content_digest ?? null,
      value_source_span_ids: value?.source_span_ids ?? [],
      change_source_span_ids: change.source_span_ids,
    };
  }

  private readNextBoundary(binding: PolicyOutputBinding, validAt: string, knownAtSeq: bigint): string | null {
    const rows = this.database
      .prepare(
        `SELECT s.segment_id, s.scope_id, s.item_id, s.value_revision_id, s.change_revision_id,
                s.status, s.valid_from, s.valid_to, s.valid_from_precision, s.valid_to_precision,
                s.valid_timezone, s.valid_from_timezone, s.valid_to_timezone,
                s.valid_from_original, s.valid_to_original, s.tx_from_seq, s.tx_to_seq
           FROM state_segment AS s
          WHERE s.scope_id = ?
            AND s.tx_from_seq <= ?
            AND (s.tx_to_seq IS NULL OR ? < s.tx_to_seq)
            AND NOT EXISTS (
              SELECT 1
                FROM revision_source AS rs
                JOIN source_event AS e
                  ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
                LEFT JOIN scope_output_grant AS g
                  ON g.scope_id = e.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
                LEFT JOIN purge_tombstone AS t
                  ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
               WHERE rs.scope_id = s.scope_id AND rs.revision_id = s.change_revision_id
                 AND (g.scope_id IS NULL OR t.capture_id IS NOT NULL)
            )
            AND (
              s.value_revision_id IS NULL OR NOT EXISTS (
                SELECT 1
                  FROM revision_source AS rs
                  JOIN source_event AS e
                    ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
                  LEFT JOIN scope_output_grant AS g
                    ON g.scope_id = e.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
                  LEFT JOIN purge_tombstone AS t
                    ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
                 WHERE rs.scope_id = s.scope_id AND rs.revision_id = s.value_revision_id
                   AND (g.scope_id IS NULL OR t.capture_id IS NOT NULL)
              )
            )
          ORDER BY s.valid_from, s.valid_to, s.segment_id`,
      )
      .all(binding.scope_id, knownAtSeq, knownAtSeq, binding.target, binding.target)
      .map((row) => this.parseSegment(row))
      .filter((segment) => this.readTemporalSegment(segment, binding) !== undefined);
    let next: string | null = null;
    for (const segment of rows) {
      for (const boundary of [segment.valid_from, segment.valid_to]) {
        if (boundary !== null && boundary > validAt && (next === null || boundary < next)) next = boundary;
      }
    }
    return next;
  }

  private applyInTransaction(binding: TrustedBinding, mutation: CanonicalRevisionMutation, verified = false): RevisionMutationResult {
    const operation = this.database
      .prepare(
        `SELECT operation_id, scope_id, request_digest, status, result_item_id, result_revision_id, result_slot_generation,
                result_item_status, resolver_disposition, resolver_reason
           FROM revision_operation WHERE operation_id = ?`,
      )
      .get(mutation.operation_id);
    if (operation !== undefined) {
      if (
        sqlText(rowValue(operation, "scope_id"), "operation_scope") !== mutation.scope_id ||
        sqlText(rowValue(operation, "request_digest"), "operation_digest") !== mutation.request_digest
      ) {
        throw new StoreError("revision_conflict");
      }
      if (sqlText(rowValue(operation, "status"), "operation_status") !== "committed") {
        throw new StoreError("revision_conflict");
      }
      const itemId = sqlText(rowValue(operation, "result_item_id"), "result_item_id");
      const revisionId = sqlText(rowValue(operation, "result_revision_id"), "result_revision_id");
      const storedGeneration = nullableText(operation, "result_slot_generation");
      const slotGeneration = storedGeneration === null
        ? null
        : parseContract(nonNegativeInt64Schema, storedGeneration, "revision-slot-generation");
      const item = this.readItem(mutation.scope_id, itemId);
      if (item === undefined) throw new StoreError("revision_invalid");
      const receipt = readResolverReceipt(operation);
      return {
        version: 1,
        operation_id: mutation.operation_id,
        item_id: itemId,
        revision_id: revisionId,
        entity_id: item.entity_id,
        slot_generation: slotGeneration,
        status: receipt.status,
        disposition: receipt.disposition,
        resolution_reason: receipt.resolution_reason,
        replayed: true,
      };
    }

    this.requireScope(mutation.scope_id, binding);
    const sourceEvidence = this.readSourceEvidence(mutation.scope_id, mutation.source_span_ids);
    const { commitSeq } = this.nextCommit(mutation.scope_id);
    const entityId = this.resolveEntity(mutation, commitSeq);
    const hasResolvedEntity = entityId !== null && mutation.identity.entity.kind === "resolved";
    const slot = hasResolvedEntity ? this.readSlot(mutation, entityId) : undefined;
    const itemId = mutation.item_id ?? randomUUID();

    if (mutation.operation === "ADD") {
      if (mutation.expected.revision_id !== null) {
        throw new StoreError("revision_conflict");
      }
      if (this.readItem(mutation.scope_id, itemId) !== undefined) throw new StoreError("revision_conflict");
      const addingToMultiSlot =
        slot !== undefined && entityId !== null && slot.cardinality === "multi" && mutation.identity.cardinality === "multi";
      if (slot !== undefined && !addingToMultiSlot) throw new StoreError("revision_conflict");
      if (slot === undefined && mutation.expected.slot_generation !== null) throw new StoreError("revision_conflict");
      if (addingToMultiSlot) {
        if (mutation.expected.slot_generation === undefined || mutation.expected.slot_generation === null) {
          throw new StoreError("revision_conflict");
        }
        if (BigInt(mutation.expected.slot_generation) !== slot.generation) throw new StoreError("revision_conflict");
        if (this.slotMemberExists(mutation, entityId, mutation.value.digest)) throw new StoreError("revision_conflict");
      } else if (hasResolvedEntity) {
        this.insertSlot(mutation, entityId, commitSeq);
      }
      this.insertItem(mutation, itemId, entityId, commitSeq);
      const revisionId = this.insertRevision(binding, mutation, itemId, null, commitSeq);
      this.insertRevisionSources(mutation.scope_id, revisionId, sourceEvidence);
      this.updateCurrentRevision(mutation.scope_id, itemId, null, revisionId);
      const decision = !verified
        ? this.deriveResolverDecision(mutation, sourceEvidence, undefined)
        : this.deriveVerifiedResolverDecision(mutation, sourceEvidence, undefined);
      this.applyTemporalMutation(mutation, itemId, revisionId, [], commitSeq, decision);
      if (hasResolvedEntity) {
        this.insertSlotMember(mutation, entityId, revisionId, itemId);
      }
      const generation =
        !hasResolvedEntity
          ? null
          : addingToMultiSlot
            ? this.bumpSlotGeneration(mutation, entityId, revisionId, itemId, slot)
            : "1";
      const resultStatus = !verified ? "candidate" : "supported";
      this.insertOperation(mutation, itemId, revisionId, generation, commitSeq, resultStatus, decision);
      if (verified) this.setItemStatus(mutation.scope_id, itemId, "supported");
      this.onRevisionCommitted?.(mutation.scope_id, revisionId, commitSeq.toString(10), null);
      return {
        version: 1,
        operation_id: mutation.operation_id,
        item_id: itemId,
        revision_id: revisionId,
        entity_id: entityId,
        slot_generation: generation,
        status: "candidate",
        disposition: decision.effect,
        resolution_reason: decision.reason,
        replayed: false,
      };
    }

    if (mutation.item_id === undefined || mutation.expected.revision_id === undefined || mutation.expected.revision_id === null) {
      throw new StoreError("revision_conflict");
    }
    const item = this.readItem(mutation.scope_id, mutation.item_id);
    if (item === undefined) throw new StoreError("revision_conflict");
    const protectedStatus = item.status === "supported" || item.status === "disputed" || item.status === "superseded" || item.status === "retracted";
    // A verified correction verdict (plan §6: SUPERSEDE/CORRECT/RETRACT) is a
    // belegte state change against the current ledger head and flows through
    // the resolver even though the item is protected against unverified
    // writes; the CAS checks below still bind it to the expected revision.
    const verifiedCorrection = verified && isVerifiedCorrectionOperation(mutation.operation);
    const effectiveRevision = this.readEffectiveRevision(mutation.scope_id, item.current_revision_id);
    if (protectedStatus && !verifiedCorrection) {
      if (mutation.operation !== "IGNORE") throw new StoreError("revision_conflict");
      if (effectiveRevision === undefined || effectiveRevision === null) throw new StoreError("revision_conflict");
      const requestedMeaning = mutation.meaning ?? null;
      if (requestedMeaning?.digest !== effectiveRevision.meaning?.digest) throw new StoreError("revision_conflict");
      const requestedTemporal = mutation.temporal_intent ?? unknownTemporalIntent();
      const effectiveTemporal = effectiveRevision.temporal_intent ?? unknownTemporalIntent();
      if (requestedTemporal.digest !== effectiveTemporal.digest || mutation.value.digest !== effectiveRevision.content_digest) {
        throw new StoreError("revision_conflict");
      }
    }
    if (
      item.kind !== mutation.kind ||
      item.entity_id !== entityId ||
      item.predicate !== mutation.identity.predicate ||
      item.qualifiers_digest !== mutation.identity.qualifiers_digest ||
      item.cardinality !== mutation.identity.cardinality
    ) {
      throw new StoreError("revision_conflict");
    }
    if (item.current_revision_id !== mutation.expected.revision_id) throw new StoreError("revision_conflict");
    if (!hasResolvedEntity) {
      if (mutation.expected.slot_generation !== undefined && mutation.expected.slot_generation !== null) throw new StoreError("revision_conflict");
    } else {
      if (mutation.expected.slot_generation === undefined || mutation.expected.slot_generation === null || slot === undefined) {
        throw new StoreError("revision_conflict");
      }
      if (BigInt(mutation.expected.slot_generation) !== slot.generation) throw new StoreError("revision_conflict");
    }
    if (mutation.operation === "SUPPORT") {
      if (entityId !== null && slot !== undefined) this.requireMatchingMember(mutation, entityId, item.item_id);
      else this.requireMatchingCurrentValue(mutation.scope_id, item.item_id, mutation.value.digest);
    }
    const decision = !verified
      ? this.deriveResolverDecision(mutation, sourceEvidence, item)
      : this.deriveVerifiedResolverDecision(mutation, sourceEvidence, item);

    if (mutation.operation === "IGNORE" && protectedStatus) {
      if (effectiveRevision === null) throw new StoreError("revision_conflict");
      const generation = hasResolvedEntity && slot !== undefined ? slot.generation.toString(10) : null;
      this.insertOperation(mutation, item.item_id, effectiveRevision.revision_id, generation, commitSeq, item.status, decision);
      return {
        version: 1,
        operation_id: mutation.operation_id,
        item_id: item.item_id,
        revision_id: effectiveRevision.revision_id,
        entity_id: entityId,
        slot_generation: generation,
        status: item.status,
        disposition: decision.effect,
        resolution_reason: decision.reason,
        replayed: false,
      };
    }

    const activeSegments = this.readOpenSegments(mutation.scope_id, item.item_id);
    let inheritedSupportIntent: CanonicalTemporalIntent | undefined;
    if (mutation.operation === "SUPPORT") {
      inheritedSupportIntent = this.inheritedSupportIntent(mutation.scope_id, item, activeSegments, mutation.value.digest);
      if (mutation.temporal_intent !== undefined && mutation.temporal_intent.digest !== inheritedSupportIntent.digest) {
        throw new StoreError("revision_conflict");
      }
    }
    const revisionId = this.insertRevision(binding, mutation, item.item_id, item.current_revision_id, commitSeq, inheritedSupportIntent);
    this.insertRevisionSources(mutation.scope_id, revisionId, sourceEvidence);
    this.updateCurrentRevision(mutation.scope_id, item.item_id, item.current_revision_id, revisionId);
    let generation: string | null = null;
    if (hasResolvedEntity && slot !== undefined) {
      generation = mutation.operation === "IGNORE" || decision.effect === "ignored"
        ? slot.generation.toString(10)
        : this.bumpSlotGeneration(mutation, entityId, revisionId, item.item_id, slot);
    }
    this.applyTemporalMutation(mutation, item.item_id, revisionId, activeSegments, commitSeq, decision);
    const resultStatus = !verified ? item.status : mutation.operation === "RETRACT" ? "retracted" : "supported";
    this.insertOperation(mutation, item.item_id, revisionId, generation, commitSeq, resultStatus, decision);
    if (verified) {
      if (verifiedCorrection) this.setCorrectedItemStatus(mutation.scope_id, item.item_id, mutation.operation);
      else this.setItemStatus(mutation.scope_id, item.item_id, "supported");
    }
    this.onRevisionCommitted?.(mutation.scope_id, revisionId, commitSeq.toString(10), item.current_revision_id);
    return {
      version: 1,
      operation_id: mutation.operation_id,
      item_id: item.item_id,
      revision_id: revisionId,
      entity_id: entityId,
      slot_generation: generation,
      status: item.status,
      disposition: decision.effect,
      resolution_reason: decision.reason,
      replayed: false,
    };
  }

  private readOpenSegments(scopeId: string, itemId: string): StoredSegment[] {
    const rows = this.database
      .prepare(
        `SELECT segment_id, scope_id, item_id, value_revision_id, change_revision_id,
                status, valid_from, valid_to, valid_from_precision, valid_to_precision,
                valid_timezone, valid_from_timezone, valid_to_timezone, valid_from_original,
                valid_to_original, tx_from_seq, tx_to_seq
           FROM state_segment
          WHERE scope_id = ? AND item_id = ? AND tx_to_seq IS NULL
          ORDER BY valid_from, valid_to, segment_id`,
      )
      .all(scopeId, itemId);
    return rows.map((row) => this.parseSegment(row));
  }

  private deriveResolverDecision(
    mutation: CanonicalRevisionMutation,
    sourceEvidence: readonly SourceEvidence[],
    item: ItemRow | undefined,
  ): ResolverDecision {
    this.validateMeaningAttribution(mutation, sourceEvidence);
    if (mutation.meaning?.corrects_revision_id !== undefined && mutation.operation !== "CORRECT") {
      throw new StoreError("revision_invalid");
    }
    if (mutation.operation === "CORRECT" && mutation.meaning?.corrects_revision_id !== undefined && item !== undefined) {
      const target = this.database
        .prepare("SELECT item_id FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
        .get(mutation.scope_id, mutation.meaning.corrects_revision_id);
      if (target === undefined || sqlText(rowValue(target, "item_id"), "correction-item") !== item.item_id) {
        throw new StoreError("revision_conflict");
      }
    }
    const effectiveRevision = item === undefined ? null : this.readEffectiveRevision(mutation.scope_id, item.current_revision_id);
    if (mutation.operation === "SUPPORT" && item !== undefined) {
      const effectiveMeaning = effectiveRevision?.meaning ?? null;
      if (mutation.meaning === undefined && effectiveMeaning !== null) throw new StoreError("revision_conflict");
      if (mutation.meaning !== undefined && (effectiveMeaning === null || mutation.meaning.digest !== effectiveMeaning.digest)) {
        throw new StoreError("revision_conflict");
      }
    }
    const current: ResolverCurrentState | undefined = item === undefined
      ? undefined
      : {
          item_id: item.item_id,
          revision_id: item.current_revision_id ?? mutation.expected.revision_id ?? "",
          status: item.status,
          value_digest: this.effectiveValueDigest(mutation.scope_id, item.current_revision_id) ?? "",
          meaning: effectiveRevision?.meaning ?? null,
          temporal_digest: effectiveRevision?.temporal_intent?.digest ?? null,
          existing_sources: mutation.operation === "SUPPORT"
            ? this.readItemSourceFacts(mutation.scope_id, item.item_id, sourceEvidence)
            : [],
        };
    const decision = decideRevision(
      mutation,
      sourceEvidence.map((source) => ({
        source_capture_id: source.source_capture_id,
        source_span_id: source.source_span_id,
        role: source.role,
        evidence_class: source.evidence_class,
        native_identity: source.native_identity,
        native_outcome: source.native_outcome,
        automation_marker: source.automation_marker,
      } satisfies ResolverSourceFact)),
      current,
    );
    if (!isResolverDecision(decision)) throw new StoreError("revision_invalid");
    return decision;
  }

  private deriveVerifiedResolverDecision(
    mutation: CanonicalRevisionMutation,
    sourceEvidence: readonly SourceEvidence[],
    item: ItemRow | undefined,
  ): ResolverDecision {
    // A uniformly positive verifier receipt accepts ADD/SUPPORT plus the
    // correction operations of the resolver table (plan §6, §7). DISPUTE
    // needs unresolved contradiction evidence and IGNORE is not acceptance.
    if (!isVerifiedEntailmentOperation(mutation.operation)) throw new StoreError("revision_invalid");
    const decision = this.deriveResolverDecision(mutation, sourceEvidence, item);
    return Object.freeze({ ...decision, acceptance: "verified", reason: "verified_entailment" });
  }

  private setItemStatus(scopeId: string, itemId: string, status: "supported"): void {
    const updated = this.database.prepare("UPDATE memory_item SET status = ? WHERE scope_id = ? AND item_id = ? AND status = 'candidate'").run(status, scopeId, itemId);
    if (sqlInteger(updated.changes, "revision-status-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * Fachliche status transition of a verified correction (plan §6 state
   * diagram). SUPERSEDE/CORRECT carry a supported new value on the same item
   * and resolve a disputed claim as a new revision; RETRACT stops asserting
   * the claim. The superseded historical value lives in the closed bitemporal
   * segments, not in the item row that now heads the ledger.
   */
  private setCorrectedItemStatus(scopeId: string, itemId: string, operation: "SUPERSEDE" | "CORRECT" | "RETRACT"): void {
    const status = operation === "RETRACT" ? "retracted" : "supported";
    const updated = this.database
      .prepare("UPDATE memory_item SET status = ? WHERE scope_id = ? AND item_id = ? AND status IN ('candidate', 'supported', 'disputed')")
      .run(status, scopeId, itemId);
    if (sqlInteger(updated.changes, "revision-status-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  private readWallClock(): string {
    if (this.wallClock !== undefined) return this.wallClock();
    const row = this.database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get();
    return sqlText(rowValue(row, "now"), "revision-clock-now");
  }

  private assertPersistedVerification(mutation: CanonicalRevisionMutation, proof: { readonly batch_id: string; readonly candidate_id: string }): void {
    const batchId = parseContract(uuidSchema, proof.batch_id, "verified-batch-id");
    const candidateId = parseContract(uuidSchema, proof.candidate_id, "verified-candidate-id");
    const row = this.database.prepare(
      `SELECT b.scope_id, b.source_capture_id, b.state AS extraction_state,
              c.candidate_digest, c.candidate_json, c.state AS candidate_state,
              v.receipt_digest, v.entailment, v.attribution, v.modality, v.negation, v.time
         FROM extraction_batch AS b
         JOIN extraction_candidate AS c ON c.batch_id = b.batch_id AND c.candidate_id = ?
         JOIN extraction_verdict AS v ON v.batch_id = c.batch_id AND v.candidate_id = c.candidate_id AND v.candidate_digest = c.candidate_digest
         JOIN execution_attempt AS a ON a.attempt_id = b.verify_attempt_id
        WHERE b.batch_id = ?
          AND b.state = 'verified' AND c.state = 'verified'
          AND b.verify_result_digest IS NOT NULL
          AND a.batch_id = b.batch_id AND a.phase = 'verify'
          AND a.state = 'reconciled' AND a.terminal_status = 'completed'
          AND a.result_receipt_json IS NOT NULL
          AND a.result_digest = b.verify_result_digest`,
    ).get(candidateId, batchId);
    if (row === undefined || sqlText(rowValue(row, "scope_id"), "verified-scope") !== mutation.scope_id) {
      throw new StoreError("revision_conflict");
    }
    const candidateDigest = sqlText(rowValue(row, "candidate_digest"), "verified-candidate-digest");
    let candidate: ReturnType<typeof parseExtractionCandidate>;
    try { candidate = parseExtractionCandidate(JSON.parse(sqlText(rowValue(row, "candidate_json"), "verified-candidate-json")) as unknown); } catch (error: unknown) { throw new StoreError("revision_invalid", error); }
    const candidateQualifiers = candidate.identity.qualifiers.map((qualifier) => ({ key: qualifier.key, type: qualifier.type, value: qualifier.value }));
    const mutationTemporal = mutation.temporal_intent === undefined ? undefined : JSON.parse(mutation.temporal_intent.json) as unknown;
    let candidateTemporal: unknown;
    try { candidateTemporal = candidate.temporal_intent === undefined ? undefined : JSON.parse(canonicalizeTemporalIntent(candidate.temporal_intent).json) as unknown; } catch (error: unknown) { throw new StoreError("revision_invalid", error); }
    if (candidate.candidate_id !== candidateId || candidate.candidate_digest !== candidateDigest || candidate.operation !== mutation.operation || candidate.kind !== mutation.kind || candidate.identity.entity.kind !== mutation.identity.entity.kind || (candidate.identity.entity.kind === "resolved" && mutation.identity.entity.kind === "resolved" && candidate.identity.entity.entity_id !== mutation.identity.entity.entity_id) || candidate.identity.predicate !== mutation.identity.predicate || candidate.identity.cardinality !== mutation.identity.cardinality || JSON.stringify(candidateQualifiers) !== JSON.stringify(mutation.identity.qualifiers) || candidate.source_span_ids.length !== mutation.source_span_ids.length || candidate.source_span_ids.some((id) => !mutation.source_span_ids.includes(id)) || candidate.value.type !== mutation.value.type || JSON.stringify(candidate.value.value) !== JSON.stringify(mutation.value.value) || candidate.expected.item_id !== mutation.item_id || (candidate.expected.revision_id ?? null) !== (mutation.expected.revision_id ?? null) || (candidate.expected.slot_generation ?? null) !== (mutation.expected.slot_generation ?? null) || JSON.stringify(candidateTemporal ?? null) !== JSON.stringify(mutationTemporal ?? null) || candidate.meaning.polarity !== (mutation.meaning?.polarity === "negated" ? "negated" : "affirmed") || candidate.meaning.modality !== (mutation.meaning?.modality === "planned" ? "planned" : mutation.meaning?.modality ?? "unknown") || candidate.meaning.attribution !== mutation.meaning?.attribution.kind) {
      throw new StoreError("revision_conflict");
    }
    const positive = ["entailment", "attribution", "modality", "negation", "time"].every((field) => {
      const value = rowValue(row, field);
      return field === "entailment" ? value === "entailed" : value === "positive";
    });
    const count = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_candidate WHERE batch_id = ?").get(batchId);
    const verdictCount = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_verdict WHERE batch_id = ?").get(batchId);
    const unverified = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_candidate WHERE batch_id = ? AND state <> 'verified'").get(batchId);
    const countValue = (value: unknown): bigint => sqlInteger(rowValue(value, "count"), "verified-count");
    // The verifier contract is batch-wide: acceptance requires a uniformly
    // positive verdict set, so no candidate may remain candidate, disputed or
    // errored while any single candidate is committed.
    if (!positive || countValue(count) !== countValue(verdictCount) || countValue(unverified) !== 0n) throw new StoreError("revision_conflict");
  }

  private assertVerifiedBatchControl(batchId: string, claim: JobClaim): void {
    const now = this.readWallClock();
    const job = this.database.prepare("SELECT state, scope_id, source_capture_id, task_version, owner, fence, lease_until, input_fingerprint, input_privacy_epoch FROM job WHERE job_id = ? AND task_kind = 'extract'").get(claim.job_id);
    if (job === undefined || sqlText(rowValue(job, "state"), "verified-job-state") !== "running" || sqlText(rowValue(job, "scope_id"), "verified-job-scope") !== claim.scope_id || sqlText(rowValue(job, "source_capture_id"), "verified-job-source") !== claim.source_capture_id || sqlText(rowValue(job, "task_version"), "verified-job-version") !== claim.task_version || sqlText(rowValue(job, "owner"), "verified-job-owner") !== claim.owner || sqlInteger(rowValue(job, "fence"), "verified-job-fence").toString(10) !== claim.fence || sqlText(rowValue(job, "lease_until"), "verified-job-lease") !== claim.lease_until || Date.parse(claim.lease_until) <= Date.parse(now) || sqlText(rowValue(job, "input_fingerprint"), "verified-job-fingerprint") !== claim.input_fingerprint || sqlText(rowValue(job, "input_privacy_epoch"), "verified-job-privacy") !== claim.input_privacy_epoch) throw new StoreError("revision_conflict");
    const source = this.database.prepare("SELECT e.fingerprint, s.privacy_epoch, t.capture_id AS tombstone FROM source_event AS e JOIN scope AS s ON s.scope_id = e.scope_id LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id WHERE e.scope_id = ? AND e.capture_id = ?").get(claim.scope_id, claim.source_capture_id);
    if (source === undefined || rowValue(source, "tombstone") !== null || sqlText(rowValue(source, "fingerprint"), "verified-source-fingerprint") !== claim.input_fingerprint || sqlInteger(rowValue(source, "privacy_epoch"), "verified-source-privacy").toString(10) !== claim.input_privacy_epoch) throw new StoreError("revision_conflict");
    const executionBatch = this.database.prepare("SELECT profile_id, provider_id, provider_target, account_ref, auth_epoch, auth_generation, auth_entry_id FROM execution_batch WHERE batch_id = ? AND job_id = ?").get(batchId, claim.job_id);
    if (executionBatch === undefined) throw new StoreError("revision_conflict");
    // The extraction acceptance path is provider-bound: the recorded batch
    // identity must be the registered API provider and the API credential
    // registry row must still match it exactly. The provider-unscoped
    // auth_registry is never consulted for this route.
    const providerId = sqlText(rowValue(executionBatch, "provider_id"), "verified-provider-id");
    const providerTarget = sqlText(rowValue(executionBatch, "provider_target"), "verified-provider-target");
    const local = rowValue(executionBatch, "profile_id") === "XP-Local" && providerId === "local-endpoint";
    if ((!local && providerId !== "openrouter") || providerTarget !== `provider:${providerId}`) throw new StoreError("revision_conflict");
    const closureRows = this.database.prepare(
      `SELECT bs.capture_id, bs.span_id, t.capture_id AS tombstone
         FROM extraction_batch_source AS bs
         JOIN execution_batch AS xb ON xb.batch_id = bs.batch_id
         JOIN scope_output_grant AS g ON g.scope_id = bs.scope_id AND g.output_target = xb.provider_target
         JOIN source_span AS ss ON ss.scope_id = bs.scope_id AND ss.source_id = bs.capture_id AND ss.span_id = bs.span_id
         LEFT JOIN purge_tombstone AS t ON t.scope_id = bs.scope_id AND t.capture_id = bs.capture_id
        WHERE bs.batch_id = ? AND g.source_class = bs.evidence_class`,
    ).all(batchId);
    const expectedClosure = this.database.prepare("SELECT COUNT(*) AS count FROM extraction_batch_source WHERE batch_id = ?").get(batchId);
    if (closureRows.length === 0 || sqlInteger(rowValue(expectedClosure, "count"), "verified-closure-count") !== BigInt(closureRows.length) || closureRows.some((row) => rowValue(row, "tombstone") !== null)) throw new StoreError("revision_conflict");
    if (local) {
      if (rowValue(executionBatch, "auth_generation") !== null || rowValue(executionBatch, "auth_entry_id") !== null) throw new StoreError("revision_conflict");
      return;
    }
    const auth = this.database.prepare("SELECT auth_epoch, state, auth_generation, entry_id FROM api_auth_registry WHERE provider_id = ? AND account_ref = ?").get(providerId, sqlText(rowValue(executionBatch, "account_ref"), "verified-account"));
    if (
      auth === undefined ||
      sqlText(rowValue(auth, "state"), "verified-auth-state") !== "ready" ||
      sqlText(rowValue(auth, "auth_epoch"), "verified-auth-epoch") !== sqlText(rowValue(executionBatch, "auth_epoch"), "verified-batch-auth-epoch") ||
      sqlText(rowValue(auth, "auth_generation"), "verified-auth-generation") !== sqlText(rowValue(executionBatch, "auth_generation"), "verified-batch-auth-generation") ||
      rowValue(auth, "entry_id") !== rowValue(executionBatch, "auth_entry_id")
    ) throw new StoreError("revision_conflict");
  }

  private validateMeaningAttribution(mutation: CanonicalRevisionMutation, sourceEvidence: readonly SourceEvidence[]): void {
    const attribution = mutation.meaning?.attribution;
    if (attribution === undefined) return;
    // native_ids are correlation identifiers, not a typed actor field. Until a
    // trusted adapter adds such a field, actor_ref is an unverified hint and
    // cannot enter the resolver contract.
    if (attribution.actor_ref !== undefined) throw new StoreError("revision_invalid");
    for (const source of sourceEvidence) {
      const matches =
        attribution.kind === "user" ? source.role === "user" :
        attribution.kind === "assistant" ? source.role === "assistant" :
        attribution.kind === "tool" ? source.role === "tool" :
        attribution.kind === "system" ? source.role === "system" :
        source.automation_marker;
      if (!matches) throw new StoreError("revision_invalid");
    }
  }

  private readRevisionMeaning(scopeId: string, revisionId: string | null): CanonicalRevisionMeaning | null {
    if (revisionId === null) return null;
    const row = this.database
      .prepare("SELECT meaning_json, meaning_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
      .get(scopeId, revisionId);
    if (row === undefined) return null;
    const json = nullableText(row, "meaning_json");
    const digest = nullableText(row, "meaning_digest");
    if (json === null && digest === null) return null;
    if (json === null || digest === null || digestJson(json) !== digest) throw new StoreError("revision_invalid");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch (error: unknown) {
      throw new StoreError("revision_invalid", error);
    }
    const meaning = canonicalizeRevisionMeaning(parsed);
    if (meaning.json !== json || meaning.digest !== digest) throw new StoreError("revision_invalid");
    return meaning;
  }

  private effectiveValueDigest(scopeId: string, revisionId: string | null): string | null {
    const effectiveRevision = this.effectiveValueRevisionId(scopeId, revisionId);
    if (effectiveRevision === null) return null;
    const row = this.database
      .prepare("SELECT content_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
      .get(scopeId, effectiveRevision);
    return row === undefined ? null : sqlText(rowValue(row, "content_digest"), "content-digest");
  }

  private readEffectiveRevision(scopeId: string, revisionId: string | null): EffectiveRevision | null {
    const effectiveId = this.effectiveValueRevisionId(scopeId, revisionId);
    if (effectiveId === null) return null;
    const row = this.database
      .prepare("SELECT content_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
      .get(scopeId, effectiveId);
    if (row === undefined) throw new StoreError("revision_invalid");
    return {
      revision_id: effectiveId,
      content_digest: sqlText(rowValue(row, "content_digest"), "content-digest"),
      meaning: this.readRevisionMeaning(scopeId, effectiveId),
      temporal_intent: this.readTemporalIntent(effectiveId, scopeId),
    };
  }

  private readTemporalIntent(revisionId: string, scopeId: string): CanonicalTemporalIntent | null {
    const row = this.database
      .prepare("SELECT intent_json, intent_digest FROM temporal_intent WHERE scope_id = ? AND revision_id = ?")
      .get(scopeId, revisionId);
    if (row === undefined) return null;
    const json = sqlText(rowValue(row, "intent_json"), "intent-json");
    const digest = sqlText(rowValue(row, "intent_digest"), "intent-digest");
    if (digestJson(json) !== digest) throw new StoreError("revision_invalid");
    let stored: unknown;
    try {
      stored = JSON.parse(json) as unknown;
    } catch (error: unknown) {
      throw new StoreError("revision_invalid", error);
    }
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) throw new StoreError("revision_invalid");
    const value = stored as Record<string, unknown>;
    const basis = value.validity_basis;
    let input: Record<string, unknown>;
    if (basis === "unknown") {
      input = { version: 1, validity_basis: "unknown" };
    } else if (basis === "observed_current") {
      input = {
        version: 1,
        validity_basis: basis,
        observed_at: value.original_observed_at,
        precision: value.precision,
        timezone: value.timezone,
      };
    } else if (basis === "interval") {
      const boundInput = (raw: unknown): Record<string, unknown> => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new StoreError("revision_invalid");
        const bound = raw as Record<string, unknown>;
        if (bound.kind === "open" || bound.kind === "unknown") return { kind: bound.kind };
        if (bound.kind === "exact") return { kind: "exact", at: bound.original_at, precision: bound.precision, timezone: bound.timezone };
        if (bound.kind === "uncertain") {
          return {
            kind: "uncertain",
            earliest: bound.original_earliest,
            latest: bound.original_latest,
            precision: bound.precision,
            timezone: bound.timezone,
          };
        }
        throw new StoreError("revision_invalid");
      };
      input = { version: 1, validity_basis: basis, from: boundInput(value.from), to: boundInput(value.to) };
    } else {
      throw new StoreError("revision_invalid");
    }
    const canonical = canonicalizeTemporalIntent(input);
    if (canonical.json !== json || canonical.digest !== digest) throw new StoreError("revision_invalid");
    return canonical;
  }

  private parseSegment(row: unknown): StoredSegment {
    const status = parseContract(z.enum(["definite", "possible", "unknown", "gap"]), rowValue(row, "status"), "segment-status");
    const validFrom = nullableText(row, "valid_from");
    const validTo = nullableText(row, "valid_to");
    if ((validFrom !== null && normalizeTemporalDateTime(validFrom) !== validFrom) || (validTo !== null && normalizeTemporalDateTime(validTo) !== validTo)) {
      throw new StoreError("revision_invalid");
    }
    if (!validInterval(validFrom, validTo)) throw new StoreError("revision_invalid");
    const txFrom = sqlInteger(rowValue(row, "tx_from_seq"), "tx-from-seq");
    const txTo = nullableInteger(row, "tx_to_seq");
    if (txTo !== null && txTo <= txFrom) throw new StoreError("revision_invalid");
    return {
      segment_id: sqlText(rowValue(row, "segment_id"), "segment-id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "segment-scope"),
      item_id: sqlText(rowValue(row, "item_id"), "segment-item"),
      value_revision_id: nullableText(row, "value_revision_id"),
      change_revision_id: sqlText(rowValue(row, "change_revision_id"), "change-revision-id"),
      status,
      valid_from: validFrom,
      valid_to: validTo,
      valid_from_precision: nullableText(row, "valid_from_precision"),
      valid_to_precision: nullableText(row, "valid_to_precision"),
      valid_timezone: nullableText(row, "valid_timezone"),
      valid_from_timezone: nullableText(row, "valid_from_timezone"),
      valid_to_timezone: nullableText(row, "valid_to_timezone"),
      valid_from_original: nullableText(row, "valid_from_original"),
      valid_to_original: nullableText(row, "valid_to_original"),
      tx_from_seq: txFrom,
      tx_to_seq: txTo,
    };
  }

  private closeOpenSegments(scopeId: string, itemId: string, commitSeq: bigint): void {
    const result = this.database
      .prepare("UPDATE state_segment SET tx_to_seq = ? WHERE scope_id = ? AND item_id = ? AND tx_to_seq IS NULL")
      .run(commitSeq, scopeId, itemId);
    if (sqlInteger(result.changes, "segment-close-changes") < 0n) throw new StoreError("revision_write_failed");
  }

  private insertSegment(
    scopeId: string,
    itemId: string,
    valueRevisionId: string | null,
    changeRevisionId: string,
    bounds: SegmentBounds,
    txFromSeq: bigint,
  ): void {
    if (!validInterval(bounds.from, bounds.to)) throw new StoreError("revision_invalid");
    if (bounds.status === "gap" && valueRevisionId !== null) throw new StoreError("revision_invalid");
    if (bounds.status !== "gap" && valueRevisionId === null) throw new StoreError("revision_invalid");
    this.database
      .prepare(
        `INSERT INTO state_segment (
           scope_id, segment_id, item_id, value_revision_id, change_revision_id, status,
           valid_from, valid_to, valid_from_precision, valid_to_precision, valid_timezone,
           valid_from_timezone, valid_to_timezone, valid_from_original, valid_to_original,
           tx_from_seq, tx_to_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        scopeId,
        randomUUID(),
        itemId,
        valueRevisionId,
        changeRevisionId,
        bounds.status,
        bounds.from,
        bounds.to,
        bounds.fromPrecision,
        bounds.toPrecision,
        bounds.timezone,
        bounds.fromTimezone ?? bounds.timezone,
        bounds.toTimezone ?? bounds.timezone,
        bounds.originalFrom,
        bounds.originalTo,
        txFromSeq,
      );
  }

  private intentBounds(intent: CanonicalTemporalIntent): SegmentBounds {
    const bounds = temporalBounds(intent);
    return {
      from: bounds.from,
      to: bounds.to,
      status: bounds.status,
      fromPrecision: bounds.from_precision,
      toPrecision: bounds.to_precision,
      timezone: bounds.from_timezone !== null && bounds.from_timezone === bounds.to_timezone ? bounds.from_timezone : null,
      fromTimezone: bounds.from_timezone,
      toTimezone: bounds.to_timezone,
      originalFrom: bounds.original_from,
      originalTo: bounds.original_to,
      fromLatest: bounds.from_latest,
      toEarliest: bounds.to_earliest,
    };
  }

  private copySegment(segment: StoredSegment, changeRevisionId: string, txFromSeq: bigint, status = segment.status): void {
    this.insertSegment(
      segment.scope_id,
      segment.item_id,
      segment.value_revision_id,
      changeRevisionId,
      {
        from: segment.valid_from,
        to: segment.valid_to,
        status,
        fromPrecision: segment.valid_from_precision,
        toPrecision: segment.valid_to_precision,
        timezone: segment.valid_timezone,
        fromTimezone: segment.valid_from_timezone,
        toTimezone: segment.valid_to_timezone,
        originalFrom: segment.valid_from_original,
        originalTo: segment.valid_to_original,
      },
      txFromSeq,
    );
  }

  private inheritedSupportIntent(scopeId: string, item: ItemRow, active: readonly StoredSegment[], valueDigest: string): CanonicalTemporalIntent {
    const effectiveCurrentId = this.effectiveValueRevisionId(scopeId, item.current_revision_id);
    if (effectiveCurrentId !== null) {
      const current = this.database
        .prepare("SELECT content_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
        .get(scopeId, effectiveCurrentId);
      if (current !== undefined && sqlText(rowValue(current, "content_digest"), "content-digest") === valueDigest) {
        return this.readTemporalIntent(effectiveCurrentId, scopeId) ?? unknownTemporalIntent();
      }
    }
    const matchingSegment = [...active].reverse().find((segment) => {
      if (segment.value_revision_id === null) return false;
      const row = this.database
        .prepare("SELECT content_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
        .get(scopeId, segment.value_revision_id);
      return row !== undefined && sqlText(rowValue(row, "content_digest"), "content-digest") === valueDigest;
    });
    const valueRevisionId = matchingSegment?.value_revision_id ?? item.current_revision_id;
    if (valueRevisionId === null) return unknownTemporalIntent();
    return this.readTemporalIntent(valueRevisionId, scopeId) ?? unknownTemporalIntent();
  }

  private effectiveValueRevisionId(scopeId: string, revisionId: string | null): string | null {
    let current = revisionId;
    for (let depth = 0; current !== null && depth < 256; depth += 1) {
      const row = this.database
        .prepare("SELECT revision_id, operation, parent_revision_id FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
        .get(scopeId, current);
      if (row === undefined) return null;
      const operation = sqlText(rowValue(row, "operation"), "revision-operation");
      if (operation !== "IGNORE") return sqlText(rowValue(row, "revision_id"), "revision-id");
      current = nullableText(row, "parent_revision_id");
    }
    return null;
  }

  private applyTemporalMutation(
    mutation: CanonicalRevisionMutation,
    itemId: string,
    revisionId: string,
    active: readonly StoredSegment[],
    commitSeq: bigint,
    decision: ResolverDecision,
  ): void {
    if (decision.effect === "ignored") return;
    if (mutation.operation === "IGNORE") return;
    const intent = mutation.temporal_intent ?? unknownTemporalIntent();
    const bounds = this.intentBounds(intent);
    if (mutation.operation === "SUPPORT") {
      this.closeOpenSegments(mutation.scope_id, itemId, commitSeq);
      for (const segment of active) this.copySegment(segment, revisionId, commitSeq);
      if (active.length === 0) {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, unknownSegmentBounds(), commitSeq);
      }
      return;
    }

    if (mutation.operation === "DISPUTE") {
      this.closeOpenSegments(mutation.scope_id, itemId, commitSeq);
      for (const segment of active) this.copySegment(segment, revisionId, commitSeq, segment.status === "gap" ? "gap" : "possible");
      if (active.length === 0) {
        this.insertSegment(
          mutation.scope_id,
          itemId,
          revisionId,
          revisionId,
          bounds.status === "unknown" ? unknownSegmentBounds() : { ...bounds, status: "possible" },
          commitSeq,
        );
      } else if (bounds.status !== "unknown") {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, { ...bounds, status: "possible" }, commitSeq);
      } else {
        for (const segment of active) {
          if (segment.status !== "gap") {
            this.insertSegment(
              mutation.scope_id,
              itemId,
              revisionId,
              revisionId,
              {
                from: segment.valid_from,
                to: segment.valid_to,
                status: "unknown",
                fromPrecision: null,
                toPrecision: null,
                timezone: null,
                originalFrom: null,
                originalTo: null,
              },
              commitSeq,
            );
          }
        }
      }
      return;
    }

    this.closeOpenSegments(mutation.scope_id, itemId, commitSeq);
    if (mutation.operation === "ADD") {
      for (const part of temporalIntervalParts(intent)) {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, toSegmentBounds(part), commitSeq);
      }
      return;
    }

    if (mutation.operation === "SUPERSEDE") {
      const transition = temporalTransition(intent);
      if (transition === undefined) {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, unknownSegmentBounds(), commitSeq);
        return;
      }
      for (const segment of active) {
        if (transition.uncertain) {
          this.insertSupersedeOldUncertain(segment, revisionId, transition, commitSeq);
        } else {
          this.insertSupersedeOldExact(segment, revisionId, transition.earliest, commitSeq);
        }
      }
      for (const part of temporalIntervalParts(intent)) {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, toSegmentBounds(part), commitSeq);
      }
      return;
    }

    if (mutation.operation === "CORRECT") {
      if (bounds.status === "unknown") {
        for (const segment of active) this.insertCorrectionEdges(segment, revisionId, bounds, commitSeq);
        for (const part of temporalIntervalParts(intent)) {
          this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, toSegmentBounds(part), commitSeq);
        }
        return;
      }
      for (const segment of active) {
        this.insertCorrectionEdges(segment, revisionId, bounds, commitSeq);
      }
      for (const part of temporalIntervalParts(intent)) {
        this.insertSegment(mutation.scope_id, itemId, revisionId, revisionId, toSegmentBounds(part), commitSeq);
      }
      return;
    }

    if (mutation.operation === "RETRACT") {
      if (intent.validity_basis === "unknown") {
        this.insertSegment(mutation.scope_id, itemId, null, revisionId, unknownGapBounds(), commitSeq);
        return;
      }
      const retractionParts = temporalIntervalParts(intent);
      if (bounds.status === "unknown") {
        for (const segment of active) this.insertRetractionPartition(segment, revisionId, bounds, commitSeq);
        for (const part of retractionParts) {
          this.insertSegment(mutation.scope_id, itemId, null, revisionId, { ...toSegmentBounds(part), status: "gap" }, commitSeq);
        }
        if (active.length === 0 && retractionParts.length === 0) {
          this.insertSegment(mutation.scope_id, itemId, null, revisionId, unknownGapBounds(), commitSeq);
        }
        return;
      }
      for (const segment of active) this.insertRetractionPartition(segment, revisionId, bounds, commitSeq);
      for (const part of retractionParts) {
        this.insertSegment(mutation.scope_id, itemId, null, revisionId, { ...toSegmentBounds(part), status: "gap" }, commitSeq);
      }
      if (active.length === 0 && temporalIntervalParts(intent).length === 0) {
        this.insertSegment(mutation.scope_id, itemId, null, revisionId, unknownGapBounds(), commitSeq);
      }
    }
  }

  private insertSupersedeOldExact(segment: StoredSegment, revisionId: string, transition: string, commitSeq: bigint): void {
    const beforeTo = minUpper(segment.valid_to, transition);
    if ((segment.valid_from === null || segment.valid_from < transition) && validInterval(segment.valid_from, beforeTo)) {
      this.copySegmentWithBounds(segment, revisionId, segment.valid_from, beforeTo, commitSeq);
    }
  }

  private insertSupersedeOldUncertain(segment: StoredSegment, revisionId: string, transition: { readonly earliest: string; readonly latest: string | null }, commitSeq: bigint): void {
    const earliest = transition.earliest;
    const latest = transition.latest;
    const beforeTo = minUpper(segment.valid_to, earliest);
    if ((segment.valid_from === null || segment.valid_from < earliest) && validInterval(segment.valid_from, beforeTo)) {
      this.copySegmentWithBounds(segment, revisionId, segment.valid_from, beforeTo, commitSeq);
    }
    if (latest !== null) {
      const uncertainFrom = maxLower(segment.valid_from, earliest);
      const uncertainTo = minUpper(segment.valid_to, latest);
      if (validInterval(uncertainFrom, uncertainTo)) {
        this.copySegmentWithBounds(segment, revisionId, uncertainFrom, uncertainTo, commitSeq, "possible");
      }
    } else {
      const uncertainFrom = maxLower(segment.valid_from, earliest);
      if (validInterval(uncertainFrom, segment.valid_to)) {
        this.copySegmentWithBounds(segment, revisionId, uncertainFrom, segment.valid_to, commitSeq, "possible");
      }
    }
  }

  private insertCorrectionEdges(segment: StoredSegment, revisionId: string, correction: SegmentBounds, commitSeq: bigint): void {
    const leftTo = minUpper(segment.valid_to, correction.from);
    if ((correction.from !== null && (segment.valid_from === null || segment.valid_from < correction.from)) && validInterval(segment.valid_from, leftTo)) {
      this.copySegmentWithBounds(segment, revisionId, segment.valid_from, leftTo, commitSeq);
    }
    if (correction.to !== null) {
      const rightFrom = maxLower(segment.valid_from, correction.to);
      if (validInterval(rightFrom, segment.valid_to)) {
        this.copySegmentWithBounds(segment, revisionId, rightFrom, segment.valid_to, commitSeq);
      }
    }
    this.insertPossibleCorrectionAlternatives(segment, revisionId, correction, commitSeq);
  }

  private insertPossibleCorrectionAlternatives(segment: StoredSegment, revisionId: string, correction: SegmentBounds, commitSeq: bigint): void {
    if (segment.status === "gap" || correction.status === "unknown") return;
    const startCore = correction.fromLatest ?? correction.from;
    const endCore = correction.toEarliest ?? correction.to;
    const hullFrom = maxLower(segment.valid_from, correction.from);
    const hullTo = minUpper(segment.valid_to, correction.to);
    if (!validInterval(startCore, endCore)) {
      if (validInterval(hullFrom, hullTo)) this.copySegmentWithBounds(segment, revisionId, hullFrom, hullTo, commitSeq, "possible");
      return;
    }
    if (correction.fromLatest !== undefined && correction.from !== null && correction.fromLatest !== null) {
      const from = maxLower(segment.valid_from, correction.from);
      const to = minUpper(segment.valid_to, correction.fromLatest);
      if (validInterval(from, to)) this.copySegmentWithBounds(segment, revisionId, from, to, commitSeq, "possible");
    }
    if (correction.toEarliest !== undefined && correction.to !== null && correction.toEarliest !== null) {
      const from = maxLower(segment.valid_from, correction.toEarliest);
      const to = minUpper(segment.valid_to, correction.to);
      if (validInterval(from, to)) this.copySegmentWithBounds(segment, revisionId, from, to, commitSeq, "possible");
    }
  }

  private insertRetractionPartition(
    segment: StoredSegment,
    revisionId: string,
    bounds: SegmentBounds,
    commitSeq: bigint,
  ): void {
    const leftTo = minUpper(segment.valid_to, bounds.from);
    if ((bounds.from !== null && (segment.valid_from === null || segment.valid_from < bounds.from)) && validInterval(segment.valid_from, leftTo)) {
      this.copySegmentWithBounds(segment, revisionId, segment.valid_from, leftTo, commitSeq);
    }
    const rightFrom = bounds.to === null ? null : maxLower(segment.valid_from, bounds.to);
    if (bounds.to !== null && validInterval(rightFrom, segment.valid_to)) {
      this.copySegmentWithBounds(segment, revisionId, rightFrom, segment.valid_to, commitSeq);
    }
    if (segment.status === "gap") return;
    const coreFrom = bounds.fromLatest ?? bounds.from;
    const coreTo = bounds.toEarliest ?? bounds.to;
    const hullFrom = maxLower(segment.valid_from, bounds.from);
    const hullTo = minUpper(segment.valid_to, bounds.to);
    if (!validInterval(coreFrom, coreTo)) {
      if (validInterval(hullFrom, hullTo)) this.copySegmentWithBounds(segment, revisionId, hullFrom, hullTo, commitSeq, "possible");
      return;
    }
    if (bounds.fromLatest !== undefined && bounds.from !== null && bounds.fromLatest !== null) {
      const possibleFrom = maxLower(segment.valid_from, bounds.from);
      const possibleTo = minUpper(segment.valid_to, bounds.fromLatest);
      if (validInterval(possibleFrom, possibleTo)) this.copySegmentWithBounds(segment, revisionId, possibleFrom, possibleTo, commitSeq, "possible");
    }
    if (bounds.toEarliest !== undefined && bounds.to !== null && bounds.toEarliest !== null) {
      const possibleFrom = maxLower(segment.valid_from, bounds.toEarliest);
      const possibleTo = minUpper(segment.valid_to, bounds.to);
      if (validInterval(possibleFrom, possibleTo)) this.copySegmentWithBounds(segment, revisionId, possibleFrom, possibleTo, commitSeq, "possible");
    }
  }

  private copySegmentWithBounds(
    segment: StoredSegment,
    changeRevisionId: string,
    from: string | null,
    to: string | null,
    txFromSeq: bigint,
    status = segment.status,
  ): void {
    // Projection cut metadata is derived at the cut only. An unchanged
    // endpoint retains the immutable intent's precision/timezone/original
    // text; a newly calculated non-null endpoint is a canonical UTC instant;
    // an open endpoint has no endpoint metadata. This stays independent of
    // semantic status, including unknown segments.
    const unchangedFrom = from !== null && from === segment.valid_from;
    const unchangedTo = to !== null && to === segment.valid_to;
    const fromPrecision = from === null ? null : unchangedFrom ? segment.valid_from_precision : "instant";
    const toPrecision = to === null ? null : unchangedTo ? segment.valid_to_precision : "instant";
    const fromTimezone = from === null ? null : unchangedFrom ? segment.valid_from_timezone ?? segment.valid_timezone : "UTC";
    const toTimezone = to === null ? null : unchangedTo ? segment.valid_to_timezone ?? segment.valid_timezone : "UTC";
    const originalFrom = from === null ? null : unchangedFrom ? segment.valid_from_original : from;
    const originalTo = to === null ? null : unchangedTo ? segment.valid_to_original : to;
    this.insertSegment(
      segment.scope_id,
      segment.item_id,
      segment.value_revision_id,
      changeRevisionId,
      {
        from,
        to,
        status,
        fromPrecision,
        toPrecision,
        timezone: fromTimezone !== null && fromTimezone === toTimezone ? fromTimezone : null,
        fromTimezone,
        toTimezone,
        originalFrom,
        originalTo,
      },
      txFromSeq,
    );
  }

  private requireScope(scopeId: string, binding: TrustedBinding): void {
    if (!binding.allowed_scope_ids.includes(scopeId)) throw new StoreError("scope_not_allowed");
    const row = this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(scopeId);
    if (row === undefined) throw new StoreError("scope_not_registered");
  }

  private readSourceEvidence(scopeId: string, sourceSpanIds: readonly string[]): SourceEvidence[] {
    const placeholders = sourceSpanIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT s.span_id, s.source_id, s.scope_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest,
                e.role, e.evidence_class, e.session_id, e.payload_json, e.event_json,
                sess.host_kind, sess.surface, sess.execution_domain_kind, sess.execution_domain_id,
                sess.host_instance_id, sess.host_session_id,
                t.capture_id AS tombstone_capture_id
           FROM source_span AS s
           JOIN source_event AS e
             ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
           JOIN session AS sess
             ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = s.scope_id AND t.capture_id = s.source_id
          WHERE s.scope_id = ? AND s.span_id IN (${placeholders})`,
      )
      .all(scopeId, ...sourceSpanIds);
    if (rows.length !== sourceSpanIds.length) throw new StoreError("revision_invalid");
    const evidence: SourceEvidence[] = [];
    for (const row of rows) {
      if (rowValue(row, "tombstone_capture_id") !== null) throw new StoreError("revision_invalid");
      const role = parseContract(sourceRoleSchema, rowValue(row, "role"), "source-role");
      const evidenceClass = parseContract(evidenceClassSchema, rowValue(row, "evidence_class"), "source-class");
      const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "payload_json"), "payload_json");
      const event = jsonObject(sqlText(rowValue(row, "event_json"), "event_json"), "event_json");
      const correlationData = nativeCorrelationData(event);
      const sessionId = sqlText(rowValue(row, "session_id"), "source-session-id");
      const sessionNamespace = {
        scopeId,
        sessionId,
        hostKind: sqlText(rowValue(row, "host_kind"), "source-host-kind"),
        surface: sqlText(rowValue(row, "surface"), "source-surface"),
        domainKind: sqlText(rowValue(row, "execution_domain_kind"), "source-domain-kind"),
        domainId: sqlText(rowValue(row, "execution_domain_id"), "source-domain-id"),
        hostInstanceId: sqlText(rowValue(row, "host_instance_id"), "source-host-instance"),
        hostSessionId: sqlText(rowValue(row, "host_session_id"), "source-host-session"),
      };
      const root = sqlText(rowValue(row, "root"), "source-root");
      if (root !== "payload" && root !== "event") throw new StoreError("revision_invalid");
      const path = sqlText(rowValue(row, "path"), "source-path");
      const start = sqlInteger(rowValue(row, "start_utf16"), "source-start");
      const end = sqlInteger(rowValue(row, "end_utf16"), "source-end");
      if (start > BigInt(Number.MAX_SAFE_INTEGER) || end > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreError("revision_invalid");
      try {
        validateSpanExcerpt(
          resolveTextAtPath(root === "event" ? event : payload, path),
          Number(start),
          Number(end),
          sqlText(rowValue(row, "digest"), "source-digest"),
        );
      } catch (error: unknown) {
        throw new StoreError("revision_invalid", error);
      }
      evidence.push({
        source_capture_id: sqlText(rowValue(row, "source_id"), "source-capture-id"),
        source_span_id: sqlText(rowValue(row, "span_id"), "source-span-id"),
        session_id: sessionId,
        stage: correlationData.stage,
        correlation_key: correlationData.correlation_key,
        native_ids_json: correlationData.native_ids_json,
        role,
        evidence_class: evidenceClass,
        native_identity: nativeIdentity(event, sessionNamespace),
        native_outcome: nativeOutcome(event),
        automation_marker: automationMarker(event),
      });
    }
    evidence.sort((left, right) => left.source_span_id.localeCompare(right.source_span_id));
    return evidence;
  }

  private readItemSourceFacts(scopeId: string, itemId: string, incoming: readonly SourceEvidence[]): SourceEvidence[] {
    if (incoming.length === 0) return [];
    if (incoming.length > MAX_RESOLVER_SOURCE_FACTS) throw new StoreError("revision_invalid");
    const exactPairs = incoming.map(() => "(rs.source_capture_id = ? AND rs.source_span_id = ?)").join(" OR ");
    const exactRows = this.database
      .prepare(
        `SELECT DISTINCT rs.source_capture_id, rs.source_span_id
           FROM revision_source AS rs
           JOIN memory_revision AS r
             ON r.scope_id = rs.scope_id AND r.revision_id = rs.revision_id
          WHERE r.scope_id = ? AND r.item_id = ? AND r.operation <> 'IGNORE'
            AND (${exactPairs})
          ORDER BY rs.source_span_id`,
      )
      .all(
        scopeId,
        itemId,
        ...incoming.flatMap((source) => [source.source_capture_id, source.source_span_id]),
      );
    const refs: Array<{ readonly captureId: string; readonly spanId: string }> = exactRows.map((row) => ({
      captureId: sqlText(rowValue(row, "source_capture_id"), "item-source-capture"),
      spanId: sqlText(rowValue(row, "source_span_id"), "item-source-span"),
    }));
    const nativeMatch = this.database.prepare(
      `SELECT rs.source_capture_id, rs.source_span_id
         FROM revision_source AS rs
         JOIN memory_revision AS r
           ON r.scope_id = rs.scope_id AND r.revision_id = rs.revision_id
         JOIN source_event AS e
           ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
        WHERE r.scope_id = ? AND r.item_id = ? AND r.operation <> 'IGNORE'
          AND e.session_id = ?
          AND json_extract(e.event_json, '$.stage') = ?
          AND json_extract(e.event_json, '$.provenance.correlation.status') = 'correlated'
          AND json_extract(e.event_json, '$.provenance.correlation.key') = ?
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(e.event_json, '$.native_ids') AS existing_id
             WHERE existing_id.key <> 'session_id'
               AND NOT EXISTS (
                 SELECT 1
                   FROM json_each(?) AS wanted_id
                  WHERE wanted_id.key = existing_id.key
                    AND wanted_id.value = existing_id.value
               )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM json_each(?) AS wanted_id
             WHERE NOT EXISTS (
               SELECT 1
                 FROM json_each(e.event_json, '$.native_ids') AS existing_id
                WHERE existing_id.key = wanted_id.key
                  AND existing_id.value = wanted_id.value
             )
            )
        ORDER BY rs.source_span_id
        LIMIT 1`,
    );
    for (const source of incoming) {
      if (source.native_identity === null || source.correlation_key === null || source.native_ids_json === null) continue;
      if (refs.some((existing) => existing.captureId === source.source_capture_id && existing.spanId === source.source_span_id)) continue;
      const row = nativeMatch.get(
        scopeId,
        itemId,
        source.session_id,
        source.stage,
        source.correlation_key,
        source.native_ids_json,
        source.native_ids_json,
      );
      if (row === undefined) continue;
      const ref = {
        captureId: sqlText(rowValue(row, "source_capture_id"), "item-source-capture"),
        spanId: sqlText(rowValue(row, "source_span_id"), "item-source-span"),
      };
      if (refs.length < MAX_RESOLVER_SOURCE_FACTS && !refs.some((existing) => existing.captureId === ref.captureId && existing.spanId === ref.spanId)) {
        refs.push(ref);
      }
    }
    return refs.length === 0 ? [] : this.readSourceEvidence(scopeId, refs.map((ref) => ref.spanId));
  }

  private resolveEntity(mutation: CanonicalRevisionMutation, commitSeq: bigint): string | null {
    const entity = mutation.identity.entity;
    if (entity.kind === "none") return null;
    if (entity.kind === "resolved") {
      const row = this.database
        .prepare("SELECT resolution_state FROM entity WHERE scope_id = ? AND entity_id = ?")
        .get(mutation.scope_id, entity.entity_id);
      if (row === undefined || sqlText(rowValue(row, "resolution_state"), "entity-state") !== "resolved") {
        throw new StoreError("revision_invalid");
      }
      return entity.entity_id;
    }
    const entityId = entity.entity_id ?? randomUUID();
    const existing = this.database
      .prepare("SELECT resolution_state, canonical_key, label FROM entity WHERE scope_id = ? AND entity_id = ?")
      .get(mutation.scope_id, entityId);
    if (existing !== undefined) {
      if (
        sqlText(rowValue(existing, "resolution_state"), "entity-state") !== "candidate" ||
        rowValue(existing, "canonical_key") !== null ||
        sqlText(rowValue(existing, "label"), "entity-label") !== entity.label
      ) {
        throw new StoreError("revision_conflict");
      }
      return entityId;
    }
    this.database
      .prepare(
        `INSERT INTO entity (scope_id, entity_id, resolution_state, canonical_key, label, created_commit_seq)
         VALUES (?, ?, 'candidate', NULL, ?, ?)`,
      )
      .run(mutation.scope_id, entityId, entity.label, commitSeq);
    return entityId;
  }

  private readItem(scopeId: string, itemId: string): ItemRow | undefined {
    const row = this.database
      .prepare(
        `SELECT scope_id, item_id, kind, entity_id, predicate, qualifiers_digest, qualifiers_json,
                cardinality, status, current_revision_id
           FROM memory_item WHERE scope_id = ? AND item_id = ?`,
      )
      .get(scopeId, itemId);
    if (row === undefined) return undefined;
    return {
      scope_id: sqlText(rowValue(row, "scope_id"), "item-scope"),
      item_id: sqlText(rowValue(row, "item_id"), "item-id"),
      kind: parseContract(z.enum(["observation", "plan", "fact", "decision", "preference", "lesson", "procedure"]), rowValue(row, "kind"), "memory-kind"),
      entity_id: nullableText(row, "entity_id"),
      predicate: sqlText(rowValue(row, "predicate"), "predicate"),
      qualifiers_digest: sqlText(rowValue(row, "qualifiers_digest"), "qualifiers-digest"),
      qualifiers_json: sqlText(rowValue(row, "qualifiers_json"), "qualifiers-json"),
      cardinality: parseContract(z.enum(["exclusive", "multi"]), rowValue(row, "cardinality"), "semantic-cardinality"),
      status: parseContract(memoryItemStatusSchema, rowValue(row, "status"), "memory-item-status"),
      current_revision_id: nullableText(row, "current_revision_id"),
    };
  }

  private readSlot(mutation: CanonicalRevisionMutation, entityId: string): SlotRow | undefined {
    const row = this.database
      .prepare(
        `SELECT cardinality, generation, qualifiers_json
           FROM semantic_slot
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ?`,
      )
      .get(mutation.scope_id, entityId, mutation.identity.predicate, mutation.identity.qualifiers_digest);
    if (row === undefined) return undefined;
    return {
      cardinality: parseContract(z.enum(["exclusive", "multi"]), rowValue(row, "cardinality"), "semantic-cardinality"),
      generation: sqlInteger(rowValue(row, "generation"), "slot-generation"),
      qualifiers_json: sqlText(rowValue(row, "qualifiers_json"), "slot-qualifiers"),
    };
  }

  private insertSlot(mutation: CanonicalRevisionMutation, entityId: string, commitSeq: bigint): void {
    this.database
      .prepare(
        `INSERT INTO semantic_slot (
           scope_id, entity_id, predicate, qualifiers_json, qualifiers_digest,
           cardinality, generation, created_commit_seq
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        mutation.scope_id,
        entityId,
        mutation.identity.predicate,
        mutation.identity.qualifiers_json,
        mutation.identity.qualifiers_digest,
        mutation.identity.cardinality,
        commitSeq,
      );
  }

  private insertItem(mutation: CanonicalRevisionMutation, itemId: string, entityId: string | null, commitSeq: bigint): void {
    this.database
      .prepare(
        `INSERT INTO memory_item (
           scope_id, item_id, kind, entity_id, predicate, qualifiers_json,
           qualifiers_digest, cardinality, status, current_revision_id, created_commit_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, ?)`,
      )
      .run(
        mutation.scope_id,
        itemId,
        mutation.kind,
        entityId,
        mutation.identity.predicate,
        mutation.identity.qualifiers_json,
        mutation.identity.qualifiers_digest,
        mutation.identity.cardinality,
        commitSeq,
      );
  }

  private insertRevision(
    binding: TrustedBinding,
    mutation: CanonicalRevisionMutation,
    itemId: string,
    parentRevisionId: string | null,
    commitSeq: bigint,
    effectiveIntent?: CanonicalTemporalIntent,
  ): string {
    const revisionId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO memory_revision (
           scope_id, revision_id, item_id, parent_revision_id, operation,
           content_json, content_digest, actor_binding_id, actor_host_kind,
           actor_surface, actor_execution_domain_kind, actor_execution_domain_id,
           actor_host_instance_id, actor_host_session_id, meaning_json, meaning_digest, created_commit_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mutation.scope_id,
        revisionId,
        itemId,
        parentRevisionId,
        mutation.operation,
        mutation.value.json,
        mutation.value.digest,
        binding.binding_id,
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
        mutation.meaning?.json ?? null,
        mutation.meaning?.digest ?? null,
        commitSeq,
      );
    const intent = mutation.temporal_intent ?? effectiveIntent ?? unknownTemporalIntent();
    this.database
      .prepare(
        `INSERT INTO temporal_intent (scope_id, revision_id, intent_json, intent_digest)
         VALUES (?, ?, ?, ?)`,
      )
      .run(mutation.scope_id, revisionId, intent.json, intent.digest);
    return revisionId;
  }

  private insertRevisionSources(scopeId: string, revisionId: string, evidence: readonly SourceEvidence[]): void {
    const insert = this.database.prepare(
      `INSERT INTO revision_source (scope_id, revision_id, source_capture_id, source_span_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const source of evidence) {
      insert.run(scopeId, revisionId, source.source_capture_id, source.source_span_id);
      this.onRevisionSourceLinked?.(scopeId, revisionId, source.source_capture_id);
    }
  }

  private updateCurrentRevision(scopeId: string, itemId: string, expectedRevisionId: string | null, revisionId: string): void {
    const result = this.database
      .prepare(
        `UPDATE memory_item SET current_revision_id = ?
          WHERE scope_id = ? AND item_id = ?
            AND ((current_revision_id IS NULL AND ? IS NULL) OR current_revision_id = ?)`,
      )
      .run(revisionId, scopeId, itemId, expectedRevisionId, expectedRevisionId);
    if (sqlInteger(result.changes, "item_revision_changes") !== 1n) throw new StoreError("revision_conflict");
  }

  private requireMatchingMember(mutation: CanonicalRevisionMutation, entityId: string | null, itemId: string): void {
    if (entityId === null) return;
    const row = this.database
      .prepare(
        `SELECT member_digest
           FROM semantic_slot_member
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ? AND item_id = ?`,
      )
      .get(mutation.scope_id, entityId, mutation.identity.predicate, mutation.identity.qualifiers_digest, itemId);
    if (row === undefined || sqlText(rowValue(row, "member_digest"), "member-digest") !== mutation.value.digest) {
      throw new StoreError("revision_conflict");
    }
  }

  private requireMatchingCurrentValue(scopeId: string, itemId: string, digest: string): void {
    const row = this.database
      .prepare(
        `WITH RECURSIVE revision_chain(revision_id, operation, parent_revision_id, content_digest) AS (
           SELECT r.revision_id, r.operation, r.parent_revision_id, r.content_digest
             FROM memory_item AS i
             JOIN memory_revision AS r
               ON r.scope_id = i.scope_id AND r.revision_id = i.current_revision_id
            WHERE i.scope_id = ? AND i.item_id = ?
           UNION ALL
           SELECT parent.revision_id, parent.operation, parent.parent_revision_id, parent.content_digest
             FROM revision_chain AS child
             JOIN memory_revision AS parent
               ON child.operation = 'IGNORE'
              AND parent.revision_id = child.parent_revision_id
              AND parent.scope_id = ?
         )
         SELECT content_digest FROM revision_chain WHERE operation <> 'IGNORE' LIMIT 1`,
      )
      .get(scopeId, itemId, scopeId);
    if (row === undefined || sqlText(rowValue(row, "content_digest"), "content-digest") !== digest) {
      throw new StoreError("revision_conflict");
    }
  }

  private slotMemberExists(mutation: CanonicalRevisionMutation, entityId: string, memberDigest: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS present
           FROM semantic_slot_member
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ? AND member_digest = ?`,
      )
      .get(mutation.scope_id, entityId, mutation.identity.predicate, mutation.identity.qualifiers_digest, memberDigest);
    return row !== undefined;
  }

  private bumpSlotGeneration(
    mutation: CanonicalRevisionMutation,
    entityId: string,
    revisionId: string,
    itemId: string,
    slot: SlotRow,
  ): string {
    if (slot.generation >= MAX_INT64) throw new StoreError("revision_write_failed");
    const next = slot.generation + 1n;
    const member = this.database
      .prepare(
        `SELECT member_digest
           FROM semantic_slot_member
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ? AND item_id = ?`,
      )
      .get(mutation.scope_id, entityId, mutation.identity.predicate, mutation.identity.qualifiers_digest, itemId);
    if (member === undefined) throw new StoreError("revision_invalid");
    const previousDigest = sqlText(rowValue(member, "member_digest"), "member-digest");
    if (previousDigest !== mutation.value.digest && this.slotMemberExists(mutation, entityId, mutation.value.digest)) {
      throw new StoreError("revision_conflict");
    }
    const memberUpdated = this.database
      .prepare(
        `UPDATE semantic_slot_member SET member_digest = ?, revision_id = ?
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ?
            AND item_id = ? AND member_digest = ?`,
      )
      .run(
        mutation.value.digest,
        revisionId,
        mutation.scope_id,
        entityId,
        mutation.identity.predicate,
        mutation.identity.qualifiers_digest,
        itemId,
        previousDigest,
      );
    if (sqlInteger(memberUpdated.changes, "slot_member_revision_changes") !== 1n) throw new StoreError("revision_conflict");
    const updated = this.database
      .prepare(
        `UPDATE semantic_slot SET generation = ?
          WHERE scope_id = ? AND entity_id = ? AND predicate = ? AND qualifiers_digest = ? AND generation = ?`,
      )
      .run(
        next,
        mutation.scope_id,
        entityId,
        mutation.identity.predicate,
        mutation.identity.qualifiers_digest,
        slot.generation,
      );
    if (sqlInteger(updated.changes, "slot_generation_changes") !== 1n) throw new StoreError("revision_conflict");
    return next.toString(10);
  }

  private insertSlotMember(mutation: CanonicalRevisionMutation, entityId: string, revisionId: string, itemId: string): void {
    this.database
      .prepare(
        `INSERT INTO semantic_slot_member (
           scope_id, entity_id, predicate, qualifiers_digest, member_digest, item_id, revision_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mutation.scope_id,
        entityId,
        mutation.identity.predicate,
        mutation.identity.qualifiers_digest,
        mutation.value.digest,
        itemId,
        revisionId,
      );
  }

  private insertOperation(
    mutation: CanonicalRevisionMutation,
    itemId: string,
    revisionId: string,
    slotGeneration: string | null,
    commitSeq: bigint,
    resultStatus: z.infer<typeof memoryItemStatusSchema>,
    decision: ResolverDecision,
  ): void {
    this.database
      .prepare(
        `INSERT INTO revision_operation (
           operation_id, scope_id, request_digest, status,
           result_item_id, result_revision_id, result_slot_generation, result_code,
           result_item_status, resolver_disposition, resolver_reason, created_commit_seq
         ) VALUES (?, ?, ?, 'committed', ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        mutation.operation_id,
        mutation.scope_id,
        mutation.request_digest,
        itemId,
        revisionId,
        slotGeneration,
        resultStatus,
        decision.effect,
        decision.reason === "verified_entailment" ? "candidate_only_until_t11b" : decision.reason,
        commitSeq,
      );
  }

  private nextCommit(scopeId: string): { readonly commitSeq: bigint; readonly dataEpoch: bigint } {
    const counter = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
    if (counter === undefined) throw new StoreError("revision_write_failed");
    const currentCommit = sqlInteger(rowValue(counter, "commit_seq"), "commit_seq");
    const currentEpoch = sqlInteger(rowValue(counter, "data_epoch"), "data_epoch");
    if (currentCommit >= MAX_INT64 || currentEpoch >= MAX_INT64) throw new StoreError("revision_write_failed");
    const commitSeq = currentCommit + 1n;
    const dataEpoch = currentEpoch + 1n;
    const counterUpdate = this.database
      .prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1 AND commit_seq = ? AND data_epoch = ?")
      .run(commitSeq, dataEpoch, currentCommit, currentEpoch);
    if (sqlInteger(counterUpdate.changes, "counter_changes") !== 1n) throw new StoreError("revision_conflict");
    try {
      recordCommitClock(this.database, commitSeq, this.wallClock);
    } catch (error: unknown) {
      throw new StoreError("revision_write_failed", error);
    }
    const scopeUpdate = this.database
      .prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?")
      .run(dataEpoch, scopeId);
    if (sqlInteger(scopeUpdate.changes, "scope_epoch_changes") !== 1n) throw new StoreError("revision_write_failed");
    return { commitSeq, dataEpoch };
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
          // Preserve the original revision failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }
}
