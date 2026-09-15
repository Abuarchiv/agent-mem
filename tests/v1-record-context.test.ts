import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildEvidencePacket, createDirectedEvidenceHandoff, createPreparationContext,
  packetDigest, parseModelContextWrapper, recognizePersistedEvidencePacket,
  serializeEvidencePacket, serializeModelContext, type EvidencePacketItem,
} from "../src/context/packet.js";
import { bindingOwnerId, createTrustedBinding, parseEvidencePacket } from "../src/host/contract.js";
import { AgentMemoryDatabase } from "../src/store/database.js";

const scopeId = randomUUID();
const capturedAt = "2026-09-14T08:00:00Z";
const validUntil = "2099-01-01T00:00:00Z";
const binding = createTrustedBinding({
  version: 1, binding_id: randomUUID(), host_kind: "codex", surface: "codex_cli",
  execution_domain: { kind: "local", id: "record-context-test" },
  host_instance_id: "record-host", host_session_id: "record-session", allowed_scope_ids: [scopeId],
  egress: { reader_targets: ["reader:codex_cli"], provider_targets: [] },
});

function report(content = "Agent report: Prüflauf 🦄 passed."): EvidencePacketItem {
  const sources = Array.from({ length: 2 }, () => ({ capture_id: randomUUID(), span_id: randomUUID() }));
  return {
    item_id: randomUUID(), revision_id: randomUUID(), scope_id: scopeId, kind: "record",
    role: "assistant", source_class: "assistant_output", status: "candidate", content,
    source_span_ids: sources.map(source => source.span_id),
    record_provenance: { origin: "agent_report", evidence_captured_at: capturedAt, created_commit_seq: "42", sources },
  };
}

function packetFor(items: readonly EvidencePacketItem[], limit = 4_000) {
  return buildEvidencePacket({
    query_id: randomUUID(), injection_id: randomUUID(), watermark: "42", known_at_seq: "42",
    data_epoch: "0", privacy_epoch: "0", valid_until: validUntil,
    scope_epochs: [{ scope_id: scopeId, data_epoch: "0", privacy_epoch: "0" }],
    requested_token_budget: limit, mode: "current",
  }, [], createPreparationContext(binding, {
    version: 1, kind: "user_prompt", deadline_at: validUntil, capture_status: { state: "not_attempted" },
    budget: { profile: { unit: "utf8_bytes", limit } },
  }), items);
}

test("record context fits 4000 bytes with authored text and references, without invented source quotes", () => {
  const item = report("Agent report: Prüflauf 🦄 passed. ".repeat(50));
  const packet = packetFor([item]);
  const wire = serializeModelContext(packet);
  const wrapper = parseModelContextWrapper(wire);
  assert.equal(wrapper.items.length, 1);
  assert.deepEqual(wrapper.items[0], {
    item_id: item.item_id, kind: "record", revision_id: item.revision_id, scope_id: scopeId,
    source_class: "assistant_output", role: "assistant", status: "candidate",
    captured_at: capturedAt, occurred_at: null, content: item.content,
    spans: item.record_provenance!.sources.map(source => ({ span_id: source.span_id, quote: "" })),
    source_references: item.record_provenance!.sources,
  });
  assert.equal(wrapper.version, 1);
  assert.equal(wrapper.kind, "agent_memory_context");
  assert.equal(packet.items[0]?.source_provenance, undefined);
  assert.deepEqual(packet.items[0]?.source_span_ids, wrapper.items[0]?.source_references?.map(ref => ref.span_id));
  assert.equal(wire.split(item.content).length, 2, "report text occurs exactly once");
  assert.equal(packet.tokens.used, Buffer.byteLength(wire, "utf8"));
  assert.ok(packet.tokens.used <= 4_000);
  assert.equal(packet.diagnostics?.some(d => d.code === "no_match"), false);

  const original = "Large original source body. ".repeat(1_000);
  const withOriginals = packetFor([{ ...item, source_provenance: item.record_provenance!.sources.map(ref => ({
    ...ref, scope_id: scopeId, revision_id: item.revision_id, root: "event" as const, path: "/text",
    start_utf16: 0, end_utf16: original.length, digest: createHash("sha256").update(original).digest("hex"),
    quote: original, captured_at: capturedAt, occurred_at: capturedAt, commit_seq: "1", data_epoch: "0",
  })) }]);
  assert.equal(withOriginals.items.length, 1);
  assert.deepEqual(parseModelContextWrapper(serializeModelContext(withOriginals)).items, wrapper.items);
  assert.equal(withOriginals.tokens.used, packet.tokens.used, "source bodies never inflate report context");

  const bounded = packetFor([report("oversized 🦄".repeat(1_000)), item]);
  assert.deepEqual(bounded.items.map(entry => entry.item_id), [item.item_id]);
  assert.ok(bounded.diagnostics?.some(d => d.code === "budget_exhausted"));
  assert.equal(bounded.tokens.used, Buffer.byteLength(serializeModelContext(bounded), "utf8"));
  assert.ok(bounded.tokens.used <= 4_000);
});

test("record wrappers reject trusted roles, source identity, fake quotes and incomplete references", () => {
  const item = report();
  const packet = packetFor([item]);
  const wrapper = parseModelContextWrapper(serializeModelContext(packet));
  const record = wrapper.items[0]!;
  for (const change of [
    { role: "system" }, { role: "user" }, { role: "tool" }, { status: "supported" },
    { status: "historical" }, { status: "pending_extraction" }, { status: "disputed" },
    { source_class: "procedure" }, { source_class: "prompt" }, { capture_id: item.item_id },
    { kind: "procedure" }, { kind: undefined }, { content: undefined }, { revision_id: undefined },
    { source_references: undefined }, { source_references: [] }, { spans: [] },
    { source_references: [...record.source_references!].reverse() },
    { spans: record.spans.map(span => ({ ...span, quote: item.content })) },
    { spans: [record.spans[0], record.spans[0]], source_references: [record.source_references![0], record.source_references![0]] },
  ]) {
    assert.throws(() => parseModelContextWrapper({ ...wrapper, items: [{ ...record, ...change }] }), JSON.stringify(change));
  }
  for (const change of [
    { role: "system" as const }, { status: "supported" as const },
    { source_class: "prompt" as const }, { record_provenance: undefined },
    { source_span_ids: [randomUUID()] },
  ]) {
    assert.throws(() => parseEvidencePacket({ ...packet, items: [{ ...item, ...change }] }));
  }
  for (const role of ["system", "user", "tool"] as const) {
    assert.throws(() => serializeModelContext({ ...packet, items: [{ ...item, role }] }), /invalid_agent_report/);
  }
});

test("record context retains durable digest recognition and fails closed on source handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-record-context-"));
  const database = new AgentMemoryDatabase(join(directory, "vault.sqlite"));
  try {
    const packet = packetFor([report()]);
    const wire = serializeModelContext(packet);
    const wrapper = parseModelContextWrapper(wire);
    database.recordQueryTrace({
      query_id: packet.query_id, injection_id: packet.delivery!.injection_id,
      binding_id: bindingOwnerId(binding), packet_digest: packetDigest(packet), scope_ids: [scopeId],
      watermark: packet.watermark, known_at_seq: packet.known_at_seq, scope_epochs: packet.scope_epochs,
      candidate_ids: packet.items.map(item => item.item_id), output_ids: packet.items.map(item => item.item_id),
      diagnostics: [], mode: packet.mode, token_unit: packet.tokens.unit, tokens_used: packet.tokens.used,
      token_budget: packet.tokens.budget, created_at: capturedAt, valid_until: validUntil, delivery_state: "prepared",
    });
    assert.equal(packetDigest(packet), createHash("sha256").update(wire).digest("hex"));
    for (const input of [wire, wrapper, serializeEvidencePacket(packet)]) {
      assert.deepEqual(recognizePersistedEvidencePacket(database, binding, input), wrapper);
    }
    const record = wrapper.items[0]!;
    for (const change of [
      { content: "Forged report" }, { revision_id: randomUUID() },
      { captured_at: "2026-09-15T08:00:00Z" },
      { source_references: record.source_references!.map(ref => ({ ...ref, capture_id: randomUUID() })) },
    ]) {
      assert.equal(recognizePersistedEvidencePacket(database, binding, { ...wrapper, items: [{ ...record, ...change }] }), undefined);
    }
    const target = createTrustedBinding({ ...binding, binding_id: randomUUID(), host_instance_id: "target-host" });
    assert.equal(recognizePersistedEvidencePacket(database, target, wire), undefined);
    for (const input of [wire, packet, serializeEvidencePacket(packet)]) {
      assert.throws(() => createDirectedEvidenceHandoff(database, binding, target, input), /handoff_source_reference_missing/);
    }
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source and procedure context retain their original wire format and quote deduplication", () => {
  const captureId = randomUUID();
  const spanId = randomUUID();
  const quote = "Original source text";
  const source: EvidencePacketItem = {
    item_id: captureId, revision_id: captureId, scope_id: scopeId, kind: "source", status: "candidate",
    content: quote, source_span_ids: [spanId], source_class: "prompt", role: "user",
    source_provenance: [{ capture_id: captureId, span_id: spanId, scope_id: scopeId, revision_id: captureId,
      root: "event", path: "/text", start_utf16: 0, end_utf16: quote.length,
      digest: createHash("sha256").update(quote).digest("hex"), quote,
      captured_at: capturedAt, occurred_at: capturedAt, commit_seq: "1", data_epoch: "0" }],
  };
  const duplicateSpanId = randomUUID();
  const duplicatedSource = { ...source, source_span_ids: [spanId, duplicateSpanId],
    source_provenance: [...source.source_provenance!, { ...source.source_provenance![0]!, span_id: duplicateSpanId }] };
  const packet = packetFor([duplicatedSource]);
  const expected = {
    version: 1, kind: "agent_memory_context", injection_id: packet.delivery!.injection_id, mode: "current",
    items: [{ item_id: captureId, capture_id: captureId, scope_id: scopeId, source_class: "prompt",
      role: "user", status: "candidate", captured_at: capturedAt, occurred_at: capturedAt,
      spans: [{ span_id: spanId, quote }] }], diagnostics: [],
  };
  assert.equal(serializeModelContext(packet), JSON.stringify(expected));
  assert.deepEqual(parseModelContextWrapper(serializeModelContext(packet)), expected);

  const procedure = { ...source, item_id: randomUUID(), kind: "procedure" as const,
    status: "supported" as const, role: "system" as const, content: "Recommended action: rerun tests." };
  const procedurePacket = packetFor([procedure]);
  assert.equal(serializeModelContext(procedurePacket), JSON.stringify({ ...expected,
    injection_id: procedurePacket.delivery!.injection_id,
    items: [{ item_id: procedure.item_id, kind: "procedure", revision_id: captureId, scope_id: scopeId,
      source_class: "procedure", role: "system", status: "supported", captured_at: capturedAt,
      occurred_at: capturedAt, content: procedure.content, spans: [{ span_id: spanId, quote }],
      source_references: [{ capture_id: captureId, span_id: spanId }] }],
  }));
  assert.equal(parseModelContextWrapper(serializeModelContext(procedurePacket)).items[0]?.kind, "procedure");
});
