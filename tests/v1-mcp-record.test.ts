import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareEvidencePacket } from "../src/context/source-only.js";
import { capture } from "../src/core/capture.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { purgeSource } from "../src/core/purge-source.js";
import { createTrustedBinding, parseEvidencePacket, type EvidencePacket } from "../src/host/contract.js";
import { createMemoryMcpServer, type MemoryMcpServer } from "../src/host/mcp.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mcp-record-egress-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: false });
  const scopeId = randomUUID();
  const binding = createTrustedBinding({ version: 1, binding_id: randomUUID(), host_kind: "codex", surface: "codex_cli",
    execution_domain: { kind: "local", id: "mcp-record-test" }, host_instance_id: "host", host_session_id: "session",
    allowed_scope_ids: [scopeId], egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] } });
  const policyBinding = createPolicySetupBinding({ version: 1, setup_id: randomUUID(), allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:codex_cli"] });
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "mcp-record-test", created_at: "2026-09-15T08:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-15T08:00:00Z");
  function grants(source_classes: ("prompt" | "assistant_output")[]) {
    setScopeOutputGrants(database, policyBinding, scopeId, [{ target: "reader:codex_cli", source_classes }], "2026-09-15T08:00:01Z");
  }
  grants(["prompt", "assistant_output"]);
  const sourceIds = ["first original evidence", "second original evidence"].map(text => {
    const captureId = randomUUID();
    capture({ version: 1, capture_id: captureId, scope_id: scopeId,
      origin: { host_kind: binding.host_kind, surface: binding.surface, execution_domain: binding.execution_domain,
        host_instance_id: binding.host_instance_id, host_session_id: binding.host_session_id },
      adapter_version: "0.1.0", event: { stage: "prompt_submitted", role: "user", evidence_class: "prompt",
        native_ids: { session_id: "native", turn_id: captureId }, text }, payload: { text },
      captured_at: "2026-09-15T08:01:00Z", occurred_at: "2026-09-15T08:01:00Z", truncation: { truncated: false },
      redaction: { applied: true, policy_version: "1.0.0" } }, binding, database, { source_spans: [{
        span_id: randomUUID(), root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length,
        digest: createHash("sha256").update(text).digest("hex"),
      }] });
    return captureId;
  });
  const input = { scope_id: scopeId, kind: "handoff" as const, key: "release", summary: "Handoff release ready",
    next_steps: ["Run smoke check"], source_ids: sourceIds };
  const options = { database, binding, policyBinding };
  const server = createMemoryMcpServer(options);
  function purge(id: string) {
    purgeSource(database, policyBinding, { version: 1, operation_id: randomUUID(), scope_id: scopeId,
      capture_ids: [id], expected_privacy_epoch: database.getScopePrivacyEpoch(scopeId), requested_at: "2026-09-15T08:02:00Z" });
  }
  return { ...options, options, input, server, grants, purge,
    close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function call(server: MemoryMcpServer, name: string, args: unknown) {
  const response = await server.handleMessageObject({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
    params: { name, arguments: args } });
  const result = response?.["result"] as { content: { text: string }[]; isError?: boolean };
  assert.ok(result);
  return { isError: result.isError ?? false, text: result.content[0]!.text,
    payload: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

test("MCP writes a bounded receipt, reads reports, recalls them and maps head conflicts", async () => {
  const f = fixture();
  try {
    const server = createMemoryMcpServer({ ...f.options, write: input => ({
      ...f.database.summaries.writeSourceRecord(f.binding, input), unbounded: "private callback data".repeat(10_000),
    }) });
    const write = await call(server, "memory_write", f.input);
    assert.equal(write.isError, false);
    assert.ok(Buffer.byteLength(write.text) < 1_000);
    const receipt = write.payload.record;
    assert.deepEqual(Object.keys(receipt).sort(), ["created_commit_seq", "key", "kind", "revision_id", "scope_id", "state"]);
    const getArgs = { scope_id: f.input.scope_id, reference: { kind: "record", revision_id: receipt.revision_id } };
    const get = await call(server, "memory_get", getArgs);
    assert.equal(get.isError, false);
    assert.equal(get.payload.record.summary, f.input.summary);
    const recall = await call(server, "memory_recall", { query: "handoff" });
    assert.equal(recall.isError, false);
    const packet = parseEvidencePacket(recall.payload.packet);
    assert.equal(packet.items.filter(item => item.kind === "record").length, 1);
    assert.equal(f.database.getQueryTrace(packet.delivery!.injection_id)?.delivery_state, "returned");
    const conflict = await call(server, "memory_write", { ...f.input, summary: "Changed report" });
    assert.equal(conflict.payload.error.code, "revision_conflict");
    const replace = await call(server, "memory_write", { ...f.input, summary: "Changed report", replaces: receipt.revision_id });
    assert.equal(replace.isError, false);
    assert.equal((await call(server, "memory_get", getArgs)).payload.record.state, "blocked");
    f.grants(["prompt"]);
    assert.equal((await call(server, "memory_get", getArgs)).isError, true);
  } finally { f.close(); }
});

for (const change of ["purge first", "purge second", "revoke assistant", "revoke sources", "supersede", "omit dependency", "metadata microtask", "metadata serialization"] as const) {
  test(`MCP final recall egress rejects ${change} after preparation`, async () => {
    const f = fixture();
    try {
      const stored = f.database.summaries.writeSourceRecord(f.binding, f.input);
      let prepared: EvidencePacket | undefined;
      const supersede = () => f.database.summaries.writeSourceRecord(f.binding, { ...f.input, summary: "Replacement report", replaces: stored.revision_id });
      const server = createMemoryMcpServer({ ...f.options,
        prepareRecall: async (request, context) => {
          const packet = await prepareEvidencePacket(f.database, request, f.binding, context);
          assert.equal(packet.items.filter(item => item.kind === "record").length, 1);
          prepared = packet;
          await Promise.resolve();
          switch (change) {
            case "purge first": f.purge(f.input.source_ids[0]!); break;
            case "purge second": f.purge(f.input.source_ids[1]!); break;
            case "revoke assistant": f.grants(["prompt"]); break;
            case "revoke sources": f.grants(["assistant_output"]); break;
            case "supersede": supersede(); break;
            case "omit dependency": return { ...packet, items: packet.items.map(item => item.kind !== "record" ? item : {
              ...item, source_span_ids: item.source_span_ids.slice(0, 1),
              record_provenance: { ...item.record_provenance!, sources: item.record_provenance!.sources.slice(0, 1) },
            }) };
          }
          return packet;
        },
        recallMetadata: () => {
          if (change === "metadata microtask") queueMicrotask(supersede);
          return change === "metadata serialization" ? { toJSON() { f.grants(["prompt"]); return {}; } } : undefined;
        },
      });
      const result = await call(server, "memory_recall", { query: "handoff" });
      assert.equal(result.isError, true);
      assert.equal(result.text.includes(f.input.summary), false);
      assert.notEqual(f.database.getQueryTrace(prepared!.delivery!.injection_id)?.delivery_state, "returned");
    } finally { f.close(); }
  });
}

test("MCP final recall egress also rejects a purged original source", async () => {
  const f = fixture();
  try {
    const server = createMemoryMcpServer({ ...f.options, prepareRecall: async (request, context) => {
      const packet = await prepareEvidencePacket(f.database, request, f.binding, context);
      assert.ok(packet.items.some(item => item.kind === "source"));
      await Promise.resolve();
      f.purge(f.input.source_ids[0]!);
      return packet;
    } });
    const result = await call(server, "memory_recall", { query: "first original evidence" });
    assert.equal(result.isError, true);
    assert.equal(result.text.includes("first original evidence"), false);
  } finally { f.close(); }
});

test("MCP record get rejects grant revocation during its dependency read", async t => {
  const f = fixture();
  try {
    const stored = f.database.summaries.writeSourceRecord(f.binding, f.input);
    const read = f.database.summaries.read.bind(f.database.summaries);
    t.mock.method(f.database.summaries, "read", (...args: Parameters<typeof read>) => {
      const record = read(...args);
      f.grants(["prompt"]);
      return record;
    });
    const result = await call(f.server, "memory_get", { scope_id: f.input.scope_id,
      reference: { kind: "record", revision_id: stored.revision_id } });
    assert.equal(result.isError, true);
    assert.equal(result.text.includes(f.input.summary), false);
  } finally { f.close(); }
});
