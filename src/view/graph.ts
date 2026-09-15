export interface GraphProject {
  readonly scope_id: string;
  readonly root: string;
}

export interface GraphSession {
  readonly session_id: string;
  readonly scope_id: string;
  readonly host_kind: string;
  readonly surface: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly coverage: string;
}

export interface GraphSource {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly session_id: string;
  readonly role: string;
  readonly evidence_class: string;
  readonly observed_stage: string;
  readonly commit_seq: string;
}

export type GraphNodeKind = "scope" | "session" | "source";

export interface EvidenceGraphNode {
  readonly entity_id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly resolution_state: "resolved" | "candidate";
  readonly created_commit_seq: string;
}

export interface EvidenceGraphEdge {
  readonly edge_id: string;
  readonly from: string;
  readonly to: string;
  readonly predicate: string;
  readonly created_commit_seq: string;
}

export interface EvidenceGraph {
  readonly nodes: readonly EvidenceGraphNode[];
  readonly edges: readonly EvidenceGraphEdge[];
}

export interface EvidenceGraphInput {
  readonly projects: readonly GraphProject[];
  readonly sessions: readonly GraphSession[];
  readonly sources: readonly GraphSource[];
}

function sessionEntity(scopeId: string, sessionId: string): string {
  return `session:${scopeId}:${sessionId}`;
}

function sourceEntity(scopeId: string, captureId: string): string {
  return `source:${scopeId}:${captureId}`;
}

function addNode(nodes: Map<string, EvidenceGraphNode>, node: EvidenceGraphNode): void {
  if (!nodes.has(node.entity_id)) nodes.set(node.entity_id, node);
}

function addEdge(edges: Map<string, EvidenceGraphEdge>, edge: EvidenceGraphEdge): void {
  if (!edges.has(edge.edge_id)) edges.set(edge.edge_id, edge);
}

export function buildEvidenceGraph(input: EvidenceGraphInput): EvidenceGraph {
  const nodes = new Map<string, EvidenceGraphNode>();
  const edges = new Map<string, EvidenceGraphEdge>();

  for (const project of input.projects) {
    addNode(nodes, {
      entity_id: `scope:${project.scope_id}`,
      kind: "scope",
      label: project.root,
      resolution_state: "resolved",
      created_commit_seq: "0",
    });
  }

  for (const session of input.sessions) {
    const entityId = sessionEntity(session.scope_id, session.session_id);
    addNode(nodes, {
      entity_id: entityId,
      kind: "session",
      label: `${session.host_kind} / ${session.surface}`,
      resolution_state: "resolved",
      created_commit_seq: "0",
    });
    addEdge(edges, {
      edge_id: `scope-session:${session.scope_id}:${session.session_id}`,
      from: `scope:${session.scope_id}`,
      to: entityId,
      predicate: "has_session",
      created_commit_seq: "0",
    });
  }

  for (const source of input.sources) {
    const sourceId = sourceEntity(source.scope_id, source.capture_id);
    const knownSession = sessionEntity(source.scope_id, source.session_id);
    addNode(nodes, {
      entity_id: sourceId,
      kind: "source",
      label: `${source.role} / ${source.evidence_class}`,
      resolution_state: "resolved",
      created_commit_seq: source.commit_seq,
    });
    const parentId = nodes.has(knownSession) ? knownSession : `scope:${source.scope_id}`;
    addEdge(edges, {
      edge_id: `${parentId}-source:${source.scope_id}:${source.capture_id}`,
      from: parentId,
      to: sourceId,
      predicate: nodes.has(knownSession) ? "provides_evidence" : "contains_source",
      created_commit_seq: source.commit_seq,
    });
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

export interface GraphController {
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  readonly setQuery: (query: string) => void;
  readonly destroy: () => void;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const GRAPH_WIDTH = 960;
const GRAPH_HEIGHT = 560;

function nodePoint(index: number, count: number): Point {
  const angle = count <= 1 ? 0 : (Math.PI * 2 * index) / count - Math.PI / 2;
  const radius = Math.min(220, Math.max(80, count * 16));
  return {
    x: GRAPH_WIDTH / 2 + Math.cos(angle) * radius,
    y: GRAPH_HEIGHT / 2 + Math.sin(angle) * radius,
  };
}

function drawGraph(canvas: HTMLCanvasElement, model: EvidenceGraph, query: string, zoom: number): Map<string, Point> {
  const context = canvas.getContext("2d");
  const points = new Map<string, Point>();
  if (context === null) return points;

  const normalized = query.trim().toLocaleLowerCase();
  const visibleNodes = model.nodes.filter((node) => normalized.length === 0 || node.label.toLocaleLowerCase().includes(normalized) || node.entity_id.toLocaleLowerCase().includes(normalized));
  const visibleIds = new Set(visibleNodes.map((node) => node.entity_id));
  const visibleEdges = model.edges.filter((edge) => {
    if (!visibleIds.has(edge.from) || !visibleIds.has(edge.to)) return false;
    return normalized.length === 0 || edge.predicate.toLocaleLowerCase().includes(normalized);
  });

  const scale = window.devicePixelRatio || 1;
  canvas.width = GRAPH_WIDTH * scale;
  canvas.height = GRAPH_HEIGHT * scale;
  canvas.style.aspectRatio = `${GRAPH_WIDTH} / ${GRAPH_HEIGHT}`;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
  context.fillStyle = "#090b0c";
  context.fillRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
  context.save();
  context.translate(GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2);
  context.scale(zoom, zoom);
  context.translate(-GRAPH_WIDTH / 2, -GRAPH_HEIGHT / 2);

  visibleNodes.forEach((node, index) => points.set(node.entity_id, nodePoint(index, visibleNodes.length)));
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.lineWidth = 1.4;
  for (const edge of visibleEdges) {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (from === undefined || to === undefined) continue;
    context.strokeStyle = "#5b6b6d";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.fillStyle = "#899493";
    context.fillText(edge.predicate, (from.x + to.x) / 2, (from.y + to.y) / 2);
  }
  for (const node of visibleNodes) {
    const point = points.get(node.entity_id);
    if (point === undefined) continue;
    context.fillStyle = node.resolution_state === "candidate" ? "#e7c85d" : node.kind === "scope" ? "#57db80" : "#ff6b6b";
    context.strokeStyle = "#111516";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(point.x, point.y, 18, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = "#e7ece9";
    context.fillText(node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label, point.x + 25, point.y + 4);
  }
  context.restore();
  return points;
}

export function createGraphController(container: HTMLElement, model: EvidenceGraph): GraphController {
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "graph-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Knowledge graph");
  canvasWrap.appendChild(canvas);
  const inspector = document.createElement("aside");
  inspector.className = "graph-inspector";
  inspector.innerHTML = "<div class=\"graph-inspector-kicker\">Selection</div><p>Click a node to inspect its local evidence link.</p>";
  stage.append(canvasWrap, inspector);
  container.replaceChildren(stage);

  let zoom = 1;
  let query = "";
  let points = new Map<string, Point>();
  const listeners: Array<() => void> = [];
  const render = (): void => {
    points = drawGraph(canvas, model, query, zoom);
  };
  const showSelection = (selected: EvidenceGraphNode): void => {
    const kicker = document.createElement("div");
    kicker.className = "graph-inspector-kicker";
    kicker.textContent = selected.kind;
    const heading = document.createElement("h3");
    heading.textContent = selected.label;
    const description = document.createElement("p");
    description.textContent = selected.resolution_state === "candidate"
      ? "Candidate relation; source-backed but not resolved to a stored session."
      : "Resolved from local evidence.";
    const details = document.createElement("dl");
    for (const [label, value] of [["Entity", selected.entity_id], ["Commit sequence", selected.created_commit_seq]] as const) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      row.append(term, detail);
      details.appendChild(row);
    }
    inspector.replaceChildren(kicker, heading, description, details);
  };
  const selectNode = (event: MouseEvent): void => {
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * GRAPH_WIDTH;
    const y = ((event.clientY - bounds.top) / bounds.height) * GRAPH_HEIGHT;
    const selected = model.nodes.find((node) => {
      const point = points.get(node.entity_id);
      if (point === undefined) return false;
      const graphX = (x - GRAPH_WIDTH / 2) / zoom + GRAPH_WIDTH / 2;
      const graphY = (y - GRAPH_HEIGHT / 2) / zoom + GRAPH_HEIGHT / 2;
      return Math.hypot(point.x - graphX, point.y - graphY) <= 22;
    });
    if (selected === undefined) return;
    showSelection(selected);
  };
  canvas.addEventListener("click", selectNode);
  listeners.push(() => canvas.removeEventListener("click", selectNode));
  render();

  return {
    zoomBy: (factor: number): void => {
      if (!Number.isFinite(factor) || factor <= 0) return;
      zoom = Math.min(2.5, Math.max(0.5, zoom * factor));
      render();
    },
    reset: (): void => {
      zoom = 1;
      query = "";
      render();
    },
    setQuery: (nextQuery: string): void => {
      query = nextQuery;
      render();
    },
    destroy: (): void => {
      listeners.splice(0).forEach((remove) => remove());
      if (container.contains(stage)) container.replaceChildren();
    },
  };
}
