import {
  validateBoundRecallRequest,
  type TrustedBinding,
} from "../host/contract.js";
import type { AgentMemoryDatabase } from "../store/database.js";
import {
  VECTOR_MAX_RESULTS,
  vectorSearch,
  type VectorResult,
  type VectorSearchOptions,
} from "./vector.js";
import {
  lexicalSearch,
  type LexicalResult,
  type LexicalSearchOptions,
} from "./lexical.js";

export const RRF_K = 60 as const;
export const HYBRID_INITIAL_TOP = 40 as const;
const HYBRID_OVERFETCH_FACTOR = 2 as const;

export type FusionErrorCode =
  | "limit_invalid"
  | "fusion_unavailable";

export class FusionError extends Error {
  readonly code: FusionErrorCode;

  constructor(code: FusionErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "FusionError";
    this.code = code;
  }
}

export interface FusedResult {
  readonly source_id: string;
  readonly revision_id: string | null;
  readonly scope_id: string;
  readonly chunk_id: string | undefined;
  readonly span_id: string;
  readonly quote: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly commit_seq: string;
  readonly data_epoch: string;
  readonly lexical_rank: number | undefined;
  readonly vector_rank: number | undefined;
  readonly rrf_score: number;
  readonly rank: number;
}

export interface HybridSearchOptions {
  readonly lexical?: LexicalSearchOptions;
  readonly vector?: VectorSearchOptions;
  readonly per_signal_limit?: number;
}

function rrfScore(rank: number, k: number = RRF_K): number {
  return 1 / (k + rank + 1);
}

/**
 * Fuse two independent rank lists with reciprocal rank fusion (k=60).
 * Identity is the source capture; the best chunk per source wins each
 * signal. Scores are summed; ties break by capture_id for determinism.
 * Inputs must already be eligibility-filtered; fusion never widens scope.
 */
export function fuseRanks(
  lexical: readonly { readonly source_id: string; readonly span_id?: string; readonly revision_id?: string | null }[],
  vector: readonly { readonly source_id: string; readonly span_id?: string; readonly revision_id?: string | null }[],
  limit: number,
  k: number = RRF_K,
): { readonly source_id: string; readonly span_id: string | undefined; readonly revision_id: string | null; readonly score: number; readonly lexical_rank: number | undefined; readonly vector_rank: number | undefined }[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > VECTOR_MAX_RESULTS) {
    throw new FusionError("limit_invalid");
  }
  if (k !== RRF_K) throw new FusionError("limit_invalid", new Error("rrf_k_fixed"));
  const scores = new Map<string, { source_id: string; span_id: string | undefined; revision_id: string | null; score: number; lexical_rank: number | undefined; vector_rank: number | undefined }>();
  const seenLexical = new Set<string>();
  const seenVector = new Set<string>();
  let lexicalRank = 0;
  lexical.forEach((entry) => {
    const identity = entry.source_id;
    if (seenLexical.has(identity)) return;
    seenLexical.add(identity);
    const current = scores.get(identity) ?? { source_id: entry.source_id, span_id: entry.span_id, revision_id: entry.revision_id ?? null, score: 0, lexical_rank: undefined, vector_rank: undefined };
    scores.set(identity, {
      source_id: entry.source_id,
      span_id: entry.span_id,
      revision_id: current.revision_id ?? entry.revision_id ?? null,
      score: current.score + rrfScore(lexicalRank, k),
      lexical_rank: current.lexical_rank ?? lexicalRank,
      vector_rank: current.vector_rank,
    });
    lexicalRank += 1;
  });
  let vectorRank = 0;
  vector.forEach((entry) => {
    const identity = entry.source_id;
    if (seenVector.has(identity)) return;
    seenVector.add(identity);
    const current = scores.get(identity) ?? { source_id: entry.source_id, span_id: entry.span_id, revision_id: entry.revision_id ?? null, score: 0, lexical_rank: undefined, vector_rank: undefined };
    scores.set(identity, {
      source_id: entry.source_id,
      span_id: entry.span_id,
      revision_id: current.revision_id ?? entry.revision_id ?? null,
      score: current.score + rrfScore(vectorRank, k),
      lexical_rank: current.lexical_rank,
      vector_rank: current.vector_rank ?? vectorRank,
    });
    vectorRank += 1;
  });
  return [...scores.entries()]
    .map(([, value]) => value)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0;
    })
    .slice(0, limit);
}

function groupKey(result: LexicalResult | VectorResult): string {
  return result.source_id;
}

/**
 * Hybrid recall: snapshot before candidates (via the store snapshot read in
 * each signal), fuse independent source-level FTS/vector ranks with RRF k=60,
 * then revalidate before output. Each signal gets a bounded 2x row/chunk
 * overfetch to keep repeated spans/chunks from crowding out other sources;
 * the overfetch is capped at the existing 200-result bound.
 */
export function hybridSearch(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  input: unknown,
  queryVector: Float32Array,
  limit = 20,
  options: HybridSearchOptions = {},
): FusedResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > VECTOR_MAX_RESULTS) {
    throw new FusionError("limit_invalid");
  }
  const request = validateBoundRecallRequest(input, binding);
  const perSignal = options.per_signal_limit ?? HYBRID_INITIAL_TOP;
  if (!Number.isSafeInteger(perSignal) || perSignal < limit || perSignal > VECTOR_MAX_RESULTS) {
    throw new FusionError("limit_invalid");
  }
  const candidateLimit = Math.min(VECTOR_MAX_RESULTS, perSignal * HYBRID_OVERFETCH_FACTOR);
  const scopeIds = [...new Set(request.scope_ids)];
  const snapshot = database.getRecallSnapshot(scopeIds, binding);
  const vectorGeneration = database.getActiveVectorGeneration();
  let lexical: LexicalResult[];
  let vector: VectorResult[];
  try {
    lexical = request.valid_at === undefined
      ? lexicalSearch(database, binding, request, candidateLimit, options.lexical ?? {})
      : [];
    vector = vectorSearch(database, binding, queryVector, request, candidateLimit, options.vector ?? {});
  } catch (error: unknown) {
    throw new FusionError("fusion_unavailable", error);
  }
  const lexicalBySource = new Map<string, LexicalResult>();
  for (const entry of lexical) {
    if (!lexicalBySource.has(groupKey(entry))) lexicalBySource.set(groupKey(entry), entry);
  }
  const vectorBySource = new Map<string, VectorResult>();
  for (const entry of vector) {
    if (!vectorBySource.has(groupKey(entry))) vectorBySource.set(groupKey(entry), entry);
  }
  const fused = fuseRanks(lexical, vector, limit);
  const output = fused.map((entry, rank) => {
    const identity = entry.source_id;
    const lexicalEntry = lexicalBySource.get(identity);
    const vectorEntry = vectorBySource.get(identity);
    const primary = (lexicalEntry ?? vectorEntry);
    if (primary === undefined) throw new FusionError("fusion_unavailable", new Error("fused_source_missing"));
    return {
      source_id: entry.source_id,
      revision_id: entry.revision_id,
      scope_id: primary.scope_id,
      chunk_id: vectorEntry?.chunk_id,
      span_id: primary.span_id,
      quote: primary.quote,
      captured_at: primary.captured_at,
      occurred_at: primary.occurred_at,
      commit_seq: primary.commit_seq,
      data_epoch: primary.data_epoch,
      lexical_rank: entry.lexical_rank,
      vector_rank: entry.vector_rank,
      rrf_score: entry.score,
      rank,
    } satisfies FusedResult;
  });
  const revalidated = database.revalidateRecallSnapshot(
    snapshot,
    binding,
    output.map((entry) => entry.source_id),
  );
  if (!revalidated) throw new FusionError("fusion_unavailable", new Error("snapshot_revalidation_failed"));
  if (database.getActiveVectorGeneration() !== vectorGeneration) {
    throw new FusionError("fusion_unavailable", new Error("vector_generation_changed"));
  }
  return output;
}
