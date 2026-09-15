import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPolicyOutputBinding, createPolicySetupBinding, setLocalUiOutputGrants, setScopeOutputGrants } from "../src/core/policy.js";
import { capture } from "../src/core/capture.js";
import { createTrustedBinding } from "../src/host/contract.js";
import { normalizeNativeEvent } from "../src/host/events.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "22222222-2222-4222-8222-222222222222";
const setupId = "33333333-3333-4333-8333-333333333333";
const outputBindingId = "44444444-4444-4444-8444-444444444444";
const allSourceClasses = ["prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic"] as const;

test("local UI exposes the complete read-only V1 data contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-view-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"), { extraction_enabled: false });
  const binding = createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "view-test" },
    host_instance_id: "view-host",
    host_session_id: "view-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
  const policy = createPolicySetupBinding({
    version: 1,
    setup_id: setupId,
    allowed_scope_ids: [scopeId],
    allowed_output_targets: ["local_ui", "reader:codex_cli"],
  });
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "view-test", created_at: "2026-09-15T20:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-15T20:00:01Z");
  setScopeOutputGrants(database, policy, scopeId, [{ target: "reader:codex_cli", source_classes: ["prompt", "assistant_output"] }], "2026-09-15T20:00:02Z");
  setLocalUiOutputGrants(database, policy, scopeId, allSourceClasses, "2026-09-15T20:00:03Z");
  const localUi = createPolicyOutputBinding(policy, {
    version: 1,
    output_binding_id: outputBindingId,
    setup_id: setupId,
    scope_id: scopeId,
    target: "local_ui",
  });

  try {
    const sourceText = "This is a complete source event with a short evidence span.";
    const captureId = "55555555-5555-4555-8555-555555555555";
    const spanId = "66666666-6666-4666-8666-666666666666";
    const normalized = normalizeNativeEvent({
      version: 1,
      capture_id: captureId,
      scope_id: scopeId,
      adapter_version: "1.0.0",
      stage: "prompt_submitted",
      native_ids: { session_id: "native-view", turn_id: captureId },
      text: sourceText,
      payload: { text: sourceText },
      captured_at: "2026-09-15T20:00:04Z",
      coverage: { status: "complete" },
    }, binding);
    capture(normalized, binding, database, {
      source_spans: [{
        span_id: spanId,
        root: "payload",
        path: "/text",
        start_utf16: 0,
        end_utf16: sourceText.length,
        digest: createHash("sha256").update(sourceText, "utf8").digest("hex"),
      }],
    });
    const tokenSavings = database.getTokenSavingsForUi(localUi, { countUnits: (text) => text.length });
    assert.equal(tokenSavings.status, "computed");
    assert.equal(tokenSavings.unit, "tokens");
    assert.equal(tokenSavings.measured_sources, 1);
    assert.ok(tokenSavings.saved_units > 0);
    const snapshot = database.getLocalUiSnapshot(localUi);
    assert.equal(snapshot.scope_id, scopeId);
    assert.equal(snapshot.capture_paused, false);
    assert.equal(database.getUiCounts(localUi).source_count, 1n);
    assert.deepEqual(database.listMemoryItemsForUi(localUi, 10), []);
    assert.deepEqual(database.listQueryTracesForUi(localUi, 10), []);
    assert.equal(database.getPrivacySnapshotForUi(localUi).grants.filter((grant) => grant.output_target === "local_ui").length, allSourceClasses.length);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
