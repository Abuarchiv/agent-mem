import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import { resolveTextAtPath, validateSpanExcerpt } from "../core/capture.js";
import { isTrustedBinding, validateBoundedJson } from "../host/contract.js";
import { isPolicyOutputBinding, isPolicySetupBinding } from "../core/policy.js";
import { type TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase, TransferImportPlan, TransferImportDbResult } from "../store/database.js";
import { StoreError } from "../store/errors.js";
import {
  TRANSFER_MAX_BYTES,
  TRANSFER_MAX_LINE_BYTES,
  TRANSFER_MAX_RECORDS,
  TRANSFER_TARGET,
  transferManifestSchema,
  transferRecordSchema,
  validateTransferRecords,
  type TransferCounts,
  type TransferManifest,
  type TransferRecord,
  type TransferExportPolicy,
} from "./export.js";

export type TransferImportPolicy = TransferExportPolicy;
export type TransferInput = string | Uint8Array;

export interface TransferImportOptions {
  readonly scope_map: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  readonly policy_binding: TransferImportPolicy;
  readonly mode?: "dry-run" | "commit";
}

export interface TransferImportReport {
  readonly mode: "dry-run" | "commit";
  readonly export_id: string;
  readonly file_sha256: string;
  readonly records_sha256: string;
  readonly scope_map: readonly { readonly original_scope_id: string; readonly target_scope_id: string }[];
  readonly counts: TransferCounts;
  readonly conflicts: readonly string[];
  readonly inserted: number;
  readonly duplicates: number;
  readonly downgraded: number;
  readonly dependency_count: number;
  readonly no_op: boolean;
}

interface ParsedTransfer {
  readonly bytes: Uint8Array;
  readonly manifest: TransferManifest;
  readonly records: readonly TransferRecord[];
  readonly body: string;
}

const ORIGIN_SURFACE: Readonly<Record<string, readonly string[]>> = {
  codex: ["codex_cli", "codex_desktop"],
  claude_code: ["claude_code_cli"],
  opencode: ["opencode_cli"],
  copilot: ["copilot_cli", "copilot_vscode_agent"],
};
const JSON_BOUNDS = { max_depth: 32, max_bytes: 4_000_000, max_nodes: 25_000 } as const;

function fail(cause?: unknown): never {
  throw new StoreError("transfer_invalid", cause);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  fail();
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function scanJsonNoDuplicateKeys(input: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(input[index] ?? "")) index += 1; };
  const string = (): void => {
    if (input[index] !== '"') throw new Error("json_string");
    const start = index;
    index += 1;
    while (index < input.length) {
      const character = input[index];
      if (character === "\\") { index += 2; continue; }
      if (character === '"') { index += 1; JSON.parse(input.slice(start, index)); return; }
      if ((character?.charCodeAt(0) ?? 0) < 0x20) throw new Error("json_control");
      index += 1;
    }
    throw new Error("json_string");
  };
  const value = (): void => {
    whitespace();
    const character = input[index];
    if (character === '"') { string(); return; }
    if (character === "{") {
      index += 1;
      const keys = new Set<string>();
      whitespace();
      if (input[index] === "}") { index += 1; return; }
      for (;;) {
        whitespace();
        const keyStart = index;
        string();
        const key = JSON.parse(input.slice(keyStart, index)) as unknown;
        if (typeof key !== "string" || keys.has(key)) throw new Error("json_duplicate_key");
        keys.add(key);
        whitespace();
        if (input[index] !== ":") throw new Error("json_colon");
        index += 1;
        value();
        whitespace();
        if (input[index] === "}") { index += 1; return; }
        if (input[index] !== ",") throw new Error("json_comma");
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (input[index] === "]") { index += 1; return; }
      for (;;) {
        value();
        whitespace();
        if (input[index] === "]") { index += 1; return; }
        if (input[index] !== ",") throw new Error("json_comma");
        index += 1;
      }
    }
    const literal = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/uy;
    literal.lastIndex = index;
    const match = literal.exec(input);
    if (match === null) throw new Error("json_value");
    index += match[0].length;
  };
  try {
    value();
    whitespace();
    if (index !== input.length) throw new Error("json_trailing");
  } catch (error: unknown) {
    throw new StoreError("transfer_invalid", error);
  }
}

function parseLine(line: string): unknown {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") + 1 > TRANSFER_MAX_LINE_BYTES) fail();
  scanJsonNoDuplicateKeys(line);
  try { return JSON.parse(line) as unknown; } catch (error: unknown) { fail(error); }
}

function countRecords(records: readonly TransferRecord[]): TransferCounts {
  const result: TransferCounts = { scope: 0, source: 0, entity: 0, item: 0, revision: 0, revision_source: 0, derived_artifact: 0, dependency: 0 };
  for (const record of records) result[record.kind] += 1;
  return result;
}

export function parseTransferJsonl(input: Uint8Array): ParsedTransfer {
  if (!(input instanceof Uint8Array) || input.byteLength < 2 || input.byteLength > TRANSFER_MAX_BYTES) fail();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch (error: unknown) { fail(error); }
  if (text.startsWith("\uFEFF") || text.includes("\r")) fail();
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 1) fail();
  const manifest = transferManifestSchema.safeParse(parseLine(text.slice(0, firstLineEnd)));
  if (!manifest.success) fail();
  const body = text.slice(firstLineEnd + 1);
  if (body.length > 0 && !body.endsWith("\n")) fail();
  const lines = body.length === 0 ? [] : body.slice(0, -1).split("\n");
  if (lines.length > TRANSFER_MAX_RECORDS || lines.some((line) => line.length === 0)) fail();
  const records = lines.map((line) => {
    const parsed = transferRecordSchema.safeParse(parseLine(line));
    if (!parsed.success) fail();
    return parsed.data;
  });
  const bodyBytes = Buffer.from(body, "utf8");
  if (sha256(bodyBytes) !== manifest.data.records_sha256) fail();
  if (JSON.stringify(countRecords(records)) !== JSON.stringify(manifest.data.counts)) fail();
  return { bytes: input.slice(), manifest: manifest.data, records, body };
}

function validateClosure(parsed: ParsedTransfer): void {
  validateTransferRecords(parsed.records);
  for (const source of parsed.records) {
    if (source.kind !== "source") continue;
    if (source.observed_stage !== source.event.stage || source.role !== source.event.role || source.evidence_class !== source.event.evidence_class) fail();
    const surfaces = ORIGIN_SURFACE[source.origin.host_kind];
    if (surfaces === undefined || !surfaces.includes(source.origin.surface)) fail();
    try { validateBoundedJson(source.payload, JSON_BOUNDS, "transfer-source-payload"); validateBoundedJson(source.event, JSON_BOUNDS, "transfer-source-event"); } catch (error: unknown) { fail(error); }
  }
}

function scopeMapEntries(input: Readonly<Record<string, string>> | ReadonlyMap<string, string>): readonly { readonly original_scope_id: string; readonly target_scope_id: string }[] {
  const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
  if (entries.length < 1 || entries.some(([source, target]) => !z.uuid().safeParse(source).success || !z.uuid().safeParse(target).success) || new Set(entries.map(([source]) => source)).size !== entries.length || new Set(entries.map(([, target]) => target)).size !== entries.length) fail();
  return entries.map(([original_scope_id, target_scope_id]) => ({ original_scope_id, target_scope_id })).sort((left, right) => left.original_scope_id.localeCompare(right.original_scope_id));
}

function targetScope(mapping: ReadonlyMap<string, string>, scopeId: string): string {
  const target = mapping.get(scopeId);
  if (target === undefined) fail();
  return target;
}

function buildPlan(parsed: ParsedTransfer, mappings: readonly { readonly original_scope_id: string; readonly target_scope_id: string }[]): TransferImportPlan {
  const map = new Map(mappings.map((entry) => [entry.original_scope_id, entry.target_scope_id]));
  const scopes = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "scope" }> => record.kind === "scope");
  if (scopes.length !== mappings.length || scopes.some((scope) => !map.has(scope.scope_id))) fail();
  const sourceRecords = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "source" }> => record.kind === "source");
  const rawItems = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "item" }> => record.kind === "item");
  const rawRevisions = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "revision" }> => record.kind === "revision");
  const rawRevisionSources = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "revision_source" }> => record.kind === "revision_source");
  const sources = sourceRecords.map((source) => {
    const { transfer_provenance: provenance, ...eventWithoutTransfer } = source.event;
    const originalEvent = provenance?.original_event ?? eventWithoutTransfer;
    const prefix = "/transfer_provenance/original_event";
    const spans = source.spans.map((span) => {
      const path = span.root === "event" && !(provenance?.original_event !== undefined && span.path.startsWith(prefix + "/")) ? prefix + span.path : span.path;
      // Validate the stored address during dry-run, before the transaction writes.
      const root = span.root === "event" ? { transfer_provenance: { original_event: originalEvent } } : source.payload;
      try { validateSpanExcerpt(resolveTextAtPath(root, path), span.start_utf16, span.end_utf16, span.digest); } catch (error: unknown) { fail(error); }
      return { ...span, path, scope_id: targetScope(map, span.scope_id) };
    });
    return ({
    ...(() => {
      const provenance = source.event.transfer_provenance;
      return {
        original_stage: provenance?.original_stage ?? source.observed_stage,
        original_role: provenance?.original_role ?? source.role,
        original_evidence_class: provenance?.original_evidence_class ?? source.evidence_class,
        original_origin_json: canonicalJson(provenance?.original_origin ?? source.origin),
      };
    })(),
    capture_id: source.capture_id,
    original_scope_id: source.scope_id,
    target_scope_id: targetScope(map, source.scope_id),
    fingerprint: source.fingerprint,
    adapter_version: source.adapter_version,
    captured_at: source.captured_at,
    occurred_at: source.occurred_at,
    payload_json: canonicalJson(source.payload),
    event_json: canonicalJson(normalizeImportedEvent()),
    original_event_json: canonicalJson(originalEvent),
    truncation_json: canonicalJson(source.truncation),
    redaction_json: canonicalJson(source.redaction),
    coverage_json: canonicalJson({ status: "partial", stages: ["message_part"], truncated: false }),
    revision_claims_json: canonicalJson(rawRevisions.filter((revision) => rawRevisionSources.some((link) => link.revision_id === revision.revision_id && link.source_capture_id === source.capture_id)).map((revision) => ({ revision_id: revision.revision_id, item_id: revision.item_id, claimed_status: rawItems.find((item) => item.scope_id === revision.scope_id && item.item_id === revision.item_id)?.claimed_status ?? "candidate", actor: revision.actor }))),
    spans,
  });
  });
  const entities = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "entity" }> => record.kind === "entity").map((entity) => ({ original_scope_id: entity.scope_id, target_scope_id: targetScope(map, entity.scope_id), entity_id: entity.entity_id, label: entity.label }));
  const items = rawItems.map((item) => ({ original_scope_id: item.scope_id, target_scope_id: targetScope(map, item.scope_id), item_id: item.item_id, kind: item.memory_kind, entity_id: item.entity_id, predicate: item.predicate, qualifiers_json: canonicalJson(item.qualifiers), qualifiers_digest: item.qualifiers_digest, cardinality: item.cardinality, claimed_status: item.claimed_status, current_revision_id: item.current_revision_id, created_commit_seq: item.created_commit_seq }));
  const revisions = rawRevisions.map((revision) => ({ original_scope_id: revision.scope_id, target_scope_id: targetScope(map, revision.scope_id), revision_id: revision.revision_id, item_id: revision.item_id, parent_revision_id: revision.parent_revision_id, operation: revision.operation, content_json: canonicalJson(revision.content), content_digest: revision.content_digest, meaning_json: revision.meaning === null ? null : canonicalJson(revision.meaning), claimed_actor_json: canonicalJson(revision.actor), created_commit_seq: revision.created_commit_seq }));
  const revisionSources = rawRevisionSources.map((source) => ({ original_scope_id: source.scope_id, target_scope_id: targetScope(map, source.scope_id), revision_id: source.revision_id, source_capture_id: source.source_capture_id, source_span_id: source.source_span_id }));
  const derived = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "derived_artifact" }> => record.kind === "derived_artifact").map((artifact) => ({ original_scope_id: artifact.scope_id, target_scope_id: targetScope(map, artifact.scope_id), artifact_id: artifact.artifact_id, revision_id: artifact.revision_id, kind: artifact.artifact_kind, content_json: canonicalJson(artifact.content), content_digest: artifact.content_digest, temporal_domain_json: canonicalJson({ version: 1, status: "unknown", intervals: [] }), claimed_status: artifact.claimed_status, created_commit_seq: artifact.created_commit_seq }));
  const dependencies = parsed.records.filter((record): record is Extract<TransferRecord, { kind: "dependency" }> => record.kind === "dependency").map((dependency) => ({ original_scope_id: dependency.scope_id, target_scope_id: targetScope(map, dependency.scope_id), child_type: dependency.child_type, child_revision_id: dependency.child_revision_id, parent_type: dependency.parent_type, parent_revision_id: dependency.parent_revision_id, relation: dependency.relation, created_commit_seq: dependency.created_commit_seq }));
  return { export_id: parsed.manifest.export_id, records_sha256: parsed.manifest.records_sha256, source_bytes_sha256: sha256(parsed.bytes), scopes: scopes.map((scope) => ({ scope_id: scope.scope_id, kind: scope.scope_kind })), scope_map: mappings, sources, entities, items, revisions, revisionSources, derived, dependencies };
}

function normalizeImportedEvent(): Record<string, unknown> {
  return { stage: "message_part", role: "assistant", evidence_class: "assistant_output", native_ids: {} };
}

function readInput(input: TransferInput): { readonly bytes: Uint8Array; readonly path?: string } {
  if (input instanceof Uint8Array) {
    if (input.byteLength > TRANSFER_MAX_BYTES) fail();
    return { bytes: input.slice() };
  }
  if (typeof input !== "string" || input.length < 1 || input.length > 4_096) fail();
  const requested = resolve(input);
  let descriptor: number | undefined;
  try {
    const parent = dirname(requested);
    const before = lstatSync(requested);
    if (!before.isFile() || before.isSymbolicLink() || lstatSync(parent).isSymbolicLink()) fail();
    const path = resolve(realpathSync(parent), requested.slice(parent.length + 1));
    // NOFOLLOW rejects a symlink swap; NONBLOCK prevents a FIFO swap from hanging
    // open before fstat can reject it. All reads use this one pinned descriptor.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size > TRANSFER_MAX_BYTES) fail();
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail();
    return { bytes: bytes.subarray(0, offset), path };
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    return fail(error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function authorizePolicy(policy: TransferImportPolicy): void {
  if (isPolicySetupBinding(policy)) {
    if (!policy.allowed_output_targets.includes(TRANSFER_TARGET)) throw new StoreError("output_not_allowed");
    return;
  }
  if (!isPolicyOutputBinding(policy) || policy.target !== TRANSFER_TARGET) throw new StoreError("output_not_allowed");
}

function report(mode: "dry-run" | "commit", plan: TransferImportPlan, result: TransferImportDbResult): TransferImportReport {
  return { mode, export_id: plan.export_id, file_sha256: plan.source_bytes_sha256, records_sha256: plan.records_sha256, scope_map: plan.scope_map, counts: { scope: plan.scopes.length, source: plan.sources.length, entity: plan.entities.length, item: plan.items.length, revision: plan.revisions.length, revision_source: plan.revisionSources.length, derived_artifact: plan.derived.length, dependency: plan.dependencies.length }, conflicts: result.conflicts, inserted: result.inserted, duplicates: result.duplicates, downgraded: result.downgraded, dependency_count: result.dependency_count, no_op: result.no_op };
}

export function importTransfer(database: AgentMemoryDatabase, binding: TrustedBinding, input: TransferInput, options: TransferImportOptions): TransferImportReport {
  if (!isTrustedBinding(binding)) throw new StoreError("scope_not_allowed");
  authorizePolicy(options.policy_binding);
  const initial = readInput(input);
  const parsed = parseTransferJsonl(initial.bytes);
  validateClosure(parsed);
  const mappings = scopeMapEntries(options.scope_map);
  const plan = buildPlan(parsed, mappings);
  const mode = options.mode ?? "commit";
  const recheck = mode === "commit" ? () => {
    const current = initial.path === undefined ? initial.bytes : readInput(initial.path).bytes;
    if (sha256(current) !== plan.source_bytes_sha256 || current.length !== initial.bytes.length || !Buffer.from(current).equals(Buffer.from(initial.bytes))) throw new StoreError("transfer_conflict");
  } : undefined;
  const result = database.commitTransferImport(binding, options.policy_binding, plan, mode === "commit", recheck);
  return report(mode, plan, result);
}

export function dryRunImport(database: AgentMemoryDatabase, binding: TrustedBinding, input: TransferInput, options: Omit<TransferImportOptions, "mode">): TransferImportReport {
  return importTransfer(database, binding, input, { ...options, mode: "dry-run" });
}

export const importJsonl = importTransfer;
