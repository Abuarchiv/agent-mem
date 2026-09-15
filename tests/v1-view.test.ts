import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPolicyOutputBinding, createPolicySetupBinding, setLocalUiOutputGrants, setScopeOutputGrants } from "../src/core/policy.js";
import { capture } from "../src/core/capture.js";
import { createTrustedBinding } from "../src/host/contract.js";
import { normalizeNativeEvent } from "../src/host/events.js";
import { AgentMemoryDatabase } from "../src/store/database.js";
import { buildViewSnapshot, GLOBAL_SCOPE_ID } from "../src/view/model.js";
import { buildEvidenceGraph, mergeSemanticGraph } from "../src/view/graph.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const setupId = "33333333-3333-4333-8333-333333333333";
const outputBindingId = "44444444-4444-4444-8444-444444444444";
const allSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

test("local UI exposes the complete read-only V1 data contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-view-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: false });
  const binding = createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "view-test" },
    host_instance_id: "view-host",
    host_session_id: "view-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["local_ui", "reader:codex_cli"],
  });
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "view-test", created_at: "2026-09-15T20:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-15T20:00:01Z");
  setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: ["prompt", "assistant_output"] }], "2026-09-15T20:00:02Z");
  setLocalUiOutputGrants(database, policy, scopeId, allSourceClasses, "2026-09-15T20:00:03Z");
  const localUi = createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: outputBindingId,
    setup_id: setupId,
    scope_id: scopeId,
    target: "local_ui",
  });

  try {
    const sourceText = "This is a complete source event with a short evidence span.";
    const captureId = "55555555-5555-4555-8555-555555555555";
    const spanId = "66666666-6666-4666-8666-666666666666";
    const normalized = normalizeNativeEvent({
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      adapter_version: "1.0.0",
      stage: "prompt_submitted",
      native_ids: { session_id: "native-view", turn_id: captureId },
      text: sourceText,
      payload: { text: sourceText },
      captured_at: "2026-09-15T20:00:04Z",
      coverage: { status: "complete" },
    }, binding);
    capture(normalized, binding, database, {
      source_spans: [{
        span_id: spanId,
        root: "payload",
        path: "/text",
        start_utf16: 0,
        end_utf16: sourceText.length,
        digest: createHash("sha256").update(sourceText, "utf8").digest("hex"),
      }],
    });
    const tokenSavings = database.getTokenSavingsForUi(localUi, { countUnits: (text) => text.length });
    assert.equal(tokenSavings.status, "computed");
    assert.equal(tokenSavings.unit, "tokens");
    assert.equal(tokenSavings.measured_sources, 1);
    assert.ok(tokenSavings.saved_units > 0);
    const snapshot = database.getLocalUiSnapshot(localUi);
    assert.equal(snapshot.scope_id, scopeId);
    assert.equal(snapshot.capture_paused, false);
    assert.equal(database.getUiCounts(localUi).source_count, 1n);
    assert.deepEqual(database.listMemoryItemsForUi(localUi, 10), []);
    assert.deepEqual(database.listQueryTracesForUi(localUi, 10), []);
    assert.equal(database.getPrivacySnapshotForUi(localUi).grants.filter((grant) => grant.output_target === "local_ui").length, allSourceClasses.length);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("global local UI aggregates authorized data across projects", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-global-view-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: false });
  const secondScopeId = "77777777-7777-4777-8777-777777777777";
  const binding = createTrustedBinding({
    version: 1,
    binding_id: "88888888-8888-4888-8888-888888888888",
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "global-view-test" },
    host_instance_id: "global-view-host",
    host_session_id: "global-view-session",
    allowed_scope_ids: [scopeId, secondScopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: "99999999-9999-4999-8999-999999999999",
    allowed_scope_ids: [scopeId, secondScopeId],
    allowed_output_targets: ["local_ui", "reader:codex_cli"],
  });
  const localBindings = new Map<string, ReturnType<typeof createPolicyOutputBinding>>();
  const readerBindings = new Map<string, ReturnType<typeof createPolicyOutputBinding>>();

  try {
    for (const [index, currentScopeId] of [scopeId, secondScopeId].entries()) {
      database.registerScope({ scope_id: currentScopeId, kind: "project", owner_ref: `global-view-${index}`, created_at: "2026-09-15T20:00:00Z" });
      database.registerSession(currentScopeId, binding, `2026-09-15T20:00:0${index + 1}Z`);
      setScopeOutputGrants(database, policy, currentScopeId, [{ target: "reader:codex_cli", source_classes: ["prompt", "assistant_output"] }], `2026-09-15T20:00:1${index}Z`);
      setLocalUiOutputGrants(database, policy, currentScopeId, allSourceClasses, `2026-09-15T20:00:2${index}Z`);
      localBindings.set(currentScopeId, createPolicyOutputBinding(policy, {
        version: 1,
        output_binding_id: randomUUID(),
        setup_id: policy.setup_id,
        scope_id: currentScopeId,
        target: "local_ui",
      }));
      readerBindings.set(currentScopeId, createPolicyOutputBinding(policy, {
        version: 1,
        output_binding_id: randomUUID(),
        setup_id: policy.setup_id,
        scope_id: currentScopeId,
        target: "reader:codex_cli",
      }));
      const text = `global source ${index}`;
      const normalized = normalizeNativeEvent({
        version: 1,
        capture_id: randomUUID(),
        scope_id: currentScopeId,
        adapter_version: "1.0.0",
        stage: "prompt_submitted",
        native_ids: { session_id: `global-native-${index}` },
        text,
        payload: { text },
        captured_at: `2026-09-15T20:00:3${index}Z`,
        coverage: { status: "complete" },
      }, binding);
      capture(normalized, binding, database);
    }

    const snapshot = buildViewSnapshot({
      database,
      projects: [
        { scope_id: scopeId, root: "/repo/one" },
        { scope_id: secondScopeId, root: "/repo/two" },
      ],
      status: () => ({ state: "core_ready" }),
      localUiBindingFor: (currentScopeId) => localBindings.get(currentScopeId)!,
      readerOutputBindingFor: (currentScopeId) => readerBindings.get(currentScopeId)!,
      countUnits: (value) => value.length,
    });

    assert.equal(snapshot.selected_scope_id, GLOBAL_SCOPE_ID);
    assert.equal(snapshot.projects.length, 2);
    assert.equal(snapshot.counts.sources, "2");
    assert.equal(snapshot.sources.length, 2);
    assert.deepEqual(new Set(snapshot.sources.map((source) => source.scope_id)), new Set([scopeId, secondScopeId]));
    assert.equal(snapshot.token_savings.status, "computed");
    assert.equal(snapshot.token_savings.measured_sources, 2);
    assert.equal(snapshot.graph_sources.length, 2);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("evidence graph connects real scopes, sessions, and source events", () => {
  const graph = buildEvidenceGraph({
    projects: [
      { scope_id: scopeId, root: "/repo/one" },
      { scope_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", root: "/repo/two" },
    ],
    sessions: [{
      session_id: "session-one",
      scope_id: scopeId,
      host_kind: "codex",
      surface: "codex_cli",
      started_at: "2026-09-15T20:00:00Z",
      ended_at: null,
      coverage: "complete",
    }],
    sources: [{
      capture_id: "source-one",
      scope_id: scopeId,
      session_id: "session-one",
      role: "user",
      evidence_class: "prompt",
      observed_stage: "prompt_submitted",
      commit_seq: "1",
    }, {
      capture_id: "source-two",
      scope_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      session_id: "missing-session",
      role: "assistant",
      evidence_class: "assistant_output",
      observed_stage: "assistant_final",
      commit_seq: "2",
    }],
  });

  assert.equal(graph.nodes.filter((node) => node.kind === "scope").length, 2);
  assert.equal(graph.nodes.filter((node) => node.kind === "session").length, 1);
  assert.equal(graph.nodes.filter((node) => node.kind === "source").length, 2);
  assert.ok(graph.edges.some((edge) => edge.from === "scope:" + scopeId && edge.to === "session:" + scopeId + ":session-one"));
  assert.ok(graph.edges.some((edge) => edge.from === "session:" + scopeId + ":session-one" && edge.to === "source:" + scopeId + ":source-one"));
  assert.ok(graph.edges.some((edge) => edge.from === "scope:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && edge.to === "source:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:source-two"));
});

test("knowledge graph keeps only active source-backed semantic relations", () => {
  const graph = mergeSemanticGraph({ nodes: [], edges: [] }, {
    nodes: [
      { entity_id: "entity-a", label: "Agent Mem", resolution_state: "resolved", created_commit_seq: "1" },
      { entity_id: "entity-b", label: "Codex", resolution_state: "candidate", created_commit_seq: "2" },
    ],
    edges: [{
      edge_id: "edge-active",
      source_entity: "entity-a",
      target_entity: "entity-b",
      predicate: "uses",
      evidence_revision: "revision-1",
      status: "active",
      created_commit_seq: "2",
    }, {
      edge_id: "edge-purged",
      source_entity: "entity-a",
      target_entity: "entity-b",
      predicate: "old_relation",
      evidence_revision: "revision-0",
      status: "purged",
      created_commit_seq: "1",
    }],
  });

  assert.deepEqual(graph.nodes.map((node) => node.entity_id), ["entity:entity-a", "entity:entity-b"]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.predicate, "uses");
});
