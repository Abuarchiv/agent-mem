import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import { createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { purgeSource } from "../src/core/purge-source.js";
import { createPreparationContext, parseModelContextWrapper, recognizePersistedEvidencePacket, serializeModelContext } from "../src/context/packet.js";
import { recallMemoryRecords } from "../src/context/memory-records.js";
import { prepareSourceEvidencePacket } from "../src/context/source-only.js";
import { createTrustedBinding, type EvidencePacket } from "../src/host/contract.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const capturedAt = "2026-09-15T08:00:00Z";
const deadline = "2099-01-01T00:00:00Z";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-record-recall-"));
  const path = join(directory, "vault.sqlite");
  const scopeId = randomUUID();
  const policy = createPolicySetupBinding({ version: 1, setup_id: randomUUID(), allowed_scope_ids: [scopeId], allowed_output_targets: ["reader:codex_cli"] });
  const value = {
    directory, path, scopeId, policy,
    database: new AgentMemoryDatabase(path, { extraction_enabled: false }),
    binding: createTrustedBinding({
      version: 1, binding_id: randomUUID(), host_kind: "codex", surface: "codex_cli",
      execution_domain: { kind: "local", id: "record-recall-test" }, host_instance_id: "record-recall-host",
      host_session_id: randomUUID(), allowed_scope_ids: [scopeId],
      egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
    }),
    close() { this.database.close(); rmSync(directory, { recursive: true, force: true }); },
    restart() {
      this.database.close();
      this.database = new AgentMemoryDatabase(path, { extraction_enabled: false });
      this.binding = createTrustedBinding({ ...this.binding, binding_id: randomUUID(), host_session_id: randomUUID() });
      this.database.registerSession(scopeId, this.binding, capturedAt);
    },
  };
  value.database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "record-recall", created_at: capturedAt });
  value.database.registerSession(scopeId, value.binding, capturedAt);
  setScopeOutputGrants(value.database, policy, scopeId, [{ target: "reader:codex_cli",
    source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }], capturedAt);
  return value;
}

function source(value: ReturnType<typeof fixture>, text: string, stage: "prompt_submitted" | "assistant_final" | "tool_result" = "assistant_final") {
  const id = randomUUID();
  capture({
    version: 1, capture_id: id, scope_id: value.scopeId,
    origin: { host_kind: value.binding.host_kind, surface: value.binding.surface,
      execution_domain: value.binding.execution_domain, host_instance_id: value.binding.host_instance_id,
      host_session_id: value.binding.host_session_id },
    adapter_version: "0.1.0", event: { stage, text,
      role: stage === "prompt_submitted" ? "user" : stage === "tool_result" ? "tool" : "assistant",
      evidence_class: stage === "prompt_submitted" ? "prompt" : stage === "tool_result" ? "tool_output" : "assistant_output",
      ...(stage === "tool_result" ? { outcome: "succeeded" } : {}),
      native_ids: { session_id: value.binding.host_session_id, turn_id: id } },
    payload: { text }, captured_at: capturedAt, occurred_at: capturedAt,
    truncation: { truncated: false }, redaction: { applied: true, policy_version: "1.0.0" },
  }, value.binding, value.database);
  return id;
}

async function recall(value: ReturnType<typeof fixture>, query = "...", excluded?: string, excludePrompts = false) {
  return prepareSourceEvidencePacket(value.database, { query, scope_ids: [value.scopeId], mode: "current", token_budget: 4_000 }, value.binding,
    createPreparationContext(value.binding, { version: 1, kind: "session_start", deadline_at: deadline,
      capture_status: excluded ? { state: "committed", capture_id: excluded } : { state: "not_attempted" },
      exclude_current_session_prompts: excludePrompts, budget: { profile: { unit: "utf8_bytes", limit: 4_000 } } }));
}

function checkContext(value: ReturnType<typeof fixture>, packet: EvidencePacket) {
  const wire = serializeModelContext(packet);
  const wrapper = parseModelContextWrapper(wire);
  assert.equal(packet.tokens.used, Buffer.byteLength(wire, "utf8"));
  assert.ok(packet.tokens.used <= 4_000);
  assert.deepEqual(recognizePersistedEvidencePacket(value.database, value.binding, wire), wrapper);
  for (const item of wrapper.items.filter(item => item.kind === "record")) {
    assert.equal(item.role, "assistant");
    assert.equal(item.status, "candidate");
    assert.equal(item.source_class, "assistant_output");
    assert.equal(item.capture_id, undefined);
    assert.equal(item.captured_at, capturedAt);
    assert.ok(item.spans.every(span => span.quote === ""));
    assert.equal(JSON.parse(item.content!).origin, "agent_report");
  }
  return wrapper;
}

test("write -> 4000-byte startup amid long raw sources -> replacement -> restart and marker-free query -> purge", async () => {
  const value = fixture();
  try {
    const raw = "Long raw investigation log. ".repeat(1_000);
    const firstSource = source(value, raw);
    const original = value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: "invoice-rollout", summary: `Agent chose amber-${randomUUID()}.`,
      next_steps: ["Run invoice migration smoke checks."], source_ids: [firstSource],
    });
    source(value, "Task: continue the invoice rollout. " + "Background detail. ".repeat(50), "prompt_submitted");
    for (let index = 0; index < 25; index++) source(value, `${index} ${raw}`, "tool_result");
    const shortSource = source(value, "Independent original source remains readable.", "tool_result");
    const startup = await recall(value);
    const startupContext = checkContext(value, startup);
    assert.ok(startup.items.some(item => item.revision_id === original.revision_id), "raw protected sources must not starve the handoff");
    assert.ok(startup.items.some(item => item.kind === "source"), "remaining budget still delivers original evidence");
    assert.equal(serializeModelContext(startup).includes(raw), false);
    assert.equal(startupContext.items.find(item => item.kind === "record")?.source_references?.[0]?.capture_id, firstSource);
    const snapshot = value.database.getRecallSnapshot([value.scopeId], value.binding);
    assert.ok(value.database.getRecallSourceGroups([value.scopeId], value.binding, [firstSource], snapshot.watermark)[0]?.spans.some(span => span.quote === raw));

    const replacementSource = source(value, raw + "New outcome.");
    const marker = `violet-${randomUUID()}`;
    const replacement = value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: "invoice-rollout", summary: `Agent now chose ${marker}.`,
      next_steps: ["Verify invoice migration."], source_ids: [replacementSource], replaces: original.revision_id,
    });
    value.restart();
    const query = "invoice rollout";
    assert.equal(query.includes(marker), false);
    const recalled = await recall(value, query);
    checkContext(value, recalled);
    assert.ok(recalled.items.some(item => item.revision_id === replacement.revision_id && item.content.includes(marker)));
    assert.equal(recalled.items.some(item => item.revision_id === original.revision_id), false);

    const result = purgeSource(value.database, value.policy, { version: 1, operation_id: randomUUID(), scope_id: value.scopeId,
      capture_ids: [replacementSource], expected_privacy_epoch: value.database.getScopePrivacyEpoch(value.scopeId), requested_at: capturedAt });
    assert.equal(result.physical_cleanup, "complete");
    value.restart();
    const afterPurge = await recall(value, query);
    checkContext(value, afterPurge);
    assert.equal(afterPurge.items.some(item => item.kind === "record"), false, "purge never resurrects the superseded report");
    assert.equal(serializeModelContext(afterPurge).includes(marker), false);
    assert.equal(value.database.getRecallSourceGroups([value.scopeId], value.binding, [shortSource], value.database.getRecallSnapshot([value.scopeId], value.binding).watermark).length, 1);
  } finally { value.close(); }
});

test("a long protected current task survives an oversized report at automatic startup", async () => {
  const value = fixture();
  try {
    const task = source(value, "Current task: finish the invoice rollout safely. " + "Required context. ".repeat(96), "prompt_submitted");
    const reportSource = source(value, "Source-backed rollout handoff.");
    const report = value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: "invoice-rollout",
      summary: ("Continue the invoice rollout with the verified migration checklist. " + "Verified report detail. ".repeat(80)).slice(0, 1_200),
      next_steps: ["Run the migration smoke check."], source_ids: [reportSource],
    });

    const packet = await recall(value);
    checkContext(value, packet);
    assert.ok(packet.items.some((item) => item.kind === "source" && item.item_id === task), "current task must remain in context");
    assert.equal(packet.items.some((item) => item.kind === "record" && item.revision_id === report.revision_id), false, "oversized report must not evict the current task");
    assert.ok(packet.diagnostics?.some((diagnostic) => diagnostic.code === "budget_exhausted"));
  } finally { value.close(); }
});

for (const viaSource of [false, true]) test(`query retrieves an old record behind 55 newer keys via ${viaSource ? "cited source" : "report text"}`, async () => {
  const value = fixture();
  try {
    const id = source(value, viaSource ? "Invoice rollout source facts." : "Unrelated raw log without the report's lookup terms.");
    const marker = `cobalt-${randomUUID()}`;
    const target = value.database.summaries.writeSourceRecord(value.binding, { scope_id: value.scopeId,
      kind: "decision", key: viaSource ? "release-mode" : "invoice-rollout", summary: `Use ${marker}.`, next_steps: [], source_ids: [id] });
    const noiseId = source(value, "Unrelated maintenance source.");
    for (let index = 0; index < 55; index++) value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "decision", key: `noise-${index}`, summary: "Unrelated maintenance.", next_steps: [], source_ids: [noiseId],
    });
    value.restart();
    const packet = await recall(value, "invoice rollout");
    checkContext(value, packet);
    assert.ok(packet.items.some(item => item.revision_id === target.revision_id && item.content.includes(marker)));
    assert.equal(packet.items.some(item => item.kind === "record" && item.revision_id !== target.revision_id), false);
  } finally { value.close(); }
});

test("record recall respects current-capture exclusion, session exclusions and revoked output grants", async () => {
  const value = fixture();
  try {
    const id = source(value, "User requested the invoice rollout.", "prompt_submitted");
    value.database.summaries.writeSourceRecord(value.binding, { scope_id: value.scopeId, kind: "decision", key: "invoice-rollout",
      summary: "Agent proposed the rollout.", next_steps: [], source_ids: [id] });
    assert.ok((await recall(value)).items.some(item => item.kind === "record"));
    assert.equal((await recall(value, "...", id)).items.some(item => item.kind === "record"), false);
    assert.equal((await recall(value, "...", undefined, true)).items.some(item => item.kind === "record"), false);
    value.restart();
    assert.ok((await recall(value, "...", undefined, true)).items.some(item => item.kind === "record"));
    setScopeOutputGrants(value.database, value.policy, value.scopeId,
      [{ target: "reader:codex_cli", source_classes: ["prompt"] }], capturedAt);
    const revoked = await recall(value);
    checkContext(value, revoked);
    assert.equal(revoked.items.some(item => item.kind === "record"), false);
    assert.ok(revoked.items.some(item => item.kind === "source"));
  } finally { value.close(); }
});

test("direct report matches rank ahead of newer reports sharing a matching raw source", async () => {
  const value = fixture();
  try {
    const id = source(value, "Invoice rollout source log.");
    const target = value.database.summaries.writeSourceRecord(value.binding, { scope_id: value.scopeId,
      kind: "decision", key: "invoice-rollout", summary: "Agent selected the invoice rollout.", next_steps: [], source_ids: [id] });
    for (let index = 0; index < 6; index++) value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "decision", key: `maintenance-${index}`, summary: "Unrelated maintenance.", next_steps: [], source_ids: [id],
    });
    const packet = await recall(value, "invoice rollout");
    checkContext(value, packet);
    assert.equal(packet.items.find(item => item.kind === "record")?.revision_id, target.revision_id);
  } finally { value.close(); }
});

test("budget selection reaches a small report after four oversized reports", async (t) => {
  const value = fixture();
  try {
    const sources = Array.from({ length: 16 }, (_, index) => source(value, `Source ${index}.`));
    const small = value.database.summaries.writeSourceRecord(value.binding, { scope_id: value.scopeId,
      kind: "handoff", key: "small", summary: "Continue invoice review.", next_steps: [], source_ids: [sources[0]!] });
    for (let index = 0; index < 4; index++) value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: `oversized-${index}`, summary: "Large report detail. ".repeat(60).slice(0, 1_200),
      next_steps: Array.from({ length: 5 }, () => "Detailed next action. ".repeat(12).slice(0, 240)), source_ids: sources,
    });
    const validation = t.mock.method(value.database, "revalidateRecallSnapshot");
    const packet = await recall(value);
    checkContext(value, packet);
    assert.deepEqual(packet.items.filter(item => item.kind === "record").map(item => item.revision_id), [small.revision_id]);
    assert.ok(packet.diagnostics?.some(diagnostic => diagnostic.code === "budget_exhausted"));
    const emitted = new Set(packet.items.flatMap(item => item.kind === "source" ? [item.item_id]
      : item.record_provenance!.sources.map(ref => ref.capture_id)));
    assert.ok(emitted.size < sources.length, "some candidate citations were omitted");
    assert.deepEqual(new Set(validation.mock.calls.at(-1)!.arguments[2]), emitted, "validate emitted references only");
  } finally { value.close(); }
});

test("one handoff and the current user task survive multiple 1200-character reports at 4000 bytes", async () => {
  const value = fixture();
  try {
    const id = source(value, "Investigation source. ".repeat(1_000));
    const reports = Array.from({ length: 4 }, (_, index) => value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: `rollout-${index}`, summary: "Agent progress details. ".repeat(60).slice(0, 1_200),
      next_steps: [], source_ids: [id],
    }));
    const task = source(value, "Fix the invoice validation bug and run its regression test.", "prompt_submitted");
    const packet = await recall(value);
    checkContext(value, packet);
    assert.ok(packet.items.some(item => item.kind === "source" && item.item_id === task));
    assert.ok(packet.items.some(item => item.kind === "record" && item.revision_id === reports.at(-1)!.revision_id));
    assert.ok(packet.diagnostics?.some(diagnostic => diagnostic.code === "budget_exhausted"));
  } finally { value.close(); }
});

test("shared record sources hydrate once within the 50-record bound and equal scores sort stably", (t) => {
  const value = fixture();
  try {
    const id = source(value, "Large original source body. ".repeat(1_000));
    const records = Array.from({ length: 50 }, (_, index) => value.database.summaries.writeSourceRecord(value.binding, {
      scope_id: value.scopeId, kind: "handoff", key: `shared-${index}`, summary: "Agent progress.", next_steps: [], source_ids: [id],
    }));
    const hydration = t.mock.method(value.database, "getRecallSourceGroups");
    const knownAt = value.database.getRecallSnapshot([value.scopeId], value.binding).watermark;
    const result = recallMemoryRecords(value.database, value.binding, [value.scopeId], knownAt, "...", [], true);
    assert.equal(result.items.length, 50);
    assert.equal(hydration.mock.callCount(), 1);
    assert.deepEqual(hydration.mock.calls[0]!.arguments[2], [id]);
    assert.equal("source_ids" in result, false);
    assert.ok(result.items.every(item => item.source_provenance === undefined));

    const tied = records.slice(0, 3).map(record => ({ ...record, created_commit_seq: records[0]!.created_commit_seq }));
    t.mock.method(value.database.summaries, "listSourceRecords", () => tied);
    const revisions = () => recallMemoryRecords(value.database, value.binding, [value.scopeId], knownAt, "...", [], true).items.map(item => item.revision_id);
    const expected = tied.map(record => record.revision_id).sort();
    assert.deepEqual(revisions(), expected);
    tied.reverse();
    assert.deepEqual(revisions(), expected);
  } finally { value.close(); }
});
