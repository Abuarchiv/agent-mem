import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createRuntime, type RuntimeOwner } from "../app/runtime.js";
import { createPolicySetupBinding, createPolicyOutputBinding, readerOutputTarget, setReaderOutputGrants, setScopeCapturePolicy, setScopeOutputGrants, setCapturePaused } from "../core/policy.js";
import { AgentMemoryBroker, AgentMemoryBrokerClient } from "../host/broker.js";
import { bindingOwnerId, validateBoundRecallRequest, type EvidencePacket, type TrustedBinding } from "../host/contract.js";
import { createMemoryMcpServer, type MemoryMcpServer } from "../host/mcp.js";
import { E5_MODEL_MANIFEST } from "../models/manifest.js";
import { loadReranker, parseRerankManifest, type LocalReranker } from "../models/rerank.js";
import { retrievalQuery } from "../retrieval/source-intelligence.js";
import type { RecallSnapshot } from "../store/database.js";
import { SearchState } from "./search-state.js";
import { acquireOwnerLock, clearStaleSocket } from "./lock.js";
import { bindingFor, ensurePrivateDirectory, loadConfig, runtimeDirectory, saveConfig, socketPath, vaultPath, type V1Config, type V1Connection } from "./config.js";
import { rerankerDataRoot } from "./extras.js";

const controlSchema = z.discriminatedUnion("operation", [
  z.object({ kind: z.literal("control"), operation: z.literal("status") }).strict(),
  z.object({ kind: z.literal("control"), operation: z.enum(["pause", "resume"]) }).strict(),
  z.object({ kind: z.literal("control"), operation: z.literal("forget"), capture_id: z.uuid(), scope_id: z.uuid() }).strict(),
  z.object({ kind: z.literal("control"), operation: z.literal("feedback"), scope_id: z.uuid(), query_id: z.uuid(), capture_id: z.uuid(), useful: z.boolean() }).strict(),
  z.object({ kind: z.literal("control"), operation: z.literal("procedure_add"), scope_id: z.uuid(), capture_id: z.uuid(), terms: z.array(z.string().trim().min(1).max(128)).min(1).max(32) }).strict(),
  z.object({ kind: z.literal("control"), operation: z.literal("procedure_list"), scope_id: z.uuid() }).strict(),
  z.object({ kind: z.literal("control"), operation: z.literal("procedure_remove"), scope_id: z.uuid(), capture_id: z.uuid() }).strict(),
]);
const mcpSchema = z.object({ kind: z.literal("mcp"), message: z.unknown() }).strict();
const sourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;
export const V1_OUTPUT_TARGETS = ["reader:codex_cli", "reader:opencode_cli", "reader:copilot_cli"] as const;
export const V1_READER_SOURCE_CLASSES = ["prompt", "assistant_output"] as const;

export interface V1ServiceOptions {
  readonly rerank?: boolean;
}

type RerankerStatus = { state: "disabled" | "loading" | "ready" | "disposing" | "disposed" | "unavailable"; reason: string | null };

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof Error && /^[A-Za-z0-9_.:-]+$/.test(error.message)) return error.message;
  return fallback;
}

function pinnedRerankerFactory(update: (status: RerankerStatus) => void, dataDirectory?: string): () => Promise<LocalReranker> {
  return async () => {
    update({ state: "loading", reason: null });
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const manifestPath = fileURLToPath(new URL("../models/rerank-manifest.json", import.meta.url));
    const manifest = parseRerankManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    const bundledBase = join(root, ".models", "rerank");
    const candidates = dataDirectory === undefined
      ? [bundledBase]
      : [rerankerDataRoot(dataDirectory), bundledBase];
    let lastError: unknown;
    for (const base of candidates) {
      try {
        const reranker = await loadReranker({ modelRoot: join(base, manifest.model_id, manifest.revision), manifest });
        update({ state: "ready", reason: null });
        return reranker;
      } catch (error: unknown) {
        lastError = error;
      }
    }
    const failure = lastError ?? new Error("source_reranker_unavailable");
    update({ state: "unavailable", reason: errorCode(failure, "source_reranker_unavailable") });
    throw failure;
  };
}

export function connectClient(directory: string, config: V1Config, entry?: V1Connection): AgentMemoryBrokerClient {
  return new AgentMemoryBrokerClient({
    socketPath: socketPath(directory),
    credential: { binding: bindingFor(config, entry), secret: Buffer.from(entry?.secret_hex ?? config.operator.secret_hex, "hex") },
    requestTimeoutMs: 15_000,
  });
}

export async function startService(directory: string, modelRoot?: string, options: V1ServiceOptions = {}) {
  ensurePrivateDirectory(directory);
  ensurePrivateDirectory(runtimeDirectory(directory));
  const releaseConfiguration = acquireOwnerLock(runtimeDirectory(directory), "agent-memory-v1-config", "config.lock");
  try { return await startConfiguredService(directory, modelRoot, options); }
  finally { releaseConfiguration(); }
}

async function startConfiguredService(directory: string, modelRoot?: string, options: V1ServiceOptions = {}) {
  const config = loadConfig(directory);
  if (config.projects.length === 0 || config.connections.length === 0) throw new Error("connect_a_project_before_start");
  ensurePrivateDirectory(runtimeDirectory(directory));
  const operator = bindingFor(config);
  const rerankEnabled = options.rerank ?? config.reranker_enabled ?? false;
  let rerankerStatus: RerankerStatus = rerankEnabled
    ? { state: "loading", reason: null }
    : { state: "disabled", reason: null };
  let searchState: SearchState | undefined;
  let searchStateError: string | null = null;
  try { searchState = new SearchState(directory); }
  catch (error: unknown) { searchStateError = errorCode(error, "search_state_unavailable"); }
  const updateRerankerStatus = (status: RerankerStatus): void => { rerankerStatus = status; };
  const credentials = [
    { binding: operator, secret: Buffer.from(config.operator.secret_hex, "hex"), allowNativeSessions: false },
    ...config.connections.map(entry => ({ binding: bindingFor(config, entry), secret: Buffer.from(entry.secret_hex, "hex"), allowNativeSessions: true })),
  ];
  const scopeIds = config.projects.map(p => p.scope_id);
  const targets = V1_OUTPUT_TARGETS;
  const policy = createPolicySetupBinding({ version: 1, setup_id: config.installation_id, allowed_scope_ids: scopeIds, allowed_output_targets: targets });
  const first = config.projects[0]!;
  const output = createPolicyOutputBinding(policy, { version: 1, setup_id: policy.setup_id, output_binding_id: randomUUID(), scope_id: first.scope_id, target: "reader:codex_cli" });
  let servers = new WeakMap<object, MemoryMcpServer>();
  let runtime: RuntimeOwner | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = () => { if (!runtime || closing) throw new Error("v1_backend_not_ready"); return runtime; };
  const stateOrThrow = (): SearchState => {
    if (searchState === undefined) throw new Error(searchStateError ?? "search_state_unavailable");
    return searchState;
  };
  const outputBindingFor = (binding: TrustedBinding, scopeId: string) => createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: randomUUID(),
    setup_id: policy.setup_id,
    scope_id: scopeId,
    target: readerOutputTarget(binding),
  });
  const requireCurrentSource = (owner: RuntimeOwner, binding: TrustedBinding, scopeId: string, captureId: string): void => {
    if (!scopeIds.includes(scopeId)) throw new Error("scope_not_allowed");
    try {
      if (owner.database.getSourceForOutput(captureId, outputBindingFor(binding, scopeId)) === undefined) throw new Error("source_not_found");
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "source_not_found") throw error;
      throw new Error("source_not_found", { cause: error });
    }
  };
  const recallMetadata = (owner: RuntimeOwner, binding: TrustedBinding, packet: EvidencePacket): Record<string, unknown> | undefined => {
    if (searchState === undefined) return undefined;
    const report = searchState.report(packet.query_id, bindingOwnerId(binding));
    if (report === undefined || !scopeIds.includes(report.scope_id) || !packet.scope_epochs?.some(scope => scope.scope_id === report.scope_id)) return undefined;
    try {
      const references = [...new Set([...report.candidates.map(candidate => candidate.capture_id), ...report.procedure_ids])];
      const snapshot: RecallSnapshot = {
        watermark: packet.watermark,
        data_epoch: packet.data_epoch,
        privacy_epoch: packet.privacy_epoch,
        scopes: packet.scope_epochs,
      };
      if (!owner.database.revalidateRecallSnapshot(snapshot, binding, references)) return undefined;
      const outputBinding = outputBindingFor(binding, report.scope_id);
      if (references.some((captureId) => owner.database.getSourceForOutput(captureId, outputBinding)?.scope_id !== report.scope_id)) return undefined;
    } catch {
      return undefined;
    }
    return {
      query_id: report.query_id,
      kind: report.kind,
      weights: { ...report.weights },
      procedure_ids: report.procedure_ids.slice(0, 10),
      stages: [...report.stages],
      reranker: report.reranker,
      graph_hops: report.graph_hops,
      graph_added: report.graph_added,
      graph_complete: report.graph_complete,
      learned_samples: report.learned_samples,
      candidate_count: report.candidates.length,
      procedure_count: report.procedure_ids.length,
    };
  };

  function status(requestingBinding: TrustedBinding = operator) {
    const visibleScopes = requestingBinding.binding_id === operator.binding_id
      ? new Set(scopeIds)
      : new Set(requestingBinding.allowed_scope_ids.filter(scopeId => scopeIds.includes(scopeId)));
    const intelligence = {
      search_state: searchState === undefined
        ? { state: "disabled" as const, reason: searchStateError }
        : { state: "ready" as const, reason: null, counts: searchState.status() },
      reranker: rerankerStatus,
    };
    if (!runtime) return { version: 1, running: true, state: "starting", pid: process.pid, intelligence };
    const state = runtime.status();
    intelligence.reranker = state.source_reranker;
    const indexState = state.semantic_search.state !== "ready" ? "unavailable" : state.jobs.failed + state.jobs.paused > 0 ? "degraded" : state.jobs.pending + state.jobs.running > 0 ? "indexing" : "ready";
    return {
      version: 1, running: !closing, state: indexState === "ready" ? "core_ready" : indexState, pid: process.pid,
      embedding: { state: indexState, model_state: state.semantic_search.state, reason: state.semantic_search.reason ?? (state.jobs.failed > 0 ? "index_jobs_failed" : state.jobs.paused > 0 ? "index_jobs_paused" : null), model: E5_MODEL_MANIFEST.model_id }, jobs: state.jobs,
      projects: config.projects.filter(project => visibleScopes.has(project.scope_id)).map(p => ({ root: p.root, scope_id: p.scope_id, capture_paused: runtime!.database.isCapturePaused(p.scope_id) })),
      intelligence,
    };
  }

  async function rpc(binding: TrustedBinding, payload: unknown, signal?: AbortSignal, client?: object): Promise<unknown> {
    const control = controlSchema.safeParse(payload);
    if (control.success) {
      const request = control.data;
      if (request.operation === "status") return status(binding);
      if (binding.binding_id !== operator.binding_id) throw new Error("operator_binding_required");
      const owner = active();
      if (request.operation === "forget") {
        stateOrThrow();
        if (!scopeIds.includes(request.scope_id)) throw new Error("scope_not_allowed");
        return owner.purge(request.capture_id, undefined, request.scope_id);
      }
      if (request.operation === "feedback") {
        requireCurrentSource(owner, binding, request.scope_id, request.capture_id);
        return stateOrThrow().feedback(request.scope_id, request.query_id, request.capture_id, request.useful);
      }
      if (request.operation === "procedure_add") {
        requireCurrentSource(owner, binding, request.scope_id, request.capture_id);
        stateOrThrow().registerProcedure({ scope_id: request.scope_id, capture_id: request.capture_id, terms: [...request.terms] });
        return { registered: true, scope_id: request.scope_id, capture_id: request.capture_id };
      }
      if (request.operation === "procedure_list") {
        if (!scopeIds.includes(request.scope_id)) throw new Error("scope_not_allowed");
        return stateOrThrow().procedures(request.scope_id);
      }
      if (request.operation === "procedure_remove") {
        if (!scopeIds.includes(request.scope_id)) throw new Error("scope_not_allowed");
        stateOrThrow().removeProcedure(request.scope_id, request.capture_id);
        return { removed: true, scope_id: request.scope_id, capture_id: request.capture_id };
      }
      await owner.brokerOwner.runMutation(() => {
        for (const scope of scopeIds) setCapturePaused(owner.database, policy, scope, request.operation === "pause", new Date().toISOString());
      });
      return status();
    }
    const parsed = mcpSchema.safeParse(payload);
    if (!parsed.success) throw new Error("v1_rpc_invalid");
    const owner = active();
    if (client === undefined) throw new Error("v1_rpc_client_missing");
    let server = servers.get(client);
    if (!server) {
      server = createMemoryMcpServer({
        database: owner.database, binding, policyBinding: policy, callTimeoutMs: 12_000,
        prepareRecall: async (input, context, recallSignal) => {
          const request = validateBoundRecallRequest(input, binding);
          const current = active();
          const options = { deadlineAt: context.deadline_at, ...(recallSignal === undefined ? {} : { signal: recallSignal }) };
          const vectors = await current.brokerOwner.embedQuery(options, retrievalQuery(request.query));
          return current.brokerOwner.runInteractive(options, (ownerSignal) => current.prepareSourceRecall(request, binding, context, vectors?.[0], ownerSignal));
        },
        recallMetadata: packet => recallMetadata(active(), binding, packet),
        write: input => active().brokerOwner.runMutation(() => active().database.summaries.writeSourceRecord(binding, input)),
        forget: async request => {
          stateOrThrow();
          return active().purgeSources(request);
        },
      });
      servers.set(client, server);
    }
    return server.handleMessageObject(parsed.data.message, signal);
  }

  const broker = new AgentMemoryBroker({
    runtimeDirectory: runtimeDirectory(directory),
    credentials,
    owner: () => runtime?.brokerOwner,
    rpcHandler: rpc,
    prepareRecall: (input, binding, context, queryVector, signal) => active().prepareSourceRecall(input, binding, context, queryVector, signal),
  });
  // Reserve the existing broker endpoint before loading a second DB/model owner.
  const releaseLock = acquireOwnerLock(runtimeDirectory(directory), config.installation_id);
  try {
    await clearStaleSocket(socketPath(directory));
    await broker.start();
    runtime = await createRuntime({
      vaultPath: vaultPath(directory), requireExisting: config.vault_initialized,
      embeddingModelRoot: modelRoot ?? fileURLToPath(new URL(`../../../.models/e5/${E5_MODEL_MANIFEST.model_id}/${E5_MODEL_MANIFEST.revision}`, import.meta.url)),
      scope: { scope_id: first.scope_id, kind: "project", owner_ref: config.installation_id, created_at: first.created_at },
      policyBinding: policy, outputBinding: output, hostBinding: operator,
      ...(rerankEnabled ? { sourceReranker: pinnedRerankerFactory(updateRerankerStatus, directory) } : {}),
      ...(searchState === undefined ? {} : { searchState }),
      initialize(database, timestamp) {
        for (const project of config.projects) {
          database.registerScope({ scope_id: project.scope_id, kind: "project", owner_ref: config.installation_id, created_at: project.created_at });
          if (!database.getScopeCapturePolicy(project.scope_id).enrolled) {
            setScopeOutputGrants(database, policy, project.scope_id, targets.map(target => ({ target, source_classes: [...V1_READER_SOURCE_CLASSES] })), timestamp);
            setScopeCapturePolicy(database, policy, project.scope_id, sourceClasses.map(source_class => ({ source_class, retention: { mode: "until_deleted" } })), timestamp);
          } else {
            setReaderOutputGrants(database, policy, project.scope_id, targets.map(target => ({ target, source_classes: [...V1_READER_SOURCE_CLASSES] })), timestamp);
          }
        }
      },
    });
    if (!config.vault_initialized) { config.vault_initialized = true; saveConfig(directory, config); }
  } catch (error) { await broker.stop(); await runtime?.close(); releaseLock(); throw error; }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => { await broker.stop(); await runtime?.close(); servers = new WeakMap(); releaseLock(); })();
    return closePromise;
  }
  return { status, close, database: runtime.database, broker, config };
}

export async function operatorCall(directory: string, payload: unknown): Promise<unknown> {
  const config = loadConfig(directory);
  if (process.platform !== "win32" && !existsSync(socketPath(directory))) throw new Error("v1_backend_not_running");
  const client = connectClient(directory, config);
  try { await client.connect(); return await client.rpc(payload); } finally { await client.close(); }
}
