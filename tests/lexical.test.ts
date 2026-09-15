import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture, prepareCaptureInput, type SourceSpanInput } from "../src/core/capture.js";
import { createPolicyOutputBinding, createPolicySetupBinding, setScopeOutputGrants, type PolicySetupBinding } from "../src/core/policy.js";
import {
  createTrustedBinding,
  type RecallRequest,
  type TrustedBinding,
} from "../src/host/contract.js";
import { AgentMemoryDatabase, APPLICATION_ID, CURRENT_SCHEMA_VERSION } from "../src/store/database.js";
import { LexicalSearchError, lexicalSearch } from "../src/retrieval/lexical.js";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bindingFor(scopeIds: readonly string[] = [scopeA]): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "lexical-test" },
    host_instance_id: "lexical-host",
    host_session_id: "lexical-session",
    allowed_scope_ids: [...scopeIds],
    egress: {
      reader_targets: ["reader:codex_cli"],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function envelope(
  captureId: string,
  scopeId: string,
  payloadText: string,
  eventText: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "lexical-test" },
      host_instance_id: "lexical-host",
      host_session_id: "lexical-session",
    },
    adapter_version: "0.1.0",
    event: {
      stage: "prompt_submitted",
      role: "user",
      evidence_class: "prompt",
      native_ids: { session_id: "native-session", turn_id: captureId },
      text: eventText,
    },
    payload: { text: payloadText, marker: "synthetic" },
    captured_at: "2026-09-07T08:00:00Z",
    occurred_at: "2026-09-07T07:59:59Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
    ...overrides,
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function span(
  spanId: string,
  root: "payload" | "event",
  path: string,
  text: string,
  start = 0,
  end = text.length,
): SourceSpanInput {
  return { span_id: spanId, root, path, start_utf16: start, end_utf16: end, digest: digest(text.slice(start, end)) };
}

function request(scopeIds: readonly string[], query: string, overrides: Partial<RecallRequest> = {}): RecallRequest {
  return {
    query,
    scope_ids: [...scopeIds],
    mode: "current",
    token_budget: 200,
    ...overrides,
  };
}

function setup(scopeIds: readonly string[] = [scopeA]): {
  directory: string;
  path: string;
  database: AgentMemoryDatabase;
  binding: TrustedBinding;
  policy: PolicySetupBinding;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-lexical-"));
  const path = join(directory, "vault.sqlite");
  const database = new AgentMemoryDatabase(path);
  const binding = bindingFor(scopeIds);
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: "abababab-abab-4bab-8bab-abababababab",
    allowed_scope_ids: [...scopeIds],
    allowed_output_targets: ["reader:codex_cli"],
  });
  for (const scopeId of scopeIds) {
    database.registerScope({
      scope_id: scopeId,
      kind: "project",
      owner_ref: `owner-${scopeId}`,
      created_at: "2026-09-07T07:00:00Z",
    });
    database.registerSession(scopeId, binding, "2026-09-07T07:00:00Z");
    setScopeOutputGrants(
      database,
      policy,
      scopeId,
      [{ target: "reader:codex_cli", source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }],
      "2026-09-07T07:01:00Z",
    );
  }
  return { directory, path, database, binding, policy };
}

function outputBinding(policy: PolicySetupBinding, scopeId = scopeA) {
  return createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd",
    setup_id: policy.setup_id,
    scope_id: scopeId,
    target: "reader:codex_cli",
  });
}

function sourceSpans(database: AgentMemoryDatabase, policy: PolicySetupBinding, captureId: string) {
  return database.getSourceSpansForOutput(captureId, outputBinding(policy));
}

function closeSetup(directory: string, database: AgentMemoryDatabase): void {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}

function grantReaderForMigratedScope(database: AgentMemoryDatabase): PolicySetupBinding {
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
    allowed_scope_ids: [scopeA],
    allowed_output_targets: ["reader:codex_cli"],
  });
  setScopeOutputGrants(
    database,
    policy,
    scopeA,
    [{ target: "reader:codex_cli", source_classes: ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] }],
    "2026-09-07T07:01:00Z",
  );
  return policy;
}

test("indexes exact payload and event roots and hydrates canonical UTF-16 quotes", () => {
  const { directory, database, binding, policy } = setup();
  try {
    const payload = "Payload🦄 needle";
    const event = "Event needle differs";
    const captureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    capture(
      envelope(captureId, scopeA, payload, event),
      binding,
      database,
      { source_spans: [span("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "payload", "/text", payload)] },
    );

    const results = lexicalSearch(database, binding, request([scopeA], "needle"), 10);
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((result) => ({ root: result.root, quote: result.quote, path: result.path })).sort((a, b) => a.root.localeCompare(b.root)),
      [
        { root: "event", quote: event, path: "/text" },
        { root: "payload", quote: payload, path: "/text" },
      ],
    );
    assert.equal(results.every((result) => result.lexical_match === true), true);
    assert.equal(results.some((result) => result.quote.includes("🦄")), true);
    assert.equal(sourceSpans(database, policy, captureId).length, 2);
  } finally {
    closeSetup(directory, database);
  }
});

test("derives a stable event span after fingerprinting and replay remains idempotent", () => {
  const { directory, database, binding, policy } = setup();
  try {
    const input = envelope(
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      scopeA,
      "payload only",
      "event text with replay needle",
    );
    const first = capture(input, binding, database);
    const firstSpans = sourceSpans(database, policy, first.capture_id);
    assert.equal(firstSpans.length, 1);
    assert.equal(firstSpans[0]?.root, "event");
    const firstResults = lexicalSearch(database, binding, request([scopeA], "replay"), 10);
    assert.equal(firstResults.length, 1);

    assert.deepEqual(capture(input, binding, database), first);
    assert.deepEqual(sourceSpans(database, policy, first.capture_id), firstSpans);
    assert.equal(lexicalSearch(database, binding, request([scopeA], "replay"), 10).length, 1);
  } finally {
    closeSetup(directory, database);
  }
});

test("keeps omitted and explicit payload roots on the same legacy capture fingerprint", () => {
  const { directory, database, binding } = setup();
  try {
    const input = envelope("abababab-abab-4bab-8bab-abababababab", scopeA, "payload compatibility", "event compatibility");
    const digestValue = digest("payload compatibility");
    const omittedRoot = prepareCaptureInput(input, binding, {
      source_spans: [{ span_id: "acacacac-acac-4cac-8cac-acacacacacac", path: "/text", start_utf16: 0, end_utf16: "payload compatibility".length, digest: digestValue }],
    });
    const explicitPayloadRoot = prepareCaptureInput(input, binding, {
      source_spans: [{ span_id: "acacacac-acac-4cac-8cac-acacacacacac", root: "payload", path: "/text", start_utf16: 0, end_utf16: "payload compatibility".length, digest: digestValue }],
    });
    assert.equal(omittedRoot.fingerprint, explicitPayloadRoot.fingerprint);
    assert.deepEqual(database.commitCapture(omittedRoot), database.commitCapture(explicitPayloadRoot));
  } finally {
    closeSetup(directory, database);
  }
});

test("preserves compatibility forms between query and index for opaque identifiers", () => {
  const { directory, database, binding } = setup();
  try {
    const sourceText = "ＡＢＣ opaque identifier";
    capture(
      envelope("adadadad-adad-4dad-8dad-adadadadadad", scopeA, sourceText, "unrelated event"),
      binding,
      database,
      { source_spans: [span("aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae", "payload", "/text", sourceText)] },
    );
    const exact = lexicalSearch(database, binding, request([scopeA], "ＡＢＣ"), 10);
    assert.equal(exact.length, 1);
    assert.equal(exact[0]?.quote, sourceText);
    assert.equal(lexicalSearch(database, binding, request([scopeA], "ABC"), 10).length, 0);
  } finally {
    closeSetup(directory, database);
  }
});

test("migrates a complete v1 vault through auth v2 and search v3 and backfills valid stored spans", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-lexical-migration-"));
  const path = join(directory, "legacy.sqlite");
  const captureId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const text = "legacy migration needle";
  const legacy = new DatabaseSync(path, { readBigInts: true });
  try {
    legacy.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
    legacy.exec(readFileSync(new URL("./fixtures/vault-v1.sql", import.meta.url), "utf8"));
    legacy
      .prepare("INSERT INTO scope (scope_id, kind, owner_ref, data_epoch, privacy_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scopeA, "project", "legacy-owner", 1n, 0n, "2026-09-07T07:00:00Z");
    legacy
      .prepare(
        `INSERT INTO session (
           session_id, scope_id, host_kind, surface, execution_domain_kind, execution_domain_id,
           host_instance_id, host_session_id, started_at, coverage
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(sessionId, scopeA, "codex", "codex_cli", "local", "lexical-test", "lexical-host", "lexical-session", "2026-09-07T07:00:00Z");
    legacy
      .prepare(
        `INSERT INTO source_event (
           capture_id, scope_id, session_id, fingerprint, adapter_version, observed_stage, role,
           evidence_class, captured_at, occurred_at, payload_json, event_json, truncation_json,
           redaction_json, coverage_json, commit_seq, data_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        captureId,
        scopeA,
        sessionId,
        "a".repeat(64),
        "0.1.0",
        "prompt_submitted",
        "user",
        "prompt",
        "2026-09-07T08:00:00Z",
        "2026-09-07T07:59:59Z",
        JSON.stringify({ text }),
        JSON.stringify({ stage: "prompt_submitted", role: "user", evidence_class: "prompt", native_ids: {} }),
        JSON.stringify({ truncated: false }),
        JSON.stringify({ applied: true, policy_version: "1.0.0" }),
        JSON.stringify({ status: "complete", stages: ["prompt_submitted"], truncated: false }),
        1n,
        1n,
      );
    legacy
      .prepare("INSERT INTO source_span (span_id, source_id, scope_id, path, start_utf16, end_utf16, digest) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("12121212-1212-4121-8121-121212121212", captureId, scopeA, "/text", 0n, BigInt(text.length), digest(text));
    legacy
      .prepare(
        `INSERT INTO job (
           job_id, scope_id, source_capture_id, task_kind, task_version, state, dedupe_key,
           attempts, next_at, owner, lease_until, fence, created_commit_seq
         ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, 0, NULL, NULL, NULL, 0, ?)`
      )
      .run("23232323-2323-4232-8232-232323232323", scopeA, captureId, "extract-v1", "b".repeat(64), 1n);
    legacy.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1").run(1n, 1n);
  } finally {
    legacy.close();
  }

  try {
    const database = new AgentMemoryDatabase(path);
    try {
      const binding = bindingFor();
    assert.equal(database.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
      const policy = grantReaderForMigratedScope(database);
      assert.equal(sourceSpans(database, policy, captureId)[0]?.root, "payload");
      const results = lexicalSearch(database, binding, request([scopeA], "migration"), 10);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.quote, text);
      assert.deepEqual(database.getCounter(), { commit_seq: "1", data_epoch: "1" });
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a legacy source with no caller spans, derives event text, and keeps replay idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-lexical-zero-span-"));
  const path = join(directory, "legacy.sqlite");
  const captureId = "efefefef-efef-4efe-8fef-efefefefefef";
  const sessionId = "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0";
  const sourceText = "legacy zero span needle";
  const input = envelope(captureId, scopeA, sourceText, sourceText);
  const binding = bindingFor();
  const prepared = prepareCaptureInput(input, binding);
  const legacy = new DatabaseSync(path, { readBigInts: true });
  try {
    legacy.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`);
    legacy.exec(readFileSync(new URL("./fixtures/vault-v1.sql", import.meta.url), "utf8"));
    legacy
      .prepare("INSERT INTO scope (scope_id, kind, owner_ref, data_epoch, privacy_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(scopeA, "project", "legacy-zero-owner", 1n, 0n, "2026-09-07T07:00:00Z");
    legacy
      .prepare(
        `INSERT INTO session (
           session_id, scope_id, host_kind, surface, execution_domain_kind, execution_domain_id,
           host_instance_id, host_session_id, started_at, coverage
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(sessionId, scopeA, "codex", "codex_cli", "local", "lexical-test", "lexical-host", "lexical-session", "2026-09-07T07:00:00Z");
    const nativeIds = prepared.envelope.event.native_ids;
    legacy
      .prepare(
        `INSERT INTO source_event (
           capture_id, scope_id, session_id, fingerprint, adapter_version, observed_stage, role,
           evidence_class, native_session_id, native_turn_id, native_message_id, native_part_id,
           native_tool_call_id, captured_at, occurred_at, payload_json, event_json, truncation_json,
           redaction_json, coverage_json, commit_seq, data_epoch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        captureId,
        scopeA,
        sessionId,
        prepared.fingerprint,
        prepared.envelope.adapter_version,
        prepared.envelope.event.stage,
        prepared.envelope.event.role,
        prepared.envelope.event.evidence_class,
        nativeIds.session_id ?? null,
        nativeIds.turn_id ?? null,
        nativeIds.message_id ?? null,
        nativeIds.part_id ?? null,
        nativeIds.tool_call_id ?? null,
        prepared.envelope.captured_at,
        prepared.envelope.occurred_at ?? null,
        JSON.stringify(prepared.envelope.payload),
        JSON.stringify(prepared.envelope.event),
        JSON.stringify(prepared.envelope.truncation),
        JSON.stringify(prepared.envelope.redaction),
        JSON.stringify({ status: "complete", stages: ["prompt_submitted"], truncated: false }),
        1n,
        1n,
      );
    legacy
      .prepare(
        `INSERT INTO job (
           job_id, scope_id, source_capture_id, task_kind, task_version, state, dedupe_key,
           attempts, next_at, owner, lease_until, fence, created_commit_seq
         ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, 0, NULL, NULL, NULL, 0, ?)`
      )
      .run("f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1", scopeA, captureId, "extract-v1", "b".repeat(64), 1n);
    legacy.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1").run(1n, 1n);
  } finally {
    legacy.close();
  }

  try {
    const database = new AgentMemoryDatabase(path);
    const policy = grantReaderForMigratedScope(database);
    try {
      assert.equal(sourceSpans(database, policy, captureId).length, 1);
      assert.equal(sourceSpans(database, policy, captureId)[0]?.root, "event");
      assert.equal(lexicalSearch(database, binding, request([scopeA], "zero"), 10)[0]?.quote, sourceText);
      assert.deepEqual(capture(input, binding, database), {
        version: 1,
        capture_id: captureId,
        commit_seq: "1",
        coverage: { status: "complete", stages: ["prompt_submitted"], truncated: false },
      });
      assert.equal(sourceSpans(database, policy, captureId).length, 1);
      database.close();
    } finally {
      if (!database.isClosed()) database.close();
    }
    const reopened = new AgentMemoryDatabase(path);
    try {
      assert.equal(sourceSpans(reopened, policy, captureId).length, 1);
      assert.equal(lexicalSearch(reopened, binding, request([scopeA], "zero"), 10)[0]?.quote, sourceText);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applies scope and eligibility before LIMIT and ignores MATCH punctuation/operators", () => {
  const { directory, database, binding } = setup([scopeA, scopeB]);
  try {
    capture(
      envelope("34343434-3434-4343-8343-343434343434", scopeA, "needle allowed result", "event A"),
      binding,
      database,
      { source_spans: [span("30303030-3030-4030-8030-303030303030", "payload", "/text", "needle allowed result")] },
    );
    capture(
      envelope("45454545-4545-4454-8454-454545454545", scopeB, "needle needle forbidden result", "event B"),
      binding,
      database,
      { source_spans: [span("40404040-4040-4040-8040-404040404040", "payload", "/text", "needle needle forbidden result")] },
    );

    const onlyA = lexicalSearch(database, bindingFor([scopeA]), request([scopeA], 'needle"'), 1);
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0]?.scope_id, scopeA);
    assert.match(onlyA[0]?.quote ?? "", /allowed/);
    assert.throws(
      () => lexicalSearch(database, bindingFor([scopeA]), request([scopeB], "needle"), 10),
      /scope_not_allowed/,
    );
    assert.equal(lexicalSearch(database, bindingFor([scopeA]), request([scopeA], "!!! --- ()"), 10).length, 0);
  } finally {
    closeSetup(directory, database);
  }
});

test("keeps FTS insert/update/delete trigger state transactional and immediate", () => {
  const { directory, path, database, binding } = setup();
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    const captureId = "56565656-5656-4565-8565-565656565656";
    capture(envelope(captureId, scopeA, "trigger needle", "trigger event"), binding, database);
    const before = lexicalSearch(database, binding, request([scopeA], "trigger"), 10);
    assert.equal(before.length, 1);
    const row = raw.prepare("SELECT span_id, text FROM search_document WHERE source_id = ?").get(captureId) as Record<string, unknown>;
    const spanId = String(row.span_id);
    const originalText = String(row.text);

    raw.prepare("UPDATE search_document SET text = ? WHERE span_id = ?").run("updated needle", spanId);
    const updatedFts = raw.prepare("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?").get('"updated"') as Record<string, unknown>;
    assert.equal(updatedFts.count, 1n);
    raw.prepare("UPDATE search_document SET text = ? WHERE span_id = ?").run(originalText, spanId);

    raw.exec("BEGIN IMMEDIATE");
    raw.prepare("DELETE FROM search_document WHERE span_id = ?").run(spanId);
    assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?").get('"trigger"') as Record<string, unknown>).count, 0n);
    raw.exec("ROLLBACK");
    assert.equal(lexicalSearch(database, binding, request([scopeA], "trigger"), 10).length, 1);

    raw.prepare("DELETE FROM search_document WHERE span_id = ?").run(spanId);
    assert.equal(lexicalSearch(database, binding, request([scopeA], "trigger"), 10).length, 0);
  } finally {
    raw.close();
    closeSetup(directory, database);
  }
});

test("fails closed when an indexed span no longer matches canonical source text", () => {
  const { directory, path, database, binding } = setup();
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    const captureId = "67676767-6767-4676-8676-676767676767";
    capture(envelope(captureId, scopeA, "corrupt needle", "corrupt event"), binding, database);
    const spanId = String((raw.prepare("SELECT span_id FROM search_document WHERE source_id = ?").get(captureId) as Record<string, unknown>).span_id);
    raw.prepare("UPDATE source_span SET digest = ? WHERE span_id = ?").run("0".repeat(64), spanId);
    assert.throws(
      () => lexicalSearch(database, binding, request([scopeA], "corrupt"), 10),
      (error: unknown) => error instanceof LexicalSearchError && error.code === "source_span_invalid",
    );
  } finally {
    raw.close();
    closeSetup(directory, database);
  }
});

test("fails closed when an indexed span row is missing", () => {
  const { directory, path, database, binding } = setup();
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    const captureId = "68686868-6868-4686-8686-686868686868";
    capture(envelope(captureId, scopeA, "missing needle", "missing event"), binding, database);
    const spanId = String((raw.prepare("SELECT span_id FROM search_document WHERE source_id = ?").get(captureId) as Record<string, unknown>).span_id);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.prepare("DELETE FROM source_span WHERE span_id = ?").run(spanId);
    raw.exec("PRAGMA foreign_keys = ON");
    assert.throws(
      () => lexicalSearch(database, binding, request([scopeA], "missing"), 10),
      (error: unknown) => error instanceof LexicalSearchError && error.code === "source_span_missing",
    );
  } finally {
    raw.close();
    closeSetup(directory, database);
  }
});

test("applies known-at bounds while preserving raw sources when valid-at is supplied", () => {
  const { directory, database, binding } = setup();
  try {
    const first = capture(
      envelope("78787878-7878-4787-8787-787878787878", scopeA, "first bounded needle", "first event", {
        captured_at: "2026-09-07T08:00:00Z",
        occurred_at: "2026-09-07T07:59:00Z",
      }),
      binding,
      database,
      { source_spans: [span("70707070-7070-4070-8070-707070707070", "payload", "/text", "first bounded needle")] },
    );
    const secondEnvelope = envelope("89898989-8989-4898-8898-898989898989", scopeA, "second bounded needle", "second event", {
      captured_at: "2026-09-07T09:00:00Z",
    }) as Record<string, unknown>;
    delete secondEnvelope.occurred_at;
    capture(
      secondEnvelope,
      binding,
      database,
      { source_spans: [span("80808080-8080-4080-8080-808080808080", "payload", "/text", "second bounded needle")] },
    );
    const known = lexicalSearch(database, binding, request([scopeA], "bounded", { known_at_seq: first.commit_seq }), 10);
    assert.equal(known.length, 1);
    assert.match(known[0]?.quote ?? "", /first/);
    const valid = lexicalSearch(
      database,
      binding,
      request([scopeA], "bounded", {
        valid_at: "2026-09-07T07:30:00Z",
        known_at_seq: "2",
        mode: "historical",
      }),
      10,
    );
    assert.equal(valid.length, 2);
    assert.deepEqual(valid.map((result) => result.quote).sort(), ["first bounded needle", "second bounded needle"]);
  } finally {
    closeSetup(directory, database);
  }
});

test("rejects untrusted or unscoped recall at the database search boundary", () => {
  const { directory, database, binding } = setup();
  try {
    assert.throws(() => lexicalSearch(database, { ...binding }, request([scopeA], "needle"), 10), /binding_not_trusted/);
    assert.throws(() => lexicalSearch(database, binding, { query: "needle", scope_ids: [], mode: "current", token_budget: 1 }, 10), /too_small/);
  } finally {
    closeSetup(directory, database);
  }
});

test("does not accept invalid numeric limits", () => {
  const { directory, database, binding } = setup();
  try {
    assert.throws(() => lexicalSearch(database, binding, request([scopeA], "needle"), 0), /limit/);
    assert.throws(() => lexicalSearch(database, binding, request([scopeA], "needle"), 201), /limit/);
  } finally {
    closeSetup(directory, database);
  }
});
