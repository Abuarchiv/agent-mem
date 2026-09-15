import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import {
  createPolicyOutputBinding,
  createPolicySetupBinding,
  readSourceForOutput,
  setScopeOutputGrants,
  type PolicyOutputBinding,
  type PolicySetupBinding,
} from "../src/core/policy.js";
import { pauseCapture, resumeCapture } from "../src/core/pause.js";
import { purgeSource } from "../src/core/purge-source.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { lexicalSearch } from "../src/retrieval/lexical.js";
import { AgentMemoryDatabase, StoreError } from "../src/store/database.js";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const allSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

function readerBinding(scopeIds: readonly string[] = [scopeA]): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "purge-test" },
    host_instance_id: "purge-host",
    host_session_id: "purge-session",
    allowed_scope_ids: [...scopeIds],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: ["provider:xp-copilot"] },
  });
}

function setupBinding(scopeIds: readonly string[] = [scopeA], targets: readonly string[] = ["local_ui", "reader:codex_cli", "provider:xp-copilot"]): PolicySetupBinding {
  return createPolicySetupBinding({
    version: 1,
    setup_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    allowed_scope_ids: [...scopeIds],
    allowed_output_targets: [...targets],
  });
}

function outputBinding(setup: PolicySetupBinding, scopeId: string, target: string): PolicyOutputBinding {
  return createPolicyOutputBinding(setup, {
    version: 1,
    output_binding_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    setup_id: setup.setup_id,
    scope_id: scopeId,
    target,
  });
}

function envelope(captureId: string, scopeId: string, text: string): unknown {
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "purge-test" },
      host_instance_id: "purge-host",
      host_session_id: "purge-session",
    },
    adapter_version: "0.1.0",
    event: {
      stage: "prompt_submitted",
      role: "user",
      evidence_class: "prompt",
      native_ids: { session_id: "native-session", turn_id: captureId },
      text,
    },
    payload: { text, marker: "synthetic" },
    captured_at: "2026-09-07T10:00:00Z",
    occurred_at: "2026-09-07T09:59:59Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function setup(scopeIds: readonly string[] = [scopeA]): {
  directory: string;
  path: string;
  database: AgentMemoryDatabase;
  binding: TrustedBinding;
  policy: PolicySetupBinding;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-purge-"));
  const path = join(directory, "vault.sqlite");
  const database = new AgentMemoryDatabase(path);
  const binding = readerBinding(scopeIds);
  const policy = setupBinding(scopeIds);
  for (const scopeId of scopeIds) {
    database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: `owner-${scopeId}`, created_at: "2026-09-07T09:00:00Z" });
    database.registerSession(scopeId, binding, "2026-09-07T09:00:00Z");
    setScopeOutputGrants(database, policy, scopeId, [
      { target: "local_ui", source_classes: [...allSourceClasses] },
      { target: "reader:codex_cli", source_classes: ["prompt"] },
      { target: "provider:xp-copilot", source_classes: ["tool_output"] },
    ], "2026-09-07T09:01:00Z");
  }
  return { directory, path, database, binding, policy };
}

function cleanup(directory: string, database: AgentMemoryDatabase): void {
  if (!database.isClosed()) database.close();
  rmSync(directory, { recursive: true, force: true });
}

test("persists a pause, fences the rejected ID, and allows a deliberately new ID after restart/resume", () => {
  const { directory, path, database, binding, policy } = setup();
  const pausedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const acknowledgedId = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
  try {
    const acknowledgedInput = envelope(acknowledgedId, scopeA, "already acknowledged source");
    const acknowledged = capture(acknowledgedInput, binding, database);
    const pausedEpoch = pauseCapture(database, policy, scopeA, "2026-09-07T10:00:00Z");
    assert.equal(database.isCapturePaused(scopeA), true);
    assert.deepEqual(capture(acknowledgedInput, binding, database), acknowledged);
    assert.throws(
      () => capture(envelope(acknowledgedId, scopeA, "changed body"), binding, database),
      (error: unknown) => error instanceof StoreError && error.code === "capture_conflict",
    );
    const markerCheck = new DatabaseSync(path, { readOnly: true, readBigInts: true });
    try {
      assert.equal(
        (markerCheck.prepare("SELECT COUNT(*) AS count FROM capture_replay_marker WHERE capture_id = ?").get(acknowledgedId) as Record<string, unknown>).count,
        0n,
      );
    } finally {
      markerCheck.close();
    }
    assert.throws(
      () => capture(envelope(pausedId, scopeA, "paused source"), binding, database),
      (error: unknown) => error instanceof StoreError && error.code === "capture_paused",
    );
    database.close();
    const reopened = new AgentMemoryDatabase(path);
    try {
      assert.equal(reopened.isCapturePaused(scopeA), true);
      const markerDb = new DatabaseSync(path, { readOnly: true });
      try {
        const markerColumns = markerDb
          .prepare("PRAGMA table_info(capture_replay_marker)")
          .all()
          .map((row) => String((row as Record<string, unknown>).name));
        assert.equal(markerColumns.includes("fingerprint"), false);
        assert.equal(markerColumns.includes("payload_json"), false);
      } finally {
        markerDb.close();
      }
      assert.throws(
        () => capture(envelope(pausedId, scopeA, "paused source"), binding, reopened),
        (error: unknown) => error instanceof StoreError && error.code === "capture_paused",
      );
      assert.equal(resumeCapture(reopened, policy, scopeA, "2026-09-07T10:00:01Z"), String(Number(pausedEpoch) + 1));
      assert.equal(reopened.isCapturePaused(scopeA), false);
      assert.deepEqual(capture(acknowledgedInput, binding, reopened), acknowledged);
      assert.throws(
        () => capture(envelope(pausedId, scopeA, "paused source"), binding, reopened),
        (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
      );
      const freshAck = capture(envelope("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", scopeA, "new source after resume"), binding, reopened);
      assert.equal(freshAck.commit_seq, "2");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(directory, database);
  }
});

test("keeps local UI, reader, and provider source-class grants independent", () => {
  const { directory, database, binding, policy } = setup();
  try {
    const ack = capture(envelope("f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0", scopeA, "policy source"), binding, database);
    setScopeOutputGrants(database, policy, scopeA, [{ target: "local_ui", source_classes: ["prompt"] }], "2026-09-07T10:00:00Z");
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "local_ui"), ack.capture_id)?.capture_id, ack.capture_id);
    assert.equal(database.getSourceSpansForOutput(ack.capture_id, outputBinding(policy, scopeA, "local_ui")).length, 1);
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "reader:codex_cli"), ack.capture_id), undefined);
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "provider:xp-copilot"), ack.capture_id), undefined);
    assert.throws(
      () => setScopeOutputGrants(database, policy, scopeA, [{ target: "reader:other", source_classes: ["prompt"] }], "2026-09-07T10:00:00Z"),
      (error: unknown) => error instanceof StoreError && error.code === "output_not_allowed",
    );
    assert.throws(
      () => createPolicyOutputBinding(policy, { version: 1, output_binding_id: "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd", setup_id: policy.setup_id, scope_id: scopeA, target: "admin_secret" }),
      /policy_output_invalid/,
    );
    assert.throws(
      () => readSourceForOutput(database, { ...outputBinding(policy, scopeA, "local_ui") }, ack.capture_id),
      (error: unknown) => error instanceof StoreError && error.code === "policy_invalid",
    );
    assert.throws(() => (policy.allowed_scope_ids as string[]).push(scopeB), TypeError);
    assert.throws(() => (policy.allowed_output_targets as string[]).push("reader:other"), TypeError);
    assert.throws(
      () => pauseCapture(database, { ...policy }, scopeA, "2026-09-07T10:00:01Z"),
      (error: unknown) => error instanceof StoreError && error.code === "policy_invalid",
    );
  } finally {
    cleanup(directory, database);
  }
});

test("purges only selected authorized scope content, fences replay, and preserves another scope", () => {
  const { directory, path, database, binding, policy } = setup([scopeA, scopeB]);
  const purgeId = "12121212-1212-4121-8121-121212121212";
  try {
    const deleted = capture(envelope("13131313-1313-4131-8131-131313131313", scopeA, "delete me needle"), binding, database);
    const retained = capture(envelope("14141414-1414-4141-8141-141414141414", scopeB, "retain me needle"), binding, database);
    const expectedEpoch = database.getScopePrivacyEpoch(scopeA);
    const result = purgeSource(database, setupBinding([scopeA]), {
      version: 1,
      operation_id: purgeId,
      scope_id: scopeA,
      capture_ids: [deleted.capture_id],
      expected_privacy_epoch: expectedEpoch,
      requested_at: "2026-09-07T10:00:00Z",
    });
    assert.equal(result.state, "pending");
    assert.equal(database.getPurgeRuntimeState(purgeId).state, "unknown");
    assert.equal(result.physical_cleanup, "complete");
    assert.equal(lexicalSearch(database, binding, { query: "needle", scope_ids: [scopeA], mode: "current", token_budget: 100 }, 10).length, 0);
    assert.equal(lexicalSearch(database, binding, { query: "needle", scope_ids: [scopeB], mode: "current", token_budget: 100 }, 10)[0]?.source_id, retained.capture_id);
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "local_ui"), deleted.capture_id), undefined);
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeB, "local_ui"), retained.capture_id)?.capture_id, retained.capture_id);
    assert.deepEqual(database.purgeSources(setupBinding([scopeA]), {
      operation_id: purgeId,
      scope_id: scopeA,
      capture_ids: [deleted.capture_id],
      expected_privacy_epoch: expectedEpoch,
      requested_at: "2026-09-07T10:00:01Z",
    }), result);
    assert.throws(
      () => capture(envelope(deleted.capture_id, scopeA, "replayed deleted source"), binding, database),
      (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
    );
    database.registerSession(scopeA, binding, "2026-09-07T10:00:02Z");
    assert.equal(capture(envelope("15151515-1515-4151-8151-151515151515", scopeA, "new ID allowed"), binding, database).commit_seq, "3");
    const raw = new DatabaseSync(path, { readOnly: true, readBigInts: true });
    try {
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM purge_tombstone WHERE capture_id = ?").get(deleted.capture_id) as Record<string, unknown>).count, 1n);
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE scope_id = ?").get(scopeB) as Record<string, unknown>).count, 1n);
    } finally {
      raw.close();
    }
  } finally {
    cleanup(directory, database);
  }
});

test("rejects stale epochs, foreign scopes, and malformed operation selections without a barrier", () => {
  const { directory, database, binding, policy } = setup([scopeA, scopeB]);
  try {
    const ack = capture(envelope("16161616-1616-4161-8161-161616161616", scopeA, "protected source"), binding, database);
    const before = database.getScopePrivacyEpoch(scopeA);
    assert.throws(
      () => purgeSource(database, setupBinding([scopeB]), {
        version: 1,
        operation_id: "17171717-1717-4171-8171-171717171717",
        scope_id: scopeA,
        capture_ids: [ack.capture_id],
        expected_privacy_epoch: before,
        requested_at: "2026-09-07T10:00:00Z",
      }),
      (error: unknown) => error instanceof StoreError && error.code === "purge_scope_not_allowed",
    );
    assert.throws(
      () => purgeSource(database, policy, {
        version: 1,
        operation_id: "18181818-1818-4181-8181-181818181818",
        scope_id: scopeA,
        capture_ids: [ack.capture_id],
        expected_privacy_epoch: "0",
        requested_at: "2026-09-07T10:00:00Z",
      }),
      (error: unknown) => error instanceof StoreError && error.code === "purge_epoch_mismatch",
    );
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "local_ui"), ack.capture_id)?.capture_id, ack.capture_id);
    assert.equal(database.isCapturePaused(scopeA), false);
  } finally {
    cleanup(directory, database);
  }
});

test("hides a barrier-protected source while content deletion is pending", () => {
  const { directory, path, database, binding, policy } = setup();
  const purgeId = "23232323-2323-4232-8232-232323232323";
  const triggerDb = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  let triggerClosed = false;
  try {
    const ack = capture(envelope("24242424-2424-4242-8242-242424242424", scopeA, "barrier protected source"), binding, database);
    const request = {
      version: 1 as const,
      operation_id: purgeId,
      scope_id: scopeA,
      capture_ids: [ack.capture_id],
      expected_privacy_epoch: database.getScopePrivacyEpoch(scopeA),
      requested_at: "2026-09-07T10:00:00Z",
    };
    triggerDb.exec("CREATE TRIGGER fail_purge_source BEFORE DELETE ON source_event BEGIN SELECT RAISE(ABORT, 'injected_purge_failure'); END;");
    const pending = purgeSource(database, setupBinding([scopeA]), request);
    assert.equal(pending.state, "pending");
    assert.equal(pending.physical_cleanup, "pending");
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "local_ui"), ack.capture_id), undefined);
    assert.equal(database.getSourceSpansForOutput(ack.capture_id, outputBinding(policy, scopeA, "local_ui")).length, 0);

    triggerDb.exec("DROP TRIGGER fail_purge_source");
    triggerDb.close();
    triggerClosed = true;
    database.recordPurgeRuntimeState(policy, scopeA, purgeId, "test-no-model", "not_required");
    const completed = purgeSource(database, setupBinding([scopeA]), request);
    assert.equal(completed.state, "completed");
    assert.equal(readSourceForOutput(database, outputBinding(policy, scopeA, "local_ui"), ack.capture_id), undefined);
  } finally {
    if (!triggerClosed) triggerDb.close();
    cleanup(directory, database);
  }
});

test("leaves physical cleanup pending behind a reader and completes after close/reopen", () => {
  const { directory, path, database, binding, policy } = setup();
  const purgeId = "19191919-1919-4191-8191-191919191919";
  const reader = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  let readerClosed = false;
  try {
    const ack = capture(envelope("20202020-2020-4020-8020-202020202020", scopeA, "busy cleanup needle"), binding, database);
    reader.exec("BEGIN");
    reader.prepare("SELECT capture_id FROM source_event WHERE capture_id = ?").get(ack.capture_id);
    const request = {
      version: 1 as const,
      operation_id: purgeId,
      scope_id: scopeA,
      capture_ids: [ack.capture_id],
      expected_privacy_epoch: database.getScopePrivacyEpoch(scopeA),
      requested_at: "2026-09-07T10:00:00Z",
    };
    const pending = purgeSource(database, setupBinding([scopeA]), request);
    assert.equal(pending.state, "pending");
    assert.equal(pending.physical_cleanup, "pending");
    reader.exec("ROLLBACK");
    reader.close();
    readerClosed = true;
    database.close();
    const reopened = new AgentMemoryDatabase(path);
    try {
      reopened.recordPurgeRuntimeState(policy, scopeA, request.operation_id, "test-no-model", "not_required");
      const completed = purgeSource(reopened, setupBinding([scopeA]), request);
      assert.equal(completed.state, "completed");
      assert.equal(completed.physical_cleanup, "complete");
      assert.equal(readSourceForOutput(reopened, outputBinding(policy, scopeA, "local_ui"), ack.capture_id), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    if (!readerClosed) {
      try {
        reader.close();
      } catch {
        // Cleanup only; the assertion above covers the pending state.
      }
    }
    cleanup(directory, database);
  }
});
