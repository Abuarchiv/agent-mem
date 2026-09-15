import { validatePhaseOutput, type SourceSpanForValidation } from "../execution/protocol.js";
import {
  createVerificationReceipt,
  isPositiveVerification,
  parseExtractionCandidate,
  verificationJudgmentSchema,
  type ExtractionCandidate,
  type VerificationJudgment,
  type VerificationReceipt,
} from "./schema.js";

export class VerificationValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VerificationValidationError";
  }
}

function requireText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new VerificationValidationError(code);
  return value;
}

/** Validate the separate verifier result against the exact server-owned set. */
export function verifyExtractionCandidates(
  output: unknown,
  candidates: readonly ExtractionCandidate[],
  sourceSpans: readonly SourceSpanForValidation[],
  batchId: string,
): VerificationReceipt {
  const parsedOutput = validatePhaseOutput("verify", output, sourceSpans) as Record<string, unknown>;
  if (parsedOutput.status !== "evaluated") throw new VerificationValidationError("verification_skipped");
  const values = parsedOutput.verifications;
  if (!Array.isArray(values) || values.length !== candidates.length) throw new VerificationValidationError("verification_coverage_incomplete");
  const judgments: VerificationJudgment[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new VerificationValidationError("verification_item_invalid");
    const item = value as Record<string, unknown>;
    const candidateId = requireText(item.candidate_id, "verification_candidate_id_missing");
    const candidateDigest = requireText(item.candidate_digest, "verification_candidate_digest_missing");
    const entailment = item.entailment ?? item.verdict;
    const attribution = item.attribution_judgment;
    const modality = item.modality_judgment;
    const negation = item.negation_judgment;
    const time = item.time_judgment;
    if (typeof entailment !== "string" || typeof attribution !== "string" || typeof modality !== "string" || typeof negation !== "string" || typeof time !== "string") {
      throw new VerificationValidationError("verification_judgment_missing");
    }
    const judgment = verificationJudgmentSchema.safeParse({ candidate_id: candidateId, candidate_digest: candidateDigest, entailment, attribution, modality, negation, time });
    if (!judgment.success) throw new VerificationValidationError("verification_judgment_invalid");
    judgments.push(judgment.data);
  }
  try {
    return createVerificationReceipt(batchId, candidates.map(parseExtractionCandidate), judgments);
  } catch (error: unknown) {
    if (error instanceof VerificationValidationError) throw error;
    throw new VerificationValidationError(error instanceof Error ? error.message : "verification_invalid");
  }
}

export function allCandidatesPositive(receipt: VerificationReceipt): boolean {
  return receipt.judgments.every(isPositiveVerification);
}
