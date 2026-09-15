import { removeCapturePolicySchema } from "./fixtures/legacy-policy.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { capture, observeNative, prepareCaptureInput } from "../src/core/capture.js";
import {
  createPolicySetupBinding,
  setCapturePaused,
  setScopeCapturePolicy,
  setScopeOutputGrants,
} from "../src/core/policy.js";
import { purgeSource } from "../src/core/purge-source.js";
import { createBackup, restoreBackup } from "../src/store/backup.js";
import { exportTransfer } from "../src/transfer/export.js";
import { importTransfer } from "../src/transfer/import.js";
import { normalizeNativeEvent } from "../src/host/events.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryDatabase, StoreError } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const targetScopeId = "12121212-1212-4121-8121-121212121212";
const setupId = "22222222-2222-4222-8222-222222222222";
const bindingId = "44444444-4444-4444-8444-444444444444";
const nativeBindingId = "55555555-5555-4555-8555-555555555555";
const allClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

function bindingFor(overrides: Partial<Parameters<typeof createTrustedBinding>[0]> = {}): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "capture-policy-test" },
    host_instance_id: "capture-policy-host",
    host_session_id: "capture-policy-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
    ...overrides,
  });
}

function bindingForScope(scope: string, overrides: Partial<Parameters<typeof createTrustedBinding>[0]> = {}): TrustedBinding {
  return bindingFor({ allowed_scope_ids: [scope], ...overrides });
}

function policyBinding() {
  return createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["local_ui", "reader:codex_cli"],
  });
}

function envelope(captureId: string, sourceClass: "prompt" | "assistant_output", text: string, capturedAt = "2099-01-01T00:00:00Z"): unknown {
  const prompt = sourceClass === "prompt";
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "capture-policy-test" },
      host_instance_id: "capture-policy-host",
      host_session_id: "capture-policy-session",
    },
    adapter_version: "1.0.0",
    event: {
      stage: prompt ? "prompt_submitted" : "assistant_final",
      role: prompt ? "user" : "assistant",
      evidence_class: sourceClass,
      native_ids: { session_id: "capture-policy-native-session", turn_id: captureId },
      text,
    },
    payload: { text },
    captured_at: capturedAt,
    occurred_at: capturedAt,
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function setupDatabase(clock: () => string): { readonly dir: string; readonly path: string; readonly db: AgentMemoryDatabase; readonly binding: TrustedBinding; readonly policy: ReturnType<typeof policyBinding> } {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-policy-"));
  const path = join(dir, "vault.sqlite");
  const db = new AgentMemoryDatabase(path, { wall_clock: clock });
  const binding = bindingFor();
  const policy = policyBinding();
  db.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "capture-policy-test", created_at: "2026-09-09T00:00:00Z" });
  db.registerSession(scopeId, binding, "2026-09-09T00:00:00Z");
  setScopeOutputGrants(db, policy, scopeId, [{ target: "local_ui", source_classes: [...allClasses] }], "2026-09-09T00:00:01Z");
  return { dir, path, db, binding, policy };
}

function closeDatabase(dir: string, db: AgentMemoryDatabase): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test("enrollment starts deny-all, stores acceptance time, and exclusion markers do not resurrect", () => {
  let now = "2026-09-09T00:00:00Z";
  const fixture = setupDatabase(() => now);
  const promptId = "66666666-6666-4666-8666-666666666666";
  const assistantId = "77777777-7777-4777-8777-777777777777";
  try {
    assert.deepEqual(fixture.db.getScopeCapturePolicy(scopeId), { enrolled: false, selections: [] });
    const initialEpoch = fixture.db.getScopePrivacyEpoch(scopeId);
    for (const invalid of [
      [{ source_class: "prompt", retention: { mode: "finite" } }],
      [{ source_class: "prompt", retention: { mode: "finite", duration_seconds: 0 } }],
      [
        { source_class: "prompt", retention: { mode: "until_deleted" } },
        { source_class: "prompt", retention: { mode: "until_deleted" } },
      ],
      [{ source_class: "unknown", retention: { mode: "until_deleted" } }],
    ]) {
      assert.throws(() => setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, invalid, now), /policy_capture_invalid/);
    }
    assert.equal(fixture.db.getScopePrivacyEpoch(scopeId), initialEpoch);
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [], now);
    assert.equal(fixture.db.isCapturePaused(scopeId), true);
    assert.throws(
      () => setCapturePaused(fixture.db, fixture.policy, scopeId, false, now),
      (error: unknown) => error instanceof StoreError && error.code === "policy_invalid",
    );

    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [
      { source_class: "prompt", retention: { mode: "until_deleted" } },
    ], now);
    setCapturePaused(fixture.db, fixture.policy, scopeId, false, now);
    const ack = capture(envelope(promptId, "prompt", "accepted"), fixture.binding, fixture.db);
    const raw = new DatabaseSync(fixture.path, { readOnly: true, readBigInts: true });
    try {
      const acceptance = raw.prepare("SELECT accepted_at FROM capture_acceptance WHERE capture_id = ?").get(promptId) as { accepted_at: string };
      assert.equal(acceptance.accepted_at, now);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE capture_id = ?").get(promptId)?.count, 1n);
    } finally {
      raw.close();
    }

    assert.throws(
      () => capture(envelope(assistantId, "assistant_output", "excluded"), fixture.binding, fixture.db),
      (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
    );
    const markerDb = new DatabaseSync(fixture.path, { readOnly: true, readBigInts: true });
    try {
      assert.equal(markerDb.prepare("SELECT reason FROM capture_replay_marker WHERE capture_id = ?").get(assistantId)?.reason, "capture_class_excluded");
      assert.equal(markerDb.prepare("SELECT COUNT(*) AS count FROM source_event WHERE capture_id = ?").get(assistantId)?.count, 0n);
    } finally {
      markerDb.close();
    }

    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [
      { source_class: "prompt", retention: { mode: "until_deleted" } },
      { source_class: "assistant_output", retention: { mode: "until_deleted" } },
    ], now);
    assert.throws(
      () => capture(envelope(assistantId, "assistant_output", "excluded"), fixture.binding, fixture.db),
      (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
    );
    assert.equal(fixture.db.getCaptureState(ack.capture_id)?.source_count, 1n);
  } finally {
    closeDatabase(fixture.dir, fixture.db);
  }
});

test("migrates a real v25 shaped vault into the capture policy schema", () => {
  let now = "2026-09-09T00:30:00Z";
  const fixture = setupDatabase(() => now);
  const captureId = "13131313-1313-4131-8131-131313131313";
  try {
    capture(envelope(captureId, "prompt", "pre-migration"), fixture.binding, fixture.db);
    fixture.db.close();
    const legacy = new DatabaseSync(fixture.path, { readBigInts: true, enableForeignKeyConstraints: false });
    try {
      removeCapturePolicySchema(legacy);
      legacy.prepare("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'").run();
      legacy.exec("PRAGMA user_version = 25");
    } finally {
      legacy.close();
    }
    const migrated = new AgentMemoryDatabase(fixture.path, { wall_clock: () => now });
    try {
      assert.equal(migrated.getSchemaVersion(), 26);
      assert.equal(migrated.getCaptureState(captureId)?.source_count, 1n);
      assert.deepEqual(migrated.getScopeCapturePolicy(scopeId), { enrolled: false, selections: [] });
      const check = new DatabaseSync(fixture.path, { readOnly: true, readBigInts: true });
      try {
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM scope_capture_policy").get()?.count, 0n);
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM capture_acceptance").get()?.count, 0n);
        assert.equal(check.prepare("SELECT COUNT(*) AS count FROM capture_replay_marker").get()?.count, 0n);
      } finally {
        check.close();
      }
    } finally {
      migrated.close();
    }
    for (const invalidVersion of [21, 23]) {
      const invalid = new DatabaseSync(fixture.path, { readBigInts: true });
      try {
        invalid.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(invalidVersion));
        invalid.exec(`PRAGMA user_version = ${invalidVersion}`);
      } finally {
        invalid.close();
      }
      assert.throws(
        () => new AgentMemoryDatabase(fixture.path),
        (error: unknown) => error instanceof StoreError && error.code === "schema_version_mismatch",
      );
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("restore overlays the live capture policy without importing the backup selection", async () => {
  let now = "2026-09-09T00:45:00Z";
  const fixture = setupDatabase(() => now);
  try {
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "prompt", retention: { mode: "finite", duration_seconds: 60 } }], now);
    setCapturePaused(fixture.db, fixture.policy, scopeId, false, now);
    capture(envelope("abababab-abab-4bab-8bab-abababababab", "prompt", "retention snapshot"), fixture.binding, fixture.db);
    const backup = await createBackup(fixture.db, join(fixture.dir, "policy-backup"));
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "assistant_output", retention: { mode: "finite", duration_seconds: 120 } }], now);
    const candidate = await restoreBackup({ backup_path: backup.backup_path, output_path: join(fixture.dir, "policy-candidate.sqlite") }, fixture.db);
    const restored = new DatabaseSync(candidate.output_path, { readOnly: true, readBigInts: true });
    try {
      assert.deepEqual({ ...restored.prepare("SELECT accepted_at, retention_seconds FROM capture_acceptance").get() }, { accepted_at: now, retention_seconds: 60n });
      assert.equal(restored.prepare("SELECT source_class FROM scope_capture_policy WHERE scope_id = ?").get(scopeId)?.source_class, "assistant_output");
      assert.equal(restored.prepare("SELECT capture_policy_enrolled, capture_paused FROM scope_policy WHERE scope_id = ?").get(scopeId)?.capture_policy_enrolled, 1n);
      assert.equal(restored.prepare("SELECT capture_policy_enrolled, capture_paused FROM scope_policy WHERE scope_id = ?").get(scopeId)?.capture_paused, 0n);
    } finally {
      restored.close();
    }
  } finally {
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("the commit boundary rechecks selection for prepared and native observations", () => {
  let now = "2026-09-09T01:00:00Z";
  const fixture = setupDatabase(() => now);
  const preparedId = "88888888-8888-4888-8888-888888888888";
  try {
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [
      { source_class: "prompt", retention: { mode: "until_deleted" } },
    ], now);
    setCapturePaused(fixture.db, fixture.policy, scopeId, false, now);
    const prepared = prepareCaptureInput(envelope(preparedId, "prompt", "prepared"), fixture.binding);
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [
      { source_class: "assistant_output", retention: { mode: "until_deleted" } },
    ], now);
    assert.throws(
      () => fixture.db.commitCapture(prepared),
      (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
    );

    const nativeBinding = bindingFor({
      binding_id: nativeBindingId,
      host_kind: "opencode",
      surface: "opencode_cli",
      execution_domain: { kind: "local", id: "native-capture-policy-test" },
      host_instance_id: "native-capture-policy-host",
      host_session_id: "native-capture-policy-session",
      egress: { reader_targets: ["reader:opencode_cli"], provider_targets: [] },
    });
    const nativePolicy = createPolicySetupBinding({ version: 1, setup_id: "99999999-9999-4999-8999-999999999999", allowed_scope_ids: [scopeId], allowed_output_targets: ["local_ui"] });
    const nativePath = join(fixture.dir, "native-vault.sqlite");
    const nativeDb = new AgentMemoryDatabase(nativePath, { wall_clock: () => now });
    try {
      nativeDb.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "native-capture-policy-test", created_at: "2026-09-09T01:00:00Z" });
      nativeDb.registerSession(scopeId, nativeBinding, now);
      setScopeOutputGrants(nativeDb, nativePolicy, scopeId, [{ target: "local_ui", source_classes: [...allClasses] }], now);
      setScopeCapturePolicy(nativeDb, nativePolicy, scopeId, [{ source_class: "assistant_output", retention: { mode: "until_deleted" } }], now);
      setCapturePaused(nativeDb, nativePolicy, scopeId, false, now);
      const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const nativeEventInput = {
        version: 1,
        capture_id: nativeId,
        scope_id: scopeId,
        adapter_version: "1.0.0",
        stage: "prompt_submitted",
        role: "user",
        evidence_class: "prompt",
        native_ids: { session_id: nativeBinding.host_session_id, turn_id: "native-turn" },
        text: "excluded native prompt",
        payload: { text: "excluded native prompt" },
        captured_at: "2099-01-01T00:00:00Z",
        coverage: { status: "complete" },
      } as const;
      const nativeEvent = normalizeNativeEvent(nativeEventInput, nativeBinding);
      assert.throws(
        () => observeNative(nativeEvent, nativeBinding, nativeDb, { version: 1, identity: { kind: "event", key: "native-event" } }),
        (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
      );
      const nativeRetry = normalizeNativeEvent({ ...nativeEventInput, capture_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, nativeBinding);
      nativeDb.close();
      const reopenedNative = new AgentMemoryDatabase(nativePath, { wall_clock: () => now });
      try {
        assert.throws(
          () => observeNative(nativeRetry, nativeBinding, reopenedNative, { version: 1, identity: { kind: "event", key: "native-event" } }),
          (error: unknown) => error instanceof StoreError && error.code === "capture_rejected",
        );
      } finally {
        reopenedNative.close();
      }
      const raw = new DatabaseSync(nativePath, { readOnly: true, readBigInts: true });
      try {
        assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE capture_id = ?").get(nativeId)?.count, 0n);
        assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM opencode_observation_receipt WHERE capture_id = ?").get(nativeId)?.count, 0n);
      } finally {
        raw.close();
      }
    } finally {
      nativeDb.close();
    }
  } finally {
    closeDatabase(fixture.dir, fixture.db);
  }
});

test("finite retention uses store acceptance time and remains due after restart", () => {
  let now = "2026-09-09T02:00:00Z";
  const fixture = setupDatabase(() => now);
  const captureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const laterCaptureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  try {
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [
      { source_class: "prompt", retention: { mode: "finite", duration_seconds: 60 } },
      { source_class: "assistant_output", retention: { mode: "finite", duration_seconds: 3600 } },
    ], now);
    setCapturePaused(fixture.db, fixture.policy, scopeId, false, now);
    capture(envelope("20202020-2020-4202-8202-202020202020", "assistant_output", "older but not yet due"), fixture.binding, fixture.db);
    now = "2026-09-09T02:00:00.100Z";
    capture(envelope(captureId, "prompt", "finite", "1999-01-01T00:00:00Z"), fixture.binding, fixture.db);
    now = "2026-09-09T02:00:00.900Z";
    capture(envelope(laterCaptureId, "prompt", "finite later", "1999-01-01T00:00:00Z"), fixture.binding, fixture.db);
    now = "2026-09-09T02:01:00.500Z";
    assert.deepEqual(fixture.db.selectDueCaptures(scopeId, now, 1), [{
      capture_id: captureId,
      scope_id: scopeId,
      source_class: "prompt",
      accepted_at: "2026-09-09T02:00:00.100Z",
      expires_at: "2026-09-09T02:01:00.100Z",
    }]);
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "prompt", retention: { mode: "until_deleted" } }], now);
    assert.equal(fixture.db.selectDueCaptures(scopeId, now, 1)[0]?.capture_id, captureId);
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [], now);
    assert.equal(fixture.db.selectDueCaptures(scopeId, now, 1)[0]?.capture_id, captureId);
    fixture.db.close();
    const reopened = new AgentMemoryDatabase(fixture.path, { wall_clock: () => now });
    try {
      assert.deepEqual(reopened.getScopeCapturePolicy(scopeId), {
        enrolled: true,
        selections: [],
      });
      assert.equal(reopened.selectDueCaptures(scopeId, now)[0]?.capture_id, captureId);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("source purge cascades the store acceptance record while keeping the tombstone", () => {
  const now = "2026-09-09T03:00:00Z";
  const fixture = setupDatabase(() => now);
  const captureId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  try {
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "prompt", retention: { mode: "until_deleted" } }], now);
    setCapturePaused(fixture.db, fixture.policy, scopeId, false, now);
    capture(envelope(captureId, "prompt", "purge acceptance"), fixture.binding, fixture.db);
    const result = purgeSource(fixture.db, fixture.policy, {
      version: 1,
      operation_id: "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
      scope_id: scopeId,
      capture_ids: [captureId],
      expected_privacy_epoch: fixture.db.getScopePrivacyEpoch(scopeId),
      requested_at: now,
    });
    assert.equal(result.state, "pending");
    const raw = new DatabaseSync(fixture.path, { readOnly: true, readBigInts: true });
    try {
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM source_event WHERE capture_id = ?").get(captureId)?.count, 0n);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM capture_acceptance WHERE capture_id = ?").get(captureId)?.count, 0n);
      assert.equal(raw.prepare("SELECT COUNT(*) AS count FROM purge_tombstone WHERE capture_id = ?").get(captureId)?.count, 1n);
    } finally {
      raw.close();
    }
  } finally {
    closeDatabase(fixture.dir, fixture.db);
  }
});

test("transfer import remains closed when the target denies its fixed assistant class", () => {
  const now = "2026-09-09T03:30:00Z";
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-capture-policy-transfer-"));
  const sourcePath = join(directory, "source.sqlite");
  const targetPath = join(directory, "target.sqlite");
  const sourceDb = new AgentMemoryDatabase(sourcePath, { wall_clock: () => now });
  const targetDb = new AgentMemoryDatabase(targetPath, { wall_clock: () => now });
  const sourceBinding = bindingForScope(scopeId);
  const targetBinding = bindingForScope(targetScopeId, { host_session_id: "capture-policy-target-session" });
  const sourcePolicy = createPolicySetupBinding({ version: 1, setup_id: "14141414-1414-4141-8141-141414141414", allowed_scope_ids: [scopeId], allowed_output_targets: ["export:jsonl"] });
  const targetPolicy = createPolicySetupBinding({ version: 1, setup_id: "15151515-1515-4151-8151-151515151515", allowed_scope_ids: [targetScopeId], allowed_output_targets: ["export:jsonl"] });
  const transferPath = join(directory, "transfer.jsonl");
  try {
    sourceDb.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "capture-policy-transfer-source", created_at: now });
    sourceDb.registerSession(scopeId, sourceBinding, now);
    setScopeOutputGrants(sourceDb, sourcePolicy, scopeId, [{ target: "export:jsonl", source_classes: ["prompt"] }], now);
    capture(envelope("16161616-1616-4161-8161-161616161616", "prompt", "transfer source"), sourceBinding, sourceDb);
    exportTransfer(sourceDb, sourcePolicy, { scope_ids: [scopeId], destination: transferPath, export_id: "17171717-1717-4171-8171-171717171717", created_at: now });

    targetDb.registerScope({ scope_id: targetScopeId, kind: "project", owner_ref: "capture-policy-transfer-target", created_at: now });
    targetDb.registerSession(targetScopeId, targetBinding, now);
    setScopeOutputGrants(targetDb, targetPolicy, targetScopeId, [{ target: "export:jsonl", source_classes: ["assistant_output"] }], now);
    setScopeCapturePolicy(targetDb, targetPolicy, targetScopeId, [{ source_class: "prompt", retention: { mode: "until_deleted" } }], now);
    setCapturePaused(targetDb, targetPolicy, targetScopeId, false, now);
    assert.throws(
      () => importTransfer(targetDb, targetBinding, transferPath, { scope_map: { [scopeId]: targetScopeId }, policy_binding: targetPolicy }),
      (error: unknown) => error instanceof StoreError && error.code === "transfer_blocked",
    );
    assert.equal(targetDb.getCounts().source_count, 0n);
    setScopeCapturePolicy(targetDb, targetPolicy, targetScopeId, [{ source_class: "assistant_output", retention: { mode: "finite", duration_seconds: 60 } }], now);
    importTransfer(targetDb, targetBinding, transferPath, { scope_map: { [scopeId]: targetScopeId }, policy_binding: targetPolicy });
    setScopeCapturePolicy(targetDb, targetPolicy, targetScopeId, [], now);
    const due = targetDb.selectDueCaptures(targetScopeId, "2026-09-09T03:31:00Z");
    assert.equal(due.length, 1);
    assert.equal(due[0]?.accepted_at, now);
    assert.equal(due[0]?.expires_at, "2026-09-09T03:31:00.000Z");

  } finally {
    sourceDb.close();
    targetDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});


test("rejects version-only downgrades without modifying the inconsistent vault", () => {
  const fixture = setupDatabase(() => "2026-09-09T04:00:00Z");
  try {
    fixture.db.close();
    const raw = new DatabaseSync(fixture.path);
    raw.exec("UPDATE schema_meta SET value = '25' WHERE key = 'schema_version'; PRAGMA user_version = 25");
    raw.close();
    assert.throws(() => new AgentMemoryDatabase(fixture.path), (error: unknown) => error instanceof StoreError && error.code === "schema_migration_failed");
    const checked = new DatabaseSync(fixture.path);
    try {
      assert.equal(checked.prepare("PRAGMA user_version").get()?.user_version, 25);
      assert.equal(checked.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value, "25");
    } finally { checked.close(); }
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});


test("finite expiry rejects unsupported dates at selection and again at acceptance", () => {
  let now = "9999-12-31T23:59:58Z";
  const fixture = setupDatabase(() => now);
  try {
    const before = fixture.db.getScopePrivacyEpoch(scopeId);
    assert.throws(() => setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "prompt", retention: { mode: "finite", duration_seconds: Number.MAX_SAFE_INTEGER } }], now), /policy_invalid/);
    assert.equal(fixture.db.getScopePrivacyEpoch(scopeId), before);
    setScopeCapturePolicy(fixture.db, fixture.policy, scopeId, [{ source_class: "prompt", retention: { mode: "finite", duration_seconds: 1 } }], now);
    capture(envelope("18181818-1818-4181-8181-181818181818", "prompt", "last representable expiry"), fixture.binding, fixture.db);
    now = "9999-12-31T23:59:59Z";
    assert.equal(fixture.db.selectDueCaptures(scopeId, now)[0]?.expires_at, "9999-12-31T23:59:59.000Z");
    assert.throws(() => capture(envelope("19191919-1919-4191-8191-191919191919", "prompt", "overflow must not commit"), fixture.binding, fixture.db), /policy_invalid/);
    assert.equal(fixture.db.getCounts().source_count, 1n);
  } finally { closeDatabase(fixture.dir, fixture.db); }
});
