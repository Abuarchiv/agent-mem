import type {
  AgentMemoryDatabase,
  LocalUiScopeSnapshot,
  OutputSourceGroup,
  QueryTraceRecord,
  UiGraphSessionRow,
  UiGraphSourceRow,
  UiGraphSnapshot,
  UiJobRow,
  UiJobStateCount,
  UiPrivacySnapshot,
  UiSavingsSnapshot,
} from "../store/database.js";
import type { PolicyOutputBinding } from "../core/policy.js";
import type { DerivedArtifactRecord } from "../store/derived-repository.js";
import type { RevisionDetail } from "../store/revision-repository.js";

export interface ViewProject {
  readonly scope_id: string;
  readonly root: string;
}

/** The local viewer defaults to the operator-wide read-only view. */
export const GLOBAL_SCOPE_ID = "__all__" as const;

export interface ViewModelOptions {
  readonly database: AgentMemoryDatabase;
  readonly projects: readonly ViewProject[];
  readonly status: () => unknown;
  readonly localUiBindingFor: (scopeId: string) => PolicyOutputBinding;
  readonly readerOutputBindingFor: (scopeId: string) => PolicyOutputBinding;
  readonly countUnits?: ((text: string) => number) | undefined;
}

export interface ViewSourceRow {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly session_id?: string;
  readonly host_kind?: string;
  readonly project_label?: string;
  readonly commit_seq: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly evidence_class: string;
  readonly role: string;
  readonly job_state: string | null;
  readonly preview: string;
  readonly span_count: number;
}

export interface ViewSourceDetail {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly source: unknown;
}

export interface ViewSnapshot {
  readonly version: 1;
  readonly generated_at: string;
  readonly status: unknown;
  readonly projects: readonly ViewProject[];
  readonly selected_scope_id: string;
  readonly scope: LocalUiScopeSnapshot;
  readonly counts: {
    readonly scopes: string;
    readonly sessions: string;
    readonly sources: string;
    readonly spans: string;
    readonly jobs: string;
  };
  readonly savings: UiSavingsSnapshot & { readonly reduction_percent: number };
  readonly token_savings: ReturnType<AgentMemoryDatabase["getTokenSavingsForUi"]>;
  readonly job_states: readonly UiJobStateCount[];
  readonly jobs: readonly UiJobRow[];
  readonly sessions: readonly UiGraphSessionRow[];
  readonly sources: readonly ViewSourceRow[];
  readonly source_details: readonly ViewSourceDetail[];
  readonly memory_items: readonly RevisionDetail[];
  readonly source_records: readonly DerivedArtifactRecord[];
  readonly graph_sources: readonly UiGraphSourceRow[];
  readonly graph: UiGraphSnapshot;
  readonly privacy: UiPrivacySnapshot;
  readonly query_traces: readonly QueryTraceRecord[];
  readonly warnings: readonly string[];
}

type TokenSavings = ViewSnapshot["token_savings"];
const SOURCE_PREVIEW_LIMIT = 220;

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)) as unknown;
}

function sourcePreview(group: OutputSourceGroup): string {
  const preview = group.spans.map((span) => span.quote).filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
  return preview.length <= SOURCE_PREVIEW_LIMIT ? preview : `${preview.slice(0, SOURCE_PREVIEW_LIMIT - 1)}…`;
}

function mapSource(group: OutputSourceGroup): ViewSourceRow {
  return {
    capture_id: group.capture_id,
    scope_id: group.scope_id,
    ...(group.session_id === undefined ? {} : { session_id: group.session_id }),
    ...(group.host_kind === undefined ? {} : { host_kind: group.host_kind }),
    ...(group.project_label === undefined ? {} : { project_label: group.project_label }),
    commit_seq: group.commit_seq,
    captured_at: group.captured_at,
    occurred_at: group.occurred_at,
    evidence_class: group.evidence_class,
    role: group.role,
    job_state: group.job_state,
    preview: sourcePreview(group),
    span_count: group.spans.length,
  };
}

function newestFirst<T>(items: readonly T[], value: (item: T) => string | null | undefined): T[] {
  return [...items].sort((left, right) => {
    const a = value(left) ?? "";
    const b = value(right) ?? "";
    return a < b ? 1 : a > b ? -1 : 0;
  });
}

function sumBigInt(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString(10);
}

function maxBigInt(values: readonly string[]): string {
  return values.reduce((current, value) => BigInt(value) > BigInt(current) ? value : current, "0");
}

function buildScopeSnapshot(options: ViewModelOptions, scopeId: string): ViewSnapshot {
  const localBinding = options.localUiBindingFor(scopeId);
  const readerBinding = options.readerOutputBindingFor(scopeId);
  const scope = options.database.getLocalUiSnapshot(localBinding);
  const counts = options.database.getUiCounts(localBinding);
  const rawSavings = options.database.getSavingsForUi(localBinding);
  const reductionPercent = rawSavings.stored_chars === 0
    ? 0
    : Math.max(0, Math.min(100, (1 - rawSavings.evidence_chars / rawSavings.stored_chars) * 100));
  const sourcePage = options.database.listSourcesForOutput(localBinding, { limit: 50 });
  const sourceRecords = options.database.summaries.listSourceRecords(readerBinding, { limit: 50, include_history: true });
  const sources = sourcePage.groups.map(mapSource);
  const warnings: string[] = [];
  let graphSources: readonly UiGraphSourceRow[] = [];
  let graph: UiGraphSnapshot = { nodes: [], edges: [] };
  try {
    graphSources = options.database.getKnowledgeGraphForUi(localBinding, 100);
  } catch {
    warnings.push("graph_unavailable");
  }
  try {
    graph = options.database.getGraphForUi(localBinding, 100);
  } catch {
    warnings.push("semantic_graph_unavailable");
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    status: jsonSafe(options.status()),
    projects: options.projects,
    selected_scope_id: scopeId,
    scope,
    counts: {
      scopes: counts.scope_count.toString(10),
      sessions: counts.session_count.toString(10),
      sources: counts.source_count.toString(10),
      spans: counts.span_count.toString(10),
      jobs: counts.job_count.toString(10),
    },
    savings: { ...rawSavings, reduction_percent: Number(reductionPercent.toFixed(1)) },
    token_savings: options.database.getTokenSavingsForUi(localBinding, { countUnits: options.countUnits }),
    job_states: options.database.getUiJobStateCounts(localBinding),
    jobs: options.database.listJobsForUi(localBinding, 100),
    sessions: options.database.listSessionsForUi(localBinding, 100),
    sources,
    source_details: sources.flatMap((source) => {
      const detail = readViewSource(options, scopeId, source.capture_id);
      return detail === undefined ? [] : [{ capture_id: source.capture_id, scope_id: scopeId, source: detail }];
    }),
    memory_items: options.database.listMemoryItemsForUi(localBinding, 50),
    source_records: sourceRecords,
    graph_sources: graphSources,
    graph,
    privacy: options.database.getPrivacySnapshotForUi(localBinding),
    query_traces: options.database.listQueryTracesForUi(localBinding, 50),
    warnings,
  };
}

function mergeTokenSavings(snapshots: readonly ViewSnapshot[]): TokenSavings {
  const measured = snapshots.map((snapshot) => snapshot.token_savings).filter((savings) => savings.status === "computed");
  if (measured.length === 0) {
    const first = snapshots[0]?.token_savings;
    if (first === undefined) throw new Error("view_scope_not_found");
    return {
      ...first,
      status: "unobserved",
      unit: first.unit ?? "utf8_bytes",
      method: first.method ?? "utf8_bytes",
      baseline_units: 0,
      memory_units: 0,
      saved_units: 0,
      savings_percent: null,
      measured_sources: 0,
      measured_spans: 0,
      reason: "no_authorized_source_text",
    };
  }
  const baseline = measured.reduce((total, savings) => total + savings.baseline_units, 0);
  const memory = measured.reduce((total, savings) => total + savings.memory_units, 0);
  const saved = measured.reduce((total, savings) => total + savings.saved_units, 0);
  const first = measured[0]!;
  return {
    ...first,
    status: "computed",
    unit: first.unit ?? "utf8_bytes",
    method: first.method ?? "utf8_bytes",
    baseline_units: baseline,
    memory_units: memory,
    saved_units: saved,
    savings_percent: baseline === 0 ? null : Number(((saved / baseline) * 100).toFixed(1)),
    measured_sources: measured.reduce((total, savings) => total + savings.measured_sources, 0),
    measured_spans: measured.reduce((total, savings) => total + savings.measured_spans, 0),
  };
}

function mergeGraphs(snapshots: readonly ViewSnapshot[]): UiGraphSnapshot {
  const nodes = snapshots.flatMap((snapshot) => snapshot.graph.nodes.map((node) => ({
    ...node,
    entity_id: `${snapshot.scope.scope_id}:${node.entity_id}`,
  })));
  const edges = snapshots.flatMap((snapshot) => snapshot.graph.edges.map((edge) => ({
    ...edge,
    source_entity: `${snapshot.scope.scope_id}:${edge.source_entity}`,
    target_entity: `${snapshot.scope.scope_id}:${edge.target_entity}`,
  })));
  return { nodes, edges };
}

function mergeGlobalSnapshots(options: ViewModelOptions, snapshots: readonly ViewSnapshot[]): ViewSnapshot {
  const first = snapshots[0];
  if (first === undefined) throw new Error("view_scope_not_found");
  const counts = {
    scopes: sumBigInt(snapshots.map((snapshot) => snapshot.counts.scopes)),
    sessions: sumBigInt(snapshots.map((snapshot) => snapshot.counts.sessions)),
    sources: sumBigInt(snapshots.map((snapshot) => snapshot.counts.sources)),
    spans: sumBigInt(snapshots.map((snapshot) => snapshot.counts.spans)),
    jobs: sumBigInt(snapshots.map((snapshot) => snapshot.counts.jobs)),
  };
  const tokenSavings = mergeTokenSavings(snapshots);
  const storedChars = snapshots.reduce((total, snapshot) => total + snapshot.savings.stored_chars, 0);
  const evidenceChars = snapshots.reduce((total, snapshot) => total + snapshot.savings.evidence_chars, 0);
  const savings = {
    ...first.savings,
    source_count: Number(counts.sources),
    stored_chars: storedChars,
    evidence_chars: evidenceChars,
    span_count: Number(counts.spans),
    stored_units: tokenSavings.baseline_units,
    evidence_units: tokenSavings.memory_units,
    saved_units: tokenSavings.saved_units,
    savings_percent: tokenSavings.savings_percent,
    reduction_percent: storedChars === 0 ? 0 : Number(Math.max(0, Math.min(100, (1 - evidenceChars / storedChars) * 100)).toFixed(1)),
  };
  const scope: LocalUiScopeSnapshot = {
    ...first.scope,
    scope_id: GLOBAL_SCOPE_ID,
    watermark: maxBigInt(snapshots.map((snapshot) => snapshot.scope.watermark)),
    capture_paused: snapshots.some((snapshot) => snapshot.scope.capture_paused),
  };
  return {
    ...first,
    generated_at: new Date().toISOString(),
    status: jsonSafe(options.status()),
    projects: options.projects,
    selected_scope_id: GLOBAL_SCOPE_ID,
    scope,
    counts,
    savings,
    token_savings: tokenSavings,
    job_states: snapshots.flatMap((snapshot) => snapshot.job_states),
    jobs: newestFirst(snapshots.flatMap((snapshot) => snapshot.jobs), (job) => job.created_commit_seq).slice(0, 100),
    sessions: newestFirst(snapshots.flatMap((snapshot) => snapshot.sessions), (session) => session.started_at).slice(0, 100),
    sources: newestFirst(snapshots.flatMap((snapshot) => snapshot.sources), (source) => source.captured_at).slice(0, 50),
    source_details: snapshots.flatMap((snapshot) => snapshot.source_details).slice(0, 50),
    memory_items: snapshots.flatMap((snapshot) => snapshot.memory_items).slice(0, 50),
    source_records: snapshots.flatMap((snapshot) => snapshot.source_records).slice(0, 50),
    graph_sources: newestFirst(snapshots.flatMap((snapshot) => snapshot.graph_sources), (source) => source.commit_seq).slice(0, 250),
    graph: mergeGraphs(snapshots),
    privacy: {
      capture_paused: snapshots.some((snapshot) => snapshot.privacy.capture_paused),
      grants: snapshots.flatMap((snapshot) => snapshot.privacy.grants),
      purges: snapshots.flatMap((snapshot) => snapshot.privacy.purges),
    },
    query_traces: newestFirst(snapshots.flatMap((snapshot) => snapshot.query_traces), (trace) => trace.created_at).slice(0, 50),
    warnings: [...new Set(snapshots.flatMap((snapshot) => snapshot.warnings))],
  };
}

export function buildViewSnapshot(options: ViewModelOptions, scopeId: string = GLOBAL_SCOPE_ID): ViewSnapshot {
  if (options.projects.length === 0) throw new Error("view_scope_not_found");
  if (scopeId === GLOBAL_SCOPE_ID) {
    return mergeGlobalSnapshots(options, options.projects.map((project) => buildScopeSnapshot(options, project.scope_id)));
  }
  if (!options.projects.some((project) => project.scope_id === scopeId)) throw new Error("view_scope_not_found");
  return buildScopeSnapshot(options, scopeId);
}

export function readViewSource(options: ViewModelOptions, scopeId: string, captureId: string): unknown {
  const scopeIds = scopeId === GLOBAL_SCOPE_ID ? options.projects.map((project) => project.scope_id) : [scopeId];
  for (const currentScopeId of scopeIds) {
    const binding = options.localUiBindingFor(currentScopeId);
    const source = options.database.getSourceForOutput(captureId, binding);
    if (source !== undefined) {
      return { ...source, spans: options.database.getSourceSpansForOutput(captureId, binding) };
    }
  }
  return undefined;
}
