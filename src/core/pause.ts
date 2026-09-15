import type { AgentMemoryDatabase } from "../store/database.js";
import { setCapturePaused, type PolicySetupBinding } from "./policy.js";

export function pauseCapture(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  updatedAt: string,
): string {
  return setCapturePaused(database, binding, scopeId, true, updatedAt);
}

export function resumeCapture(
  database: AgentMemoryDatabase,
  binding: PolicySetupBinding,
  scopeId: string,
  updatedAt: string,
): string {
  return setCapturePaused(database, binding, scopeId, false, updatedAt);
}
