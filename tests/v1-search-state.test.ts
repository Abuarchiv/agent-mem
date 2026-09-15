import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_SEARCH_WEIGHTS, type ProcedureRule, type SearchReport, type SignalValues } from "../src/retrieval/intelligence-types.js";
import { SearchState } from "../src/v1/search-state.js";

const scopeA = "scope-a";
const scopeB = "scope-b";
const bindingA = "binding-a";

function features(overrides: Partial<SignalValues> = {}): SignalValues {
  return {
    lexical: 0,
    semantic: 0,
    graph: 0,
    procedure: 0,
    recency: 0,
    ...overrides,
  };
}

function report(input: {
  queryId?: string;
  bindingId?: string;
  scopeId?: string;
  captureId?: string;
  createdAt?: string;
  candidateFeatures?: SignalValues;
} = {}): SearchReport {
  return {
    query_id: input.queryId ?? "query-1",
    binding_id: input.bindingId ?? bindingA,
    scope_id: input.scopeId ?? scopeA,
    kind: "semantic",
    created_at: input.createdAt ?? new Date().toISOString(),
    stages: ["lexical"],
    reranker: "disabled",
    graph_hops: 0,
    graph_added: 0,
    graph_complete: true,
    weights: { ...DEFAULT_SEARCH_WEIGHTS },
    learned_samples: 0,
    candidates: [{ capture_id: input.captureId ?? "capture-1", features: input.candidateFeatures ?? features({ lexical: 1 }) }],
    procedure_ids: [],
  };
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

test("persists only private feedback/procedures and deep-copies ephemeral reports", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    const original = report({ queryId: "query-deep-copy", captureId: "capture-deep-copy" });
    state.remember(original);
    original.candidates[0]!.features.lexical = 99;

    assert.equal(state.sampleCount(scopeA, "semantic"), 0);
    assert.equal(state.report("query-deep-copy", bindingA)?.candidates[0]?.features.lexical, 1);
    const returned = state.report("query-deep-copy", bindingA)!;
    returned.candidates[0]!.features.lexical = 88;
    assert.equal(state.report("query-deep-copy", bindingA)?.candidates[0]?.features.lexical, 1);

    const rule: ProcedureRule = { scope_id: scopeA, capture_id: "capture-procedure", terms: ["Deploy"] };
    state.registerProcedure(rule);
    rule.terms.push("mutated-after-register");

    const stateFile = join(directory, "search-state.json");
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
    const persisted = readFileSync(stateFile, "utf8");
    assert.equal(persisted.includes("query-deep-copy"), false);
    assert.equal((JSON.parse(persisted) as { reports?: unknown }).reports, undefined);

    const restarted = new SearchState(directory);
    assert.equal(restarted.report("query-deep-copy", bindingA), undefined);
    assert.deepEqual(restarted.procedures(scopeA), [{ scope_id: scopeA, capture_id: "capture-procedure", terms: ["Deploy"] }]);
    assert.deepEqual(restarted.status(), { feedback: 0, procedures: 1, reports: 0 });
  } finally {
    cleanup(directory);
  }
});

test("migrates v1 state to v2 without losing feedback or procedures", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    state.registerProcedure({ scope_id: scopeA, capture_id: "legacy-procedure", terms: ["Deploy"] });
    state.remember(report({ queryId: "legacy-query", captureId: "legacy-capture" }));
    state.feedback(scopeA, "legacy-query", "legacy-capture", true);

    const stateFile = join(directory, "search-state.json");
    const current = JSON.parse(readFileSync(stateFile, "utf8")) as { feedback: unknown[]; procedures: unknown[] };
    const legacy = { version: 1, feedback: current.feedback, procedures: current.procedures };
    writeFileSync(stateFile, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const migrated = new SearchState(directory);
    assert.equal(migrated.sampleCount(scopeA, "semantic"), 1);
    assert.deepEqual(migrated.procedures(scopeA), [{ scope_id: scopeA, capture_id: "legacy-procedure", terms: ["Deploy"] }]);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { ...legacy, version: 2, purge_epochs: {} });
  } finally {
    cleanup(directory);
  }
});

test("rejects foreign, stale, and non-candidate feedback", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    state.remember(report({ queryId: "query-current", captureId: "capture-current" }));

    assert.throws(
      () => state.feedback(scopeB, "query-current", "capture-current", true),
      /feedback_scope_mismatch/,
    );
    assert.throws(
      () => state.feedback(scopeA, "query-current", "not-a-candidate", true),
      /feedback_candidate_missing/,
    );

    state.remember(report({
      queryId: "query-stale",
      captureId: "capture-stale",
      createdAt: new Date(Date.now() - 15 * 60 * 1000 - 1_000).toISOString(),
    }));
    assert.throws(
      () => state.feedback(scopeA, "query-stale", "capture-stale", true),
      /feedback_report_stale/,
    );
    assert.equal(state.report("query-stale", bindingA), undefined);
  } finally {
    cleanup(directory);
  }
});

test("keeps the fixed baseline until five labels, then learns bounded feature weights", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    const baseline = state.weights(scopeA, "semantic");

    for (let index = 0; index < 5; index += 1) {
      const queryId = `query-${index}`;
      const captureId = `capture-${index}`;
      state.remember(report({
        queryId,
        captureId,
        candidateFeatures: features({ lexical: 1 }),
      }));
      const result = state.feedback(scopeA, queryId, captureId, true);
      assert.equal(result.samples, index + 1);
      if (index < 4) assert.deepEqual(result.weights, baseline);
    }

    const learned = state.weights(scopeA, "semantic");
    assert.equal(state.sampleCount(scopeA, "semantic"), 5);
    assert.ok(learned.lexical > baseline.lexical);
    assert.ok(Number.isFinite(learned.lexical));
    assert.ok(learned.lexical <= 2.5);
    assert.equal(learned.recency, baseline.recency);
    assert.deepEqual(state.weights(scopeB, "semantic"), baseline);
    for (let index = 0; index < 5; index++) {
      const queryId = `negative-${index}`;
      state.remember(report({ queryId, candidateFeatures: features({ graph: 1 }) }));
      state.feedback(scopeA, queryId, "capture-1", false);
    }
    assert.ok(state.weights(scopeA, "semantic").graph < baseline.graph);
    state.forgetSources(scopeA, ["indirect-predecessor"]);
    assert.deepEqual(state.weights(scopeA, "semantic"), baseline);
    assert.equal(state.status().reports, 0);
  } finally {
    cleanup(directory);
  }
});

test("matches procedure terms literally, keeps scopes separate, and forgets source state", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    const sourceId = "capture-forget";
    state.registerProcedure({ scope_id: scopeA, capture_id: sourceId, terms: ["Deploy"] });
    state.registerProcedure({ scope_id: scopeA, capture_id: "capture-literal", terms: ["a+b"] });
    state.registerProcedure({ scope_id: scopeB, capture_id: "capture-other-scope", terms: ["Deploy"] });
    state.remember(report({ queryId: "query-forget", captureId: sourceId }));
    state.feedback(scopeA, "query-forget", sourceId, true);

    assert.deepEqual(state.matchingProcedures(scopeA, "please deploy now").map((rule) => rule.capture_id), [sourceId]);
    assert.deepEqual(state.matchingProcedures(scopeA, "deployment now"), []);
    assert.deepEqual(state.matchingProcedures(scopeA, "aXb"), []);
    assert.deepEqual(state.matchingProcedures(scopeB, "please deploy now").map((rule) => rule.capture_id), ["capture-other-scope"]);

    state.forgetSources(scopeA, [sourceId]);
    assert.equal(state.sampleCount(scopeA, "semantic"), 0);
    assert.equal(state.report("query-forget", bindingA), undefined);
    assert.equal(state.procedures(scopeA).some((rule) => rule.capture_id === sourceId), false);
    assert.equal(state.procedures(scopeB).length, 1);
    assert.deepEqual(state.status(), { feedback: 0, procedures: 2, reports: 0 });
  } finally {
    cleanup(directory);
  }
});

test("reconciles newer purge epochs once and keeps scopes isolated", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    state.registerProcedure({ scope_id: scopeA, capture_id: "capture-purged", terms: ["purged"] });
    state.registerProcedure({ scope_id: scopeA, capture_id: "capture-keep", terms: ["keep"] });
    state.registerProcedure({ scope_id: scopeB, capture_id: "capture-other", terms: ["other"] });
    for (let index = 0; index < 5; index += 1) {
      const queryId = `purge-query-${index}`;
      const captureId = `learned-capture-${index}`;
      state.remember(report({ queryId, captureId }));
      state.feedback(scopeA, queryId, captureId, true);
    }
    state.remember(report({ queryId: "scope-report", captureId: "unlisted-capture" }));
    state.remember(report({ queryId: "other-report", scopeId: scopeB, captureId: "other-capture" }));

    state.reconcilePurges(scopeA, "7", ["capture-purged"]);
    assert.equal(state.sampleCount(scopeA, "semantic"), 0);
    assert.equal(state.report("scope-report", bindingA), undefined);
    assert.ok(state.report("other-report", bindingA));
    assert.deepEqual(state.procedures(scopeA).map((rule) => rule.capture_id), ["capture-keep"]);
    assert.deepEqual(state.procedures(scopeB).map((rule) => rule.capture_id), ["capture-other"]);

    const stateFile = join(directory, "search-state.json");
    assert.deepEqual((JSON.parse(readFileSync(stateFile, "utf8")) as { purge_epochs: Record<string, string> }).purge_epochs, { [scopeA]: "7" });

    const restarted = new SearchState(directory);
    for (let index = 0; index < 5; index += 1) {
      const queryId = `new-query-${index}`;
      const captureId = `new-capture-${index}`;
      restarted.remember(report({ queryId, captureId }));
      restarted.feedback(scopeA, queryId, captureId, true);
    }
    const learned = restarted.weights(scopeA, "semantic");
    restarted.remember(report({ queryId: "same-epoch-report", captureId: "fresh-capture" }));
    assert.throws(
      () => restarted.reconcilePurges(scopeA, "7.0", []),
      /search_state_privacy_epoch_invalid/,
    );
    restarted.reconcilePurges(scopeA, "7", ["capture-keep"]);
    assert.equal(restarted.sampleCount(scopeA, "semantic"), 5);
    assert.deepEqual(restarted.weights(scopeA, "semantic"), learned);
    assert.ok(restarted.report("same-epoch-report", bindingA));

    assert.throws(
      () => restarted.reconcilePurges(scopeA, "6", ["capture-keep"]),
      /search_state_privacy_epoch_regressed/,
    );
    assert.equal(restarted.sampleCount(scopeA, "semantic"), 5);

    restarted.reconcilePurges(scopeA, "8", ["capture-keep"]);
    assert.equal(restarted.sampleCount(scopeA, "semantic"), 0);
    assert.equal(restarted.report("same-epoch-report", bindingA), undefined);
    assert.deepEqual(restarted.procedures(scopeA), []);
    assert.deepEqual(restarted.procedures(scopeB).map((rule) => rule.capture_id), ["capture-other"]);
    assert.deepEqual((JSON.parse(readFileSync(stateFile, "utf8")) as { purge_epochs: Record<string, string> }).purge_epochs, { [scopeA]: "8" });
  } finally {
    cleanup(directory);
  }
});

test("does not mutate state when the purge checkpoint write fails", {
  skip: process.platform === "win32" || process.getuid?.() === 0 ? "directory permissions are not enforceable" : false,
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const state = new SearchState(directory);
    state.registerProcedure({ scope_id: scopeA, capture_id: "write-failure", terms: ["failure"] });
    state.remember(report({ queryId: "write-failure-report", captureId: "write-failure" }));
    const stateFile = join(directory, "search-state.json");
    const before = readFileSync(stateFile, "utf8");

    chmodSync(directory, 0o500);
    try {
      assert.throws(
        () => state.reconcilePurges(scopeA, "1", ["write-failure"]),
        /EACCES|EPERM/,
      );
    } finally {
      chmodSync(directory, 0o700);
    }

    assert.equal(readFileSync(stateFile, "utf8"), before);
    assert.deepEqual(state.procedures(scopeA).map((rule) => rule.capture_id), ["write-failure"]);
    assert.ok(state.report("write-failure-report", bindingA));
    assert.deepEqual((JSON.parse(before) as { purge_epochs: Record<string, string> }).purge_epochs, {});
  } finally {
    cleanup(directory);
  }
});

test("rejects corrupt, oversized, and symlinked state without overwriting it", () => {
  const corruptDirectory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  const oversizedDirectory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  const symlinkDirectory = mkdtempSync(join(tmpdir(), "agent-memory-search-state-"));
  try {
    const corruptPath = join(corruptDirectory, "search-state.json");
    writeFileSync(corruptPath, "not json\n", { mode: 0o600 });
    assert.throws(() => new SearchState(corruptDirectory), /search_state_invalid/);
    assert.equal(readFileSync(corruptPath, "utf8"), "not json\n");

    const oversizedPath = join(oversizedDirectory, "search-state.json");
    writeFileSync(oversizedPath, "x".repeat(1_000_001), { mode: 0o600 });
    assert.throws(() => new SearchState(oversizedDirectory), /search_state_file_too_large/);
    assert.equal(statSync(oversizedPath).size, 1_000_001);

    const targetPath = join(symlinkDirectory, "real-state.json");
    const symlinkPath = join(symlinkDirectory, "search-state.json");
    writeFileSync(targetPath, "{}\n", { mode: 0o600 });
    symlinkSync(targetPath, symlinkPath);
    assert.throws(() => new SearchState(symlinkDirectory), /search_state_file_must_be_owned_and_private/);
    assert.equal(readFileSync(targetPath, "utf8"), "{}\n");
  } finally {
    cleanup(corruptDirectory);
    cleanup(oversizedDirectory);
    cleanup(symlinkDirectory);
  }
});
