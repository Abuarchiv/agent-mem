import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";
import { assertPrivatePath } from "../v1/private-files.js";

function createRequireFromMeta(): NodeRequire {
  return createRequire(import.meta.url);
}

const MODEL_ID = "Xenova/multilingual-e5-small" as const;
const SOURCE_MODEL_ID = "intfloat/multilingual-e5-small" as const;
const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78" as const;
const MODEL_DIMENSIONS = 384 as const;
const MODEL_MAX_TOKENS = 512 as const;

const artifactSchema = z
  .object({
    path: z.string().min(1).max(256),
    bytes: z.number().int().positive().max(2_000_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const modelManifestSchema = z
  .object({
    version: z.literal(1),
    model_id: z.literal(MODEL_ID),
    source_model_id: z.literal(SOURCE_MODEL_ID),
    revision: z.literal(MODEL_REVISION),
    architecture: z.literal("XLM-RoBERTa"),
    dimensions: z.literal(MODEL_DIMENSIONS),
    max_tokens: z.literal(MODEL_MAX_TOKENS),
    dtype: z.literal("q8"),
    device: z.literal("cpu"),
    batch_strategy: z.literal("rowwise_batch1"),
    runtime: z
      .object({
        transformers_js: z.literal("4.2.0"),
        onnxruntime_node: z.literal("1.24.3"),
        dependency_overrides: z
          .object({ adm_zip: z.literal("0.6.0"), sharp: z.literal("0.35.3") })
          .strict(),
      })
      .strict(),
    prefixes: z
      .object({ query: z.literal("query: "), passage: z.literal("passage: ") })
      .strict(),
    pooling: z.literal("masked_mean"),
    normalization: z.literal("l2"),
    license: z
      .object({
        spdx: z.literal("MIT"),
        name: z.literal("MIT"),
        source: z.literal("https://huggingface.co/intfloat/multilingual-e5-small"),
      })
      .strict(),
    artifacts: z.array(artifactSchema).length(4),
  })
  .strict();

export type E5ModelManifest = z.infer<typeof modelManifestSchema>;
export type E5ModelArtifact = E5ModelManifest["artifacts"][number];

export interface VerifiedE5Artifact {
  readonly relative_path: string;
  readonly absolute_path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface VerifiedE5Artifacts {
  readonly model_root: string;
  readonly manifest: E5ModelManifest;
  readonly files: readonly VerifiedE5Artifact[];
}

export type ModelArtifactErrorCode =
  | "model_root_invalid"
  | "model_manifest_invalid"
  | "model_artifact_missing"
  | "model_artifact_tampered"
  | "model_artifact_unreadable";

export class ModelArtifactError extends Error {
  readonly code: ModelArtifactErrorCode;
  readonly relative_path: string | undefined;

  constructor(code: ModelArtifactErrorCode, relativePath?: string, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "ModelArtifactError";
    this.code = code;
    this.relative_path = relativePath;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function parseManifest(input: unknown): E5ModelManifest {
  const parsed = modelManifestSchema.safeParse(input);
  if (!parsed.success) throw new ModelArtifactError("model_manifest_invalid");
  const paths = parsed.data.artifacts.map((artifact) => artifact.path);
  const expectedPaths = ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"];
  if (new Set(paths).size !== paths.length || paths.some((path) => !expectedPaths.includes(path))) {
    throw new ModelArtifactError("model_manifest_invalid");
  }
  return deepFreeze(parsed.data);
}

export const E5_MODEL_MANIFEST: E5ModelManifest = deepFreeze({
  version: 1,
  model_id: MODEL_ID,
  source_model_id: SOURCE_MODEL_ID,
  revision: MODEL_REVISION,
  architecture: "XLM-RoBERTa",
  dimensions: MODEL_DIMENSIONS,
  max_tokens: MODEL_MAX_TOKENS,
  dtype: "q8",
  device: "cpu",
  batch_strategy: "rowwise_batch1",
  runtime: {
    transformers_js: "4.2.0",
    onnxruntime_node: "1.24.3",
    dependency_overrides: { adm_zip: "0.6.0", sharp: "0.35.3" },
  },
  prefixes: { query: "query: ", passage: "passage: " },
  pooling: "masked_mean",
  normalization: "l2",
  license: {
    spdx: "MIT",
    name: "MIT",
    source: "https://huggingface.co/intfloat/multilingual-e5-small",
  },
  artifacts: [
    {
      path: "config.json",
      bytes: 658,
      sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
      path: "tokenizer_config.json",
      bytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
      path: "tokenizer.json",
      bytes: 17_082_730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
      path: "onnx/model_quantized.onnx",
      bytes: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
  ],
} satisfies E5ModelManifest);

export function resolveOwnedModelRoot(modelRoot: string): string {
  if (typeof modelRoot !== "string" || modelRoot.length === 0 || modelRoot.includes("\0")) {
    throw new ModelArtifactError("model_root_invalid");
  }
  return resolve(modelRoot);
}

function safeArtifactPath(modelRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.includes("\0")) throw new ModelArtifactError("model_manifest_invalid", relativePath);
  const absolutePath = resolve(modelRoot, relativePath);
  const relativeToRoot = relative(modelRoot, absolutePath);
  if (relativeToRoot === "" || relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === "..") {
    throw new ModelArtifactError("model_manifest_invalid", relativePath);
  }
  return absolutePath;
}

async function hashArtifact(absolutePath: string, expected: E5ModelArtifact): Promise<VerifiedE5Artifact> {
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? "model_artifact_missing" : "model_artifact_unreadable";
    throw new ModelArtifactError(code, expected.path, error);
  }
  if (!fileStat.isFile() || !isOwnedReadOnly(fileStat, absolutePath) || fileStat.size !== expected.bytes) {
    throw new ModelArtifactError("model_artifact_tampered", expected.path);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(absolutePath, { highWaterMark: 1024 * 1024 })) {
      if (!(chunk instanceof Buffer)) throw new ModelArtifactError("model_artifact_unreadable", expected.path);
      bytes += chunk.length;
      hash.update(chunk);
    }
  } catch (error: unknown) {
    if (error instanceof ModelArtifactError) throw error;
    throw new ModelArtifactError("model_artifact_unreadable", expected.path, error);
  }
  const sha256 = hash.digest("hex");
  if (bytes !== expected.bytes || sha256 !== expected.sha256) {
    throw new ModelArtifactError("model_artifact_tampered", expected.path);
  }
  return { relative_path: expected.path, absolute_path: absolutePath, bytes, sha256 };
}

function isOwnedReadOnly(value: { readonly mode: number; readonly uid?: number }, path: string): boolean {
  if (process.platform === "win32") {
    try { assertPrivatePath(path, undefined, "model_asset_unverified", "asset"); return true; } catch { return false; }
  }
  if ((value.mode & 0o022) !== 0) return false;
  const currentUid = process.getuid?.();
  return currentUid === undefined || value.uid === undefined || value.uid === currentUid;
}

/**
 * Shared ownership, realpath and hash verification for one owned model
 * artifact set. Both pinned local profiles (E5 embedder and reranker) verify
 * their artifacts through this single implementation before any inference
 * runtime is imported.
 */
export async function verifyOwnedArtifacts(
  modelRootInput: string,
  artifacts: readonly E5ModelArtifact[],
): Promise<{ readonly model_root: string; readonly files: readonly VerifiedE5Artifact[] }> {
  const modelRoot = resolveOwnedModelRoot(modelRootInput);
  let rootStat;
  try {
    rootStat = await lstat(modelRoot);
  } catch (error: unknown) {
    throw new ModelArtifactError("model_root_invalid", undefined, error);
  }
  if (!rootStat.isDirectory() || !isOwnedReadOnly(rootStat, modelRoot)) throw new ModelArtifactError("model_root_invalid");
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(modelRoot);
  } catch (error: unknown) {
    throw new ModelArtifactError("model_root_invalid", undefined, error);
  }
  const files: VerifiedE5Artifact[] = [];
  for (const artifact of artifacts) {
    const absolutePath = safeArtifactPath(modelRoot, artifact.path);
    const pathParts = artifact.path.split("/");
    let parentPath = modelRoot;
    for (const pathPart of pathParts.slice(0, -1)) {
      parentPath = join(parentPath, pathPart);
      let parentStat;
      try {
        parentStat = await lstat(parentPath);
      } catch (error: unknown) {
        const code = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
          ? "model_artifact_missing"
          : "model_artifact_unreadable";
        throw new ModelArtifactError(code, artifact.path, error);
      }
      if (!parentStat.isDirectory() || !isOwnedReadOnly(parentStat, parentPath)) {
        throw new ModelArtifactError("model_artifact_tampered", artifact.path);
      }
      let parentRealPath: string;
      try {
        parentRealPath = await realpath(parentPath);
      } catch (error: unknown) {
        throw new ModelArtifactError("model_artifact_unreadable", artifact.path, error);
      }
      if (parentRealPath !== rootRealPath && !parentRealPath.startsWith(`${rootRealPath}${sep}`)) {
        throw new ModelArtifactError("model_artifact_tampered", artifact.path);
      }
    }
    let artifactStat;
    try {
      artifactStat = await lstat(absolutePath);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
        ? "model_artifact_missing"
        : "model_artifact_unreadable";
      throw new ModelArtifactError(code, artifact.path, error);
    }
    if (!artifactStat.isFile() || !isOwnedReadOnly(artifactStat, absolutePath)) {
      throw new ModelArtifactError("model_artifact_tampered", artifact.path);
    }
    let fileRealPath: string;
    try {
      fileRealPath = await realpath(absolutePath);
    } catch (error: unknown) {
      throw new ModelArtifactError("model_artifact_missing", artifact.path, error);
    }
    if (fileRealPath !== rootRealPath && !fileRealPath.startsWith(`${rootRealPath}${sep}`)) {
      throw new ModelArtifactError("model_artifact_tampered", artifact.path);
    }
    files.push(await hashArtifact(fileRealPath, artifact));
  }
  return deepFreeze({ model_root: rootRealPath, files });
}

/** Verify the fixed E5 artifact set before any model runtime is imported. */
export async function verifyE5Artifacts(modelRootInput: string, manifestInput: E5ModelManifest = E5_MODEL_MANIFEST): Promise<VerifiedE5Artifacts> {
  const manifest = parseManifest(manifestInput);
  const verified = await verifyOwnedArtifacts(modelRootInput, manifest.artifacts);
  return deepFreeze({ model_root: verified.model_root, manifest, files: verified.files });
}

export type NativeRuntimeErrorCode =
  | "runtime_unsupported_platform"
  | "runtime_version_mismatch"
  | "runtime_binding_missing";

export class NativeRuntimeError extends Error {
  readonly code: NativeRuntimeErrorCode;

  constructor(code: NativeRuntimeErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "NativeRuntimeError";
    this.code = code;
  }
}

const supportedNativeOnnxTargets = new Set(["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"]);

export function isNativeOnnxRuntimeSupported(target = `${process.platform}-${process.arch}`): boolean {
  return supportedNativeOnnxTargets.has(target);
}

/**
 * Shared native ONNX runtime identity check for every pinned local model
 * profile: the tested stack is CPU inference on the validated platform with
 * onnxruntime-node 1.24.3 and a NAPI v6 binding. Called before the inference
 * runtime is imported or executed.
 */
export function assertNativeOnnxRuntime(expectedVersion: string): void {
  const target = `${process.platform}-${process.arch}`;
  if (!isNativeOnnxRuntimeSupported(target)) {
    throw new NativeRuntimeError("runtime_unsupported_platform");
  }
  const require = createRequireFromMeta();
  try {
    // Read package metadata as data; do not import or execute the native
    // binding until the artifact and runtime identity checks have passed.
    const metadata = require("onnxruntime-node/package.json") as {
      readonly version?: unknown;
      readonly binary?: { readonly napi_versions?: readonly unknown[] };
    };
    if (metadata.version !== expectedVersion || !metadata.binary?.napi_versions?.includes(6)) {
      throw new NativeRuntimeError("runtime_version_mismatch");
    }
    const packageEntry = require.resolve("onnxruntime-node");
    const bindingPath = resolve(dirname(packageEntry), "../bin/napi-v6", process.platform, process.arch, "onnxruntime_binding.node");
    const bindingStat = lstatSync(bindingPath);
    if (!bindingStat.isFile()) throw new NativeRuntimeError("runtime_binding_missing");
  } catch (error: unknown) {
    if (error instanceof NativeRuntimeError) throw error;
    throw new NativeRuntimeError("runtime_binding_missing", error);
  }
}
