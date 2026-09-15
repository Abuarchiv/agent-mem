import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { nonNegativeInt64Schema, parseContract } from "../host/contract.js";
import { AUTH_ISSUER, authStateRecordSchema, type AuthLogoutDecision, type AuthStateRecord } from "./auth-state.js";
import { StoreError } from "./errors.js";

const apiAuthRecordSchema = z.object({
  version: z.literal(1),
  provider_id: z.literal("openrouter"),
  account_ref: z.uuid(),
  entry_id: z.uuid(),
  auth_generation: z.uuid(),
  auth_epoch: nonNegativeInt64Schema,
  state: z.enum(["ready", "revoked"]),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();

export type ApiAuthRecord = z.infer<typeof apiAuthRecordSchema>;

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;
const PROCESS_OWNER_NONCE = randomUUID();
const clientIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) {
    throw new StoreError("read_failed", new Error(`missing ${field}`));
  }
  return (row as Record<string, unknown>)[field];
}

function sqlInteger(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new StoreError("read_failed", new Error(`unsafe ${field}`));
}

function sqlText(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new StoreError("read_failed", new Error(`invalid ${field}`));
}

function sqlNullableText(row: unknown, field: string): string | null {
  const value = rowValue(row, field);
  return value === null ? null : sqlText(value, field);
}

function incrementAuthEpoch(value: string): string {
  const parsed = nonNegativeInt64Schema.safeParse(value);
  if (!parsed.success) throw new StoreError("auth_invalid");
  const next = BigInt(parsed.data) + 1n;
  const canonical = next.toString(10);
  if (!nonNegativeInt64Schema.safeParse(canonical).success) throw new StoreError("auth_invalid");
  return canonical;
}

export class AuthStateRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly ensureOpen: () => void,
  ) {}

  getApiCredential(accountRef: string): ApiAuthRecord | undefined {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "api-auth-account-ref");
    const row = this.database.prepare("SELECT version, provider_id, account_ref, entry_id, auth_generation, auth_epoch, state, updated_at FROM api_auth_registry WHERE account_ref = ? AND provider_id = 'openrouter'").get(parsedAccountRef);
    return row === undefined ? undefined : apiAuthRecordSchema.parse(row);
  }

  registerApiCredential(record: ApiAuthRecord): ApiAuthRecord | false {
    this.ensureOpen();
    const parsed = apiAuthRecordSchema.parse(record);
    if (parsed.state !== "ready") throw new StoreError("auth_invalid");
    const result = this.database.prepare("INSERT INTO api_auth_registry (version, provider_id, account_ref, entry_id, auth_generation, auth_epoch, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(parsed.version, parsed.provider_id, parsed.account_ref, parsed.entry_id, parsed.auth_generation, parsed.auth_epoch, parsed.state, parsed.updated_at);
    return result.changes === 1n ? parsed : false;
  }

  rotateApiCredential(accountRef: string, expectedGeneration: string, entryId: string, generation: string, authEpoch: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccount = parseContract(z.uuid(), accountRef, "api-auth-account-ref");
    const parsedExpected = parseContract(z.uuid(), expectedGeneration, "api-auth-generation");
    const parsedEntry = parseContract(z.uuid(), entryId, "api-auth-entry");
    const parsedGeneration = parseContract(z.uuid(), generation, "api-auth-generation");
    const parsedEpoch = parseContract(nonNegativeInt64Schema, authEpoch, "api-auth-epoch");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "api-auth-updated-at");
    const result = this.database.prepare("UPDATE api_auth_registry SET entry_id = ?, auth_generation = ?, auth_epoch = ?, state = 'ready', updated_at = ? WHERE provider_id = 'openrouter' AND account_ref = ? AND auth_generation = ? AND state = 'ready'").run(parsedEntry, parsedGeneration, parsedEpoch, parsedUpdated, parsedAccount, parsedExpected);
    return result.changes === 1n;
  }

  revokeApiCredential(accountRef: string, expectedGeneration: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccount = parseContract(z.uuid(), accountRef, "api-auth-account-ref");
    const parsedExpected = parseContract(z.uuid(), expectedGeneration, "api-auth-generation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "api-auth-updated-at");
    const result = this.database.prepare("UPDATE api_auth_registry SET state = 'revoked', updated_at = ? WHERE provider_id = 'openrouter' AND account_ref = ? AND auth_generation = ? AND state = 'ready'").run(parsedUpdated, parsedAccount, parsedExpected);
    return result.changes === 1n;
  }

  getAuthState(accountRef: string): AuthStateRecord | undefined {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const row = this.database
      .prepare(
        `SELECT version, account_ref, entry_id, client_id, issuer, account_id, auth_epoch, state, auth_generation,
                pending_entry_id, operation_id, retiring_entry_id, access_expires_at,
                refresh_expires_at, granted_scope, refresh_started_at, updated_at
           FROM auth_registry WHERE account_ref = ?`,
      )
      .get(parsedAccountRef);
    if (row === undefined) return undefined;
    return this.readAuthStateRow(row);
  }

  isAuthAuthorizationActive(accountRef: string, entryId: string, clientId: string, operationId: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-authorization-entry");
    const parsedClientId = parseContract(clientIdSchema, clientId, "auth-client-id");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM auth_operations
          WHERE account_ref = ? AND entry_id = ? AND client_id = ? AND issuer = ?
            AND operation_id = ? AND kind = 'authorization' AND state = 'pending'`,
      )
      .get(parsedAccountRef, parsedEntry, parsedClientId, AUTH_ISSUER, parsedOperation);
    return row !== undefined;
  }

  beginAuthAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, startedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-authorization-entry");
    const parsedClientId = parseContract(clientIdSchema, clientId, "auth-client-id");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedStarted = parseContract(z.iso.datetime({ offset: true }), startedAt, "auth-authorization-started");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current !== undefined &&
        (current.client_id !== parsedClientId || current.issuer !== AUTH_ISSUER || current.state !== "revoked" ||
          current.entry_id !== null || current.pending_entry_id !== null || current.operation_id !== null || current.retiring_entry_id !== null)
      ) {
        return false;
      }
      if (current !== undefined && !this.authCleanupReceiptsComplete(current.account_ref, current.auth_generation)) return false;
      const pending = this.database
        .prepare("SELECT 1 AS present FROM auth_operations WHERE account_ref = ? AND state = 'pending'")
        .get(parsedAccountRef);
      if (pending !== undefined) return false;
      this.insertAuthorizationOperation(parsedAccountRef, parsedEntry, parsedClientId, parsedOperation, parsedStarted);
      return true;
    });
  }

  cancelAuthAuthorization(accountRef: string, entryId: string, clientId: string, operationId: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-authorization-entry");
    const parsedClientId = parseContract(clientIdSchema, clientId, "auth-client-id");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-authorization-updated-at");
    return this.authTransaction(() => {
      const result = this.database
        .prepare(
          `UPDATE auth_operations SET state = 'cancelled', updated_at = ?
            WHERE account_ref = ? AND entry_id = ? AND client_id = ? AND issuer = ?
              AND operation_id = ? AND kind = 'authorization' AND state = 'pending'`,
        )
        .run(parsedUpdated, parsedAccountRef, parsedEntry, parsedClientId, AUTH_ISSUER, parsedOperation);
      return sqlInteger(result.changes, "auth_authorization_cancel_changes") === 1n;
    });
  }

  prepareAuthLogout(
    accountRef: string,
    entryId: string,
    clientId: string,
    newGeneration: string,
    updatedAt: string,
  ): AuthLogoutDecision {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-logout-entry");
    const parsedClientId = parseContract(clientIdSchema, clientId, "auth-client-id");
    const parsedGeneration = parseContract(z.uuid(), newGeneration, "auth-generation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-logout-updated-at");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (current === undefined) {
        const cancelled = this.database
          .prepare(
            `UPDATE auth_operations SET state = 'cancelled', updated_at = ?
              WHERE account_ref = ? AND entry_id = ? AND client_id = ? AND issuer = ?
                AND kind = 'authorization' AND state = 'pending'`,
          )
          .run(parsedUpdated, parsedAccountRef, parsedEntry, parsedClientId, AUTH_ISSUER);
        return sqlInteger(cancelled.changes, "auth_logout_cancel_changes") === 1n ? { action: "cancelled" } : { action: "none" };
      }
      if (current.client_id !== parsedClientId || current.issuer !== AUTH_ISSUER) return { action: "invalid" };
      const ownedEntries = new Set(
        [current.entry_id, current.pending_entry_id, current.retiring_entry_id].filter(
          (value): value is string => value !== null,
        ),
      );
      if (ownedEntries.size > 0 && !ownedEntries.has(parsedEntry)) return { action: "invalid" };
      if (current.state === "revoked") {
        this.database
          .prepare(
            `UPDATE auth_operations SET state = 'cancelled', updated_at = ?
              WHERE account_ref = ? AND entry_id = ? AND client_id = ? AND issuer = ?
                AND kind = 'authorization' AND state = 'pending'`,
          )
          .run(parsedUpdated, parsedAccountRef, parsedEntry, parsedClientId, AUTH_ISSUER);
        return { action: "already_revoked", auth_generation: current.auth_generation };
      }
      if (parsedGeneration === current.auth_generation) return { action: "invalid" };
      const nextEpoch = incrementAuthEpoch(current.auth_epoch);
      const updated = this.database
        .prepare(
          `UPDATE auth_registry
              SET state = 'revoked', auth_generation = ?, auth_epoch = ?, refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND client_id = ? AND auth_generation = ? AND state <> 'revoked'`,
        )
        .run(parsedGeneration, nextEpoch, parsedUpdated, parsedAccountRef, parsedClientId, current.auth_generation);
      if (sqlInteger(updated.changes, "auth_logout_revoke_changes") !== 1n) return { action: "invalid" };
      this.insertAuthCleanupEntries(current, parsedGeneration, parsedUpdated);
      return { action: "revoked", auth_generation: parsedGeneration };
    });
  }

  registerAuthProvisioning(record: AuthStateRecord): AuthStateRecord | false {
    this.ensureOpen();
    const parsed = this.parseAuthState(record);
    if (parsed.state !== "provisioning" || parsed.entry_id === null) throw new StoreError("auth_invalid");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsed.account_ref);
      if (current === undefined) {
        // The first authorization starts at epoch one. The caller's epoch is
        // deliberately ignored; the registry is the authority for it.
        const effective = { ...parsed, auth_epoch: "1" };
        if (!this.prepareAuthProvisioningOperation(effective)) return false;
        this.insertAuthState(effective);
        return effective;
      }
      if (
        current.state !== "revoked" ||
        current.entry_id !== null ||
        current.pending_entry_id !== null ||
        current.operation_id !== null ||
        current.retiring_entry_id !== null
      ) {
        return false;
      }
      const pendingOperations = this.database
        .prepare("SELECT COUNT(*) AS count FROM auth_operations WHERE account_ref = ? AND state = 'pending' AND operation_id <> ?")
        .get(parsed.account_ref, parsed.operation_id);
      if (pendingOperations === undefined || sqlInteger(rowValue(pendingOperations, "count"), "auth_pending_operations") !== 0n) {
        return false;
      }
      if (!this.authCleanupReceiptsComplete(current.account_ref, current.auth_generation)) return false;
      if (!this.sameAuthIdentity(current, parsed, { includeEpoch: false })) return false;
      const previouslyUsed = this.database
        .prepare("SELECT 1 AS present FROM auth_cleanup_entries WHERE account_ref = ? AND entry_id = ? LIMIT 1")
        .get(parsed.account_ref, parsed.entry_id);
      if (previouslyUsed !== undefined) return false;
      const effective = { ...parsed, auth_epoch: incrementAuthEpoch(current.auth_epoch) };
      if (!this.prepareAuthProvisioningOperation(effective)) return false;
      const updated = this.updateAuthState(
        effective,
        `WHERE account_ref = ? AND state = 'revoked' AND entry_id IS NULL
           AND pending_entry_id IS NULL AND operation_id IS NULL AND retiring_entry_id IS NULL
           AND auth_epoch = ?`,
        [parsed.account_ref, current.auth_epoch],
      );
      if (!updated) throw new StoreError("auth_invalid");
      return effective;
    });
  }

  completeAuthProvisioning(
    accountRef: string,
    expectedGeneration: string,
    operationId: string,
    record: AuthStateRecord,
  ): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsed = this.parseAuthState(record);
    if (parsed.state !== "ready") throw new StoreError("auth_invalid");
    if (parsed.account_ref !== parsedAccountRef || parsed.auth_generation !== parsedGeneration || parsed.operation_id !== null) {
      return false;
    }
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current === undefined ||
        current.state !== "provisioning" ||
        current.auth_generation !== parsedGeneration ||
        current.operation_id !== parsedOperation
      ) return false;
      if (!this.sameProvisioningPayload(current, parsed)) return false;
      if (!this.completeAuthOperationInTransaction(parsedAccountRef, parsedOperation, current.entry_id, parsed.updated_at)) return false;
      const result = this.database
        .prepare(
          `UPDATE auth_registry
              SET state = 'ready', operation_id = NULL, refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND state = 'provisioning' AND auth_generation = ? AND operation_id = ?`,
        )
        .run(parsed.updated_at, parsedAccountRef, parsedGeneration, parsedOperation);
      return sqlInteger(result.changes, "auth_provisioning_changes") === 1n;
    });
  }

  claimAuthRefresh(
    accountRef: string,
    expectedGeneration: string,
    operationId: string,
    pendingEntryId: string,
    startedAt: string,
  ): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedPending = parseContract(z.uuid(), pendingEntryId, "auth-pending-entry");
    const parsedStarted = parseContract(z.iso.datetime({ offset: true }), startedAt, "auth-refresh-started");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current === undefined ||
        current.state !== "ready" ||
        current.auth_generation !== parsedGeneration ||
        current.entry_id === null ||
        parsedPending === current.entry_id
      ) {
        return false;
      }
      const result = this.database
        .prepare(
          `UPDATE auth_registry
              SET state = 'refreshing', pending_entry_id = ?, operation_id = ?, refresh_started_at = ?, updated_at = ?
            WHERE account_ref = ? AND state = 'ready' AND auth_generation = ?`,
        )
        .run(parsedPending, parsedOperation, parsedStarted, parsedStarted, parsedAccountRef, parsedGeneration);
      if (sqlInteger(result.changes, "auth_claim_changes") !== 1n) return false;
      const currentEntry = current.entry_id;
      if (currentEntry === null) throw new StoreError("auth_invalid");
      this.insertAuthOperation(
        {
          version: 1,
          account_ref: current.account_ref,
          entry_id: parsedPending,
          client_id: current.client_id,
          issuer: current.issuer,
          account_id: current.account_id,
          auth_epoch: current.auth_epoch,
          state: "refreshing",
          auth_generation: current.auth_generation,
          pending_entry_id: parsedPending,
          operation_id: parsedOperation,
          retiring_entry_id: null,
          access_expires_at: current.access_expires_at,
          refresh_expires_at: current.refresh_expires_at,
          granted_scope: current.granted_scope,
          refresh_started_at: parsedStarted,
          updated_at: parsedStarted,
        },
        "refresh",
      );
      return true;
    });
  }

  promoteAuthRefresh(accountRef: string, expectedGeneration: string, operationId: string, record: AuthStateRecord): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsed = this.parseAuthState(record);
    if (parsed.state !== "cleanup_pending" || parsed.operation_id !== parsedOperation || parsed.retiring_entry_id === null) {
      throw new StoreError("auth_invalid");
    }
    if (parsed.account_ref !== parsedAccountRef || parsed.auth_generation === parsedGeneration || parsed.operation_id !== parsedOperation) {
      return false;
    }
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current === undefined ||
        current.state !== "refreshing" ||
        current.auth_generation !== parsedGeneration ||
        current.operation_id !== parsedOperation ||
        current.entry_id === null ||
        current.pending_entry_id === null
      ) {
        return false;
      }
      if (!this.isPendingAuthOperation(parsedAccountRef, parsedOperation, current.pending_entry_id)) return false;
      if (
        !this.sameAuthIdentity(current, parsed, { includeEpoch: true }) ||
        parsed.entry_id !== current.pending_entry_id ||
        parsed.pending_entry_id !== null ||
        parsed.retiring_entry_id !== current.entry_id ||
        parsed.refresh_started_at !== null ||
        parsed.operation_id !== parsedOperation
      ) {
        return false;
      }
      const result = this.database
        .prepare(
          `UPDATE auth_registry SET
              version = ?, entry_id = ?, auth_generation = ?, state = 'cleanup_pending',
              pending_entry_id = NULL, operation_id = ?, retiring_entry_id = ?,
              access_expires_at = ?, refresh_expires_at = ?, granted_scope = ?,
              refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND state = 'refreshing' AND auth_generation = ?
              AND operation_id = ? AND pending_entry_id = ?`,
        )
        .run(
          parsed.version,
          parsed.entry_id,
          parsed.auth_generation,
          parsed.operation_id,
          parsed.retiring_entry_id,
          parsed.access_expires_at,
          parsed.refresh_expires_at,
          parsed.granted_scope,
          parsed.updated_at,
          parsedAccountRef,
          parsedGeneration,
          parsedOperation,
          current.pending_entry_id,
        );
      return sqlInteger(result.changes, "auth_promotion_changes") === 1n;
    });
  }

  completeAuthCleanup(accountRef: string, expectedGeneration: string, operationId: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-updated-at");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current === undefined ||
        current.state !== "cleanup_pending" ||
        current.auth_generation !== parsedGeneration ||
        current.operation_id !== parsedOperation ||
        current.entry_id === null ||
        current.retiring_entry_id === null
      ) {
        return false;
      }
      if (!this.isCompletedAuthOperation(parsedAccountRef, parsedOperation, current.entry_id)) return false;
      const result = this.database
        .prepare(
          `UPDATE auth_registry
              SET state = 'ready', operation_id = NULL, retiring_entry_id = NULL, refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND state = 'cleanup_pending' AND auth_generation = ? AND operation_id = ?`,
        )
        .run(parsedUpdated, parsedAccountRef, parsedGeneration, parsedOperation);
      return sqlInteger(result.changes, "auth_cleanup_changes") === 1n;
    });
  }

  revokeAuthState(accountRef: string, expectedGeneration: string, clientId: string, newGeneration: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedExpectedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedClientId = parseContract(clientIdSchema, clientId, "auth-client-id");
    const parsedGeneration = parseContract(z.uuid(), newGeneration, "auth-generation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-updated-at");
    if (parsedGeneration === parsedExpectedGeneration) return false;
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (
        current === undefined ||
        current.client_id !== parsedClientId ||
        current.auth_generation !== parsedExpectedGeneration ||
        current.state === "revoked"
      ) {
        return false;
      }
      const nextEpoch = incrementAuthEpoch(current.auth_epoch);
      const result = this.database
        .prepare(
          `UPDATE auth_registry
              SET state = 'revoked', auth_generation = ?, auth_epoch = ?, refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND client_id = ? AND auth_generation = ? AND state <> 'revoked'`,
        )
        .run(parsedGeneration, nextEpoch, parsedUpdated, parsedAccountRef, parsedClientId, parsedExpectedGeneration);
      if (sqlInteger(result.changes, "auth_revoke_changes") !== 1n) return false;
      this.insertAuthCleanupEntries(current, parsedGeneration, parsedUpdated);
      return true;
    });
  }

  completeAuthRevocation(accountRef: string, expectedGeneration: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), expectedGeneration, "auth-generation");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-updated-at");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (current === undefined || current.state !== "revoked" || current.auth_generation !== parsedGeneration) return false;
      const pendingOperations = this.database
        .prepare("SELECT COUNT(*) AS count FROM auth_operations WHERE account_ref = ? AND state = 'pending'")
        .get(parsedAccountRef);
      if (
        pendingOperations === undefined ||
        sqlInteger(rowValue(pendingOperations, "count"), "auth_pending_operations") !== 0n
      ) {
        return false;
      }
      if (!this.authCleanupReceiptsComplete(parsedAccountRef, parsedGeneration)) return false;
      if (current.entry_id === null && current.pending_entry_id === null && current.operation_id === null && current.retiring_entry_id === null) {
        return true;
      }
      const result = this.database
        .prepare(
          `UPDATE auth_registry
              SET entry_id = NULL, pending_entry_id = NULL, operation_id = NULL, retiring_entry_id = NULL,
                  refresh_started_at = NULL, updated_at = ?
            WHERE account_ref = ? AND state = 'revoked' AND auth_generation = ?`,
        )
        .run(parsedUpdated, parsedAccountRef, parsedGeneration);
      return sqlInteger(result.changes, "auth_revoke_cleanup_changes") === 1n;
    });
  }

  markAuthEntryDeleted(accountRef: string, revokedGeneration: string, entryId: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedGeneration = parseContract(z.uuid(), revokedGeneration, "auth-generation");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-cleanup-entry");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-cleanup-updated-at");
    return this.authTransaction(() => {
      const current = this.readAuthStateForUpdate(parsedAccountRef);
      if (current === undefined || current.state !== "revoked" || current.auth_generation !== parsedGeneration) return false;
      const alreadyDeleted = this.database
        .prepare(
          `SELECT 1 AS present FROM auth_cleanup_entries
            WHERE account_ref = ? AND revoked_generation = ? AND entry_id = ? AND state = 'deleted'`,
        )
        .get(parsedAccountRef, parsedGeneration, parsedEntry);
      if (alreadyDeleted !== undefined) return true;
      return this.markAuthEntryDeletedInTransaction(parsedAccountRef, parsedGeneration, parsedEntry, parsedUpdated);
    });
  }

  completeAuthOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-operation-entry");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-operation-updated-at");
    return this.authTransaction(() => this.completeAuthOperationInTransaction(parsedAccountRef, parsedOperation, parsedEntry, parsedUpdated));
  }

  recoverAuthOperation(accountRef: string, operationId: string, entryId: string, updatedAt: string): boolean {
    this.ensureOpen();
    const parsedAccountRef = parseContract(z.uuid(), accountRef, "auth-account-ref");
    const parsedOperation = parseContract(z.uuid(), operationId, "auth-operation");
    const parsedEntry = parseContract(z.uuid(), entryId, "auth-operation-entry");
    const parsedUpdated = parseContract(z.iso.datetime({ offset: true }), updatedAt, "auth-operation-recovery-updated-at");
    return this.authTransaction(() => {
      const operation = this.database
        .prepare(
          `SELECT account_ref, operation_id, entry_id, state, owner_pid, owner_nonce
             FROM auth_operations WHERE account_ref = ? AND operation_id = ?`,
        )
        .get(parsedAccountRef, parsedOperation);
      if (
        operation === undefined ||
        sqlText(rowValue(operation, "entry_id"), "auth_operation_entry_id") !== parsedEntry ||
        !["pending", "completed"].includes(sqlText(rowValue(operation, "state"), "auth_operation_state"))
      ) {
        return false;
      }
      if (sqlText(rowValue(operation, "state"), "auth_operation_state") === "completed") return true;
      const ownerPid = sqlInteger(rowValue(operation, "owner_pid"), "auth_operation_owner_pid");
      const ownerNonce = sqlText(rowValue(operation, "owner_nonce"), "auth_operation_owner_nonce");
      if (!this.authOwnerTerminated(ownerPid, ownerNonce)) return false;
      return this.completeAuthOperationInTransaction(parsedAccountRef, parsedOperation, parsedEntry, parsedUpdated, true);
    });
  }

  private parseAuthState(record: unknown): AuthStateRecord {
    const parsed = authStateRecordSchema.safeParse(record);
    if (!parsed.success) throw new StoreError("auth_invalid");
    return parsed.data;
  }

  private readAuthStateRow(row: unknown): AuthStateRecord {
    return this.parseAuthState({
      version: Number(sqlInteger(rowValue(row, "version"), "auth_version")),
      account_ref: sqlText(rowValue(row, "account_ref"), "account_ref"),
      entry_id: sqlNullableText(row, "entry_id"),
      client_id: sqlText(rowValue(row, "client_id"), "client_id"),
      issuer: sqlText(rowValue(row, "issuer"), "issuer"),
      account_id: sqlText(rowValue(row, "account_id"), "account_id"),
      auth_epoch: sqlText(rowValue(row, "auth_epoch"), "auth_epoch"),
      state: sqlText(rowValue(row, "state"), "auth_state"),
      auth_generation: sqlText(rowValue(row, "auth_generation"), "auth_generation"),
      pending_entry_id: sqlNullableText(row, "pending_entry_id"),
      operation_id: sqlNullableText(row, "operation_id"),
      retiring_entry_id: sqlNullableText(row, "retiring_entry_id"),
      access_expires_at: sqlText(rowValue(row, "access_expires_at"), "access_expires_at"),
      refresh_expires_at: sqlText(rowValue(row, "refresh_expires_at"), "refresh_expires_at"),
      granted_scope: sqlText(rowValue(row, "granted_scope"), "granted_scope"),
      refresh_started_at: sqlNullableText(row, "refresh_started_at"),
      updated_at: sqlText(rowValue(row, "updated_at"), "updated_at"),
    });
  }

  private insertAuthState(record: AuthStateRecord): void {
    this.database
      .prepare(
        `INSERT INTO auth_registry (
           version, account_ref, entry_id, client_id, issuer, account_id, auth_epoch, state, auth_generation,
           pending_entry_id, operation_id, retiring_entry_id, access_expires_at,
           refresh_expires_at, granted_scope, refresh_started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.version,
        record.account_ref,
        record.entry_id,
        record.client_id,
        record.issuer,
        record.account_id,
        record.auth_epoch,
        record.state,
        record.auth_generation,
        record.pending_entry_id,
        record.operation_id,
        record.retiring_entry_id,
        record.access_expires_at,
        record.refresh_expires_at,
        record.granted_scope,
        record.refresh_started_at,
        record.updated_at,
      );
  }

  private insertAuthOperation(record: AuthStateRecord, kind: "provisioning" | "refresh"): void {
    if (record.operation_id === null || (record.entry_id === null && record.pending_entry_id === null)) {
      throw new StoreError("auth_invalid");
    }
    const entryId = kind === "provisioning" ? record.entry_id : record.pending_entry_id;
    if (entryId === null) throw new StoreError("auth_invalid");
    const timestamp = record.refresh_started_at ?? record.updated_at;
    this.database
      .prepare(
        `INSERT INTO auth_operations (
           version, operation_id, account_ref, client_id, issuer, owner_pid, owner_nonce,
           auth_generation, kind, entry_id, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        1,
        record.operation_id,
        record.account_ref,
        record.client_id,
        record.issuer,
        process.pid,
        PROCESS_OWNER_NONCE,
        record.auth_generation,
        kind,
        entryId,
        timestamp,
        record.updated_at,
      );
  }

  private insertAuthorizationOperation(
    accountRef: string,
    entryId: string,
    clientId: string,
    operationId: string,
    startedAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO auth_operations (
           version, operation_id, account_ref, client_id, issuer, owner_pid, owner_nonce,
           auth_generation, kind, entry_id, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'authorization', ?, 'pending', ?, ?)`,
      )
      .run(1, operationId, accountRef, clientId, AUTH_ISSUER, process.pid, PROCESS_OWNER_NONCE, entryId, startedAt, startedAt);
  }

  private prepareAuthProvisioningOperation(record: AuthStateRecord): boolean {
    if (record.operation_id === null || record.entry_id === null) return false;
    const existing = this.database
      .prepare(
        `SELECT account_ref, operation_id, client_id, issuer, entry_id, kind, state
           FROM auth_operations WHERE operation_id = ?`,
      )
      .get(record.operation_id);
    if (existing === undefined) {
      this.insertAuthOperation(record, "provisioning");
      return true;
    }
    if (
      sqlText(rowValue(existing, "account_ref"), "auth_operation_account_ref") !== record.account_ref ||
      sqlText(rowValue(existing, "operation_id"), "auth_operation_id") !== record.operation_id ||
      sqlText(rowValue(existing, "client_id"), "auth_operation_client_id") !== record.client_id ||
      sqlText(rowValue(existing, "issuer"), "auth_operation_issuer") !== record.issuer ||
      sqlText(rowValue(existing, "entry_id"), "auth_operation_entry_id") !== record.entry_id ||
      sqlText(rowValue(existing, "kind"), "auth_operation_kind") !== "authorization" ||
      sqlText(rowValue(existing, "state"), "auth_operation_state") !== "pending"
    ) {
      return false;
    }
    const result = this.database
      .prepare(
        `UPDATE auth_operations SET kind = 'provisioning', auth_generation = ?, owner_pid = ?, owner_nonce = ?, updated_at = ?
          WHERE operation_id = ? AND account_ref = ? AND kind = 'authorization' AND state = 'pending'`,
      )
      .run(record.auth_generation, process.pid, PROCESS_OWNER_NONCE, record.updated_at, record.operation_id, record.account_ref);
    return sqlInteger(result.changes, "auth_authorization_promote_changes") === 1n;
  }

  private insertAuthCleanupEntries(current: AuthStateRecord, revokedGeneration: string, updatedAt: string): void {
    const entryIds = new Set(
      [current.entry_id, current.pending_entry_id, current.retiring_entry_id].filter(
        (entryId): entryId is string => entryId !== null,
      ),
    );
    if (entryIds.size === 0) throw new StoreError("auth_invalid");
    const insert = this.database.prepare(
      `INSERT INTO auth_cleanup_entries (
         version, account_ref, revoked_generation, entry_id, state, created_at, updated_at
       ) VALUES (1, ?, ?, ?, 'pending', ?, ?)`,
    );
    for (const entryId of entryIds) insert.run(current.account_ref, revokedGeneration, entryId, updatedAt, updatedAt);
  }

  private markAuthEntryDeletedInTransaction(
    accountRef: string,
    revokedGeneration: string,
    entryId: string,
    updatedAt: string,
  ): boolean {
    const pendingWriter = this.database
      .prepare(
        `SELECT 1 AS present FROM auth_operations
          WHERE account_ref = ? AND entry_id = ? AND state = 'pending'`,
      )
      .get(accountRef, entryId);
    if (pendingWriter !== undefined) return false;
    const result = this.database
      .prepare(
        `UPDATE auth_cleanup_entries SET state = 'deleted', updated_at = ?
          WHERE account_ref = ? AND revoked_generation = ? AND entry_id = ?
            AND state = 'pending'`,
      )
      .run(updatedAt, accountRef, revokedGeneration, entryId);
    return sqlInteger(result.changes, "auth_cleanup_entry_changes") === 1n;
  }

  private authCleanupReceiptsComplete(accountRef: string, revokedGeneration: string): boolean {
    const cleanup = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN state = 'deleted' THEN 1 ELSE 0 END), 0) AS deleted
           FROM auth_cleanup_entries
          WHERE account_ref = ? AND revoked_generation = ?`,
      )
      .get(accountRef, revokedGeneration);
    if (cleanup === undefined) return false;
    return (
      sqlInteger(rowValue(cleanup, "total"), "auth_cleanup_total") ===
      sqlInteger(rowValue(cleanup, "deleted"), "auth_cleanup_deleted")
    );
  }

  private isPendingAuthOperation(accountRef: string, operationId: string, entryId: string | null): boolean {
    if (entryId === null) return false;
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM auth_operations
          WHERE account_ref = ? AND operation_id = ? AND entry_id = ?
            AND kind = 'refresh' AND state = 'pending'`,
      )
      .get(accountRef, operationId, entryId);
    return row !== undefined;
  }

  private isCompletedAuthOperation(accountRef: string, operationId: string, entryId: string | null): boolean {
    if (entryId === null) return false;
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM auth_operations
          WHERE account_ref = ? AND operation_id = ? AND entry_id = ? AND state = 'completed'`,
      )
      .get(accountRef, operationId, entryId);
    return row !== undefined;
  }

  private completeAuthOperationInTransaction(
    accountRef: string,
    operationId: string,
    entryId: string | null,
    updatedAt: string,
    ownerAlreadyVerified = false,
  ): boolean {
    if (entryId === null) return false;
    const current = this.readAuthStateForUpdate(accountRef);
    if (current === undefined || current.operation_id !== operationId) return false;
    const operation = this.database
      .prepare(
        `SELECT account_ref, operation_id, entry_id, state, owner_pid, owner_nonce
           FROM auth_operations WHERE account_ref = ? AND operation_id = ?`,
      )
      .get(accountRef, operationId);
    if (
      operation === undefined ||
      sqlText(rowValue(operation, "account_ref"), "auth_operation_account_ref") !== accountRef ||
      sqlText(rowValue(operation, "operation_id"), "auth_operation_id") !== operationId ||
      sqlText(rowValue(operation, "entry_id"), "auth_operation_entry_id") !== entryId ||
      !["pending", "completed"].includes(sqlText(rowValue(operation, "state"), "auth_operation_state"))
    ) {
      return false;
    }
    const ownerPid = sqlInteger(rowValue(operation, "owner_pid"), "auth_operation_owner_pid");
    const ownerNonce = sqlText(rowValue(operation, "owner_nonce"), "auth_operation_owner_nonce");
    if (!ownerAlreadyVerified && (ownerPid !== BigInt(process.pid) || ownerNonce !== PROCESS_OWNER_NONCE)) return false;
    if (sqlText(rowValue(operation, "state"), "auth_operation_state") === "completed") return true;
    const result = this.database
      .prepare(
        `UPDATE auth_operations SET state = 'completed', updated_at = ?
          WHERE account_ref = ? AND operation_id = ? AND entry_id = ? AND state = 'pending'`,
      )
      .run(updatedAt, accountRef, operationId, entryId);
    return sqlInteger(result.changes, "auth_operation_complete_changes") === 1n;
  }

  private authOwnerTerminated(ownerPid: bigint, ownerNonce: string): boolean {
    if (ownerPid <= 0n || ownerPid > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    if (ownerPid === BigInt(process.pid) && ownerNonce === PROCESS_OWNER_NONCE) return false;
    try {
      process.kill(Number(ownerPid), 0);
      return false;
    } catch (error: unknown) {
      return error instanceof Error && "code" in error && error.code === "ESRCH";
    }
  }

  private readAuthStateForUpdate(accountRef: string): AuthStateRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT version, account_ref, entry_id, client_id, issuer, account_id, auth_epoch, state, auth_generation,
                pending_entry_id, operation_id, retiring_entry_id, access_expires_at,
                refresh_expires_at, granted_scope, refresh_started_at, updated_at
           FROM auth_registry WHERE account_ref = ?`,
      )
      .get(accountRef);
    return row === undefined ? undefined : this.readAuthStateRow(row);
  }

  private sameAuthIdentity(
    current: AuthStateRecord,
    candidate: AuthStateRecord,
    options: { readonly includeEpoch: boolean } = { includeEpoch: true },
  ): boolean {
    return (
      current.version === candidate.version &&
      current.account_ref === candidate.account_ref &&
      current.client_id === candidate.client_id &&
      current.issuer === candidate.issuer &&
      current.account_id === candidate.account_id &&
      (!options.includeEpoch || current.auth_epoch === candidate.auth_epoch)
    );
  }

  private sameProvisioningPayload(current: AuthStateRecord, candidate: AuthStateRecord): boolean {
    return (
      this.sameAuthIdentity(current, candidate) &&
      current.entry_id === candidate.entry_id &&
      current.access_expires_at === candidate.access_expires_at &&
      current.refresh_expires_at === candidate.refresh_expires_at &&
      current.granted_scope === candidate.granted_scope &&
      candidate.pending_entry_id === null &&
      candidate.retiring_entry_id === null &&
      candidate.refresh_started_at === null
    );
  }

  private updateAuthState(record: AuthStateRecord, where: string, parameters: readonly SqlInputValue[]): boolean {
    const result = this.database
      .prepare(
        `UPDATE auth_registry SET
           version = ?, account_ref = ?, entry_id = ?, client_id = ?, issuer = ?, account_id = ?, auth_epoch = ?, state = ?, auth_generation = ?,
           pending_entry_id = ?, operation_id = ?, retiring_entry_id = ?, access_expires_at = ?,
           refresh_expires_at = ?, granted_scope = ?, refresh_started_at = ?, updated_at = ? ${where}`,
      )
      .run(
        record.version,
        record.account_ref,
        record.entry_id,
        record.client_id,
        record.issuer,
        record.account_id,
        record.auth_epoch,
        record.state,
        record.auth_generation,
        record.pending_entry_id,
        record.operation_id,
        record.retiring_entry_id,
        record.access_expires_at,
        record.refresh_expires_at,
        record.granted_scope,
        record.refresh_started_at,
        record.updated_at,
        ...parameters,
      );
    return sqlInteger(result.changes, "auth_update_changes") === 1n;
  }

  private authTransaction<T>(operation: () => T): T {
    this.ensureOpen();
    let committed = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = operation();
      this.database.exec("COMMIT");
      committed = true;
      return result;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the first auth transaction failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("auth_write_failed", error);
    }
  }

}
