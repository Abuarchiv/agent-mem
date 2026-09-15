import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertPrivatePath } from "../v1/private-files.js";

export const SQLITE_VEC_VERSION = "v0.1.9" as const;
export const SQLITE_VEC_DARWIN_ARM64_SHA256 = "193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793" as const;
export const SQLITE_VEC_DIMENSIONS = 384 as const;

export type SqliteVecTarget = "darwin-arm64" | "linux-arm64" | "linux-x64" | "win32-x64";

const SQLITE_VEC_ASSETS: Readonly<Record<SqliteVecTarget, { readonly filename: string; readonly sha256: string }>> = Object.freeze({
  "darwin-arm64": { filename: "vec0.dylib", sha256: SQLITE_VEC_DARWIN_ARM64_SHA256 },
  "linux-arm64": { filename: "vec0.linux-arm64.so", sha256: "0b84cbd06418ca3040827deddd650539be05be0f657952426b926c8606217437" },
  "linux-x64": { filename: "vec0.linux-x64.so", sha256: "5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8" },
  "win32-x64": { filename: "vec0.win32-x64.dll", sha256: "fcf98662a7ad9dce394b96a88f91032047823831b951c76636787c312a6476e6" },
});

export function sqliteVecTarget(platform = process.platform, arch = process.arch): SqliteVecTarget {
  const target = `${platform}-${arch}` as SqliteVecTarget;
  if (!(target in SQLITE_VEC_ASSETS)) throw new Error("sqlite_vec_platform_unsupported");
  return target;
}

export function sqliteVecAssetFilename(platform = process.platform, arch = process.arch): string {
  return SQLITE_VEC_ASSETS[sqliteVecTarget(platform, arch)].filename;
}

export interface SqliteVecQualification {
  readonly version: typeof SQLITE_VEC_VERSION;
  readonly platform: SqliteVecTarget;
  readonly extension_path: string;
  readonly sha256: string;
  readonly authorized_rowid_in: true;
  readonly distance: number;
}

function hashExtension(path: string): string {
  const stats = statSync(path);
  if (!stats.isFile() || (process.platform !== "win32" && (stats.mode & 0o022) !== 0)) throw new Error("sqlite_vec_asset_invalid");
  if (process.platform === "win32") assertPrivatePath(path, stats, "sqlite_vec_asset_invalid", "asset");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function vectorLiteral(axis: number): string {
  return `[${Array.from({ length: SQLITE_VEC_DIMENSIONS }, (_, index) => index === axis ? "1" : "0").join(",")}]`;
}

/** Load and qualify the pinned vec0 asset, including its authorized-ID KNN filter. */
export function qualifySqliteVec(database: DatabaseSync, extensionPath: string): SqliteVecQualification {
  const target = sqliteVecTarget();
  if (!isAbsolute(extensionPath)) {
    throw new Error("sqlite_vec_platform_unsupported");
  }
  const sha256 = hashExtension(extensionPath);
  if (sha256 !== SQLITE_VEC_ASSETS[target].sha256) throw new Error("sqlite_vec_asset_hash_mismatch");
  let loaded = false;
  try {
    database.enableLoadExtension(true);
    database.loadExtension(extensionPath);
    loaded = true;
    database.enableLoadExtension(false);
    database.exec("DROP TABLE IF EXISTS temp.vec0_t15_probe; DROP TABLE IF EXISTS temp.vec0_t15_allowed;");
    database.exec("CREATE VIRTUAL TABLE temp.vec0_t15_probe USING vec0(embedding float[384]); CREATE TEMP TABLE vec0_t15_allowed(rowid INTEGER PRIMARY KEY);");
    database.prepare("INSERT INTO temp.vec0_t15_probe(rowid, embedding) VALUES (?, ?), (?, ?)").run(1n, vectorLiteral(0), 2n, vectorLiteral(1));
    database.prepare("INSERT INTO temp.vec0_t15_allowed(rowid) VALUES (?)").run(1n);
    const rows = database.prepare(
      "SELECT rowid, distance FROM temp.vec0_t15_probe WHERE embedding MATCH ? AND k = 1 AND rowid IN (SELECT rowid FROM temp.vec0_t15_allowed)",
    ).all(vectorLiteral(0)) as readonly Record<string, unknown>[];
    if (rows.length !== 1 || rows[0]?.rowid !== 1n || rows[0]?.distance !== 0) throw new Error("sqlite_vec_authorized_knn_failed");
    return {
      version: SQLITE_VEC_VERSION,
      platform: target,
      extension_path: extensionPath,
      sha256,
      authorized_rowid_in: true,
      distance: 0,
    };
  } finally {
    try { database.enableLoadExtension(false); } catch { /* preserve qualification error */ }
    if (loaded) {
      try { database.exec("DROP TABLE IF EXISTS temp.vec0_t15_probe; DROP TABLE IF EXISTS temp.vec0_t15_allowed;"); } catch { /* probe cleanup is best effort */ }
    }
  }
}
