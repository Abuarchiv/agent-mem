export type GraphNodeKind = "scope" | "session" | "source" | "entity";

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

export interface GraphEntity {
  readonly entity_id: string;
  readonly label: string;
  readonly resolution_state: string;
  readonly created_commit_seq: string;
}

export interface GraphRelation {
  readonly edge_id: string;
  readonly source_entity: string;
  readonly target_entity: string;
  readonly predicate: string;
  readonly evidence_revision: string;
  readonly status: string;
  readonly created_commit_seq: string;
}

export interface EvidenceGraphNode {
  readonly entity_id: string;
  readonly kind: GraphNodeKind;
  readonly label: string;
  readonly resolution_state: string;
  readonly created_commit_seq: string;
  readonly role?: string;
  readonly detail?: string;
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

export interface SemanticGraphInput {
  readonly nodes: readonly GraphEntity[];
  readonly edges: readonly GraphRelation[];
}

export interface GraphController {
  readonly zoomBy: (factor: number) => void;
  readonly reset: () => void;
  readonly setQuery: (query: string) => void;
  readonly destroy: () => void;
}

function projectLabel(root: string): string {
  const normalized = root.replace(/[\\/]+$/gu, "");
  return normalized.split(/[\\/]/u).pop() || normalized || "data space";
}

function roleLabel(role: string): string {
  return role === "user" ? "User" : role === "assistant" ? "Assistant" : role === "tool" ? "Tool" : "System";
}

function addNode(nodes: Map<string, EvidenceGraphNode>, node: EvidenceGraphNode): void {
  if (!nodes.has(node.entity_id)) nodes.set(node.entity_id, node);
}

function addEdge(edges: Map<string, EvidenceGraphEdge>, edge: EvidenceGraphEdge): void {
  if (!edges.has(edge.edge_id)) edges.set(edge.edge_id, edge);
}

function sessionEntity(scopeId: string, sessionId: string): string {
  return `session:${scopeId}:${sessionId}`;
}

function sourceEntity(scopeId: string, captureId: string): string {
  return `source:${scopeId}:${captureId}`;
}

export function buildEvidenceGraph(input: EvidenceGraphInput): EvidenceGraph {
  const nodes = new Map<string, EvidenceGraphNode>();
  const edges = new Map<string, EvidenceGraphEdge>();
  for (const project of input.projects) {
    addNode(nodes, {
      entity_id: `scope:${project.scope_id}`,
      kind: "scope",
      label: projectLabel(project.root),
      detail: project.root,
      resolution_state: "resolved",
      created_commit_seq: "0",
    });
  }
  for (const session of input.sessions) {
    const entityId = sessionEntity(session.scope_id, session.session_id);
    addNode(nodes, {
      entity_id: entityId,
      kind: "session",
      label: `${session.host_kind} · ${session.surface}`,
      detail: `${session.started_at} · ${session.coverage}`,
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
    const sessionId = sessionEntity(source.scope_id, source.session_id);
    addNode(nodes, {
      entity_id: sourceId,
      kind: "source",
      label: `${roleLabel(source.role)} · ${source.evidence_class}`,
      detail: `${source.observed_stage} · commit ${source.commit_seq}`,
      role: source.role,
      resolution_state: "resolved",
      created_commit_seq: source.commit_seq,
    });
    const parentId = nodes.has(sessionId) ? sessionId : `scope:${source.scope_id}`;
    addEdge(edges, {
      edge_id: `${parentId}-source:${source.scope_id}:${source.capture_id}`,
      from: parentId,
      to: sourceId,
      predicate: nodes.has(sessionId) ? "provides_evidence" : "contains_source",
      created_commit_seq: source.commit_seq,
    });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function mergeSemanticGraph(base: EvidenceGraph, input: SemanticGraphInput): EvidenceGraph {
  const nodes = [...base.nodes];
  const edges = [...base.edges];
  const knownNodes = new Set(nodes.map((node) => node.entity_id));
  const semanticIds = new Set<string>();
  for (const entity of input.nodes) {
    const entityId = `entity:${entity.entity_id}`;
    semanticIds.add(entityId);
    if (knownNodes.has(entityId)) continue;
    knownNodes.add(entityId);
    nodes.push({
      entity_id: entityId,
      kind: "entity",
      label: entity.label,
      detail: `semantic entity · commit ${entity.created_commit_seq}`,
      resolution_state: entity.resolution_state,
      created_commit_seq: entity.created_commit_seq,
    });
  }
  const edgeIds = new Set(edges.map((edge) => edge.edge_id));
  for (const relation of input.edges) {
    const from = `entity:${relation.source_entity}`;
    const to = `entity:${relation.target_entity}`;
    if (relation.status !== "active" || !semanticIds.has(from) || !semanticIds.has(to) || edgeIds.has(relation.edge_id)) continue;
    edgeIds.add(relation.edge_id);
    edges.push({
      edge_id: relation.edge_id,
      from,
      to,
      predicate: relation.predicate,
      created_commit_seq: relation.created_commit_seq,
    });
  }
  return { nodes, edges };
}

interface Point { x: number; y: number; }
interface Viewport { x: number; y: number; scale: number; }

const NODE_RADIUS: Record<GraphNodeKind, number> = { scope: 19, session: 12, source: 8, entity: 13 };
const NODE_COLOR: Record<GraphNodeKind, string> = { scope: "#57db80", session: "#899493", source: "#ff6b6b", entity: "#e7c85d" };

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function scopeOf(node: EvidenceGraphNode): string | undefined {
  const parts = node.entity_id.split(":");
  return parts.length > 1 && (node.kind === "scope" || node.kind === "session" || node.kind === "source") ? parts[1] : undefined;
}

function seedNodes(nodes: EvidenceGraphNode[]): Map<string, Point> {
  const points = new Map<string, Point>();
  const scopes = nodes.filter((node) => node.kind === "scope");
  scopes.forEach((node, index) => {
    const angle = (index / Math.max(scopes.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = scopes.length > 1 ? 150 : 0;
    points.set(node.entity_id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  const byScope = new Map<string, EvidenceGraphNode[]>();
  nodes.filter((node) => node.kind !== "scope").forEach((node) => {
    const key = scopeOf(node) ?? "semantic";
    const list = byScope.get(key) ?? [];
    list.push(node);
    byScope.set(key, list);
  });
  for (const [scopeId, list] of byScope) {
    const center = points.get(`scope:${scopeId}`) ?? { x: 0, y: 0 };
    list.forEach((node, index) => {
      const angle = index * 2.3999632297;
      const radius = node.kind === "session" ? 120 : node.kind === "entity" ? 230 : 280;
      points.set(node.entity_id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
  }
  return points;
}

function readColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function createGraphController(container: HTMLElement, model: EvidenceGraph): GraphController {
  if (model.nodes.length === 0) {
    container.innerHTML = `<div class="graph-empty">No knowledge graph data is available yet.<br>Real nodes appear after Codex source events or semantic relations are captured.</div>`;
    return { zoomBy: () => undefined, reset: () => undefined, setQuery: () => undefined, destroy: () => undefined };
  }
  const nodes = model.nodes.map((node) => ({ ...node }));
  const edges = [...model.edges];
  const byId = new Map(nodes.map((node) => [node.entity_id, node]));
  const positions = seedNodes(nodes);
  nodes.forEach((node) => { const point = positions.get(node.entity_id) ?? { x: 0, y: 0 }; (node as { x?: number }).x = point.x; (node as { y?: number }).y = point.y; });
  container.innerHTML = `<div class="graph-stage"><div class="graph-canvas-wrap"><canvas class="graph-canvas" tabindex="0" role="application" aria-label="Knowledge graph. Drag nodes, pan, zoom, and press F to fit view."></canvas></div><aside class="graph-inspector" aria-live="polite"></aside></div>`;
  const canvasElement = container.querySelector<HTMLCanvasElement>("canvas");
  const inspector = container.querySelector<HTMLElement>(".graph-inspector");
  if (canvasElement === null || inspector === null) return { zoomBy: () => undefined, reset: () => undefined, setQuery: () => undefined, destroy: () => undefined };
  const canvas = canvasElement;
  const context = canvas.getContext("2d");
  if (context === null) return { zoomBy: () => undefined, reset: () => undefined, setQuery: () => undefined, destroy: () => undefined };

  const getX = (node: EvidenceGraphNode): number => (node as EvidenceGraphNode & { x: number }).x;
  const getY = (node: EvidenceGraphNode): number => (node as EvidenceGraphNode & { y: number }).y;
  const setPoint = (node: EvidenceGraphNode, point: Point): void => { (node as EvidenceGraphNode & { x: number; y: number }).x = point.x; (node as EvidenceGraphNode & { x: number; y: number }).y = point.y; };
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let raf = 0;
  let alpha = 1;
  let query = "";
  let selected: EvidenceGraphNode | undefined;
  let hover: EvidenceGraphNode | undefined;
  let dragNode: EvidenceGraphNode | undefined;
  let pointerId: number | undefined;
  let lastX = 0;
  let lastY = 0;
  let moved = 0;
  let panning = false;
  const viewport: Viewport = { x: 0, y: 0, scale: 1 };
  const textColor = readColor("--text", "#e7ece9");
  const mutedColor = readColor("--muted", "#899493");
  const normalizedQuery = (): string => query.trim().toLocaleLowerCase();
  const matches = (node: EvidenceGraphNode): boolean => { const needle = normalizedQuery(); return needle.length === 0 || `${node.entity_id} ${node.label} ${node.detail ?? ""}`.toLocaleLowerCase().includes(needle); };
  const connected = (node: EvidenceGraphNode, other: EvidenceGraphNode): boolean => edges.some((edge) => (edge.from === node.entity_id && edge.to === other.entity_id) || (edge.to === node.entity_id && edge.from === other.entity_id));

  const nodeColor = (node: EvidenceGraphNode): string => {
    if (node.kind === "source" && node.role === "assistant") return "#c8d2ce";
    if (node.kind === "source" && node.role === "tool") return "#8d7ad8";
    return NODE_COLOR[node.kind];
  };
  const screenPoint = (node: EvidenceGraphNode): Point => ({ x: (getX(node) - viewport.x) * viewport.scale + width / 2, y: (getY(node) - viewport.y) * viewport.scale + height / 2 });
  const worldPoint = (clientX: number, clientY: number): Point => { const rect = canvas.getBoundingClientRect(); return { x: (clientX - rect.left - width / 2) / viewport.scale + viewport.x, y: (clientY - rect.top - height / 2) / viewport.scale + viewport.y }; };
  const nodeAt = (clientX: number, clientY: number): EvidenceGraphNode | undefined => { const point = worldPoint(clientX, clientY); for (let index = nodes.length - 1; index >= 0; index -= 1) { const node = nodes[index]!; const dx = getX(node) - point.x; const dy = getY(node) - point.y; if (dx * dx + dy * dy <= (NODE_RADIUS[node.kind] + 7) ** 2) return node; } return undefined; };

  const legend = `<div class="graph-legend"><div class="graph-inspector-kicker">Legend</div><div class="graph-legend-row"><i style="background:${NODE_COLOR.scope}"></i>Data space</div><div class="graph-legend-row"><i style="background:${NODE_COLOR.session}"></i>Session</div><div class="graph-legend-row"><i style="background:#ff6b6b"></i>Source / user</div><div class="graph-legend-row"><i style="background:#c8d2ce"></i>Source / assistant</div><div class="graph-legend-row"><i style="background:${NODE_COLOR.entity}"></i>Semantic entity</div></div>`;
  const showInspector = (node: EvidenceGraphNode | undefined): void => {
    const selection = node === undefined
      ? `<div class="graph-inspector-kicker">Knowledge graph</div><h3>Local memory</h3><p>Real relationships from captured sessions, source evidence, and semantic entities.</p><div class="graph-stat"><span>Nodes</span><strong>${nodes.length}</strong></div><div class="graph-stat"><span>Links</span><strong>${edges.length}</strong></div>`
      : `<div class="graph-inspector-kicker">${escapeHtml(node.kind)}</div><h3>${escapeHtml(node.label)}</h3><p>${escapeHtml(node.detail ?? "Resolved from local evidence.")}</p><dl><div><dt>Connections</dt><dd>${edges.filter((edge) => edge.from === node.entity_id || edge.to === node.entity_id).length}</dd></div><div><dt>Entity</dt><dd>${escapeHtml(node.entity_id)}</dd></div><div><dt>Commit</dt><dd>${escapeHtml(node.created_commit_seq)}</dd></div></dl>`;
    inspector.innerHTML = `${selection}${legend}`;
  };

  const resize = (): void => { const box = canvas.parentElement; if (box === null) return; width = box.clientWidth; height = box.clientHeight; pixelRatio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.max(1, Math.floor(width * pixelRatio)); canvas.height = Math.max(1, Math.floor(height * pixelRatio)); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); draw(); };
  const fit = (): void => { let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity; nodes.forEach((node) => { minX = Math.min(minX, getX(node)); minY = Math.min(minY, getY(node)); maxX = Math.max(maxX, getX(node)); maxY = Math.max(maxY, getY(node)); }); const spanX = Math.max(maxX - minX, 180); const spanY = Math.max(maxY - minY, 180); viewport.x = (minX + maxX) / 2; viewport.y = (minY + maxY) / 2; viewport.scale = Math.min(2.2, Math.max(0.18, Math.min(width / (spanX + 220), height / (spanY + 220)))); draw(); };
  const draw = (): void => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#090b0c";
    context.fillRect(0, 0, width, height);
    const focused = selected ?? hover;
    for (const edge of edges) {
      const from = byId.get(edge.from); const to = byId.get(edge.to); if (from === undefined || to === undefined) continue;
      const a = screenPoint(from); const b = screenPoint(to); const edgeFocused = focused !== undefined && (edge.from === focused.entity_id || edge.to === focused.entity_id); const visible = matches(from) && matches(to);
      context.globalAlpha = !visible ? 0.05 : focused === undefined || edgeFocused ? 0.62 : 0.12;
      context.strokeStyle = edgeFocused ? "#ff6b6b" : "#657371"; context.lineWidth = edgeFocused ? 1.8 : 1;
      context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
      if (edgeFocused && viewport.scale > 0.55) { context.globalAlpha = 1; context.fillStyle = mutedColor; context.font = "9px ui-monospace, monospace"; context.fillText(edge.predicate, (a.x + b.x) / 2 + 5, (a.y + b.y) / 2 - 4); }
    }
    for (const node of nodes) {
      const point = screenPoint(node); const visible = matches(node); const active = node === selected || node === hover || (selected !== undefined && connected(node, selected)); const radius = NODE_RADIUS[node.kind] * viewport.scale;
      context.globalAlpha = visible ? selected === undefined || active ? 1 : 0.18 : 0.06; context.fillStyle = nodeColor(node); context.strokeStyle = "#111516"; context.lineWidth = 2; context.beginPath(); context.arc(point.x, point.y, Math.max(3, radius), 0, Math.PI * 2); context.fill(); context.stroke();
      if (node === selected || node === hover) { context.globalAlpha = 1; context.strokeStyle = "#f5f7f5"; context.lineWidth = 1.5; context.beginPath(); context.arc(point.x, point.y, Math.max(6, radius + 6), 0, Math.PI * 2); context.stroke(); }
      const showLabel = node.kind !== "source" || node === selected || node === hover || viewport.scale > 1.35;
      if (showLabel) { context.globalAlpha = visible ? 1 : 0.18; context.fillStyle = textColor; context.font = node.kind === "scope" ? "600 12px ui-monospace, monospace" : "11px ui-monospace, monospace"; const label = node.label.length > 32 ? `${node.label.slice(0, 31)}…` : node.label; context.fillText(label, point.x + Math.max(8, radius + 7), point.y + 4); }
    }
    context.globalAlpha = 1;
  };
  const wake = (): void => { alpha = Math.max(alpha, 0.3); if (raf === 0) raf = requestAnimationFrame(tick); };
  const tick = (): void => {
    raf = 0;
    if (alpha > 0.02 && nodes.length > 1) {
      for (let index = 0; index < nodes.length; index += 1) {
        const left = nodes[index]!; let vx = 0; let vy = 0;
        for (let otherIndex = index + 1; otherIndex < nodes.length; otherIndex += 1) { const right = nodes[otherIndex]!; let dx = getX(right) - getX(left); let dy = getY(right) - getY(left); const distanceSq = Math.max(dx * dx + dy * dy, 64); const distance = Math.sqrt(distanceSq); const force = 2600 / distanceSq; dx /= distance; dy /= distance; if (dragNode !== left) { (left as unknown as { vx: number }).vx = ((left as unknown as { vx: number }).vx ?? 0) - dx * force * alpha; (left as unknown as { vy: number }).vy = ((left as unknown as { vy: number }).vy ?? 0) - dy * force * alpha; } if (dragNode !== right) { (right as unknown as { vx: number }).vx = ((right as unknown as { vx: number }).vx ?? 0) + dx * force * alpha; (right as unknown as { vy: number }).vy = ((right as unknown as { vy: number }).vy ?? 0) + dy * force * alpha; } }
        if (dragNode !== left) { vx = (left as unknown as { vx: number }).vx ?? 0; vy = (left as unknown as { vy: number }).vy ?? 0; const centerForce = 0.001 * alpha; (left as unknown as { vx: number }).vx = vx - getX(left) * centerForce; (left as unknown as { vy: number }).vy = vy - getY(left) * centerForce; }
      }
      for (const edge of edges) { const from = byId.get(edge.from); const to = byId.get(edge.to); if (from === undefined || to === undefined) continue; const dx = getX(to) - getX(from); const dy = getY(to) - getY(from); const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1); const force = (distance - (from.kind === "scope" || to.kind === "scope" ? 170 : 120)) * 0.012 * alpha; if (dragNode !== from) { (from as unknown as { vx: number }).vx = ((from as unknown as { vx: number }).vx ?? 0) + dx / distance * force; (from as unknown as { vy: number }).vy = ((from as unknown as { vy: number }).vy ?? 0) + dy / distance * force; } if (dragNode !== to) { (to as unknown as { vx: number }).vx = ((to as unknown as { vx: number }).vx ?? 0) - dx / distance * force; (to as unknown as { vy: number }).vy = ((to as unknown as { vy: number }).vy ?? 0) - dy / distance * force; } }
      for (const node of nodes) { if (dragNode === node) continue; const velocity = node as unknown as { vx: number; vy: number }; velocity.vx = Math.max(-10, Math.min(10, velocity.vx ?? 0)) * 0.86; velocity.vy = Math.max(-10, Math.min(10, velocity.vy ?? 0)) * 0.86; setPoint(node, { x: getX(node) + velocity.vx, y: getY(node) + velocity.vy }); }
      alpha *= 0.985;
    }
    draw(); if (alpha > 0.02) raf = requestAnimationFrame(tick);
  };
  const pointerDown = (event: PointerEvent): void => { const rect = canvas.getBoundingClientRect(); pointerId = event.pointerId; dragNode = nodeAt(event.clientX, event.clientY); panning = dragNode === undefined; moved = 0; lastX = event.clientX - rect.left; lastY = event.clientY - rect.top; canvas.setPointerCapture(event.pointerId); wake(); };
  const pointerMove = (event: PointerEvent): void => { const node = nodeAt(event.clientX, event.clientY); if (pointerId === undefined) { if (node !== hover) { hover = node; canvas.style.cursor = node === undefined ? "default" : "grab"; draw(); } return; } const rect = canvas.getBoundingClientRect(); const dx = event.clientX - rect.left - lastX; const dy = event.clientY - rect.top - lastY; moved += Math.abs(dx) + Math.abs(dy); if (dragNode !== undefined) { setPoint(dragNode, worldPoint(event.clientX, event.clientY)); } else if (panning) { viewport.x -= dx / viewport.scale; viewport.y -= dy / viewport.scale; } lastX = event.clientX - rect.left; lastY = event.clientY - rect.top; wake(); };
  const pointerUp = (event: PointerEvent): void => { if (event.pointerId !== pointerId) return; if (moved < 5) { selected = nodeAt(event.clientX, event.clientY); showInspector(selected); } pointerId = undefined; dragNode = undefined; panning = false; draw(); };
  const wheel = (event: WheelEvent): void => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); const mx = event.clientX - rect.left - width / 2; const my = event.clientY - rect.top - height / 2; const next = Math.min(3, Math.max(0.15, viewport.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1))); viewport.x += mx / viewport.scale - mx / next; viewport.y += my / viewport.scale - my / next; viewport.scale = next; draw(); };
  const keydown = (event: KeyboardEvent): void => { if (event.key === "f" || event.key === "F") fit(); else if (event.key === "+" || event.key === "=") controller.zoomBy(1.15); else if (event.key === "-" || event.key === "_") controller.zoomBy(1 / 1.15); else if (event.key === "Escape") { selected = undefined; showInspector(undefined); draw(); } else return; event.preventDefault(); };
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", pointerUp); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", keydown); resizeObserver?.observe(canvas.parentElement ?? canvas); resize(); fit(); showInspector(undefined); wake();
  const controller: GraphController = { zoomBy: (factor) => { viewport.scale = Math.min(3, Math.max(0.15, viewport.scale * factor)); draw(); }, reset: () => { selected = undefined; query = ""; fit(); showInspector(undefined); }, setQuery: (nextQuery) => { query = nextQuery; draw(); }, destroy: () => { if (raf !== 0) cancelAnimationFrame(raf); resizeObserver?.disconnect(); canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", pointerUp); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", keydown); } };
  return controller;
}
