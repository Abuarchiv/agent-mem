import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPrivatePath, ensurePrivateDirectory } from "./private-files.js";
import { parseRerankManifest, verifyRerankArtifacts, type RerankModelManifest } from "../models/rerank.js";

export const RERANKER_EXTRA_ID = "reranker" as const;

export class ExtraError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ExtraError";
  }
}

export type RerankerExtraStatus =
  | { readonly state: "ready"; readonly source: "data" | "bundled"; readonly model_root: string }
  | { readonly state: "unavailable"; readonly reason: "extra_not_installed" | "extra_artifacts_invalid" };

export interface RerankerExtraInstallOptions {
  readonly fetch?: typeof fetch;
  readonly manifest?: unknown;
  readonly baseUrl?: string;
  /** Maximum wait for one remote artifact before the optional extra degrades. */
  readonly timeoutMs?: number;
  /** Test/package override; null disables the bundled-source shortcut. */
  readonly bundledRoot?: string | null;
}

export interface RerankerExtraInstallResult {
  readonly state: "existing" | "installed";
  readonly model_root: string;
}

export interface RerankerActivationResult {
  readonly enabled: boolean;
  readonly state: "disabled" | "ready" | "unavailable";
  readonly reason: string | null;
  readonly model_root?: string;
}

export type RerankerExtraInstaller = (dataDirectory: string) => Promise<RerankerExtraInstallResult>;

function absoluteDataDirectory(dataDirectory: string): string {
  if (typeof dataDirectory !== "string" || dataDirectory.length === 0 || dataDirectory.includes("\0") || !isAbsolute(dataDirectory)) {
    throw new ExtraError("extra_path_invalid");
  }
  return resolve(dataDirectory);
}

function manifest(): RerankModelManifest {
  try {
    return parseRerankManifest(JSON.parse(readFileSync(fileURLToPath(new URL("../models/rerank-manifest.json", import.meta.url)), "utf8")) as unknown);
  } catch (error) {
    throw new ExtraError("extra_manifest_invalid", error);
  }
}

export function rerankerDataRoot(dataDirectory: string): string {
  return join(absoluteDataDirectory(dataDirectory), "models", "rerank");
}

export function rerankerModelRoot(dataDirectory: string, input: unknown = manifest()): string {
  const parsed = parseRerankManifest(input);
  return join(rerankerDataRoot(dataDirectory), parsed.model_id, parsed.revision);
}

function bundledModelRoot(input: RerankModelManifest): string {
  const packageRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  return join(packageRoot, ".models", "rerank", input.model_id, input.revision);
}

function assertOwnedTarget(path: string, code = "extra_target_unverified"): void {
  if (!existsSync(path)) return;
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch (error) { throw new ExtraError(code, error); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ExtraError(code);
  try { assertPrivatePath(path, info, code); } catch (error) { throw new ExtraError(code, error); }
}

function artifactPath(root: string, path: string): string {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path)) throw new ExtraError("extra_artifact_path_invalid");
  const absolute = resolve(root, path);
  const contained = relative(root, absolute);
  if (contained === "" || contained === ".." || contained.startsWith(".." + "/") || contained.startsWith(".." + "\\")) {
    throw new ExtraError("extra_artifact_path_invalid");
  }
  return absolute;
}

export async function verifyRerankerExtra(dataDirectory: string, bundledRoot?: string): Promise<RerankerExtraStatus> {
  const parsed = manifest();
  const dataRoot = rerankerModelRoot(dataDirectory, parsed);
  try {
    if (existsSync(rerankerDataRoot(dataDirectory))) assertOwnedTarget(rerankerDataRoot(dataDirectory));
    if (existsSync(dataRoot)) {
      const verified = await verifyRerankArtifacts(dataRoot, parsed);
      return { state: "ready", source: "data", model_root: verified.model_root };
    }
  } catch {
    return { state: "unavailable", reason: "extra_artifacts_invalid" };
  }
  const candidate = bundledRoot === undefined ? bundledModelRoot(parsed) : resolve(bundledRoot);
  try {
    if (!existsSync(candidate)) return { state: "unavailable", reason: "extra_not_installed" };
    const verified = await verifyRerankArtifacts(candidate, parsed);
    return { state: "ready", source: "bundled", model_root: verified.model_root };
  } catch {
    return { state: "unavailable", reason: "extra_not_installed" };
  }
}

function downloadUrl(parsed: RerankModelManifest, path: string, baseUrl: string): string {
  const upstreamPath = path === "onnx/model_quantized.onnx" ? "onnx/model_quint8_avx2.onnx" : path;
  return `${baseUrl.replace(/\/$/u, "")}/${parsed.model_id}/resolve/${parsed.revision}/${upstreamPath}?download=true`;
}

export async function installRerankerExtra(dataDirectory: string, options: RerankerExtraInstallOptions = {}): Promise<RerankerExtraInstallResult> {
  const dataRoot = rerankerDataRoot(dataDirectory);
  const parsed = options.manifest === undefined ? manifest() : parseRerankManifest(options.manifest);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new ExtraError("extra_timeout_invalid");
  const destination = rerankerModelRoot(dataDirectory, parsed);
  try {
    if (existsSync(destination)) {
      const verified = await verifyRerankArtifacts(destination, parsed);
      return { state: "existing", model_root: verified.model_root };
    }
  } catch {
    assertOwnedTarget(destination);
  }
  ensurePrivateDirectory(dataRoot);
  assertOwnedTarget(dataRoot);
  const stage = mkdtempSync(join(dataRoot, `.reranker-${randomUUID()}-`));
  try {
    const fetcher = options.fetch ?? fetch;
    const baseUrl = options.baseUrl ?? "https://huggingface.co";
    let bundledRoot: string | undefined;
    if (options.bundledRoot !== null) {
      try {
        const candidate = options.bundledRoot ?? bundledModelRoot(parsed);
        await verifyRerankArtifacts(candidate, parsed);
        bundledRoot = candidate;
      } catch { /* A core package may not contain the optional bundle. */ }
    }
    for (const artifact of parsed.artifacts) {
      const target = artifactPath(stage, artifact.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (bundledRoot !== undefined) {
        copyFileSync(join(bundledRoot, artifact.path), target);
        continue;
      }
      let response: Response;
      try { response = await fetcher(downloadUrl(parsed, artifact.path, baseUrl), { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }); }
      catch (error) { throw new ExtraError("extra_download_failed", error); }
      if (!response.ok) throw new ExtraError(`extra_download_http_${response.status}`);
      let bytes: Buffer;
      try { bytes = Buffer.from(await response.arrayBuffer()); }
      catch (error) { throw new ExtraError("extra_download_failed", error); }
      if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
        throw new ExtraError("extra_download_hash_mismatch");
      }
      writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
    }
    await verifyRerankArtifacts(stage, parsed);
    ensurePrivateDirectory(dirname(destination));
    assertOwnedTarget(destination);
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(stage, destination);
    return { state: "installed", model_root: destination };
  } catch (error) {
    if (error instanceof ExtraError) throw error;
    throw new ExtraError("extra_install_failed", error);
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

/** Install the recommended optional extra without making the V1 core fail closed. */
export async function ensureRerankerExtra(
  dataDirectory: string,
  requested: boolean,
  installer: RerankerExtraInstaller = installRerankerExtra,
): Promise<RerankerActivationResult> {
  if (!requested) return { enabled: false, state: "disabled", reason: null };
  try {
    const result = await installer(dataDirectory);
    return { enabled: true, state: "ready", reason: null, model_root: result.model_root };
  } catch (error) {
    const reason = error instanceof ExtraError
      ? error.code
      : error instanceof Error && /^[a-z][a-z0-9_]{1,127}$/u.test(error.message)
        ? error.message
        : "extra_install_failed";
    return { enabled: false, state: "unavailable", reason };
  }
}

export function removeRerankerExtra(dataDirectory: string): { readonly state: "removed" | "not_installed"; readonly model_root: string } {
  const dataRoot = rerankerDataRoot(dataDirectory);
  const destination = rerankerModelRoot(dataDirectory);
  if (!existsSync(destination)) return { state: "not_installed", model_root: destination };
  assertOwnedTarget(dataRoot);
  assertOwnedTarget(destination);
  rmSync(destination, { recursive: true, force: true });
  return { state: "removed", model_root: destination };
}
