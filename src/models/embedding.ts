import {
  assertNativeOnnxRuntime,
  E5_MODEL_MANIFEST,
  ModelArtifactError,
  resolveOwnedModelRoot,
  verifyE5Artifacts,
  type E5ModelManifest,
  type VerifiedE5Artifacts,
} from "./manifest.js";


export type E5InputKind = "query" | "passage";

export interface E5CpuThreadOptions {
  readonly intra_op_num_threads?: number;
  readonly inter_op_num_threads?: number;
}

export interface LoadE5EmbedderOptions {
  readonly modelRoot: string;
  readonly signal?: AbortSignal;
  readonly cpu_threads?: E5CpuThreadOptions;
}

export interface E5EmbedRequest {
  readonly kind: E5InputKind;
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
}

export interface E5EmbedderReport {
  readonly state: "ready" | "disposing" | "disposed";
  readonly model_root: string;
  readonly model_id: string;
  readonly revision: string;
  readonly dimensions: 384;
  readonly max_tokens: 512;
  readonly dtype: "q8";
  readonly device: "cpu";
  readonly batch_strategy: "rowwise_batch1";
  readonly input_count: number;
  readonly completed_batches: number;
}

export interface LocalE5Embedder {
  readonly manifest: E5ModelManifest;
  embed(request: E5EmbedRequest): Promise<readonly Float32Array[]>;
  /** Counts the exact formatted input without truncation. */
  readonly countTokens?: (request: { readonly kind: E5InputKind; readonly text: string }) => number;
  dispose(options?: { readonly timeout_ms?: number }): Promise<void>;
  report(): E5EmbedderReport;
}

export type E5ModelErrorCode =
  | "model_input_invalid"
  | "model_input_too_large"
  | "model_batch_too_large"
  | "model_input_too_long"
  | "model_busy"
  | "model_aborted"
  | "model_disposed"
  | "model_load_failed"
  | "model_inference_failed"
  | "model_output_invalid"
  | "model_dispose_failed"
  | "model_dispose_timeout";

export class E5ModelError extends Error {
  readonly code: E5ModelErrorCode;

  constructor(code: E5ModelErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "E5ModelError";
    this.code = code;
  }
}

export const E5_MAX_BATCH_SIZE = 128;
export const E5_MAX_BATCH_BYTES = 4_000_000;
export const E5_MAX_TEXT_BYTES = 1_000_000;
export const E5_DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

const DEFAULT_INTRA_OP_THREADS = 2;
const DEFAULT_INTER_OP_THREADS = 1;
const MAX_INTRA_OP_THREADS = 4;
const MAX_INTER_OP_THREADS = 2;

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new E5ModelError("model_aborted");
}

export function formatE5Input(kind: E5InputKind, text: string): string {
  if (kind !== "query" && kind !== "passage") throw new E5ModelError("model_input_invalid");
  if (typeof text !== "string") throw new E5ModelError("model_input_invalid");
  return `${E5_MODEL_MANIFEST.prefixes[kind]}${text}`;
}

function validateCpuThreads(options: E5CpuThreadOptions | undefined): { readonly intraOpNumThreads: number; readonly interOpNumThreads: number } {
  const intraOpNumThreads = options?.intra_op_num_threads ?? DEFAULT_INTRA_OP_THREADS;
  const interOpNumThreads = options?.inter_op_num_threads ?? DEFAULT_INTER_OP_THREADS;
  if (!Number.isSafeInteger(intraOpNumThreads) || intraOpNumThreads < 1 || intraOpNumThreads > MAX_INTRA_OP_THREADS) {
    throw new E5ModelError("model_input_invalid");
  }
  if (!Number.isSafeInteger(interOpNumThreads) || interOpNumThreads < 1 || interOpNumThreads > MAX_INTER_OP_THREADS) {
    throw new E5ModelError("model_input_invalid");
  }
  return { intraOpNumThreads, interOpNumThreads };
}

function assertNativeRuntime(): void {
  // Shared pinned-profile check; loadE5Embedder wraps every non-E5 error as
  // model_load_failed before the model is ever published.
  assertNativeOnnxRuntime(E5_MODEL_MANIFEST.runtime.onnxruntime_node);
}

function validateTexts(request: E5EmbedRequest): string[] {
  if (typeof request !== "object" || request === null || (request.kind !== "query" && request.kind !== "passage")) {
    throw new E5ModelError("model_input_invalid");
  }
  if (!Array.isArray(request.texts) || request.texts.length === 0 || request.texts.length > E5_MAX_BATCH_SIZE) {
    throw new E5ModelError("model_batch_too_large");
  }
  const formatted: string[] = [];
  let totalBytes = 0;
  for (const text of request.texts) {
    if (typeof text !== "string") throw new E5ModelError("model_input_invalid");
    if (Buffer.byteLength(text, "utf8") > E5_MAX_TEXT_BYTES) throw new E5ModelError("model_input_too_large");
    const formattedText = formatE5Input(request.kind, text);
    const bytes = Buffer.byteLength(formattedText, "utf8");
    totalBytes += bytes;
    if (totalBytes > E5_MAX_BATCH_BYTES) throw new E5ModelError("model_input_too_large");
    formatted.push(formattedText);
  }
  return formatted;
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

function tokenCounts(inputs: unknown, batchSize: number): number[] {
  if (typeof inputs !== "object" || inputs === null || !("input_ids" in inputs) || !("attention_mask" in inputs)) {
    throw new E5ModelError("model_input_invalid");
  }
  const inputIds = (inputs as { readonly input_ids?: unknown }).input_ids;
  const attentionMask = (inputs as { readonly attention_mask?: unknown }).attention_mask;
  if (!isTensorLike(inputIds) || !isTensorLike(attentionMask)) throw new E5ModelError("model_input_invalid");
  if (inputIds.dims.length !== 2 || attentionMask.dims.length !== 2 || inputIds.dims[0] !== batchSize || attentionMask.dims[0] !== batchSize) {
    throw new E5ModelError("model_input_invalid");
  }
  const sequenceLength = inputIds.dims[1];
  if (
    typeof sequenceLength !== "number" ||
    !Number.isSafeInteger(sequenceLength) ||
    sequenceLength < 1 ||
    attentionMask.dims[1] !== sequenceLength
  ) {
    throw new E5ModelError("model_input_invalid");
  }
  const counts: number[] = [];
  for (let row = 0; row < batchSize; row += 1) {
    let count = 0;
    for (let column = 0; column < sequenceLength; column += 1) {
      const value = Number(attentionMask.data[row * sequenceLength + column]);
      if (value !== 0 && value !== 1) throw new E5ModelError("model_input_invalid");
      count += value;
    }
    if (count < 1) throw new E5ModelError("model_input_invalid");
    counts.push(count);
  }
  return counts;
}

interface TensorLike {
  readonly dims: readonly number[];
  readonly data: ArrayLike<number | bigint | boolean>;
  readonly dispose?: () => void;
}

type TensorTransform = (hidden: TensorLike, mask: TensorLike) => TensorLike;

interface CallableModel {
  (inputs: unknown): Promise<unknown>;
  readonly config?: unknown;
  readonly dispose: () => Promise<unknown>;
}

interface TokenizerLike {
  (texts: string[], options: { readonly padding: boolean; readonly truncation: boolean }): unknown;
}

function isTensorLike(value: unknown): value is TensorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "dims" in value &&
    Array.isArray((value as { readonly dims?: unknown }).dims) &&
    "data" in value &&
    typeof (value as { readonly data?: unknown }).data === "object" &&
    (value as { readonly data?: unknown }).data !== null
  );
}

function outputVectors(
  output: unknown,
  batchSize: number,
  meanPooling: TensorTransform,
  mask: TensorLike,
): Float32Array[] {
  if (typeof output !== "object" || output === null || !("last_hidden_state" in output)) {
    throw new E5ModelError("model_output_invalid");
  }
  const hidden = (output as { readonly last_hidden_state?: unknown }).last_hidden_state;
  if (!isTensorLike(hidden) || hidden.dims.length !== 3 || hidden.dims[0] !== batchSize || hidden.dims[2] !== E5_MODEL_MANIFEST.dimensions) {
    throw new E5ModelError("model_output_invalid");
  }
  if (mask.dims.length !== 2 || mask.dims[0] !== batchSize || mask.dims[1] !== hidden.dims[1]) {
    throw new E5ModelError("model_output_invalid");
  }
  let pooled: TensorLike | undefined;
  let normalized: TensorLike | undefined;
  try {
    pooled = meanPooling(hidden, mask);
    if (!isTensorLike(pooled) || pooled.dims.length !== 2 || pooled.dims[0] !== batchSize || pooled.dims[1] !== E5_MODEL_MANIFEST.dimensions) {
      throw new E5ModelError("model_output_invalid");
    }
    const normalize = (pooled as TensorLike & { readonly normalize?: unknown }).normalize;
    if (typeof normalize !== "function") throw new E5ModelError("model_output_invalid");
    const normalizedValue = normalize.call(pooled, 2, -1);
    if (!isTensorLike(normalizedValue) || normalizedValue.dims.length !== 2 || normalizedValue.dims[0] !== batchSize || normalizedValue.dims[1] !== E5_MODEL_MANIFEST.dimensions) {
      throw new E5ModelError("model_output_invalid");
    }
    normalized = normalizedValue;
    const data = normalized.data;
    if (data.length !== batchSize * E5_MODEL_MANIFEST.dimensions) {
      throw new E5ModelError("model_output_invalid");
    }
    const vectors: Float32Array[] = [];
    for (let row = 0; row < batchSize; row += 1) {
      const vector = new Float32Array(E5_MODEL_MANIFEST.dimensions);
      let squaredNorm = 0;
      for (let column = 0; column < E5_MODEL_MANIFEST.dimensions; column += 1) {
        const value = Number(data[row * E5_MODEL_MANIFEST.dimensions + column]);
        if (!Number.isFinite(value)) throw new E5ModelError("model_output_invalid");
        vector[column] = value;
        squaredNorm += value * value;
      }
      const norm = Math.sqrt(squaredNorm);
      if (!Number.isFinite(norm) || norm <= 0 || Math.abs(norm - 1) > 0.002) {
        throw new E5ModelError("model_output_invalid");
      }
      vectors.push(vector);
    }
    return vectors;
  } finally {
    disposeValues([pooled, normalized]);
  }
}

class LocalE5EmbedderImpl implements LocalE5Embedder {
  readonly manifest = E5_MODEL_MANIFEST;
  private readonly model: CallableModel;
  private readonly tokenizer: TokenizerLike;
  private readonly meanPooling: TensorTransform;
  private readonly modelRoot: string;
  private state: E5EmbedderReport["state"] = "ready";
  private disposePromise: Promise<void> | undefined;
  private activePromise: Promise<readonly Float32Array[]> | undefined;
  private inputCount = 0;
  private completedBatches = 0;

  constructor(
    verified: VerifiedE5Artifacts,
    tokenizer: TokenizerLike,
    model: CallableModel,
    meanPooling: TensorTransform,
  ) {
    this.modelRoot = verified.model_root;
    this.tokenizer = tokenizer;
    this.model = model;
    this.meanPooling = meanPooling;
  }

  embed(request: E5EmbedRequest): Promise<readonly Float32Array[]> {
    if (this.state !== "ready") return Promise.reject(new E5ModelError("model_disposed"));
    let signal: AbortSignal | undefined;
    let formatted: string[];
    try {
      // Validate and copy before returning. The caller may mutate its array or
      // object immediately after this method returns; model work must use only
      // this owned bounded copy.
      signal = request?.signal;
      assertNotAborted(signal);
      formatted = validateTexts(request);
      assertNotAborted(signal);
    } catch (error: unknown) {
      return Promise.reject(error instanceof E5ModelError ? error : new E5ModelError("model_input_invalid", error));
    }
    if (this.activePromise !== undefined) return Promise.reject(new E5ModelError("model_busy"));
    const active = this.embedNow(formatted, signal);
    this.activePromise = active;
    void active.finally(() => {
      if (this.activePromise === active) this.activePromise = undefined;
    }).catch(() => undefined);
    return active;
  }

  countTokens(request: { readonly kind: E5InputKind; readonly text: string }): number {
    if (typeof request !== "object" || request === null || typeof request.text !== "string") {
      throw new E5ModelError("model_input_invalid");
    }
    const formatted = formatE5Input(request.kind, request.text);
    let inputs: unknown;
    try {
      inputs = this.tokenizer([formatted], { padding: true, truncation: false });
      const count = tokenCounts(inputs, 1)[0];
      // Counting must admit overlong sources so the worker can split them before inference.
      if (count === undefined) throw new E5ModelError("model_input_invalid");
      return count;
    } finally {
      if (typeof inputs === "object" && inputs !== null) disposeValues(Object.values(inputs));
    }
  }

  async dispose(options: { readonly timeout_ms?: number } = {}): Promise<void> {
    if (this.state === "disposed") return;
    const timeout = options.timeout_ms ?? E5_DEFAULT_DISPOSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new E5ModelError("model_input_invalid");
    if (this.disposePromise === undefined) {
      this.state = "disposing";
      const active = this.activePromise ?? Promise.resolve();
      const activeSettled = active.then(
        () => undefined,
        () => undefined,
      );
      this.disposePromise = activeSettled.then(async () => {
        try {
          await this.model.dispose();
          this.state = "disposed";
        } catch (error: unknown) {
          throw new E5ModelError("model_dispose_failed", error);
        }
      });
    }
    return withTimeout(this.disposePromise, timeout);
  }

  report(): E5EmbedderReport {
    return {
      state: this.state,
      model_root: this.modelRoot,
      model_id: this.manifest.model_id,
      revision: this.manifest.revision,
      dimensions: this.manifest.dimensions,
      max_tokens: this.manifest.max_tokens,
      dtype: this.manifest.dtype,
      device: this.manifest.device,
      batch_strategy: this.manifest.batch_strategy,
      input_count: this.inputCount,
      completed_batches: this.completedBatches,
    };
  }

  private async embedNow(formatted: readonly string[], signal: AbortSignal | undefined): Promise<readonly Float32Array[]> {
    if (this.state === "disposed") throw new E5ModelError("model_disposed");
    assertNotAborted(signal);
    const vectors: Float32Array[] = [];
    for (const text of formatted) {
      let inputs: unknown;
      let outputs: unknown;
      try {
        // The pinned q8 ONNX profile uses dynamic activation quantization. Its
        // output can vary with unrelated rows in one batch, so each row is
        // intentionally evaluated with batch size one. This keeps embeddings
        // invariant when callers add or remove padded/neighbor rows.
        inputs = this.tokenizer([text], { padding: true, truncation: false });
        const counts = tokenCounts(inputs, 1);
        if (counts[0] === undefined || counts[0] > this.manifest.max_tokens) {
          throw new E5ModelError("model_input_too_long");
        }
        assertNotAborted(signal);
        outputs = await this.model(inputs);
        assertNotAborted(signal);
        const attentionMask = (inputs as { readonly attention_mask?: unknown }).attention_mask;
        if (!isTensorLike(attentionMask)) throw new E5ModelError("model_input_invalid");
        const row = outputVectors(outputs, 1, this.meanPooling, attentionMask)[0];
        if (row === undefined) throw new E5ModelError("model_output_invalid");
        vectors.push(row);
      } catch (error: unknown) {
        if (error instanceof E5ModelError) throw error;
        if (signal?.aborted) throw new E5ModelError("model_aborted", error);
        throw new E5ModelError("model_inference_failed", error);
      } finally {
        const inputValues = typeof inputs === "object" && inputs !== null ? Object.values(inputs) : [];
        const outputValues = typeof outputs === "object" && outputs !== null ? Object.values(outputs) : [];
        disposeValues([...inputValues, ...outputValues]);
      }
    }
    this.inputCount += formatted.length;
    this.completedBatches += 1;
    return vectors;
  }
}

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new E5ModelError("model_dispose_timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function loadE5Embedder(options: LoadE5EmbedderOptions): Promise<LocalE5Embedder> {
  if (typeof options !== "object" || options === null) throw new E5ModelError("model_input_invalid");
  assertNotAborted(options.signal);
  const threads = validateCpuThreads(options.cpu_threads);
  const modelRoot = resolveOwnedModelRoot(options.modelRoot);
  const verified = await verifyE5Artifacts(modelRoot);
  assertNotAborted(options.signal);
  let tokenizer: unknown;
  let model: CallableModel | undefined;
  try {
    assertNativeRuntime();
    // These options are the pinned Transformers.js 4.2.0 API. The absolute
    // verified directory avoids the revisioned tokenizer-discovery path and
    // `local_files_only` remains explicit at both loader boundaries.
    // Source: https://raw.githubusercontent.com/huggingface/transformers.js/4.2.0/packages/transformers/src/models/auto/modeling_auto.js
    const transformers = await import("@huggingface/transformers");
    if (transformers.env.version !== E5_MODEL_MANIFEST.runtime.transformers_js) {
      throw new E5ModelError("model_load_failed");
    }
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;
    // A verified absolute path is the only input authority. Transformers.js
    // checks caches before local files, so disable every optional cache route
    // for this profile; otherwise a stale global/custom cache could replace a
    // hash-verified artifact with different bytes.
    transformers.env.useBrowserCache = false;
    transformers.env.useFSCache = false;
    transformers.env.useCustomCache = false;
    transformers.env.experimental_useCrossOriginStorage = false;
    transformers.env.useWasmCache = false;
    tokenizer = await transformers.AutoTokenizer.from_pretrained(verified.model_root, {
      revision: E5_MODEL_MANIFEST.revision,
      local_files_only: true,
    });
    assertNotAborted(options.signal);
    model = (await transformers.AutoModel.from_pretrained(verified.model_root, {
      revision: E5_MODEL_MANIFEST.revision,
      dtype: E5_MODEL_MANIFEST.dtype,
      device: E5_MODEL_MANIFEST.device,
      local_files_only: true,
      session_options: {
        intraOpNumThreads: threads.intraOpNumThreads,
        interOpNumThreads: threads.interOpNumThreads,
      },
    })) as unknown as CallableModel;
    assertNotAborted(options.signal);
    const modelConfig = model.config;
    const hiddenSize = typeof modelConfig === "object" && modelConfig !== null && "hidden_size" in modelConfig
      ? (modelConfig as { readonly hidden_size?: unknown }).hidden_size
      : undefined;
    if (hiddenSize !== E5_MODEL_MANIFEST.dimensions) throw new E5ModelError("model_load_failed");
    return new LocalE5EmbedderImpl(
      verified,
      tokenizer as TokenizerLike,
      model,
      // Official helper: masked mean over [batch, sequence, hidden]. L2 is
      // applied below through Tensor.normalize before copying owned vectors.
      // Source: https://raw.githubusercontent.com/huggingface/transformers.js/4.2.0/packages/transformers/src/utils/tensor.js
      (hidden, mask) => transformers.mean_pooling(hidden as never, mask as never) as never,
    );
  } catch (error: unknown) {
    if (model !== undefined) {
      try {
        await model.dispose();
      } catch {
        // Preserve the original load failure; the model was never published.
      }
    }
    if (error instanceof E5ModelError) throw error;
    if (options.signal?.aborted) throw new E5ModelError("model_aborted", error);
    throw new E5ModelError("model_load_failed", error);
  }
}

export { ModelArtifactError };
