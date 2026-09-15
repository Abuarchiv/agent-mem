import { z } from "zod";

import { validateBoundRecallRequest, type RecallRequest, type TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase, SourceGraphNeighbor } from "../store/database.js";

export const SOURCE_GRAPH_MAX_HOPS = 2;
export const SOURCE_GRAPH_MAX_NODES = 32;
const SOURCE_GRAPH_MAX_SEEDS = 32;
const SOURCE_GRAPH_NEIGHBOR_LIMIT = 128;

export interface SourceGraphOptions {
  readonly max_hops?: number;
  readonly max_nodes?: number;
  readonly excluded_capture_id?: string;
  readonly exclude_current_session_prompts?: boolean;
  readonly deadline_at: string;
}

export interface SourceGraphEdge {
  readonly from_id: string;
  readonly source_id: string;
  readonly scope_id: string;
  readonly kind: string;
  readonly hop: number;
}

export interface SourceGraphResult {
  readonly source_ids: string[];
  readonly edges: SourceGraphEdge[];
  readonly complete: boolean;
  readonly hops: number;
}

function invalid(): never {
  throw new Error("source_graph_invalid");
}

function checkedOptions(options: SourceGraphOptions): {
  readonly max_hops: number;
  readonly max_nodes: number;
  readonly excluded_capture_id?: string;
  readonly exclude_current_session_prompts: boolean;
  readonly deadline_ms: number;
} {
  if (typeof options !== "object" || options === null || typeof options.deadline_at !== "string") invalid();
  const deadlineMs = Date.parse(options.deadline_at);
  if (!Number.isFinite(deadlineMs)) invalid();
  const maxHops = options.max_hops ?? SOURCE_GRAPH_MAX_HOPS;
  const maxNodes = options.max_nodes ?? SOURCE_GRAPH_MAX_NODES;
  if (!Number.isSafeInteger(maxHops) || maxHops < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 0) invalid();
  if (options.excluded_capture_id !== undefined && !z.uuid().safeParse(options.excluded_capture_id).success) invalid();
  if (options.exclude_current_session_prompts !== undefined && typeof options.exclude_current_session_prompts !== "boolean") invalid();
  return {
    max_hops: Math.min(maxHops, SOURCE_GRAPH_MAX_HOPS),
    max_nodes: Math.min(maxNodes, SOURCE_GRAPH_MAX_NODES),
    ...(options.excluded_capture_id === undefined ? {} : { excluded_capture_id: options.excluded_capture_id }),
    exclude_current_session_prompts: options.exclude_current_session_prompts === true,
    deadline_ms: deadlineMs,
  };
}

function uniqueSourceIds(seeds: readonly string[]): string[] {
  if (!Array.isArray(seeds) || seeds.length > SOURCE_GRAPH_MAX_SEEDS) invalid();
  const unique = [...new Set(seeds)];
  if (unique.some((seed) => !z.uuid().safeParse(seed).success)) invalid();
  return unique;
}

function canonicalIds(
  database: AgentMemoryDatabase,
  request: RecallRequest,
  binding: TrustedBinding,
  sourceIds: readonly string[],
  knownAtSeq: string,
  options: ReturnType<typeof checkedOptions>,
): ReadonlyMap<string, string> {
  if (sourceIds.length === 0) return new Map();
  const groups = database.getRecallSourceGroups(
    request.scope_ids,
    binding,
    sourceIds,
    knownAtSeq,
    options.excluded_capture_id,
    options.exclude_current_session_prompts,
  );
  return new Map(groups.map((group) => [group.capture_id, group.scope_id]));
}

function acceptedNeighbors(
  neighbors: readonly SourceGraphNeighbor[],
  frontier: ReadonlySet<string>,
  canonical: ReadonlyMap<string, string>,
): SourceGraphNeighbor[] {
  return neighbors.filter((neighbor) => frontier.has(neighbor.from_id) && canonical.get(neighbor.source_id) === neighbor.scope_id);
}

/**
 * Expand only durable source adjacency. Native IDs, explicit paths, and
 * immediate session order are structural evidence; none is treated as cause.
 * Canonical source groups are hydrated before any edge is returned.
 */
export function expandSourceGraph(
  database: AgentMemoryDatabase,
  request: RecallRequest,
  binding: TrustedBinding,
  seeds: readonly string[],
  options: SourceGraphOptions,
): SourceGraphResult {
  const checkedRequest = validateBoundRecallRequest(request, binding);
  const checked = checkedOptions(options);
  const seedIds = uniqueSourceIds(seeds);
  if (Date.now() >= checked.deadline_ms || checked.max_hops === 0 || seedIds.length === 0) {
    return { source_ids: [], edges: [], complete: Date.now() < checked.deadline_ms, hops: 0 };
  }

  const knownAtSeq = checkedRequest.known_at_seq ?? database.getRecallSnapshot(checkedRequest.scope_ids, binding).watermark;
  const seedScopes = canonicalIds(database, checkedRequest, binding, seedIds, knownAtSeq, checked);
  let frontier = seedIds.filter((sourceId) => seedScopes.has(sourceId));
  const known = new Set(frontier);
  const discovered: string[] = [];
  const discoveredSet = new Set<string>();
  const edges: SourceGraphEdge[] = [];
  let complete = true;
  let hops = 0;

  for (let hop = 1; hop <= checked.max_hops && frontier.length > 0; hop += 1) {
    if (Date.now() >= checked.deadline_ms) {
      complete = false;
      break;
    }
    const neighbors = database.getSourceGraphNeighbors({
      scope_ids: checkedRequest.scope_ids,
      source_ids: frontier,
      known_at_seq: knownAtSeq,
      limit: SOURCE_GRAPH_NEIGHBOR_LIMIT,
      ...(checked.excluded_capture_id === undefined ? {} : { excluded_capture_id: checked.excluded_capture_id }),
      ...(checked.exclude_current_session_prompts ? { exclude_current_session_prompts: true } : {}),
    }, binding);
    if (neighbors.truncated || neighbors.length >= SOURCE_GRAPH_NEIGHBOR_LIMIT) complete = false;
    if (Date.now() >= checked.deadline_ms) {
      complete = false;
      break;
    }

    const targetIds = [...new Set(neighbors.map((neighbor) => neighbor.source_id))];
    const targetScopes = canonicalIds(database, checkedRequest, binding, targetIds, knownAtSeq, checked);
    const accepted = acceptedNeighbors(neighbors, new Set(frontier), targetScopes);
    if (accepted.length === 0) break;
    hops = hop;

    const newTargets: string[] = [];
    const newTargetSet = new Set<string>();
    for (const neighbor of accepted) {
      if (!known.has(neighbor.source_id) && !newTargetSet.has(neighbor.source_id)) {
        newTargetSet.add(neighbor.source_id);
        newTargets.push(neighbor.source_id);
      }
    }
    const remaining = Math.max(0, checked.max_nodes - discovered.length);
    const allowedNewTargets = newTargets.slice(0, remaining);
    if (allowedNewTargets.length < newTargets.length) complete = false;
    const allowed = new Set([...known, ...allowedNewTargets]);
    const nextFrontier: string[] = [];
    for (const neighbor of accepted) {
      if (!allowed.has(neighbor.source_id)) continue;
      edges.push({ ...neighbor, hop });
      if (!known.has(neighbor.source_id)) {
        known.add(neighbor.source_id);
        discovered.push(neighbor.source_id);
        discoveredSet.add(neighbor.source_id);
        nextFrontier.push(neighbor.source_id);
      }
    }
    frontier = [...new Set(nextFrontier)];
    if (Date.now() >= checked.deadline_ms) {
      complete = false;
      break;
    }
    if (allowedNewTargets.length < newTargets.length || discoveredSet.size >= checked.max_nodes) {
      if (allowedNewTargets.length < newTargets.length) complete = false;
      if (frontier.length === 0) break;
    }
  }

  return { source_ids: discovered, edges, complete, hops };
}
