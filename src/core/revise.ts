import type { PolicyOutputBinding } from "./policy.js";
import type { TrustedBinding } from "../host/contract.js";
import type { AgentMemoryDatabase } from "../store/database.js";
import type { RevisionDetail, RevisionMutationResult } from "../store/revision-repository.js";

/**
 * Apply one structurally validated ledger operation through the store-owned
 * transaction boundary. The input contains no caller-controlled support or
 * actor status; those facts are derived from stored source rows and binding.
 */
export function revise(
  database: AgentMemoryDatabase,
  binding: TrustedBinding,
  input: unknown,
): RevisionMutationResult {
  return database.revisions.apply(binding, input);
}

/** Read a revision only through the bound output policy. */
export function readRevision(
  database: AgentMemoryDatabase,
  binding: PolicyOutputBinding,
  revisionId: string,
): RevisionDetail | undefined {
  return database.revisions.readDetail(binding, revisionId);
}
