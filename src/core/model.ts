import { createHash } from "node:crypto";

import { z } from "zod";

import { nonNegativeInt64Schema, parseContract, validateBoundedJson } from "../host/contract.js";
import { canonicalizeTemporalIntent, type CanonicalTemporalIntent } from "./time.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -MAX_INT64 - 1n;
const qualifierKeySchema = z.string().min(1).max(128);
const qualifierTypeSchema = z.enum(["string", "integer", "number", "boolean", "date", "enum"]);
const memoryValueTypeSchema = z.enum(["text", "integer", "number", "boolean", "date", "json"]);

export const memoryKindSchema = z.enum([
  "observation",
  "plan",
  "fact",
  "decision",
  "preference",
  "lesson",
  "procedure",
]);
export const revisionOperationSchema = z.enum([
  "ADD",
  "SUPPORT",
  "SUPERSEDE",
  "CORRECT",
  "DISPUTE",
  "IGNORE",
  "RETRACT",
]);
export const semanticCardinalitySchema = z.enum(["exclusive", "multi"]);

const qualifierInputSchema = z
  .object({ key: qualifierKeySchema, type: qualifierTypeSchema, value: z.unknown() })
  .strict();

const typedValueInputSchema = z
  .object({ type: memoryValueTypeSchema, value: z.unknown() })
  .strict();

const meaningAttributionSchema = z
  .object({
    kind: z.enum(["user", "automation", "assistant", "tool", "system"]),
    actor_ref: z.string().min(1).max(256).optional(),
  })
  .strict();

export const revisionMeaningSchema = z
  .object({
    version: z.literal(1),
    polarity: z.enum(["affirmed", "negated"]),
    modality: z.enum(["asserted", "planned", "hypothetical", "conditional", "unknown"]),
    attribution: meaningAttributionSchema,
    corrects_revision_id: z.uuid().optional(),
  })
  .strict();

const entityInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("resolved"), entity_id: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("candidate"),
      entity_id: z.uuid().optional(),
      label: z.string().min(1).max(512),
    })
    .strict(),
]);

const expectedStateSchema = z
  .object({
    revision_id: z.uuid().nullable().optional(),
    slot_generation: nonNegativeInt64Schema.nullable().optional(),
  })
  .strict()
  .default({});

export const revisionMutationSchema = z
  .object({
    version: z.literal(1),
    operation_id: z.uuid(),
    scope_id: z.uuid(),
    operation: revisionOperationSchema,
    kind: memoryKindSchema,
    item_id: z.uuid().optional(),
    identity: z
      .object({
        entity: entityInputSchema,
        predicate: z.string().min(1).max(256),
        qualifiers: z.array(qualifierInputSchema).max(32),
        cardinality: semanticCardinalitySchema,
      })
      .strict(),
    expected: expectedStateSchema,
    value: typedValueInputSchema,
    source_span_ids: z.array(z.uuid()).min(1).max(128),
    meaning: z.unknown().optional(),
    // Parsed separately below so the temporal module owns the bound union and
    // produces one canonical digest.
    temporal_intent: z.unknown().optional(),
  })
  .strict();

export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type RevisionOperation = z.infer<typeof revisionOperationSchema>;
export type SemanticCardinality = z.infer<typeof semanticCardinalitySchema>;
export type QualifierType = z.infer<typeof qualifierTypeSchema>;
export type MemoryValueType = z.infer<typeof memoryValueTypeSchema>;
export type RevisionMeaningAttribution = z.infer<typeof meaningAttributionSchema>;

export interface CanonicalQualifier {
  readonly key: string;
  readonly type: QualifierType;
  readonly value: string | boolean | number;
}

export interface CanonicalTypedValue {
  readonly type: MemoryValueType;
  readonly value: unknown;
  readonly json: string;
  readonly digest: string;
}

export interface CanonicalRevisionMeaning {
  readonly version: 1;
  readonly polarity: "affirmed" | "negated";
  readonly modality: "asserted" | "planned" | "hypothetical" | "conditional" | "unknown";
  readonly attribution: RevisionMeaningAttribution;
  readonly corrects_revision_id?: string;
  readonly json: string;
  readonly digest: string;
}

export interface CanonicalRevisionMutation {
  readonly version: 1;
  readonly operation_id: string;
  readonly scope_id: string;
  readonly operation: RevisionOperation;
  readonly kind: MemoryKind;
  readonly item_id: string | undefined;
  readonly identity: {
    readonly entity:
      | { readonly kind: "none" }
      | { readonly kind: "resolved"; readonly entity_id: string }
      | { readonly kind: "candidate"; readonly entity_id: string | undefined; readonly label: string };
    readonly predicate: string;
    readonly qualifiers: readonly CanonicalQualifier[];
    readonly qualifiers_json: string;
    readonly qualifiers_digest: string;
    readonly cardinality: SemanticCardinality;
  };
  readonly expected: {
    readonly revision_id: string | null | undefined;
    readonly slot_generation: string | null | undefined;
  };
  readonly value: CanonicalTypedValue;
  readonly source_span_ids: readonly string[];
  readonly meaning?: CanonicalRevisionMeaning;
  readonly temporal_intent?: CanonicalTemporalIntent;
  readonly request_digest: string;
}

export class RevisionModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionModelError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RevisionModelError("revision_value_invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new RevisionModelError("revision_value_invalid");
}

function digestJson(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function exactText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new RevisionModelError(`${field}_invalid`);
  }
  if (value.trim().length === 0) throw new RevisionModelError(`${field}_invalid`);
  return value;
}

function semanticKey(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new RevisionModelError(`${field}_invalid`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new RevisionModelError(`${field}_invalid`);
  return normalized;
}

function semanticLabel(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new RevisionModelError(`${field}_invalid`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maxLength) throw new RevisionModelError(`${field}_invalid`);
  return normalized;
}

function canonicalInteger(value: unknown, field: string): string {
  let parsed: bigint;
  try {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("integer");
      parsed = BigInt(value);
    } else if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
      parsed = BigInt(value);
    } else {
      throw new Error("integer");
    }
  } catch {
    throw new RevisionModelError(`${field}_invalid`);
  }
  if (parsed < MIN_INT64 || parsed > MAX_INT64) throw new RevisionModelError(`${field}_invalid`);
  return parsed.toString(10);
}

function canonicalNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RevisionModelError(`${field}_invalid`);
  return Object.is(value, -0) ? 0 : value;
}

function canonicalizeQualifier(input: unknown): CanonicalQualifier {
  const parsed = parseContract(qualifierInputSchema, input, "revision-qualifier");
  const key = semanticKey(parsed.key, "qualifier_key", 128);
  switch (parsed.type) {
    case "string":
      return { key, type: parsed.type, value: exactText(parsed.value, "qualifier_value", 1_000) };
    case "enum":
      return { key, type: parsed.type, value: exactText(parsed.value, "qualifier_value", 256) };
    case "date": {
      const result = z.iso.date().safeParse(parsed.value);
      if (!result.success) throw new RevisionModelError("qualifier_value_invalid");
      return { key, type: parsed.type, value: result.data };
    }
    case "integer":
      return { key, type: parsed.type, value: canonicalInteger(parsed.value, "qualifier_value") };
    case "number":
      return { key, type: parsed.type, value: canonicalNumber(parsed.value, "qualifier_value") };
    case "boolean":
      if (typeof parsed.value !== "boolean") throw new RevisionModelError("qualifier_value_invalid");
      return { key, type: parsed.type, value: parsed.value };
  }
}

export function canonicalizeQualifiers(input: unknown): {
  readonly values: readonly CanonicalQualifier[];
  readonly json: string;
  readonly digest: string;
} {
  if (!Array.isArray(input) || input.length > 32) throw new RevisionModelError("qualifiers_invalid");
  const values = input.map(canonicalizeQualifier).sort((left, right) => {
    const leftKey = `${left.key}\u0000${left.type}`;
    const rightKey = `${right.key}\u0000${right.type}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.key)) throw new RevisionModelError("duplicate_qualifier");
    seen.add(value.key);
  }
  const json = canonicalJson(values);
  return { values, json, digest: digestJson(json) };
}

export function canonicalizeTypedValue(input: unknown): CanonicalTypedValue {
  const parsed = parseContract(typedValueInputSchema, input, "revision-value");
  try {
    validateBoundedJson(parsed.value, { max_depth: 16, max_bytes: 1_000_000, max_nodes: 4_096 }, "revision-value");
  } catch {
    throw new RevisionModelError("revision_value_invalid");
  }
  let value: unknown = parsed.value;
  switch (parsed.type) {
    case "text":
      if (typeof parsed.value !== "string" || parsed.value.length === 0 || parsed.value.length > 1_000_000) {
        throw new RevisionModelError("revision_value_invalid");
      }
      value = parsed.value;
      break;
    case "date": {
      const result = z.iso.date().safeParse(parsed.value);
      if (!result.success) throw new RevisionModelError("revision_value_invalid");
      value = result.data;
      break;
    }
    case "integer":
      value = canonicalInteger(parsed.value, "revision_value");
      break;
    case "number":
      value = canonicalNumber(parsed.value, "revision_value");
      break;
    case "boolean":
      if (typeof parsed.value !== "boolean") throw new RevisionModelError("revision_value_invalid");
      value = parsed.value;
      break;
    case "json":
      value = parsed.value;
      break;
  }
  const json = canonicalJson({ type: parsed.type, value });
  return { type: parsed.type, value, json, digest: digestJson(json) };
}

export function canonicalizeRevisionMeaning(input: unknown): CanonicalRevisionMeaning {
  const parsed = parseContract(revisionMeaningSchema, input, "revision-meaning");
  const actorRef = parsed.attribution.actor_ref === undefined ? undefined : exactText(parsed.attribution.actor_ref, "meaning_actor_ref", 256);
  const attribution = actorRef === undefined ? { kind: parsed.attribution.kind } : { kind: parsed.attribution.kind, actor_ref: actorRef };
  const canonical = {
    version: 1 as const,
    polarity: parsed.polarity,
    modality: parsed.modality,
    attribution,
    ...(parsed.corrects_revision_id === undefined ? {} : { corrects_revision_id: parsed.corrects_revision_id }),
  };
  const json = canonicalJson(canonical);
  return { ...canonical, json, digest: digestJson(json) };
}

function canonicalPredicate(value: string): string {
  const predicate = semanticKey(value, "predicate", 256);
  if (!/^[\p{L}\p{N}_:.\-/]+$/u.test(predicate)) throw new RevisionModelError("predicate_invalid");
  return predicate;
}

function canonicalEntity(entity: z.infer<typeof entityInputSchema>): CanonicalRevisionMutation["identity"]["entity"] {
  if (entity.kind === "none") return entity;
  if (entity.kind === "resolved") return entity;
  return { kind: entity.kind, entity_id: entity.entity_id, label: semanticLabel(entity.label, "entity_label", 512) };
}

export function parseRevisionMutation(input: unknown): CanonicalRevisionMutation {
  const parsed = parseContract(revisionMutationSchema, input, "revision-mutation");
  const qualifiers = canonicalizeQualifiers(parsed.identity.qualifiers);
  const value = canonicalizeTypedValue(parsed.value);
  const temporalIntent = parsed.temporal_intent === undefined ? undefined : canonicalizeTemporalIntent(parsed.temporal_intent);
  const meaning = parsed.meaning === undefined ? undefined : canonicalizeRevisionMeaning(parsed.meaning);
  const entity = canonicalEntity(parsed.identity.entity);
  const sourceSpanIds = [...new Set(parsed.source_span_ids)].sort();
  if (sourceSpanIds.length !== parsed.source_span_ids.length) throw new RevisionModelError("duplicate_source_span");
  const canonical = {
    version: 1 as const,
    operation_id: parsed.operation_id,
    scope_id: parsed.scope_id,
    operation: parsed.operation,
    kind: parsed.kind,
    item_id: parsed.item_id,
    identity: {
      entity,
      predicate: canonicalPredicate(parsed.identity.predicate),
      qualifiers: qualifiers.values,
      qualifiers_json: qualifiers.json,
      qualifiers_digest: qualifiers.digest,
      cardinality: parsed.identity.cardinality,
    },
    expected: {
      revision_id: parsed.expected.revision_id,
      slot_generation: parsed.expected.slot_generation,
    },
    value,
    source_span_ids: sourceSpanIds,
    ...(temporalIntent === undefined ? {} : { temporal_intent: temporalIntent }),
    ...(meaning === undefined ? {} : { meaning }),
  } satisfies Omit<CanonicalRevisionMutation, "request_digest">;
  const entityForDigest =
    canonical.identity.entity.kind === "candidate"
      ? {
          kind: "candidate" as const,
          entity_id: canonical.identity.entity.entity_id ?? null,
          label: canonical.identity.entity.label,
        }
      : canonical.identity.entity;
  const requestJson = canonicalJson({
    version: canonical.version,
    scope_id: canonical.scope_id,
    operation: canonical.operation,
    kind: canonical.kind,
    item_id: canonical.item_id ?? null,
    identity: {
      entity: entityForDigest,
      predicate: canonical.identity.predicate,
      qualifiers: canonical.identity.qualifiers_json,
      cardinality: canonical.identity.cardinality,
    },
    expected: {
      revision_id: canonical.expected.revision_id ?? null,
      slot_generation: canonical.expected.slot_generation ?? null,
    },
    value: canonical.value.json,
    source_span_ids: canonical.source_span_ids,
    ...(canonical.temporal_intent === undefined ? {} : { temporal_intent: canonical.temporal_intent.json }),
    ...(canonical.meaning === undefined ? {} : { meaning: canonical.meaning.json }),
  });
  return { ...canonical, request_digest: digestJson(requestJson) };
}
