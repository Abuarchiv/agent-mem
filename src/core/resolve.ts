import type {
  CanonicalRevisionMeaning,
  CanonicalRevisionMutation,
} from "./model.js";

const resolverDecisionBrand = Symbol("agent-memory-resolver-decision");

export type ResolverEffect = "candidate" | "ignored";
export type ResolverReason = "candidate_only_until_t11b" | "duplicate_evidence" | "explicit_ignore" | "verified_entailment";

/**
 * Operations a uniformly positive verifier receipt may accept (plan §7
 * "Semantische Annahmeregel", §6 resolver table): a verified entailment can
 * add, support, or carry a belegte state change, explicit correction or
 * retraction through the resolver. DISPUTE stays reserved for unresolved
 * contradiction evidence and IGNORE is never a meaning-bearing acceptance.
 */
export const VERIFIED_ENTAILMENT_OPERATIONS = Object.freeze(["ADD", "SUPPORT", "SUPERSEDE", "CORRECT", "RETRACT"] as const);

export type VerifiedEntailmentOperation = (typeof VERIFIED_ENTAILMENT_OPERATIONS)[number];

export function isVerifiedEntailmentOperation(operation: string): operation is VerifiedEntailmentOperation {
  return (VERIFIED_ENTAILMENT_OPERATIONS as readonly string[]).includes(operation);
}

/** The correction operations of the resolver table that change canonical state. */
export type VerifiedCorrectionOperation = Exclude<VerifiedEntailmentOperation, "ADD" | "SUPPORT">;

export function isVerifiedCorrectionOperation(operation: string): operation is VerifiedCorrectionOperation {
  return operation === "SUPERSEDE" || operation === "CORRECT" || operation === "RETRACT";
}

/** Facts are read from durable source rows; callers cannot assert their values through this type. */
export interface ResolverSourceFact {
  readonly source_capture_id: string;
  readonly source_span_id: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly evidence_class: "prompt" | "assistant_output" | "tool_input" | "tool_output" | "lifecycle" | "diagnostic";
  readonly native_identity: string | null;
  readonly native_outcome: "succeeded" | "failed" | "unknown" | null;
  readonly automation_marker: boolean;
}

export interface ResolverCurrentState {
  readonly item_id: string;
  readonly revision_id: string;
  readonly status: "candidate" | "supported" | "disputed" | "superseded" | "retracted";
  readonly value_digest: string;
  readonly meaning: CanonicalRevisionMeaning | null;
  readonly temporal_digest: string | null;
  readonly existing_sources: readonly ResolverSourceFact[];
}

export interface ResolverDecision {
  readonly version: 1;
  readonly acceptance: "candidate_only" | "verified";
  readonly effect: ResolverEffect;
  readonly reason: ResolverReason;
  readonly operation_id: string;
  readonly request_digest: string;
  readonly scope_id: string;
  readonly item_id: string | null;
  readonly expected_revision_id: string | null;
  readonly expected_slot_generation: string | null;
  readonly source_span_ids: readonly string[];
  readonly [resolverDecisionBrand]: true;
}

function repeatedEvidence(
  mutation: CanonicalRevisionMutation,
  sources: readonly ResolverSourceFact[],
  current: ResolverCurrentState | undefined,
): boolean {
  if (mutation.operation !== "SUPPORT") return false;
  if (sources.length === 0 || current === undefined || current.existing_sources.length === 0) return false;
  return sources.every((source) => current.existing_sources.some((existing) =>
    (existing.source_capture_id === source.source_capture_id && existing.source_span_id === source.source_span_id) ||
    (source.native_identity !== null && existing.native_identity !== null && source.native_identity === existing.native_identity),
  ));
}

/**
 * T09 intentionally has no promotion rule. Without a separately verified
 * receipt every meaning-bearing proposal remains a candidate. Only an exact
 * repeated SUPPORT evidence set is semantically ignored. Correction
 * operations (SUPERSEDE/CORRECT/RETRACT) flow through this same decision and
 * only reach canonical state changes when the caller overrides the acceptance
 * with a persisted verified receipt (plan §6 resolver table, §7).
 */
export function decideRevision(
  mutation: CanonicalRevisionMutation,
  sources: readonly ResolverSourceFact[],
  current: ResolverCurrentState | undefined,
): ResolverDecision {
  const duplicate = repeatedEvidence(mutation, sources, current);
  const explicitIgnore = mutation.operation === "IGNORE";
  const sourceSpanIds = Object.freeze([...mutation.source_span_ids]);
  return Object.freeze({
    version: 1,
    acceptance: "candidate_only",
    effect: duplicate || explicitIgnore ? "ignored" : "candidate",
    reason: explicitIgnore ? "explicit_ignore" : duplicate ? "duplicate_evidence" : "candidate_only_until_t11b",
    operation_id: mutation.operation_id,
    request_digest: mutation.request_digest,
    scope_id: mutation.scope_id,
    item_id: mutation.item_id ?? null,
    expected_revision_id: mutation.expected.revision_id ?? null,
    expected_slot_generation: mutation.expected.slot_generation ?? null,
    source_span_ids: sourceSpanIds,
    [resolverDecisionBrand]: true as const,
  });
}

export function isResolverDecision(value: unknown): value is ResolverDecision {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as Partial<ResolverDecision>;
  return (
    decision[resolverDecisionBrand] === true &&
    decision.version === 1 &&
    (decision.acceptance === "candidate_only" || decision.acceptance === "verified") &&
    (decision.effect === "candidate" || decision.effect === "ignored") &&
    (decision.reason === "candidate_only_until_t11b" || decision.reason === "duplicate_evidence" || decision.reason === "explicit_ignore" || decision.reason === "verified_entailment") &&
    typeof decision.operation_id === "string" &&
    typeof decision.request_digest === "string" &&
    typeof decision.scope_id === "string" &&
    Array.isArray(decision.source_span_ids)
  );
}
