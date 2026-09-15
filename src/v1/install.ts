import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { V1_HOSTS, type V1Host } from "./config.js";

export const INSTALLABLE_HOSTS = V1_HOSTS;
export type InstallHostSelection = "auto" | readonly V1Host[];

export interface InstallOptions {
  readonly project: string;
  readonly hosts: InstallHostSelection;
  readonly rerank: boolean;
  readonly nonInteractive: boolean;
}

export type InstallHostProbe = Record<V1Host, boolean>;

export interface InstallPlan {
  readonly project: string;
  readonly hosts: readonly V1Host[];
  readonly detectedHosts: readonly V1Host[];
  readonly notDetectedHosts: readonly V1Host[];
  readonly rerank: boolean;
  readonly nonInteractive: boolean;
}

export class InstallError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "InstallError";
    this.code = code;
  }
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new InstallError(`install_${name.slice(2)}_required`);
  return value;
}

function parseHosts(value: string): readonly V1Host[] | "auto" {
  if (value === "auto") return "auto";
  const names = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) throw new InstallError("install_hosts_required");
  const seen = new Set<string>();
  for (const name of names) {
    if (!(INSTALLABLE_HOSTS as readonly string[]).includes(name)) throw new InstallError("install_host_invalid");
    if (seen.has(name)) throw new InstallError("install_host_duplicate");
    seen.add(name);
  }
  return names as V1Host[];
}

/** Parse install arguments without touching user files. */
export function parseInstallArgs(args: readonly string[], cwd = process.cwd()): InstallOptions {
  const project = optionValue(args, "--project");
  const agents = optionValue(args, "--agents");
  const hosts = optionValue(args, "--hosts");
  if (agents !== undefined && hosts !== undefined) throw new InstallError("install_host_option_conflict");
  const coreOnly = args.includes("--core-only");
  const noRerank = args.includes("--no-rerank");
  const rerank = args.includes("--rerank");
  if ((coreOnly && (noRerank || rerank)) || (noRerank && rerank)) throw new InstallError("install_feature_conflict");
  const known = new Set(["--project", "--agents", "--hosts", "--core-only", "--no-rerank", "--rerank", "--yes", "--non-interactive"]);
  const consumed = new Set<number>();
  for (const name of ["--project", "--agents", "--hosts"]) {
    const index = args.indexOf(name);
    if (index >= 0) { consumed.add(index); consumed.add(index + 1); }
  }
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index) || known.has(args[index]!)) continue;
    throw new InstallError("install_argument_unexpected");
  }
  const selected = agents ?? hosts;
  return {
    project: resolve(cwd, project ?? cwd),
    hosts: selected === undefined ? "auto" : parseHosts(selected),
    rerank: !(coreOnly || noRerank),
    nonInteractive: args.includes("--yes") || args.includes("--non-interactive"),
  };
}

export function detectInstallHosts(selection: InstallHostSelection, probe: InstallHostProbe): readonly V1Host[] {
  if (selection !== "auto") return [...selection];
  const detected = INSTALLABLE_HOSTS.filter((host) => probe[host]);
  if (detected.length === 0) throw new InstallError("install_no_host_detected");
  return detected;
}

export function createInstallPlan(options: InstallOptions, probe: InstallHostProbe): InstallPlan {
  const hosts = detectInstallHosts(options.hosts, probe);
  return {
    project: options.project,
    hosts,
    detectedHosts: hosts.filter((host) => probe[host]),
    notDetectedHosts: hosts.filter((host) => !probe[host]),
    rerank: options.rerank,
    nonInteractive: options.nonInteractive,
  };
}

export function detectInstallHostProbe(project: string): InstallHostProbe {
  const commandExists = (command: string): boolean => {
    try {
      execFileSync(platform() === "win32" ? "where" : "which", [command], { stdio: "ignore", timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  };
  const home = homedir();
  return {
    codex: existsSync(join(project, ".codex")) || existsSync(join(home, ".codex")) || commandExists("codex"),
    opencode: existsSync(join(project, "opencode.json")) || existsSync(join(project, "opencode.jsonc")) || commandExists("opencode"),
    "copilot-cli": existsSync(join(project, ".github")) || commandExists("copilot"),
  };
}

export interface OwnedServiceLauncher {
  readonly isRunning: () => Promise<boolean>;
  readonly isStarting?: () => Promise<boolean>;
  readonly start: () => Promise<number>;
}

export interface OwnedServiceEnsureOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export type OwnedServiceEnsureResult =
  | { readonly state: "already_running" }
  | { readonly state: "started"; readonly pid: number };

export async function ensureOwnedService(
  launcher: OwnedServiceLauncher,
  options: OwnedServiceEnsureOptions = {},
): Promise<OwnedServiceEnsureResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new InstallError("install_recovery_options_invalid");
  const alreadyStarting = launcher.isStarting === undefined ? false : await launcher.isStarting();
  let pid: number | undefined;
  if (!await launcher.isRunning() && !alreadyStarting) {
    pid = await launcher.start();
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new InstallError("install_broker_pid_invalid");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await launcher.isRunning()) return pid === undefined ? { state: "already_running" } : { state: "started", pid };
    await new Promise<void>((done) => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  throw new InstallError("install_broker_not_ready");
}

export interface OwnedServiceProcess {
  readonly pid: number;
  readonly owned: boolean;
}

export interface OwnedServiceController {
  readonly findOwner: () => Promise<OwnedServiceProcess | null>;
  readonly isAlive: (pid: number) => Promise<boolean>;
  readonly signal: (pid: number, signal: NodeJS.Signals) => void | Promise<void>;
}

export interface OwnedServiceStopOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

export async function stopOwnedService(
  controller: OwnedServiceController,
  options: OwnedServiceStopOptions = {},
): Promise<{ readonly state: "not_running" } | { readonly state: "stopped"; readonly pid: number }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new InstallError("install_recovery_options_invalid");
  const owner = await controller.findOwner();
  if (owner === null) return { state: "not_running" };
  if (!owner.owned || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new InstallError("install_owner_not_owned");
  if (!await controller.isAlive(owner.pid)) return { state: "stopped", pid: owner.pid };
  await controller.signal(owner.pid, "SIGTERM");
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!await controller.isAlive(owner.pid)) return true;
      await new Promise<void>((done) => setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
    return false;
  };
  if (await waitForExit()) return { state: "stopped", pid: owner.pid };
  const current = await controller.findOwner();
  if (current === null || !current.owned || current.pid !== owner.pid) throw new InstallError("install_owner_ownership_lost");
  await controller.signal(owner.pid, "SIGKILL");
  if (!await waitForExit()) throw new InstallError("install_owner_stop_timeout");
  return { state: "stopped", pid: owner.pid };
}
