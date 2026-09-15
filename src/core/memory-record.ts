import { z } from "zod";

/** A host agent's source-linked report. Validation does not certify its claims. */
export const memoryRecordInputSchema = z.object({
  scope_id: z.uuid(),
  key: z.string().trim().min(1).max(96).regex(/^[\p{L}\p{N}_.:/ -]+$/u),
  kind: z.enum(["handoff", "decision", "preference", "procedure"]),
  summary: z.string().trim().min(1).max(1200),
  next_steps: z.array(z.string().trim().min(1).max(240)).max(5).default([]),
  source_ids: z.array(z.uuid()).min(1).max(16).refine(ids => new Set(ids).size === ids.length, "duplicate_source"),
  replaces: z.uuid().optional(),
}).strict();

export type MemoryRecordInput = z.output<typeof memoryRecordInputSchema>;
export const memoryRecordSchema = memoryRecordInputSchema.extend({
  format: z.literal("agent_memory_record_v1"),
  origin: z.literal("agent_report"),
});
export type MemoryRecord = z.output<typeof memoryRecordSchema>;
