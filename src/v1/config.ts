import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createTrustedBinding, type TrustedBinding } from "../host/contract.js";
import { ipcEndpointPath } from "../host/ipc-path.js";
import { assertPrivatePath, ensurePrivateDirectory } from "./private-files.js";
export { ensurePrivateDirectory } from "./private-files.js";

export const V1_HOSTS = ["codex", "opencode", "copilot-cli"] as const;
export type V1Host = typeof V1_HOSTS[number];
const credential = z.object({ binding_id: z.uuid(), secret_hex: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const project = z.object({ scope_id: z.uuid(), root: z.string().min(1).max(4096), created_at: z.iso.datetime({ offset: true }) }).strict();
const connection = credential.extend({ host: z.enum(V1_HOSTS), scope_id: z.uuid() }).strict();
const schema = z.object({
  version: z.literal(1), installation_id: z.uuid(), created_at: z.iso.datetime({ offset: true }),
  vault_initialized: z.boolean(), operator: credential,
  reranker_enabled: z.boolean().optional(),
  projects: z.array(project).max(32), connections: z.array(connection).max(64),
}).strict();
export type V1Config = z.infer<typeof schema>;
export type V1Connection = V1Config["connections"][number];
export const defaultDataDirectory = (): string => {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local"), "Agent Memory V1");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Agent Memory V1");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "Agent Memory V1");
};
export const configFile = (directory: string) => join(resolve(directory), "config.json");
export const installJournalFile = (directory: string) => join(resolve(directory), "install.json");
export const runtimeDirectory = (directory: string) => join(resolve(directory), "ipc");
export const socketPath = (directory: string): string => ipcEndpointPath(runtimeDirectory(directory));
export const vaultPath = (directory: string) => join(resolve(directory), "vault.sqlite");
export const connectionFile = (directory: string, id: string) => join(resolve(directory), "connections", `${z.uuid().parse(id)}.json`);

function newCredential() { return { binding_id: randomUUID(), secret_hex: randomBytes(32).toString("hex") }; }

export function writePrivateJson(path: string, value: unknown): void {
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("config_file_must_be_owned_and_private");
    assertPrivatePath(path, info, "config_file_must_be_owned_and_private");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      assertPrivatePath(temporary, fstatSync(fd), "config_file_must_be_owned_and_private");
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function validateConfig(value: unknown): V1Config {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("v1_config_invalid");
  const config = parsed.data;
  const scopes = new Set(config.projects.map(p => p.scope_id));
  const roots = new Set(config.projects.map(p => p.root));
  const ids = new Set([config.operator.binding_id, ...config.connections.map(c => c.binding_id)]);
  const pairs = new Set(config.connections.map(c => `${c.host}:${c.scope_id}`));
  if (scopes.size !== config.projects.length || roots.size !== config.projects.length || ids.size !== config.connections.length + 1 || pairs.size !== config.connections.length || config.projects.some(p => p.root !== resolve(p.root)) || config.connections.some(c => !scopes.has(c.scope_id))) throw new Error("v1_config_inconsistent");
  return config;
}

export function loadConfig(directory: string, create = false): V1Config {
  const root = resolve(directory), path = configFile(root);
  if (!existsSync(root) && !create) throw new Error("v1_setup_required");
  ensurePrivateDirectory(root);
  if (!existsSync(path)) {
    if (!create) throw new Error("v1_setup_required");
    const config: V1Config = { version: 1, installation_id: randomUUID(), created_at: new Date().toISOString(), vault_initialized: false, operator: newCredential(), projects: [], connections: [] };
    writePrivateJson(path, config);
    return config;
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("config_file_must_be_owned_and_private");
    assertPrivatePath(path, info, "config_file_must_be_owned_and_private");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")) as unknown; }
    catch { throw new Error("v1_config_invalid"); }
    return validateConfig(parsed);
  } finally { closeSync(fd); }
}

export function saveConfig(directory: string, config: V1Config): void {
  ensurePrivateDirectory(resolve(directory));
  writePrivateJson(configFile(directory), validateConfig(config));
}

export function addConnection(config: V1Config, host: V1Host, projectPath: string): V1Connection {
  const root = realpathSync(resolve(projectPath));
  if (!lstatSync(root).isDirectory()) throw new Error("project_must_be_directory");
  let selected = config.projects.find(p => p.root === root);
  if (!selected) {
    selected = { scope_id: randomUUID(), root, created_at: new Date().toISOString() };
    config.projects.push(selected);
  }
  let entry = config.connections.find(c => c.host === host && c.scope_id === selected.scope_id);
  if (!entry) { entry = { ...newCredential(), host, scope_id: selected.scope_id }; config.connections.push(entry); }
  validateConfig(config);
  return entry;
}

export function bindingFor(config: V1Config, entry?: V1Connection): TrustedBinding {
  const host = entry?.host ?? "codex";
  const hostKind = host === "copilot-cli" ? "copilot" : host;
  const surface = host === "codex" ? "codex_cli" : host === "opencode" ? "opencode_cli" : "copilot_cli";
  return createTrustedBinding({
    version: 1, binding_id: entry?.binding_id ?? config.operator.binding_id,
    host_kind: hostKind, surface, execution_domain: { kind: "local", id: config.installation_id },
    host_instance_id: entry?.binding_id ?? "v1-operator", host_session_id: "installation",
    allowed_scope_ids: entry ? [entry.scope_id] : config.projects.map(p => p.scope_id),
    egress: { reader_targets: [`reader:${surface}`], provider_targets: [] },
  });
}
