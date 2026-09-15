import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { prepareCaptureInput } from "../src/core/capture.js";
import { createPolicySetupBinding, createPolicyOutputBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { createPreparationContext } from "../src/context/packet.js";
import { prepareSourceEvidencePacket } from "../src/context/source-only.js";
import { createTrustedBinding } from "../src/host/contract.js";
import { VECTOR_DIM, VECTOR_PROFILE_ID, VECTOR_TOKENIZER_VERSION, VECTOR_CHUNKER_VERSION, vectorInputDigest } from "../src/retrieval/vector.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scope = "11111111-1111-4111-8111-111111111111";
const classes = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;
const now = "2026-09-15T08:00:00Z";
const knownAt = "999999";
const embedTask = "embed-e5-761b726-gen1";
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

function setup(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "v1-legacy-source-"));
  const path = join(directory, "vault.sqlite");
  const database = new AgentMemoryDatabase(path, { extraction_enabled: false });
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const binding = createTrustedBinding({
    version: 1, binding_id: randomUUID(), host_kind: "codex", surface: "codex_cli",
    execution_domain: { kind: "local", id: "legacy-source" },
    host_instance_id: "legacy-host", host_session_id: "legacy-session", allowed_scope_ids: [scope],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
  const policy = createPolicySetupBinding({ version: 1, setup_id: randomUUID(), allowed_scope_ids: [scope], allowed_output_targets: ["reader:codex_cli"] });
  database.registerScope({ scope_id: scope, kind: "project", owner_ref: "legacy-test", created_at: now });
  database.registerSession(scope, binding, now);
  const grants = (allowed: readonly (typeof classes)[number][]) => setScopeOutputGrants(database, policy, scope, [{ target: "reader:codex_cli", source_classes: [...allowed] }], now);
  grants(classes);
  const vector = new Float32Array(VECTOR_DIM);
  vector[0] = 1;
  const request = { query: "legacyneedle", scope_ids: [scope], mode: "current", token_budget: 8000, known_at_seq: knownAt };

  function add(stage: "stop" | "tool_started" | "tool_result" | "prompt_submitted", payload: Record<string, unknown>, text = "legacyneedle handoff") {
    const captureId = randomUUID(), spanId = randomUUID();
    const identity = stage === "stop" ? { role: "system", evidence_class: "lifecycle" }
      : stage === "prompt_submitted" ? { role: "user", evidence_class: "prompt" }
      : { role: "tool", evidence_class: stage === "tool_started" ? "tool_input" : "tool_output" };
    const prepared = prepareCaptureInput({
      version: 1, capture_id: captureId, scope_id: scope,
      origin: { host_kind: binding.host_kind, surface: binding.surface, execution_domain: binding.execution_domain,
        host_instance_id: binding.host_instance_id, host_session_id: binding.host_session_id },
      adapter_version: "0.1.0",
      event: { stage, ...identity, native_ids: { session_id: "native-legacy", message_id: "shared-message", tool_call_id: captureId },
        ...(stage === "tool_result" ? { outcome: "succeeded" } : {}), ...(stage === "stop" ? {} : { text }) },
      payload: { ...payload, text }, captured_at: now, occurred_at: now,
      truncation: { truncated: false }, redaction: { applied: true, policy_version: "1.0.0" },
    }, binding, { source_spans: [{ span_id: spanId, root: "payload", path: stage === "stop" && payload.last_assistant_message === text ? "/last_assistant_message" : "/text",
      start_utf16: 0, end_utf16: text.length, digest: digest(text) }] });
    database.commitCapture(prepared, { task_version: embedTask });
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const generation = database.getActiveVectorGeneration();
    const chunk = { scope_id: scope, source_id: captureId, span_id: spanId, chunk_index: 0, text,
      profile_id: VECTOR_PROFILE_ID, tokenizer_version: VECTOR_TOKENIZER_VERSION, chunker_version: VECTOR_CHUNKER_VERSION, generation };
    assert.equal(database.completeVectorProjection(claim, [{ ...chunk, chunk_id: randomUUID(), input_digest: vectorInputDigest(chunk),
      vector, source_digest: digest(text) }], digest(claim.job_id)).status, "completed");
    return captureId;
  }
  const raw = () => {
    const reader = new DatabaseSync(path, { readOnly: true });
    try { return reader.prepare("SELECT * FROM source_event ORDER BY capture_id").all(); }
    finally { reader.close(); }
  };
  const timeline = (limit = 40) => database.getRecallTimelineGroups([scope], binding, knownAt, limit);
  const groups = (ids: string[]) => database.getRecallSourceGroups([scope], binding, ids, knownAt);
  const lexical = (limit = 40) => database.searchLexicalCandidates(request, binding, '"legacyneedle"', limit);
  const vectors = (limit = 40) => database.searchVectorCandidates(request, binding, vector, { limit });
  const graph = (ids: string[]) => database.getSourceGraphNeighbors({ scope_ids: [scope], source_ids: ids, known_at_seq: knownAt, limit: 100 }, binding);
  // Seed historical auxiliary rows solely to exercise the read boundaries.
  // Synthetic attempt IDs stand in for the unrelated extraction pipeline;
  // source rows/spans still come from capture and are never rewritten here.
  const seedLegacyRecommendations = (captureIds: string[]) => {
    const fixture = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    try {
      for (const captureId of captureIds) {
        const spanId = fixture.prepare("SELECT span_id FROM source_span WHERE source_id = ? AND root = 'payload' ORDER BY rowid LIMIT 1").get(captureId)?.span_id;
        const jobId = fixture.prepare("SELECT job_id FROM job WHERE source_capture_id = ? AND task_kind = 'embed'").get(captureId)?.job_id;
        assert.equal(typeof spanId, "string");
        assert.equal(typeof jobId, "string");
        const itemId = randomUUID(), revisionId = randomUUID(), batchId = randomUUID(), candidateId = randomUUID();
        fixture.prepare(`INSERT INTO memory_item
          (scope_id, item_id, kind, predicate, qualifiers_json, qualifiers_digest, cardinality, status, current_revision_id, created_commit_seq)
          VALUES (?, ?, 'procedure', 'legacy_procedure', '[]', ?, 'multi', 'supported', ?, 1)`)
          .run(scope, itemId, digest("[]"), revisionId);
        fixture.prepare(`INSERT INTO memory_revision
          (scope_id, revision_id, item_id, operation, content_json, content_digest, actor_binding_id,
           actor_host_kind, actor_surface, actor_execution_domain_kind, actor_execution_domain_id,
           actor_host_instance_id, actor_host_session_id, created_commit_seq)
          VALUES (?, ?, ?, 'ADD', '{}', ?, ?, 'codex', 'codex_cli', 'local', 'legacy-source', 'legacy-host', 'legacy-session', 1)`)
          .run(scope, revisionId, itemId, digest("{}"), binding.binding_id);
        fixture.prepare("INSERT INTO revision_source (scope_id, revision_id, source_capture_id, source_span_id) VALUES (?, ?, ?, ?)")
          .run(scope, revisionId, captureId, String(spanId));
        fixture.prepare(`INSERT INTO procedure_activation
          (scope_id, procedure_item_id, status, policy_version, conditions_json, validated_revision, active_revision, created_at, updated_at)
          VALUES (?, ?, 'active', 'legacy-test', '{}', ?, ?, ?, ?)`)
          .run(scope, itemId, revisionId, revisionId, now, now);
        fixture.prepare(`INSERT INTO extraction_batch
          (batch_id, job_id, scope_id, source_capture_id, task_version, input_fingerprint, input_privacy_epoch,
           source_token_count, source_measurement_unit, target_json, state,
           extract_attempt_id, extract_result_digest, verify_attempt_id, verify_result_digest, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'legacy-test', ?, '0', 1, 'tokens', '{}', 'verified', ?, ?, ?, ?, ?, ?)`)
          .run(batchId, String(jobId), scope, captureId, digest(captureId), randomUUID(), digest("extract"), randomUUID(), digest("verify"), now, now);
        const candidate = JSON.stringify({ operation: "CORRECT", expected: { item_id: itemId }, source_span_ids: [spanId] });
        fixture.prepare(`INSERT INTO extraction_candidate
          (batch_id, candidate_id, candidate_digest, candidate_json, state, created_at) VALUES (?, ?, ?, ?, 'verified', ?)`)
          .run(batchId, candidateId, digest(candidate), candidate, now);
        fixture.prepare(`INSERT INTO extraction_verdict
          (batch_id, candidate_id, candidate_digest, entailment, attribution, modality, negation, time, receipt_digest, created_at)
          VALUES (?, ?, ?, 'entailed', 'positive', 'positive', 'positive', 'positive', ?, ?)`)
          .run(batchId, candidateId, digest(candidate), digest("receipt"), now);
      }
    } finally { fixture.close(); }
  };
  const procedures = () => database.listProcedureRecommendationRows([scope], binding).flatMap(row => row.spans.map(span => span.capture_id));
  const corrections = () => database.listPendingCorrectionReplacementSources([scope], binding).map(row => row.capture_id);
  return { database, binding, policy, request, grants, add, raw, timeline, groups, lexical, vectors, graph, seedLegacyRecommendations, procedures, corrections };
}

test("legacy Codex Stop becomes assistant evidence only on recall; repeated reads preserve the raw vault", async t => {
  const f = setup(t);
  const id = f.add("stop", { hook_event_name: "Stop", last_assistant_message: "legacyneedle handoff" });
  const before = f.raw();
  assert.equal(before[0]?.observed_stage, "stop");
  assert.equal(before[0]?.role, "system");
  assert.equal(before[0]?.evidence_class, "lifecycle");
  for (let read = 0; read < 2; read++) {
    for (const group of [...f.timeline(), ...f.groups([id])]) {
      assert.equal(group.role, "assistant");
      assert.equal(group.evidence_class, "assistant_output");
      assert.equal(group.payload_json, before[0]?.payload_json);
      assert.equal(group.event_json, before[0]?.event_json);
      assert.equal(group.fingerprint, before[0]?.fingerprint);
    }
    assert.equal(f.database.getRecallTimelineGroups([scope], f.binding, knownAt, 1, undefined, false, { source_classes: ["assistant_output"] })[0]?.capture_id, id);
    assert.equal(f.lexical()[0]?.source_id, id);
    assert.equal(f.vectors()[0]?.source_id, id);
    const packet = await prepareSourceEvidencePacket(f.database, { ...f.request, query: "..." }, f.binding,
      createPreparationContext(f.binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" }, budget: { profile: { unit: "utf8_bytes", limit: 8000 } } }));
    const item = packet.items.find(item => item.item_id === id);
    assert.equal(item?.content, "legacyneedle handoff");
    assert.equal(item?.role, "assistant");
    assert.equal(item?.source_class, "assistant_output");
    const audit = f.database.getSourceForOutput(id, createPolicyOutputBinding(f.policy, {
      version: 1, output_binding_id: randomUUID(), setup_id: f.policy.setup_id, scope_id: scope, target: "reader:codex_cli",
    }));
    assert.equal(audit?.event_json, before[0]?.event_json);
    assert.deepEqual(f.raw(), before);
  }
});

test("revoking either raw lifecycle or assistant_output grant closes every recall path", t => {
  const f = setup(t);
  const seed = f.add("prompt_submitted", {});
  const id = f.add("stop", { hook_event_name: "Stop", last_assistant_message: "legacyneedle handoff" });
  assert.ok(f.graph([seed]).some(edge => edge.source_id === id));
  for (const revoked of ["lifecycle", "assistant_output"] as const) {
    f.grants(classes.filter(value => value !== revoked));
    assert.ok(!f.timeline().some(row => row.capture_id === id));
    assert.deepEqual(f.groups([id]), []);
    assert.ok(!f.lexical().some(row => row.source_id === id));
    assert.ok(!f.vectors().some(row => row.source_id === id));
    assert.ok(!f.graph([seed]).some(row => row.source_id === id));
    assert.equal(f.graph([id]).length, 0);
    f.grants(classes);
    assert.equal(f.groups([id])[0]?.evidence_class, "assistant_output");
  }
});

test("more than 40 historical memory echoes cannot starve real file evidence before limits", t => {
  const f = setup(t);
  const text = "legacyneedle file docs mention mcp__agent_memory_v1__memory_recall and agent_memory_v1_memory_get";
  const real = f.add("tool_result", { tool_name: "read_file", file_path: "README.md" }, text);
  const echoes: string[] = [];
  const tools = ["memory_recall", "memory_get", "memory_forget", "memory_write"];
  const names = tools.flatMap(tool => [`mcp__agent_memory_v1__${tool}`, `agent_memory_v1_${tool}`,
    `mcp__agent-memory-v1__${tool}`, `agent-memory-v1.${tool}`, `agent-memory-v1_${tool}`, `mcp.agent-memory-v1.${tool}`]);
  for (const name of names) {
    for (const stage of ["tool_started", "tool_result"] as const) {
      const slot = echoes.length % 3;
      echoes.push(f.add(stage, slot === 0 ? { tool_name: name } : slot === 1 ? { native_part: { tool: name } } : { input: { tool: name } }));
    }
  }
  assert.ok(echoes.length > 40);
  const before = f.raw();
  assert.deepEqual(f.timeline(1).map(row => row.capture_id), [real]);
  assert.deepEqual(f.lexical(1).map(row => row.source_id), [real]);
  assert.deepEqual(f.vectors(1).map(row => row.source_id), [real]);
  assert.deepEqual(f.groups([real, ...echoes]).map(row => row.capture_id), [real]);
  assert.equal(f.graph([real]).length, 0);
  assert.equal(f.graph(echoes.slice(0, 1)).length, 0);
  assert.deepEqual(f.raw(), before);
});

test("normalization requires the old identity and an actual nonempty Stop message; foreign tool identities survive", t => {
  const f = setup(t);
  for (const payload of [{}, { hook_event_name: "Stop", last_assistant_message: "" },
    { hook_event_name: "Stop", last_assistant_message: " \n\t " },
    { hook_event_name: "Stop", last_assistant_message: 42 },
    { hook_event_name: "Other", last_assistant_message: "legacyneedle handoff" }]) {
    const id = f.add("stop", payload);
    assert.equal(f.groups([id])[0]?.evidence_class, "lifecycle");
  }
  for (const tool of ["memory_recall", "mcp__foreign__memory_get", "agent_memory_v1_memory_recall_extra", "read_file"]) {
    const id = f.add("tool_result", { tool_name: tool, contents: "mcp__agent_memory_v1__memory_recall" });
    assert.equal(f.groups([id])[0]?.evidence_class, "tool_output");
  }
});

test("legacy procedure and correction reads require both grants and filter 129 OpenCode echoes before LIMIT", t => {
  const f = setup(t);
  const real = f.add("tool_result", { tool: "read_file", contents: "agentmemory_memory_get agent-memory.memory_write" });
  const stop = f.add("stop", { hook_event_name: "Stop", last_assistant_message: "legacyneedle handoff" });
  const echoes: string[] = [];
  const servers = ["agent_memory_v1", "agent-memory-v1", "agent-memory", "agentmemory"];
  const methods = ["memory_recall", "memory_get", "memory_forget", "memory_write"];
  for (let index = 0; index < 129; index++) {
    const server = servers[index % 4], method = methods[Math.floor(index / 4) % 4];
    const tool = index < 64 ? `${server}_${method}` : `mcp__${server}__${method}`;
    const slot = Math.floor(index / 16) % 4;
    const metadata = slot === 0 ? { tool } : slot === 1 ? { tool_name: tool }
      : slot === 2 ? { native_part: { tool } } : { input: { tool } };
    echoes.push(f.add(index % 2 ? "tool_started" : "tool_result", metadata));
  }
  f.seedLegacyRecommendations([real, stop, ...echoes]);
  const before = f.raw();
  for (const read of [f.procedures, f.corrections]) {
    assert.deepEqual(new Set(read()), new Set([real, stop]));
    for (const revoked of ["assistant_output", "lifecycle"] as const) {
      f.grants(classes.filter(value => value !== revoked));
      assert.deepEqual(read(), [real]);
      f.grants(classes);
      assert.deepEqual(new Set(read()), new Set([real, stop]));
    }
  }
  assert.deepEqual(new Set(f.timeline().map(row => row.capture_id)), new Set([real, stop]));
  assert.deepEqual(new Set(f.groups([real, stop, ...echoes]).map(row => row.capture_id)), new Set([real, stop]));
  assert.deepEqual(new Set(f.lexical().map(row => row.source_id)), new Set([real, stop]));
  assert.deepEqual(new Set(f.vectors().map(row => row.source_id)), new Set([real, stop]));
  assert.ok(f.graph([real]).every(row => row.source_id === stop));
  assert.deepEqual(f.raw(), before);
});
