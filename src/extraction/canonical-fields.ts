import { z } from "zod";
const uuidSchema = z.uuid();
export const canonicalIdentitySchema = z.object({
    entity: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("resolved"), entity_id: uuidSchema }).strict(),
      z.object({ kind: z.literal("candidate"), entity_id: uuidSchema.optional(), label: z.string().min(1).max(512) }).strict(),
    ]),
    predicate: z.string().min(1).max(256),
    qualifiers: z.array(z.object({ key: z.string().min(1).max(128), type: z.enum(["string", "integer", "number", "boolean", "date", "enum"]), value: z.json() }).strict()).max(32),
    cardinality: z.enum(["exclusive", "multi"]),
  }).strict();
export const canonicalValueSchema = z.object({ type: z.enum(["text", "integer", "number", "boolean", "date", "json"]), value: z.json() }).strict();

export const canonicalMeaningSchema = z.object({
  polarity: z.enum(["affirmed", "negated"]),
  modality: z.enum(["asserted", "planned", "hypothetical", "conditional", "unknown"]),
  attribution: z.enum(["user", "assistant", "tool", "system"]),
}).strict();
