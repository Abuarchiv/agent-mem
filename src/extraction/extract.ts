import { createHash } from "node:crypto";

import type { SourceSpanForValidation } from "../execution/protocol.js";
import { createExtractionCandidates, type ExtractionCandidate, type ExtractionCandidateInput } from "./schema.js";

export interface ExtractionInput extends ExtractionCandidateInput {
  readonly output: unknown;
  readonly sourceSpans: readonly SourceSpanForValidation[];
}

export interface SummaryProposal {
  readonly candidate_id: string;
  readonly candidate_digest: string;
  readonly summary: string;
  readonly source_span_ids: readonly string[];
  readonly status: "candidate";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function extractionOutputDigest(output: unknown): string {
  return createHash("sha256").update(stableJson(output), "utf8").digest("hex");
}

/**
 * Deterministic job-ledger result digest derived only from persisted batch
 * fields. Fresh commits and crash replays therefore bind the same result to
 * the extraction batch and the completing job record.
 */
export function extractionBatchResultDigest(batchId: string, extractionDigest: string | null, verificationDigest: string | null): string {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("extraction_batch_result_digest_invalid");
  if (extractionDigest !== null && !/^[a-f0-9]{64}$/i.test(extractionDigest)) throw new Error("extraction_batch_result_digest_invalid");
  if (verificationDigest !== null && !/^[a-f0-9]{64}$/i.test(verificationDigest)) throw new Error("extraction_batch_result_digest_invalid");
  return createHash("sha256").update(stableJson({ version: 1, batch_id: batchId.toLowerCase(), extraction_digest: extractionDigest === null ? null : extractionDigest.toLowerCase(), verification_digest: verificationDigest === null ? null : verificationDigest.toLowerCase() }), "utf8").digest("hex");
}

/** Structural extraction boundary used by the worker and offline callers. */
export function extractCandidates(input: ExtractionInput): readonly ExtractionCandidate[] {
  return createExtractionCandidates(input.output, input.sourceSpans, input);
}

/** Source-linked summary proposal for the later T13 consumer; it has no truth status. */
export function summaryProposals(candidates: readonly ExtractionCandidate[]): readonly SummaryProposal[] {
  return candidates
    .filter((candidate) => candidate.kind === "observation" && candidate.identity.predicate === "extracted_claim" && typeof candidate.value.value === "string")
    .map((candidate) => ({ candidate_id: candidate.candidate_id, candidate_digest: candidate.candidate_digest, summary: candidate.value.value as string, source_span_ids: candidate.source_span_ids, status: "candidate" as const }));
}
