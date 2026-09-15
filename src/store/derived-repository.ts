import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { memoryRecordInputSchema, memoryRecordSchema, type MemoryRecord, type MemoryRecordInput } from "../core/memory-record.js";
import { redactCaptureInput } from "../core/redact.js";
import { isTrustedBinding, type TrustedBinding } from "../host/contract.js";
import { isPolicyOutputBinding, readerOutputTarget, type PolicyOutputBinding } from "../core/policy.js";
import { normalizeTemporalDateTime } from "../core/time.js";
import { StoreError } from "./errors.js";

const uuid = z.uuid();
const dependencyType = z.enum(["derived_artifact", "memory_revision"]);
const parentType = z.enum(["derived_artifact", "memory_revision", "source_span"]);
const relation = z.enum(["derives", "supports"]);
const artifactKind = z.enum(["summary", "reflection", "search_enrichment"]);
const purpose = z.enum(["historical", "current"]);
const artifactStatus = z.enum(["active", "blocked", "purged"]);
const sourceRecordFormat = "agent_memory_record_v1" as const;
const sourceRecordOrigin = "agent_report" as const;
const sourceRecordLimit = 50;
const sourceRecordSourceLimit = 16;
const sourceRecordPayloadSql = "CASE WHEN json_valid(json_extract(content_json, '$')) THEN json_extract(content_json, '$') ELSE 'null' END";

export type DependencyType = z.infer<typeof dependencyType>;
export type DependencyParentType = z.infer<typeof parentType>;
export type DependencyRelation = z.infer<typeof relation>;
export type DerivedArtifactKind = z.infer<typeof artifactKind>;
export type SummaryPurpose = z.infer<typeof purpose>;
export type DerivedArtifactStatus = z.infer<typeof artifactStatus>;

/** Distinct delivery label so historical text can never masquerade as current state. */
export type SummaryContextLabel = "historical_session_context" | "current_project_context";

export function contextLabel(purpose: SummaryPurpose): SummaryContextLabel {
  return purpose === "historical" ? "historical_session_context" : "current_project_context";
}

const commitSeqSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const validAtSchema = z.iso.datetime({ offset: true });

/** Optional bitemporal read contract for derived artifacts (plan §6). */
export interface ReadSummaryOptions {
  /** Valid-time instant the summary must cover; defaults to unfiltered. */
  readonly valid_at?: string;
  /** Transaction-time watermark; artifacts committed later are not yet known. */
  readonly known_at_seq?: string;
}

export interface DependencyRecord {
  readonly version: 1;
  readonly scope_id: string;
  readonly child_type: DependencyType;
  readonly child_revision_id: string;
  readonly parent_type: DependencyParentType;
  readonly parent_revision_id: string;
  readonly relation: DependencyRelation;
  readonly created_commit_seq: string;
}

export interface SummaryTemporalInterval {
  readonly from: string | null;
  readonly to: string | null;
}

export interface SummaryTemporalDomain {
  readonly version: 1;
  readonly status: "definite" | "unknown";
  readonly intervals: readonly SummaryTemporalInterval[];
}

export interface DerivedArtifactRecord {
  readonly version: 1;
  readonly artifact_id: string;
  readonly scope_id: string;
  readonly revision_id: string;
  readonly kind: DerivedArtifactKind;
  readonly purpose: SummaryPurpose;
  readonly context_label: SummaryContextLabel;
  readonly session_id: string | null;
  readonly content: string;
  readonly content_digest: string;
  readonly temporal_domain: SummaryTemporalDomain;
  readonly egress_targets: readonly string[];
  readonly status: DerivedArtifactStatus;
  readonly status_reason: string | null;
  readonly created_commit_seq: string;
  readonly invalidated_commit_seq: string | null;
  readonly dependencies: readonly DependencyRecord[];
}

export interface CreateSummaryInput {
  readonly artifact_id?: string;
  readonly revision_id?: string;
  readonly scope_id: string;
  readonly kind?: DerivedArtifactKind;
  readonly purpose: SummaryPurpose;
  readonly session_id?: string;
  readonly content: string;
  readonly parent_revision_ids: readonly string[];
}

function rowValue(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null || !(key in row)) throw new StoreError("read_failed");
  return (row as Record<string, unknown>)[key];
}

function text(row: unknown, key: string): string {
  const value = rowValue(row, key);
  if (typeof value !== "string") throw new StoreError("read_failed");
  return value;
}

function nullableText(row: unknown, key: string): string | null {
  const value = rowValue(row, key);
  return value === null ? null : text(row, key);
}

function integer(row: unknown, key: string): bigint {
  const value = rowValue(row, key);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new StoreError("read_failed");
}

function parseJson<T>(row: unknown, key: string): T {
  try { return JSON.parse(text(row, key)) as T; } catch (error: unknown) { throw new StoreError("read_failed", error); }
}

function isSourceRecordContent(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).format === sourceRecordFormat;
  } catch {
    return false;
  }
}

function foldGerman(value: string): string {
  return value
    .replaceAll("Ä", "ä")
    .replaceAll("Ö", "ö")
    .replaceAll("Ü", "ü")
    .replaceAll("ẞ", "ß")
    .toLocaleLowerCase("und");
}

function foldGermanSql(valueSql: string): string {
  return `lower(replace(replace(replace(replace(${valueSql}, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß'))`;
}

function parseSourceRecordInput(input: MemoryRecordInput): MemoryRecordInput {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.hasOwn(input, "redaction")) throw new StoreError("revision_invalid");
  let redacted: unknown;
  try {
    redacted = redactCaptureInput(input).value;
  } catch (error: unknown) {
    throw new StoreError("revision_invalid", error);
  }
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) throw new StoreError("revision_invalid");
  const { redaction: _redaction, ...record } = redacted as Record<string, unknown>;
  try {
    return memoryRecordInputSchema.parse(record);
  } catch (error: unknown) {
    throw new StoreError("revision_invalid", error);
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalTargets(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function intersect(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function sameSourceRecordContent(left: MemoryRecord, right: MemoryRecordInput): boolean {
  return left.scope_id === right.scope_id
    && left.kind === right.kind
    && left.key === right.key
    && left.summary === right.summary
    && JSON.stringify(left.next_steps) === JSON.stringify(right.next_steps);
}

function intervalIntersection(left: SummaryTemporalInterval, right: SummaryTemporalInterval): SummaryTemporalInterval | null {
  const from = left.from === null ? right.from : right.from === null ? left.from : left.from > right.from ? left.from : right.from;
  const to = left.to === null ? right.to : right.to === null ? left.to : left.to < right.to ? left.to : right.to;
  return from !== null && to !== null && from >= to ? null : { from, to };
}

function parseDomain(value: unknown): SummaryTemporalDomain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StoreError("read_failed");
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (record.version !== 1 || (status !== "definite" && status !== "unknown") || !Array.isArray(record.intervals)) throw new StoreError("read_failed");
  const intervals = record.intervals.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new StoreError("read_failed");
    const item = entry as Record<string, unknown>;
    if ((item.from !== null && typeof item.from !== "string") || (item.to !== null && typeof item.to !== "string")) throw new StoreError("read_failed");
    return { from: item.from as string | null, to: item.to as string | null };
  });
  return { version: 1, status, intervals };
}

export class DependencyRepository {
  constructor(private readonly database: DatabaseSync, private readonly ensureOpen: () => void) {}

  add(input: Omit<DependencyRecord, "version" | "created_commit_seq"> & { readonly created_commit_seq?: string }): DependencyRecord {
    this.ensureOpen();
    const parsed = this.parseInput(input);
    return this.transaction(() => {
      const current = this.database.prepare("SELECT created_commit_seq FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ? AND parent_type = ? AND parent_revision_id = ?").get(parsed.scope_id, parsed.child_type, parsed.child_revision_id, parsed.parent_type, parsed.parent_revision_id);
      if (current !== undefined) {
        if (parsed.created_commit_seq !== undefined && integer(current, "created_commit_seq").toString(10) !== parsed.created_commit_seq) throw new StoreError("revision_conflict");
        return this.read(parsed.scope_id, parsed.child_type, parsed.child_revision_id, parsed.parent_type, parsed.parent_revision_id)!;
      }
      this.insertLocked(parsed, parsed.created_commit_seq ?? this.nextCommit(parsed.scope_id).toString(10));
      return this.read(parsed.scope_id, parsed.child_type, parsed.child_revision_id, parsed.parent_type, parsed.parent_revision_id)!;
    });
  }

  listForChild(scopeId: string, childType: DependencyType, childRevisionId: string): readonly DependencyRecord[] {
    this.ensureOpen();
    uuid.parse(scopeId); dependencyType.parse(childType); uuid.parse(childRevisionId);
    return this.database.prepare("SELECT * FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ? ORDER BY parent_type, parent_revision_id").all(scopeId, childType, childRevisionId).map((row) => this.parseRow(row));
  }

  listForParent(scopeId: string, parentKind: DependencyParentType, parentRevisionId: string): readonly DependencyRecord[] {
    this.ensureOpen();
    uuid.parse(scopeId); parentType.parse(parentKind); uuid.parse(parentRevisionId);
    return this.database.prepare("SELECT * FROM dependency WHERE scope_id = ? AND parent_type = ? AND parent_revision_id = ? ORDER BY child_type, child_revision_id").all(scopeId, parentKind, parentRevisionId).map((row) => this.parseRow(row));
  }

  /** Called by a parent revision transaction; it must not start another transaction. */
  invalidateDependentsLocked(scopeId: string, changedParentType: DependencyParentType, changedParentRevisionId: string, commitSeq: string, reason = "parent_revision_changed"): void {
    this.ensureOpen();
    uuid.parse(scopeId); parentType.parse(changedParentType); uuid.parse(changedParentRevisionId); z.string().regex(/^(?:0|[1-9][0-9]*)$/).parse(commitSeq);
    this.database.prepare(
      `WITH RECURSIVE affected(child_type, child_revision_id) AS (
         SELECT child_type, child_revision_id
           FROM dependency
          WHERE scope_id = ? AND parent_type = ? AND parent_revision_id = ?
         UNION
         SELECT d.child_type, d.child_revision_id
           FROM dependency AS d
           JOIN affected AS a
             ON d.scope_id = ? AND d.parent_type = a.child_type AND d.parent_revision_id = a.child_revision_id
          WHERE d.scope_id = ?
       )
       UPDATE derived_artifact
          SET status = 'blocked', status_reason = ?, invalidated_commit_seq = ?
        WHERE scope_id = ? AND purpose = 'current' AND status = 'active'
          AND revision_id IN (SELECT child_revision_id FROM affected WHERE child_type = 'derived_artifact')`,
    ).run(scopeId, changedParentType, changedParentRevisionId, scopeId, scopeId, reason, BigInt(commitSeq), scopeId);
  }

  invalidateSourceLocked(scopeId: string, sourceSpanId: string, commitSeq: string, reason = "source_unavailable"): void {
    this.invalidateDependentsLocked(scopeId, "source_span", sourceSpanId, commitSeq, reason);
  }

  insertLocked(input: ParsedDependency, createdCommitSeq: string): void {
    this.assertNodeExists(input.scope_id, input.child_type, input.child_revision_id, true);
    this.assertNodeExists(input.scope_id, input.parent_type, input.parent_revision_id, false);
    this.assertAcyclic(input);
    this.database.prepare("INSERT INTO dependency (scope_id, child_type, child_revision_id, parent_type, parent_revision_id, relation, created_commit_seq) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.scope_id, input.child_type, input.child_revision_id, input.parent_type, input.parent_revision_id, input.relation, BigInt(createdCommitSeq));
  }

  private parseInput(input: Omit<DependencyRecord, "version" | "created_commit_seq"> & { readonly created_commit_seq?: string }): ParsedDependency {
    const scopeId = uuid.parse(input.scope_id);
    const childRevisionId = uuid.parse(input.child_revision_id);
    const parentRevisionId = uuid.parse(input.parent_revision_id);
    const created = input.created_commit_seq === undefined ? undefined : z.string().regex(/^(?:0|[1-9][0-9]*)$/).parse(input.created_commit_seq);
    return { scope_id: scopeId, child_type: dependencyType.parse(input.child_type), child_revision_id: childRevisionId, parent_type: parentType.parse(input.parent_type), parent_revision_id: parentRevisionId, relation: relation.parse(input.relation), ...(created === undefined ? {} : { created_commit_seq: created }) };
  }

  private assertNodeExists(scopeId: string, type: DependencyParentType | DependencyType, revisionId: string, child: boolean): void {
    if (type === "source_span") {
      if (child || this.database.prepare("SELECT 1 FROM source_span WHERE scope_id = ? AND span_id = ?").get(scopeId, revisionId) === undefined) throw new StoreError("revision_invalid");
      return;
    }
    const table = type === "memory_revision" ? "memory_revision" : "derived_artifact";
    if (this.database.prepare(`SELECT 1 FROM ${table} WHERE scope_id = ? AND ${type === "memory_revision" ? "revision_id" : "revision_id"} = ?`).get(scopeId, revisionId) === undefined) throw new StoreError("revision_invalid");
  }

  private assertAcyclic(input: ParsedDependency): void {
    if (input.child_type === input.parent_type && input.child_revision_id === input.parent_revision_id) throw new StoreError("revision_conflict");
    const cycle = this.database.prepare(
      `WITH RECURSIVE ancestors(node_type, node_id) AS (
         SELECT ?, ?
         UNION
         SELECT d.parent_type, d.parent_revision_id FROM dependency AS d JOIN ancestors AS x
           ON d.child_type = x.node_type AND d.child_revision_id = x.node_id
          WHERE d.scope_id = ?
       )
       SELECT 1 AS present FROM ancestors WHERE node_type = ? AND node_id = ? LIMIT 1`,
    ).get(input.parent_type, input.parent_revision_id, input.scope_id, input.child_type, input.child_revision_id);
    if (cycle !== undefined) throw new StoreError("revision_conflict");
  }

  private read(scopeId: string, childType: DependencyType, childRevisionId: string, parentKind: DependencyParentType, parentRevisionId: string): DependencyRecord | undefined {
    const row = this.database.prepare("SELECT * FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ? AND parent_type = ? AND parent_revision_id = ?").get(scopeId, childType, childRevisionId, parentKind, parentRevisionId);
    return row === undefined ? undefined : this.parseRow(row);
  }

  private parseRow(row: unknown): DependencyRecord {
    return { version: 1, scope_id: uuid.parse(text(row, "scope_id")), child_type: dependencyType.parse(text(row, "child_type")), child_revision_id: uuid.parse(text(row, "child_revision_id")), parent_type: parentType.parse(text(row, "parent_type")), parent_revision_id: uuid.parse(text(row, "parent_revision_id")), relation: relation.parse(text(row, "relation")), created_commit_seq: integer(row, "created_commit_seq").toString(10) };
  }

  private nextCommit(scopeId: string): bigint {
    const row = this.database.prepare("SELECT commit_seq FROM vault_counter WHERE id = 1").get();
    if (row === undefined) throw new StoreError("revision_write_failed");
    const current = integer(row, "commit_seq") + 1n;
    this.database.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = data_epoch + 1 WHERE id = 1").run(current);
    this.database.prepare("UPDATE scope SET data_epoch = (SELECT data_epoch FROM vault_counter WHERE id = 1) WHERE scope_id = ?").run(scopeId);
    return current;
  }

  private transaction<T>(operation: () => T): T {
    let committed = false;
    try { this.database.exec("BEGIN IMMEDIATE"); const result = operation(); this.database.exec("COMMIT"); committed = true; return result; }
    catch (error: unknown) { if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ } } if (error instanceof StoreError) throw error; throw new StoreError("revision_write_failed", error); }
  }
}

interface ParsedDependency {
  readonly scope_id: string;
  readonly child_type: DependencyType;
  readonly child_revision_id: string;
  readonly parent_type: DependencyParentType;
  readonly parent_revision_id: string;
  readonly relation: DependencyRelation;
  readonly created_commit_seq?: string;
}

export class SummaryRepository {
  readonly dependencies: DependencyRepository;

  constructor(private readonly database: DatabaseSync, private readonly ensureOpen: () => void) {
    this.dependencies = new DependencyRepository(database, ensureOpen);
  }

  create(binding: TrustedBinding, input: CreateSummaryInput): DerivedArtifactRecord {
    this.ensureOpen();
    if (!isTrustedBinding(binding)) throw new StoreError("revision_invalid");
    const parsed = this.parseInput(input);
    if (!binding.allowed_scope_ids.includes(parsed.scope_id)) throw new StoreError("scope_not_allowed");
    return this.transaction(() => {
      const evidence = this.readEvidence(parsed.scope_id, parsed.parent_revision_ids);
      const targets = this.egressIntersection(parsed.scope_id, evidence.classes);
      if (targets.length === 0) throw new StoreError("output_not_allowed");
      const temporal = this.temporalIntersection(parsed.scope_id, parsed.parent_revision_ids);
      const currentParents = this.currentParentCheck(parsed.scope_id, parsed.parent_revision_ids);
      const status: DerivedArtifactStatus = parsed.purpose === "current" && !currentParents ? "blocked" : "active";
      const statusReason = status === "blocked" ? "parent_revision_not_current" : null;
      const artifactId = parsed.artifact_id ?? randomUUID();
      const revisionId = parsed.revision_id ?? randomUUID();
      uuid.parse(artifactId); uuid.parse(revisionId);
      const commitSeq = this.nextCommit(parsed.scope_id);
      const contentDigest = hash(parsed.content);
      this.database.prepare(
        `INSERT INTO derived_artifact (artifact_id, scope_id, revision_id, kind, purpose, session_id, content_json, content_digest, temporal_domain_json, egress_targets_json, status, status_reason, created_commit_seq, invalidated_commit_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(artifactId, parsed.scope_id, revisionId, parsed.kind, parsed.purpose, parsed.session_id ?? null, JSON.stringify(parsed.content), contentDigest, JSON.stringify(temporal), JSON.stringify(targets), status, statusReason, commitSeq);
      for (const parentRevisionId of parsed.parent_revision_ids) {
        this.dependencies.insertLocked({ scope_id: parsed.scope_id, child_type: "derived_artifact", child_revision_id: revisionId, parent_type: "memory_revision", parent_revision_id: parentRevisionId, relation: "derives" }, commitSeq.toString(10));
      }
      for (const sourceSpanId of evidence.sourceSpanIds) {
        this.dependencies.insertLocked({ scope_id: parsed.scope_id, child_type: "derived_artifact", child_revision_id: revisionId, parent_type: "source_span", parent_revision_id: sourceSpanId, relation: "supports" }, commitSeq.toString(10));
      }
      return this.require(parsed.scope_id, revisionId);
    });
  }

  writeSourceRecord(binding: TrustedBinding, input: MemoryRecordInput): DerivedArtifactRecord {
    this.ensureOpen();
    if (!isTrustedBinding(binding)) throw new StoreError("revision_invalid");
    const parsed = parseSourceRecordInput(input);
    if (!binding.allowed_scope_ids.includes(parsed.scope_id)) throw new StoreError("scope_not_allowed");
    let readerTarget: string;
    try {
      readerTarget = readerOutputTarget(binding);
    } catch (error: unknown) {
      throw new StoreError("output_not_allowed", error);
    }
    return this.transaction(() => {
      let record = parsed;
      let evidence = this.readSourceRecordEvidence(record.scope_id, record.source_ids);
      let targets = this.sourceRecordEgress(record.scope_id, evidence.classes, readerTarget);
      let content: string;
      try {
        content = JSON.stringify(memoryRecordSchema.parse({ ...record, format: sourceRecordFormat, origin: sourceRecordOrigin }));
      } catch (error: unknown) {
        throw new StoreError("revision_invalid", error);
      }
      const head = this.findSourceRecordHead(parsed.scope_id, parsed.kind, parsed.key);
      if (head !== undefined) {
        if (head.status !== "active") throw new StoreError("revision_conflict");
        if (!head.egress_targets.includes(readerTarget) || !this.outputStillAllowed(parsed.scope_id, head, readerTarget)) throw new StoreError("output_not_allowed");
        if (head.content === content) {
          return head;
        }
        let headRecord: MemoryRecord;
        try {
          headRecord = memoryRecordSchema.parse(JSON.parse(head.content));
        } catch (error: unknown) {
          throw new StoreError("read_failed", error);
        }
        if (sameSourceRecordContent(headRecord, parsed)) {
          if (parsed.replaces !== undefined && parsed.replaces !== head.revision_id) throw new StoreError("revision_conflict");
          const sourceIds = [...new Set([...headRecord.source_ids, ...parsed.source_ids])];
          if (sourceIds.length > sourceRecordSourceLimit) throw new StoreError("revision_invalid");
          if (sourceIds.length === headRecord.source_ids.length) return head;
          record = { ...parsed, source_ids: sourceIds, replaces: head.revision_id };
          evidence = this.readSourceRecordEvidence(record.scope_id, record.source_ids);
          targets = this.sourceRecordEgress(record.scope_id, evidence.classes, readerTarget);
          try {
            content = JSON.stringify(memoryRecordSchema.parse({ ...record, format: sourceRecordFormat, origin: sourceRecordOrigin }));
          } catch (error: unknown) {
            throw new StoreError("revision_invalid", error);
          }
        } else if (parsed.replaces !== head.revision_id) {
          throw new StoreError("revision_conflict");
        }
      } else if (parsed.replaces !== undefined) {
        throw new StoreError("revision_conflict");
      }

      const artifactId = randomUUID();
      const revisionId = randomUUID();
      const commitSeq = this.nextCommit(parsed.scope_id);
      if (head !== undefined) {
        this.database.prepare(
          "UPDATE derived_artifact SET status = 'blocked', status_reason = 'record_superseded', invalidated_commit_seq = ? WHERE scope_id = ? AND revision_id = ?",
        ).run(commitSeq, parsed.scope_id, head.revision_id);
      }
      this.database.prepare(
        `INSERT INTO derived_artifact (artifact_id, scope_id, revision_id, kind, purpose, session_id, content_json, content_digest, temporal_domain_json, egress_targets_json, status, status_reason, created_commit_seq, invalidated_commit_seq)
         VALUES (?, ?, ?, 'search_enrichment', 'current', NULL, ?, ?, ?, ?, 'active', NULL, ?, NULL)`,
      ).run(
        artifactId,
        parsed.scope_id,
        revisionId,
        JSON.stringify(content),
        hash(content),
        JSON.stringify({ version: 1, status: "definite", intervals: [{ from: null, to: null }] }),
        JSON.stringify(targets),
        commitSeq,
      );
      for (const sourceSpanId of evidence.sourceSpanIds) {
        this.dependencies.insertLocked({
          scope_id: parsed.scope_id,
          child_type: "derived_artifact",
          child_revision_id: revisionId,
          parent_type: "source_span",
          parent_revision_id: sourceSpanId,
          relation: "supports",
        }, commitSeq.toString(10));
      }
      return this.require(parsed.scope_id, revisionId);
    });
  }

  read(binding: PolicyOutputBinding, revisionId: string, options: ReadSummaryOptions = {}): DerivedArtifactRecord | undefined {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("output_not_allowed");
    const parsedRevisionId = uuid.parse(revisionId);
    let knownAtSeq: bigint | undefined;
    let validAt: string | undefined;
    try {
      knownAtSeq = options.known_at_seq === undefined ? undefined : BigInt(commitSeqSchema.parse(options.known_at_seq));
      validAt = options.valid_at === undefined ? undefined : normalizeTemporalDateTime(validAtSchema.parse(options.valid_at));
    } catch (error: unknown) {
      throw new StoreError("read_failed", error);
    }
    if (!binding.scope_id) throw new StoreError("output_not_allowed");
    const row = this.database.prepare("SELECT * FROM derived_artifact WHERE scope_id = ? AND revision_id = ?").get(binding.scope_id, parsedRevisionId);
    if (row === undefined) return undefined;
    const record = this.parseArtifact(row);
    if (record.status === "purged") return undefined;
    if (!record.egress_targets.includes(binding.target)) return undefined;
    if (!this.outputStillAllowed(binding.scope_id, record, binding.target)) return undefined;
    if (knownAtSeq !== undefined && knownAtSeq < BigInt(record.created_commit_seq)) return undefined;
    if (record.purpose === "current" && this.hasStaleParent(record)) {
      return { ...record, status: "blocked", status_reason: record.status_reason ?? "parent_revision_not_current" };
    }
    if (record.purpose === "current") {
      const temporalReason = this.currentTemporalBlock(record, validAt);
      if (temporalReason !== null) return { ...record, status: "blocked", status_reason: temporalReason };
    }
    return record;
  }

  listSourceRecords(
    binding: PolicyOutputBinding,
    options: {
      readonly known_at_seq?: string;
      readonly limit?: number;
      readonly include_history?: boolean;
      readonly query_terms?: readonly string[];
      readonly source_ids?: readonly string[];
    } = {},
  ): readonly DerivedArtifactRecord[] {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("output_not_allowed");
    const limit = options.limit ?? sourceRecordLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > sourceRecordLimit) throw new StoreError("read_failed");
    let knownAtSeq: bigint | undefined;
    try {
      knownAtSeq = options.known_at_seq === undefined ? undefined : BigInt(commitSeqSchema.parse(options.known_at_seq));
    } catch (error: unknown) {
      throw new StoreError("read_failed", error);
    }
    const includeHistory = options.include_history ?? false;
    if (typeof includeHistory !== "boolean") throw new StoreError("read_failed");
    const knownAtClause = knownAtSeq === undefined ? "" : " AND a.created_commit_seq <= ?";
    const statusClause = includeHistory ? "a.status <> 'purged'" : "a.status = 'active'";
    const sourcePayloadSql = sourceRecordPayloadSql.replaceAll("content_json", "a.content_json");
    const queryTerms = this.sourceRecordQueryTerms(options.query_terms);
    const sourceIds = this.sourceRecordQuerySourceIds(options.source_ids);
    const recordText = `coalesce(json_extract(${sourcePayloadSql}, '$.kind'), '') || ' ' || coalesce(json_extract(${sourcePayloadSql}, '$.key'), '') || ' ' || coalesce(json_extract(${sourcePayloadSql}, '$.summary'), '') || ' ' || coalesce(json_extract(${sourcePayloadSql}, '$.next_steps'), '')`;
    const recordTextSql = foldGermanSql(recordText);
    const relevanceParts: string[] = [];
    const relevanceParameters: string[] = [];
    if (queryTerms.length > 0) {
      relevanceParts.push(`(${queryTerms.map(() => `instr(${recordTextSql}, ?) > 0`).join(" OR ")})`);
      relevanceParameters.push(...queryTerms);
    }
    if (sourceIds.length > 0) {
      relevanceParts.push(`EXISTS (SELECT 1 FROM json_each(json_extract(${sourcePayloadSql}, '$.source_ids')) AS cited_source WHERE cited_source.value IN (${sourceIds.map(() => "?").join(",")}))`);
      relevanceParameters.push(...sourceIds);
    }
    const relevanceClause = relevanceParts.length === 0 ? "" : ` AND (${relevanceParts.join(" OR ")})`;
    const parameters: Array<string | number | bigint> = [binding.scope_id, sourceRecordFormat, binding.target, binding.target, binding.target, ...relevanceParameters];
    if (knownAtSeq !== undefined) parameters.push(knownAtSeq);
    parameters.push(limit);
    const rows = this.database.prepare(
      `SELECT revision_id
         FROM derived_artifact AS a
        WHERE a.scope_id = ?
          AND a.kind = 'search_enrichment'
          AND a.purpose = 'current'
          AND ${statusClause}
          AND json_valid(a.content_json)
          AND json_type(${sourcePayloadSql}) = 'object'
          AND json_extract(${sourcePayloadSql}, '$.format') = ?
          AND EXISTS (
            SELECT 1 FROM json_each(a.egress_targets_json) AS egress
             WHERE egress.value = ?
          )
          AND EXISTS (
            SELECT 1 FROM scope_output_grant AS assistant_grant
             WHERE assistant_grant.scope_id = a.scope_id
               AND assistant_grant.output_target = ?
               AND assistant_grant.source_class = 'assistant_output'
          )
          AND EXISTS (
            SELECT 1 FROM dependency AS cited
             WHERE cited.scope_id = a.scope_id
               AND cited.child_type = 'derived_artifact'
               AND cited.child_revision_id = a.revision_id
               AND cited.parent_type = 'source_span'
          )
          AND NOT EXISTS (
            SELECT 1 FROM dependency AS cited
             WHERE cited.scope_id = a.scope_id
               AND cited.child_type = 'derived_artifact'
               AND cited.child_revision_id = a.revision_id
               AND cited.parent_type = 'source_span'
               AND NOT EXISTS (
                 SELECT 1
                   FROM source_span AS ss
                   JOIN source_event AS e
                     ON e.scope_id = ss.scope_id AND e.capture_id = ss.source_id
                   JOIN scope_output_grant AS source_grant
                     ON source_grant.scope_id = e.scope_id
                    AND source_grant.source_class = e.evidence_class
                  WHERE ss.scope_id = cited.scope_id
                    AND ss.span_id = cited.parent_revision_id
                    AND source_grant.output_target = ?
                    AND NOT EXISTS (
                      SELECT 1 FROM purge_tombstone AS t
                       WHERE t.scope_id = ss.scope_id AND t.capture_id = ss.source_id
                    )
               )
          )${relevanceClause}${knownAtClause}
        ORDER BY a.created_commit_seq DESC, a.revision_id DESC
        LIMIT ?`,
    ).all(...parameters);
    const records: DerivedArtifactRecord[] = [];
    for (const row of rows) {
      const record = this.read(binding, text(row, "revision_id"), options.known_at_seq === undefined ? {} : { known_at_seq: options.known_at_seq });
      if (record === undefined || !isSourceRecordContent(record.content)) continue;
      if (!includeHistory && record.status !== "active") continue;
      records.push(record);
    }
    return records;
  }

  list(binding: PolicyOutputBinding, purposeFilter?: SummaryPurpose, options: ReadSummaryOptions = {}): readonly DerivedArtifactRecord[] {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("output_not_allowed");
    const rows = this.database.prepare("SELECT * FROM derived_artifact WHERE scope_id = ? AND (? IS NULL OR purpose = ?) ORDER BY created_commit_seq DESC, revision_id").all(binding.scope_id, purposeFilter ?? null, purposeFilter ?? null);
    return rows.map((row) => this.read(binding, text(row, "revision_id"), options)).filter((value): value is DerivedArtifactRecord => value !== undefined);
  }

  invalidateForRevisionLocked(scopeId: string, revisionId: string, commitSeq: string): void {
    this.dependencies.invalidateDependentsLocked(scopeId, "memory_revision", revisionId, commitSeq, "parent_revision_not_current");
  }

  invalidateForSourceLocked(scopeId: string, sourceSpanId: string, commitSeq: string): void {
    this.dependencies.invalidateSourceLocked(scopeId, sourceSpanId, commitSeq);
  }

  private parseInput(input: CreateSummaryInput): Required<Pick<CreateSummaryInput, "scope_id" | "purpose" | "content" | "parent_revision_ids">> & { readonly artifact_id?: string; readonly revision_id?: string; readonly kind: DerivedArtifactKind; readonly session_id?: string } {
    const scopeId = uuid.parse(input.scope_id);
    const parents = input.parent_revision_ids.map((value) => uuid.parse(value));
    if (parents.length === 0 || parents.length > 128 || new Set(parents).size !== parents.length) throw new StoreError("revision_invalid");
    if (typeof input.content !== "string" || input.content.trim().length === 0 || input.content.length > 1_000_000) throw new StoreError("revision_invalid");
    if (input.purpose === "historical" && input.session_id === undefined) throw new StoreError("revision_invalid");
    return { scope_id: scopeId, purpose: purpose.parse(input.purpose), content: input.content, parent_revision_ids: parents, kind: artifactKind.parse(input.kind ?? "summary"), ...(input.artifact_id === undefined ? {} : { artifact_id: uuid.parse(input.artifact_id) }), ...(input.revision_id === undefined ? {} : { revision_id: uuid.parse(input.revision_id) }), ...(input.session_id === undefined ? {} : { session_id: input.session_id }) };
  }

  private readEvidence(scopeId: string, revisionIds: readonly string[]): { readonly sourceSpanIds: readonly string[]; readonly classes: readonly string[] } {
    const placeholders = revisionIds.map(() => "?").join(",");
    const rows = this.database.prepare(
      `SELECT DISTINCT rs.source_span_id, e.evidence_class
         FROM revision_source AS rs
         JOIN source_span AS ss ON ss.scope_id = rs.scope_id AND ss.span_id = rs.source_span_id
         JOIN source_event AS e ON e.scope_id = ss.scope_id AND e.capture_id = ss.source_id
        WHERE rs.scope_id = ? AND rs.revision_id IN (${placeholders})`,
    ).all(scopeId, ...revisionIds);
    if (rows.length === 0) throw new StoreError("revision_invalid");
    const sourceSpanIds = rows.map((row) => uuid.parse(text(row, "source_span_id"))).sort();
    const classes = [...new Set(rows.map((row) => text(row, "evidence_class")))].sort();
    const count = this.database.prepare(`SELECT COUNT(DISTINCT revision_id) AS count FROM revision_source WHERE scope_id = ? AND revision_id IN (${placeholders})`).get(scopeId, ...revisionIds);
    if (integer(count, "count") !== BigInt(revisionIds.length)) throw new StoreError("revision_invalid");
    return { sourceSpanIds, classes };
  }

  private egressIntersection(scopeId: string, classes: readonly string[]): readonly string[] {
    let targets: string[] | undefined;
    for (const sourceClass of classes) {
      const rows = this.database.prepare("SELECT output_target FROM scope_output_grant WHERE scope_id = ? AND source_class = ? ORDER BY output_target").all(scopeId, sourceClass);
      const current = rows.map((row) => text(row, "output_target"));
      targets = targets === undefined ? current : intersect(targets, current);
    }
    return canonicalTargets(targets ?? []);
  }

  private temporalIntersection(scopeId: string, revisionIds: readonly string[]): SummaryTemporalDomain {
    let intervals: SummaryTemporalInterval[] | undefined;
    let unknown = false;
    for (const revisionId of revisionIds) {
      const rows = this.database.prepare("SELECT valid_from, valid_to, status FROM state_segment WHERE scope_id = ? AND value_revision_id = ? ORDER BY valid_from, valid_to, segment_id").all(scopeId, revisionId);
      const current = rows.filter((row) => text(row, "status") !== "gap").map((row) => ({ from: nullableText(row, "valid_from"), to: nullableText(row, "valid_to") }));
      if (current.length === 0) { unknown = true; continue; }
      intervals = intervals === undefined ? current : intervals.flatMap((left) => current.flatMap((right) => { const value = intervalIntersection(left, right); return value === null ? [] : [value]; }));
    }
    return { version: 1, status: unknown || intervals === undefined ? "unknown" : "definite", intervals: intervals ?? [] };
  }

  private currentParentCheck(scopeId: string, revisionIds: readonly string[]): boolean {
    const placeholders = revisionIds.map(() => "?").join(",");
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM memory_revision AS r JOIN memory_item AS i ON i.scope_id = r.scope_id AND i.item_id = r.item_id AND i.current_revision_id = r.revision_id WHERE r.scope_id = ? AND r.revision_id IN (${placeholders})`).get(scopeId, ...revisionIds);
    return integer(row, "count") === BigInt(revisionIds.length);
  }

  /** Plan §6: an unclear domain yields no unique current assertion, and a
   *  definite domain is checked against valid_at on every read. */
  private currentTemporalBlock(record: DerivedArtifactRecord, validAt: string | undefined): string | null {
    const domain = record.temporal_domain;
    if (domain.status === "unknown") return "temporal_domain_unknown";
    if (domain.intervals.length === 0) return "outside_temporal_domain";
    if (validAt === undefined) return null;
    const inside = domain.intervals.some((interval) => (interval.from === null || interval.from <= validAt) && (interval.to === null || validAt < interval.to));
    return inside ? null : "outside_temporal_domain";
  }

  private hasStaleParent(record: DerivedArtifactRecord): boolean {
    return record.dependencies.some((dependency) => dependency.parent_type === "memory_revision" && this.database.prepare("SELECT 1 FROM memory_revision AS r JOIN memory_item AS i ON i.scope_id = r.scope_id AND i.item_id = r.item_id AND i.current_revision_id = r.revision_id WHERE r.scope_id = ? AND r.revision_id = ?").get(record.scope_id, dependency.parent_revision_id) === undefined);
  }

  private findSourceRecordHead(scopeId: string, kind: MemoryRecord["kind"], key: string): DerivedArtifactRecord | undefined {
    const row = this.database.prepare(
      `SELECT *
         FROM derived_artifact
        WHERE scope_id = ?
          AND kind = 'search_enrichment'
          AND purpose = 'current'
          AND json_valid(content_json)
          AND json_type(${sourceRecordPayloadSql}) = 'object'
          AND json_extract(${sourceRecordPayloadSql}, '$.format') = ?
          AND json_extract(${sourceRecordPayloadSql}, '$.kind') = ?
          AND json_extract(${sourceRecordPayloadSql}, '$.key') = ?
        ORDER BY created_commit_seq DESC, revision_id DESC
        LIMIT 1`,
    ).get(scopeId, sourceRecordFormat, kind, key);
    return row === undefined ? undefined : this.parseArtifact(row);
  }

  private readSourceRecordEvidence(scopeId: string, sourceIds: readonly string[]): { readonly sourceSpanIds: readonly string[]; readonly classes: readonly string[] } {
    const placeholders = sourceIds.map(() => "?").join(",");
    const sources = this.database.prepare(
      `SELECT e.capture_id, e.scope_id, e.evidence_class, t.capture_id AS tombstone_capture_id
         FROM source_event AS e
         LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
        WHERE e.capture_id IN (${placeholders})`,
    ).all(...sourceIds);
    if (sources.length !== sourceIds.length) throw new StoreError("revision_invalid");
    const classes: string[] = [];
    for (const row of sources) {
      if (text(row, "scope_id") !== scopeId) throw new StoreError("scope_not_allowed");
      if (rowValue(row, "tombstone_capture_id") !== null) throw new StoreError("revision_invalid");
      classes.push(text(row, "evidence_class"));
    }
    const spans = this.database.prepare(
      `SELECT source_id, span_id
         FROM source_span
        WHERE scope_id = ? AND source_id IN (${placeholders})
        ORDER BY source_id, span_id`,
    ).all(scopeId, ...sourceIds);
    const firstSpanBySource = new Map<string, string>();
    for (const row of spans) {
      const sourceId = text(row, "source_id");
      if (!firstSpanBySource.has(sourceId)) firstSpanBySource.set(sourceId, uuid.parse(text(row, "span_id")));
    }
    if (firstSpanBySource.size !== sourceIds.length) throw new StoreError("revision_invalid");
    return { sourceSpanIds: sourceIds.map((sourceId) => firstSpanBySource.get(sourceId)!), classes };
  }

  private sourceRecordEgress(scopeId: string, classes: readonly string[], readerTarget: string): readonly string[] {
    const requiredClasses = [...new Set([...classes, "assistant_output"])]
      .sort((left, right) => left.localeCompare(right));
    const placeholders = requiredClasses.map(() => "?").join(",");
    const rows = this.database.prepare(
      `SELECT source_class
         FROM scope_output_grant
        WHERE scope_id = ? AND output_target = ? AND source_class IN (${placeholders})`,
    ).all(scopeId, readerTarget, ...requiredClasses);
    if (rows.length !== requiredClasses.length) throw new StoreError("output_not_allowed");
    return [readerTarget];
  }

  private sourceRecordQueryTerms(values: readonly string[] | undefined): readonly string[] {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 32) throw new StoreError("read_failed");
    const terms = values.map((value) => {
      if (typeof value !== "string") throw new StoreError("read_failed");
      const term = value.trim();
      if (term.length === 0 || term.length > 120) throw new StoreError("read_failed");
      return foldGerman(term);
    });
    return [...new Set(terms)];
  }

  private sourceRecordQuerySourceIds(values: readonly string[] | undefined): readonly string[] {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 128) throw new StoreError("read_failed");
    try {
      return [...new Set(values.map((value) => uuid.parse(value)))];
    } catch (error: unknown) {
      throw new StoreError("read_failed", error);
    }
  }

  private outputStillAllowed(scopeId: string, record: DerivedArtifactRecord, target: string): boolean {
    const sourceDeps = record.dependencies.filter((dependency) => dependency.parent_type === "source_span");
    if (sourceDeps.length === 0) return false;
    if (isSourceRecordContent(record.content) && this.database.prepare(
      "SELECT 1 FROM scope_output_grant WHERE scope_id = ? AND output_target = ? AND source_class = 'assistant_output'",
    ).get(scopeId, target) === undefined) return false;
    for (const source of sourceDeps) {
      const row = this.database.prepare(
        `SELECT 1 FROM source_span AS ss JOIN source_event AS e ON e.scope_id = ss.scope_id AND e.capture_id = ss.source_id
          JOIN scope_output_grant AS g ON g.scope_id = e.scope_id AND g.source_class = e.evidence_class AND g.output_target = ?
         WHERE ss.scope_id = ? AND ss.span_id = ? AND NOT EXISTS (SELECT 1 FROM purge_tombstone AS t WHERE t.scope_id = ss.scope_id AND t.capture_id = ss.source_id)`,
      ).get(target, scopeId, source.parent_revision_id);
      if (row === undefined) return false;
    }
    return true;
  }

  private parseArtifact(row: unknown): DerivedArtifactRecord {
    const contentJson = text(row, "content_json");
    let content: unknown;
    try { content = JSON.parse(contentJson); } catch (error: unknown) { throw new StoreError("read_failed", error); }
    if (typeof content !== "string" || hash(content) !== text(row, "content_digest")) throw new StoreError("read_failed");
    const targets = parseJson<unknown>(row, "egress_targets_json");
    if (!Array.isArray(targets) || targets.some((value) => typeof value !== "string")) throw new StoreError("read_failed");
    const parsedPurpose = purpose.parse(text(row, "purpose"));
    const dependencies = this.dependencies.listForChild(text(row, "scope_id"), "derived_artifact", text(row, "revision_id"));
    const invalidatedValue = rowValue(row, "invalidated_commit_seq");
    if (invalidatedValue !== null && typeof invalidatedValue !== "bigint" && !(typeof invalidatedValue === "number" && Number.isSafeInteger(invalidatedValue))) throw new StoreError("read_failed");
    return { version: 1, artifact_id: uuid.parse(text(row, "artifact_id")), scope_id: uuid.parse(text(row, "scope_id")), revision_id: uuid.parse(text(row, "revision_id")), kind: artifactKind.parse(text(row, "kind")), purpose: parsedPurpose, context_label: contextLabel(parsedPurpose), session_id: nullableText(row, "session_id"), content, content_digest: text(row, "content_digest"), temporal_domain: parseDomain(parseJson(row, "temporal_domain_json")), egress_targets: canonicalTargets(targets), status: artifactStatus.parse(text(row, "status")), status_reason: nullableText(row, "status_reason"), created_commit_seq: integer(row, "created_commit_seq").toString(10), invalidated_commit_seq: invalidatedValue === null ? null : (typeof invalidatedValue === "bigint" ? invalidatedValue : BigInt(invalidatedValue)).toString(10), dependencies };
  }

  private require(scopeId: string, revisionId: string): DerivedArtifactRecord {
    const row = this.database.prepare("SELECT * FROM derived_artifact WHERE scope_id = ? AND revision_id = ?").get(scopeId, revisionId);
    if (row === undefined) throw new StoreError("read_failed");
    return this.parseArtifact(row);
  }

  private nextCommit(scopeId: string): bigint {
    const row = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
    if (row === undefined) throw new StoreError("revision_write_failed");
    const currentCommit = integer(row, "commit_seq");
    const currentEpoch = integer(row, "data_epoch");
    const nextCommit = currentCommit + 1n;
    this.database.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1 AND commit_seq = ? AND data_epoch = ?").run(nextCommit, currentEpoch + 1n, currentCommit, currentEpoch);
    this.database.prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?").run(currentEpoch + 1n, scopeId);
    return nextCommit;
  }

  private transaction<T>(operation: () => T): T {
    let committed = false;
    try { this.database.exec("BEGIN IMMEDIATE"); const result = operation(); this.database.exec("COMMIT"); committed = true; return result; }
    catch (error: unknown) { if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve original */ } } if (error instanceof StoreError) throw error; throw new StoreError("revision_write_failed", error); }
  }
}
