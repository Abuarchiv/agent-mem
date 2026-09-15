import type { AgentMemoryDatabase, PhysicalMaintenanceResult } from "./database.js";

export type { PhysicalMaintenanceResult };

/** Run the store's bounded secure-delete/checkpoint maintenance pass. */
export function runPhysicalMaintenance(
  database: AgentMemoryDatabase,
  options: { readonly vacuum?: boolean } = {},
): PhysicalMaintenanceResult {
  return database.performPhysicalMaintenance(options);
}

export const maintainPurgeStore = runPhysicalMaintenance;
