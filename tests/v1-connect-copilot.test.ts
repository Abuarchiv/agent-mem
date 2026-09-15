import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configureHost } from "../src/v1/connect.js";
import { loadConfig } from "../src/v1/config.js";

test("connects Copilot CLI/app through project MCP and owned hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-v1-copilot-connect-"));
  const dataDirectory = join(root, "data");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  try {
    const connected = configureHost(dataDirectory, "copilot-cli", project);
    assert.equal(connected.host, "copilot-cli");
    assert.equal(connected.state, "configured");

    const config = loadConfig(dataDirectory);
    const entry = config.connections.find((candidate) => candidate.host === "copilot-cli");
    assert.ok(entry);

    const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { type: string; command: string; args: string[] }> };
    const server = mcp.mcpServers.agent_memory_v1;
    assert.ok(server);
    assert.equal(server.type, "local");
    assert.equal(server.command, process.execPath);
    assert.ok(server.args.includes(entry.binding_id));

    const hookPath = join(project, ".github", "hooks", "agent-memory-v1.json");
    const hooks = JSON.parse(readFileSync(hookPath, "utf8")) as { version: number; hooks: Record<string, readonly [{ bash: string; powershell: string; timeoutSec: number }]> };
    assert.equal(hooks.version, 1);
    assert.ok(hooks.hooks.sessionStart);
    assert.ok(hooks.hooks.userPromptSubmitted);
    assert.match(hooks.hooks.sessionStart[0]!.bash, /copilot-cli\/index\.js/);
    assert.match(hooks.hooks.userPromptSubmitted[0]!.powershell, /--event 'userPromptSubmitted'/);

    const repeated = configureHost(dataDirectory, "copilot-cli", project);
    assert.equal(repeated.changed, false);

    const disconnected = configureHost(dataDirectory, "copilot-cli", project, true);
    assert.equal(disconnected.state, "disconnected");
    assert.equal(existsSync(hookPath), false);
    const after = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> };
    assert.equal(after.mcpServers.agent_memory_v1, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not overwrite foreign Copilot MCP or hook configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-v1-copilot-foreign-"));
  const dataDirectory = join(root, "data");
  const project = join(root, "project");
  const hooksDirectory = join(project, ".github", "hooks");
  mkdirSync(hooksDirectory, { recursive: true, mode: 0o700 });
  const mcpPath = join(project, ".mcp.json");
  const foreignMcp = { mcpServers: { other: { type: "local", command: "other-tool", args: [] } } };
  const foreignHooks = { version: 1, hooks: { sessionStart: [] } };
  try {
    writeJson(mcpPath, foreignMcp);
    writeJson(join(hooksDirectory, "agent-memory-v1.json"), foreignHooks);
    assert.throws(() => configureHost(dataDirectory, "copilot-cli", project), /copilot_hook_file_owned_elsewhere/);
    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")), foreignMcp);
    assert.deepEqual(JSON.parse(readFileSync(join(hooksDirectory, "agent-memory-v1.json"), "utf8")), foreignHooks);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects precedence conflicts and accepts a package-path rotation for its own MCP entry", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-memory-v1-copilot-mcp-"));
  const dataDirectory = join(root, "data");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  try {
    configureHost(dataDirectory, "copilot-cli", project);
    const mcpPath = join(project, ".mcp.json");
    const own = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    rmSync(mcpPath);
    mkdirSync(join(project, ".github"), { recursive: true, mode: 0o700 });
    writeJson(join(project, ".github", "mcp.json"), own);
    writeJson(mcpPath, { mcpServers: { agent_memory_v1: { type: "local", command: "foreign", args: [] } } });
    assert.throws(() => configureHost(dataDirectory, "copilot-cli", project), /copilot_mcp_entry_ambiguous/);

    rmSync(mcpPath);
    const projectMcp = JSON.parse(readFileSync(join(project, ".github", "mcp.json"), "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    projectMcp.mcpServers.agent_memory_v1!.command = "/opt/previous-agent-memory/node";
    writeJson(join(project, ".github", "mcp.json"), projectMcp);
    const rotated = configureHost(dataDirectory, "copilot-cli", project);
    assert.equal(rotated.changed, true);
    const refreshed = JSON.parse(readFileSync(join(project, ".github", "mcp.json"), "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
    assert.equal(refreshed.mcpServers.agent_memory_v1!.command, process.execPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
