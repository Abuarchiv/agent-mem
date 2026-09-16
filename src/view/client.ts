import { buildEvidenceGraph, createGraphController, mergeSemanticGraph, type GraphController, type GraphSession, type GraphSource } from "./graph.js";

type JsonObject = Record<string, unknown>;

interface Project { readonly scope_id: string; readonly root: string; }
interface SourceRow {
  readonly capture_id: string;
  readonly captured_at: string;
  readonly host_kind?: string;
  readonly project_label?: string;
  readonly session_id?: string;
  readonly role: string;
  readonly evidence_class: string;
  readonly job_state: string | null;
  readonly preview: string;
  readonly span_count: number;
}
interface TokenSavings {
  readonly status: "computed" | "unobserved";
  readonly unit: "tokens" | "utf8_bytes";
  readonly method: string;
  readonly baseline_units: number;
  readonly memory_units: number;
  readonly saved_units: number;
  readonly savings_percent: number | null;
  readonly reason?: string;
}
interface GraphNode { readonly entity_id: string; readonly label: string; readonly resolution_state: string; readonly created_commit_seq: string; }
interface GraphEdge { readonly edge_id: string; readonly source_entity: string; readonly target_entity: string; readonly predicate: string; readonly evidence_revision: string; readonly status: string; readonly created_commit_seq: string; }
interface GraphSnapshot { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[]; }
interface Snapshot {
  readonly projects: readonly Project[];
  readonly selected_scope_id: string;
  readonly counts: { readonly sessions: string; readonly sources: string; readonly spans: string; readonly jobs: string };
  readonly scope: { readonly data_epoch: string; readonly privacy_epoch: string; readonly watermark: string };
  readonly token_savings: TokenSavings;
  readonly sources: readonly SourceRow[];
  readonly memory_items: readonly JsonObject[];
  readonly source_records: readonly JsonObject[];
  readonly sessions: readonly JsonObject[];
  readonly jobs: readonly JsonObject[];
  readonly graph_sources: readonly JsonObject[];
  readonly source_details: readonly { readonly capture_id: string; readonly scope_id: string; readonly source: SourceDetail }[];
  readonly privacy: { readonly capture_paused: boolean; readonly grants: readonly JsonObject[]; readonly purges: readonly JsonObject[] };
  readonly query_traces: readonly JsonObject[];
  readonly status: unknown;
  readonly graph: GraphSnapshot;
}
interface SourceDetail extends JsonObject { readonly spans?: readonly JsonObject[]; }
interface ClientState { view: string; snapshot: Snapshot | null; sources: readonly SourceRow[]; detail: SourceDetail | null; }

const GLOBAL_SCOPE_ID = "__all__";

const app = document.querySelector<HTMLElement>("#app");
const scopeSelect = document.querySelector<HTMLSelectElement>("#scope-select");
const searchInput = document.querySelector<HTMLInputElement>("#source-search");
const state: ClientState = { view: "dashboard", snapshot: null, sources: [], detail: null };
let activeGraphController: GraphController | null = null;

const viewerStyles = `
:root{color-scheme:dark;--bg:#0d0f10;--panel:#111516;--panel2:#15191a;--line:#30383a;--soft:#22292a;--text:#e7ece9;--muted:#899493;--accent:#ff6b6b;--good:#57db80;--warn:#e7c85d;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;--sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 var(--sans)}button,input,select{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.topbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:20px;min-height:62px;padding:0 24px;border-bottom:1px solid var(--line);background:rgba(13,15,16,.97)}.brand{color:var(--text);font:700 21px/1 var(--mono);text-decoration:none;letter-spacing:-.06em;white-space:nowrap}.brand small{margin-left:7px;color:var(--muted);font-size:11px;letter-spacing:.08em}.tabs{display:flex;align-self:stretch;gap:2px;overflow:auto}.tab{border:0;border-bottom:2px solid transparent;padding:0 10px;background:transparent;color:var(--muted);font:10px var(--mono);letter-spacing:.05em;white-space:nowrap}.tab:hover,.tab.is-active{color:var(--text)}.tab.is-active{border-bottom-color:var(--accent)}.top-actions{display:flex;align-items:center;gap:9px;margin-left:auto}.scope-picker,.search-box{display:flex;align-items:center;gap:7px;color:var(--muted);font:10px var(--mono)}.scope-picker select,.search-box{height:34px;border:1px solid var(--line);background:var(--panel)}.scope-picker select{max-width:180px;padding:0 8px}.search-box{width:230px;padding:0 9px}.search-box input{width:100%;border:0;outline:0;background:transparent;font:11px var(--mono)}.live-status{display:inline-flex;align-items:center;gap:6px;color:var(--good);font:10px var(--mono);white-space:nowrap}.live-status i{width:8px;height:8px;border-radius:50%;background:var(--good)}
.shell{max-width:1800px;margin:0 auto;padding:20px 24px 40px}.loading,.empty,.error{padding:48px 20px;border:1px solid var(--line);color:var(--muted);text-align:center;font-family:var(--mono)}.error{border-color:var(--accent);color:var(--accent)}.section{margin-bottom:18px;border:1px solid var(--line);background:var(--panel)}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font:600 12px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase}.section-head small{color:var(--muted);font:10px var(--mono)}.metrics{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:1px;margin-bottom:18px;background:var(--line)}.metric{min-height:104px;padding:15px;background:var(--panel)}.metric-label,.readout-label{color:var(--muted);font:10px var(--mono);letter-spacing:.08em;text-transform:uppercase}.metric-value{margin-top:15px;font:700 27px/1 var(--mono);letter-spacing:-.05em}.metric-sub{margin-top:7px;color:var(--muted);font:10px var(--mono)}.split{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr);gap:18px}.stack{display:grid;gap:18px;align-content:start}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font:11px var(--mono)}th,td{padding:10px 12px;border-bottom:1px solid var(--soft);text-align:left;vertical-align:top}th{color:var(--muted);font-size:9px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr[data-capture-id]{cursor:pointer}tbody tr[data-capture-id]:hover{background:var(--panel2)}.preview{max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.muted{color:var(--muted)}.pill{display:inline-block;padding:3px 6px;border:1px solid var(--line);color:var(--muted);font:9px var(--mono);text-transform:uppercase}.pill.good{border-color:#2e7145;color:var(--good)}.pill.attn{border-color:#8b3b3b;color:var(--accent)}.status-row{display:grid;grid-template-columns:12px 1fr auto auto;align-items:center;gap:10px;padding:11px 15px;border-bottom:1px solid var(--soft);font:11px var(--mono)}.status-row:last-child{border-bottom:0}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.status-dot.good{background:var(--good)}.status-dot.warn{background:var(--warn)}.status-dot.attn{background:var(--accent)}.status-value{color:var(--muted)}.reduction{padding:18px}.reduction-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.readout-value{margin-top:5px;font:700 22px var(--mono)}.bar{height:9px;margin-top:10px;background:#232a2b}.bar i{display:block;height:100%;background:var(--accent)}.bar i.good{background:var(--good)}.detail{padding:14px 16px;border-top:1px solid var(--line);background:#0b0d0e}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}pre{max-height:480px;margin:0;overflow:auto;padding:12px;border:1px solid var(--soft);background:#090b0c;color:#c8d2ce;font:11px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}.legend{padding:12px 16px;border-bottom:1px solid var(--line)}.search-hint,.footer{color:var(--muted);font:10px var(--mono)}.footer{padding:16px 24px 28px;text-align:center}
@media(max-width:1200px){.topbar{flex-wrap:wrap;gap:10px;padding:12px 16px 0}.tabs{order:3;width:100%;min-height:38px}.top-actions{margin-left:auto}.metrics{grid-template-columns:repeat(4,1fr)}}@media(max-width:820px){.top-actions{width:100%;margin:0}.scope-picker{flex:1}.scope-picker select,.search-box{width:100%;max-width:none}.live-status{display:none}.shell{padding:14px 12px 28px}.metrics{grid-template-columns:repeat(2,1fr)}.split,.detail-grid{grid-template-columns:1fr}}
`;
const graphStyles = `.graph-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);font:10px var(--mono)}.graph-toolbar input{min-width:220px;height:30px;border:1px solid var(--line);background:var(--panel);padding:0 8px}.graph-tool{height:30px;min-width:30px;border:1px solid var(--line);background:var(--panel);color:var(--text)}.graph-tool:hover{border-color:var(--accent)}.graph-canvas{display:block;width:100%;min-height:520px;background:#090b0c}.graph-empty{display:grid;place-items:center;min-height:520px;padding:40px;color:var(--muted);font:12px var(--mono);text-align:center}.graph-edge{stroke:#5b6b6d;stroke-width:1.4;opacity:.75}.graph-node{stroke:#111516;stroke-width:2}.graph-node.resolved{fill:var(--good)}.graph-node.candidate{fill:var(--warn)}.graph-label{fill:var(--text);font:11px var(--mono);pointer-events:none}.graph-predicate{fill:var(--muted);font:9px var(--mono);pointer-events:none}`;
const graphCanvasStyles = `.graph-stage{display:grid;grid-template-columns:minmax(0,1fr) 286px;min-height:620px}.graph-canvas-wrap{min-width:0;min-height:620px;background:#090b0c;position:relative}.graph-canvas-wrap canvas.graph-canvas{width:100%;height:620px;min-height:0;touch-action:none;outline:0}.graph-inspector{border-left:1px solid var(--line);padding:18px;background:var(--panel2);font:11px var(--mono);overflow:auto}.graph-inspector-kicker{color:var(--accent);font-size:9px;letter-spacing:.1em;text-transform:uppercase}.graph-inspector h3{margin:10px 0 6px;font:600 14px/1.3 var(--mono);word-break:break-word}.graph-inspector p{color:var(--muted);line-height:1.6}.graph-inspector dl{margin:18px 0 0}.graph-inspector dl div{padding:8px 0;border-top:1px solid var(--soft)}.graph-inspector dt{color:var(--muted);font-size:9px;text-transform:uppercase}.graph-inspector dd{margin:4px 0 0;word-break:break-word}.graph-legend{margin-top:24px;padding-top:14px;border-top:1px solid var(--line)}.graph-legend-row{display:flex;align-items:center;gap:8px;padding:6px 0;color:var(--muted);font-size:10px}.graph-legend-row i{display:block;width:9px;height:9px;border-radius:50%;border:1px solid #111516}.graph-stat{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--soft);color:var(--muted)}.graph-stat strong{color:var(--text);font-size:14px}@media(max-width:820px){.graph-stage{grid-template-columns:1fr}.graph-inspector{border-left:0;border-top:1px solid var(--line);min-height:180px}.graph-canvas-wrap canvas.graph-canvas{height:440px}}`;

function installStyles(): void {
  if (document.querySelector("#agent-mem-styles")) return;
  const style = document.createElement("style");
  style.id = "agent-mem-styles";
  style.textContent = `${viewerStyles.replace("repeat(7,", "repeat(8,")} ${graphStyles} ${graphCanvasStyles}`;
  document.head.appendChild(style);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function pretty(value: unknown): string { return escapeHtml(JSON.stringify(value, null, 2)); }
function number(value: unknown): string { return Number(value ?? 0).toLocaleString("en-US"); }
function short(value: unknown, length = 16): string { const text = String(value ?? ""); return text.length <= length ? text : `${text.slice(0, length - 1)}…`; }
function text(record: JsonObject | undefined, key: string, fallback = "—"): string { const value = record?.[key]; return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
function pill(value: unknown, kind = ""): string { return `<span class="pill ${kind}">${escapeHtml(value || "—")}</span>`; }
function metric(label: string, value: unknown, sub = ""): string { return `<div class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div>${sub ? `<div class="metric-sub">${escapeHtml(sub)}</div>` : ""}</div>`; }

function sourceRows(sources: readonly SourceRow[]): string {
  if (sources.length === 0) return `<tr><td colspan="7" class="muted">No authorized sources recorded.</td></tr>`;
  return sources.map((source) => `<tr data-capture-id="${escapeHtml(source.capture_id)}">
    <td>${escapeHtml(source.captured_at)}</td>
    <td>${escapeHtml(short(source.host_kind ?? source.project_label ?? "local"))}<br><span class="muted">${escapeHtml(short(source.session_id))}</span></td>
    <td>${pill(source.role)}</td><td>${pill(source.evidence_class)}</td>
    <td>${pill(source.job_state ?? "stored", source.job_state === "failed" ? "attn" : source.job_state === "running" ? "good" : "")}</td>
    <td>${number(source.span_count)}</td><td class="preview">${escapeHtml(source.preview || "—")}</td>
  </tr>`).join("");
}

function sourceTable(sources: readonly SourceRow[]): string {
  return `<div class="section"><div class="section-head"><h2>Recent sources</h2><small>${number(sources.length)} loaded · click a row for raw evidence</small></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Host / session</th><th>Role</th><th>Evidence class</th><th>State</th><th>Spans</th><th>Preview</th></tr></thead><tbody>${sourceRows(sources)}</tbody></table></div></div>`;
}

function statusPanel(snapshot: Snapshot): string {
  const status = snapshot.status as JsonObject | null;
  const rows = ["capture", "semantic_search", "model", "source_reranker"].map((key) => {
    const value = status?.[key];
    const stateValue = typeof value === "string" ? value : text(value as JsonObject | undefined, "state", "available");
    const tone = stateValue === "ready" || stateValue === "available" || stateValue === "disabled" ? "good" : stateValue === "unavailable" ? "attn" : "warn";
    return `<div class="status-row"><i class="status-dot ${tone}"></i><span class="status-name">${escapeHtml(key.replace("semantic_search", "search").replace("source_reranker", "reranker"))}</span><span class="status-value">${escapeHtml(stateValue)}</span><span class="muted">V1</span></div>`;
  }).join("");
  return `<div class="section"><div class="section-head"><h2>System status</h2><small>local runtime</small></div>${rows}</div>`;
}

function reductionPanel(snapshot: Snapshot): string {
  const savings = snapshot.token_savings;
  const measured = savings.status === "computed";
  const unit = savings.unit === "tokens" ? "tokens" : "bytes";
  const percent = measured && savings.savings_percent !== null ? `${savings.savings_percent.toFixed(1)}%` : "Not measured";
  const ratio = measured && savings.baseline_units > 0 ? Math.max(0, Math.min(100, savings.memory_units / savings.baseline_units * 100)) : 0;
  return `<div class="section"><div class="section-head"><h2>Evidence reduction</h2><small>${escapeHtml(savings.method)}</small></div><div class="reduction"><div class="reduction-grid"><div><div class="readout-label">Stored baseline</div><div class="readout-value">${number(savings.baseline_units)} ${unit}</div><div class="bar"><i style="width:100%"></i></div></div><div><div class="readout-label">Surfaced evidence</div><div class="readout-value">${number(savings.memory_units)} ${unit}</div><div class="bar"><i class="good" style="width:${ratio}%"></i></div></div></div><dl class="detail-grid" style="margin-top:18px"><div><dt class="readout-label">Reduction</dt><dd class="readout-value">${escapeHtml(percent)}</dd></div><div><dt class="readout-label">Saved</dt><dd class="readout-value">${measured ? `${number(savings.saved_units)} ${unit}` : "—"}</dd></div></dl>${savings.reason ? `<p class="muted mono">${escapeHtml(savings.reason)}</p>` : ""}</div></div>`;
}

function dashboard(snapshot: Snapshot): string {
  const savings = snapshot.token_savings;
  const tokenValue = savings.status === "computed" && savings.savings_percent !== null ? `${savings.savings_percent.toFixed(1)}%` : "—";
  const tokenSub = savings.status === "computed" ? `${number(savings.saved_units)} ${savings.unit} saved` : "awaiting source evidence";
  return `<div class="metrics">${metric("Sessions", snapshot.counts.sessions)}${metric("Sources", snapshot.counts.sources)}${metric("Spans", snapshot.counts.spans)}${metric("Records", snapshot.memory_items.length + snapshot.source_records.length)}${metric("Jobs", snapshot.counts.jobs)}${metric("Graph sources", snapshot.graph_sources.length)}${metric("Token savings", tokenValue, tokenSub)}${metric("Health", "Local", "read-only")}</div><div class="split"><div>${sourceTable(state.sources)}</div><div class="stack">${statusPanel(snapshot)}${reductionPanel(snapshot)}</div></div>`;
}

function detailPanel(detail: SourceDetail): string { return `<div class="detail"><div class="section-head" style="padding:0 0 12px;border:0"><h2>Source detail</h2><button class="tab" data-close-detail>CLOSE</button></div><div class="detail-grid"><div><h3>Stored source</h3><pre>${pretty(detail)}</pre></div><div><h3>Spans</h3><pre>${pretty(detail.spans ?? [])}</pre></div></div></div>`; }

function sourcesView(): string { return `<div class="section"><div class="section-head"><h2>Sources / timeline</h2><small>local evidence, expandable details</small></div><div class="legend"><span class="search-hint">Use the search field above. Raw payload and event data open per source.</span></div><div class="table-wrap"><table><thead><tr><th>Time</th><th>Host / session</th><th>Role</th><th>Evidence class</th><th>State</th><th>Spans</th><th>Preview</th></tr></thead><tbody>${sourceRows(state.sources)}</tbody></table></div>${state.detail ? detailPanel(state.detail) : ""}</div>`; }

function recordsView(snapshot: Snapshot): string {
  const records = snapshot.source_records;
  const items = snapshot.memory_items;
  return `<div class="split"><div class="section"><div class="section-head"><h2>Source-linked records</h2><small>${number(records.length)} loaded</small></div><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Purpose</th><th>Status</th><th>Commit</th><th>Content</th></tr></thead><tbody>${records.map((record) => `<tr><td>${pill(text(record, "kind"))}</td><td>${escapeHtml(text(record, "context_label", text(record, "purpose")))}</td><td>${pill(text(record, "status"), "good")}</td><td>${escapeHtml(text(record, "created_commit_seq"))}</td><td class="preview">${escapeHtml(text(record.content as JsonObject | undefined, "summary", JSON.stringify(record.content)))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No explicit source-linked records yet.</td></tr>`}</tbody></table></div></div><div class="section"><div class="section-head"><h2>Current memory revisions</h2><small>${number(items.length)} loaded</small></div><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Status</th><th>Operation</th><th>Revision</th><th>Predicate</th></tr></thead><tbody>${items.map((item) => `<tr><td>${pill(text(item, "kind"))}</td><td>${pill(text(item, "status"), "warn")}</td><td>${escapeHtml(text(item, "operation"))}</td><td>${escapeHtml(short(item.revision_id))}</td><td>${escapeHtml(text(item, "predicate"))}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No canonical memory revisions yet.</td></tr>`}</tbody></table></div></div></div>`;
}

function sessionsView(snapshot: Snapshot): string { return `<div class="split"><div class="section"><div class="section-head"><h2>Sessions</h2><small>${number(snapshot.sessions.length)} loaded</small></div><div class="table-wrap"><table><thead><tr><th>Host</th><th>Surface</th><th>Started</th><th>Ended</th><th>Coverage</th></tr></thead><tbody>${snapshot.sessions.map((session) => `<tr><td>${escapeHtml(text(session, "host_kind"))}</td><td>${escapeHtml(text(session, "surface"))}</td><td>${escapeHtml(text(session, "started_at"))}</td><td>${escapeHtml(text(session, "ended_at", "active"))}</td><td>${pill(text(session, "coverage"), "good")}</td></tr>`).join("")}</tbody></table></div></div><div class="section"><div class="section-head"><h2>Jobs</h2><small>${number(snapshot.jobs.length)} loaded</small></div><div class="table-wrap"><table><thead><tr><th>Kind</th><th>State</th><th>Attempts</th><th>Source</th><th>Pause reason</th></tr></thead><tbody>${snapshot.jobs.map((job) => `<tr><td>${escapeHtml(text(job, "task_kind"))}</td><td>${pill(text(job, "state"), text(job, "state") === "failed" ? "attn" : "good")}</td><td>${escapeHtml(text(job, "attempts"))}</td><td>${escapeHtml(short(job.source_capture_id))}</td><td>${escapeHtml(text(job, "pause_reason"))}</td></tr>`).join("")}</tbody></table></div></div></div>`; }

function graphString(record: JsonObject, key: string): string { const value = record[key]; return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function graphNullableString(record: JsonObject, key: string): string | null { const value = record[key]; return typeof value === "string" ? value : null; }
function evidenceGraph(snapshot: Snapshot) {
  const sessions: GraphSession[] = snapshot.sessions.flatMap((record) => {
    const sessionId = graphString(record, "session_id");
    const scopeId = graphString(record, "scope_id");
    return sessionId && scopeId ? [{ session_id: sessionId, scope_id: scopeId, host_kind: graphString(record, "host_kind"), surface: graphString(record, "surface"), started_at: graphString(record, "started_at"), ended_at: graphNullableString(record, "ended_at"), coverage: graphString(record, "coverage") }] : [];
  });
  const sources: GraphSource[] = snapshot.graph_sources.flatMap((record) => {
    const captureId = graphString(record, "capture_id");
    const scopeId = graphString(record, "scope_id");
    const sessionId = graphString(record, "session_id");
    return captureId && scopeId && sessionId ? [{ capture_id: captureId, scope_id: scopeId, session_id: sessionId, role: graphString(record, "role"), evidence_class: graphString(record, "evidence_class"), observed_stage: graphString(record, "observed_stage"), commit_seq: graphString(record, "commit_seq") }] : [];
  });
  const evidence = buildEvidenceGraph({ projects: snapshot.projects, sessions, sources });
  return mergeSemanticGraph(evidence, {
    nodes: snapshot.graph.nodes.map((node) => ({
      entity_id: node.entity_id,
      label: node.label,
      resolution_state: node.resolution_state,
      created_commit_seq: node.created_commit_seq,
    })),
    edges: snapshot.graph.edges.map((edge) => ({
      edge_id: edge.edge_id,
      source_entity: edge.source_entity,
      target_entity: edge.target_entity,
      predicate: edge.predicate,
      evidence_revision: edge.evidence_revision,
      status: edge.status,
      created_commit_seq: edge.created_commit_seq,
    })),
  });
}

function graphView(snapshot: Snapshot): string {
  return `<div class="metrics">${metric("Graph nodes", snapshot.graph.nodes.length)}${metric("Graph edges", snapshot.graph.edges.length)}${metric("Source rows", snapshot.graph_sources.length)}${metric("Data epoch", snapshot.scope.data_epoch)}${metric("Privacy epoch", snapshot.scope.privacy_epoch)}${metric("Watermark", snapshot.scope.watermark)}${metric("Graph mode", "evidenced", "active edges only")}${metric("Depth", "2 hops", "bounded")}</div><div class="section"><div class="section-head"><h2>Semantic graph</h2><small>evidenced entities and relations</small></div><div class="graph-toolbar"><input id="graph-search" type="search" placeholder="Search nodes or predicates…" aria-label="Search graph"><button class="graph-tool" data-graph-zoom="out" aria-label="Zoom out">−</button><button class="graph-tool" data-graph-zoom="reset" aria-label="Recenter graph">⌖</button><button class="graph-tool" data-graph-zoom="in" aria-label="Zoom in">+</button><span class="muted">${snapshot.graph.nodes.length} nodes · ${snapshot.graph.edges.length} edges</span></div><div id="graph-canvas" class="graph-canvas"></div></div>`;
}

function auditView(snapshot: Snapshot): string { return `<div class="split"><div class="section"><div class="section-head"><h2>Privacy grants</h2><small>${snapshot.privacy.capture_paused ? "capture paused" : "capture active"}</small></div><div class="table-wrap"><table><thead><tr><th>Target</th><th>Source class</th><th>Created</th></tr></thead><tbody>${snapshot.privacy.grants.map((grant) => `<tr><td>${escapeHtml(text(grant, "output_target"))}</td><td>${escapeHtml(text(grant, "source_class"))}</td><td>${escapeHtml(text(grant, "created_at"))}</td></tr>`).join("")}</tbody></table></div></div><div class="section"><div class="section-head"><h2>Query traces</h2><small>${number(snapshot.query_traces.length)} loaded</small></div><div class="table-wrap"><table><thead><tr><th>Created</th><th>Mode</th><th>Usage</th><th>Delivery</th></tr></thead><tbody>${snapshot.query_traces.map((trace) => `<tr><td>${escapeHtml(text(trace, "created_at"))}</td><td>${escapeHtml(text(trace, "mode"))}</td><td>${escapeHtml(text(trace, "tokens_used"))} / ${escapeHtml(text(trace, "token_budget"))} ${escapeHtml(text(trace, "token_unit"))}</td><td>${escapeHtml(text(trace, "delivery_state"))}</td></tr>`).join("")}</tbody></table></div></div></div>`; }

function render(): void {
  if (!app || !state.snapshot) return;
  app.innerHTML = state.view === "dashboard" ? dashboard(state.snapshot) : state.view === "sources" ? sourcesView() : state.view === "records" ? recordsView(state.snapshot) : state.view === "sessions" ? sessionsView(state.snapshot) : state.view === "graph" ? graphView(state.snapshot) : auditView(state.snapshot);
  activeGraphController?.destroy();
  activeGraphController = null;
  if (state.view === "graph") {
    const container = document.querySelector<HTMLElement>("#graph-canvas");
    if (container !== null) {
      const model = evidenceGraph(state.snapshot);
      activeGraphController = createGraphController(container, model);
      const section = container.closest(".section");
      const heading = section?.querySelector("h2");
      const description = section?.querySelector(".section-head small");
      const readout = section?.querySelector(".graph-toolbar .muted");
      const metricValues = app.querySelectorAll<HTMLElement>(".metrics .metric-value");
      if (heading !== null && heading !== undefined) heading.textContent = "Knowledge graph";
      if (description !== null && description !== undefined) description.textContent = "real local scope / session / source links";
      if (readout !== null && readout !== undefined) readout.textContent = `${model.nodes.length} nodes · ${model.edges.length} links`;
      if (metricValues[0] !== undefined) metricValues[0].textContent = String(model.nodes.length);
      if (metricValues[1] !== undefined) metricValues[1].textContent = String(model.edges.length);
    }
  }
}

function loadSnapshot(): void {
  installStyles();
  try {
    const data = document.querySelector<HTMLScriptElement>("#agent-mem-view-data")?.textContent;
    if (!data) throw new Error("viewer_snapshot_missing");
    state.snapshot = JSON.parse(data) as Snapshot;
    state.sources = state.snapshot.sources;
    state.detail = null;
    if (scopeSelect) {
      const all = `<option value="${GLOBAL_SCOPE_ID}" ${state.snapshot.selected_scope_id === GLOBAL_SCOPE_ID ? "selected" : ""}>All projects</option>`;
      const projects = state.snapshot.projects.map((project) => `<option value="${escapeHtml(project.scope_id)}" ${project.scope_id === state.snapshot?.selected_scope_id ? "selected" : ""}>${escapeHtml(project.root)}</option>`).join("");
      scopeSelect.innerHTML = all + projects;
    }
    render();
  } catch (error) { if (app) app.innerHTML = `<div class="error">${escapeHtml(error instanceof Error ? error.message : "viewer_unavailable")}</div>`; }
}

function loadSources(query: string): void {
  if (state.snapshot === null) return;
  const needle = query.trim().toLocaleLowerCase();
  state.sources = needle.length === 0
    ? state.snapshot.sources
    : state.snapshot.sources.filter((source) => [source.capture_id, source.session_id, source.host_kind, source.project_label, source.role, source.evidence_class, source.preview].some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)));
  render();
}

document.addEventListener("click", async (event: Event) => {
  const graphControl = (event.target as HTMLElement).closest<HTMLElement>("[data-graph-zoom]");
  if (graphControl && state.snapshot !== null) {
    const action = graphControl.dataset.graphZoom;
    if (activeGraphController !== null) {
      if (action === "in") activeGraphController.zoomBy(1.15);
      else if (action === "out") activeGraphController.zoomBy(1 / 1.15);
      else activeGraphController.reset();
    }
    return;
  }
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-view]");
  if (target) {
    state.view = target.dataset.view ?? "dashboard";
    document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === target));
    render();
    return;
  }
  const row = (event.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-capture-id]");
  if (row) {
    const detail = state.snapshot?.source_details.find((item) => item.capture_id === row.dataset.captureId);
    if (detail !== undefined) {
      state.detail = detail.source;
      state.view = "sources";
      render();
    }
    return;
  }
  if ((event.target as HTMLElement).closest("[data-close-detail]")) { state.detail = null; render(); }
});

document.addEventListener("input", (event: Event) => {
  if (state.view === "graph" && (event.target as HTMLElement).id === "graph-search" && state.snapshot !== null) {
    activeGraphController?.setQuery((event.target as HTMLInputElement).value);
  }
});

scopeSelect?.addEventListener("change", () => {
  const selected = scopeSelect.value || GLOBAL_SCOPE_ID;
  window.location.assign(selected === GLOBAL_SCOPE_ID ? "/" : `/?scope_id=${encodeURIComponent(selected)}`);
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
searchInput?.addEventListener("input", () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void loadSources(searchInput.value.trim()); }, 180);
});
void loadSnapshot();
