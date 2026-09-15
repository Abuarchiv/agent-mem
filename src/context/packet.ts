import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  bindingOwnerId,
  evidenceGraphContinuationSchema,
  isTrustedBinding,
  parseContract,
  parseEvidencePacket,
  type EvidencePacket,
  type TrustedBinding,
} from "../host/contract.js";
export interface ControllerContextBudgetIdentity {
  readonly kind: "session_start" | "user_prompt";
  readonly exclude_current_session_prompts: boolean;
  readonly unit: "tokens" | "utf8_bytes";
  readonly limit: number;
  readonly requested_limit: number;
  readonly automatic_tokens: number;
  readonly session_start_tokens: number;
  readonly max_bytes: number;
  readonly session_start_max_bytes: number;
  readonly reserve_bytes: number;
  readonly profile: { readonly unit: "utf8_bytes"; readonly limit: number } | null;
  readonly tokenizer_identity: string | null;
  readonly tokenizer_version: string | null;
  readonly wrapper_version: 1;
  readonly wrapper_kind: "agent_memory_context";
  readonly priority_version: typeof CONTROLLER_CONTEXT_PRIORITY_VERSION;
}
export const CONTROLLER_CONTEXT_PRIORITY_VERSION = "protected_procedure_v1" as const;
import { capture } from "../core/capture.js";
import type { AgentMemoryDatabase, RecallScopeSnapshot, RecallSnapshot, RecallSourceGroup } from "../store/database.js";

const dateTimeSchema = z.iso.datetime({ offset: true });
const contextInputSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["session_start", "user_prompt"]),
    deadline_at: dateTimeSchema,
    capture_status: z.discriminatedUnion("state", [
      z.object({ state: z.literal("committed"), capture_id: z.uuid() }).strict(),
      z.object({ state: z.literal("failed") }).strict(),
      z.object({ state: z.literal("not_attempted") }).strict(),
    ]),
    // Narrow opt-in: exclude native current-session user/prompt sources from
    // recall candidates. Used only when the native submitted↔transformed
    // identity is unprovable (Copilot CLI transformed recall) so the
    // just-recorded original cannot echo as historical evidence. Derived
    // server-side from the authenticated binding; never payload-asserted.
    exclude_current_session_prompts: z.boolean().optional(),
    budget: z
      .object({
        profile: z.object({ unit: z.literal("utf8_bytes"), limit: z.number().int().min(1).max(4_000_000) }).strict().optional(),
        automatic_tokens: z.number().int().min(1).max(200_000).optional(),
        session_start_tokens: z.number().int().min(1).max(200_000).optional(),
        max_bytes: z.number().int().min(1_024).max(4_000_000).optional(),
        session_start_max_bytes: z.number().int().min(1_024).max(4_000_000).optional(),
        reserve_bytes: z.number().int().min(0).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const contextBudgetDefaults = {
  automatic_tokens: 1_500,
  session_start_tokens: 600,
  max_bytes: 64 * 1024,
  // Separate explicit byte ceilings keep the fallback conservative without
  // pretending that characters or bytes have a universal token ratio.
  session_start_max_bytes: 24 * 1024,
  reserve_bytes: 1_024,
} as const;

export type ContextPreparationKind = "session_start" | "user_prompt";
export type ContextCaptureStatus =
  | { readonly state: "committed"; readonly capture_id: string }
  | { readonly state: "failed" }
  | { readonly state: "not_attempted" };

export interface ContextTokenizer {
  readonly count: (serializedWrapper: string) => number;
  readonly identity?: string;
  readonly version?: string;
}

export interface ContextBudget {
  readonly profile?: { readonly unit: "utf8_bytes"; readonly limit: number };
  readonly automatic_tokens: number;
  readonly session_start_tokens: number;
  readonly max_bytes: number;
  readonly session_start_max_bytes: number;
  readonly reserve_bytes: number;
  readonly tokenizer?: ContextTokenizer;
}

declare const preparationContextBrand: unique symbol;
export interface PreparationContext {
  readonly version: 1;
  readonly binding_id: string;
  readonly kind: ContextPreparationKind;
  readonly deadline_at: string;
  readonly capture_status: ContextCaptureStatus;
  readonly budget: ContextBudget;
  readonly exclude_current_session_prompts: boolean;
  readonly [preparationContextBrand]: true;
}

const preparationContexts = new WeakSet<object>();

export function createPreparationContext(
  binding: TrustedBinding,
  input: unknown,
  tokenizer?: ContextTokenizer,
): PreparationContext {
  if (!isTrustedBinding(binding)) throw new Error("context_binding_invalid");
  const parsed = parseContract(contextInputSchema, input, "preparation-context");
  const budgetInput = parsed.budget ?? {};
  const budget = {
    ...(budgetInput.profile === undefined ? {} : { profile: Object.freeze({ ...budgetInput.profile }) }),
    automatic_tokens: budgetInput.automatic_tokens ?? contextBudgetDefaults.automatic_tokens,
    session_start_tokens: budgetInput.session_start_tokens ?? contextBudgetDefaults.session_start_tokens,
    max_bytes: budgetInput.max_bytes ?? contextBudgetDefaults.max_bytes,
    session_start_max_bytes: budgetInput.session_start_max_bytes ?? contextBudgetDefaults.session_start_max_bytes,
    reserve_bytes: budgetInput.reserve_bytes ?? contextBudgetDefaults.reserve_bytes,
    ...(tokenizer === undefined ? {} : {
      tokenizer: Object.freeze({
        count: tokenizer.count,
        ...(tokenizer.identity === undefined ? {} : { identity: tokenizer.identity }),
        ...(tokenizer.version === undefined ? {} : { version: tokenizer.version }),
      }),
    }),
  } satisfies ContextBudget;
  if (budget.reserve_bytes >= budget.max_bytes || budget.reserve_bytes >= budget.session_start_max_bytes) throw new Error("context_budget_invalid");
  if (tokenizer !== undefined) {
    const initial = tokenizer.count("");
    if (!Number.isSafeInteger(initial) || initial < 0) throw new Error("context_tokenizer_invalid");
    if ((tokenizer.identity === undefined) !== (tokenizer.version === undefined)) throw new Error("context_tokenizer_identity_invalid");
    if (tokenizer.identity !== undefined && (tokenizer.identity.length === 0 || tokenizer.version!.length === 0)) throw new Error("context_tokenizer_identity_invalid");
  }
  const context = Object.freeze({
    version: 1 as const,
    binding_id: binding.binding_id,
    kind: parsed.kind,
    deadline_at: parsed.deadline_at,
    capture_status: Object.freeze({ ...parsed.capture_status }),
    budget: Object.freeze(budget),
    exclude_current_session_prompts: parsed.exclude_current_session_prompts ?? false,
  }) as PreparationContext;
  preparationContexts.add(context);
  return context;
}

export function isPreparationContext(value: unknown): value is PreparationContext {
  return typeof value === "object" && value !== null && preparationContexts.has(value);
}

const trustedContextBudgets = new WeakSet<object>();

export function isTrustedControllerContextBudget(value: unknown): value is ControllerContextBudgetIdentity {
  return typeof value === "object" && value !== null && trustedContextBudgets.has(value);
}

/**
 * Derive the exact packet operating point from trusted preparation state.
 * Callers may record this value, but cannot choose it independently of the
 * context and request that the runtime actually uses.
 */
export function contextBudgetMeasurementIdentity(
  context: PreparationContext,
  requestedLimit: number,
): ControllerContextBudgetIdentity {
  if (!isPreparationContext(context) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new Error("context_budget_identity_invalid");
  const maxBytes = context.kind === "session_start" ? context.budget.session_start_max_bytes : context.budget.max_bytes;
  const byteBudget = maxBytes - context.budget.reserve_bytes;
  const tokenLimit = Math.min(requestedLimit, context.kind === "session_start" ? context.budget.session_start_tokens : context.budget.automatic_tokens);
  const profile = context.budget.profile === undefined ? null : Object.freeze({ unit: "utf8_bytes" as const, limit: context.budget.profile.limit });
  const tokenizer = profile === null ? context.budget.tokenizer : undefined;
  const unit = profile !== null ? "utf8_bytes" : tokenizer === undefined ? "utf8_bytes" : "tokens";
  const limit = profile !== null
    ? Math.min(profile.limit, requestedLimit, byteBudget)
    : tokenizer === undefined ? Math.min(tokenLimit, byteBudget) : tokenLimit;
  const identity: ControllerContextBudgetIdentity = Object.freeze({
    kind: context.kind,
    exclude_current_session_prompts: context.exclude_current_session_prompts,
    unit,
    limit,
    requested_limit: requestedLimit,
    automatic_tokens: context.budget.automatic_tokens,
    session_start_tokens: context.budget.session_start_tokens,
    max_bytes: maxBytes,
    session_start_max_bytes: context.budget.session_start_max_bytes,
    reserve_bytes: context.budget.reserve_bytes,
    profile,
    tokenizer_identity: tokenizer?.identity ?? null,
    tokenizer_version: tokenizer?.version ?? null,
    wrapper_version: 1,
    wrapper_kind: "agent_memory_context",
    priority_version: CONTROLLER_CONTEXT_PRIORITY_VERSION,
  });
  trustedContextBudgets.add(identity);
  return identity;
}

export class PacketBudgetError extends Error {
  constructor() {
    super("context_budget_unrepresentable");
    this.name = "PacketBudgetError";
  }
}

export const contextDiagnosticCodeSchema = z.enum([
  "no_match",
  "budget_exhausted",
  "revalidation_failed",
  "degraded_lexical",
  "graph_incomplete",
]);
export type ContextDiagnosticCode = z.infer<typeof contextDiagnosticCodeSchema>;

type EvidencePacketItem = EvidencePacket["items"][number];
export type { EvidencePacketItem };

export interface PacketBuildInput {
  readonly query_id: string;
  readonly injection_id: string;
  readonly watermark: string;
  readonly known_at_seq: string;
  readonly data_epoch: string;
  readonly privacy_epoch: string;
  readonly valid_until: string;
  readonly scope_epochs: readonly RecallScopeSnapshot[];
  readonly requested_token_budget: number;
  /** Original user query used only to choose among already-authenticated source spans. */
  readonly query?: string;
  readonly mode?: EvidencePacket["mode"];
  readonly diagnostics?: readonly ContextDiagnosticCode[];
  /** Source captures derived from trusted freshness/session/graph state. */
  readonly protected_source_ids?: readonly string[];
  /** Connected graph evidence is admitted or dropped as a whole. */
  readonly atomic_source_groups?: readonly (readonly string[])[];
  readonly graph_continuation?: EvidencePacket["graph_continuation"];
}

function digestPacket(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function serializeEvidencePacket(packet: EvidencePacket): string {
  if (packet.delivery === undefined) throw new Error("evidence_delivery_missing");
  const serialized = JSON.stringify({
    version: 1,
    kind: "agent_memory_evidence",
    injection_id: packet.delivery.injection_id,
    packet,
  });
  if (Buffer.byteLength(serialized, "utf8") > 4_000_000) throw new PacketBudgetError();
  return serialized;
}

const modelContextWrapperSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent_memory_context"),
    injection_id: z.uuid(),
    mode: z.enum(["current", "historical", "timeline", "degraded"]),
    status: z.string().min(1).max(512).optional(),
    graph_continuation: evidenceGraphContinuationSchema.optional(),
    items: z
      .array(
        z
          .object({
            item_id: z.uuid(),
            // Legacy source items keep capture_id. Procedures and agent reports
            // carry their source captures in source_references instead: the
            // derived item id is never presented as an original capture.
            capture_id: z.uuid().optional(),
            kind: z.enum(["procedure", "record"]).optional(),
            revision_id: z.uuid().optional(),
            scope_id: z.uuid(),
            source_class: z.string().min(1).max(64),
            role: z.enum(["user", "assistant", "tool", "system"]),
            status: z.enum(["supported", "candidate", "disputed", "historical", "pending_extraction"]),
            captured_at: dateTimeSchema,
            occurred_at: dateTimeSchema.nullable(),
            content: z.string().min(1).max(1_000_000).optional(),
            spans: z
              .array(
                z
                  .object({ span_id: z.uuid(), quote: z.string().max(1_000_000) })
                  .strict(),
              )
              .min(1)
              .max(128),
            source_references: z
              .array(z.object({ capture_id: z.uuid(), span_id: z.uuid() }).strict())
              .min(1)
              .max(128)
              .optional(),
          })
          .strict()
          .superRefine((value, context) => {
            if (value.kind === "procedure" || value.kind === "record") {
              const kind = value.kind;
              if (value.capture_id !== undefined) context.addIssue({ code: "custom", path: ["capture_id"], message: `${kind}_capture_id_forbidden` });
              if (value.revision_id === undefined) context.addIssue({ code: "custom", path: ["revision_id"], message: `${kind}_revision_missing` });
              if (value.content === undefined) context.addIssue({ code: "custom", path: ["content"], message: `${kind}_content_missing` });
              if (value.role !== (kind === "record" ? "assistant" : "system")) context.addIssue({ code: "custom", path: ["role"], message: `${kind}_role_invalid` });
              if (value.status !== (kind === "record" ? "candidate" : "supported")) context.addIssue({ code: "custom", path: ["status"], message: `${kind}_status_invalid` });
              if (kind === "record") {
                if (value.source_class !== "assistant_output") context.addIssue({ code: "custom", path: ["source_class"], message: "record_source_class_invalid" });
                if (value.spans.some((span) => span.quote !== "")) context.addIssue({ code: "custom", path: ["spans"], message: "record_source_quote_forbidden" });
              }
              if (value.source_references === undefined) {
                context.addIssue({ code: "custom", path: ["source_references"], message: `${kind}_source_references_missing` });
              } else {
                const spanIds = value.spans.map((span) => span.span_id);
                const referenceIds = value.source_references.map((reference) => reference.span_id);
                if (new Set(spanIds).size !== spanIds.length || spanIds.length !== referenceIds.length || spanIds.some((id, index) => referenceIds[index] !== id)) {
                  context.addIssue({ code: "custom", path: ["source_references"], message: `${kind}_source_references_mismatch` });
                }
              }
            } else {
              if (value.capture_id === undefined) context.addIssue({ code: "custom", path: ["capture_id"], message: "source_capture_id_missing" });
              for (const field of ["content", "revision_id", "source_references"] as const) {
                if (field in value) context.addIssue({ code: "custom", path: [field], message: "source_procedure_field_forbidden" });
              }
            }
          }),
      )
      .max(200),
    diagnostics: z
      .array(
        z
          .object({ code: contextDiagnosticCodeSchema })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export interface EvidenceContextWrapper {
  readonly version: 1;
  readonly kind: "agent_memory_context";
  readonly injection_id: string;
  readonly mode: "current" | "historical" | "timeline" | "degraded";
  readonly status?: string;
  readonly graph_continuation?: EvidencePacket["graph_continuation"];
  readonly items: readonly {
    readonly item_id: string;
    readonly capture_id?: string;
    readonly kind?: "procedure" | "record";
    readonly revision_id?: string;
    readonly scope_id: string;
    readonly source_class: string;
    readonly role: "user" | "assistant" | "tool" | "system";
    readonly status: "supported" | "candidate" | "disputed" | "historical" | "pending_extraction";
    readonly captured_at: string;
    readonly occurred_at: string | null;
    readonly content?: string;
    readonly spans: readonly { readonly span_id: string; readonly quote: string }[];
    readonly source_references?: readonly { readonly capture_id: string; readonly span_id: string }[];
  }[];
  readonly diagnostics?: readonly { readonly code: ContextDiagnosticCode }[];
}

function serializeModelContextWrapper(wrapper: EvidenceContextWrapper): string {
  const serialized = JSON.stringify({
    version: 1,
    kind: "agent_memory_context",
    injection_id: wrapper.injection_id,
    mode: wrapper.mode,
    ...(wrapper.status === undefined ? {} : { status: wrapper.status }),
    ...(wrapper.graph_continuation === undefined ? {} : { graph_continuation: wrapper.graph_continuation }),
    items: wrapper.items.map((item) => item.kind === "procedure" || item.kind === "record"
      ? {
          item_id: item.item_id,
          kind: item.kind,
          revision_id: item.revision_id,
          scope_id: item.scope_id,
          source_class: item.source_class,
          role: item.role,
          status: item.status,
          captured_at: item.captured_at,
          occurred_at: item.occurred_at,
          content: item.content,
          spans: item.spans.map((span) => ({ span_id: span.span_id, quote: span.quote })),
          source_references: item.source_references?.map((reference) => ({ capture_id: reference.capture_id, span_id: reference.span_id })),
        }
      : {
          item_id: item.item_id,
          capture_id: item.capture_id,
          scope_id: item.scope_id,
          source_class: item.source_class,
          role: item.role,
          status: item.status,
          captured_at: item.captured_at,
          occurred_at: item.occurred_at,
          spans: item.spans.map((span) => ({ span_id: span.span_id, quote: span.quote })),
        }),
    ...(wrapper.diagnostics === undefined ? {} : { diagnostics: wrapper.diagnostics.map((diagnostic) => ({ code: diagnostic.code })) }),
  });
  if (Buffer.byteLength(serialized, "utf8") > 4_000_000) throw new PacketBudgetError();
  return serialized;
}

export function serializeModelContext(packet: EvidencePacket): string {
  return serializePacketContext(packet, true);
}

/** Serialize a context packet with the bounded install/session marker. */
export function serializeModelContextWithStatus(packet: EvidencePacket, status: string): string {
  if (typeof status !== "string" || status.length === 0 || status.length > 512) throw new Error("session_status_invalid");
  return serializePacketContext(packet, true, status);
}

function serializePacketContext(packet: EvidencePacket, deduplicateQuotes: boolean, status?: string): string {
  if (packet.delivery === undefined) throw new Error("evidence_delivery_missing");
  const items = packet.items.map((item) => {
    if (item.kind === "record") {
      const provenance = item.record_provenance;
      if (provenance === undefined || item.role !== "assistant" || item.source_class !== "assistant_output" || item.status !== "candidate") {
        throw new Error("invalid_agent_report");
      }
      return {
        item_id: item.item_id,
        kind: "record" as const,
        revision_id: item.revision_id,
        scope_id: item.scope_id,
        source_class: item.source_class,
        role: item.role,
        status: item.status,
        captured_at: provenance.evidence_captured_at,
        occurred_at: null,
        content: item.content,
        // References identify supporting evidence; no original quotes were loaded.
        spans: provenance.sources.map((source) => ({ span_id: source.span_id, quote: "" })),
        source_references: provenance.sources,
      };
    }
    if (item.source_provenance === undefined || item.source_provenance.length === 0) {
      throw new PacketBudgetError();
    }
    const firstProvenance = item.source_provenance[0];
    if (firstProvenance === undefined) throw new PacketBudgetError();
    const seen = new Set<string>();
    const spans = item.source_provenance.filter((span) => {
      const key = JSON.stringify([span.capture_id, span.quote]);
      if (deduplicateQuotes && seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (item.kind === "procedure") {
      return {
        item_id: item.item_id,
        kind: "procedure" as const,
        revision_id: item.revision_id,
        scope_id: item.scope_id,
        source_class: "procedure",
        role: "system" as const,
        status: item.status,
        captured_at: firstProvenance.captured_at,
        occurred_at: firstProvenance.occurred_at,
        content: item.content,
        spans: spans.map((span) => ({ span_id: span.span_id, quote: span.quote })),
        source_references: spans.map((span) => ({ capture_id: span.capture_id, span_id: span.span_id })),
      };
    }
    return {
      item_id: item.item_id,
      capture_id: item.item_id,
      scope_id: item.scope_id,
      source_class: item.source_class ?? "diagnostic",
      role: item.role ?? "system",
      status: item.status,
      captured_at: firstProvenance.captured_at,
      occurred_at: firstProvenance.occurred_at,
      spans: spans.map((span) => ({ span_id: span.span_id, quote: span.quote })),
    };
  });
  const wrapper: EvidenceContextWrapper = {
    version: 1,
    kind: "agent_memory_context",
    injection_id: packet.delivery.injection_id,
    mode: packet.mode,
    ...(status === undefined ? {} : { status }),
    ...(packet.graph_continuation === undefined ? {} : { graph_continuation: packet.graph_continuation }),
    items,
    ...(packet.diagnostics === undefined ? {} : { diagnostics: packet.diagnostics }),
  };
  return serializeModelContextWrapper(wrapper);
}

export function parseModelContextWrapper(input: unknown): EvidenceContextWrapper {
  let candidate = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > 4_000_000) throw new Error("evidence_context_wrapper_too_large");
    candidate = JSON.parse(input) as unknown;
  }
  return parseContract(modelContextWrapperSchema, candidate, "evidence-context-wrapper") as EvidenceContextWrapper;
}

const packetWrapperSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent_memory_evidence"),
    injection_id: z.uuid(),
    packet: z.unknown(),
  })
  .strict();

export interface EvidencePacketWrapper {
  readonly version: 1;
  readonly kind: "agent_memory_evidence";
  readonly injection_id: string;
  readonly packet: EvidencePacket;
}

export function parseEvidencePacketWrapper(input: unknown): EvidencePacketWrapper {
  let candidate = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > 4_000_000) throw new Error("evidence_packet_wrapper_too_large");
    try {
      candidate = JSON.parse(input) as unknown;
    } catch (error: unknown) {
      throw new Error("evidence_packet_wrapper_json_invalid", { cause: error });
    }
  }
  const wrapper = parseContract(packetWrapperSchema, candidate, "evidence-packet-wrapper");
  const packet = parseEvidencePacket(wrapper.packet);
  if (packet.delivery?.injection_id !== wrapper.injection_id) throw new Error("evidence_delivery_mismatch");
  return { ...wrapper, packet };
}

const handoffBindingIdentitySchema = z
  .object({
    binding_owner_id: z.uuid(),
    host_kind: z.enum(["codex", "claude_code", "opencode", "copilot"]),
    surface: z.enum([
      "codex_cli",
      "codex_desktop",
      "claude_code_cli",
      "opencode_cli",
      "copilot_cli",
      "copilot_vscode_agent",
    ]),
    execution_domain: z
      .object({ kind: z.enum(["local", "remote_ssh", "container", "wsl"]), id: z.string().min(1).max(256) })
      .strict(),
    host_instance_id: z.string().min(1).max(256),
    host_session_id: z.string().min(1).max(256),
    reader_target: z.string().regex(/^reader:[A-Za-z0-9._/-]{1,120}$/),
  })
  .strict();

const handoffSourceReferenceSchema = z
  .object({
    capture_id: z.uuid(),
    scope_id: z.uuid(),
    revision_id: z.uuid(),
    span_ids: z.array(z.uuid()).min(1).max(128),
    origin: handoffBindingIdentitySchema.omit({ binding_owner_id: true, reader_target: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.span_ids).size !== value.span_ids.length) {
      context.addIssue({ code: "custom", path: ["span_ids"], message: "duplicate_span" });
    }
  });

const directedEvidenceHandoffSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("agent_memory_handoff"),
    handoff_id: z.uuid(),
    source: handoffBindingIdentitySchema,
    target: handoffBindingIdentitySchema,
    source_injection_id: z.uuid(),
    source_packet_digest: z.string().regex(/^[a-f0-9]{64}$/i),
    source_references: z.array(handoffSourceReferenceSchema).min(1).max(200),
    context: z.unknown(),
    created_at: dateTimeSchema,
  })
  .strict();

export interface DirectedHandoffBindingIdentity {
  readonly binding_owner_id: string;
  readonly host_kind: "codex" | "claude_code" | "opencode" | "copilot";
  readonly surface:
    | "codex_cli"
    | "codex_desktop"
    | "claude_code_cli"
    | "opencode_cli"
    | "copilot_cli"
    | "copilot_vscode_agent";
  readonly execution_domain: Readonly<{ kind: "local" | "remote_ssh" | "container" | "wsl"; id: string }>;
  readonly host_instance_id: string;
  readonly host_session_id: string;
  readonly reader_target: string;
}

export interface DirectedHandoffSourceReference {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly revision_id: string;
  readonly span_ids: readonly string[];
  readonly origin: Omit<DirectedHandoffBindingIdentity, "binding_owner_id" | "reader_target">;
}

export interface DirectedEvidenceHandoff {
  readonly version: 1;
  readonly kind: "agent_memory_handoff";
  readonly handoff_id: string;
  readonly source: DirectedHandoffBindingIdentity;
  readonly target: DirectedHandoffBindingIdentity;
  readonly source_injection_id: string;
  readonly source_packet_digest: string;
  readonly source_references: readonly DirectedHandoffSourceReference[];
  readonly context: EvidenceContextWrapper;
  readonly created_at: string;
}

function parseJsonCandidate(input: unknown, tooLargeCode: string): unknown {
  if (typeof input !== "string") return input;
  if (Buffer.byteLength(input, "utf8") > 4_000_000) throw new Error(tooLargeCode);
  return JSON.parse(input) as unknown;
}

function parseHandoffContext(input: unknown): { readonly context: EvidenceContextWrapper; readonly packet?: EvidencePacket } {
  try {
    return { context: parseModelContextWrapper(input) };
  } catch {
    try {
      const packet = parseEvidencePacket(input);
      return { packet, context: parseModelContextWrapper(serializeModelContext(packet)) };
    } catch {
      const full = parseEvidencePacketWrapper(input);
      return { packet: full.packet, context: parseModelContextWrapper(serializeModelContext(full.packet)) };
    }
  }
}

function handoffReferences(
  context: EvidenceContextWrapper,
  packet: EvidencePacket | undefined,
): Omit<DirectedHandoffSourceReference, "origin">[] {
  if (context.items.length === 0) throw new Error("handoff_context_empty");
  if (packet !== undefined) {
    if (packet.items.length !== context.items.length) throw new Error("handoff_context_mismatch");
    return packet.items.map((item, index) => {
      const contextItem = context.items[index];
      if (contextItem === undefined || item.item_id !== contextItem.item_id || item.scope_id !== contextItem.scope_id) {
        throw new Error("handoff_context_mismatch");
      }
      const spans = item.source_provenance;
      if (item.kind === "procedure" || item.kind !== "source" || spans === undefined || spans.length === 0 || spans.some((span) => span.capture_id !== item.item_id)) {
        throw new Error("handoff_source_reference_missing");
      }
      const visibleSpanIds = new Set(contextItem.spans.map((span) => span.span_id));
      const deliveredSpans = spans.filter((span) => visibleSpanIds.has(span.span_id));
      if (deliveredSpans.length === 0) throw new Error("handoff_source_reference_missing");
      return {
        capture_id: item.item_id,
        scope_id: item.scope_id,
        revision_id: item.revision_id,
        span_ids: deliveredSpans.map((span) => span.span_id),
      };
    });
  }
  return context.items.map((item) => {
    if (item.kind !== undefined || item.capture_id !== item.item_id || item.spans.length === 0) throw new Error("handoff_source_reference_missing");
    return {
      capture_id: item.capture_id,
      scope_id: item.scope_id,
      // The early T05 source path uses the durable capture as its revision
      // identity. Full packets preserve a distinct revision_id above.
      revision_id: item.item_id,
      span_ids: item.spans.map((span) => span.span_id),
    };
  });
}

function readerTargetForBinding(binding: TrustedBinding): string {
  const target = `reader:${binding.surface}`;
  if (!binding.egress.reader_targets.includes(target as TrustedBinding["egress"]["reader_targets"][number])) {
    throw new Error("handoff_reader_egress_missing");
  }
  return target;
}

function handoffBindingIdentity(binding: TrustedBinding): DirectedHandoffBindingIdentity {
  if (!isTrustedBinding(binding)) throw new Error("trusted_binding_required");
  return {
    binding_owner_id: bindingOwnerId(binding),
    host_kind: binding.host_kind,
    surface: binding.surface,
    execution_domain: { ...binding.execution_domain },
    host_instance_id: binding.host_instance_id,
    host_session_id: binding.host_session_id,
    reader_target: readerTargetForBinding(binding),
  };
}

function stableBindingIdentity(identity: DirectedHandoffBindingIdentity): string {
  return JSON.stringify({
    binding_owner_id: identity.binding_owner_id,
    host_kind: identity.host_kind,
    surface: identity.surface,
    execution_domain: identity.execution_domain,
    host_instance_id: identity.host_instance_id,
    reader_target: identity.reader_target,
  });
}

function currentTargetMatches(identity: DirectedHandoffBindingIdentity, binding: TrustedBinding): boolean {
  let current: DirectedHandoffBindingIdentity;
  try {
    current = handoffBindingIdentity(binding);
  } catch {
    return false;
  }
  return stableBindingIdentity(identity) === stableBindingIdentity(current);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function handoffReferencesMatchContext(
  references: readonly DirectedHandoffSourceReference[],
  context: EvidenceContextWrapper,
): boolean {
  if (references.length !== context.items.length) return false;
  return references.every((reference, index) => {
    const item = context.items[index];
    return item !== undefined &&
      reference.capture_id === item.capture_id &&
      reference.scope_id === item.scope_id &&
      sameStringSet(reference.span_ids, item.spans.map((span) => span.span_id));
  });
}

export function parseDirectedEvidenceHandoff(input: unknown): DirectedEvidenceHandoff {
  const candidate = parseJsonCandidate(input, "evidence_handoff_too_large");
  const parsed = parseContract(directedEvidenceHandoffSchema, candidate, "evidence-handoff");
  const context = parseHandoffContext(parsed.context).context;
  const normalized = { ...parsed, context, source_references: parsed.source_references.map((reference) => ({ ...reference, span_ids: [...reference.span_ids] })) };
  return normalized;
}

export function serializeDirectedEvidenceHandoff(input: DirectedEvidenceHandoff): string {
  const handoff = parseDirectedEvidenceHandoff(input);
  const serialized = JSON.stringify(handoff);
  if (Buffer.byteLength(serialized, "utf8") > 4_000_000) throw new PacketBudgetError();
  return serialized;
}

function sourceTraceForHandoff(
  database: AgentMemoryDatabase,
  handoff: DirectedEvidenceHandoff,
): ReturnType<AgentMemoryDatabase["getQueryTrace"]> | undefined {
  try {
    const trace = database.getQueryTrace(handoff.source_injection_id);
    if (trace === undefined || trace.injection_id !== handoff.context.injection_id) return undefined;
    if (
      trace.binding_id !== handoff.source.binding_owner_id ||
      trace.packet_digest !== handoff.source_packet_digest ||
      trace.packet_digest !== contextDigest(handoff.context)
    ) return undefined;
    if (!sameStringSet(trace.output_ids, handoff.context.items.map((item) => item.item_id))) return undefined;
    const contextScopes = [...new Set(handoff.context.items.map((item) => item.scope_id))];
    if (contextScopes.some((scopeId) => !trace.scope_ids.includes(scopeId))) return undefined;
    if (Date.parse(handoff.created_at) < Date.parse(trace.created_at)) return undefined;
    if (Date.parse(trace.valid_until) <= Date.now()) return undefined;
    return trace;
  } catch {
    return undefined;
  }
}

function traceSnapshot(
  trace: NonNullable<ReturnType<AgentMemoryDatabase["getQueryTrace"]>>,
  scopeIds: readonly string[],
): RecallSnapshot {
  const scopes = trace.scope_epochs.filter((scope) => scopeIds.includes(scope.scope_id));
  if (scopes.length !== new Set(scopeIds).size) throw new Error("handoff_scope_missing");
  return {
    watermark: trace.watermark,
    data_epoch: "0",
    privacy_epoch: "0",
    scopes,
  };
}

/**
 * Create a directed bearer handoff from a packet already authenticated for the
 * source binding. The target is described by its own binding and never inherits
 * source scopes or egress. The durable query trace is the restart anchor; no
 * second capture or evidence engine is introduced.
 */
export function createDirectedEvidenceHandoff(
  database: AgentMemoryDatabase,
  sourceBinding: TrustedBinding,
  targetBinding: TrustedBinding,
  input: unknown,
): DirectedEvidenceHandoff {
  if (!isTrustedBinding(sourceBinding) || !isTrustedBinding(targetBinding)) throw new Error("trusted_binding_required");
  const source = handoffBindingIdentity(sourceBinding);
  const target = handoffBindingIdentity(targetBinding);
  if (stableBindingIdentity(source) === stableBindingIdentity(target)) throw new Error("handoff_target_same_binding");
  const parsed = parseHandoffContext(input);
  const context = parsed.context;
  if (recognizePersistedEvidencePacket(database, sourceBinding, context) === undefined) throw new Error("handoff_source_unrecognized");
  const trace = database.getQueryTrace(context.injection_id);
  if (trace === undefined || trace.binding_id !== source.binding_owner_id || trace.packet_digest !== contextDigest(context)) {
    throw new Error("handoff_source_unrecognized");
  }
  const references = handoffReferences(context, parsed.packet).map((reference) => {
    const origin = handoffBindingIdentitySchema.omit({ binding_owner_id: true, reader_target: true }).parse(
      database.getHandoffSourceOrigin(sourceBinding, reference.scope_id, reference.capture_id));
    return { ...reference, origin };
  });
  let beforeTransition: RecallSnapshot;
  try {
    beforeTransition = database.getRecallSnapshot(trace.scope_ids, targetBinding);
    if (!database.revalidateRecallSnapshot(traceSnapshot(trace, trace.scope_ids), targetBinding, trace.output_ids)) {
      throw new Error("handoff_target_not_allowed");
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "handoff_target_not_allowed") throw error;
    throw new Error("handoff_target_not_allowed", { cause: error });
  }
  if (!database.validateHandoffSourceReferences(targetBinding, references)) throw new Error("handoff_source_unavailable");
  const handoff = {
    version: 1,
    kind: "agent_memory_handoff",
    source,
    target,
    source_injection_id: trace.injection_id,
    source_packet_digest: trace.packet_digest,
    source_references: references,
    context,
    created_at: new Date().toISOString(),
  } satisfies Omit<DirectedEvidenceHandoff, "handoff_id">;
  const directed = { ...handoff, handoff_id: randomUUID() };
  const transitionScopes = new Set(references.map((reference) => reference.scope_id));
  for (const scopeId of transitionScopes) {
    capture({ version: 1, capture_id: randomUUID(), scope_id: scopeId,
      origin: { host_kind: sourceBinding.host_kind, surface: sourceBinding.surface, execution_domain: { ...sourceBinding.execution_domain },
        host_instance_id: sourceBinding.host_instance_id, host_session_id: sourceBinding.host_session_id },
      adapter_version: "1.0.0", event: { stage: "stop", role: "system", evidence_class: "lifecycle", native_ids: {} },
      payload: { transition: "directed_handoff", handoff_id: directed.handoff_id, source_injection_id: trace.injection_id,
        target_binding_id: targetBinding.binding_id, source_references: references.filter((reference) => reference.scope_id === scopeId) },
      captured_at: directed.created_at, truncation: { truncated: false }, redaction: { applied: true, policy_version: "1.0.0" },
    }, sourceBinding, database);
  }
  // Existing durable trace authenticates the exact directed transition, including
  // the handing-off reader and each independent persisted source origin.
  const deliveredSnapshot = database.getRecallSnapshot(trace.scope_ids, targetBinding);
  if (BigInt(deliveredSnapshot.data_epoch) !== BigInt(beforeTransition.data_epoch) + BigInt(transitionScopes.size) ||
      beforeTransition.scopes.some((scope) => deliveredSnapshot.scopes.find((current) => current.scope_id === scope.scope_id)?.privacy_epoch !== scope.privacy_epoch)) {
    throw new Error("handoff_snapshot_changed");
  }
  database.recordQueryTrace({ ...trace, scope_epochs: deliveredSnapshot.scopes, query_id: randomUUID(), injection_id: directed.handoff_id,
    binding_id: bindingOwnerId(targetBinding), packet_digest: createHash("sha256").update(serializeDirectedEvidenceHandoff(directed)).digest("hex"),
    diagnostics: ["directed_handoff"], created_at: directed.created_at, delivery_state: "prepared" });
  return directed;
}

/** Return a handoff only when its source trace and target binding still pass. */
export function recognizeDirectedEvidenceHandoff(
  database: AgentMemoryDatabase,
  targetBinding: TrustedBinding,
  input: unknown,
): DirectedEvidenceHandoff | undefined {
  if (!isTrustedBinding(targetBinding)) return undefined;
  let handoff: DirectedEvidenceHandoff;
  try {
    handoff = parseDirectedEvidenceHandoff(input);
  } catch {
    return undefined;
  }
  const delivery = database.getQueryTrace(handoff.handoff_id);
  if (delivery === undefined || delivery.binding_id !== bindingOwnerId(targetBinding) ||
      !delivery.diagnostics.includes("directed_handoff") || delivery.packet_digest !== createHash("sha256").update(serializeDirectedEvidenceHandoff(handoff)).digest("hex")) return undefined;
  if (!currentTargetMatches(handoff.target, targetBinding)) return undefined;
  if (stableBindingIdentity(handoff.source) === stableBindingIdentity(handoff.target)) return undefined;
  const trace = sourceTraceForHandoff(database, handoff);
  if (trace === undefined || !handoffReferencesMatchContext(handoff.source_references, handoff.context)) return undefined;
  try {
    // Use the exact post-transition snapshot, not the pre-transition source
    // trace. Any later capture/correction still invalidates this delivery.
    if (!database.revalidateRecallSnapshot(traceSnapshot(delivery, delivery.scope_ids), targetBinding, trace.output_ids)) return undefined;
    if (!database.validateHandoffSourceReferences(targetBinding, handoff.source_references)) return undefined;
  } catch {
    return undefined;
  }
  return handoff;
}

/**
 * Verify a wrapper against the durable trace created by this product and the
 * currently authenticated host binding. A caller-supplied digest alone is
 * never treated as provenance. Capture adapters can use this operation before
 * forwarding a packet-shaped echo; ordinary model/source text cannot satisfy it.
 */
export function recognizePersistedEvidencePacket(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  input: unknown,
): EvidenceContextWrapper | undefined {
  if (!isTrustedBinding(binding)) return undefined;
  const directed = recognizeDirectedEvidenceHandoff(database, binding, input);
  if (directed !== undefined) return directed.context;
  let wrapper: EvidenceContextWrapper;
  let legacy: EvidenceContextWrapper | undefined;
  try {
    wrapper = parseModelContextWrapper(input);
  } catch {
    try {
      const full = parseEvidencePacketWrapper(input);
      wrapper = parseModelContextWrapper(serializeModelContext(full.packet));
      legacy = parseModelContextWrapper(serializePacketContext(full.packet, false));
    } catch {
      return undefined;
    }
  }
  let trace: ReturnType<AgentMemoryDatabase["getQueryTrace"]>;
  try {
    trace = database.getQueryTrace(wrapper.injection_id);
  } catch {
    return undefined;
  }
  if (
    trace === undefined ||
    trace.binding_id !== bindingOwnerId(binding) ||
    trace.injection_id !== wrapper.injection_id
  ) {
    return undefined;
  }
  if (trace.packet_digest === contextDigest(wrapper)) return wrapper;
  // Existing full-packet echoes retain their original, authenticated wire digest.
  return legacy !== undefined && trace.packet_digest === contextDigest(legacy) ? legacy : undefined;
}

function contextDigest(wrapper: EvidenceContextWrapper): string {
  // The session marker is transport metadata, not evidence. Excluding it from
  // the durable digest keeps an authenticated status-bearing wrapper
  // recognizable and prevents the marker from becoming a captured prompt.
  const { status: _status, ...canonical } = wrapper;
  return digestPacket(serializeModelContextWrapper(canonical));
}

function packetItem(group: RecallSourceGroup): EvidencePacketItem {
  const sourceSpans = group.spans.map((span) => ({
    capture_id: group.capture_id,
    span_id: span.span_id,
    scope_id: group.scope_id,
    revision_id: group.revision_id,
    root: span.root,
    path: span.path,
    start_utf16: Number(span.start_utf16),
    end_utf16: Number(span.end_utf16),
    digest: span.digest,
    quote: span.quote,
    captured_at: group.captured_at,
    occurred_at: group.occurred_at,
    commit_seq: group.commit_seq,
    data_epoch: group.data_epoch,
  }));
  return {
    item_id: group.capture_id,
    revision_id: group.revision_id,
    scope_id: group.scope_id,
    kind: "source",
    status: group.job_state === "pending_extraction" ? "pending_extraction" : "candidate",
    content: sourceSpans.reduce((content, span, index) => {
      if (index === 0) return span.quote;
      const previous = sourceSpans[index - 1]!;
      const separator = previous.root === span.root && previous.path === span.path && previous.end_utf16 === span.start_utf16 ? "" : "\n";
      return `${content}${separator}${span.quote}`;
    }, ""),
    source_span_ids: sourceSpans.map((span) => span.span_id),
    source_class: group.evidence_class,
    role: group.role,
    source_provenance: sourceSpans,
  };
}

function uniqueDiagnostics(diagnostics: readonly ContextDiagnosticCode[]): ContextDiagnosticCode[] {
  return [...new Set(diagnostics)];
}

function groupFitsPacketContract(group: RecallSourceGroup): boolean {
  if (group.spans.length > 128) return false;
  let contentLength = 0;
  for (const [index, span] of group.spans.entries()) {
    if (span.quote.length > 1_000_000) return false;
    contentLength += span.quote.length + (index === 0 ? 0 : 1);
    if (contentLength > 1_000_000) return false;
  }
  return group.spans.length > 0;
}

function queryTerms(query: string | undefined): string[] {
  return query?.toLocaleLowerCase("und").match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
}

function spanQueryScore(quote: string, terms: readonly string[]): number {
  const text = quote.toLocaleLowerCase("und");
  return terms.reduce((sum, term) => sum + (text.includes(term) ? (/[_\d/-]/u.test(term) || term.length >= 12 ? 8 : 1) : 0), 0);
}

function selectBudgetedSourceSpans(group: RecallSourceGroup, query: string | undefined, byteBudget: number): RecallSourceGroup {
  if (group.spans.length <= 1) return group;
  const wholeSpan = group.spans.find((span) => span.start_utf16 === 0n && group.spans.some((other) =>
    other.span_id !== span.span_id &&
    other.root === span.root &&
    other.path === span.path &&
    other.start_utf16 >= span.start_utf16 &&
    other.end_utf16 <= span.end_utf16 &&
    other.end_utf16 < span.end_utf16,
  ));
  const sourceSpans = wholeSpan === undefined ? group.spans : group.spans.filter((span) => span.span_id !== wholeSpan.span_id);
  if (sourceSpans.length === 0) return { ...group, spans: [] };
  const baseCap = Math.min(byteBudget, Math.max(256, Math.min(8_192, Math.floor(byteBudget * 0.75))));
  const cap = group.evidence_class === "assistant_output" ? Math.min(baseCap, 1_024) : baseCap;
  if (sourceSpans.length === 1) {
    return Buffer.byteLength(sourceSpans[0]!.quote, "utf8") <= cap
      ? { ...group, spans: [sourceSpans[0]!] }
      : { ...group, spans: [] };
  }
  const terms = queryTerms(query);
  const ranked = sourceSpans.map((span, index) => {
    const score = spanQueryScore(span.quote, terms);
    return { span, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: typeof ranked = [];
  let bytes = 0;
  for (const candidate of ranked) {
    const nextBytes = Buffer.byteLength(candidate.span.quote, "utf8") + (selected.length === 0 ? 0 : 1);
    if (selected.length > 0 && bytes + nextBytes > cap) continue;
    if (nextBytes > cap && selected.length === 0) continue;
    selected.push(candidate);
    bytes += nextBytes;
  }
  if (selected.length === 0) return { ...group, spans: [] };
  if (wholeSpan === undefined && selected.length === group.spans.length) return group;
  const spans = selected.sort((left, right) => left.index - right.index).map(candidate => candidate.span);
  return { ...group, spans };
}

function sourceBatchDensity(
  batch: { readonly groups: readonly RecallSourceGroup[] },
  query: string | undefined,
): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const score = batch.groups.reduce((sum, group) => sum + group.spans.reduce((groupScore, span) => groupScore + spanQueryScore(span.quote, terms), 0), 0);
  if (score === 0) return 0;
  const serializedCost = Buffer.byteLength(JSON.stringify(batch.groups.map(packetItem)), "utf8");
  return score / Math.max(1, serializedCost);
}

function packetFor(
  input: PacketBuildInput,
  groups: readonly RecallSourceGroup[],
  diagnostics: readonly ContextDiagnosticCode[],
  used: number,
  budget: number,
  unit: "tokens" | "utf8_bytes",
  recommendations: readonly EvidencePacketItem[] = [],
): EvidencePacket {
  const scopes = input.scope_epochs.map((scope) => ({
    scope_id: scope.scope_id,
    data_epoch: scope.data_epoch,
    privacy_epoch: scope.privacy_epoch,
  }));
  return parseEvidencePacket({
    version: 1,
    query_id: input.query_id,
    watermark: input.watermark,
    known_at_seq: input.known_at_seq,
    data_epoch: input.data_epoch,
    privacy_epoch: input.privacy_epoch,
    valid_until: input.valid_until,
    scope_epochs: scopes,
    items: [...groups.map(packetItem), ...recommendations],
    tokens: { used, budget, unit },
    mode: input.mode ?? "degraded",
    ...(input.graph_continuation === undefined ? {} : { graph_continuation: input.graph_continuation }),
    diagnostics: uniqueDiagnostics(diagnostics).map((code) => ({ code })),
    delivery: { format: "agent_memory_evidence_v1", injection_id: input.injection_id },
  });
}

function measure(packet: EvidencePacket, tokenizer: ContextTokenizer | undefined): { readonly bytes: number; readonly units: number; readonly unit: "tokens" | "utf8_bytes" } {
  const serialized = serializeModelContext(packet);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (tokenizer === undefined) return { bytes, units: bytes, unit: "utf8_bytes" };
  const units = tokenizer.count(serialized);
  if (!Number.isSafeInteger(units) || units < 0) throw new Error("context_tokenizer_invalid");
  return { bytes, units, unit: "tokens" };
}

function packetWithUsage(
  packet: EvidencePacket,
  used: number,
  budget: number,
  unit: "tokens" | "utf8_bytes",
): EvidencePacket {
  return parseEvidencePacket({ ...packet, tokens: { used, budget, unit } });
}

function packetFits(
  packet: EvidencePacket,
  tokenizer: ContextTokenizer | undefined,
  unitBudget: number,
  byteBudget: number,
): { readonly fits: boolean; readonly packet: EvidencePacket; readonly measurement: { readonly bytes: number; readonly units: number; readonly unit: "tokens" | "utf8_bytes" } } {
  const current = packet;
  let measurement;
  try {
    measurement = measure(current, tokenizer);
  } catch (error: unknown) {
    if (error instanceof PacketBudgetError) {
      return {
        fits: false,
        packet: current,
        measurement: {
          bytes: Number.MAX_SAFE_INTEGER,
          units: Number.MAX_SAFE_INTEGER,
          unit: tokenizer === undefined ? "utf8_bytes" : "tokens",
        },
      };
    }
    throw error;
  }
  if (measurement.bytes > byteBudget || measurement.units > unitBudget) {
    return { fits: false, packet: current, measurement };
  }
  // Usage metadata is omitted from serializeModelContext, so it cannot change the measurement.
  return {
    fits: true,
    packet: packetWithUsage(current, measurement.units, current.tokens.budget, measurement.unit),
    measurement,
  };
}

function finalizePacketUsage(
  packet: EvidencePacket,
  tokenizer: ContextTokenizer | undefined,
  budget: number,
): { readonly packet: EvidencePacket; readonly measurement: { readonly bytes: number; readonly units: number; readonly unit: "tokens" | "utf8_bytes" } } {
  const measurement = measure(packet, tokenizer);
  return {
    packet: measurement.units > budget ? packet : packetWithUsage(packet, measurement.units, budget, measurement.unit),
    measurement,
  };
}

function emptyPacketWithinBudget(
  input: PacketBuildInput,
  diagnostics: readonly ContextDiagnosticCode[],
  tokenizer: ContextTokenizer | undefined,
  unitBudget: number,
  byteBudget: number,
): EvidencePacket {
  const empty = packetFor(input, [], diagnostics, 0, unitBudget, tokenizer === undefined ? "utf8_bytes" : "tokens");
  const emptyInitial = measure(empty, tokenizer);
  if (emptyInitial.bytes > byteBudget || emptyInitial.units > unitBudget) throw new PacketBudgetError();
  const finalized = finalizePacketUsage(empty, tokenizer, unitBudget);
  if (finalized.measurement.bytes > byteBudget || finalized.measurement.units > unitBudget) throw new PacketBudgetError();
  return finalized.packet;
}

export function buildEvidencePacket(
  input: PacketBuildInput,
  groups: readonly RecallSourceGroup[],
  context: PreparationContext,
  recommendations: readonly EvidencePacketItem[] = [],
): EvidencePacket {
  if (!isPreparationContext(context)) throw new Error("preparation_context_invalid");
  // Explicit byte profiles measure bytes even if a tokenizer is available.
  const tokenizer = context.budget.profile === undefined ? context.budget.tokenizer : undefined;
  const byteBudget = (context.kind === "session_start" ? context.budget.session_start_max_bytes : context.budget.max_bytes) - context.budget.reserve_bytes;
  const tokenBudget = Math.min(
    input.requested_token_budget,
    context.kind === "session_start" ? context.budget.session_start_tokens : context.budget.automatic_tokens,
  );
  // Without a verified tokenizer, one requested token is one conservative
  // byte of the measured wrapper budget. This is an upper bound, never a
  // claim about the language's actual tokenization.
  const unitBudget = context.budget.profile === undefined
    ? tokenizer === undefined ? Math.min(byteBudget, tokenBudget) : tokenBudget
    : Math.min(byteBudget, context.budget.profile.limit, input.requested_token_budget);
  const initialDiagnostics = [...(input.diagnostics ?? [])];
  const atomicSourceGroups = (input.atomic_source_groups ?? [])
    .map((atomic) => [...new Set(atomic)])
    .filter((atomic) => atomic.length > 0);
  const spanBudget = tokenizer === undefined ? unitBudget : byteBudget;
  const selectedGroups = input.query === undefined
    ? groups
    : groups.map((group) => selectBudgetedSourceSpans(group, input.query, spanBudget));
  // Check both possible terminal forms, including the cursor. Measuring each
  // also handles tokenizers whose cost is not ordered by string byte length.
  const droppedInput: PacketBuildInput = {
    ...input,
    graph_continuation: {
      complete: false,
      reason: "packet_budget_exhausted",
      ...(input.graph_continuation?.cursor === undefined ? {} : { cursor: input.graph_continuation.cursor }),
    },
  };
  const fitInputs = atomicSourceGroups.length === 0 ? [input] : [input, droppedInput];
  let reserveTerminalBudgetDiagnostic = false;
  for (;;) {
    let skippedForBudget = false;
    let protectedEvidenceOmitted = false;
    const fitsTerminalForms = (sources: readonly RecallSourceGroup[], extraDiagnostics: readonly ContextDiagnosticCode[] = [], items: readonly EvidencePacketItem[] = []) =>
      sources.length + items.length <= 200 && fitInputs.every(fitInput => {
        const fitDiagnostics = uniqueDiagnostics([
          ...initialDiagnostics,
          ...(reserveTerminalBudgetDiagnostic ? ["budget_exhausted" as const] : []),
          ...(fitInput.graph_continuation?.complete === false ? ["graph_incomplete" as const] : []),
          ...extraDiagnostics,
        ]);
        return packetFits(packetFor(fitInput, sources, fitDiagnostics, 0, unitBudget, tokenizer === undefined ? "utf8_bytes" : "tokens", items), tokenizer, unitBudget, byteBudget).fits;
      });
    let accepted: RecallSourceGroup[] = [];
    const byId = new Map(selectedGroups.map((group) => [group.capture_id, group]));
    const acceptedIds = new Set<string>();
    const graphMemberIds = new Set(atomicSourceGroups.flat());
    const processedAtomic = new Set<number>();
    let graphIncomplete = initialDiagnostics.includes("graph_incomplete") || input.graph_continuation?.complete === false;
    let graphDropped = atomicSourceGroups.some((atomic) => atomic.some((id) => !byId.has(id)));
    graphIncomplete ||= graphDropped;
    const hasBlockingInputDiagnostic = input.diagnostics?.some((code) => code !== "degraded_lexical") ?? false;
    const batches: { readonly groups: readonly RecallSourceGroup[]; readonly graph: boolean; readonly protected: boolean }[] = [];
    for (const group of selectedGroups) {
    let graphBatch = false;
    let batch: RecallSourceGroup[];
    if (graphMemberIds.has(group.capture_id)) {
      const atomicIndex = atomicSourceGroups.findIndex((atomic, index) => !processedAtomic.has(index) && atomic.includes(group.capture_id));
      if (atomicIndex < 0) continue;
      processedAtomic.add(atomicIndex);
      graphBatch = true;
      const atomic = atomicSourceGroups[atomicIndex];
      if (atomic === undefined || atomic.some((id) => !byId.has(id))) {
        skippedForBudget = true;
        graphIncomplete = true;
        graphDropped = true;
        continue;
      }
      batch = atomic.filter((id) => !acceptedIds.has(id)).map((id) => byId.get(id)).filter((entry): entry is RecallSourceGroup => entry !== undefined);
    } else {
      batch = [group];
    }
    if (batch.length === 0) continue;
    batches.push({ groups: batch, graph: graphBatch, protected: graphBatch || batch.some((entry) => input.protected_source_ids?.includes(entry.capture_id) === true) });
  }
  // Graph paths remain atomic in every fit pass.
  const processSourceBatch = (sourceBatch: (typeof batches)[number], items: readonly EvidencePacketItem[] = []): void => {
    const graphBatch = sourceBatch.graph;
    const batch = sourceBatch.groups.filter((entry) => !acceptedIds.has(entry.capture_id));
    if (batch.length === 0) return;
    if (batch.some((entry) => !groupFitsPacketContract(entry))) {
      skippedForBudget = true;
      protectedEvidenceOmitted ||= sourceBatch.protected && !graphBatch;
      graphIncomplete ||= graphBatch;
      graphDropped ||= graphBatch;
      return;
    }
    const candidateGroups = [...accepted, ...batch];
    if (fitsTerminalForms(candidateGroups, [], items)) {
      accepted = candidateGroups;
      for (const entry of batch) acceptedIds.add(entry.capture_id);
    }
    else {
      skippedForBudget = true;
      protectedEvidenceOmitted ||= sourceBatch.protected && !graphBatch;
      graphIncomplete ||= graphBatch;
      graphDropped ||= graphBatch;
    }
  };
  // Protect the latest user task before admitting reports. Reports and
  // older notes are useful context, but neither may evict the task.
  const acceptedRecommendations: EvidencePacketItem[] = [];
  let recommendationOmitted = false;
  const recordRecommendations = recommendations.filter((item) => item.kind === "record");
  const promptBatches = batches.filter((batch) => batch.protected && batch.groups.some((entry) => entry.evidence_class === "prompt"));
  const latestPromptByScope = new Map<string, (typeof batches)[number]>();
  for (const batch of promptBatches) {
    const group = batch.groups[0];
    if (group === undefined) continue;
    const previous = latestPromptByScope.get(group.scope_id);
    if (previous === undefined || BigInt(group.commit_seq) > BigInt(previous.groups[0]!.commit_seq)) latestPromptByScope.set(group.scope_id, batch);
  }
  const taskProtectedBatches = promptBatches.filter((batch) => latestPromptByScope.get(batch.groups[0]!.scope_id) === batch);
  for (const sourceBatch of taskProtectedBatches) processSourceBatch(sourceBatch, acceptedRecommendations);

  // A compact current assistant handoff comes next. Large raw assistant
  // output can be dropped without displacing the task or a compact report.
  const remainingProtectedBatches = batches.filter((batch) => batch.protected && !taskProtectedBatches.includes(batch));
  const assistantProtectedBatches = remainingProtectedBatches.filter((batch) => batch.groups.some((entry) => entry.evidence_class === "assistant_output"));
  for (const sourceBatch of assistantProtectedBatches) processSourceBatch(sourceBatch, acceptedRecommendations);

  const recommendationFitDiagnostics = [
    ...(accepted.length === 0 && selectedGroups.length > 0 && skippedForBudget ? ["budget_exhausted" as const] : []),
    ...(selectedGroups.length === 0 && recommendations.length === 0 && !hasBlockingInputDiagnostic ? ["no_match" as const] : []),
  ];
  for (const record of recordRecommendations) {
    if (fitsTerminalForms(accepted, recommendationFitDiagnostics, [...acceptedRecommendations, record])) acceptedRecommendations.push(record);
    else { skippedForBudget = true; recommendationOmitted = true; }
  }

  // Older explicit notes and other protected prompt evidence fill only
  // remaining space after the task, handoff and report have had a chance.
  for (const sourceBatch of remainingProtectedBatches.filter((batch) => !assistantProtectedBatches.includes(batch))) processSourceBatch(sourceBatch, acceptedRecommendations);

  // T18b additive procedure recommendations: append after accepted source
  // groups, one fit check each, so oversized recommendations are dropped
  // without displacing protected evidence.
  for (const recommendation of recommendations.filter((item) => item.kind !== "record")) {
    if (fitsTerminalForms(accepted, recommendationFitDiagnostics, [...acceptedRecommendations, recommendation])) acceptedRecommendations.push(recommendation);
    else { skippedForBudget = true; recommendationOmitted = true; }
  }

  // Optional relevance/timeline material fills only after protected evidence
  // and current recommendations have had a chance to fit.
  const optionalBatches = batches
    .map((batch, index) => ({ batch, index }))
    .filter((entry) => !entry.batch.protected)
    .sort((left, right) => sourceBatchDensity(right.batch, input.query) - sourceBatchDensity(left.batch, input.query) || left.index - right.index);
  for (const entry of optionalBatches) processSourceBatch(entry.batch, acceptedRecommendations);
  let finalAccepted = accepted;
  let finalGraphDropped = graphDropped;
  let finalGraphIncomplete = graphIncomplete;
  const finalDiagnostics = (): ContextDiagnosticCode[] => {
    const diagnostics = [...initialDiagnostics];
    if (finalGraphIncomplete) diagnostics.push("graph_incomplete");
    if (finalAccepted.length === 0 && selectedGroups.length === 0 && recommendations.length === 0 && !hasBlockingInputDiagnostic) diagnostics.push("no_match");
    if (finalAccepted.length === 0 && selectedGroups.length > 0 && skippedForBudget) diagnostics.push("budget_exhausted");
    if (protectedEvidenceOmitted) diagnostics.push("budget_exhausted");
    if (recommendationOmitted) diagnostics.push("budget_exhausted");
    return uniqueDiagnostics(diagnostics);
  };
  const buildFinalPacket = (): EvidencePacket => packetFor(
    finalGraphDropped ? droppedInput : input,
    finalAccepted,
    finalDiagnostics(),
    0,
    unitBudget,
    tokenizer === undefined ? "utf8_bytes" : "tokens",
    acceptedRecommendations,
  );
  let packet = buildFinalPacket();
  let initialMeasurement = measure(packet, tokenizer);
  if (initialMeasurement.bytes > byteBudget || initialMeasurement.units > unitBudget) {
    if (!reserveTerminalBudgetDiagnostic && (protectedEvidenceOmitted || recommendationOmitted)) {
      reserveTerminalBudgetDiagnostic = true;
      continue;
    }
    const emptyDiagnostics = [...finalDiagnostics(), "budget_exhausted" as const];
    return emptyPacketWithinBudget(finalGraphDropped ? droppedInput : input, emptyDiagnostics, tokenizer, unitBudget, byteBudget);
  }
  const finalized = finalizePacketUsage(packet, tokenizer, unitBudget);
  const final = finalized.packet;
  const finalMeasured = finalized.measurement;
  if (finalMeasured.bytes > byteBudget || finalMeasured.units > unitBudget) {
    if (!reserveTerminalBudgetDiagnostic && (protectedEvidenceOmitted || recommendationOmitted)) {
      reserveTerminalBudgetDiagnostic = true;
      continue;
    }
    const emptyDiagnostics = [...finalDiagnostics(), "budget_exhausted" as const];
    return emptyPacketWithinBudget(finalGraphDropped ? droppedInput : input, emptyDiagnostics, tokenizer, unitBudget, byteBudget);
  }
  return final;
}
}

export function packetDigest(packet: EvidencePacket): string {
  return digestPacket(serializeModelContext(packet));
}
