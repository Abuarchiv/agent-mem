import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { configureHost } from "../src/v1/connect.js";
import { defaultDataDirectory, installJournalFile, loadConfig, runtimeDirectory, saveConfig, V1_HOSTS } from "../src/v1/config.js";
import { createInstallJournal, readInstallJournal, updateInstallJournal, writeInstallJournal } from "../src/v1/install-journal.js";
import { createInstallPlan, detectInstallHostProbe, ensureOwnedService, InstallError, parseInstallArgs, stopOwnedService, type InstallOptions } from "../src/v1/install.js";
import { assertPrivatePath } from "../src/v1/private-files.js";

const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);

async function serviceState(directory: string): Promise<"ready" | "starting" | "stopped"> {
  try {
    const { operatorCall } = await import("../src/v1/service.js");
    const value = await operatorCall(directory, { kind: "control", operation: "status" });
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "stopped";
    const state = value as { readonly running?: unknown; readonly state?: unknown };
    if (state.running !== true) return "stopped";
    return state.state === "starting" ? "starting" : "ready";
  } catch {
    return "stopped";
  }
}

async function serviceIsReady(directory: string): Promise<boolean> {
  return (await serviceState(directory)) === "ready";
}

async function serviceIsStarting(directory: string): Promise<boolean> {
  return (await serviceState(directory)) === "starting";
}

function operationErrorCode(error: unknown, fallback = "install_failed"): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{1,127}$/.test(error.message) ? error.message : fallback;
}

function launchOwnedService(directory: string, options: InstallOptions): Promise<number> {
  const logPath = join(runtimeDirectory(directory), "owner.log");
  const logFd = openSync(logPath, "a", 0o600);
  const entry = fileURLToPath(new URL("./v1.js", import.meta.url));
  try {
    const child = spawn(process.execPath, [
      entry, "--data-dir", directory, "start", ...(options.rerank ? ["--rerank"] : []),
    ], {
      cwd: options.project,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("install_broker_pid_invalid");
    child.unref();
    return Promise.resolve(pid);
  } finally {
    closeSync(logFd);
  }
}

async function runInstall(directory: string, options: InstallOptions): Promise<void> {
  const journalPath = installJournalFile(directory);
  let journalCreated = false;
  try {
    const project = realpathSync(options.project);
    if (!lstatSync(project).isDirectory()) throw new InstallError("install_project_must_be_directory");
    const plan = createInstallPlan(options, detectInstallHostProbe(project));
    let journal;
    try {
      journal = readInstallJournal(journalPath);
      if (journal.project !== project || journal.rerank !== plan.rerank || journal.hosts.length !== plan.hosts.length || journal.hosts.some((host, index) => host !== plan.hosts[index])) {
        throw new InstallError("install_journal_plan_mismatch");
      }
      if (journal.currentPhase === "complete") journal = createInstallJournal({ project, hosts: plan.hosts, rerank: plan.rerank });
      else if (journal.attempts >= 3) throw new InstallError("install_journal_attempts_exceeded");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "install_journal_missing") throw error;
      journal = createInstallJournal({ project, hosts: plan.hosts, rerank: plan.rerank });
    }
    journal = writeInstallJournal(journalPath, journal);
    journalCreated = true;
    journal = updateInstallJournal(journalPath, current => ({
      ...current,
      attempts: current.attempts + 1,
      currentPhase: "detect",
      phases: { ...current.phases, detect: "running" },
      lastErrorCode: null,
    }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "detect", phases: { ...current.phases, detect: "completed" }, lastGoodPhase: "detect" }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "plan", phases: { ...current.phases, plan: "completed" }, lastGoodPhase: "plan" }));

    const config = loadConfig(directory, true);
    config.reranker_enabled = plan.rerank;
    saveConfig(directory, config);
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "stage", phases: { ...current.phases, stage: "completed" }, lastGoodPhase: "stage" }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "verify", phases: { ...current.phases, verify: "completed" }, lastGoodPhase: "verify" }));

    const projectEntry = config.projects.find((entry) => entry.root === project);
    const existingHosts = new Set(projectEntry === undefined
      ? []
      : config.connections.filter((entry) => entry.scope_id === projectEntry.scope_id).map((entry) => entry.host));
    const hostResults: unknown[] = [];
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "configure", phases: { ...current.phases, configure: "running" } }));
    for (const host of plan.hosts) {
      if (existingHosts.has(host)) hostResults.push({ host, state: "already_configured" });
      else hostResults.push(configureHost(directory, host, project));
    }
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "configure", phases: { ...current.phases, configure: "completed" }, lastGoodPhase: "configure" }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "start", phases: { ...current.phases, start: "running" } }));
    const service = await ensureOwnedService({
      isRunning: () => serviceIsReady(directory),
      isStarting: () => serviceIsStarting(directory),
      start: () => launchOwnedService(directory, options),
    });
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "start", phases: { ...current.phases, start: "completed" }, lastGoodPhase: "start" }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "smoke", phases: { ...current.phases, smoke: "running" } }));
    const mcp = await verifyMcpConnections(directory, project, plan.hosts);
    const { operatorCall } = await import("../src/v1/service.js");
    const backend = await operatorCall(directory, { kind: "control", operation: "status" });
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "smoke", phases: { ...current.phases, smoke: "completed" }, lastGoodPhase: "smoke" }));
    journal = updateInstallJournal(journalPath, current => ({ ...current, currentPhase: "complete", phases: { ...current.phases, complete: "completed" }, lastGoodPhase: "complete", lastErrorCode: null }));
    console.log(json({ version: 1, state: "installed", project, hosts: plan.hosts,
      detected_hosts: plan.detectedHosts, not_detected_hosts: plan.notDetectedHosts,
      rerank: plan.rerank, host_results: hostResults, mcp, service, backend,
      journal: { path: journalPath, phase: journal.currentPhase, attempts: journal.attempts } }));
  } catch (error) {
    if (journalCreated) {
      try {
        updateInstallJournal(journalPath, current => ({
          ...current,
          currentPhase: "failed",
          phases: { ...current.phases, failed: "failed" },
          lastErrorCode: operationErrorCode(error),
        }));
      } catch { /* Keep the original installation error. */ }
    }
    throw error;
  }
}

async function verifyMcpConnections(directory: string, project: string, hosts: readonly string[]): Promise<readonly unknown[]> {
  const { connectClient } = await import("../src/v1/service.js");
  const config = loadConfig(directory);
  const projectEntry = config.projects.find((entry) => entry.root === project);
  if (projectEntry === undefined) throw new InstallError("install_project_scope_missing");
  const results: unknown[] = [];
  for (const host of hosts) {
    const entry = config.connections.find(candidate => candidate.host === host && candidate.scope_id === projectEntry.scope_id);
    if (entry === undefined) throw new InstallError(`install_${host.replaceAll("-", "_")}_connection_missing`);
    const client = connectClient(directory, config, entry);
    try {
      await client.connect();
      const initialize = await client.rpc({ kind: "mcp", message: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-memory-v1-installer", version: "1" } } } });
      const initResult = mcpResult(initialize, "install_mcp_initialize_failed");
      const tools = await client.rpc({ kind: "mcp", message: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
      const toolResult = mcpResult(tools, "install_mcp_tools_failed");
      const listed = toolResult.tools;
      if (!Array.isArray(listed) || listed.length < 4) throw new InstallError("install_mcp_tools_failed");
      results.push({ host, state: "verified", protocol: initResult.protocolVersion, tools: listed.length });
    } finally { await client.close(); }
  }
  return results;
}

function mcpResult(value: unknown, errorCode: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("result" in value)) throw new InstallError(errorCode);
  const result = (value as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new InstallError(errorCode);
  return result as Record<string, any>;
}

function readOwnedOwner(directory: string): { readonly pid: number; readonly owned: boolean } | null {
  const path = join(runtimeDirectory(directory), "owner.lock");
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  assertPrivatePath(path, info, "install_owner_lock_unverified");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { throw new Error("install_owner_lock_invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("install_owner_lock_invalid");
  const record = value as { readonly installation_id?: unknown; readonly pid?: unknown };
  const config = loadConfig(directory);
  return { pid: typeof record.pid === "number" ? record.pid : -1, owned: record.installation_id === config.installation_id };
}

async function stopInstalledOwner(directory: string): Promise<void> {
  const result = await stopOwnedService({
    findOwner: async () => readOwnedOwner(directory),
    isAlive: async (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    },
    signal: (pid, signal) => { process.kill(pid, signal); },
  });
  console.log(json({ version: 1, ...result }));
}
function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing_${name.slice(2)}`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function scopeForProject(directory: string, project: string): string {
  const config = loadConfig(directory);
  const root = realpathSync(resolve(project));
  const selected = config.projects.find((entry) => entry.root === root);
  if (!selected) throw new Error("project_not_connected");
  return selected.scope_id;
}

function procedureTerms(value: string): string[] {
  const terms = value.split(",").map((term) => term.trim()).filter((term) => term.length > 0);
  if (terms.length === 0) throw new Error("procedure_terms_required");
  return terms;
}

async function mcp(directory: string, id: string): Promise<void> {
  const { connectClient } = await import("../src/v1/service.js");
  const config = loadConfig(directory), entry = config.connections.find(c => c.binding_id === id);
  if (!entry) throw new Error("mcp_connection_not_configured");
  const client = connectClient(directory, config, entry);
  await client.connect();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let bytes = 0;
  const guard = (chunk: Buffer) => { for (const byte of chunk) { bytes = byte === 10 ? 0 : bytes + 1; if (bytes > 1_000_000) { input.close(); process.stdin.destroy(new Error("mcp_frame_too_large")); break; } } };
  const pendingCancellations = new Set<Promise<void>>();
  const MAX_SERIAL_QUEUE = 32;
  const MAX_CANCELLATIONS = 8;
  let serialQueueSize = 0;
  let requestChain = Promise.resolve();
  process.stdin.on("data", guard);
  const handleLine = async (line: string): Promise<void> => {
    let message: unknown;
    try { message = JSON.parse(line) as unknown; }
    catch { process.stdout.write(json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); return; }
    try {
      const response = await client.rpc({ kind: "mcp", message });
      if (response !== null) process.stdout.write(json(response) + "\n");
    } catch {
      if (message && typeof message === "object" && !Array.isArray(message) && !("id" in message)) return;
      const rawId = message && typeof message === "object" && "id" in message ? message.id : null;
      const requestId = typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId)) ? rawId : null;
      process.stdout.write(json({ jsonrpc: "2.0", id: requestId, error: { code: -32603, message: "Memory backend unavailable" } }) + "\n");
    }
  };
  const isCancellationNotification = (line: string): boolean => {
    try {
      const message: unknown = JSON.parse(line);
      return message !== null && typeof message === "object" && !Array.isArray(message)
        && !("id" in message) && "method" in message && message.method === "notifications/cancelled";
    } catch { return false; }
  };
  const closeOnOverflow = (code: string): void => {
    input.close();
    process.stdin.destroy(new Error(code));
  };
  try {
    for await (const line of input) {
      if (isCancellationNotification(line)) {
        if (pendingCancellations.size >= MAX_CANCELLATIONS) {
          closeOnOverflow("mcp_cancellation_queue_overflow");
          break;
        }
        const task = handleLine(line);
        pendingCancellations.add(task);
        void task.then(() => pendingCancellations.delete(task), () => pendingCancellations.delete(task));
      } else {
        if (serialQueueSize >= MAX_SERIAL_QUEUE) {
          closeOnOverflow("mcp_request_queue_overflow");
          break;
        }
        serialQueueSize += 1;
        const task = requestChain.then(() => handleLine(line));
        requestChain = task.finally(() => { serialQueueSize -= 1; });
      }
    }
    await requestChain;
    await Promise.all([...pendingCancellations]);
  } finally { process.stdin.off("data", guard); input.close(); await client.close(); }
}

export async function main(input = process.argv.slice(2)): Promise<void> {
  const args = [...input], directory = resolve(takeOption(args, "--data-dir") ?? defaultDataDirectory());
  const command = args.shift();
  if (!command || command === "--help" || command === "help") {
    console.log("Agent Memory V1\n  memory install [--project PATH] [--agents auto|codex,opencode,copilot-cli] [--no-rerank]\n  memory stop\n  memory connect|disconnect codex|opencode|copilot-cli --project PATH\n  memory start [--rerank | --no-rerank]\n  memory status [--json]\n  memory pause|resume\n  memory forget CAPTURE_ID --project PATH\n  memory feedback --project PATH --query-id ID --capture-id ID --useful yes|no\n  memory procedure add|list|remove --project PATH [--capture-id ID] [--terms TERM[,TERM...]]\nInstall configures selected hosts, starts the owned broker, and verifies readiness.");
    return;
  }
  if (command === "install") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log("V1 install\n  memory install [--project PATH] [--agents auto|codex,opencode,copilot-cli]\n  --core-only | --no-rerank  Install only the V1 core\n  --yes | --non-interactive  Use detected/default choices without prompts");
      return;
    }
    await runInstall(directory, parseInstallArgs(args));
    return;
  }
  if (command === "stop") {
    if (args.length) throw new Error("stop_takes_no_arguments");
    await stopInstalledOwner(directory);
    return;
  }
  if (command === "connect" || command === "disconnect") {
    const host = z.enum(V1_HOSTS).parse(args.shift()), project = takeOption(args, "--project");
    if (!project || args.length) throw new Error("connect_requires_host_and_project");
    const { configureHost } = await import("../src/v1/connect.js");
    console.log(json(configureHost(directory, host, resolve(project), command === "disconnect")));
    return;
  }
  if (command === "mcp") {
    const id = takeOption(args, "--connection");
    if (!id || args.length) throw new Error("mcp_requires_connection");
    await mcp(directory, z.uuid().parse(id));
    return;
  }
  if (command === "start") {
    const rerank = takeFlag(args, "--rerank");
    const noRerank = takeFlag(args, "--no-rerank");
    if (rerank && noRerank) throw new Error("conflicting_rerank_flags");
    if (args.length) throw new Error("unexpected_start_arguments");
    const { startService } = await import("../src/v1/service.js");
    const service = await startService(directory, undefined, { rerank });
    console.error(json(service.status()));
    await new Promise<void>((resolveStopped, reject) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        process.off("SIGINT", stop); process.off("SIGTERM", stop);
        service.close().then(resolveStopped, reject);
      };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    });
    return;
  }
  const { operatorCall } = await import("../src/v1/service.js");
  if (command === "feedback") {
    const project = takeOption(args, "--project");
    const queryId = takeOption(args, "--query-id");
    const captureId = takeOption(args, "--capture-id");
    const useful = takeOption(args, "--useful");
    if (!project || !queryId || !captureId || !useful || args.length) throw new Error("feedback_requires_project_query_capture_label");
    const scopeId = scopeForProject(directory, project);
    const label = z.enum(["yes", "no"]).parse(useful);
    console.log(json(await operatorCall(directory, {
      kind: "control",
      operation: "feedback",
      scope_id: scopeId,
      query_id: queryId,
      capture_id: z.uuid().parse(captureId),
      useful: label === "yes",
    })));
    return;
  }
  if (command === "procedure") {
    const action = args.shift();
    const project = takeOption(args, "--project");
    if (!action || !project) throw new Error("procedure_requires_action_and_project");
    const scopeId = scopeForProject(directory, project);
    if (action === "list") {
      if (args.length) throw new Error("unexpected_procedure_arguments");
      console.log(json(await operatorCall(directory, { kind: "control", operation: "procedure_list", scope_id: scopeId })));
      return;
    }
    const captureId = takeOption(args, "--capture-id");
    if (!captureId) throw new Error("procedure_requires_capture");
    if (action === "remove") {
      if (args.length) throw new Error("unexpected_procedure_arguments");
      console.log(json(await operatorCall(directory, { kind: "control", operation: "procedure_remove", scope_id: scopeId, capture_id: z.uuid().parse(captureId) })));
      return;
    }
    if (action === "add") {
      const terms = takeOption(args, "--terms");
      if (!terms || args.length) throw new Error("procedure_add_requires_terms");
      console.log(json(await operatorCall(directory, {
        kind: "control",
        operation: "procedure_add",
        scope_id: scopeId,
        capture_id: z.uuid().parse(captureId),
        terms: procedureTerms(terms),
      })));
      return;
    }
    throw new Error("unknown_procedure_action");
  }
  if (command === "status" || command === "pause" || command === "resume") {
    if (command === "status" && args[0] === "--json") args.shift();
    if (args.length) throw new Error("unexpected_arguments");
    try { console.log(json(await operatorCall(directory, { kind: "control", operation: command }))); }
    catch (error) {
      if (command !== "status") throw error;
      const reason = error instanceof Error ? error.message : "unavailable";
      const state = reason === "v1_backend_not_running" ? "stopped" : reason === "v1_setup_required" ? "not_configured" : "unknown";
      console.log(json({ version: 1, running: false, state, reason: state === "unknown" ? "status_unverified" : reason }));
      process.exitCode = 1;
    }
    return;
  }
  if (command === "forget") {
    const captureId = z.uuid().parse(args.shift()), project = takeOption(args, "--project");
    if (!project || args.length) throw new Error("forget_requires_project");
    console.log(json(await operatorCall(directory, { kind: "control", operation: "forget", capture_id: captureId, scope_id: scopeForProject(directory, project) })));
    return;
  }
  throw new Error("unknown_command");
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  main().catch((error: unknown) => { console.error(error instanceof Error && !error.message.includes("\n") ? error.message : "memory_operation_failed"); process.exitCode = 1; });
}
