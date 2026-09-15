import { closeSync, openSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectionFile, ensurePrivateDirectory, loadConfig, runtimeDirectory, type V1Host } from "./config.js";
import { ensureOwnedService, type OwnedServiceEnsureResult } from "./install.js";

export interface HookRecoveryOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

async function backendState(dataDirectory: string): Promise<"ready" | "starting" | "stopped"> {
  try {
    const { operatorCall } = await import("./service.js");
    const value = await operatorCall(dataDirectory, { kind: "control", operation: "status" });
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "stopped";
    const state = value as { readonly running?: unknown; readonly state?: unknown };
    if (state.running !== true) return "stopped";
    return state.state === "starting" ? "starting" : "ready";
  } catch {
    return "stopped";
  }
}

function startOwnedBroker(dataDirectory: string, project: string): Promise<number> {
  ensurePrivateDirectory(runtimeDirectory(dataDirectory));
  const logPath = resolve(runtimeDirectory(dataDirectory), "owner.log");
  const logFd = openSync(logPath, "a", 0o600);
  const entry = fileURLToPath(new URL("../../scripts/v1.js", import.meta.url));
  try {
    const child = spawn(process.execPath, [entry, "--data-dir", dataDirectory, "start"], {
      cwd: project,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
      stdio: ["ignore", logFd, logFd],
      detached: true,
      windowsHide: true,
    });
    const pid = child.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("recovery_broker_pid_invalid");
    child.unref();
    return Promise.resolve(pid);
  } finally {
    closeSync(logFd);
  }
}

/** Recover only the owner referenced by a generated host connection file. */
export async function ensureOwnedBrokerForConnection(
  configPath: string,
  project: string,
  host: V1Host,
  options: HookRecoveryOptions = {},
): Promise<OwnedServiceEnsureResult> {
  if (typeof configPath !== "string" || typeof project !== "string" || !isAbsolute(configPath) || !isAbsolute(project)) {
    throw new Error("recovery_config_path_invalid");
  }
  const absoluteConfig = resolve(configPath);
  if (basename(dirname(absoluteConfig)) !== "connections") throw new Error("recovery_config_path_invalid");
  const dataDirectory = resolve(dirname(dirname(absoluteConfig)));
  const config = loadConfig(dataDirectory);
  const entry = config.connections.find(candidate => connectionFile(dataDirectory, candidate.binding_id) === absoluteConfig && candidate.host === host);
  if (entry === undefined) throw new Error("recovery_connection_not_configured");
  let canonicalProject: string;
  try { canonicalProject = realpathSync(project); } catch { throw new Error("recovery_project_not_configured"); }
  const route = config.projects.find(candidate => candidate.scope_id === entry.scope_id && candidate.root === canonicalProject);
  if (route === undefined) throw new Error("recovery_project_not_configured");
  const timeoutMs = options.timeoutMs ?? 2_500;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("recovery_options_invalid");
  return ensureOwnedService({
    isRunning: async () => (await backendState(dataDirectory)) === "ready",
    isStarting: async () => (await backendState(dataDirectory)) === "starting",
    start: () => startOwnedBroker(dataDirectory, route.root),
  }, { timeoutMs, pollMs });
}
