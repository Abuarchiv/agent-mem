import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentMemoryDatabase } from "./database.js";
import { createBackup, type BackupOptions, type BackupResult } from "./backup.js";
import { StoreError } from "./errors.js";

export interface MigrationOptions extends BackupOptions {
  /** Optional destination for the pre-migration backup package. */
  readonly backup_path?: string;
}

export interface MigrationResult {
  readonly database: AgentMemoryDatabase;
  readonly backup: BackupResult;
  readonly schema_version: number;
}

/**
 * Snapshot, then revalidate the full logical basis under the existing migration
 * engine's exclusive write lock. An intervening committed write rejects migration
 * before any schema mutation. Failed/cancelled updates retain their checked backup.
 * Legacy recovery migrates a stage to this binary; old-binary rollback is unsupported.
 */
export async function migrateVault(vaultPath: string, options: MigrationOptions = {}): Promise<MigrationResult> {
  if (typeof vaultPath !== "string" || vaultPath.length === 0) throw new StoreError("schema_migration_failed");
  const backupPath = options.backup_path ?? join(mkdtempSync(join(tmpdir(), "agent-memory-migration-")), "backup");
  const backup = await createBackup(vaultPath, backupPath, options.allow_legacy_schema === undefined ? { ...options, allow_legacy_schema: true } : options);
  if (options.signal?.aborted === true) throw new StoreError("backup_aborted");
  const database = new AgentMemoryDatabase(vaultPath, { migration_basis_sha256: backup.source_basis_sha256, ...(options.vector_extension_path === undefined ? {} : { vector_extension_path: options.vector_extension_path }) });
  return { database, backup, schema_version: database.getSchemaVersion() };
}
