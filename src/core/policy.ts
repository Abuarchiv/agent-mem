import { z } from "zod";

import { evidenceClassSchema, type TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase, StoredSource } from "../store/database.js";

const outputTargetSchema = z.union([
  z.literal("local_ui"),
  z.literal("export:jsonl"),
  z.string().regex(/^reader:[A-Za-z0-9._/-]{1,120}$/),
  z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/),
]);
const sourceClassListSchema = z.array(evidenceClassSchema).min(1).max(6);
const captureRetentionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("until_deleted") }).strict(),
  z.object({ mode: z.literal("finite"), duration_seconds: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
const captureSelectionSchema = z
  .object({ source_class: evidenceClassSchema, retention: captureRetentionSchema })
  .strict();
const capturePolicySchema = z.array(captureSelectionSchema).max(6).superRefine((value, context) => {
  const classes = value.map((selection) => selection.source_class);
  if (new Set(classes).size !== classes.length) {
    context.addIssue({ code: "custom", path: ["source_class"], message: "duplicate_source_class" });
  }
});
const setupBindingSchema = z
  .object({
    version: z.literal(1),
    setup_id: z.uuid(),
    allowed_scope_ids: z.array(z.uuid()).min(1).max(128),
    allowed_output_targets: z.array(outputTargetSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowed_scope_ids).size !== value.allowed_scope_ids.length) {
      context.addIssue({ code: "custom", path: ["allowed_scope_ids"], message: "duplicate_scope" });
    }
    if (new Set(value.allowed_output_targets).size !== value.allowed_output_targets.length) {
      context.addIssue({ code: "custom", path: ["allowed_output_targets"], message: "duplicate_target" });
    }
  });
const outputBindingSchema = z
  .object({
    version: z.literal(1),
    output_binding_id: z.uuid(),
    setup_id: z.uuid(),
    scope_id: z.uuid(),
    target: outputTargetSchema,
  })
  .strict();
const grantSchema = z
  .object({ target: outputTargetSchema, source_classes: sourceClassListSchema })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.source_classes).size !== value.source_classes.length) {
      context.addIssue({ code: "custom", path: ["source_classes"], message: "duplicate_source_class" });
    }
  });

export type OutputTarget = z.infer<typeof outputTargetSchema>;
export type SourceClass = z.infer<typeof evidenceClassSchema>;
export type ScopeOutputGrant = z.infer<typeof grantSchema>;
export type CaptureRetention = z.infer<typeof captureRetentionSchema>;
export type ScopeCaptureSelection = z.infer<typeof captureSelectionSchema>;
type PolicySetupShape = z.infer<typeof setupBindingSchema>;
declare const policySetupBrand: unique symbol;
declare const policyOutputBrand: unique symbol;
export type PolicySetupBinding = Omit<PolicySetupShape, "allowed_scope_ids" | "allowed_output_targets"> & {
  readonly allowed_scope_ids: readonly PolicySetupShape["allowed_scope_ids"][number][];
  readonly allowed_output_targets: readonly PolicySetupShape["allowed_output_targets"][number][];
  readonly [policySetupBrand]: true;
};
export type PolicyOutputBinding = z.infer<typeof outputBindingSchema> & { readonly [policyOutputBrand]: true };

const setupBindings = new WeakSet<object>();
const outputBindings = new WeakSet<object>();

function parsePolicy<T>(schema: z.ZodType<T>, input: unknown, name: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`${name}_invalid`);
  return result.data;
}

export function createPolicySetupBinding(input: unknown): PolicySetupBinding {
  const parsed = parsePolicy(setupBindingSchema, input, "policy_setup");
  const binding = Object.freeze({
    ...parsed,
    allowed_scope_ids: Object.freeze([...parsed.allowed_scope_ids]),
    allowed_output_targets: Object.freeze([...parsed.allowed_output_targets]),
  }) as PolicySetupBinding;
  setupBindings.add(binding);
  return binding;
}

export function createPolicyOutputBinding(setup: PolicySetupBinding, input: unknown): PolicyOutputBinding {
  if (!isPolicySetupBinding(setup)) throw new Error("policy_setup_invalid");
  const parsed = parsePolicy(outputBindingSchema, input, "policy_output");
  if (parsed.setup_id !== setup.setup_id) throw new Error("policy_output_setup_mismatch");
  if (!setup.allowed_scope_ids.includes(parsed.scope_id)) throw new Error("policy_output_scope_not_allowed");
  if (!setup.allowed_output_targets.includes(parsed.target)) throw new Error("policy_output_target_not_allowed");
  const binding = Object.freeze(parsed) as PolicyOutputBinding;
  outputBindings.add(binding);
  return binding;
}

export function isPolicySetupBinding(input: unknown): input is PolicySetupBinding {
  return typeof input === "object" && input !== null && setupBindings.has(input);
}

export function isPolicyOutputBinding(input: unknown): input is PolicyOutputBinding {
  return typeof input === "object" && input !== null && outputBindings.has(input);
}

export function parseScopeOutputGrants(input: unknown): readonly ScopeOutputGrant[] {
  if (!Array.isArray(input) || input.length > 32) throw new Error("policy_grants_invalid");
  const grants = input.map((grant, index) => parsePolicy(grantSchema, grant, `policy_grant_${index}`));
  const keys = grants.flatMap((grant) => grant.source_classes.map((sourceClass) => `${grant.target}\u0000${sourceClass}`));
  if (new Set(keys).size !== keys.length) throw new Error("policy_grants_invalid");
  return grants;
}

export function parseScopeCapturePolicy(input: unknown): readonly ScopeCaptureSelection[] {
  const parsed = parsePolicy(capturePolicySchema, input, "policy_capture");
  return parsed.map((selection) => ({
    source_class: selection.source_class,
    retention: { ...selection.retention },
  }));
}

export function readerOutputTarget(binding: TrustedBinding): OutputTarget {
  const target = `reader:${binding.surface}` as TrustedBinding["egress"]["reader_targets"][number] as OutputTarget;
  if (!binding.egress.reader_targets.includes(target as TrustedBinding["egress"]["reader_targets"][number])) {
    throw new Error("reader_output_target_missing");
  }
  return target;
}

export function setScopeOutputGrants(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  grants: unknown,
  updatedAt: string,
): string {
  return database.replaceScopeOutputGrants(binding, scopeId, parseScopeOutputGrants(grants), updatedAt);
}

/** Replace only reader grants while preserving local, export, and provider grants. */
export function setReaderOutputGrants(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  grants: unknown,
  updatedAt: string,
): string {
  return database.replaceReaderOutputGrants(binding, scopeId, parseScopeOutputGrants(grants), updatedAt);
}

/** Replace only local viewer grants while preserving reader/export/provider grants. */
export function setLocalUiOutputGrants(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  sourceClasses: unknown,
  updatedAt: string,
): string {
  return database.replaceLocalUiOutputGrants(
    binding,
    scopeId,
    parseScopeOutputGrants([{ target: "local_ui", source_classes: sourceClasses }]),
    updatedAt,
  );
}

export function setScopeCapturePolicy(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  selections: unknown,
  updatedAt: string,
): string {
  return database.replaceScopeCapturePolicy(binding, scopeId, parseScopeCapturePolicy(selections), updatedAt);
}

/** Enroll an installed scope with deny-all capture until the user selects classes. */
export function enrollScopeCapturePolicy(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  updatedAt: string,
): string {
  return setScopeCapturePolicy(database, binding, scopeId, [], updatedAt);
}

export function setCapturePaused(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  paused: boolean,
  updatedAt: string,
): string {
  return database.setCapturePaused(binding, scopeId, paused, updatedAt);
}

export function readSourceForOutput(
  database: AgentMemoryDatabase,
  binding: PolicyOutputBinding,
  captureId: string,
): StoredSource | undefined {
  return database.getSourceForOutput(captureId, binding);
}
