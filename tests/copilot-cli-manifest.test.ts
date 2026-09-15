import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { COPILOT_CLI_VERSION } from "../adapters/copilot-cli/index.js";
import { createTrustedBinding, parseSourceEnvelope } from "../src/host/contract.js";

const PINNED_CLI_VERSION = "1.0.83" as const;
const HOOK_REFERENCE_URL = "https://docs.github.com/en/copilot/reference/hooks-reference" as const;
const MANIFEST_URL = new URL("../../adapters/copilot-cli/manifest.json", import.meta.url);

const SCOPE_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPTURE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function copilotCliBindingInput(): Record<string, unknown> {
  return {
    version: 1,
    binding_id: BINDING_ID,
    host_kind: "copilot",
    surface: "copilot_cli",
    execution_domain: { kind: "local", id: "synthetic-local" },
    host_instance_id: "synthetic-instance",
    host_session_id: "synthetic-session",
    allowed_scope_ids: [SCOPE_ID],
    egress: {
      reader_targets: ["reader:copilot_cli"],
      provider_targets: [],
    },
  };
}

function promptTransformedEnvelope(event: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    capture_id: CAPTURE_ID,
    scope_id: SCOPE_ID,
    origin: {
      host_kind: "copilot",
      surface: "copilot_cli",
      execution_domain: { kind: "local", id: "synthetic-local" },
      host_instance_id: "synthetic-instance",
      host_session_id: "synthetic-session",
    },
    adapter_version: "1.0.0",
    event,
    payload: { source: "synthetic" },
    captured_at: "2026-09-07T00:00:00Z",
    truncation: { truncated: false },
    redaction: { applied: false, policy_version: "1.0.0" },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.ok(value !== null);
  assert.ok(!Array.isArray(value));
  return value as Record<string, unknown>;
}

function readCliVersion(manifest: Record<string, unknown>): unknown {
  const native = manifest["native"];
  if (typeof native !== "object" || native === null || Array.isArray(native)) return undefined;
  const record = native as Record<string, unknown>;
  for (const key of ["cliVersion", "cli_version", "copilotCliVersion", "copilot_cli_version", "version", "observedVersion"] as const) {
    const candidate: unknown = record[key];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function readCoverageGaps(manifest: Record<string, unknown>): unknown {
  for (const key of ["coverageGaps", "coverage_gaps", "gaps"] as const) {
    const candidate: unknown = manifest[key];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

test("pins the Copilot CLI native version to 1.0.83", () => {
  assert.equal(COPILOT_CLI_VERSION, PINNED_CLI_VERSION);
  assert.equal(COPILOT_CLI_VERSION, "1.0.83");
});

test("keeps the copilot/copilot_cli surface binding pair valid", () => {
  const binding = createTrustedBinding(copilotCliBindingInput());
  assert.equal(binding.host_kind, "copilot");
  assert.equal(binding.surface, "copilot_cli");
  assert.deepEqual([...binding.egress.reader_targets], ["reader:copilot_cli"]);

  assert.throws(() =>
    createTrustedBinding({ ...copilotCliBindingInput(), host_kind: "codex", surface: "copilot_cli" }),
  );
  assert.throws(() =>
    createTrustedBinding({ ...copilotCliBindingInput(), host_kind: "copilot", surface: "codex_cli" }),
  );
  assert.throws(() =>
    createTrustedBinding({
      ...copilotCliBindingInput(),
      egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
    }),
  );
});

test("keeps prompt_transformed as user prompt evidence", () => {
  const parsed = parseSourceEnvelope(
    promptTransformedEnvelope({
      stage: "prompt_transformed",
      role: "user",
      evidence_class: "prompt",
      native_ids: {},
      text: "synthetic transformed prompt",
    }),
  );
  assert.equal(parsed.event.stage, "prompt_transformed");
  assert.equal(parsed.event.role, "user");
  assert.equal(parsed.event.evidence_class, "prompt");

  assert.throws(() =>
    parseSourceEnvelope(
      promptTransformedEnvelope({
        stage: "prompt_transformed",
        role: "assistant",
        evidence_class: "prompt",
        native_ids: {},
        text: "wrong role",
      }),
    ),
  );
  assert.throws(() =>
    parseSourceEnvelope(
      promptTransformedEnvelope({
        stage: "prompt_transformed",
        role: "user",
        evidence_class: "assistant_output",
        native_ids: {},
        text: "wrong evidence class",
      }),
    ),
  );
});

test("pins the copilot-cli adapter manifest contract", (t) => {
  if (!existsSync(MANIFEST_URL)) {
    t.skip("adapters/copilot-cli/manifest.json is parent-owned and not present yet; pinned constants above still hold");
    return;
  }
  const raw = readFileSync(MANIFEST_URL, "utf8");
  const manifest = asRecord(JSON.parse(raw) as unknown);

  const status: unknown = manifest["status"];
  const admissionRaw: unknown = manifest["admission"];
  if (status === "source_checked") {
    assert.equal(status, "source_checked");
  } else {
    assert.ok(typeof admissionRaw === "object" && admissionRaw !== null, "manifest must pin source_checked or technical_only admission");
    const admission = admissionRaw as Record<string, unknown>;
    assert.equal(admission["default"], "technical_only");
    assert.equal(admission["e2eVerified"], false);
  }
  if (typeof admissionRaw === "object" && admissionRaw !== null && !Array.isArray(admissionRaw)) {
    const admission = admissionRaw as Record<string, unknown>;
    if (admission["e2eVerified"] !== undefined) assert.equal(admission["e2eVerified"], false);
  }

  assert.equal(readCliVersion(manifest), PINNED_CLI_VERSION);
  assert.equal(readCliVersion(manifest), COPILOT_CLI_VERSION);

  const sources: unknown = manifest["sources"];
  if (Array.isArray(sources)) {
    assert.ok(
      sources.includes(HOOK_REFERENCE_URL),
      `manifest sources must reference ${HOOK_REFERENCE_URL}`,
    );
  } else {
    assert.ok(raw.includes(HOOK_REFERENCE_URL), `manifest must reference ${HOOK_REFERENCE_URL}`);
  }

  const registrationRaw: unknown = manifest["registration"];
  assert.ok(typeof registrationRaw === "object" && registrationRaw !== null && !Array.isArray(registrationRaw));
  const registration = registrationRaw as Record<string, unknown>;
  assert.equal(registration["version"], 1);
  assert.equal(typeof registration["kind"], "string");
  assert.ok((registration["kind"] as string).length > 0);
  assert.match(JSON.stringify(registration), /bash|powershell/i);

  const gapsRaw = readCoverageGaps(manifest);
  assert.ok(Array.isArray(gapsRaw), "manifest must list explicit coverage gaps");
  const gaps = gapsRaw as unknown[];
  assert.ok(gaps.length >= 4, "manifest must pin at least the four documented CLI coverage gaps");
  for (const gap of gaps) assert.equal(typeof gap, "string");
  const gapsText = (gaps as string[]).join("\n").toLowerCase();
  assert.ok(
    gapsText.includes("correlat") || (gapsText.includes("message") && gapsText.includes("id")),
    "coverage gaps must state no message/event ID correlation",
  );
  assert.ok(
    gapsText.includes("drop") && gapsText.includes("submitted"),
    "coverage gaps must state submitted output is dropped",
  );
  assert.ok(gapsText.includes("transcript"), "coverage gaps must state transcript path is metadata only");
  assert.ok(
    (gapsText.includes("g1") && gapsText.includes("g2")) ||
      (gapsText.includes("native") && gapsText.includes("unverified")),
    "coverage gaps must state native G1/G2 delivery is unverified",
  );
});
