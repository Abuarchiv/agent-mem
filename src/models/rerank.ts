import {
  assertNativeOnnxRuntime,
  resolveOwnedModelRoot,
  verifyOwnedArtifacts,
  type VerifiedE5Artifact,
} from "./manifest.js";

import { z } from "zod";

/**
 * Pinned local cross-encoder reranker — plan §3:
 * `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`, int8 (q8), CPU, first Top-20
 * over fused candidates. Top-20 is the first rerank slice, never a permanent
 * recall cap. Inference uses only locally installed, hash-verified artifacts;
 * there is no runtime network discovery.
 *
 * Manifest conventions follow src/models/manifest.ts (E5): the runtime
 * profile is pinned in code, and the owned artifact set (paths, byte sizes,
 * sha256) is verified through the shared owned-artifact check before any
 * model runtime is imported. The installed manifest supplies the exact
 * revision and file hashes. V1 packaging verifies and bundles that manifest
 * and its artifacts; runtime loading never downloads a replacement.
 * Tests cover controlled fixtures and real local inference when artifacts
 * are available (see tests/rerank-load.test.ts).
 */

export const RERANK_MODEL_ID = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1" as const;
export const RERANK_ARCHITECTURE = "XLM-RoBERTa" as const;
export const RERANK_HIDDEN_SIZE = 384 as const;
export const RERANK_MAX_TOKENS = 512 as const;
export const RERANK_DTYPE = "q8" as const;
export const RERANK_DEVICE = "cpu" as const;
export const RERANK_BATCH_STRATEGY = "rowwise_batch1" as const;

const artifactSchema = z
  .object({
    path: z.string().min(1).max(256),
    bytes: z.number().int().positive().max(2_000_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const rerankManifestSchema = z
  .object({
    version: z.literal(1),
    model_id: z.literal(RERANK_MODEL_ID),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    architecture: z.literal(RERANK_ARCHITECTURE),
    hidden_size: z.literal(RERANK_HIDDEN_SIZE),
    num_labels: z.literal(1),
    max_tokens: z.literal(RERANK_MAX_TOKENS),
    dtype: z.literal(RERANK_DTYPE),
    device: z.literal(RERANK_DEVICE),
    batch_strategy: z.literal(RERANK_BATCH_STRATEGY),
    score: z.literal("sigmoid"),
    runtime: z
      .object({
        transformers_js: z.literal("4.2.0"),
        onnxruntime_node: z.literal("1.24.3"),
      })
      .strict(),
    artifacts: z.array(artifactSchema).length(4),
  })
  .strict();

export interface RerankArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface RerankModelManifest {
  readonly version: 1;
  readonly model_id: typeof RERANK_MODEL_ID;
  readonly revision: string;
  readonly architecture: typeof RERANK_ARCHITECTURE;
  readonly hidden_size: typeof RERANK_HIDDEN_SIZE;
  readonly num_labels: 1;
  readonly max_tokens: typeof RERANK_MAX_TOKENS;
  readonly dtype: typeof RERANK_DTYPE;
  readonly device: typeof RERANK_DEVICE;
  readonly batch_strategy: typeof RERANK_BATCH_STRATEGY;
  readonly score: "sigmoid";
  readonly runtime: { readonly transformers_js: "4.2.0"; readonly onnxruntime_node: "1.24.3" };
  readonly artifacts: readonly RerankArtifact[];
}

export interface VerifiedRerankArtifacts {
  readonly model_root: string;
  readonly manifest: RerankModelManifest;
  readonly files: readonly VerifiedE5Artifact[];
}

/** Parse and profile-check an installed reranker manifest from caller data. */
export function parseRerankManifest(input: unknown): RerankModelManifest {
  const parsed = rerankManifestSchema.safeParse(input);
  if (!parsed.success) throw new RerankError("rerank_manifest_invalid");
  const paths = parsed.data.artifacts.map((artifact) => artifact.path);
  const expectedPaths = ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quint8_avx2.onnx"];
  if (new Set(paths).size !== paths.length || paths.some((path) => !expectedPaths.includes(path))) {
    throw new RerankError("rerank_manifest_invalid");
  }
  return deepFreeze(parsed.data as RerankModelManifest);
}

/**
 * Verify the installed reranker artifact set against its manifest before any
 * model runtime is imported. Ownership, realpath and hash rules are the
 * shared ones from src/models/manifest.ts.
 */
export async function verifyRerankArtifacts(modelRootInput: string, manifest: RerankModelManifest): Promise<VerifiedRerankArtifacts> {
  const parsed = parseRerankManifest(manifest);
  const verified = await verifyOwnedArtifacts(modelRootInput, parsed.artifacts);
  return deepFreeze({ model_root: verified.model_root, manifest: parsed, files: verified.files });
}

export type RerankErrorCode =
  | "rerank_manifest_invalid"
  | "rerank_input_invalid"
  | "rerank_input_too_large"
  | "rerank_input_too_long"
  | "rerank_busy"
  | "rerank_aborted"
  | "rerank_deadline_exceeded"
  | "rerank_disposed"
  | "rerank_load_failed"
  | "rerank_inference_failed"
  | "rerank_output_invalid"
  | "rerank_dispose_failed"
  | "rerank_dispose_timeout";

export class RerankError extends Error {
  readonly code: RerankErrorCode;

  constructor(code: RerankErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "RerankError";
    this.code = code;
  }
}

export const RERANK_MAX_CANDIDATES = 200 as const;
export const RERANK_MAX_TEXT_BYTES = 1_000_000 as const;
export const RERANK_MAX_TOTAL_BYTES = 4_000_000 as const;
export const RERANK_DEFAULT_DISPOSE_TIMEOUT_MS = 10_000 as const;

export interface RerankCandidate {
  /** Stable caller identity (e.g. fused candidate source/revision identity). */
  readonly id: string;
  readonly text: string;
}

export interface RerankRequest {
  readonly query: string;
  readonly candidates: readonly RerankCandidate[];
  readonly signal?: AbortSignal;
  /**
   * Absolute ISO deadline; the reranker checks it before every rowwise
   * inference and stops with rerank_deadline_exceeded when no time remains.
   * Running native inference is never preempted mid-row.
   */
  readonly deadline_at?: string;
}

export interface RerankScore {
  readonly id: string;
  readonly score: number;
  /** 0-based rank by descending score; ties break by input order. */
  readonly rank: number;
}

export interface RerankerReport {
  readonly state: "ready" | "disposing" | "disposed";
  readonly model_root: string;
  readonly model_id: typeof RERANK_MODEL_ID;
  readonly revision: string;
  readonly hidden_size: typeof RERANK_HIDDEN_SIZE;
  readonly max_tokens: typeof RERANK_MAX_TOKENS;
  readonly dtype: typeof RERANK_DTYPE;
  readonly device: typeof RERANK_DEVICE;
  readonly batch_strategy: typeof RERANK_BATCH_STRATEGY;
  readonly scored_pairs: number;
  readonly completed_batches: number;
}

export interface LoadRerankerOptions {
  readonly modelRoot: string;
  /** Installed, profile-pinned manifest supplied by the model install step. */
  readonly manifest: unknown;
  readonly signal?: AbortSignal;
  readonly intra_op_num_threads?: number;
  readonly inter_op_num_threads?: number;
}

export interface LocalReranker {
  readonly manifest: RerankModelManifest;
  rerank(request: RerankRequest): Promise<readonly RerankScore[]>;
  dispose(options?: { readonly timeout_ms?: number }): Promise<void>;
  report(): RerankerReport;
}

/**
 * Controlled runtime port behind the pinned loader. The real loader binds it
 * to Transformers.js 4.2.0; offline tests bind a deterministic fixture port,
 * which keeps the single-flight, budget and lifecycle behavior fully
 * exercised without a network or unverified artifact dependency.
 */
export interface RerankRuntimePort {
  /** Tokenize one (query, passage) pair into model-ready inputs. */
  tokenizePair(query: string, text: string): unknown;
  /** One rowwise model inference; resolves to exactly one logit value. */
  infer(inputs: unknown): Promise<number>;
  disposeModel(): Promise<void>;
}

interface TensorLike {
  readonly dims: readonly number[];
  readonly data: ArrayLike<number | bigint | boolean>;
}

function sigmoid(logit: number): number {
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const expLogit = Math.exp(logit);
  return expLogit / (1 + expLogit);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RerankError("rerank_aborted");
}

function assertNotPastDeadline(
  signal: AbortSignal | undefined,
  deadlineAt: string | undefined,
  now: () => number,
): void {
  if (deadlineAt !== undefined) {
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline)) throw new RerankError("rerank_input_invalid");
    if (deadline - now() <= 0) throw new RerankError("rerank_deadline_exceeded");
  }
  assertNotAborted(signal);
}

function disposeValue(value: unknown): void {
  if (typeof value !== "object" || value === null || !("dispose" in value)) return;
  const dispose = (value as { readonly dispose?: unknown }).dispose;
  if (typeof dispose === "function") {
    try {
      dispose.call(value);
    } catch {
      // Runtime tensor cleanup is best effort; model disposal remains the
      // authoritative lifecycle boundary.
    }
  }
}

function disposeValues(values: readonly unknown[]): void {
  const seen = new Set<object>();
  for (const value of values) {
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    disposeValue(value);
  }
}

export interface AdmittedRerankRequest {
  readonly query: string;
  readonly candidates: readonly { readonly id: string; readonly text: string }[];
}

/**
 * Validate and copy a rerank request into an owned bounded admission.
 * Callers may mutate their arrays immediately after admission; model work
 * uses only the owned copy. Source text is never truncated.
 */
export function admitRerankRequest(request: RerankRequest): AdmittedRerankRequest {
  if (typeof request !== "object" || request === null) throw new RerankError("rerank_input_invalid");
  if (typeof request.query !== "string" || request.query.length === 0 || request.query.length > 100_000) {
    throw new RerankError("rerank_input_invalid");
  }
  if (!Array.isArray(request.candidates) || request.candidates.length === 0 || request.candidates.length > RERANK_MAX_CANDIDATES) {
    throw new RerankError("rerank_input_invalid");
  }
  if (request.deadline_at !== undefined && !Number.isFinite(Date.parse(request.deadline_at))) {
    throw new RerankError("rerank_input_invalid");
  }
  const candidates: { id: string; text: string }[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const candidate of request.candidates) {
    if (typeof candidate !== "object" || candidate === null) throw new RerankError("rerank_input_invalid");
    if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 256) {
      throw new RerankError("rerank_input_invalid");
    }
    if (seen.has(candidate.id)) throw new RerankError("rerank_input_invalid");
    seen.add(candidate.id);
    if (typeof candidate.text !== "string" || candidate.text.length === 0) throw new RerankError("rerank_input_invalid");
    if (Buffer.byteLength(candidate.text, "utf8") > RERANK_MAX_TEXT_BYTES) throw new RerankError("rerank_input_too_large");
    totalBytes += Buffer.byteLength(`${request.query}\u0000${candidate.text}`, "utf8");
    if (totalBytes > RERANK_MAX_TOTAL_BYTES) throw new RerankError("rerank_input_too_large");
    candidates.push({ id: candidate.id, text: candidate.text });
  }
  return { query: request.query, candidates };
}

class LocalRerankerImpl implements LocalReranker {
  readonly manifest: RerankModelManifest;
  private readonly runtime: RerankRuntimePort;
  private readonly modelRoot: string;
  private readonly now: () => number;
  private state: RerankerReport["state"] = "ready";
  private disposePromise: Promise<void> | undefined;
  private activePromise: Promise<readonly RerankScore[]> | undefined;
  private scoredPairs = 0;
  private completedBatches = 0;

  constructor(verified: VerifiedRerankArtifacts, runtime: RerankRuntimePort, now: () => number) {
    this.manifest = verified.manifest;
    this.modelRoot = verified.model_root;
    this.runtime = runtime;
    this.now = now;
  }

  rerank(request: RerankRequest): Promise<readonly RerankScore[]> {
    if (this.state !== "ready") return Promise.reject(new RerankError("rerank_disposed"));
    let signal: AbortSignal | undefined;
    let deadlineAt: string | undefined;
    let admitted: AdmittedRerankRequest;
    try {
      if (typeof request !== "object" || request === null) throw new RerankError("rerank_input_invalid");
      signal = request.signal;
      deadlineAt = request.deadline_at;
      assertNotPastDeadline(signal, deadlineAt, this.now);
      admitted = admitRerankRequest(request);
      assertNotPastDeadline(signal, deadlineAt, this.now);
    } catch (error: unknown) {
      return Promise.reject(error instanceof RerankError ? error : new RerankError("rerank_input_invalid", error));
    }
    if (this.activePromise !== undefined) return Promise.reject(new RerankError("rerank_busy"));
    // One local inference at a time per model (plan §8): concurrent callers
    // are rejected instead of loading or queueing a second copy of the warm
    // model.
    const active = this.rerankNow(admitted.query, admitted.candidates, signal, deadlineAt);
    this.activePromise = active;
    void active.finally(() => {
      if (this.activePromise === active) this.activePromise = undefined;
    }).catch(() => undefined);
    return active;
  }

  dispose(options: { readonly timeout_ms?: number } = {}): Promise<void> {
    if (this.state === "disposed") return Promise.resolve();
    const timeout = options.timeout_ms ?? RERANK_DEFAULT_DISPOSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) return Promise.reject(new RerankError("rerank_input_invalid"));
    if (this.disposePromise === undefined) {
      this.state = "disposing";
      const active = this.activePromise ?? Promise.resolve();
      const activeSettled = active.then(
        () => undefined,
        () => undefined,
      );
      this.disposePromise = activeSettled.then(async () => {
        try {
          await this.runtime.disposeModel();
          this.state = "disposed";
        } catch (error: unknown) {
          throw new RerankError("rerank_dispose_failed", error);
        }
      });
    }
    return withTimeout(this.disposePromise, timeout);
  }

  report(): RerankerReport {
    return {
      state: this.state,
      model_root: this.modelRoot,
      model_id: this.manifest.model_id,
      revision: this.manifest.revision,
      hidden_size: this.manifest.hidden_size,
      max_tokens: this.manifest.max_tokens,
      dtype: this.manifest.dtype,
      device: this.manifest.device,
      batch_strategy: this.manifest.batch_strategy,
      scored_pairs: this.scoredPairs,
      completed_batches: this.completedBatches,
    };
  }

  private async rerankNow(
    query: string,
    candidates: readonly { readonly id: string; readonly text: string }[],
    signal: AbortSignal | undefined,
    deadlineAt: string | undefined,
  ): Promise<readonly RerankScore[]> {
    const scores: number[] = [];
    try {
      for (const candidate of candidates) {
        // The pinned q8 profile keeps every row a single-row inference so the
        // score of one pair cannot drift with unrelated rows in a batch
        // (dynamic activation quantization), matching the E5 profile.
        assertNotPastDeadline(signal, deadlineAt, this.now);
        let inputs: unknown;
        let logit: number | undefined;
        try {
          inputs = this.runtime.tokenizePair(query, candidate.text);
          logit = await this.runtime.infer(inputs);
        } finally {
          disposeValues(typeof inputs === "object" && inputs !== null ? Object.values(inputs) : []);
        }
        assertNotPastDeadline(signal, deadlineAt, this.now);
        if (typeof logit !== "number" || !Number.isFinite(logit)) throw new RerankError("rerank_output_invalid");
        const score = sigmoid(logit);
        if (!Number.isFinite(score)) throw new RerankError("rerank_output_invalid");
        scores.push(score);
      }
      const ordered = candidates
        .map((candidate, index) => ({ id: candidate.id, index, score: scores[index] ?? Number.NaN }))
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.index - right.index;
        })
        .map((entry, rank) => ({ id: entry.id, score: entry.score, rank }));
      this.scoredPairs += candidates.length;
      this.completedBatches += 1;
      return deepFreeze(ordered);
    } catch (error: unknown) {
      if (error instanceof RerankError) throw error;
      if (signal?.aborted) throw new RerankError("rerank_aborted", error);
      throw new RerankError("rerank_inference_failed", error);
    }
  }
}

/**
 * Bind a verified artifact set and a controlled runtime port into one warm
 * reranker. Exactly one model instance exists per call; callers must reuse
 * it across queries instead of loading a copy per call.
 */
export function createLocalReranker(verified: VerifiedRerankArtifacts, runtime: RerankRuntimePort, options: { readonly now?: () => number } = {}): LocalReranker {
  if (typeof runtime !== "object" || runtime === null) throw new RerankError("rerank_input_invalid");
  if (typeof runtime.tokenizePair !== "function" || typeof runtime.infer !== "function" || typeof runtime.disposeModel !== "function") {
    throw new RerankError("rerank_input_invalid");
  }
  return new LocalRerankerImpl(verified, runtime, options.now ?? Date.now);
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RerankError("rerank_dispose_timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function logitsFromOutput(output: unknown): number {
  if (typeof output !== "object" || output === null || !("logits" in output)) throw new RerankError("rerank_output_invalid");
  const logits = (output as { readonly logits?: unknown }).logits;
  if (
    typeof logits !== "object" ||
    logits === null ||
    !Array.isArray((logits as TensorLike).dims) ||
    (logits as TensorLike).dims.length !== 2 ||
    (logits as TensorLike).dims[0] !== 1 ||
    (logits as TensorLike).dims[1] !== 1
  ) {
    throw new RerankError("rerank_output_invalid");
  }
  const data = (logits as TensorLike).data;
  if (typeof data !== "object" || data === null || data.length !== 1) throw new RerankError("rerank_output_invalid");
  const value = Number(data[0]);
  if (!Number.isFinite(value)) throw new RerankError("rerank_output_invalid");
  return value;
}

interface CallableModel {
  (inputs: unknown): Promise<unknown>;
  readonly config?: unknown;
  readonly dispose: () => Promise<unknown>;
}

interface TokenizerLike {
  (texts: readonly string[], options: { readonly text_pair?: readonly string[]; readonly padding: boolean; readonly truncation: boolean }): unknown;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Load the pinned reranker from local verified artifacts only. The caller
 * supplies the installed manifest; this loader validates it against the
 * pinned profile, hash-verifies every artifact, checks the native runtime
 * identity, and only then imports the pinned Transformers.js runtime.
 */
export async function loadReranker(options: LoadRerankerOptions): Promise<LocalReranker> {
  if (typeof options !== "object" || options === null) throw new RerankError("rerank_input_invalid");
  const manifest = parseRerankManifest(options.manifest);
  assertNotAborted(options.signal);
  const modelRoot = resolveOwnedModelRoot(options.modelRoot);
  const verified = await verifyRerankArtifacts(modelRoot, manifest);
  assertNotAborted(options.signal);
  assertNativeOnnxRuntime(manifest.runtime.onnxruntime_node);
  let tokenizer: unknown;
  let model: CallableModel | undefined;
  try {
    // Pinned Transformers.js 4.2.0 API, same offline hygiene as the E5
    // embedder: verified absolute path, no remote discovery, every optional
    // cache route disabled so a stale cache can never replace a
    // hash-verified artifact.
    const transformers = await import("@huggingface/transformers");
    if (transformers.env.version !== manifest.runtime.transformers_js) throw new RerankError("rerank_load_failed");
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    transformers.env.useBrowserCache = false;
    transformers.env.useFSCache = false;
    transformers.env.useCustomCache = false;
    transformers.env.experimental_useCrossOriginStorage = false;
    transformers.env.useWasmCache = false;
    tokenizer = await transformers.AutoTokenizer.from_pretrained(verified.model_root, {
      revision: manifest.revision,
      local_files_only: true,
    });
    assertNotAborted(options.signal);
    model = (await transformers.AutoModelForSequenceClassification.from_pretrained(verified.model_root, {
      revision: manifest.revision,
      dtype: manifest.dtype,
      device: manifest.device,
      local_files_only: true,
      session_options: {
        intraOpNumThreads: intraThreads(options.intra_op_num_threads),
        interOpNumThreads: interThreads(options.inter_op_num_threads),
      },
    })) as unknown as CallableModel;
    assertNotAborted(options.signal);
    const modelConfig = model.config;
    const hiddenSize = typeof modelConfig === "object" && modelConfig !== null && "hidden_size" in modelConfig
      ? (modelConfig as { readonly hidden_size?: unknown }).hidden_size
      : undefined;
    if (hiddenSize !== manifest.hidden_size) throw new RerankError("rerank_load_failed");
    const runtime: RerankRuntimePort = {
      tokenizePair(query: string, text: string): unknown {
        if (typeof query !== "string" || typeof text !== "string") throw new RerankError("rerank_input_invalid");
        // Pinned pair order: text=query, text_pair=passage. No truncation —
        // source text is never silently shortened; overlong pairs are
        // rejected and handled as degraded rerank by the caller.
        return (tokenizer as TokenizerLike)([query], { text_pair: [text], padding: true, truncation: false });
      },
      async infer(inputs: unknown): Promise<number> {
        const inputIds = typeof inputs === "object" && inputs !== null && "input_ids" in inputs
          ? inputs.input_ids as TensorLike
          : undefined;
        const dims = inputIds?.dims;
        if (!Array.isArray(dims) || dims.length !== 2 || dims[0] !== 1 || !Number.isSafeInteger(dims[1]) || dims[1]! < 1) {
          throw new RerankError("rerank_input_invalid");
        }
        if (dims[1]! > manifest.max_tokens) throw new RerankError("rerank_input_too_long");
        const output = await model!(inputs);
        try {
          return logitsFromOutput(output);
        } finally {
          if (typeof output === "object" && output !== null) disposeValues(Object.values(output));
        }
      },
      async disposeModel(): Promise<void> {
        await model!.dispose();
      },
    };
    return createLocalReranker(verified, runtime);
  } catch (error: unknown) {
    if (model !== undefined) {
      try {
        await model.dispose();
      } catch {
        // Preserve the original load failure; the model was never published.
      }
    }
    if (typeof tokenizer === "object" && tokenizer !== null) disposeValues(Object.values(tokenizer));
    if (error instanceof RerankError) throw error;
    if (options.signal?.aborted) throw new RerankError("rerank_aborted", error);
    throw new RerankError("rerank_load_failed", error);
  }
}

function intraThreads(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) throw new RerankError("rerank_input_invalid");
  return value;
}

function interThreads(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2) throw new RerankError("rerank_input_invalid");
  return value;
}
