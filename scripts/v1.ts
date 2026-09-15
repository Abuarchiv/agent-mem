import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defaultDataDirectory, loadConfig, V1_HOSTS } from "../src/v1/config.js";

const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
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
    console.log("Agent Memory V1\n  memory [--data-dir PATH] connect|disconnect codex|opencode|copilot-cli --project PATH\n  memory [--data-dir PATH] start [--rerank | --no-rerank]\n  memory [--data-dir PATH] status [--json]\n  memory [--data-dir PATH] pause|resume\n  memory [--data-dir PATH] forget CAPTURE_ID --project PATH\n  memory [--data-dir PATH] feedback --project PATH --query-id ID --capture-id ID --useful yes|no\n  memory [--data-dir PATH] procedure add|list|remove --project PATH [--capture-id ID] [--terms TERM[,TERM...]]\nStart runs in the foreground; Ctrl+C stops it safely.");
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
