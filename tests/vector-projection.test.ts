import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { prepareCaptureInput, type SourceSpanInput } from "../src/core/capture.js";
import { purgeSource } from "../src/core/purge-source.js";
import {
  createPolicySetupBinding,
  setScopeOutputGrants,
  type PolicySetupBinding,
} from "../src/core/policy.js";
import {
  createTrustedBinding,
  type TrustedBinding,
} from "../src/host/contract.js";
import { AgentMemoryDatabase, type VectorChunkProjection } from "../src/store/database.js";
import {
  chunkPassageForE5,
  createE5TokenCounter,
  digestText,
  VECTOR_CHUNKER_VERSION,
  VECTOR_DIM,
  VECTOR_PROFILE_ID,
  VECTOR_TOKENIZER_VERSION,
  vectorSearch,
  vectorInputDigest,
  type E5TokenizerLike,
} from "../src/retrieval/vector.js";
import { fuseRanks, hybridSearch } from "../src/retrieval/fusion.js";
import { isNativeOnnxRuntimeSupported } from "../src/models/manifest.js";

const scopeA = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const scopeB = "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2";
const bindingId = "c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3";
const policyId = "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4";
const EMBED_TASK_VERSION = "embed-e5-761b726-gen1";

function bindingFor(scopeIds: readonly string[] = [scopeA]): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "vector-projection-test" },
    host_instance_id: "vector-projection-host",
    host_session_id: "vector-projection-session",
    allowed_scope_ids: [...scopeIds],
    egress: {
      reader_targets: ["reader:codex_cli"],
      provider_targets: ["provider:xp-copilot"],
    },
  });
}

function policyFor(scopeIds: readonly string[] = [scopeA]): PolicySetupBinding {
  return createPolicySetupBinding({
    version: 1,
    setup_id: policyId,
    allowed_scope_ids: [...scopeIds],
    allowed_output_targets: ["reader:codex_cli", "local_ui", "provider:xp-copilot"],
  });
}

function envelope(
  captureId: string,
  scopeId: string,
  text: string,
  evidenceClass = "prompt",
): unknown {
  const identity =
    evidenceClass === "assistant_output"
      ? { stage: "assistant_final", role: "assistant" }
      : { stage: "prompt_submitted", role: "user" };
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: "codex",
      surface: "codex_cli",
      execution_domain: { kind: "local", id: "vector-projection-test" },
      host_instance_id: "vector-projection-host",
      host_session_id: "vector-projection-session",
    },
    adapter_version: "0.1.0",
    event: {
      stage: identity.stage,
      role: identity.role,
      evidence_class: evidenceClass,
      native_ids: { session_id: "native-session", turn_id: captureId },
      text,
    },
    payload: { text, marker: "synthetic-vector-projection" },
    captured_at: "2026-09-07T08:00:00Z",
    occurred_at: "2026-09-07T07:59:59Z",
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function textlessLifecycleEnvelope(captureId: string, scopeId: string): unknown {
  const base = envelope(captureId, scopeId, "", "lifecycle") as { readonly [key: string]: unknown };
  return {
    ...base,
    event: {
      stage: "stop",
      role: "system",
      evidence_class: "lifecycle",
      native_ids: { session_id: "native-session", turn_id: captureId },
    },
    payload: { stage: "stop", native: { session_id: "native-session" } },
  };
}

function span(spanId: string, text: string): SourceSpanInput {
  return {
    span_id: spanId,
    root: "payload",
    path: "/text",
    start_utf16: 0,
    end_utf16: text.length,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

function setup(scopeIds: readonly string[] = [scopeA], options: { readonly vector_extension_path?: string } = {}): {
  directory: string;
  path: string;
  database: AgentMemoryDatabase;
  binding: TrustedBinding;
  policy: PolicySetupBinding;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-vector-projection-"));
  const path = join(directory, "vault.sqlite");
  const database = new AgentMemoryDatabase(path, options);
  const binding = bindingFor(scopeIds);
  const policy = policyFor(scopeIds);
  for (const scopeId of scopeIds) {
    database.registerScope({
      scope_id: scopeId,
      kind: "project",
      owner_ref: `synthetic-owner-${scopeId}`,
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

function closeSetup(directory: string, database: AgentMemoryDatabase): void {
  if (!database.isClosed()) database.close();
  rmSync(directory, { recursive: true, force: true });
}

/** Deterministic synthetic unit vector: 1 at `axis`, 0 elsewhere. Test-only ranking fixture. */
function basis(axis: number): Float32Array {
  const vector = new Float32Array(VECTOR_DIM);
  vector[axis] = 1;
  return vector;
}

function resultDigestFor(jobId: string): string {
  return createHash("sha256").update(`vector-result\u0000${jobId}`, "utf8").digest("hex");
}

function captureWithEmbed(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  captureId: string,
  scopeId: string,
  text: string,
  spanId: string,
): void {
  const prepared = prepareCaptureInput(envelope(captureId, scopeId, text), binding, {
    source_spans: [span(spanId, text)],
  });
  database.commitCapture(prepared, { task_version: EMBED_TASK_VERSION });
}

function projectionFor(
  database: AgentMemoryDatabase,
  scopeId: string,
  captureId: string,
  spanId: string,
  text: string,
  vector: Float32Array,
  chunkId: string,
  options: {
    readonly chunk_index?: number;
    readonly chunker_version?: string;
    readonly generation?: string;
    readonly source_span_digest?: string;
    readonly start_utf16?: number;
    readonly end_utf16?: number;
  } = {},
): VectorChunkProjection {
  const generation = options.generation ?? database.getActiveVectorGeneration();
  const chunkerVersion = options.chunker_version ?? VECTOR_CHUNKER_VERSION;
  return {
    chunk_id: chunkId,
    scope_id: scopeId,
    source_id: captureId,
    span_id: spanId,
    chunk_index: options.chunk_index ?? 0,
    text,
    input_digest: vectorInputDigest({
      scope_id: scopeId,
      source_id: captureId,
      span_id: spanId,
      chunk_index: options.chunk_index ?? 0,
      text,
      profile_id: VECTOR_PROFILE_ID,
      tokenizer_version: VECTOR_TOKENIZER_VERSION,
      chunker_version: chunkerVersion,
      generation,
    }),
    profile_id: VECTOR_PROFILE_ID,
    tokenizer_version: VECTOR_TOKENIZER_VERSION,
    chunker_version: chunkerVersion,
    generation,
    vector,
    source_digest: digestText(text),
    ...(options.source_span_digest === undefined ? {} : { source_span_digest: options.source_span_digest }),
    ...(options.start_utf16 === undefined ? {} : { start_utf16: options.start_utf16 }),
    ...(options.end_utf16 === undefined ? {} : { end_utf16: options.end_utf16 }),
  };
}

function vectorRowCount(path: string): { readonly chunks: bigint; readonly embeddings: bigint } {
  const raw = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    const chunks = raw.prepare("SELECT COUNT(*) AS count FROM vector_chunk").get() as Record<string, unknown>;
    const embeddings = raw.prepare("SELECT COUNT(*) AS count FROM vector_embedding").get() as Record<string, unknown>;
    return { chunks: chunks["count"] as bigint, embeddings: embeddings["count"] as bigint };
  } finally {
    raw.close();
  }
}

test("hybrid recall keeps one row per source and does not lose a source to chunk limits", () => {
  const { directory, database, binding } = setup();
  try {
    const sourceA = "11111111-aaaa-4aaa-8aaa-111111111111";
    const spanA = "11111111-bbbb-4bbb-8bbb-111111111111";
    const chunksA = ["needle alpha ", "needle beta ", "needle gamma"];
    const textA = chunksA.join("");
    captureWithEmbed(database, binding, sourceA, scopeA, textA, spanA);
    const claimA = database.jobs.claimNext(undefined, "embed");
    assert.ok(claimA);
    let offset = 0;
    const projectionsA = chunksA.map((text, index) => {
      const start = offset;
      const end = start + text.length;
      offset = end;
      return projectionFor(database, scopeA, sourceA, spanA, text, basis(0), `a${String(index + 1).repeat(7)}-0000-4000-8000-000000000000`, {
        chunk_index: index,
        source_span_digest: digestText(textA),
        start_utf16: start,
        end_utf16: end,
      });
    });
    assert.equal(database.completeVectorProjection(claimA, projectionsA, resultDigestFor(claimA.job_id)).status, "completed");

    const sourceB = "22222222-aaaa-4aaa-8aaa-222222222222";
    const spanB = "22222222-bbbb-4bbb-8bbb-222222222222";
    const textB = "semantic-only source";
    captureWithEmbed(database, binding, sourceB, scopeA, textB, spanB);
    const claimB = database.jobs.claimNext(undefined, "embed");
    assert.ok(claimB);
    const vectorB = basis(0);
    vectorB[1] = 0.1;
    assert.equal(database.completeVectorProjection(
      claimB,
      [projectionFor(database, scopeA, sourceB, spanB, textB, vectorB, "b1111111-0000-4000-8000-000000000000")],
      resultDigestFor(claimB.job_id),
    ).status, "completed");

    const request = { query: "needle", scope_ids: [scopeA], mode: "current" as const, token_budget: 200 };
    const raw = vectorSearch(database, binding, basis(0), request, 2);
    assert.deepEqual(raw.map((entry) => entry.source_id), [sourceA, sourceA]);

    const fused = hybridSearch(database, binding, request, basis(0), 2, { per_signal_limit: 2 });
    assert.deepEqual(fused.map((entry) => entry.source_id).sort(), [sourceA, sourceB].sort());
    assert.equal(new Set(fused.map((entry) => entry.source_id)).size, fused.length);

    const mergedRevision = fuseRanks(
      [{ source_id: sourceA, revision_id: null }],
      [{ source_id: sourceA, revision_id: "33333333-aaaa-4aaa-8aaa-333333333333" }],
      2,
    );
    assert.equal(mergedRevision.length, 1);
  } finally {
    closeSetup(directory, database);
  }
});

test("capture with embed creates both jobs atomically and projector completes fenced", () => {
  const { directory, path, database, binding } = setup();
  try {
    const captureId = "11111111-1111-4111-8111-111111111111";
    const spanId = "11111111-2222-4222-8222-111111111111";
    const text = "atomic vector projection source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);

    assert.equal(database.getJobByCaptureId(captureId)?.state, "pending_extraction");
    const embed = database.getEmbedJobByCaptureId(captureId, EMBED_TASK_VERSION);
    assert.ok(embed);
    assert.equal(embed.state, "pending_extraction");

    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    assert.equal(claim.task_kind, "embed");
    assert.equal(claim.source_capture_id, captureId);

    const completed = database.completeVectorProjection(
      claim,
      [projectionFor(database, scopeA, captureId, spanId, text, basis(3), "33333333-3333-4333-8333-333333333333")],
      resultDigestFor(claim.job_id),
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(vectorRowCount(path), { chunks: 1n, embeddings: 1n });
    assert.equal(database.getEmbedJobByCaptureId(captureId, EMBED_TASK_VERSION)?.state, "completed");
    assert.equal(database.getJobByCaptureId(captureId)?.state, "pending_extraction");
    const changedPayload = database.completeVectorProjection(
      claim,
      [projectionFor(database, scopeA, captureId, spanId, text, basis(4), "33333333-3333-4333-8333-333333333333")],
      resultDigestFor(claim.job_id),
    );
    assert.equal(changedPayload.status, "rejected");
  } finally {
    closeSetup(directory, database);
  }
});

test("does not enqueue embed work for textless lifecycle capture, replay, or backfill", () => {
  const { directory, database, binding } = setup();
  try {
    const captureId = "abababab-abab-4bab-8bab-abababababab";
    const prepared = prepareCaptureInput(textlessLifecycleEnvelope(captureId, scopeA), binding);
    const first = database.commitCapture(prepared, { task_version: EMBED_TASK_VERSION });
    assert.equal(first.capture_id, captureId);
    assert.equal(database.getEmbedJobByCaptureId(captureId, EMBED_TASK_VERSION), undefined);

    assert.deepEqual(database.commitCapture(prepared, { task_version: EMBED_TASK_VERSION }), first);
    assert.equal(database.getEmbedJobByCaptureId(captureId, EMBED_TASK_VERSION), undefined);

    assert.deepEqual(database.enqueueEmbedJob(scopeA, captureId, EMBED_TASK_VERSION), { job_id: null, created: false });
    assert.equal(database.getEmbedJobByCaptureId(captureId, EMBED_TASK_VERSION), undefined);
  } finally {
    closeSetup(directory, database);
  }
});

test("reindexes old chunker projections and returns exact multi-chunk source quotes", () => {
  const { directory, database, binding } = setup();
  try {
    const captureId = "abababab-cdcd-4ded-8efe-abababababab";
    const spanId = "cdcdcdcd-efef-4fef-8a8f-cdcdcdcdcdcd";
    const text = Array.from(
      { length: 96 },
      (_, index) => `Segment ${index}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda.`,
    ).join(" ");
    const prepared = prepareCaptureInput(envelope(captureId, scopeA, text), binding, { source_spans: [span(spanId, text)] });
    database.commitCapture(prepared, { task_version: EMBED_TASK_VERSION });
    const chunks = chunkPassageForE5(text, (formatted) => Math.max(1, Math.ceil(formatted.length / 4)));
    assert.ok(chunks.length > 1);
    const offsets: Array<{ readonly start: number; readonly end: number }> = [];
    let cursor = 0;
    for (const chunk of chunks) {
      const start = text.indexOf(chunk, cursor);
      assert.ok(start >= 0, "chunk must remain an exact source substring");
      const end = start + chunk.length;
      offsets.push({ start, end });
      cursor = end;
    }
    const firstOffset = offsets[0];
    assert.ok(firstOffset);

    const oldClaim = database.jobs.claimNext(undefined, "embed");
    assert.ok(oldClaim);
    const oldProjection = projectionFor(
      database,
      scopeA,
      captureId,
      spanId,
      chunks[0] as string,
      basis(0),
      "dededede-dead-4eee-8fff-dededededede",
      {
        chunker_version: "vector-chunker-v1",
        source_span_digest: digestText(text),
        start_utf16: firstOffset.start,
        end_utf16: firstOffset.end,
      },
    );
    assert.equal(database.completeVectorProjection(oldClaim, [oldProjection], resultDigestFor(oldClaim.job_id)).status, "completed");

    const request = { query: "long source", scope_ids: [scopeA], mode: "current" as const, token_budget: 200 };
    assert.deepEqual(vectorSearch(database, binding, basis(0), request, 10), []);

    const reindexTaskVersion = `${EMBED_TASK_VERSION}:reindex-v2`;
    assert.deepEqual(database.enqueueEmbedJob(scopeA, captureId, reindexTaskVersion).created, true);
    const reindexClaim = database.jobs.claimNext(undefined, "embed");
    assert.ok(reindexClaim);
    const reindexed = chunks.map((chunk, index) => {
      const offset = offsets[index];
      assert.ok(offset);
      return projectionFor(
        database,
        scopeA,
        captureId,
        spanId,
        chunk,
        basis(index % VECTOR_DIM),
        `e${String(index).padStart(7, "0")}-0000-4000-8000-000000000000`,
        {
          chunk_index: index,
          generation: "2",
          source_span_digest: digestText(text),
          start_utf16: offset.start,
          end_utf16: offset.end,
        },
      );
    });
    assert.equal(database.completeVectorProjection(reindexClaim, reindexed, resultDigestFor(reindexClaim.job_id)).status, "completed");
    assert.equal(database.activateVectorGeneration("1", "2026-09-15T12:00:00Z"), "2");

    const results = vectorSearch(database, binding, basis(0), request, chunks.length);
    assert.ok(results.length > 1);
    for (const result of results) {
      assert.equal(result.source_id, captureId);
      assert.equal(text.slice(result.start_utf16, result.end_utf16), result.quote);
      assert.equal(result.digest, digestText(result.quote));
    }
  } finally {
    closeSetup(directory, database);
  }
});

test("long automatic event spans do not duplicate the payload full span in vector jobs", () => {
  const { directory, database, binding } = setup();
  try {
    const captureId = "abababab-eeee-4ded-8efe-abababababab";
    const spanId = "cdcdcdcd-aaaa-4fef-8a8f-cdcdcdcdcdcd";
    const text = `${"vector source line ".repeat(120)}VECTOR_DUPLICATE_ANCHOR`;
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const source = database.getVectorProjectionSource(scopeA, captureId);
    assert.ok(source.spans.length > 1);
    assert.ok(source.spans.length <= 127);
    assert.ok(source.spans.every((span) => span.root === "event" && span.path === "/text"));
    assert.equal(source.spans.some((span) => span.start_utf16 === 0 && span.end_utf16 === text.length), false);
  } finally {
    closeSetup(directory, database);
  }
});

test("keeps repeated identical chunks bound to cumulative UTF-16 offsets", () => {
  const { directory, database, binding } = setup();
  try {
    const captureId = "bcbcbcbc-dede-4fef-8a8f-bcbcbcbcbcbc";
    const spanId = "dededede-fafa-4afa-8bfb-dededededede";
    const paragraph = "Repeated 🧭 paragraph: alpha beta gamma delta epsilon zeta eta theta.";
    const text = Array.from({ length: 120 }, () => paragraph).join("\n\n");
    const prepared = prepareCaptureInput(envelope(captureId, scopeA, text), binding, { source_spans: [span(spanId, text)] });
    database.commitCapture(prepared, { task_version: EMBED_TASK_VERSION });
    const chunks = chunkPassageForE5(text, (formatted) => Math.max(1, Math.ceil(formatted.length / 4)));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.filter((chunk) => chunk === chunks[0]).length > 1);
    const parentDigest = digestText(text);
    const projections: VectorChunkProjection[] = [];
    let cursor = 0;
    for (const [index, chunk] of chunks.entries()) {
      const start = text.indexOf(chunk, cursor);
      assert.ok(start >= 0);
      const end = start + chunk.length;
      cursor = end;
      projections.push(projectionFor(database, scopeA, captureId, spanId, chunk, basis(index % VECTOR_DIM), `f${String(index).padStart(7, "0")}-0000-4000-8000-000000000000`, {
        chunk_index: index,
        source_span_digest: parentDigest,
        start_utf16: start,
        end_utf16: end,
      }));
    }
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    assert.equal(database.completeVectorProjection(claim, projections, resultDigestFor(claim.job_id)).status, "completed");
    const results = vectorSearch(database, binding, basis(0), { query: "repeated paragraph", scope_ids: [scopeA], mode: "current", token_budget: 200 }, chunks.length);
    assert.equal(results.length, chunks.length);
    for (const result of results) {
      assert.equal(text.slice(result.start_utf16, result.end_utf16), result.quote);
      assert.equal(result.digest, digestText(result.quote));
    }
  } finally {
    closeSetup(directory, database);
  }
});

test("projection rolls back chunks and job on crash before commit", () => {
  const { directory, path, database, binding } = setup();
  const trigger = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
  try {
    const captureId = "44444444-4444-4444-8444-444444444444";
    const spanId = "44444444-5555-4555-8555-444444444444";
    const text = "crash fencing vector source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);

    trigger.exec(
      "CREATE TRIGGER fail_vector_chunk BEFORE INSERT ON vector_chunk BEGIN SELECT RAISE(ABORT, 'injected_vector_failure'); END;",
    );
    const projection = projectionFor(database, scopeA, captureId, spanId, text, basis(1), "66666666-6666-4666-8666-666666666666");
    assert.throws(() => database.completeVectorProjection(claim, [projection], resultDigestFor(claim.job_id)));
    assert.deepEqual(vectorRowCount(path), { chunks: 0n, embeddings: 0n });
    assert.equal(database.jobs.get(claim.job_id)?.state, "running");
    trigger.exec("DROP TRIGGER fail_vector_chunk");

    const retry = database.completeVectorProjection(claim, [projection], resultDigestFor(claim.job_id));
    assert.equal(retry.status, "completed");
    assert.deepEqual(vectorRowCount(path), { chunks: 1n, embeddings: 1n });
  } finally {
    trigger.close();
    closeSetup(directory, database);
  }
});

test("wrong-owner completion is fenced without writing vectors", () => {
  const { directory, path, database, binding } = setup();
  try {
    const captureId = "77777777-7777-4777-8777-777777777777";
    const spanId = "77777777-8888-4888-8888-777777777777";
    const text = "fenced vector source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);

    const forged = { ...claim, owner: "00000000-0000-4000-8000-000000000000" };
    const rejected = database.completeVectorProjection(
      forged,
      [projectionFor(database, scopeA, captureId, spanId, text, basis(2), "99999999-9999-4999-8999-999999999999")],
      resultDigestFor(claim.job_id),
    );
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(vectorRowCount(path), { chunks: 0n, embeddings: 0n });
    assert.equal(database.jobs.get(claim.job_id)?.state, "running");
  } finally {
    closeSetup(directory, database);
  }
});

test("purged source fences late projection and removes vectors", () => {
  const { directory, path, database, binding, policy } = setup();
  try {
    const captureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const spanId = "aaaaaaaa-bbbb-4bbb-8bbb-aaaaaaaaaaaa";
    const text = "purge fenced vector source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const completed = database.completeVectorProjection(
      claim,
      [projectionFor(database, scopeA, captureId, spanId, text, basis(4), "aaaaaaaa-cccc-4ccc-8ccc-aaaaaaaaaaaa")],
      resultDigestFor(claim.job_id),
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(vectorRowCount(path), { chunks: 1n, embeddings: 1n });

    const secondCaptureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secondSpanId = "bbbbbbbb-cccc-4ccc-8ccc-bbbbbbbbbbbb";
    captureWithEmbed(database, binding, secondCaptureId, scopeA, "late vector source", secondSpanId);
    const lateClaim = database.jobs.claimNext(undefined, "embed");
    assert.ok(lateClaim);
    assert.equal(lateClaim.source_capture_id, secondCaptureId);

    // Simulate the purge barrier window: the tombstone lands while the
    // claimed job row is still present, so the projector must pause instead
    // of writing vectors.
    const barrier = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
    try {
      barrier.prepare("INSERT INTO purge_operation (operation_id, scope_id, expected_privacy_epoch, state, selected_count, requested_at, updated_at) VALUES (?, ?, ?, 'barrier', 1, ?, ?)").run(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        scopeA,
        database.getScopePrivacyEpoch(scopeA),
        "2026-09-07T09:00:00Z",
        "2026-09-07T09:00:00Z",
      );
      barrier.prepare("INSERT INTO purge_tombstone (capture_id, scope_id, operation_id, created_at) VALUES (?, ?, ?, ?)").run(
        secondCaptureId,
        scopeA,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "2026-09-07T09:00:00Z",
      );
    } finally {
      barrier.close();
    }
    const late = database.completeVectorProjection(
      lateClaim,
      [projectionFor(database, scopeA, secondCaptureId, secondSpanId, "late vector source", basis(5), "dddddddd-dddd-4ddd-8ddd-dddddddddddd")],
      resultDigestFor(lateClaim.job_id),
    );
    assert.equal(late.status, "rejected");
    assert.equal(late.reason, "source_purged");
    assert.equal(database.jobs.get(lateClaim.job_id)?.state, "paused");
    assert.deepEqual(vectorRowCount(path), { chunks: 1n, embeddings: 1n });

    // Full purge removes the projected vectors and both jobs with them.
    const purged = purgeSource(database, policy, {
      version: 1,
      operation_id: "dddddddd-cccc-4ccc-8ccc-dddddddddddd",
      scope_id: scopeA,
      capture_ids: [captureId],
      expected_privacy_epoch: database.getScopePrivacyEpoch(scopeA),
      requested_at: "2026-09-07T09:01:00Z",
    });
    assert.equal(purged.state, "pending");
    assert.equal(purged.physical_cleanup, "complete");
    assert.equal(database.getPurgeRuntimeState(purged.operation_id).state, "unknown");
    assert.deepEqual(vectorRowCount(path), { chunks: 0n, embeddings: 0n });
  } finally {
    closeSetup(directory, database);
  }
});

test("generation switch is atomic CAS and stale writes are fenced", () => {
  const { directory, database, binding } = setup();
  try {
    assert.equal(database.getActiveVectorGeneration(), "1");
    assert.equal(database.activateVectorGeneration("0", "2026-09-07T10:00:00Z"), undefined);
    assert.equal(database.getActiveVectorGeneration(), "1");
    assert.equal(database.activateVectorGeneration("1", "2026-09-07T10:00:00Z"), "2");
    assert.equal(database.getActiveVectorGeneration(), "2");

    const captureId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const spanId = "eeeeeeee-ffff-4fff-8fff-eeeeeeeeeeee";
    const text = "stale generation vector source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const staleGeneration = database.getActiveVectorGeneration();
    assert.equal(staleGeneration, "2");
    const staleProjection: VectorChunkProjection = {
      ...projectionFor(database, scopeA, captureId, spanId, text, basis(6), "ffffffff-ffff-4fff-8fff-ffffffffffff"),
      generation: "1",
      input_digest: vectorInputDigest({
        scope_id: scopeA,
        source_id: captureId,
        span_id: spanId,
        chunk_index: 0,
        text,
        profile_id: VECTOR_PROFILE_ID,
        tokenizer_version: VECTOR_TOKENIZER_VERSION,
        chunker_version: VECTOR_CHUNKER_VERSION,
        generation: "1",
      }),
    };
    assert.throws(
      () => database.completeVectorProjection(claim, [staleProjection], resultDigestFor(claim.job_id)),
      (error: unknown) => error instanceof Error && /job_stale|vector_generation_stale/.test(error.message),
    );
  } finally {
    closeSetup(directory, database);
  }
});

test("forbidden nearest rows never displace allowed rows", () => {
  const { directory, database } = setup([scopeA, scopeB]);
  try {
    const allowedCapture = "10101010-1010-4101-8101-010101010101";
    const allowedSpan = "10101010-2020-4202-8202-010101010101";
    const allowedText = "allowed scope vector document";
    captureWithEmbed(database, bindingFor([scopeA, scopeB]), allowedCapture, scopeA, allowedText, allowedSpan);
    const forbiddenCapture = "20202020-2020-4202-8202-020202020202";
    const forbiddenSpan = "20202020-3030-4303-8303-020202020202";
    const forbiddenText = "forbidden scope vector document";
    captureWithEmbed(database, bindingFor([scopeA, scopeB]), forbiddenCapture, scopeB, forbiddenText, forbiddenSpan);

    const first = database.jobs.claimNext(undefined, "embed");
    const second = database.jobs.claimNext(undefined, "embed");
    assert.ok(first);
    assert.ok(second);
    for (const claim of [first, second]) {
      const isAllowed = claim.scope_id === scopeA;
      const done = database.completeVectorProjection(
        claim,
        [
          projectionFor(
            database,
            claim.scope_id,
            claim.source_capture_id,
            isAllowed ? allowedSpan : forbiddenSpan,
            isAllowed ? allowedText : forbiddenText,
            isAllowed ? basis(0) : basis(1),
            isAllowed ? "30303030-3030-4303-8303-030303030303" : "40404040-4040-4404-8404-040404040404",
          ),
        ],
        resultDigestFor(claim.job_id),
      );
      assert.equal(done.status, "completed");
    }

    const query = basis(1);
    const allowedOnly = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA], mode: "current", token_budget: 100 },
      bindingFor([scopeA]),
      query,
      { limit: 10 },
    );
    assert.equal(allowedOnly.length, 1);
    assert.equal(allowedOnly[0]?.source_id, allowedCapture);

    const full = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA, scopeB], mode: "current", token_budget: 100 },
      bindingFor([scopeA, scopeB]),
      query,
      { limit: 1 },
    );
    assert.equal(full.length, 1);
    assert.equal(full[0]?.source_id, forbiddenCapture);
    assert.equal(full[0]?.distance, 0);
  } finally {
    closeSetup(directory, database);
  }
});

test("ungranted evidence class is excluded before TopK even at distance zero", () => {
  const { directory, database, binding } = setup();
  try {
    const policy = policyFor([scopeA]);
    setScopeOutputGrants(
      database,
      policy,
      scopeA,
      [{ target: "reader:codex_cli", source_classes: ["prompt"] }],
      "2026-09-07T07:02:00Z",
    );
    const allowedCapture = "50505050-5050-4505-8505-050505050505";
    const allowedSpan = "50505050-6060-4606-8606-050505050505";
    const allowedText = "granted prompt vector document";
    const preparedAllowed = prepareCaptureInput(envelope(allowedCapture, scopeA, allowedText, "prompt"), binding, {
      source_spans: [span(allowedSpan, allowedText)],
    });
    database.commitCapture(preparedAllowed, { task_version: EMBED_TASK_VERSION });
    const deniedCapture = "60606060-6060-4606-8606-060606060606";
    const deniedSpan = "60606060-7070-4707-8707-060606060606";
    const deniedText = "denied assistant vector document";
    const preparedDenied = prepareCaptureInput(
      envelope(deniedCapture, scopeA, deniedText, "assistant_output"),
      binding,
      { source_spans: [span(deniedSpan, deniedText)] },
    );
    database.commitCapture(preparedDenied, { task_version: EMBED_TASK_VERSION });

    for (let claim = database.jobs.claimNext(undefined, "embed"); claim !== undefined; claim = database.jobs.claimNext(undefined, "embed")) {
      const isAllowed = claim.source_capture_id === allowedCapture;
      const done = database.completeVectorProjection(
        claim,
        [
          projectionFor(
            database,
            scopeA,
            claim.source_capture_id,
            isAllowed ? allowedSpan : deniedSpan,
            isAllowed ? allowedText : deniedText,
            isAllowed ? basis(8) : basis(9),
            isAllowed ? "70707070-7070-4707-8707-070707070707" : "80808080-8080-4808-8808-080808080808",
          ),
        ],
        resultDigestFor(claim.job_id),
      );
      assert.equal(done.status, "completed");
    }

    const results = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA], mode: "current", token_budget: 100 },
      binding,
      basis(9),
      { limit: 1 },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.source_id, allowedCapture);
  } finally {
    closeSetup(directory, database);
  }
});

test("BigInt known_at bounds keep full precision and empty eligibility returns no rows", () => {
  const { directory, database, binding } = setup();
  try {
    const captureId = "90909090-9090-4909-8909-090909090909";
    const spanId = "90909090-0101-4010-8010-090909090909";
    const text = "bigint bound vector document";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const done = database.completeVectorProjection(
      claim,
      [projectionFor(database, scopeA, captureId, spanId, text, basis(11), "01010101-0101-4010-8010-010101010101")],
      resultDigestFor(claim.job_id),
    );
    assert.equal(done.status, "completed");

    const maxInt = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA], mode: "current", token_budget: 100, known_at_seq: "9223372036854775807" },
      binding,
      basis(11),
      { limit: 10 },
    );
    assert.equal(maxInt.length, 1);
    assert.equal(maxInt[0]?.commit_seq, 1n);

    const empty = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA], mode: "current", token_budget: 100, known_at_seq: "0" },
      binding,
      basis(11),
      { limit: 10 },
    );
    assert.equal(empty.length, 0);

    const excluded = database.searchVectorCandidates(
      { query: "vector", scope_ids: [scopeA], mode: "current", token_budget: 100 },
      binding,
      basis(11),
      { limit: 10, excluded_capture_id: captureId },
    );
    assert.equal(excluded.length, 0);
  } finally {
    closeSetup(directory, database);
  }
});

test("chunker keeps every chunk within 512 E5 tokens and never truncates", () => {
  const short: string[] = chunkPassageForE5("hello world", (formatted) => formatted.split(/\s+/u).length + 3);
  assert.deepEqual(short, ["hello world"]);

  const unit = "word";
  assert.throws(
    () =>
      chunkPassageForE5(`${unit} ${unit}`, (formatted) => (formatted.includes(unit) ? 600 : 1)),
    (error: unknown) => error instanceof Error && error.message === "chunk_too_long",
  );
  assert.throws(
    () => chunkPassageForE5("", () => 5),
    (error: unknown) => error instanceof Error && error.message === "chunk_empty",
  );
});

test("chunker bounds tokenizer calls for long exact sources", () => {
  const sourceText = Array.from(
    { length: 500 },
    (_, index) => `Sentence ${index}: alpha beta gamma delta epsilon zeta eta theta.`,
  ).join(" ");
  let calls = 0;
  let maxFormattedLength = 0;
  const chunks = chunkPassageForE5(sourceText, (formatted) => {
    calls += 1;
    maxFormattedLength = Math.max(maxFormattedLength, formatted.length);
    return Math.max(1, Math.ceil(formatted.length / 4));
  });
  assert.ok(chunks.length > 1);
  assert.ok(calls < 100, `expected bounded tokenizer calls, got ${calls}`);
  assert.ok(maxFormattedLength <= 1_809, `expected bounded tokenization input, got ${maxFormattedLength}`);
  let cursor = 0;
  for (const chunk of chunks) {
    const offset = sourceText.indexOf(chunk, cursor);
    assert.ok(offset >= 0);
    cursor = offset + chunk.length;
  }
  assert.equal(cursor, sourceText.length);
});

test("chunker counts the real E5 tokenizer including prefix and special tokens", { skip: !isNativeOnnxRuntimeSupported() }, async () => {
  const transformers = (await import("@huggingface/transformers")) as unknown as {
    readonly env: Record<string, boolean | string>;
    readonly AutoTokenizer: {
      readonly from_pretrained: (root: string, options: Record<string, unknown>) => Promise<E5TokenizerLike>;
    };
  };
  transformers.env["allowRemoteModels"] = false;
  transformers.env["allowLocalModels"] = true;
  transformers.env["useBrowserCache"] = false;
  transformers.env["useFSCache"] = false;
  transformers.env["useCustomCache"] = false;
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(
    join(repositoryRoot, ".models/e5/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78"),
    { revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", local_files_only: true },
  );
  const count = createE5TokenCounter(tokenizer);
  const seen: string[] = [];
  const recording = (formatted: string): number => {
    seen.push(formatted);
    return count(formatted);
  };
  const sourceText = Array.from(
    { length: 120 },
    (_, index) => `Der schnelle Fuchs ${index} springt über den faulen Hund.`,
  ).join("\n\t");
  const chunks = chunkPassageForE5(sourceText, recording);
  assert.ok(chunks.length > 1);
  assert.ok(seen.every((formatted) => formatted.startsWith("passage: ")));
  for (const chunk of chunks) {
    assert.ok(count(`passage: ${chunk}`) <= 512);
  }
  let sourceCursor = 0;
  for (const chunk of chunks) {
    const offset = sourceText.indexOf(chunk, sourceCursor);
    assert.ok(offset >= 0, "real E5 chunks must remain exact source substrings");
    sourceCursor = offset + chunk.length;
  }
  assert.equal(sourceCursor, sourceText.length);
});

test("qualified vec0 ranks the authorized persistent vector index", {
  skip: process.platform !== "darwin" || process.arch !== "arm64"
    ? "native vec0 ranking probe is executed on the macOS ARM64 asset host"
    : false,
}, () => {
  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/native/vec0.dylib");
  const { directory, database, binding } = setup([scopeA], { vector_extension_path: extensionPath });
  try {
    const captureId = "13131313-aaaa-4aaa-8aaa-131313131313";
    const spanId = "13131313-bbbb-4bbb-8bbb-131313131313";
    const text = "persistent vec0 authorized source";
    captureWithEmbed(database, binding, captureId, scopeA, text, spanId);
    const claim = database.jobs.claimNext(undefined, "embed");
    assert.ok(claim);
    const generation = database.getActiveVectorGeneration();
    const projection = projectionFor(database, scopeA, captureId, spanId, text, basis(17), "13131313-cccc-4ccc-8ccc-131313131313");
    assert.equal(database.completeVectorProjection(claim, [projection], resultDigestFor(claim.job_id)).status, "completed");
    const rows = database.searchVectorCandidates(
      { query: "authorized", scope_ids: [scopeA], mode: "current", token_budget: 100 },
      binding,
      basis(17),
      { limit: 1, generation },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source_id, captureId);
    assert.equal(rows[0]?.distance, 0);
  } finally {
    closeSetup(directory, database);
  }
});
