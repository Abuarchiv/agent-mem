import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { observeNative } from "../src/core/capture.js";
import { normalizeNativeEvent } from "../src/host/events.js";
import { ContractValidationError, createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bindingFor(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "opencode",
    surface: "opencode_cli",
    execution_domain: { kind: "local", id: "local-v1-capture" },
    host_instance_id: "opencode-v1-capture",
    host_session_id: "native-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:opencode_cli"], provider_targets: [] },
  });
}

function eventInput(binding: TrustedBinding, captureId: string, text: string, capturedAt: string): ReturnType<typeof normalizeNativeEvent> {
  return normalizeNativeEvent({
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    adapter_version: "1.0.0",
    stage: "message_part",
    role: "assistant",
    evidence_class: "assistant_output",
    native_ids: { session_id: binding.host_session_id, message_id: "message-v1", part_id: "part-v1" },
    text,
    payload: { text, marker: "v1-capture" },
    captured_at: capturedAt,
    coverage: { status: "complete" },
    correlation: { status: "correlated", basis: "native_ids", key: "message-v1:part-v1" },
  }, binding);
}

function setupDatabase(database: AgentMemoryDatabase, binding: TrustedBinding): void {
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "v1-capture", created_at: "2026-09-14T10:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-14T10:00:01Z");
}

test("validates extraction_enabled as a boolean", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-option-"));
  try {
    assert.throws(
      () => new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: "false" } as never),
      (error: unknown) => error instanceof ContractValidationError && error.contract === "extraction-enabled",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disabled extraction preserves source and FTS, keeps E5 jobs, and distinguishes native replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-capture-"));
  const path = join(directory, "vault.sqlite");
  const options = { extraction_enabled: false, embedding_task_version: "e5-test" } as const;
  const binding = bindingFor();
  let database = new AgentMemoryDatabase(path, options);
  try {
    setupDatabase(database, binding);
    const first = observeNative(
      eventInput(binding, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "nativev1marker durable source", "2026-09-14T10:01:00Z"),
      binding,
      database,
      { version: 1, identity: { kind: "event", key: "event-v1" } },
    );
    assert.equal("job_id" in first, false);

    database.close();
    database = new AgentMemoryDatabase(path, options);
    const replay = observeNative(
      eventInput(binding, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "nativev1marker durable source", "2026-09-14T10:09:00Z"),
      binding,
      database,
      { version: 1, identity: { kind: "event", key: "event-v1" } },
    );
    assert.deepEqual(replay, first);
    assert.equal(database.getJobByCaptureId(first.capture_id), undefined);
    assert.throws(
      () => observeNative(
        eventInput(binding, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "changed nativev1marker", "2026-09-14T10:10:00Z"),
        binding,
        database,
        { version: 1, identity: { kind: "event", key: "event-v1" } },
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "native_observation_conflict",
    );

    const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
    try {
      const count = (sql: string, ...parameters: SQLInputValue[]): bigint => (raw.prepare(sql).get(...parameters) as { count: bigint }).count;
      assert.equal(count("SELECT COUNT(*) AS count FROM source_event WHERE capture_id = ?", first.capture_id), 1n);
      assert.equal(count("SELECT COUNT(*) AS count FROM source_span WHERE source_id = ?", first.capture_id), 1n);
      assert.equal(count("SELECT COUNT(*) AS count FROM search_document WHERE source_id = ?", first.capture_id), 1n);
      assert.equal(count("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?", "nativev1marker"), 1n);
      const jobs = raw.prepare("SELECT task_kind, COUNT(*) AS count FROM job WHERE source_capture_id = ? GROUP BY task_kind").all(first.capture_id) as unknown as readonly { task_kind: string; count: bigint }[];
      assert.deepEqual(jobs.map((job) => [job.task_kind, job.count]), [["embed", 1n]]);
    } finally {
      raw.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
