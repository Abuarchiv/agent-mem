import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import {
  createPreparationContext,
  recognizePersistedEvidencePacket,
  serializeModelContext,
} from "../src/context/packet.js";
import {
  ContextPreparationError,
  prepareEvidencePacket,
  prepareSourceEvidencePacket,
  recall,
} from "../src/context/source-only.js";
import { bindingOwnerId, createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { SearchState } from "../src/v1/search-state.js";
import type { LocalReranker } from "../src/models/rerank.js";
import { emptySignals, improveSourceRanking, retrievalQuery } from "../src/retrieval/source-intelligence.js";
import { VECTOR_DIM, VectorSearchError } from "../src/retrieval/vector.js";
import { AgentMemoryDatabase, type RecallSourceGroup } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const policyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const allClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

function bindingFor(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "v1-recall-test" },
    host_instance_id: "v1-recall-host",
    host_session_id: "v1-recall-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:xp-copilot"] },
  });
}

function envelope(captureId: string, text: string, capturedAt: string, stage: "prompt_submitted" | "assistant_final" | "tool_result" = "prompt_submitted"): unknown {
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "v1-recall-test" },
      host_instance_id: "v1-recall-host",
      host_session_id: "v1-recall-session",
    },
    adapter_version: "0.1.0",
    event: {
      stage,
      role: stage === "prompt_submitted" ? "user" : stage === "assistant_final" ? "assistant" : "tool",
      evidence_class: stage === "prompt_submitted" ? "prompt" : stage === "assistant_final" ? "assistant_output" : "tool_output",
      ...(stage === "tool_result" ? { outcome: "succeeded" } : {}),
      native_ids: { session_id: "native-session", turn_id: captureId },
      text,
      provenance: {
        revision_id: captureId,
        revision_kind: "initial",
        correlation: { status: "correlated", basis: "native_ids", key: captureId },
        coverage: { status: "complete" },
      },
    },
    payload: { text },
    captured_at: capturedAt,
    occurred_at: capturedAt,
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function setup(): { database: AgentMemoryDatabase; binding: TrustedBinding; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-v1-recall-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"));
  const binding = bindingFor();
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: policyId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["reader:codex_cli"],
  });
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "v1-recall", created_at: "2026-09-14T08:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-14T08:00:00Z");
  setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: [...allClasses] }], "2026-09-14T08:00:01Z");
  return { database, binding, directory };
}

function close(database: AgentMemoryDatabase, directory: string): void {
  if (!database.isClosed()) database.close();
  rmSync(directory, { recursive: true, force: true });
}

test("automatic startup keeps the task, handoff and an older explicit note despite tool noise", async () => {
  const { database, binding, directory } = setup();
  try {
    const note = randomUUID(), task = randomUUID(), handoff = randomUUID();
    capture(envelope(note, "Decision: PostgreSQL is the project database.", "2026-09-14T08:01:00Z"), binding, database);
    capture(envelope(task, "Implement invoice validation", "2026-09-14T08:02:00Z"), binding, database);
    capture(envelope(handoff, "Invoice migration still needs review", "2026-09-14T08:03:00Z", "assistant_final"), binding, database);
    for (let index = 0; index < 30; index++) capture(envelope(randomUUID(), `Decision: tool output ${index}`, "2026-09-14T08:04:00Z", "tool_result"), binding, database);
    const packet = await prepareSourceEvidencePacket(database,
      { query: "...", scope_ids: [scopeId], mode: "current", token_budget: 8000 }, binding,
      createPreparationContext(binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" }, budget: { profile: { unit: "utf8_bytes", limit: 8000 } } }));
    const ids = packet.items.map(item => item.item_id);
    assert.ok(ids.includes(note));
    assert.ok(ids.includes(task));
    assert.ok(ids.includes(handoff));
    assert.equal(packet.items.find(item => item.item_id === note)?.content, "Decision: PostgreSQL is the project database.");
    const policy = createPolicySetupBinding({ version: 1, setup_id: policyId, allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:codex_cli"] });
    setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: ["tool_output"] }], "2026-09-14T08:05:00Z");
    assert.deepEqual(database.getRecallTimelineGroups([scopeId], binding, "99999", 8, undefined, false, { source_classes: ["prompt"] }), []);
  } finally { close(database, directory); }
});

test("long archive notes leave room for task and handoff at the native Codex budget", async () => {
  const { database, binding, directory } = setup();
  try {
    const state = new SearchState(directory);
    for (let index = 0; index < 2; index++) {
      const note = randomUUID();
      capture(envelope(note, `Decision: ${"archived context ".repeat(170)}${index}`, "2026-09-14T08:01:00Z"), binding, database);
      state.registerProcedure({ scope_id: scopeId, capture_id: note, terms: ["recent"] });
    }
    const task = randomUUID(), handoff = randomUUID();
    capture(envelope(task, "Implement invoice validation", "2026-09-14T08:02:00Z"), binding, database);
    capture(envelope(handoff, "Invoice migration still needs review", "2026-09-14T08:03:00Z", "assistant_final"), binding, database);
    const packet = await prepareSourceEvidencePacket(database,
      { query: "recent project context", scope_ids: [scopeId], mode: "current", token_budget: 4000 }, binding,
      createPreparationContext(binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "committed", capture_id: randomUUID() }, budget: { profile: { unit: "utf8_bytes", limit: 4000 } } }), undefined, { state });
    assert.ok(packet.items.some(item => item.item_id === task));
    assert.ok(packet.items.some(item => item.item_id === handoff));
    assert.ok(packet.tokens.used <= 4000);
  } finally { close(database, directory); }
});

test("recent wording does not replace topical search with an unrelated timeline", async () => {
  const { database, binding, directory } = setup();
  try {
    const sourceId = randomUUID();
    capture(envelope(sourceId, "Stromrechnung Oktober bezahlt", "2026-09-14T08:01:00Z"), binding, database);
    for (let index = 0; index < 25; index++) {
      capture(envelope(randomUUID(), "unrelated deployment log", "2026-09-14T08:02:00Z"), binding, database);
    }
    const packet = await prepareSourceEvidencePacket(database,
      { query: "latest Stromrechnung", scope_ids: [scopeId], mode: "current", token_budget: 4000 }, binding,
      createPreparationContext(binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" }, budget: { profile: { unit: "utf8_bytes", limit: 4000 } } }));
    assert.equal(packet.items[0]?.item_id, sourceId);
    assert.notEqual(packet.mode, "timeline");
  } finally { close(database, directory); }
});

test("a distinctive exact term beats a misleading hybrid score", async () => {
  const { database, binding, directory } = setup();
  try {
    const answerId = randomUUID();
    const toolId = randomUUID();
    capture(envelope(answerId, "CODEX_MEMORY_ANCHOR_7421 is the confirmed release decision.", "2026-09-14T08:01:00Z", "assistant_final"), binding, database);
    capture(envelope(toolId, "The tool output discusses memory context and the current release session.", "2026-09-14T08:02:00Z", "tool_result"), binding, database);
    const snapshot = database.getRecallSnapshot([scopeId], binding);
    const groups = database.getRecallSourceGroups([scopeId], binding, [toolId, answerId], snapshot.watermark);
    const result = await improveSourceRanking(
      database,
      { query: "CODEX_MEMORY_ANCHOR_7421", scope_ids: [scopeId], mode: "current", token_budget: 4_000, known_at_seq: snapshot.watermark },
      binding,
      groups,
      new Map([
        [toolId, { ...emptySignals(), lexical: 1, semantic: 1 }],
        [answerId, { ...emptySignals(), lexical: 0.1, semantic: 0.1 }],
      ]),
      { deadline_at: "2099-01-01T00:00:00Z", exclude_current_session_prompts: false, timeline: false },
      {},
    );
    assert.equal(result.groups[0]?.capture_id, answerId);
  } finally {
    close(database, directory);
  }
});

test("long queries retain technical anchors at the retrieval boundary", () => {
  const query = `${Array.from({ length: 60 }, (_, index) => `filler${index}`).join(" ")} src/retrieval/lexical.ts`;
  assert.match(retrievalQuery(query), /src\/retrieval\/lexical\.ts/);
});

test("lexical fallback keeps a distinctive technical anchor ahead of question filler", async () => {
  const { database, binding, directory } = setup();
  try {
    const rareId = randomUUID();
    const fillerId = randomUUID();
    capture(envelope(rareId, "AXOLOTL_7421 release checklist is the relevant decision.", "2026-09-14T08:01:00Z", "assistant_final"), binding, database);
    capture(envelope(fillerId, "Where can I find the release document?", "2026-09-14T08:02:00Z", "tool_result"), binding, database);
    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "Where can I find AXOLOTL_7421 document?", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      createPreparationContext(binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z", capture_status: { state: "not_attempted" }, budget: { profile: { unit: "utf8_bytes", limit: 4_000 } } }),
    );
    assert.equal(packet.items[0]?.item_id, rareId, JSON.stringify(packet.items.map(item => ({ id: item.item_id, content: item.content }))));
  } finally {
    close(database, directory);
  }
});

test("equal matches get a stable session and source-class diversity pass", async () => {
  const { database, binding, directory } = setup();
  try {
    const group = (captureId: string, sessionId: string, evidenceClass: "prompt" | "assistant_output", commitSeq: string): RecallSourceGroup => ({
      capture_id: captureId,
      scope_id: scopeId,
      session_id: sessionId,
      commit_seq: commitSeq,
      data_epoch: "0",
      evidence_class: evidenceClass,
      role: evidenceClass === "prompt" ? "user" : "assistant",
      event_json: JSON.stringify({ native_ids: { message_id: captureId } }),
      spans: [{ span_id: randomUUID(), quote: "release decision" }],
    } as unknown as RecallSourceGroup);
    const first = group(randomUUID(), "session-a", "prompt", "1");
    const duplicate = group(randomUUID(), "session-a", "prompt", "2");
    const otherSession = group(randomUUID(), "session-b", "assistant_output", "3");
    const result = await improveSourceRanking(
      database,
      { query: "release decision", scope_ids: [scopeId], mode: "current", token_budget: 4_000, known_at_seq: "3" },
      binding,
      [first, duplicate, otherSession],
      new Map([[first.capture_id, emptySignals()], [duplicate.capture_id, emptySignals()], [otherSession.capture_id, emptySignals()]]),
      { deadline_at: "2099-01-01T00:00:00Z", exclude_current_session_prompts: false, timeline: false },
      {},
    );
    assert.deepEqual(result.groups.map(group => group.capture_id), [first.capture_id, otherSession.capture_id, duplicate.capture_id]);
  } finally {
    close(database, directory);
  }
});

test("snapshot revalidation retry performs at most one cross-encoder pass", async () => {
  const { database, binding, directory } = setup();
  try {
    capture(envelope(randomUUID(), "needle first source", "2026-09-14T08:01:00Z"), binding, database);
    capture(envelope(randomUUID(), "needle second source", "2026-09-14T08:02:00Z"), binding, database);
    const revalidate = database.revalidateRecallSnapshot.bind(database);
    let validations = 0, passes = 0;
    database.revalidateRecallSnapshot = (...args) => ++validations === 1 ? false : revalidate(...args);
    const reranker: LocalReranker = {
      manifest: {} as LocalReranker["manifest"],
      dispose: async () => undefined,
      report: () => { throw new Error("ranking_only_fixture"); },
      rerank: async (request) => {
      passes++;
      return request.candidates.map((candidate, rank) => ({ id: candidate.id, rank, score: 0.5 }));
    } };
    const packet = await prepareSourceEvidencePacket(database,
      { query: "needle", scope_ids: [scopeId], mode: "current", token_budget: 4000 }, binding,
      createPreparationContext(binding, { version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" }, budget: { profile: { unit: "utf8_bytes", limit: 4000 } } }),
      undefined, { reranker });
    assert.equal(packet.items.length, 2);
    assert.equal(validations, 2);
    assert.equal(passes, 1);
  } finally { close(database, directory); }
});

test("registered procedures return original sources and explicit feedback learns without a model", async () => {
  const { database, binding, directory } = setup();
  try {
    const state = new SearchState(directory);
    const sourceId = randomUUID();
    const original = "Release checklist: run the existing smoke check before publishing.";
    capture(envelope(sourceId, original, "2026-09-14T08:01:00Z"), binding, database);
    for (let index = 0; index < 3; index++) {
      state.registerProcedure({ scope_id: scopeId, capture_id: randomUUID(), terms: ["bereitstellen"] });
    }
    state.registerProcedure({ scope_id: scopeId, capture_id: sourceId, terms: ["bereitstellen"] });
    const context = createPreparationContext(binding, {
      version: 1, kind: "session_start", deadline_at: "2099-01-01T00:00:00Z", capture_status: { state: "not_attempted" },
      budget: { profile: { unit: "utf8_bytes", limit: 4000 } },
    });
    for (let index = 0; index < 5; index++) {
      const packet = await prepareSourceEvidencePacket(database,
        { query: "bereitstellen", scope_ids: [scopeId], mode: "current", token_budget: 1500 },
        binding, context, undefined, { state });
      assert.equal(packet.items[0]?.content, original, JSON.stringify({ packet, report: state.report(packet.query_id, bindingOwnerId(binding)) }));
      assert.equal(packet.items[0]?.item_id, sourceId);
      const report = state.report(packet.query_id, bindingOwnerId(binding));
      assert.deepEqual(report?.procedure_ids, [sourceId]);
      assert.equal(report?.reranker, "disabled");
      state.feedback(scopeId, packet.query_id, sourceId, true);
    }
    assert.equal(state.sampleCount(scopeId, "procedure"), 5);
    assert.ok(state.weights(scopeId, "procedure").procedure > 0.4);
    state.forgetSources(scopeId, [sourceId]);
    assert.equal(state.sampleCount(scopeId, "procedure"), 0);
    assert.ok(state.procedures(scopeId).every(rule => rule.capture_id !== sourceId));
  } finally { close(database, directory); }
});

test("source-only recall returns raw scoped evidence, excludes current capture, and persists delivery", async () => {
  const { database, binding, directory } = setup();
  try {
    const previousId = randomUUID();
    const recentUnrelatedId = randomUUID();
    const currentId = randomUUID();
    capture(envelope(previousId, "needle from the previous session", "2026-09-14T08:01:00Z"), binding, database);
    capture(envelope(recentUnrelatedId, "recent unrelated source", "2026-09-14T08:02:00Z"), binding, database);
    capture(envelope(currentId, "needle from the current capture", "2026-09-14T08:03:00Z"), binding, database);

    const context = createPreparationContext(binding, {
      version: 1,
      kind: "user_prompt",
      deadline_at: "2099-01-01T00:00:00Z",
      capture_status: { state: "committed", capture_id: currentId },
    });
    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "needle", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      context,
    );

    assert.deepEqual(packet.items.map((item) => item.item_id), [previousId]);
    assert.equal(packet.items[0]?.kind, "source");
    assert.equal(packet.items[0]?.content, "needle from the previous session");
    assert.equal(packet.items.some((item) => item.item_id === recentUnrelatedId), false);
    assert.equal(packet.items.some((item) => item.item_id === currentId), false);
    assert.equal(prepareEvidencePacket, prepareSourceEvidencePacket);
    assert.equal(recall, prepareSourceEvidencePacket);

    const wrapper = recognizePersistedEvidencePacket(database, binding, serializeModelContext(packet));
    assert.equal(wrapper?.injection_id, packet.delivery?.injection_id);
  } finally {
    close(database, directory);
  }
});

test("source-only V1 lexical fallback matches partial natural German terms", async () => {
  const { database, binding, directory } = setup();
  try {
    const sourceId = randomUUID();
    capture(
      envelope(sourceId, "Die Stromrechnung für Oktober wurde bereits bezahlt.", "2026-09-14T08:01:00Z"),
      binding,
      database,
    );

    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "Welche Rechnung für Oktober wurde bezahlt?", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      createPreparationContext(binding, {
        version: 1,
        kind: "session_start",
        deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" },
      }),
    );

    assert.equal(packet.items[0]?.item_id, sourceId);
    assert.equal(packet.items[0]?.content, "Die Stromrechnung für Oktober wurde bereits bezahlt.");
  } finally {
    close(database, directory);
  }
});

test("session-start without searchable terms uses a bounded recent source timeline", async () => {
  const { database, binding, directory } = setup();
  try {
    const recentId = randomUUID();
    capture(envelope(recentId, "recent timeline source", "2026-09-14T08:01:00Z"), binding, database);

    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "...", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      createPreparationContext(binding, {
        version: 1,
        kind: "session_start",
        deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" },
      }),
    );

    assert.equal(packet.items[0]?.item_id, recentId);
    assert.equal(packet.mode, "timeline");
  } finally {
    close(database, directory);
  }
});

test("native session-start uses the recent timeline despite its searchable placeholder", async () => {
  const { database, binding, directory } = setup();
  try {
    const recentId = randomUUID();
    const currentId = randomUUID();
    capture(envelope(recentId, "recent native session source", "2026-09-14T08:01:00Z"), binding, database);
    capture(envelope(currentId, "recent project work", "2026-09-14T08:02:00Z"), binding, database);

    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "recent project work", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      createPreparationContext(binding, {
        version: 1,
        kind: "session_start",
        deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "committed", capture_id: currentId },
      }),
    );

    assert.equal(packet.mode, "timeline");
    assert.equal(packet.items[0]?.item_id, recentId);
    assert.equal(packet.items.some((item) => item.item_id === currentId), false);
  } finally {
    close(database, directory);
  }
});

test("falls back to validated lexical evidence when a vector source span is invalid", async () => {
  const { database, binding, directory } = setup();
  const originalSearchVectorCandidates = database.searchVectorCandidates;
  database.searchVectorCandidates = (() => {
    throw new VectorSearchError("source_span_invalid");
  }) as typeof database.searchVectorCandidates;
  try {
    const sourceId = randomUUID();
    capture(envelope(sourceId, "needle survives the invalid vector projection", "2026-09-14T08:01:00Z"), binding, database);
    const packet = await prepareSourceEvidencePacket(
      database,
      { query: "needle", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
      binding,
      createPreparationContext(binding, {
        version: 1,
        kind: "session_start",
        deadline_at: "2099-01-01T00:00:00Z",
        capture_status: { state: "not_attempted" },
      }),
      Float32Array.from({ length: VECTOR_DIM }, (_, index) => (index === 0 ? 1 : 0)),
    );

    assert.equal(packet.items[0]?.item_id, sourceId);
    assert.equal(packet.items[0]?.content, "needle survives the invalid vector projection");
    assert.equal(packet.mode, "degraded");
    assert.ok(packet.diagnostics?.some((diagnostic) => diagnostic.code === "degraded_lexical"));
    const trace = database.getQueryTrace(packet.delivery!.injection_id);
    assert.ok(trace?.diagnostics.includes("projection_unavailable"));
  } finally {
    database.searchVectorCandidates = originalSearchVectorCandidates;
    close(database, directory);
  }
});

test("source-only context errors preserve the old error codes", async () => {
  const { database, binding, directory } = setup();
  try {
    await assert.rejects(
      () => prepareSourceEvidencePacket(
        database,
        { query: "needle", scope_ids: [scopeId], mode: "current", token_budget: 1_500 },
        binding,
        createPreparationContext(binding, {
          version: 1,
          kind: "user_prompt",
          deadline_at: "2099-01-01T00:00:00Z",
          capture_status: { state: "failed" },
        }),
      ),
      (error: unknown) => error instanceof ContextPreparationError && error.code === "capture_failed",
    );
  } finally {
    close(database, directory);
  }
});
