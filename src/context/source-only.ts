import { randomUUID } from "node:crypto";

import {
  bindingOwnerId,
  ContractValidationError,
  isTrustedBinding,
  validateBoundRecallRequest,
  type EvidencePacket,
  type RecallRequest,
  type TrustedBinding,
} from "../host/contract.js";
import { FusionError, hybridSearch } from "../retrieval/fusion.js";
import { LexicalSearchError, lexicalSearch } from "../retrieval/lexical.js";
import { VectorSearchError } from "../retrieval/vector.js";
import { emptySignals, improveSourceRanking, retrievalQuery, type IntelligenceResult, type SourceIntelligenceOptions } from "../retrieval/source-intelligence.js";
import type { SignalValues } from "../retrieval/intelligence-types.js";
import { recallMemoryRecords } from "./memory-records.js";
import {
  AgentMemoryDatabase,
  StoreError,
  type RecallSnapshot,
  type RecallSourceGroup,
} from "../store/database.js";
import {
  buildEvidencePacket,
  createPreparationContext,
  isPreparationContext,
  packetDigest,
  PacketBudgetError,
  type ContextDiagnosticCode,
  type PreparationContext,
} from "./packet.js";

const LEXICAL_CANDIDATE_LIMIT = 40;
// ponytail: keep session-start continuity to 20 recent groups; widen only after measured recall gaps.
const TIMELINE_SOURCE_LIMIT = 20;

export type ContextErrorCode = "forbidden" | "capture_failed" | "deadline" | "store_unavailable" | "budget_exhausted";

export class ContextPreparationError extends Error {
  readonly code: ContextErrorCode;

  constructor(code: ContextErrorCode, cause?: unknown) {
    super(code, cause instanceof Error ? { cause } : undefined);
    this.name = "ContextPreparationError";
    this.code = code;
  }
}

function deadlineMs(context: PreparationContext): number {
  const value = Date.parse(context.deadline_at);
  if (!Number.isFinite(value)) throw new ContextPreparationError("deadline");
  return value;
}

function ensureBeforeDeadline(context: PreparationContext): void {
  if (Date.now() >= deadlineMs(context)) throw new ContextPreparationError("deadline");
}

function mapFailure(error: unknown): ContextPreparationError {
  if (error instanceof ContextPreparationError) return error;
  if (error instanceof Error && error.message === "search_deadline") return new ContextPreparationError("deadline", error);
  const causes = errorCauses(error);
  const forbidden = causes.find(
    (cause): cause is ContractValidationError | StoreError =>
      cause instanceof ContractValidationError ||
      (cause instanceof StoreError &&
        (cause.code === "scope_not_allowed" || cause.code === "output_not_allowed" || cause.code === "purge_scope_not_allowed")),
  );
  if (forbidden instanceof ContractValidationError) return new ContextPreparationError("forbidden", forbidden);
  if (forbidden instanceof StoreError) return new ContextPreparationError("forbidden", forbidden);
  if (error instanceof PacketBudgetError) return new ContextPreparationError("budget_exhausted", error);
  if (causes.some((cause) => cause instanceof LexicalSearchError)) return new ContextPreparationError("store_unavailable", error);
  if (causes.some((cause) => cause instanceof FusionError)) return new ContextPreparationError("store_unavailable", error);
  if (error instanceof StoreError) {
    return new ContextPreparationError("store_unavailable", error);
  }
  return new ContextPreparationError("store_unavailable", error);
}

function errorCauses(error: unknown): Error[] {
  const causes: Error[] = [];
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    causes.push(current);
    seen.add(current);
    current = current.cause;
  }
  return causes;
}

function excludedCaptureId(context: PreparationContext): string | undefined {
  return context.capture_status.state === "committed" ? context.capture_status.capture_id : undefined;
}

function effectiveKnownAt(request: RecallRequest, snapshot: RecallSnapshot): string {
  if (request.known_at_seq === undefined) return snapshot.watermark;
  const requested = BigInt(request.known_at_seq);
  const watermark = BigInt(snapshot.watermark);
  return (requested < watermark ? requested : watermark).toString(10);
}

function hasSearchableTerms(query: string): boolean {
  return /[\p{L}\p{N}_]+/u.test(query);
}

function usesRecentTimeline(context: PreparationContext, request: RecallRequest): boolean {
  return request.mode === "timeline" || context.kind === "session_start" && (
    context.capture_status.state === "committed" ||
    !hasSearchableTerms(request.query)
  );
}

function orderGroups(groups: readonly RecallSourceGroup[], candidateIds: readonly string[]): RecallSourceGroup[] {
  const byId = new Map(groups.map((group) => [group.capture_id, group]));
  return candidateIds.flatMap((captureId) => {
    const group = byId.get(captureId);
    return group === undefined ? [] : [group];
  });
}

function sourceOnlyGroups(groups: readonly RecallSourceGroup[]): RecallSourceGroup[] {
  return groups.filter((group) => {
    const sourceClass = group.evidence_class as string;
    return sourceClass !== "assertion" && sourceClass !== "derived";
  });
}

interface CandidateSearchResult {
  readonly candidateIds: string[];
  readonly projectionUnavailable: boolean;
  readonly signals: ReadonlyMap<string, SignalValues>;
  readonly protectedIds?: readonly string[];
}

function automaticStartCandidates(
  database: AgentMemoryDatabase, request: RecallRequest, binding: TrustedBinding,
  knownAtSeq: string, excluded: string | undefined, excludePrompts: boolean,
): CandidateSearchResult {
  // Separate lanes keep a burst of tool output from evicting the user's task.
  const recent = [
    ...database.getRecallTimelineGroups(request.scope_ids, binding, knownAtSeq, 8, excluded, excludePrompts, { source_classes: ["prompt"] }),
    ...database.getRecallTimelineGroups(request.scope_ids, binding, knownAtSeq, 6, excluded, excludePrompts, { source_classes: ["assistant_output"] }),
    ...database.getRecallTimelineGroups(request.scope_ids, binding, knownAtSeq, 6, excluded, excludePrompts, { source_classes: ["tool_output"] }),
  ];
  // Original explicitly labelled notes, never inferred or generated facts.
  // Eligibility precedes the limit, so tool echoes cannot crowd out user notes.
  const notes = database.getRecallTimelineGroups(request.scope_ids, binding, knownAtSeq, 2, excluded, excludePrompts,
    { source_classes: ["prompt"], explicit_notes: true });
  const task = recent.find(group => group.evidence_class === "prompt");
  const handoff = recent.find(group => group.evidence_class === "assistant_output");
  return { candidateIds: [...new Set([...notes, ...recent].map(group => group.capture_id))],
    protectedIds: [...new Set([...(task ? [task.capture_id] : []), ...(handoff ? [handoff.capture_id] : []), ...notes.map(group => group.capture_id)])],
    projectionUnavailable: false, signals: new Map() };
}

function isProjectionFailure(error: unknown): boolean {
  if (!(error instanceof FusionError)) return false;
  const cause = error.cause;
  return cause instanceof VectorSearchError && (cause.code === "source_span_invalid" || cause.code === "source_span_missing");
}

function searchCandidateIds(
  database: AgentMemoryDatabase, request: RecallRequest, binding: TrustedBinding,
  context: PreparationContext, queryVector: Float32Array | undefined, knownAtSeq: string,
  excluded: string | undefined,
): CandidateSearchResult {
  const excludeCurrentSessionPrompts = context.exclude_current_session_prompts === true;
  const boundedRequest = { ...request, query: retrievalQuery(request.query), known_at_seq: knownAtSeq };
  const lexicalOptions = { any_terms: true, ...(excluded === undefined ? {} : { excluded_capture_id: excluded }),
    ...(excludeCurrentSessionPrompts ? { exclude_current_session_prompts: true } : {}) };
  if (usesRecentTimeline(context, request)) {
    if (request.mode !== "timeline") return automaticStartCandidates(database, request, binding, knownAtSeq, excluded, excludeCurrentSessionPrompts);
    return { candidateIds: database.getRecallTimelineGroups(request.scope_ids, binding, knownAtSeq, TIMELINE_SOURCE_LIMIT, excluded, excludeCurrentSessionPrompts).map(group => group.capture_id), projectionUnavailable: false, signals: new Map() };
  }
  if (!hasSearchableTerms(boundedRequest.query)) return { candidateIds: [], projectionUnavailable: false, signals: new Map() };
  if (queryVector !== undefined) {
    try {
      const rows = hybridSearch(database, binding, boundedRequest, queryVector, LEXICAL_CANDIDATE_LIMIT, {
        lexical: lexicalOptions, vector: { ...(excluded === undefined ? {} : { excluded_capture_id: excluded }),
          ...(excludeCurrentSessionPrompts ? { exclude_current_session_prompts: true } : {}) },
      });
      return { candidateIds: rows.map(row => row.source_id), projectionUnavailable: false,
        signals: new Map(rows.map(row => [row.source_id, { ...emptySignals(),
          lexical: row.lexical_rank === undefined ? 0 : 61 / (61 + row.lexical_rank),
          semantic: row.vector_rank === undefined ? 0 : 61 / (61 + row.vector_rank) }])) };
    } catch (error) {
      if (!isProjectionFailure(error)) throw error;
      ensureBeforeDeadline(context);
    }
  }
  const rows = lexicalSearch(database, binding, boundedRequest, LEXICAL_CANDIDATE_LIMIT, lexicalOptions);
  return { candidateIds: rows.map(row => row.source_id), projectionUnavailable: queryVector !== undefined,
    signals: new Map(rows.map(row => [row.source_id, { ...emptySignals(), lexical: 61 / (61 + row.rank) }])) };
}

function recordTrace(
  database: AgentMemoryDatabase,
  packet: EvidencePacket,
  binding: TrustedBinding,
  scopeIds: readonly string[],
  snapshot: RecallSnapshot,
  knownAtSeq: string,
  candidateIds: readonly string[],
  createdAt: string,
  additionalDiagnostics: readonly string[] = [],
): void {
  const injectionId = packet.delivery?.injection_id;
  if (injectionId === undefined) throw new ContextPreparationError("store_unavailable");
  database.recordQueryTrace({
    query_id: packet.query_id,
    injection_id: injectionId,
    binding_id: bindingOwnerId(binding),
    packet_digest: packetDigest(packet),
    scope_ids: [...scopeIds],
    watermark: packet.watermark,
    known_at_seq: knownAtSeq,
    scope_epochs: snapshot.scopes,
    candidate_ids: [...candidateIds],
    output_ids: packet.items.map((item) => item.item_id),
    diagnostics: [...new Set([...(packet.diagnostics?.map((diagnostic) => diagnostic.code) ?? []), ...additionalDiagnostics])],
    mode: packet.mode,
    token_unit: packet.tokens.unit ?? "tokens",
    tokens_used: packet.tokens.used,
    token_budget: packet.tokens.budget,
    created_at: createdAt,
    valid_until: packet.valid_until,
    delivery_state: "prepared",
  });
}

function emptyAfterRevalidation(
  request: RecallRequest,
  context: PreparationContext,
  snapshot: RecallSnapshot,
  knownAtSeq: string,
  queryId: string,
): EvidencePacket {
  return buildEvidencePacket(
    {
      query_id: queryId,
      injection_id: randomUUID(),
      watermark: snapshot.watermark,
      known_at_seq: knownAtSeq,
      data_epoch: snapshot.data_epoch,
      privacy_epoch: snapshot.privacy_epoch,
      valid_until: context.deadline_at,
      scope_epochs: snapshot.scopes,
      requested_token_budget: request.token_budget,
      mode: "degraded",
      diagnostics: ["revalidation_failed"],
    },
    [],
    context,
  );
}

function packetMode(
  context: PreparationContext,
  request: RecallRequest,
  queryVector: Float32Array | undefined,
  projectionUnavailable = false,
): {
  readonly mode: EvidencePacket["mode"];
  readonly diagnostics: readonly ContextDiagnosticCode[];
} {
  if (usesRecentTimeline(context, request)) return { mode: "timeline", diagnostics: [] };
  if (queryVector === undefined || projectionUnavailable) return { mode: "degraded", diagnostics: ["degraded_lexical"] };
  return { mode: request.mode, diagnostics: [] };
}

/** Prepare bounded source evidence and source-linked, unverified agent reports. */
export async function prepareSourceEvidencePacket(
  database: AgentMemoryDatabase,
  requestInput: unknown,
  binding: TrustedBinding,
  context: PreparationContext,
  queryVector?: Float32Array,
  options: SourceIntelligenceOptions = {},
): Promise<EvidencePacket> {
  if (!isTrustedBinding(binding) || !isPreparationContext(context) || context.binding_id !== binding.binding_id) {
    throw new ContextPreparationError("forbidden");
  }
  if (context.capture_status.state === "failed") throw new ContextPreparationError("capture_failed");
  if (context.kind === "user_prompt" && context.capture_status.state === "not_attempted") {
    throw new ContextPreparationError("capture_failed");
  }
  ensureBeforeDeadline(context);

  let request: RecallRequest;
  try {
    request = validateBoundRecallRequest(requestInput, binding);
  } catch (error: unknown) {
    throw mapFailure(error);
  }

  const queryId = randomUUID();
  const createdAt = new Date().toISOString();
  const scopeIds = [...new Set(request.scope_ids)];
  const excluded = excludedCaptureId(context);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    ensureBeforeDeadline(context);
    let snapshot: RecallSnapshot;
    let knownAtSeq: string;
    let candidateIds: string[];
    let groups: RecallSourceGroup[];
    let additionalDiagnostics: readonly string[] = [];
    let intelligence: IntelligenceResult;
    let protectedIds: readonly string[] = [];
    let records: ReturnType<typeof recallMemoryRecords> = { items: [] };
    try {
      snapshot = database.getRecallSnapshot(scopeIds, binding);
      knownAtSeq = effectiveKnownAt(request, snapshot);
      const search = searchCandidateIds(database, { ...request, scope_ids: scopeIds }, binding, context, queryVector, knownAtSeq, excluded);
      protectedIds = search.protectedIds ?? [];
      candidateIds = [...new Set(search.candidateIds)];
      additionalDiagnostics = search.projectionUnavailable ? ["projection_unavailable"] : [];
      const hydrated = database.getRecallSourceGroups(
        scopeIds,
        binding,
        [...new Set(candidateIds)],
        knownAtSeq,
        excluded,
        context.exclude_current_session_prompts === true,
      );
      groups = sourceOnlyGroups(orderGroups(hydrated, candidateIds));
      const rankingOptions = { ...options };
      if (attempt > 0 && rankingOptions.reranker) {
        delete rankingOptions.reranker;
        rankingOptions.rerankerState = "skipped";
      }
      intelligence = await improveSourceRanking(database, { ...request, known_at_seq: knownAtSeq }, binding, groups, search.signals, {
        deadline_at: context.deadline_at, ...(excluded === undefined ? {} : { excluded_capture_id: excluded }),
        exclude_current_session_prompts: context.exclude_current_session_prompts,
        timeline: usesRecentTimeline(context, request),
      }, rankingOptions);
      groups = intelligence.groups;
      if (usesRecentTimeline(context, request) && request.mode !== "timeline" && protectedIds.length > 0) {
        const priority = new Map(protectedIds.map((id, index) => [id, index]));
        groups = [...groups].sort((a, b) => (priority.get(a.capture_id) ?? protectedIds.length) - (priority.get(b.capture_id) ?? protectedIds.length));
      }
      candidateIds = groups.map(group => group.capture_id);
      records = recallMemoryRecords(database, binding, scopeIds, knownAtSeq, request.query, candidateIds, usesRecentTimeline(context, request), excluded, context.exclude_current_session_prompts);
      additionalDiagnostics = [...additionalDiagnostics, ...intelligence.report.stages,
        ...(retrievalQuery(request.query) === request.query ? [] : ["query_terms_limited"])];
    } catch (error: unknown) {
      throw mapFailure(error);
    }

    ensureBeforeDeadline(context);
    let packet: EvidencePacket;
    try {
      packet = buildEvidencePacket(
        {
          query_id: queryId,
          injection_id: randomUUID(),
          watermark: snapshot.watermark,
          known_at_seq: knownAtSeq,
          data_epoch: snapshot.data_epoch,
          privacy_epoch: snapshot.privacy_epoch,
          valid_until: context.deadline_at,
          scope_epochs: snapshot.scopes,
          requested_token_budget: request.token_budget,
          mode: packetMode(context, request, queryVector, additionalDiagnostics.includes("projection_unavailable")).mode,
          atomic_source_groups: intelligence.atomic_groups,
          protected_source_ids: protectedIds,
          diagnostics: [...packetMode(context, request, queryVector, additionalDiagnostics.includes("projection_unavailable")).diagnostics,
            ...(intelligence.report.graph_complete ? [] : ["graph_incomplete" as const])],
        },
        groups,
        context,
        records.items,
      );
    } catch (error: unknown) {
      throw mapFailure(error);
    }

    ensureBeforeDeadline(context);
    try {
      const outputIds = packet.items
        .filter((item) => item.kind === "source")
        .map((item) => item.item_id);
      const recordSourceIds = packet.items.flatMap(item => item.kind === "record"
        ? item.record_provenance!.sources.map(source => source.capture_id) : []);
      if (database.revalidateRecallSnapshot(snapshot, binding, [...new Set([...outputIds, ...intelligence.validation_ids, ...recordSourceIds])])) {
        recordTrace(database, packet, binding, scopeIds, snapshot, knownAtSeq, candidateIds, createdAt, additionalDiagnostics);
        if (options.state && scopeIds.length === 1) {
          const visible = new Set([...outputIds, ...candidateIds.filter(id => !outputIds.includes(id)).slice(0, 10)]);
          options.state.remember({ ...intelligence.report, query_id: queryId, binding_id: bindingOwnerId(binding), created_at: createdAt,
            candidates: intelligence.report.candidates.filter(candidate => visible.has(candidate.capture_id)),
            procedure_ids: intelligence.report.procedure_ids.filter(id => visible.has(id)),
            graph_complete: intelligence.report.graph_complete && intelligence.atomic_groups.every(path => path.every(id => outputIds.includes(id))),
          });
        }
        return packet;
      }
    } catch (error: unknown) {
      throw mapFailure(error);
    }

    if (attempt === 0) continue;
    ensureBeforeDeadline(context);
    try {
      const safePacket = emptyAfterRevalidation(request, context, snapshot, knownAtSeq, queryId);
      recordTrace(database, safePacket, binding, scopeIds, snapshot, knownAtSeq, candidateIds, createdAt, additionalDiagnostics);
      return safePacket;
    } catch (error: unknown) {
      throw mapFailure(error);
    }
  }

  throw new ContextPreparationError("deadline");
}

export const prepareEvidencePacket = prepareSourceEvidencePacket;
export const recall = prepareSourceEvidencePacket;

export { createPreparationContext };
