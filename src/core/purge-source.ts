import { z } from "zod";

import type {
  AgentMemoryDatabase,
  PurgeExecutionResult,
} from "../store/database.js";
import { nonNegativeInt64Schema, parseContract } from "../host/contract.js";
import type { PolicySetupBinding } from "./policy.js";

const purgeRequestSchema = z
  .object({
    version: z.literal(1),
    operation_id: z.uuid(),
    scope_id: z.uuid(),
    capture_ids: z.array(z.uuid()).min(1).max(128),
    expected_privacy_epoch: nonNegativeInt64Schema,
    requested_at: z.iso.datetime({ offset: true }),
    full: z.boolean().optional(),
    defer_completion: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.capture_ids).size !== value.capture_ids.length) {
      context.addIssue({ code: "custom", path: ["capture_ids"], message: "duplicate_capture_id" });
    }
  });

export type PurgeSourceRequest = z.infer<typeof purgeRequestSchema>;
export type PurgeSourceResult = PurgeExecutionResult;

export function purgeSource(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  input: unknown,
): PurgeSourceResult {
  const parsed = parseContract(purgeRequestSchema, input, "purge-source");
  return database.purgeSources(binding, parsed);
}

export const purgeSources = purgeSource;
