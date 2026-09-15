import { randomUUID } from "node:crypto";
import { memoryRecordSchema } from "../core/memory-record.js";
import { createPolicyOutputBinding, createPolicySetupBinding, readerOutputTarget } from "../core/policy.js";
import type { EvidencePacket, TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase } from "../store/database.js";

export function recallMemoryRecords(database: AgentMemoryDatabase, binding: TrustedBinding,
  scopeIds: readonly string[], knownAt: string, query: string, sourceIds: readonly string[], automatic: boolean,
  excluded?: string, excludeCurrentPrompts = false,
): { items: EvidencePacket["items"] } {
  const target = readerOutputTarget(binding);
  const policy = createPolicySetupBinding({ version: 1, setup_id: randomUUID(), allowed_scope_ids: [...binding.allowed_scope_ids], allowed_output_targets: [target] });
  const matched = new Set(sourceIds.slice(0, 128));
  const terms = [...new Set((query.toLocaleLowerCase("und").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])
    .filter(term => term.length <= 120 && !["the", "and", "was", "wie", "die", "der", "das", "what", "which", "project", "projekt"].includes(term)))].slice(0, 32);
  if (!automatic && terms.length === 0 && matched.size === 0) return { items: [] };
  const candidates: Array<{ item: EvidencePacket["items"][number]; score: number }> = [];
  for (const scopeId of scopeIds) {
    const output = createPolicyOutputBinding(policy, { version: 1, setup_id: policy.setup_id, output_binding_id: randomUUID(), scope_id: scopeId, target });
    // At most 50 * 16 distinct sources per scope; retain only citation metadata,
    // so shared sources are hydrated once and large quote bodies are not cached.
    const sources = new Map<string, { captured_at: string; span_ids: readonly string[] }>();
    const checked = new Set<string>();
    for (const stored of database.summaries.listSourceRecords(output, { known_at_seq: knownAt, limit: 50,
      ...(automatic ? {} : { query_terms: terms, source_ids: [...matched] }),
    })) {
      if (stored.kind !== "search_enrichment" || stored.status !== "active") continue;
      let value: unknown;
      try { value = JSON.parse(stored.content); } catch { continue; }
      const parsed = memoryRecordSchema.safeParse(value);
      if (!parsed.success) continue;
      const record = parsed.data;
      const text = `${record.kind} ${record.key} ${record.summary} ${record.next_steps.join(" ")}`.toLocaleLowerCase("und");
      const score = (terms.some(term => text.includes(term)) ? 2 : 0) + (record.source_ids.some(id => matched.has(id)) ? 1 : 0);
      if (!automatic && score === 0) continue;
      const missing = record.source_ids.filter(id => !checked.has(id));
      if (missing.length > 0) {
        for (const group of database.getRecallSourceGroups([scopeId], binding, missing, knownAt, excluded, excludeCurrentPrompts)) {
          sources.set(group.capture_id, { captured_at: group.captured_at, span_ids: group.spans.map(span => span.span_id) });
        }
        for (const id of missing) checked.add(id);
      }
      if (record.source_ids.some(id => !sources.has(id))) continue;
      const dependencyIds = new Set(stored.dependencies.filter(dep => dep.parent_type === "source_span").map(dep => dep.parent_revision_id));
      const references = record.source_ids.flatMap(captureId => {
        const spanId = sources.get(captureId)!.span_ids.find(id => dependencyIds.has(id));
        return spanId ? [{ capture_id: captureId, span_id: spanId }] : [];
      });
      if (references.length !== record.source_ids.length) continue;
      candidates.push({ score: score + (automatic && record.kind === "handoff" ? 3 : 0),
        item: { item_id: stored.artifact_id, revision_id: stored.revision_id, scope_id: scopeId, kind: "record", status: "candidate",
          content: JSON.stringify({ origin: "agent_report", kind: record.kind, key: record.key, summary: record.summary,
            next_steps: record.next_steps, ...(record.replaces ? { replaces: record.replaces } : {}) }),
          source_class: "assistant_output", role: "assistant", source_span_ids: references.map(ref => ref.span_id),
          record_provenance: { origin: "agent_report", evidence_captured_at: sources.get(record.source_ids[0]!)!.captured_at,
            created_commit_seq: stored.created_commit_seq, sources: references },
        },
      });
    }
  }
  candidates.sort((a, b) => {
    const left = BigInt(a.item.record_provenance!.created_commit_seq), right = BigInt(b.item.record_provenance!.created_commit_seq);
    return b.score - a.score || (left > right ? -1 : left < right ? 1 : a.item.revision_id.localeCompare(b.item.revision_id));
  });
  // The packet builder chooses what fits; oversized reports must not hide smaller candidates.
  return { items: candidates.map(candidate => candidate.item) };
}
