import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createRuntime, type RuntimeOwnerOptions } from "../src/app/runtime.js";
import { capture } from "../src/core/capture.js";
import { createPolicyOutputBinding, createPolicySetupBinding, setScopeOutputGrants } from "../src/core/policy.js";
import { E5_MODEL_MANIFEST } from "../src/models/manifest.js";
import type { LocalE5Embedder } from "../src/models/embedding.js";
import type { LocalReranker } from "../src/models/rerank.js";
import { createTrustedBinding } from "../src/host/contract.js";
import { AgentMemoryDatabase, type VectorChunkProjection, vectorProjectionReceiptDigest } from "../src/store/database.js";
import { digestText, VECTOR_CHUNKER_VERSION, VECTOR_PROFILE_ID, VECTOR_TOKENIZER_VERSION, vectorInputDigest } from "../src/retrieval/vector.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const setupId = "22222222-2222-4222-8222-222222222222";
const outputBindingId = "33333333-3333-4333-8333-333333333333";
const hostBindingId = "44444444-4444-4444-8444-444444444444";

function fakeEmbedding(): LocalE5Embedder {
  let disposed = false;
  return {
    manifest: E5_MODEL_MANIFEST,
    countTokens: ({ text }) => Math.ceil(text.length / 4),
    embed: async ({ texts }) => {
      assert.equal(disposed, false);
      return texts.map(() => {
        const vector = new Float32Array(E5_MODEL_MANIFEST.dimensions);
        vector[0] = 1;
        return vector;
      });
    },
    dispose: async () => { disposed = true; },
    report: () => ({
      state: disposed ? "disposed" as const : "ready" as const,
      model_root: "fixture",
      model_id: E5_MODEL_MANIFEST.model_id,
      revision: E5_MODEL_MANIFEST.revision,
      dimensions: E5_MODEL_MANIFEST.dimensions,
      max_tokens: E5_MODEL_MANIFEST.max_tokens,
      dtype: "q8" as const,
      device: "cpu" as const,
      batch_strategy: "rowwise_batch1" as const,
      input_count: 0,
      completed_batches: 0,
    }),
  };
}

function sourceOnlyOptions(vaultPath: string): RuntimeOwnerOptions {
  const policyBinding = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["local_ui", "reader:opencode_cli"],
  });
  const outputBinding = createPolicyOutputBinding(policyBinding, {
    version: 1,
    output_binding_id: outputBindingId,
    setup_id: setupId,
    scope_id: scopeId,
    target: "local_ui",
  });
  const hostBinding = createTrustedBinding({
    version: 1,
    binding_id: hostBindingId,
    host_kind: "opencode",
    surface: "opencode_cli",
    execution_domain: { kind: "local", id: "v1-runtime-test" },
    host_instance_id: "v1-runtime-test",
    host_session_id: "v1-runtime-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:opencode_cli"], provider_targets: [] },
  });
  return {
    vaultPath,
    embedding: fakeEmbedding(),
    scope: { scope_id: scopeId, kind: "project", owner_ref: "v1-runtime-test", created_at: "2026-09-14T10:00:00Z" },
    policyBinding,
    outputBinding,
    hostBinding,
    initialize: (database, updatedAt) => setScopeOutputGrants(database, policyBinding, scopeId, [
      { target: "local_ui", source_classes: ["prompt"] },
      { target: "reader:opencode_cli", source_classes: ["prompt"] },
    ], updatedAt),
  };
}

test("rejects an existing non-private vault before opening it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission regression; Windows ACL coverage is tested separately");
    return;
  }
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-private-vault-"));
  const vaultPath = resolve(directory, "vault.sqlite");
  writeFileSync(vaultPath, "not a vault\n", { mode: 0o644 });
  chmodSync(vaultPath, 0o644);
  try {
    await assert.rejects(
      () => createRuntime(sourceOnlyOptions(vaultPath)),
      /vault_file_must_be_owned_and_private/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeReranker(onDispose: () => void, failFirstDispose = false): LocalReranker {
  let state: "ready" | "disposing" | "disposed" = "ready";
  let disposeCalls = 0;
  const report = () => ({
    state,
    model_root: "fixture",
    model_id: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1" as const,
    revision: "0".repeat(40),
    hidden_size: 384 as const,
    max_tokens: 512 as const,
    dtype: "q8" as const,
    device: "cpu" as const,
    batch_strategy: "rowwise_batch1" as const,
    scored_pairs: 0,
    completed_batches: 0,
  });
  return {
    manifest: {} as LocalReranker["manifest"],
    rerank: async () => [],
    dispose: async () => {
      disposeCalls += 1;
      state = "disposing";
      if (failFirstDispose && disposeCalls === 1) throw new Error("rerank_dispose_failed");
      state = "disposed";
      onDispose();
    },
    report,
  };
}

test("source-only runtime starts, captures without extraction, queries, and restarts", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-"));
  const vaultPath = resolve(directory, "vault.sqlite");
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime(sourceOnlyOptions(vaultPath));
    assert.equal(runtime.status().state, "core_ready");
    assert.deepEqual(runtime.status().semantic_search, { state: "ready", reason: null });
    assert.equal(runtime.status().model, E5_MODEL_MANIFEST.model_id);
    assert.equal(runtime.brokerOwner.database, runtime.database);
    assert.equal(runtime.brokerOwner.scheduler.status().admission, "open");

    const captured = await runtime.ingest("v1 source-only marker survives restart");
    assert.ok(captured.job_id === null || typeof captured.job_id === "string");
    assert.ok(captured.state === "stored" || captured.state === "pending_extraction");
    const jobReader = new DatabaseSync(vaultPath, { readOnly: true });
    const jobKinds = jobReader.prepare("SELECT task_kind FROM job WHERE source_capture_id = ?").all(captured.capture_id).map((row) => String(row.task_kind));
    jobReader.close();
    assert.ok(jobKinds.every((kind) => kind === "embed"));
    const sourceStatus = runtime.status().sources.find((source) => source.capture_id === captured.capture_id);
    assert.equal(sourceStatus?.capture_id, captured.capture_id);
    assert.ok(sourceStatus?.job_id === null || typeof sourceStatus?.job_id === "string");
    assert.ok(sourceStatus?.state === "stored" || sourceStatus?.state === "pending_extraction" || sourceStatus?.state === "completed");
    const firstQuery = await runtime.query("source-only marker");
    assert.ok(firstQuery.sources.some((source) => source.capture_id === captured.capture_id));
    assert.deepEqual(firstQuery.facts, []);
    assert.deepEqual(firstQuery.summaries, []);

    await runtime.close();
    runtime = await createRuntime(sourceOnlyOptions(vaultPath));
    assert.ok((await runtime.query("source-only marker")).sources.some((source) => source.capture_id === captured.capture_id));
    const restartedJobReader = new DatabaseSync(vaultPath, { readOnly: true });
    const restartedJobKinds = restartedJobReader.prepare("SELECT task_kind FROM job WHERE source_capture_id = ?").all(captured.capture_id).map((row) => String(row.task_kind));
    restartedJobReader.close();
    assert.ok(restartedJobKinds.every((kind) => kind === "embed"));
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal runtime rebuilds a legacy projected source on startup and restart", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-reindex-"));
  const vaultPath = resolve(directory, "vault.sqlite");
  const options = sourceOnlyOptions(vaultPath);
  const hostBinding = options.hostBinding;
  assert.ok(hostBinding);
  const seedDatabase = new AgentMemoryDatabase(vaultPath, {
    extraction_enabled: false,
    embedding_task_version: "offline-e5-v1",
  });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const captureId = randomUUID();
  const spanId = randomUUID();
  const text = "legacy projected source survives automatic vector rebuild";
  const capturedAt = "2026-09-15T10:00:00.000Z";
  const sourceDigest = createHash("sha256").update(text).digest("hex");
  try {
    seedDatabase.registerScope(options.scope);
    seedDatabase.registerSession(scopeId, hostBinding, capturedAt);
    options.initialize?.(seedDatabase, capturedAt);
    capture({
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      origin: {
        host_kind: hostBinding.host_kind,
        surface: hostBinding.surface,
        execution_domain: hostBinding.execution_domain,
        host_instance_id: hostBinding.host_instance_id,
        host_session_id: hostBinding.host_session_id,
      },
      adapter_version: "0.1.0",
      event: {
        stage: "prompt_submitted",
        role: "user",
        evidence_class: "prompt",
        native_ids: { session_id: hostBinding.host_session_id, turn_id: captureId },
        text,
      },
      payload: { text },
      captured_at: capturedAt,
      occurred_at: capturedAt,
      truncation: { truncated: false },
      redaction: { applied: true, policy_version: "1.0.0" },
    }, hostBinding, seedDatabase, {
      source_spans: [{ span_id: spanId, root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length, digest: sourceDigest }],
    });

    const oldEmbedJob = seedDatabase.getEmbedJobByCaptureId(captureId, "offline-e5-v1");
    assert.ok(oldEmbedJob);
    const oldClaim = seedDatabase.jobs.claimNext(undefined, "embed");
    assert.ok(oldClaim);
    const oldVector = new Float32Array(E5_MODEL_MANIFEST.dimensions);
    oldVector[0] = 1;
    const legacyProjection: VectorChunkProjection = {
      chunk_id: randomUUID(),
      scope_id: scopeId,
      source_id: captureId,
      span_id: spanId,
      chunk_index: 0,
      text,
      input_digest: vectorInputDigest({
        scope_id: scopeId,
        source_id: captureId,
        span_id: spanId,
        chunk_index: 0,
        text,
        profile_id: VECTOR_PROFILE_ID,
        tokenizer_version: VECTOR_TOKENIZER_VERSION,
        chunker_version: "vector-chunker-v1",
        generation: "1",
      }),
      profile_id: VECTOR_PROFILE_ID,
      tokenizer_version: VECTOR_TOKENIZER_VERSION,
      chunker_version: "vector-chunker-v1",
      generation: "1",
      vector: oldVector,
      source_digest: digestText(text),
      source_span_digest: sourceDigest,
      start_utf16: 0,
      end_utf16: text.length,
    };
    assert.equal(seedDatabase.completeVectorProjection(oldClaim, [legacyProjection], vectorProjectionReceiptDigest([legacyProjection])).status, "completed");
    seedDatabase.close();

  const normalOptions = (): RuntimeOwnerOptions => ({ ...sourceOnlyOptions(vaultPath), requireExisting: true });
    runtime = await createRuntime(normalOptions());
    const rebuiltTaskVersion = `offline-e5-v1:chunker:${VECTOR_CHUNKER_VERSION}:generation:2`;
    const deadline = Date.now() + 5_000;
    while (runtime.database.getEmbedJobByCaptureId(captureId, rebuiltTaskVersion)?.state !== "completed") {
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.status()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runtime.database.getActiveVectorGeneration(), "2");
    assert.ok((await runtime.query("legacy projected source")).sources.some((source) => source.capture_id === captureId));

    await runtime.close();
    runtime = await createRuntime(normalOptions());
    assert.equal(runtime.database.getActiveVectorGeneration(), "2");
    assert.equal(runtime.database.getEmbedJobByCaptureId(captureId, rebuiltTaskVersion)?.state, "completed");
    assert.ok((await runtime.query("legacy projected source")).sources.some((source) => source.capture_id === captureId));
  } finally {
    await runtime?.close();
    if (!seedDatabase.isClosed()) seedDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal startup rebuilds mixed vector generations despite an old-generation marker", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-mixed-reindex-"));
  const vaultPath = resolve(directory, "vault.sqlite");
  const options = sourceOnlyOptions(vaultPath);
  const hostBinding = options.hostBinding;
  assert.ok(hostBinding);
  const seedDatabase = new AgentMemoryDatabase(vaultPath, {
    extraction_enabled: false,
    embedding_task_version: "offline-e5-v1",
  });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const capturedAt = "2026-09-15T10:05:00.000Z";
  const seedProjection = (text: string, chunkerVersion: string): string => {
    const captureId = randomUUID();
    const spanId = randomUUID();
    const digest = createHash("sha256").update(text).digest("hex");
    capture({
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      origin: {
        host_kind: hostBinding.host_kind,
        surface: hostBinding.surface,
        execution_domain: hostBinding.execution_domain,
        host_instance_id: hostBinding.host_instance_id,
        host_session_id: hostBinding.host_session_id,
      },
      adapter_version: "0.1.0",
      event: {
        stage: "prompt_submitted",
        role: "user",
        evidence_class: "prompt",
        native_ids: { session_id: hostBinding.host_session_id, turn_id: captureId },
        text,
      },
      payload: { text },
      captured_at: capturedAt,
      occurred_at: capturedAt,
      truncation: { truncated: false },
      redaction: { applied: true, policy_version: "1.0.0" },
    }, hostBinding, seedDatabase, {
      source_spans: [{ span_id: spanId, root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length, digest }],
    });
    const claim = seedDatabase.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const vector = new Float32Array(E5_MODEL_MANIFEST.dimensions);
    vector[0] = 1;
    const projection: VectorChunkProjection = {
      chunk_id: randomUUID(),
      scope_id: scopeId,
      source_id: captureId,
      span_id: spanId,
      chunk_index: 0,
      text,
      input_digest: vectorInputDigest({ scope_id: scopeId, source_id: captureId, span_id: spanId, chunk_index: 0, text, profile_id: VECTOR_PROFILE_ID, tokenizer_version: VECTOR_TOKENIZER_VERSION, chunker_version: chunkerVersion, generation: "1" }),
      profile_id: VECTOR_PROFILE_ID,
      tokenizer_version: VECTOR_TOKENIZER_VERSION,
      chunker_version: chunkerVersion,
      generation: "1",
      vector,
      source_digest: digestText(text),
      source_span_digest: digest,
      start_utf16: 0,
      end_utf16: text.length,
    };
    assert.equal(seedDatabase.completeVectorProjection(claim, [projection], vectorProjectionReceiptDigest([projection])).status, "completed");
    return captureId;
  };
  try {
    seedDatabase.registerScope(options.scope);
    seedDatabase.registerSession(scopeId, hostBinding, capturedAt);
    options.initialize?.(seedDatabase, capturedAt);
    const legacyCaptureId = seedProjection("mixed legacy projected source", "vector-chunker-v1");
    const currentCaptureId = seedProjection("mixed current projected source", VECTOR_CHUNKER_VERSION);
    const oldGenerationTaskVersion = `offline-e5-v1:chunker:${VECTOR_CHUNKER_VERSION}:generation:1`;
    const marker = seedDatabase.enqueueEmbedJob(scopeId, legacyCaptureId, oldGenerationTaskVersion);
    assert.equal(marker.created, true);
    const markerClaim = seedDatabase.jobs.claimNext(undefined, "embed");
    assert.ok(markerClaim);
    assert.equal(seedDatabase.jobs.pause(markerClaim, "manual")?.state, "paused");
    seedDatabase.close();

    const normalOptions = (): RuntimeOwnerOptions => ({ ...sourceOnlyOptions(vaultPath), requireExisting: true });
    runtime = await createRuntime(normalOptions());
    const rebuiltTaskVersion = `offline-e5-v1:chunker:${VECTOR_CHUNKER_VERSION}:generation:2`;
    const deadline = Date.now() + 5_000;
    while ([legacyCaptureId, currentCaptureId].some((captureId) => runtime!.database.getEmbedJobByCaptureId(captureId, rebuiltTaskVersion)?.state !== "completed")) {
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.status()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runtime.database.getActiveVectorGeneration(), "2");
    assert.equal(runtime.database.getEmbedJobByCaptureId(legacyCaptureId, oldGenerationTaskVersion)?.state, "paused");
    assert.ok((await runtime.query("mixed legacy projected source")).sources.some((source) => source.capture_id === legacyCaptureId));
    assert.ok((await runtime.query("mixed current projected source")).sources.some((source) => source.capture_id === currentCaptureId));

    await runtime.close();
    runtime = await createRuntime(normalOptions());
    assert.equal(runtime.database.getActiveVectorGeneration(), "2");
    const raw = new DatabaseSync(vaultPath, { readOnly: true, readBigInts: true });
    try {
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM job WHERE task_kind = 'embed' AND task_version = ?").get(rebuiltTaskVersion) as { count: bigint }).count, 2n);
    } finally {
      raw.close();
    }
    assert.ok((await runtime.query("mixed legacy projected source")).sources.some((source) => source.capture_id === legacyCaptureId));
    assert.ok((await runtime.query("mixed current projected source")).sources.some((source) => source.capture_id === currentCaptureId));
  } finally {
    await runtime?.close();
    if (!seedDatabase.isClosed()) seedDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source-only startup resumes the same shutdown-paused current-generation embed job", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-shutdown-resume-"));
  const vaultPath = resolve(directory, "vault.sqlite");
  const options = sourceOnlyOptions(vaultPath);
  const hostBinding = options.hostBinding;
  assert.ok(hostBinding);
  const seedDatabase = new AgentMemoryDatabase(vaultPath, { extraction_enabled: false });
  const captureId = randomUUID();
  const spanId = randomUUID();
  const text = "shutdown paused current generation source";
  const capturedAt = "2026-09-15T10:10:00.000Z";
  const digest = createHash("sha256").update(text).digest("hex");
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    seedDatabase.registerScope(options.scope);
    seedDatabase.registerSession(scopeId, hostBinding, capturedAt);
    options.initialize?.(seedDatabase, capturedAt);
    capture({
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      origin: {
        host_kind: hostBinding.host_kind,
        surface: hostBinding.surface,
        execution_domain: hostBinding.execution_domain,
        host_instance_id: hostBinding.host_instance_id,
        host_session_id: hostBinding.host_session_id,
      },
      adapter_version: "0.1.0",
      event: { stage: "prompt_submitted", role: "user", evidence_class: "prompt", native_ids: { session_id: hostBinding.host_session_id, turn_id: captureId }, text },
      payload: { text },
      captured_at: capturedAt,
      occurred_at: capturedAt,
      truncation: { truncated: false },
      redaction: { applied: true, policy_version: "1.0.0" },
    }, hostBinding, seedDatabase, {
      source_spans: [{ span_id: spanId, root: "payload", path: "/text", start_utf16: 0, end_utf16: text.length, digest }],
    });
    const seeded = seedDatabase.ensureVectorIndexCurrent("offline-e5-v1", VECTOR_CHUNKER_VERSION, capturedAt);
    assert.equal(seeded.enqueued_jobs, 1);
    const claim = seedDatabase.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    assert.equal(claim.task_version, seeded.task_version);
    const manualPaused = seedDatabase.jobs.pause(claim, "manual");
    assert.equal(manualPaused?.state, "paused");
    assert.equal(seedDatabase.jobs.resume({ job_id: claim.job_id, expected_fence: manualPaused!.fence, expected_reason: "manual", now: capturedAt })?.attempts, 1);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const interrupted = seedDatabase.jobs.claimNext(undefined, "embed");
      assert.ok(interrupted);
      const paused = seedDatabase.jobs.pause(interrupted, "shutdown");
      assert.equal(paused?.pause_reason, "shutdown");
      const resumed = seedDatabase.jobs.resume({ job_id: interrupted.job_id, expected_fence: paused!.fence, expected_reason: "shutdown", now: capturedAt });
      assert.equal(resumed?.job_id, claim.job_id);
      assert.equal(resumed?.attempts, 1);
    }
    const finalClaim = seedDatabase.jobs.claimNext(undefined, "embed");
    assert.ok(finalClaim);
    const finalPaused = seedDatabase.jobs.pause(finalClaim, "shutdown");
    assert.equal(finalPaused?.state, "paused");
    assert.equal(finalPaused?.pause_reason, "shutdown");
    assert.equal(finalPaused?.attempts, 2);
    const jobId = claim.job_id;
    seedDatabase.close();

    runtime = await createRuntime(sourceOnlyOptions(vaultPath));
    const deadline = Date.now() + 5_000;
    while (runtime.database.getEmbedJobByCaptureId(captureId, seeded.task_version)?.state !== "completed") {
      assert.ok(Date.now() < deadline, JSON.stringify(runtime.status()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(runtime.database.getEmbedJobByCaptureId(captureId, seeded.task_version)?.job_id, jobId);
    const completedRaw = new DatabaseSync(vaultPath, { readOnly: true, readBigInts: true });
    try {
      const row = completedRaw.prepare("SELECT state, attempts FROM job WHERE job_id = ?").get(jobId) as { state: string; attempts: bigint };
      assert.equal(row.state, "completed");
      assert.equal(row.attempts, 2n);
    } finally {
      completedRaw.close();
    }
    assert.ok((await runtime.query("shutdown paused current generation")).sources.some((source) => source.capture_id === captureId));

    await runtime.close();
    runtime = await createRuntime(sourceOnlyOptions(vaultPath));
    assert.equal(runtime.database.getEmbedJobByCaptureId(captureId, seeded.task_version)?.job_id, jobId);
    assert.equal(runtime.database.getEmbedJobByCaptureId(captureId, seeded.task_version)?.state, "completed");
    const raw = new DatabaseSync(vaultPath, { readOnly: true, readBigInts: true });
    try {
      assert.equal((raw.prepare("SELECT COUNT(*) AS count FROM job WHERE source_capture_id = ? AND task_version = ?").get(captureId, seeded.task_version) as { count: bigint }).count, 1n);
    } finally {
      raw.close();
    }
    assert.ok((await runtime.query("shutdown paused current generation")).sources.some((source) => source.capture_id === captureId));
  } finally {
    await runtime?.close();
    if (!seedDatabase.isClosed()) seedDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime batch purge removes all requested sources through one owner operation", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-purge-"));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime({
      ...sourceOnlyOptions(resolve(directory, "vault.sqlite")),
      reloadEmbedding: async () => fakeEmbedding(),
    });
    const first = await runtime.ingest("v1 batch purge first source");
    const second = await runtime.ingest("v1 batch purge second source");
    const result = await runtime.purgeSources({
      version: 1,
      operation_id: randomUUID(),
      scope_id: scopeId,
      capture_ids: [first.capture_id, second.capture_id],
      expected_privacy_epoch: runtime.database.getScopePrivacyEpoch(scopeId),
      requested_at: new Date().toISOString(),
    });
    assert.equal(result.selected_count, 2);
    assert.equal((await runtime.query("batch purge first source")).sources.length, 0);
    assert.equal((await runtime.query("batch purge second source")).sources.length, 0);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed auxiliary purge stays pending and restart reconciles tombstones before admission", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-purge-sidecar-"));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let fail = true;
  let procedureCaptureId: string | undefined;
  let checkpointEpoch: string | undefined;
  let learnedWeight = "learned";
  const reconciled: Array<{ scopeId: string; epoch: string; ids: readonly string[] }> = [];
  const searchState = {
    clearReports: () => undefined,
    procedures: (scopeId: string) => procedureCaptureId === undefined ? [] : [{ scope_id: scopeId, capture_id: procedureCaptureId, terms: [] }],
    reconcilePurges: (scopeId: string, epoch: string, ids: readonly string[]) => {
      reconciled.push({ scopeId, epoch, ids: [...ids] });
      if (fail) throw new Error("sidecar_write_failed");
      if (checkpointEpoch === epoch) return;
      checkpointEpoch = epoch;
      learnedWeight = "baseline";
    },
  } as unknown as NonNullable<RuntimeOwnerOptions["searchState"]>;
  try {
    let initializeFirstRuntime = true;
    const options = () => {
      const current = { ...sourceOnlyOptions(resolve(directory, "vault.sqlite")), searchState, reloadEmbedding: async () => fakeEmbedding() };
      if (initializeFirstRuntime) {
        initializeFirstRuntime = false;
        return current;
      }
      const { initialize: ignoredInitialize, ...withoutInitialize } = current;
      void ignoredInitialize;
      return withoutInitialize;
    };
    runtime = await createRuntime(options());
    assert.deepEqual(reconciled, []);
    const captured = await runtime.ingest("sidecar crash recovery source");
    const unregistered = await runtime.ingest("sidecar unrelated source");
    procedureCaptureId = captured.capture_id;
    const result = await runtime.purgeSources({
      version: 1,
      operation_id: randomUUID(),
      scope_id: scopeId,
      capture_ids: [captured.capture_id, unregistered.capture_id],
      expected_privacy_epoch: runtime.database.getScopePrivacyEpoch(scopeId),
      requested_at: new Date().toISOString(),
    });
    assert.equal(result.state, "pending");
    assert.ok(result.pending.includes("model_reset_pending"));
    assert.deepEqual(reconciled, [{ scopeId, epoch: "2", ids: [captured.capture_id] }]);
    await assert.rejects(runtime.query("sidecar crash recovery"), /reset|closed|maintenance/);
    await runtime.close();
    runtime = undefined;
    fail = false;
    runtime = await createRuntime(options());
    assert.deepEqual(reconciled, [
      { scopeId, epoch: "2", ids: [captured.capture_id] },
      { scopeId, epoch: "2", ids: [captured.capture_id] },
    ]);
    const recoveredWeight = learnedWeight;
    await runtime.close();
    runtime = await createRuntime(options());
    assert.equal(learnedWeight, recoveredWeight);
    assert.deepEqual(reconciled, [
      { scopeId, epoch: "2", ids: [captured.capture_id] },
      { scopeId, epoch: "2", ids: [captured.capture_id] },
      { scopeId, epoch: "2", ids: [captured.capture_id] },
    ]);
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime owns one source reranker, reloads it after purge reset, and clears search reports", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-reranker-"));
  const disposed: LocalReranker[] = [];
  const forgotten: Array<{ scopeId: string; ids: readonly string[] }> = [];
  let clearReports = 0;
  let factoryCalls = 0;
  let procedureCaptureId: string | undefined;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  const searchState = {
    clearReports: () => { clearReports += 1; },
    procedures: (scopeId: string) => procedureCaptureId === undefined ? [] : [{ scope_id: scopeId, capture_id: procedureCaptureId, terms: [] }],
    reconcilePurges: (scopeId: string, _epoch: string, ids: readonly string[]) => { forgotten.push({ scopeId, ids }); },
  } as unknown as NonNullable<RuntimeOwnerOptions["searchState"]>;
  try {
    runtime = await createRuntime({
      ...sourceOnlyOptions(resolve(directory, "vault.sqlite")),
      reloadEmbedding: async () => fakeEmbedding(),
      sourceReranker: async () => {
        factoryCalls += 1;
        const reranker = fakeReranker(() => { disposed.push(reranker); });
        return reranker;
      },
      searchState,
    });
    assert.equal(factoryCalls, 1);
    assert.equal(runtime.status().source_reranker.state, "ready");

    const captured = await runtime.ingest("source reranker lifecycle marker");
    procedureCaptureId = captured.capture_id;
    const result = await runtime.purge(captured.capture_id);

    assert.equal(result.state, "completed");
    assert.equal(factoryCalls, 2);
    assert.equal(clearReports, 1);
    assert.deepEqual(forgotten, [{ scopeId, ids: [captured.capture_id] }]);
    assert.equal(disposed.length, 1);
    assert.equal(runtime.status().source_reranker.state, "ready");
  } finally {
    await runtime?.close();
    assert.equal(disposed.length, 2);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime reports a pending purge when source reranker disposal fails", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-memory-v1-runtime-reranker-failure-"));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    runtime = await createRuntime({
      ...sourceOnlyOptions(resolve(directory, "vault.sqlite")),
      reloadEmbedding: async () => fakeEmbedding(),
      sourceReranker: async () => fakeReranker(() => undefined, true),
    });
    const captured = await runtime.ingest("source reranker disposal failure marker");
    const result = await runtime.purge(captured.capture_id);

    assert.equal(result.state, "pending");
    assert.ok(result.pending.includes("model_reset_pending"));
    assert.equal(runtime.status().source_reranker.state, "disposing");
    assert.equal(runtime.status().source_reranker.reason, "rerank_dispose_failed");
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
