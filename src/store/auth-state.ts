import { z } from "zod";

import { nonNegativeInt64Schema } from "../host/contract.js";
import type { AgentMemoryDatabase } from "./database.js";

export const AUTH_ISSUER = "https://github.com";

const uuidSchema = z.uuid();
const clientIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const accountIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
const dateTimeSchema = z.iso.datetime({ offset: true });

export const authStateRecordSchema = z
  .object({
    version: z.literal(1),
    // The active entry is retained while revoked cleanup is pending and is
    // cleared only by completeRevocation after the caller confirms deletion.
    entry_id: uuidSchema.nullable(),
    account_ref: uuidSchema,
    client_id: clientIdSchema,
    issuer: z.literal(AUTH_ISSUER),
    account_id: accountIdSchema,
    auth_epoch: nonNegativeInt64Schema,
    state: z.enum(["provisioning", "ready", "refreshing", "cleanup_pending", "revoked"]),
    auth_generation: uuidSchema,
    pending_entry_id: uuidSchema.nullable(),
    operation_id: uuidSchema.nullable(),
    retiring_entry_id: uuidSchema.nullable(),
    access_expires_at: dateTimeSchema,
    refresh_expires_at: dateTimeSchema,
    granted_scope: z.string().max(4096),
    refresh_started_at: dateTimeSchema.nullable(),
    updated_at: dateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === "provisioning") {
      if (
        record.entry_id === null ||
        record.operation_id === null ||
        record.refresh_started_at === null ||
        record.pending_entry_id !== null ||
        record.retiring_entry_id !== null
      ) {
        context.addIssue({ code: "custom", path: ["state"], message: "provisioning_transition_invalid" });
      }
      return;
    }
    if (record.state === "ready") {
      if (
        record.entry_id === null ||
        record.pending_entry_id !== null ||
        record.operation_id !== null ||
        record.retiring_entry_id !== null ||
        record.refresh_started_at !== null
      ) {
        context.addIssue({ code: "custom", path: ["state"], message: "ready_transition_invalid" });
      }
      return;
    }
    if (record.state === "refreshing") {
      if (
        record.entry_id === null ||
        record.pending_entry_id === null ||
        record.operation_id === null ||
        record.retiring_entry_id !== null ||
        record.refresh_started_at === null
      ) {
        context.addIssue({ code: "custom", path: ["state"], message: "refresh_transition_invalid" });
      }
      return;
    }
    if (record.state === "cleanup_pending") {
      if (
        record.entry_id === null ||
        record.pending_entry_id !== null ||
        record.operation_id === null ||
        record.retiring_entry_id === null ||
        record.refresh_started_at !== null
      ) {
        context.addIssue({ code: "custom", path: ["state"], message: "cleanup_transition_invalid" });
      }
      return;
    }
    if (
      record.refresh_started_at !== null ||
      (record.entry_id === null &&
        (record.pending_entry_id !== null || record.operation_id !== null || record.retiring_entry_id !== null))
    ) {
      context.addIssue({ code: "custom", path: ["refresh_started_at"], message: "revoked_refresh_marker_invalid" });
    }
  });

export type AuthStateRecord = z.infer<typeof authStateRecordSchema>;

export type AuthLogoutDecision =
  | { readonly action: "cancelled" | "none" }
  | { readonly action: "revoked" | "already_revoked"; readonly auth_generation: string }
  | { readonly action: "invalid" };

/** Durable auth metadata boundary; tokens never cross this interface. */
export interface AuthStateRegistry {
  load(accountRef: string): Promise<unknown>;
  authorizationActive(accountRef: string, entryId: string, clientId: string, operationId: string): Promise<boolean>;
  beginAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, startedAt: string): Promise<boolean>;
  cancelAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, updatedAt: string): Promise<boolean>;
  prepareLogout(accountRef: string, entryId: string, clientId: string, newGeneration: string, updatedAt: string): Promise<AuthLogoutDecision>;
  registerProvisioning(record: AuthStateRecord): Promise<AuthStateRecord | false>;
  completeProvisioning(accountRef: string, expectedGeneration: string, operationId: string, record: AuthStateRecord): Promise<boolean>;
  claimRefresh(
    accountRef: string,
    expectedGeneration: string,
    operationId: string,
    pendingEntryId: string,
    startedAt: string,
  ): Promise<boolean>;
  promoteRefresh(accountRef: string, expectedGeneration: string, operationId: string, record: AuthStateRecord): Promise<boolean>;
  completeCleanup(accountRef: string, expectedGeneration: string, operationId: string, updatedAt: string): Promise<boolean>;
  completeOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): Promise<boolean>;
  recoverOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): Promise<boolean>;
  markEntryDeleted(accountRef: string, revokedGeneration: string, entryId: string, updatedAt: string): Promise<boolean>;
  revoke(
    accountRef: string,
    expectedGeneration: string,
    clientId: string,
    newGeneration: string,
    updatedAt: string,
  ): Promise<boolean>;
  completeRevocation(accountRef: string, expectedGeneration: string, updatedAt: string): Promise<boolean>;
}

export class DatabaseAuthStateRegistry implements AuthStateRegistry {
  constructor(
    private readonly database: AgentMemoryDatabase,
    private readonly admit?: <T>(operation: () => T) => Promise<T>,
  ) {}

  private run<T>(operation: () => T): Promise<T> {
    return this.admit === undefined ? Promise.resolve(operation()) : this.admit(operation);
  }

  load(accountRef: string): Promise<unknown> {
    return this.run(() => this.database.auth.getAuthState(accountRef));
  }

  authorizationActive(accountRef: string, entryId: string, clientId: string, operationId: string): Promise<boolean> {
    return this.run(() => this.database.auth.isAuthAuthorizationActive(accountRef, entryId, clientId, operationId));
  }

  prepareLogout(
    accountRef: string,
    entryId: string,
    clientId: string,
    newGeneration: string,
    updatedAt: string,
  ): Promise<AuthLogoutDecision> {
    return this.run(() => this.database.auth.prepareAuthLogout(accountRef, entryId, clientId, newGeneration, updatedAt));
  }

  beginAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, startedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.beginAuthAuthorization(accountRef, entryId, clientId, operationId, startedAt));
  }

  cancelAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.cancelAuthAuthorization(accountRef, entryId, clientId, operationId, updatedAt));
  }

  registerProvisioning(record: AuthStateRecord): Promise<AuthStateRecord | false> {
    return this.run(() => this.database.auth.registerAuthProvisioning(record));
  }

  completeProvisioning(
    accountRef: string,
    expectedGeneration: string,
    operationId: string,
    record: AuthStateRecord,
  ): Promise<boolean> {
    return this.run(() => this.database.auth.completeAuthProvisioning(accountRef, expectedGeneration, operationId, record));
  }

  claimRefresh(
    accountRef: string,
    expectedGeneration: string,
    operationId: string,
    pendingEntryId: string,
    startedAt: string,
  ): Promise<boolean> {
    return this.run(() => this.database.auth.claimAuthRefresh(accountRef, expectedGeneration, operationId, pendingEntryId, startedAt));
  }

  promoteRefresh(accountRef: string, expectedGeneration: string, operationId: string, record: AuthStateRecord): Promise<boolean> {
    return this.run(() => this.database.auth.promoteAuthRefresh(accountRef, expectedGeneration, operationId, record));
  }

  completeCleanup(accountRef: string, expectedGeneration: string, operationId: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.completeAuthCleanup(accountRef, expectedGeneration, operationId, updatedAt));
  }

  completeOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.completeAuthOperation(accountRef, operationId, entryId, updatedAt));
  }

  recoverOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.recoverAuthOperation(accountRef, operationId, entryId, updatedAt));
  }

  markEntryDeleted(accountRef: string, revokedGeneration: string, entryId: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.markAuthEntryDeleted(accountRef, revokedGeneration, entryId, updatedAt));
  }

  revoke(
    accountRef: string,
    expectedGeneration: string,
    clientId: string,
    newGeneration: string,
    updatedAt: string,
  ): Promise<boolean> {
    return this.run(() => this.database.auth.revokeAuthState(accountRef, expectedGeneration, clientId, newGeneration, updatedAt));
  }

  completeRevocation(accountRef: string, expectedGeneration: string, updatedAt: string): Promise<boolean> {
    return this.run(() => this.database.auth.completeAuthRevocation(accountRef, expectedGeneration, updatedAt));
  }
}
