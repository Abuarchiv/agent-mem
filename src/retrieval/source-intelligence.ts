import type { LocalReranker } from "../models/rerank.js";
import type { SearchState } from "../v1/search-state.js";
import { createHash } from "node:crypto";
import type { RecallRequest, TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase, RecallSourceGroup } from "../store/database.js";
import { expandSourceGraph } from "./source-graph.js";
import { DEFAULT_SEARCH_WEIGHTS, SEARCH_SIGNALS, type SearchKind, type SearchReport, type SignalValues } from "./intelligence-types.js";

export interface SourceIntelligenceOptions {
  reranker?: LocalReranker;
  state?: SearchState;
  signal?: AbortSignal;
  rerankerState?: "disabled" | "unavailable" | "skipped";
}

export const emptySignals = (): SignalValues => ({ lexical: 0, semantic: 0, graph: 0, procedure: 0, recency: 0 });

function rankingAnchors(query: string): string[] {
  const phrases = [...query.matchAll(/"([^"\r\n]{2,128})"/gu)].map(match => match[1]!.trim());
  const technical = query.match(/[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+|[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)+/gu) ?? [];
  return [...new Set([...phrases, ...technical].map(anchor => anchor.toLocaleLowerCase("und")))].slice(0, 4);
}

export function retrievalQuery(query: string): string {
  const tokens = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (query.length <= 2048 && tokens.length <= 48 && tokens.every(token => token.length <= 128)) return query;
  const anchors = rankingAnchors(query);
  const anchorTokens = new Set(anchors.flatMap(anchor => anchor.match(/[\p{L}\p{N}_]+/gu) ?? []));
  const remainder = tokens.filter(token => !anchorTokens.has(token.toLocaleLowerCase("und")) && token.length <= 128);
  return [...anchors, ...remainder].slice(0, 48).join(" ").slice(0, 2048) || "...";
}

export function queryKind(query: string, mode: string): SearchKind {
  if (mode === "timeline" || /\b(zuletzt|zuletztbearbeitet|recent|latest|last session)\b/iu.test(query)) return "recent";
  if (/\b(why|warum|zusammenhang|related|context|kontext|ursache|cause)\b/iu.test(query)) return "relation";
  if (/\b[A-Z]{2,}[-_]\d+\b|\b[a-f0-9]{12,}\b|\S+\/(?:\S+)|\b\w+\.(?:ts|tsx|js|py|sql|rs|go|json)\b/u.test(query)) return "identifier";
  return "semantic";
}

/** Ranking inputs only; these excerpts never replace registered source spans. */
function rankingPassage(group: RecallSourceGroup, query: string): string {
  const text = [...new Set(group.spans.map(span => span.quote))].join("\n");
  if (text.length <= 1600) return text;
  const lower = text.toLocaleLowerCase("und");
  const terms = (query.toLocaleLowerCase("und").match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).sort((a, b) => b.length - a.length);
  const hit = terms.map(term => lower.indexOf(term)).find(index => index >= 0) ?? 0;
  let start = Math.max(0, hit - 300), end = Math.min(text.length, start + 1600);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return text.slice(start, end);
}

function rankingQueryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase("und").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])];
}

function queryFit(group: RecallSourceGroup, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const textTokens = new Set(
    [...new Set(group.spans.map(span => span.quote))]
      .join("\n")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}_-]+/gu) ?? [],
  );
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    const weight = /[\d_/-]/u.test(term) || term.length >= 12 ? 4 : 1;
    total += weight;
    if (textTokens.has(term)) matched += weight;
  }
  return total === 0 ? 0 : matched / total;
}

function queryAnchorScore(group: RecallSourceGroup, anchors: readonly string[]): number {
  if (anchors.length === 0) return 0;
  const spans = [...new Set(group.spans.map(span => span.quote))].map(quote => quote.toLocaleLowerCase("und"));
  return anchors.reduce((score, anchor, index) => score + (spans.some(span => span.includes(anchor)) ? anchors.length - index : 0), 0);
}

function diversifyEquivalentMatches(
  groups: readonly RecallSourceGroup[],
  fit: ReadonlyMap<string, number>,
  anchorScores: ReadonlyMap<string, number>,
  skippedIds: ReadonlySet<string>,
): { groups: RecallSourceGroup[]; changed: boolean } {
  const positions = new Map<string, number[]>();
  const buckets = new Map<string, RecallSourceGroup[]>();
  groups.forEach((group, index) => {
    if (skippedIds.has(group.capture_id)) return;
    const queryCoverage = fit.get(group.capture_id) ?? 0;
    if (queryCoverage <= 0) return;
    const key = `${anchorScores.get(group.capture_id) ?? 0}\u0000${queryCoverage}`;
    positions.set(key, [...(positions.get(key) ?? []), index]);
    buckets.set(key, [...(buckets.get(key) ?? []), group]);
  });
  const ordered = [...groups];
  let changed = false;
  for (const [key, bucket] of buckets) {
    const seen = new Set<string>();
    const firstBySource = bucket.filter(group => {
      const sourceKey = `${group.scope_id}\u0000${group.session_id}\u0000${group.evidence_class}`;
      if (seen.has(sourceKey)) return false;
      seen.add(sourceKey);
      return true;
    });
    const replacement = [...firstBySource, ...bucket.filter(group => !firstBySource.includes(group))];
    const slots = positions.get(key) ?? [];
    slots.forEach((slot, index) => {
      const next = replacement[index];
      if (next === undefined) return;
      if (ordered[slot]?.capture_id !== next.capture_id) changed = true;
      ordered[slot] = next;
    });
  }
  return { groups: ordered, changed };
}

function logicalMessageKey(group: RecallSourceGroup): string {
  const event = JSON.parse(group.event_json) as { native_ids?: { message_id?: unknown }; role?: unknown };
  const id = event.native_ids?.message_id;
  if (typeof id !== "string" || id.length === 0) return group.capture_id;
  const digest = createHash("sha256").update([...new Set(group.spans.map(span => span.quote))].join("\n")).digest("hex");
  return JSON.stringify([group.scope_id, group.session_id, group.evidence_class, id, digest]);
}

export interface IntelligenceResult {
  groups: RecallSourceGroup[];
  candidates: string[];
  validation_ids: string[];
  atomic_groups: string[][];
  report: Omit<SearchReport, "query_id" | "binding_id" | "created_at">;
}

export async function improveSourceRanking(
  database: AgentMemoryDatabase, request: RecallRequest & { known_at_seq: string }, binding: TrustedBinding,
  groups: readonly RecallSourceGroup[], signals: ReadonlyMap<string, SignalValues>,
  limits: { deadline_at: string; excluded_capture_id?: string; exclude_current_session_prompts: boolean; timeline: boolean },
  options: SourceIntelligenceOptions,
): Promise<IntelligenceResult> {
  const deadline = Date.parse(limits.deadline_at);
  const check = () => { if (options.signal?.aborted || Date.now() >= deadline) throw new Error("search_deadline"); };
  check();
  const scope = request.scope_ids[0]!;
  // Feedback is project-local. Broad internal multi-scope queries use fixed weights.
  const state = request.scope_ids.length === 1 ? options.state : undefined;
  const rules = state?.matchingProcedures(scope, request.query) ?? [];
  const procedureGroups = rules.length === 0 ? [] : database.getRecallSourceGroups(request.scope_ids, binding,
    [...new Set(rules.map(rule => rule.capture_id))], request.known_at_seq, limits.excluded_capture_id, limits.exclude_current_session_prompts);
  const authorizedProcedures = new Map(procedureGroups.map(group => [group.capture_id, group]));
  const procedureIds = rules.filter(rule => authorizedProcedures.has(rule.capture_id)).slice(0, 3).map(rule => rule.capture_id);
  const baseKind = queryKind(request.query, request.mode);
  const kind: SearchKind = limits.timeline ? "recent" : baseKind !== "semantic" ? baseKind : procedureIds.length > 0 ? "procedure" : "semantic";
  const weights = state?.weights(scope, kind) ?? { ...DEFAULT_SEARCH_WEIGHTS };
  const stages = [limits.timeline ? "timeline" : "lexical_vector_fusion", "weighted_signals"];
  const byId = new Map(groups.map(group => [group.capture_id, group]));
  for (const id of procedureIds) byId.set(id, authorizedProcedures.get(id)!);
  const values = new Map([...signals].map(([id, value]) => [id, { ...value }]));
  const extraIds: string[] = [];
  let graphHops = 0, graphAdded = 0, graphComplete = true;
  const validationIds = new Set<string>();
  let atomicGroups: string[][] = [];
  if (kind === "relation" && byId.size > 0 && deadline - Date.now() > 150) {
    const graph = expandSourceGraph(database, request, binding, [...byId.keys()].slice(0, 4), {
      max_hops: 2, max_nodes: 16, deadline_at: limits.deadline_at,
      ...(limits.excluded_capture_id === undefined ? {} : { excluded_capture_id: limits.excluded_capture_id }),
      exclude_current_session_prompts: limits.exclude_current_session_prompts,
    });
    graphHops = graph.hops; graphComplete = graph.complete;
    for (const edge of graph.edges) { validationIds.add(edge.from_id); validationIds.add(edge.source_id); }
    atomicGroups = graph.edges.map(edge => {
      const parent = edge.hop > 1 ? graph.edges.find(item => item.source_id === edge.from_id && item.hop === edge.hop - 1) : undefined;
      return [...new Set([...(parent ? [parent.from_id] : []), edge.from_id, edge.source_id])];
    });
    atomicGroups = atomicGroups.filter((path, index) => !atomicGroups.some((other, otherIndex) => otherIndex !== index && (other.length > path.length || otherIndex < index) && path.every(id => other.includes(id))));
    for (const id of graph.source_ids) {
      if (!byId.has(id)) { extraIds.push(id); graphAdded++; }
      const current = values.get(id) ?? emptySignals(); current.graph = 1; values.set(id, current);
    }
    stages.push("structural_graph");
  } else if (kind === "relation" && byId.size > 0) {
    graphComplete = false;
    stages.push("graph_skipped_deadline");
  }
  if (extraIds.length > 0) {
    const additional = database.getRecallSourceGroups(request.scope_ids, binding, [...new Set(extraIds)], request.known_at_seq, limits.excluded_capture_id, limits.exclude_current_session_prompts);
    for (const group of additional) if (!["assertion", "derived"].includes(group.evidence_class as string)) byId.set(group.capture_id, group);
  }
  const validProcedures = procedureIds.filter(id => byId.has(id));
  if (validProcedures.length) stages.push("registered_procedures");
  const recency = [...byId.values()].sort((a, b) => BigInt(a.commit_seq) > BigInt(b.commit_seq) ? -1 : BigInt(a.commit_seq) < BigInt(b.commit_seq) ? 1 : a.capture_id.localeCompare(b.capture_id));
  const freshness = new Map(recency.map((group, index) => [group.capture_id, 1 / (1 + index)]));
  for (const group of byId.values()) {
    const value = values.get(group.capture_id) ?? emptySignals();
    value.procedure = validProcedures.includes(group.capture_id) ? 1 : 0;
    value.recency = kind === "recent" ? freshness.get(group.capture_id)! : 0;
    values.set(group.capture_id, value);
  }
  const baseOrder = new Map([...byId.keys()].map((id, index) => [id, index]));
  const terms = rankingQueryTerms(request.query);
  const fit = new Map([...byId.values()].map(group => [group.capture_id, queryFit(group, terms)]));
  const anchors = rankingAnchors(request.query);
  const anchorScores = new Map([...byId.values()].map(group => [group.capture_id, queryAnchorScore(group, anchors)]));
  const score = (group: RecallSourceGroup) => SEARCH_SIGNALS.reduce((sum, key) => sum + weights[key] * values.get(group.capture_id)![key], 0);
  let ordered = [...byId.values()].sort((a, b) => anchorScores.get(b.capture_id)! - anchorScores.get(a.capture_id)! || score(b) - score(a) || fit.get(b.capture_id)! - fit.get(a.capture_id)! || baseOrder.get(a.capture_id)! - baseOrder.get(b.capture_id)!);
  let reranker: SearchReport["reranker"] = options.reranker === undefined ? options.rerankerState ?? "disabled" : "skipped";
  if (options.reranker && !["identifier", "recent"].includes(kind) && ordered.length > 1 && deadline - Date.now() > 250) {
    const top = request.token_budget >= 16000 ? 20 : 12;
    let pool = ordered.slice(0, top);
    if (kind === "relation") {
      const related = ordered.filter(group => values.get(group.capture_id)!.graph > 0).slice(0, 4);
      pool = [...new Map([...ordered.slice(0, top - related.length), ...related].map(group => [group.capture_id, group])).values()];
    }
    try {
      const ranked = await options.reranker.rerank({ query: retrievalQuery(request.query), candidates: pool.map(group => ({ id: group.capture_id, text: rankingPassage(group, request.query) })),
        deadline_at: new Date(Math.min(deadline - 75, Date.now() + (top > 12 ? 1800 : 900))).toISOString(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      check();
      const poolIds = new Set(pool.map(group => group.capture_id));
      if (ranked.length !== pool.length || new Set(ranked.map(row => row.id)).size !== pool.length || ranked.some(row => !poolIds.has(row.id) || !Number.isFinite(row.score))) throw new Error("invalid_rerank_result");
      ordered = [...ranked.map(row => byId.get(row.id)!), ...ordered.filter(group => !poolIds.has(group.capture_id))];
      reranker = "applied"; stages.push("cross_encoder");
    } catch { check(); reranker = "unavailable"; stages.push("rerank_fallback"); }
  }
  if (kind !== "recent" && ordered.length > 1) {
    const skippedIds = new Set([...validProcedures, ...atomicGroups.flat()]);
    const diversity = diversifyEquivalentMatches(ordered, fit, anchorScores, skippedIds);
    ordered = diversity.groups;
    if (diversity.changed) stages.push("session_diversity");
  }
  if (validProcedures.length > 0) ordered.sort((a, b) => Number(validProcedures.includes(b.capture_id)) - Number(validProcedures.includes(a.capture_id)));
  const seen = new Set<string>(), primary: RecallSourceGroup[] = [], duplicates: RecallSourceGroup[] = [];
  for (const group of ordered) { const key = logicalMessageKey(group); if (seen.has(key)) duplicates.push(group); else { seen.add(key); primary.push(group); } }
  // Group only output ordering; every original capture remains available for point reads.
  stages.push("message_diversity");
  ordered = [...primary, ...duplicates];
  if (limits.timeline && request.mode !== "timeline") {
    const lanes = ["prompt", "assistant_output", "tool_output"].map(kind => ordered.filter(group => group.evidence_class === kind));
    const mixed: RecallSourceGroup[] = [];
    for (let index = 0; index < Math.max(0, ...lanes.map(lane => lane.length)); index++) {
      for (const lane of lanes) if (lane[index]) mixed.push(lane[index]!);
    }
    ordered = [...mixed, ...ordered.filter(group => !mixed.includes(group))];
    stages.push("working_context_mix");
  }
  check();
  return { groups: ordered, candidates: ordered.map(group => group.capture_id), validation_ids: [...validationIds], atomic_groups: atomicGroups, report: {
    scope_id: scope, kind, stages, reranker, graph_hops: graphHops, graph_added: graphAdded, graph_complete: graphComplete,
    weights: { ...weights }, learned_samples: state?.sampleCount(scope, kind) ?? 0,
    candidates: ordered.map(group => ({ capture_id: group.capture_id, features: { ...values.get(group.capture_id)! } })), procedure_ids: validProcedures,
  } };
}
