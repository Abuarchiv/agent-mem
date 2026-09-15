import { canonicalIdentitySchema, canonicalValueSchema, canonicalMeaningSchema } from "./canonical-fields.js";
import { createHash } from "node:crypto";

import { z } from "zod";

import { validatePhaseOutput, type SourceSpanForValidation } from "../execution/protocol.js";

const uuidSchema = z.uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const sourceRoleSchema = canonicalMeaningSchema.shape.attribution;
const candidateKindSchema = z.enum(["observation", "fact", "decision", "lesson", "procedure"]);
const operationSchema = z.enum(["ADD", "SUPPORT", "SUPERSEDE", "CORRECT", "DISPUTE", "RETRACT"]);
const judgmentSchema = z.enum(["positive", "negative", "uncertain"]);
const entailmentSchema = z.enum(["entailed", "contradicted", "uncertain"]);

export const extractionSourceSchema = z.object({
  source_span_id: uuidSchema,
  capture_id: uuidSchema,
  scope_id: uuidSchema,
  role: sourceRoleSchema,
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  captured_at: z.iso.datetime({ offset: true }).optional(),
  text: z.string().min(1).max(100_000),
  digest: digestSchema.optional(),
}).strict();

export type ExtractionSource = z.infer<typeof extractionSourceSchema>;

const expectedTargetSchema = z.object({
  item_id: uuidSchema.optional(),
  revision_id: uuidSchema.nullable().optional(),
  slot_generation: z.string().regex(/^(?:0|[1-9][0-9]*)$/).nullable().optional(),
}).strict();

export const extractionCandidateSchema = z.object({
  version: z.literal(1),
  candidate_id: uuidSchema,
  candidate_digest: digestSchema,
  operation: operationSchema,
  kind: candidateKindSchema,
  identity: canonicalIdentitySchema,
  value: canonicalValueSchema,
  meaning: canonicalMeaningSchema,
  source_span_ids: z.array(uuidSchema).min(1).max(128),
  quote: z.string().min(1).max(100_000),
  expected: expectedTargetSchema,
  temporal_intent: z.record(z.string().min(1).max(64), z.json()).optional(),
}).strict();

export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;

export const verificationJudgmentSchema = z.object({
  candidate_id: uuidSchema,
  candidate_digest: digestSchema,
  entailment: entailmentSchema,
  attribution: judgmentSchema,
  modality: judgmentSchema,
  negation: judgmentSchema,
  time: judgmentSchema,
}).strict();

export type VerificationJudgment = z.infer<typeof verificationJudgmentSchema>;

export const verificationReceiptSchema = z.object({
  version: z.literal(1),
  status: z.literal("verified"),
  batch_id: uuidSchema,
  candidate_ids: z.array(uuidSchema).min(1).max(128),
  candidate_digests: z.array(digestSchema).min(1).max(128),
  judgments: z.array(verificationJudgmentSchema).min(1).max(128),
  receipt_digest: digestSchema,
}).strict();

export type VerificationReceipt = z.infer<typeof verificationReceiptSchema>;

export interface ExtractionCandidateInput {
  readonly expected?: z.infer<typeof expectedTargetSchema>;
  readonly require_canonical_identity?: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function candidateIdForDigest(candidateDigest: string): string {
  const hex = candidateDigest.slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function modality(value: unknown): ExtractionCandidate["meaning"]["modality"] {
  return value === "requested" ? "planned" : value === "conditional" ? "conditional" : value === "hypothetical" ? "hypothetical" : value === "asserted" ? "asserted" : "unknown";
}

function candidateFromItem(
  kind: ExtractionCandidate["kind"],
  text: string,
  item: Record<string, unknown>,
  expected: z.infer<typeof expectedTargetSchema> | undefined,
  requireCanonicalIdentity: boolean,
  valueOverride?: { type: "json"; value: Record<string, unknown> },
): ExtractionCandidate {
  const sourceSpanIds = item.source_span_ids as string[];
  const quote = item.quote as string;
  const meaning = {
    polarity: item.negated === true ? "negated" as const : "affirmed" as const,
    modality: modality(item.modality),
    attribution: item.attribution as ExtractionCandidate["meaning"]["attribution"],
  };
  const validAt = typeof item.valid_at === "object" && item.valid_at !== null && !Array.isArray(item.valid_at) ? item.valid_at as { from?: string; to?: string } : undefined;
  const rawIdentity = item.identity;
  const rawValue = item.value;
  if (requireCanonicalIdentity && (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity) || typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue))) throw new Error("extraction_canonical_identity_missing");
  const identity = rawIdentity === undefined ? { entity: { kind: "none" as const }, predicate: "extracted_claim", qualifiers: [], cardinality: "multi" as const } : rawIdentity;
  const value = valueOverride ?? (rawValue === undefined ? { type: "text" as const, value: text } : rawValue);
  const operation = operationSchema.safeParse(item.operation).success ? item.operation as ExtractionCandidate["operation"] : "ADD" as const;
  const draft = {
    version: 1 as const,
    operation,
    kind,
    identity,
    value,
    meaning,
    source_span_ids: [...sourceSpanIds].sort(),
    quote,
    expected: expected ?? {},
    ...(item.temporal_intent !== undefined ? { temporal_intent: item.temporal_intent } : validAt === undefined ? {} : { temporal_intent: {
      version: 1,
      validity_basis: "interval",
      from: validAt.from === undefined ? { kind: "open" } : { kind: "exact", at: validAt.from },
      to: validAt.to === undefined ? { kind: "open" } : { kind: "exact", at: validAt.to },
    } }),
  };
  const candidateDigest = digest(draft);
  return extractionCandidateSchema.parse({ ...draft, candidate_id: candidateIdForDigest(candidateDigest), candidate_digest: candidateDigest });
}

/** Convert the transport-validated extraction object into server-owned candidates. */
export function createExtractionCandidates(
  output: unknown,
  sourceSpans: readonly SourceSpanForValidation[],
  input: ExtractionCandidateInput = {},
): readonly ExtractionCandidate[] {
  const parsed = validatePhaseOutput("extract", output, sourceSpans) as Record<string, unknown>;
  if (parsed.status !== "accepted") return [];
  const candidates: ExtractionCandidate[] = [];
  for (const [key, kind] of [["observations", "observation"], ["claims", "fact"], ["decisions", "decision"], ["lesson_candidates", "lesson"], ["procedure_candidates", "procedure"]] as const) {
    const values = parsed[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const item = value as Record<string, unknown>;
      const text = typeof item.observation === "string" ? item.observation : typeof item.claim === "string" ? item.claim : typeof item.decision === "string" ? item.decision : `${item.problem ?? ""}\n${item.recommended_action ?? ""}`;
      // T18b: the structured procedure body IS the committed value, so the
      // canonical revision content carries prerequisites, ordered steps,
      // allowed tool classes, abort/retry rules and postconditions verbatim.
      const valueOverride = kind === "procedure"
        ? {
            type: "json" as const,
            value: {
              problem: item.problem,
              conditions: item.conditions,
              attempt: item.attempt,
              observed_outcome: item.observed_outcome,
              recommended_action: item.recommended_action,
              prerequisites: item.prerequisites,
              steps: item.steps,
              allowed_tool_classes: item.allowed_tool_classes,
              abort_rule: item.abort_rule,
              retry_rule: item.retry_rule,
              postconditions: item.postconditions,
            },
          }
        : undefined;
      candidates.push(candidateFromItem(kind, text, item, input.expected, input.require_canonical_identity === true, valueOverride));
    }
  }
  const summary = parsed.summary;
  if (summary !== null && typeof summary === "object") {
    const item = summary as Record<string, unknown>;
    candidates.push(candidateFromItem("observation", item.summary as string, item, input.expected, input.require_canonical_identity === true));
  }
  return Object.freeze(candidates);
}

export function parseExtractionCandidate(value: unknown): ExtractionCandidate {
  const candidate = extractionCandidateSchema.parse(value);
  const { candidate_id: _id, candidate_digest: _digest, ...draft } = candidate;
  if (digest(draft) !== candidate.candidate_digest.toLowerCase()) throw new Error("candidate_digest_mismatch");
  return candidate;
}

export function createVerifierPhaseInput(
  candidates: readonly ExtractionCandidate[],
  sourceSpans: readonly SourceSpanForValidation[],
  affectedRevisions: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  const parsedCandidates = candidates.map(parseExtractionCandidate);
  if (parsedCandidates.length === 0 || parsedCandidates.length > 128) throw new Error("verification_candidates_invalid");
  return {
    version: 1,
    candidates: parsedCandidates,
    original_spans: sourceSpans,
    affected_revisions: affectedRevisions,
  };
}

export function createVerificationReceipt(
  batchId: string,
  candidates: readonly ExtractionCandidate[],
  judgments: readonly VerificationJudgment[],
): VerificationReceipt {
  const parsedCandidates = candidates.map(parseExtractionCandidate);
  const parsedJudgments = judgments.map((judgment) => verificationJudgmentSchema.parse(judgment));
  const expected = new Map(parsedCandidates.map((candidate) => [candidate.candidate_id, candidate]));
  if (parsedJudgments.length !== parsedCandidates.length || new Set(parsedJudgments.map((judgment) => judgment.candidate_id)).size !== parsedJudgments.length) throw new Error("verification_coverage_incomplete");
  for (const judgment of parsedJudgments) {
    const candidate = expected.get(judgment.candidate_id);
    if (candidate === undefined || candidate.candidate_digest !== judgment.candidate_digest) throw new Error("verification_candidate_mismatch");
  }
  const candidateIds = parsedCandidates.map((candidate) => candidate.candidate_id);
  const candidateDigests = parsedCandidates.map((candidate) => candidate.candidate_digest);
  const receiptDigest = digest({ version: 1, status: "verified", batch_id: batchId, candidate_ids: candidateIds, candidate_digests: candidateDigests, judgments: parsedJudgments });
  return verificationReceiptSchema.parse({ version: 1, status: "verified", batch_id: batchId, candidate_ids: candidateIds, candidate_digests: candidateDigests, judgments: parsedJudgments, receipt_digest: receiptDigest });
}

export function isPositiveVerification(judgment: VerificationJudgment): boolean {
  return judgment.entailment === "entailed" && judgment.attribution === "positive" && judgment.modality === "positive" && judgment.negation === "positive" && judgment.time === "positive";
}

export function candidateDigest(value: Omit<ExtractionCandidate, "candidate_id" | "candidate_digest">): string {
  return digest(value);
}
