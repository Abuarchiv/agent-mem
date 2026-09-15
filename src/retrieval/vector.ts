import { createHash } from "node:crypto";

import { z } from "zod";

import {
  resolveTextAtPath,
  validateSpanExcerpt,
} from "../core/capture.js";
import {
  validateBoundRecallRequest,
  type TrustedBinding,
} from "../host/contract.js";
import type {
  AgentMemoryDatabase,
  VectorCandidateRow,
} from "../store/database.js";

export const VECTOR_DIM = 384 as const;
export const VECTOR_MAX_TOKENS = 512 as const;
export const VECTOR_PROFILE_ID =
  "e5-multilingual-small-q8-761b726dd34fb83930e26aab4e9ac3899aa1fa78" as const;
export const VECTOR_TOKENIZER_VERSION =
  "Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78" as const;
export const VECTOR_CHUNKER_VERSION = "vector-chunker-v4" as const;
export const VECTOR_MAX_RESULTS = 200 as const;
export const VECTOR_BLOB_BYTES = 1_536 as const;

const dateTimeSchema = z.iso.datetime({ offset: true });

export type VectorSearchErrorCode =
  | "query_vector_invalid"
  | "limit_invalid"
  | "generation_invalid"
  | "profile_invalid"
  | "chunk_too_long"
  | "chunk_empty"
  | "source_span_missing"
  | "source_span_invalid"
  | "search_unavailable";

export class VectorSearchError extends Error {
  readonly code: VectorSearchErrorCode;

  constructor(code: VectorSearchErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "VectorSearchError";
    this.code = code;
  }
}

export interface VectorResult {
  readonly vector_match: true;
  readonly chunk_id: string;
  readonly span_id: string;
  readonly source_id: string;
  readonly revision_id: string | null;
  readonly scope_id: string;
  readonly root: "payload" | "event";
  readonly path: string;
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly digest: string;
  readonly quote: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly commit_seq: string;
  readonly data_epoch: string;
  readonly generation: string;
  readonly distance: number;
  readonly rank: number;
}

export interface VectorSearchOptions {
  readonly excluded_capture_id?: string;
  readonly generation?: string;
  readonly profile_id?: string;
  readonly exclude_current_session_prompts?: boolean;
}

export interface ChunkRequest {
  readonly chunk_id: string;
  readonly span_id: string;
  readonly chunk_index: number;
  readonly text: string;
}

export interface ProjectedChunk extends ChunkRequest {
  readonly input_digest: string;
  readonly source_digest: string;
}

function safeOffset(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VectorSearchError("source_span_invalid", new Error(field));
  }
  return Number(value);
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new VectorSearchError("source_span_invalid", new Error(field, { cause: error }));
  }
}

function validateDate(value: string, field: string): string {
  const result = dateTimeSchema.safeParse(value);
  if (!result.success) throw new VectorSearchError("search_unavailable", new Error(field));
  return result.data;
}

function assertQueryVector(vector: unknown): Float32Array {
  if (!(vector instanceof Float32Array) || vector.length !== VECTOR_DIM) {
    throw new VectorSearchError("query_vector_invalid");
  }
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new VectorSearchError("query_vector_invalid");
    }
    squaredNorm += (value as number) * (value as number);
  }
  if (!(squaredNorm > 0) || !Number.isFinite(squaredNorm)) {
    throw new VectorSearchError("query_vector_invalid");
  }
  return vector;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

const MAX_UNIT_UTF16 = 400;
const MAX_WINDOW_UTF16 = 1_800;

function splitLongRange(text: string, start: number, end: number): TextRange[] {
  const ranges: TextRange[] = [];
  let currentStart = start;
  let currentEnd = start;
  for (const match of text.slice(start, end).matchAll(/\s+|\S+/gu)) {
    const tokenStart = start + (match.index ?? 0);
    const tokenEnd = tokenStart + match[0].length;
    if (currentEnd > currentStart && tokenEnd - currentStart > MAX_UNIT_UTF16) {
      ranges.push({ start: currentStart, end: currentEnd });
      currentStart = tokenStart;
    }
    currentEnd = tokenEnd;
  }
  if (currentEnd > currentStart) ranges.push({ start: currentStart, end: currentEnd });
  return ranges;
}

function splitUnits(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const boundaryPattern = /(?<=[.!?])\s+|\n{2,}/gu;
  let segmentStart = 0;
  const append = (start: number, end: number): void => {
    if (end <= start) return;
    if (end - start <= MAX_UNIT_UTF16) ranges.push({ start, end });
    else ranges.push(...splitLongRange(text, start, end));
  };
  for (const match of text.matchAll(boundaryPattern)) {
    const boundaryStart = match.index ?? 0;
    const boundaryEnd = boundaryStart + match[0].length;
    append(segmentStart, boundaryEnd);
    segmentStart = boundaryEnd;
  }
  append(segmentStart, text.length);
  return ranges;
}

/**
 * Split passage text into chunks whose formatted E5 token count (including
 * the `passage: ` prefix and tokenizer special tokens) is <= 512. The caller
 * supplies token counting from the real E5 tokenizer; this function never
 * silently truncates. A minimal unit that alone exceeds the budget fails
 * closed with `chunk_too_long`.
 */
export function chunkPassageForE5(
  text: string,
  countTokens: (formattedPassage: string) => number,
): string[] {
  if (typeof text !== "string" || text.length === 0) {
    throw new VectorSearchError("chunk_empty");
  }
  if (text.length <= MAX_WINDOW_UTF16) {
    const direct = countTokens(`passage: ${text}`);
    if (!Number.isSafeInteger(direct) || direct < 1) {
      throw new VectorSearchError("search_unavailable", new Error("token_count_invalid"));
    }
    if (direct <= VECTOR_MAX_TOKENS) return [text];
  }
  const units = splitUnits(text);
  const windows: Array<{ readonly first: number; readonly last: number }> = [];
  let windowFirst = 0;
  for (let index = 1; index < units.length; index += 1) {
    const firstUnit = units[windowFirst];
    const currentUnit = units[index];
    if (firstUnit === undefined || currentUnit === undefined) throw new VectorSearchError("chunk_empty");
    if (currentUnit.end - firstUnit.start > MAX_WINDOW_UTF16) {
      windows.push({ first: windowFirst, last: index });
      windowFirst = index;
    }
  }
  if (windowFirst < units.length) windows.push({ first: windowFirst, last: units.length });
  const chunks: string[] = [];
  const appendBudgeted = (first: number, last: number): void => {
    const firstUnit = units[first];
    const lastUnit = units[last - 1];
    if (firstUnit === undefined || lastUnit === undefined) throw new VectorSearchError("chunk_empty");
    const candidate = text.slice(firstUnit.start, lastUnit.end);
    const candidateCount = countTokens(`passage: ${candidate}`);
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) {
      throw new VectorSearchError("search_unavailable", new Error("token_count_invalid"));
    }
    if (candidateCount <= VECTOR_MAX_TOKENS) {
      chunks.push(candidate);
      return;
    }
    if (last - first === 1) throw new VectorSearchError("chunk_too_long", new Error(`unit_tokens=${candidateCount}`));
    const middle = first + Math.floor((last - first) / 2);
    appendBudgeted(first, middle);
    appendBudgeted(middle, last);
  };
  for (const window of windows) appendBudgeted(window.first, window.last);
  if (chunks.length === 0) throw new VectorSearchError("chunk_empty");
  return chunks;
}

/** Minimal tokenizer counter shape matching the pinned Transformers.js tokenizer call. */
export interface E5TokenizerLike {
  (texts: string[], options: { readonly padding: boolean; readonly truncation: boolean }): unknown;
}

/**
 * Build a token counter from the real E5 tokenizer object. Reads the
 * attention mask for the single formatted row, so prefix and special tokens
 * are included exactly as the model sees them.
 */
export function createE5TokenCounter(tokenizer: E5TokenizerLike): (formattedPassage: string) => number {
  return (formattedPassage: string): number => {
    const inputs = tokenizer([formattedPassage], { padding: true, truncation: false }) as {
      readonly attention_mask?: { readonly dims?: readonly unknown[]; readonly data?: ArrayLike<unknown> };
    };
    const mask = inputs.attention_mask;
    if (typeof mask !== "object" || mask === null || !Array.isArray(mask.dims) || mask.dims.length !== 2) {
      throw new VectorSearchError("search_unavailable", new Error("tokenizer_mask_invalid"));
    }
    const [rows, columns] = mask.dims as readonly unknown[];
    if (rows !== 1 || typeof columns !== "number" || !Number.isSafeInteger(columns) || columns < 1) {
      throw new VectorSearchError("search_unavailable", new Error("tokenizer_mask_shape"));
    }
    const data = mask.data;
    if (data === undefined || data === null || typeof data.length !== "number") {
      throw new VectorSearchError("search_unavailable", new Error("tokenizer_mask_data"));
    }
    let count = 0;
    for (let index = 0; index < (columns as number); index += 1) {
      const value = Number((data as ArrayLike<unknown>)[index]);
      if (value !== 0 && value !== 1) throw new VectorSearchError("search_unavailable", new Error("tokenizer_mask_value"));
      count += value;
    }
    return count;
  };
}

export function vectorInputDigest(input: {
  readonly scope_id: string;
  readonly source_id: string;
  readonly span_id: string;
  readonly chunk_index: number;
  readonly text: string;
  readonly profile_id: string;
  readonly tokenizer_version: string;
  readonly chunker_version: string;
  readonly generation: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.scope_id,
        input.source_id,
        input.span_id,
        String(input.chunk_index),
        input.text,
        input.profile_id,
        input.tokenizer_version,
        input.chunker_version,
        input.generation,
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

export function digestText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function encodeVectorBlob(vector: Float32Array): Buffer {
  assertQueryVector(vector);
  const buffer = Buffer.alloc(VECTOR_BLOB_BYTES);
  for (let index = 0; index < VECTOR_DIM; index += 1) {
    buffer.writeFloatLE(vector[index] as number, index * 4);
  }
  return buffer;
}

export function decodeVectorBlob(blob: Uint8Array): Float32Array {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== VECTOR_BLOB_BYTES) {
    throw new VectorSearchError("source_span_invalid", new Error("vector_blob_bytes"));
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(VECTOR_DIM);
  for (let index = 0; index < VECTOR_DIM; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) throw new VectorSearchError("source_span_invalid", new Error("vector_float"));
    vector[index] = value;
  }
  return vector;
}

/** Cosine distance in [0, 2]; 0 is identical direction. Exact, no truncation. */
export function cosineDistance(left: Float32Array, right: Float32Array): number {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== VECTOR_DIM || right.length !== VECTOR_DIM) {
    throw new VectorSearchError("query_vector_invalid");
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < VECTOR_DIM; index += 1) {
    const leftValue = left[index] as number;
    const rightValue = right[index] as number;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new VectorSearchError("query_vector_invalid");
    }
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) throw new VectorSearchError("query_vector_invalid");
  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return 1 - Math.max(-1, Math.min(1, similarity));
}

function assertCandidateIntegrity(candidate: VectorCandidateRow): {
  root: "payload" | "event";
  path: string;
  start: number;
  end: number;
  digest: string;
  quote: string;
} {
  if (
    candidate.source_span_id === null ||
    candidate.source_scope_id === null ||
    candidate.source_root === null ||
    candidate.source_path === null ||
    candidate.source_start_utf16 === null ||
    candidate.source_end_utf16 === null ||
    candidate.source_digest === null
  ) {
    throw new VectorSearchError("source_span_missing");
  }
  if (
    candidate.chunk_scope_id !== candidate.source_scope ||
    candidate.source_scope_id !== candidate.source_scope ||
    candidate.chunk_source_id !== candidate.source_id ||
    candidate.document_span_id !== candidate.source_span_id ||
    candidate.document_source_id !== candidate.source_id ||
    candidate.chunk_root !== candidate.source_root ||
    candidate.chunk_path !== candidate.source_path ||
    candidate.chunk_chunker_version !== VECTOR_CHUNKER_VERSION ||
    candidate.chunk_eligible !== 1n
  ) {
    throw new VectorSearchError("source_span_invalid");
  }
  if (candidate.chunk_siblings.length === 0 || candidate.chunk_siblings.length > 128) {
    throw new VectorSearchError("source_span_invalid");
  }
  const sourceStart = safeOffset(candidate.source_start_utf16, "source_start_utf16");
  const sourceEnd = safeOffset(candidate.source_end_utf16, "source_end_utf16");
  const payload = parseJson(candidate.payload_json, "payload_json");
  const event = parseJson(candidate.event_json, "event_json");
  const root = candidate.source_root === "event" ? event : payload;
  let sourceQuote: string;
  try {
    sourceQuote = validateSpanExcerpt(
      resolveTextAtPath(root, candidate.source_path),
      sourceStart,
      sourceEnd,
      candidate.source_digest,
    );
  } catch (error: unknown) {
    throw new VectorSearchError("source_span_invalid", error);
  }
  let previousIndex: bigint | undefined;
  let candidateIndex = -1;
  for (const [index, sibling] of candidate.chunk_siblings.entries()) {
    if (previousIndex !== undefined && sibling.chunk_index <= previousIndex) {
      throw new VectorSearchError("source_span_invalid");
    }
    previousIndex = sibling.chunk_index;
    if (sibling.chunk_id === candidate.chunk_id) {
      if (candidateIndex !== -1) throw new VectorSearchError("source_span_invalid");
      candidateIndex = index;
    }
  }
  if (candidateIndex === -1 || candidate.chunk_siblings.map((sibling) => sibling.text).join("") !== sourceQuote) {
    throw new VectorSearchError("source_span_invalid");
  }
  const chunkDigest = digestText(candidate.chunk_text);
  if (candidate.chunk_digest.toLowerCase() !== chunkDigest) {
    throw new VectorSearchError("source_span_invalid");
  }
  if (candidate.chunk_siblings[candidateIndex]?.text !== candidate.chunk_text) {
    throw new VectorSearchError("source_span_invalid");
  }
  let relativeStart = 0;
  for (let index = 0; index < candidateIndex; index += 1) {
    relativeStart += candidate.chunk_siblings[index]?.text.length ?? 0;
  }
  const start = sourceStart + relativeStart;
  const end = start + candidate.chunk_text.length;
  if (start < sourceStart || end > sourceEnd || end <= start) {
    throw new VectorSearchError("source_span_invalid");
  }
  let quote: string;
  try {
    quote = validateSpanExcerpt(resolveTextAtPath(root, candidate.source_path), start, end, chunkDigest);
  } catch (error: unknown) {
    throw new VectorSearchError("source_span_invalid", error);
  }
  if (quote !== candidate.chunk_text) throw new VectorSearchError("source_span_invalid");
  return {
    root: candidate.source_root,
    path: candidate.source_path,
    start,
    end,
    digest: chunkDigest,
    quote,
  };
}

/**
 * Exact vector recall over already-authorized relational rows (scalar cosine
 * fallback). Eligibility (scope, grant, eligible, generation, purge, known_at)
 * is applied in SQL BEFORE any ordering/limit; distances are computed over
 * that authorized set with no truncation. This is the correct fallback when
 * vec0 cannot execute the complete authorized TopK filter reliably.
 */
export function vectorSearch(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  queryVector: Float32Array,
  input: unknown,
  limit = 20,
  options: VectorSearchOptions = {},
): VectorResult[] {
  const checked = assertQueryVector(queryVector);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > VECTOR_MAX_RESULTS) {
    throw new VectorSearchError("limit_invalid");
  }
  const request = validateBoundRecallRequest(input, binding);
  let candidates: VectorCandidateRow[];
  try {
    candidates = database.searchVectorCandidates(request, binding, checked, {
      limit,
      excluded_capture_id: options.excluded_capture_id,
      generation: options.generation,
      profile_id: options.profile_id,
      exclude_current_session_prompts: options.exclude_current_session_prompts,
      chunker_version: VECTOR_CHUNKER_VERSION,
    });
  } catch (error: unknown) {
    if (error instanceof VectorSearchError) throw error;
    throw new VectorSearchError("search_unavailable", error);
  }
  return candidates.map((candidate, index) => {
    const hydrated = assertCandidateIntegrity(candidate);
    return {
      vector_match: true as const,
      chunk_id: candidate.chunk_id,
      span_id: candidate.source_span_id ?? candidate.document_span_id,
      source_id: candidate.source_id,
      revision_id: candidate.chunk_revision_id,
      scope_id: candidate.source_scope,
      root: hydrated.root,
      path: hydrated.path,
      start_utf16: hydrated.start,
      end_utf16: hydrated.end,
      digest: hydrated.digest,
      quote: hydrated.quote,
      captured_at: validateDate(candidate.captured_at, "captured_at"),
      occurred_at: candidate.occurred_at === null ? null : validateDate(candidate.occurred_at, "occurred_at"),
      commit_seq: candidate.commit_seq.toString(10),
      data_epoch: candidate.data_epoch.toString(10),
      generation: candidate.chunk_generation.toString(10),
      distance: candidate.distance,
      rank: index,
    };
  });
}

export const searchVector = vectorSearch;
