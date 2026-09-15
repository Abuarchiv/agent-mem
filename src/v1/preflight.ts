import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { E5_MODEL_MANIFEST, verifyE5Artifacts } from "../models/manifest.js";
import { parseRerankManifest, RERANK_MODEL_ID } from "../models/rerank.js";
import { InstallError } from "./install.js";
import { verifyRerankerExtra, type RerankerExtraStatus } from "./extras.js";

const fileSchema = z.object({
  path: z.string().min(1).max(4_096),
  bytes: z.number().int().min(0).max(4_000_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const bundleSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platform: z.enum(["darwin", "linux", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  node: z.string().regex(/^v\d+\.\d+\.\d+$/),
  profile: z.enum(["core-v1", "full-v1"]),
  files: z.array(fileSchema).max(100_000),
}).passthrough();

export type InstallBundleManifest = z.infer<typeof bundleSchema>;

export interface InstallBundleReport {
  readonly version: 1;
  readonly mode: "package" | "source";
  readonly target: string;
  readonly runtime: { readonly state: "embedded" | "system"; readonly version: string };
  readonly core: { readonly state: "ready"; readonly model: string; readonly revision: string };
  readonly reranker: RerankerExtraStatus;
  readonly sqlite_vec: unknown;
  readonly manifest?: { readonly profile: InstallBundleManifest["profile"]; readonly version: string };
}

function fail(code: string): never {
  throw new InstallError(code);
}

export function parseInstallBundleManifest(value: unknown): InstallBundleManifest {
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success) fail("install_bundle_manifest_invalid");
  const paths = parsed.data.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || paths.some(path => !isAbsoluteSafePath(path))) fail("install_bundle_manifest_invalid");
  return parsed.data;
}

function isAbsoluteSafePath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !isAbsolute(path) && path !== "." && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

export function safeBundlePath(bundleRoot: string, path: string): string {
  if (!isAbsolute(bundleRoot) || !isAbsoluteSafePath(path)) fail("install_bundle_path_invalid");
  const root = resolve(bundleRoot);
  const absolute = resolve(root, path);
  const remainder = relative(root, absolute);
  if (remainder === "" || remainder === ".." || remainder.startsWith("../") || remainder.startsWith("..\\") || isAbsolute(remainder)) fail("install_bundle_path_invalid");
  return absolute;
}

export function packageTarget(manifest: Pick<InstallBundleManifest, "platform" | "arch">): string {
  return manifest.platform === "win32" ? `win-${manifest.arch}` : `${manifest.platform}-${manifest.arch}`;
}

function bundleRoot(): string {
  return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function readManifest(root: string): InstallBundleManifest | undefined {
  const path = join(root, "manifest.json");
  if (!existsSync(path)) return undefined;
  try { return parseInstallBundleManifest(JSON.parse(readFileSync(path, "utf8")) as unknown); }
  catch (error) {
    if (error instanceof InstallError) throw error;
    fail("install_bundle_manifest_invalid");
  }
}

function verifyManifestFiles(root: string, manifest: InstallBundleManifest): void {
  for (const file of manifest.files) {
    const path = safeBundlePath(root, file.path);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(path); } catch { fail("install_bundle_file_missing"); }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes) fail("install_bundle_file_invalid");
    let digest: string;
    try { digest = createHash("sha256").update(readFileSync(path)).digest("hex"); }
    catch { fail("install_bundle_file_unreadable"); }
    if (digest !== file.sha256) fail("install_bundle_file_tampered");
  }
}

function verifyRuntime(root: string, manifest: InstallBundleManifest): string {
  const executable = manifest.platform === "win32" ? join(root, "runtime", "bin", "node.exe") : join(root, "runtime", "bin", "node");
  try {
    const info = lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink()) fail("install_bundle_runtime_invalid");
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } }).trim();
    if (version !== manifest.node) fail("install_bundle_runtime_version_invalid");
    return version;
  } catch (error) {
    if (error instanceof InstallError) throw error;
    fail("install_bundle_runtime_unavailable");
  }
}

function bundledRerankerRoot(root: string): string {
  const manifest = parseRerankManifest(JSON.parse(readFileSync(join(root, "dist-v1", "src", "models", "rerank-manifest.json"), "utf8")) as unknown);
  return join(root, ".models", "rerank", RERANK_MODEL_ID, manifest.revision);
}

/** Prove the local package/core before install writes host files. */
export async function verifyInstallBundle(root = bundleRoot(), dataDirectory?: string): Promise<InstallBundleReport> {
  const bundleManifest = readManifest(resolve(root));
  const mode = bundleManifest === undefined ? "source" : "package";
  if (bundleManifest !== undefined) {
    if (bundleManifest.platform !== process.platform || bundleManifest.arch !== process.arch) fail("install_bundle_target_mismatch");
    verifyManifestFiles(resolve(root), bundleManifest);
  }
  const runtimeVersion = bundleManifest === undefined ? process.version : verifyRuntime(resolve(root), bundleManifest);
  const e5Root = join(resolve(root), ".models", "e5", E5_MODEL_MANIFEST.model_id, E5_MODEL_MANIFEST.revision);
  try { await verifyE5Artifacts(e5Root, E5_MODEL_MANIFEST); }
  catch { fail("install_core_unavailable"); }
  let reranker: RerankerExtraStatus;
  try { reranker = await verifyRerankerExtra(dataDirectory ?? resolve(root), bundledRerankerRoot(resolve(root))); }
  catch { reranker = { state: "unavailable", reason: "extra_artifacts_invalid" }; }
  return {
    version: 1,
    mode,
    target: bundleManifest === undefined ? `${process.platform}-${process.arch}` : packageTarget(bundleManifest),
    runtime: { state: bundleManifest === undefined ? "system" : "embedded", version: runtimeVersion },
    core: { state: "ready", model: E5_MODEL_MANIFEST.model_id, revision: E5_MODEL_MANIFEST.revision },
    reranker,
    sqlite_vec: bundleManifest?.sqlite_vec ?? { state: "unknown" },
    ...(bundleManifest === undefined ? {} : { manifest: { profile: bundleManifest.profile, version: bundleManifest.version } }),
  };
}
