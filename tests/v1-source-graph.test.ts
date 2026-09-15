import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import { purgeSource } from "../src/core/purge-source.js";
import { createPolicySetupBinding, setScopeOutputGrants, type PolicySetupBinding } from "../src/core/policy.js";
import { createTrustedBinding, type RecallRequest, type TrustedBinding } from "../src/host/contract.js";
import { expandSourceGraph } from "../src/retrieval/source-graph.js";
import { AgentMemoryDatabase } from "../src/store/database.js";


const scopeA = "11111111-1111-4111-8111-111111111111";
const scopeB = "22222222-2222-4222-8222-222222222222";
const allSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;
type Stage = "prompt_submitted" | "assistant_final" | "tool_started" | "tool_result";

function bindingFor(scopeIds: readonly string[]): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: randomUUID(),
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "v1-source-graph" },
    host_instance_id: "source-graph-host",
    host_session_id: "source-graph-session",
    allowed_scope_ids: [...scopeIds],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
}

function policyFor(scopeIds: readonly string[]): PolicySetupBinding {
  return createPolicySetupBinding({
    version: 1,
    setup_id: randomUUID(),
    allowed_scope_ids: [...scopeIds],
    allowed_output_targets: ["reader:codex_cli"],
  });
}

function envelope(
  binding: TrustedBinding,
  scopeId: string,
  captureId: string,
  stage: Stage,
  nativeIds: Record<string, string>,
  text: string,
  filePath: string,
  capturedAt: string,
): unknown {
  const identity = stage === "prompt_submitted"
    ? { role: "user", evidence_class: "prompt" }
    : stage === "assistant_final"
      ? { role: "assistant", evidence_class: "assistant_output" }
      : stage === "tool_started"
        ? { role: "tool", evidence_class: "tool_input" }
        : { role: "tool", evidence_class: "tool_output" };
  return {
    version: 1,
    capture_id: captureId,
    scope_id: scopeId,
    origin: {
      host_kind: binding.host_kind,
      surface: binding.surface,
      execution_domain: binding.execution_domain,
      host_instance_id: binding.host_instance_id,
      host_session_id: binding.host_session_id,
    },
    adapter_version: "0.1.0",
    event: {
      stage,
      ...identity,
      native_ids: nativeIds,
      text,
      ...(stage === "tool_result" ? { outcome: "succeeded" } : {}),
    },
    payload: { text, file_path: filePath },
    captured_at: capturedAt,
    occurred_at: capturedAt,
    truncation: { truncated: false },
    redaction: { applied: true, policy_version: "1.0.0" },
  };
}

function setup(scopeIds: readonly string[] = [scopeA]): {
  readonly directory: string;
  readonly database: AgentMemoryDatabase;
  readonly binding: TrustedBinding;
  readonly policy: PolicySetupBinding;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-source-graph-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: false });
  const binding = bindingFor(scopeIds);
  const policy = policyFor(scopeIds);
  for (const scopeId of scopeIds) {
    database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: `source-graph-${scopeId}`, created_at: "2026-09-15T08:00:00Z" });
    database.registerSession(scopeId, binding, "2026-09-15T08:00:01Z");
    setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: [...allSourceClasses] }], "2026-09-15T08:00:02Z");
  }
  return { directory, database, binding, policy };
}

function addSource(
  fixture: ReturnType<typeof setup>,
  scopeId: string,
  stage: Stage,
  nativeIds: Record<string, string>,
  filePath: string,
  capturedAt: string,
): { readonly captureId: string; readonly commitSeq: string } {
  const captureId = randomUUID();
  const ack = capture(
    envelope(fixture.binding, scopeId, captureId, stage, nativeIds, `${stage}:${captureId}`, filePath, capturedAt),
    fixture.binding,
    fixture.database,
  );
  return { captureId, commitSeq: ack.commit_seq };
}

function request(scopeIds: readonly string[], knownAtSeq?: string): RecallRequest {
  return {
    query: "structural context",
    scope_ids: [...scopeIds],
    mode: "current",
    token_budget: 1_000,
    ...(knownAtSeq === undefined ? {} : { known_at_seq: knownAtSeq }),
  };
}

function close(fixture: ReturnType<typeof setup>): void {
  if (!fixture.database.isClosed()) fixture.database.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

const futureDeadline = "2099-01-01T00:00:00Z";

test("expands authorized source metadata and adjacent session events for two hops", () => {
  const fixture = setup();
  try {
    const first = addSource(fixture, scopeA, "prompt_submitted", { session_id: "native", message_id: "message-1" }, "/repo/a.ts", "2026-09-15T08:01:00Z");
    const second = addSource(fixture, scopeA, "tool_started", { session_id: "native", message_id: "message-1", tool_call_id: "tool-1" }, "/repo/b.ts", "2026-09-15T08:01:01Z");
    const third = addSource(fixture, scopeA, "tool_result", { session_id: "native", tool_call_id: "tool-1" }, "/repo/c.ts", "2026-09-15T08:01:02Z");

    const result = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], { deadline_at: futureDeadline });

    assert.deepEqual(new Set(result.source_ids), new Set([second.captureId, third.captureId]));
    assert.equal(result.hops, 2);
    assert.equal(result.complete, true);
    assert.ok(result.edges.some((edge) => edge.from_id === first.captureId && edge.source_id === second.captureId && edge.hop === 1));
    assert.ok(result.edges.some((edge) => edge.from_id === second.captureId && edge.source_id === third.captureId && edge.hop === 2));
  } finally {
    close(fixture);
  }
});

test("does not join reused native message or tool IDs across native sessions", () => {
  const fixture = setup();
  try {
    const first = addSource(fixture, scopeA, "prompt_submitted", {
      session_id: "native-one",
      message_id: "message-1",
      tool_call_id: "tool-1",
    }, "/repo/native-one.ts", "2026-09-15T08:01:10Z");
    addSource(fixture, scopeA, "assistant_final", { session_id: "native-filler", message_id: "filler" }, "/repo/filler.ts", "2026-09-15T08:01:11Z");
    const reused = addSource(fixture, scopeA, "tool_started", {
      session_id: "native-two",
      message_id: "message-1",
      tool_call_id: "tool-1",
    }, "/repo/native-two.ts", "2026-09-15T08:01:12Z");

    const result = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], {
      max_hops: 1,
      deadline_at: futureDeadline,
    });

    assert.equal(result.source_ids.includes(reused.captureId), false);
    assert.equal(result.edges.some((edge) => edge.source_id === reused.captureId), false);
  } finally {
    close(fixture);
  }
});

test("terminates cycles and reports a node-budget truncation", () => {
  const fixture = setup();
  try {
    const first = addSource(fixture, scopeA, "prompt_submitted", { session_id: "cycle", message_id: "cycle-a" }, "/repo/cycle.ts", "2026-09-15T08:02:00Z");
    const second = addSource(fixture, scopeA, "prompt_submitted", { session_id: "cycle", message_id: "cycle-b" }, "/repo/cycle.ts", "2026-09-15T08:02:01Z");
    const third = addSource(fixture, scopeA, "prompt_submitted", { session_id: "cycle", message_id: "cycle-a" }, "/repo/cycle.ts", "2026-09-15T08:02:02Z");

    const complete = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], { deadline_at: futureDeadline });
    assert.deepEqual(new Set(complete.source_ids), new Set([second.captureId, third.captureId]));
    assert.equal(complete.complete, true);
    assert.ok(complete.edges.every((edge) => edge.hop <= 2));

    const budgeted = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], { max_nodes: 1, deadline_at: futureDeadline });
    assert.equal(budgeted.source_ids.length, 1);
    assert.equal(new Set(budgeted.source_ids).size, 1);
    assert.equal(budgeted.complete, false);
  } finally {
    close(fixture);
  }
});

test("does not link identical metadata across scopes", () => {
  const fixture = setup([scopeA, scopeB]);
  try {
    const local = addSource(fixture, scopeA, "prompt_submitted", { session_id: "same", message_id: "same-message" }, "/repo/shared.ts", "2026-09-15T08:03:00Z");
    const foreign = addSource(fixture, scopeB, "prompt_submitted", { session_id: "same", message_id: "same-message" }, "/repo/shared.ts", "2026-09-15T08:03:01Z");

    const result = expandSourceGraph(fixture.database, request([scopeA, scopeB]), fixture.binding, [local.captureId], { deadline_at: futureDeadline });

    assert.equal(result.source_ids.includes(foreign.captureId), false);
    assert.equal(result.edges.some((edge) => edge.source_id === foreign.captureId), false);
  } finally {
    close(fixture);
  }
});

test("filters revoked and purged hop sources before expansion", () => {
  const fixture = setup();
  try {
    const first = addSource(fixture, scopeA, "prompt_submitted", { session_id: "filtered", message_id: "filtered-message" }, "/repo/filtered.ts", "2026-09-15T08:04:00Z");
    const second = addSource(fixture, scopeA, "tool_started", { session_id: "filtered", message_id: "filtered-message" }, "/repo/filtered.ts", "2026-09-15T08:04:01Z");

    setScopeOutputGrants(fixture.database, fixture.policy, scopeA, [{ target: "reader:codex_cli", source_classes: ["prompt"] }], "2026-09-15T08:04:02Z");
    const revoked = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], { deadline_at: futureDeadline });
    assert.equal(revoked.source_ids.includes(second.captureId), false);

    setScopeOutputGrants(fixture.database, fixture.policy, scopeA, [{ target: "reader:codex_cli", source_classes: [...allSourceClasses] }], "2026-09-15T08:04:03Z");
    purgeSource(fixture.database, fixture.policy, {
      version: 1,
      operation_id: randomUUID(),
      scope_id: scopeA,
      capture_ids: [second.captureId],
      expected_privacy_epoch: fixture.database.getScopePrivacyEpoch(scopeA),
      requested_at: "2026-09-15T08:04:04Z",
      full: true,
      defer_completion: true,
    });
    const purged = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], { deadline_at: futureDeadline });
    assert.equal(purged.source_ids.includes(second.captureId), false);
  } finally {
    close(fixture);
  }
});

test("applies known-at and current-session prompt cutoffs on every hop", () => {
  const fixture = setup();
  try {
    const first = addSource(fixture, scopeA, "assistant_final", { session_id: "cutoff", message_id: "cutoff-message" }, "/repo/cutoff.ts", "2026-09-15T08:05:00Z");
    const later = addSource(fixture, scopeA, "prompt_submitted", { session_id: "cutoff", message_id: "cutoff-message" }, "/repo/cutoff.ts", "2026-09-15T08:05:01Z");

    const beforeLater = expandSourceGraph(fixture.database, request([scopeA], first.commitSeq), fixture.binding, [first.captureId], { deadline_at: futureDeadline });
    assert.equal(beforeLater.source_ids.includes(later.captureId), false);

    const excluded = expandSourceGraph(fixture.database, request([scopeA]), fixture.binding, [first.captureId], {
      deadline_at: futureDeadline,
      exclude_current_session_prompts: true,
    });
    assert.equal(excluded.source_ids.includes(later.captureId), false);
  } finally {
    close(fixture);
  }
});
