import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { z } from "zod";

import type { PolicyOutputBinding } from "../core/policy.js";
import type { AgentMemoryDatabase } from "../store/database.js";
import { buildViewSnapshot, readViewSource, type ViewModelOptions, type ViewProject } from "./model.js";

const portSchema = z.number().int().min(0).max(65_535);
const scopeSchema = z.uuid();
const captureSchema = z.uuid();
const maxSourceQueryBytes = 4_096;

export interface V1ViewServerOptions {
  readonly database: AgentMemoryDatabase;
  readonly projects: readonly ViewProject[];
  readonly status: () => unknown;
  readonly localUiBindingFor: (scopeId: string) => PolicyOutputBinding;
  readonly readerOutputBindingFor: (scopeId: string) => PolicyOutputBinding;
  readonly countUnits?: ((text: string) => number) | undefined;
  readonly port?: number;
}

export interface V1ViewServer {
  readonly url: string;
  close(): Promise<void>;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, json(value), "application/json; charset=utf-8");
}

function sendError(response: ServerResponse, status: number, code: string): void {
  sendJson(response, status, { version: 1, error: code });
}

function clientScript(): string {
  return readFileSync(new URL("./client.js", import.meta.url), "utf8");
}

function indexDocument(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>agent-mem</title></head><body><header class="topbar"><a class="brand" href="#dashboard">agent-mem <small>V1</small></a><nav class="tabs" aria-label="Viewer sections"><button class="tab is-active" data-view="dashboard">DASHBOARD</button><button class="tab" data-view="sources">SOURCES</button><button class="tab" data-view="records">MEMORY RECORDS</button><button class="tab" data-view="sessions">SESSIONS / JOBS</button><button class="tab" data-view="graph">GRAPH</button><button class="tab" data-view="audit">AUDIT</button></nav><div class="top-actions"><label class="scope-picker">Project<select id="scope-select" aria-label="Project scope"></select></label><label class="search-box" aria-label="Search sources"><span aria-hidden="true">⌕</span><input id="source-search" type="search" placeholder="Search sources…" autocomplete="off"></label><span class="live-status"><i></i> LIVE</span></div></header><main id="app" class="shell" aria-live="polite"><div class="loading">Loading local vault…</div></main><footer class="footer">Agent Mem · local read-only viewer · no writes from this page</footer><script type="module" src="/view.js"></script></body></html>`;
}

function selectedScope(url: URL, projects: readonly ViewProject[]): string {
  const requested = url.searchParams.get("scope_id") ?? projects[0]?.scope_id;
  if (requested === undefined || !scopeSchema.safeParse(requested).success || !projects.some((project) => project.scope_id === requested)) {
    throw new Error("view_scope_invalid");
  }
  return requested;
}

function queryText(url: URL): string | undefined {
  const value = url.searchParams.get("query") ?? undefined;
  if (value !== undefined && Buffer.byteLength(value, "utf8") > maxSourceQueryBytes) throw new Error("view_query_too_large");
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function viewModel(options: V1ViewServerOptions): ViewModelOptions {
  return {
    database: options.database,
    projects: options.projects,
    status: options.status,
    localUiBindingFor: options.localUiBindingFor,
    readerOutputBindingFor: options.readerOutputBindingFor,
    countUnits: options.countUnits,
  };
}

function sourceSearch(options: V1ViewServerOptions, scopeId: string, query: string | undefined): unknown {
  const binding = options.localUiBindingFor(scopeId);
  if (query === undefined) return buildViewSnapshot(viewModel(options), scopeId).sources;
  return options.database
    .searchSourcesForOutput(binding, { query, limit: 50 })
    .groups
    .map((group) => ({
      capture_id: group.capture_id,
      scope_id: group.scope_id,
      session_id: group.session_id,
      host_kind: group.host_kind,
      project_label: group.project_label,
      commit_seq: group.commit_seq,
      captured_at: group.captured_at,
      occurred_at: group.occurred_at,
      evidence_class: group.evidence_class,
      role: group.role,
      job_state: group.job_state,
      preview: group.spans.map((span) => span.quote).join(" ").slice(0, 220),
      span_count: group.spans.length,
    }));
}

function handleRequest(options: V1ViewServerOptions, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") {
    sendError(response, 405, "method_not_allowed");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/") {
      send(response, 200, indexDocument(), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/view.js") {
      send(response, 200, clientScript(), "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/snapshot") {
      sendJson(response, 200, buildViewSnapshot(viewModel(options), selectedScope(url, options.projects)));
      return;
    }
    if (url.pathname === "/api/sources") {
      sendJson(response, 200, { version: 1, sources: sourceSearch(options, selectedScope(url, options.projects), queryText(url)) });
      return;
    }
    if (url.pathname === "/api/source") {
      const scopeId = selectedScope(url, options.projects);
      const captureId = captureSchema.parse(url.searchParams.get("capture_id"));
      const source = readViewSource(viewModel(options), scopeId, captureId);
      if (source === undefined) {
        sendError(response, 404, "source_not_found");
        return;
      }
      sendJson(response, 200, { version: 1, source });
      return;
    }
    sendError(response, 404, "not_found");
  } catch (error: unknown) {
    const code = error instanceof Error && /^[a-z][a-z0-9_]{1,63}$/.test(error.message) ? error.message : "view_unavailable";
    sendError(response, code === "view_scope_invalid" ? 400 : 500, code);
  }
}

export async function createV1ViewServer(options: V1ViewServerOptions): Promise<V1ViewServer> {
  const port = portSchema.parse(options.port ?? 0);
  const server = createServer((request, response) => handleRequest(options, request, response));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("view_address_unavailable");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}
