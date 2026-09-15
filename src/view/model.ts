import type {
  AgentMemoryDatabase,
  OutputSourceGroup,
  QueryTraceRecord,
  UiGraphSessionRow,
  UiGraphSourceRow,
  UiGraphSnapshot,
  UiJobRow,
  UiJobStateCount,
  UiPrivacySnapshot,
  UiSavingsSnapshot,
  LocalUiScopeSnapshot,
} from "../store/database.js";
import type { DerivedArtifactRecord } from "../store/derived-repository.js";
import type { PolicyOutputBinding } from "../core/policy.js";
import type { RevisionDetail } from "../store/revision-repository.js";

const SOURCE_PREVIEW_LIMIT = 220;

export interface ViewProject {
  readonly scope_id: string;
  readonly root: string;
}

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
  readonly memory_items: readonly RevisionDetail[];
  readonly source_records: readonly DerivedArtifactRecord[];
  readonly graph_sources: readonly UiGraphSourceRow[];
  readonly graph: UiGraphSnapshot;
  readonly privacy: UiPrivacySnapshot;
  readonly query_traces: readonly QueryTraceRecord[];
  readonly warnings: readonly string[];
}

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

export function buildViewSnapshot(options: ViewModelOptions, scopeId = options.projects[0]?.scope_id): ViewSnapshot {
  if (scopeId === undefined || !options.projects.some((project) => project.scope_id === scopeId)) {
    throw new Error("view_scope_not_found");
  }
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
  const warnings: string[] = [];
  let graphSources: readonly UiGraphSourceRow[] = [];
  let graph: UiGraphSnapshot = { nodes: [], edges: [] };
  try {
    graphSources = options.database.getKnowledgeGraphForUi(localBinding, 250);
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
    sources: sourcePage.groups.map(mapSource),
    memory_items: options.database.listMemoryItemsForUi(localBinding, 50),
    source_records: sourceRecords,
    graph_sources: graphSources,
    graph,
    privacy: options.database.getPrivacySnapshotForUi(localBinding),
    query_traces: options.database.listQueryTracesForUi(localBinding, 50),
    warnings,
  };
}

export function readViewSource(options: ViewModelOptions, scopeId: string, captureId: string): unknown {
  const binding = options.localUiBindingFor(scopeId);
  const source = options.database.getSourceForOutput(captureId, binding);
  if (source === undefined) return undefined;
  return {
    ...source,
    spans: options.database.getSourceSpansForOutput(captureId, binding),
  };
}
