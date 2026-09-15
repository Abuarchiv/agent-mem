import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ContractValidationError,
  createTrustedBinding,
  type TrustedBinding,
} from "../src/host/contract.js";
import { capture, prepareCaptureInput } from "../src/core/capture.js";
import { createPolicyOutputBinding, createPolicySetupBinding, readSourceForOutput, setScopeOutputGrants, type PolicySetupBinding } from "../src/core/policy.js";
import { AgentMemoryDatabase, APPLICATION_ID, CURRENT_SCHEMA_VERSION, StoreError } from "../src/store/database.js";

const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const capturePolicy = createPolicySetupBinding({
  version: 1,
  setup_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  allowed_scope_ids: [scopeA],
  allowed_output_targets: ["local_ui"],
});
const captureSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

function captureOutputBinding(policy: PolicySetupBinding = capturePolicy) {
  return createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    setup_id: policy.setup_id,
    scope_id: scopeA,
    target: "local_ui",
  });
}

function sourceForCapture(database: AgentMemoryDatabase, captureId: string) {
  return readSourceForOutput(database, captureOutputBinding(), captureId);
}

function spansForCapture(database: AgentMemoryDatabase, captureId: string) {
  return database.getSourceSpansForOutput(captureId, captureOutputBinding());
}

function bindingFor(scopeIds: string[] = [scopeA]): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "local-macos" },
    host_instance_id: "host-instance-1",
    host_session_id: "session-1",
    allowed_scope_ids: scopeIds,
    egress: {
      reader_targets: ["reader:codex_cli"],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    capture_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    scope_id: scopeA,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "local-macos" },
      host_instance_id: "host-instance-1",
      host_session_id: "session-1",
    },
    adapter_version: "0.1.0",
    event: {
      stage: "prompt_submitted",
      role: "user",
      evidence_class: "prompt",
      native_ids: { session_id: "native-session", turn_id: "native-turn" },
      text: "Remember this decision.",
    },
    payload: { text: "Remember this decision.", marker: "synthetic" },
    captured_at: "2026-09-06T21:00:00Z",
    occurred_at: "2026-09-06T20:59:59Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
    ...overrides,
  };
}

function setupDatabase(): { dir: string; path: string; db: AgentMemoryDatabase; binding: TrustedBinding } {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-"));
  const path = join(dir, "vault.sqlite");
  const db = new AgentMemoryDatabase(path);
  const binding = bindingFor();
  db.registerScope({
    scope_id: scopeA,
    kind: "project",
    owner_ref: "synthetic-owner",
    created_at: "2026-09-06T20:00:00Z",
  });
  db.registerSession(scopeA, binding, "2026-09-06T20:00:00Z");
  setScopeOutputGrants(
    db,
    capturePolicy,
    scopeA,
    [{ target: "local_ui", source_classes: [...captureSourceClasses] }],
    "2026-09-06T20:00:01Z",
  );
  return { dir, path, db, binding };
}

function cleanup(dir: string, db: AgentMemoryDatabase): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

test("persists source, job, WAL/FULL/FK settings and ACK across reopen", () => {
  const { dir, path, db, binding } = setupDatabase();
  try {
    const ack = capture(envelope(), binding, db);
    assert.equal(ack.commit_seq, "1");
    assert.deepEqual(db.getPragmas(), { foreign_keys: 1n, journal_mode: "wal", synchronous: 2n });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const identity = new DatabaseSync(path, { readBigInts: true });
    try {
      const applicationIdRow = identity.prepare("PRAGMA application_id").get() as { application_id: bigint };
      const userVersionRow = identity.prepare("PRAGMA user_version").get() as { user_version: bigint };
      assert.equal(applicationIdRow.application_id, BigInt(APPLICATION_ID));
      assert.equal(userVersionRow.user_version, BigInt(CURRENT_SCHEMA_VERSION));
    } finally {
      identity.close();
    }
    const runtimeSchema = fileURLToPath(new URL("../src/store/schema.sql", import.meta.url));
    assert.equal(existsSync(runtimeSchema), true);
    assert.match(readFileSync(runtimeSchema, "utf8"), /schema_version/);
    assert.equal(sourceForCapture(db, ack.capture_id)?.payload_json, JSON.stringify({ text: "Remember this decision.", marker: "synthetic" }));
    assert.equal(db.getJobByCaptureId(ack.capture_id)?.state, "pending_extraction");
    assert.equal(db.getJobByCaptureId(ack.capture_id)?.next_at, null);

    db.close();
    const reopened = new AgentMemoryDatabase(path);
    try {
      assert.deepEqual(reopened.getCaptureState(ack.capture_id), {
        commit_seq: "1",
        data_epoch: "1",
        source_count: 1n,
        span_count: 1n,
        job_count: 1n,
      });
      assert.equal(reopened.getJobByCaptureId(ack.capture_id)?.dedupe_key.length, 64);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an in-memory store for durable capture", () => {
  assert.throws(
    () => new AgentMemoryDatabase(":memory:"),
    (error: unknown) => error instanceof StoreError && error.code === "volatile_store_rejected",
  );
});

test("rejects a foreign SQLite file before any schema or pragma mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-foreign-"));
  const path = join(dir, "foreign.sqlite");
  const foreign = new DatabaseSync(path, { readBigInts: true });
  foreign.exec("CREATE TABLE unrelated_records (value TEXT); INSERT INTO unrelated_records VALUES ('keep-me');");
  foreign.close();
  const before = readFileSync(path);
  const beforeStat = statSync(path);

  try {
    assert.throws(
      () => new AgentMemoryDatabase(path),
      (error: unknown) => error instanceof StoreError && error.code === "vault_identity_mismatch",
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(statSync(path).size, beforeStat.size);
    const check = new DatabaseSync(path, { readBigInts: true });
    try {
      const retained = check.prepare("SELECT COUNT(*) AS count FROM unrelated_records").get() as { count: bigint };
      const productTables = check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'source_event'").get() as { count: bigint };
      assert.equal(retained.count, 1n);
      assert.equal(productTables.count, 0n);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a newer own schema without changing its bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-version-"));
  const path = join(dir, "future.sqlite");
  const future = new DatabaseSync(path, { readBigInts: true });
      future.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1};`);
  future.close();
  const before = readFileSync(path);

  try {
    assert.throws(
      () => new AgentMemoryDatabase(path),
      (error: unknown) => error instanceof StoreError && error.code === "schema_version_mismatch",
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closes and leaves an incomplete own initialization untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-incomplete-"));
  const path = join(dir, "incomplete.sqlite");
  const incomplete = new DatabaseSync(path, { readBigInts: true });
  incomplete.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1; CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version', '1');`);
  incomplete.close();
  const before = readFileSync(path);

  try {
    assert.throws(
      () => new AgentMemoryDatabase(path),
      (error: unknown) => error instanceof StoreError && error.code === "schema_invalid",
    );
    assert.deepEqual(readFileSync(path), before);
    const check = new DatabaseSync(path, { readBigInts: true });
    try {
      const userVersionRow = check.prepare("PRAGMA user_version").get() as { user_version: bigint };
      assert.equal(userVersionRow.user_version, 1n);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requires an explicitly registered scope and matching session origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-memory-capture-boundary-"));
  const path = join(dir, "vault.sqlite");
  const db = new AgentMemoryDatabase(path);
  const binding = bindingFor();
  try {
    assert.throws(() => capture(envelope(), binding, db), (error: unknown) => error instanceof Error && error.message.includes("scope_not_registered"));
    assert.deepEqual(db.getCounts(), { scope_count: 0n, session_count: 0n, source_count: 0n, span_count: 0n, job_count: 0n });

    db.registerScope({
      scope_id: scopeA,
      kind: "project",
      owner_ref: "synthetic-owner",
      created_at: "2026-09-06T20:00:00Z",
    });
    assert.throws(() => capture(envelope(), binding, db), (error: unknown) => error instanceof Error && error.message.includes("session_not_registered"));
    db.registerSession(scopeA, binding, "2026-09-06T20:00:00Z");
    assert.throws(
      () => capture(envelope({ origin: { ...(envelope() as { origin: Record<string, unknown> }).origin, host_session_id: "other-session" } }), binding, db),
      (error: unknown) => error instanceof ContractValidationError && error.contract === "source-envelope",
    );
    assert.equal(db.getCounts().source_count, 0n);

    assert.throws(
      () => capture(envelope({ scope_id: scopeB }), binding, db),
      (error: unknown) => error instanceof ContractValidationError && error.contract === "source-envelope",
    );
  } finally {
    cleanup(dir, db);
  }
});

test("makes identical scope/session setup idempotent while preserving other namespaces", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const sameScope = db.registerScope({
      scope_id: scopeA,
      kind: "project",
      owner_ref: "synthetic-owner",
      created_at: "2026-09-06T20:00:00Z",
    });
    assert.equal(sameScope.owner_ref, "synthetic-owner");
    assert.throws(
      () =>
        db.registerScope({
          scope_id: scopeA,
          kind: "project",
          owner_ref: "different-owner",
          created_at: "2026-09-06T20:00:00Z",
        }),
      (error: unknown) => error instanceof StoreError && error.code === "scope_conflict",
    );

    const firstSession = db.registerSession(scopeA, binding, "2026-09-06T20:00:00Z");
    const sameSession = db.registerSession(scopeA, binding, "2026-09-06T21:00:00Z");
    assert.equal(sameSession, firstSession);
    const otherNamespace = createTrustedBinding({
      ...binding,
      execution_domain: { kind: "local", id: "other-domain" },
      host_instance_id: "host-instance-2",
      host_session_id: "session-2",
    });
    const otherSession = db.registerSession(scopeA, otherNamespace, "2026-09-06T21:00:00Z");
    assert.notEqual(otherSession, firstSession);
    assert.equal(db.getCounts().session_count, 2n);
  } finally {
    cleanup(dir, db);
  }
});

test("does not accept a structural PreparedCapture clone at the commit boundary", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const prepared = prepareCaptureInput(envelope(), binding);
    const clone = { ...prepared };
    assert.throws(
      () => db.commitCapture(clone),
      (error: unknown) => error instanceof ContractValidationError && error.contract === "capture" && error.message.includes("capture_not_prepared"),
    );
    assert.equal(db.getCounts().source_count, 0n);
  } finally {
    cleanup(dir, db);
  }
});

test("preparation rejects an invalid span and freezes nested payload and span data", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    assert.throws(
      () =>
        prepareCaptureInput(envelope(), binding, {
          source_spans: [
            {
              span_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              path: "/does-not-exist",
              start_utf16: 0,
              end_utf16: 1,
              digest: "0".repeat(64),
            },
          ],
        }),
      (error: unknown) => error instanceof ContractValidationError,
    );

    const digest = createHash("sha256").update("Remember", "utf8").digest("hex");
    const prepared = prepareCaptureInput(envelope(), binding, {
      source_spans: [
        {
          span_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          path: "/text",
          start_utf16: 0,
          end_utf16: 8,
          digest,
        },
      ],
    });
    assert.throws(() => {
      (prepared.envelope.payload as { text: string }).text = "mutated";
    });
    assert.throws(() => {
      (prepared.source_spans[0] as { digest: string }).digest = "0".repeat(64);
    });
    assert.equal(db.commitCapture(prepared).commit_seq, "1");
    assert.equal(sourceForCapture(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")?.payload_json, JSON.stringify({ text: "Remember this decision.", marker: "synthetic" }));
  } finally {
    cleanup(dir, db);
  }
});

test("rejects an oversized capture before acquiring the write lock", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    assert.throws(
      () => capture(envelope({ payload: { blob: "x".repeat(4_000_001) } }), binding, db),
      (error: unknown) => error instanceof ContractValidationError && error.message.includes("payload_too_large"),
    );
    assert.equal(db.getCounts().source_count, 0n);
    assert.equal(db.getCounter().commit_seq, "0");
  } finally {
    cleanup(dir, db);
  }
});

test("does not schedule a job from a future host clock", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const ack = capture(envelope({ captured_at: "2099-01-01T00:00:00Z" }), binding, db);
    assert.equal(sourceForCapture(db, ack.capture_id)?.captured_at, "2099-01-01T00:00:00Z");
    assert.equal(db.getJobByCaptureId(ack.capture_id)?.next_at, null);
  } finally {
    cleanup(dir, db);
  }
});

test("same capture ID and canonical content is idempotent despite JSON key order", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const first = envelope({ payload: { marker: "synthetic", text: "Remember this decision." } });
    const second = envelope({ payload: { text: "Remember this decision.", marker: "synthetic" } });
    const firstAck = capture(first, binding, db);
    const secondAck = capture(second, binding, db);

    assert.deepEqual(secondAck, firstAck);
    assert.deepEqual(db.getCounts(), { scope_count: 1n, session_count: 1n, source_count: 1n, span_count: 1n, job_count: 1n });
  } finally {
    cleanup(dir, db);
  }
});

test("same capture ID with changed content is a conflict and never overwrites", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const firstAck = capture(envelope(), binding, db);
    assert.throws(
      () => capture(envelope({ payload: { text: "changed", marker: "synthetic" } }), binding, db),
      (error: unknown) => error instanceof Error && error.message.includes("capture_conflict"),
    );
    assert.equal(sourceForCapture(db, firstAck.capture_id)?.commit_seq, "1");
    assert.equal(sourceForCapture(db, firstAck.capture_id)?.payload_json.includes("changed"), false);
    assert.equal(db.getCounts().job_count, 1n);
  } finally {
    cleanup(dir, db);
  }
});

test("same capture ID with changed supplied spans is a conflict", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const text = "A🦄Z";
    const emojiDigest = createHash("sha256").update("🦄", "utf8").digest("hex");
    const asciiDigest = createHash("sha256").update("A", "utf8").digest("hex");
    const spans = (start_utf16: number, end_utf16: number, digest: string) => ({
      source_spans: [
        {
          span_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          path: "/text",
          start_utf16,
          end_utf16,
          digest,
        },
      ],
    });
    const first = capture(envelope({ payload: { text, marker: "synthetic" } }), binding, db, spans(1, 3, emojiDigest));
    assert.throws(
      () => capture(envelope({ payload: { text, marker: "synthetic" } }), binding, db, spans(0, 1, asciiDigest)),
      (error: unknown) => error instanceof StoreError && error.code === "capture_conflict",
    );
    const storedSpans = spansForCapture(db, first.capture_id);
    assert.deepEqual(storedSpans[0], {
      span_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      root: "payload",
      path: "/text",
      start_utf16: 1n,
      end_utf16: 3n,
      digest: emojiDigest,
    });
    assert.equal(storedSpans.length, 2);
  } finally {
    cleanup(dir, db);
  }
});

test("composite foreign keys reject cross-scope source and job links", () => {
  const { dir, path, db, binding } = setupDatabase();
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    db.registerScope({
      scope_id: scopeB,
      kind: "project",
      owner_ref: "other-synthetic-owner",
      created_at: "2026-09-06T20:00:00Z",
    });
    const ack = capture(envelope(), binding, db);
    assert.throws(() =>
      raw
        .prepare(
          "INSERT INTO source_span (span_id, source_id, scope_id, path, start_utf16, end_utf16, digest) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ack.capture_id, scopeB, "/text", 0n, 1n, "0".repeat(64)),
    );
    assert.throws(() =>
      raw
        .prepare(
          `INSERT INTO job (
             job_id, scope_id, source_capture_id, task_kind, task_version, state,
             dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq
           ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
          scopeB,
          ack.capture_id,
          "extract-v1",
          "0".repeat(64),
          0n,
          "2026-09-06T21:00:00Z",
          0n,
          1n,
        ),
    );
    assert.deepEqual(db.getCounts(), { scope_count: 2n, session_count: 1n, source_count: 1n, span_count: 1n, job_count: 1n });
  } finally {
    raw.close();
    cleanup(dir, db);
  }
});

test("rolls back source, job and counters when the job insert fails", () => {
  const { dir, path, db, binding } = setupDatabase();
  const triggerDb = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    triggerDb.exec("CREATE TRIGGER fail_capture_job BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT, 'injected_job_failure'); END;");
    assert.throws(() => capture(envelope(), binding, db));
    assert.deepEqual(db.getCounts(), { scope_count: 1n, session_count: 1n, source_count: 0n, span_count: 0n, job_count: 0n });
    assert.deepEqual(db.getCounter(), { commit_seq: "0", data_epoch: "0" });
  } finally {
    triggerDb.close();
    cleanup(dir, db);
  }
});

test("keeps commit sequence exact above JavaScript safe integer range", () => {
  const { dir, path, db, binding } = setupDatabase();
  const seedDb = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  let seedClosed = false;
  try {
    seedDb.prepare("UPDATE vault_counter SET commit_seq = ? WHERE id = 1").run(9_007_199_254_740_992n);
    seedDb.close();
    seedClosed = true;
    const ack = capture(envelope(), binding, db);
    assert.equal(ack.commit_seq, "9007199254740993");
    db.close();
    const reopened = new AgentMemoryDatabase(path);
    try {
      assert.equal(sourceForCapture(reopened, ack.capture_id)?.commit_seq, "9007199254740993");
      assert.equal(reopened.getCounter().commit_seq, "9007199254740993");
    } finally {
      reopened.close();
    }
  } finally {
    if (!db.isClosed()) db.close();
    if (!seedClosed) seedDb.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores supplied and automatic UTF-16 source spans with verified digest", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const text = "A🦄Z";
    const spanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const digest = createHash("sha256").update("🦄", "utf8").digest("hex");
    const ack = capture(
      envelope({ payload: { text, marker: "synthetic" } }),
      binding,
      db,
      {
        source_spans: [{ span_id: spanId, path: "/text", start_utf16: 1, end_utf16: 3, digest }],
      },
    );
    const storedSpans = spansForCapture(db, ack.capture_id);
    assert.deepEqual(storedSpans[0], {
      span_id: spanId,
      root: "payload",
      path: "/text",
      start_utf16: 1n,
      end_utf16: 3n,
      digest,
    });
    assert.equal(storedSpans.length, 2);

    assert.throws(() =>
      capture(
        envelope({ capture_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", payload: { text, marker: "synthetic" } }),
        binding,
        db,
        { source_spans: [{ span_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", path: "/text", start_utf16: 1, end_utf16: 4, digest }] },
      ),
    );
    assert.equal(db.getCounts().source_count, 1n);
  } finally {
    cleanup(dir, db);
  }
});

test("accepts only own JSON pointer fields and never splits a surrogate pair", () => {
  const { dir, db, binding } = setupDatabase();
  try {
    const text = "A🦄Z";
    const digest = createHash("sha256").update("A", "utf8").digest("hex");
    const invalidPointer = ["/toString", "/text~2"].map((path, index) => () =>
      capture(
        envelope({ capture_id: `f${String(index).repeat(7)}-ffff-4fff-8fff-ffffffffffff`, payload: { text, marker: "synthetic" } }),
        binding,
        db,
        { source_spans: [{ span_id: `a${String(index).repeat(7)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, path, start_utf16: 0, end_utf16: 1, digest }] },
      ),
    );
    assert.throws(invalidPointer[0]!, (error: unknown) => error instanceof ContractValidationError);
    assert.throws(invalidPointer[1]!, (error: unknown) => error instanceof ContractValidationError);
    assert.throws(
      () =>
        capture(
          envelope({ capture_id: "abababab-abab-4bab-8bab-abababababab", payload: { text, marker: "synthetic" } }),
          binding,
          db,
          { source_spans: [{ span_id: "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd", path: "/text", start_utf16: 2, end_utf16: 3, digest: "0".repeat(64) }] },
        ),
      (error: unknown) => error instanceof ContractValidationError && error.message.includes("splits_surrogate_pair"),
    );
    assert.equal(db.getCounts().source_count, 0n);
  } finally {
    cleanup(dir, db);
  }
});
