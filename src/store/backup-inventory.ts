import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { removeOwnedPath } from "../runtime/owned-path.js";

const identity = z.object({ dev: z.string(), ino: z.string() }).strict();
const file = z.object({ path: z.string(), parent: identity, identity: identity.nullable(), hash: z.string().nullable() }).strict();
const entry = z.object({ owner_path: z.string(), owner: identity, scopes: z.array(z.string()), revoked: z.boolean(), files: z.array(file) }).strict();
const prefix = "managed_backup:";
export const fileHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
function pin(path: string): z.infer<typeof identity> {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error("backup_symlink");
  return { dev: String(info.dev), ino: String(info.ino) };
}
function same(a: z.infer<typeof identity>, b: z.infer<typeof identity>): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Complete logical recovery basis, excluding only the separately owned backup inventory.
 * ponytail: scans all logical rows; replace with a SQLite snapshot revision facility if vault size warrants it.
 */
export function snapshotBasis(database: DatabaseSync): string {
  const hash = createHash("sha256");
  const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? { bigint: String(item) } : item instanceof Uint8Array ? { bytes: Buffer.from(item).toString("hex") } : item);
  hash.update(encode(database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()));
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    const name = String(row.name);
    // Quoted identifiers come only from SQLite's schema, never a request.
    const where = name === "schema_meta" ? " WHERE key NOT LIKE 'managed_backup:%'" : "";
    const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"${where}`).all();
    hash.update(name).update(encode(rows.map(encode).sort()));
  }
  return hash.digest("hex");
}

/** Durable intent exists before any backup payload is written; crash residue stays a purge obligation. */
export function registerBackupIntent(database: DatabaseSync, id: string, scopes: readonly string[], paths: readonly string[]): void {
  const location = database.location();
  if (location === null || database.isTransaction) throw new Error("backup_owner_unavailable");
  const ownerPath = realpathSync(location);
  const value = { owner_path: ownerPath, owner: pin(ownerPath), scopes: [...scopes], revoked: false, files: paths.map((path) => ({ path, parent: pin(dirname(path)), identity: null, hash: null })) };
  database.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(prefix + id, JSON.stringify(value));
}

export interface RegisteredBackupFile {
  readonly path: string;
  readonly identity: { readonly dev: string; readonly ino: string };
  readonly hash: string;
}

export function finishBackupRegistration(database: DatabaseSync, id: string, ownedFiles?: readonly RegisteredBackupFile[]): void {
  const row = database.prepare("SELECT value FROM schema_meta WHERE key = ?").get(prefix + id);
  const value = entry.parse(JSON.parse(String(row?.value)));
  value.files = value.files.map((file) => {
    if (ownedFiles !== undefined) {
      // Transfer supplies identities obtained from its exclusively created fd.
      // Never adopt a path merely because it now exists after failed publication.
      const owned = ownedFiles.find((entry) => entry.path === file.path);
      return owned === undefined ? file : { ...file, identity: owned.identity, hash: owned.hash };
    }
    try { return { ...file, identity: pin(file.path), hash: fileHash(file.path) }; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return file; throw error; }
  });
  database.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run(JSON.stringify(value), prefix + id);
}

export function countManagedBackups(database: DatabaseSync, scopeId: string): number {
  return database.prepare("SELECT value FROM schema_meta WHERE key LIKE 'managed_backup:%'").all()
    .filter((row) => entry.parse(JSON.parse(String(row.value))).scopes.includes(scopeId)).length;
}

/** Shared source-purge lane. Whole affected backups are revoked; unrelated scopes do not preserve a mixed backup. */
export function purgeManagedBackups(database: DatabaseSync, scopeId: string): boolean {
  let complete = true;
  for (const row of database.prepare("SELECT key, value FROM schema_meta WHERE key LIKE 'managed_backup:%'").all()) {
    try {
      const value = entry.parse(JSON.parse(String(row.value)));
      if (!value.scopes.includes(scopeId)) continue;
      // Establish ownership from the open store BEFORE inspecting any archived file path.
      const location = database.location();
      if (location === null || realpathSync(location) !== value.owner_path || !same(pin(location), value.owner)) { complete = false; continue; }
      value.revoked = true;
      database.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run(JSON.stringify(value), String(row.key));
      let removed = true;
      for (const file of value.files) {
        // Pin the parent as well as target: renamed/replaced trees are never followed.
        try {
          if (realpathSync(dirname(file.path)) !== dirname(file.path) || !same(pin(dirname(file.path)), file.parent)) { removed = false; continue; }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          removed = false; continue;
        }
        try {
          pin(file.path);
          if (file.identity === null || file.hash === null || fileHash(file.path) !== file.hash) { removed = false; continue; }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          removed = false; continue;
        }
        const result = removeOwnedPath(dirname(file.path), basename(file.path), file.identity!);
        if (result !== "removed" && result !== "missing") removed = false;
      }
      if (removed) database.prepare("DELETE FROM schema_meta WHERE key = ?").run(String(row.key));
      else complete = false;
    } catch { complete = false; }
  }
  return complete;
}

/** Rebind only inventory proven to belong to the retiring canonical owner. */
export function transferBackupInventory(source: DatabaseSync, target: DatabaseSync, canonicalPath: string, installedInodePath: string): void {
  const ownerPath = realpathSync(canonicalPath);
  const owner = pin(ownerPath);
  const replacement = pin(installedInodePath);
  target.exec("DELETE FROM schema_meta WHERE key LIKE 'managed_backup:%'");
  for (const row of source.prepare("SELECT key, value FROM schema_meta WHERE key LIKE 'managed_backup:%'").all()) {
    const record = entry.parse(JSON.parse(String(row.value)));
    if (record.owner_path !== ownerPath || !same(record.owner, owner)) throw new Error("backup_inventory_owner_mismatch");
    // The promoted candidate becomes the primary store, never its own backup.
    if (record.files.some((file) => file.path === installedInodePath)) continue;
    record.owner_path = ownerPath;
    record.owner = replacement;
    target.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)").run(String(row.key), JSON.stringify(record));
  }
}

export function assertManagedRestoreCandidate(source: DatabaseSync, path: string): void {
  const location = source.location();
  if (location === null) throw new Error("restore_owner_unavailable");
  const ownerPath = realpathSync(location);
  const owner = pin(ownerPath);
  for (const row of source.prepare("SELECT value FROM schema_meta WHERE key LIKE 'managed_backup:%'").all()) {
    const record = entry.parse(JSON.parse(String(row.value)));
    if (record.owner_path !== ownerPath || !same(record.owner, owner) || record.revoked) continue;
    const file = record.files.find((file) => file.path === path);
    if (file === undefined) continue;
    if (file.identity === null || file.hash === null || !same(pin(dirname(path)), file.parent) || !same(pin(path), file.identity) || fileHash(path) !== file.hash) throw new Error("restore_candidate_changed");
    return;
  }
  throw new Error("restore_candidate_not_owned");
}
