import { createHash, randomUUID } from "node:crypto";
import {
  backup as sqliteBackup,
  DatabaseSync,
  type SQLInputValue,
} from "node:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { removeOwnedPath } from "../runtime/owned-path.js";
import { createPolicySetupBinding } from "../core/policy.js";
import { fullPurge } from "../core/purge.js";
import { qualifySqliteVec } from "../retrieval/vec0.js";
import {
  AgentMemoryDatabase,
  APPLICATION_ID,
  CURRENT_SCHEMA_VERSION,
} from "./database.js";
import { StoreError } from "./errors.js";
import { registerBackupIntent, finishBackupRegistration, snapshotBasis, transferBackupInventory, assertManagedRestoreCandidate } from "./backup-inventory.js";
import type { RuntimeCleanupWorker } from "../runtime/cleanup.js";

/** The on-disk format is deliberately a SQLite file plus a small manifest. */
export const BACKUP_FORMAT = "agent-memory-backup" as const;
export const BACKUP_FORMAT_VERSION = 1 as const;
export const RESTORE_METADATA_SUFFIX = ".restore.json" as const;

const DATABASE_FILE_NAME = "vault.sqlite";
const MANIFEST_FILE_NAME = "manifest.json";
const HASH = z.string().regex(/^[a-f0-9]{64}$/u);
const UUID = z.uuid();
const MAX_AUTHORITY_ROWS = 100_000;
const MAX_PURGE_CAPTURES = 128;

const REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
  "search_document",
  "search_fts",
  "scope_policy",
  "scope_capture_policy",
  "scope_output_grant",
  "capture_replay_marker",
  "capture_acceptance",
  "purge_operation",
  "purge_tombstone",
  "query_trace",
  "entity",
  "memory_item",
  "memory_revision",
  "revision_source",
  "semantic_slot",
  "semantic_slot_member",
  "revision_operation",
  "temporal_intent",
  "state_segment",
  "commit_clock_meta",
  "commit_clock",
  "execution_batch",
  "budget_reservation",
  "budget_reservation_period",
  "execution_attempt",
  "vector_chunk",
  "vector_embedding",
  "vector_generation",
  "runtime_artifact",
  "api_auth_registry",
  "derived_artifact",
  "dependency",
  "extraction_batch",
  "extraction_batch_source",
  "extraction_candidate",
  "extraction_verdict",
  "semantic_edge",
  "procedure_activation",
  "managed_export",
  "opencode_observation_receipt",
  "opencode_observation_head",
  "opencode_reconcile_scan",
  "opencode_identity_tombstone",
] as const;

const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  format_version: z.literal(BACKUP_FORMAT_VERSION),
  backup_id: UUID,
  created_at: z.iso.datetime({ offset: true }),
  schema_version: z.number().int().min(1).max(CURRENT_SCHEMA_VERSION).refine((value) => value !== 21 && value !== 23),
  application_id: z.number().int().nonnegative(),
  database_file: z.string().min(1).max(256),
  database_sha256: HASH,
  database_size: z.number().int().nonnegative(),
  schema_digest: HASH,
  owner_binding: HASH,
  owner_binding_mode: z.enum(["explicit", "scopes"]),
  scope_owner_digest: HASH,
  authority: z.object({
    commit_seq: z.string().regex(/^[0-9]{1,20}$/u),
    data_epoch: z.string().regex(/^[0-9]{1,20}$/u),
    journal_digest: HASH,
    scope_count: z.number().int().nonnegative(),
    purge_operation_count: z.number().int().nonnegative(),
    purge_tombstone_count: z.number().int().nonnegative(),
    native_tombstone_count: z.number().int().nonnegative(),
  }).strict(),
  sqlite: z.object({
    version: z.string().min(1).max(64),
    compile_options_digest: HASH,
    vector_extension_required: z.boolean(),
  }).strict(),
}).strict();

export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupOptions {
  readonly owner_binding?: string;
  readonly signal?: AbortSignal;
  readonly rate?: number;
  readonly vector_extension_path?: string;
  /** Migration keeps a byte-for-byte backup of an older, otherwise valid vault. */
  readonly allow_legacy_schema?: boolean;
}

export interface BackupResult {
  readonly backup_path: string;
  readonly database_path: string;
  readonly manifest_path: string;
  readonly manifest: BackupManifest;
  readonly source_basis_sha256: string;
}

export interface RestoreOptions {
  readonly owner_binding?: string;
  readonly signal?: AbortSignal;
  readonly vector_extension_path?: string;
}

export interface RestoreRequest extends RestoreOptions {
  readonly backup_path: string;
  readonly output_path: string;
}

export interface RestoreResult {
  readonly status: "awaiting_activation" | "quarantined";
  readonly output_path: string;
  readonly metadata_path: string;
  readonly backup_id: string;
  readonly schema_version: number;
  readonly authority_digest: string;
  readonly quarantine_reasons: readonly string[];
  readonly source_basis_sha256: string;
}

interface BackupLayout {
  readonly backupPath: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly directory: boolean;
}

interface VaultInspection {
  readonly application_id: number;
  readonly schema_version: number;
  readonly schema_digest: string;
  readonly sqlite_version: string;
  readonly compile_options_digest: string;
  readonly vector_extension_required: boolean;
}

interface AuthorityScope {
  readonly scope_id: string;
  readonly kind: string;
  readonly owner_ref: string;
  readonly data_epoch: string;
  readonly privacy_epoch: string;
  readonly created_at: string;
}

interface AuthorityOperation {
  readonly operation_id: string;
  readonly scope_id: string;
  readonly expected_privacy_epoch: string;
  readonly state: "barrier" | "content_deleted" | "completed";
  readonly selected_count: number;
  readonly requested_at: string;
  readonly updated_at: string;
  readonly runtime_reset_state: string;
  readonly runtime_reset_owner: string | null;
  readonly cleanup_batch_ids_json: string;
}

interface AuthorityTombstone {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly operation_id: string;
  readonly created_at: string;
}

interface AuthorityNativeTombstone {
  readonly scope_id: string;
  readonly binding_id: string;
  readonly native_session_id: string;
  readonly identity_kind: string;
  readonly identity_key: string;
  readonly message_id: string | null;
  readonly part_id: string | null;
  readonly operation_id: string | null;
  readonly created_at: string;
}

interface AuthorityReplayMarker {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly reason: string;
  readonly native_binding_id: string | null;
  readonly native_session_id: string | null;
  readonly native_identity_kind: string | null;
  readonly native_identity_key: string | null;
  readonly rejected_at: string;
}

interface AuthoritySnapshot {
  readonly commit_seq: string;
  readonly data_epoch: string;
  readonly scopes: readonly AuthorityScope[];
  readonly operations: readonly AuthorityOperation[];
  readonly tombstones: readonly AuthorityTombstone[];
  readonly native_tombstones: readonly AuthorityNativeTombstone[];
  readonly replay_markers: readonly AuthorityReplayMarker[];
  readonly scope_policy: readonly Record<string, unknown>[];
  readonly scope_capture_policy: readonly Record<string, unknown>[];
  readonly scope_output_grant: readonly Record<string, unknown>[];
  readonly auth_registry: readonly Record<string, unknown>[];
  readonly api_auth_registry: readonly Record<string, unknown>[];
  readonly auth_operations: readonly Record<string, unknown>[];
  readonly auth_cleanup_entries: readonly Record<string, unknown>[];
  readonly managed_exports: readonly Record<string, unknown>[];
  readonly journal_digest: string;
  readonly scope_owner_digest: string;
}

interface RawSource {
  readonly database: DatabaseSync;
  readonly path: string;
  readonly owned: boolean;
}

interface SerializationDatabase {
  readonly serialize: () => Uint8Array;
  readonly deserialize: (data: Uint8Array) => void;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StoreError("backup_invalid", new Error(field));
  return value as Record<string, unknown>;
}

function value(row: Record<string, unknown>, field: string): unknown {
  if (!(field in row)) throw new StoreError("backup_invalid", new Error(field));
  return row[field];
}

function text(row: Record<string, unknown>, field: string): string {
  const item = value(row, field);
  if (typeof item !== "string") throw new StoreError("backup_invalid", new Error(field));
  return item;
}

function nullableText(row: Record<string, unknown>, field: string): string | null {
  const item = value(row, field);
  if (item === null) return null;
  if (typeof item !== "string") throw new StoreError("backup_invalid", new Error(field));
  return item;
}

function integer(row: Record<string, unknown>, field: string): bigint {
  const item = value(row, field);
  if (typeof item === "bigint") return item;
  if (typeof item === "number" && Number.isSafeInteger(item)) return BigInt(item);
  throw new StoreError("backup_invalid", new Error(field));
}

function number(row: Record<string, unknown>, field: string): number {
  const item = integer(row, field);
  const result = Number(item);
  if (!Number.isSafeInteger(result)) throw new StoreError("backup_invalid", new Error(field));
  return result;
}

function sqlValue(item: unknown, field: string): SQLInputValue {
  if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "bigint" || item instanceof Uint8Array) return item;
  throw new StoreError("restore_authority_mismatch", new Error(field));
}

function stable(valueToEncode: unknown): string {
  if (typeof valueToEncode === "bigint") return `${valueToEncode.toString(10)}n`;
  if (valueToEncode instanceof Uint8Array) return Buffer.from(valueToEncode).toString("base64");
  if (Array.isArray(valueToEncode)) return `[${valueToEncode.map(stable).join(",")}]`;
  if (typeof valueToEncode === "object" && valueToEncode !== null) {
    const record = valueToEncode as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(valueToEncode);
}

function sha256(valueToHash: string | Uint8Array): string {
  return createHash("sha256").update(valueToHash).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function safePath(input: string, field: string): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 4_096 || input === ":memory:") throw new StoreError("backup_invalid", new Error(field));
  const output = resolve(input);
  assertNoSymlinkAncestors(dirname(output));
  return join(realpathSync(dirname(output)), basename(output));
}

interface PathFlavor {
  readonly sep: string;
  readonly resolve: (...paths: string[]) => string;
  readonly parse: (path: string) => { readonly root: string };
}

const nativePathFlavor: PathFlavor = { sep, resolve, parse };

/** Enumerate every existing-or-to-be-created ancestor in a platform-neutral way. */
export function pathAncestors(path: string, pathFlavor: PathFlavor = nativePathFlavor): readonly string[] {
  const resolved = pathFlavor.resolve(path);
  const root = pathFlavor.parse(resolved).root;
  let current = root;
  const ancestors: string[] = [];
  for (const part of resolved.slice(root.length).split(pathFlavor.sep).filter(Boolean)) {
    current = pathFlavor.resolve(current, part);
    ancestors.push(current);
  }
  return ancestors;
}

function assertNoSymlinkAncestors(path: string): void {
  for (const current of pathAncestors(path)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        const canonical = resolve(realpathSync(current));
        const systemAlias = (current === "/tmp" || current.startsWith("/tmp/") || current === "/var" || current.startsWith("/var/")) && canonical === `/private${current}`;
        if (!systemAlias) throw new StoreError("backup_invalid");
      }
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new StoreError("backup_invalid", error);
    }
  }
}

function assertRegularFile(path: string, code: "backup_invalid" | "restore_invalid" = "backup_invalid"): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new StoreError(code);
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(code, error);
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function checkAborted(signal: AbortSignal | undefined, code: "backup_aborted" | "restore_aborted"): void {
  if (signal?.aborted === true) throw new StoreError(code);
}

function openDatabase(path: string, readOnly: boolean, vectorExtensionPath?: string): DatabaseSync {
  try {
    const uri = pathToFileURL(path);
    uri.search = readOnly ? "?mode=ro" : "?mode=rw";
    return new DatabaseSync(uri.href, {
      enableForeignKeyConstraints: true,
      readOnly,
      readBigInts: true,
      defensive: true,
      timeout: 1_000,
      allowExtension: vectorExtensionPath !== undefined,
    });
  } catch (error: unknown) {
    throw new StoreError(readOnly ? "backup_invalid" : "restore_invalid", error);
  }
}

function qualifyExtension(database: DatabaseSync, vectorExtensionPath: string | undefined, code: "backup_invalid" | "restore_invalid" = "backup_invalid"): void {
  if (vectorExtensionPath === undefined) return;
  try { qualifySqliteVec(database, vectorExtensionPath); } catch (error: unknown) {
    throw new StoreError(code, error);
  }
}

function pragmaInteger(database: DatabaseSync, name: string): bigint {
  const row = asRecord(database.prepare(`PRAGMA ${name}`).get(), name);
  return integer(row, name);
}

function pragmaText(database: DatabaseSync, name: string): string {
  const row = name === "sqlite_version"
    ? asRecord(database.prepare("SELECT sqlite_version() AS sqlite_version").get(), name)
    : asRecord(database.prepare(`PRAGMA ${name}`).get(), name);
  return text(row, name);
}

function readSchemaDigest(database: DatabaseSync): string {
  const rows = database.prepare(
    "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all().map((row) => asRecord(row, "sqlite_master"));
  return sha256(stable(rows));
}

function readCompileOptionsDigest(database: DatabaseSync): string {
  const options = database.prepare("PRAGMA compile_options").all().map((row) => {
    const item = asRecord(row, "compile_options");
    const first = Object.values(item)[0];
    if (typeof first !== "string") throw new StoreError("backup_invalid");
    return first;
  }).sort();
  return sha256(stable(options));
}

function readIntegrity(database: DatabaseSync, code: "backup_invalid" | "restore_invalid" | "restore_authority_mismatch"): void {
  const integrityRow = asRecord(database.prepare("PRAGMA integrity_check").get(), "integrity_check");
  const integrity = Object.values(integrityRow)[0];
  if (integrity !== "ok") throw new StoreError(code);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new StoreError(code);
}

function inspectDatabase(database: DatabaseSync, allowLegacy = false): VaultInspection {
  let applicationId: bigint;
  let schemaVersion: bigint;
  try {
    applicationId = pragmaInteger(database, "application_id");
    schemaVersion = pragmaInteger(database, "user_version");
    if (applicationId !== BigInt(APPLICATION_ID)) throw new StoreError("backup_invalid");
    if (schemaVersion < 1n || schemaVersion > BigInt(CURRENT_SCHEMA_VERSION) || schemaVersion === 21n || schemaVersion === 23n) throw new StoreError("backup_invalid");
    const meta = asRecord(database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get(), "schema_meta");
    if (text(meta, "value") !== schemaVersion.toString(10)) throw new StoreError("backup_invalid");
    if (!allowLegacy && schemaVersion !== BigInt(CURRENT_SCHEMA_VERSION)) throw new StoreError("backup_invalid");
    if (schemaVersion === BigInt(CURRENT_SCHEMA_VERSION)) {
      for (const table of REQUIRED_TABLES) {
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) throw new StoreError("backup_invalid");
      }
    }
    readIntegrity(database, "backup_invalid");
    const vectorExtensionRequired = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE sql LIKE '%USING vec0%' LIMIT 1",
    ).get() !== undefined;
    return {
      application_id: Number(applicationId),
      schema_version: Number(schemaVersion),
      schema_digest: readSchemaDigest(database),
      sqlite_version: pragmaText(database, "sqlite_version"),
      compile_options_digest: readCompileOptionsDigest(database),
      vector_extension_required: vectorExtensionRequired,
    };
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("backup_invalid", error);
  }
}

function readRows(database: DatabaseSync, query: string, code: "backup_invalid" | "restore_authority_mismatch" = "backup_invalid"): readonly Record<string, unknown>[] {
  try {
    const rows = database.prepare(query).all().map((row) => asRecord(row, "authority_row"));
    if (rows.length > MAX_AUTHORITY_ROWS) throw new StoreError(code);
    return rows;
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError(code, error);
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function readRowsOptional(database: DatabaseSync, table: string, query: string, code: "backup_invalid" | "restore_authority_mismatch" = "backup_invalid"): readonly Record<string, unknown>[] {
  return hasTable(database, table) ? readRows(database, query, code) : [];
}

function ownerDigest(scopes: readonly AuthorityScope[]): string {
  return sha256(stable(scopes.map(({ scope_id, kind, owner_ref, created_at }) => ({ scope_id, kind, owner_ref, created_at }))));
}

function authoritySnapshot(database: DatabaseSync): AuthoritySnapshot {
  try {
    const counter = asRecord(database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get(), "vault_counter");
    const scopes = readRows(database, "SELECT scope_id, kind, owner_ref, data_epoch, privacy_epoch, created_at FROM scope ORDER BY scope_id", "restore_authority_mismatch").map((row) => ({
      scope_id: text(row, "scope_id"),
      kind: text(row, "kind"),
      owner_ref: text(row, "owner_ref"),
      data_epoch: integer(row, "data_epoch").toString(10),
      privacy_epoch: integer(row, "privacy_epoch").toString(10),
      created_at: text(row, "created_at"),
    }));
    const purgeOperationRows = readRowsOptional(database, "purge_operation", "SELECT * FROM purge_operation ORDER BY operation_id", "restore_authority_mismatch");
    const operations = purgeOperationRows.map((row) => {
      const stateValue = text(row, "state");
      if (stateValue !== "barrier" && stateValue !== "content_deleted" && stateValue !== "completed") throw new StoreError("restore_authority_mismatch");
      const state: AuthorityOperation["state"] = stateValue;
      return {
        operation_id: text(row, "operation_id"),
        scope_id: text(row, "scope_id"),
        expected_privacy_epoch: text(row, "expected_privacy_epoch"),
        state,
        selected_count: number(row, "selected_count"),
        requested_at: text(row, "requested_at"),
        updated_at: text(row, "updated_at"),
        runtime_reset_state: "runtime_reset_state" in row ? text(row, "runtime_reset_state") : "unknown",
        runtime_reset_owner: "runtime_reset_owner" in row ? nullableText(row, "runtime_reset_owner") : null,
        cleanup_batch_ids_json: "cleanup_batch_ids_json" in row ? text(row, "cleanup_batch_ids_json") : "[]",
      };
    });
    const tombstones = readRowsOptional(database, "purge_tombstone", "SELECT capture_id, scope_id, operation_id, created_at FROM purge_tombstone ORDER BY capture_id", "restore_authority_mismatch").map((row) => ({
      capture_id: text(row, "capture_id"),
      scope_id: text(row, "scope_id"),
      operation_id: text(row, "operation_id"),
      created_at: text(row, "created_at"),
    }));
    const nativeTombstones = readRowsOptional(database, "opencode_identity_tombstone", "SELECT scope_id, binding_id, native_session_id, identity_kind, identity_key, message_id, part_id, operation_id, created_at FROM opencode_identity_tombstone ORDER BY scope_id, binding_id, native_session_id, identity_kind, identity_key", "restore_authority_mismatch").map((row) => ({
      scope_id: text(row, "scope_id"),
      binding_id: text(row, "binding_id"),
      native_session_id: text(row, "native_session_id"),
      identity_kind: text(row, "identity_kind"),
      identity_key: text(row, "identity_key"),
      message_id: nullableText(row, "message_id"),
      part_id: nullableText(row, "part_id"),
      operation_id: nullableText(row, "operation_id"),
      created_at: text(row, "created_at"),
    }));
    const currentSchema = pragmaInteger(database, "user_version") >= 26n;
    const replayMarkers = (currentSchema
      ? readRowsOptional(database, "capture_replay_marker", "SELECT capture_id, scope_id, reason, native_binding_id, native_session_id, native_identity_kind, native_identity_key, rejected_at FROM capture_replay_marker ORDER BY capture_id", "restore_authority_mismatch")
      : readRowsOptional(database, "capture_replay_marker", "SELECT capture_id, scope_id, reason, rejected_at FROM capture_replay_marker ORDER BY capture_id", "restore_authority_mismatch")
    ).map((row) => ({
      capture_id: text(row, "capture_id"),
      scope_id: text(row, "scope_id"),
      reason: text(row, "reason"),
      native_binding_id: currentSchema ? nullableText(row, "native_binding_id") : null,
      native_session_id: currentSchema ? nullableText(row, "native_session_id") : null,
      native_identity_kind: currentSchema ? nullableText(row, "native_identity_kind") : null,
      native_identity_key: currentSchema ? nullableText(row, "native_identity_key") : null,
      rejected_at: text(row, "rejected_at"),
    }));
    const authority: AuthoritySnapshot = {
      commit_seq: integer(counter, "commit_seq").toString(10),
      data_epoch: integer(counter, "data_epoch").toString(10),
      scopes,
      operations,
      tombstones,
      native_tombstones: nativeTombstones,
      replay_markers: replayMarkers,
      scope_policy: currentSchema
        ? readRowsOptional(database, "scope_policy", "SELECT scope_id, capture_paused, capture_policy_enrolled, updated_at FROM scope_policy ORDER BY scope_id", "restore_authority_mismatch")
        : readRowsOptional(database, "scope_policy", "SELECT scope_id, capture_paused, updated_at FROM scope_policy ORDER BY scope_id", "restore_authority_mismatch"),
      scope_capture_policy: readRowsOptional(database, "scope_capture_policy", "SELECT scope_id, source_class, retention_mode, retention_seconds, selected_at FROM scope_capture_policy ORDER BY scope_id, source_class", "restore_authority_mismatch"),
      scope_output_grant: readRowsOptional(database, "scope_output_grant", "SELECT scope_id, output_target, source_class, created_at FROM scope_output_grant ORDER BY scope_id, output_target, source_class", "restore_authority_mismatch"),
      auth_registry: readRowsOptional(database, "auth_registry", "SELECT * FROM auth_registry ORDER BY account_ref", "restore_authority_mismatch"),
      api_auth_registry: readRowsOptional(database, "api_auth_registry", "SELECT * FROM api_auth_registry ORDER BY account_ref", "restore_authority_mismatch"),
      auth_operations: readRowsOptional(database, "auth_operations", "SELECT * FROM auth_operations ORDER BY operation_id", "restore_authority_mismatch"),
      auth_cleanup_entries: readRowsOptional(database, "auth_cleanup_entries", "SELECT * FROM auth_cleanup_entries ORDER BY account_ref, revoked_generation, entry_id", "restore_authority_mismatch"),
      managed_exports: readRowsOptional(database, "managed_export", "SELECT * FROM managed_export ORDER BY scope_id, export_id", "restore_authority_mismatch"),
      journal_digest: sha256(stable({
        commit_seq: integer(counter, "commit_seq").toString(10),
        data_epoch: integer(counter, "data_epoch").toString(10),
        scopes,
        operations,
        tombstones,
        native_tombstones: nativeTombstones,
        replay_markers: replayMarkers,
      })),
      scope_owner_digest: ownerDigest(scopes),
    };
    for (const operation of operations) {
      if (!UUID.safeParse(operation.operation_id).success || !UUID.safeParse(operation.scope_id).success || operation.selected_count < 1 || operation.selected_count > MAX_PURGE_CAPTURES) throw new StoreError("restore_authority_mismatch");
      const operationTombstones = tombstones.filter((row) => row.operation_id === operation.operation_id);
      if (operationTombstones.length !== operation.selected_count || operationTombstones.some((row) => row.scope_id !== operation.scope_id || !UUID.safeParse(row.capture_id).success)) throw new StoreError("restore_authority_mismatch");
    }
    const operationIds = new Set(operations.map((operation) => operation.operation_id));
    if (tombstones.some((row) => !operationIds.has(row.operation_id))) throw new StoreError("restore_authority_mismatch");
    const scopesById = new Map(scopes.map((scope) => [scope.scope_id, scope]));
    for (const row of tombstones) if (!scopesById.has(row.scope_id)) throw new StoreError("restore_authority_mismatch");
    for (const marker of replayMarkers) {
      if (!scopesById.has(marker.scope_id) || !UUID.safeParse(marker.capture_id).success || (marker.reason !== "capture_paused" && marker.reason !== "capture_class_excluded")) throw new StoreError("restore_authority_mismatch");
      const nativeFields = [marker.native_binding_id, marker.native_session_id, marker.native_identity_kind, marker.native_identity_key];
      if (nativeFields.some((field) => field !== null) && nativeFields.some((field) => field === null)) throw new StoreError("restore_authority_mismatch");
      if (marker.native_binding_id !== null && (!UUID.safeParse(marker.native_binding_id).success || marker.native_identity_kind !== "event" && marker.native_identity_kind !== "part_snapshot")) throw new StoreError("restore_authority_mismatch");
    }
    for (const row of nativeTombstones) {
      if (!scopesById.has(row.scope_id) || (row.operation_id !== null && !operationIds.has(row.operation_id))) throw new StoreError("restore_authority_mismatch");
    }
    if (hasTable(database, "opencode_observation_receipt")) {
      const nativeKeys = new Set(nativeTombstones.map((row) => rowKey(row as unknown as Record<string, unknown>, ["scope_id", "binding_id", "native_session_id", "identity_kind", "identity_key"])));
      for (const row of readRows(database, "SELECT scope_id, binding_id, native_session_id, identity_kind, identity_key FROM opencode_observation_receipt WHERE state = 'purged'", "restore_authority_mismatch")) {
        if (!nativeKeys.has(rowKey(row, ["scope_id", "binding_id", "native_session_id", "identity_kind", "identity_key"]))) throw new StoreError("restore_authority_mismatch");
      }
    }
    if (pragmaInteger(database, "user_version") >= 20n && authority.scope_policy.length !== scopes.length) throw new StoreError("restore_authority_mismatch");
    for (const operation of operations.filter((row) => row.state === "completed")) {
      for (const tombstone of tombstones.filter((row) => row.operation_id === operation.operation_id)) {
        if (database.prepare("SELECT 1 FROM source_event WHERE scope_id = ? AND capture_id = ?").get(tombstone.scope_id, tombstone.capture_id) !== undefined) throw new StoreError("restore_authority_mismatch");
      }
    }
    return authority;
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("restore_authority_mismatch", error);
  }
}

function resolveCreateLayout(destination: string): BackupLayout {
  const path = safePath(destination, "backup-destination");
  const isFileLayout = [".sqlite", ".db"].includes(extname(path).toLowerCase());
  if (isFileLayout) return { backupPath: path, databasePath: path, manifestPath: `${path}.manifest.json`, directory: false };
  return { backupPath: path, databasePath: join(path, DATABASE_FILE_NAME), manifestPath: join(path, MANIFEST_FILE_NAME), directory: true };
}

function resolveReadLayout(input: string): BackupLayout {
  const path = safePath(input, "backup-path");
  try {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) return { backupPath: path, databasePath: join(path, DATABASE_FILE_NAME), manifestPath: join(path, MANIFEST_FILE_NAME), directory: true };
  } catch {
    // The regular file check below provides the bounded public error.
  }
  assertRegularFile(path, "backup_invalid");
  return { backupPath: path, databasePath: path, manifestPath: `${path}.manifest.json`, directory: false };
}

function readManifest(layout: BackupLayout): BackupManifest {
  assertRegularFile(layout.manifestPath, "backup_invalid");
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(layout.manifestPath, "utf8")));
    if (!parsed.success) throw new StoreError("backup_invalid");
    if (parsed.data.database_file !== (layout.directory ? DATABASE_FILE_NAME : layout.databasePath.split("/").at(-1))) throw new StoreError("backup_invalid");
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("backup_invalid", error);
  }
}

function ownedStorePath(source: AgentMemoryDatabase): string {
  if (!(source instanceof AgentMemoryDatabase) || source.isClosed()) throw new StoreError("backup_invalid");
  const database = (source as unknown as { readonly database: DatabaseSync }).database;
  if (database.location() === null) throw new StoreError("backup_invalid");
  return safePath(database.location()!, "backup-source");
}

function sourceDatabase(source: string | AgentMemoryDatabase, vectorExtensionPath?: string): RawSource {
  const path = typeof source === "string" ? safePath(source, "backup-source") : ownedStorePath(source);
  assertRegularFile(path, "backup_invalid");
  // A dedicated connection owns the asynchronous lock: scheduler activity on the
  // application's connection must never commit or roll back our transaction.
  const database = openDatabase(path, false, vectorExtensionPath);
  try { qualifyExtension(database, vectorExtensionPath); } catch (error) { database.close(); throw error; }
  return { database, path, owned: true };
}

function writeExclusiveFile(path: string, content: string): void {
  const descriptor = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
}

function linkNoClobber(source: string, target: string, code: "backup_target_exists" | "restore_target_exists" = "restore_target_exists"): void {
  try { linkSync(source, target); } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new StoreError(code);
    throw error;
  }
}

function cleanupPath(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* bounded cleanup is reported by the caller's failure */ }
}

function authorityManifest(authority: AuthoritySnapshot, inspection: VaultInspection, ownerBinding: string, ownerBindingMode: "explicit" | "scopes", databasePath: string, now: string, databaseSha256: string, databaseSize: number): BackupManifest {
  return {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    backup_id: randomUUID(),
    created_at: now,
    schema_version: inspection.schema_version,
    application_id: inspection.application_id,
    database_file: databasePath.split("/").at(-1) ?? DATABASE_FILE_NAME,
    database_sha256: databaseSha256,
    database_size: databaseSize,
    schema_digest: inspection.schema_digest,
    owner_binding: ownerBindingMode === "scopes" ? ownerBinding : sha256(ownerBinding),
    owner_binding_mode: ownerBindingMode,
    scope_owner_digest: authority.scope_owner_digest,
    authority: {
      commit_seq: authority.commit_seq,
      data_epoch: authority.data_epoch,
      journal_digest: authority.journal_digest,
      scope_count: authority.scopes.length,
      purge_operation_count: authority.operations.length,
      purge_tombstone_count: authority.tombstones.length,
      native_tombstone_count: authority.native_tombstones.length,
    },
    sqlite: {
      version: inspection.sqlite_version,
      compile_options_digest: inspection.compile_options_digest,
      vector_extension_required: inspection.vector_extension_required,
    },
  };
}

/** Create an exclusive, manifest-checked SQLite backup from a path or open store. */
export async function createBackup(source: string | AgentMemoryDatabase, destination: string, options: BackupOptions = {}): Promise<BackupResult> {
  const layout = resolveCreateLayout(destination);
  const signal = options.signal;
  checkAborted(signal, "backup_aborted");
  if (!Number.isSafeInteger(options.rate ?? 100) || (options.rate ?? 100) < 1 || (options.rate ?? 100) > 10_000) throw new StoreError("backup_invalid");
  if (existsSync(layout.backupPath) || existsSync(layout.manifestPath)) throw new StoreError("backup_target_exists");
  assertNoSymlinkAncestors(dirname(layout.backupPath));
  if (!statSync(dirname(layout.backupPath)).isDirectory()) throw new StoreError("backup_invalid");
  let sourceInfo: RawSource | undefined;
  let snapshotSource: DatabaseSync | undefined;
  let serializedSource: DatabaseSync | undefined;
  let destinationCreated = false;
  let temporaryDatabase: string | undefined;
  const backupId = randomUUID();
  let temporaryManifest: string | undefined;
  let destinationDatabaseLinked = false;
  let destinationManifestLinked = false;
  try {
    if (layout.directory) {
      mkdirSync(layout.backupPath, { mode: 0o700 });
      destinationCreated = true;
    }
    const vectorExtensionPath = options.vector_extension_path ?? (typeof source === "object" ? source.vectorQualification?.extension_path : undefined);
    sourceInfo = sourceDatabase(source, vectorExtensionPath);
    if (sourceInfo.database.isTransaction) throw new StoreError("backup_busy");
    const inspection = inspectDatabase(sourceInfo.database, options.allow_legacy_schema === true);
    const restoreState = sourceInfo.database.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get();
    if (restoreState !== undefined && restoreState.value !== "ready") throw new StoreError("restore_quarantined");
    const authority = authoritySnapshot(sourceInfo.database);
    const ownerBinding = options.owner_binding ?? authority.scope_owner_digest;
    if (typeof ownerBinding !== "string" || ownerBinding.length < 1 || ownerBinding.length > 256) throw new StoreError("backup_invalid");
    const ownerBindingMode = options.owner_binding === undefined ? "scopes" : "explicit";
    const journalMode = pragmaText(sourceInfo.database, "journal_mode");
    if (inspection.vector_extension_required && vectorExtensionPath === undefined) throw new StoreError("backup_invalid");
    if (journalMode === "wal") {
      snapshotSource = openDatabase(sourceInfo.path, true, vectorExtensionPath);
      qualifyExtension(snapshotSource, vectorExtensionPath);
    }
    temporaryDatabase = layout.directory ? join(layout.backupPath, `.vault-${backupId}.tmp`) : join(dirname(layout.databasePath), `.vault-${backupId}.tmp`);
    temporaryManifest = layout.directory ? join(layout.backupPath, `.manifest-${backupId}.tmp`) : join(dirname(layout.manifestPath), `.manifest-${backupId}.tmp`);
    try { registerBackupIntent(sourceInfo.database, backupId, authority.scopes.map((scope) => scope.scope_id), [temporaryDatabase, temporaryManifest, layout.databasePath, layout.manifestPath]); }
    catch (error) { throw new StoreError("backup_busy", error); }
    try { sourceInfo.database.exec("BEGIN EXCLUSIVE"); } catch (error: unknown) {
      try { snapshotSource?.close(); } catch { /* preserve the lock failure */ }
      snapshotSource = undefined;
      throw new StoreError("backup_busy", error);
    }
    try {
      checkAborted(signal, "backup_aborted");
      const lockedAuthority = authoritySnapshot(sourceInfo.database);
      if (lockedAuthority.journal_digest !== authority.journal_digest || lockedAuthority.scope_owner_digest !== authority.scope_owner_digest) throw new StoreError("backup_busy");
      const sourceBasis = snapshotBasis(sourceInfo.database);
      const backupSource = journalMode === "wal"
        ? snapshotSource
        : (serializedSource = new DatabaseSync(":memory:", { readBigInts: true, defensive: true }));
      if (journalMode !== "wal") {
        (serializedSource as unknown as SerializationDatabase).deserialize((sourceInfo.database as unknown as SerializationDatabase).serialize());
      }
      if (backupSource === undefined) throw new StoreError("backup_invalid");
      await sqliteBackup(backupSource, temporaryDatabase, {
        rate: options.rate ?? 100,
        progress: () => checkAborted(signal, "backup_aborted"),
      });
      checkAborted(signal, "backup_aborted");
      assertRegularFile(temporaryDatabase, "backup_invalid");
      chmodSync(temporaryDatabase, 0o600);
      fsyncFile(temporaryDatabase);
      const copied = openDatabase(temporaryDatabase, false, vectorExtensionPath);
      try {
        qualifyExtension(copied, vectorExtensionPath);
        const copiedInspection = inspectDatabase(copied, options.allow_legacy_schema === true);
        copied.exec("DELETE FROM schema_meta WHERE key LIKE 'managed_backup:%'; INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_state', 'archive');");
        copied.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        if (copiedInspection.schema_version !== inspection.schema_version || copiedInspection.schema_digest !== inspection.schema_digest || copiedInspection.application_id !== inspection.application_id) throw new StoreError("backup_invalid");
      } finally { copied.close(); }
      fsyncFile(temporaryDatabase);
      const fileStat = statSync(temporaryDatabase);
      const manifest = { ...authorityManifest(lockedAuthority, inspection, ownerBinding, ownerBindingMode, layout.databasePath, new Date().toISOString(), sha256File(temporaryDatabase), fileStat.size), backup_id: backupId };
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      try {
        writeExclusiveFile(temporaryManifest, manifestText);
        linkNoClobber(temporaryDatabase, layout.databasePath, "backup_target_exists");
        destinationDatabaseLinked = true;
        unlinkSync(temporaryDatabase);
        temporaryDatabase = undefined;
        linkNoClobber(temporaryManifest, layout.manifestPath, "backup_target_exists");
        destinationManifestLinked = true;
        unlinkSync(temporaryManifest);
        fsyncDirectory(layout.directory ? layout.backupPath : dirname(layout.databasePath));
        if (layout.directory) fsyncDirectory(dirname(layout.backupPath));
      } catch (error: unknown) {
        cleanupPath(temporaryManifest);
        throw error;
      }
      finishBackupRegistration(sourceInfo.database, backupId);
      sourceInfo.database.exec("COMMIT");
      return { source_basis_sha256: sourceBasis, backup_path: layout.backupPath, database_path: layout.databasePath, manifest_path: layout.manifestPath, manifest };
    } catch (error: unknown) {
      try { sourceInfo.database.exec("ROLLBACK"); } catch { /* preserve failure */ }
      throw error;
    }
    finally {
      try { snapshotSource?.close(); } catch { /* preserve the primary result */ }
      snapshotSource = undefined;
      try { serializedSource?.close(); } catch { /* preserve the primary result */ }
      serializedSource = undefined;
    }
  } catch (error: unknown) {
    if (temporaryDatabase !== undefined) cleanupPath(temporaryDatabase);
    if (destinationCreated) cleanupPath(layout.backupPath);
    if (!layout.directory && destinationDatabaseLinked) {
      try { unlinkSync(layout.databasePath); } catch { /* preserve primary */ }
    }
    if (!layout.directory && destinationManifestLinked) {
      try { unlinkSync(layout.manifestPath); } catch { /* preserve primary */ }
    }
    if (error instanceof StoreError) throw error;
    if (signal?.aborted === true) throw new StoreError("backup_aborted", error);
    throw new StoreError("backup_invalid", error);
  } finally {
    if (sourceInfo?.owned === true) {
      try { sourceInfo.database.close(); } catch { /* preserve primary result */ }
    }
  }
}

const quarantineCleanupWorker = {
  async reconcileSource(): Promise<void> {
    // Restore must never trust a stale filesystem path. The caller inspects
    // the durable inventory below and quarantines any unresolved artifact.
  },
} as unknown as RuntimeCleanupWorker;

function rowKey(row: Record<string, unknown>, fields: readonly string[]): string {
  return stable(fields.map((field) => value(row, field)));
}

function ensureStageAuthoritySubset(stage: DatabaseSync, authority: AuthoritySnapshot): void {
  const currentOperations = new Map(authority.operations.map((row) => [row.operation_id, row]));
  for (const row of readRows(stage, "SELECT operation_id, scope_id, expected_privacy_epoch, selected_count, requested_at FROM purge_operation", "restore_authority_mismatch")) {
    const current = currentOperations.get(text(row, "operation_id"));
    if (current === undefined || current.scope_id !== text(row, "scope_id") || current.expected_privacy_epoch !== text(row, "expected_privacy_epoch") || current.selected_count !== number(row, "selected_count") || current.requested_at !== text(row, "requested_at")) throw new StoreError("restore_authority_mismatch");
  }
  const currentTombstones = new Map(authority.tombstones.map((row) => [row.capture_id, row]));
  for (const row of readRows(stage, "SELECT capture_id, scope_id, operation_id, created_at FROM purge_tombstone", "restore_authority_mismatch")) {
    const current = currentTombstones.get(text(row, "capture_id"));
    if (current === undefined || rowKey(row, ["scope_id", "operation_id", "created_at"]) !== rowKey(current as unknown as Record<string, unknown>, ["scope_id", "operation_id", "created_at"])) throw new StoreError("restore_authority_mismatch");
  }
  const currentNative = new Map(authority.native_tombstones.map((row) => [rowKey(row as unknown as Record<string, unknown>, ["scope_id", "binding_id", "native_session_id", "identity_kind", "identity_key"]), row]));
  for (const row of readRows(stage, "SELECT scope_id, binding_id, native_session_id, identity_kind, identity_key, message_id, part_id, operation_id, created_at FROM opencode_identity_tombstone", "restore_authority_mismatch")) {
    const current = currentNative.get(rowKey(row, ["scope_id", "binding_id", "native_session_id", "identity_kind", "identity_key"]));
    if (current === undefined || rowKey(row, ["message_id", "part_id", "operation_id", "created_at"]) !== rowKey(current as unknown as Record<string, unknown>, ["message_id", "part_id", "operation_id", "created_at"])) throw new StoreError("restore_authority_mismatch");
  }
  const currentReplay = new Map(authority.replay_markers.map((row) => [row.capture_id, row]));
  for (const row of readRows(stage, "SELECT capture_id, scope_id, reason, native_binding_id, native_session_id, native_identity_kind, native_identity_key, rejected_at FROM capture_replay_marker", "restore_authority_mismatch")) {
    const current = currentReplay.get(text(row, "capture_id"));
    if (current === undefined || rowKey(row, ["scope_id", "reason", "native_binding_id", "native_session_id", "native_identity_kind", "native_identity_key", "rejected_at"]) !== rowKey(current as unknown as Record<string, unknown>, ["scope_id", "reason", "native_binding_id", "native_session_id", "native_identity_kind", "native_identity_key", "rejected_at"])) throw new StoreError("restore_authority_mismatch");
  }
}

function insertRows(database: DatabaseSync, table: string, columns: readonly string[], rows: readonly unknown[], ignore = false): void {
  if (rows.length === 0) return;
  const statement = database.prepare(`${ignore ? "INSERT OR IGNORE" : "INSERT"} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  for (const entry of rows) {
    const row = asRecord(entry, `${table}.row`);
    statement.run(...columns.map((column) => sqlValue(value(row, column), `${table}.${column}`)));
  }
}

function applyAuthorityOverlay(stage: DatabaseSync, authority: AuthoritySnapshot): void {
  stage.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    ensureStageAuthoritySubset(stage, authority);
    const stageScopes = new Map(readRows(stage, "SELECT scope_id, kind, owner_ref, data_epoch, privacy_epoch, created_at FROM scope", "restore_authority_mismatch").map((row) => [text(row, "scope_id"), row]));
    if (stageScopes.size !== authority.scopes.length) throw new StoreError("restore_authority_mismatch");
    for (const scope of authority.scopes) {
      const existing = stageScopes.get(scope.scope_id);
      if (existing === undefined || text(existing, "kind") !== scope.kind || text(existing, "owner_ref") !== scope.owner_ref || text(existing, "created_at") !== scope.created_at) throw new StoreError("restore_authority_mismatch");
      stage.prepare("UPDATE scope SET data_epoch = ?, privacy_epoch = ? WHERE scope_id = ?").run(BigInt(scope.data_epoch), BigInt(scope.privacy_epoch), scope.scope_id);
    }
    stage.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1").run(BigInt(authority.commit_seq), BigInt(authority.data_epoch));

    stage.exec("DELETE FROM scope_output_grant; DELETE FROM scope_capture_policy; DELETE FROM scope_policy;");
    insertRows(stage, "scope_policy", ["scope_id", "capture_paused", "capture_policy_enrolled", "updated_at"], authority.scope_policy.map((row) => ({
      ...row,
      capture_policy_enrolled: "capture_policy_enrolled" in row ? row.capture_policy_enrolled : 0n,
    })));
    insertRows(stage, "scope_capture_policy", ["scope_id", "source_class", "retention_mode", "retention_seconds", "selected_at"], authority.scope_capture_policy);
    insertRows(stage, "scope_output_grant", ["scope_id", "output_target", "source_class", "created_at"], authority.scope_output_grant);

    stage.exec("DELETE FROM auth_cleanup_entries; DELETE FROM auth_operations; DELETE FROM api_auth_registry; DELETE FROM auth_registry;");
    insertRows(stage, "auth_registry", ["version", "account_ref", "entry_id", "client_id", "issuer", "account_id", "auth_epoch", "state", "auth_generation", "pending_entry_id", "operation_id", "retiring_entry_id", "access_expires_at", "refresh_expires_at", "granted_scope", "refresh_started_at", "updated_at"], authority.auth_registry);
    insertRows(stage, "api_auth_registry", ["version", "provider_id", "account_ref", "entry_id", "auth_generation", "auth_epoch", "state", "updated_at"], authority.api_auth_registry);
    insertRows(stage, "auth_operations", ["version", "operation_id", "account_ref", "client_id", "issuer", "owner_pid", "owner_nonce", "auth_generation", "kind", "entry_id", "state", "created_at", "updated_at"], authority.auth_operations);
    insertRows(stage, "auth_cleanup_entries", ["version", "account_ref", "revoked_generation", "entry_id", "state", "created_at", "updated_at"], authority.auth_cleanup_entries);

    for (const operation of authority.operations) {
      const existing = stage.prepare("SELECT operation_id FROM purge_operation WHERE operation_id = ?").get(operation.operation_id);
      if (existing === undefined) {
        stage.prepare("INSERT INTO purge_operation (operation_id, scope_id, expected_privacy_epoch, state, selected_count, requested_at, updated_at, runtime_reset_state, runtime_reset_owner, cleanup_batch_ids_json) VALUES (?, ?, ?, 'barrier', ?, ?, ?, ?, ?, ?)").run(operation.operation_id, operation.scope_id, operation.expected_privacy_epoch, operation.selected_count, operation.requested_at, operation.updated_at, operation.runtime_reset_state, operation.runtime_reset_owner, operation.cleanup_batch_ids_json);
      } else {
        stage.prepare("UPDATE purge_operation SET scope_id = ?, expected_privacy_epoch = ?, state = 'barrier', selected_count = ?, requested_at = ?, updated_at = ?, runtime_reset_state = ?, runtime_reset_owner = ?, cleanup_batch_ids_json = ? WHERE operation_id = ?").run(operation.scope_id, operation.expected_privacy_epoch, operation.selected_count, operation.requested_at, operation.updated_at, operation.runtime_reset_state, operation.runtime_reset_owner, operation.cleanup_batch_ids_json, operation.operation_id);
      }
    }
    insertRows(stage, "purge_tombstone", ["capture_id", "scope_id", "operation_id", "created_at"], authority.tombstones, true);
    insertRows(stage, "opencode_identity_tombstone", ["scope_id", "binding_id", "native_session_id", "identity_kind", "identity_key", "message_id", "part_id", "operation_id", "created_at"], authority.native_tombstones, true);
    insertRows(stage, "capture_replay_marker", ["capture_id", "scope_id", "reason", "native_binding_id", "native_session_id", "native_identity_kind", "native_identity_key", "rejected_at"], authority.replay_markers.map((row) => ({
      ...row,
      native_binding_id: "native_binding_id" in row ? row.native_binding_id : null,
      native_session_id: "native_session_id" in row ? row.native_session_id : null,
      native_identity_kind: "native_identity_kind" in row ? row.native_identity_kind : null,
      native_identity_key: "native_identity_key" in row ? row.native_identity_key : null,
    })), true);

    const currentExports = new Map(authority.managed_exports.map((row) => [text(row, "export_id"), row]));
    for (const row of readRows(stage, "SELECT * FROM managed_export", "restore_authority_mismatch")) {
      const current = currentExports.get(text(row, "export_id"));
      if (current === undefined) continue;
      const immutable = ["scope_id", "procedure_item_id", "procedure_revision_id", "binding_id", "output_target", "target_kind", "root", "path", "expected_owner_hash", "root_dev", "root_ino", "parent_dev", "parent_ino"] as const;
      if (rowKey(row, immutable) !== rowKey(current, immutable)) throw new StoreError("restore_authority_mismatch");
      stage.prepare("UPDATE managed_export SET purge_operation_id = ?, desired_state = ?, state = ?, observed_state = ?, observed_hash = ?, host_refresh_state = ?, outbox_state = ?, outbox_attempts = ?, outbox_next_at = ?, outbox_owner = ?, outbox_lease_until = ?, outbox_fence = ?, outbox_last_error = ?, updated_at = ? WHERE scope_id = ? AND export_id = ?").run(
        sqlValue(value(current, "purge_operation_id"), "managed_export.purge_operation_id"),
        sqlValue(value(current, "desired_state"), "managed_export.desired_state"),
        sqlValue(value(current, "state"), "managed_export.state"),
        sqlValue(value(current, "observed_state"), "managed_export.observed_state"),
        sqlValue(value(current, "observed_hash"), "managed_export.observed_hash"),
        sqlValue(value(current, "host_refresh_state"), "managed_export.host_refresh_state"),
        sqlValue(value(current, "outbox_state"), "managed_export.outbox_state"),
        sqlValue(value(current, "outbox_attempts"), "managed_export.outbox_attempts"),
        sqlValue(value(current, "outbox_next_at"), "managed_export.outbox_next_at"),
        sqlValue(value(current, "outbox_owner"), "managed_export.outbox_owner"),
        sqlValue(value(current, "outbox_lease_until"), "managed_export.outbox_lease_until"),
        sqlValue(value(current, "outbox_fence"), "managed_export.outbox_fence"),
        sqlValue(value(current, "outbox_last_error"), "managed_export.outbox_last_error"),
        sqlValue(value(current, "updated_at"), "managed_export.updated_at"),
        text(row, "scope_id"), text(row, "export_id"),
      );
    }

    for (const tombstone of authority.native_tombstones) {
      stage.prepare("UPDATE opencode_observation_receipt SET state = 'purged', content_digest = NULL WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND ((identity_kind = ? AND identity_key = ?) OR (message_id = ? AND (part_id IS NULL OR part_id = ? OR ? IS NULL)))").run(tombstone.scope_id, tombstone.binding_id, tombstone.native_session_id, tombstone.identity_kind, tombstone.identity_key, tombstone.message_id, tombstone.part_id, tombstone.part_id);
      if (tombstone.message_id !== null) stage.prepare("UPDATE opencode_observation_head SET state = 'blocked', current_capture_id = NULL, current_digest = NULL, first_observed_at = NULL, last_observed_at = ?, last_scan_id = NULL WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ? AND (part_id = ? OR ? IS NULL)").run(tombstone.created_at, tombstone.scope_id, tombstone.binding_id, tombstone.native_session_id, tombstone.message_id, tombstone.part_id, tombstone.part_id);
    }
    stage.exec("DELETE FROM query_trace;");
    stage.exec("UPDATE opencode_reconcile_scan SET state = 'invalidated', cursor_json = NULL, coverage_json = '{\"status\":\"coverage_gap\",\"reason\":\"restore_quarantine\"}' WHERE state = 'active';");
    stage.exec("COMMIT");
    committed = true;
  } catch (error: unknown) {
    if (!committed) {
      try { stage.exec("ROLLBACK"); } catch { /* preserve primary */ }
    }
    if (error instanceof StoreError) throw error;
    throw new StoreError("restore_authority_mismatch", error);
  }
}

function applyQuarantineState(stage: DatabaseSync): void {
  stage.exec("BEGIN IMMEDIATE");
  let committed = false;
  try {
    stage.exec("UPDATE job SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL, fence = fence + 1, input_privacy_epoch = (SELECT s.privacy_epoch FROM scope s WHERE s.scope_id = job.scope_id), pause_reason = 'policy_changed', completion_receipt_json = NULL WHERE state <> 'completed';");
    stage.exec("UPDATE managed_export SET outbox_state = 'paused', outbox_owner = NULL, outbox_lease_until = NULL, outbox_next_at = NULL, outbox_fence = outbox_fence + 1, outbox_last_error = 'restore_quarantine', updated_at = updated_at WHERE outbox_state <> 'paused';");
    stage.exec("UPDATE runtime_artifact SET state = CASE WHEN state = 'removed' THEN state ELSE 'ownership_uncertain' END, cleanup_owner = NULL, cleanup_lease_until = NULL, cleanup_fence = cleanup_fence + 1, cleanup_evidence_json = '{\"action\":\"restore_quarantine\"}' WHERE state <> 'removed';");
    stage.exec("UPDATE opencode_reconcile_scan SET state = 'invalidated', cursor_json = NULL, coverage_json = '{\"status\":\"coverage_gap\",\"reason\":\"restore_quarantine\"}' WHERE state = 'active';");
    stage.exec("DELETE FROM query_trace;");
    stage.exec("COMMIT");
    committed = true;
  } catch (error: unknown) {
    if (!committed) {
      try { stage.exec("ROLLBACK"); } catch { /* preserve primary */ }
    }
    if (error instanceof StoreError) throw error;
    throw new StoreError("restore_quarantined", error);
  }
}

function restoreMetadata(result: Omit<RestoreResult, "metadata_path">): string {
  return `${JSON.stringify({
    format: "agent-memory-restore",
    version: 1,
    status: result.status,
    backup_id: result.backup_id,
    schema_version: result.schema_version,
    authority_digest: result.authority_digest,
    quarantine_reasons: result.quarantine_reasons,
  }, null, 2)}\n`;
}

/** Maintenance primitive for a privileged owner of the actual current store.
 * An open DB proves consistency, not global freshness. The application must supply its
 * configured canonical store; request/model data must never select that authority.
 * The production boundary is OfflineRuntime.restoreBackup, which closes over its store.
 */
export async function restoreBackup(request: RestoreRequest, currentVault: AgentMemoryDatabase): Promise<RestoreResult> {
  const signal = request.signal;
  checkAborted(signal, "restore_aborted");
  const backupLayout = resolveReadLayout(request.backup_path);
  const livePath = ownedStorePath(currentVault);
  const targetPath = safePath(request.output_path, "restore-output-path");
  const metadataPath = `${targetPath}${RESTORE_METADATA_SUFFIX}`;
  const candidateManifestPath = `${targetPath}.manifest.json`;
  const candidateId = randomUUID();
  if (livePath === targetPath || realpathOrSelf(livePath) === realpathOrSelf(backupLayout.databasePath) || existsSync(targetPath) || existsSync(metadataPath) || existsSync(candidateManifestPath)) throw new StoreError("restore_target_exists");
  assertRegularFile(livePath, "restore_invalid");
  const outputParent = dirname(targetPath);
  try {
  if (!statSync(outputParent).isDirectory()) throw new StoreError("restore_invalid");
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("restore_invalid", error);
  }
  const manifest = readManifest(backupLayout);
  if (manifest.sqlite.vector_extension_required && request.vector_extension_path === undefined) throw new StoreError("restore_invalid");
  if (!manifest.sqlite.vector_extension_required && request.vector_extension_path !== undefined) throw new StoreError("restore_invalid");
  const backupDb = openDatabase(backupLayout.databasePath, true, request.vector_extension_path);
  qualifyExtension(backupDb, request.vector_extension_path, "restore_invalid");
  let liveDb: DatabaseSync | undefined;
  let stageDbPath: string | undefined;
  let stageStore: AgentMemoryDatabase | undefined;
  let liveLocked = false;
  let outputLinked = false;
  let metadataLinked = false;
  let candidateManifestLinked = false;
  try {
    const backupInspection = inspectDatabase(backupDb, true);
    const backupAuthority = authoritySnapshot(backupDb);
    if (
      sha256File(backupLayout.databasePath) !== manifest.database_sha256 ||
      statSync(backupLayout.databasePath).size !== manifest.database_size ||
      backupInspection.schema_version !== manifest.schema_version ||
      backupInspection.application_id !== manifest.application_id ||
      backupInspection.schema_digest !== manifest.schema_digest ||
      backupInspection.sqlite_version !== manifest.sqlite.version ||
      backupInspection.compile_options_digest !== manifest.sqlite.compile_options_digest ||
      backupInspection.vector_extension_required !== manifest.sqlite.vector_extension_required ||
      backupAuthority.journal_digest !== manifest.authority.journal_digest ||
      backupAuthority.scope_owner_digest !== manifest.scope_owner_digest ||
      backupAuthority.commit_seq !== manifest.authority.commit_seq ||
      backupAuthority.data_epoch !== manifest.authority.data_epoch ||
      backupAuthority.scopes.length !== manifest.authority.scope_count ||
      backupAuthority.operations.length !== manifest.authority.purge_operation_count ||
      backupAuthority.tombstones.length !== manifest.authority.purge_tombstone_count ||
      backupAuthority.native_tombstones.length !== manifest.authority.native_tombstone_count
    ) throw new StoreError("restore_invalid");
    if (backupInspection.vector_extension_required !== (request.vector_extension_path !== undefined)) throw new StoreError("restore_invalid");
    liveDb = openDatabase(livePath, false, request.vector_extension_path);
    qualifyExtension(liveDb, request.vector_extension_path, "restore_invalid");
    const liveInspection = inspectDatabase(liveDb);
    if (liveInspection.application_id !== manifest.application_id || liveInspection.sqlite_version !== manifest.sqlite.version || liveInspection.compile_options_digest !== manifest.sqlite.compile_options_digest || liveInspection.vector_extension_required !== manifest.sqlite.vector_extension_required) throw new StoreError("restore_authority_mismatch");
    stageDbPath = join(mkdtempSync(join(outputParent, `.restore-${candidateId}-`)), DATABASE_FILE_NAME);
    try { registerBackupIntent(liveDb, candidateId, authoritySnapshot(liveDb).scopes.map((scope) => scope.scope_id), [stageDbPath, join(dirname(stageDbPath), "restore.json"), join(dirname(stageDbPath), "manifest.json"), targetPath, metadataPath, candidateManifestPath]); } catch (error) { if (error instanceof StoreError) throw error; throw new StoreError("restore_busy", error); }
    try { liveDb.exec("BEGIN EXCLUSIVE"); } catch (error: unknown) { throw new StoreError("restore_busy", error); }
    liveLocked = true;
    const authority = authoritySnapshot(liveDb);
    const sourceBasis = snapshotBasis(liveDb);
    if (authority.scope_owner_digest !== manifest.scope_owner_digest) throw new StoreError("restore_authority_mismatch");
    let watermark = { commit_seq: backupAuthority.commit_seq, data_epoch: backupAuthority.data_epoch, scopes: backupAuthority.scopes.map((scope) => ({ scope_id: scope.scope_id, data_epoch: scope.data_epoch, privacy_epoch: scope.privacy_epoch })) };
    if (backupDb.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get()?.value === "awaiting_activation") {
      // Replay can advance local maintenance counters. Only a candidate whose exact
      // bytes remain registered by THIS owner may use its recorded original basis.
      assertManagedRestoreCandidate(liveDb, backupLayout.databasePath);
      const epoch = z.string().regex(/^[0-9]+$/u);
      watermark = z.object({ commit_seq: epoch, data_epoch: epoch, scopes: z.array(z.object({ scope_id: UUID, data_epoch: epoch, privacy_epoch: epoch }).strict()) }).strict().parse(JSON.parse(String(backupDb.prepare("SELECT value FROM schema_meta WHERE key = 'restore_origin'").get()?.value)));
    }
    if (BigInt(authority.commit_seq) < BigInt(watermark.commit_seq) || BigInt(authority.data_epoch) < BigInt(watermark.data_epoch)) throw new StoreError("restore_authority_mismatch");
    const liveScopes = new Map(authority.scopes.map((scope) => [scope.scope_id, scope]));
    for (const backupScope of watermark.scopes) {
      const liveScope = liveScopes.get(backupScope.scope_id);
      if (liveScope === undefined || BigInt(liveScope.data_epoch) < BigInt(backupScope.data_epoch) || BigInt(liveScope.privacy_epoch) < BigInt(backupScope.privacy_epoch)) throw new StoreError("restore_authority_mismatch");
    }
    if (request.owner_binding !== undefined) {
      if (request.owner_binding.length < 1 || request.owner_binding.length > 256 || sha256(request.owner_binding) !== manifest.owner_binding) throw new StoreError("restore_authority_mismatch");
    } else if (manifest.owner_binding_mode !== "scopes" || manifest.owner_binding !== manifest.scope_owner_digest) {
      throw new StoreError("restore_authority_mismatch");
    }
    await sqliteBackup(backupDb, stageDbPath, {
      progress: () => checkAborted(signal, "restore_aborted"),
    });
    checkAborted(signal, "restore_aborted");
    // The staged artifact is private and cannot be published or returned until all checks finish.
    const stageRaw = openDatabase(stageDbPath, false, request.vector_extension_path);
    try {
      stageRaw.exec("DELETE FROM schema_meta WHERE key = 'restore_state' OR key LIKE 'managed_backup:%';");
    } finally { stageRaw.close(); }
    const stageOptions = request.vector_extension_path === undefined ? {} : { vector_extension_path: request.vector_extension_path };
    // The same constructor migration engine supports legacy recovery; this is not old-binary rollback.
    stageStore = new AgentMemoryDatabase(stageDbPath, stageOptions);
    stageStore.close();
    stageStore = undefined;
    const migratedRaw = openDatabase(stageDbPath, false, request.vector_extension_path);
    try {
      qualifyExtension(migratedRaw, request.vector_extension_path, "restore_invalid");
      if (inspectDatabase(migratedRaw).schema_digest !== liveInspection.schema_digest) throw new StoreError("restore_authority_mismatch");
      applyAuthorityOverlay(migratedRaw, authority);
    } finally { migratedRaw.close(); }
    stageStore = new AgentMemoryDatabase(stageDbPath, stageOptions);
    const operationResults: Array<{ readonly state: string; readonly pending: readonly string[] }> = [];
    for (const operation of authority.operations) {
      checkAborted(signal, "restore_aborted");
      const captures = authority.tombstones.filter((row) => row.operation_id === operation.operation_id).map((row) => row.capture_id);
      const policy = createPolicySetupBinding({ version: 1, setup_id: randomUUID(), allowed_scope_ids: [operation.scope_id], allowed_output_targets: ["local_ui"] });
      const result = await fullPurge(stageStore, policy, {
        version: 1,
        operation_id: operation.operation_id,
        scope_id: operation.scope_id,
        capture_ids: captures,
        expected_privacy_epoch: operation.expected_privacy_epoch,
        requested_at: operation.updated_at,
      }, { runtime_cleanup_worker: quarantineCleanupWorker });
      operationResults.push({ state: result.state, pending: result.pending });
    }
    stageStore.close();
    stageStore = undefined;
    const finalRaw = openDatabase(stageDbPath, false, request.vector_extension_path);
    qualifyExtension(finalRaw, request.vector_extension_path, "restore_invalid");
    let reasons: string[] = [];
    let finalAuthority: AuthoritySnapshot;
    let finalInspection: VaultInspection;
    try {
      applyQuarantineState(finalRaw);
      for (const result of operationResults) reasons.push(...result.pending);
      const pendingRuntime = finalRaw.prepare("SELECT 1 FROM runtime_artifact WHERE state <> 'removed' LIMIT 1").get();
      if (pendingRuntime !== undefined) reasons.push("runtime_cleanup_pending");
      const pendingExports = finalRaw.prepare("SELECT 1 FROM managed_export WHERE state <> 'revoked' LIMIT 1").get();
      if (pendingExports !== undefined) reasons.push("managed_export_cleanup_pending");
      const pendingAuth = finalRaw.prepare("SELECT 1 FROM auth_operations WHERE state = 'pending' UNION ALL SELECT 1 FROM auth_registry WHERE state IN ('provisioning', 'refreshing', 'cleanup_pending') LIMIT 1").get();
      if (pendingAuth !== undefined) reasons.push("auth_recovery_pending");
      reasons = [...new Set(reasons)].sort();
      for (const tombstone of authority.tombstones) {
        if (finalRaw.prepare("SELECT 1 FROM source_event WHERE scope_id = ? AND capture_id = ?").get(tombstone.scope_id, tombstone.capture_id) !== undefined) reasons.push("purge_authority_pending");
      }
      if (reasons.length > 0) reasons = [...new Set(reasons)].sort();
      finalInspection = inspectDatabase(finalRaw);
      if (finalInspection.schema_digest !== liveInspection.schema_digest || finalInspection.vector_extension_required !== manifest.sqlite.vector_extension_required) throw new StoreError("restore_authority_mismatch");
      finalRaw.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_state', ?)").run(reasons.length === 0 ? "awaiting_activation" : "quarantined");
      finalRaw.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_origin', ?)").run(JSON.stringify({ commit_seq: authority.commit_seq, data_epoch: authority.data_epoch, scopes: authority.scopes.map((scope) => ({ scope_id: scope.scope_id, data_epoch: scope.data_epoch, privacy_epoch: scope.privacy_epoch })) }));
      finalAuthority = authoritySnapshot(finalRaw);
      readIntegrity(finalRaw, "restore_authority_mismatch");
      finalRaw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { finalRaw.close(); }
    const status: RestoreResult["status"] = reasons.length === 0 ? "awaiting_activation" : "quarantined";
    const resultWithoutMetadata: Omit<RestoreResult, "metadata_path"> = {
      status,
      output_path: targetPath,
      backup_id: manifest.backup_id,
      schema_version: CURRENT_SCHEMA_VERSION,
      authority_digest: authority.journal_digest,
      quarantine_reasons: reasons,
      source_basis_sha256: sourceBasis,
    };
    if (existsSync(metadataPath)) throw new StoreError("restore_target_exists");
    const stageDirectory = dirname(stageDbPath);
    const metadataTemp = join(stageDirectory, "restore.json");
    writeExclusiveFile(metadataTemp, restoreMetadata(resultWithoutMetadata));
    fsyncFile(stageDbPath);
    const candidateManifestTemp = join(stageDirectory, "manifest.json");
    const candidateManifest = authorityManifest(finalAuthority!, finalInspection!, finalAuthority!.scope_owner_digest, "scopes", targetPath, new Date().toISOString(), sha256File(stageDbPath), statSync(stageDbPath).size);
    writeExclusiveFile(candidateManifestTemp, `${JSON.stringify(candidateManifest, null, 2)}\n`);
    linkNoClobber(stageDbPath, targetPath);
    outputLinked = true;
    unlinkSync(stageDbPath);
    chmodSync(targetPath, 0o600);
    linkNoClobber(metadataTemp, metadataPath);
    metadataLinked = true;
    unlinkSync(metadataTemp);
    linkNoClobber(candidateManifestTemp, candidateManifestPath);
    candidateManifestLinked = true;
    unlinkSync(candidateManifestTemp);
    fsyncDirectory(outputParent);
    finishBackupRegistration(liveDb, candidateId);
    backupDb.close();
    liveDb.exec("COMMIT");
    liveLocked = false;
    return { ...resultWithoutMetadata, metadata_path: metadataPath };
  } catch (error: unknown) {
    if (stageStore !== undefined) {
      try { stageStore.close(); } catch { /* preserve primary */ }
    }
    if (liveDb !== undefined && liveLocked) {
      try { liveDb.exec("ROLLBACK"); } catch { /* preserve primary */ }
    }
    if (outputLinked) {
      try { unlinkSync(targetPath); } catch { /* preserve primary */ }
    }
    if (metadataLinked) {
      try { unlinkSync(metadataPath); } catch { /* preserve primary */ }
    }
    if (candidateManifestLinked) cleanupPath(candidateManifestPath);
    if (stageDbPath !== undefined) cleanupPath(dirname(stageDbPath));
    if (error instanceof StoreError) throw error;
    if (signal?.aborted === true) throw new StoreError("restore_aborted", error);
    throw new StoreError("restore_invalid", error);
  } finally {
    try { backupDb.close(); } catch { /* preserve primary */ }
    if (liveDb !== undefined) {
      try { liveDb.close(); } catch { /* preserve primary */ }
    }
  }
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

const handoffSchema = z.object({
  version: z.literal(1), operation_id: UUID, canonical_path: z.string(),
  stage_path: z.string(), stage_dev: z.string(), stage_ino: z.string(),
  stage_root_dev: z.string(), stage_root_ino: z.string(),
  original_dev: z.string(), original_ino: z.string(),
  stage_hash: HASH.optional(), backup_path: z.string(),
}).strict();

export interface ActivatedRestoreResult { readonly vault_path: string; readonly backup_path: string; }

/** Resume only the configured owner's durable handoff; not a general force-open API. */
export function resumeRestoreActivation(vaultPath: string, options: Pick<RestoreOptions, "signal" | "vector_extension_path"> = {}): void {
  const path = safePath(vaultPath, "activation-vault");
  if (!existsSync(path)) throw new StoreError("restore_quarantined");
  let database: DatabaseSync | undefined = openDatabase(path, false, options.vector_extension_path);
  let installed = false;
  let cleanup: { path: string; dev: string; ino: string } | undefined;
  try {
    qualifyExtension(database, options.vector_extension_path, "restore_invalid");
    const state = database.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get()?.value;
    if (state !== "retired" && state !== "activating") return;
    assertRegularFile(path, "restore_invalid");
    inspectDatabase(database);
    const handoff = handoffSchema.parse(JSON.parse(String(database.prepare("SELECT value FROM schema_meta WHERE key = 'restore_handoff'").get()?.value)));
    const stageRoot = join(dirname(path), `.activation-${handoff.operation_id}`);
    if (handoff.canonical_path !== path || handoff.stage_path !== join(stageRoot, DATABASE_FILE_NAME) || handoff.backup_path !== join(dirname(path), `.restore-original-${handoff.operation_id}`)) throw new StoreError("restore_quarantined");
    assertNoSymlinkAncestors(stageRoot);
    const root = lstatSync(stageRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(stageRoot) !== stageRoot || String(root.dev) !== handoff.stage_root_dev || String(root.ino) !== handoff.stage_root_ino) throw new StoreError("restore_quarantined");
    const info = statSync(path);
    database.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
    if (state === "retired") {
      if (String(info.dev) !== handoff.original_dev || String(info.ino) !== handoff.original_ino || handoff.stage_hash === undefined) throw new StoreError("restore_quarantined");
      assertRegularFile(handoff.stage_path, "restore_invalid");
      const stage = statSync(handoff.stage_path);
      if (String(stage.dev) !== handoff.stage_dev || String(stage.ino) !== handoff.stage_ino || sha256File(handoff.stage_path) !== handoff.stage_hash) throw new StoreError("restore_quarantined");
      // Old inode stays locked/retired while atomic replacement installs the blocked new inode.
      renameSync(handoff.stage_path, path);
      fsyncDirectory(dirname(path));
      installed = true;
    } else {
      if (String(info.dev) !== handoff.stage_dev || String(info.ino) !== handoff.stage_ino) throw new StoreError("restore_quarantined");
      database.exec("DELETE FROM schema_meta WHERE key IN ('restore_state', 'restore_handoff'); COMMIT");
      cleanup = { path: stageRoot, dev: handoff.stage_root_dev, ino: handoff.stage_root_ino };
    }
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("restore_quarantined", error);
  } finally { database.close(); database = undefined; }
  if (installed) resumeRestoreActivation(path, options);
  else {
    fsyncFile(path);
    if (cleanup !== undefined) removeOwnedPath(dirname(cleanup.path), basename(cleanup.path), cleanup);
  }
}

/** The owning runtime must stop dispatches and close its DB/readers before calling this. */
export async function activateRestore(stagedPath: string, canonicalPath: string, options: Pick<RestoreOptions, "signal" | "vector_extension_path"> = {}): Promise<ActivatedRestoreResult> {
  checkAborted(options.signal, "restore_aborted");
  const path = safePath(canonicalPath, "activation-vault");
  const candidate = safePath(stagedPath, "activation-candidate");
  resumeRestoreActivation(path, options);
  const operationId = randomUUID();
  const stageRoot = join(dirname(path), `.activation-${operationId}`);
  mkdirSync(stageRoot, { mode: 0o700 });
  const createdRoot = statSync(stageRoot);
  const stagePath = join(stageRoot, DATABASE_FILE_NAME);
  const backupPath = join(dirname(path), `.restore-original-${operationId}`);
  const owner = new AgentMemoryDatabase(path, options.vector_extension_path === undefined ? {} : { vector_extension_path: options.vector_extension_path });
  let refreshed: RestoreResult;
  try {
    const raw = openDatabase(path, true);
    try { assertManagedRestoreCandidate(raw, candidate); } finally { raw.close(); }
    const candidateRaw = openDatabase(candidate, true);
    try {
      if (candidateRaw.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get()?.value !== "awaiting_activation") throw new StoreError("restore_quarantined");
    } finally { candidateRaw.close(); }
    refreshed = await restoreBackup({ ...options, backup_path: candidate, output_path: stagePath }, owner);
    if (refreshed.status !== "awaiting_activation") throw new StoreError("restore_quarantined");
    await createBackup(owner, backupPath, options);
    checkAborted(options.signal, "restore_aborted");
  } finally { owner.close(); }
  const source = openDatabase(path, false, options.vector_extension_path);
  qualifyExtension(source, options.vector_extension_path, "restore_invalid");
  let sourceRetired = false;
  try {
    // DELETE mode refuses live WAL users. Existing readers/writers must drain,
    // and no old WAL/SHM can be accidentally attached to the replacement inode.
    try { source.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE"); }
    catch (error) { throw new StoreError("restore_busy", error); }
    if (snapshotBasis(source) !== refreshed.source_basis_sha256) throw new StoreError("restore_busy");
    checkAborted(options.signal, "restore_aborted");
    const stage = openDatabase(stagePath, false, options.vector_extension_path);
    qualifyExtension(stage, options.vector_extension_path, "restore_invalid");
    const stageInfo = statSync(stagePath);
    const original = statSync(path);
    const root = statSync(stageRoot);
    const handoff = { version: 1 as const, operation_id: operationId, canonical_path: path, stage_path: stagePath, stage_dev: String(stageInfo.dev), stage_ino: String(stageInfo.ino), stage_root_dev: String(root.dev), stage_root_ino: String(root.ino), original_dev: String(original.dev), original_ino: String(original.ino), backup_path: backupPath };
    try {
      stage.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
      transferBackupInventory(source, stage, path, stagePath);
      stage.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_handoff', ?)").run(JSON.stringify(handoff));
      stage.exec("UPDATE schema_meta SET value = 'activating' WHERE key = 'restore_state'; COMMIT");
      readIntegrity(stage, "restore_invalid");
    } finally { stage.close(); }
    fsyncFile(stagePath);
    fsyncDirectory(stageRoot);
    fsyncDirectory(dirname(path));
    checkAborted(options.signal, "restore_aborted");
    source.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_handoff', ?)").run(JSON.stringify({ ...handoff, stage_hash: sha256File(stagePath) }));
    source.exec("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('restore_state', 'retired'); COMMIT");
    sourceRetired = true;
  } finally {
    if (!sourceRetired && source.isTransaction) source.exec("ROLLBACK");
    const pendingHandoff = source.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get()?.value === "retired";
    source.close();
    if (!sourceRetired && !pendingHandoff) removeOwnedPath(dirname(stageRoot), basename(stageRoot), { dev: String(createdRoot.dev), ino: String(createdRoot.ino) });
  }
  fsyncFile(path);
  resumeRestoreActivation(path, options);
  return { vault_path: path, backup_path: backupPath };
}
