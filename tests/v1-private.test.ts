import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { capture } from "../src/core/capture.js";
import { redactCaptureInput } from "../src/core/redact.js";
import { createTrustedBinding, type TrustedBinding } from "../src/host/contract.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = "11111111-1111-4111-8111-111111111111";
const bindingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const captureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bindingFor(): TrustedBinding {
  return createTrustedBinding({
    version: 1,
    binding_id: bindingId,
    host_kind: "codex",
    surface: "codex_cli",
    execution_domain: { kind: "local", id: "v1-private" },
    host_instance_id: "v1-private-host",
    host_session_id: "v1-private-session",
    allowed_scope_ids: [scopeId],
    egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
  });
}

function setupDatabase(database: AgentMemoryDatabase, binding: TrustedBinding): void {
  database.registerScope({ scope_id: scopeId, kind: "project", owner_ref: "v1-private", created_at: "2026-09-15T10:00:00Z" });
  database.registerSession(scopeId, binding, "2026-09-15T10:00:01Z");
}

test("capture strips nested and unmatched private blocks before source and FTS persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-mem-private-"));
  const path = join(directory, "vault.sqlite");
  const binding = bindingFor();
  const rawText = "PUBLIC_BEFORE <private>PRIVATE_OUTER <private>PRIVATE_NESTED</private> PRIVATE_OUTER_TAIL</private> PUBLIC_MIDDLE <private>PRIVATE_UNMATCHED PUBLIC_AFTER_UNMATCHED";
  const sanitized = redactCaptureInput({ payload: { text: rawText } }).value as { payload: { text: string } };
  const publicText = sanitized.payload.text;
  const database = new AgentMemoryDatabase(path, { extraction_enabled: false });
  try {
    setupDatabase(database, binding);
    const ack = capture(
      {
        version: 1,
        capture_id: captureId,
        scope_id: scopeId,
        origin: {
          host_kind: "codex",
          surface: "codex_cli",
          execution_domain: { kind: "local", id: "v1-private" },
          host_instance_id: "v1-private-host",
          host_session_id: "v1-private-session",
        },
        adapter_version: "0.1.0",
        event: {
          stage: "prompt_submitted",
          role: "user",
          evidence_class: "prompt",
          native_ids: { session_id: "v1-private-session", turn_id: captureId },
          text: rawText,
        },
        payload: { text: rawText },
        captured_at: "2026-09-15T10:01:00Z",
        occurred_at: "2026-09-15T10:01:00Z",
        truncation: { truncated: false },
        redaction: { applied: false, policy_version: "1.0.0" },
      },
      binding,
      database,
      {
        source_spans: [{
          span_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          root: "payload",
          path: "/text",
          start_utf16: 0,
          end_utf16: publicText.length,
          digest: createHash("sha256").update(publicText, "utf8").digest("hex"),
        }],
      },
    );

    const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true });
    try {
      const source = raw.prepare("SELECT payload_json, event_json FROM source_event WHERE capture_id = ?").get(ack.capture_id) as { payload_json: string; event_json: string };
      const serialized = `${source.payload_json}\n${source.event_json}`;
      assert.equal(serialized.includes("PRIVATE_OUTER"), false);
      assert.equal(serialized.includes("PRIVATE_NESTED"), false);
      assert.equal(serialized.includes("PRIVATE_UNMATCHED"), false);
      assert.equal(serialized.includes("PUBLIC_BEFORE"), true);
      assert.equal(serialized.includes("PUBLIC_MIDDLE"), true);

      const span = raw.prepare("SELECT start_utf16, end_utf16, digest FROM source_span WHERE source_id = ? AND root = 'payload'").get(ack.capture_id) as { start_utf16: bigint; end_utf16: bigint; digest: string };
      assert.equal(span.start_utf16, 0n);
      assert.equal(span.end_utf16, BigInt(publicText.length));
      assert.equal(span.digest, createHash("sha256").update(publicText, "utf8").digest("hex"));

      const ftsCount = (query: string): bigint => (raw.prepare("SELECT COUNT(*) AS count FROM search_fts WHERE search_fts MATCH ?").get(query) as { count: bigint }).count;
      assert.equal(ftsCount("PRIVATE_OUTER"), 0n);
      assert.ok(ftsCount("PUBLIC_BEFORE") > 0n);
      assert.ok(ftsCount("PUBLIC_MIDDLE") > 0n);
    } finally {
      raw.close();
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
