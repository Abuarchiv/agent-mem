import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import { createPolicyOutputBinding, createPolicySetupBinding, setScopeOutputGrants, type PolicyOutputBinding, type PolicySetupBinding, type ScopeOutputGrant } from "../src/core/policy.js";
import { purgeSource } from "../src/core/purge-source.js";
import type { MemoryRecordInput } from "../src/core/memory-record.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryDatabase } from "../src/store/database.js";
import { StoreError } from "../src/store/errors.js";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const setupId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const allSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

interface Fixture {
  readonly directory: string;
  readonly path: string;
  readonly database: AgentMemoryDatabase;
  readonly binding: TrustedBinding;
  readonly policy: PolicySetupBinding;
}

interface Source {
  readonly captureId: string;
  readonly spanId: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(grants: readonly ScopeOutputGrant[] = [
  { target: "reader:codex_cli", source_classes: [...allSourceClasses] },
  { target: "provider:test", source_classes: [...allSourceClasses] },
]): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-record-"));
  const path = join(directory, "vault.sqlite");
  const database = new AgentMemoryDatabase(path, { extraction_enabled: false });
  const binding = createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "memory-record-test" },
    host_instance_id: "memory-record-host",
    host_session_id: "memory-record-session",
    allowed_scope_ids: [scopeA, scopeB],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:test"] },
  });
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeA, scopeB],
    allowed_output_targets: ["reader:codex_cli", "provider:test"],
  });
  for (const scopeId of [scopeA, scopeB]) {
    database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: `owner-${scopeId}`, created_at: "2026-09-15T08:00:00Z" });
    database.registerSession(scopeId, binding, "2026-09-15T08:00:01Z");
    setScopeOutputGrants(database, policy, scopeId, grants, "2026-09-15T08:00:02Z");
  }
  return { directory, path, database, binding, policy };
}

function source(fixtureValue: Fixture, scopeId: string, text: string, stage: "prompt_submitted" | "assistant_final" = "assistant_final"): Source {
  const captureId = randomUUID();
  const spanId = randomUUID();
  capture({
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: fixtureValue.binding.host_kind,
      surface: fixtureValue.binding.surface,
      execution_domain: fixtureValue.binding.execution_domain,
      host_instance_id: fixtureValue.binding.host_instance_id,
      host_session_id: fixtureValue.binding.host_session_id,
    },
    adapter_version: "0.1.0",
    event: {
      stage,
      role: stage === "prompt_submitted" ? "user" : "assistant",
      evidence_class: stage === "prompt_submitted" ? "prompt" : "assistant_output",
      native_ids: { session_id: "native", turn_id: captureId },
      text,
    },
    payload: { text },
    captured_at: "2026-09-15T08:01:00Z",
    occurred_at: "2026-09-15T08:01:00Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  }, fixtureValue.binding, fixtureValue.database, {
    source_spans: [{ span_id: spanId, root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length, digest: digest(text) }],
  });
  return { captureId, spanId };
}

function recordInput(scopeId: string, sourceIds: readonly string[], overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    scope_id: scopeId,
    key: "release-mode",
    kind: "decision",
    summary: "Use the local release path.",
    next_steps: ["Run the smoke check."],
    source_ids: [...sourceIds],
    ...overrides,
  };
}

function output(fixtureValue: Fixture, scopeId: string, target: "reader:codex_cli" | "provider:test" = "reader:codex_cli"): PolicyOutputBinding {
  return createPolicyOutputBinding(fixtureValue.policy, {
    version: 1,
    output_binding_id: randomUUID(),
    setup_id: fixtureValue.policy.setup_id,
    scope_id: scopeId,
    target,
  });
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
  throw new Error("expected StoreError");
}

function scalar(path: string, sql: string, ...parameters: string[]): bigint {
  const raw = new DatabaseSync(path, { readBigInts: true });
  try {
    return (raw.prepare(sql).get(...parameters) as { count: bigint }).count;
  } finally {
    raw.close();
  }
}

function spanIds(path: string, captureId: string): readonly string[] {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("SELECT span_id FROM source_span WHERE source_id = ? ORDER BY span_id").all(captureId)
      .map((row) => String((row as { span_id: unknown }).span_id));
  } finally {
    raw.close();
  }
}

function close(fixtureValue: Fixture): void {
  if (!fixtureValue.database.isClosed()) fixtureValue.database.close();
  rmSync(fixtureValue.directory, { recursive: true, force: true });
}

test("writes a redacted source record with bounded citations and reader-only egress", () => {
  const value = fixture();
  try {
    const prompt = source(value, scopeA, "user release request", "prompt_submitted");
    const answer = source(value, scopeA, "assistant release answer");
    const jobsBefore = scalar(value.path, "SELECT COUNT(*) AS count FROM job");
    const record = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [prompt.captureId, answer.captureId], {
      summary: "Use api_key=sk-1234567890 <private>never persist this</private> for the local release path.",
    }));

    assert.equal(record.kind, "search_enrichment");
    assert.equal(record.purpose, "current");
    assert.deepEqual(record.egress_targets, ["reader:codex_cli"]);
    assert.deepEqual(record.temporal_domain, { version: 1, status: "definite", intervals: [{ from: null, to: null }] });
    assert.equal(record.dependencies.length, 2);
    for (const citedSource of [prompt, answer]) {
      const citedSpanIds = spanIds(value.path, citedSource.captureId);
      assert.equal(record.dependencies.filter((dependency) => citedSpanIds.includes(dependency.parent_revision_id)).length, 1);
    }
    assert.equal(record.dependencies.every((dependency) => dependency.parent_type === "source_span" && dependency.relation === "supports"), true);

    const stored = JSON.parse(record.content) as Record<string, unknown>;
    assert.equal(stored.format, "agent_memory_record_v1");
    assert.equal(stored.origin, "agent_report");
    assert.equal(stored.verified, undefined);
    assert.equal(JSON.stringify(stored).includes("sk-1234567890"), false);
    assert.equal(JSON.stringify(stored).includes("never persist this"), false);
    assert.equal(scalar(value.path, "SELECT COUNT(*) AS count FROM job"), jobsBefore);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA), { known_at_seq: (BigInt(record.created_commit_seq) - 1n).toString() }), []);
    assert.equal(value.database.summaries.listSourceRecords(output(value, scopeA), { limit: 1 }).length, 1);
    assert.equal(errorCode(() => value.database.summaries.listSourceRecords(output(value, scopeA), { limit: 51 })), "read_failed");
    assert.equal(value.database.summaries.read(output(value, scopeA), record.revision_id)?.content, record.content);
    assert.equal(value.database.summaries.read(output(value, scopeA, "provider:test"), record.revision_id), undefined);
  } finally {
    close(value);
  }
});

test("requires a head CAS replacement, keeps superseded rows, and retries without a commit", () => {
  const value = fixture();
  try {
    const firstSource = source(value, scopeA, "first answer");
    const secondSource = source(value, scopeA, "second answer");
    const firstInput = recordInput(scopeA, [firstSource.captureId]);
    const first = value.database.summaries.writeSourceRecord(value.binding, firstInput);
    const beforeRetry = scalar(value.path, "SELECT commit_seq AS count FROM vault_counter WHERE id = 1");
    const retry = value.database.summaries.writeSourceRecord(value.binding, firstInput);
    assert.equal(retry.revision_id, first.revision_id);
    assert.equal(scalar(value.path, "SELECT commit_seq AS count FROM vault_counter WHERE id = 1"), beforeRetry);

    const second = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [secondSource.captureId], {
      summary: "Use the second answer.",
      replaces: first.revision_id,
    }));
    const old = value.database.summaries.read(output(value, scopeA), first.revision_id);
    assert.equal(old?.status, "blocked");
    assert.equal(old?.status_reason, "record_superseded");
    assert.notEqual(old?.invalidated_commit_seq, null);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA)).map((entry) => entry.revision_id), [second.revision_id]);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA), { include_history: true }).map((entry) => entry.revision_id), [second.revision_id, first.revision_id]);
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [secondSource.captureId], { summary: "third answer" }))), "revision_conflict");
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [secondSource.captureId], { summary: "third answer", replaces: first.revision_id }))), "revision_conflict");
  } finally {
    close(value);
  }
});

test("merges new citations for same-content records while preserving immutable CAS and retry idempotency", () => {
  const value = fixture();
  try {
    const firstSource = source(value, scopeA, "first answer");
    const secondSource = source(value, scopeA, "second answer");
    const input = recordInput(scopeA, [firstSource.captureId]);
    const first = value.database.summaries.writeSourceRecord(value.binding, input);
    const mergeInput = recordInput(scopeA, [firstSource.captureId, secondSource.captureId], { replaces: first.revision_id });
    const merged = value.database.summaries.writeSourceRecord(value.binding, mergeInput);
    assert.notEqual(merged.revision_id, first.revision_id);
    assert.deepEqual((JSON.parse(merged.content) as MemoryRecordInput).source_ids, [firstSource.captureId, secondSource.captureId]);
    assert.equal(merged.dependencies.filter((dependency) => dependency.parent_type === "source_span").length, 2);
    assert.equal(merged.dependencies.some((dependency) => dependency.parent_revision_id === spanIds(value.path, firstSource.captureId)[0]), true);
    assert.equal(merged.dependencies.some((dependency) => dependency.parent_revision_id === spanIds(value.path, secondSource.captureId)[0]), true);
    assert.equal(value.database.summaries.read(output(value, scopeA), first.revision_id)?.status_reason, "record_superseded");

    const beforeRetry = scalar(value.path, "SELECT commit_seq AS count FROM vault_counter WHERE id = 1");
    const retry = value.database.summaries.writeSourceRecord(value.binding, mergeInput);
    assert.equal(retry.revision_id, merged.revision_id);
    assert.equal(scalar(value.path, "SELECT commit_seq AS count FROM vault_counter WHERE id = 1"), beforeRetry);
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, { ...input, summary: "Stale report" })), "revision_conflict");
  } finally {
    close(value);
  }
});

test("rejects cross-scope sources and cannot read or write through a revoked assistant grant", () => {
  const value = fixture();
  try {
    const foreign = source(value, scopeB, "foreign answer");
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [foreign.captureId]))), "scope_not_allowed");

    const prompt = source(value, scopeA, "user-only evidence", "prompt_submitted");
    const record = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [prompt.captureId]));
    setScopeOutputGrants(value.database, value.policy, scopeA, [{ target: "reader:codex_cli", source_classes: ["prompt"] }], "2026-09-15T08:02:00Z");
    assert.equal(value.database.summaries.read(output(value, scopeA), record.revision_id), undefined);
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [prompt.captureId], { key: "new-key" }))), "output_not_allowed");
  } finally {
    close(value);
  }
});

test("purging a cited source deletes its record and does not resurrect an older head", () => {
  const value = fixture();
  try {
    const firstSource = source(value, scopeA, "first answer");
    const purgedSource = source(value, scopeA, "purged answer");
    const first = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [firstSource.captureId]));
    const second = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [purgedSource.captureId], { summary: "The purged head.", replaces: first.revision_id }));
    const result = purgeSource(value.database, value.policy, {
      version: 1,
      operation_id: randomUUID(),
      scope_id: scopeA,
      capture_ids: [purgedSource.captureId],
      expected_privacy_epoch: value.database.getScopePrivacyEpoch(scopeA),
      requested_at: "2026-09-15T08:03:00Z",
    });
    assert.equal(result.physical_cleanup, "complete");
    assert.equal(value.database.summaries.read(output(value, scopeA), second.revision_id), undefined);
    assert.equal(scalar(value.path, "SELECT COUNT(*) AS count FROM derived_artifact WHERE revision_id = ?", second.revision_id), 0n);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA)).map((entry) => entry.revision_id), []);
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [firstSource.captureId], { summary: "Stale implicit resurrection" }))), "revision_conflict");
    assert.equal(errorCode(() => value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [firstSource.captureId], { summary: "Stale explicit replacement", replaces: first.revision_id }))), "revision_conflict");
    const replacement = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [firstSource.captureId], { key: "new-record-key", summary: "Explicit new key after purge" }));
    assert.equal(replacement.status, "active");
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA)).map((entry) => entry.revision_id), [replacement.revision_id]);
  } finally {
    close(value);
  }
});

test("filters unreadable source records before the bounded list limit", () => {
  const value = fixture();
  try {
    const readableSource = source(value, scopeA, "readable assistant answer");
    const readable = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [readableSource.captureId], { key: "Überweisung-alt", summary: "Überweisung older record" }));
    for (let index = 0; index < 50; index += 1) {
      const unreadableSource = source(value, scopeA, `user-only evidence ${index}`, "prompt_submitted");
      value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [unreadableSource.captureId], { key: `unreadable-${index}` }));
    }
    setScopeOutputGrants(value.database, value.policy, scopeA, [{ target: "reader:codex_cli", source_classes: ["assistant_output"] }], "2026-09-15T08:04:00Z");
    assert.equal(value.database.summaries.read(output(value, scopeA), readable.revision_id)?.status, "active");
    const records = value.database.summaries.listSourceRecords(output(value, scopeA));
    assert.deepEqual(records.map((entry) => entry.revision_id), [readable.revision_id]);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA), { query_terms: ["überweisung"], limit: 1 }).map((entry) => entry.revision_id), [readable.revision_id]);
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA), { source_ids: [readableSource.captureId], limit: 1 }).map((entry) => entry.revision_id), [readable.revision_id]);
  } finally {
    close(value);
  }
});

test("keeps German umlauts distinct before relevance limiting", () => {
  const value = fixture();
  try {
    const oldSource = source(value, scopeA, "older assistant evidence");
    const oldRecord = value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [oldSource.captureId], {
      key: "Schön-alt",
      summary: "Schön older record",
    }));
    for (let index = 0; index < 50; index += 1) {
      const noiseSource = source(value, scopeA, `newer assistant evidence ${index}`);
      value.database.summaries.writeSourceRecord(value.binding, recordInput(scopeA, [noiseSource.captureId], {
        key: `noise-${index}`,
        summary: "Schon newer noise",
      }));
    }
    assert.deepEqual(value.database.summaries.listSourceRecords(output(value, scopeA), { query_terms: ["schön"], limit: 1 }).map((entry) => entry.revision_id), [oldRecord.revision_id]);
  } finally {
    close(value);
  }
});
