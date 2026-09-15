import { z } from "zod";

import {
  resolveTextAtPath,
  validateSpanExcerpt,
} from "../core/capture.js";
import {
  validateBoundRecallRequest,
  type TrustedBinding,
} from "../host/contract.js";
import type { AgentMemoryDatabase, SearchCandidateRow } from "../store/database.js";

const MAX_RESULTS = 200;
const MAX_MATCH_BYTES = 2_048;
const MAX_QUERY_TOKENS = 64;
const MAX_TOKEN_LENGTH = 128;
const dateTimeSchema = z.iso.datetime({ offset: true });

export type LexicalSearchErrorCode =
  | "query_empty"
  | "query_too_complex"
  | "limit_invalid"
  | "source_span_missing"
  | "source_span_invalid"
  | "search_unavailable";

export class LexicalSearchError extends Error {
  readonly code: LexicalSearchErrorCode;

  constructor(code: LexicalSearchErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "LexicalSearchError";
    this.code = code;
  }
}

export interface LexicalResult {
  readonly lexical_match: true;
  readonly span_id: string;
  readonly source_id: string;
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
  readonly rank: number;
}

export interface LexicalSearchOptions {
  readonly excluded_capture_id?: string;
  readonly exclude_current_session_prompts?: boolean;
  readonly any_terms?: boolean;
}

function safeOffset(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LexicalSearchError("source_span_invalid", new Error(field));
  }
  return Number(value);
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new LexicalSearchError("source_span_invalid", new Error(field, { cause: error }));
  }
}

function validateDate(value: string, field: string): string {
  const result = dateTimeSchema.safeParse(value);
  if (!result.success) throw new LexicalSearchError("search_unavailable", new Error(field));
  return result.data;
}

function quotedMatch(query: string, anyTerms = false): string | undefined {
  // Keep Unicode compatibility forms as supplied. The index stores the
  // canonical source text with unicode61; folding only the query would make
  // an opaque identifier such as fullwidth `ＡＢＣ` unsearchable.
  const comparable = query.toLocaleLowerCase("und");
  const tokens = comparable.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) return undefined;
  if (uniqueTokens.length > MAX_QUERY_TOKENS || uniqueTokens.some((token) => token.length > MAX_TOKEN_LENGTH)) {
    throw new LexicalSearchError("query_too_complex");
  }
  const match = uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(anyTerms ? " OR " : " ");
  if (Buffer.byteLength(match, "utf8") > MAX_MATCH_BYTES) {
    throw new LexicalSearchError("query_too_complex");
  }
  return match;
}

function assertCandidateIntegrity(candidate: SearchCandidateRow): {
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
    throw new LexicalSearchError("source_span_missing");
  }
  if (
    candidate.document_span_id !== candidate.source_span_id ||
    candidate.document_source_id !== candidate.source_id ||
    candidate.document_scope_id !== candidate.source_scope ||
    candidate.source_scope_id !== candidate.source_scope ||
    candidate.document_root !== candidate.source_root ||
    candidate.document_path !== candidate.source_path ||
    candidate.document_start_utf16 !== candidate.source_start_utf16 ||
    candidate.document_end_utf16 !== candidate.source_end_utf16 ||
    candidate.document_digest.toLowerCase() !== candidate.source_digest.toLowerCase() ||
    candidate.document_representation !== "lexical" ||
    candidate.document_eligible !== 1n
  ) {
    throw new LexicalSearchError("source_span_invalid");
  }

  const start = safeOffset(candidate.source_start_utf16, "start_utf16");
  const end = safeOffset(candidate.source_end_utf16, "end_utf16");
  const payload = parseJson(candidate.payload_json, "payload_json");
  const event = parseJson(candidate.event_json, "event_json");
  let quote: string;
  try {
    const root = candidate.source_root === "event" ? event : payload;
    quote = validateSpanExcerpt(
      resolveTextAtPath(root, candidate.source_path),
      start,
      end,
      candidate.source_digest,
    );
  } catch (error: unknown) {
    throw new LexicalSearchError("source_span_invalid", error);
  }
  if (quote !== candidate.document_text) throw new LexicalSearchError("source_span_invalid");
  return {
    root: candidate.source_root,
    path: candidate.source_path,
    start,
    end,
    digest: candidate.source_digest.toLowerCase(),
    quote,
  };
}

/**
 * Perform a lexical-only recall. The database repeats trusted binding and
 * scope validation; this function only turns user text into quoted FTS terms
 * and hydrates raw source matches from canonical rows. `valid_at` is carried
 * by the request for later bitemporal resolution and does not reinterpret an
 * occurrence timestamp as fact validity in this raw-source stage.
 */
export function lexicalSearch(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  input: unknown,
  limit = 20,
  options: LexicalSearchOptions = {},
): LexicalResult[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new LexicalSearchError("limit_invalid");
  }
  const request = validateBoundRecallRequest(input, binding);
  const match = quotedMatch(request.query, options.any_terms === true);
  if (match === undefined) return [];

  let candidates: SearchCandidateRow[];
  try {
    candidates = database.searchLexicalCandidates(
      request,
      binding,
      match,
      limit,
      options.excluded_capture_id,
      options.exclude_current_session_prompts,
      options.any_terms === true,
    );
  } catch (error: unknown) {
    if (error instanceof LexicalSearchError) throw error;
    throw new LexicalSearchError("search_unavailable", error);
  }

  return candidates.map((candidate) => {
    const hydrated = assertCandidateIntegrity(candidate);
    return {
      lexical_match: true,
      span_id: candidate.source_span_id ?? candidate.document_span_id,
      source_id: candidate.source_id,
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
      rank: candidate.rank,
    };
  });
}

export const searchLexical = lexicalSearch;
