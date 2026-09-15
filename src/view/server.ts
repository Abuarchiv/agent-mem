import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { z } from "zod";

import type { PolicyOutputBinding } from "../core/policy.js";
import type { AgentMemoryDatabase } from "../store/database.js";
import { buildViewSnapshot, GLOBAL_SCOPE_ID, type ViewModelOptions, type ViewProject, type ViewSnapshot } from "./model.js";

const portSchema = z.number().int().min(0).max(65_535);
const scopeSchema = z.uuid();

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
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function sendError(response: ServerResponse, status: number, code: string): void {
  send(response, status, `<!doctype html><meta charset="utf-8"><title>agent-mem viewer</title><pre>${code}</pre>`, "text/html; charset=utf-8");
}

function clientScript(): string {
  return readFileSync(new URL("./client.js", import.meta.url), "utf8");
}

function graphScript(): string {
  return readFileSync(new URL("./graph.js", import.meta.url), "utf8");
}

function embeddedSnapshot(snapshot: ViewSnapshot): string {
  return json(snapshot)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function indexDocument(snapshot: ViewSnapshot): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>agent-mem viewer</title></head><body><header class="topbar"><a class="brand" href="/?scope_id=${encodeURIComponent(GLOBAL_SCOPE_ID)}">agent-mem <small>V1</small></a><nav class="tabs" aria-label="Viewer sections"><button class="tab is-active" data-view="dashboard">DASHBOARD</button><button class="tab" data-view="sources">SOURCES</button><button class="tab" data-view="records">MEMORY RECORDS</button><button class="tab" data-view="sessions">SESSIONS / JOBS</button><button class="tab" data-view="graph">GRAPH</button><button class="tab" data-view="audit">AUDIT</button></nav><div class="top-actions"><label class="scope-picker">View<select id="scope-select" aria-label="Viewer scope"></select></label><label class="search-box" aria-label="Search sources"><span aria-hidden="true">⌕</span><input id="source-search" type="search" placeholder="Search sources…" autocomplete="off"></label><span class="live-status"><i></i> LOCAL</span></div></header><main id="app" class="shell" aria-live="polite"><div class="loading">Reading local vault…</div></main><footer class="footer">Agent Mem · local read-only viewer · embedded snapshot · no REST endpoints</footer><script id="agent-mem-view-data" type="application/json">${embeddedSnapshot(snapshot)}</script><script type="module" src="/view.js"></script></body></html>`;
}

function selectedScope(url: URL, projects: readonly ViewProject[]): string {
  const requested = url.searchParams.get("scope_id") ?? GLOBAL_SCOPE_ID;
  if (requested === GLOBAL_SCOPE_ID) return requested;
  if (scopeSchema.safeParse(requested).success && projects.some((project) => project.scope_id === requested)) return requested;
  throw new Error("view_scope_invalid");
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

function handleRequest(options: V1ViewServerOptions, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") {
    sendError(response, 405, "method_not_allowed");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/") {
      const snapshot = buildViewSnapshot(viewModel(options), selectedScope(url, options.projects));
      send(response, 200, indexDocument(snapshot), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/view.js") {
      send(response, 200, clientScript(), "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/graph.js") {
      send(response, 200, graphScript(), "text/javascript; charset=utf-8");
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
