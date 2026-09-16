import { z } from "zod";

import { nonNegativeInt64Schema, parseContract, validateBoundedJson } from "./contract.js";
import { memoryRecordInputSchema } from "../core/memory-record.js";

/**
 * Tool schemas for the agent-mem stdio MCP adapter (plan §14 row T19).
 *
 * The zod schemas in this file are the authoritative runtime validation at
 * the tool boundary. The JSON Schema descriptors further below mirror them
 * for `tools/list`; they describe the same inputs and are kept in step
 * manually. Every schema is strict: unknown keys are rejected, payloads are
 * bounded, and queries/parameters are plain data — never SQL or FTS syntax.
 *
 * Trust boundaries (plan §4/§10): host identity, allowed scopes and egress
 * targets never come from tool arguments. They are supplied once from trusted
 * setup (`TrustedBinding` + `PolicySetupBinding`) when the server is
 * constructed. Arguments may only narrow an authorized scope selection.
 */

export const MEMORY_MCP_SERVER_NAME = "agent-mem";
export const MEMORY_MCP_SERVER_KEY = "agent_mem";
export const MEMORY_MCP_LEGACY_SERVER_KEYS = ["agent_memory_v1", "agent-memory-v1", "agent-memory", "agentmemory"] as const;
export const MEMORY_MCP_SERVER_VERSION = "1.0.0-rc.4";
/**
 * MCP protocol versions this framing speaks, newest first. The MCP stdio
 * transport exchanges newline-delimited JSON-RPC 2.0 messages and negotiates
 * the protocol version during `initialize`; this adapter implements that
 * shape directly (initialize / notifications/initialized / ping /
 * tools/list / tools/call) instead of linking an SDK.
 */
export const MEMORY_MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type MemoryMcpProtocolVersion = (typeof MEMORY_MCP_PROTOCOL_VERSIONS)[number];
export const MEMORY_MCP_DEFAULT_PROTOCOL_VERSION: MemoryMcpProtocolVersion = "2025-06-18";
/** Bumped whenever a tool input/output contract changes incompatibly. */
export const MEMORY_TOOL_CATALOG_VERSION = 3;

export const memoryToolNames = [
  "memory_recall",
  "memory_get",
  "memory_forget",
  "memory_write",
] as const;
export type MemoryToolName = (typeof memoryToolNames)[number];
export const memoryWriteArgsSchema = memoryRecordInputSchema;

/** Stable failure codes surfaced inside `tools/call` results (isError). */
export const memoryToolErrorCodes = [
  "invalid_arguments",
  "forbidden",
  "not_found",
  "revision_conflict",
  "deadline",
  "budget_exhausted",
  "capture_failed",
  "store_unavailable",
] as const;
export type MemoryToolErrorCode = (typeof memoryToolErrorCodes)[number];

const uuidSchema = z.uuid();
const dateTimeSchema = z.iso.datetime({ offset: true });

const qualifierInputSchema = z
  .object({
    key: z.string().min(1).max(128),
    type: z.enum(["string", "integer", "number", "boolean", "date", "enum"]),
    value: z.unknown(),
  })
  .strict();

const entityInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("resolved"), entity_id: uuidSchema }).strict(),
  z
    .object({ kind: z.literal("candidate"), entity_id: uuidSchema.optional(), label: z.string().min(1).max(512) })
    .strict(),
]);

const typedValueSchema = z
  .object({ type: z.enum(["text", "integer", "number", "boolean", "date", "json"]), value: z.unknown() })
  .strict();

const timeViewSchema = z
  .object({
    valid_at: dateTimeSchema.optional(),
    known_at_seq: nonNegativeInt64Schema.optional(),
    known_at: dateTimeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.known_at_seq !== undefined && value.known_at !== undefined) {
      context.addIssue({ code: "custom", path: ["known_at"], message: "known_at_selects_one_clock" });
    }
  });

export const memoryRecallArgsSchema = z
  .object({
    query: z.string().min(1).max(4096),
    scope_ids: z.array(uuidSchema).min(1).max(16).optional(),
    mode: z.enum(["current", "historical", "timeline"]).default("current"),
    valid_at: dateTimeSchema.optional(),
    known_at_seq: nonNegativeInt64Schema.optional(),
    /** Preferred explicit UTF-8 byte budget; omitted uses the MCP default. */
    max_bytes: z.number().int().min(1).max(32_000).optional(),
    /** Legacy alias for max_bytes; units are UTF-8 bytes, not model tokens. */
    token_budget: z.number().int().min(64).max(32_000).optional(),
  })
  .strict();

export const memoryGetArgsSchema = z
  .object({
    scope_id: uuidSchema,
    reference: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("revision"),
          revision_id: uuidSchema,
          time_view: timeViewSchema.optional(),
        })
        .strict(),
    z
      .object({
        kind: z.literal("source"),
        capture_id: uuidSchema,
      })
      .strict(),
    z.object({ kind: z.literal("record"), revision_id: uuidSchema }).strict(),
    ]),
  })
  .strict();

export const memoryHistoryArgsSchema = z
  .object({
    scope_id: uuidSchema,
    item_id: uuidSchema,
    valid_at: dateTimeSchema.optional(),
    known_at_seq: nonNegativeInt64Schema.optional(),
    known_at: dateTimeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.known_at_seq !== undefined && value.known_at !== undefined) {
      context.addIssue({ code: "custom", path: ["known_at"], message: "known_at_selects_one_clock" });
    }
  });

export const memoryCorrectArgsSchema = z
  .object({
    version: z.literal(1),
    scope_id: uuidSchema,
    /** Optional client-generated id enables the core's idempotent replay. */
    operation_id: uuidSchema.optional(),
    operation: z.enum(["SUPPORT", "SUPERSEDE", "CORRECT", "DISPUTE", "IGNORE", "RETRACT"]),
    kind: z.enum(["observation", "plan", "fact", "decision", "preference", "lesson", "procedure"]),
    item_id: uuidSchema,
    identity: z
      .object({
        entity: entityInputSchema,
        predicate: z.string().min(1).max(256),
        qualifiers: z.array(qualifierInputSchema).max(32),
        cardinality: z.enum(["exclusive", "multi"]),
      })
      .strict(),
    /** CAS against the item's current revision; mismatch is a conflict. */
    expected: z
      .object({ revision_id: uuidSchema, slot_generation: nonNegativeInt64Schema.optional() })
      .strict(),
    value: typedValueSchema,
    source_span_ids: z.array(uuidSchema).min(1).max(128),
    meaning: z
      .object({
        version: z.literal(1),
        polarity: z.enum(["affirmed", "negated"]),
        modality: z.enum(["asserted", "planned", "hypothetical", "conditional", "unknown"]),
        // actor_ref is deliberately not accepted: the resolver treats actor
        // attribution as an unverified hint and rejects it outright.
        attribution: z.object({ kind: z.enum(["user", "automation", "assistant", "tool", "system"]) }).strict(),
        corrects_revision_id: uuidSchema.optional(),
      })
      .strict()
      .optional(),
    temporal_intent: z.unknown().optional(),
  })
  .strict();

export const memoryDiagnoseArgsSchema = z.object({ injection_id: uuidSchema }).strict();

export const memoryForgetArgsSchema = z
  .object({
    version: z.literal(1),
    scope_id: uuidSchema,
    /** Client retries use the same operation id; the server binds its authority. */
    operation_id: uuidSchema.optional(),
    capture_ids: z.array(uuidSchema).min(1).max(128),
    expected_privacy_epoch: nonNegativeInt64Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capture_ids).size !== value.capture_ids.length) context.addIssue({ code: "custom", path: ["capture_ids"], message: "duplicate_capture_id" });
  });

const toolArgBounds = { max_depth: 12, max_bytes: 1_000_000, max_nodes: 8_192 } as const;

/**
 * Validate one tool's arguments at the boundary: bounded plain JSON first,
 * then the strict tool schema. Throws ContractValidationError with the tool
 * name as contract; never echoes input content into error messages.
 */
export function parseMemoryToolArgs<T>(schema: z.ZodType<T>, name: MemoryToolName, args: unknown): T {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error(`${name}: arguments_object_required`);
  }
  validateBoundedJson(args, toolArgBounds, name);
  return parseContract(schema, args, name);
}

export interface MemoryToolDescriptor {
  readonly name: MemoryToolName;
  readonly description: string;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  /** JSON Schema (2020-12 subset) mirroring the authoritative zod schema. */
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

const jsonScopeIds = { type: "array", items: { type: "string", format: "uuid" }, minItems: 1, maxItems: 16 } as const;
const jsonDateTime = { type: "string", format: "date-time" } as const;
const jsonNonNegativeInt64 = { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" } as const;
const jsonUuid = { type: "string", format: "uuid" } as const;

const jsonTimeView = {
  type: "object",
  properties: {
    valid_at: jsonDateTime,
    known_at_seq: jsonNonNegativeInt64,
    known_at: jsonDateTime,
  },
  additionalProperties: false,
} as const;

const memoryToolDescriptors: readonly MemoryToolDescriptor[] = Object.freeze([
  {
    name: "memory_recall",
    annotations: { readOnlyHint: true, openWorldHint: false },
      description:
      "Search the local memory store and return an EvidencePacket with the query ID, watermark, epochs, validity time, matching items, source provenance, and UTF-8 byte usage. If the byte limit leaves out authorized matches, the result can include up to 10 omitted_sources references for memory_get; these IDs are not packet evidence. Omit scope_ids to use the project's trusted scope. Supplied scopes can only narrow it. max_bytes defaults to 8000 and cannot exceed 32000. token_budget is a legacy name for the same UTF-8 byte limit. The query is plain data, not search syntax.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4096 },
        scope_ids: { ...jsonScopeIds, description: "Optional subset of the trusted scopes. If omitted, the binding's project scopes are used." },
        mode: { enum: ["current", "historical", "timeline"], default: "current" },
        valid_at: jsonDateTime,
        known_at_seq: jsonNonNegativeInt64,
        max_bytes: { type: "integer", minimum: 1, maximum: 32000, default: 8000, description: "UTF-8 byte limit; maximum 32000." },
        token_budget: { type: "integer", minimum: 64, maximum: 32000, description: "Legacy name for max_bytes; uses UTF-8 bytes." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      'Load an original source. Pass scope_id at the top level and put capture_id inside reference, for example {"scope_id":"<scope UUID>","reference":{"kind":"source","capture_id":"<capture UUID>"}}. Do not pass top-level capture_id, item_id, or source_id. Use IDs from memory_recall or omitted_sources. The source and its canonical spans are checked before return. Legacy revision references remain supported. Setup remains the authority for access.',
    inputSchema: {
      type: "object",
      properties: {
        scope_id: jsonUuid,
        reference: {
          oneOf: [
            {
              type: "object",
              properties: { kind: { const: "revision" }, revision_id: jsonUuid, time_view: jsonTimeView },
              required: ["kind", "revision_id"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { const: "source" }, capture_id: jsonUuid },
              required: ["kind", "capture_id"],
              additionalProperties: false,
            },
            { type: "object", properties: { kind: { const: "record" }, revision_id: jsonUuid }, required: ["kind", "revision_id"], additionalProperties: false },
          ],
        },
      },
      required: ["scope_id", "reference"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_forget",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description:
      "Start or resume a full purge for the selected sources. Access comes from the trusted setup binding. The result reports pending runtime cleanup or host refresh; it does not claim deletion before those steps finish.",
    inputSchema: {
      type: "object",
      properties: {
        version: { const: 1 },
        scope_id: jsonUuid,
        operation_id: jsonUuid,
        capture_ids: { type: "array", items: jsonUuid, minItems: 1, maxItems: 128 },
        expected_privacy_epoch: jsonNonNegativeInt64,
      },
      required: ["version", "scope_id", "capture_ids", "expected_privacy_epoch"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_write",
    description: "Save a source-linked handoff, decision, preference, or procedure when a task ends or before compaction. Use a stable kind and key, and use source IDs returned by recall. When replacing a report, pass its current revision in replaces; reread after a conflict. Reports are agent statements, not verified facts. This call does not use another model.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: {
      scope_id: jsonUuid, key: { type: "string", minLength: 1, maxLength: 96 },
      kind: { enum: ["handoff", "decision", "preference", "procedure"] },
      summary: { type: "string", minLength: 1, maxLength: 1200 },
      next_steps: { type: "array", items: { type: "string", minLength: 1, maxLength: 240 }, maxItems: 5 },
      source_ids: { type: "array", items: jsonUuid, minItems: 1, maxItems: 16, uniqueItems: true }, replaces: jsonUuid,
    }, required: ["scope_id", "key", "kind", "summary", "source_ids"], additionalProperties: false },
  },
] satisfies readonly MemoryToolDescriptor[]);

/** Versioned tool catalog served by `tools/list`. */
export function memoryToolCatalog(): readonly MemoryToolDescriptor[] {
  return memoryToolDescriptors;
}
