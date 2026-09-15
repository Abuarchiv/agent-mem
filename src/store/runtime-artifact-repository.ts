import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { parseContract } from "../host/contract.js";
import { StoreError } from "./errors.js";
import { removeOwnedPath, type OwnedPathRemoval } from "../execution/owned-path.js";

const uuid = z.uuid();
const id = z.string().min(1).max(256);
const digestPath = z.string().min(1).max(2048);
const kind = z.enum(["runtime_root", "session", "file", "log", "input", "output", "backup"]);
const state = z.enum(["planned", "present", "cleanup_pending", "removed", "ownership_uncertain"]);
const date = z.iso.datetime({ offset: true });

export type RuntimeArtifactKind = z.infer<typeof kind>;
export type RuntimeArtifactState = z.infer<typeof state>;

export interface RuntimeArtifactRecord {
  readonly version: 1;
  readonly artifact_id: string;
  readonly attempt_id: string;
  readonly batch_id: string;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly profile_id: string;
  readonly account_ref: string;
  readonly kind: RuntimeArtifactKind;
  readonly trusted_root: string;
  readonly trusted_root_identity: { readonly dev: string; readonly ino: string; readonly mode: number };
  readonly relative_path: string | null;
  readonly native_session_id: string | null;
  readonly ownership_evidence: { readonly target_dev?: string; readonly target_ino?: string; readonly target_mode?: number; readonly creation_attempted?: boolean };
  readonly state: RuntimeArtifactState;
  readonly cleanup_evidence: { readonly action: string; readonly observed_at: string } | null;
  readonly execution_close_state: "unknown" | "confirmed";
  readonly execution_closed_at: string | null;
  readonly cleanup_fence: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RegisterRuntimeArtifactInput {
  readonly artifact_id?: string;
  readonly attempt_id: string;
  readonly batch_id: string;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly profile_id: string;
  readonly account_ref: string;
  readonly kind: RuntimeArtifactKind;
  readonly trusted_root: string;
  readonly relative_path?: string;
  readonly native_session_id?: string;
}

export interface NativeSessionRemover {
  readonly deleteSession: (sessionId: string) => Promise<boolean>;
}

type CleanupClaim = { readonly fence: bigint; readonly lease: string };

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) throw new StoreError("read_failed");
  return (row as Record<string, unknown>)[field];
}

function text(row: unknown, field: string): string {
  const value = rowValue(row, field);
  if (typeof value !== "string") throw new StoreError("read_failed");
  return value;
}

function nullableText(row: unknown, field: string): string | null {
  const value = rowValue(row, field);
  return value === null ? null : text(row, field);
}

function json<T>(row: unknown, field: string): T {
  try { return JSON.parse(text(row, field)) as T; } catch (error) { throw new StoreError("read_failed", error); }
}

function identity(path: string): { readonly dev: string; readonly ino: string; readonly mode: number } {
  const info = lstatSync(path);
  return { dev: String(info.dev), ino: String(info.ino), mode: info.mode };
}

function assertNoSymlinkParent(root: string, relativePath: string): void {
  let current = root;
  const parts = relativePath.split("/");
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(current); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("ownership_uncertain");
  }
}

function privateRoot(input: string): string {
  if (!isAbsolute(input) || input === "/") throw new StoreError("attempt_invalid");
  let root: string;
  try { root = realpathSync(input); } catch (error) { throw new StoreError("attempt_invalid", error); }
  const info = statSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new StoreError("attempt_invalid");
  return root;
}

function safeRelative(input: string | undefined, native: string | undefined): string | null {
  if (native !== undefined) {
    if (input !== undefined) throw new StoreError("attempt_invalid");
    return null;
  }
  if (input === undefined || input.length === 0 || isAbsolute(input)) throw new StoreError("attempt_invalid");
  const normalized = input.replaceAll("\\", "/");
  if (normalized === "." || normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")) throw new StoreError("attempt_invalid");
  return normalized;
}

function parseRecord(row: unknown): RuntimeArtifactRecord {
  const rootIdentity = json<RuntimeArtifactRecord["trusted_root_identity"]>(row, "trusted_root_identity_json");
  const ownership = json<RuntimeArtifactRecord["ownership_evidence"]>(row, "ownership_evidence_json");
  const cleanupRaw = nullableText(row, "cleanup_evidence_json");
  const cleanup = cleanupRaw === null ? null : (() => { try { return JSON.parse(cleanupRaw) as RuntimeArtifactRecord["cleanup_evidence"]; } catch (error) { throw new StoreError("read_failed", error); } })();
  if (!uuid.safeParse(text(row, "artifact_id")).success || !uuid.safeParse(text(row, "attempt_id")).success) throw new StoreError("attempt_invalid");
  return {
    version: 1,
    artifact_id: text(row, "artifact_id"),
    attempt_id: text(row, "attempt_id"), batch_id: text(row, "batch_id"), job_id: text(row, "job_id"),
    scope_id: text(row, "scope_id"), source_capture_id: text(row, "source_capture_id"),
    profile_id: text(row, "profile_id"), account_ref: text(row, "account_ref"),
    kind: kind.parse(rowValue(row, "kind")), trusted_root: text(row, "trusted_root"),
    trusted_root_identity: rootIdentity,
    relative_path: nullableText(row, "relative_path"), native_session_id: nullableText(row, "native_session_id"),
    ownership_evidence: ownership, state: state.parse(rowValue(row, "state")), cleanup_evidence: cleanup,
    execution_close_state: z.enum(["unknown", "confirmed"]).parse(rowValue(row, "execution_close_state")),
    execution_closed_at: nullableText(row, "execution_closed_at"),
    cleanup_fence: String(rowValue(row, "cleanup_fence")),
    created_at: date.parse(text(row, "created_at")), updated_at: date.parse(text(row, "updated_at")),
  };
}

export class RuntimeArtifactRepository {
  private readonly owner = randomUUID();
  private readonly leaseMs = 10_000;

  constructor(private readonly database: DatabaseSync, private readonly ensureOpen: () => void) {}


  register(input: RegisterRuntimeArtifactInput, now = new Date().toISOString()): RuntimeArtifactRecord {
    this.ensureOpen();
    for (const [value, field] of [[input.attempt_id, "attempt-id"], [input.batch_id, "batch-id"], [input.job_id, "job-id"], [input.scope_id, "scope-id"], [input.source_capture_id, "source-capture-id"]] as const) parseContract(uuid, value, field);
    const root = privateRoot(parseContract(digestPath, input.trusted_root, "runtime-root"));
    const relativePath = safeRelative(input.relative_path, input.native_session_id);
    if (relativePath !== null) {
      try {
        assertNoSymlinkParent(root, relativePath);
        const existingTarget = resolve(root, relativePath);
        try { if (lstatSync(existingTarget).isSymbolicLink()) throw new Error("symlink_target"); } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      } catch (error) { throw new StoreError("attempt_invalid", error); }
    }
    const parsedKind = kind.parse(input.kind);
    if (parsedKind === "session" && input.native_session_id === undefined) throw new StoreError("attempt_invalid");
    if (parsedKind !== "session" && input.native_session_id !== undefined) throw new StoreError("attempt_invalid");
    const artifactId = parseContract(uuid, input.artifact_id ?? randomUUID(), "artifact-id");
    const rootIdentity = identity(root);
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM runtime_artifact WHERE artifact_id = ?").get(artifactId);
      if (existing !== undefined) {
        const current = parseRecord(existing);
        if (
          current.attempt_id !== input.attempt_id || current.batch_id !== input.batch_id || current.job_id !== input.job_id ||
          current.scope_id !== input.scope_id || current.source_capture_id !== input.source_capture_id || current.kind !== parsedKind ||
          current.trusted_root !== root || current.relative_path !== relativePath || current.native_session_id !== (input.native_session_id ?? null)
        ) throw new StoreError("attempt_conflict");
        return current;
      }
      this.database.prepare(
        `INSERT INTO runtime_artifact (
          artifact_id, attempt_id, batch_id, job_id, scope_id, source_capture_id, profile_id, account_ref,
          kind, trusted_root, trusted_root_identity_json, relative_path, native_session_id,
          ownership_evidence_json, state, cleanup_evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        artifactId, input.attempt_id, input.batch_id, input.job_id, input.scope_id, input.source_capture_id,
        id.parse(input.profile_id), id.parse(input.account_ref), parsedKind, root,
        JSON.stringify(rootIdentity), relativePath, input.native_session_id ?? null,
        "{}", input.native_session_id === undefined ? "planned" : "present", now, now,
      );
      return this.require(artifactId);
    });
  }

  get(artifactId: string): RuntimeArtifactRecord | undefined {
    this.ensureOpen();
    const row = this.database.prepare("SELECT * FROM runtime_artifact WHERE artifact_id = ?").get(parseContract(uuid, artifactId, "artifact-id"));
    return row === undefined ? undefined : parseRecord(row);
  }

  listForAttempt(attemptId: string): readonly RuntimeArtifactRecord[] {
    this.ensureOpen();
    return this.database.prepare("SELECT * FROM runtime_artifact WHERE attempt_id = ? ORDER BY created_at, artifact_id").all(parseContract(uuid, attemptId, "attempt-id")).map(parseRecord);
  }

  listForSource(scopeId: string, sourceCaptureIds: readonly string[]): readonly RuntimeArtifactRecord[] {
    this.ensureOpen();
    if (sourceCaptureIds.length === 0) return [];
    const placeholders = sourceCaptureIds.map(() => "?").join(",");
    return this.database.prepare(`SELECT * FROM runtime_artifact WHERE scope_id = ? AND (source_capture_id IN (${placeholders}) OR batch_id IN
      (SELECT value FROM purge_operation p, json_each(p.cleanup_batch_ids_json) WHERE p.scope_id = ? AND EXISTS
        (SELECT 1 FROM purge_tombstone t WHERE t.operation_id = p.operation_id AND t.capture_id IN (${placeholders})))) ORDER BY created_at, artifact_id`).all(scopeId, ...sourceCaptureIds, scopeId, ...sourceCaptureIds).map(parseRecord);
  }

  listPending(): readonly RuntimeArtifactRecord[] {
    this.ensureOpen();
    return this.database
      .prepare("SELECT * FROM runtime_artifact WHERE state IN ('planned', 'present', 'cleanup_pending', 'ownership_uncertain') ORDER BY updated_at, artifact_id")
      .all()
      .map(parseRecord);
  }

  markPresent(artifactId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.native_session_id !== null) throw new StoreError("attempt_invalid");
    if (current.state === "present") return current;
    if (current.state !== "planned") throw new StoreError("attempt_conflict");
    const claim = this.claim(current.artifact_id);
    if (claim === undefined) throw new StoreError("attempt_conflict");
    const target = this.target(current);
    let targetIdentity: ReturnType<typeof identity>;
    try {
      assertNoSymlinkParent(current.trusted_root, current.relative_path ?? "");
      targetIdentity = identity(target);
    } catch (error) { throw new StoreError("attempt_invalid", error); }
    if (targetIdentity.mode & 0o077) throw new StoreError("attempt_invalid");
    return this.update(current.artifact_id, "present", { target_dev: targetIdentity.dev, target_ino: targetIdentity.ino, target_mode: targetIdentity.mode, action: "present" }, claim);
  }

  markCreationAttempted(artifactId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.kind !== "runtime_root" || current.state !== "planned") throw new StoreError("attempt_conflict");
    const claim = this.claim(artifactId);
    if (claim === undefined) throw new StoreError("attempt_conflict");
    return this.update(artifactId, "planned", { action: "creation_attempted", creation_attempted: true }, claim);
  }

  observeNativeSession(artifactId: string, nativeSessionId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.kind !== "session" || current.native_session_id !== null || current.relative_path !== null) throw new StoreError("attempt_conflict");
    const sessionId = parseContract(id, nativeSessionId, "native-session-id");
    const claim = this.claim(current.artifact_id);
    if (claim === undefined) throw new StoreError("attempt_conflict");
    return this.update(current.artifact_id, "present", { action: "session_observed", native_session_id: sessionId }, claim);
  }

  confirmNativeRemoved(artifactId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.kind !== "session" || current.native_session_id === null || current.state !== "present") throw new StoreError("attempt_conflict");
    const claim = this.claim(current.artifact_id);
    if (claim === undefined) throw new StoreError("attempt_conflict");
    return this.update(current.artifact_id, "removed", { action: "native_deleted" }, claim);
  }

  confirmExecutionClosed(artifactId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.kind !== "runtime_root" || (current.state !== "present" && current.state !== "cleanup_pending")) throw new StoreError("attempt_conflict");
    const claim = this.claim(artifactId);
    if (claim === undefined) throw new StoreError("attempt_conflict");
    return this.update(artifactId, current.state, { action: "execution_closed" }, claim, true);
  }

  async reconcile(artifactId: string, remover?: NativeSessionRemover): Promise<RuntimeArtifactRecord> {
    const current = this.require(artifactId);
    if (current.state === "removed") return current;
    const claim = this.claim(current.artifact_id);
    if (claim === undefined) return current;
    if (current.state === "planned" && current.ownership_evidence.creation_attempted !== true && current.relative_path !== null) {
      try { lstatSync(this.target(current)); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.update(current.artifact_id, "removed", { action: "planned_absence_verified" }, claim);
      }
    }
    if (!this.attemptCleanupReady(current.attempt_id)) return this.update(current.artifact_id, "cleanup_pending", { action: "execution_not_ended" }, claim);
    if (current.native_session_id !== null) {
      if (remover === undefined) return this.update(current.artifact_id, "cleanup_pending", { action: "native_delete_unavailable" }, claim);
      try {
        if (await this.withTimeout(remover.deleteSession(current.native_session_id), 2_000)) return this.update(current.artifact_id, "removed", { action: "native_deleted" }, claim);
      } catch { /* durable pending state below */ }
      return this.update(current.artifact_id, "cleanup_pending", { action: "native_delete_failed" }, claim);
    }
    return this.reconcilePath(current, claim);
  }

  reconcileSync(artifactId: string): RuntimeArtifactRecord {
    const current = this.require(artifactId);
    if (current.state === "removed") return current;
    const claim = this.claim(current.artifact_id);
    if (claim === undefined) return current;
    if (current.state === "planned" && current.ownership_evidence.creation_attempted !== true && current.relative_path !== null) {
      try { lstatSync(this.target(current)); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.update(current.artifact_id, "removed", { action: "planned_absence_verified" }, claim);
      }
    }
    if (!this.attemptCleanupReady(current.attempt_id)) return this.update(current.artifact_id, "cleanup_pending", { action: "execution_not_ended" }, claim);
    if (current.native_session_id !== null) return this.update(current.artifact_id, "cleanup_pending", { action: "native_delete_requires_transport" }, claim);
    return this.reconcilePath(current, claim);
  }

  private reconcilePath(current: RuntimeArtifactRecord, claim: CleanupClaim): RuntimeArtifactRecord {
    const target = this.target(current);
    try {
      try { assertNoSymlinkParent(current.trusted_root, current.relative_path ?? ""); }
      catch { return this.update(current.artifact_id, "ownership_uncertain", { action: "symlink_parent" }, claim); }
      const rootIdentity = identity(current.trusted_root);
      if (JSON.stringify(rootIdentity) !== JSON.stringify(current.trusted_root_identity)) return this.update(current.artifact_id, "ownership_uncertain", { action: "root_identity_changed" }, claim);
      let targetIdentity: ReturnType<typeof identity>;
      try {
        lstatSync(target);
        targetIdentity = identity(target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return this.update(current.artifact_id, "removed", { action: "absence_verified" }, claim);
        return this.update(current.artifact_id, "cleanup_pending", { action: "stat_failed" }, claim);
      }
      if (targetIdentity.mode & 0o077) return this.update(current.artifact_id, "ownership_uncertain", { action: "target_not_private" }, claim);
      if ((current.state !== "present" && current.state !== "cleanup_pending") || current.ownership_evidence.target_ino !== String(targetIdentity.ino) || current.ownership_evidence.target_dev !== String(targetIdentity.dev)) {
        return this.update(current.artifact_id, "ownership_uncertain", { action: "target_identity_mismatch" }, claim);
      }
      const removal: OwnedPathRemoval = removeOwnedPath(current.trusted_root, current.relative_path ?? "", {
        dev: String(targetIdentity.dev), ino: String(targetIdentity.ino),
      });
      if (removal === "removed" || removal === "missing") return this.update(current.artifact_id, "removed", { action: removal === "removed" ? "files_deleted" : "absence_verified" }, claim);
      if (removal === "ownership_uncertain") return this.update(current.artifact_id, "ownership_uncertain", { action: "target_identity_changed" }, claim);
      return this.update(current.artifact_id, "cleanup_pending", { action: "delete_failed" }, claim);
    } catch { return this.update(current.artifact_id, "cleanup_pending", { action: "delete_failed" }, claim); }
  }

  async reconcileSource(scopeId: string, sourceCaptureIds: readonly string[], remover?: NativeSessionRemover): Promise<boolean> {
    const artifacts = this.listForSource(scopeId, sourceCaptureIds);
    for (const artifact of artifacts) await this.reconcile(artifact.artifact_id, remover);
    return this.listForSource(scopeId, sourceCaptureIds).every((artifact) => artifact.state === "removed");
  }

  reconcileSourceSync(scopeId: string, sourceCaptureIds: readonly string[]): boolean {
    const artifacts = this.listForSource(scopeId, sourceCaptureIds);
    for (const artifact of artifacts) {
      const attempt = this.database.prepare("SELECT state, terminal_at FROM execution_attempt WHERE attempt_id = ?").get(artifact.attempt_id);
      if (attempt !== undefined) {
        const attemptState = text(attempt, "state");
        const terminalAt = nullableText(attempt, "terminal_at");
        if (!(attemptState === "terminal_observed" || attemptState === "reconciled" || attemptState === "failed" || attemptState === "aborted" || (attemptState === "cleanup_pending" && terminalAt !== null))) continue;
      }
      this.reconcileSync(artifact.artifact_id);
    }
    return this.listForSource(scopeId, sourceCaptureIds).every((artifact) => artifact.state === "removed");
  }

  countPending(): number {
    this.ensureOpen();
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM runtime_artifact WHERE state IN ('planned', 'present', 'cleanup_pending', 'ownership_uncertain')").get();
    return Number(rowValue(row, "count"));
  }

  private target(record: RuntimeArtifactRecord): string {
    if (record.relative_path === null) throw new StoreError("attempt_invalid");
    const path = resolve(record.trusted_root, record.relative_path);
    const rel = relative(record.trusted_root, path);
    if (rel !== record.relative_path || rel.startsWith("..") || isAbsolute(rel)) throw new StoreError("attempt_invalid");
    return path;
  }

  private attemptCleanupReady(attemptId: string): boolean {
    const row = this.database.prepare("SELECT state, terminal_at FROM execution_attempt WHERE attempt_id = ?").get(attemptId);
    if (row === undefined) return false;
    const attemptState = text(row, "state");
    const terminalAt = nullableText(row, "terminal_at");
    const root = this.database.prepare("SELECT execution_close_state FROM runtime_artifact WHERE attempt_id = ? AND kind = 'runtime_root' LIMIT 1").get(attemptId);
    return (attemptState === "terminal_observed" || attemptState === "reconciled" || attemptState === "failed" || attemptState === "aborted" || (attemptState === "cleanup_pending" && terminalAt !== null)) && root !== undefined && text(root, "execution_close_state") === "confirmed";
  }

  private require(artifactId: string): RuntimeArtifactRecord {
    const row = this.database.prepare("SELECT * FROM runtime_artifact WHERE artifact_id = ?").get(parseContract(uuid, artifactId, "artifact-id"));
    if (row === undefined) throw new StoreError("attempt_not_found");
    return parseRecord(row);
  }

  private update(artifactId: string, nextState: RuntimeArtifactState, evidence: Record<string, unknown>, claim: CleanupClaim, close = false): RuntimeArtifactRecord {
    this.ensureOpen();
    const now = new Date().toISOString();
    const ownership = { ...evidence };
    delete ownership.action;
    delete ownership.native_session_id;
    return this.transaction(() => {
      const current = this.require(artifactId);
      const nativeSessionId = typeof evidence.native_session_id === "string" ? evidence.native_session_id : current.native_session_id;
      const updated = this.database.prepare("UPDATE runtime_artifact SET state = ?, native_session_id = ?, ownership_evidence_json = ?, cleanup_evidence_json = ?, execution_close_state = CASE WHEN ? THEN 'confirmed' ELSE execution_close_state END, execution_closed_at = CASE WHEN ? THEN ? ELSE execution_closed_at END, cleanup_owner = NULL, cleanup_lease_until = NULL, updated_at = ? WHERE artifact_id = ? AND cleanup_owner = ? AND cleanup_fence = ? AND cleanup_lease_until > ?").run(
        nextState, nativeSessionId, JSON.stringify({ ...current.ownership_evidence, ...ownership }), JSON.stringify({ action: String(evidence.action ?? "reconciled"), observed_at: now }), close ? 1 : 0, close ? 1 : 0, close ? now : null, now, artifactId, this.owner, claim.fence, now,
      );
      if (Number(updated.changes) !== 1) throw new StoreError("attempt_conflict");
      return this.require(artifactId);
    });
  }

  private claim(artifactId: string): CleanupClaim | undefined {
    const lease = new Date(Date.now() + this.leaseMs).toISOString();
    const updated = this.database.prepare(
      "UPDATE runtime_artifact SET cleanup_owner = ?, cleanup_lease_until = ?, cleanup_fence = cleanup_fence + 1 WHERE artifact_id = ? AND state IN ('planned', 'present', 'cleanup_pending', 'ownership_uncertain') AND (cleanup_owner IS NULL OR cleanup_lease_until <= ?)",
    ).run(this.owner, lease, artifactId, new Date().toISOString());
    if (Number(updated.changes) !== 1) return undefined;
    const row = this.database.prepare("SELECT cleanup_fence FROM runtime_artifact WHERE artifact_id = ? AND cleanup_owner = ? AND cleanup_lease_until = ?").get(artifactId, this.owner, lease);
    return row === undefined ? undefined : { fence: BigInt(rowValue(row, "cleanup_fence") as bigint | number), lease };
  }

  private async withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup_timeout")), milliseconds); timer.unref?.(); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve primary */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }
}
