import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderCopilotCliHookFile } from "../../adapters/copilot-cli/index.js";
import { MEMORY_MCP_LEGACY_SERVER_KEYS, MEMORY_MCP_SERVER_KEY } from "../host/tool-schemas.js";
import { addConnection, bindingFor, connectionFile, ensurePrivateDirectory, loadConfig, runtimeDirectory, saveConfig, socketPath, writePrivateJson, type V1Config, type V1Connection, type V1Host } from "./config.js";
import { acquireOwnerLock } from "./lock.js";

const name = MEMORY_MCP_SERVER_KEY;
const legacyNames = MEMORY_MCP_LEGACY_SERVER_KEYS;
const allNames = [name, ...legacyNames] as const;
const hookEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact", "PostCompact"];
const shellQuote = (value: string): string => process.platform === "win32"
  ? `"${value.replaceAll('"', '\\"')}"`
  : `'${value.replaceAll("'", "'\\''")}'`;
const entryScript = () => fileURLToPath(new URL("../../scripts/v1.js", import.meta.url));
const adapterScript = (path: string) => fileURLToPath(new URL(`../../adapters/${path}`, import.meta.url));

function readText(path: string): string {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error("host_config_file_invalid");
  return readFileSync(path, "utf8");
}

function assertCodexDirectory(root: string): void {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(join(root, ".codex")); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("codex_config_directory_must_not_be_symlink");
}

function objectJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new Error("host_config_invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("host_config_object_required");
  return value as Record<string, unknown>;
}

function stripJsoncComments(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    const next = text[index + 1];
    if (lineComment) {
      if (current === "\n" || current === "\r") { lineComment = false; output += current; }
      else output += " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") { blockComment = false; output += "  "; index += 1; }
      else output += current === "\n" || current === "\r" ? current : " ";
      continue;
    }
    if (!quote && current === "/" && next === "/") { lineComment = true; output += "  "; index += 1; continue; }
    if (!quote && current === "/" && next === "*") { blockComment = true; output += "  "; index += 1; continue; }
    output += current;
    if (current === "\\" && quote) { escaped = !escaped; continue; }
    if (current === '"' && !escaped) quote = !quote;
    escaped = false;
  }
  return output;
}

function stripJsoncTrailingCommas(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    if (!quote && current === ",") {
      let next = index + 1;
      while (next < text.length && /\s/u.test(text[next]!)) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output += current;
    if (current === "\\" && quote) { escaped = !escaped; continue; }
    if (current === '"' && !escaped) quote = !quote;
    escaped = false;
  }
  return output;
}

function objectJsonc(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(text))) as unknown; }
  catch { throw new Error("host_config_invalid_jsonc"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("host_config_object_required");
  return value as Record<string, unknown>;
}

function writeHostFile(path: string, before: string, after: string): void {
  if (before === after) return;
  if (readText(path) !== before) throw new Error("host_config_changed_concurrently");
  if (after === "") {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
  writeFileSync(temporary, after, { mode, flag: "wx" });
  renameSync(temporary, path);
}

function backupHostFile(directory: string, path: string, content: string): void {
  if (content.length === 0) return;
  writePrivateJson(join(resolve(directory), "backups", `${randomUUID()}.json`), {
    version: 1,
    original_path: path,
    content,
  });
}

function assertDirectoryPath(path: string, code: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
}

function assertCopilotParents(root: string, hooks: boolean): void {
  const github = join(root, ".github");
  assertDirectoryPath(github, "copilot_github_directory_invalid");
  if (hooks) assertDirectoryPath(join(github, "hooks"), "copilot_hooks_directory_invalid");
}

function copilotConfigPaths(root: string): string[] {
  return [join(root, ".mcp.json"), join(root, ".github", "mcp.json")];
}

function copilotMcpServers(value: Record<string, unknown>): { readonly servers: Record<string, unknown>; readonly wrapped: boolean } {
  if (Object.hasOwn(value, "mcpServers")) {
    const servers = value.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("copilot_mcp_servers_invalid");
    return { servers: servers as Record<string, unknown>, wrapped: true };
  }
  if (Object.keys(value).length === 0) return { servers: {}, wrapped: true };
  return { servers: value, wrapped: false };
}

function isOwnedCopilotMcpEntry(value: unknown, entry: V1Connection): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = (value as Record<string, unknown>).command;
  const args = (value as Record<string, unknown>).args;
  return typeof command === "string" && isAbsolute(command) && Array.isArray(args)
    && args.includes("mcp") && args.includes("--connection") && args.includes(entry.binding_id);
}

function copilotMcpEntries(servers: Record<string, unknown>, entry: V1Connection): readonly { readonly name: string; readonly owned: boolean }[] {
  return allNames.flatMap(serverName => {
    const value = servers[serverName];
    return value === undefined ? [] : [{ name: serverName, owned: isOwnedCopilotMcpEntry(value, entry) }];
  });
}

function copilotMcpPath(root: string, entry: V1Connection, remove: boolean): string {
  const paths = copilotConfigPaths(root);
  const findings = paths.flatMap((path) => {
    if (!existsSync(path)) return [];
    const value = objectJson(readText(path));
    return copilotMcpEntries(copilotMcpServers(value).servers, entry).map(finding => ({ path, owned: finding.owned }));
  });
  const owned = findings.filter((finding) => finding.owned);
  const foreign = findings.filter((finding) => !finding.owned);
  if (owned.length > 1 || (owned.length > 0 && foreign.length > 0) || foreign.length > 1) throw new Error("copilot_mcp_entry_ambiguous");
  if (owned.length === 1) return owned[0]!.path;
  if (foreign.length === 1) return foreign[0]!.path;
  if (remove) return paths.find((path) => existsSync(path)) ?? paths[0]!;
  return paths.find((path) => existsSync(path)) ?? paths[0]!;
}

function copilotMcpChanges(root: string, directory: string, entry: V1Connection, remove: boolean) {
  const path = copilotMcpPath(root, entry, remove);
  assertCopilotParents(root, path === join(root, ".github", "mcp.json"));
  const before = readText(path);
  const value = objectJson(before);
  const shape = copilotMcpServers(value);
  if (copilotMcpEntries(shape.servers, entry).some(finding => !finding.owned)) throw new Error("copilot_mcp_entry_owned_elsewhere");
  for (const serverName of allNames) delete shape.servers[serverName];
  if (!remove) shape.servers[name] = {
    type: "local",
    command: process.execPath,
    args: mcpArguments(directory, entry),
  };
  if (shape.wrapped) value.mcpServers = shape.servers;
  const after = JSON.stringify(value, null, 2) + "\n";
  return { path, before, after };
}

function copilotHookChanges(root: string, directory: string, entry: V1Connection, remove: boolean) {
  assertCopilotParents(root, true);
  const canonicalPath = join(root, ".github", "hooks", "agent-mem.json");
  const legacyPath = join(root, ".github", "hooks", "agent-memory-v1.json");
  const before = readText(canonicalPath);
  const legacyBefore = readText(legacyPath);
  const expected = renderCopilotCliHookFile({
    nodePath: process.execPath,
    helperPath: adapterScript("copilot-cli/index.js"),
    configPath: connectionFile(directory, entry.binding_id),
  }) + "\n";
  if ((before.trim() && before !== expected) || (legacyBefore.trim() && legacyBefore !== expected)) throw new Error("copilot_hook_file_owned_elsewhere");
  if (remove) return [
    { path: canonicalPath, before, after: "" },
    { path: legacyPath, before: legacyBefore, after: "" },
  ];
  return legacyBefore.trim()
    ? [{ path: legacyPath, before: legacyBefore, after: "" }, { path: canonicalPath, before, after: expected }]
    : [{ path: canonicalPath, before, after: expected }];
}

function copilotChanges(root: string, directory: string, entry: V1Connection, remove: boolean) {
  return [copilotMcpChanges(root, directory, entry, remove), ...copilotHookChanges(root, directory, entry, remove)];
}

function hookCommand(dataDir: string, entry: V1Connection): string {
  return `${shellQuote(process.execPath)} ${shellQuote(adapterScript("codex/index.js"))} --config ${shellQuote(connectionFile(dataDir, entry.binding_id))}`;
}

function mcpArguments(dataDir: string, entry: V1Connection): string[] {
  return [entryScript(), "--data-dir", resolve(dataDir), "mcp", "--connection", entry.binding_id];
}

function codexChanges(root: string, directory: string, entry: V1Connection, remove: boolean) {
  assertCodexDirectory(root);
  const tomlPath = join(root, ".codex", "config.toml"), hooksPath = join(root, ".codex", "hooks.json");
  const tomlBefore = readText(tomlPath), hooksBefore = readText(hooksPath);
  const start = `# BEGIN agent-mem ${entry.binding_id}`;
  const end = `# END agent-mem ${entry.binding_id}`;
  const block = `${start}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(mcpArguments(directory, entry))}\nstartup_timeout_sec = 20\ntool_timeout_sec = 20\n${end}\n`;
  let tomlAfter = tomlBefore;
  let found = false;
  for (const marker of ["agent-mem", "agent-memory-v1"]) {
    const markerStart = `# BEGIN ${marker} ${entry.binding_id}`;
    const markerEnd = `# END ${marker} ${entry.binding_id}`;
    const pattern = new RegExp(`${markerStart}\\r?\\n[\\s\\S]*?${markerEnd}\\r?\\n?`);
    if (pattern.test(tomlAfter)) {
      found = true;
      tomlAfter = tomlAfter.replace(pattern, remove ? "" : block);
    }
  }
  if (!found && (tomlBefore.includes(`[mcp_servers.${name}]`) || tomlBefore.includes("[mcp_servers.agent_memory_v1]"))) throw new Error("codex_mcp_entry_owned_elsewhere");
  if (!found && !remove) tomlAfter = `${tomlBefore}${tomlBefore && !tomlBefore.endsWith("\n") ? "\n" : ""}${block}`;
  const hooks = objectJson(hooksBefore);
  const current = hooks.hooks === undefined ? {} : hooks.hooks;
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("codex_hooks_invalid");
  const groups = current as Record<string, unknown>;
  const command = hookCommand(directory, entry);
  for (const event of hookEvents) {
    const items = groups[event] ?? [];
    if (!Array.isArray(items)) throw new Error("codex_hook_group_invalid");
    const retained: unknown[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || !Array.isArray(item.hooks)) { retained.push(item); continue; }
      const ownConfigSuffix = ` --config ${shellQuote(connectionFile(directory, entry.binding_id))}`;
      const remaining = item.hooks.filter((hook: unknown) => !hook || typeof hook !== "object" || !("command" in hook) || typeof hook.command !== "string" || !hook.command.trimEnd().endsWith(ownConfigSuffix));
      if (remaining.length) retained.push({ ...item, hooks: remaining });
    }
    if (!remove) retained.push({ hooks: [{ type: "command", command, timeout: 15, statusMessage: "Agent Mem" }] });
    if (retained.length) groups[event] = retained; else delete groups[event];
  }
  hooks.hooks = groups;
  return [{ path: tomlPath, before: tomlBefore, after: tomlAfter }, { path: hooksPath, before: hooksBefore, after: JSON.stringify(hooks, null, 2) + "\n" }];
}

function openCodeChanges(root: string, directory: string, entry: V1Connection, remove: boolean) {
  const path = existsSync(join(root, "opencode.json")) ? join(root, "opencode.json") : join(root, "opencode.jsonc");
  const before = readText(path), value = path.endsWith(".jsonc") ? objectJsonc(before) : objectJson(before);
  const mcp = value.mcp === undefined ? {} : value.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("opencode_mcp_invalid");
  const servers = mcp as Record<string, unknown>;
  const existing = allNames.flatMap(serverName => {
    const value = servers[serverName];
    return value === undefined ? [] : [{ value, owned: typeof value === "object" && value !== null && !Array.isArray(value) && "command" in value && Array.isArray(value.command) && value.command.includes(entry.binding_id) }];
  });
  if (existing.some(candidate => !candidate.owned)) throw new Error("opencode_mcp_entry_owned_elsewhere");
  for (const serverName of allNames) delete servers[serverName];
  if (!remove) servers[name] = { type: "local", command: [process.execPath, ...mcpArguments(directory, entry)], enabled: true, timeout: 15_000 };
  value.mcp = servers;
  const plugins = value.plugin ?? [];
  if (!Array.isArray(plugins)) throw new Error("opencode_plugins_invalid");
  const configPath = connectionFile(directory, entry.binding_id);
  const retained = plugins.filter(plugin => !Array.isArray(plugin) || !plugin[1] || typeof plugin[1] !== "object" || plugin[1].config_path !== configPath);
  if (!remove) retained.push([pathToFileURL(adapterScript("opencode/plugin.js")).href, {
    version: 1, native_version: "1.18.30", node_path: process.execPath,
    bridge_path: adapterScript("opencode/bridge.js"), config_path: configPath,
    hook_timeout_ms: 10_000, request_timeout_ms: 5_000,
  }]);
  value.plugin = retained;
  return [{ path, before, after: JSON.stringify(value, null, 2) + "\n" }];
}

function adapterConfig(config: V1Config, entry: V1Connection, directory: string) {
  const project = config.projects.find(p => p.scope_id === entry.scope_id)!;
  const surface = entry.host === "codex" ? "codex_cli" : entry.host === "opencode" ? "opencode_cli" : "copilot_cli";
  return {
    version: 1, ...(entry.host === "opencode" ? { native_version: "1.18.30" } : {}), ...(entry.host === "copilot-cli" ? { cli_version: "1.0.83" } : {}),
    socket_path: socketPath(directory), surface,
    binding: bindingFor(config, entry), broker_secret_hex: entry.secret_hex,
    projects: [{ scope_id: project.scope_id, workspace_roots: [project.root] }],
    session_start_query: "recent project work", request_timeout_ms: 5_000,
    ...(entry.host === "codex" ? { hook_timeout_ms: 10_000 } : entry.host === "copilot-cli" ? { hook_timeout_ms: 4_000 } : {}),
  };
}

export function configureHost(directory: string, host: V1Host, projectPath: string, remove = false) {
  ensurePrivateDirectory(resolve(directory));
  ensurePrivateDirectory(runtimeDirectory(directory));
  const release = acquireOwnerLock(runtimeDirectory(directory), "agent-mem-config", "config.lock");
  try { return configureHostLocked(directory, host, projectPath, remove); }
  finally { release(); }
}

function configureHostLocked(directory: string, host: V1Host, projectPath: string, remove: boolean) {
  const backendActive = existsSync(socketPath(directory)) || existsSync(join(runtimeDirectory(directory), "owner.lock"));
  const config = loadConfig(directory, !remove);
  const configBefore = structuredClone(config);
  const entry = remove
    ? config.connections.find(c => c.host === host && config.projects.some(p => p.scope_id === c.scope_id && p.root === realpathSync(resolve(projectPath))))
    : addConnection(config, host, projectPath);
  if (!entry) return { changed: false, host, state: "not_configured" };
  const project = config.projects.find(p => p.scope_id === entry.scope_id)!;
  const changes = host === "codex" ? codexChanges(project.root, directory, entry, remove) : host === "opencode" ? openCodeChanges(project.root, directory, entry, remove) : copilotChanges(project.root, directory, entry, remove);
  if (backendActive && changes.some(change => change.before !== change.after)) throw new Error("stop_backend_before_changing_connections");
  const written: typeof changes = [];
  try {
    if (!remove) {
      ensurePrivateDirectory(join(resolve(directory), "connections"));
      writePrivateJson(connectionFile(directory, entry.binding_id), adapterConfig(config, entry, directory));
      // Save the stable identity first so a repeated connect can complete partial setup.
      saveConfig(directory, config);
    }
    for (const change of changes) {
      if (host === "codex") assertCodexDirectory(project.root);
      if (change.before !== change.after) backupHostFile(directory, change.path, change.before);
      writeHostFile(change.path, change.before, change.after);
      written.push(change);
    }
    if (remove) {
      config.connections = config.connections.filter(c => c.binding_id !== entry.binding_id);
      saveConfig(directory, config);
      const ownConfig = connectionFile(directory, entry.binding_id);
      if (existsSync(ownConfig)) unlinkSync(ownConfig);
    }
    return { changed: changes.some(c => c.before !== c.after), host, project: project.root, scope_id: project.scope_id, state: remove ? "disconnected" : "configured", ...(host === "codex" && !remove ? { next: "Review and trust the project hooks with /hooks in Codex before native capture can run." } : {}), ...(host === "copilot-cli" && !remove ? { next: "Open the project in GitHub Copilot app or run Copilot CLI locally; confirm the project MCP server and hooks are trusted." } : {}) };
  } catch (error) {
    for (const change of written.toReversed()) {
      try { writeHostFile(change.path, change.after, change.before); } catch { /* Preserve a concurrent host edit. */ }
    }
    try {
      saveConfig(directory, configBefore);
      if (!remove) {
        const ownConfig = connectionFile(directory, entry.binding_id);
        if (existsSync(ownConfig)) unlinkSync(ownConfig);
      } else if (configBefore.connections.some(candidate => candidate.binding_id === entry.binding_id)) {
        ensurePrivateDirectory(join(resolve(directory), "connections"));
        writePrivateJson(connectionFile(directory, entry.binding_id), adapterConfig(configBefore, entry, directory));
      }
    } catch { /* The original error is more actionable than a best-effort rollback failure. */ }
    throw error;
  }
}
