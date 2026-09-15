import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { StoreError } from "./errors.js";
import { countManagedBackups, finishBackupRegistration, purgeManagedBackups, registerBackupIntent, snapshotBasis, type RegisteredBackupFile } from "./backup-inventory.js";
import { AuthStateRepository } from "./auth-repository.js";
import { RevisionRepository, type RevisionDetail } from "./revision-repository.js";
import { JobRepository } from "./job-repository.js";
import { AttemptRepository } from "./attempt-repository.js";
import { RuntimeArtifactRepository } from "./runtime-artifact-repository.js";
import { SummaryRepository } from "./derived-repository.js";
import { recordCommitClock, resolveWallTimeToSequence, type WallClockResolution } from "../core/time.js";
import { qualifySqliteVec, type SqliteVecQualification } from "../retrieval/vec0.js";
import { parseExtractionCandidate, type VerificationReceipt } from "../extraction/schema.js";
import { verifyExtractionCandidates } from "../extraction/verify.js";
import { executionResultDigest } from "../execution/dispatch.js";
import { parseExecutionResult, type ExecutionResult } from "../execution/types.js";
import type { SourceSpanForValidation } from "../execution/protocol.js";
import { extractionBatchResultDigest } from "../extraction/extract.js";

import {
  parseContract,
  parseCaptureAck,
  nonNegativeInt64Schema,
  evidenceClassSchema,
  readerTargetSchema,
  managedExportPathInfo,
  managedExportTargetKindSchema,
  managedExportTargetReaders,
  type ManagedExportTargetKind,
  isTrustedBinding,
  nativeObservationSchema,
  nativeReconcileCoverageSchema,
  type NativeReconcileCoverage,
  nativeReconcileCursorSchema,
  validateBoundRecallRequest,
  type CaptureAck,
  type NativeObservation,
  type NativeObservationIdentity,
  type NativeReconcileCursor,
  type TrustedBinding,
} from "../host/contract.js";
import {
  requirePreparedCapture,
  resolveTextAtPath,
  preparedCaptureContentDigest,
  rebasePreparedCaptureCapturedAt,
  validateSpanExcerpt,
  type NormalizedSourceSpan,
  type PreparedCapture,
} from "../core/capture.js";
import {
  isPolicyOutputBinding,
  isPolicySetupBinding,
  parseScopeCapturePolicy,
  parseScopeOutputGrants,
  readerOutputTarget,
  type CaptureRetention,
  type PolicyOutputBinding,
  type PolicySetupBinding,
  type ScopeCaptureSelection,
  type SourceClass,
  type ScopeOutputGrant,
} from "../core/policy.js";
const scopeRegistrationSchema = z
  .object({
    scope_id: z.uuid(),
    kind: z.enum(["project", "personal"]),
    owner_ref: z.string().min(1).max(256),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ScopeRegistration = z.infer<typeof scopeRegistrationSchema>;

// Narrow trusted-context exclusion (T05d): filters the current native
// session's own user/prompt sources out of recall candidates. The six
// positional parameters are the authenticated server binding's origin
// (host_kind, surface, execution_domain kind/id, host_instance_id,
// host_session_id) — never payload-asserted values. Scope-bound via
// s.scope_id = e.scope_id; parallel native sessions are unaffected.
const currentSessionPromptExclusion = `NOT (
  e.role = 'user'
  AND e.evidence_class = 'prompt'
  AND e.session_id IN (
    SELECT sess.session_id FROM session AS sess
    WHERE sess.scope_id = e.scope_id
      AND sess.host_kind = ?
      AND sess.surface = ?
      AND sess.execution_domain_kind = ?
      AND sess.execution_domain_id = ?
      AND sess.host_instance_id = ?
      AND sess.host_session_id = ?
  )
)`;

// Read-side compatibility only: the original envelope, spans and fingerprint
// stay untouched. Require the stored Codex identity, not just payload claims.
const legacyCodexStop = `COALESCE((
  e.observed_stage = 'stop' AND e.evidence_class = 'lifecycle' AND e.role = 'system'
  AND json_extract(e.payload_json, '$.hook_event_name') = 'Stop'
  AND json_type(e.payload_json, '$.last_assistant_message') = 'text'
  AND length(trim(json_extract(e.payload_json, '$.last_assistant_message'), char(9) || char(10) || char(13) || ' ')) > 0
  AND EXISTS (SELECT 1 FROM session AS legacy_session
    WHERE legacy_session.session_id = e.session_id AND legacy_session.scope_id = e.scope_id
      AND legacy_session.host_kind = 'codex')
), 0)`;
const recallEvidenceClass = `CASE WHEN ${legacyCodexStop} THEN 'assistant_output' ELSE e.evidence_class END`;
const recallSourceRole = `CASE WHEN ${legacyCodexStop} THEN 'assistant' ELSE e.role END`;

// Exact V1 identities in native metadata only; file contents mentioning these
// names remain evidence. Both configured and canonical server names occur.
const legacyMemoryToolNames = ["agent_memory_v1", "agent-memory-v1", "agent-memory", "agentmemory"].flatMap(server =>
  ["memory_recall", "memory_get", "memory_forget", "memory_write"].flatMap(tool => [
    ...[".", "_", ":", "/", "__"].map(separator => `${server}${separator}${tool}`),
    `mcp__${server}__${tool}`, `mcp.${server}.${tool}`,
  ]),
).map(name => `'${name}'`).join(", ");
// Each caller already joins g on the ORIGINAL class. Normalizing an old Stop
// additionally requires the assistant grant for that same scope and target.
const recallSourceEligibility = `NOT EXISTS (
  SELECT 1 FROM json_each(json_array(
    json_extract(e.payload_json, '$.tool'),
    json_extract(e.payload_json, '$.tool_name'),
    json_extract(e.payload_json, '$.native_part.tool'),
 json_extract(e.payload_json, '$.input.tool'),
 json_extract(e.payload_json, '$.toolName')
  )) AS own_tool WHERE own_tool.value IN (${legacyMemoryToolNames})
) AND (NOT ${legacyCodexStop} OR EXISTS (
  SELECT 1 FROM scope_output_grant AS assistant_grant
  WHERE assistant_grant.scope_id = e.scope_id
    AND assistant_grant.output_target = g.output_target
    AND assistant_grant.source_class = 'assistant_output'
))`;

// One effective job per source: auth replacements supersede their paused
// ancestor, whereas ordinary continuation parts remain independently required.
// A running part wins, then failed/paused/pending work; completed means every
// effective part completed. Newest row breaks ties without hiding unfinished work.
const effectiveExtractionPart = `CASE WHEN effective.task_version = 'extract-v1' THEN '0'
  ELSE substr(effective.task_version, instr(effective.task_version, ':part:') + 6) END`;
const effectiveSourceJobId = `(SELECT effective.job_id FROM job AS effective
  WHERE effective.scope_id = e.scope_id AND effective.source_capture_id = e.capture_id
    AND effective.task_kind = 'extract'
    AND NOT (effective.state = 'paused' AND effective.pause_reason = 'authorization_required'
      AND EXISTS (
        SELECT 1 FROM job AS replacement
        WHERE replacement.scope_id = effective.scope_id
          AND replacement.source_capture_id = effective.source_capture_id
          AND replacement.task_kind = 'extract'
          AND replacement.input_fingerprint = effective.input_fingerprint
          AND replacement.task_version IN (
            'extract-v1:recovery:' || effective.job_id || ':part:' || CAST(${effectiveExtractionPart} AS INTEGER),
            'extract-v1:retry:' || effective.job_id || ':part:' || (${effectiveExtractionPart})
          )
      ))
  ORDER BY CASE effective.state
    WHEN 'running' THEN 0 WHEN 'failed' THEN 1 WHEN 'paused' THEN 2
    WHEN 'pending_extraction' THEN 3 ELSE 4 END, effective.rowid DESC
  LIMIT 1)`;

const recallScopeSnapshotSchema = z
  .object({
    scope_id: z.uuid(),
    data_epoch: nonNegativeInt64Schema,
    privacy_epoch: nonNegativeInt64Schema,
  })
  .strict();

const queryTraceSchema = z
  .object({
    query_id: z.uuid(),
    injection_id: z.uuid(),
    binding_id: z.uuid(),
    packet_digest: z.string().regex(/^[a-f0-9]{64}$/i),
    scope_ids: z.array(z.uuid()).min(1).max(128),
    watermark: nonNegativeInt64Schema,
    known_at_seq: nonNegativeInt64Schema,
    scope_epochs: z.array(recallScopeSnapshotSchema).min(1).max(128),
    candidate_ids: z.array(z.uuid()).max(200),
    output_ids: z.array(z.uuid()).max(200),
    diagnostics: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(8),
    mode: z.enum(["current", "historical", "timeline", "degraded"]),
    token_unit: z.enum(["tokens", "utf8_bytes"]),
    tokens_used: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    token_budget: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    created_at: z.iso.datetime({ offset: true }),
    valid_until: z.iso.datetime({ offset: true }),
    delivery_state: z.enum(["prepared", "returned"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tokens_used > value.token_budget) {
      context.addIssue({ code: "custom", path: ["tokens_used"], message: "tokens_exceed_budget" });
    }
    if (new Set(value.scope_ids).size !== value.scope_ids.length) {
      context.addIssue({ code: "custom", path: ["scope_ids"], message: "duplicate_scope" });
    }
  });

export { StoreError };
export type { StoreErrorCode } from "./errors.js";

export const APPLICATION_ID = 0x414d454d;
export const CURRENT_SCHEMA_VERSION = 26;

export interface AgentMemoryDatabaseOptions {
  /** An initialized owner must never replace a lost journal with a new vault. */
  readonly require_existing?: boolean;
  /** Maintenance-only recovery basis, checked under the migration write lock. */
  readonly migration_basis_sha256?: string;
  /** Trusted deterministic clock injection for repository tests. */
  readonly job_clock?: () => string;
  /** Optional bounded lease for long-running explicitly owned executions. */
  readonly job_lease_ms?: number;
  /** Trusted deterministic SQLite-clock substitute for temporal repository tests. */
  readonly wall_clock?: () => string;
  /** Trusted deterministic attempt/budget clock for repository tests. */
  readonly attempt_clock?: () => string;
  /** Enables automatic local E5 projection jobs for every new capture. */
  readonly embedding_task_version?: string;
  /** Enables automatic extraction jobs for every new capture; defaults to legacy behavior. */
  readonly extraction_enabled?: boolean;
  /** Absolute path to the pinned vec0 loadable asset; qualification is fail-closed. */
  readonly vector_extension_path?: string;
}

const LEGACY_SCHEMA_VERSION = 1;
const AUTH_SCHEMA_VERSION = 2;
const SEARCH_SCHEMA_VERSION = 3;
const POLICY_SCHEMA_VERSION = 4;
const CONTEXT_SCHEMA_VERSION = 5;
const REVISION_SCHEMA_VERSION = 6;
const JOB_SCHEMA_VERSION = 7;
const TEMPORAL_SCHEMA_VERSION = 8;
const MEANING_SCHEMA_VERSION = 9;
const ATTEMPT_SCHEMA_VERSION = 10;
const VECTOR_SCHEMA_VERSION = 11;
const RUNTIME_SCHEMA_VERSION = 12;
const API_AUTH_SCHEMA_VERSION = 13;
const DERIVED_SCHEMA_VERSION = 14;
const EXTRACTION_SCHEMA_VERSION = 15;
const GRAPH_SCHEMA_VERSION = 16;
const PROCEDURE_SCHEMA_VERSION = 17;
const EXPORTS_SCHEMA_VERSION = 18;
const OPENCODE_SCHEMA_VERSION = 19;
// Migration 021 remains reserved; its unknown schema is not supported.
// The format migration currently accepts the known schema 20 only.
const MANAGED_EXPORT_FORMAT_SCHEMA_VERSION = 22;
const BACKUP_SCHEMA_VERSION = 24;
const TRANSFER_POLICY_SCHEMA_VERSION = 25;
const CAPTURE_POLICY_SCHEMA_VERSION = 26;
/** Bounded embedded outbox: backoff 1/5/30 s, at most five attempts. */
const EXPORT_OUTBOX_MAX_ATTEMPTS = 5;
/** Only verifiable refresh contract until a host-specific hot-unload test exists. */
export const MANAGED_EXPORT_REFRESH_CONTRACT = "controlled_host_restart";
const INITIAL_SEARCH_GENERATION = 1n;
const VECTOR_DIMENSIONS = 384;
const VECTOR_BLOB_BYTES = 1_536;
const VECTOR_PROFILE_ID = "e5-multilingual-small-q8-761b726dd34fb83930e26aab4e9ac3899aa1fa78";
const VECTOR_MAX_RESULTS = 200;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const LOCAL_UI_MAX_RESULTS = 100;
const LOCAL_UI_MAX_QUERY_BYTES = 4_096;
const LOCAL_UI_MAX_QUERY_TOKENS = 64;
const LOCAL_UI_MAX_TOKEN_LENGTH = 128;
const LOCAL_UI_MAX_MATCH_BYTES = 2_048;
const REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
  "search_document",
  "search_fts",
  "scope_policy",
  "scope_output_grant",
  "capture_replay_marker",
  "purge_operation",
  "purge_tombstone",
  "query_trace",
  "entity",
  "memory_item",
  "memory_revision",
  "revision_source",
  "semantic_slot",
  "semantic_slot_member",
  "revision_operation",
] as const;
const TEMPORAL_REQUIRED_TABLES = [
  ...REQUIRED_TABLES,
  "temporal_intent",
  "state_segment",
  "commit_clock_meta",
  "commit_clock",
] as const;
const ATTEMPT_REQUIRED_TABLES = [
  ...TEMPORAL_REQUIRED_TABLES,
  "execution_batch",
  "budget_reservation",
  "budget_reservation_period",
  "execution_attempt",
 ] as const;
const VECTOR_REQUIRED_TABLES = [
  ...TEMPORAL_REQUIRED_TABLES,
  "vector_chunk",
  "vector_embedding",
  "vector_generation",
] as const;
const RUNTIME_REQUIRED_TABLES = [...ATTEMPT_REQUIRED_TABLES, "runtime_artifact"] as const;
const API_AUTH_REQUIRED_TABLES = [...RUNTIME_REQUIRED_TABLES, "api_auth_registry"] as const;
const DERIVED_REQUIRED_TABLES = [...API_AUTH_REQUIRED_TABLES, "derived_artifact", "dependency"] as const;
const EXTRACTION_REQUIRED_TABLES = [
  ...DERIVED_REQUIRED_TABLES,
  "extraction_batch",
  "extraction_batch_source",
  "extraction_candidate",
  "extraction_verdict",
] as const;
const GRAPH_REQUIRED_TABLES = [
  ...EXTRACTION_REQUIRED_TABLES,
  "entity",
  "semantic_edge",
] as const;
const PROCEDURE_REQUIRED_TABLES = [
  ...GRAPH_REQUIRED_TABLES,
  "procedure_activation",
] as const;
const EXPORTS_REQUIRED_TABLES = [...PROCEDURE_REQUIRED_TABLES, "managed_export"] as const;
const OPENCODE_REQUIRED_TABLES = [
  ...EXPORTS_REQUIRED_TABLES,
  "opencode_observation_receipt",
  "opencode_observation_head",
  "opencode_reconcile_scan",
  "opencode_identity_tombstone",
] as const;
const CAPTURE_POLICY_REQUIRED_TABLES = [
  ...OPENCODE_REQUIRED_TABLES,
  "scope_capture_policy",
  "capture_acceptance",
] as const;
const SEARCH_REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
  "search_document",
  "search_fts",
] as const;
const POLICY_REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
  "search_document",
  "search_fts",
  "scope_policy",
  "scope_output_grant",
  "capture_replay_marker",
  "purge_operation",
  "purge_tombstone",
] as const;
const CONTEXT_REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
  "search_document",
  "search_fts",
  "scope_policy",
  "scope_output_grant",
  "capture_replay_marker",
  "purge_operation",
  "purge_tombstone",
  "query_trace",
] as const;
const REVISION_REQUIRED_TABLES = [
  ...CONTEXT_REQUIRED_TABLES,
  "entity",
  "memory_item",
  "memory_revision",
  "revision_source",
  "semantic_slot",
  "semantic_slot_member",
  "revision_operation",
] as const;
const AUTH_REQUIRED_TABLES = [
  "schema_meta",
  "vault_counter",
  "scope",
  "session",
  "source_event",
  "source_span",
  "job",
  "auth_registry",
  "auth_operations",
  "auth_cleanup_entries",
] as const;
const LEGACY_REQUIRED_TABLES = ["schema_meta", "vault_counter", "scope", "session", "source_event", "source_span", "job"] as const;
const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
const PRE_JOB_REQUIRED_COLUMNS = [
  "job_id",
  "scope_id",
  "source_capture_id",
  "task_kind",
  "task_version",
  "state",
  "dedupe_key",
  "attempts",
  "next_at",
  "owner",
  "lease_until",
  "fence",
  "created_commit_seq",
] as const;
const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  schema_meta: ["key", "value"],
  vault_counter: ["id", "commit_seq", "data_epoch"],
  scope: ["scope_id", "kind", "owner_ref", "data_epoch", "privacy_epoch", "created_at"],
  session: ["session_id", "scope_id", "host_kind", "surface", "execution_domain_kind", "execution_domain_id", "host_instance_id", "host_session_id", "started_at", "ended_at", "coverage"],
  source_event: ["capture_id", "scope_id", "session_id", "fingerprint", "adapter_version", "observed_stage", "role", "evidence_class", "captured_at", "occurred_at", "payload_json", "event_json", "truncation_json", "redaction_json", "coverage_json", "commit_seq", "data_epoch"],
  source_span: ["span_id", "source_id", "scope_id", "path", "start_utf16", "end_utf16", "digest"],
  job: [
    "job_id",
    "scope_id",
    "source_capture_id",
    "task_kind",
    "task_version",
    "state",
    "dedupe_key",
    "attempts",
    "next_at",
    "owner",
    "lease_until",
    "fence",
    "created_commit_seq",
    "input_fingerprint",
    "input_privacy_epoch",
    "pause_reason",
    "completion_receipt_json",
  ],
  auth_registry: ["version", "account_ref", "entry_id", "client_id", "issuer", "account_id", "auth_epoch", "state", "auth_generation", "pending_entry_id", "operation_id", "retiring_entry_id", "access_expires_at", "refresh_expires_at", "granted_scope", "refresh_started_at", "updated_at"],
  auth_operations: ["version", "operation_id", "account_ref", "client_id", "issuer", "owner_pid", "owner_nonce", "auth_generation", "kind", "entry_id", "state", "created_at", "updated_at"],
  auth_cleanup_entries: ["version", "account_ref", "revoked_generation", "entry_id", "state", "created_at", "updated_at"],
  api_auth_registry: ["version", "provider_id", "account_ref", "entry_id", "auth_generation", "auth_epoch", "state", "updated_at"],
  search_document: [
    "span_id",
    "source_id",
    "scope_id",
    "root",
    "path",
    "start_utf16",
    "end_utf16",
    "digest",
    "text",
    "representation",
    "eligible",
    "generation",
  ],
  scope_policy: ["scope_id", "capture_paused", "updated_at"],
  scope_capture_policy: ["scope_id", "source_class", "retention_mode", "retention_seconds", "selected_at"],
  scope_output_grant: ["scope_id", "output_target", "source_class", "created_at"],
  capture_replay_marker: ["capture_id", "scope_id", "reason", "rejected_at"],
  capture_acceptance: ["capture_id", "scope_id", "accepted_at", "retention_seconds"],
  purge_operation: ["operation_id", "scope_id", "expected_privacy_epoch", "state", "selected_count", "requested_at", "updated_at"],
  purge_tombstone: ["capture_id", "scope_id", "operation_id", "created_at"],
  query_trace: [
    "query_id",
    "injection_id",
    "binding_id",
    "packet_digest",
    "scope_ids_json",
    "watermark",
    "known_at_seq",
    "scope_epochs_json",
    "candidate_ids_json",
    "output_ids_json",
    "diagnostics_json",
    "mode",
    "token_unit",
    "tokens_used",
    "token_budget",
    "created_at",
    "valid_until",
    "delivery_state",
  ],
  entity: ["scope_id", "entity_id", "resolution_state", "canonical_key", "label", "created_commit_seq"],
  memory_item: [
    "scope_id",
    "item_id",
    "kind",
    "entity_id",
    "predicate",
    "qualifiers_json",
    "qualifiers_digest",
    "cardinality",
    "status",
    "current_revision_id",
    "created_commit_seq",
  ],
  memory_revision: [
    "scope_id",
    "revision_id",
    "item_id",
    "parent_revision_id",
    "operation",
    "content_json",
    "content_digest",
    "actor_binding_id",
    "actor_host_kind",
    "actor_surface",
    "actor_execution_domain_kind",
    "actor_execution_domain_id",
    "actor_host_instance_id",
    "actor_host_session_id",
    "meaning_json",
    "meaning_digest",
    "created_commit_seq",
  ],
  revision_source: ["scope_id", "revision_id", "source_capture_id", "source_span_id"],
  semantic_slot: [
    "scope_id",
    "entity_id",
    "predicate",
    "qualifiers_json",
    "qualifiers_digest",
    "cardinality",
    "generation",
    "created_commit_seq",
  ],
  semantic_slot_member: ["scope_id", "entity_id", "predicate", "qualifiers_digest", "member_digest", "item_id", "revision_id"],
  semantic_edge: [
    "scope_id",
    "edge_id",
    "source_entity",
    "target_entity",
    "predicate",
    "qualifiers_json",
    "evidence_revision",
    "valid_from",
    "valid_to",
    "tx_from_seq",
    "tx_to_seq",
    "status",
    "created_commit_seq",
  ],
  procedure_activation: [
    "scope_id",
    "procedure_item_id",
    "status",
    "policy_version",
    "conditions_json",
    "validated_revision",
    "active_revision",
    "created_at",
    "updated_at",
  ],
  revision_operation: [
    "operation_id",
    "scope_id",
    "request_digest",
    "status",
    "result_item_id",
    "result_revision_id",
    "result_slot_generation",
    "result_code",
    "result_item_status",
    "resolver_disposition",
    "resolver_reason",
    "created_commit_seq",
  ],
  managed_export: [
    "scope_id",
    "export_id",
    "procedure_item_id",
    "procedure_revision_id",
    "binding_id",
    "output_target",
    "target_kind",
    "root",
    "path",
    "expected_owner_hash",
    "root_dev",
    "root_ino",
    "parent_dev",
    "parent_ino",
    "staging_path",
    "staging_hash",
    "purge_operation_id",
    "desired_state",
    "state",
    "observed_state",
    "observed_hash",
    "privacy_epoch",
    "host_refresh_state",
    "outbox_state",
    "outbox_attempts",
    "outbox_next_at",
    "outbox_owner",
    "outbox_lease_until",
    "outbox_fence",
    "outbox_last_error",
    "created_at",
    "updated_at",
  ],
  opencode_observation_receipt: [
    "scope_id",
    "binding_id",
    "native_session_id",
    "identity_kind",
    "identity_key",
    "message_id",
    "part_id",
    "generation",
    "capture_id",
    "content_digest",
    "first_observed_at",
    "occurred_at",
    "commit_seq",
    "state",
  ],
  opencode_observation_head: [
    "scope_id",
    "binding_id",
    "native_session_id",
    "message_id",
    "part_id",
    "generation",
    "current_capture_id",
    "current_digest",
    "first_observed_at",
    "last_observed_at",
    "last_commit_seq",
    "last_scan_id",
    "state",
  ],
  opencode_reconcile_scan: [
    "scan_id",
    "scope_id",
    "binding_id",
    "native_session_id",
    "watermark",
    "cursor_json",
    "state",
    "coverage_json",
    "created_at",
    "updated_at",
  ],
  opencode_identity_tombstone: [
    "scope_id",
    "binding_id",
    "native_session_id",
    "identity_kind",
    "identity_key",
    "message_id",
    "part_id",
    "operation_id",
    "created_at",
  ],
  temporal_intent: ["scope_id", "revision_id", "intent_json", "intent_digest"],
  state_segment: [
    "scope_id",
    "segment_id",
    "item_id",
    "value_revision_id",
    "change_revision_id",
    "status",
    "valid_from",
    "valid_to",
    "valid_from_precision",
    "valid_to_precision",
    "valid_timezone",
    "valid_from_timezone",
    "valid_to_timezone",
    "valid_from_original",
    "valid_to_original",
    "tx_from_seq",
    "tx_to_seq",
  ],
  commit_clock_meta: ["id", "history_start_seq", "history_start_wall_time"],
  commit_clock: ["commit_seq", "recorded_wall_time"],
  execution_batch: [
    "batch_id",
    "job_id",
    "scope_id",
    "source_capture_id",
    "task_version",
    "input_fingerprint",
    "input_privacy_epoch",
    "request_digest",
    "binding_id",
    "profile_hash",
    "profile_id",
    "runtime_id",
    "model_id",
    "reasoning",
    "provider_id",
    "provider_target",
    "account_ref",
    "auth_epoch",
    "auth_generation",
    "auth_entry_id",
    "job_owner",
    "job_fence",
    "job_lease_until",
    "state",
    "extract_starts",
    "verify_starts",
    "total_starts",
    "active_ms",
    "failure_reason",
    "created_at",
    "updated_at",
  ],
  budget_reservation: [
    "reservation_id",
    "batch_id",
    "phase",
    "period_day",
    "period_month",
    "budget_key",
    "daily_start_limit",
    "monthly_start_limit",
    "daily_active_ms_limit",
    "monthly_active_ms_limit",
    "daily_usage_limits_json",
    "monthly_usage_limits_json",
    "usage_reservation_json",
    "reserved_input_tokens",
    "reserved_output_tokens",
    "reserved_provider_requests",
    "reserved_credits",
    "consumed_input_tokens",
    "consumed_output_tokens",
    "consumed_provider_requests",
    "consumed_credits",
    "reserved_starts",
    "consumed_starts",
    "reserved_active_ms",
    "consumed_active_ms",
    "state",
    "created_at",
    "updated_at",
  ],
  budget_reservation_period: [
    "period_id",
    "reservation_id",
    "budget_key",
    "period_day",
    "period_month",
    "reserved_starts",
    "consumed_starts",
    "reserved_active_ms",
    "consumed_active_ms",
    "reserved_input_tokens",
    "reserved_output_tokens",
    "reserved_provider_requests",
    "reserved_credits",
    "consumed_input_tokens",
    "consumed_output_tokens",
    "consumed_provider_requests",
    "consumed_credits",
    "state",
    "created_at",
    "updated_at",
  ],
  execution_attempt: [
    "attempt_id",
    "batch_id",
    "job_id",
    "phase",
    "ordinal",
    "request_digest",
    "input_fingerprint",
    "input_privacy_epoch",
    "binding_id",
    "profile_hash",
    "profile_id",
    "runtime_id",
    "model_id",
    "reasoning",
    "provider_id",
    "account_ref",
    "auth_epoch",
    "auth_generation",
    "auth_entry_id",
    "owner",
    "job_fence",
    "lease_until",
    "reservation_id",
    "accounting_period_day",
    "accounting_period_month",
    "deadline_at",
    "state",
    "runtime_session_id",
    "provider_attempt_id",
    "terminal_status",
    "result_digest",
    "result_receipt_json",
    "usage_status",
    "usage_json",
    "usage_complete_json",
    "cleanup_state",
    "cleanup_reason",
    "budget_violation",
    "started_at",
    "terminal_at",
    "cleanup_at",
    "active_ms",
    "created_at",
    "updated_at",
  ],
  vector_chunk: [
    "chunk_id",
    "scope_id",
    "source_id",
    "span_id",
    "revision_id",
    "chunk_index",
    "text",
    "input_digest",
    "profile_id",
    "tokenizer_version",
    "chunker_version",
    "generation",
    "eligible",
    "created_commit_seq",
  ],
  vector_embedding: [
    "chunk_id",
    "scope_id",
    "profile_id",
    "dim",
    "dtype",
    "vector_blob",
    "source_digest",
    "generation",
  ],
  vector_generation: ["id", "active_generation", "updated_at"],
  extraction_batch: [
    "batch_id", "job_id", "scope_id", "source_capture_id", "task_version",
    "input_fingerprint", "input_privacy_epoch", "source_token_count", "source_measurement_unit",
    "continuation_json", "target_json", "state", "extraction_digest",
    "verification_digest", "completion_receipt_json",
    "extract_attempt_id", "extract_result_digest", "verify_attempt_id", "verify_result_digest",
    "created_at", "updated_at",
  ],
  extraction_batch_source: [
    "batch_id", "ordinal", "scope_id", "capture_id", "span_id", "source_digest",
    "role", "evidence_class", "captured_at", "occurred_at", "text",
  ],
  extraction_candidate: ["batch_id", "candidate_id", "candidate_digest", "candidate_json", "state", "created_at"],
  extraction_verdict: [
    "batch_id", "candidate_id", "candidate_digest", "entailment", "attribution",
    "modality", "negation", "time", "receipt_digest", "created_at",
  ],
  runtime_artifact: [
    "artifact_id",
    "attempt_id",
    "batch_id",
    "job_id",
    "scope_id",
    "source_capture_id",
    "profile_id",
    "account_ref",
    "kind",
    "trusted_root",
    "trusted_root_identity_json",
    "relative_path",
    "native_session_id",
    "ownership_evidence_json",
    "state",
    "cleanup_evidence_json",
    "cleanup_owner",
    "cleanup_lease_until",
    "cleanup_fence",
    "execution_close_state",
    "execution_closed_at",
    "created_at",
    "updated_at",
  ],
};

const PRE_MEANING_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  ...REQUIRED_COLUMNS,
  memory_revision: REQUIRED_COLUMNS.memory_revision!.filter((column) => column !== "meaning_json" && column !== "meaning_digest"),
  revision_operation: REQUIRED_COLUMNS.revision_operation!.filter(
    (column) => column !== "result_item_status" && column !== "resolver_disposition" && column !== "resolver_reason",
  ),
};

const extractionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
/** Extraction task versions include immutable recovery/retry jobs with a source-part marker. */
const extractionTaskVersionSchema = z.string().regex(/^extract-v1(?::part:[0-9]{1,3}|:(?:recovery|retry):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:part:[0-9]{1,3})?$/u).refine((value) => {
  const match = /:part:([0-9]{1,3})$/u.exec(value);
  if (match === null) return true;
  const part = Number(match[1]);
  return Number.isSafeInteger(part) && part >= 0 && part <= 255;
}, { message: "extraction_task_version_invalid" });

export interface StoredSource {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly commit_seq: string;
  readonly data_epoch: string;
  readonly fingerprint: string;
  readonly captured_at: string;
  readonly payload_json: string;
  readonly event_json: string;
  readonly coverage_json: string;
}

export interface StoredScopeCapturePolicy {
  readonly source_class: SourceClass;
  readonly retention: CaptureRetention;
  readonly selected_at: string;
}

export interface ScopeCapturePolicyState {
  readonly enrolled: boolean;
  readonly selections: readonly StoredScopeCapturePolicy[];
}

export interface DueCapture {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly source_class: SourceClass;
  readonly accepted_at: string;
  readonly expires_at: string;
}

/** Raw, explicitly selected rows handed to the transfer serializer. */
export interface TransferSnapshot {
  readonly schema_version: number;
  readonly scopes: readonly Record<string, unknown>[];
  readonly sources: readonly Record<string, unknown>[];
  readonly spans: readonly Record<string, unknown>[];
  readonly entities: readonly Record<string, unknown>[];
  readonly items: readonly Record<string, unknown>[];
  readonly revisions: readonly Record<string, unknown>[];
  readonly revisionSources: readonly Record<string, unknown>[];
  readonly derived: readonly Record<string, unknown>[];
  readonly dependencies: readonly Record<string, unknown>[];
}

export interface TransferImportSource {
  readonly capture_id: string;
  readonly original_scope_id: string;
  readonly target_scope_id: string;
  readonly fingerprint: string;
  readonly adapter_version: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly original_stage: string;
  readonly original_role: string;
  readonly original_evidence_class: string;
  readonly original_origin_json: string;
  readonly original_event_json: string;
  readonly revision_claims_json: string;
  readonly payload_json: string;
  readonly event_json: string;
  readonly truncation_json: string;
  readonly redaction_json: string;
  readonly coverage_json: string;
  readonly spans: readonly {
    readonly span_id: string;
    readonly source_id: string;
    readonly scope_id: string;
    readonly root: "payload" | "event";
    readonly path: string;
    readonly start_utf16: number;
    readonly end_utf16: number;
    readonly digest: string;
  }[];
}

export interface TransferImportPlan {
  readonly export_id: string;
  readonly records_sha256: string;
  readonly source_bytes_sha256: string;
  readonly scopes: readonly { readonly scope_id: string; readonly kind: "project" | "personal" }[];
  readonly scope_map: readonly { readonly original_scope_id: string; readonly target_scope_id: string }[];
  readonly sources: readonly TransferImportSource[];
  readonly entities: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly entity_id: string;
    readonly label: string;
  }[];
  readonly items: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly item_id: string;
    readonly kind: string;
    readonly entity_id: string | null;
    readonly predicate: string;
    readonly qualifiers_json: string;
    readonly qualifiers_digest: string;
    readonly cardinality: string;
    readonly claimed_status: string;
    readonly current_revision_id: string | null;
    readonly created_commit_seq: string;
  }[];
  readonly revisions: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly revision_id: string;
    readonly item_id: string;
    readonly parent_revision_id: string | null;
    readonly operation: string;
    readonly content_json: string;
    readonly content_digest: string;
    readonly meaning_json: string | null;
    readonly claimed_actor_json: string;
    readonly created_commit_seq: string;
  }[];
  readonly revisionSources: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly revision_id: string;
    readonly source_capture_id: string;
    readonly source_span_id: string;
  }[];
  readonly derived: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly artifact_id: string;
    readonly revision_id: string;
    readonly kind: string;
    readonly content_json: string;
    readonly content_digest: string;
    readonly temporal_domain_json: string;
    readonly claimed_status: string;
    readonly created_commit_seq: string;
  }[];
  readonly dependencies: readonly {
    readonly original_scope_id: string;
    readonly target_scope_id: string;
    readonly child_type: string;
    readonly child_revision_id: string;
    readonly parent_type: string;
    readonly parent_revision_id: string;
    readonly relation: string;
    readonly created_commit_seq: string;
  }[];
}

export interface TransferImportDbResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly downgraded: number;
  readonly dependency_count: number;
  readonly no_op: boolean;
  readonly conflicts: readonly string[];
}

export interface StoredJob {
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly state: string;
  readonly dedupe_key: string;
  readonly next_at: string | null;
}

export interface UiJobRow {
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_kind: "extract" | "embed";
  readonly state: "pending_extraction" | "running" | "completed" | "failed" | "paused";
  readonly attempts: number;
  readonly created_commit_seq: string;
  readonly next_at: string | null;
  readonly pause_reason: string | null;
}

export interface UiJobStateCount {
  readonly state: UiJobRow["state"];
  readonly count: number;
}

export interface UiGraphSourceRow {
  readonly capture_id: string;
  readonly scope_id: string;
  readonly session_id: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly evidence_class: "prompt" | "assistant_output" | "tool_input" | "tool_output" | "lifecycle" | "diagnostic";
  readonly observed_stage: string;
  readonly commit_seq: string;
}

export interface UiGraphSessionRow {
  readonly session_id: string;
  readonly scope_id: string;
  readonly host_kind: string;
  readonly surface: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly coverage: string;
}

export interface UiPrivacyGrant {
  readonly output_target: string;
  readonly source_class: "prompt" | "assistant_output" | "tool_input" | "tool_output" | "lifecycle" | "diagnostic";
  readonly created_at: string;
}

export interface UiPurgeRecord {
  readonly operation_id: string;
  readonly state: "barrier" | "content_deleted" | "completed";
  readonly selected_count: number;
  readonly requested_at: string;
  readonly updated_at: string;
}

export interface UiPrivacySnapshot {
  readonly capture_paused: boolean;
  readonly grants: readonly UiPrivacyGrant[];
  readonly purges: readonly UiPurgeRecord[];
}

export interface UiSavingsSnapshot {
  readonly source_count: number;
  readonly stored_chars: number;
  readonly evidence_chars: number;
  readonly span_count: number;
}


export interface SourceSpanRow {
  readonly span_id: string;
  readonly root: "payload" | "event";
  readonly path: string;
  readonly start_utf16: bigint;
  readonly end_utf16: bigint;
  readonly digest: string;
}

/** Exact source evidence accepted by an execution request after DB binding. */
export interface ExecutionSourceReference {
  readonly source_span_id: string;
  readonly capture_id: string;
  readonly scope_id: string;
  readonly role: string;
  readonly evidence_class?: string | undefined;
  readonly captured_at?: string | undefined;
  readonly occurred_at?: string | undefined;
  readonly text: string;
}

export interface ExtractionBatchRecord {
  readonly batch_id: string;
  readonly job_id: string;
  readonly scope_id: string;
  readonly source_capture_id: string;
  readonly task_version: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly source_token_count: number;
  readonly source_measurement_unit: "tokens" | "utf8_bytes";
  readonly state: "prepared" | "extracted" | "verified" | "completed" | "failed";
  readonly extraction_digest: string | null;
  readonly verification_digest: string | null;
  readonly completion_receipt_json: string | null;
  readonly extract_attempt_id: string | null;
  readonly extract_result_digest: string | null;
  readonly verify_attempt_id: string | null;
  readonly verify_result_digest: string | null;
}

export interface RecallScopeSnapshot {
  readonly scope_id: string;
  readonly data_epoch: string;
  readonly privacy_epoch: string;
}

export interface RecallSnapshot {
  readonly watermark: string;
  readonly data_epoch: string;
  readonly privacy_epoch: string;
  readonly scopes: readonly RecallScopeSnapshot[];
}

export interface LocalUiScopeSnapshot {
  readonly scope_id: string;
  readonly watermark: string;
  readonly data_epoch: string;
  readonly global_data_epoch: string;
  readonly privacy_epoch: string;
  readonly capture_paused: boolean;
}

export interface OutputSourceListOptions {
  readonly limit: number;
  readonly watermark?: string;
  readonly cursor?: string;
  readonly agent?: string;
  readonly session_id?: string;
}

export interface OutputSourceSearchOptions extends OutputSourceListOptions {
  readonly query: string;
}

export type OutputSourceGroup = RecallSourceGroup & { readonly lexical_rank?: number };

export interface OutputSourcePage {
  readonly watermark: string;
  readonly groups: readonly OutputSourceGroup[];
  readonly next_cursor?: string;
}

export interface RecallSpanRow extends SourceSpanRow {
  readonly quote: string;
}

export interface RecallSourceGroup extends StoredSource {
  readonly revision_id: string;
  readonly evidence_class: SourceClass;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly occurred_at: string | null;
  readonly job_state: string | null;
  readonly host_kind?: string;
  readonly session_id?: string;
  readonly project_label?: string;
  readonly spans: readonly RecallSpanRow[];
}

export interface QueryTraceRecord {
  readonly query_id: string;
  readonly injection_id: string;
  readonly binding_id: string;
  readonly packet_digest: string;
  readonly scope_ids: readonly string[];
  readonly watermark: string;
  readonly known_at_seq: string;
  readonly scope_epochs: readonly RecallScopeSnapshot[];
  readonly candidate_ids: readonly string[];
  readonly output_ids: readonly string[];
  readonly diagnostics: readonly string[];
  readonly mode: "current" | "historical" | "timeline" | "degraded";
  readonly token_unit: "tokens" | "utf8_bytes";
  readonly tokens_used: number;
  readonly token_budget: number;
  readonly created_at: string;
  readonly valid_until: string;
  readonly delivery_state: "prepared" | "returned";
}

export interface SearchCandidateRow {
  readonly rowid: bigint;
  readonly rank: number;
  readonly document_span_id: string;
  readonly document_source_id: string;
  readonly document_scope_id: string;
  readonly document_root: "payload" | "event";
  readonly document_path: string;
  readonly document_start_utf16: bigint;
  readonly document_end_utf16: bigint;
  readonly document_digest: string;
  readonly document_text: string;
  readonly document_representation: string;
  readonly document_eligible: bigint;
  readonly document_generation: bigint;
  readonly source_span_id: string | null;
  readonly source_scope_id: string | null;
  readonly source_root: "payload" | "event" | null;
  readonly source_path: string | null;
  readonly source_start_utf16: bigint | null;
  readonly source_end_utf16: bigint | null;
  readonly source_digest: string | null;
  readonly source_id: string;
  readonly source_scope: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly payload_json: string;
  readonly event_json: string;
  readonly commit_seq: bigint;
  readonly data_epoch: bigint;
}

/** Bounded, source-only structural neighbor lookup. No relation is causal. */
export interface SourceGraphNeighborQuery {
  readonly scope_ids: readonly string[];
  readonly source_ids: readonly string[];
  readonly known_at_seq: string;
  readonly excluded_capture_id?: string;
  readonly exclude_current_session_prompts?: boolean;
  readonly limit: number;
}

export interface SourceGraphNeighbor {
  readonly from_id: string;
  readonly source_id: string;
  readonly scope_id: string;
  readonly kind: string;
}

export type SourceGraphNeighborRows = SourceGraphNeighbor[] & { readonly truncated: boolean };

export interface VectorChunkSibling {
  readonly chunk_id: string;
  readonly chunk_index: bigint;
  readonly text: string;
}

export interface VectorCandidateRow {
  readonly chunk_id: string;
  readonly chunk_scope_id: string;
  readonly chunk_source_id: string;
  readonly chunk_revision_id: string | null;
  readonly chunk_index: bigint;
  readonly chunk_text: string;
  readonly chunk_input_digest: string;
  readonly chunk_profile_id: string;
  readonly chunk_tokenizer_version: string;
  readonly chunk_generation: bigint;
  readonly chunk_eligible: bigint;
  readonly chunk_created_commit_seq: bigint;
  readonly chunk_chunker_version: string;
  readonly chunk_siblings: readonly VectorChunkSibling[];
  readonly chunk_root: "payload" | "event";
  readonly chunk_path: string;
  readonly chunk_start_utf16: bigint;
  readonly chunk_end_utf16: bigint;
  readonly chunk_digest: string;
  readonly embedding_blob: Uint8Array;
  readonly embedding_dim: bigint;
  readonly document_span_id: string;
  readonly document_source_id: string;
  readonly source_span_id: string | null;
  readonly source_scope_id: string | null;
  readonly source_root: "payload" | "event" | null;
  readonly source_path: string | null;
  readonly source_start_utf16: bigint | null;
  readonly source_end_utf16: bigint | null;
  readonly source_digest: string | null;
  readonly source_id: string;
  readonly source_scope: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly payload_json: string;
  readonly event_json: string;
  readonly commit_seq: bigint;
  readonly data_epoch: bigint;
  readonly distance: number;
}

export interface VectorSearchStoreOptions {
  readonly limit: number;
  readonly excluded_capture_id?: string | undefined;
  readonly generation?: string | undefined;
  readonly profile_id?: string | undefined;
  readonly exclude_current_session_prompts?: boolean | undefined;
  readonly chunker_version?: string | undefined;
}

export interface VectorIndexStartupStatus {
  readonly generation: string;
  readonly task_version: string;
  readonly enqueued_jobs: number;
  readonly pending_jobs: number;
  readonly running_jobs: number;
  readonly failed_jobs: number;
  readonly completed_jobs: number;
  readonly missing_sources: number;
  readonly state: "ready" | "pending" | "failed";
}

export interface VectorChunkProjection {
  readonly chunk_id: string;
  readonly scope_id: string;
  readonly source_id: string;
  readonly span_id: string;
  readonly revision_id?: string;
  readonly chunk_index: number;
  readonly text: string;
  readonly input_digest: string;
  readonly profile_id: string;
  readonly tokenizer_version: string;
  readonly chunker_version: string;
  readonly generation: string;
  readonly vector: Float32Array;
  readonly source_digest: string;
  /** Original span identity for chunked projections. */
  readonly source_span_digest?: string;
  readonly start_utf16?: number;
  readonly end_utf16?: number;
}

export interface EmbedJobRequest {
  readonly task_version: string;
}

export interface NativeObservationReceipt {
  readonly capture_id: string;
  readonly commit_seq: string;
  readonly generation: string;
  readonly first_observed_at: string;
  readonly replayed: boolean;
}

export interface NativeReconcileScan {
  readonly coverage: NativeReconcileCoverage;
  readonly scan_id: string;
  readonly scope_id: string;
  readonly binding_id: string;
  readonly native_session_id: string;
  readonly watermark: string;
  readonly cursor: NativeReconcileCursor | null;
  readonly state: "active" | "completed" | "invalidated";
}

export interface NativeCaptureMetadata extends NativeObservation {
  readonly binding_id: string;
}

export interface VectorProjectionSourceSpan {
  readonly span_id: string;
  readonly root: "payload" | "event";
  readonly path: string;
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly digest: string;
  readonly text: string;
  readonly revision_ids: readonly string[];
}

export interface VectorProjectionSource {
  readonly scope_id: string;
  readonly source_id: string;
  readonly input_fingerprint: string;
  readonly input_privacy_epoch: string;
  readonly commit_seq: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly spans: readonly VectorProjectionSourceSpan[];
}

export function vectorProjectionReceiptDigest(projections: readonly VectorChunkProjection[]): string {
  const hash = createHash("sha256");
  for (const projection of projections) {
    hash.update(JSON.stringify({
      chunk_id: projection.chunk_id,
      scope_id: projection.scope_id,
      source_id: projection.source_id,
      span_id: projection.span_id,
      revision_id: projection.revision_id ?? null,
      chunk_index: projection.chunk_index,
      text: projection.text,
      input_digest: projection.input_digest,
      profile_id: projection.profile_id,
      tokenizer_version: projection.tokenizer_version,
      chunker_version: projection.chunker_version,
      generation: projection.generation,
      source_digest: projection.source_digest,
      source_span_digest: projection.source_span_digest ?? null,
      start_utf16: projection.start_utf16 ?? null,
      end_utf16: projection.end_utf16 ?? null,
      vector: projection.vector instanceof Float32Array
        ? Buffer.from(projection.vector.buffer, projection.vector.byteOffset, projection.vector.byteLength).toString("base64")
        : null,
    }), "utf8");
    hash.update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

export interface PurgeExecutionRequest {
  readonly operation_id: string;
  readonly scope_id: string;
  readonly capture_ids: readonly string[];
  readonly expected_privacy_epoch: string;
  readonly requested_at: string;
  /** T21 asks the same source purge transaction to remove all local dependents. */
  readonly full?: boolean | undefined;
  /** Keep the durable operation resumable while an external reset is pending. */
  readonly defer_completion?: boolean | undefined;
}

export interface PurgeExecutionResult {
  readonly operation_id: string;
  readonly scope_id: string;
  readonly state: "completed" | "pending";
  readonly privacy_epoch: string;
  readonly selected_count: number;
  /** Complete covers this SQLite/FTS database and WAL; it is not an SSD or external snapshot claim. */
  readonly physical_cleanup: "complete" | "pending";
}

export interface PurgeInventory {
  readonly scope_id: string;
  readonly capture_ids: readonly string[];
  readonly source_count: number;
  readonly span_count: number;
  readonly revision_count: number;
  readonly item_count: number;
  readonly derived_count: number;
  readonly dependency_count: number;
  readonly vector_chunk_count: number;
  readonly vector_embedding_count: number;
  readonly graph_edge_count: number;
  readonly extraction_batch_count: number;
  readonly runtime_artifact_count: number;
  readonly query_trace_count: number;
  readonly managed_export_count: number;
  readonly managed_backup_count: number;
  readonly managed_export_states: readonly { readonly state: string; readonly count: number }[];
}

export interface PhysicalMaintenanceResult {
  readonly secure_delete: "complete" | "pending";
  readonly fts_secure_delete: "complete" | "pending";
  readonly wal_checkpoint: "complete" | "pending";
  readonly vacuum: "complete" | "pending" | "not_requested";
}

export interface DatabaseCounts {
  readonly scope_count: bigint;
  readonly session_count: bigint;
  readonly source_count: bigint;
  readonly span_count: bigint;
  readonly job_count: bigint;
}

export interface CaptureState {
  readonly commit_seq: string;
  readonly data_epoch: string;
  readonly source_count: bigint;
  readonly span_count: bigint;
  readonly job_count: bigint;
}

export interface DatabasePragmas {
  readonly foreign_keys: bigint;
  readonly journal_mode: string;
  readonly synchronous: bigint;
}

function readSchemaSql(): string {
  try {
    return `${readFileSync(new URL("./schema.sql", import.meta.url), "utf8")}\n${readSearchSql()}\n${readRevisionSql()}\n${readTemporalSql()}\n${readAttemptsSql()}\n${readVectorsSql()}\n${readRuntimeArtifactsSql()}\n${readDerivedSql()}\n${readExtractionSql()}\n${readGraphSql()}\n${readProcedureSql()}\n${readExportsSql()}\n${readOpenCodeSql()}`;
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readExportsSql(): string {
  try {
    return readFileSync(new URL("./exports.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readExportsMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/018-managed-exports.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readOpenCodeSql(): string {
  try {
    return readFileSync(new URL("./opencode.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readOpenCodeMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/019-opencode-observation.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readManagedExportFormatMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/022-managed-export-formats.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readCapturePolicyMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/026-capture-policy.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readProcedureSql(): string {
  try {
    return readFileSync(new URL("./procedures.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readProcedureMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/017-procedure-activation.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readDerivedSql(): string {
  try {
    return readFileSync(new URL("./derived.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readDerivedMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/014-summary-dependencies.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readExtractionSql(): string {
  try {
    return readFileSync(new URL("./extraction.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readExtractionMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/015-extraction-attempt-binding.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readGraphSql(): string {
  try {
    return readFileSync(new URL("./graph.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readGraphMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/016-graph-edges.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readAuthMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/002-auth.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readSearchMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/003-search.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readSearchSql(): string {
  try {
    return readFileSync(new URL("./search.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readPolicyMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/004-policy.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readContextMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/005-context.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readRevisionSql(): string {
  try {
    return readFileSync(new URL("./revisions.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readRevisionMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/006-revisions.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readJobMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/007-jobs.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readTemporalSql(): string {
  try {
    return readFileSync(new URL("./segments.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readTemporalMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/008-temporal.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readMeaningMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/009-meaning.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readAttemptsSql(): string {
  try {
    return readFileSync(new URL("./attempts.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readVectorsSql(): string {
  try {
    return readFileSync(new URL("./vectors.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readRuntimeArtifactsSql(): string {
  try {
    return readFileSync(new URL("./runtime-artifacts.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readRuntimeArtifactsMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/012-runtime-artifacts.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readApiAuthMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/013-api-auth.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readAttemptsMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/010-attempts.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function readVectorMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/011-vectors.sql", import.meta.url), "utf8");
  } catch (error: unknown) {
    throw new StoreError("schema_unavailable", error);
  }
}

function unlinkOwnedVaultFiles(filePath: string): void {
  if (filePath === ":memory:") return;
  for (const path of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      unlinkSync(path);
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}

function prepareVaultFile(filePath: string, requireExisting = false): boolean {
  if (filePath === ":memory:") return true;
  const parent = dirname(filePath);
  try {
    if (!statSync(parent).isDirectory()) throw new StoreError("vault_parent_missing");
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("vault_parent_missing", error);
  }
  if (existsSync(filePath)) return false;
  if (requireExisting) throw new StoreError("restore_quarantined");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600);
    chmodSync(filePath, 0o600);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
      try {
        unlinkSync(filePath);
      } catch {
        // Preserve the creation or permission failure.
      }
    }
    throw new StoreError("schema_unavailable", error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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

function assertNoSymlinkAncestors(path: string): void {
  let current = "/";
  for (const component of resolve(path).split("/").filter(Boolean)) {
    current = resolve(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new StoreError("revision_invalid");
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new StoreError("revision_invalid", error);
    }
  }
}

function canonicalExportRoot(input: string): string {
  const lexical = resolve(input);
  let current = lexical;
  const suffix: string[] = [];
  for (;;) {
    try {
      const canonical = resolve(realpathSync(current), ...suffix);
      const systemAlias = (lexical.startsWith("/var/") || lexical === "/var" || lexical.startsWith("/tmp/") || lexical === "/tmp") && canonical === `/private${lexical}`;
      if (canonical !== lexical && !systemAlias) throw new StoreError("revision_invalid");
      return canonical;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw new StoreError("revision_invalid");
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  return (error as { readonly errcode?: unknown }).errcode === 2067;
}

function sqlNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new StoreError("read_failed", new Error(`invalid ${field}`));
}

function nullableSqlText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return sqlText(value, field);
}

function nullableSqlInteger(value: unknown, field: string): bigint | null {
  if (value === null) return null;
  return sqlInteger(value, field);
}

function readPragmaInteger(database: DatabaseSync, name: string): bigint {
  const row = database.prepare(`PRAGMA ${name}`).get();
  return sqlInteger(rowValue(row, name), name);
}

function assertExistingVaultIdentity(database: DatabaseSync): number {
  if (readPragmaInteger(database, "application_id") !== BigInt(APPLICATION_ID)) {
    throw new StoreError("vault_identity_mismatch");
  }
  const version = readPragmaInteger(database, "user_version");
  if (
    version !== BigInt(LEGACY_SCHEMA_VERSION) &&
    version !== BigInt(AUTH_SCHEMA_VERSION) &&
    version !== BigInt(SEARCH_SCHEMA_VERSION) &&
    version !== BigInt(POLICY_SCHEMA_VERSION) &&
    version !== BigInt(CONTEXT_SCHEMA_VERSION) &&
    version !== BigInt(REVISION_SCHEMA_VERSION) &&
    version !== BigInt(JOB_SCHEMA_VERSION) &&
    version !== BigInt(TEMPORAL_SCHEMA_VERSION) &&
    version !== BigInt(MEANING_SCHEMA_VERSION) &&
    version !== BigInt(ATTEMPT_SCHEMA_VERSION) &&
    version !== BigInt(VECTOR_SCHEMA_VERSION) &&
    version !== BigInt(RUNTIME_SCHEMA_VERSION) &&
    version !== BigInt(API_AUTH_SCHEMA_VERSION) &&
    version !== BigInt(DERIVED_SCHEMA_VERSION) &&
    version !== BigInt(EXTRACTION_SCHEMA_VERSION) &&
    version !== BigInt(GRAPH_SCHEMA_VERSION) &&
    version !== BigInt(PROCEDURE_SCHEMA_VERSION) &&
    version !== BigInt(EXPORTS_SCHEMA_VERSION) &&
    version !== BigInt(OPENCODE_SCHEMA_VERSION) &&
    version !== 20n &&
    version !== BigInt(MANAGED_EXPORT_FORMAT_SCHEMA_VERSION) &&
    version !== BigInt(BACKUP_SCHEMA_VERSION) &&
    version !== BigInt(TRANSFER_POLICY_SCHEMA_VERSION) &&
    version !== BigInt(CURRENT_SCHEMA_VERSION)
  ) {
    throw new StoreError("schema_version_mismatch");
  }
  const requiredTables =
    version === BigInt(LEGACY_SCHEMA_VERSION)
      ? LEGACY_REQUIRED_TABLES
      : version === BigInt(AUTH_SCHEMA_VERSION)
        ? AUTH_REQUIRED_TABLES
      : version === BigInt(SEARCH_SCHEMA_VERSION)
        ? SEARCH_REQUIRED_TABLES
        : version === BigInt(POLICY_SCHEMA_VERSION)
          ? POLICY_REQUIRED_TABLES
            : version === BigInt(CONTEXT_SCHEMA_VERSION)
              ? CONTEXT_REQUIRED_TABLES
              : version === BigInt(REVISION_SCHEMA_VERSION)
                ? REVISION_REQUIRED_TABLES
                : version === BigInt(JOB_SCHEMA_VERSION)
                  ? REQUIRED_TABLES
                  : version === BigInt(TEMPORAL_SCHEMA_VERSION) || version === BigInt(MEANING_SCHEMA_VERSION)
                    ? TEMPORAL_REQUIRED_TABLES
                    : version === BigInt(ATTEMPT_SCHEMA_VERSION)
                      ? ATTEMPT_REQUIRED_TABLES
                      : version === BigInt(VECTOR_SCHEMA_VERSION)
                        ? VECTOR_REQUIRED_TABLES
                      : version === BigInt(RUNTIME_SCHEMA_VERSION)
                        ? RUNTIME_REQUIRED_TABLES
                        : version === BigInt(API_AUTH_SCHEMA_VERSION)
                          ? API_AUTH_REQUIRED_TABLES
                          : version === BigInt(DERIVED_SCHEMA_VERSION)
                            ? DERIVED_REQUIRED_TABLES
                            : version === BigInt(EXTRACTION_SCHEMA_VERSION)
                              ? EXTRACTION_REQUIRED_TABLES
                              : version === BigInt(GRAPH_SCHEMA_VERSION)
                                ? GRAPH_REQUIRED_TABLES
                                : version === BigInt(PROCEDURE_SCHEMA_VERSION)
                                  ? PROCEDURE_REQUIRED_TABLES
                                  : version === BigInt(EXPORTS_SCHEMA_VERSION)
                                    ? EXPORTS_REQUIRED_TABLES
                                    : version < BigInt(CAPTURE_POLICY_SCHEMA_VERSION)
                                      ? OPENCODE_REQUIRED_TABLES
                                      : CAPTURE_POLICY_REQUIRED_TABLES;
  const requiredColumnMap = version < BigInt(MEANING_SCHEMA_VERSION) ? PRE_MEANING_REQUIRED_COLUMNS : REQUIRED_COLUMNS;
  for (const table of requiredTables) {
    const row = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (row === undefined) throw new StoreError("schema_invalid");
    const columns = database.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(columns.map((column) => rowValue(column, "name")));
    const requiredColumns = table === "job" && version < BigInt(JOB_SCHEMA_VERSION) ? PRE_JOB_REQUIRED_COLUMNS : requiredColumnMap[table];
    if (requiredColumns?.some((column) => !names.has(column))) throw new StoreError("schema_invalid");
    if (version >= 20n && table === "purge_operation" && ["runtime_reset_state", "runtime_reset_owner", "cleanup_batch_ids_json"].some((column) => !names.has(column))) throw new StoreError("schema_invalid");
    if (version >= BigInt(CAPTURE_POLICY_SCHEMA_VERSION) && table === "scope_policy" && !names.has("capture_policy_enrolled")) throw new StoreError("schema_invalid");
    if (version >= BigInt(CAPTURE_POLICY_SCHEMA_VERSION) && table === "capture_replay_marker" && ["native_binding_id", "native_session_id", "native_identity_kind", "native_identity_key"].some((column) => !names.has(column))) throw new StoreError("schema_invalid");
    if (version >= BigInt(SEARCH_SCHEMA_VERSION) && table === "source_span" && !names.has("root")) {
      throw new StoreError("schema_invalid");
    }
  }
  const meta = database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
  if (meta === undefined || rowValue(meta, "value") !== version.toString()) {
    throw new StoreError("schema_version_mismatch");
  }
  if (version >= 25n) {
    const policy = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scope_output_grant'").get();
    if (policy === undefined || !sqlText(rowValue(policy, "sql"), "transfer-policy-schema").includes("output_target = 'export:jsonl'")) throw new StoreError("schema_invalid");
  }
  const counter = database.prepare("SELECT id, commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
  if (counter === undefined || sqlInteger(rowValue(counter, "commit_seq"), "commit_seq") < 0n || sqlInteger(rowValue(counter, "data_epoch"), "data_epoch") < 0n) {
    throw new StoreError("schema_invalid");
  }
  return Number(version);
}

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) {
    throw new StoreError("read_failed", new Error(`missing ${field}`));
  }
  return (row as Record<string, unknown>)[field];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Finite retention must fit both JavaScript Date and the persisted ISO timestamp contract. */
function captureExpiryAt(acceptedAt: string, durationSeconds: bigint): string {
  const acceptedMilliseconds = Date.parse(acceptedAt);
  if (!Number.isFinite(acceptedMilliseconds) || durationSeconds < 1n) throw new StoreError("policy_invalid");
  const expiresMilliseconds = BigInt(acceptedMilliseconds) + durationSeconds * 1_000n;
  if (expiresMilliseconds > 8_640_000_000_000_000n) throw new StoreError("policy_invalid");
  const expiresAt = new Date(Number(expiresMilliseconds)).toISOString();
  if (!z.iso.datetime({ offset: true }).safeParse(expiresAt).success) throw new StoreError("policy_invalid");
  return expiresAt;
}

function nativeObservationKey(identity: NativeObservationIdentity): string {
  return identity.kind === "event"
    ? identity.key
    : `${identity.session_id}\u0000${identity.message_id}\u0000${identity.part_id}`;
}

function nativeEventIdentityKey(stage: string, sessionId: string, ids: Readonly<Record<string, string | undefined>>): string {
  const meaningful = Object.entries(ids)
    .filter(([name, value]) => name !== "session_id" && value !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (meaningful.length === 0) throw new StoreError("native_observation_conflict");
  return sha256(`opencode:event:v1\u0000${sessionId}\u0000${stage}\u0000${meaningful.map(([name, value]) => `${name}=${value}`).join("\u0000")}`);
}

function sourceSpanRoot(value: unknown, field: string): "payload" | "event" {
  const root = sqlText(value, field);
  if (root !== "payload" && root !== "event") throw new StoreError("schema_invalid");
  return root;
}

function nullableSourceSpanRoot(value: unknown, field: string): "payload" | "event" | null {
  if (value === null) return null;
  return sourceSpanRoot(value, field);
}

function safeSpanOffset(value: unknown, field: string): number {
  const offset = sqlInteger(value, field);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreError("schema_invalid");
  return Number(offset);
}

function jsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new StoreError("schema_invalid", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StoreError("schema_invalid", new Error(`invalid ${field}`));
  }
  return parsed as Record<string, unknown>;
}

function uuidFromDigest(value: string): string {
  const bytes = Buffer.from(value.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function automaticEventSpan(
  fingerprint: string,
  eventText: string | undefined,
  callerSpans: readonly NormalizedSourceSpan[],
): NormalizedSourceSpan | undefined {
  if (eventText === undefined || eventText.length === 0) return undefined;
  const eventDigest = sha256(eventText);
  const existing = callerSpans.some(
    (span) =>
      span.root === "event" &&
      span.path === "/text" &&
      span.start_utf16 === 0 &&
      span.end_utf16 === eventText.length &&
      span.digest === eventDigest,
  );
  if (existing) return undefined;
  return {
    span_id: uuidFromDigest(sha256(`agent-memory:event-text\u0000${fingerprint}\u0000${eventDigest}`)),
    root: "event",
    path: "/text",
    start_utf16: 0,
    end_utf16: eventText.length,
    digest: eventDigest,
  };
}

function nextPrivacyEpoch(current: bigint): bigint {
  if (current < 0n || current >= MAX_INT64) throw new StoreError("purge_pending");
  return current + 1n;
}

function requirePolicySetup(binding: PolicySetupBinding, scopeId: string, errorCode: "policy_invalid" | "purge_scope_not_allowed"): void {
  if (!isPolicySetupBinding(binding)) throw new StoreError("policy_invalid");
  if (!binding.allowed_scope_ids.includes(scopeId)) throw new StoreError(errorCode);
}

function requireLocalUiOutput(binding: PolicyOutputBinding): PolicyOutputBinding {
  if (!isPolicyOutputBinding(binding) || binding.target !== "local_ui") throw new StoreError("output_not_allowed");
  if (!z.uuid().safeParse(binding.scope_id).success) throw new StoreError("output_not_allowed");
  return binding;
}

function parseJobColumn<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const parsed = sqlText(value, field);
  if (!(allowed as readonly string[]).includes(parsed)) throw new StoreError("schema_invalid");
  return parsed as T;
}


function localUiLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LOCAL_UI_MAX_RESULTS) throw new StoreError("read_failed");
  return limit;
}

function localUiMatch(query: string): string | undefined {
  if (typeof query !== "string" || Buffer.byteLength(query, "utf8") > LOCAL_UI_MAX_QUERY_BYTES) {
    throw new StoreError("read_failed");
  }
  const comparable = query.toLocaleLowerCase("und");
  const tokens = comparable.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const uniqueTokens = [...new Set(tokens)];
  if (uniqueTokens.length === 0) return undefined;
  if (uniqueTokens.length > LOCAL_UI_MAX_QUERY_TOKENS || uniqueTokens.some((token) => token.length > LOCAL_UI_MAX_TOKEN_LENGTH)) {
    throw new StoreError("read_failed");
  }
  const match = uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
  if (Buffer.byteLength(match, "utf8") > LOCAL_UI_MAX_MATCH_BYTES) throw new StoreError("read_failed");
  return match;
}

const outputCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["timeline", "lexical"]),
    scope_id: z.uuid(),
    query_digest: z.string().regex(/^[a-f0-9]{64}$/i),
    watermark: nonNegativeInt64Schema,
    data_epoch: nonNegativeInt64Schema,
    global_data_epoch: nonNegativeInt64Schema,
    privacy_epoch: nonNegativeInt64Schema,
    commit_seq: nonNegativeInt64Schema,
    capture_id: z.uuid(),
    lexical_rank: z.number().finite().optional(),
  })
  .strict();

type OutputCursor = z.infer<typeof outputCursorSchema>;

function encodeOutputCursor(cursor: OutputCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function staleOutputCursor(): StoreError {
  return new StoreError("read_failed", new Error("cursor_stale"));
}

function decodeOutputCursor(
  value: string | undefined,
  kind: OutputCursor["kind"],
  scopeId: string,
  queryDigest: string,
  watermark: string,
  dataEpoch: string,
  globalDataEpoch: string,
  privacyEpoch: string,
): OutputCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length < 8 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new StoreError("read_failed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new StoreError("read_failed");
  }
  const cursor = outputCursorSchema.safeParse(parsed);
  if (
    !cursor.success ||
    cursor.data.kind !== kind ||
    cursor.data.scope_id !== scopeId ||
    cursor.data.query_digest !== queryDigest ||
    cursor.data.watermark !== watermark ||
    cursor.data.data_epoch !== dataEpoch ||
    cursor.data.global_data_epoch !== globalDataEpoch ||
    cursor.data.privacy_epoch !== privacyEpoch
  ) {
    throw staleOutputCursor();
  }
  return cursor.data;
}

function policyTargetAllowed(binding: PolicySetupBinding, target: string): void {
  if (!binding.allowed_output_targets.includes(target as PolicySetupBinding["allowed_output_targets"][number])) {
    throw new StoreError("output_not_allowed");
  }
}

function transferCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoreError("transfer_invalid");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(transferCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${transferCanonicalJson(record[key])}`).join(",")}}`;
  }
  throw new StoreError("transfer_invalid");
}

function transferJsonEqual(left: string, right: string, stripTransferProvenance = false): boolean {
  try {
    const parse = (value: string): unknown => {
      const parsed = JSON.parse(value) as unknown;
      if (!stripTransferProvenance || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
      const copy = { ...(parsed as Record<string, unknown>) };
      delete copy.transfer_provenance;
      return copy;
    };
    return transferCanonicalJson(parse(left)) === transferCanonicalJson(parse(right));
  } catch {
    return false;
  }
}

function transferJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StoreError("transfer_invalid", new Error(field));
  return parsed as Record<string, unknown>;
}

function importedEventJson(source: TransferImportSource, exportId: string, binding: TrustedBinding): string {
  const event = transferJsonObject(source.event_json, "transfer-event");
  delete event.provenance;
  delete event.outcome;
  delete event.transfer_provenance;
  event.stage = "message_part";
  event.role = "assistant";
  event.evidence_class = "assistant_output";
  event.native_ids = {};
  event.transfer_provenance = {
    version: 1,
    export_id: exportId,
    original_scope_id: source.original_scope_id,
    original_capture_id: source.capture_id,
    original_stage: source.original_stage,
    original_role: source.original_role,
    original_evidence_class: source.original_evidence_class,
    original_origin: JSON.parse(source.original_origin_json) as unknown,
    original_event: JSON.parse(source.original_event_json) as unknown,
    imported_by: {
      binding_id: binding.binding_id,
      host_kind: binding.host_kind,
      surface: binding.surface,
      execution_domain_kind: binding.execution_domain.kind,
      execution_domain_id: binding.execution_domain.id,
      host_instance_id: binding.host_instance_id,
      host_session_id: binding.host_session_id,
    },
    revision_claims: JSON.parse(source.revision_claims_json) as unknown,
  };
  return transferCanonicalJson(event);
}

function recallScopeIds(scopeIds: readonly string[], binding: TrustedBinding): string[] {
  if (!Array.isArray(scopeIds) || scopeIds.length < 1 || scopeIds.length > 128) {
    throw new StoreError("scope_not_allowed");
  }
  const unique = [...new Set(scopeIds)];
  if (unique.length !== scopeIds.length || unique.some((scopeId) => !z.uuid().safeParse(scopeId).success)) {
    throw new StoreError("scope_not_allowed");
  }
  validateBoundRecallRequest(
    { query: "context snapshot", scope_ids: unique, mode: "current", token_budget: 1 },
    binding,
  );
  try {
    readerOutputTarget(binding);
  } catch (error: unknown) {
    throw new StoreError("output_not_allowed", error);
  }
  return unique;
}

function nullableSqlTextOrNull(value: unknown, field: string): string | null {
  return value === null ? null : sqlText(value, field);
}

function recallRole(value: unknown): RecallSourceGroup["role"] {
  const role = sqlText(value, "source_role");
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") {
    throw new StoreError("schema_invalid");
  }
  return role;
}

function recallSourceClass(value: unknown): SourceClass {
  return parseContract(evidenceClassSchema, value, "source-class");
}

/**
 * T17 graph expansion query contract (plan §9 step 4). All fields are
 * validated at the store boundary; scope ids must be bound by the trusted
 * reader binding and `valid_at` must be the normalized ISO-8601 UTC form
 * (…Z) so lexicographic comparison against the edge validity bounds is
 * chronological. `cursor` resumes a previously exhausted expansion budget.
 */
export interface GraphExpansionQuery {
  readonly scope_ids: readonly string[];
  readonly start_entity_ids: readonly string[];
  readonly valid_at?: string;
  readonly known_at_seq?: string;
  readonly limit: number;
  readonly cursor?: {
    readonly hop: number;
    readonly scope_id: string;
    readonly edge_id: string;
  };
}

/** One evidenced relation reached by expansion, with its best evidence passage. */
export interface GraphEdgeCandidateRow {
  readonly scope_id: string;
  readonly edge_id: string;
  readonly hop: number;
  /** Deterministic, start-anchored edge path proving this candidate's dependencies. */
  readonly path_edge_ids: readonly string[];
  readonly source_entity: string;
  readonly target_entity: string;
  readonly predicate: string;
  readonly qualifiers_json: string;
  readonly evidence_revision: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly tx_from_seq: string;
  readonly tx_to_seq: string | null;
  readonly evidence_source_id: string;
  readonly evidence_span_id: string;
  readonly evidence_text: string;
  readonly captured_at: string;
  readonly occurred_at: string | null;
  readonly commit_seq: string;
  readonly data_epoch: string;
}

export interface GraphExpansionRelations {
  readonly edges: readonly GraphEdgeCandidateRow[];
  /** True when qualifying evidence existed beyond the candidate budget. */
  readonly has_more: boolean;
  /** Resumes the expansion after the last scanned edge when `has_more`. */
  readonly next_cursor?: {
    readonly hop: number;
    readonly scope_id: string;
    readonly edge_id: string;
  };
}

export interface GraphStartEntityQuery {
  readonly scope_ids: readonly string[];
  readonly revision_ids?: readonly string[];
  readonly capture_ids?: readonly string[];
}

export interface GraphStartEntityRow {
  readonly scope_id: string;
  readonly entity_id: string;
}

const graphExpansionQuerySchema = z
  .object({
    scope_ids: z.array(z.uuid()).min(1).max(128),
    start_entity_ids: z.array(z.uuid()).max(200),
    valid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).optional(),
    known_at_seq: z.string().regex(/^[0-9]{1,20}$/).optional(),
    limit: z.number().int().min(1).max(200),
    cursor: z
      .object({
        hop: z.number().int().min(1).max(2),
        scope_id: z.uuid(),
        edge_id: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();

const graphStartEntityQuerySchema = z
  .object({
    scope_ids: z.array(z.uuid()).min(1).max(128),
    revision_ids: z.array(z.uuid()).max(200).optional(),
    capture_ids: z.array(z.uuid()).max(200).optional(),
  })
  .strict()
  .refine(
    (value) => (value.revision_ids?.length ?? 0) > 0 || (value.capture_ids?.length ?? 0) > 0,
    { message: "start_revision_or_capture_required" },
  );

const sourceGraphNeighborQuerySchema = z
  .object({
    scope_ids: z.array(z.uuid()).min(1).max(128),
    source_ids: z.array(z.uuid()).max(32),
    known_at_seq: nonNegativeInt64Schema,
    excluded_capture_id: z.uuid().optional(),
    exclude_current_session_prompts: z.boolean().optional(),
    limit: z.number().int().min(1).max(128),
  })
  .strict();

const SOURCE_GRAPH_QUERY_ROW_LIMIT = 128;

function sourceGraphPathSql(alias: "e" | "s"): string {
  return `COALESCE(
    json_extract(${alias}.payload_json, '$.file_path'),
    json_extract(${alias}.payload_json, '$.filePath'),
    json_extract(${alias}.payload_json, '$.path'),
    json_extract(${alias}.payload_json, '$.tool_input.file_path'),
    json_extract(${alias}.payload_json, '$.tool_input.filePath'),
    json_extract(${alias}.payload_json, '$.tool_input.path'),
    json_extract(${alias}.payload_json, '$.input.file_path'),
    json_extract(${alias}.payload_json, '$.input.path'),
    json_extract(${alias}.payload_json, '$.arguments.file_path'),
    json_extract(${alias}.payload_json, '$.arguments.path'),
    json_extract(${alias}.event_json, '$.file_path'),
    json_extract(${alias}.event_json, '$.filePath'),
    json_extract(${alias}.event_json, '$.path')
  )`;
}

/** Plan §9 step 4: the first graph expansion is two hops, never deeper. */
const GRAPH_MAX_HOPS = 2 as const;

function parseGraphPath(value: unknown): string[] {
  const encoded = sqlText(value, "path_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch (error: unknown) {
    throw new StoreError("schema_invalid", error);
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > GRAPH_MAX_HOPS) {
    throw new StoreError("schema_invalid");
  }
  return parsed.map((edgeId, index) => parseContract(z.uuid(), edgeId, `graph-path-edge-${index}`));
}

const PURGE_DELETE_TRIGGERS = [
  "revision_operation_append_only_delete",
  "memory_revision_append_only_delete",
  "revision_source_append_only_delete",
  "temporal_intent_append_only_delete",
  "state_segment_append_only_delete",
  "commit_clock_append_only_delete",
  "commit_clock_meta_immutable_delete",
  "dependency_append_only_delete",
] as const;

interface PurgeTargets {
  readonly source_span_ids: readonly string[];
  readonly memory_revision_ids: readonly string[];
  readonly memory_item_ids: readonly string[];
  readonly entity_ids: readonly string[];
  readonly derived_revision_ids: readonly string[];
  readonly semantic_edge_ids: readonly string[];
  readonly extraction_batch_ids: readonly string[];
  readonly managed_export_ids: readonly string[];
}


export class AgentMemoryDatabase {
  private readonly database!: DatabaseSync;
  readonly auth!: AuthStateRepository;
  readonly revisions!: RevisionRepository;
  readonly jobs!: JobRepository;
  readonly attempts!: AttemptRepository;
  readonly runtimeArtifacts!: RuntimeArtifactRepository;
  readonly summaries!: SummaryRepository;
  private closed = false;
  private readonly wallClock: (() => string) | undefined;
  private readonly extractionEnabled: boolean;
  private readonly embeddingTaskVersion: string | undefined;
  readonly vectorQualification: SqliteVecQualification | undefined;

  constructor(filePath: string, options: AgentMemoryDatabaseOptions = {}) {
    if (filePath === ":memory:") throw new StoreError("volatile_store_rejected");
    const extractionEnabled = options.extraction_enabled === undefined
      ? true
      : parseContract(z.boolean(), options.extraction_enabled, "extraction-enabled");
    const schemaSql = readSchemaSql();
    const createdFile = prepareVaultFile(filePath, options.require_existing);
    const databaseUri = pathToFileURL(filePath);
    let opened: DatabaseSync | undefined;
    let probe: DatabaseSync | undefined;
    let existingVersion: number | undefined;
    try {
      if (!createdFile) {
        databaseUri.search = "?mode=ro";
        probe = new DatabaseSync(databaseUri.href, {
          enableForeignKeyConstraints: true,
          readOnly: true,
          readBigInts: true,
          defensive: true,
        });
        existingVersion = assertExistingVaultIdentity(probe);
        const restoreState = probe.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get();
        if (restoreState !== undefined && restoreState.value !== "ready") throw new StoreError("restore_quarantined");
        probe.close();
        probe = undefined;
      }
      // prepareVaultFile owns creation; neither SQLite open may recreate a lost file.
      databaseUri.search = "?mode=rw";
      const database = new DatabaseSync(databaseUri.href, {
        enableForeignKeyConstraints: true,
        timeout: 1_000,
        readBigInts: true,
        defensive: true,
        allowExtension: options.vector_extension_path !== undefined,
      });
      opened = database;
      this.database = database;
      this.wallClock = options.wall_clock;
      this.extractionEnabled = extractionEnabled;
      this.embeddingTaskVersion = options.embedding_task_version === undefined
        ? undefined
        : parseContract(z.string().min(1).max(128), options.embedding_task_version, "embedding-task-version");
      this.vectorQualification = undefined;
      this.summaries = new SummaryRepository(database, () => this.ensureOpen());
      this.auth = new AuthStateRepository(database, () => this.ensureOpen());
      this.revisions = new RevisionRepository(
        database,
        () => this.ensureOpen(),
        options.wall_clock,
        this.embeddingTaskVersion === undefined
          ? undefined
          : (scopeId, revisionId, captureId) => this.ensureRevisionEmbedJobLocked(scopeId, revisionId, captureId),
        (scopeId, revisionId, commitSeq, replacedRevisionId) => {
          // Plan §5 invariant 6 and §7: invalidation of every dependent of the
          // replaced revision happens inside the same canonical transaction.
          if (replacedRevisionId !== null) {
            this.summaries.invalidateForRevisionLocked(scopeId, replacedRevisionId, commitSeq);
          }
          this.summaries.invalidateForRevisionLocked(scopeId, revisionId, commitSeq);
        },
      );
      this.jobs = new JobRepository(
        database,
        () => this.ensureOpen(),
        { ...(options.job_clock === undefined ? {} : { clock: options.job_clock }), ...(options.job_lease_ms === undefined ? {} : { lease_ms: options.job_lease_ms }) },
      );
      this.attempts = new AttemptRepository(
        database,
        () => this.ensureOpen(),
        options.attempt_clock === undefined ? {} : { clock: options.attempt_clock },
      );
      this.runtimeArtifacts = new RuntimeArtifactRepository(database, () => this.ensureOpen());
      if (options.vector_extension_path !== undefined && options.migration_basis_sha256 !== undefined) {
        this.vectorQualification = qualifySqliteVec(this.database, options.vector_extension_path);
      }
      if (createdFile) {
        this.initializeNewVault(schemaSql);
      } else if (existingVersion !== CURRENT_SCHEMA_VERSION || options.migration_basis_sha256 !== undefined) {
        this.migrateSchema(
          readAuthMigrationSql(),
          readSearchMigrationSql(),
          readSearchSql(),
          readPolicyMigrationSql(),
          readContextMigrationSql(),
          readRevisionMigrationSql(),
          readJobMigrationSql(),
          readTemporalMigrationSql(),
          readMeaningMigrationSql(),
          readAttemptsMigrationSql(),
          readVectorMigrationSql(),
          readRuntimeArtifactsMigrationSql(),
          readApiAuthMigrationSql(),
          readDerivedMigrationSql(),
          readExtractionMigrationSql(),
          readGraphMigrationSql(),
          readProcedureMigrationSql(),
          readExportsMigrationSql(),
          readOpenCodeMigrationSql(),
          readManagedExportFormatMigrationSql(),
          readCapturePolicyMigrationSql(),
          options.migration_basis_sha256,
        );
      } else {
        assertExistingVaultIdentity(this.database);
      }
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.assertDurabilityPragmas();
      if (options.vector_extension_path !== undefined) {
        this.vectorQualification ??= qualifySqliteVec(this.database, parseContract(z.string().min(1).max(4_096), options.vector_extension_path, "vector-extension-path"));
        this.ensureVectorVec0Index();
      }
      if (this.getSchemaVersion() !== SCHEMA_VERSION) throw new StoreError("schema_invalid");
    } catch (error: unknown) {
      try {
        probe?.close();
        opened?.close();
      } catch {
        // Preserve the initialization failure.
      }
      if (createdFile) {
        try {
          unlinkOwnedVaultFiles(filePath);
        } catch {
          // Preserve the initialization failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("schema_invalid", error);
    }
  }

  private initializeNewVault(schemaSql: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.database.exec(schemaSql);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the schema failure.
      }
      throw error;
    }
  }

  private migrateSchema(
    authMigrationSql: string,
    searchMigrationSql: string,
    searchSql: string,
    policyMigrationSql: string,
    contextMigrationSql: string,
    revisionMigrationSql: string,
    jobMigrationSql: string,
    temporalMigrationSql: string,
    meaningMigrationSql: string,
    attemptsMigrationSql: string,
    vectorMigrationSql: string,
    runtimeArtifactsMigrationSql: string,
    apiAuthMigrationSql: string,
    derivedMigrationSql: string,
    extractionMigrationSql: string,
    graphMigrationSql: string,
    procedureMigrationSql: string,
    exportsMigrationSql: string,
    openCodeMigrationSql: string,
    managedExportFormatMigrationSql: string,
    capturePolicyMigrationSql: string,
    expectedBasis?: string,
  ): void {
    this.database.exec("PRAGMA foreign_keys = OFF");
    this.database.exec("BEGIN EXCLUSIVE");
    let committed = false;
    try {
      if (expectedBasis !== undefined && snapshotBasis(this.database) !== expectedBasis) throw new StoreError("backup_busy");
      const actualVersion = assertExistingVaultIdentity(this.database);
      if (actualVersion === CURRENT_SCHEMA_VERSION) {
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      let version = actualVersion;
      if (version === LEGACY_SCHEMA_VERSION) {
        this.database.exec(authMigrationSql);
        this.database.exec(`PRAGMA user_version = ${AUTH_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== AUTH_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = AUTH_SCHEMA_VERSION;
      }
      if (version === AUTH_SCHEMA_VERSION) {
        this.database.exec(searchMigrationSql);
        this.database.exec(searchSql);
        this.backfillSearchDocuments();
        this.database.exec("INSERT INTO search_fts (search_fts) VALUES ('rebuild')");
        this.database.exec(`PRAGMA user_version = ${SEARCH_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== SEARCH_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = SEARCH_SCHEMA_VERSION;
      }
      if (version === SEARCH_SCHEMA_VERSION) {
        this.database.exec(policyMigrationSql);
        this.database.exec(`PRAGMA user_version = ${POLICY_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== POLICY_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = POLICY_SCHEMA_VERSION;
      }
      if (version === POLICY_SCHEMA_VERSION) {
        this.database.exec(contextMigrationSql);
        this.database.exec(`PRAGMA user_version = ${CONTEXT_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== CONTEXT_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = CONTEXT_SCHEMA_VERSION;
      }
      if (version === CONTEXT_SCHEMA_VERSION) {
        this.database.exec(revisionMigrationSql);
        this.database.exec(`PRAGMA user_version = ${REVISION_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== REVISION_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = REVISION_SCHEMA_VERSION;
      }
      if (version === REVISION_SCHEMA_VERSION) {
        this.database.exec(jobMigrationSql);
        this.database.exec(`PRAGMA user_version = ${JOB_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== JOB_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = JOB_SCHEMA_VERSION;
      }
      if (version === JOB_SCHEMA_VERSION) {
        this.database.exec(temporalMigrationSql);
        this.database.exec(`PRAGMA user_version = ${TEMPORAL_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== TEMPORAL_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = TEMPORAL_SCHEMA_VERSION;
      }
      if (version === TEMPORAL_SCHEMA_VERSION) {
        this.database.exec(meaningMigrationSql);
        this.database.exec(`PRAGMA user_version = ${MEANING_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== MEANING_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = MEANING_SCHEMA_VERSION;
      }
      if (version === MEANING_SCHEMA_VERSION) {
        this.database.exec(attemptsMigrationSql);
        this.database.exec(`PRAGMA user_version = ${ATTEMPT_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== ATTEMPT_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = ATTEMPT_SCHEMA_VERSION;
      }
      if (version === ATTEMPT_SCHEMA_VERSION) {
        this.database.exec(vectorMigrationSql);
        this.database.exec(`PRAGMA user_version = ${VECTOR_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== VECTOR_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = VECTOR_SCHEMA_VERSION;
      }
      // A vault that is already at the extraction schema (15) enters the
      // remaining chain segments here so the 15→16 graph step can run.
      if (version < VECTOR_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === VECTOR_SCHEMA_VERSION) {
        this.database.exec(runtimeArtifactsMigrationSql);
        this.database.exec(`PRAGMA user_version = ${RUNTIME_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== RUNTIME_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = RUNTIME_SCHEMA_VERSION;
      }
      if (version < RUNTIME_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === RUNTIME_SCHEMA_VERSION) {
        this.database.exec(apiAuthMigrationSql);
        this.database.exec(`PRAGMA user_version = ${API_AUTH_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== API_AUTH_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = API_AUTH_SCHEMA_VERSION;
      }
      if (version < API_AUTH_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === API_AUTH_SCHEMA_VERSION) {
        this.database.exec(derivedMigrationSql);
        this.database.exec(`PRAGMA user_version = ${DERIVED_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== DERIVED_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = DERIVED_SCHEMA_VERSION;
      }
      if (version < DERIVED_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === DERIVED_SCHEMA_VERSION) {
        this.database.exec(extractionMigrationSql);
        this.database.exec(`PRAGMA user_version = ${EXTRACTION_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== EXTRACTION_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = EXTRACTION_SCHEMA_VERSION;
      }
      if (version < EXTRACTION_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === EXTRACTION_SCHEMA_VERSION) {
        this.database.exec(graphMigrationSql);
        this.database.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== GRAPH_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = GRAPH_SCHEMA_VERSION;
      }
      if (version < GRAPH_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === GRAPH_SCHEMA_VERSION) {
        this.database.exec(procedureMigrationSql);
        this.database.exec(`PRAGMA user_version = ${PROCEDURE_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== PROCEDURE_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = PROCEDURE_SCHEMA_VERSION;
      }
      if (version < PROCEDURE_SCHEMA_VERSION || version > TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === PROCEDURE_SCHEMA_VERSION) {
        this.database.exec(exportsMigrationSql);
        this.database.exec(`PRAGMA user_version = ${EXPORTS_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== EXPORTS_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = EXPORTS_SCHEMA_VERSION;
      }
      if (version !== EXPORTS_SCHEMA_VERSION && version !== OPENCODE_SCHEMA_VERSION && version !== 20 && version !== MANAGED_EXPORT_FORMAT_SCHEMA_VERSION && version !== BACKUP_SCHEMA_VERSION && version !== TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      if (version === EXPORTS_SCHEMA_VERSION) {
        this.database.exec(openCodeMigrationSql);
        this.database.exec(`PRAGMA user_version = ${OPENCODE_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== OPENCODE_SCHEMA_VERSION) {
          throw new StoreError("schema_migration_failed");
        }
        version = OPENCODE_SCHEMA_VERSION;
      }
      if (version === OPENCODE_SCHEMA_VERSION) {
        this.database.exec(readFileSync(new URL("./migrations/020-purge-runtime.sql", import.meta.url), "utf8"));
        this.database.exec("PRAGMA user_version = 20");
        if (assertExistingVaultIdentity(this.database) !== 20) throw new StoreError("schema_migration_failed");
        version = 20;
      }
      // Only the known v20 contract can enter this table rebuild.
      if (version === 20) {
        this.database.exec(managedExportFormatMigrationSql);
        this.database.exec(`PRAGMA user_version = ${MANAGED_EXPORT_FORMAT_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== MANAGED_EXPORT_FORMAT_SCHEMA_VERSION) throw new StoreError("schema_migration_failed");
        version = MANAGED_EXPORT_FORMAT_SCHEMA_VERSION;
      }
      if (version === MANAGED_EXPORT_FORMAT_SCHEMA_VERSION) {
        this.database.exec(readFileSync(new URL("./migrations/024-backup-restore.sql", import.meta.url), "utf8"));
        this.database.exec(`PRAGMA user_version = ${BACKUP_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== BACKUP_SCHEMA_VERSION) throw new StoreError("schema_migration_failed");
        version = BACKUP_SCHEMA_VERSION;
      }
      if (version === BACKUP_SCHEMA_VERSION) {
        this.database.exec(readFileSync(new URL("./migrations/025-transfer-policy.sql", import.meta.url), "utf8"));
        this.database.exec(`PRAGMA user_version = ${TRANSFER_POLICY_SCHEMA_VERSION}`);
        if (assertExistingVaultIdentity(this.database) !== TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_migration_failed");
        version = TRANSFER_POLICY_SCHEMA_VERSION;
      }
      if (version !== TRANSFER_POLICY_SCHEMA_VERSION) throw new StoreError("schema_version_mismatch");
      this.database.exec(capturePolicyMigrationSql);
      this.database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      if (assertExistingVaultIdentity(this.database) !== CURRENT_SCHEMA_VERSION) throw new StoreError("schema_migration_failed");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      try {
        if (!committed) this.database.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure.
      }
      try { this.database.exec("PRAGMA foreign_keys = ON"); } catch { /* preserve migration failure */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError("schema_migration_failed", error);
    }
    this.database.exec("PRAGMA foreign_keys = ON");
    assertExistingVaultIdentity(this.database);
  }

  private backfillSearchDocuments(): void {
    const sourceRows = this.database
      .prepare(
        `SELECT
           e.capture_id, e.scope_id, e.fingerprint, e.payload_json, e.event_json,
           e.commit_seq
         FROM source_event AS e
         ORDER BY e.commit_seq, e.capture_id`,
      )
      .iterate();
    const sourceSpanRows = this.database.prepare(
      `SELECT span_id, root, path, start_utf16, end_utf16, digest
         FROM source_span WHERE source_id = ? ORDER BY rowid`,
    );
    const spanInsert = this.database.prepare(
      `INSERT INTO source_span (span_id, source_id, scope_id, root, path, start_utf16, end_utf16, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const searchInsert = this.database.prepare(
      `INSERT INTO search_document (
         span_id, source_id, scope_id, root, path, start_utf16, end_utf16,
         digest, text, representation, eligible, generation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lexical', 1, ?)`,
    );

    const backfillSource = (row: Record<string, unknown>): void => {
      const captureId = sqlText(rowValue(row, "capture_id"), "capture_id");
      const scopeId = sqlText(rowValue(row, "scope_id"), "scope_id");
      const fingerprint = sqlText(rowValue(row, "fingerprint"), "fingerprint");
      const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "payload_json"), "payload_json");
      const event = jsonObject(sqlText(rowValue(row, "event_json"), "event_json"), "event_json");
      const spans: NormalizedSourceSpan[] = sourceSpanRows.all(captureId).map((spanRow) => ({
        span_id: sqlText(rowValue(spanRow, "span_id"), "span_id"),
        root: sourceSpanRoot(rowValue(spanRow, "root"), "root"),
        path: sqlText(rowValue(spanRow, "path"), "path"),
        start_utf16: safeSpanOffset(rowValue(spanRow, "start_utf16"), "start_utf16"),
        end_utf16: safeSpanOffset(rowValue(spanRow, "end_utf16"), "end_utf16"),
        digest: sqlText(rowValue(spanRow, "digest"), "digest").toLowerCase(),
      }));
      const excerpts = new Map<string, string>();
      for (const span of spans) {
        try {
          const root = span.root === "event" ? event : payload;
          const excerpt = validateSpanExcerpt(
            resolveTextAtPath(root, span.path),
            span.start_utf16,
            span.end_utf16,
            span.digest,
          );
          if (excerpt.length === 0) throw new Error("empty_span");
          excerpts.set(span.span_id, excerpt);
        } catch (error: unknown) {
          throw new StoreError("schema_migration_failed", error);
        }
      }

      const eventText = typeof event.text === "string" ? event.text : undefined;
      const derivedEventSpan = automaticEventSpan(fingerprint, eventText, spans);
      if (derivedEventSpan !== undefined) {
        spanInsert.run(
          derivedEventSpan.span_id,
          captureId,
          scopeId,
          derivedEventSpan.root,
          derivedEventSpan.path,
          BigInt(derivedEventSpan.start_utf16),
          BigInt(derivedEventSpan.end_utf16),
          derivedEventSpan.digest,
        );
        spans.push(derivedEventSpan);
        try {
          excerpts.set(
            derivedEventSpan.span_id,
            validateSpanExcerpt(
              resolveTextAtPath(event, derivedEventSpan.path),
              derivedEventSpan.start_utf16,
              derivedEventSpan.end_utf16,
              derivedEventSpan.digest,
            ),
          );
        } catch (error: unknown) {
          throw new StoreError("schema_migration_failed", error);
        }
      }

      for (const span of spans) {
        const excerpt = excerpts.get(span.span_id);
        if (excerpt === undefined) throw new StoreError("schema_migration_failed");
        searchInsert.run(
          span.span_id,
          captureId,
          scopeId,
          span.root,
          span.path,
          BigInt(span.start_utf16),
          BigInt(span.end_utf16),
          span.digest,
          excerpt,
          INITIAL_SEARCH_GENERATION,
        );
      }
    };

    for (const row of sourceRows) backfillSource(row);
  }

  private assertDurabilityPragmas(): void {
    const pragmas = this.getPragmas();
    if (pragmas.foreign_keys !== 1n || pragmas.journal_mode !== "wal" || pragmas.synchronous !== 2n) {
      throw new StoreError("durability_unavailable");
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getSchemaVersion(): number {
    this.ensureOpen();
    if (readPragmaInteger(this.database, "user_version") !== BigInt(SCHEMA_VERSION)) {
      throw new StoreError("schema_version_mismatch");
    }
    const row = this.database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    const value = row === undefined ? undefined : rowValue(row, "value");
    if (value !== String(SCHEMA_VERSION)) throw new StoreError("schema_invalid");
    return SCHEMA_VERSION;
  }

  getPragmas(): DatabasePragmas {
    this.ensureOpen();
    const foreignKeys = this.database.prepare("PRAGMA foreign_keys").get();
    const journalMode = this.database.prepare("PRAGMA journal_mode").get();
    const synchronous = this.database.prepare("PRAGMA synchronous").get();
    return {
      foreign_keys: sqlInteger(rowValue(foreignKeys, "foreign_keys"), "foreign_keys"),
      journal_mode: sqlText(rowValue(journalMode, "journal_mode"), "journal_mode"),
      synchronous: sqlInteger(rowValue(synchronous, "synchronous"), "synchronous"),
    };
  }

  /** T21 phase 1: enumerate the local, source-derived purge reach. */
  getPurgeInventory(binding: PolicySetupBinding, scopeId: string, captureIds: readonly string[]): PurgeInventory {
    this.ensureOpen();
    if (!isPolicySetupBinding(binding)) throw new StoreError("policy_invalid");
    const parsedScopeId = parseContract(z.uuid(), scopeId, "purge-scope");
    requirePolicySetup(binding, parsedScopeId, "purge_scope_not_allowed");
    if (!Array.isArray(captureIds) || captureIds.length < 1 || captureIds.length > 128 || new Set(captureIds).size !== captureIds.length || captureIds.some((captureId) => !z.uuid().safeParse(captureId).success)) throw new StoreError("purge_selection_invalid");
    const parsedCaptureIds = captureIds.map((captureId) => parseContract(z.uuid(), captureId, "purge-capture"));
    const capturePlaceholders = parsedCaptureIds.map(() => "?").join(", ");
    const count = (query: string, ...args: SQLInputValue[]): number => Number(sqlInteger(rowValue(this.database.prepare(query).get(...args), "count"), "purge-count"));
    const sourceCount = count(`SELECT COUNT(*) AS count FROM source_event WHERE scope_id = ? AND capture_id IN (${capturePlaceholders})`, parsedScopeId, ...parsedCaptureIds);
    if (sourceCount !== parsedCaptureIds.length) throw new StoreError("purge_selection_invalid");
    const targets = this.collectPurgeTargets(parsedScopeId, parsedCaptureIds);
    const list = (ids: readonly string[]): string => ids.map(() => "?").join(", ");
    const dependencyClauses: string[] = [];
    const dependencyArgs: SQLInputValue[] = [parsedScopeId];
    if (targets.source_span_ids.length > 0) {
      dependencyClauses.push(`(parent_type = 'source_span' AND parent_revision_id IN (${list(targets.source_span_ids)}))`);
      dependencyArgs.push(...targets.source_span_ids);
    }
    if (targets.memory_revision_ids.length > 0) {
      dependencyClauses.push(`((parent_type = 'memory_revision' AND parent_revision_id IN (${list(targets.memory_revision_ids)})) OR (child_type = 'memory_revision' AND child_revision_id IN (${list(targets.memory_revision_ids)})))`);
      dependencyArgs.push(...targets.memory_revision_ids, ...targets.memory_revision_ids);
    }
    if (targets.derived_revision_ids.length > 0) {
      dependencyClauses.push(`((parent_type = 'derived_artifact' AND parent_revision_id IN (${list(targets.derived_revision_ids)})) OR (child_type = 'derived_artifact' AND child_revision_id IN (${list(targets.derived_revision_ids)})))`);
      dependencyArgs.push(...targets.derived_revision_ids, ...targets.derived_revision_ids);
    }
    const dependencyCount = dependencyClauses.length === 0
      ? 0
      : count(`SELECT COUNT(*) AS count FROM dependency WHERE scope_id = ? AND (${dependencyClauses.join(" OR ")})`, ...dependencyArgs);
    const vectorChunkCount = count(
      `SELECT COUNT(*) AS count FROM vector_chunk WHERE scope_id = ? AND (source_id IN (${capturePlaceholders}) OR revision_id IN (SELECT value FROM json_each(?)))`,
      parsedScopeId,
      ...parsedCaptureIds, JSON.stringify(targets.memory_revision_ids),
    );
    const vectorEmbeddingCount = count(
      `SELECT COUNT(*) AS count FROM vector_embedding AS v JOIN vector_chunk AS c ON c.chunk_id = v.chunk_id WHERE c.scope_id = ? AND (c.source_id IN (${capturePlaceholders}) OR c.revision_id IN (SELECT value FROM json_each(?)))`,
      parsedScopeId,
      ...parsedCaptureIds, JSON.stringify(targets.memory_revision_ids),
    );
    const runtimeArtifactCount = count(
      `SELECT COUNT(*) AS count FROM runtime_artifact WHERE scope_id = ? AND
        (source_capture_id IN (SELECT value FROM json_each(?)) OR job_id IN
        (SELECT job_id FROM extraction_batch WHERE batch_id IN (SELECT value FROM json_each(?))))`,
      parsedScopeId, JSON.stringify(parsedCaptureIds), JSON.stringify(targets.extraction_batch_ids),
    );
    const queryTraceCount = count(
      "SELECT COUNT(*) AS count FROM query_trace WHERE EXISTS (SELECT 1 FROM json_each(query_trace.scope_ids_json) WHERE value = ?)",
      parsedScopeId,
    );
    const managedExportStates = targets.managed_export_ids.length === 0
      ? []
      : this.database.prepare(
        `SELECT state, COUNT(*) AS count FROM managed_export WHERE scope_id = ? AND export_id IN (${list(targets.managed_export_ids)}) GROUP BY state ORDER BY state`,
      ).all(parsedScopeId, ...targets.managed_export_ids).map((row) => ({ state: sqlText(rowValue(row, "state"), "export-state"), count: Number(sqlInteger(rowValue(row, "count"), "export-count")) }));
    return {
      scope_id: parsedScopeId,
      capture_ids: parsedCaptureIds,
      source_count: sourceCount,
      span_count: targets.source_span_ids.length,
      revision_count: targets.memory_revision_ids.length,
      item_count: targets.memory_item_ids.length,
      derived_count: targets.derived_revision_ids.length,
      dependency_count: dependencyCount,
      vector_chunk_count: vectorChunkCount,
      vector_embedding_count: vectorEmbeddingCount,
      graph_edge_count: targets.semantic_edge_ids.length,
      extraction_batch_count: targets.extraction_batch_ids.length,
      runtime_artifact_count: runtimeArtifactCount,
      query_trace_count: queryTraceCount,
      managed_export_count: targets.managed_export_ids.length,
      managed_backup_count: countManagedBackups(this.database, parsedScopeId),
      managed_export_states: managedExportStates,
    };
  }

  /** T21 phase 4: compact the SQLite/FTS store under the current writer. */
  performPhysicalMaintenance(options: { readonly vacuum?: boolean } = {}): PhysicalMaintenanceResult {
    this.ensureOpen();
    const vacuumRequested = options.vacuum === true;
    let secureDelete: PhysicalMaintenanceResult["secure_delete"] = "complete";
    let ftsSecureDelete: PhysicalMaintenanceResult["fts_secure_delete"] = "complete";
    try { this.database.exec("PRAGMA secure_delete = ON"); } catch { secureDelete = "pending"; }
    try { this.database.exec("INSERT INTO search_fts (search_fts, rank) VALUES ('secure-delete', 1)"); } catch { ftsSecureDelete = "pending"; }
    const checkpoint = (): PhysicalMaintenanceResult["wal_checkpoint"] => {
      try {
        const row = this.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        return sqlInteger(rowValue(row, "busy"), "checkpoint_busy") === 0n ? "complete" : "pending";
      } catch {
        return "pending";
      }
    };
    if (secureDelete === "pending" || ftsSecureDelete === "pending") {
      return { secure_delete: secureDelete, fts_secure_delete: ftsSecureDelete, wal_checkpoint: "pending", vacuum: vacuumRequested ? "pending" : "not_requested" };
    }
    if (checkpoint() === "pending") return { secure_delete: secureDelete, fts_secure_delete: ftsSecureDelete, wal_checkpoint: "pending", vacuum: vacuumRequested ? "pending" : "not_requested" };
    let vacuum: PhysicalMaintenanceResult["vacuum"] = "not_requested";
    if (vacuumRequested) {
      try {
        this.database.exec("VACUUM");
        vacuum = "complete";
      } catch {
        return { secure_delete: secureDelete, fts_secure_delete: ftsSecureDelete, wal_checkpoint: "pending", vacuum: "pending" };
      }
    }
    const finalCheckpoint = checkpoint();
    return { secure_delete: secureDelete, fts_secure_delete: ftsSecureDelete, wal_checkpoint: finalCheckpoint, vacuum: vacuumRequested && finalCheckpoint === "pending" ? "pending" : vacuum };
  }

  registerScope(input: unknown): ScopeRegistration {
    this.ensureOpen();
    const scope = parseContract(scopeRegistrationSchema, input, "scope-registration");
    const existing = this.database
      .prepare("SELECT kind, owner_ref, created_at FROM scope WHERE scope_id = ?")
      .get(scope.scope_id);
    if (existing !== undefined) {
      if (
        rowValue(existing, "kind") !== scope.kind ||
        rowValue(existing, "owner_ref") !== scope.owner_ref ||
        rowValue(existing, "created_at") !== scope.created_at
      ) {
        throw new StoreError("scope_conflict");
      }
      if (this.database.prepare("SELECT 1 AS present FROM scope_policy WHERE scope_id = ?").get(scope.scope_id) === undefined) {
        throw new StoreError("schema_invalid");
      }
      return scope;
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(
          "INSERT INTO scope (scope_id, kind, owner_ref, data_epoch, privacy_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(scope.scope_id, scope.kind, scope.owner_ref, 0n, 0n, scope.created_at);
      this.database
        .prepare("INSERT INTO scope_policy (scope_id, capture_paused, updated_at) VALUES (?, 0, ?)")
        .run(scope.scope_id, scope.created_at);
      this.database.exec("COMMIT");
      return scope;
    } catch (error: unknown) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the scope or policy failure.
      }
      throw new StoreError("scope_write_failed", error);
    }
  }

  registerTransferFileIntent(exportId: string, scopeIds: readonly string[], paths: readonly string[]): void {
    this.ensureOpen();
    if (!z.uuid().safeParse(exportId).success || scopeIds.length < 1 || new Set(scopeIds).size !== scopeIds.length || scopeIds.some((scopeId) => !z.uuid().safeParse(scopeId).success) || paths.length < 1) throw new StoreError("transfer_invalid");
    try {
      registerBackupIntent(this.database, exportId, scopeIds, paths);
    } catch (error: unknown) {
      throw new StoreError("transfer_write_failed", error);
    }
  }

  finishTransferFileRegistration(exportId: string, ownedFiles: readonly RegisteredBackupFile[]): void {
    this.ensureOpen();
    if (!z.uuid().safeParse(exportId).success) throw new StoreError("transfer_invalid");
    try {
      finishBackupRegistration(this.database, exportId, ownedFiles);
    } catch (error: unknown) {
      throw new StoreError("transfer_write_failed", error);
    }
  }

  runTransferExportLocked<T>(
    binding: PolicySetupBinding | PolicyOutputBinding,
    scopeIds: readonly string[],
    action: (snapshot: TransferSnapshot) => T,
  ): T {
    this.ensureOpen();
    if ((!isPolicySetupBinding(binding) && !isPolicyOutputBinding(binding)) || !Array.isArray(scopeIds) || scopeIds.length < 1 || new Set(scopeIds).size !== scopeIds.length || scopeIds.some((scopeId) => !z.uuid().safeParse(scopeId).success)) throw new StoreError("output_not_allowed");
    if (isPolicySetupBinding(binding)) {
      if (!binding.allowed_output_targets.includes("export:jsonl") || scopeIds.some((scopeId) => !binding.allowed_scope_ids.includes(scopeId))) throw new StoreError("output_not_allowed");
    } else if (binding.target !== "export:jsonl" || scopeIds.some((scopeId) => scopeId !== binding.scope_id)) {
      throw new StoreError("output_not_allowed");
    }
    let committed = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const snapshot = this.readTransferSnapshotLocked(scopeIds);
      const result = action(snapshot);
      this.database.exec("COMMIT");
      committed = true;
      return result;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the export failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("transfer_write_failed", error);
    }
  }

  private readTransferSnapshotLocked(scopeIds: readonly string[]): TransferSnapshot {
    const placeholders = scopeIds.map(() => "?").join(", ");
    const scopes = this.database.prepare(
      `SELECT scope_id, kind, created_at FROM scope WHERE scope_id IN (${placeholders}) ORDER BY scope_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    if (scopes.length !== scopeIds.length) throw new StoreError("scope_not_registered");
    const pendingPurge = this.database.prepare(
      `SELECT 1 AS present FROM purge_operation WHERE scope_id IN (${placeholders}) AND state <> 'completed' LIMIT 1`,
    ).get(...scopeIds);
    if (pendingPurge !== undefined) throw new StoreError("transfer_blocked");
    const sources = this.database.prepare(
      `SELECT e.capture_id, e.scope_id, e.fingerprint, e.adapter_version, e.observed_stage, e.role, e.evidence_class,
              e.captured_at, e.occurred_at, e.payload_json, e.event_json, e.truncation_json, e.redaction_json,
              e.coverage_json, e.commit_seq, e.data_epoch,
              sess.host_kind AS origin_host_kind, sess.surface AS origin_surface,
              sess.execution_domain_kind AS origin_execution_domain_kind,
              sess.execution_domain_id AS origin_execution_domain_id,
              sess.host_instance_id AS origin_host_instance_id,
              sess.host_session_id AS origin_host_session_id
         FROM source_event AS e
         JOIN session AS sess ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
        WHERE e.scope_id IN (${placeholders}) ORDER BY e.scope_id, e.commit_seq, e.capture_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const sourceIds = sources.map((row) => rowValue(row, "capture_id"));
    if (sourceIds.some((value) => typeof value !== "string")) throw new StoreError("transfer_invalid");
    for (const source of sources) {
      const captureId = sqlText(rowValue(source, "capture_id"), "transfer-capture");
      if (this.database.prepare("SELECT 1 AS present FROM capture_replay_marker WHERE capture_id = ?").get(captureId) !== undefined || this.database.prepare("SELECT 1 AS present FROM purge_tombstone WHERE capture_id = ?").get(captureId) !== undefined) throw new StoreError("transfer_blocked");
      const grant = this.database.prepare("SELECT 1 AS present FROM scope_output_grant WHERE scope_id = ? AND output_target = 'export:jsonl' AND source_class = ?").get(sqlText(rowValue(source, "scope_id"), "transfer-source-scope"), sqlText(rowValue(source, "evidence_class"), "transfer-source-class"));
      if (grant === undefined) throw new StoreError("output_not_allowed");
    }
    const spans = this.database.prepare(
      `SELECT span_id, source_id, scope_id, root, path, start_utf16, end_utf16, digest
         FROM source_span WHERE scope_id IN (${placeholders}) ORDER BY scope_id, source_id, rowid`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const entities = this.database.prepare(
      `SELECT scope_id, entity_id, resolution_state, canonical_key, label, created_commit_seq
         FROM entity WHERE scope_id IN (${placeholders}) ORDER BY scope_id, entity_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const items = this.database.prepare(
      `SELECT scope_id, item_id, kind, entity_id, predicate, qualifiers_json, qualifiers_digest,
              cardinality, status, current_revision_id, created_commit_seq
         FROM memory_item WHERE scope_id IN (${placeholders}) ORDER BY scope_id, created_commit_seq, item_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const revisions = this.database.prepare(
      `SELECT scope_id, revision_id, item_id, parent_revision_id, operation, content_json, content_digest,
              actor_binding_id, actor_host_kind, actor_surface, actor_execution_domain_kind,
              actor_execution_domain_id, actor_host_instance_id, actor_host_session_id,
              meaning_json, meaning_digest, created_commit_seq
         FROM memory_revision WHERE scope_id IN (${placeholders}) ORDER BY scope_id, created_commit_seq, revision_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const revisionSources = this.database.prepare(
      `SELECT scope_id, revision_id, source_capture_id, source_span_id
         FROM revision_source WHERE scope_id IN (${placeholders}) ORDER BY scope_id, revision_id, source_span_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const derived = this.database.prepare(
      `SELECT scope_id, artifact_id, revision_id, kind, purpose, session_id, content_json,
              content_digest, temporal_domain_json, egress_targets_json, status, status_reason,
              created_commit_seq, invalidated_commit_seq
         FROM derived_artifact WHERE scope_id IN (${placeholders}) ORDER BY scope_id, created_commit_seq, revision_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    const dependencies = this.database.prepare(
      `SELECT scope_id, child_type, child_revision_id, parent_type, parent_revision_id, relation, created_commit_seq
         FROM dependency WHERE scope_id IN (${placeholders}) ORDER BY scope_id, child_type, child_revision_id, parent_type, parent_revision_id`,
    ).all(...scopeIds).map((row) => row as Record<string, unknown>);
    return { schema_version: CURRENT_SCHEMA_VERSION, scopes, sources, spans, entities, items, revisions, revisionSources, derived, dependencies };
  }

  commitTransferImport(
    binding: TrustedBinding,
    policy: PolicySetupBinding | PolicyOutputBinding,
    plan: TransferImportPlan,
    commit: boolean,
    recheck?: () => void,
  ): TransferImportDbResult {
    this.ensureOpen();
    if (!isTrustedBinding(binding) || (!isPolicySetupBinding(policy) && !isPolicyOutputBinding(policy))) throw new StoreError("output_not_allowed");
    const targetScopeIds = plan.scope_map.map((entry) => entry.target_scope_id);
    if (targetScopeIds.length < 1 || new Set(targetScopeIds).size !== targetScopeIds.length) throw new StoreError("transfer_invalid");
    if (isPolicySetupBinding(policy)) {
      if (!policy.allowed_output_targets.includes("export:jsonl") || targetScopeIds.some((scopeId) => !policy.allowed_scope_ids.includes(scopeId))) throw new StoreError("output_not_allowed");
    } else if (policy.target !== "export:jsonl" || targetScopeIds.some((scopeId) => scopeId !== policy.scope_id)) {
      throw new StoreError("output_not_allowed");
    }
    if (targetScopeIds.some((scopeId) => !binding.allowed_scope_ids.includes(scopeId))) throw new StoreError("scope_not_allowed");
    let committed = false;
    try {
      this.database.exec(commit ? "BEGIN IMMEDIATE" : "BEGIN");
      if (recheck !== undefined) recheck();
      const inspection = this.inspectTransferImportLocked(binding, plan, targetScopeIds);
      if (!commit) {
        this.database.exec("COMMIT");
        committed = true;
        return inspection;
      }
      if (inspection.conflicts.length > 0) throw new StoreError("transfer_conflict");
      if (inspection.no_op) {
        this.database.exec("COMMIT");
        committed = true;
        return inspection;
      }
      const counter = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
      if (counter === undefined) throw new StoreError("transfer_write_failed");
      const commitSeq = sqlInteger(rowValue(counter, "commit_seq"), "transfer-commit-seq") + 1n;
      const dataEpoch = sqlInteger(rowValue(counter, "data_epoch"), "transfer-data-epoch") + 1n;
      if (commitSeq > MAX_INT64 || dataEpoch > MAX_INT64) throw new StoreError("transfer_write_failed");
      recordCommitClock(this.database, commitSeq, this.wallClock);
      const acceptedAt = parseContract(z.iso.datetime({ offset: true }), this.wallClockNow(), "capture-accepted-at");
      const sourceInsert = this.database.prepare(
        `INSERT INTO source_event (
           capture_id, scope_id, session_id, fingerprint, adapter_version, observed_stage,
           role, evidence_class, native_session_id, native_turn_id, native_message_id,
           native_part_id, native_tool_call_id, captured_at, occurred_at, payload_json,
           event_json, truncation_json, redaction_json, coverage_json, commit_seq, data_epoch
         ) VALUES (?, ?, ?, ?, ?, 'message_part', 'assistant', 'assistant_output', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const source of plan.sources) {
        const existing = this.database.prepare("SELECT 1 AS present FROM source_event WHERE capture_id = ?").get(source.capture_id);
        if (existing !== undefined) continue;
        const session = this.database.prepare(
          `SELECT session_id FROM session
             WHERE scope_id = ? AND host_kind = ? AND surface = ?
               AND execution_domain_kind = ? AND execution_domain_id = ?
               AND host_instance_id = ? AND host_session_id = ?`,
        ).get(source.target_scope_id, binding.host_kind, binding.surface, binding.execution_domain.kind, binding.execution_domain.id, binding.host_instance_id, binding.host_session_id);
        if (session === undefined) throw new StoreError("session_not_registered");
        const eventJson = importedEventJson(source, plan.export_id, binding);
        const retention = this.database.prepare("SELECT retention_seconds FROM scope_capture_policy WHERE scope_id = ? AND source_class = 'assistant_output'").get(source.target_scope_id);
        const retentionSeconds = retention === undefined || rowValue(retention, "retention_seconds") === null ? null : sqlInteger(rowValue(retention, "retention_seconds"), "capture-retention-seconds");
        if (retentionSeconds !== null) captureExpiryAt(acceptedAt, retentionSeconds);
        sourceInsert.run(source.capture_id, source.target_scope_id, sqlText(rowValue(session, "session_id"), "transfer-session-id"), source.fingerprint, source.adapter_version, source.captured_at, source.occurred_at, source.payload_json, eventJson, source.truncation_json, source.redaction_json, source.coverage_json, commitSeq, dataEpoch);
        this.database.prepare("INSERT INTO capture_acceptance (capture_id, scope_id, accepted_at, retention_seconds) VALUES (?, ?, ?, ?)").run(source.capture_id, source.target_scope_id, acceptedAt, retentionSeconds);
        const event = transferJsonObject(eventJson, "transfer-event");
        const payload = transferJsonObject(source.payload_json, "transfer-payload");
        const spanInsert = this.database.prepare("INSERT INTO source_span (span_id, source_id, scope_id, root, path, start_utf16, end_utf16, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const searchInsert = this.database.prepare("INSERT INTO search_document (span_id, source_id, scope_id, root, path, start_utf16, end_utf16, digest, text, representation, eligible, generation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lexical', 1, ?)");
        for (const span of source.spans) {
          if (this.database.prepare("SELECT 1 AS present FROM source_span WHERE span_id = ?").get(span.span_id) !== undefined) continue;
          const root = span.root === "event" ? event : payload;
          let excerpt: string;
          try { excerpt = validateSpanExcerpt(resolveTextAtPath(root, span.path), span.start_utf16, span.end_utf16, span.digest); } catch (error: unknown) { throw new StoreError("transfer_invalid", error); }
          spanInsert.run(span.span_id, span.source_id, span.scope_id, span.root, span.path, BigInt(span.start_utf16), BigInt(span.end_utf16), span.digest);
          if (excerpt.length > 0) searchInsert.run(span.span_id, span.source_id, span.scope_id, span.root, span.path, BigInt(span.start_utf16), BigInt(span.end_utf16), span.digest, excerpt, INITIAL_SEARCH_GENERATION);
        }
      }
      this.revisions.insertImportedCandidateHistory(
        binding,
        plan.entities.map((entity) => ({ scope_id: entity.target_scope_id, entity_id: entity.entity_id, label: entity.label, created_commit_seq: commitSeq.toString(10) })),
        plan.items.map((item) => ({ scope_id: item.target_scope_id, item_id: item.item_id, kind: item.kind as RevisionDetail["kind"], entity_id: item.entity_id, predicate: item.predicate, qualifiers_json: item.qualifiers_json, qualifiers_digest: item.qualifiers_digest, cardinality: item.cardinality as RevisionDetail["cardinality"], current_revision_id: item.current_revision_id, created_commit_seq: commitSeq.toString(10) })),
        plan.revisions.map((revision) => ({ scope_id: revision.target_scope_id, revision_id: revision.revision_id, item_id: revision.item_id, parent_revision_id: revision.parent_revision_id, operation: revision.operation as RevisionDetail["operation"], content_json: revision.content_json, content_digest: revision.content_digest, meaning_json: revision.meaning_json, created_commit_seq: commitSeq.toString(10) })),
        plan.revisionSources.map((source) => ({ scope_id: source.target_scope_id, revision_id: source.revision_id, source_capture_id: source.source_capture_id, source_span_id: source.source_span_id })),
      );
      for (const artifact of plan.derived) {
        if (this.database.prepare("SELECT 1 AS present FROM derived_artifact WHERE scope_id = ? AND revision_id = ?").get(artifact.target_scope_id, artifact.revision_id) !== undefined) continue;
        this.database.prepare(
          `INSERT INTO derived_artifact (artifact_id, scope_id, revision_id, kind, purpose, session_id, content_json, content_digest, temporal_domain_json, egress_targets_json, status, status_reason, created_commit_seq, invalidated_commit_seq)
           VALUES (?, ?, ?, ?, 'historical', NULL, ?, ?, ?, '[]', 'blocked', 'foreign_import', ?, NULL)`,
        ).run(artifact.artifact_id, artifact.target_scope_id, artifact.revision_id, artifact.kind, artifact.content_json, artifact.content_digest, artifact.temporal_domain_json, commitSeq);
      }
      for (const dependency of plan.dependencies) {
        if (this.database.prepare("SELECT relation FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ? AND parent_type = ? AND parent_revision_id = ?").get(dependency.target_scope_id, dependency.child_type, dependency.child_revision_id, dependency.parent_type, dependency.parent_revision_id) !== undefined) continue;
        this.database.prepare("INSERT INTO dependency (scope_id, child_type, child_revision_id, parent_type, parent_revision_id, relation, created_commit_seq) VALUES (?, ?, ?, ?, ?, ?, ?)").run(dependency.target_scope_id, dependency.child_type, dependency.child_revision_id, dependency.parent_type, dependency.parent_revision_id, dependency.relation, commitSeq);
      }
      this.database.prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1").run(commitSeq, dataEpoch);
      for (const scopeId of targetScopeIds) this.database.prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?").run(dataEpoch, scopeId);
      this.database.exec("COMMIT");
      committed = true;
      return { ...inspection, inserted: inspection.duplicates === 0 ? plan.sources.length + plan.entities.length + plan.items.length + plan.revisions.length + plan.revisionSources.length + plan.derived.length + plan.dependencies.length : plan.sources.length + plan.entities.length + plan.items.length + plan.revisions.length + plan.revisionSources.length + plan.derived.length + plan.dependencies.length - inspection.duplicates, no_op: false };
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the transfer failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("transfer_write_failed", error);
    }
  }

  private inspectTransferImportLocked(binding: TrustedBinding, plan: TransferImportPlan, targetScopeIds: readonly string[]): TransferImportDbResult {
    const conflicts: string[] = [];
    const addConflict = (value: string): void => { if (!conflicts.includes(value)) conflicts.push(value); };
    const sameKeys = (stored: readonly string[], incoming: readonly string[]): boolean => {
      const keys = new Set(incoming);
      return stored.length === incoming.length && stored.every((key) => keys.has(key));
    };
    const inspectDependencies = (scopeId: string, childType: string, revisionId: string): void => {
      const stored = this.database.prepare("SELECT parent_type, parent_revision_id, relation FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ?").all(scopeId, childType, revisionId).map((row) => JSON.stringify([row.parent_type, row.parent_revision_id, row.relation]));
      const incoming = plan.dependencies.filter((edge) => edge.target_scope_id === scopeId && edge.child_type === childType && edge.child_revision_id === revisionId).map((edge) => JSON.stringify([edge.parent_type, edge.parent_revision_id, edge.relation]));
      if (!sameKeys(stored, incoming)) addConflict(`dependency_history:${revisionId}`);
    };
    let duplicates = 0;
    const scopes = this.database.prepare(`SELECT scope_id, kind FROM scope WHERE scope_id IN (${targetScopeIds.map(() => "?").join(", ")})`).all(...targetScopeIds);
    if (scopes.length !== targetScopeIds.length) throw new StoreError("scope_not_registered");
    for (const mapping of plan.scope_map) {
      const row = this.database.prepare("SELECT kind FROM scope WHERE scope_id = ?").get(mapping.target_scope_id);
      const expected = plan.scopes.find((scope) => scope.scope_id === mapping.original_scope_id);
      if (row === undefined || expected === undefined || sqlText(rowValue(row, "kind"), "transfer-scope-kind") !== expected.kind) throw new StoreError("transfer_conflict");
      const targetPolicy = this.database.prepare("SELECT capture_paused, capture_policy_enrolled FROM scope_policy WHERE scope_id = ?").get(mapping.target_scope_id);
      if (targetPolicy === undefined) throw new StoreError("schema_invalid");
      if (sqlInteger(rowValue(targetPolicy, "capture_paused"), "transfer-capture-paused") === 1n) throw new StoreError("transfer_blocked");
      if (
        sqlInteger(rowValue(targetPolicy, "capture_policy_enrolled"), "transfer-capture-policy-enrolled") === 1n &&
        this.database.prepare("SELECT 1 AS present FROM scope_capture_policy WHERE scope_id = ? AND source_class = 'assistant_output'").get(mapping.target_scope_id) === undefined
      ) throw new StoreError("transfer_blocked");
      if (this.database.prepare("SELECT 1 AS present FROM purge_operation WHERE scope_id = ? AND state <> 'completed' LIMIT 1").get(mapping.target_scope_id) !== undefined) throw new StoreError("transfer_blocked");
      if (this.database.prepare("SELECT 1 AS present FROM scope_output_grant WHERE scope_id = ? AND output_target = 'export:jsonl' AND source_class = 'assistant_output'").get(mapping.target_scope_id) === undefined) throw new StoreError("output_not_allowed");
    }
    for (const source of plan.sources) {
      if (this.database.prepare("SELECT 1 AS present FROM capture_replay_marker WHERE capture_id = ?").get(source.capture_id) !== undefined || this.database.prepare("SELECT 1 AS present FROM purge_tombstone WHERE capture_id = ?").get(source.capture_id) !== undefined) throw new StoreError("transfer_blocked");
      const existing = this.database.prepare("SELECT scope_id, fingerprint, payload_json, event_json FROM source_event WHERE capture_id = ?").get(source.capture_id);
      if (existing === undefined) continue;
      const storedEvent = transferJsonObject(sqlText(rowValue(existing, "event_json"), "transfer-source-event"), "transfer-source-event");
      const storedProvenance = storedEvent.transfer_provenance;
      const storedOriginal = typeof storedProvenance === "object" && storedProvenance !== null && "original_event" in storedProvenance ? storedProvenance.original_event : undefined;
      if (storedOriginal === undefined || !transferJsonEqual(transferCanonicalJson(storedOriginal), source.original_event_json)) addConflict(`source_original_event:${source.capture_id}`);
      if (sqlText(rowValue(existing, "scope_id"), "transfer-source-scope") !== source.target_scope_id || sqlText(rowValue(existing, "fingerprint"), "transfer-source-fingerprint") !== source.fingerprint || !transferJsonEqual(sqlText(rowValue(existing, "payload_json"), "transfer-source-payload"), source.payload_json) || !transferJsonEqual(sqlText(rowValue(existing, "event_json"), "transfer-source-event"), source.event_json, true)) addConflict(`source:${source.capture_id}`);
      else {
        duplicates += 1;
        for (const span of source.spans) if (this.database.prepare("SELECT 1 AS present FROM source_span WHERE span_id = ?").get(span.span_id) === undefined) addConflict(`source_span_missing:${span.span_id}`);
      }
    }
    if (plan.sources.length > 0) for (const mapping of plan.scope_map) {
      if (this.database.prepare(
        `SELECT 1 AS present FROM session
           WHERE scope_id = ? AND host_kind = ? AND surface = ?
             AND execution_domain_kind = ? AND execution_domain_id = ?
             AND host_instance_id = ? AND host_session_id = ?`,
      ).get(mapping.target_scope_id, binding.host_kind, binding.surface, binding.execution_domain.kind, binding.execution_domain.id, binding.host_instance_id, binding.host_session_id) === undefined) throw new StoreError("session_not_registered");
    }
    for (const source of plan.sources) for (const span of source.spans) {
      const existing = this.database.prepare("SELECT source_id, scope_id, root, path, start_utf16, end_utf16, digest FROM source_span WHERE span_id = ?").get(span.span_id);
      if (existing === undefined) continue;
      const existingStart = sqlInteger(rowValue(existing, "start_utf16"), "transfer-span-start").toString(10);
      const existingEnd = sqlInteger(rowValue(existing, "end_utf16"), "transfer-span-end").toString(10);
      if (rowValue(existing, "source_id") !== span.source_id || rowValue(existing, "scope_id") !== span.scope_id || rowValue(existing, "root") !== span.root || rowValue(existing, "path") !== span.path || existingStart !== String(span.start_utf16) || existingEnd !== String(span.end_utf16) || rowValue(existing, "digest") !== span.digest) addConflict(`span:${span.span_id}`);
      else duplicates += 1;
    }
    for (const entity of plan.entities) {
      const existing = this.database.prepare("SELECT label FROM entity WHERE scope_id = ? AND entity_id = ?").get(entity.target_scope_id, entity.entity_id);
      if (existing !== undefined && rowValue(existing, "label") !== entity.label) addConflict(`entity:${entity.entity_id}`);
      else if (existing !== undefined) duplicates += 1;
    }
    for (const item of plan.items) {
      const existing = this.database.prepare("SELECT kind, entity_id, predicate, qualifiers_json, qualifiers_digest, cardinality, current_revision_id FROM memory_item WHERE scope_id = ? AND item_id = ?").get(item.target_scope_id, item.item_id);
      if (existing !== undefined && (rowValue(existing, "kind") !== item.kind || rowValue(existing, "entity_id") !== item.entity_id || rowValue(existing, "predicate") !== item.predicate || rowValue(existing, "qualifiers_json") !== item.qualifiers_json || rowValue(existing, "qualifiers_digest") !== item.qualifiers_digest || rowValue(existing, "cardinality") !== item.cardinality)) addConflict(`item:${item.item_id}`);
      else if (existing !== undefined) duplicates += 1;
      if (existing !== undefined) {
        const stored = this.database.prepare("SELECT revision_id FROM memory_revision WHERE scope_id = ? AND item_id = ?").all(item.target_scope_id, item.item_id).map((row) => String(row.revision_id));
        const incoming = plan.revisions.filter((revision) => revision.target_scope_id === item.target_scope_id && revision.item_id === item.item_id).map((revision) => revision.revision_id);
        if (rowValue(existing, "current_revision_id") !== item.current_revision_id || !sameKeys(stored, incoming)) addConflict(`item_history:${item.item_id}`);
      }
    }
    for (const revision of plan.revisions) {
      const existing = this.database.prepare("SELECT item_id, parent_revision_id, operation, content_json, content_digest, meaning_json FROM memory_revision WHERE scope_id = ? AND revision_id = ?").get(revision.target_scope_id, revision.revision_id);
      if (existing !== undefined && (rowValue(existing, "item_id") !== revision.item_id || rowValue(existing, "parent_revision_id") !== revision.parent_revision_id || rowValue(existing, "operation") !== revision.operation || rowValue(existing, "content_json") !== revision.content_json || rowValue(existing, "content_digest") !== revision.content_digest || rowValue(existing, "meaning_json") !== revision.meaning_json)) addConflict(`revision:${revision.revision_id}`);
      else if (existing !== undefined) duplicates += 1;
      if (existing !== undefined) {
        const stored = this.database.prepare("SELECT source_capture_id, source_span_id FROM revision_source WHERE scope_id = ? AND revision_id = ?").all(revision.target_scope_id, revision.revision_id).map((row) => JSON.stringify([row.source_capture_id, row.source_span_id]));
        const incoming = plan.revisionSources.filter((source) => source.target_scope_id === revision.target_scope_id && source.revision_id === revision.revision_id).map((source) => JSON.stringify([source.source_capture_id, source.source_span_id]));
        if (!sameKeys(stored, incoming)) addConflict(`revision_history:${revision.revision_id}`);
        inspectDependencies(revision.target_scope_id, "memory_revision", revision.revision_id);
      }
    }
    for (const source of plan.revisionSources) {
      const existing = this.database.prepare("SELECT source_capture_id FROM revision_source WHERE scope_id = ? AND revision_id = ? AND source_span_id = ?").get(source.target_scope_id, source.revision_id, source.source_span_id);
      if (existing !== undefined && rowValue(existing, "source_capture_id") !== source.source_capture_id) addConflict(`revision_source:${source.revision_id}:${source.source_span_id}`);
      else if (existing !== undefined) duplicates += 1;
    }
    for (const artifact of plan.derived) {
      const existing = this.database.prepare("SELECT artifact_id, kind, content_json, content_digest FROM derived_artifact WHERE scope_id = ? AND revision_id = ?").get(artifact.target_scope_id, artifact.revision_id);
      if (existing !== undefined && (rowValue(existing, "artifact_id") !== artifact.artifact_id || rowValue(existing, "kind") !== artifact.kind || rowValue(existing, "content_json") !== artifact.content_json || rowValue(existing, "content_digest") !== artifact.content_digest)) addConflict(`derived:${artifact.revision_id}`);
      else if (existing !== undefined) duplicates += 1;
      if (existing !== undefined) inspectDependencies(artifact.target_scope_id, "derived_artifact", artifact.revision_id);
    }
    for (const dependency of plan.dependencies) {
      const existing = this.database.prepare("SELECT relation FROM dependency WHERE scope_id = ? AND child_type = ? AND child_revision_id = ? AND parent_type = ? AND parent_revision_id = ?").get(dependency.target_scope_id, dependency.child_type, dependency.child_revision_id, dependency.parent_type, dependency.parent_revision_id);
      if (existing !== undefined && rowValue(existing, "relation") !== dependency.relation) addConflict(`dependency:${dependency.child_revision_id}:${dependency.parent_revision_id}`);
      else if (existing !== undefined) duplicates += 1;
    }
    const total = plan.sources.length + plan.sources.reduce((count, source) => count + source.spans.length, 0) + plan.entities.length + plan.items.length + plan.revisions.length + plan.revisionSources.length + plan.derived.length + plan.dependencies.length;
    const downgraded = plan.items.filter((item) => item.claimed_status !== "candidate").length + plan.derived.filter((artifact) => artifact.claimed_status !== "blocked").length;
    return { inserted: 0, duplicates, downgraded, dependency_count: plan.dependencies.length, no_op: total === 0 || (conflicts.length === 0 && duplicates === total), conflicts };
  }

  getScopePrivacyEpoch(scopeId: string): string {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    const row = this.database
      .prepare("SELECT privacy_epoch FROM scope WHERE scope_id = ?")
      .get(parsedScopeId);
    if (row === undefined) throw new StoreError("scope_not_registered");
    return sqlInteger(rowValue(row, "privacy_epoch"), "privacy_epoch").toString(10);
  }

  isCapturePaused(scopeId: string): boolean {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    const row = this.database
      .prepare("SELECT capture_paused FROM scope_policy WHERE scope_id = ?")
      .get(parsedScopeId);
    if (row === undefined) throw new StoreError("schema_invalid");
    return sqlInteger(rowValue(row, "capture_paused"), "capture_paused") === 1n;
  }

  getScopeCapturePolicy(scopeId: string): ScopeCapturePolicyState {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    const policy = this.database
      .prepare("SELECT capture_policy_enrolled FROM scope_policy WHERE scope_id = ?")
      .get(parsedScopeId);
    if (policy === undefined) throw new StoreError("scope_not_registered");
    const enrolled = sqlInteger(rowValue(policy, "capture_policy_enrolled"), "capture-policy-enrolled") === 1n;
    const rows = this.database
      .prepare(
        `SELECT source_class, retention_mode, retention_seconds, selected_at
           FROM scope_capture_policy
          WHERE scope_id = ?
          ORDER BY source_class`,
      )
      .all(parsedScopeId);
    if (rows.length > 6 || (!enrolled && rows.length > 0)) throw new StoreError("schema_invalid");
    return {
      enrolled,
      selections: rows.map((row) => {
        const sourceClass = parseContract(evidenceClassSchema, rowValue(row, "source_class"), "capture-policy-source-class");
        const mode = parseContract(z.enum(["until_deleted", "finite"]), rowValue(row, "retention_mode"), "capture-policy-retention-mode");
        const seconds = rowValue(row, "retention_seconds");
        const selectedAt = parseContract(z.iso.datetime({ offset: true }), rowValue(row, "selected_at"), "capture-policy-selected-at");
        if (mode === "until_deleted") {
          if (seconds !== null) throw new StoreError("schema_invalid");
          return { source_class: sourceClass, retention: { mode }, selected_at: selectedAt };
        }
        if (seconds === null) throw new StoreError("schema_invalid");
        const durationSeconds = sqlInteger(seconds, "capture-policy-retention-seconds");
        if (durationSeconds < 1n || durationSeconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoreError("schema_invalid");
        return { source_class: sourceClass, retention: { mode, duration_seconds: Number(durationSeconds) }, selected_at: selectedAt };
      }),
    };
  }

  replaceScopeCapturePolicy(
    binding: PolicySetupBinding,
    scopeId: string,
    selections: readonly ScopeCaptureSelection[],
    updatedAt: string,
  ): string {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    requirePolicySetup(binding, parsedScopeId, "purge_scope_not_allowed");
    const parsedAt = parseContract(z.iso.datetime({ offset: true }), updatedAt, "policy-updated-at");
    let parsedSelections: readonly ScopeCaptureSelection[];
    try {
      parsedSelections = parseScopeCapturePolicy(selections);
    } catch (error: unknown) {
      throw new StoreError("policy_invalid", error);
    }

    for (const selection of parsedSelections) {
      if (selection.retention.mode === "finite") captureExpiryAt(this.wallClockNow(), BigInt(selection.retention.duration_seconds));
    }

    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const scope = this.database
        .prepare("SELECT s.privacy_epoch, p.capture_paused FROM scope AS s JOIN scope_policy AS p ON p.scope_id = s.scope_id WHERE s.scope_id = ?")
        .get(parsedScopeId);
      if (scope === undefined) throw new StoreError("scope_not_registered");
      const nextEpoch = nextPrivacyEpoch(sqlInteger(rowValue(scope, "privacy_epoch"), "privacy_epoch"));
      const wasPaused = sqlInteger(rowValue(scope, "capture_paused"), "capture-paused") === 1n;
      this.database.prepare("DELETE FROM scope_capture_policy WHERE scope_id = ?").run(parsedScopeId);
      const insert = this.database.prepare(
        `INSERT INTO scope_capture_policy (scope_id, source_class, retention_mode, retention_seconds, selected_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const selection of parsedSelections) {
        insert.run(
          parsedScopeId,
          selection.source_class,
          selection.retention.mode,
          selection.retention.mode === "finite" ? BigInt(selection.retention.duration_seconds) : null,
          parsedAt,
        );
      }
      const policyUpdated = this.database
        .prepare("UPDATE scope_policy SET capture_policy_enrolled = 1, capture_paused = ?, updated_at = ? WHERE scope_id = ?")
        .run(parsedSelections.length === 0 ? 1 : wasPaused ? 1 : 0, parsedAt, parsedScopeId);
      if (sqlInteger(policyUpdated.changes, "policy_changes") !== 1n) throw new StoreError("policy_invalid");
      const scopeUpdated = this.database
        .prepare("UPDATE scope SET privacy_epoch = ? WHERE scope_id = ?")
        .run(nextEpoch, parsedScopeId);
      if (sqlInteger(scopeUpdated.changes, "scope_changes") !== 1n) throw new StoreError("policy_invalid");
      this.database.exec("COMMIT");
      committed = true;
      return nextEpoch.toString(10);
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the policy failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("policy_invalid", error);
    }
  }

  /** Enroll an installed scope with deny-all capture until explicit selection. */
  enrollScopeCapturePolicy(binding: PolicySetupBinding, scopeId: string, updatedAt: string): string {
    return this.replaceScopeCapturePolicy(binding, scopeId, [], updatedAt);
  }

  /** Bounded future-owner selector; expiry itself is intentionally not scheduled here. */
  selectDueCaptures(scopeId: string, now = this.wallClockNow(), limit = 128): readonly DueCapture[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "capture-due-scope");
    const parsedNow = parseContract(z.iso.datetime({ offset: true }), now, "capture-due-now");
    const parsedLimit = parseContract(z.number().int().min(1).max(128), limit, "capture-due-limit");
    if (this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(parsedScopeId) === undefined) {
      throw new StoreError("scope_not_registered");
    }
    const nowMilliseconds = Date.parse(parsedNow);
    if (!Number.isFinite(nowMilliseconds)) throw new StoreError("policy_invalid");
    return this.database
      .prepare(
        `SELECT a.capture_id, a.scope_id, e.evidence_class, a.accepted_at, a.retention_seconds
           FROM capture_acceptance AS a
           JOIN source_event AS e ON e.scope_id = a.scope_id AND e.capture_id = a.capture_id
          WHERE a.scope_id = ? AND a.retention_seconds IS NOT NULL
          ORDER BY julianday(a.accepted_at) + CAST(a.retention_seconds AS REAL) / 86400.0, a.capture_id
          LIMIT ?`,
      )
      .all(parsedScopeId, parsedLimit)
      .flatMap((row) => {
        const acceptedAt = parseContract(z.iso.datetime({ offset: true }), rowValue(row, "accepted_at"), "capture-accepted-at");
        const acceptedMilliseconds = Date.parse(acceptedAt);
        const durationSeconds = sqlInteger(rowValue(row, "retention_seconds"), "capture-policy-retention-seconds");
        if (!Number.isFinite(acceptedMilliseconds) || durationSeconds < 1n) throw new StoreError("schema_invalid");
        const expiresAt = captureExpiryAt(acceptedAt, durationSeconds);
        if (nowMilliseconds < Date.parse(expiresAt)) return [];
        return [{
          capture_id: parseContract(z.uuid(), rowValue(row, "capture_id"), "capture-due-capture"),
          scope_id: parseContract(z.uuid(), rowValue(row, "scope_id"), "capture-due-scope-row"),
          source_class: parseContract(evidenceClassSchema, rowValue(row, "evidence_class"), "capture-due-source-class"),
          accepted_at: acceptedAt,
          expires_at: expiresAt,
        }];
      });
  }

  replaceScopeOutputGrants(
    binding: PolicySetupBinding,
    scopeId: string,
    grants: readonly ScopeOutputGrant[],
    updatedAt: string,
  ): string {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    requirePolicySetup(binding, parsedScopeId, "purge_scope_not_allowed");
    const parsedAt = parseContract(z.iso.datetime({ offset: true }), updatedAt, "policy-updated-at");
    let parsedGrants: readonly ScopeOutputGrant[];
    try {
      parsedGrants = parseScopeOutputGrants(grants);
    } catch (error: unknown) {
      throw new StoreError("policy_invalid", error);
    }
    for (const grant of parsedGrants) policyTargetAllowed(binding, grant.target);

    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const scope = this.database
        .prepare("SELECT privacy_epoch FROM scope WHERE scope_id = ?")
        .get(parsedScopeId);
      if (scope === undefined) throw new StoreError("scope_not_registered");
      if (this.database.prepare("SELECT 1 AS present FROM scope_policy WHERE scope_id = ?").get(parsedScopeId) === undefined) {
        throw new StoreError("schema_invalid");
      }
      const nextEpoch = nextPrivacyEpoch(sqlInteger(rowValue(scope, "privacy_epoch"), "privacy_epoch"));
      this.database.prepare("DELETE FROM scope_output_grant WHERE scope_id = ?").run(parsedScopeId);
      const insert = this.database.prepare(
        "INSERT INTO scope_output_grant (scope_id, output_target, source_class, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const grant of parsedGrants) {
        for (const sourceClass of grant.source_classes) {
          insert.run(parsedScopeId, grant.target, sourceClass, parsedAt);
        }
      }
      const updated = this.database
        .prepare("UPDATE scope SET privacy_epoch = ? WHERE scope_id = ?")
        .run(nextEpoch, parsedScopeId);
      if (sqlInteger(updated.changes, "scope_changes") !== 1n) throw new StoreError("policy_invalid");
      const policyUpdated = this.database
        .prepare("UPDATE scope_policy SET updated_at = ? WHERE scope_id = ?")
        .run(parsedAt, parsedScopeId);
      if (sqlInteger(policyUpdated.changes, "policy_changes") !== 1n) throw new StoreError("policy_invalid");
      this.database.exec("COMMIT");
      committed = true;
      return nextEpoch.toString(10);
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the policy failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("policy_invalid", error);
    }
  }

  setCapturePaused(binding: PolicySetupBinding, scopeId: string, paused: boolean, updatedAt: string): string {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "scope-id");
    requirePolicySetup(binding, parsedScopeId, "purge_scope_not_allowed");
    const parsedAt = parseContract(z.iso.datetime({ offset: true }), updatedAt, "policy-updated-at");
    if (typeof paused !== "boolean") throw new StoreError("policy_invalid");

    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT s.privacy_epoch, p.capture_paused, p.capture_policy_enrolled FROM scope AS s JOIN scope_policy AS p ON p.scope_id = s.scope_id WHERE s.scope_id = ?")
        .get(parsedScopeId);
      if (row === undefined) throw new StoreError("scope_not_registered");
      const wasPaused = sqlInteger(rowValue(row, "capture_paused"), "capture_paused") === 1n;
      const currentEpoch = sqlInteger(rowValue(row, "privacy_epoch"), "privacy_epoch");
      const enrolled = sqlInteger(rowValue(row, "capture_policy_enrolled"), "capture-policy-enrolled") === 1n;
      if (!paused && enrolled && this.database.prepare("SELECT 1 AS present FROM scope_capture_policy WHERE scope_id = ? LIMIT 1").get(parsedScopeId) === undefined) {
        throw new StoreError("policy_invalid");
      }
      if (wasPaused === paused) {
        this.database.exec("COMMIT");
        committed = true;
        return currentEpoch.toString(10);
      }
      const nextEpoch = nextPrivacyEpoch(currentEpoch);
      const policyUpdated = this.database
        .prepare("UPDATE scope_policy SET capture_paused = ?, updated_at = ? WHERE scope_id = ?")
        .run(paused ? 1 : 0, parsedAt, parsedScopeId);
      if (sqlInteger(policyUpdated.changes, "policy_changes") !== 1n) throw new StoreError("policy_invalid");
      const scopeUpdated = this.database
        .prepare("UPDATE scope SET privacy_epoch = ? WHERE scope_id = ?")
        .run(nextEpoch, parsedScopeId);
      if (sqlInteger(scopeUpdated.changes, "scope_changes") !== 1n) throw new StoreError("policy_invalid");
      this.database.exec("COMMIT");
      committed = true;
      return nextEpoch.toString(10);
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the policy failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("policy_invalid", error);
    }
  }

  getSourceForOutput(captureId: string, binding: PolicyOutputBinding): StoredSource | undefined {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("policy_invalid");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "capture-id");
    const row = this.database
      .prepare(
        `SELECT e.capture_id, e.scope_id, e.commit_seq, e.data_epoch, e.fingerprint,
                e.captured_at, e.payload_json, e.event_json, e.coverage_json
           FROM source_event AS e
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE e.capture_id = ? AND e.scope_id = ? AND t.capture_id IS NULL`,
      )
      .get(binding.target, parsedCaptureId, binding.scope_id);
    if (row === undefined) return undefined;
    return {
      capture_id: sqlText(rowValue(row, "capture_id"), "capture_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
      data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
      fingerprint: sqlText(rowValue(row, "fingerprint"), "fingerprint"),
      captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
      payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
      event_json: sqlText(rowValue(row, "event_json"), "event_json"),
      coverage_json: sqlText(rowValue(row, "coverage_json"), "coverage_json"),
    };
  }

  /**
   * Validate every source quote that an execution request intends to send.
   * The scope, provider grant and purge barrier are SQL predicates before the
   * payload/event JSON is read; the stored span digest then authenticates the
   * exact UTF-16 quote supplied by the caller.
   */
  assertExecutionSourceReferences(
    scopeId: string,
    captureId: string,
    providerTarget: string,
    references: readonly ExecutionSourceReference[],
  ): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "execution-source-scope");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "execution-source-capture");
    const parsedProviderTarget = parseContract(z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/), providerTarget, "execution-source-provider");
    if (references.length < 1 || references.length > 256) throw new StoreError("attempt_stale");
    const statement = this.database.prepare(
      `SELECT e.capture_id, e.scope_id, e.role, e.occurred_at, e.payload_json, e.event_json,
              s.span_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest
         FROM source_span AS s
         JOIN source_event AS e
           ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
         JOIN scope_output_grant AS g
           ON g.scope_id = e.scope_id
          AND g.output_target = ?
          AND g.source_class = e.evidence_class
         LEFT JOIN purge_tombstone AS t
           ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
        WHERE s.scope_id = ? AND s.source_id = ? AND s.span_id = ?
          AND e.scope_id = ? AND e.capture_id = ? AND t.capture_id IS NULL`,
    );
    for (const reference of references) {
      const spanId = parseContract(z.uuid(), reference.source_span_id, "execution-source-span");
      const referenceScope = parseContract(z.uuid(), reference.scope_id, "execution-source-reference-scope");
      const referenceCapture = parseContract(z.uuid(), reference.capture_id, "execution-source-reference-capture");
      if (referenceScope !== parsedScopeId || referenceCapture !== parsedCaptureId || typeof reference.role !== "string" || typeof reference.text !== "string" || reference.text.length === 0) {
        throw new StoreError("attempt_stale");
      }
      const row = statement.get(parsedProviderTarget, parsedScopeId, parsedCaptureId, spanId, parsedScopeId, parsedCaptureId);
      if (row === undefined) throw new StoreError("attempt_stale");
      if (sqlText(rowValue(row, "role"), "execution-source-role") !== reference.role) throw new StoreError("attempt_stale");
      const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "execution-source-payload"), "execution-source-payload");
      const event = jsonObject(sqlText(rowValue(row, "event_json"), "execution-source-event"), "execution-source-event");
      const root = sourceSpanRoot(rowValue(row, "root"), "execution-source-root");
      const path = sqlText(rowValue(row, "path"), "execution-source-path");
      const start = safeSpanOffset(rowValue(row, "start_utf16"), "execution-source-start");
      const end = safeSpanOffset(rowValue(row, "end_utf16"), "execution-source-end");
      const digest = sqlText(rowValue(row, "digest"), "execution-source-digest");
      let quote: string;
      try {
        quote = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
      } catch (error: unknown) {
        throw new StoreError("attempt_stale", error);
      }
      if (quote !== reference.text) throw new StoreError("attempt_stale");
      if (reference.occurred_at !== undefined) {
        const storedOccurred = nullableSqlTextOrNull(rowValue(row, "occurred_at"), "execution-source-occurred");
        const requestedOccurred = Date.parse(reference.occurred_at);
        if (storedOccurred === null || !Number.isFinite(requestedOccurred) || Date.parse(storedOccurred) !== requestedOccurred) throw new StoreError("attempt_stale");
      }
    }
  }

  /** Validate a bounded, authorized closure that may span several captures. */
  assertExecutionSourceClosure(
    scopeId: string,
    providerTarget: string,
    references: readonly ExecutionSourceReference[],
  ): void {
    this.ensureOpen();
    if (references.length < 1 || references.length > 256) throw new StoreError("attempt_stale");
    const byCapture = new Map<string, ExecutionSourceReference[]>();
    for (const reference of references) {
      const capture = parseContract(z.uuid(), reference.capture_id, "execution-closure-capture");
      const current = byCapture.get(capture) ?? [];
      current.push(reference);
      byCapture.set(capture, current);
    }
    for (const [captureId, captureReferences] of byCapture) {
      this.assertExecutionSourceReferences(scopeId, captureId, providerTarget, captureReferences);
    }
  }

  /** Read the complete, still-authorized source-span closure for one extract job. */
  getExtractionSourceBatch(
    scopeId: string,
    captureId: string,
    providerTarget: string,
    maxSpans = 256,
  ): readonly ExecutionSourceReference[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "extraction-source-scope");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "extraction-source-capture");
    const parsedProviderTarget = parseContract(z.string().regex(/^provider:[A-Za-z0-9._/-]{1,120}$/), providerTarget, "extraction-source-provider");
    if (!Number.isSafeInteger(maxSpans) || maxSpans < 1 || maxSpans > 256) throw new StoreError("attempt_stale");
    const rows = this.database
      .prepare(
        `WITH primary_source AS (
               SELECT native_session_id, native_turn_id
                 FROM source_event
                WHERE scope_id = ? AND capture_id = ?
             )
         SELECT e.capture_id, e.scope_id, e.role, e.evidence_class, e.captured_at, e.occurred_at, e.payload_json, e.event_json,
                s.span_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest
           FROM source_span AS s
           JOIN source_event AS e
             ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE s.scope_id = ? AND t.capture_id IS NULL
            AND (
              s.source_id = ? OR EXISTS (
                SELECT 1 FROM primary_source AS p
                 WHERE p.native_session_id IS NOT NULL
                   AND e.native_session_id = p.native_session_id
                   AND p.native_turn_id IS NOT NULL
                   AND e.native_turn_id = p.native_turn_id
              )
            )
          ORDER BY e.commit_seq, s.rowid
          LIMIT ?`,
      )
      .all(parsedScopeId, parsedCaptureId, parsedProviderTarget, parsedScopeId, parsedCaptureId, maxSpans + 1);
    if (rows.length === 0 || rows.length > maxSpans) throw new StoreError("attempt_stale");
    return rows.map((row) => {
      const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "extraction-source-payload"), "extraction-source-payload");
      const event = jsonObject(sqlText(rowValue(row, "event_json"), "extraction-source-event"), "extraction-source-event");
      const root = sourceSpanRoot(rowValue(row, "root"), "extraction-source-root");
      const path = sqlText(rowValue(row, "path"), "extraction-source-path");
      const start = safeSpanOffset(rowValue(row, "start_utf16"), "extraction-source-start");
      const end = safeSpanOffset(rowValue(row, "end_utf16"), "extraction-source-end");
      const digest = sqlText(rowValue(row, "digest"), "extraction-source-digest");
      const text = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
      return {
        source_span_id: parseContract(z.uuid(), sqlText(rowValue(row, "span_id"), "extraction-source-span"), "extraction-source-span"),
        capture_id: parseContract(z.uuid(), sqlText(rowValue(row, "capture_id"), "extraction-source-capture"), "extraction-source-capture"),
        scope_id: parseContract(z.uuid(), sqlText(rowValue(row, "scope_id"), "extraction-source-scope"), "extraction-source-scope"),
        role: sqlText(rowValue(row, "role"), "extraction-source-role"),
        evidence_class: sqlText(rowValue(row, "evidence_class"), "extraction-source-class"),
        captured_at: sqlText(rowValue(row, "captured_at"), "extraction-source-captured"),
        ...(rowValue(row, "occurred_at") === null ? {} : { occurred_at: sqlText(rowValue(row, "occurred_at"), "extraction-source-occurred") }),
        text,
      } satisfies ExecutionSourceReference;
    });
  }

  enqueueExtractionContinuation(input: { readonly scope_id: string; readonly source_capture_id: string; readonly task_version: string; readonly input_fingerprint: string; readonly input_privacy_epoch: string; readonly created_commit_seq?: string }): { readonly job_id: string; readonly created: boolean } {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "continuation-scope");
    const captureId = parseContract(z.uuid(), input.source_capture_id, "continuation-source");
    const taskVersion = parseContract(extractionTaskVersionSchema, input.task_version, "continuation-version");
    const fingerprint = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.input_fingerprint, "continuation-fingerprint").toLowerCase();
    const privacy = parseContract(nonNegativeInt64Schema, input.input_privacy_epoch, "continuation-privacy");
    const createdSeq = input.created_commit_seq === undefined ? 0n : BigInt(parseContract(nonNegativeInt64Schema, input.created_commit_seq, "continuation-commit"));
    const dedupeKey = sha256(`${scopeId}\u0000${captureId}\u0000extract\u0000${taskVersion}`);
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const existing = this.database.prepare("SELECT job_id, scope_id, source_capture_id, task_version, input_fingerprint, input_privacy_epoch FROM job WHERE dedupe_key = ?").get(dedupeKey);
      if (existing !== undefined) {
        if (
          sqlText(rowValue(existing, "scope_id"), "continuation-scope") !== scopeId ||
          sqlText(rowValue(existing, "source_capture_id"), "continuation-source") !== captureId ||
          sqlText(rowValue(existing, "task_version"), "continuation-version") !== taskVersion ||
          sqlText(rowValue(existing, "input_fingerprint"), "continuation-fingerprint") !== fingerprint ||
          sqlText(rowValue(existing, "input_privacy_epoch"), "continuation-privacy") !== privacy
        ) throw new StoreError("attempt_conflict");
        const jobId = sqlText(rowValue(existing, "job_id"), "continuation-job-id");
        this.database.exec("COMMIT");
        committed = true;
        return { job_id: jobId, created: false };
      }
      this.database.prepare("INSERT INTO job (job_id, scope_id, source_capture_id, task_kind, task_version, state, dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq, input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, 0, NULL, NULL, NULL, 0, ?, ?, ?, NULL, NULL)").run(randomUUID(), scopeId, captureId, taskVersion, dedupeKey, createdSeq, fingerprint, privacy);
      const row = this.database.prepare("SELECT job_id FROM job WHERE dedupe_key = ?").get(dedupeKey);
      if (row === undefined) throw new StoreError("attempt_write_failed");
      const jobId = sqlText(rowValue(row, "job_id"), "continuation-job-id");
      this.database.exec("COMMIT");
      committed = true;
      return { job_id: jobId, created: true };
    } catch (error: unknown) {
      if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  beginExtractionBatch(input: {
    readonly batch_id?: string;
    readonly job: { readonly job_id: string; readonly scope_id: string; readonly source_capture_id: string; readonly task_version: string; readonly input_fingerprint: string; readonly input_privacy_epoch: string; readonly owner: string; readonly fence: string };
    readonly sources: readonly ExecutionSourceReference[];
    readonly source_token_count: number;
    readonly source_measurement_unit?: "tokens" | "utf8_bytes";
    readonly targets?: readonly Record<string, unknown>[];
    readonly continuation?: Record<string, unknown>;
  }): ExtractionBatchRecord {
    this.ensureOpen();
    const jobId = parseContract(z.uuid(), input.job.job_id, "extraction-job-id");
    const scopeId = parseContract(z.uuid(), input.job.scope_id, "extraction-job-scope");
    const captureId = parseContract(z.uuid(), input.job.source_capture_id, "extraction-job-source");
    const taskVersion = parseContract(extractionTaskVersionSchema, input.job.task_version, "extraction-job-version");
    const fingerprint = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.job.input_fingerprint, "extraction-job-fingerprint").toLowerCase();
    const privacyEpoch = parseContract(nonNegativeInt64Schema, input.job.input_privacy_epoch, "extraction-job-privacy");
    if (!Number.isSafeInteger(input.source_token_count) || input.source_token_count < 1 || input.source_token_count > 6000 || input.sources.length < 1 || input.sources.length > 256) throw new StoreError("attempt_stale");
    const batchId = parseContract(z.uuid(), input.batch_id ?? randomUUID(), "extraction-batch-id");
    const targetJson = JSON.stringify(input.targets ?? []);
    const continuationJson = input.continuation === undefined ? null : JSON.stringify(input.continuation);
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const currentJob = this.database.prepare("SELECT scope_id, source_capture_id, task_version, state, owner, fence, input_fingerprint, input_privacy_epoch FROM job WHERE job_id = ? AND task_kind = 'extract'").get(jobId);
      if (currentJob === undefined || sqlText(rowValue(currentJob, "scope_id"), "extraction-job-scope") !== scopeId || sqlText(rowValue(currentJob, "source_capture_id"), "extraction-job-source") !== captureId || sqlText(rowValue(currentJob, "task_version"), "extraction-job-task-version") !== taskVersion || sqlText(rowValue(currentJob, "state"), "extraction-job-state") !== "running" || sqlText(rowValue(currentJob, "owner"), "extraction-job-owner") !== input.job.owner || sqlInteger(rowValue(currentJob, "fence"), "extraction-job-fence").toString(10) !== input.job.fence || sqlText(rowValue(currentJob, "input_fingerprint"), "extraction-job-input") !== fingerprint || sqlText(rowValue(currentJob, "input_privacy_epoch"), "extraction-job-privacy") !== privacyEpoch) throw new StoreError("attempt_stale");
      const existing = this.database.prepare("SELECT batch_id FROM extraction_batch WHERE job_id = ?").get(jobId);
      if (existing !== undefined) {
        const existingId = sqlText(rowValue(existing, "batch_id"), "extraction-batch-existing");
        if (existingId !== batchId) throw new StoreError("attempt_conflict");
        // The frozen batch is immutable: a replayed begin must present exactly
        // the same frozen source closure, measurement, targets and continuation
        // pointer; any divergence is a conflict, never a silent rewrite.
        const record = this.readExtractionBatchLocked(batchId);
        const storedSources = this.database.prepare("SELECT ordinal, span_id, capture_id, scope_id, source_digest FROM extraction_batch_source WHERE batch_id = ? ORDER BY ordinal").all(batchId);
        if (storedSources.length !== input.sources.length) throw new StoreError("attempt_conflict");
        for (const [ordinal, source] of input.sources.entries()) {
          const row = storedSources[ordinal];
          if (row === undefined) throw new StoreError("attempt_conflict");
          if (
            Number(sqlInteger(rowValue(row, "ordinal"), "extraction-source-ordinal")) !== ordinal ||
            sqlText(rowValue(row, "span_id"), "extraction-source-span") !== source.source_span_id ||
            sqlText(rowValue(row, "capture_id"), "extraction-source-capture") !== source.capture_id ||
            sqlText(rowValue(row, "scope_id"), "extraction-source-scope") !== source.scope_id ||
            sqlText(rowValue(row, "source_digest"), "extraction-source-digest") !== sha256(source.text)
          ) throw new StoreError("attempt_conflict");
        }
        const storedMeta = this.database.prepare("SELECT source_token_count, source_measurement_unit, target_json, continuation_json FROM extraction_batch WHERE batch_id = ?").get(batchId);
        if (storedMeta === undefined) throw new StoreError("attempt_not_found");
        if (Number(sqlInteger(rowValue(storedMeta, "source_token_count"), "extraction-token-count")) !== input.source_token_count) throw new StoreError("attempt_conflict");
        if (sqlText(rowValue(storedMeta, "source_measurement_unit"), "extraction-measurement-unit") !== (input.source_measurement_unit ?? "utf8_bytes")) throw new StoreError("attempt_conflict");
        if (sqlText(rowValue(storedMeta, "target_json"), "extraction-target-json") !== JSON.stringify(input.targets ?? [])) throw new StoreError("attempt_conflict");
        const storedContinuation = rowValue(storedMeta, "continuation_json");
        if (input.continuation === undefined) {
          if (storedContinuation !== null) throw new StoreError("attempt_conflict");
        } else if (storedContinuation === null || sqlText(storedContinuation, "extraction-continuation-json") !== JSON.stringify(input.continuation)) {
          throw new StoreError("attempt_conflict");
        }
        this.database.exec("COMMIT");
        committed = true;
        return record;
      }
      this.database.prepare(
        `INSERT INTO extraction_batch (
           batch_id, job_id, scope_id, source_capture_id, task_version,
           input_fingerprint, input_privacy_epoch, source_token_count, source_measurement_unit,
           continuation_json, target_json, state, extraction_digest,
           verification_digest, completion_receipt_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, NULL,
                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).run(batchId, jobId, scopeId, captureId, taskVersion, fingerprint, privacyEpoch, input.source_token_count, input.source_measurement_unit ?? "utf8_bytes", continuationJson, targetJson);
      const sourceInsert = this.database.prepare(
        `INSERT INTO extraction_batch_source (
           batch_id, ordinal, scope_id, capture_id, span_id, source_digest,
           role, evidence_class, captured_at, occurred_at, text
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const seen = new Set<string>();
      input.sources.forEach((source, ordinal) => {
        const sourceScope = parseContract(z.uuid(), source.scope_id, "extraction-source-scope");
        const sourceCapture = parseContract(z.uuid(), source.capture_id, "extraction-source-capture");
        const span = parseContract(z.uuid(), source.source_span_id, "extraction-source-span");
        const key = `${sourceScope}\u0000${sourceCapture}\u0000${span}`;
        if (seen.has(key) || sourceScope !== scopeId) throw new StoreError("attempt_stale");
        seen.add(key);
        const sourceDigest = sha256(source.text);
        sourceInsert.run(batchId, ordinal, sourceScope, sourceCapture, span, sourceDigest, source.role, source.evidence_class ?? "prompt", source.captured_at ?? new Date().toISOString(), source.occurred_at ?? null, source.text);
      });
      const record = this.readExtractionBatchLocked(batchId);
      this.database.exec("COMMIT");
      committed = true;
      return record;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the primary error */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  getExtractionBatchSources(batchId: string): readonly ExecutionSourceReference[] {
    this.ensureOpen();
    const parsedId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    const rows = this.database.prepare("SELECT span_id, capture_id, scope_id, role, evidence_class, captured_at, occurred_at, text FROM extraction_batch_source WHERE batch_id = ? ORDER BY ordinal").all(parsedId);
    if (rows.length === 0) throw new StoreError("attempt_not_found");
    return rows.map((row) => ({
      source_span_id: parseContract(z.uuid(), sqlText(rowValue(row, "span_id"), "extraction-span"), "extraction-span"),
      capture_id: parseContract(z.uuid(), sqlText(rowValue(row, "capture_id"), "extraction-capture"), "extraction-capture"),
      scope_id: parseContract(z.uuid(), sqlText(rowValue(row, "scope_id"), "extraction-scope"), "extraction-scope"),
      role: sqlText(rowValue(row, "role"), "extraction-role"),
      evidence_class: sqlText(rowValue(row, "evidence_class"), "extraction-class"),
      captured_at: sqlText(rowValue(row, "captured_at"), "extraction-captured"),
      ...(rowValue(row, "occurred_at") === null ? {} : { occurred_at: sqlText(rowValue(row, "occurred_at"), "extraction-occurred") }),
      text: sqlText(rowValue(row, "text"), "extraction-text"),
    }));
  }

  /**
   * Validate that the named attempt is a durably reconciled, completed record
   * of this batch and phase whose persisted result digest matches. Every
   * extraction result must be written through exactly such a binding.
   */
  private assertReconciledExtractionAttempt(batchId: string, phase: "extract" | "verify", attemptId: string, resultDigest: string): void {
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    const parsedAttemptId = parseContract(z.uuid(), attemptId, "extraction-attempt-id");
    const parsedDigest = parseContract(extractionDigestSchema, resultDigest, "extraction-result-digest").toLowerCase();
    const attempt = this.attempts.getAttempt(parsedAttemptId);
    if (
      attempt === undefined ||
      attempt.batch_id !== parsedBatchId ||
      attempt.phase !== phase ||
      attempt.state !== "reconciled" ||
      attempt.terminal_status !== "completed" ||
      attempt.result_digest !== parsedDigest ||
      attempt.result_receipt_json === null
    ) throw new StoreError("attempt_conflict");
  }

  storeExtractionCandidates(batchId: string, candidates: readonly { readonly candidate_id: string; readonly candidate_digest: string; readonly candidate_json: string }[], extractionDigest: string, extractBinding: { readonly attempt_id: string; readonly result_digest: string }): void {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    const parsedDigest = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), extractionDigest, "extraction-digest").toLowerCase();
    if (candidates.length > 128) throw new StoreError("attempt_stale");
    this.assertReconciledExtractionAttempt(parsedBatchId, "extract", extractBinding.attempt_id, extractBinding.result_digest);
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const batch = this.readExtractionBatchLocked(parsedBatchId);
      if (batch.state !== "prepared" && batch.state !== "extracted") throw new StoreError("attempt_conflict");
      if (batch.extract_attempt_id === null) {
        if (batch.state !== "prepared") throw new StoreError("attempt_conflict");
        const bound = this.database.prepare("UPDATE extraction_batch SET extract_attempt_id = ?, extract_result_digest = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ? AND extract_attempt_id IS NULL AND state = 'prepared'").run(extractBinding.attempt_id, extractBinding.result_digest.toLowerCase(), parsedBatchId);
        if (sqlInteger(bound.changes, "extraction-extract-bind-changes") !== 1n) throw new StoreError("attempt_conflict");
      } else if (batch.extract_attempt_id !== extractBinding.attempt_id || batch.extract_result_digest !== extractBinding.result_digest.toLowerCase()) {
        throw new StoreError("attempt_conflict");
      }
      const insert = this.database.prepare("INSERT OR IGNORE INTO extraction_candidate (batch_id, candidate_id, candidate_digest, candidate_json, state, created_at) VALUES (?, ?, ?, ?, 'candidate', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
      for (const candidate of candidates) {
        const id = parseContract(z.uuid(), candidate.candidate_id, "candidate-id");
        const digest = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), candidate.candidate_digest, "candidate-digest").toLowerCase();
        if (typeof candidate.candidate_json !== "string" || candidate.candidate_json.length === 0 || candidate.candidate_json.length > 16_384) throw new StoreError("attempt_stale");
        let parsedCandidate: ReturnType<typeof parseExtractionCandidate>;
        try { parsedCandidate = parseExtractionCandidate(JSON.parse(candidate.candidate_json) as unknown); } catch (error: unknown) { throw new StoreError("attempt_stale", error); }
        if (parsedCandidate.candidate_id !== id || parsedCandidate.candidate_digest !== digest) throw new StoreError("attempt_stale");
        insert.run(parsedBatchId, id, digest, candidate.candidate_json);
        const row = this.database.prepare("SELECT candidate_digest, candidate_json FROM extraction_candidate WHERE batch_id = ? AND candidate_id = ?").get(parsedBatchId, id);
        if (row === undefined || sqlText(rowValue(row, "candidate_digest"), "candidate-digest") !== digest || sqlText(rowValue(row, "candidate_json"), "candidate-json") !== candidate.candidate_json) throw new StoreError("attempt_conflict");
      }
      this.database.prepare("UPDATE extraction_batch SET state = 'extracted', extraction_digest = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ?").run(parsedDigest, parsedBatchId);
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  /** Derive verdicts only from the exact result reconciled by the verify attempt. */
  storeExtractionVerification(batchId: string, input: ExecutionResult, verifyBinding: { readonly attempt_id: string; readonly result_digest: string }): VerificationReceipt {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = parseExecutionResult(input);
      const batch = this.readExtractionBatchLocked(parsedBatchId);
      if (batch.state !== "extracted" && batch.state !== "verified") throw new StoreError("attempt_conflict");
      if (result.status !== "completed" || result.phase !== "verify" || result.job_id !== batch.job_id || result.attempt_id !== verifyBinding.attempt_id || executionResultDigest(result) !== verifyBinding.result_digest.toLowerCase()) throw new StoreError("attempt_conflict");
      this.assertReconciledExtractionAttempt(parsedBatchId, "verify", verifyBinding.attempt_id, verifyBinding.result_digest);
      const candidates = this.getExtractionCandidates(parsedBatchId).map((candidate) => parseExtractionCandidate(JSON.parse(candidate.candidate_json) as unknown));
      const spans = this.getExtractionBatchSources(parsedBatchId).map((source) => ({ ...source, role: source.role as SourceSpanForValidation["role"] }));
      const receipt = verifyExtractionCandidates(result.structured_output, candidates, spans, parsedBatchId);
      const receiptDigest = receipt.receipt_digest;
      if (batch.verify_attempt_id === null) {
        if (batch.state !== "extracted") throw new StoreError("attempt_conflict");
        const bound = this.database.prepare("UPDATE extraction_batch SET verify_attempt_id = ?, verify_result_digest = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ? AND verify_attempt_id IS NULL AND state = 'extracted'").run(verifyBinding.attempt_id, verifyBinding.result_digest.toLowerCase(), parsedBatchId);
        if (sqlInteger(bound.changes, "extraction-verify-bind-changes") !== 1n) throw new StoreError("attempt_conflict");
      } else if (batch.verify_attempt_id !== verifyBinding.attempt_id || batch.verify_result_digest !== verifyBinding.result_digest.toLowerCase()) {
        throw new StoreError("attempt_conflict");
      }
      const insert = this.database.prepare("INSERT OR IGNORE INTO extraction_verdict (batch_id, candidate_id, candidate_digest, entailment, attribution, modality, negation, time, receipt_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
      const update = this.database.prepare("UPDATE extraction_candidate SET state = ? WHERE batch_id = ? AND candidate_id = ? AND candidate_digest = ?");
      for (const judgment of receipt.judgments) {
        const candidateId = parseContract(z.uuid(), judgment.candidate_id, "verification-candidate-id");
        const candidateDigest = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), judgment.candidate_digest, "verification-candidate-digest").toLowerCase();
        insert.run(parsedBatchId, candidateId, candidateDigest, judgment.entailment, judgment.attribution, judgment.modality, judgment.negation, judgment.time, receiptDigest);
        const state = judgment.entailment === "entailed" && judgment.attribution === "positive" && judgment.modality === "positive" && judgment.negation === "positive" && judgment.time === "positive" ? "verified" : "disputed";
        if (sqlInteger(update.run(state, parsedBatchId, candidateId, candidateDigest).changes, "verification-candidate-update") !== 1n) throw new StoreError("attempt_conflict");
      }
      this.database.prepare("UPDATE extraction_batch SET state = 'verified', verification_digest = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ?").run(receiptDigest, parsedBatchId);
      this.database.exec("COMMIT");
      committed = true;
      return receipt;
    } catch (error: unknown) {
      if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  failExtractionBatch(batchId: string, reason: string): void {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    const boundedReason = z.string().min(1).max(128).parse(reason);
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      this.readExtractionBatchLocked(parsedBatchId);
      this.database.prepare("UPDATE extraction_candidate SET state = 'error' WHERE batch_id = ? AND state = 'candidate'").run(parsedBatchId);
      this.database.prepare("UPDATE extraction_batch SET state = 'failed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ? AND state <> 'completed'").run(parsedBatchId);
      void boundedReason;
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  /**
   * Complete a batch that accepts no revision (skipped source or no uniformly
   * positive verdict). The receipt is derived server-side from the persisted
   * digests; callers cannot inject a fabricated completion receipt.
   */
  completeExtractionBatch(batchId: string, completion: { readonly status: "completed_without_acceptance" } | { readonly status: "skipped_with_reason"; readonly reason: string }): void {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const batch = this.readExtractionBatchLocked(parsedBatchId);
      if (batch.state !== "extracted" && batch.state !== "verified") throw new StoreError("attempt_conflict");
      const resultDigest = extractionBatchResultDigest(batch.batch_id, batch.extraction_digest, batch.verification_digest);
      const receipt = {
        version: 1,
        status: completion.status,
        ...(completion.status === "skipped_with_reason" ? { reason: parseContract(z.string().min(1).max(128), completion.reason, "extraction-skip-reason") } : {}),
        batch_id: batch.batch_id,
        extraction_digest: batch.extraction_digest,
        verification_digest: batch.verification_digest,
        result_digest: resultDigest,
      };
      const json = JSON.stringify(receipt);
      if (json.length > 32_768) throw new StoreError("attempt_stale");
      const updated = this.database.prepare("UPDATE extraction_batch SET state = 'completed', completion_receipt_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE batch_id = ? AND state IN ('extracted', 'verified')").run(json, parsedBatchId);
      if (sqlInteger(updated.changes, "extraction-complete-changes") !== 1n) throw new StoreError("attempt_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) { try { this.database.exec("ROLLBACK"); } catch { /* preserve */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError("attempt_write_failed", error);
    }
  }

  getExtractionBatchByJobId(jobId: string): ExtractionBatchRecord | undefined {
    this.ensureOpen();
    const parsedJobId = parseContract(z.uuid(), jobId, "extraction-job-id");
    const row = this.database.prepare("SELECT batch_id FROM extraction_batch WHERE job_id = ?").get(parsedJobId);
    if (row === undefined) return undefined;
    return this.readExtractionBatchLocked(sqlText(rowValue(row, "batch_id"), "extraction-batch-id"));
  }

  getExtractionCandidates(batchId: string): readonly { readonly candidate_id: string; readonly candidate_digest: string; readonly candidate_json: string }[] {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    return this.database.prepare("SELECT candidate_id, candidate_digest, candidate_json FROM extraction_candidate WHERE batch_id = ? ORDER BY rowid").all(parsedBatchId).map((row) => ({
      candidate_id: parseContract(z.uuid(), sqlText(rowValue(row, "candidate_id"), "candidate-id"), "candidate-id"),
      candidate_digest: sqlText(rowValue(row, "candidate_digest"), "candidate-digest"),
      candidate_json: sqlText(rowValue(row, "candidate_json"), "candidate-json"),
    }));
  }

  getExtractionVerification(batchId: string): { readonly receipt_digest: string; readonly judgments: readonly { readonly candidate_id: string; readonly candidate_digest: string; readonly entailment: string; readonly attribution: string; readonly modality: string; readonly negation: string; readonly time: string }[] } | undefined {
    this.ensureOpen();
    const parsedBatchId = parseContract(z.uuid(), batchId, "extraction-batch-id");
    const rows = this.database.prepare("SELECT candidate_id, candidate_digest, entailment, attribution, modality, negation, time, receipt_digest FROM extraction_verdict WHERE batch_id = ? ORDER BY rowid").all(parsedBatchId);
    if (rows.length === 0) return undefined;
    const receiptDigest = sqlText(rowValue(rows[0], "receipt_digest"), "verification-receipt-digest");
    if (rows.some((row) => sqlText(rowValue(row, "receipt_digest"), "verification-receipt-digest") !== receiptDigest)) throw new StoreError("schema_invalid");
    return {
      receipt_digest: receiptDigest,
      judgments: rows.map((row) => ({
        candidate_id: sqlText(rowValue(row, "candidate_id"), "verification-candidate-id"),
        candidate_digest: sqlText(rowValue(row, "candidate_digest"), "verification-candidate-digest"),
        entailment: sqlText(rowValue(row, "entailment"), "verification-entailment"),
        attribution: sqlText(rowValue(row, "attribution"), "verification-attribution"),
        modality: sqlText(rowValue(row, "modality"), "verification-modality"),
        negation: sqlText(rowValue(row, "negation"), "verification-negation"),
        time: sqlText(rowValue(row, "time"), "verification-time"),
      })),
    };
  }

  /** T18: scopes that currently contain lesson items (bounded consolidation discovery). */
  listConsolidationScopes(): readonly string[] {
    this.ensureOpen();
    return this.database.prepare(
      `SELECT DISTINCT scope_id FROM memory_item WHERE kind = 'lesson' ORDER BY scope_id`,
    ).all().map((row) => sqlText(rowValue(row, "scope_id"), "lesson-scope"));
  }

  /**
   * T18 discovery: list memory items of one kind in a scope with their
   * canonical identity and ledger head. Read-only and parameterized.
   */
  listMemoryItemsByKind(kind: "observation" | "plan" | "fact" | "decision" | "preference" | "lesson" | "procedure", scopeId: string): readonly {
    readonly item_id: string;
    readonly status: "candidate" | "supported" | "disputed" | "superseded" | "retracted";
    readonly current_revision_id: string | null;
    readonly predicate: string;
    readonly qualifiers_json: string;
    readonly cardinality: "exclusive" | "multi";
  }[] {
    this.ensureOpen();
    const parsedKind = parseContract(z.enum(["observation", "plan", "fact", "decision", "preference", "lesson", "procedure"]), kind, "memory-kind");
    const parsedScopeId = parseContract(z.uuid(), scopeId, "lesson-scope");
    return this.database.prepare(
      `SELECT item_id, status, current_revision_id, predicate, qualifiers_json, cardinality
         FROM memory_item
        WHERE scope_id = ? AND kind = ?
        ORDER BY created_commit_seq, item_id`,
    ).all(parsedScopeId, parsedKind).map((row) => ({
      item_id: sqlText(rowValue(row, "item_id"), "lesson-item-id"),
      status: parseContract(z.enum(["candidate", "supported", "disputed", "superseded", "retracted"]), rowValue(row, "status"), "lesson-status"),
      current_revision_id: rowValue(row, "current_revision_id") === null ? null : sqlText(rowValue(row, "current_revision_id"), "lesson-revision"),
      predicate: sqlText(rowValue(row, "predicate"), "lesson-predicate"),
      qualifiers_json: sqlText(rowValue(row, "qualifiers_json"), "lesson-qualifiers"),
      cardinality: parseContract(z.enum(["exclusive", "multi"]), rowValue(row, "cardinality"), "lesson-cardinality"),
    }));
  }

  /**
   * T18 correlation: tool-output sources in the scope whose text references
   * the predicate pattern and that were captured at or after the lesson's
   * current revision commit. Read-only; pattern must arrive pre-escaped.
   */
  listLessonFeedbackSources(scopeId: string, escapedLikePattern: string, currentRevisionId: string | null): readonly {
    readonly capture_id: string;
    readonly span_id: string;
    readonly outcome: "succeeded" | "failed";
    readonly role: string;
  }[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "lesson-scope");
    if (currentRevisionId === null) return [];
    const parsedRevisionId = parseContract(z.uuid(), currentRevisionId, "lesson-revision");
    if (escapedLikePattern.length > 512) throw new StoreError("revision_invalid");
    const rows = this.database.prepare(
      `SELECT e.capture_id, ss.span_id, COALESCE(json_extract(e.payload_json, '$.outcome'), json_extract(e.payload_json, '$.event.outcome')) AS outcome, e.role
         FROM source_event AS e
         JOIN source_span AS ss ON ss.scope_id = e.scope_id AND ss.source_id = e.capture_id
        WHERE e.scope_id = ?
          AND e.evidence_class = 'tool_output'
          AND COALESCE(json_extract(e.payload_json, '$.outcome'), json_extract(e.payload_json, '$.event.outcome')) IN ('succeeded', 'failed')
          AND json_extract(e.payload_json, '$.text') LIKE ? ESCAPE '\\'
          AND e.captured_at >= COALESCE((
                SELECT MAX(se2.captured_at)
                  FROM revision_source AS rs
                  JOIN source_span AS ss2 ON ss2.scope_id = rs.scope_id AND ss2.source_id = rs.source_capture_id
                  JOIN source_event AS se2 ON se2.scope_id = ss2.scope_id AND se2.capture_id = ss2.source_id
                 WHERE rs.scope_id = ? AND rs.revision_id = ?), '1970-01-01T00:00:00Z')
        ORDER BY e.captured_at
        LIMIT 32`,
    ).all(parsedScopeId, escapedLikePattern, parsedScopeId, parsedRevisionId);
    return rows.map((row) => ({
      capture_id: sqlText(rowValue(row, "capture_id"), "lesson-capture"),
      span_id: sqlText(rowValue(row, "span_id"), "lesson-span"),
      outcome: parseContract(z.enum(["succeeded", "failed"]), rowValue(row, "outcome"), "lesson-outcome"),
      role: sqlText(rowValue(row, "role"), "lesson-role"),
    }));
  }

  /**
   * T18b: canonical content JSON of one revision (read-only). Used by the
   * procedure layer to parse the structured procedure body that the verified
   * extraction pipeline committed as the revision value.
   */
  getRevisionContentJson(scopeId: string, revisionId: string): string | undefined {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "revision-content-scope");
    const parsedRevisionId = parseContract(z.uuid(), revisionId, "revision-content-revision");
    const row = this.database
      .prepare("SELECT content_json FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
      .get(parsedScopeId, parsedRevisionId);
    return row === undefined ? undefined : sqlText(rowValue(row, "content_json"), "revision-content");
  }

  /** T18c: read the immutable source digest for export provenance. */
  getRevisionDigest(scopeId: string, revisionId: string): string | undefined {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "revision-content-scope");
    const parsedRevisionId = parseContract(z.uuid(), revisionId, "revision-content-revision");
    const row = this.database
      .prepare("SELECT content_digest FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
      .get(parsedScopeId, parsedRevisionId);
    return row === undefined
      ? undefined
      : parseContract(z.string().regex(/^[a-f0-9]{64}$/i), sqlText(rowValue(row, "content_digest"), "revision-digest"), "revision-digest").toLowerCase();
  }

  /**
   * T18b discovery: every activation row of a scope (read-only). The
   * activation state is separate from the memory item and only ever changed
   * through the CAS transition methods below.
   */
  listProcedureActivations(scopeId: string): readonly {
    readonly procedure_item_id: string;
    readonly status: "candidate" | "validated" | "active" | "deprecated" | "revoked" | "purged";
    readonly policy_version: string | null;
    readonly conditions_json: string;
    readonly validated_revision: string | null;
    readonly active_revision: string | null;
    readonly created_at: string;
    readonly updated_at: string;
  }[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    return this.database.prepare(
      `SELECT procedure_item_id, status, policy_version, conditions_json, validated_revision, active_revision, created_at, updated_at
         FROM procedure_activation
        WHERE scope_id = ?
        ORDER BY procedure_item_id`,
    ).all(parsedScopeId).map((row) => ({
      procedure_item_id: sqlText(rowValue(row, "procedure_item_id"), "procedure-item-id"),
      status: parseContract(z.enum(["candidate", "validated", "active", "deprecated", "revoked", "purged"]), rowValue(row, "status"), "procedure-activation-status"),
      policy_version: rowValue(row, "policy_version") === null ? null : sqlText(rowValue(row, "policy_version"), "procedure-policy-version"),
      conditions_json: sqlText(rowValue(row, "conditions_json"), "procedure-conditions"),
      validated_revision: rowValue(row, "validated_revision") === null ? null : sqlText(rowValue(row, "validated_revision"), "procedure-validated-revision"),
      active_revision: rowValue(row, "active_revision") === null ? null : sqlText(rowValue(row, "active_revision"), "procedure-active-revision"),
      created_at: sqlText(rowValue(row, "created_at"), "procedure-created-at"),
      updated_at: sqlText(rowValue(row, "updated_at"), "procedure-updated-at"),
    }));
  }

  private wallClockNow(): string {
    return this.wallClock === undefined ? new Date().toISOString() : this.wallClock();
  }

  /**
   * T18b: register the separate scoped activation row for a procedure item.
   * CAS on the primary key: a second registration of the same item is a
   * conflict, never a silent reset. The memory item itself is never written.
   */
  insertProcedureActivation(input: unknown): void {
    this.ensureOpen();
    const parsed = parseContract(
      z.object({ scope_id: z.uuid(), procedure_item_id: z.uuid() }).strict(),
      input,
      "procedure-activation-input",
    );
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const item = this.database
        .prepare("SELECT kind FROM memory_item WHERE scope_id = ? AND item_id = ?")
        .get(parsed.scope_id, parsed.procedure_item_id);
      if (item === undefined || sqlText(rowValue(item, "kind"), "procedure-item-kind") !== "procedure") {
        throw new StoreError("revision_invalid");
      }
      const at = this.wallClockNow();
      this.database
        .prepare(
          `INSERT INTO procedure_activation (scope_id, procedure_item_id, status, policy_version, conditions_json, validated_revision, active_revision, created_at, updated_at)
           VALUES (?, ?, 'candidate', NULL, '{}', NULL, NULL, ?, ?)`,
        )
        .run(parsed.scope_id, parsed.procedure_item_id, at, at);
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new StoreError("revision_conflict", error);
      }
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18b state machine, CAS candidate → validated. The guard is enforced
   * inside the transaction: the item head must be a verified pipeline head
   * (status 'supported' on the exact revision) AND at least one correlated
   * succeeded tool execution must postdate that revision. Assistant
   * self-assertion never validates a procedure.
   */
  markProcedureValidated(scopeId: string, procedureItemId: string, validatedRevisionId: string): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    const parsedItemId = parseContract(z.uuid(), procedureItemId, "procedure-item-id");
    const parsedRevisionId = parseContract(z.uuid(), validatedRevisionId, "procedure-validated-revision");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const item = this.database
        .prepare("SELECT kind, status, predicate, current_revision_id FROM memory_item WHERE scope_id = ? AND item_id = ?")
        .get(parsedScopeId, parsedItemId);
      if (item === undefined || sqlText(rowValue(item, "kind"), "procedure-item-kind") !== "procedure") {
        throw new StoreError("revision_invalid");
      }
      const status = sqlText(rowValue(item, "status"), "procedure-item-status");
      const currentRevisionId = rowValue(item, "current_revision_id") === null ? null : sqlText(rowValue(item, "current_revision_id"), "procedure-current-revision");
      if (status !== "supported" || currentRevisionId !== parsedRevisionId) {
        throw new StoreError("revision_conflict");
      }
      const succeeded = this.database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM source_event AS e
             JOIN source_span AS ss ON ss.scope_id = e.scope_id AND ss.source_id = e.capture_id
            WHERE e.scope_id = ?
              AND e.evidence_class = 'tool_output'
              AND COALESCE(json_extract(e.payload_json, '$.outcome'), json_extract(e.payload_json, '$.event.outcome')) = 'succeeded'
              AND json_extract(e.payload_json, '$.text') LIKE ? ESCAPE '\\'
              AND e.captured_at >= COALESCE((
                    SELECT MAX(se2.captured_at)
                      FROM revision_source AS rs
                      JOIN source_span AS ss2 ON ss2.scope_id = rs.scope_id AND ss2.source_id = rs.source_capture_id
                      JOIN source_event AS se2 ON se2.scope_id = ss2.scope_id AND se2.capture_id = ss2.source_id
                     WHERE rs.scope_id = ? AND rs.revision_id = ?), '1970-01-01T00:00:00Z')`,
        )
        .get(parsedScopeId, `%${sqlText(rowValue(item, "predicate"), "procedure-predicate").replace(/[\\%_]/g, (match) => `\\${match}`)}%`, parsedScopeId, parsedRevisionId);
      if (succeeded === undefined || sqlInteger(rowValue(succeeded, "count"), "procedure-validation-evidence") === 0n) {
        throw new StoreError("revision_conflict");
      }
      const updated = this.database
        .prepare(
          `UPDATE procedure_activation
              SET status = 'validated', validated_revision = ?, updated_at = ?
            WHERE scope_id = ? AND procedure_item_id = ? AND status = 'candidate'`,
        )
        .run(parsedRevisionId, this.wallClockNow(), parsedScopeId, parsedItemId);
      if (sqlInteger(updated.changes, "procedure-validate-changes") !== 1n) {
        throw new StoreError("revision_conflict");
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18b state machine, CAS validated → active. Activation exists only
   * within the pre-approved recommendation policy; the policy version is a
   * required non-empty identifier and the activated revision is the CAS
   * validated revision (CHECK-constrained in the schema).
   */
  markProcedureActive(scopeId: string, procedureItemId: string, policyVersion: string, conditionsJson: string): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    const parsedItemId = parseContract(z.uuid(), procedureItemId, "procedure-item-id");
    const parsedPolicyVersion = parseContract(z.string().min(1).max(128), policyVersion, "procedure-policy-version");
    const parsedConditionsJson = parseContract(z.string().min(2).max(8_192), conditionsJson, "procedure-conditions-json");
    try {
      const parsedConditions: unknown = JSON.parse(parsedConditionsJson);
      if (parsedConditions === null || typeof parsedConditions !== "object" || Array.isArray(parsedConditions)) throw new Error("conditions_not_object");
    } catch (error: unknown) {
      throw new StoreError("revision_invalid", error);
    }    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const updated = this.database
        .prepare(
          `UPDATE procedure_activation
              SET status = 'active', policy_version = ?, conditions_json = ?, active_revision = validated_revision, updated_at = ?
            WHERE scope_id = ? AND procedure_item_id = ? AND status = 'validated' AND validated_revision IS NOT NULL`,
        )
        .run(parsedPolicyVersion, parsedConditionsJson, this.wallClockNow(), parsedScopeId, parsedItemId);
      if (sqlInteger(updated.changes, "procedure-activate-changes") !== 1n) {
        throw new StoreError("revision_conflict");
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18b state machine, CAS active → deprecated. A deprecated procedure is
   * immediately blocked from new core-controlled outputs; the historic
   * versions stay visible as experience until a purge covers them.
   */
  markProcedureDeprecated(scopeId: string, procedureItemId: string): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    const parsedItemId = parseContract(z.uuid(), procedureItemId, "procedure-item-id");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const updated = this.database
        .prepare(
          `UPDATE procedure_activation SET status = 'deprecated', updated_at = ?
            WHERE scope_id = ? AND procedure_item_id = ? AND status = 'active'`,
        )
        .run(this.wallClockNow(), parsedScopeId, parsedItemId);
      if (sqlInteger(updated.changes, "procedure-deprecate-changes") !== 1n) {
        throw new StoreError("revision_conflict");
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18b state machine, CAS validated/active/deprecated → revoked.
   * Revocation takes effect for every new core-controlled output
   * immediately and has no transition back.
   */
  markProcedureRevoked(scopeId: string, procedureItemId: string): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    const parsedItemId = parseContract(z.uuid(), procedureItemId, "procedure-item-id");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const updated = this.database
        .prepare(
          `UPDATE procedure_activation SET status = 'revoked', updated_at = ?
            WHERE scope_id = ? AND procedure_item_id = ? AND status IN ('validated', 'active', 'deprecated')`,
        )
        .run(this.wallClockNow(), parsedScopeId, parsedItemId);
      if (sqlInteger(updated.changes, "procedure-revoke-changes") !== 1n) {
        throw new StoreError("revision_conflict");
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18b purge hook: mark every activation row of a scope purged (idempotent
   * CAS). T21 integrates this into the full purge cascade; the
   * recommendation read filters status = 'active', so a purged row can never
   * be recommended again.
   */
  markProcedureActivationsPurgedInScope(scopeId: string): bigint {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "procedure-scope");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const updated = this.database
        .prepare(
          `UPDATE procedure_activation SET status = 'purged', updated_at = ?
            WHERE scope_id = ? AND status <> 'purged'`,
        )
        .run(this.wallClockNow(), parsedScopeId);
      const changes = sqlInteger(updated.changes, "procedure-purge-changes");
      this.database.exec("COMMIT");
      committed = true;
      return changes;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }
  /**
   * T18c: register the export intent plus its durable outbox job in ONE
   * transaction (plan §7 step 1). The row starts at state 'prepared' with
   * desired_state 'present' and a pending outbox; no file has been touched.
   * The privacy epoch snapshot is read from the scope row inside the same
   * transaction so the reconciliation re-check is authoritative. A revoked
   * export of the same target location may be reset as a fresh intent
   * (re-export); any other existing row on the same location is a conflict.
   */
  beginManagedExport(input: {
    readonly scope_id: string;
    readonly procedure_item_id: string;
    readonly procedure_revision_id: string;
    readonly binding: TrustedBinding;
    readonly output_target: string;
    readonly target_kind: ManagedExportTargetKind;
    readonly root: string;
    readonly path: string;
  }): { readonly export_id: string; readonly created: boolean } {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const procedureItemId = parseContract(z.uuid(), input.procedure_item_id, "export-item");
    const procedureRevisionId = parseContract(z.uuid(), input.procedure_revision_id, "export-revision");
    const targetKind = parseContract(managedExportTargetKindSchema, input.target_kind, "export-target");
    if (!isTrustedBinding(input.binding)) throw new StoreError("policy_invalid");
    if (!input.binding.allowed_scope_ids.includes(scopeId)) throw new StoreError("scope_not_allowed");
    const bindingId = input.binding.binding_id;
    const outputTarget = parseContract(readerTargetSchema, input.output_target, "export-output-target");
    if (!input.binding.egress.reader_targets.includes(outputTarget)) throw new StoreError("output_not_allowed");
    if (!managedExportTargetReaders[targetKind].includes(outputTarget)) {
      throw new StoreError("output_not_allowed");
    }
    const rootInput = parseContract(z.string().min(2).max(1024), input.root, "export-root");
    const pathInput = parseContract(z.string().min(1).max(512), input.path, "export-path");
    if (!isAbsolute(rootInput) || resolve(rootInput) === "/" || pathInput.includes("\u0000") || isAbsolute(pathInput) || pathInput.split(/[\\/]/u).includes("..")) {
      throw new StoreError("revision_invalid");
    }
    const root = canonicalExportRoot(rootInput);
    const path = normalize(pathInput).replaceAll("\\", "/");
    if (path === "." || path === "" || path.startsWith("../") || path === ".." || relative(root, resolve(root, path)).startsWith("..")) {
      throw new StoreError("revision_invalid");
    }
    try {
      managedExportPathInfo(targetKind, path);
    } catch {
      throw new StoreError("revision_invalid");
    }
    assertNoSymlinkAncestors(root);
    try {
      const rootInfo = lstatSync(root);
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new StoreError("revision_invalid");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    assertNoSymlinkAncestors(resolve(root, path));
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const scope = this.database
        .prepare("SELECT privacy_epoch FROM scope WHERE scope_id = ?")
        .get(scopeId);
      if (scope === undefined) throw new StoreError("scope_not_registered");
      const privacyEpoch = sqlInteger(rowValue(scope, "privacy_epoch"), "export-privacy-epoch").toString(10);
      const item = this.database
        .prepare(
          `SELECT i.kind, i.status, i.current_revision_id,
                  a.status AS activation_status, a.active_revision, a.policy_version
             FROM memory_item AS i
             JOIN procedure_activation AS a
               ON a.scope_id = i.scope_id AND a.procedure_item_id = i.item_id
            WHERE i.scope_id = ? AND i.item_id = ?
              AND i.kind = 'procedure'
              AND i.status = 'supported'
              AND i.current_revision_id = ?
              AND a.status = 'active'
              AND a.active_revision = ?
              AND a.policy_version IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM revision_source AS rs
                  JOIN purge_tombstone AS t
                    ON t.scope_id = rs.scope_id AND t.capture_id = rs.source_capture_id
                 WHERE rs.scope_id = ? AND rs.revision_id = ?
              )`,
        )
        .get(scopeId, procedureItemId, procedureRevisionId, procedureRevisionId, scopeId, procedureRevisionId);
      if (item === undefined) {
        throw new StoreError("revision_invalid");
      }
      const sourceMissingGrant = this.database
        .prepare(
          `SELECT 1 AS present
             FROM revision_source AS rs
             JOIN source_event AS e
               ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
             LEFT JOIN scope_output_grant AS g
               ON g.scope_id = rs.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
            WHERE rs.scope_id = ? AND rs.revision_id = ? AND g.scope_id IS NULL
            LIMIT 1`,
        )
        .get(outputTarget, scopeId, procedureRevisionId);
      const sourcePresent = this.database
        .prepare("SELECT 1 AS present FROM revision_source WHERE scope_id = ? AND revision_id = ? LIMIT 1")
        .get(scopeId, procedureRevisionId);
      if (sourcePresent === undefined || sourceMissingGrant !== undefined) throw new StoreError("output_not_allowed");
      const revision = this.database
        .prepare("SELECT item_id FROM memory_revision WHERE scope_id = ? AND revision_id = ?")
        .get(scopeId, procedureRevisionId);
      if (revision === undefined || sqlText(rowValue(revision, "item_id"), "export-revision-item") !== procedureItemId) {
        throw new StoreError("revision_invalid");
      }
      const existing = this.database
        .prepare("SELECT export_id, state FROM managed_export WHERE scope_id = ? AND root = ? AND path = ?")
        .get(scopeId, root, path);
      const now = this.wallClockNow();
      if (existing !== undefined) {
        const existingId = sqlText(rowValue(existing, "export_id"), "export-id");
        if (sqlText(rowValue(existing, "state"), "export-existing-state") !== "revoked") {
          throw new StoreError("revision_conflict");
        }
        this.database
          .prepare(
            `UPDATE managed_export
                SET procedure_item_id = ?, procedure_revision_id = ?, binding_id = ?, output_target = ?, target_kind = ?, expected_owner_hash = NULL,
                    root_dev = NULL, root_ino = NULL, parent_dev = NULL, parent_ino = NULL,
                    staging_path = NULL, staging_hash = NULL, purge_operation_id = NULL,
                    desired_state = 'present', state = 'prepared', observed_state = 'unknown', observed_hash = NULL,
                    privacy_epoch = ?, host_refresh_state = 'not_required',
                    outbox_state = 'pending', outbox_attempts = 0, outbox_next_at = NULL,
                    outbox_owner = NULL, outbox_lease_until = NULL, outbox_fence = outbox_fence + 1,
                    outbox_last_error = NULL, updated_at = ?
              WHERE scope_id = ? AND export_id = ?`,
          )
          .run(procedureItemId, procedureRevisionId, bindingId, outputTarget, targetKind, privacyEpoch, now, scopeId, existingId);
        this.database.exec("COMMIT");
        committed = true;
        return { export_id: existingId, created: false };
      }
      const exportId = randomUUID();
      this.database
        .prepare(`INSERT INTO managed_export (scope_id, export_id, procedure_item_id, procedure_revision_id, binding_id, output_target, target_kind, root, path, expected_owner_hash, root_dev, root_ino, parent_dev, parent_ino, staging_path, staging_hash, purge_operation_id, desired_state, state, observed_state, observed_hash, privacy_epoch, host_refresh_state, outbox_state, outbox_attempts, outbox_next_at, outbox_owner, outbox_lease_until, outbox_fence, outbox_last_error, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'present', 'prepared', 'unknown', NULL, ?, 'not_required', 'pending', 0, NULL, NULL, NULL, 0, NULL, ?, ?)`)
        .run(scopeId, exportId, procedureItemId, procedureRevisionId, bindingId, outputTarget, targetKind, root, path, privacyEpoch, now, now);
      this.database.exec("COMMIT");
      committed = true;
      return { export_id: exportId, created: true };
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /** T18c: single managed export row (read-only). */
  getManagedExport(scopeId: string, exportId: string): ManagedExportRow | undefined {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "export-scope");
    const parsedExportId = parseContract(z.uuid(), exportId, "export-id");
    const row = this.database
      .prepare(`SELECT ${MANAGED_EXPORT_COLUMNS} FROM managed_export WHERE scope_id = ? AND export_id = ?`)
      .get(parsedScopeId, parsedExportId);
    return row === undefined ? undefined : readManagedExportRow(row as Record<string, unknown>);
  }

  /** T18c: revalidate the exact active procedure and privacy snapshot before a file write. */
  isManagedExportCurrent(input: {
    readonly scope_id: string;
    readonly procedure_item_id: string;
    readonly procedure_revision_id: string;
    readonly privacy_epoch: string;
    readonly output_target: string;
  }): boolean {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const itemId = parseContract(z.uuid(), input.procedure_item_id, "export-item");
    const revisionId = parseContract(z.uuid(), input.procedure_revision_id, "export-revision");
    const privacyEpoch = parseContract(z.string().min(1).max(64), input.privacy_epoch, "export-privacy-epoch");
    const outputTarget = parseContract(readerTargetSchema, input.output_target, "export-output-target");
    return this.isManagedExportRevisionCurrentLocked(scopeId, itemId, revisionId, privacyEpoch, outputTarget);
  }

  private isManagedExportRevisionCurrentLocked(scopeId: string, itemId: string, revisionId: string, privacyEpoch: string, outputTarget: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS present
           FROM scope AS s
           JOIN memory_item AS i
             ON i.scope_id = s.scope_id AND i.item_id = ?
           JOIN procedure_activation AS a
             ON a.scope_id = i.scope_id AND a.procedure_item_id = i.item_id
          WHERE s.scope_id = ? AND s.privacy_epoch = ?
            AND i.kind = 'procedure' AND i.status = 'supported' AND i.current_revision_id = ?
            AND a.status = 'active' AND a.active_revision = ? AND a.policy_version IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM revision_source AS rs
                JOIN source_event AS e
                  ON e.scope_id = rs.scope_id AND e.capture_id = rs.source_capture_id
                LEFT JOIN scope_output_grant AS g
                  ON g.scope_id = rs.scope_id AND g.output_target = ? AND g.source_class = e.evidence_class
               WHERE rs.scope_id = ? AND rs.revision_id = ? AND g.scope_id IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
                FROM revision_source AS rs
                JOIN purge_tombstone AS t
                  ON t.scope_id = rs.scope_id AND t.capture_id = rs.source_capture_id
               WHERE rs.scope_id = ? AND rs.revision_id = ?
            )`,
      )
      .get(itemId, scopeId, privacyEpoch, revisionId, revisionId, outputTarget, scopeId, revisionId, scopeId, revisionId);
    return row !== undefined;
  }

  /**
   * Persist the deterministic owner hash before the filesystem boundary. This
   * closes the rename→DB-confirmation crash window: a restarted worker can
   * recognize its own fully written bytes even though the row is still
   * `prepared`.
   */
  prepareManagedExportOwnerHash(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly owner: string;
    readonly fence: number;
    readonly owner_hash: string;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const owner = parseContract(z.string().min(1).max(256), input.owner, "export-owner");
    const fence = sqlInteger(input.fence, "export-fence");
    const ownerHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.owner_hash, "export-owner-hash").toLowerCase();
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET expected_owner_hash = ?, host_refresh_state = 'required', updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND state = 'prepared'
            AND outbox_state = 'running' AND outbox_owner = ? AND outbox_fence = ?
            AND (expected_owner_hash IS NULL OR expected_owner_hash = ?)`,
      )
      .run(ownerHash, this.wallClockNow(), scopeId, exportId, owner, fence.toString(10), ownerHash);
    if (sqlInteger(updated.changes, "export-owner-hash-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * Inventory the exact staged artifact and canonical target identities before
   * any rename. The row is the recovery record for a killed writer; a later
   * worker may only adopt a staging file with this hash and path.
   */
  prepareManagedExportArtifacts(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly owner: string;
    readonly fence: number;
    readonly owner_hash: string;
    readonly staging_path: string;
    readonly staging_hash: string;
    readonly root_dev: string;
    readonly root_ino: string;
    readonly parent_dev: string;
    readonly parent_ino: string;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const owner = parseContract(z.string().min(1).max(256), input.owner, "export-owner");
    const fence = sqlInteger(input.fence, "export-fence");
    const ownerHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.owner_hash, "export-owner-hash").toLowerCase();
    const stagingPath = parseContract(z.string().min(2).max(4096), input.staging_path, "export-staging-path");
    if (!isAbsolute(stagingPath)) throw new StoreError("revision_invalid");
    const stagingHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.staging_hash, "export-staging-hash").toLowerCase();
    if (stagingHash !== ownerHash) throw new StoreError("revision_conflict");
    const rootDev = parseContract(z.string().min(1).max(128), input.root_dev, "export-root-dev");
    const rootIno = parseContract(z.string().min(1).max(128), input.root_ino, "export-root-ino");
    const parentDev = parseContract(z.string().min(1).max(128), input.parent_dev, "export-parent-dev");
    const parentIno = parseContract(z.string().min(1).max(128), input.parent_ino, "export-parent-ino");
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET expected_owner_hash = ?, host_refresh_state = 'required',
                root_dev = ?, root_ino = ?, parent_dev = ?, parent_ino = ?,
                staging_path = ?, staging_hash = ?, updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND state = 'prepared'
            AND outbox_state = 'running' AND outbox_owner = ? AND outbox_fence = ?
            AND (expected_owner_hash IS NULL OR expected_owner_hash = ? OR observed_state IN ('absent', 'owned_stale'))
            AND (root_dev IS NULL OR (root_dev = ? AND root_ino = ?))
            AND (parent_dev IS NULL OR (parent_dev = ? AND parent_ino = ?))`,
      )
      .run(ownerHash, rootDev, rootIno, parentDev, parentIno, stagingPath, stagingHash, this.wallClockNow(), scopeId, exportId, owner, fence.toString(10), ownerHash, rootDev, rootIno, parentDev, parentIno);
    if (sqlInteger(updated.changes, "export-artifact-prepare-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /** Clear a verified owned staging artifact after rename/revocation. */
  clearManagedExportStaging(input: { readonly scope_id: string; readonly export_id: string; readonly staging_path: string; readonly staging_hash: string }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const stagingPath = parseContract(z.string().min(2).max(4096), input.staging_path, "export-staging-path");
    const stagingHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.staging_hash, "export-staging-hash").toLowerCase();
    const updated = this.database
      .prepare("UPDATE managed_export SET staging_path = NULL, staging_hash = NULL, updated_at = ? WHERE scope_id = ? AND export_id = ? AND staging_path = ? AND staging_hash = ?")
      .run(this.wallClockNow(), scopeId, exportId, stagingPath, stagingHash);
    if (sqlInteger(updated.changes, "export-staging-clear-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /** Clear a staged artifact while retaining the current outbox owner/fence. */
  clearManagedExportStagingOwned(input: { readonly scope_id: string; readonly export_id: string; readonly owner: string; readonly fence: number; readonly staging_path: string; readonly staging_hash: string }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const owner = parseContract(z.string().min(1).max(256), input.owner, "export-owner");
    const fence = sqlInteger(input.fence, "export-fence");
    const stagingPath = parseContract(z.string().min(2).max(4096), input.staging_path, "export-staging-path");
    const stagingHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), input.staging_hash, "export-staging-hash").toLowerCase();
    const updated = this.database
      .prepare("UPDATE managed_export SET staging_path = NULL, staging_hash = NULL, updated_at = ? WHERE scope_id = ? AND export_id = ? AND staging_path = ? AND staging_hash = ? AND outbox_state = 'running' AND outbox_owner = ? AND outbox_fence = ?")
      .run(this.wallClockNow(), scopeId, exportId, stagingPath, stagingHash, owner, fence.toString(10));
    if (sqlInteger(updated.changes, "export-staging-clear-owned-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * Filesystem exclusion shared with every vault writer, including purge and
   * lease takeover. SQLite releases it when the process exits; elapsed lease
   * time alone cannot displace a process still performing filesystem effects.
   * Callers must commit artifact inventory BEFORE entering, and keep inference
   * and nested transactions outside this synchronous section.
   */
  withManagedExportFilesystemLock<T>(effect: () => T): T {
    this.ensureOpen();
    // ponytail: one vault-wide writer lock during local file I/O and fsync;
    // use an OS-backed per-target lock if measured write contention warrants it.
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = effect();
      this.database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the effect failure */ }
      throw error;
    }
  }

  /** Lease/fence guard immediately before a filesystem effect. */
  assertManagedExportLease(input: { readonly scope_id: string; readonly export_id: string; readonly owner: string; readonly fence: number; readonly now: string }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const owner = parseContract(z.string().min(1).max(256), input.owner, "export-owner");
    const fence = sqlInteger(input.fence, "export-fence");
    const now = parseContract(z.iso.datetime({ offset: true }), input.now, "export-now");
    const row = this.database
      .prepare("SELECT outbox_owner, outbox_fence, outbox_lease_until FROM managed_export WHERE scope_id = ? AND export_id = ? AND outbox_state = 'running'")
      .get(scopeId, exportId);
    const leaseTime = row === undefined || rowValue(row, "outbox_lease_until") === null ? Number.NaN : new Date(String(rowValue(row, "outbox_lease_until"))).getTime();
    if (row === undefined || rowValue(row, "outbox_owner") !== owner || sqlInteger(rowValue(row, "outbox_fence"), "export-fence") !== fence || !Number.isFinite(leaseTime) || leaseTime <= new Date(now).getTime()) {
      throw new StoreError("revision_conflict");
    }
  }

  /**
   * T18c: outbox lease CAS for the embedded bounded job (plan §7 step 2,
   * serialized reconciliation). Only a pending row or one whose lease has
   * expired can be claimed; each claim bumps the fence so a displaced worker
   * can never commit afterwards.
   */
  claimManagedExportOutbox(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly owner: string;
    readonly lease_until: string;
    readonly now?: string;
  }): number {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const owner = parseContract(z.string().min(1).max(256), input.owner, "export-owner");
    const leaseUntil = parseContract(z.iso.datetime({ offset: true }), input.lease_until, "export-lease");
    const now = input.now === undefined
      ? this.wallClockNow()
      : parseContract(z.iso.datetime({ offset: true }), input.now, "export-now");
    if (new Date(leaseUntil).getTime() <= new Date(now).getTime()) throw new StoreError("revision_invalid");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = this.database
        .prepare(
          `UPDATE managed_export
              SET outbox_state = 'running', outbox_owner = ?, outbox_lease_until = ?, outbox_fence = outbox_fence + 1, updated_at = ?
            WHERE scope_id = ? AND export_id = ?
              AND (
                (outbox_state = 'pending' AND (outbox_next_at IS NULL OR outbox_next_at <= ?))
                OR (outbox_state = 'running' AND outbox_lease_until IS NOT NULL AND outbox_lease_until <= ?)
              )`,
        )
        .run(owner, leaseUntil, this.wallClockNow(), scopeId, exportId, now, now);
      if (sqlInteger(result.changes, "export-claim-changes") !== 1n) throw new StoreError("revision_conflict");
      const row = this.database
        .prepare("SELECT outbox_fence FROM managed_export WHERE scope_id = ? AND export_id = ? AND outbox_state = 'running' AND outbox_owner = ? AND outbox_lease_until = ?")
        .get(scopeId, exportId, owner, leaseUntil);
      if (row === undefined) throw new StoreError("revision_conflict");
      const fence = Number(sqlInteger(rowValue(row, "outbox_fence"), "export-fence"));
      this.database.exec("COMMIT");
      committed = true;
      return fence;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the claim failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18c CAS prepared → materialized. Records the owner hash of the file the
   * worker actually wrote plus the observed filesystem state; the outbox lease
   * is kept until the worker completes. Idempotent when the row is already
   * materialized with the same owner hash (crash re-run after the first
   * confirm).
   */
  confirmManagedExportMaterialized(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly fence: number;
    readonly owner_hash: string;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    const ownerHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/), input.owner_hash, "export-owner-hash");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT state, expected_owner_hash, procedure_item_id, procedure_revision_id, output_target, privacy_epoch, outbox_state, outbox_fence FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined) throw new StoreError("revision_invalid");
      const state = sqlText(rowValue(row, "state"), "export-state");
      const expectedOwnerHash = rowValue(row, "expected_owner_hash") === null ? null : sqlText(rowValue(row, "expected_owner_hash"), "export-owner-hash");
      if (state === "materialized" && expectedOwnerHash === ownerHash && sqlText(rowValue(row, "outbox_state"), "export-outbox") === "running" && sqlInteger(rowValue(row, "outbox_fence"), "export-fence") === fence) {
        this.database
          .prepare("UPDATE managed_export SET staging_path = NULL, staging_hash = NULL, outbox_state = 'pending', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL, updated_at = ? WHERE scope_id = ? AND export_id = ?")
          .run(this.wallClockNow(), scopeId, exportId);
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      if (state !== "prepared") throw new StoreError("revision_conflict");
      const itemId = sqlText(rowValue(row, "procedure_item_id"), "export-item");
      const revisionId = sqlText(rowValue(row, "procedure_revision_id"), "export-revision");
      const outputTarget = sqlText(rowValue(row, "output_target"), "export-output-target");
      const privacyEpoch = sqlText(rowValue(row, "privacy_epoch"), "export-privacy-epoch");
      if (!this.isManagedExportRevisionCurrentLocked(scopeId, itemId, revisionId, privacyEpoch, outputTarget)) {
        const invalidated = this.database
          .prepare(
            `UPDATE managed_export
                SET desired_state = 'absent', state = 'revocation_pending', expected_owner_hash = ?,
                    observed_state = 'owned_current', observed_hash = ?, host_refresh_state = 'required',
                    staging_path = NULL, staging_hash = NULL,
                    outbox_state = 'pending', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL,
                    outbox_fence = outbox_fence + 1, outbox_last_error = 'revision_or_policy_changed', updated_at = ?
              WHERE scope_id = ? AND export_id = ? AND state = 'prepared'
                AND outbox_state = 'running' AND outbox_fence = ?`,
          )
          .run(ownerHash, ownerHash, this.wallClockNow(), scopeId, exportId, fence.toString(10));
        if (sqlInteger(invalidated.changes, "export-invalidate-changes") !== 1n) throw new StoreError("revision_conflict");
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      const updated = this.database
        .prepare(
          `UPDATE managed_export
              SET state = 'materialized', expected_owner_hash = ?, observed_state = 'owned_current', observed_hash = ?, host_refresh_state = 'required',
                  staging_path = NULL, staging_hash = NULL,
                  outbox_state = 'pending', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL, updated_at = ?
            WHERE scope_id = ? AND export_id = ? AND state = 'prepared'
              AND outbox_state = 'running' AND outbox_fence = ?`,
        )
        .run(ownerHash, ownerHash, this.wallClockNow(), scopeId, exportId, fence.toString(10));
      if (sqlInteger(updated.changes, "export-materialize-changes") !== 1n) throw new StoreError("revision_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18c CAS materialized → active. The observed file hash was confirmed to
   * match the owner hash, so the export is live on disk; the supported host
   * version now requires the refresh contract (host_refresh_state 'required',
   * enforced by the schema CHECK). Idempotent when already active.
   */
  confirmManagedExportActive(input: { readonly scope_id: string; readonly export_id: string; readonly fence: number }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT state, expected_owner_hash, procedure_item_id, procedure_revision_id, output_target, privacy_epoch FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined) throw new StoreError("revision_invalid");
      if (sqlText(rowValue(row, "state"), "export-state") === "active") {
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      const expectedOwnerHash = rowValue(row, "expected_owner_hash") === null ? null : sqlText(rowValue(row, "expected_owner_hash"), "export-owner-hash");
      const itemId = sqlText(rowValue(row, "procedure_item_id"), "export-item");
      const revisionId = sqlText(rowValue(row, "procedure_revision_id"), "export-revision");
      const outputTarget = sqlText(rowValue(row, "output_target"), "export-output-target");
      const privacyEpoch = sqlText(rowValue(row, "privacy_epoch"), "export-privacy-epoch");
      if (!this.isManagedExportRevisionCurrentLocked(scopeId, itemId, revisionId, privacyEpoch, outputTarget)) {
        const invalidated = this.database
          .prepare(
            `UPDATE managed_export
                SET desired_state = 'absent', state = 'revocation_pending', observed_state = 'owned_current', observed_hash = ?,
                    outbox_state = 'pending', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL,
                    outbox_fence = outbox_fence + 1, outbox_last_error = 'revision_or_policy_changed', updated_at = ?
              WHERE scope_id = ? AND export_id = ? AND state = 'materialized'
                AND outbox_state = 'running' AND outbox_fence = ?`,
          )
          .run(expectedOwnerHash, this.wallClockNow(), scopeId, exportId, fence.toString(10));
        if (sqlInteger(invalidated.changes, "export-invalidate-changes") !== 1n) throw new StoreError("revision_conflict");
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      const updated = this.database
        .prepare(
          `UPDATE managed_export
              SET state = 'active', host_refresh_state = 'required', updated_at = ?
            WHERE scope_id = ? AND export_id = ? AND state = 'materialized'
              AND outbox_state = 'running' AND outbox_fence = ?`,
        )
        .run(this.wallClockNow(), scopeId, exportId, fence.toString(10));
      if (sqlInteger(updated.changes, "export-activate-changes") !== 1n) throw new StoreError("revision_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /** T18c: release a claimed outbox row as completed (worker finished its unit). */
  completeManagedExportOutbox(input: { readonly scope_id: string; readonly export_id: string; readonly fence: number }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET outbox_state = 'completed', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL,
                outbox_last_error = NULL, updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND outbox_state = 'running' AND outbox_fence = ?`,
      )
      .run(this.wallClockNow(), scopeId, exportId, fence.toString(10));
    if (sqlInteger(updated.changes, "export-outbox-complete-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * T18c: bounded outbox failure (backoff 1/5/30 s, at most five attempts,
   * then a visible terminal failure with the recorded reason).
   */
  failManagedExportOutbox(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly fence: number;
    readonly error: string;
    readonly next_at: string | null;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    const error = parseContract(z.string().min(1).max(256), input.error, "export-outbox-error");
    const nextAt = input.next_at === null ? null : parseContract(z.iso.datetime({ offset: true }), input.next_at, "export-outbox-next-at");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT outbox_attempts FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined) throw new StoreError("revision_invalid");
      const attempts = Number(sqlInteger(rowValue(row, "outbox_attempts"), "export-outbox-attempts"));
      const failed = attempts + 1 >= EXPORT_OUTBOX_MAX_ATTEMPTS;
      const updated = this.database
        .prepare(
          `UPDATE managed_export
              SET outbox_state = ?, outbox_attempts = outbox_attempts + 1, outbox_next_at = ?,
                  outbox_owner = NULL, outbox_lease_until = NULL, outbox_last_error = ?, updated_at = ?
            WHERE scope_id = ? AND export_id = ? AND outbox_state = 'running' AND outbox_fence = ?`,
        )
        .run(failed ? "failed" : "pending", failed ? null : nextAt, error, this.wallClockNow(), scopeId, exportId, fence.toString(10));
      if (sqlInteger(updated.changes, "export-outbox-fail-changes") !== 1n) throw new StoreError("revision_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18c: a foreign file blocks the desired export (plan §7 step 4: foreign
   * changes stay a visible conflict, never overwritten). The outbox row ends
   * as a terminal visible failure; recovery runs through observation.
   */
  markManagedExportConflict(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly fence: number;
    readonly observed_hash: string;
    readonly discard_owner_claim?: boolean;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    const observedHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/), input.observed_hash, "export-observed-hash");
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET state = 'conflict', observed_state = 'foreign', observed_hash = ?,
                expected_owner_hash = CASE WHEN ? THEN NULL ELSE expected_owner_hash END,
                outbox_state = 'failed', outbox_owner = NULL, outbox_lease_until = NULL,
                outbox_last_error = 'foreign_file', updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND state IN ('prepared', 'materialized', 'active')
            AND outbox_state = 'running' AND outbox_fence = ?`,
      )
      .run(observedHash, input.discard_owner_claim === true ? 1 : 0, this.wallClockNow(), scopeId, exportId, fence.toString(10));
    if (sqlInteger(updated.changes, "export-conflict-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * T18c state machine, desired present → revocation requested (plan §7 step
   * 4). Only a caller that presents the matching owner hash may revoke a
   * materialized export; the cleanup outbox job is armed immediately. The
   * desired_state flip itself blocks the export from every new core output.
   */
  requestManagedExportRevocation(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly owner_hash: string | null;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const ownerHash = input.owner_hash === null
      ? null
      : parseContract(z.string().regex(/^[a-f0-9]{64}$/), input.owner_hash, "export-owner-hash");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT state, expected_owner_hash FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined) throw new StoreError("revision_invalid");
      if (sqlText(rowValue(row, "state"), "export-state") === "revocation_pending") {
        this.database.exec("COMMIT");
        committed = true;
        return;
      }
      if (!["prepared", "materialized", "active", "conflict", "host_refresh_pending"].includes(sqlText(rowValue(row, "state"), "export-state"))) {
        throw new StoreError("revision_conflict");
      }
      const expectedOwnerHash = rowValue(row, "expected_owner_hash") === null ? null : sqlText(rowValue(row, "expected_owner_hash"), "export-owner-hash");
      if (expectedOwnerHash !== ownerHash) throw new StoreError("revision_conflict");
      const updated = this.database
        .prepare(
          `UPDATE managed_export
              SET desired_state = 'absent', state = 'revocation_pending',
                  outbox_state = 'pending', outbox_attempts = 0, outbox_next_at = NULL,
                  outbox_owner = NULL, outbox_lease_until = NULL, outbox_fence = outbox_fence + 1,
                  outbox_last_error = NULL, updated_at = ?
            WHERE scope_id = ? AND export_id = ?`,
        )
        .run(this.wallClockNow(), scopeId, exportId);
      if (sqlInteger(updated.changes, "export-revoke-request-changes") !== 1n) throw new StoreError("revision_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18c CAS after the cleanup outbox removed the owned file: an export whose
   * file was never confirmed to the host ('not_required') terminates as
   * revoked; a confirmed export stays host_refresh_pending until the explicit
   * verifiable refresh contract below.
   */
  confirmManagedExportRemoved(input: { readonly scope_id: string; readonly export_id: string; readonly fence: number }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT state, host_refresh_state FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined || sqlText(rowValue(row, "state"), "export-state") !== "revocation_pending") {
        throw new StoreError("revision_conflict");
      }
      const notRequired = sqlText(rowValue(row, "host_refresh_state"), "export-refresh") === "not_required";
      const updated = this.database
        .prepare(
          `UPDATE managed_export
              SET state = ?, observed_state = 'absent', observed_hash = NULL, staging_path = NULL, staging_hash = NULL,
                  outbox_state = 'completed', outbox_next_at = NULL, outbox_owner = NULL, outbox_lease_until = NULL,
                  outbox_last_error = NULL, updated_at = ?
            WHERE scope_id = ? AND export_id = ? AND state = 'revocation_pending'
              AND outbox_state = 'running' AND outbox_fence = ?`,
        )
        .run(notRequired ? "revoked" : "host_refresh_pending", this.wallClockNow(), scopeId, exportId, fence.toString(10));
      if (sqlInteger(updated.changes, "export-removed-changes") !== 1n) throw new StoreError("revision_conflict");
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /**
   * T18c: a foreign file during revocation must NOT be deleted (plan §7 step
   * 4: deletion only against a matching owner hash). The row stays
   * revocation_pending with the foreign observation and a failed outbox — a
   * visible, unresolved conflict for this target.
   */
  markManagedExportRevocationBlocked(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly fence: number;
    readonly observed_hash: string;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const fence = sqlInteger(input.fence, "export-fence");
    const observedHash = parseContract(z.string().regex(/^[a-f0-9]{64}$/), input.observed_hash, "export-observed-hash");
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET observed_state = 'foreign', observed_hash = ?,
                outbox_state = 'failed', outbox_owner = NULL, outbox_lease_until = NULL,
                outbox_last_error = 'foreign_file', updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND state = 'revocation_pending'
            AND outbox_state = 'running' AND outbox_fence = ?`,
      )
      .run(observedHash, this.wallClockNow(), scopeId, exportId, fence.toString(10));
    if (sqlInteger(updated.changes, "export-revoke-blocked-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * T18c step 5: explicit, verifiable host refresh confirmation. There is no
   * verifiable hot-unload contract, so the only accepted contract is the
   * controlled host restart; without it a removed-but-confirmed export stays
   * host_refresh_pending. Chat/context copies already delivered to the model
   * are explicitly outside any recall guarantee.
   */
  confirmManagedExportHostRefresh(scopeId: string, exportId: string, contract: string): void {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "export-scope");
    const parsedExportId = parseContract(z.uuid(), exportId, "export-id");
    if (contract !== MANAGED_EXPORT_REFRESH_CONTRACT) throw new StoreError("revision_invalid");
    const updated = this.database
      .prepare(
        `UPDATE managed_export
            SET state = 'revoked', host_refresh_state = 'confirmed', updated_at = ?
          WHERE scope_id = ? AND export_id = ? AND state = 'host_refresh_pending'`,
      )
      .run(this.wallClockNow(), parsedScopeId, parsedExportId);
    if (sqlInteger(updated.changes, "export-refresh-changes") !== 1n) throw new StoreError("revision_conflict");
  }

  /**
   * T18c observation CAS (startup/periodic DB ↔ filesystem comparison, plan §7
   * step 3). The caller supplies the observed filesystem state for one row;
   * the store decides the state machine consequences under BEGIN IMMEDIATE:
   * foreign content on a desired-present export is a conflict, a missing file
   * re-arms the outbox (self-heal), a confirmed file promotes a crashed
   * materialized row to active, and a resolved conflict re-arms re-export.
   * Rows owned by the outbox lane (prepared, revocation_pending) are untouched.
   */
  applyManagedExportObservation(input: {
    readonly scope_id: string;
    readonly export_id: string;
    readonly observed_state: "absent" | "owned_current" | "owned_stale" | "foreign";
    readonly observed_hash: string | null;
  }): void {
    this.ensureOpen();
    const scopeId = parseContract(z.uuid(), input.scope_id, "export-scope");
    const exportId = parseContract(z.uuid(), input.export_id, "export-id");
    const observedState = parseContract(z.enum(["absent", "owned_current", "owned_stale", "foreign"]), input.observed_state, "export-observed");
    const observedHash = input.observed_hash === null ? null : parseContract(z.string().regex(/^[a-f0-9]{64}$/), input.observed_hash, "export-observed-hash");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const row = this.database
        .prepare("SELECT state, observed_state, observed_hash, expected_owner_hash, outbox_state FROM managed_export WHERE scope_id = ? AND export_id = ?")
        .get(scopeId, exportId);
      if (row === undefined) throw new StoreError("revision_invalid");
      if (sqlText(rowValue(row, "outbox_state"), "export-outbox") === "running") throw new StoreError("revision_conflict");
      const state = sqlText(rowValue(row, "state"), "export-state");
      const expectedOwnerHash = rowValue(row, "expected_owner_hash") === null ? null : sqlText(rowValue(row, "expected_owner_hash"), "export-owner-hash");
      const now = this.wallClockNow();
      if (state === "materialized" || state === "active") {
        if (observedState === "foreign") {
          this.database
            .prepare(
              `UPDATE managed_export
                  SET state = 'conflict', observed_state = 'foreign', observed_hash = ?,
                      outbox_state = 'failed', outbox_owner = NULL, outbox_lease_until = NULL,
                      outbox_last_error = 'foreign_file', updated_at = ?
                WHERE scope_id = ? AND export_id = ?`,
            )
            .run(observedHash, now, scopeId, exportId);
        } else if (observedState === "absent") {
          this.database
            .prepare(
              `UPDATE managed_export
                  SET state = 'prepared', observed_state = 'absent', observed_hash = NULL, host_refresh_state = 'not_required',
                      outbox_state = 'pending', outbox_attempts = 0, outbox_next_at = NULL,
                      outbox_owner = NULL, outbox_lease_until = NULL, outbox_fence = outbox_fence + 1,
                      outbox_last_error = NULL, updated_at = ?
                WHERE scope_id = ? AND export_id = ?`,
            )
            .run(now, scopeId, exportId);
        } else if (observedState === "owned_current") {
          if (observedHash === null) throw new StoreError("revision_invalid");
          if (state === "materialized" && expectedOwnerHash === observedHash) {
            // Crash between the materialized and active confirms: complete
            // the same CAS the worker would have run.
            this.database
              .prepare(
                `UPDATE managed_export
                    SET state = 'active', host_refresh_state = 'required',
                        observed_state = 'owned_current', observed_hash = ?, updated_at = ?
                  WHERE scope_id = ? AND export_id = ?`,
              )
              .run(observedHash, now, scopeId, exportId);
          } else if (sqlText(rowValue(row, "observed_state"), "export-observed") !== "owned_current" || rowValue(row, "observed_hash") !== observedHash) {
            this.database
              .prepare("UPDATE managed_export SET observed_state = 'owned_current', observed_hash = ?, updated_at = ? WHERE scope_id = ? AND export_id = ?")
              .run(observedHash, now, scopeId, exportId);
          }
        } else {
          // owned_stale: our own older content — re-arm the outbox to rewrite.
          this.database
            .prepare(
              `UPDATE managed_export
                  SET state = 'prepared', observed_state = 'owned_stale', observed_hash = ?, host_refresh_state = 'not_required',
                      outbox_state = 'pending', outbox_attempts = 0, outbox_next_at = NULL,
                      outbox_owner = NULL, outbox_lease_until = NULL, outbox_fence = outbox_fence + 1,
                      outbox_last_error = NULL, updated_at = ?
                WHERE scope_id = ? AND export_id = ?`,
            )
            .run(observedHash, now, scopeId, exportId);
        }
      } else if (state === "conflict") {
        if (observedState === "absent" || observedState === "owned_current") {
          this.database
            .prepare(
              `UPDATE managed_export
                  SET state = 'prepared', observed_state = ?, observed_hash = ?, host_refresh_state = 'not_required',
                      outbox_state = 'pending', outbox_attempts = 0, outbox_next_at = NULL,
                      outbox_owner = NULL, outbox_lease_until = NULL, outbox_fence = outbox_fence + 1,
                      outbox_last_error = NULL, updated_at = ?
                WHERE scope_id = ? AND export_id = ?`,
            )
            .run(observedState, observedHash, now, scopeId, exportId);
        } else if (observedState === "foreign" && observedHash !== null && rowValue(row, "observed_hash") !== observedHash) {
          this.database
            .prepare("UPDATE managed_export SET observed_hash = ?, updated_at = ? WHERE scope_id = ? AND export_id = ?")
            .run(observedHash, now, scopeId, exportId);
        }
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve the failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("revision_write_failed", error);
    }
  }

  /** T18c: reconciliation listing for due outbox rows of one scope (read-only). */
  listManagedExportsDue(scopeId: string, now: string, selection: { readonly binding_id?: string; readonly purge_operation_id?: string } = {}): readonly ManagedExportRow[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "export-scope");
    const parsedNow = parseContract(z.iso.datetime({ offset: true }), now, "export-now");
    const bindingId = selection.binding_id === undefined ? null : parseContract(z.uuid(), selection.binding_id, "export-binding");
    const operationId = selection.purge_operation_id === undefined ? null : parseContract(z.uuid(), selection.purge_operation_id, "export-purge-operation");
    return this.database.prepare(
      `SELECT ${MANAGED_EXPORT_COLUMNS} FROM managed_export
        WHERE scope_id = ?
          AND (? IS NULL OR binding_id = ?)
          AND (? IS NULL OR (purge_operation_id = ? AND desired_state = 'absent'))
          AND state <> 'revoked'
          AND (
            (outbox_state = 'pending' AND (outbox_next_at IS NULL OR outbox_next_at <= ?))
            OR (outbox_state = 'running' AND outbox_lease_until IS NOT NULL AND outbox_lease_until <= ?)
          )
        ORDER BY created_at, export_id
        LIMIT 16`,
    ).all(parsedScopeId, bindingId, bindingId, operationId, operationId, parsedNow, parsedNow).map((row) => readManagedExportRow(row as Record<string, unknown>));
  }

  /** T18c: scoped, cursor-paginated startup verification listing. */
  listManagedExportsForVerification(
    scopeId?: string,
    cursor?: { readonly created_at: string; readonly export_id: string },
    limit = 128,
    selection: { readonly binding_id?: string; readonly purge_operation_id?: string } = {},
  ): readonly ManagedExportRow[] {
    this.ensureOpen();
    const parsedScopeId = scopeId === undefined ? null : parseContract(z.uuid(), scopeId, "export-scope");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new StoreError("revision_invalid");
    const cursorAt = cursor === undefined ? null : parseContract(z.iso.datetime({ offset: true }), cursor.created_at, "export-cursor-time");
    const cursorId = cursor === undefined ? null : parseContract(z.uuid(), cursor.export_id, "export-cursor-id");
    const bindingId = selection.binding_id === undefined ? null : parseContract(z.uuid(), selection.binding_id, "export-binding");
    const operationId = selection.purge_operation_id === undefined ? null : parseContract(z.uuid(), selection.purge_operation_id, "export-purge-operation");
    return this.database.prepare(
      `SELECT ${MANAGED_EXPORT_COLUMNS} FROM managed_export
        WHERE (? IS NULL OR scope_id = ?)
          AND (? IS NULL OR binding_id = ?)
          AND (? IS NULL OR (purge_operation_id = ? AND desired_state = 'absent'))
          AND (? IS NULL OR created_at > ? OR (created_at = ? AND export_id > ?))
          AND (state IN ('materialized', 'active', 'conflict') OR staging_path IS NOT NULL)
        ORDER BY created_at, export_id
        LIMIT ?`,
    ).all(parsedScopeId, parsedScopeId, bindingId, bindingId, operationId, operationId, cursorAt, cursorAt, cursorAt, cursorId, limit).map((row) => readManagedExportRow(row as Record<string, unknown>));
  }

  /** T18c: all managed exports of one scope (export journal listing). */
  listManagedExports(scopeId: string): readonly ManagedExportRow[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "export-scope");
    return this.database.prepare(
      `SELECT ${MANAGED_EXPORT_COLUMNS} FROM managed_export WHERE scope_id = ? ORDER BY created_at, export_id`,
    ).all(parsedScopeId).map((row) => readManagedExportRow(row as Record<string, unknown>));
  }

 getRevisionStatusesForSource(scopeId: string, captureId: string): readonly string[] {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "revision-status-scope");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "revision-status-capture");
    return this.database.prepare(
      `SELECT DISTINCT i.status
         FROM memory_item AS i
         JOIN memory_revision AS r ON r.scope_id = i.scope_id AND r.item_id = i.item_id
         JOIN revision_source AS rs ON rs.scope_id = r.scope_id AND rs.revision_id = r.revision_id
        WHERE rs.scope_id = ? AND rs.source_capture_id = ?
        ORDER BY i.status`,
    ).all(parsedScopeId, parsedCaptureId).map((row) => sqlText(rowValue(row, "status"), "revision-status"));
  }

  /** Internal invalidation marker, never source content or a client-visible counter. */
  getUiChangeVersion(): string {
    this.ensureOpen();
    // Same-connection writes and other connections both invalidate the viewer.
    const external = this.database.prepare("PRAGMA data_version").get();
    const local = this.database.prepare("SELECT total_changes() AS changes").get();
    return `${sqlInteger(rowValue(external, "data_version"), "ui-data-version")}:${sqlInteger(rowValue(local, "changes"), "ui-local-changes")}`;
  }

  /** Source-linked history; every revision still passes the shared output policy. */
  getUiSourceRevisions(binding: PolicyOutputBinding, captureId: string): readonly { revision: RevisionDetail; is_latest: boolean; supporting_source_ids: readonly string[] }[] {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    const capture = parseContract(z.uuid(), captureId, "ui-revision-source");
    if (this.getSourceForOutput(capture, checked) === undefined) return [];
    const rows = this.database.prepare(`
      SELECT r.revision_id, i.current_revision_id = r.revision_id AS is_latest
      FROM memory_revision r JOIN memory_item i ON i.scope_id = r.scope_id AND i.item_id = r.item_id
      WHERE r.scope_id = ? AND EXISTS (
        SELECT 1 FROM revision_source rs JOIN memory_revision linked
          ON linked.scope_id = rs.scope_id AND linked.revision_id = rs.revision_id
        WHERE rs.scope_id = r.scope_id AND rs.source_capture_id = ? AND linked.item_id = r.item_id
      ) ORDER BY is_latest DESC, r.created_commit_seq DESC LIMIT 50
    `).all(checked.scope_id, capture);
    return rows.flatMap((row) => {
      const revision = this.revisions.readDetail(checked, sqlText(rowValue(row, "revision_id"), "ui-revision"));
      if (revision === undefined) return [];
      const supporting = this.database.prepare("SELECT DISTINCT source_capture_id FROM revision_source WHERE scope_id = ? AND revision_id = ? LIMIT 128").all(checked.scope_id, revision.revision_id);
      return [{ revision, is_latest: sqlInteger(rowValue(row, "is_latest"), "ui-revision-latest") === 1n, supporting_source_ids: supporting.map((source) => sqlText(rowValue(source, "source_capture_id"), "ui-supporting-source")) }];
    });
  }

  private readExtractionBatchLocked(batchId: string): ExtractionBatchRecord {
    const row = this.database.prepare("SELECT batch_id, job_id, scope_id, source_capture_id, task_version, input_fingerprint, input_privacy_epoch, source_token_count, source_measurement_unit, state, extraction_digest, verification_digest, completion_receipt_json, extract_attempt_id, extract_result_digest, verify_attempt_id, verify_result_digest FROM extraction_batch WHERE batch_id = ?").get(batchId);
    if (row === undefined) throw new StoreError("attempt_not_found");
    const state = sqlText(rowValue(row, "state"), "extraction-state");
    if (state !== "prepared" && state !== "extracted" && state !== "verified" && state !== "completed" && state !== "failed") throw new StoreError("schema_invalid");
    return {
      batch_id: parseContract(z.uuid(), sqlText(rowValue(row, "batch_id"), "extraction-batch-id"), "extraction-batch-id"),
      job_id: parseContract(z.uuid(), sqlText(rowValue(row, "job_id"), "extraction-job-id"), "extraction-job-id"),
      scope_id: parseContract(z.uuid(), sqlText(rowValue(row, "scope_id"), "extraction-scope-id"), "extraction-scope-id"),
      source_capture_id: parseContract(z.uuid(), sqlText(rowValue(row, "source_capture_id"), "extraction-source-id"), "extraction-source-id"),
      task_version: sqlText(rowValue(row, "task_version"), "extraction-task-version"),
      input_fingerprint: sqlText(rowValue(row, "input_fingerprint"), "extraction-input-fingerprint"),
      input_privacy_epoch: sqlText(rowValue(row, "input_privacy_epoch"), "extraction-input-privacy"),
      source_token_count: Number(sqlInteger(rowValue(row, "source_token_count"), "extraction-token-count")),
      source_measurement_unit: parseContract(z.enum(["tokens", "utf8_bytes"]), rowValue(row, "source_measurement_unit"), "extraction-measurement-unit"),
      state: state as ExtractionBatchRecord["state"],
      extraction_digest: rowValue(row, "extraction_digest") === null ? null : sqlText(rowValue(row, "extraction_digest"), "extraction-digest"),
      verification_digest: rowValue(row, "verification_digest") === null ? null : sqlText(rowValue(row, "verification_digest"), "verification-digest"),
      completion_receipt_json: rowValue(row, "completion_receipt_json") === null ? null : sqlText(rowValue(row, "completion_receipt_json"), "extraction-receipt"),
      extract_attempt_id: rowValue(row, "extract_attempt_id") === null ? null : parseContract(z.uuid(), sqlText(rowValue(row, "extract_attempt_id"), "extraction-extract-attempt"), "extraction-extract-attempt"),
      extract_result_digest: rowValue(row, "extract_result_digest") === null ? null : parseContract(extractionDigestSchema, sqlText(rowValue(row, "extract_result_digest"), "extraction-extract-digest"), "extraction-extract-digest"),
      verify_attempt_id: rowValue(row, "verify_attempt_id") === null ? null : parseContract(z.uuid(), sqlText(rowValue(row, "verify_attempt_id"), "extraction-verify-attempt"), "extraction-verify-attempt"),
      verify_result_digest: rowValue(row, "verify_result_digest") === null ? null : parseContract(extractionDigestSchema, sqlText(rowValue(row, "verify_result_digest"), "extraction-verify-digest"), "extraction-verify-digest"),
    };
  }

  private collectPurgeTargets(scopeId: string, captureIds: readonly string[]): PurgeTargets {
    const capturePlaceholders = captureIds.map(() => "?").join(", ");
    const nodes = this.database.prepare(
      `WITH RECURSIVE affected(node_type, node_id) AS (
         SELECT 'source_span', span_id
           FROM source_span
          WHERE scope_id = ? AND source_id IN (${capturePlaceholders})
         UNION
         SELECT 'memory_revision', rs.revision_id
           FROM revision_source AS rs
           JOIN affected AS a ON a.node_type = 'source_span' AND a.node_id = rs.source_span_id
          WHERE rs.scope_id = ?
         UNION
         SELECT 'memory_item', r.item_id
           FROM memory_revision AS r
           JOIN affected AS a ON a.node_type = 'memory_revision' AND a.node_id = r.revision_id
          WHERE r.scope_id = ?
         UNION
         SELECT 'memory_revision', r.revision_id
           FROM memory_revision AS r
           JOIN affected AS a ON a.node_type = 'memory_item' AND a.node_id = r.item_id
          WHERE r.scope_id = ?
         UNION
         SELECT 'memory_revision', r.revision_id
           FROM memory_revision AS r
           JOIN affected AS a ON a.node_type = 'memory_revision' AND a.node_id = r.parent_revision_id
          WHERE r.scope_id = ?
         UNION
         SELECT d.child_type, d.child_revision_id
           FROM dependency AS d
           JOIN affected AS a ON a.node_type = d.parent_type AND a.node_id = d.parent_revision_id
          WHERE d.scope_id = ?
       )
       SELECT node_type, node_id FROM affected ORDER BY node_type, node_id`,
    ).all(scopeId, ...captureIds, scopeId, scopeId, scopeId, scopeId, scopeId);
    const byType = (type: string): string[] => nodes
      .filter((row) => sqlText(rowValue(row, "node_type"), "purge-node-type") === type)
      .map((row) => sqlText(rowValue(row, "node_id"), "purge-node-id"));
    const sourceSpanIds = byType("source_span");
    const memoryRevisionIds = byType("memory_revision");
    const memoryItemIds = byType("memory_item");
    const derivedRevisionIds = byType("derived_artifact");
    const idList = (ids: readonly string[]): string => ids.map(() => "?").join(", ");
    const entityIds = memoryItemIds.length === 0
      ? []
      : this.database.prepare(
        `SELECT DISTINCT entity_id FROM memory_item WHERE scope_id = ? AND item_id IN (${idList(memoryItemIds)}) AND entity_id IS NOT NULL ORDER BY entity_id`,
      ).all(scopeId, ...memoryItemIds).map((row) => sqlText(rowValue(row, "entity_id"), "purge-entity-id"));
    const edgeClauses: string[] = [];
    const edgeArgs: SQLInputValue[] = [scopeId];
    if (memoryRevisionIds.length > 0) {
      edgeClauses.push(`e.evidence_revision IN (${idList(memoryRevisionIds)})`);
      edgeArgs.push(...memoryRevisionIds);
    }
    const semanticEdgeIds = edgeClauses.length === 0
      ? []
      : this.database.prepare(
        `SELECT e.edge_id FROM semantic_edge AS e WHERE e.scope_id = ? AND (${edgeClauses.join(" OR ")}) ORDER BY e.edge_id`,
      ).all(...edgeArgs).map((row) => sqlText(rowValue(row, "edge_id"), "purge-edge-id"));
    const edgeEntityIds = semanticEdgeIds.length === 0
      ? []
      : this.database.prepare(
        `SELECT entity_id FROM (SELECT source_entity AS entity_id FROM semantic_edge WHERE scope_id = ? AND edge_id IN (${idList(semanticEdgeIds)}) UNION SELECT target_entity AS entity_id FROM semantic_edge WHERE scope_id = ? AND edge_id IN (${idList(semanticEdgeIds)})) ORDER BY entity_id`,
      ).all(scopeId, ...semanticEdgeIds, scopeId, ...semanticEdgeIds).map((row) => sqlText(rowValue(row, "entity_id"), "purge-edge-entity-id"));
    const extractionBatchIds = this.database.prepare(
      `SELECT b.batch_id FROM extraction_batch b WHERE b.scope_id = ? AND
        (b.source_capture_id IN (${capturePlaceholders}) OR EXISTS
          (SELECT 1 FROM extraction_batch_source s WHERE s.batch_id = b.batch_id AND s.capture_id IN (${capturePlaceholders}))) ORDER BY b.batch_id`,
    ).all(scopeId, ...captureIds, ...captureIds).map((row) => sqlText(rowValue(row, "batch_id"), "purge-batch-id"));
    const managedExportClauses: string[] = [];
    const managedExportArgs: SQLInputValue[] = [scopeId];
    if (memoryItemIds.length > 0) {
      managedExportClauses.push(`procedure_item_id IN (${idList(memoryItemIds)})`);
      managedExportArgs.push(...memoryItemIds);
    }
    if (memoryRevisionIds.length > 0) {
      managedExportClauses.push(`procedure_revision_id IN (${idList(memoryRevisionIds)})`);
      managedExportArgs.push(...memoryRevisionIds);
    }
    const managedExportIds = managedExportClauses.length === 0
      ? []
      : this.database.prepare(
        `SELECT export_id FROM managed_export WHERE scope_id = ? AND (${managedExportClauses.join(" OR ")}) ORDER BY export_id`,
      ).all(...managedExportArgs).map((row) => sqlText(rowValue(row, "export_id"), "purge-export-id"));
    return {
      source_span_ids: sourceSpanIds,
      memory_revision_ids: memoryRevisionIds,
      memory_item_ids: memoryItemIds,
      entity_ids: [...new Set([...entityIds, ...edgeEntityIds])].sort(),
      derived_revision_ids: derivedRevisionIds,
      semantic_edge_ids: semanticEdgeIds,
      extraction_batch_ids: extractionBatchIds,
      managed_export_ids: managedExportIds,
    };
  }

  private withPurgeDeleteTriggersDisabled<T>(operation: () => T): T {
    const triggerRows = this.database.prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${PURGE_DELETE_TRIGGERS.map(() => "?").join(", ")})`,
    ).all(...PURGE_DELETE_TRIGGERS);
    const definitions = triggerRows.map((row) => ({
      name: sqlText(rowValue(row, "name"), "purge-trigger-name"),
      sql: sqlText(rowValue(row, "sql"), "purge-trigger-sql"),
    }));
    for (const trigger of definitions) this.database.exec(`DROP TRIGGER ${trigger.name}`);
    try {
      const result = operation();
      for (const trigger of definitions) this.database.exec(trigger.sql);
      return result;
    } catch (error: unknown) {
      for (const trigger of definitions) {
        try { this.database.exec(trigger.sql); } catch { /* preserve the purge failure */ }
      }
      throw error;
    }
  }

  private deleteFullPurgeContent(scopeId: string, captureIds: readonly string[]): boolean {
    const targets = this.collectPurgeTargets(scopeId, captureIds);
    const idList = (ids: readonly string[]): string => ids.map(() => "?").join(", ");
    if (targets.managed_export_ids.length > 0) {
      const pending = this.database.prepare(
        `SELECT 1 AS present FROM managed_export WHERE scope_id = ? AND export_id IN (${idList(targets.managed_export_ids)}) AND state <> 'revoked' LIMIT 1`,
      ).get(scopeId, ...targets.managed_export_ids);
      if (pending !== undefined) return false;
    }
    this.withPurgeDeleteTriggersDisabled(() => {
      if (targets.managed_export_ids.length > 0) {
        this.database.prepare(`DELETE FROM managed_export WHERE scope_id = ? AND export_id IN (${idList(targets.managed_export_ids)}) AND state = 'revoked'`).run(scopeId, ...targets.managed_export_ids);
      }
      if (targets.extraction_batch_ids.length > 0) {
        // Recompute retained primaries only once their old frozen inputs are being removed.
        this.database.prepare(`UPDATE job SET state = 'pending_extraction', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = NULL,
          input_privacy_epoch = (SELECT CAST(privacy_epoch AS TEXT) FROM scope WHERE scope_id = ?)
          WHERE scope_id = ? AND source_capture_id NOT IN (SELECT value FROM json_each(?))
          AND job_id IN (SELECT job_id FROM extraction_batch WHERE batch_id IN (SELECT value FROM json_each(?)))`).run(scopeId, scopeId, JSON.stringify(captureIds), JSON.stringify(targets.extraction_batch_ids));
        this.database.prepare(`DELETE FROM extraction_verdict WHERE batch_id IN (${idList(targets.extraction_batch_ids)})`).run(...targets.extraction_batch_ids);
        this.database.prepare(`DELETE FROM extraction_candidate WHERE batch_id IN (${idList(targets.extraction_batch_ids)})`).run(...targets.extraction_batch_ids);
        this.database.prepare(`DELETE FROM extraction_batch_source WHERE batch_id IN (${idList(targets.extraction_batch_ids)})`).run(...targets.extraction_batch_ids);
        this.database.prepare(`DELETE FROM extraction_batch WHERE batch_id IN (${idList(targets.extraction_batch_ids)})`).run(...targets.extraction_batch_ids);
      }
      const vectorSelection = "scope_id = ? AND (source_id IN (SELECT value FROM json_each(?)) OR revision_id IN (SELECT value FROM json_each(?)))";
      const vectorArgs = [scopeId, JSON.stringify(captureIds), JSON.stringify(targets.memory_revision_ids)];
      if (this.vectorQualification !== undefined) this.database.prepare(`DELETE FROM vector_embedding_vec WHERE rowid IN (SELECT rowid FROM vector_chunk WHERE ${vectorSelection})`).run(...vectorArgs);
      this.database.prepare(`DELETE FROM vector_embedding WHERE chunk_id IN (SELECT chunk_id FROM vector_chunk WHERE ${vectorSelection})`).run(...vectorArgs);
      this.database.prepare(`DELETE FROM vector_chunk WHERE ${vectorSelection}`).run(...vectorArgs);
      this.database.prepare(`DELETE FROM search_document WHERE scope_id = ? AND source_id IN (${idList(captureIds)})`).run(scopeId, ...captureIds);
      if (targets.memory_item_ids.length > 0) {
        this.database.prepare(`DELETE FROM state_segment WHERE scope_id = ? AND item_id IN (${idList(targets.memory_item_ids)})`).run(scopeId, ...targets.memory_item_ids);
      }
      if (targets.memory_revision_ids.length > 0) {
        this.database.prepare(`DELETE FROM temporal_intent WHERE scope_id = ? AND revision_id IN (${idList(targets.memory_revision_ids)})`).run(scopeId, ...targets.memory_revision_ids);
      }
      if (targets.semantic_edge_ids.length > 0) {
        this.database.prepare(`DELETE FROM semantic_edge WHERE scope_id = ? AND edge_id IN (${idList(targets.semantic_edge_ids)})`).run(scopeId, ...targets.semantic_edge_ids);
      }
      if (targets.memory_item_ids.length > 0 || targets.memory_revision_ids.length > 0) {
        const memberClauses: string[] = [];
        const memberArgs: SQLInputValue[] = [scopeId];
        if (targets.memory_item_ids.length > 0) { memberClauses.push(`item_id IN (${idList(targets.memory_item_ids)})`); memberArgs.push(...targets.memory_item_ids); }
        if (targets.memory_revision_ids.length > 0) { memberClauses.push(`revision_id IN (${idList(targets.memory_revision_ids)})`); memberArgs.push(...targets.memory_revision_ids); }
        this.database.prepare(`UPDATE semantic_slot SET generation = generation + 1 WHERE scope_id = ? AND EXISTS (SELECT 1 FROM semantic_slot_member m WHERE m.scope_id = semantic_slot.scope_id AND m.entity_id = semantic_slot.entity_id AND m.predicate = semantic_slot.predicate AND m.qualifiers_digest = semantic_slot.qualifiers_digest AND (${memberClauses.map((clause) => `m.${clause}`).join(" OR ")}))`).run(...memberArgs);
        this.database.prepare(`DELETE FROM semantic_slot_member WHERE scope_id = ? AND (${memberClauses.join(" OR ")})`).run(...memberArgs);
      }
      if (targets.memory_item_ids.length > 0) {
        const entityIds = targets.entity_ids;
        if (entityIds.length > 0) {
          this.database.prepare(`DELETE FROM semantic_slot WHERE scope_id = ? AND entity_id IN (${idList(entityIds)}) AND NOT EXISTS (SELECT 1 FROM semantic_slot_member AS m WHERE m.scope_id = semantic_slot.scope_id AND m.entity_id = semantic_slot.entity_id AND m.predicate = semantic_slot.predicate AND m.qualifiers_digest = semantic_slot.qualifiers_digest)`).run(scopeId, ...entityIds);
        }
        this.database.prepare(`DELETE FROM procedure_activation WHERE scope_id = ? AND procedure_item_id IN (${idList(targets.memory_item_ids)})`).run(scopeId, ...targets.memory_item_ids);
        this.database.prepare(`UPDATE memory_item SET current_revision_id = NULL WHERE scope_id = ? AND item_id IN (${idList(targets.memory_item_ids)})`).run(scopeId, ...targets.memory_item_ids);
      }
      if (targets.memory_revision_ids.length > 0) {
        this.database.prepare(`DELETE FROM revision_source WHERE scope_id = ? AND revision_id IN (${idList(targets.memory_revision_ids)})`).run(scopeId, ...targets.memory_revision_ids);
        this.database.prepare(`DELETE FROM revision_operation WHERE scope_id = ? AND (result_item_id IN (${idList(targets.memory_item_ids.length > 0 ? targets.memory_item_ids : ["00000000-0000-4000-8000-000000000000"])}) OR result_revision_id IN (${idList(targets.memory_revision_ids)}))`).run(scopeId, ...(targets.memory_item_ids.length > 0 ? targets.memory_item_ids : ["00000000-0000-4000-8000-000000000000"]), ...targets.memory_revision_ids);
      }
      const dependencyClauses: string[] = [];
      const dependencyArgs: SQLInputValue[] = [scopeId];
      if (targets.source_span_ids.length > 0) { dependencyClauses.push(`(parent_type = 'source_span' AND parent_revision_id IN (${idList(targets.source_span_ids)}))`); dependencyArgs.push(...targets.source_span_ids); }
      if (targets.memory_revision_ids.length > 0) { dependencyClauses.push(`((parent_type = 'memory_revision' AND parent_revision_id IN (${idList(targets.memory_revision_ids)})) OR (child_type = 'memory_revision' AND child_revision_id IN (${idList(targets.memory_revision_ids)})))`); dependencyArgs.push(...targets.memory_revision_ids, ...targets.memory_revision_ids); }
      if (targets.derived_revision_ids.length > 0) { dependencyClauses.push(`((parent_type = 'derived_artifact' AND parent_revision_id IN (${idList(targets.derived_revision_ids)})) OR (child_type = 'derived_artifact' AND child_revision_id IN (${idList(targets.derived_revision_ids)})))`); dependencyArgs.push(...targets.derived_revision_ids, ...targets.derived_revision_ids); }
      if (dependencyClauses.length > 0) this.database.prepare(`DELETE FROM dependency WHERE scope_id = ? AND (${dependencyClauses.join(" OR ")})`).run(...dependencyArgs);
      if (targets.derived_revision_ids.length > 0) this.database.prepare(`DELETE FROM derived_artifact WHERE scope_id = ? AND revision_id IN (${idList(targets.derived_revision_ids)})`).run(scopeId, ...targets.derived_revision_ids);
      if (targets.memory_revision_ids.length > 0) this.database.prepare(`DELETE FROM memory_revision WHERE scope_id = ? AND revision_id IN (${idList(targets.memory_revision_ids)})`).run(scopeId, ...targets.memory_revision_ids);
      if (targets.memory_item_ids.length > 0) this.database.prepare(`DELETE FROM memory_item WHERE scope_id = ? AND item_id IN (${idList(targets.memory_item_ids)})`).run(scopeId, ...targets.memory_item_ids);
      if (targets.memory_item_ids.length > 0) {
        const entityIds = targets.entity_ids;
        if (entityIds.length > 0) this.database.prepare(`DELETE FROM entity WHERE scope_id = ? AND entity_id IN (${idList(entityIds)}) AND NOT EXISTS (SELECT 1 FROM memory_item AS i WHERE i.scope_id = entity.scope_id AND i.entity_id = entity.entity_id) AND NOT EXISTS (SELECT 1 FROM semantic_edge AS e WHERE e.scope_id = entity.scope_id AND (e.source_entity = entity.entity_id OR e.target_entity = entity.entity_id)) AND NOT EXISTS (SELECT 1 FROM semantic_slot AS s WHERE s.scope_id = entity.scope_id AND s.entity_id = entity.entity_id)`).run(scopeId, ...entityIds);
      }
      this.database.prepare(`DELETE FROM source_span WHERE scope_id = ? AND source_id IN (${idList(captureIds)})`).run(scopeId, ...captureIds);
      this.database.prepare(`DELETE FROM job WHERE scope_id = ? AND source_capture_id IN (${idList(captureIds)})`).run(scopeId, ...captureIds);
      this.database.prepare(`DELETE FROM source_event WHERE scope_id = ? AND capture_id IN (${idList(captureIds)})`).run(scopeId, ...captureIds);
      this.database.prepare("DELETE FROM query_trace WHERE EXISTS (SELECT 1 FROM json_each(query_trace.scope_ids_json) WHERE value = ?)").run(scopeId);
      this.database.prepare(`DELETE FROM session WHERE scope_id = ? AND NOT EXISTS (SELECT 1 FROM source_event AS e WHERE e.scope_id = session.scope_id AND e.session_id = session.session_id)`).run(scopeId);
      const counter = this.database.prepare("SELECT data_epoch FROM vault_counter WHERE id = 1").get();
      const nextDataEpoch = sqlInteger(rowValue(counter, "data_epoch"), "purge-data-epoch") + 1n;
      this.database.prepare("UPDATE vault_counter SET data_epoch = ? WHERE id = 1").run(nextDataEpoch);
      this.database.prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?").run(nextDataEpoch, scopeId);
    });
    return true;
  }

  getPurgeRequestForSource(binding: PolicySetupBinding, scopeId: string, captureId: string): PurgeExecutionRequest | undefined {
    if (!isPolicySetupBinding(binding)) throw new StoreError("policy_invalid");
    requirePolicySetup(binding, scopeId, "purge_scope_not_allowed");
    const row = this.database.prepare("SELECT p.operation_id, p.expected_privacy_epoch, p.requested_at FROM purge_tombstone t JOIN purge_operation p ON p.operation_id = t.operation_id WHERE t.scope_id = ? AND t.capture_id = ?").get(scopeId, captureId);
    if (row === undefined) return undefined;
    const operationId = sqlText(rowValue(row, "operation_id"), "purge-id");
    return { operation_id: operationId, scope_id: scopeId, capture_ids: this.database.prepare("SELECT capture_id FROM purge_tombstone WHERE operation_id = ? ORDER BY capture_id").all(operationId).map((item) => sqlText(rowValue(item, "capture_id"), "purge-capture")), expected_privacy_epoch: sqlText(rowValue(row, "expected_privacy_epoch"), "purge-epoch"), requested_at: sqlText(rowValue(row, "requested_at"), "purge-requested") };
  }

  getPurgeRuntimeState(operationId: string): { state: string; owner: string | null } {
    this.ensureOpen();
    const row = this.database.prepare("SELECT runtime_reset_state, runtime_reset_owner FROM purge_operation WHERE operation_id = ?").get(operationId);
    if (row === undefined) throw new StoreError("purge_operation_conflict");
    return { state: sqlText(rowValue(row, "runtime_reset_state"), "purge-runtime-state"), owner: rowValue(row, "runtime_reset_owner") === null ? null : sqlText(rowValue(row, "runtime_reset_owner"), "purge-runtime-owner") };
  }

  recordPurgeRuntimeState(binding: PolicySetupBinding, scopeId: string, operationId: string, owner: string, state: "required" | "complete" | "not_required"): void {
    if (!isPolicySetupBinding(binding)) throw new StoreError("policy_invalid");
    requirePolicySetup(binding, scopeId, "purge_scope_not_allowed");
    parseContract(z.string().min(1).max(128), owner, "purge-runtime-owner");
    const current = this.getPurgeRuntimeState(operationId);
    if (current.state === "complete" || current.state === "not_required") return;
    if (current.owner !== null && current.owner !== owner) throw new StoreError("purge_operation_conflict");
    if (current.state === "required" && state === "not_required") throw new StoreError("purge_operation_conflict");
    const updated = this.database.prepare("UPDATE purge_operation SET runtime_reset_state = ?, runtime_reset_owner = ? WHERE operation_id = ? AND scope_id = ? AND state <> 'completed'").run(state, owner, operationId, scopeId);
    if (sqlInteger(updated.changes, "purge-reset-changes") !== 1n) throw new StoreError("purge_operation_conflict");
  }

  purgeSources(binding: PolicySetupBinding, request: PurgeExecutionRequest): PurgeExecutionResult {
    this.ensureOpen();
    if (!isPolicySetupBinding(binding)) throw new StoreError("policy_invalid");
    requirePolicySetup(binding, request.scope_id, "purge_scope_not_allowed");
    if (!z.uuid().safeParse(request.operation_id).success || !z.uuid().safeParse(request.scope_id).success) {
      throw new StoreError("purge_selection_invalid");
    }
    if (
      !Array.isArray(request.capture_ids) ||
      request.capture_ids.length < 1 ||
      request.capture_ids.length > 128 ||
      new Set(request.capture_ids).size !== request.capture_ids.length ||
      request.capture_ids.some((captureId) => !z.uuid().safeParse(captureId).success)
    ) {
      throw new StoreError("purge_selection_invalid");
    }
    const expectedEpoch = parseContract(nonNegativeInt64Schema, request.expected_privacy_epoch, "privacy-epoch");
    const requestedAt = parseContract(z.iso.datetime({ offset: true }), request.requested_at, "purge-requested-at");

    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error: unknown) {
      throw new StoreError("purge_pending", error);
    }
    let committed = false;
    let operationState: "barrier" | "content_deleted" | "completed";
    let selectedCount: number;
    try {
      const scope = this.database
        .prepare("SELECT privacy_epoch FROM scope WHERE scope_id = ?")
        .get(request.scope_id);
      if (scope === undefined) throw new StoreError("scope_not_registered");
      const currentEpoch = sqlInteger(rowValue(scope, "privacy_epoch"), "privacy_epoch");
      const operation = this.database
        .prepare("SELECT scope_id, expected_privacy_epoch, state, selected_count FROM purge_operation WHERE operation_id = ?")
        .get(request.operation_id);
      if (operation === undefined) {
        if (currentEpoch.toString(10) !== expectedEpoch) throw new StoreError("purge_epoch_mismatch");
        const placeholders = request.capture_ids.map(() => "?").join(", ");
        const selected = this.database
          .prepare(`SELECT COUNT(*) AS count FROM source_event WHERE scope_id = ? AND capture_id IN (${placeholders})`)
          .get(request.scope_id, ...request.capture_ids);
        const selectedSourceCount = sqlInteger(rowValue(selected, "count"), "selected_source_count");
        if (selectedSourceCount !== BigInt(request.capture_ids.length)) {
          throw new StoreError("purge_selection_invalid");
        }
        const existingTombstones = this.database
          .prepare(`SELECT COUNT(*) AS count FROM purge_tombstone WHERE scope_id = ? AND capture_id IN (${placeholders})`)
          .get(request.scope_id, ...request.capture_ids);
        if (sqlInteger(rowValue(existingTombstones, "count"), "existing_tombstone_count") !== 0n) {
          throw new StoreError("purge_operation_conflict");
        }
        const nextEpoch = nextPrivacyEpoch(currentEpoch);
        this.database
          .prepare(
            `INSERT INTO purge_operation (
               operation_id, scope_id, expected_privacy_epoch, state, selected_count, requested_at, updated_at
             ) VALUES (?, ?, ?, 'barrier', ?, ?, ?)`,
          )
          .run(request.operation_id, request.scope_id, expectedEpoch, request.capture_ids.length, requestedAt, requestedAt);
        const tombstone = this.database.prepare(
          "INSERT INTO purge_tombstone (capture_id, scope_id, operation_id, created_at) VALUES (?, ?, ?, ?)",
        );
        for (const captureId of request.capture_ids) {
          tombstone.run(captureId, request.scope_id, request.operation_id, requestedAt);
        }
        this.purgeNativeObservationsLocked(request.scope_id, request.operation_id, request.capture_ids, requestedAt);
        const targets = this.collectPurgeTargets(request.scope_id, request.capture_ids);
        const executionBatchIds = this.database.prepare(`SELECT batch_id FROM execution_batch WHERE scope_id = ? AND
          (source_capture_id IN (SELECT value FROM json_each(?)) OR job_id IN
            (SELECT job_id FROM extraction_batch WHERE batch_id IN (SELECT value FROM json_each(?)) ))`)
          .all(request.scope_id, JSON.stringify(request.capture_ids), JSON.stringify(targets.extraction_batch_ids)).map((row) => sqlText(rowValue(row, "batch_id"), "purge-execution-batch"));
        this.database.prepare("UPDATE purge_operation SET cleanup_batch_ids_json = ? WHERE operation_id = ?").run(JSON.stringify(executionBatchIds), request.operation_id);
        this.database
          .prepare(
            `UPDATE managed_export
                SET desired_state = 'absent',
                    state = CASE WHEN state = 'host_refresh_pending' THEN state ELSE 'revocation_pending' END,
                    purge_operation_id = ?,
                    outbox_state = CASE WHEN state = 'host_refresh_pending' THEN outbox_state ELSE 'pending' END,
                    outbox_attempts = CASE WHEN state = 'host_refresh_pending' THEN outbox_attempts ELSE 0 END,
                    outbox_next_at = CASE WHEN state = 'host_refresh_pending' THEN outbox_next_at ELSE NULL END,
                    outbox_owner = CASE WHEN state = 'host_refresh_pending' THEN outbox_owner ELSE NULL END,
                    outbox_lease_until = CASE WHEN state = 'host_refresh_pending' THEN outbox_lease_until ELSE NULL END,
                    outbox_fence = CASE WHEN state = 'host_refresh_pending' THEN outbox_fence ELSE outbox_fence + 1 END,
                    outbox_last_error = CASE WHEN state = 'host_refresh_pending' THEN outbox_last_error ELSE 'source_purged' END,
                    updated_at = ?
              WHERE scope_id = ? AND state <> 'revoked'
                AND export_id IN (SELECT value FROM json_each(?))`,
          )
          .run(request.operation_id, requestedAt, request.scope_id, JSON.stringify(targets.managed_export_ids));
        const selectedPlaceholders = request.capture_ids.map(() => "?").join(", ");
        this.database.prepare(
          `UPDATE execution_attempt SET state = 'cleanup_pending', cleanup_state = 'pending', cleanup_reason = 'source_purged', updated_at = ?
             WHERE batch_id IN (SELECT value FROM json_each(?))
               AND state NOT IN ('failed', 'aborted')
               AND NOT (profile_id = 'XP-Local' AND provider_id = 'local-endpoint'
                 AND state = 'reconciled' AND cleanup_state = 'confirmed'
                 AND terminal_status IS NOT NULL AND terminal_at IS NOT NULL AND cleanup_at IS NOT NULL
                 AND runtime_session_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM runtime_artifact a WHERE a.attempt_id = execution_attempt.attempt_id))`,
        ).run(requestedAt, JSON.stringify(executionBatchIds));
        this.database.prepare(
          `UPDATE execution_batch SET state = 'paused', failure_reason = 'source_purged', updated_at = ?
             WHERE batch_id IN (SELECT value FROM json_each(?)) AND state NOT IN ('failed', 'reconciled')`,
        ).run(requestedAt, JSON.stringify(executionBatchIds));
        this.database.prepare(
          `UPDATE job SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = 'source_purged'
             WHERE scope_id = ? AND source_capture_id IN (${selectedPlaceholders}) AND state <> 'completed'`,
        ).run(request.scope_id, ...request.capture_ids);
        this.database.prepare(`UPDATE job SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL,
          fence = fence + 1, input_privacy_epoch = ?, pause_reason = 'source_purged', completion_receipt_json = NULL
          WHERE scope_id = ? AND source_capture_id NOT IN (${selectedPlaceholders}) AND job_id IN
          (SELECT job_id FROM extraction_batch WHERE batch_id IN (SELECT value FROM json_each(?)))`).run(nextEpoch.toString(), request.scope_id, ...request.capture_ids, JSON.stringify(targets.extraction_batch_ids));
        const scopeUpdated = this.database
          .prepare("UPDATE scope SET privacy_epoch = ? WHERE scope_id = ?")
          .run(nextEpoch, request.scope_id);
        if (sqlInteger(scopeUpdated.changes, "scope_changes") !== 1n) throw new StoreError("purge_selection_invalid");
        operationState = "barrier";
        selectedCount = request.capture_ids.length;
      } else {
        if (sqlText(rowValue(operation, "scope_id"), "operation_scope") !== request.scope_id) {
          throw new StoreError("purge_operation_conflict");
        }
        if (sqlText(rowValue(operation, "expected_privacy_epoch"), "operation_epoch") !== expectedEpoch) {
          throw new StoreError("purge_operation_conflict");
        }
        selectedCount = Number(sqlInteger(rowValue(operation, "selected_count"), "selected_count"));
        if (selectedCount !== request.capture_ids.length) throw new StoreError("purge_operation_conflict");
        const tombstones = this.database
          .prepare("SELECT capture_id FROM purge_tombstone WHERE operation_id = ? ORDER BY capture_id")
          .all(request.operation_id)
          .map((row) => sqlText(rowValue(row, "capture_id"), "capture_id"));
        if (tombstones.length !== request.capture_ids.length || tombstones.some((id) => !request.capture_ids.includes(id))) {
          throw new StoreError("purge_operation_conflict");
        }
        operationState = sqlText(rowValue(operation, "state"), "operation_state") as typeof operationState;
        if (operationState !== "barrier" && operationState !== "content_deleted" && operationState !== "completed") {
          throw new StoreError("purge_operation_conflict");
        }
        if (operationState === "barrier") {
          this.purgeNativeObservationsLocked(request.scope_id, request.operation_id, request.capture_ids, requestedAt);
        }
      }
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the purge barrier failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("purge_pending", error);
    }

    const currentPrivacyEpoch = this.getScopePrivacyEpoch(request.scope_id);
    if (!purgeManagedBackups(this.database, request.scope_id)) {
      return { operation_id: request.operation_id, scope_id: request.scope_id, state: "pending", privacy_epoch: currentPrivacyEpoch, selected_count: selectedCount, physical_cleanup: "pending" };
    }

    if (operationState === "completed") {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "completed",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "complete",
      };
    }

    try {
      this.database.exec("PRAGMA secure_delete = ON");
      this.database.exec("INSERT INTO search_fts (search_fts, rank) VALUES ('secure-delete', 1)");
      this.database.exec("BEGIN IMMEDIATE");
      // Revision histories contain self references; enforce their closure at commit.
      this.database.exec("PRAGMA defer_foreign_keys = ON");
      let deletionCommitted = false;
      try {
        const current = this.database
          .prepare("SELECT state, scope_id, selected_count FROM purge_operation WHERE operation_id = ?")
          .get(request.operation_id);
        if (current === undefined || sqlText(rowValue(current, "scope_id"), "operation_scope") !== request.scope_id) {
          throw new StoreError("purge_operation_conflict");
        }
        const state = sqlText(rowValue(current, "state"), "operation_state");
        if (state === "completed") {
          operationState = "completed";
        } else if (state === "barrier") {
          if (this.deleteFullPurgeContent(request.scope_id, request.capture_ids)) {
            const updated = this.database.prepare("UPDATE purge_operation SET state = 'content_deleted', updated_at = ? WHERE operation_id = ? AND state = 'barrier'").run(request.requested_at, request.operation_id);
            if (sqlInteger(updated.changes, "purge_changes") !== 1n) throw new StoreError("purge_operation_conflict");
            operationState = "content_deleted";
          }
        } else if (state !== "content_deleted" && state !== "completed") {
          throw new StoreError("purge_operation_conflict");
        }
        this.database.exec("COMMIT");
        deletionCommitted = true;
      } catch (error: unknown) {
        if (!deletionCommitted) {
          try {
            this.database.exec("ROLLBACK");
          } catch {
            // Preserve the pending cleanup state.
          }
        }
        if (error instanceof StoreError) throw error;
        throw new StoreError("purge_pending", error);
      }
    } catch (error: unknown) {
      if (error instanceof StoreError && error.code === "purge_operation_conflict") throw error;
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "pending",
      };
    }

    if (operationState === "completed") {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "completed",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "complete",
      };
    }

    try {
      if (!this.runtimeArtifacts.reconcileSourceSync(request.scope_id, request.capture_ids)) {
        return {
          operation_id: request.operation_id,
          scope_id: request.scope_id,
          state: "pending",
          privacy_epoch: currentPrivacyEpoch,
          selected_count: selectedCount,
          physical_cleanup: "pending",
        };
      }
    } catch {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "pending",
      };
    }

    if (!this.finishPurgePhysicalCleanup(true)) {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "pending",
      };
    }

    // The SQLite payload can be physically clean while a source-derived
    // managed export still exists on the host. Keep the purge operation open
    // until its outbox cleanup and required host refresh are complete.
    const managedExportPending = this.database
      .prepare("SELECT 1 AS present FROM managed_export WHERE scope_id = ? AND purge_operation_id = ? AND state <> 'revoked' LIMIT 1")
      .get(request.scope_id, request.operation_id);
    if (managedExportPending !== undefined) {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "pending",
      };
    }

    if (request.defer_completion === true || !["complete", "not_required"].includes(this.getPurgeRuntimeState(request.operation_id).state)) {
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "complete",
      };
    }

    try {
      this.database.exec("BEGIN IMMEDIATE");
      const updated = this.database
        .prepare("UPDATE purge_operation SET state = 'completed', updated_at = ? WHERE operation_id = ? AND state = 'content_deleted'")
        .run(request.requested_at, request.operation_id);
      if (sqlInteger(updated.changes, "purge_changes") !== 1n) {
        this.database.exec("ROLLBACK");
        throw new StoreError("purge_pending");
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the completion failure.
      }
      if (error instanceof StoreError && error.code === "purge_pending") {
        return {
          operation_id: request.operation_id,
          scope_id: request.scope_id,
          state: "pending",
          privacy_epoch: currentPrivacyEpoch,
          selected_count: selectedCount,
          physical_cleanup: "pending",
        };
      }
      return {
        operation_id: request.operation_id,
        scope_id: request.scope_id,
        state: "pending",
        privacy_epoch: currentPrivacyEpoch,
        selected_count: selectedCount,
        physical_cleanup: "pending",
      };
    }
    return {
      operation_id: request.operation_id,
      scope_id: request.scope_id,
      state: "completed",
      privacy_epoch: currentPrivacyEpoch,
      selected_count: selectedCount,
      physical_cleanup: "complete",
    };
  }

  /**
   * Purge hook owned by the native observation store. It runs inside the
   * existing source barrier, clears content digests, and leaves only identity
   * fences so an old OpenCode snapshot cannot be replayed after deletion.
   */
  private purgeNativeObservationsLocked(scopeId: string, operationId: string, captureIds: readonly string[], createdAt: string): void {
    if (captureIds.length === 0) return;
    const placeholders = captureIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT binding_id, native_session_id, identity_kind, identity_key, message_id, part_id, capture_id
           FROM opencode_observation_receipt
          WHERE scope_id = ? AND capture_id IN (${placeholders})`,
      )
      .all(scopeId, ...captureIds);
    const tombstone = this.database.prepare(
      `INSERT OR IGNORE INTO opencode_identity_tombstone (
         scope_id, binding_id, native_session_id, identity_kind, identity_key,
         message_id, part_id, operation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const blockedHeads = new Set<string>();
    for (const row of rows) {
      const bindingId = sqlText(rowValue(row, "binding_id"), "native-purge-binding");
      const nativeSessionId = sqlText(rowValue(row, "native_session_id"), "native-purge-session");
      const identityKind = sqlText(rowValue(row, "identity_kind"), "native-purge-kind");
      const identityKey = sqlText(rowValue(row, "identity_key"), "native-purge-key");
      const messageId = rowValue(row, "message_id") === null ? null : sqlText(rowValue(row, "message_id"), "native-purge-message");
      const partId = rowValue(row, "part_id") === null ? null : sqlText(rowValue(row, "part_id"), "native-purge-part");
      tombstone.run(scopeId, bindingId, nativeSessionId, identityKind, identityKey, messageId, partId, operationId, createdAt);
      if (messageId !== null && partId !== null) {
        blockedHeads.add(`${bindingId}\u0000${nativeSessionId}\u0000${messageId}\u0000${partId}`);
      }
      // chat.message can contain several text parts. Its source records their
      // native IDs; fence every contributed address before deleting that source.
      if (identityKind === "event" && messageId !== null) {
        const source = this.database.prepare("SELECT payload_json, observed_stage FROM source_event WHERE scope_id = ? AND capture_id = ?")
          .get(scopeId, sqlText(rowValue(row, "capture_id"), "native-purge-capture"));
        if (source !== undefined && rowValue(source, "observed_stage") === "prompt_submitted") {
          const payload: unknown = JSON.parse(sqlText(rowValue(source, "payload_json"), "native-purge-payload"));
          const ids = typeof payload === "object" && payload !== null && "part_ids" in payload ? payload.part_ids : undefined;
          if (Array.isArray(ids)) for (const id of ids) {
            if (typeof id !== "string" || id.length === 0 || id.length > 256 || id.includes("\u0000")) continue;
            const address = `${nativeSessionId}\u0000${messageId}\u0000${id}`;
            tombstone.run(scopeId, bindingId, nativeSessionId, "part_snapshot", address, messageId, id, operationId, createdAt);
            blockedHeads.add(`${bindingId}\u0000${address}`);
          }
        }
      }
    }
    const currentHeads = this.database
      .prepare(
        `SELECT binding_id, native_session_id, message_id, part_id
           FROM opencode_observation_head
          WHERE scope_id = ? AND current_capture_id IN (${placeholders})`,
      )
      .all(scopeId, ...captureIds);
    for (const row of currentHeads) {
      const bindingId = sqlText(rowValue(row, "binding_id"), "native-purge-binding");
      const nativeSessionId = sqlText(rowValue(row, "native_session_id"), "native-purge-session");
      const messageId = sqlText(rowValue(row, "message_id"), "native-purge-message");
      const partId = sqlText(rowValue(row, "part_id"), "native-purge-part");
      blockedHeads.add(`${bindingId}\u0000${nativeSessionId}\u0000${messageId}\u0000${partId}`);
    }
    for (const key of blockedHeads) {
      const [bindingId, nativeSessionId, messageId, partId] = key.split("\u0000");
      if (bindingId === undefined || nativeSessionId === undefined || messageId === undefined || partId === undefined) continue;
      this.database
        .prepare(
          `UPDATE opencode_observation_head
              SET state = 'blocked', current_capture_id = NULL, current_digest = NULL,
                  first_observed_at = NULL, last_observed_at = ?, last_scan_id = NULL
            WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ? AND part_id = ?`,
        )
        .run(createdAt, scopeId, bindingId, nativeSessionId, messageId, partId);
    }
    this.database
      .prepare(
        `UPDATE opencode_observation_receipt
            SET state = 'purged', content_digest = NULL
          WHERE scope_id = ? AND capture_id IN (${placeholders})`,
      )
      .run(scopeId, ...captureIds);
    this.database
      .prepare(
        `UPDATE opencode_reconcile_scan
            SET state = 'invalidated', cursor_json = NULL,
                coverage_json = ?, updated_at = ?
          WHERE scope_id = ? AND state = 'active'`,
      )
      .run(JSON.stringify({ status: "coverage_gap", reason: "purged" }), createdAt, scopeId);
  }

  private finishPurgePhysicalCleanup(vacuum = false): boolean {
    const result = this.performPhysicalMaintenance({ vacuum });
    return result.secure_delete === "complete" && result.fts_secure_delete === "complete" && result.wal_checkpoint === "complete" && (vacuum ? result.vacuum === "complete" : true);
  }

  registerSession(scopeId: string, binding: TrustedBinding, startedAt: string): string {
    // Session registration is explicit setup; capture performs the runtime-bound check.
    this.ensureOpen();
    if (!isTrustedBinding(binding)) throw new StoreError("session_write_failed");
    const parsedScopeId = parseContract(z.uuid(), scopeId, "session-scope-id");
    const parsedStartedAt = parseContract(z.iso.datetime({ offset: true }), startedAt, "session-started-at");
    if (!binding.allowed_scope_ids.includes(parsedScopeId)) {
      throw new StoreError("scope_not_allowed");
    }
    const scope = this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(parsedScopeId);
    if (scope === undefined) throw new StoreError("scope_not_registered");

    const readExistingSession = (): string | undefined => {
      const existing = this.database
        .prepare(
          `SELECT session_id FROM session
           WHERE scope_id = ? AND host_kind = ? AND surface = ?
             AND execution_domain_kind = ? AND execution_domain_id = ?
             AND host_instance_id = ? AND host_session_id = ?`,
        )
        .get(
          parsedScopeId,
          binding.host_kind,
          binding.surface,
          binding.execution_domain.kind,
          binding.execution_domain.id,
          binding.host_instance_id,
          binding.host_session_id,
        );
      return existing === undefined ? undefined : sqlText(rowValue(existing, "session_id"), "session_id");
    };
    const existingSessionId = readExistingSession();
    if (existingSessionId !== undefined) return existingSessionId;

    const sessionId = randomUUID();
    try {
      this.database
        .prepare(
          `INSERT INTO session (
             session_id, scope_id, host_kind, surface, execution_domain_kind, execution_domain_id,
             host_instance_id, host_session_id, started_at, coverage
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        )
        .run(
          sessionId,
          parsedScopeId,
          binding.host_kind,
          binding.surface,
          binding.execution_domain.kind,
          binding.execution_domain.id,
          binding.host_instance_id,
          binding.host_session_id,
          parsedStartedAt,
      );
      return sessionId;
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        try {
          const racedSessionId = readExistingSession();
          if (racedSessionId !== undefined) return racedSessionId;
        } catch {
          // Preserve the original unique constraint failure.
        }
      }
      throw new StoreError("session_write_failed", error);
    }
  }

  findSessionForBinding(scopeId: string, binding: TrustedBinding): string | undefined {
    this.ensureOpen();
    if (!binding.allowed_scope_ids.includes(scopeId)) throw new StoreError("scope_not_allowed");
    const scope = this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(scopeId);
    if (scope === undefined) throw new StoreError("scope_not_registered");
    const row = this.database
      .prepare(
        `SELECT session_id FROM session
         WHERE scope_id = ? AND host_kind = ? AND surface = ?
           AND execution_domain_kind = ? AND execution_domain_id = ?
           AND host_instance_id = ? AND host_session_id = ?`,
      )
      .get(
        scopeId,
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    return row === undefined ? undefined : sqlText(rowValue(row, "session_id"), "session_id");
  }

  getCounter(): { commit_seq: string; data_epoch: string } {
    this.ensureOpen();
    const row = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
    if (row === undefined) throw new StoreError("read_failed");
    return {
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
      data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
    };
  }

  resolveKnownAt(requestedWallTime: string): WallClockResolution {
    this.ensureOpen();
    return resolveWallTimeToSequence(this.database, requestedWallTime);
  }

  getCounts(): DatabaseCounts {
    this.ensureOpen();
    const row = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM scope) AS scope_count,
           (SELECT COUNT(*) FROM session) AS session_count,
           (SELECT COUNT(*) FROM source_event) AS source_count,
           (SELECT COUNT(*) FROM source_span) AS span_count,
           (SELECT COUNT(*) FROM job) AS job_count`,
      )
      .get();
    if (row === undefined) throw new StoreError("read_failed");
    return {
      scope_count: sqlInteger(rowValue(row, "scope_count"), "scope_count"),
      session_count: sqlInteger(rowValue(row, "session_count"), "session_count"),
      source_count: sqlInteger(rowValue(row, "source_count"), "source_count"),
      span_count: sqlInteger(rowValue(row, "span_count"), "span_count"),
      job_count: sqlInteger(rowValue(row, "job_count"), "job_count"),
    };
  }

  #readSourceByCaptureId(captureId: string): StoredSource | undefined {
    this.ensureOpen();
    const row = this.database
      .prepare(
        `SELECT capture_id, scope_id, commit_seq, data_epoch, fingerprint,
                captured_at, payload_json, event_json, coverage_json
           FROM source_event WHERE capture_id = ?`,
      )
      .get(captureId);
    if (row === undefined) return undefined;
    return {
      capture_id: sqlText(rowValue(row, "capture_id"), "capture_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
      data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
      fingerprint: sqlText(rowValue(row, "fingerprint"), "fingerprint"),
      captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
      payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
      event_json: sqlText(rowValue(row, "event_json"), "event_json"),
      coverage_json: sqlText(rowValue(row, "coverage_json"), "coverage_json"),
    };
  }

  getSourceSpansForOutput(captureId: string, binding: PolicyOutputBinding): SourceSpanRow[] {
    this.ensureOpen();
    if (!isPolicyOutputBinding(binding)) throw new StoreError("policy_invalid");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "capture-id");
    return this.database
      .prepare(
        `SELECT span_id, root, path, start_utf16, end_utf16, digest
           FROM source_span AS s
           JOIN source_event AS e ON e.capture_id = s.source_id AND e.scope_id = s.scope_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE s.source_id = ? AND e.scope_id = ? AND t.capture_id IS NULL
          ORDER BY s.rowid`,
      )
      .all(binding.target, parsedCaptureId, binding.scope_id)
      .map((row) => ({
        span_id: sqlText(rowValue(row, "span_id"), "span_id"),
        root: sourceSpanRoot(rowValue(row, "root"), "root"),
        path: sqlText(rowValue(row, "path"), "path"),
        start_utf16: sqlInteger(rowValue(row, "start_utf16"), "start_utf16"),
        end_utf16: sqlInteger(rowValue(row, "end_utf16"), "end_utf16"),
        digest: sqlText(rowValue(row, "digest"), "digest"),
      }));
  }

  /**
   * Revalidate source references for a directed cross-host handoff. The
   * supplied IDs and digests are evidence to check, never a grant: the target
   * binding supplies the reader egress and allowed scopes, while source rows,
   * revision provenance, spans, and purge tombstones remain authoritative.
   */
  getHandoffSourceOrigin(binding: TrustedBinding, scopeId: string, captureId: string): Readonly<Record<string, unknown>> | undefined {
    this.ensureOpen();
    if (!isTrustedBinding(binding) || !binding.allowed_scope_ids.includes(scopeId)) return undefined;
    const row = this.database.prepare(`SELECT sess.* FROM source_event AS e
      JOIN session AS sess ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
      JOIN scope_output_grant AS g ON g.scope_id = e.scope_id AND g.source_class = e.evidence_class AND g.output_target = ?
      LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
      WHERE e.scope_id = ? AND e.capture_id = ? AND t.capture_id IS NULL`).get(readerOutputTarget(binding), scopeId, captureId);
    if (row === undefined) return undefined;
    return {
      host_kind: sqlText(rowValue(row, "host_kind"), "handoff-origin"),
      surface: sqlText(rowValue(row, "surface"), "handoff-origin"),
      execution_domain: { kind: sqlText(rowValue(row, "execution_domain_kind"), "handoff-origin"), id: sqlText(rowValue(row, "execution_domain_id"), "handoff-origin") },
      host_instance_id: sqlText(rowValue(row, "host_instance_id"), "handoff-origin"),
      host_session_id: sqlText(rowValue(row, "host_session_id"), "handoff-origin"),
    };
  }

  validateHandoffSourceReferences(
    binding: TrustedBinding,
    references: readonly {
      readonly capture_id: string;
      readonly scope_id: string;
      readonly revision_id: string;
      readonly span_ids: readonly string[];
      readonly origin: Readonly<Record<string, unknown>>;
    }[],
  ): boolean {
    this.ensureOpen();
    if (!isTrustedBinding(binding) || references.length === 0 || references.length > 200) return false;
    let target: string;
    try {
      target = readerOutputTarget(binding);
    } catch {
      return false;
    }
    const seenCaptures = new Set<string>();
    for (const reference of references) {
      if (
        !z.uuid().safeParse(reference.capture_id).success ||
        !z.uuid().safeParse(reference.scope_id).success ||
        !z.uuid().safeParse(reference.revision_id).success ||
        reference.span_ids.length === 0 ||
        reference.span_ids.length > 128 ||
        new Set(reference.span_ids).size !== reference.span_ids.length ||
        reference.span_ids.some((spanId) => !z.uuid().safeParse(spanId).success) ||
        seenCaptures.has(reference.capture_id) ||
        !binding.allowed_scope_ids.includes(reference.scope_id)
      ) return false;
      seenCaptures.add(reference.capture_id);
      const source = this.database
        .prepare(
          `SELECT e.scope_id, e.evidence_class, e.event_json, e.payload_json,
                  sess.host_kind, sess.surface, sess.execution_domain_kind,
                  sess.execution_domain_id, sess.host_instance_id, sess.host_session_id
             FROM source_event AS e
             JOIN scope_output_grant AS g
               ON g.scope_id = e.scope_id
              AND g.output_target = ?
              AND g.source_class = e.evidence_class
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
             JOIN session AS sess
               ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
            WHERE e.scope_id = ? AND e.capture_id = ? AND t.capture_id IS NULL`,
        )
        .get(target, reference.scope_id, reference.capture_id);
      if (source === undefined) return false;
      const canonicalOrigin = this.getHandoffSourceOrigin(binding, reference.scope_id, reference.capture_id);
      if (canonicalOrigin === undefined || JSON.stringify(reference.origin) !== JSON.stringify(canonicalOrigin)) return false;
      let event: Record<string, unknown>;
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(sqlText(rowValue(source, "event_json"), "handoff-event")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
        event = parsed as Record<string, unknown>;
        const parsedPayload = JSON.parse(sqlText(rowValue(source, "payload_json"), "handoff-payload")) as unknown;
        if (typeof parsedPayload !== "object" || parsedPayload === null || Array.isArray(parsedPayload)) return false;
        payload = parsedPayload as Record<string, unknown>;
      } catch {
        return false;
      }
      const provenance = event.provenance;
      const persistedRevision = typeof provenance === "object" && provenance !== null && !Array.isArray(provenance) &&
        typeof (provenance as Record<string, unknown>).revision_id === "string" &&
        z.uuid().safeParse((provenance as Record<string, unknown>).revision_id).success
        ? String((provenance as Record<string, unknown>).revision_id)
        : reference.capture_id;
      if (persistedRevision !== reference.revision_id) return false;
      const spanRows = this.database
        .prepare(
          `SELECT span_id, root, path, start_utf16, end_utf16, digest
             FROM source_span
            WHERE scope_id = ? AND source_id = ?
            ORDER BY rowid`,
        )
        .all(reference.scope_id, reference.capture_id);
      if (spanRows.length === 0) return false;
      const byId = new Map(spanRows.map((row) => [sqlText(rowValue(row, "span_id"), "handoff-span-id"), row]));
      for (const spanId of reference.span_ids) {
        const row = byId.get(spanId);
        if (row === undefined) return false;
        const root = sourceSpanRoot(rowValue(row, "root"), "handoff-span-root");
        const path = sqlText(rowValue(row, "path"), "handoff-span-path");
        const start = safeSpanOffset(rowValue(row, "start_utf16"), "handoff-span-start");
        const end = safeSpanOffset(rowValue(row, "end_utf16"), "handoff-span-end");
        const digest = sqlText(rowValue(row, "digest"), "handoff-span-digest");
        // Both roots are re-read from the canonical sanitized source rows.
        try {
          const sourceText = root === "event" ? event : payload;
          validateSpanExcerpt(resolveTextAtPath(sourceText, path), start, end, digest);
        } catch {
          return false;
        }
      }
    }
    return true;
  }


  /** Scope registration and local_ui output grant are prerequisites for every UI read. */
  private assertLocalUiGrant(scopeId: string): void {
    const grant = this.database
      .prepare("SELECT 1 AS present FROM scope_output_grant WHERE scope_id = ? AND output_target = 'local_ui' LIMIT 1")
      .get(scopeId);
    if (grant === undefined) throw new StoreError("output_not_allowed");
  }

  /** Bounded, policy-checked job list for the local UI, newest created commit first. */
  listJobsForUi(binding: PolicyOutputBinding, limit: number): readonly UiJobRow[] {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    const capped = localUiLimit(limit);
    this.assertLocalUiGrant(checked.scope_id);
    const rows = this.database
      .prepare(
        `SELECT job_id, scope_id, source_capture_id, task_kind, state, attempts,
                created_commit_seq, next_at, pause_reason
           FROM job WHERE scope_id = ?
           ORDER BY created_commit_seq DESC, job_id DESC LIMIT ?`,
      )
      .all(checked.scope_id, capped);
    return rows.map((row) => ({
      job_id: sqlText(rowValue(row, "job_id"), "job_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      source_capture_id: sqlText(rowValue(row, "source_capture_id"), "source_capture_id"),
      task_kind: parseJobColumn(rowValue(row, "task_kind"), "task_kind", ["extract", "embed"]),
      state: parseJobColumn(rowValue(row, "state"), "state", ["pending_extraction", "running", "completed", "failed", "paused"]),
      attempts: Number(sqlInteger(rowValue(row, "attempts"), "attempts")),
      created_commit_seq: sqlInteger(rowValue(row, "created_commit_seq"), "created_commit_seq").toString(10),
      next_at: rowValue(row, "next_at") === null ? null : sqlText(rowValue(row, "next_at"), "next_at"),
      pause_reason: rowValue(row, "pause_reason") === null ? null : sqlText(rowValue(row, "pause_reason"), "pause_reason"),
    }));
  }

  /** Policy-checked counts for one local_ui scope; purged and ungranted sources stay out. */
  getUiCounts(binding: PolicyOutputBinding): DatabaseCounts {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    this.assertLocalUiGrant(checked.scope_id);
    const row = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM scope WHERE scope_id = ?) AS scope_count,
           (SELECT COUNT(*) FROM session WHERE scope_id = ?) AS session_count,
           (SELECT COUNT(DISTINCT e.capture_id)
              FROM source_event AS e
              JOIN scope_output_grant AS g
                ON g.scope_id = e.scope_id
               AND g.output_target = 'local_ui'
               AND g.source_class = e.evidence_class
              LEFT JOIN purge_tombstone AS t
                ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
             WHERE e.scope_id = ? AND t.capture_id IS NULL) AS source_count,
           (SELECT COUNT(*)
              FROM source_span AS s
              JOIN source_event AS e
                ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
              JOIN scope_output_grant AS g
                ON g.scope_id = e.scope_id
               AND g.output_target = 'local_ui'
               AND g.source_class = e.evidence_class
              LEFT JOIN purge_tombstone AS t
                ON t.scope_id = s.scope_id AND t.capture_id = s.source_id
             WHERE s.scope_id = ? AND t.capture_id IS NULL) AS span_count,
           (SELECT COUNT(*) FROM job WHERE scope_id = ?) AS job_count`,
      )
      .get(checked.scope_id, checked.scope_id, checked.scope_id, checked.scope_id, checked.scope_id);
    if (row === undefined) throw new StoreError("read_failed");
    return {
      scope_count: sqlInteger(rowValue(row, "scope_count"), "ui_scope_count"),
      session_count: sqlInteger(rowValue(row, "session_count"), "ui_session_count"),
      source_count: sqlInteger(rowValue(row, "source_count"), "ui_source_count"),
      span_count: sqlInteger(rowValue(row, "span_count"), "ui_span_count"),
      job_count: sqlInteger(rowValue(row, "job_count"), "ui_job_count"),
    };
  }

  /** Policy-checked token-savings aggregates: stored full texts vs. evidence spans. */
  getSavingsForUi(binding: PolicyOutputBinding): UiSavingsSnapshot {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    this.assertLocalUiGrant(checked.scope_id);
    const sourceRow = this.database
      .prepare(
        `SELECT COUNT(*) AS source_count,
                COALESCE(SUM(LENGTH(e.payload_json)), 0) AS payload_chars,
                COALESCE(SUM(LENGTH(e.event_json)), 0) AS event_chars
           FROM source_event AS e
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE e.scope_id = ? AND t.capture_id IS NULL`,
      )
      .get(checked.scope_id);
    const spanRow = this.database
      .prepare(
        `SELECT COUNT(*) AS span_count,
                COALESCE(SUM(s.end_utf16 - s.start_utf16), 0) AS span_chars
           FROM source_span AS s
           JOIN source_event AS e ON e.capture_id = s.source_id AND e.scope_id = s.scope_id
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = s.scope_id AND t.capture_id = s.source_id
          WHERE s.scope_id = ? AND t.capture_id IS NULL`,
      )
      .get(checked.scope_id);
    if (sourceRow === undefined || spanRow === undefined) throw new StoreError("read_failed");
    return {
      source_count: Number(sqlInteger(rowValue(sourceRow, "source_count"), "source_count")),
      stored_chars: Number(sqlInteger(rowValue(sourceRow, "payload_chars"), "payload_chars"))
        + Number(sqlInteger(rowValue(sourceRow, "event_chars"), "event_chars")),
      evidence_chars: Number(sqlInteger(rowValue(spanRow, "span_chars"), "span_chars")),
      span_count: Number(sqlInteger(rowValue(spanRow, "span_count"), "span_count")),
    };
  }

  /** Policy-checked job state distribution for the local UI. */
  getUiJobStateCounts(binding: PolicyOutputBinding): readonly UiJobStateCount[] {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    this.assertLocalUiGrant(checked.scope_id);
    const rows = this.database
      .prepare("SELECT state, COUNT(*) AS count FROM job WHERE scope_id = ? GROUP BY state")
      .all(checked.scope_id);
    return rows.map((row) => ({
      state: parseJobColumn(rowValue(row, "state"), "state", ["pending_extraction", "running", "completed", "failed", "paused"]),
      count: Number(sqlInteger(rowValue(row, "count"), "count")),
    }));
  }

  /** Policy-checked knowledge-graph slice: bounded sessions and their sources for one scope. */
  getKnowledgeGraphForUi(binding: PolicyOutputBinding, limit: number): readonly UiGraphSourceRow[] {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    const capped = localUiLimit(limit);
    this.assertLocalUiGrant(checked.scope_id);
    const rows = this.database
      .prepare(
        `SELECT s.capture_id, s.scope_id, s.session_id, s.role, s.evidence_class, s.observed_stage, s.commit_seq
           FROM source_event AS s
          WHERE s.scope_id = ?
          ORDER BY s.commit_seq DESC, s.capture_id DESC LIMIT ${capped}`,
      )
      .all(checked.scope_id);
    return rows.map((row) => ({
      capture_id: sqlText(rowValue(row, "capture_id"), "capture_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      session_id: sqlText(rowValue(row, "session_id"), "session_id"),
      role: parseJobColumn(rowValue(row, "role"), "role", ["user", "assistant", "tool", "system"]),
      evidence_class: parseJobColumn(rowValue(row, "evidence_class"), "evidence_class", [
        "prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic",
      ]),
      observed_stage: sqlText(rowValue(row, "observed_stage"), "observed_stage"),
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
    }));
  }

  /** Policy-checked bounded sessions for one scope, newest start first. */
  listSessionsForUi(binding: PolicyOutputBinding, limit: number): readonly UiGraphSessionRow[] {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    const capped = localUiLimit(limit);
    this.assertLocalUiGrant(checked.scope_id);
    const rows = this.database
      .prepare(
        `SELECT session_id, scope_id, host_kind, surface, started_at, ended_at, coverage
           FROM session WHERE scope_id = ?
           ORDER BY started_at DESC, session_id DESC LIMIT ?`,
      )
      .all(checked.scope_id, capped);
    return rows.map((row) => ({
      session_id: sqlText(rowValue(row, "session_id"), "session_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      host_kind: sqlText(rowValue(row, "host_kind"), "host_kind"),
      surface: sqlText(rowValue(row, "surface"), "surface"),
      started_at: sqlText(rowValue(row, "started_at"), "started_at"),
      ended_at: rowValue(row, "ended_at") === null ? null : sqlText(rowValue(row, "ended_at"), "ended_at"),
      coverage: sqlText(rowValue(row, "coverage"), "coverage"),
    }));
  }

  /** Policy-checked privacy snapshot: capture state, output grants, and recent purge operations. */
  getPrivacySnapshotForUi(binding: PolicyOutputBinding): UiPrivacySnapshot {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    this.assertLocalUiGrant(checked.scope_id);
    const policy = this.database
      .prepare("SELECT capture_paused FROM scope_policy WHERE scope_id = ?")
      .get(checked.scope_id);
    if (policy === undefined) throw new StoreError("schema_invalid");
    const grantRows = this.database
      .prepare(
        "SELECT output_target, source_class, created_at FROM scope_output_grant WHERE scope_id = ? ORDER BY output_target ASC, source_class ASC",
      )
      .all(checked.scope_id);
    const purgeRows = this.database
      .prepare(
        "SELECT operation_id, state, selected_count, requested_at, updated_at FROM purge_operation WHERE scope_id = ? ORDER BY requested_at DESC, operation_id DESC LIMIT 20",
      )
      .all(checked.scope_id);
    return {
      capture_paused: sqlInteger(rowValue(policy, "capture_paused"), "capture_paused") === 1n,
      grants: grantRows.map((row) => ({
        output_target: sqlText(rowValue(row, "output_target"), "output_target"),
        source_class: parseJobColumn(rowValue(row, "source_class"), "source_class", [
          "prompt", "assistant_output", "tool_input", "tool_output", "lifecycle", "diagnostic",
        ]),
        created_at: sqlText(rowValue(row, "created_at"), "created_at"),
      })),
      purges: purgeRows.map((row) => ({
        operation_id: sqlText(rowValue(row, "operation_id"), "operation_id"),
        state: parseJobColumn(rowValue(row, "state"), "state", ["barrier", "content_deleted", "completed"]),
        selected_count: Number(sqlInteger(rowValue(row, "selected_count"), "selected_count")),
        requested_at: sqlText(rowValue(row, "requested_at"), "requested_at"),
        updated_at: sqlText(rowValue(row, "updated_at"), "updated_at"),
      })),
    };
  }

  getJobByCaptureId(captureId: string): StoredJob | undefined {
    this.ensureOpen();
    const row = this.database
      .prepare(
        `SELECT j.job_id, j.scope_id, j.source_capture_id, j.state, j.dedupe_key, j.next_at
           FROM source_event AS e
           JOIN job AS j ON j.job_id = ${effectiveSourceJobId}
           WHERE e.capture_id = ?`,
      )
      .get(captureId);
    if (row === undefined) return undefined;
    return {
      job_id: sqlText(rowValue(row, "job_id"), "job_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      source_capture_id: sqlText(rowValue(row, "source_capture_id"), "source_capture_id"),
      state: sqlText(rowValue(row, "state"), "state"),
      dedupe_key: sqlText(rowValue(row, "dedupe_key"), "dedupe_key"),
      next_at: (() => {
        const value = rowValue(row, "next_at");
        if (value === null) return null;
        return sqlText(value, "next_at");
      })(),
    };
  }

  getCaptureState(captureId: string): CaptureState | undefined {
    const source = this.#readSourceByCaptureId(captureId);
    if (source === undefined) return undefined;
    const counts = this.getCounts();
    return {
      commit_seq: source.commit_seq,
      data_epoch: source.data_epoch,
      source_count: counts.source_count,
      span_count: counts.span_count,
      job_count: counts.job_count,
    };
  }

  getRecallSnapshot(scopeIds: readonly string[], binding: TrustedBinding): RecallSnapshot {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    const target = readerOutputTarget(binding);
    try {
      this.database.exec("BEGIN");
    } catch (error: unknown) {
      throw new StoreError("read_failed", error);
    }
    let committed = false;
    try {
      const counter = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
      if (counter === undefined) throw new StoreError("read_failed");
      const scopeRows = this.database
        .prepare(`SELECT scope_id, data_epoch, privacy_epoch FROM scope WHERE scope_id IN (${ids.map(() => "?").join(", ")})`)
        .all(...ids);
      if (scopeRows.length !== ids.length) throw new StoreError("scope_not_registered");
      const grants = this.database
        .prepare(`SELECT COUNT(DISTINCT scope_id) AS count FROM scope_output_grant WHERE output_target = ? AND scope_id IN (${ids.map(() => "?").join(", ")})`)
        .get(target, ...ids);
      if (grants === undefined || sqlInteger(rowValue(grants, "count"), "grant_count") !== BigInt(ids.length)) {
        throw new StoreError("output_not_allowed");
      }
      this.database.exec("COMMIT");
      committed = true;
      const snapshots = new Map(
        scopeRows.map((row) => [
          sqlText(rowValue(row, "scope_id"), "scope_id"),
          {
            scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
            data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
            privacy_epoch: sqlInteger(rowValue(row, "privacy_epoch"), "privacy_epoch").toString(10),
          } satisfies RecallScopeSnapshot,
        ]),
      );
      const scopes = ids.map((scopeId) => {
        const snapshot = snapshots.get(scopeId);
        if (snapshot === undefined) throw new StoreError("read_failed");
        return snapshot;
      });
      const privacyEpoch = scopes.reduce(
        (maximum, scope) => (BigInt(scope.privacy_epoch) > maximum ? BigInt(scope.privacy_epoch) : maximum),
        0n,
      );
      return {
        watermark: sqlInteger(rowValue(counter, "commit_seq"), "commit_seq").toString(10),
        data_epoch: sqlInteger(rowValue(counter, "data_epoch"), "data_epoch").toString(10),
        privacy_epoch: privacyEpoch.toString(10),
        scopes,
      };
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original snapshot failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  /**
   * Return the current read watermark for one explicitly granted local UI
   * output. The output binding is the authority; no host reader binding is
   * consulted or widened for this path.
   */
  getLocalUiSnapshot(binding: PolicyOutputBinding): LocalUiScopeSnapshot {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    let committed = false;
    try {
      this.database.exec("BEGIN");
      const snapshot = this.readLocalUiSnapshot(checked);
      this.database.exec("COMMIT");
      committed = true;
      return snapshot;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original local UI read failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  /** Read one UI snapshot while the caller owns a read transaction. */
  private readLocalUiSnapshot(binding: PolicyOutputBinding): LocalUiScopeSnapshot {
    const checked = requireLocalUiOutput(binding);
    const scope = this.database
      .prepare("SELECT scope_id, data_epoch, privacy_epoch FROM scope WHERE scope_id = ?")
      .get(checked.scope_id);
    if (scope === undefined) throw new StoreError("scope_not_registered");
    const policy = this.database
      .prepare("SELECT capture_paused FROM scope_policy WHERE scope_id = ?")
      .get(checked.scope_id);
    if (policy === undefined) throw new StoreError("schema_invalid");
    const grant = this.database
      .prepare("SELECT 1 AS present FROM scope_output_grant WHERE scope_id = ? AND output_target = 'local_ui' LIMIT 1")
      .get(checked.scope_id);
    if (grant === undefined) throw new StoreError("output_not_allowed");
    const counter = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
    if (counter === undefined) throw new StoreError("read_failed");
    return {
      scope_id: sqlText(rowValue(scope, "scope_id"), "scope_id"),
      watermark: sqlInteger(rowValue(counter, "commit_seq"), "commit_seq").toString(10),
      data_epoch: sqlInteger(rowValue(scope, "data_epoch"), "data_epoch").toString(10),
      global_data_epoch: sqlInteger(rowValue(counter, "data_epoch"), "data_epoch").toString(10),
      privacy_epoch: sqlInteger(rowValue(scope, "privacy_epoch"), "privacy_epoch").toString(10),
      capture_paused: sqlInteger(rowValue(policy, "capture_paused"), "capture_paused") === 1n,
    };
  }

  /**
   * List recent source groups after applying the local_ui source-class grant,
   * scope, purge tombstone, and watermark filters before the group limit.
   * The cursor carries only ordering state and never adds authority.
   */
  listSourcesForOutput(binding: PolicyOutputBinding, options: OutputSourceListOptions): OutputSourcePage {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    if (typeof options !== "object" || options === null) throw new StoreError("read_failed");
    const limit = localUiLimit(options.limit);
    if (options.agent !== undefined && typeof options.agent !== "string") throw new StoreError("read_failed");
    if (options.session_id !== undefined && typeof options.session_id !== "string") throw new StoreError("read_failed");
    const metadataFilterClause = `${options.agent === undefined ? "" : " AND sess.host_kind = ?"}${options.session_id === undefined ? "" : " AND e.session_id = ?"}`;
    const queryDigest = sha256(`local-ui\0timeline\0${JSON.stringify([options.agent ?? null, options.session_id ?? null])}`);
    let snapshot: LocalUiScopeSnapshot;
    let watermarkValue: string;
    let cursor: OutputCursor | undefined;
    let cursorClause: string;
    let parameters: Array<string | bigint | number>;
    let sourceRows: readonly unknown[];
    let spanRows: readonly unknown[];
    let committed = false;
    try {
      this.database.exec("BEGIN");
      snapshot = this.readLocalUiSnapshot(checked);
      watermarkValue = options.watermark ?? snapshot.watermark;
      if (!nonNegativeInt64Schema.safeParse(watermarkValue).success || BigInt(watermarkValue) > BigInt(snapshot.watermark)) {
        throw new StoreError("read_failed");
      }
      cursor = decodeOutputCursor(
        options.cursor,
        "timeline",
        checked.scope_id,
        queryDigest,
        watermarkValue,
        snapshot.data_epoch,
        snapshot.global_data_epoch,
        snapshot.privacy_epoch,
      );
      if (cursor !== undefined && BigInt(cursor.commit_seq) > BigInt(watermarkValue)) throw new StoreError("read_failed");
      cursorClause = cursor === undefined ? "" : " AND (e.commit_seq < ? OR (e.commit_seq = ? AND e.capture_id < ?))";
      parameters = [checked.scope_id, BigInt(watermarkValue)];
      if (options.agent !== undefined) parameters.push(options.agent);
      if (options.session_id !== undefined) parameters.push(options.session_id);
      if (cursor !== undefined) parameters.push(BigInt(cursor.commit_seq), BigInt(cursor.commit_seq), cursor.capture_id);
      parameters.push(limit);
      sourceRows = this.database
        .prepare(
          `WITH recent AS (
             SELECT e.capture_id, MAX(e.commit_seq) AS selected_commit_seq
               FROM source_event AS e
               JOIN scope_output_grant AS g
                 ON g.scope_id = e.scope_id
                AND g.output_target = 'local_ui'
                AND g.source_class = e.evidence_class
               JOIN session AS sess
                 ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
               LEFT JOIN purge_tombstone AS t
                 ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
              WHERE e.scope_id = ?
                AND e.commit_seq <= ?
                AND t.capture_id IS NULL${metadataFilterClause}${cursorClause}
              GROUP BY e.capture_id
              ORDER BY selected_commit_seq DESC, e.capture_id DESC
              LIMIT ?
           )
           SELECT e.capture_id, e.scope_id, e.commit_seq, e.data_epoch, e.fingerprint,
                  e.captured_at, e.occurred_at, e.payload_json, e.event_json, e.coverage_json,
                  e.evidence_class, e.role, j.state AS job_state,
                  e.session_id, sess.host_kind, scope_meta.owner_ref AS project_label
             FROM recent AS r
             JOIN source_event AS e ON e.capture_id = r.capture_id AND e.scope_id = ?
             JOIN session AS sess ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
             JOIN scope AS scope_meta ON scope_meta.scope_id = e.scope_id
             LEFT JOIN job AS j ON j.job_id = ${effectiveSourceJobId}
            ORDER BY e.commit_seq DESC, e.capture_id DESC`,
        )
        .all(...parameters, checked.scope_id);
      const sourceIds = sourceRows.map((row) => sqlText(rowValue(row, "capture_id"), "capture_id"));
      spanRows = this.readOutputSpanRows(checked.scope_id, sourceIds);
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original local UI read failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
    const groups = this.mapOutputSourceRows(sourceRows, spanRows);
    const last = groups.at(-1);
    return {
      watermark: watermarkValue,
      groups,
      ...(groups.length === limit && last === undefined ? {} : groups.length === limit && last !== undefined
        ? {
            next_cursor: encodeOutputCursor({
              version: 1,
              kind: "timeline",
              scope_id: checked.scope_id,
              query_digest: queryDigest,
              watermark: watermarkValue,
              data_epoch: snapshot.data_epoch,
              global_data_epoch: snapshot.global_data_epoch,
              privacy_epoch: snapshot.privacy_epoch,
              commit_seq: last.commit_seq,
              capture_id: last.capture_id,
            }),
          }
        : {}),
    };
  }

  /**
   * Search the FTS index for one local_ui output. Source groups are selected
   * from the authorized candidate set before `limit`, then hydrated with every
   * exact source span for the selected group.
   */
  searchSourcesForOutput(binding: PolicyOutputBinding, options: OutputSourceSearchOptions): OutputSourcePage {
    this.ensureOpen();
    const checked = requireLocalUiOutput(binding);
    if (typeof options !== "object" || options === null) throw new StoreError("read_failed");
    const limit = localUiLimit(options.limit);
    if (options.agent !== undefined && typeof options.agent !== "string") throw new StoreError("read_failed");
    if (options.session_id !== undefined && typeof options.session_id !== "string") throw new StoreError("read_failed");
    const metadataFilterClause = `${options.agent === undefined ? "" : " AND sess.host_kind = ?"}${options.session_id === undefined ? "" : " AND e.session_id = ?"}`;
    const match = localUiMatch(options.query);
    if (match === undefined) {
      const snapshot = this.getLocalUiSnapshot(checked);
      return { watermark: snapshot.watermark, groups: [] };
    }
    let snapshot: LocalUiScopeSnapshot;
    let watermarkValue: string;
    let cursor: OutputCursor | undefined;
    let cursorClause: string;
    let parameters: Array<string | bigint | number>;
    let sourceRows: readonly unknown[];
    let spanRows: readonly unknown[];
    let committed = false;
    try {
      this.database.exec("BEGIN");
      snapshot = this.readLocalUiSnapshot(checked);
      watermarkValue = options.watermark ?? snapshot.watermark;
      if (!nonNegativeInt64Schema.safeParse(watermarkValue).success || BigInt(watermarkValue) > BigInt(snapshot.watermark)) {
        throw new StoreError("read_failed");
      }
      const queryDigest = sha256(`local-ui\0lexical\0${JSON.stringify([match, options.agent ?? null, options.session_id ?? null])}`);
      cursor = decodeOutputCursor(
        options.cursor,
        "lexical",
        checked.scope_id,
        queryDigest,
        watermarkValue,
        snapshot.data_epoch,
        snapshot.global_data_epoch,
        snapshot.privacy_epoch,
      );
      if (cursor !== undefined && cursor.lexical_rank === undefined) throw new StoreError("read_failed");
      cursorClause = cursor === undefined ? "" : " WHERE lexical_rank > ? OR (lexical_rank = ? AND source_id > ?)";
      parameters = [match, checked.scope_id, BigInt(watermarkValue)];
      if (options.agent !== undefined) parameters.push(options.agent);
      if (options.session_id !== undefined) parameters.push(options.session_id);
      if (cursor !== undefined) parameters.push(cursor.lexical_rank as number, cursor.lexical_rank as number, cursor.capture_id);
      parameters.push(limit);
      sourceRows = this.database
        .prepare(
          `WITH ranked AS (
             SELECT d.source_id, MIN(f.rank) AS lexical_rank
               FROM search_fts AS f
               JOIN search_document AS d ON d.rowid = f.rowid
               JOIN source_event AS e ON e.capture_id = d.source_id AND e.scope_id = d.scope_id
               JOIN scope_output_grant AS g
                 ON g.scope_id = d.scope_id
                AND g.output_target = 'local_ui'
                AND g.source_class = e.evidence_class
               JOIN session AS sess
                 ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
               LEFT JOIN purge_tombstone AS t
                 ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
              WHERE f.search_fts MATCH ?
                AND d.scope_id = ?
                AND d.eligible = 1
                AND e.commit_seq <= ?
                AND t.capture_id IS NULL${metadataFilterClause}
              GROUP BY d.source_id
           ), candidates AS (
             SELECT source_id, lexical_rank
               FROM ranked${cursorClause}
              ORDER BY lexical_rank ASC, source_id ASC
              LIMIT ?
           )
           SELECT e.capture_id, e.scope_id, e.commit_seq, e.data_epoch, e.fingerprint,
                  e.captured_at, e.occurred_at, e.payload_json, e.event_json, e.coverage_json,
                  e.evidence_class, e.role, j.state AS job_state, c.lexical_rank,
                  e.session_id, sess.host_kind, scope_meta.owner_ref AS project_label
             FROM candidates AS c
             JOIN source_event AS e ON e.capture_id = c.source_id AND e.scope_id = ?
             JOIN session AS sess ON sess.scope_id = e.scope_id AND sess.session_id = e.session_id
             JOIN scope AS scope_meta ON scope_meta.scope_id = e.scope_id
             LEFT JOIN job AS j ON j.job_id = ${effectiveSourceJobId}
            ORDER BY c.lexical_rank ASC, e.capture_id ASC`,
        )
        .all(...parameters, checked.scope_id);
      const sourceIds = sourceRows.map((row) => sqlText(rowValue(row, "capture_id"), "capture_id"));
      spanRows = this.readOutputSpanRows(checked.scope_id, sourceIds);
      this.database.exec("COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original local UI read failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
    const queryDigest = sha256(`local-ui\0lexical\0${JSON.stringify([match, options.agent ?? null, options.session_id ?? null])}`);
    const groups: OutputSourceGroup[] = this.mapOutputSourceRows(sourceRows, spanRows).sort((left, right) => {
      const leftRank = left.lexical_rank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.lexical_rank ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.capture_id < right.capture_id ? -1 : left.capture_id > right.capture_id ? 1 : 0;
    });
    const last = groups.at(-1);
    return {
      watermark: watermarkValue,
      groups,
      ...(groups.length === limit && last !== undefined && last.lexical_rank !== undefined
        ? {
            next_cursor: encodeOutputCursor({
              version: 1,
              kind: "lexical",
              scope_id: checked.scope_id,
              query_digest: queryDigest,
              watermark: watermarkValue,
              data_epoch: snapshot.data_epoch,
              global_data_epoch: snapshot.global_data_epoch,
              privacy_epoch: snapshot.privacy_epoch,
              commit_seq: last.commit_seq,
              capture_id: last.capture_id,
              lexical_rank: last.lexical_rank,
            }),
          }
        : {}),
    };
  }

  getRecallTimelineGroups(
    scopeIds: readonly string[],
    binding: TrustedBinding,
    knownAtSeq: string,
    limit: number,
    excludedCaptureId?: string,
    excludeCurrentSessionPrompts = false,
    selection?: { readonly source_classes?: readonly SourceClass[]; readonly explicit_notes?: boolean },
  ): RecallSourceGroup[] {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    const target = readerOutputTarget(binding);
    const knownAt = parseContract(nonNegativeInt64Schema, knownAtSeq, "known-at-seq");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new StoreError("read_failed");
    const excluded = excludedCaptureId === undefined ? undefined : parseContract(z.uuid(), excludedCaptureId, "excluded-capture-id");
    const parameters: Array<string | bigint | number> = [target, ...ids, BigInt(knownAt)];
    const exclusion = excluded === undefined ? "" : " AND e.capture_id <> ?";
    if (excluded !== undefined) parameters.push(excluded);
    // Same narrow T05d trusted-context exclusion as the lexical path: current
    // native session user/prompt sources leave the candidate set before LIMIT.
    const sessionPromptExclusion = excludeCurrentSessionPrompts === true ? ` AND ${currentSessionPromptExclusion}` : "";
    if (excludeCurrentSessionPrompts === true) {
      parameters.push(
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    }
    const classes = selection?.source_classes === undefined ? undefined : parseContract(z.array(evidenceClassSchema).min(1).max(6), selection.source_classes, "timeline-source-classes");
    const classClause = classes === undefined ? "" : ` AND (${recallEvidenceClass}) IN (${classes.map(() => "?").join(", ")})`;
    if (classes) parameters.push(...classes);
    let noteClause = "";
    if (selection?.explicit_notes) {
      const text = "lower(COALESCE(json_extract(e.event_json, '$.text'), json_extract(e.payload_json, '$.text'), json_extract(e.payload_json, '$.prompt'), ''))";
      const prefixes = ["entscheidung:", "decision:", "projektregel:", "korrektur:", "correction:", "merke:", "remember:"];
      noteClause = " AND e.role = 'user' AND (" + prefixes.map(() => `(ltrim(${text}) LIKE ? OR ${text} LIKE ?)`).join(" OR ") + ")";
      for (const prefix of prefixes) parameters.push(prefix + "%", "%\n" + prefix + "%");
    }
    parameters.push(limit);
    const rows = this.database
      .prepare(
        `WITH recent AS (
           SELECT e.capture_id, MAX(e.commit_seq) AS selected_commit_seq
             FROM source_event AS e
             JOIN source_span AS ss ON ss.source_id = e.capture_id AND ss.scope_id = e.scope_id
             JOIN scope_output_grant AS g
               ON g.scope_id = e.scope_id
              AND g.output_target = ?
              AND g.source_class = e.evidence_class
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
              WHERE e.scope_id IN (${ids.map(() => "?").join(", ")})
               AND e.commit_seq <= ?
               AND ${recallSourceEligibility}
               AND t.capture_id IS NULL${exclusion}${sessionPromptExclusion}${classClause}${noteClause}
             GROUP BY e.capture_id
            ORDER BY selected_commit_seq DESC, e.capture_id DESC
            LIMIT ?
         )
         SELECT e.capture_id, e.scope_id, e.commit_seq, e.data_epoch, e.fingerprint,
                e.captured_at, e.occurred_at, e.payload_json, e.event_json, e.coverage_json,
                ${recallEvidenceClass} AS evidence_class, ${recallSourceRole} AS role, j.state AS job_state,
                s.span_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest
           FROM recent AS r
           JOIN source_event AS e ON e.capture_id = r.capture_id
           JOIN source_span AS s ON s.source_id = e.capture_id AND s.scope_id = e.scope_id
           LEFT JOIN job AS j ON j.job_id = ${effectiveSourceJobId}
          ORDER BY e.commit_seq DESC, e.capture_id DESC, s.rowid`,
      )
      .all(...parameters);
    return this.mapRecallSourceRows(rows);
  }

  getRecallSourceGroups(
    scopeIds: readonly string[],
    binding: TrustedBinding,
    captureIds: readonly string[],
    knownAtSeq: string,
    excludedCaptureId?: string,
    excludeCurrentSessionPrompts = false,
  ): RecallSourceGroup[] {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    const target = readerOutputTarget(binding);
    const knownAt = parseContract(nonNegativeInt64Schema, knownAtSeq, "known-at-seq");
    if (
      !Array.isArray(captureIds) ||
      captureIds.length > 200 ||
      new Set(captureIds).size !== captureIds.length ||
      captureIds.some((captureId) => !z.uuid().safeParse(captureId).success)
    ) {
      throw new StoreError("read_failed");
    }
    if (captureIds.length === 0) return [];
    const excluded = excludedCaptureId === undefined ? undefined : parseContract(z.uuid(), excludedCaptureId, "excluded-capture-id");
    const capturePlaceholders = captureIds.map(() => "?").join(", ");
    const parameters: Array<string | bigint> = [target, ...ids, ...captureIds, BigInt(knownAt)];
    const exclusion = excluded === undefined ? "" : " AND e.capture_id <> ?";
    if (excluded !== undefined) parameters.push(excluded);
    // Defense in depth for the T05d trusted-context exclusion: candidate IDs
    // were already filtered before limits, but a direct caller must not be
    // able to reintroduce current-session prompts here.
    const sessionPromptExclusion = excludeCurrentSessionPrompts === true ? ` AND ${currentSessionPromptExclusion}` : "";
    if (excludeCurrentSessionPrompts === true) {
      parameters.push(
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    }
    const rows = this.database
      .prepare(
        `SELECT e.capture_id, e.scope_id, e.commit_seq, e.data_epoch, e.fingerprint,
                e.captured_at, e.occurred_at, e.payload_json, e.event_json, e.coverage_json,
                ${recallEvidenceClass} AS evidence_class, ${recallSourceRole} AS role, j.state AS job_state,
                s.span_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest
           FROM source_event AS e
           JOIN source_span AS s ON s.source_id = e.capture_id AND s.scope_id = e.scope_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
           LEFT JOIN job AS j ON j.job_id = ${effectiveSourceJobId}
           WHERE e.scope_id IN (${ids.map(() => "?").join(", ")})
             AND e.capture_id IN (${capturePlaceholders})
             AND e.commit_seq <= ?
             AND ${recallSourceEligibility}
             AND t.capture_id IS NULL${exclusion}${sessionPromptExclusion}
           ORDER BY e.commit_seq DESC, e.capture_id DESC, s.rowid`,
      )
      .all(...parameters);
    return this.mapRecallSourceRows(rows);
  }

  /**
   * Capture ids whose evidence sourced a claim that a validated but not yet
   * committed correction candidate targets (plan §9 "Frische trotz
   * ausstehender Extraktion"). Only batches still in the verified state with
   * a fully positive verdict on a SUPERSEDE/CORRECT/RETRACT candidate count;
   * after the resolver commits the correction the canonical segment state
   * speaks for itself. Read-only helper for the context freshness marking.
   */
  /**
   * T18b: evidence rows for procedure recommendations (read-only). Only
   * procedures whose activation row is 'active', whose item head is still the
   * verified 'supported' head on the active revision, whose evidence sources
   * are still unpurged and whose scope allows the reader output target are
   * returned. A revoked, deprecated, purged or superseded procedure is
   * therefore immediately absent from every new packet. The caller (core
   * procedures layer) assembles the packet items and applies the activation
   * conditions.
   */
  listProcedureRecommendationRows(scopeIds: readonly string[], binding: TrustedBinding): readonly {
    readonly scope_id: string;
    readonly item_id: string;
    readonly revision_id: string;
    readonly predicate: string;
    readonly qualifiers_json: string;
    readonly policy_version: string;
    readonly conditions_json: string;
    readonly content_json: string;
    readonly spans: readonly {
      readonly span_id: string;
      readonly capture_id: string;
      readonly root: "payload" | "event";
      readonly path: string;
      readonly start_utf16: bigint;
      readonly end_utf16: bigint;
      readonly digest: string;
      readonly quote: string;
      readonly captured_at: string;
      readonly occurred_at: string | null;
      readonly commit_seq: bigint;
      readonly data_epoch: bigint;
    }[];
  }[] {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    if (ids.length === 0) return [];
    const target = readerOutputTarget(binding);
    const rows = this.database
      .prepare(
        `SELECT i.scope_id, i.item_id, i.predicate, i.qualifiers_json,
                a.active_revision, a.policy_version, a.conditions_json,
                r.content_json,
                e.capture_id, e.captured_at, e.occurred_at, e.commit_seq, e.data_epoch,
                e.payload_json, e.event_json,
                s.span_id, s.root, s.path, s.start_utf16, s.end_utf16, s.digest
           FROM procedure_activation AS a
           JOIN memory_item AS i
             ON i.scope_id = a.scope_id AND i.item_id = a.procedure_item_id
           JOIN memory_revision AS r
             ON r.scope_id = a.scope_id AND r.revision_id = a.active_revision
           JOIN revision_source AS rs
             ON rs.scope_id = r.scope_id AND rs.revision_id = r.revision_id
           JOIN source_span AS s
             ON s.scope_id = rs.scope_id AND s.source_id = rs.source_capture_id AND s.span_id = rs.source_span_id
           JOIN source_event AS e
             ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE a.scope_id IN (${ids.map(() => "?").join(", ")})
            AND a.status = 'active'
            AND a.active_revision IS NOT NULL
            AND i.kind = 'procedure'
            AND i.status = 'supported'
            AND i.current_revision_id = a.active_revision
            AND t.capture_id IS NULL
            AND ${recallSourceEligibility}
          ORDER BY i.scope_id, i.item_id, s.rowid`,
      )
      .all(target, ...ids);
    interface MutableProcedureRecommendationRow {
      scope_id: string;
      item_id: string;
      revision_id: string;
      predicate: string;
      qualifiers_json: string;
      policy_version: string;
      conditions_json: string;
      content_json: string;
      spans: {
        span_id: string;
        capture_id: string;
        root: "payload" | "event";
        path: string;
        start_utf16: bigint;
        end_utf16: bigint;
        digest: string;
        quote: string;
        captured_at: string;
        occurred_at: string | null;
        commit_seq: bigint;
        data_epoch: bigint;
      }[];
    }
    const roots = new Map<string, { readonly payload: Record<string, unknown>; readonly event: Record<string, unknown> }>();
    const grouped = new Map<string, MutableProcedureRecommendationRow>();
    for (const row of rows) {
      const scopeId = sqlText(rowValue(row, "scope_id"), "procedure-scope-id");
      const itemId = sqlText(rowValue(row, "item_id"), "procedure-item-id");
      const revisionId = sqlText(rowValue(row, "active_revision"), "procedure-active-revision");
      const key = `${scopeId}\u0000${itemId}`;
      let entry = grouped.get(key);
      if (entry === undefined) {
        entry = {
          scope_id: scopeId,
          item_id: itemId,
          revision_id: revisionId,
          predicate: sqlText(rowValue(row, "predicate"), "procedure-predicate"),
          qualifiers_json: sqlText(rowValue(row, "qualifiers_json"), "procedure-qualifiers"),
          policy_version: sqlText(rowValue(row, "policy_version"), "procedure-policy-version"),
          conditions_json: sqlText(rowValue(row, "conditions_json"), "procedure-conditions"),
          content_json: sqlText(rowValue(row, "content_json"), "procedure-content"),
          spans: [],
        };
        grouped.set(key, entry);
      }
      const root = sourceSpanRoot(rowValue(row, "root"), "root");
      const path = sqlText(rowValue(row, "path"), "procedure-span-path");
      const start = safeSpanOffset(rowValue(row, "start_utf16"), "procedure-span-start");
      const end = safeSpanOffset(rowValue(row, "end_utf16"), "procedure-span-end");
      const digest = sqlText(rowValue(row, "digest"), "procedure-span-digest").toLowerCase();
      const captureId = sqlText(rowValue(row, "capture_id"), "procedure-span-capture");
      let parsedRoots = roots.get(captureId);
      if (parsedRoots === undefined) {
        parsedRoots = {
          payload: jsonObject(sqlText(rowValue(row, "payload_json"), "procedure-payload"), "procedure-payload"),
          event: jsonObject(sqlText(rowValue(row, "event_json"), "procedure-event"), "procedure-event"),
        };
        roots.set(captureId, parsedRoots);
      }
      const { payload, event } = parsedRoots;
      const quote = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
      entry.spans.push({
        span_id: sqlText(rowValue(row, "span_id"), "procedure-span-id"),
        capture_id: captureId,
        root,
        path,
        start_utf16: BigInt(start),
        end_utf16: BigInt(end),
        digest,
        quote,
        captured_at: sqlText(rowValue(row, "captured_at"), "procedure-span-captured-at"),
        occurred_at: nullableSqlTextOrNull(rowValue(row, "occurred_at"), "procedure-span-occurred-at"),
        commit_seq: sqlInteger(rowValue(row, "commit_seq"), "procedure-span-commit"),
        data_epoch: sqlInteger(rowValue(row, "data_epoch"), "procedure-span-data-epoch"),
      });
    }
    return [...grouped.values()];
  }

  listCaptureIdsUnderPendingCorrection(scopeIds: readonly string[], binding: TrustedBinding): readonly string[] {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT DISTINCT rs.source_capture_id AS capture_id
           FROM extraction_batch AS b
           JOIN extraction_candidate AS c
             ON c.batch_id = b.batch_id
           JOIN extraction_verdict AS v
             ON v.batch_id = c.batch_id AND v.candidate_id = c.candidate_id AND v.candidate_digest = c.candidate_digest
           JOIN memory_revision AS r
             ON r.scope_id = b.scope_id AND r.item_id = json_extract(c.candidate_json, '$.expected.item_id')
           JOIN revision_source AS rs
             ON rs.scope_id = r.scope_id AND rs.revision_id = r.revision_id
          WHERE b.scope_id IN (${placeholders})
            AND b.state = 'verified'
            AND json_extract(c.candidate_json, '$.operation') IN ('SUPERSEDE', 'CORRECT', 'RETRACT')
            AND json_extract(c.candidate_json, '$.expected.item_id') IS NOT NULL
            AND v.entailment = 'entailed'
            AND v.attribution = 'positive'
            AND v.modality = 'positive'
            AND v.negation = 'positive'
            AND v.time = 'positive'
            AND r.operation <> 'IGNORE'`,
      )
      .all(...ids);
    return rows.map((row) => sqlText(rowValue(row, "capture_id"), "pending-correction-capture"));
  }

  /**
   * Read the actual source spans on a verified but uncommitted correction
   * candidate. `listCaptureIdsUnderPendingCorrection` intentionally returns
   * the obsolete revision's captures; these rows are the candidate producer's
   * replacement evidence and are filtered again by reader eligibility.
   */
  listPendingCorrectionReplacementSources(scopeIds: readonly string[], binding: TrustedBinding): readonly { readonly capture_id: string; readonly span_id: string }[] {
    this.ensureOpen();
    const ids = recallScopeIds(scopeIds, binding);
    const target = readerOutputTarget(binding);
    const rows = this.database
      .prepare(
        `SELECT DISTINCT e.capture_id, s.span_id
           FROM extraction_batch AS b
           JOIN extraction_candidate AS c
             ON c.batch_id = b.batch_id
           JOIN extraction_verdict AS v
             ON v.batch_id = c.batch_id AND v.candidate_id = c.candidate_id AND v.candidate_digest = c.candidate_digest
           JOIN json_each(c.candidate_json, '$.source_span_ids') AS candidate_span
           JOIN source_span AS s
             ON s.scope_id = b.scope_id AND s.span_id = candidate_span.value
           JOIN source_event AS e
             ON e.scope_id = s.scope_id AND e.capture_id = s.source_id
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE b.scope_id IN (${ids.map(() => "?").join(", ")})
            AND b.state = 'verified'
            AND json_extract(c.candidate_json, '$.operation') IN ('SUPERSEDE', 'CORRECT', 'RETRACT')
            AND json_extract(c.candidate_json, '$.expected.item_id') IS NOT NULL
            AND v.entailment = 'entailed'
            AND v.attribution = 'positive'
            AND v.modality = 'positive'
            AND v.negation = 'positive'
            AND v.time = 'positive'
            AND t.capture_id IS NULL
            AND ${recallSourceEligibility}
          ORDER BY e.commit_seq DESC, e.capture_id DESC, s.rowid
          LIMIT 128`,
      )
      .all(target, ...ids);
    return rows.map((row) => ({
      capture_id: sqlText(rowValue(row, "capture_id"), "pending-correction-replacement-capture"),
      span_id: sqlText(rowValue(row, "span_id"), "pending-correction-replacement-span"),
    }));
  }

  revalidateRecallSnapshot(snapshot: RecallSnapshot, binding: TrustedBinding, sourceIds: readonly string[]): boolean {
    this.ensureOpen();
    const ids = recallScopeIds(snapshot.scopes.map((scope) => scope.scope_id), binding);
    const target = readerOutputTarget(binding);
    const sourceIdsUnique = [...new Set(sourceIds)];
    if (sourceIdsUnique.some((sourceId) => !z.uuid().safeParse(sourceId).success)) throw new StoreError("read_failed");
    this.database.exec("BEGIN");
    let committed = false;
    try {
      const scopeRows = this.database
        .prepare(`SELECT scope_id, data_epoch, privacy_epoch FROM scope WHERE scope_id IN (${ids.map(() => "?").join(", ")})`)
        .all(...ids);
      if (scopeRows.length !== ids.length) {
        this.database.exec("ROLLBACK");
        committed = true;
        return false;
      }
      const snapshots = new Map(
        snapshot.scopes.map((scope) => [scope.scope_id, scope]),
      );
      for (const row of scopeRows) {
        const scopeId = sqlText(rowValue(row, "scope_id"), "scope_id");
        const expected = snapshots.get(scopeId);
        if (
          expected === undefined ||
          expected.data_epoch !== sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10) ||
          expected.privacy_epoch !== sqlInteger(rowValue(row, "privacy_epoch"), "privacy_epoch").toString(10)
        ) {
          this.database.exec("ROLLBACK");
          committed = true;
          return false;
        }
      }
      if (sourceIdsUnique.length > 0) {
        const placeholders = sourceIdsUnique.map(() => "?").join(", ");
        const rows = this.database
          .prepare(
            `SELECT COUNT(DISTINCT e.capture_id) AS count
               FROM source_event AS e
               JOIN scope_output_grant AS g
                 ON g.scope_id = e.scope_id
                AND g.output_target = ?
                AND g.source_class = e.evidence_class
               LEFT JOIN purge_tombstone AS t
                 ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
              WHERE e.scope_id IN (${ids.map(() => "?").join(", ")})
                AND e.capture_id IN (${placeholders})
                AND t.capture_id IS NULL`,
          )
          .get(target, ...ids, ...sourceIdsUnique);
        if (rows === undefined || sqlInteger(rowValue(rows, "count"), "source_count") !== BigInt(sourceIdsUnique.length)) {
          this.database.exec("ROLLBACK");
          committed = true;
          return false;
        }
      }
      this.database.exec("COMMIT");
      committed = true;
      return true;
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the revalidation failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  recordQueryTrace(input: unknown): QueryTraceRecord {
    this.ensureOpen();
    const trace = parseContract(queryTraceSchema, input, "query-trace") as QueryTraceRecord;
    const scopeSet = new Set(trace.scope_ids);
    if (
      trace.scope_epochs.length !== trace.scope_ids.length ||
      trace.scope_epochs.some((scope) => !scopeSet.has(scope.scope_id))
    ) {
      throw new StoreError("query_trace_write_failed");
    }
    try {
      this.database
        .prepare(
          `INSERT INTO query_trace (
             query_id, injection_id, binding_id, packet_digest, scope_ids_json, watermark, known_at_seq,
             scope_epochs_json, candidate_ids_json, output_ids_json, diagnostics_json,
             mode, token_unit, tokens_used, token_budget, created_at, valid_until, delivery_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.query_id,
          trace.injection_id,
          trace.binding_id,
          trace.packet_digest,
          JSON.stringify(trace.scope_ids),
          trace.watermark,
          trace.known_at_seq,
          JSON.stringify(trace.scope_epochs),
          JSON.stringify(trace.candidate_ids),
          JSON.stringify(trace.output_ids),
          JSON.stringify(trace.diagnostics),
          trace.mode,
          trace.token_unit,
          trace.tokens_used,
          trace.token_budget,
          trace.created_at,
          trace.valid_until,
          trace.delivery_state,
        );
      return trace;
    } catch (error: unknown) {
      throw new StoreError("query_trace_conflict", error);
    }
  }

  getQueryTrace(injectionId: string): QueryTraceRecord | undefined {
    this.ensureOpen();
    const parsedInjectionId = parseContract(z.uuid(), injectionId, "injection-id");
    const row = this.database
      .prepare(
        `SELECT query_id, injection_id, binding_id, packet_digest, scope_ids_json, watermark, known_at_seq,
                scope_epochs_json, candidate_ids_json, output_ids_json, diagnostics_json,
                mode, token_unit, tokens_used, token_budget, created_at, valid_until, delivery_state
           FROM query_trace WHERE injection_id = ?`,
      )
      .get(parsedInjectionId);
    if (row === undefined) return undefined;
    try {
      return parseContract(queryTraceSchema, {
        query_id: sqlText(rowValue(row, "query_id"), "query_id"),
        injection_id: sqlText(rowValue(row, "injection_id"), "injection_id"),
        binding_id: sqlText(rowValue(row, "binding_id"), "binding_id"),
        packet_digest: sqlText(rowValue(row, "packet_digest"), "packet_digest"),
        scope_ids: JSON.parse(sqlText(rowValue(row, "scope_ids_json"), "scope_ids_json")) as unknown,
        watermark: sqlText(rowValue(row, "watermark"), "watermark"),
        known_at_seq: sqlText(rowValue(row, "known_at_seq"), "known_at_seq"),
        scope_epochs: JSON.parse(sqlText(rowValue(row, "scope_epochs_json"), "scope_epochs_json")) as unknown,
        candidate_ids: JSON.parse(sqlText(rowValue(row, "candidate_ids_json"), "candidate_ids_json")) as unknown,
        output_ids: JSON.parse(sqlText(rowValue(row, "output_ids_json"), "output_ids_json")) as unknown,
        diagnostics: JSON.parse(sqlText(rowValue(row, "diagnostics_json"), "diagnostics_json")) as unknown,
        mode: sqlText(rowValue(row, "mode"), "mode"),
        token_unit: sqlText(rowValue(row, "token_unit"), "token_unit"),
        tokens_used: Number(sqlInteger(rowValue(row, "tokens_used"), "tokens_used")),
        token_budget: Number(sqlInteger(rowValue(row, "token_budget"), "token_budget")),
        created_at: sqlText(rowValue(row, "created_at"), "created_at"),
        valid_until: sqlText(rowValue(row, "valid_until"), "valid_until"),
        delivery_state: sqlText(rowValue(row, "delivery_state"), "delivery_state"),
      }, "query-trace") as QueryTraceRecord;
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  markQueryTraceReturned(injectionId: string): void {
    this.ensureOpen();
    const parsedInjectionId = parseContract(z.uuid(), injectionId, "injection-id");
    try {
      const updated = this.database
        .prepare("UPDATE query_trace SET delivery_state = 'returned' WHERE injection_id = ?")
        .run(parsedInjectionId);
      if (sqlInteger(updated.changes, "query_trace_changes") !== 1n) throw new StoreError("query_trace_write_failed");
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("query_trace_write_failed", error);
    }
  }

  private readOutputSpanRows(scopeId: string, sourceIds: readonly string[]): readonly unknown[] {
    if (sourceIds.length === 0) return [];
    if (sourceIds.length > LOCAL_UI_MAX_RESULTS) throw new StoreError("read_failed");
    const placeholders = sourceIds.map(() => "?").join(", ");
    return this.database
      .prepare(
        `SELECT source_id, scope_id, span_id, root, path, start_utf16, end_utf16, digest
           FROM source_span
          WHERE scope_id = ? AND source_id IN (${placeholders})
          ORDER BY source_id, rowid`,
      )
      .all(scopeId, ...sourceIds);
  }

  private mapOutputSourceRows(sourceRows: readonly unknown[], spanRows: readonly unknown[]): OutputSourceGroup[] {
    type MutableOutputSourceGroup = Omit<OutputSourceGroup, "spans"> & { spans: RecallSpanRow[] };
    const groups = new Map<string, MutableOutputSourceGroup>();
    const roots = new Map<string, { readonly payload: Record<string, unknown>; readonly event: Record<string, unknown> }>();
    for (const row of sourceRows) {
      const captureId = sqlText(rowValue(row, "capture_id"), "capture_id");
      if (groups.has(captureId)) throw new StoreError("schema_invalid");
      const eventJson = sqlText(rowValue(row, "event_json"), "event_json");
      const event = jsonObject(eventJson, "event_json");
      const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "payload_json"), "payload_json");
      roots.set(captureId, { payload, event });
      const provenance = event.provenance;
      const revisionId =
        typeof provenance === "object" && provenance !== null && "revision_id" in provenance && z.uuid().safeParse(provenance.revision_id).success
          ? String(provenance.revision_id)
          : captureId;
      const rank =
        typeof row === "object" && row !== null && "lexical_rank" in row && (row as Record<string, unknown>).lexical_rank !== null
          ? sqlNumber((row as Record<string, unknown>).lexical_rank, "lexical_rank")
          : undefined;
      groups.set(captureId, {
        capture_id: captureId,
        scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
        commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
        data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
        fingerprint: sqlText(rowValue(row, "fingerprint"), "fingerprint"),
        captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
        payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
        event_json: eventJson,
        coverage_json: sqlText(rowValue(row, "coverage_json"), "coverage_json"),
        revision_id: revisionId,
        evidence_class: recallSourceClass(rowValue(row, "evidence_class")),
        role: recallRole(rowValue(row, "role")),
        occurred_at: nullableSqlTextOrNull(rowValue(row, "occurred_at"), "occurred_at"),
        job_state: nullableSqlTextOrNull(rowValue(row, "job_state"), "job_state"),
        session_id: sqlText(rowValue(row, "session_id"), "session_id"),
        host_kind: sqlText(rowValue(row, "host_kind"), "host_kind"),
        project_label: sqlText(rowValue(row, "project_label"), "project_label"),
        spans: [],
        ...(rank === undefined ? {} : { lexical_rank: rank }),
      });
    }
    for (const row of spanRows) {
      const captureId = sqlText(rowValue(row, "source_id"), "source_id");
      const group = groups.get(captureId);
      const parsedRoots = roots.get(captureId);
      if (group === undefined || parsedRoots === undefined) throw new StoreError("schema_invalid");
      const { payload, event } = parsedRoots;
      const root = sourceSpanRoot(rowValue(row, "root"), "root");
      const path = sqlText(rowValue(row, "path"), "path");
      const start = safeSpanOffset(rowValue(row, "start_utf16"), "start_utf16");
      const end = safeSpanOffset(rowValue(row, "end_utf16"), "end_utf16");
      const digest = sqlText(rowValue(row, "digest"), "digest").toLowerCase();
      const quote = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
      group.spans.push({
        span_id: sqlText(rowValue(row, "span_id"), "span_id"),
        root,
        path,
        start_utf16: BigInt(start),
        end_utf16: BigInt(end),
        digest,
        quote,
      });
    }
    return [...groups.values()];
  }

  private mapRecallSourceRows(rows: readonly unknown[]): RecallSourceGroup[] {
    type MutableRecallSourceGroup = Omit<RecallSourceGroup, "spans"> & { spans: RecallSpanRow[] };
    const groups = new Map<string, MutableRecallSourceGroup>();
    const roots = new Map<string, { readonly payload: Record<string, unknown>; readonly event: Record<string, unknown> }>();
    for (const row of rows) {
      const captureId = sqlText(rowValue(row, "capture_id"), "capture_id");
      let group = groups.get(captureId);
      if (group === undefined) {
        const eventJson = sqlText(rowValue(row, "event_json"), "event_json");
        const event = jsonObject(eventJson, "event_json");
        const payload = jsonObject(sqlText(rowValue(row, "payload_json"), "payload_json"), "payload_json");
        roots.set(captureId, { payload, event });
        const provenance = event.provenance;
        // Older source envelopes may not carry normalized provenance. In that
        // case the durable capture ID is the source-revision identity only;
        // T05 never turns it into a semantic claim revision.
        const revisionId =
          typeof provenance === "object" && provenance !== null && "revision_id" in provenance && z.uuid().safeParse(provenance.revision_id).success
            ? String(provenance.revision_id)
            : captureId;
        group = {
          capture_id: captureId,
          scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
          commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq").toString(10),
          data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch").toString(10),
          fingerprint: sqlText(rowValue(row, "fingerprint"), "fingerprint"),
          captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
          payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
          event_json: eventJson,
          coverage_json: sqlText(rowValue(row, "coverage_json"), "coverage_json"),
          revision_id: revisionId,
          evidence_class: recallSourceClass(rowValue(row, "evidence_class")),
          role: recallRole(rowValue(row, "role")),
          occurred_at: nullableSqlTextOrNull(rowValue(row, "occurred_at"), "occurred_at"),
          job_state: nullableSqlTextOrNull(rowValue(row, "job_state"), "job_state"),
          spans: [],
        };
        groups.set(captureId, group);
      }
      if (rowValue(row, "span_id") === null) continue;
      const parsedRoots = roots.get(captureId);
      if (parsedRoots === undefined) throw new StoreError("schema_invalid");
      const { payload, event } = parsedRoots;
      const root = sourceSpanRoot(rowValue(row, "root"), "root");
      const path = sqlText(rowValue(row, "path"), "path");
      const start = safeSpanOffset(rowValue(row, "start_utf16"), "start_utf16");
      const end = safeSpanOffset(rowValue(row, "end_utf16"), "end_utf16");
      const digest = sqlText(rowValue(row, "digest"), "digest").toLowerCase();
      const quote = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
      group.spans.push({
        span_id: sqlText(rowValue(row, "span_id"), "span_id"),
        root,
        path,
        start_utf16: BigInt(start),
        end_utf16: BigInt(end),
        digest,
        quote,
      });
    }
    return [...groups.values()];
  }

  /**
   * Execute the only SQL search boundary exposed by the store. The caller may
   * supply only a quoted-token MATCH expression produced by retrieval; scope,
   * eligibility and temporal bounds are still validated and applied here.
   */
  searchLexicalCandidates(
    input: unknown,
    binding: TrustedBinding,
    match: string,
    limit: number,
    excludedCaptureId?: string,
    excludeCurrentSessionPrompts = false,
    anyTerms = false,
  ): SearchCandidateRow[] {
    this.ensureOpen();
    const request = validateBoundRecallRequest(input, binding);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new StoreError("read_failed", new Error("search_limit_invalid"));
    }
    const validMatch = anyTerms
      ? /^(?:"[\p{L}\p{N}_]+"(?:\s+OR\s+"[\p{L}\p{N}_]+")*)$/u.test(match)
      : /^(?:"[\p{L}\p{N}_]+"(?:\s+"[\p{L}\p{N}_]+")*)$/u.test(match);
    if (typeof anyTerms !== "boolean" || !validMatch || match.length > 2_048) {
      throw new StoreError("read_failed", new Error("search_match_invalid"));
    }

    const scopeIds = [...new Set(request.scope_ids)];
    const registeredScopes = this.database
      .prepare(`SELECT COUNT(*) AS count FROM scope WHERE scope_id IN (${scopeIds.map(() => "?").join(", ")})`)
      .get(...scopeIds);
    if (registeredScopes === undefined || sqlInteger(rowValue(registeredScopes, "count"), "scope_count") !== BigInt(scopeIds.length)) {
      throw new StoreError("scope_not_registered");
    }
    const excluded = excludedCaptureId === undefined ? undefined : parseContract(z.uuid(), excludedCaptureId, "excluded-capture-id");
    const conditions = [
      `f.search_fts MATCH ?`,
      `d.scope_id IN (${scopeIds.map(() => "?").join(", ")})`,
      "d.eligible = 1",
      "e.scope_id = d.scope_id",
      "g.output_target = ?",
      "t.capture_id IS NULL",
      recallSourceEligibility,
    ];
    const parameters: Array<string | number | bigint | null> = [match, ...scopeIds, readerOutputTarget(binding)];
    // Narrow trusted-context exclusion (T05d): when the native
    // submitted↔transformed identity is unprovable, the current native
    // session's own user/prompt sources must not echo as historical evidence.
    // Session identity comes only from the authenticated server binding, never
    // from payload fields; the filter stays scope-bound and applies before LIMIT.
    if (excludeCurrentSessionPrompts === true) {
      conditions.push(currentSessionPromptExclusion);
      parameters.push(
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    }
    if (excluded !== undefined) {
      conditions.push("e.capture_id <> ?");
      parameters.push(excluded);
    }
    if (request.known_at_seq !== undefined) {
      conditions.push("e.commit_seq <= ?");
      parameters.push(BigInt(request.known_at_seq));
    }
    // T04 returns raw source evidence. occurred_at is provenance metadata, not
    // a fact-validity bound; the bitemporal resolver owns valid_at semantics.
    parameters.push(limit);

    const rows = this.database
      .prepare(
        `SELECT
           d.rowid AS document_rowid,
           bm25(search_fts) AS rank,
           d.span_id AS document_span_id,
           d.source_id AS document_source_id,
           d.scope_id AS document_scope_id,
           d.root AS document_root,
           d.path AS document_path,
           d.start_utf16 AS document_start_utf16,
           d.end_utf16 AS document_end_utf16,
           d.digest AS document_digest,
           d.text AS document_text,
           d.representation AS document_representation,
           d.eligible AS document_eligible,
           d.generation AS document_generation,
           s.span_id AS source_span_id,
           s.scope_id AS source_scope_id,
           s.root AS source_root,
           s.path AS source_path,
           s.start_utf16 AS source_start_utf16,
           s.end_utf16 AS source_end_utf16,
           s.digest AS source_digest,
           e.capture_id AS source_id,
           e.scope_id AS source_scope,
           e.captured_at,
           e.occurred_at,
           e.payload_json,
           e.event_json,
           e.commit_seq,
           e.data_epoch
         FROM search_fts AS f
         JOIN search_document AS d ON d.rowid = f.rowid
         LEFT JOIN source_span AS s ON s.source_id = d.source_id AND s.span_id = d.span_id
         JOIN source_event AS e ON e.capture_id = d.source_id
         JOIN scope AS sc ON sc.scope_id = d.scope_id
         JOIN scope_output_grant AS g ON g.scope_id = d.scope_id AND g.source_class = e.evidence_class
         LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY bm25(search_fts), d.rowid
         LIMIT ?`,
      )
      .all(...parameters);

    return rows.map((row) => ({
      rowid: sqlInteger(rowValue(row, "document_rowid"), "document_rowid"),
      rank: sqlNumber(rowValue(row, "rank"), "rank"),
      document_span_id: sqlText(rowValue(row, "document_span_id"), "document_span_id"),
      document_source_id: sqlText(rowValue(row, "document_source_id"), "document_source_id"),
      document_scope_id: sqlText(rowValue(row, "document_scope_id"), "document_scope_id"),
      document_root: sourceSpanRoot(rowValue(row, "document_root"), "document_root"),
      document_path: sqlText(rowValue(row, "document_path"), "document_path"),
      document_start_utf16: sqlInteger(rowValue(row, "document_start_utf16"), "document_start_utf16"),
      document_end_utf16: sqlInteger(rowValue(row, "document_end_utf16"), "document_end_utf16"),
      document_digest: sqlText(rowValue(row, "document_digest"), "document_digest"),
      document_text: sqlText(rowValue(row, "document_text"), "document_text"),
      document_representation: sqlText(rowValue(row, "document_representation"), "document_representation"),
      document_eligible: sqlInteger(rowValue(row, "document_eligible"), "document_eligible"),
      document_generation: sqlInteger(rowValue(row, "document_generation"), "document_generation"),
      source_span_id: nullableSqlText(rowValue(row, "source_span_id"), "source_span_id"),
      source_scope_id: nullableSqlText(rowValue(row, "source_scope_id"), "source_scope_id"),
      source_root: nullableSourceSpanRoot(rowValue(row, "source_root"), "source_root"),
      source_path: nullableSqlText(rowValue(row, "source_path"), "source_path"),
      source_start_utf16: nullableSqlInteger(rowValue(row, "source_start_utf16"), "source_start_utf16"),
      source_end_utf16: nullableSqlInteger(rowValue(row, "source_end_utf16"), "source_end_utf16"),
      source_digest: nullableSqlText(rowValue(row, "source_digest"), "source_digest"),
      source_id: sqlText(rowValue(row, "source_id"), "source_id"),
      source_scope: sqlText(rowValue(row, "source_scope"), "source_scope"),
      captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
      occurred_at: nullableSqlText(rowValue(row, "occurred_at"), "occurred_at"),
      payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
      event_json: sqlText(rowValue(row, "event_json"), "event_json"),
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq"),
      data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch"),
    }));
  }

  /**
   * Resolve the graph starting entities for evidence revisions and captured
   * sources (plan §9 step 4 "Start-Entities/Quellen"). Scope authorization
   * and the trusted binding are re-checked here; the result contains only
   * entities inside the authorized scopes.
   */
  /**
   * Return bounded, source-only structural neighbors. Metadata is limited to
   * persisted native message/tool IDs and explicit JSON path fields; session
   * links are only the immediate previous/next stored event, never a
   * session-wide clique. Every candidate is grant-, purge-, scope-, and
   * known-at-filtered before it leaves this method.
   *
   * ponytail: native-id/path fields have no dedicated indexes yet, so this is
   * one bounded result read of at most 128 edges. The existing scope/commit
   * index bounds session ordering, but unindexed native-id/path matching can
   * still scan an authorized scope; add metadata indexes or a scan window when
   * that measured ceiling becomes too high.
   */
  getSourceGraphNeighbors(input: unknown, binding: TrustedBinding): SourceGraphNeighborRows {
    this.ensureOpen();
    const parsed = parseContract(sourceGraphNeighborQuerySchema, input, "source-graph-neighbor-query");
    if (new Set(parsed.scope_ids).size !== parsed.scope_ids.length || new Set(parsed.source_ids).size !== parsed.source_ids.length) {
      throw new StoreError("read_failed", new Error("source_graph_duplicate_id"));
    }
    if (parsed.source_ids.length === 0) {
      const empty = [] as unknown as SourceGraphNeighborRows;
      Object.defineProperty(empty, "truncated", { value: false, enumerable: false });
      return empty;
    }

    const scopeIds = recallScopeIds(parsed.scope_ids, binding);
    const target = readerOutputTarget(binding);
    const excluded = parsed.excluded_capture_id;
    const scopePlaceholders = scopeIds.map(() => "?").join(", ");
    const sourcePlaceholders = parsed.source_ids.map(() => "?").join(", ");
    const currentSessionClause = parsed.exclude_current_session_prompts === true ? ` AND ${currentSessionPromptExclusion}` : "";
    const excludedClause = excluded === undefined ? "" : " AND e.capture_id <> ?";
    const parameters: Array<string | bigint | number> = [target, ...scopeIds, BigInt(parsed.known_at_seq)];
    if (excluded !== undefined) parameters.push(excluded);
    if (parsed.exclude_current_session_prompts === true) {
      parameters.push(
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    }
    const limit = Math.min(parsed.limit, SOURCE_GRAPH_QUERY_ROW_LIMIT);
    parameters.push(...parsed.source_ids, ...scopeIds, BigInt(parsed.known_at_seq), limit + 1);

    const rows = this.database
      .prepare(
        `WITH eligible AS (
           SELECT
             e.capture_id,
             e.scope_id,
             e.session_id,
             e.native_session_id,
             e.native_message_id,
             e.native_tool_call_id,
             e.commit_seq,
             ${sourceGraphPathSql("e")} AS explicit_file_path
           FROM source_event AS e
           JOIN scope_output_grant AS g
             ON g.scope_id = e.scope_id
            AND g.output_target = ?
            AND g.source_class = e.evidence_class
           LEFT JOIN purge_tombstone AS t
             ON t.scope_id = e.scope_id
            AND t.capture_id = e.capture_id
           WHERE e.scope_id IN (${scopePlaceholders})
             AND e.commit_seq <= ?
             AND t.capture_id IS NULL
             AND ${recallSourceEligibility}
             ${excludedClause}
             ${currentSessionClause}
         ), seeds AS (
           SELECT capture_id, scope_id, session_id, native_session_id, native_message_id, native_tool_call_id, explicit_file_path
           FROM eligible
           WHERE capture_id IN (${sourcePlaceholders})
         ), message_edges AS (
           SELECT s.capture_id AS from_id, e.capture_id AS source_id, e.scope_id, 'message_id' AS kind
           FROM seeds AS s
           JOIN eligible AS e
            ON e.scope_id = s.scope_id
           AND e.capture_id <> s.capture_id
            AND e.session_id = s.session_id
           AND s.native_session_id IS NOT NULL
           AND s.native_session_id = e.native_session_id
           AND s.native_message_id IS NOT NULL
            AND s.native_message_id = e.native_message_id
         ), tool_edges AS (
           SELECT s.capture_id AS from_id, e.capture_id AS source_id, e.scope_id, 'tool_call_id' AS kind
           FROM seeds AS s
           JOIN eligible AS e
            ON e.scope_id = s.scope_id
           AND e.capture_id <> s.capture_id
            AND e.session_id = s.session_id
           AND s.native_session_id IS NOT NULL
           AND s.native_session_id = e.native_session_id
           AND s.native_tool_call_id IS NOT NULL
            AND s.native_tool_call_id = e.native_tool_call_id
         ), path_edges AS (
           SELECT s.capture_id AS from_id, e.capture_id AS source_id, e.scope_id, 'file_path' AS kind
           FROM seeds AS s
           JOIN eligible AS e
             ON e.scope_id = s.scope_id
            AND e.capture_id <> s.capture_id
            AND typeof(s.explicit_file_path) = 'text'
            AND typeof(e.explicit_file_path) = 'text'
            AND length(s.explicit_file_path) BETWEEN 1 AND 4096
            AND length(e.explicit_file_path) BETWEEN 1 AND 4096
            AND s.explicit_file_path = e.explicit_file_path
         ), ordered_events AS (
           SELECT
             e.capture_id,
             e.scope_id,
             e.session_id,
             LAG(e.capture_id) OVER (
               PARTITION BY e.scope_id, e.session_id
               ORDER BY e.commit_seq, e.capture_id
             ) AS previous_id,
             LEAD(e.capture_id) OVER (
               PARTITION BY e.scope_id, e.session_id
               ORDER BY e.commit_seq, e.capture_id
             ) AS next_id
           FROM source_event AS e
           WHERE e.scope_id IN (${scopePlaceholders})
             AND e.commit_seq <= ?
         ), session_edges AS (
           SELECT s.capture_id AS from_id, n.capture_id AS source_id, s.scope_id, 'previous_event' AS kind
           FROM seeds AS s
           JOIN ordered_events AS o ON o.capture_id = s.capture_id AND o.scope_id = s.scope_id
           JOIN eligible AS n ON n.capture_id = o.previous_id AND n.scope_id = s.scope_id
           UNION ALL
           SELECT s.capture_id AS from_id, n.capture_id AS source_id, s.scope_id, 'next_event' AS kind
           FROM seeds AS s
           JOIN ordered_events AS o ON o.capture_id = s.capture_id AND o.scope_id = s.scope_id
           JOIN eligible AS n ON n.capture_id = o.next_id AND n.scope_id = s.scope_id
         ), edges AS (
           SELECT from_id, source_id, scope_id, kind FROM message_edges
           UNION ALL
           SELECT from_id, source_id, scope_id, kind FROM tool_edges
           UNION ALL
           SELECT from_id, source_id, scope_id, kind FROM path_edges
           UNION ALL
           SELECT from_id, source_id, scope_id, kind FROM session_edges
         )
         SELECT from_id, source_id, scope_id, kind, 1 AS marker
         FROM edges
         ORDER BY marker, from_id, source_id, kind
         LIMIT ?`,
      )
      .all(...parameters);

    const neighbors: SourceGraphNeighbor[] = [];
    for (const row of rows.slice(0, limit)) {
      neighbors.push({
        from_id: sqlText(rowValue(row, "from_id"), "source-graph-from-id"),
        source_id: sqlText(rowValue(row, "source_id"), "source-graph-source-id"),
        scope_id: sqlText(rowValue(row, "scope_id"), "source-graph-scope-id"),
        kind: sqlText(rowValue(row, "kind"), "source-graph-kind"),
      });
    }
    const result = neighbors as SourceGraphNeighborRows;
    Object.defineProperty(result, "truncated", { value: rows.length > limit, enumerable: false });
    return result;
  }

  graphStartEntities(input: unknown, binding: TrustedBinding): GraphStartEntityRow[] {
    this.ensureOpen();
    const parsed = parseContract(graphStartEntityQuerySchema, input, "graph-start-entity-query");
    const scopeIds = recallScopeIds(parsed.scope_ids, binding);
    const revisionIds = [...new Set(parsed.revision_ids ?? [])];
    const captureIds = [...new Set(parsed.capture_ids ?? [])];
    const scopePlaceholders = scopeIds.map(() => "?").join(", ");
    const revisionClause = revisionIds.length === 0
      ? "0 = 1"
      : `mr.revision_id IN (${revisionIds.map(() => "?").join(", ")})`;
    const captureClause = captureIds.length === 0
      ? "0 = 1"
      : `rs.source_capture_id IN (${captureIds.map(() => "?").join(", ")})`;
    const rows = this.database
      .prepare(
        `SELECT DISTINCT scope_id, entity_id FROM (
           SELECT mi.scope_id AS scope_id, mi.entity_id AS entity_id
           FROM memory_revision AS mr
           JOIN memory_item AS mi ON mi.scope_id = mr.scope_id AND mi.item_id = mr.item_id
           WHERE mr.scope_id IN (${scopePlaceholders}) AND ${revisionClause} AND mi.entity_id IS NOT NULL
           UNION
           SELECT mi.scope_id AS scope_id, mi.entity_id AS entity_id
           FROM revision_source AS rs
           JOIN memory_revision AS mr ON mr.scope_id = rs.scope_id AND mr.revision_id = rs.revision_id
           JOIN memory_item AS mi ON mi.scope_id = mr.scope_id AND mi.item_id = mr.item_id
           WHERE rs.scope_id IN (${scopePlaceholders}) AND ${captureClause} AND mi.entity_id IS NOT NULL
         )
         ORDER BY scope_id, entity_id`,
      )
      .all(...scopeIds, ...revisionIds, ...scopeIds, ...captureIds);
    return rows.map((row) => ({
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      entity_id: sqlText(rowValue(row, "entity_id"), "entity_id"),
    }));
  }

  /**
   * Expand the evidenced relation graph from starting entities (plan §9 step
   * 4). A recursive CTE walks at most two hops; scope, evidence status
   * (`status='active'`) and both temporal dimensions (valid_at against the
   * edge validity bounds, known_at_seq against the transaction bounds) are
   * checked at every hop, so an edge can never be reached through a hop that
   * its own status or validity forbids. Only edges whose evidence revision
   * still yields an eligible, granted, non-purged evidence passage are
   * returned; unevidenced relations produce no candidates. `limit` is the
   * candidate budget; `has_more` plus the deterministic (hop, scope_id,
   * edge_id) order make an exhausted expansion resumable via `cursor`.
   */
  expandGraphRelations(input: unknown, binding: TrustedBinding): GraphExpansionRelations {
    this.ensureOpen();
    const parsed = parseContract(graphExpansionQuerySchema, input, "graph-expansion-query");
    const scopeIds = recallScopeIds(parsed.scope_ids, binding);
    const startEntityIds = [...new Set(parsed.start_entity_ids)];
    if (startEntityIds.length === 0) return { edges: [], has_more: false };
    const validAt = parsed.valid_at ?? null;
    const knownSeq = parsed.known_at_seq === undefined ? null : BigInt(parsed.known_at_seq);
    const cursor = parsed.cursor;
    const budget = parsed.limit;
    const target = readerOutputTarget(binding);
    const temporalClause =
      "(? IS NULL OR ((e.valid_from IS NULL OR e.valid_from <= ?) AND (e.valid_to IS NULL OR e.valid_to > ?))) AND " +
      "(? IS NULL OR (e.tx_from_seq <= ? AND (e.tx_to_seq IS NULL OR e.tx_to_seq > ?)))";
    const traversalTemporal = [
      validAt, validAt, validAt,
      knownSeq, knownSeq, knownSeq,
    ] as const;
    const cursorClause = cursor === undefined ? "" : " AND (ed.hop, ed.scope_id, ed.edge_id) > (?, ?, ?)";
    const cursorParameters = cursor === undefined ? [] : [cursor.hop, cursor.scope_id, cursor.edge_id];
    let committed = false;
    try {
      this.database.exec("BEGIN");
      const edgeRows = this.database
        .prepare(
          `WITH RECURSIVE
           seed(scope_id, entity_id) AS (
             SELECT e.scope_id, e.entity_id
             FROM entity AS e
             WHERE e.scope_id IN (${scopeIds.map(() => "?").join(", ")})
               AND e.entity_id IN (${startEntityIds.map(() => "?").join(", ")})
           ),
           reached(scope_id, entity_id, via_edge, hop) AS (
             SELECT scope_id, entity_id, CAST(NULL AS TEXT), 0 FROM seed
             UNION
             SELECT e.scope_id,
                    CASE WHEN e.source_entity = r.entity_id THEN e.target_entity ELSE e.source_entity END,
                    e.edge_id,
                    r.hop + 1
             FROM reached AS r
             JOIN semantic_edge AS e
               ON e.scope_id = r.scope_id
              AND (e.source_entity = r.entity_id OR e.target_entity = r.entity_id)
             WHERE r.hop < ?
               AND e.status = 'active'
               AND ${temporalClause}
           ),
           first_hop(scope_id, edge_id, entity_id) AS (
             SELECT scope_id, via_edge, entity_id
             FROM reached
             WHERE hop = 1 AND via_edge IS NOT NULL
           ),
           traversed(scope_id, edge_id, hop, path_json) AS (
             SELECT scope_id, via_edge, 1, json_array(via_edge)
             FROM reached
             WHERE hop = 1 AND via_edge IS NOT NULL
             UNION ALL
             SELECT r.scope_id, r.via_edge, 2, json_array(p.edge_id, r.via_edge)
             FROM reached AS r
             JOIN semantic_edge AS e
               ON e.scope_id = r.scope_id AND e.edge_id = r.via_edge
             JOIN first_hop AS p
               ON p.scope_id = r.scope_id
              AND p.edge_id <> r.via_edge
              AND (p.entity_id = e.source_entity OR p.entity_id = e.target_entity)
             WHERE r.hop = 2 AND r.via_edge IS NOT NULL
           ),
           ranked_paths AS (
             SELECT scope_id, edge_id, hop, path_json,
                    ROW_NUMBER() OVER (
                      PARTITION BY scope_id, edge_id
                      ORDER BY hop, path_json
                    ) AS path_rank
             FROM traversed
           )
           SELECT ed.scope_id, ed.edge_id, ed.hop,
                  ed.path_json,
                  e.source_entity, e.target_entity, e.predicate, e.qualifiers_json,
                  e.evidence_revision, e.valid_from, e.valid_to, e.tx_from_seq, e.tx_to_seq, e.status
           FROM ranked_paths AS ed
           JOIN semantic_edge AS e ON e.scope_id = ed.scope_id AND e.edge_id = ed.edge_id
           WHERE e.status = 'active'
             AND ed.path_rank = 1
             AND ${temporalClause}${cursorClause}
           ORDER BY ed.hop, ed.scope_id, ed.edge_id
           LIMIT ?`,
        )
        .all(
          ...scopeIds,
          ...startEntityIds,
          BigInt(GRAPH_MAX_HOPS),
          ...traversalTemporal,
          ...traversalTemporal,
          ...cursorParameters,
          budget + 1,
        );
      const ordered = edgeRows.map((row) => ({
        scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
        edge_id: sqlText(rowValue(row, "edge_id"), "edge_id"),
        hop: Number(sqlInteger(rowValue(row, "hop"), "hop")),
        path_edge_ids: parseGraphPath(rowValue(row, "path_json")),
        source_entity: sqlText(rowValue(row, "source_entity"), "source_entity"),
        target_entity: sqlText(rowValue(row, "target_entity"), "target_entity"),
        predicate: sqlText(rowValue(row, "predicate"), "predicate"),
        qualifiers_json: sqlText(rowValue(row, "qualifiers_json"), "qualifiers_json"),
        evidence_revision: sqlText(rowValue(row, "evidence_revision"), "evidence_revision"),
        valid_from: nullableSqlTextOrNull(rowValue(row, "valid_from"), "valid_from"),
        valid_to: nullableSqlTextOrNull(rowValue(row, "valid_to"), "valid_to"),
        tx_from_seq: sqlInteger(rowValue(row, "tx_from_seq"), "tx_from_seq").toString(10),
        tx_to_seq: rowValue(row, "tx_to_seq") === null ? null : sqlInteger(rowValue(row, "tx_to_seq"), "tx_to_seq").toString(10),
        status: sqlText(rowValue(row, "status"), "status"),
      }));
      const delivered = ordered.slice(0, budget);
      const hasMore = ordered.length > budget;
      // Resume after the last delivered edge; the probe row beyond the
      // budget was not delivered and must be offered again.
      const lastDelivered = hasMore ? delivered[delivered.length - 1] : undefined;
      const nextCursor = lastDelivered === undefined
        ? undefined
        : { hop: lastDelivered.hop, scope_id: lastDelivered.scope_id, edge_id: lastDelivered.edge_id };
      if (delivered.length === 0) {
        this.database.exec("COMMIT");
        committed = true;
        return nextCursor === undefined ? { edges: [], has_more: false } : { edges: [], has_more: true, next_cursor: nextCursor };
      }
      // Evidence passages: only relations whose evidence revision still
      // resolves to an eligible, granted, non-purged source span produce a
      // candidate; everything else fails closed.
      const passageRows = this.database
        .prepare(
          `SELECT rs.scope_id, rs.revision_id, rs.source_capture_id, rs.source_span_id,
                  d.text AS document_text, ev.captured_at, ev.occurred_at, ev.commit_seq, ev.data_epoch
           FROM revision_source AS rs
           JOIN search_document AS d
             ON d.scope_id = rs.scope_id AND d.source_id = rs.source_capture_id AND d.span_id = rs.source_span_id
           JOIN source_event AS ev ON ev.scope_id = rs.scope_id AND ev.capture_id = rs.source_capture_id
           JOIN scope_output_grant AS g ON g.scope_id = rs.scope_id AND g.source_class = ev.evidence_class AND g.output_target = ?
           LEFT JOIN purge_tombstone AS t ON t.scope_id = rs.scope_id AND t.capture_id = rs.source_capture_id
           WHERE t.capture_id IS NULL
             AND d.eligible = 1
             AND (? IS NULL OR ev.commit_seq <= ?)
             AND (rs.scope_id, rs.revision_id) IN (VALUES ${delivered.map(() => "(?, ?)").join(", ")})
           ORDER BY rs.scope_id, rs.revision_id, rs.source_capture_id, rs.source_span_id`,
        )
        .all(target, knownSeq, knownSeq, ...delivered.flatMap((edge) => [edge.scope_id, edge.evidence_revision]));
      const passages = new Map<string, unknown>();
      for (const row of passageRows) {
        const key = `${sqlText(rowValue(row, "scope_id"), "scope_id")}\u0000${sqlText(rowValue(row, "revision_id"), "revision_id")}`;
        if (!passages.has(key)) passages.set(key, row);
      }
      const edges: GraphEdgeCandidateRow[] = [];
      for (const edge of delivered) {
        const passage = passages.get(`${edge.scope_id}\u0000${edge.evidence_revision}`);
        if (passage === undefined) continue;
        edges.push({
          scope_id: edge.scope_id,
          edge_id: edge.edge_id,
          hop: edge.hop,
          path_edge_ids: edge.path_edge_ids,
          source_entity: edge.source_entity,
          target_entity: edge.target_entity,
          predicate: edge.predicate,
          qualifiers_json: edge.qualifiers_json,
          evidence_revision: edge.evidence_revision,
          valid_from: edge.valid_from,
          valid_to: edge.valid_to,
          tx_from_seq: edge.tx_from_seq,
          tx_to_seq: edge.tx_to_seq,
          evidence_source_id: sqlText(rowValue(passage, "source_capture_id"), "source_capture_id"),
          evidence_span_id: sqlText(rowValue(passage, "source_span_id"), "source_span_id"),
          evidence_text: sqlText(rowValue(passage, "document_text"), "document_text"),
          captured_at: sqlText(rowValue(passage, "captured_at"), "captured_at"),
          occurred_at: nullableSqlTextOrNull(rowValue(passage, "occurred_at"), "occurred_at"),
          commit_seq: sqlInteger(rowValue(passage, "commit_seq"), "commit_seq").toString(10),
          data_epoch: sqlInteger(rowValue(passage, "data_epoch"), "data_epoch").toString(10),
        });
      }
      this.database.exec("COMMIT");
      committed = true;
      return nextCursor === undefined ? { edges, has_more: false } : { edges, has_more: true, next_cursor: nextCursor };
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the original graph expansion failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  commitNativeObservation(prepared: PreparedCapture, binding: TrustedBinding, observationInput: unknown): CaptureAck {
    this.ensureOpen();
    if (!isTrustedBinding(binding) || binding.host_kind !== "opencode" || binding.surface !== "opencode_cli") {
      throw new StoreError("native_observation_conflict");
    }
    const observation = parseContract(nativeObservationSchema, observationInput, "native-observation");
    if (!binding.allowed_scope_ids.includes(prepared.envelope.scope_id)) throw new StoreError("scope_not_allowed");
    if (prepared.envelope.event.native_ids.session_id !== binding.host_session_id) {
      throw new StoreError("native_observation_conflict");
    }
    if (
      observation.identity.kind === "part_snapshot" &&
      (observation.identity.session_id !== binding.host_session_id ||
        prepared.envelope.event.native_ids.session_id !== observation.identity.session_id ||
        prepared.envelope.event.native_ids.message_id !== observation.identity.message_id ||
        prepared.envelope.event.native_ids.part_id !== observation.identity.part_id)
    ) {
      throw new StoreError("native_observation_conflict");
    }
    const identity = observation.identity.kind === "event"
      ? {
          kind: "event" as const,
          key: nativeEventIdentityKey(prepared.envelope.event.stage, binding.host_session_id, prepared.envelope.event.native_ids),
        }
      : observation.identity;
    return this.commitCapture(prepared, undefined, { ...observation, identity, binding_id: binding.binding_id });
  }

  beginNativeReconcileScan(binding: TrustedBinding, scopeId: string, startedAt: string): NativeReconcileScan {
    this.ensureOpen();
    if (!isTrustedBinding(binding) || binding.host_kind !== "opencode" || binding.surface !== "opencode_cli") {
      throw new StoreError("native_scan_invalid");
    }
    const parsedScopeId = parseContract(z.uuid(), scopeId, "native-scan-scope");
    const parsedAt = parseContract(z.iso.datetime({ offset: true }), startedAt, "native-scan-started-at");
    if (!binding.allowed_scope_ids.includes(parsedScopeId)) throw new StoreError("scope_not_allowed");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      if (this.database.prepare("SELECT 1 AS present FROM scope WHERE scope_id = ?").get(parsedScopeId) === undefined) {
        throw new StoreError("scope_not_registered");
      }
      const counter = this.database.prepare("SELECT commit_seq FROM vault_counter WHERE id = 1").get();
      if (counter === undefined) throw new StoreError("native_scan_invalid");
      const previous = this.database.prepare(`SELECT cursor_json, state FROM opencode_reconcile_scan
        WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(parsedScopeId, binding.binding_id, binding.host_session_id);
      const previousCursor = previous === undefined || rowValue(previous, "state") !== "active" ? null : rowValue(previous, "cursor_json");
      const cursor = previousCursor === null ? null : parseContract(nativeReconcileCursorSchema,
        JSON.parse(sqlText(previousCursor, "native-scan-cursor")), "native-scan-cursor");
      const coverage: NativeReconcileCoverage = { status: "partial", reason: "scan_in_progress" };
      const scanId = randomUUID();
      const watermark = sqlInteger(rowValue(counter, "commit_seq"), "native-scan-watermark");
      this.database
        .prepare(
          `INSERT INTO opencode_reconcile_scan (
             scan_id, scope_id, binding_id, native_session_id, watermark, cursor_json,
             state, coverage_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(scanId, parsedScopeId, binding.binding_id, binding.host_session_id, watermark, cursor === null ? null : JSON.stringify(cursor), JSON.stringify(coverage), parsedAt, parsedAt);
      this.database.exec("COMMIT");
      committed = true;
      return {
        scan_id: scanId,
        scope_id: parsedScopeId,
        binding_id: binding.binding_id,
        native_session_id: binding.host_session_id,
        watermark: watermark.toString(10),
        cursor,
        coverage,
        state: "active",
      };
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve scan failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("native_scan_invalid", error);
    }
  }

  advanceNativeReconcileCursor(input: {
    readonly binding: TrustedBinding;
    readonly scan_id: string;
    readonly cursor: NativeReconcileCursor | null;
    readonly capture_ids: readonly string[];
    readonly complete?: boolean;
    readonly coverage?: NativeReconcileCoverage;
    readonly updated_at: string;
  }): NativeReconcileScan {
    this.ensureOpen();
    if (!isTrustedBinding(input.binding) || input.binding.host_kind !== "opencode" || input.binding.surface !== "opencode_cli") {
      throw new StoreError("native_cursor_conflict");
    }
    const scanId = parseContract(z.uuid(), input.scan_id, "native-scan-id");
    const cursor = input.cursor === null ? null : parseContract(nativeReconcileCursorSchema, input.cursor, "native-scan-cursor");
    const updatedAt = parseContract(z.iso.datetime({ offset: true }), input.updated_at, "native-scan-updated-at");
    if (!Array.isArray(input.capture_ids) || new Set(input.capture_ids).size !== input.capture_ids.length || input.capture_ids.some((id) => !z.uuid().safeParse(id).success)) {
      throw new StoreError("native_cursor_conflict");
    }
    const coverage = parseContract(nativeReconcileCoverageSchema, input.coverage ?? { status: "complete" }, "native-scan-coverage");
    if (coverage.status !== "complete" && coverage.status !== "partial" && coverage.status !== "coverage_gap") {
      throw new StoreError("native_cursor_conflict");
    }
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const scan = this.database
        .prepare("SELECT scope_id, binding_id, native_session_id, watermark, state FROM opencode_reconcile_scan WHERE scan_id = ?")
        .get(scanId);
      if (
        scan === undefined ||
        sqlText(rowValue(scan, "binding_id"), "native-scan-binding") !== input.binding.binding_id ||
        sqlText(rowValue(scan, "native_session_id"), "native-scan-session") !== input.binding.host_session_id ||
        sqlText(rowValue(scan, "state"), "native-scan-state") !== "active"
      ) throw new StoreError("native_cursor_conflict");
      const scopeId = sqlText(rowValue(scan, "scope_id"), "native-scan-scope");
      for (const captureId of input.capture_ids) {
        const receipt = this.database
          .prepare("SELECT 1 AS present FROM opencode_observation_receipt WHERE scope_id = ? AND binding_id = ? AND capture_id = ? AND state = 'active'")
          .get(scopeId, input.binding.binding_id, captureId);
        if (receipt === undefined) throw new StoreError("native_cursor_conflict");
      }
      const state = input.complete === true
        ? "completed"
        : coverage.status === "coverage_gap"
          ? "invalidated"
          : "active";
      const updated = this.database
        .prepare("UPDATE opencode_reconcile_scan SET cursor_json = ?, state = ?, coverage_json = ?, updated_at = ? WHERE scan_id = ? AND state = 'active'")
        .run(cursor === null ? null : JSON.stringify(cursor), state, JSON.stringify(coverage), updatedAt, scanId);
      if (sqlInteger(updated.changes, "native-scan-update") !== 1n) throw new StoreError("native_cursor_conflict");
      this.database.exec("COMMIT");
      committed = true;
      return {
        scan_id: scanId,
        scope_id: scopeId,
        binding_id: input.binding.binding_id,
        native_session_id: input.binding.host_session_id,
        watermark: sqlInteger(rowValue(scan, "watermark"), "native-scan-watermark").toString(10),
        cursor,
        coverage,
        state,
      };
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve cursor failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("native_cursor_conflict", error);
    }
  }

  commitCapture(prepared: PreparedCapture, embed?: EmbedJobRequest, nativeObservation?: NativeCaptureMetadata): CaptureAck {
    this.ensureOpen();
    let checked = requirePreparedCapture(prepared);
    const embedTaskVersion =
      embed?.task_version ?? this.embeddingTaskVersion;
    const parsedEmbedTaskVersion =
      embedTaskVersion === undefined
        ? undefined
        : parseContract(z.string().min(1).max(128), embedTaskVersion, "embed-task-version");
    let transactionCommitted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");

      const native = nativeObservation === undefined
        ? undefined
        : {
            ...parseContract(
              nativeObservationSchema,
              (({ binding_id: _bindingId, ...wireObservation }) => wireObservation)(nativeObservation),
              "native-observation",
            ),
            binding_id: parseContract(z.uuid(), nativeObservation.binding_id, "native-observation-binding"),
          };
      const nativeKey = native === undefined ? undefined : nativeObservationKey(native.identity);
      const nativeScopeId = checked.envelope.scope_id;
      if (native !== undefined) {
        const observationKey = nativeKey;
        if (observationKey === undefined) throw new StoreError("native_observation_conflict");
        if (native.binding_id !== undefined && native.binding_id.length === 0) throw new StoreError("native_observation_conflict");
        if (native.scan_id !== undefined && native.scan_watermark !== undefined) {
          const scan = this.database
            .prepare(
              `SELECT scope_id, binding_id, native_session_id, watermark, state
                 FROM opencode_reconcile_scan
                WHERE scan_id = ?`,
            )
            .get(native.scan_id);
          if (
            scan === undefined ||
            sqlText(rowValue(scan, "scope_id"), "native-scan-scope") !== nativeScopeId ||
            sqlText(rowValue(scan, "binding_id"), "native-scan-binding") !== native.binding_id ||
            sqlText(rowValue(scan, "native_session_id"), "native-scan-session") !== checked.envelope.origin.host_session_id ||
            sqlInteger(rowValue(scan, "watermark"), "native-scan-watermark").toString(10) !== native.scan_watermark ||
            sqlText(rowValue(scan, "state"), "native-scan-state") !== "active"
          ) {
            throw new StoreError("native_scan_invalid");
          }
        }
        const tombstone = this.database
          .prepare(
            `SELECT 1 AS present
               FROM opencode_identity_tombstone
              WHERE scope_id = ? AND binding_id = ? AND native_session_id = ?
                AND ((identity_kind = ? AND identity_key = ?)
                  OR (message_id = ? AND (part_id IS NULL OR part_id = ? OR ? IS NULL)))`,
          )
          .get(nativeScopeId, native.binding_id, checked.envelope.origin.host_session_id,
            native.identity.kind, observationKey, checked.envelope.event.native_ids.message_id ?? null,
            checked.envelope.event.native_ids.part_id ?? null, checked.envelope.event.native_ids.part_id ?? null);
        if (tombstone !== undefined) throw new StoreError("native_observation_blocked");
        if (native.identity.kind === "event") {
          const receipt = this.database
            .prepare(
              `SELECT capture_id, content_digest, first_observed_at, state
                 FROM opencode_observation_receipt
                WHERE scope_id = ? AND binding_id = ? AND identity_kind = 'event' AND identity_key = ? AND generation = 0`,
            )
            .get(nativeScopeId, native.binding_id, observationKey);
          if (receipt !== undefined) {
            if (sqlText(rowValue(receipt, "state"), "native-receipt-state") !== "active") {
              throw new StoreError("native_observation_blocked");
            }
            const incomingDigest = preparedCaptureContentDigest(checked);
            if (sqlText(rowValue(receipt, "content_digest"), "native-receipt-digest") !== incomingDigest) {
              throw new StoreError("native_observation_conflict");
            }
            checked = rebasePreparedCaptureCapturedAt(
              checked,
              sqlText(rowValue(receipt, "first_observed_at"), "native-receipt-observed-at"),
              sqlText(rowValue(receipt, "capture_id"), "native-receipt-capture"),
            );
          }
        } else {
          const head = this.database
            .prepare(
              `SELECT generation, current_capture_id, current_digest, first_observed_at, last_commit_seq, last_scan_id, state
                 FROM opencode_observation_head
                WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ? AND part_id = ?`,
            )
            .get(nativeScopeId, native.binding_id, native.identity.session_id, native.identity.message_id, native.identity.part_id);
          const eventWatermark = native.identity.expected_generation === "0" ? "0" : native.scan_watermark;
          if (eventWatermark !== undefined && (head === undefined || rowValue(head, "current_digest") !== preparedCaptureContentDigest(checked))) {
            const laterEvent = this.database.prepare(`SELECT 1 AS present FROM opencode_observation_receipt
              WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ?
                AND (part_id = ? OR part_id IS NULL) AND identity_kind = 'event' AND commit_seq > ? LIMIT 1`)
              .get(nativeScopeId, native.binding_id, native.identity.session_id, native.identity.message_id, native.identity.part_id, BigInt(eventWatermark));
            if (laterEvent !== undefined) throw new StoreError("native_cursor_conflict");
          }
          if (head !== undefined) {
            if (sqlText(rowValue(head, "state"), "native-head-state") !== "active") {
              throw new StoreError("native_observation_blocked");
            }
            const incomingDigest = preparedCaptureContentDigest(checked);
            const currentDigest = sqlText(rowValue(head, "current_digest"), "native-head-digest");
            if (currentDigest === incomingDigest) {
              const captureId = sqlText(rowValue(head, "current_capture_id"), "native-head-capture");
              const source = this.database
                .prepare("SELECT captured_at FROM source_event WHERE scope_id = ? AND capture_id = ?")
                .get(nativeScopeId, captureId);
              if (source === undefined) throw new StoreError("capture_invariant");
              checked = rebasePreparedCaptureCapturedAt(checked, sqlText(rowValue(source, "captured_at"), "native-head-captured-at"), captureId);
            } else {
              const generation = sqlInteger(rowValue(head, "generation"), "native-head-generation");
              if (native.scan_id !== undefined && native.scan_watermark !== undefined) {
                const lastCommit = sqlInteger(rowValue(head, "last_commit_seq"), "native-head-commit");
                if (lastCommit > BigInt(native.scan_watermark)) {
                  throw new StoreError("native_cursor_conflict");
                }
              }
              if (native.identity.expected_generation !== undefined && BigInt(native.identity.expected_generation) !== generation) {
                throw new StoreError("native_cursor_conflict");
              }
            }
          } else if (native.identity.expected_generation !== undefined && native.identity.expected_generation !== "0") {
            throw new StoreError("native_cursor_conflict");
          }
        }
      }

      const scopeRow = this.database.prepare("SELECT data_epoch, privacy_epoch FROM scope WHERE scope_id = ?").get(checked.envelope.scope_id);
      if (scopeRow === undefined) throw new StoreError("scope_not_registered");
      const policyRow = this.database
        .prepare("SELECT capture_paused, capture_policy_enrolled FROM scope_policy WHERE scope_id = ?")
        .get(checked.envelope.scope_id);
      if (policyRow === undefined) throw new StoreError("schema_invalid");
      const capturePaused = sqlInteger(rowValue(policyRow, "capture_paused"), "capture_paused") === 1n;
      const capturePolicyEnrolled = sqlInteger(rowValue(policyRow, "capture_policy_enrolled"), "capture-policy-enrolled") === 1n;
      const captureClassSelection = capturePolicyEnrolled
        ? this.database
          .prepare("SELECT retention_mode, retention_seconds FROM scope_capture_policy WHERE scope_id = ? AND source_class = ?")
          .get(checked.envelope.scope_id, checked.envelope.event.evidence_class)
        : undefined;
      const captureClassAllowed = !capturePolicyEnrolled || captureClassSelection !== undefined;
      const replayMarkerByCaptureId = this.database
        .prepare("SELECT scope_id, reason FROM capture_replay_marker WHERE capture_id = ?")
        .get(checked.envelope.capture_id);
      const nativeReplayMarker = native === undefined || nativeKey === undefined
        ? undefined
        : this.database
          .prepare(
            `SELECT scope_id, reason FROM capture_replay_marker
              WHERE scope_id = ? AND native_binding_id = ? AND native_session_id = ?
                AND native_identity_kind = ? AND native_identity_key = ?`,
          )
          .get(
            checked.envelope.scope_id,
            native.binding_id,
            native.identity.kind === "event" ? checked.envelope.origin.host_session_id : native.identity.session_id,
            native.identity.kind,
            nativeKey,
          );
      const replayMarker = replayMarkerByCaptureId ?? nativeReplayMarker;
      const replayIdentity = native === undefined || nativeKey === undefined
        ? { native_binding_id: null, native_session_id: null, native_identity_kind: null, native_identity_key: null }
        : {
            native_binding_id: native.binding_id,
            native_session_id: native.identity.kind === "event" ? checked.envelope.origin.host_session_id : native.identity.session_id,
            native_identity_kind: native.identity.kind,
            native_identity_key: nativeKey,
          };
      const purgeMarker = this.database
        .prepare("SELECT scope_id FROM purge_tombstone WHERE capture_id = ?")
        .get(checked.envelope.capture_id);
      if (purgeMarker !== undefined) {
        throw new StoreError("capture_rejected");
      }
      const existing = this.database
        .prepare("SELECT scope_id, fingerprint, commit_seq, coverage_json FROM source_event WHERE capture_id = ?")
        .get(checked.envelope.capture_id);
      if (existing !== undefined) {
        if (native !== undefined) {
          const nativeReceipt = this.database
            .prepare("SELECT 1 AS present FROM opencode_observation_receipt WHERE scope_id = ? AND binding_id = ? AND capture_id = ?")
            .get(checked.envelope.scope_id, native.binding_id, checked.envelope.capture_id);
          if (nativeReceipt === undefined) throw new StoreError("native_observation_conflict");
        }
        if (sqlText(rowValue(existing, "scope_id"), "source_scope") !== checked.envelope.scope_id) {
          throw new StoreError("capture_conflict");
        }
        const existingFingerprint = sqlText(rowValue(existing, "fingerprint"), "fingerprint");
        if (existingFingerprint !== checked.fingerprint) throw new StoreError("capture_conflict");
        if (this.extractionEnabled) {
          const existingJob = this.database
            .prepare("SELECT job_id FROM job WHERE source_capture_id = ? AND task_kind = 'extract'")
            .get(checked.envelope.capture_id);
          if (existingJob === undefined) throw new StoreError("capture_invariant");
        }
        const duplicateAck = parseCaptureAck({
          version: 1,
          capture_id: checked.envelope.capture_id,
          commit_seq: sqlInteger(rowValue(existing, "commit_seq"), "commit_seq").toString(10),
          coverage: JSON.parse(sqlText(rowValue(existing, "coverage_json"), "coverage_json")) as unknown,
        });
        if (parsedEmbedTaskVersion !== undefined && !capturePaused && captureClassAllowed) {
          this.ensureEmbedJobLocked(
            checked.envelope.scope_id,
            checked.envelope.capture_id,
            parsedEmbedTaskVersion,
            existingFingerprint,
            sqlInteger(rowValue(scopeRow, "privacy_epoch"), "scope_privacy_epoch"),
            sqlInteger(rowValue(existing, "commit_seq"), "commit_seq"),
          );
        }
        this.database.exec("COMMIT");
        transactionCommitted = true;
        return duplicateAck;
      }
      if (capturePaused) {
        if (replayMarker === undefined) {
          this.database
            .prepare(
              `INSERT OR IGNORE INTO capture_replay_marker
                (capture_id, scope_id, reason, native_binding_id, native_session_id, native_identity_kind, native_identity_key, rejected_at)
               VALUES (?, ?, 'capture_paused', ?, ?, ?, ?, ?)`,
            )
            .run(checked.envelope.capture_id, checked.envelope.scope_id, replayIdentity.native_binding_id, replayIdentity.native_session_id, replayIdentity.native_identity_kind, replayIdentity.native_identity_key, parseContract(z.iso.datetime({ offset: true }), this.wallClockNow(), "capture-rejected-at"));
        }
        this.database.exec("COMMIT");
        transactionCommitted = true;
        throw new StoreError("capture_paused");
      }
      if (replayMarker !== undefined) {
        throw new StoreError("capture_rejected");
      }
      if (!captureClassAllowed) {
        this.database
          .prepare(
            `INSERT OR IGNORE INTO capture_replay_marker
              (capture_id, scope_id, reason, native_binding_id, native_session_id, native_identity_kind, native_identity_key, rejected_at)
             VALUES (?, ?, 'capture_class_excluded', ?, ?, ?, ?, ?)`,
          )
          .run(checked.envelope.capture_id, checked.envelope.scope_id, replayIdentity.native_binding_id, replayIdentity.native_session_id, replayIdentity.native_identity_kind, replayIdentity.native_identity_key, parseContract(z.iso.datetime({ offset: true }), this.wallClockNow(), "capture-rejected-at"));
        this.database.exec("COMMIT");
        transactionCommitted = true;
        throw new StoreError("capture_rejected");
      }
      const sessionRow = this.database
        .prepare(
          `SELECT session_id FROM session
           WHERE scope_id = ? AND host_kind = ? AND surface = ?
             AND execution_domain_kind = ? AND execution_domain_id = ?
             AND host_instance_id = ? AND host_session_id = ?`,
        )
        .get(
          checked.envelope.scope_id,
          checked.envelope.origin.host_kind,
          checked.envelope.origin.surface,
          checked.envelope.origin.execution_domain.kind,
          checked.envelope.origin.execution_domain.id,
          checked.envelope.origin.host_instance_id,
          checked.envelope.origin.host_session_id,
        );
      if (sessionRow === undefined) throw new StoreError("session_not_registered");
      const sessionId = sqlText(rowValue(sessionRow, "session_id"), "session_id");

      const counterRow = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
      if (counterRow === undefined) throw new StoreError("capture_invariant");
      const currentCommitSeq = sqlInteger(rowValue(counterRow, "commit_seq"), "commit_seq");
      const currentDataEpoch = sqlInteger(rowValue(counterRow, "data_epoch"), "data_epoch");
      const currentScopeEpoch = sqlInteger(rowValue(scopeRow, "data_epoch"), "scope_data_epoch");
      const currentScopePrivacyEpoch = sqlInteger(rowValue(scopeRow, "privacy_epoch"), "scope_privacy_epoch");
      const commitSeq = currentCommitSeq + 1n;
      const dataEpoch = (currentDataEpoch > currentScopeEpoch ? currentDataEpoch : currentScopeEpoch) + 1n;
      const acceptedAt = parseContract(z.iso.datetime({ offset: true }), this.wallClockNow(), "capture-accepted-at");
      const retentionSeconds = captureClassSelection === undefined || rowValue(captureClassSelection, "retention_seconds") === null ? null : sqlInteger(rowValue(captureClassSelection, "retention_seconds"), "capture-retention-seconds");
      if (retentionSeconds !== null) captureExpiryAt(acceptedAt, retentionSeconds);
      try {
        recordCommitClock(this.database, commitSeq, this.wallClock);
      } catch (error: unknown) {
        throw new StoreError("capture_invariant", error);
      }
      const event = checked.envelope.event;
      const nativeIds = event.native_ids;
      const coverage: CaptureAck["coverage"] = {
        status: checked.envelope.truncation.truncated ? "partial" : "complete",
        stages: [event.stage],
        truncated: checked.envelope.truncation.truncated,
      };

      this.database
        .prepare(
          `INSERT INTO source_event (
             capture_id, scope_id, session_id, fingerprint, adapter_version, observed_stage,
             role, evidence_class, native_session_id, native_turn_id, native_message_id,
             native_part_id, native_tool_call_id, captured_at, occurred_at, payload_json,
             event_json, truncation_json, redaction_json, coverage_json, commit_seq, data_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checked.envelope.capture_id,
          checked.envelope.scope_id,
          sessionId,
          checked.fingerprint,
          checked.envelope.adapter_version,
          event.stage,
          event.role,
          event.evidence_class,
          nativeIds.session_id ?? null,
          nativeIds.turn_id ?? null,
          nativeIds.message_id ?? null,
          nativeIds.part_id ?? null,
          nativeIds.tool_call_id ?? null,
          checked.envelope.captured_at,
          checked.envelope.occurred_at ?? null,
          JSON.stringify(checked.envelope.payload),
          JSON.stringify(event),
          JSON.stringify(checked.envelope.truncation),
          JSON.stringify(checked.envelope.redaction),
          JSON.stringify(coverage),
          commitSeq,
          dataEpoch,
        );
      this.database
        .prepare("INSERT INTO capture_acceptance (capture_id, scope_id, accepted_at, retention_seconds) VALUES (?, ?, ?, ?)")
        .run(checked.envelope.capture_id, checked.envelope.scope_id, acceptedAt, retentionSeconds);

      // The incoming fingerprint is fixed before any derived span is created.
      // Therefore this automatic event-text address cannot change replay
      // identity or make a legacy payload-root retry conflict.
      const persistedSpans: NormalizedSourceSpan[] = [...checked.source_spans];
      const eventText = "text" in event ? event.text : undefined;
      const derivedEventSpan = automaticEventSpan(checked.fingerprint, eventText, checked.source_spans);
      if (derivedEventSpan !== undefined) persistedSpans.push(derivedEventSpan);

      const spanInsert = this.database.prepare(
        `INSERT INTO source_span (span_id, source_id, scope_id, root, path, start_utf16, end_utf16, digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const searchInsert = this.database.prepare(
        `INSERT INTO search_document (
           span_id, source_id, scope_id, root, path, start_utf16, end_utf16,
           digest, text, representation, eligible, generation
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lexical', 1, ?)`,
      );
      for (const span of persistedSpans) {
        const rootValue = span.root === "event" ? event : checked.envelope.payload;
        let excerpt: string;
        try {
          excerpt = validateSpanExcerpt(
            resolveTextAtPath(rootValue, span.path),
            span.start_utf16,
            span.end_utf16,
            span.digest,
          );
        } catch (error: unknown) {
          throw new StoreError("capture_invariant", error);
        }
        spanInsert.run(
          span.span_id,
          checked.envelope.capture_id,
          checked.envelope.scope_id,
          span.root,
          span.path,
          BigInt(span.start_utf16),
          BigInt(span.end_utf16),
          span.digest,
        );
        if (excerpt.length > 0) {
          searchInsert.run(
            span.span_id,
            checked.envelope.capture_id,
            checked.envelope.scope_id,
            span.root,
            span.path,
            BigInt(span.start_utf16),
            BigInt(span.end_utf16),
            span.digest,
            excerpt,
            INITIAL_SEARCH_GENERATION,
          );
        }
      }

      if (this.extractionEnabled) {
        const taskVersion = "extract-v1";
        const dedupeKey = sha256(
          `${checked.envelope.scope_id}\u0000${checked.envelope.capture_id}\u0000extract\u0000${taskVersion}`,
        );
        this.database
          .prepare(
            `INSERT INTO job (
               job_id, scope_id, source_capture_id, task_kind, task_version, state,
               dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
               input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
               ) VALUES (?, ?, ?, 'extract', ?, 'pending_extraction', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            randomUUID(),
            checked.envelope.scope_id,
            checked.envelope.capture_id,
            taskVersion,
            dedupeKey,
            0n,
            0n,
            commitSeq,
            checked.fingerprint,
            currentScopePrivacyEpoch,
          );
      }

      if (parsedEmbedTaskVersion !== undefined) {
        this.ensureEmbedJobLocked(
          checked.envelope.scope_id,
          checked.envelope.capture_id,
          parsedEmbedTaskVersion,
          checked.fingerprint,
          currentScopePrivacyEpoch,
          commitSeq,
        );
      }

      const counterUpdate = this.database
        .prepare("UPDATE vault_counter SET commit_seq = ?, data_epoch = ? WHERE id = 1")
        .run(commitSeq, dataEpoch);
      if (sqlInteger(counterUpdate.changes, "counter_changes") !== 1n) throw new StoreError("capture_invariant");
      const scopeUpdate = this.database
        .prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?")
        .run(dataEpoch, checked.envelope.scope_id);
      if (sqlInteger(scopeUpdate.changes, "scope_changes") !== 1n) throw new StoreError("capture_invariant");

      if (native !== undefined) {
        const committedKey = nativeKey;
        if (committedKey === undefined) throw new StoreError("native_observation_conflict");
        const contentDigest = preparedCaptureContentDigest(checked);
        if (native.identity.kind === "event") {
          this.database
            .prepare(
              `INSERT INTO opencode_observation_receipt (
                 scope_id, binding_id, native_session_id, identity_kind, identity_key,
                 message_id, part_id, generation, capture_id, content_digest,
                 first_observed_at, occurred_at, commit_seq, state
               ) VALUES (?, ?, ?, 'event', ?, ?, ?, 0, ?, ?, ?, ?, ?, 'active')`,
            )
            .run(
              checked.envelope.scope_id,
              native.binding_id,
              checked.envelope.origin.host_session_id,
              committedKey,
              checked.envelope.event.native_ids.message_id ?? null,
              checked.envelope.event.native_ids.part_id ?? null,
              checked.envelope.capture_id,
              contentDigest,
              checked.envelope.captured_at,
              checked.envelope.occurred_at ?? null,
              commitSeq,
            );
        } else {
          const previous = this.database
            .prepare(
              `SELECT generation
                 FROM opencode_observation_head
                WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ? AND part_id = ?`,
            )
            .get(checked.envelope.scope_id, native.binding_id, native.identity.session_id, native.identity.message_id, native.identity.part_id);
          const generation = (previous === undefined ? 0n : sqlInteger(rowValue(previous, "generation"), "native-head-generation")) + 1n;
          this.database
            .prepare(
              `INSERT INTO opencode_observation_receipt (
                 scope_id, binding_id, native_session_id, identity_kind, identity_key,
                 message_id, part_id, generation, capture_id, content_digest,
                 first_observed_at, occurred_at, commit_seq, state
               ) VALUES (?, ?, ?, 'part_snapshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            )
            .run(
              checked.envelope.scope_id,
              native.binding_id,
              native.identity.session_id,
              committedKey,
              native.identity.message_id,
              native.identity.part_id,
              generation,
              checked.envelope.capture_id,
              contentDigest,
              checked.envelope.captured_at,
              checked.envelope.occurred_at ?? null,
              commitSeq,
            );
          if (previous === undefined) {
            this.database
              .prepare(
                `INSERT INTO opencode_observation_head (
                   scope_id, binding_id, native_session_id, message_id, part_id,
                   generation, current_capture_id, current_digest, first_observed_at,
                   last_observed_at, last_commit_seq, last_scan_id, state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
              )
              .run(
                checked.envelope.scope_id,
                native.binding_id,
                native.identity.session_id,
                native.identity.message_id,
                native.identity.part_id,
                generation,
                checked.envelope.capture_id,
                contentDigest,
                checked.envelope.captured_at,
                checked.envelope.captured_at,
                commitSeq,
                native.scan_id ?? null,
              );
          } else {
            this.database
              .prepare(
                `UPDATE opencode_observation_head
                    SET generation = ?, current_capture_id = ?, current_digest = ?,
                        last_observed_at = ?, last_commit_seq = ?, last_scan_id = ?, state = 'active'
                  WHERE scope_id = ? AND binding_id = ? AND native_session_id = ? AND message_id = ? AND part_id = ?`,
              )
              .run(
                generation,
                checked.envelope.capture_id,
                contentDigest,
                checked.envelope.captured_at,
                commitSeq,
                native.scan_id ?? null,
                checked.envelope.scope_id,
                native.binding_id,
                native.identity.session_id,
                native.identity.message_id,
                native.identity.part_id,
              );
          }
        }
      }

      this.database.exec("COMMIT");
      transactionCommitted = true;
      return parseCaptureAck({ version: 1, capture_id: checked.envelope.capture_id, commit_seq: commitSeq.toString(10), coverage });
    } catch (error: unknown) {
      if (!transactionCommitted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the first database or validation failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("capture_write_failed", error);
    }
  }

  private hasEmbeddableSourceLocked(scopeId: string, captureId: string): boolean {
    return this.database.prepare(
      `SELECT 1 AS present
         FROM search_document
        WHERE scope_id = ? AND source_id = ? AND eligible = 1 AND length(text) > 0
        LIMIT 1`,
    ).get(scopeId, captureId) !== undefined;
  }

  private ensureEmbedJobLocked(
    scopeId: string,
    captureId: string,
    taskVersion: string,
    inputFingerprint: string,
    privacyEpoch: bigint,
    createdCommitSeq: bigint,
  ): boolean {
    if (!this.hasEmbeddableSourceLocked(scopeId, captureId)) return false;
    const dedupeKey = sha256(`${scopeId}\u0000${captureId}\u0000embed\u0000${taskVersion}`);
    const inserted = this.database
      .prepare(
        `INSERT OR IGNORE INTO job (
           job_id, scope_id, source_capture_id, task_kind, task_version, state,
           dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
           input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
         ) VALUES (?, ?, ?, 'embed', ?, 'pending_extraction', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        randomUUID(),
        scopeId,
        captureId,
        taskVersion,
        dedupeKey,
        0n,
        0n,
        createdCommitSeq,
        inputFingerprint.toLowerCase(),
        privacyEpoch.toString(10),
      );
    return sqlInteger(inserted.changes, "embed-job-insert-changes") === 1n;
  }

  private ensureRevisionEmbedJobLocked(scopeId: string, revisionId: string, captureId: string): void {
    if (this.embeddingTaskVersion === undefined) return;
    const taskVersion = `${this.embeddingTaskVersion}:revision:${revisionId}`;
    const source = this.database
      .prepare(
        `SELECT e.fingerprint, e.commit_seq, s.privacy_epoch
           FROM source_event AS e JOIN scope AS s ON s.scope_id = e.scope_id
          WHERE e.scope_id = ? AND e.capture_id = ?`,
      )
      .get(scopeId, captureId);
    if (source === undefined) throw new StoreError("revision_invalid");
    this.ensureEmbedJobLocked(
      scopeId,
      captureId,
      taskVersion,
      sqlText(rowValue(source, "fingerprint"), "revision-embed-fingerprint"),
      sqlInteger(rowValue(source, "privacy_epoch"), "revision-embed-privacy"),
      sqlInteger(rowValue(source, "commit_seq"), "revision-embed-commit"),
    );
  }

  /**
   * Enqueue an embed job for a previously captured source (backfill). The
   * insert is idempotent per (scope, source, task_kind, task_version) and
   * carries the source fingerprint plus the current privacy epoch, so later
   * claim/complete fencing matches the extract path exactly.
   */
  enqueueEmbedJob(scopeId: string, captureId: string, taskVersion: string): { readonly job_id: string | null; readonly created: boolean } {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "embed-scope-id");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "embed-capture-id");
    const parsedVersion = parseContract(z.string().min(1).max(128), taskVersion, "embed-task-version");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const source = this.database
        .prepare(
          `SELECT e.fingerprint, e.commit_seq, s.privacy_epoch, t.capture_id AS tombstone_capture_id
             FROM source_event AS e
             JOIN scope AS s ON s.scope_id = e.scope_id
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
            WHERE e.scope_id = ? AND e.capture_id = ?`,
        )
        .get(parsedScopeId, parsedCaptureId);
      if (source === undefined) throw new StoreError("scope_not_registered");
      if (rowValue(source, "tombstone_capture_id") !== null) throw new StoreError("capture_rejected");
      if (!this.hasEmbeddableSourceLocked(parsedScopeId, parsedCaptureId)) {
        this.database.exec("COMMIT");
        committed = true;
        return { job_id: null, created: false };
      }
      const fingerprint = sqlText(rowValue(source, "fingerprint"), "embed-fingerprint").toLowerCase();
      const commitSeq = sqlInteger(rowValue(source, "commit_seq"), "embed-commit-seq");
      const privacyEpoch = sqlInteger(rowValue(source, "privacy_epoch"), "embed-privacy-epoch");
      const dedupeKey = sha256(`${parsedScopeId}\u0000${parsedCaptureId}\u0000embed\u0000${parsedVersion}`);
      const jobId = randomUUID();
      const inserted = this.database
        .prepare(
          `INSERT OR IGNORE INTO job (
             job_id, scope_id, source_capture_id, task_kind, task_version, state,
             dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
             input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
           ) VALUES (?, ?, ?, 'embed', ?, 'pending_extraction', ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(jobId, parsedScopeId, parsedCaptureId, parsedVersion, dedupeKey, 0n, 0n, commitSeq, fingerprint, privacyEpoch.toString(10));
      let resolvedJobId: string = jobId;
      let created = sqlInteger(inserted.changes, "embed-enqueue-changes") === 1n;
      if (!created) {
        const existingRow = this.database
          .prepare("SELECT job_id FROM job WHERE scope_id = ? AND source_capture_id = ? AND task_kind = 'embed' AND task_version = ?")
          .get(parsedScopeId, parsedCaptureId, parsedVersion);
        if (existingRow === undefined) throw new StoreError("job_write_failed");
        resolvedJobId = sqlText(rowValue(existingRow, "job_id"), "embed-job-id");
        created = false;
      }
      this.database.exec("COMMIT");
      committed = true;
      return { job_id: resolvedJobId, created };
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the enqueue failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_write_failed", error);
    }
  }

  /** Enqueue a refresh when a semantic revision is linked after capture. */
  enqueueRevisionEmbedJob(scopeId: string, captureId: string, revisionId: string, taskVersion: string): { readonly job_id: string | null; readonly created: boolean } {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "revision-embed-scope-id");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "revision-embed-capture-id");
    const parsedRevisionId = parseContract(z.uuid(), revisionId, "revision-embed-revision-id");
    const parsedVersion = parseContract(z.string().min(1).max(96), taskVersion, "revision-embed-task-version");
    const linked = this.database
      .prepare(
        `SELECT 1 AS present FROM revision_source
          WHERE scope_id = ? AND revision_id = ? AND source_capture_id = ?`,
      )
      .get(parsedScopeId, parsedRevisionId, parsedCaptureId);
    if (linked === undefined) throw new StoreError("revision_invalid");
    return this.enqueueEmbedJob(parsedScopeId, parsedCaptureId, `${parsedVersion}:revision:${parsedRevisionId}`);
  }

  ensureVectorIndexCurrent(taskVersion: string, chunkerVersion: string, updatedAt: string): VectorIndexStartupStatus {
    this.ensureOpen();
    const baseTaskVersion = parseContract(z.string().min(1).max(80), taskVersion, "vector-index-task-version");
    const targetChunkerVersion = parseContract(z.string().min(1).max(64), chunkerVersion, "vector-index-chunker-version");
    const parsedUpdatedAt = parseContract(z.iso.datetime({ offset: true }), updatedAt, "vector-index-updated-at");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const generationRow = this.database.prepare("SELECT active_generation FROM vector_generation WHERE id = 1").get();
      if (generationRow === undefined) throw new StoreError("schema_invalid");
      const activeGeneration = sqlInteger(rowValue(generationRow, "active_generation"), "vector-active-generation");
      const sourceRows = this.database.prepare(
        `SELECT DISTINCT e.scope_id, e.capture_id, e.fingerprint, e.commit_seq, s.privacy_epoch
           FROM source_event AS e
           JOIN scope AS s ON s.scope_id = e.scope_id
           JOIN search_document AS d ON d.scope_id = e.scope_id AND d.source_id = e.capture_id
           LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
          WHERE d.eligible = 1 AND d.text <> '' AND t.capture_id IS NULL
          ORDER BY e.scope_id, e.commit_seq, e.capture_id`,
      ).all();
      const sources = sourceRows.map((row) => ({
        scope_id: sqlText(rowValue(row, "scope_id"), "vector-index-scope"),
        capture_id: sqlText(rowValue(row, "capture_id"), "vector-index-capture"),
        fingerprint: sqlText(rowValue(row, "fingerprint"), "vector-index-fingerprint").toLowerCase(),
        commit_seq: sqlInteger(rowValue(row, "commit_seq"), "vector-index-commit"),
        privacy_epoch: sqlInteger(rowValue(row, "privacy_epoch"), "vector-index-privacy"),
      }));
      const sourceKey = (scopeId: string, captureId: string): string => `${scopeId}\u0000${captureId}`;
      const indexedRows = this.database.prepare(
        `SELECT DISTINCT scope_id, source_id
           FROM vector_chunk
          WHERE generation = ? AND profile_id = ? AND chunker_version = ?`,
      ).all(activeGeneration, VECTOR_PROFILE_ID, targetChunkerVersion);
      const indexed = new Set(indexedRows.map((row) => sourceKey(
        sqlText(rowValue(row, "scope_id"), "vector-index-indexed-scope"),
        sqlText(rowValue(row, "source_id"), "vector-index-indexed-source"),
      )));
      const missing = sources.filter((source) => !indexed.has(sourceKey(source.scope_id, source.capture_id)));
      const missingKeys = new Set(missing.map((source) => sourceKey(source.scope_id, source.capture_id)));
      const staleCurrentRows = this.database.prepare(
        `SELECT DISTINCT c.scope_id, c.source_id
           FROM vector_chunk AS c
           LEFT JOIN purge_tombstone AS t ON t.scope_id = c.scope_id AND t.capture_id = c.source_id
          WHERE c.generation = ? AND c.profile_id = ? AND c.chunker_version <> ? AND t.capture_id IS NULL`,
      ).all(activeGeneration, VECTOR_PROFILE_ID, targetChunkerVersion);
      const staleMissingCurrent = staleCurrentRows.some((row) => missingKeys.has(sourceKey(
        sqlText(rowValue(row, "scope_id"), "vector-index-stale-scope"),
        sqlText(rowValue(row, "source_id"), "vector-index-stale-source"),
      )));
      let targetGeneration = activeGeneration;
      if (missing.length > 0 && staleMissingCurrent) {
        targetGeneration = activeGeneration + 1n;
        const advanced = this.database
          .prepare("UPDATE vector_generation SET active_generation = ?, updated_at = ? WHERE id = 1 AND active_generation = ?")
          .run(targetGeneration, parsedUpdatedAt, activeGeneration);
        if (sqlInteger(advanced.changes, "vector-index-generation-changes") !== 1n) throw new StoreError("job_claim_conflict");
      }
      const targetTaskVersion = parseContract(
        z.string().min(1).max(128),
        `${baseTaskVersion}:chunker:${targetChunkerVersion}:generation:${targetGeneration.toString(10)}`,
        "vector-index-task-version",
      );
      const targetIndexed = targetGeneration === activeGeneration ? indexed : new Set<string>();
      const activeBaseJobs = new Set(
        this.database.prepare(
          "SELECT scope_id, source_capture_id FROM job WHERE task_kind = 'embed' AND state IN ('pending_extraction', 'running')",
        ).all().map((row) => sourceKey(
          sqlText(rowValue(row, "scope_id"), "vector-index-active-job-scope"),
          sqlText(rowValue(row, "source_capture_id"), "vector-index-active-job-source"),
        )),
      );
      let enqueuedJobs = 0;
      for (const source of sources) {
        if (targetIndexed.has(sourceKey(source.scope_id, source.capture_id))) continue;
        if (activeBaseJobs.has(sourceKey(source.scope_id, source.capture_id))) continue;
        if (this.ensureEmbedJobLocked(
          source.scope_id,
          source.capture_id,
          targetTaskVersion,
          source.fingerprint,
          source.privacy_epoch,
          source.commit_seq,
        )) enqueuedJobs += 1;
      }
      const queueRows = this.database.prepare(
        `SELECT state, COUNT(*) AS count
           FROM job
          WHERE task_kind = 'embed'
          GROUP BY state`,
      ).all();
      const counts = { pending: 0, running: 0, failed: 0, completed: 0 };
      for (const row of queueRows) {
        const state = sqlText(rowValue(row, "state"), "vector-index-state");
        const count = Number(sqlInteger(rowValue(row, "count"), "vector-index-count"));
        if (state === "pending_extraction") counts.pending += count;
        else if (state === "running") counts.running += count;
        else if (state === "failed") counts.failed += count;
        else if (state === "completed") counts.completed += count;
      }
      this.database.exec("COMMIT");
      committed = true;
      const missingSources = sources.length - targetIndexed.size;
      return {
        generation: targetGeneration.toString(10),
        task_version: targetTaskVersion,
        enqueued_jobs: enqueuedJobs,
        pending_jobs: counts.pending,
        running_jobs: counts.running,
        failed_jobs: counts.failed,
        completed_jobs: counts.completed,
        missing_sources: missingSources,
        state: missingSources === 0 ? "ready" : counts.pending + counts.running > 0 ? "pending" : counts.failed > 0 ? "failed" : "pending",
      };
    } catch (error: unknown) {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch { /* preserve first failure */ }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_write_failed", error);
    }
  }

  getEmbedJobByCaptureId(captureId: string, taskVersion?: string): StoredJob | undefined {
    this.ensureOpen();
    const parsedCaptureId = parseContract(z.uuid(), captureId, "embed-capture-id");
    const row =
      taskVersion === undefined
        ? this.database
            .prepare(
              `SELECT job_id, scope_id, source_capture_id, state, dedupe_key, next_at
                 FROM job WHERE source_capture_id = ? AND task_kind = 'embed' ORDER BY rowid LIMIT 1`,
            )
            .get(parsedCaptureId)
        : this.database
            .prepare(
              `SELECT job_id, scope_id, source_capture_id, state, dedupe_key, next_at
                 FROM job WHERE source_capture_id = ? AND task_kind = 'embed' AND task_version = ?`,
            )
            .get(parsedCaptureId, parseContract(z.string().min(1).max(128), taskVersion, "embed-task-version"));
    if (row === undefined) return undefined;
    return {
      job_id: sqlText(rowValue(row, "job_id"), "job_id"),
      scope_id: sqlText(rowValue(row, "scope_id"), "scope_id"),
      source_capture_id: sqlText(rowValue(row, "source_capture_id"), "source_capture_id"),
      state: sqlText(rowValue(row, "state"), "state"),
      dedupe_key: sqlText(rowValue(row, "dedupe_key"), "dedupe_key"),
      next_at: (() => {
        const value = rowValue(row, "next_at");
        if (value === null) return null;
        return sqlText(value, "next_at");
      })(),
    };
  }

  /** Read the exact source spans an embed worker may project. */
  getVectorProjectionSource(scopeId: string, captureId: string): VectorProjectionSource {
    this.ensureOpen();
    const parsedScopeId = parseContract(z.uuid(), scopeId, "vector-source-scope");
    const parsedCaptureId = parseContract(z.uuid(), captureId, "vector-source-capture");
    const row = this.database
      .prepare(
        `SELECT e.scope_id, e.capture_id, e.fingerprint, e.payload_json, e.event_json,
                e.commit_seq, e.captured_at, e.occurred_at, s.privacy_epoch
           FROM source_event AS e
           JOIN scope AS s ON s.scope_id = e.scope_id
          WHERE e.scope_id = ? AND e.capture_id = ?`,
      )
      .get(parsedScopeId, parsedCaptureId);
    if (row === undefined) throw new StoreError("job_not_found");
    const payload = JSON.parse(sqlText(rowValue(row, "payload_json"), "vector-source-payload")) as unknown;
    const event = JSON.parse(sqlText(rowValue(row, "event_json"), "vector-source-event")) as unknown;
    const spans = this.database
      .prepare(
        `SELECT span_id, root, path, start_utf16, end_utf16, digest
           FROM source_span WHERE scope_id = ? AND source_id = ? ORDER BY rowid`,
      )
      .all(parsedScopeId, parsedCaptureId)
      .map((spanRow): VectorProjectionSourceSpan => {
        const root = sourceSpanRoot(rowValue(spanRow, "root"), "vector-source-root");
        const path = sqlText(rowValue(spanRow, "path"), "vector-source-path");
        const start = safeSpanOffset(rowValue(spanRow, "start_utf16"), "vector-source-start");
        const end = safeSpanOffset(rowValue(spanRow, "end_utf16"), "vector-source-end");
        const digest = sqlText(rowValue(spanRow, "digest"), "vector-source-digest").toLowerCase();
        let text: string;
        try {
          text = validateSpanExcerpt(resolveTextAtPath(root === "event" ? event : payload, path), start, end, digest);
        } catch (error: unknown) {
          throw new StoreError("job_invalid", error);
        }
        const revisionRows = this.database
          .prepare(
            `SELECT revision_id FROM revision_source
              WHERE scope_id = ? AND source_capture_id = ? AND source_span_id = ?
              ORDER BY revision_id`,
          )
          .all(parsedScopeId, parsedCaptureId, sqlText(rowValue(spanRow, "span_id"), "vector-source-span"));
        return {
          span_id: sqlText(rowValue(spanRow, "span_id"), "vector-source-span"),
          root,
          path,
          start_utf16: start,
          end_utf16: end,
          digest,
          text,
          revision_ids: revisionRows.map((revisionRow) => sqlText(rowValue(revisionRow, "revision_id"), "vector-source-revision")),
        };
      });
    return {
      scope_id: sqlText(rowValue(row, "scope_id"), "vector-source-scope"),
      source_id: sqlText(rowValue(row, "capture_id"), "vector-source-capture"),
      input_fingerprint: sqlText(rowValue(row, "fingerprint"), "vector-source-fingerprint").toLowerCase(),
      input_privacy_epoch: sqlInteger(rowValue(row, "privacy_epoch"), "vector-source-privacy").toString(10),
      commit_seq: sqlInteger(rowValue(row, "commit_seq"), "vector-source-commit").toString(10),
      captured_at: sqlText(rowValue(row, "captured_at"), "vector-source-captured"),
      occurred_at: nullableSqlText(rowValue(row, "occurred_at"), "vector-source-occurred"),
      spans,
    };
  }

  getActiveVectorGeneration(): string {
    this.ensureOpen();
    const row = this.database.prepare("SELECT active_generation FROM vector_generation WHERE id = 1").get();
    if (row === undefined) throw new StoreError("schema_invalid");
    const generation = sqlInteger(rowValue(row, "active_generation"), "active_generation");
    if (generation < 1n) throw new StoreError("schema_invalid");
    return generation.toString(10);
  }

  private ensureVectorVec0Index(): void {
    if (this.vectorQualification === undefined) return;
    this.database.exec("CREATE VIRTUAL TABLE IF NOT EXISTS vector_embedding_vec USING vec0(embedding float[384]);");
    this.database.exec("DELETE FROM vector_embedding_vec");
    const rows = this.database
      .prepare(
        `SELECT c.rowid AS vector_rowid, v.vector_blob
           FROM vector_chunk AS c JOIN vector_embedding AS v ON v.chunk_id = c.chunk_id
          WHERE v.generation = c.generation`,
      )
      .all();
    const insert = this.database.prepare("INSERT OR REPLACE INTO vector_embedding_vec(rowid, embedding) VALUES (?, ?)");
    for (const row of rows) {
      const blob = rowValue(row, "vector_blob");
      if (!(blob instanceof Uint8Array) || blob.byteLength !== VECTOR_BLOB_BYTES) throw new StoreError("schema_invalid");
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      const values = Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => view.getFloat32(index * 4, true));
      insert.run(sqlInteger(rowValue(row, "vector_rowid"), "vector-rowid"), JSON.stringify(values));
    }
  }

  /**
   * Atomically switch the active vector generation after a reindex built the
   * next generation. CAS on the expected value; returns the new generation
   * or undefined when another worker already switched.
   */
  activateVectorGeneration(expectedActive: string, updatedAt: string): string | undefined {
    this.ensureOpen();
    const expected = parseContract(nonNegativeInt64Schema, expectedActive, "vector-expected-generation");
    const parsedAt = parseContract(z.iso.datetime({ offset: true }), updatedAt, "vector-generation-updated-at");
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const current = this.database.prepare("SELECT active_generation FROM vector_generation WHERE id = 1").get();
      if (current === undefined) throw new StoreError("schema_invalid");
      if (sqlInteger(rowValue(current, "active_generation"), "active_generation").toString(10) !== expected) {
        this.database.exec("ROLLBACK");
        committed = true;
        return undefined;
      }
      const next = BigInt(expected) + 1n;
      const updated = this.database
        .prepare("UPDATE vector_generation SET active_generation = ?, updated_at = ? WHERE id = 1 AND active_generation = ?")
        .run(next, parsedAt, BigInt(expected));
      if (sqlInteger(updated.changes, "vector-generation-changes") !== 1n) {
        this.database.exec("ROLLBACK");
        committed = true;
        return undefined;
      }
      this.database.exec("COMMIT");
      committed = true;
      return next.toString(10);
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the generation failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("read_failed", error);
    }
  }

  /**
   * Exact vector recall over already-authorized relational rows (scalar cosine
   * fallback). Scope, output grant, eligibility, generation, purge tombstone
   * and known_at bounds are applied in SQL BEFORE any ordering or limit; the
   * limit truncates only the distance-sorted authorized set. No vec0 norms or
   * extension state are consulted here, so there is no global-nearest-then-
   * filter path: forbidden rows never enter the distance computation.
   */
  searchVectorCandidates(
    input: unknown,
    binding: TrustedBinding,
    queryVector: Float32Array,
    options: VectorSearchStoreOptions,
  ): VectorCandidateRow[] {
    this.ensureOpen();
    const request = validateBoundRecallRequest(input, binding);
    if (typeof options !== "object" || options === null) throw new StoreError("read_failed");
    const limit = (options as VectorSearchStoreOptions).limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > VECTOR_MAX_RESULTS) {
      throw new StoreError("read_failed", new Error("vector_limit_invalid"));
    }
    if (!(queryVector instanceof Float32Array) || queryVector.length !== VECTOR_DIMENSIONS) {
      throw new StoreError("read_failed", new Error("vector_query_invalid"));
    }
    let queryNorm = 0;
    for (let index = 0; index < queryVector.length; index += 1) {
      const value = queryVector[index] as number;
      if (!Number.isFinite(value)) throw new StoreError("read_failed", new Error("vector_query_invalid"));
      queryNorm += value * value;
    }
    if (!(queryNorm > 0) || !Number.isFinite(queryNorm)) {
      throw new StoreError("read_failed", new Error("vector_query_invalid"));
    }
    const activeGeneration = this.getActiveVectorGeneration();
    const generation =
      (options as VectorSearchStoreOptions).generation === undefined
        ? activeGeneration
        : parseContract(nonNegativeInt64Schema, (options as VectorSearchStoreOptions).generation as string, "vector-generation");
    if (BigInt(generation) < 1n) throw new StoreError("read_failed", new Error("vector_generation_invalid"));
    const profileId =
      (options as VectorSearchStoreOptions).profile_id === undefined
        ? VECTOR_PROFILE_ID
        : parseContract(z.string().min(1).max(128), (options as VectorSearchStoreOptions).profile_id as string, "vector-profile-id");
    const chunkerVersion =
      (options as VectorSearchStoreOptions).chunker_version === undefined
        ? undefined
        : parseContract(z.string().min(1).max(128), (options as VectorSearchStoreOptions).chunker_version as string, "vector-chunker-version");
    const scopeIds = [...new Set(request.scope_ids)];
    const registeredScopes = this.database
      .prepare(`SELECT COUNT(*) AS count FROM scope WHERE scope_id IN (${scopeIds.map(() => "?").join(", ")})`)
      .get(...scopeIds);
    if (registeredScopes === undefined || sqlInteger(rowValue(registeredScopes, "count"), "scope_count") !== BigInt(scopeIds.length)) {
      throw new StoreError("scope_not_registered");
    }
    const excluded =
      (options as VectorSearchStoreOptions).excluded_capture_id === undefined
        ? undefined
        : parseContract(z.uuid(), (options as VectorSearchStoreOptions).excluded_capture_id as string, "excluded-capture-id");
    const conditions = [
      `c.scope_id IN (${scopeIds.map(() => "?").join(", ")})`,
      "c.eligible = 1",
      "c.generation = ?",
      "c.profile_id = ?",
      "e.scope_id = c.scope_id",
      "g.output_target = ?",
      "t.capture_id IS NULL",
      recallSourceEligibility,
    ];
    const parameters: Array<string | bigint> = [...scopeIds, BigInt(generation), profileId, readerOutputTarget(binding)];
    if (chunkerVersion !== undefined) {
      conditions.push("c.chunker_version = ?");
      parameters.push(chunkerVersion);
    }
    if (excluded !== undefined) {
      conditions.push("e.capture_id <> ?");
      parameters.push(excluded);
    }
    if (options.exclude_current_session_prompts === true) {
      conditions.push(currentSessionPromptExclusion);
      parameters.push(
        binding.host_kind,
        binding.surface,
        binding.execution_domain.kind,
        binding.execution_domain.id,
        binding.host_instance_id,
        binding.host_session_id,
      );
    }
    if (request.known_at_seq !== undefined) {
      conditions.push("e.commit_seq <= ?");
      parameters.push(BigInt(request.known_at_seq));
      conditions.push("(c.revision_id IS NULL OR EXISTS (SELECT 1 FROM memory_revision AS mr WHERE mr.scope_id = c.scope_id AND mr.revision_id = c.revision_id AND mr.created_commit_seq <= ?))");
      parameters.push(BigInt(request.known_at_seq));
    }
    if (request.valid_at !== undefined) {
      const knownAt = request.known_at_seq === undefined ? MAX_INT64 : BigInt(request.known_at_seq);
      conditions.push(
        `c.revision_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM state_segment AS ss
            WHERE ss.scope_id = c.scope_id AND ss.value_revision_id = c.revision_id
              AND ss.status IN ('definite', 'possible')
              AND (ss.valid_from IS NULL OR ss.valid_from <= ?)
              AND (ss.valid_to IS NULL OR ? < ss.valid_to)
              AND ss.tx_from_seq <= ?
              AND (ss.tx_to_seq IS NULL OR ? < ss.tx_to_seq)
         )`,
      );
      parameters.push(request.valid_at, request.valid_at, knownAt, knownAt);
    }
    let vecDistances: Map<bigint, number> | undefined;
    if (this.vectorQualification !== undefined) {
      const authorized = this.database
        .prepare(
          `SELECT rowid, distance
             FROM vector_embedding_vec
            WHERE embedding MATCH ? AND k = ?
              AND rowid IN (
                SELECT c.rowid
                  FROM vector_chunk AS c
                  JOIN source_event AS e ON e.capture_id = c.source_id AND e.scope_id = c.scope_id
                  JOIN scope_output_grant AS g ON g.scope_id = c.scope_id AND g.source_class = e.evidence_class
                  LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
                 WHERE ${conditions.join(" AND ")}
              )
            ORDER BY distance
            `,
        )
        .all(JSON.stringify(Array.from(queryVector)), limit, ...parameters) as readonly Record<string, unknown>[];
      vecDistances = new Map(authorized.map((row) => [sqlInteger(rowValue(row, "rowid"), "vector-rowid"), Number(rowValue(row, "distance"))]));
      if (vecDistances.size === 0) return [];
      conditions.push(`c.rowid IN (${[...vecDistances.keys()].map(() => "?").join(", ")})`);
      parameters.push(...vecDistances.keys());
    }
    const rows = this.database
      .prepare(
        `SELECT
           c.chunk_id AS chunk_id,
           c.scope_id AS chunk_scope_id,
           c.source_id AS chunk_source_id,
           c.rowid AS vector_rowid,
           c.revision_id AS chunk_revision_id,
           c.chunk_index AS chunk_index,
           c.text AS chunk_text,
           c.input_digest AS chunk_input_digest,
           c.profile_id AS chunk_profile_id,
           c.tokenizer_version AS chunk_tokenizer_version,
           c.generation AS chunk_generation,
           c.eligible AS chunk_eligible,
           c.created_commit_seq AS chunk_created_commit_seq,
           c.chunker_version AS chunk_chunker_version,
           s.root AS chunk_root,
           s.path AS chunk_path,
           s.start_utf16 AS chunk_start_utf16,
           s.end_utf16 AS chunk_end_utf16,
           v.source_digest AS chunk_digest,
           v.vector_blob AS embedding_blob,
           v.dim AS embedding_dim,
           s.span_id AS document_span_id,
           c.source_id AS document_source_id,
           s.span_id AS source_span_id,
           s.scope_id AS source_scope_id,
           s.root AS source_root,
           s.path AS source_path,
           s.start_utf16 AS source_start_utf16,
           s.end_utf16 AS source_end_utf16,
           s.digest AS source_digest,
           e.capture_id AS source_id,
           e.scope_id AS source_scope,
           e.captured_at AS captured_at,
           e.occurred_at AS occurred_at,
           e.payload_json AS payload_json,
           e.event_json AS event_json,
           e.commit_seq AS commit_seq,
           e.data_epoch AS data_epoch
          FROM vector_chunk AS c
          JOIN vector_embedding AS v ON v.chunk_id = c.chunk_id
          JOIN source_span AS s ON s.source_id = c.source_id AND s.span_id = c.span_id
          JOIN source_event AS e ON e.capture_id = c.source_id AND e.scope_id = c.scope_id
          JOIN scope AS sc ON sc.scope_id = c.scope_id
          JOIN scope_output_grant AS g ON g.scope_id = c.scope_id AND g.source_class = e.evidence_class
          LEFT JOIN purge_tombstone AS t ON t.scope_id = e.scope_id AND t.capture_id = e.capture_id
         WHERE ${conditions.join(" AND ")}
           AND v.scope_id = c.scope_id
           AND v.profile_id = c.profile_id
           AND v.generation = c.generation
         ORDER BY c.scope_id, c.source_id, c.span_id, c.chunk_index, c.chunk_id`,
      )
        .all(...parameters);
    const rankedRows: Array<{ readonly row: (typeof rows)[number]; readonly distance: number }> = [];
    for (const row of rows) {
      const blob = rowValue(row, "embedding_blob");
      if (!(blob instanceof Uint8Array) || blob.byteLength !== VECTOR_BLOB_BYTES) {
        throw new StoreError("schema_invalid", new Error("vector_blob_bytes"));
      }
      if (sqlInteger(rowValue(row, "embedding_dim"), "vector_dim") !== BigInt(VECTOR_DIMENSIONS)) {
        throw new StoreError("schema_invalid", new Error("vector_dim"));
      }
      const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      let distance = vecDistances?.get(sqlInteger(rowValue(row, "vector_rowid"), "vector-rowid"));
      if (distance === undefined) {
        let dot = 0;
        let candidateNorm = 0;
        for (let index = 0; index < VECTOR_DIMENSIONS; index += 1) {
          const value = view.getFloat32(index * 4, true);
          if (!Number.isFinite(value)) throw new StoreError("schema_invalid", new Error("vector_float"));
          dot += (queryVector[index] as number) * value;
          candidateNorm += value * value;
        }
        if (!(candidateNorm > 0) || !Number.isFinite(candidateNorm)) throw new StoreError("schema_invalid", new Error("vector_norm"));
        const similarity = dot / (Math.sqrt(queryNorm) * Math.sqrt(candidateNorm));
        distance = 1 - Math.max(-1, Math.min(1, similarity));
      }
      rankedRows.push({ row, distance });
    }
    rankedRows.sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      const leftId = sqlText(rowValue(left.row, "chunk_id"), "chunk-id");
      const rightId = sqlText(rowValue(right.row, "chunk_id"), "chunk-id");
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    const shortlistedRows = rankedRows.slice(0, limit);
    const groupKey = (group: {
      readonly scope_id: string;
      readonly source_id: string;
      readonly span_id: string;
      readonly revision_id: string | null;
      readonly profile_id: string;
      readonly tokenizer_version: string;
      readonly chunker_version: string;
      readonly generation: bigint;
    }): string => JSON.stringify([
      group.scope_id,
      group.source_id,
      group.span_id,
      group.revision_id,
      group.profile_id,
      group.tokenizer_version,
      group.chunker_version,
      group.generation.toString(10),
    ]);
    const groups = new Map<string, {
      readonly scope_id: string;
      readonly source_id: string;
      readonly span_id: string;
      readonly revision_id: string | null;
      readonly profile_id: string;
      readonly tokenizer_version: string;
      readonly chunker_version: string;
      readonly generation: bigint;
    }>();
    for (const ranked of shortlistedRows) {
      const row = ranked.row;
      const group = {
        scope_id: sqlText(rowValue(row, "chunk_scope_id"), "chunk-sibling-scope"),
        source_id: sqlText(rowValue(row, "chunk_source_id"), "chunk-sibling-source"),
        span_id: sqlText(rowValue(row, "document_span_id"), "chunk-sibling-span"),
        revision_id: nullableSqlText(rowValue(row, "chunk_revision_id"), "chunk-sibling-revision"),
        profile_id: sqlText(rowValue(row, "chunk_profile_id"), "chunk-sibling-profile"),
        tokenizer_version: sqlText(rowValue(row, "chunk_tokenizer_version"), "chunk-sibling-tokenizer"),
        chunker_version: sqlText(rowValue(row, "chunk_chunker_version"), "chunk-sibling-chunker"),
        generation: sqlInteger(rowValue(row, "chunk_generation"), "chunk-sibling-generation"),
      };
      groups.set(groupKey(group), group);
    }
    const siblingGroups = new Map<string, VectorChunkSibling[]>();
    if (groups.size > 0) {
      const siblingClauses: string[] = [];
      const siblingParameters: SQLInputValue[] = [];
      for (const group of groups.values()) {
        siblingClauses.push(`(
          scope_id = ? AND source_id = ? AND span_id = ?
          AND ((revision_id IS NULL AND ? IS NULL) OR revision_id = ?)
          AND profile_id = ? AND tokenizer_version = ? AND chunker_version = ? AND generation = ?
        )`);
        siblingParameters.push(
          group.scope_id,
          group.source_id,
          group.span_id,
          group.revision_id,
          group.revision_id,
          group.profile_id,
          group.tokenizer_version,
          group.chunker_version,
          group.generation,
        );
      }
      const siblingRows = this.database.prepare(
        `SELECT scope_id, source_id, span_id, revision_id, profile_id, tokenizer_version,
                chunker_version, generation, chunk_id, chunk_index, text, sibling_ordinal
           FROM (
             SELECT scope_id, source_id, span_id, revision_id, profile_id, tokenizer_version,
                    chunker_version, generation, chunk_id, chunk_index, text,
                    ROW_NUMBER() OVER (
                      PARTITION BY scope_id, source_id, span_id, revision_id, profile_id,
                                   tokenizer_version, chunker_version, generation
                      ORDER BY chunk_index, chunk_id
                    ) AS sibling_ordinal
               FROM vector_chunk
              WHERE ${siblingClauses.join(" OR ")}
           ) AS sibling
          WHERE sibling_ordinal <= 129
          ORDER BY scope_id, source_id, span_id, revision_id, profile_id,
                   tokenizer_version, chunker_version, generation, chunk_index, chunk_id`,
      ).all(...siblingParameters);
      for (const row of siblingRows) {
        const key = groupKey({
          scope_id: sqlText(rowValue(row, "scope_id"), "chunk-sibling-scope"),
          source_id: sqlText(rowValue(row, "source_id"), "chunk-sibling-source"),
          span_id: sqlText(rowValue(row, "span_id"), "chunk-sibling-span"),
          revision_id: nullableSqlText(rowValue(row, "revision_id"), "chunk-sibling-revision"),
          profile_id: sqlText(rowValue(row, "profile_id"), "chunk-sibling-profile"),
          tokenizer_version: sqlText(rowValue(row, "tokenizer_version"), "chunk-sibling-tokenizer"),
          chunker_version: sqlText(rowValue(row, "chunker_version"), "chunk-sibling-chunker"),
          generation: sqlInteger(rowValue(row, "generation"), "chunk-sibling-generation"),
        });
        const siblings = siblingGroups.get(key) ?? [];
        siblings.push({
          chunk_id: sqlText(rowValue(row, "chunk_id"), "chunk-sibling-id"),
          chunk_index: sqlInteger(rowValue(row, "chunk_index"), "chunk-sibling-index"),
          text: sqlText(rowValue(row, "text"), "chunk-sibling-text"),
        });
        siblingGroups.set(key, siblings);
      }
    }
    const candidates: { readonly row: VectorCandidateRow; readonly distance: number }[] = [];
    for (const row of rows) {
      const blob = rowValue(row, "embedding_blob");
      if (!(blob instanceof Uint8Array) || blob.byteLength !== VECTOR_BLOB_BYTES) {
        throw new StoreError("schema_invalid", new Error("vector_blob_bytes"));
      }
      if (sqlInteger(rowValue(row, "embedding_dim"), "embedding_dim") !== BigInt(VECTOR_DIMENSIONS)) {
        throw new StoreError("schema_invalid", new Error("vector_dim"));
      }
      const view = new DataView((blob as Uint8Array).buffer, (blob as Uint8Array).byteOffset, (blob as Uint8Array).byteLength);
      let distance = vecDistances?.get(sqlInteger(rowValue(row, "vector_rowid"), "vector-rowid"));
      if (distance === undefined) {
        let dot = 0;
        let candidateNorm = 0;
        for (let index = 0; index < VECTOR_DIMENSIONS; index += 1) {
          const value = view.getFloat32(index * 4, true);
          if (!Number.isFinite(value)) throw new StoreError("schema_invalid", new Error("vector_float"));
          dot += (queryVector[index] as number) * value;
          candidateNorm += value * value;
        }
        if (!(candidateNorm > 0) || !Number.isFinite(candidateNorm)) throw new StoreError("schema_invalid", new Error("vector_norm"));
        const similarity = dot / (Math.sqrt(queryNorm) * Math.sqrt(candidateNorm));
        distance = 1 - Math.max(-1, Math.min(1, similarity));
      }
      const candidateGroupKey = groupKey({
        scope_id: sqlText(rowValue(row, "chunk_scope_id"), "chunk-sibling-scope"),
        source_id: sqlText(rowValue(row, "chunk_source_id"), "chunk-sibling-source"),
        span_id: sqlText(rowValue(row, "document_span_id"), "chunk-sibling-span"),
        revision_id: nullableSqlText(rowValue(row, "chunk_revision_id"), "chunk-sibling-revision"),
        profile_id: sqlText(rowValue(row, "chunk_profile_id"), "chunk-sibling-profile"),
        tokenizer_version: sqlText(rowValue(row, "chunk_tokenizer_version"), "chunk-sibling-tokenizer"),
        chunker_version: sqlText(rowValue(row, "chunk_chunker_version"), "chunk-sibling-chunker"),
        generation: sqlInteger(rowValue(row, "chunk_generation"), "chunk-sibling-generation"),
      });
      const candidate: VectorCandidateRow = {
        chunk_id: sqlText(rowValue(row, "chunk_id"), "chunk_id"),
        chunk_scope_id: sqlText(rowValue(row, "chunk_scope_id"), "chunk_scope_id"),
        chunk_source_id: sqlText(rowValue(row, "chunk_source_id"), "chunk_source_id"),
        chunk_revision_id: nullableSqlText(rowValue(row, "chunk_revision_id"), "chunk_revision_id"),
        chunk_index: sqlInteger(rowValue(row, "chunk_index"), "chunk_index"),
        chunk_text: sqlText(rowValue(row, "chunk_text"), "chunk_text"),
        chunk_input_digest: sqlText(rowValue(row, "chunk_input_digest"), "chunk_input_digest"),
        chunk_profile_id: sqlText(rowValue(row, "chunk_profile_id"), "chunk_profile_id"),
        chunk_tokenizer_version: sqlText(rowValue(row, "chunk_tokenizer_version"), "chunk_tokenizer_version"),
        chunk_generation: sqlInteger(rowValue(row, "chunk_generation"), "chunk_generation"),
        chunk_eligible: sqlInteger(rowValue(row, "chunk_eligible"), "chunk_eligible"),
        chunk_created_commit_seq: sqlInteger(rowValue(row, "chunk_created_commit_seq"), "chunk_created_commit_seq"),
        chunk_chunker_version: sqlText(rowValue(row, "chunk_chunker_version"), "chunk_chunker_version"),
        chunk_siblings: siblingGroups.get(candidateGroupKey) ?? [],
        chunk_root: sourceSpanRoot(rowValue(row, "chunk_root"), "chunk_root"),
        chunk_path: sqlText(rowValue(row, "chunk_path"), "chunk_path"),
        chunk_start_utf16: sqlInteger(rowValue(row, "chunk_start_utf16"), "chunk_start_utf16"),
        chunk_end_utf16: sqlInteger(rowValue(row, "chunk_end_utf16"), "chunk_end_utf16"),
        chunk_digest: sqlText(rowValue(row, "chunk_digest"), "chunk_digest"),
        embedding_blob: blob as Uint8Array,
        embedding_dim: sqlInteger(rowValue(row, "embedding_dim"), "embedding_dim"),
        document_span_id: sqlText(rowValue(row, "document_span_id"), "document_span_id"),
        document_source_id: sqlText(rowValue(row, "document_source_id"), "document_source_id"),
        source_span_id: nullableSqlText(rowValue(row, "source_span_id"), "source_span_id"),
        source_scope_id: nullableSqlText(rowValue(row, "source_scope_id"), "source_scope_id"),
        source_root: nullableSourceSpanRoot(rowValue(row, "source_root"), "source_root"),
        source_path: nullableSqlText(rowValue(row, "source_path"), "source_path"),
        source_start_utf16: nullableSqlInteger(rowValue(row, "source_start_utf16"), "source_start_utf16"),
        source_end_utf16: nullableSqlInteger(rowValue(row, "source_end_utf16"), "source_end_utf16"),
        source_digest: nullableSqlText(rowValue(row, "source_digest"), "source_digest"),
        source_id: sqlText(rowValue(row, "source_id"), "source_id"),
        source_scope: sqlText(rowValue(row, "source_scope"), "source_scope"),
        captured_at: sqlText(rowValue(row, "captured_at"), "captured_at"),
        occurred_at: nullableSqlText(rowValue(row, "occurred_at"), "occurred_at"),
        payload_json: sqlText(rowValue(row, "payload_json"), "payload_json"),
        event_json: sqlText(rowValue(row, "event_json"), "event_json"),
        commit_seq: sqlInteger(rowValue(row, "commit_seq"), "commit_seq"),
        data_epoch: sqlInteger(rowValue(row, "data_epoch"), "data_epoch"),
        distance,
      };
      candidates.push({ row: candidate, distance });
    }
    candidates.sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.row.chunk_id < right.row.chunk_id ? -1 : left.row.chunk_id > right.row.chunk_id ? 1 : 0;
    });
    return candidates.slice(0, limit).map((entry) => entry.row);
  }

  /**
   * Atomically project one claimed embed job: revalidate owner, lease, fence,
   * input revisions, privacy epoch, purge tombstone and vector generation,
   * insert the bound chunks plus embedding blobs, bump the search-visible
   * data epoch, and record the completion receipt in a single transaction.
   * A crash anywhere before COMMIT rolls back both the vectors and the job.
   */
  completeVectorProjection(
    claim: {
      readonly job_id: string;
      readonly scope_id: string;
      readonly source_capture_id: string;
      readonly task_kind: string;
      readonly task_version: string;
      readonly owner: string;
      readonly lease_until: string;
      readonly fence: string;
      readonly attempts: number;
      readonly input_fingerprint: string;
      readonly input_privacy_epoch: string;
    },
    projections: readonly VectorChunkProjection[],
    resultDigest: string,
  ): { readonly status: "completed" | "already_completed" | "rejected"; readonly reason?: string; readonly receipt?: Record<string, unknown> } {
    this.ensureOpen();
    if (typeof claim !== "object" || claim === null) throw new StoreError("job_invalid");
    let checked: {
      readonly job_id: string;
      readonly scope_id: string;
      readonly source_capture_id: string;
      readonly task_kind: "embed";
      readonly task_version: string;
      readonly owner: string;
      readonly lease_until: string;
      readonly fence: string;
      readonly attempts: number;
      readonly input_fingerprint: string;
      readonly input_privacy_epoch: string;
    };
    try {
      checked = {
        job_id: parseContract(z.uuid(), claim.job_id, "vector-claim-id"),
        scope_id: parseContract(z.uuid(), claim.scope_id, "vector-claim-scope"),
        source_capture_id: parseContract(z.uuid(), claim.source_capture_id, "vector-claim-source"),
        task_kind: parseContract(z.enum(["embed"]), claim.task_kind, "vector-claim-kind"),
        task_version: parseContract(z.string().min(1).max(128), claim.task_version, "vector-claim-version"),
        owner: parseContract(z.string().min(1).max(256), claim.owner, "vector-claim-owner"),
        lease_until: parseContract(z.iso.datetime({ offset: true }), claim.lease_until, "vector-claim-lease"),
        fence: parseContract(nonNegativeInt64Schema, claim.fence, "vector-claim-fence"),
        attempts: z.number().int().min(1).max(5).parse(claim.attempts),
        input_fingerprint: parseContract(z.string().regex(/^[a-f0-9]{64}$/i), claim.input_fingerprint, "vector-claim-fingerprint").toLowerCase(),
        input_privacy_epoch: parseContract(nonNegativeInt64Schema, claim.input_privacy_epoch, "vector-claim-privacy"),
      };
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_invalid", error);
    }
    let digest: string;
    try {
      digest = parseContract(z.string().regex(/^[a-f0-9]{64}$/i), resultDigest, "vector-result-digest").toLowerCase();
    } catch (error: unknown) {
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_invalid", error);
    }
    if (!Array.isArray(projections) || projections.length === 0 || projections.length > 128) {
      throw new StoreError("job_invalid", new Error("vector_projection_batch"));
    }
    const projectionDigest = vectorProjectionReceiptDigest(projections);
    this.database.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const nowRow = this.database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get();
      const parsedNow = sqlText(rowValue(nowRow, "now"), "sqlite-clock-now");
      const jobRow = this.database
        .prepare(
          `SELECT job_id, scope_id, source_capture_id, task_kind, task_version, state, owner,
                  lease_until, fence, attempts, created_commit_seq,
                  input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
             FROM job WHERE job_id = ?`,
        )
        .get(checked.job_id);
      if (jobRow === undefined) throw new StoreError("job_not_found");
      const currentState = sqlText(rowValue(jobRow, "state"), "vector-job-state");
      if (currentState === "completed") {
        const stored = rowValue(jobRow, "completion_receipt_json");
        if (stored === null) return this.rollbackVectorProjection("claim_invalid", "completed");
        let receipt: Record<string, unknown>;
        try {
          receipt = JSON.parse(sqlText(stored, "completion_receipt_json")) as Record<string, unknown>;
        } catch {
          throw new StoreError("job_write_failed");
        }
        if (
          receipt["job_id"] !== checked.job_id ||
          receipt["owner"] !== checked.owner ||
          receipt["fence"] !== checked.fence ||
          (receipt["result_digest"] as string)?.toLowerCase() !== digest ||
          receipt["projection_digest"] !== projectionDigest
        ) {
          return this.rollbackVectorProjection("claim_invalid", "completed");
        }
        this.database.exec("ROLLBACK");
        committed = true;
        return { status: "already_completed", receipt };
      }
      const matches =
        sqlText(rowValue(jobRow, "scope_id"), "vector-job-scope") === checked.scope_id &&
        sqlText(rowValue(jobRow, "source_capture_id"), "vector-job-source") === checked.source_capture_id &&
        sqlText(rowValue(jobRow, "task_kind"), "vector-job-kind") === "embed" &&
        sqlText(rowValue(jobRow, "task_version"), "vector-job-version") === checked.task_version &&
        ((): boolean => {
          const owner = rowValue(jobRow, "owner");
          return owner !== null && sqlText(owner, "vector-job-owner") === checked.owner;
        })() &&
        ((): boolean => {
          const lease = rowValue(jobRow, "lease_until");
          return lease !== null && sqlText(lease, "vector-job-lease") === checked.lease_until;
        })() &&
        sqlInteger(rowValue(jobRow, "fence"), "vector-job-fence").toString(10) === checked.fence &&
        Number(sqlInteger(rowValue(jobRow, "attempts"), "vector-job-attempts")) === checked.attempts &&
        sqlText(rowValue(jobRow, "input_fingerprint"), "vector-job-fingerprint").toLowerCase() === checked.input_fingerprint &&
        sqlText(rowValue(jobRow, "input_privacy_epoch"), "vector-job-privacy") === checked.input_privacy_epoch;
      if (!matches || currentState !== "running") {
        return this.rollbackVectorProjection("claim_invalid", currentState);
      }
      if (!(Date.parse(checked.lease_until) > Date.parse(parsedNow))) {
        return this.rollbackVectorProjection("lease_expired", currentState);
      }
      const source = this.database
        .prepare(
          `SELECT e.fingerprint, e.payload_json, e.event_json, s.privacy_epoch,
                  t.capture_id AS tombstone_capture_id
             FROM scope AS s
             LEFT JOIN source_event AS e
               ON e.scope_id = s.scope_id AND e.capture_id = ?
             LEFT JOIN purge_tombstone AS t
               ON t.scope_id = s.scope_id AND t.capture_id = ?
            WHERE s.scope_id = ?`,
        )
        .get(checked.source_capture_id, checked.source_capture_id, checked.scope_id);
      if (source === undefined || rowValue(source, "fingerprint") === null || rowValue(source, "tombstone_capture_id") !== null) {
        this.pauseVectorJobLocked(checked.job_id, checked.owner, checked.fence, checked.lease_until, parsedNow, "source_purged");
        this.database.exec("COMMIT");
        committed = true;
        return { status: "rejected", reason: "source_purged" };
      }
      if (sqlText(rowValue(source, "fingerprint"), "vector-source-fingerprint").toLowerCase() !== checked.input_fingerprint) {
        this.pauseVectorJobLocked(checked.job_id, checked.owner, checked.fence, checked.lease_until, parsedNow, "source_purged");
        this.database.exec("COMMIT");
        committed = true;
        return { status: "rejected", reason: "source_changed" };
      }
      if (sqlInteger(rowValue(source, "privacy_epoch"), "vector-source-privacy").toString(10) !== checked.input_privacy_epoch) {
        this.pauseVectorJobLocked(checked.job_id, checked.owner, checked.fence, checked.lease_until, parsedNow, "policy_changed");
        this.database.exec("COMMIT");
        committed = true;
        return { status: "rejected", reason: "policy_changed" };
      }
      const generationRow = this.database.prepare("SELECT active_generation FROM vector_generation WHERE id = 1").get();
      if (generationRow === undefined) throw new StoreError("schema_invalid");
      const activeGeneration = sqlInteger(rowValue(generationRow, "active_generation"), "active_generation");
      const payload = JSON.parse(sqlText(rowValue(source, "payload_json"), "payload_json")) as Record<string, unknown>;
      const event = JSON.parse(sqlText(rowValue(source, "event_json"), "event_json")) as Record<string, unknown>;
      const chunkInsert = this.database.prepare(
        `INSERT INTO vector_chunk (
           chunk_id, scope_id, source_id, span_id, revision_id, chunk_index, text,
           input_digest, profile_id, tokenizer_version, chunker_version,
           generation, eligible, created_commit_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      );
      const embeddingInsert = this.database.prepare(
        `INSERT INTO vector_embedding (
           chunk_id, scope_id, profile_id, dim, dtype, vector_blob, source_digest, generation
         ) VALUES (?, ?, ?, 384, 'f32', ?, ?, ?)`,
      );
      const spanSelect = this.database.prepare(
        `SELECT root, path, start_utf16, end_utf16, digest FROM source_span WHERE source_id = ? AND span_id = ?`,
      );
      const seenChunkIds = new Set<string>();
      for (const projection of projections) {
        const chunkId = parseContract(z.uuid(), projection.chunk_id, "vector-chunk-id");
        if (seenChunkIds.has(chunkId)) throw new StoreError("job_invalid", new Error("vector_chunk_duplicate"));
        seenChunkIds.add(chunkId);
        if (projection.scope_id !== checked.scope_id) throw new StoreError("job_invalid", new Error("vector_chunk_scope"));
        if (projection.source_id !== checked.source_capture_id) throw new StoreError("job_invalid", new Error("vector_chunk_source"));
        const spanId = parseContract(z.uuid(), projection.span_id, "vector-chunk-span");
        if (!Number.isSafeInteger(projection.chunk_index) || projection.chunk_index < 0) {
          throw new StoreError("job_invalid", new Error("vector_chunk_index"));
        }
        if (typeof projection.text !== "string" || projection.text.length === 0) {
          throw new StoreError("job_invalid", new Error("vector_chunk_text"));
        }
        const profileId = parseContract(z.string().min(1).max(128), projection.profile_id, "vector-chunk-profile");
        const tokenizerVersion = parseContract(z.string().min(1).max(128), projection.tokenizer_version, "vector-chunk-tokenizer");
        const chunkerVersion = parseContract(z.string().min(1).max(128), projection.chunker_version, "vector-chunk-chunker");
        const chunkGeneration = parseContract(nonNegativeInt64Schema, projection.generation, "vector-chunk-generation");
        if (BigInt(chunkGeneration) !== activeGeneration && BigInt(chunkGeneration) !== activeGeneration + 1n) {
          throw new StoreError("job_stale", new Error("vector_generation_stale"));
        }
        const spanRow = spanSelect.get(checked.source_capture_id, spanId);
        if (spanRow === undefined) throw new StoreError("job_invalid", new Error("vector_span_missing"));
        const spanRoot = sourceSpanRoot(rowValue(spanRow, "root"), "vector-span-root");
        const spanPath = sqlText(rowValue(spanRow, "path"), "vector-span-path");
        const spanStart = sqlInteger(rowValue(spanRow, "start_utf16"), "vector-span-start");
        const spanEnd = sqlInteger(rowValue(spanRow, "end_utf16"), "vector-span-end");
        const spanDigest = sqlText(rowValue(spanRow, "digest"), "vector-span-digest");
        if (spanStart > BigInt(Number.MAX_SAFE_INTEGER) || spanEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new StoreError("job_invalid", new Error("vector_span_offset"));
        }
        const rootDocument = spanRoot === "event" ? event : payload;
        const projectedStart = projection.start_utf16 === undefined
          ? Number(spanStart)
          : projection.start_utf16;
        const projectedEnd = projection.end_utf16 === undefined
          ? Number(spanEnd)
          : projection.end_utf16;
        const projectedSpanDigest = projection.source_span_digest === undefined
          ? spanDigest
          : parseContract(z.string().regex(/^[a-f0-9]{64}$/i), projection.source_span_digest, "vector-span-source-digest").toLowerCase();
        if (projectedSpanDigest !== spanDigest || projectedStart < Number(spanStart) || projectedEnd > Number(spanEnd)) {
          throw new StoreError("job_invalid", new Error("vector_span_binding"));
        }
        const excerpt = validateSpanExcerpt(
          resolveTextAtPath(rootDocument, spanPath),
          projectedStart,
          projectedEnd,
          sha256(projection.text),
        );
        if (excerpt !== projection.text) throw new StoreError("job_invalid", new Error("vector_chunk_text_mismatch"));
        const sourceDigest = parseContract(
          z.string().regex(/^[a-f0-9]{64}$/i),
          projection.source_digest,
          "vector-source-digest",
        ).toLowerCase();
        if (sha256(projection.text) !== sourceDigest) throw new StoreError("job_invalid", new Error("vector_source_digest"));
        const expectedInputDigest = sha256(
          `${checked.scope_id}\u0000${checked.source_capture_id}\u0000${spanId}\u0000${String(projection.chunk_index)}\u0000${projection.text}\u0000${profileId}\u0000${tokenizerVersion}\u0000${chunkerVersion}\u0000${chunkGeneration}`,
        );
        const inputDigest = parseContract(
          z.string().regex(/^[a-f0-9]{64}$/i),
          projection.input_digest,
          "vector-input-digest",
        ).toLowerCase();
        if (inputDigest !== expectedInputDigest) throw new StoreError("job_invalid", new Error("vector_input_digest"));
        if (!(projection.vector instanceof Float32Array) || projection.vector.length !== VECTOR_DIMENSIONS) {
          throw new StoreError("job_invalid", new Error("vector_dim"));
        }
        const blob = Buffer.alloc(VECTOR_BLOB_BYTES);
        let vectorNorm = 0;
        for (let index = 0; index < VECTOR_DIMENSIONS; index += 1) {
          const value = (projection.vector as Float32Array)[index] as number;
          if (!Number.isFinite(value)) throw new StoreError("job_invalid", new Error("vector_float"));
          blob.writeFloatLE(value, index * 4);
          vectorNorm += value * value;
        }
        if (!(vectorNorm > 0) || !Number.isFinite(vectorNorm)) throw new StoreError("job_invalid", new Error("vector_norm"));
        let revisionId: string | null = null;
        if (projection.revision_id !== undefined) {
          revisionId = parseContract(z.uuid(), projection.revision_id, "vector-revision-id");
          const revisionRow = this.database
            .prepare(
              `SELECT 1 AS present
                 FROM memory_revision AS r
                 JOIN revision_source AS rs
                   ON rs.scope_id = r.scope_id AND rs.revision_id = r.revision_id
                WHERE r.scope_id = ? AND r.revision_id = ?
                  AND rs.source_capture_id = ? AND rs.source_span_id = ?`,
            )
            .get(checked.scope_id, revisionId, checked.source_capture_id, spanId);
          if (revisionRow === undefined) throw new StoreError("job_invalid", new Error("vector_revision_missing"));
        }
        try {
          const existingProjection = this.database
            .prepare(
              `SELECT c.chunk_id, c.text, c.input_digest, e.vector_blob
                 FROM vector_chunk AS c JOIN vector_embedding AS e ON e.chunk_id = c.chunk_id
                WHERE c.scope_id = ? AND c.source_id = ? AND c.span_id = ?
                  AND c.chunk_index = ? AND c.profile_id = ? AND c.generation = ?
                  AND ((c.revision_id IS NULL AND ? IS NULL) OR c.revision_id = ?)`,
            )
            .get(checked.scope_id, checked.source_capture_id, spanId, BigInt(projection.chunk_index), profileId, BigInt(chunkGeneration), revisionId, revisionId);
          if (existingProjection !== undefined) {
            if (
              sqlText(rowValue(existingProjection, "text"), "existing-vector-text") !== projection.text ||
              sqlText(rowValue(existingProjection, "input_digest"), "existing-vector-input") !== inputDigest
            ) throw new StoreError("job_invalid", new Error("vector_projection_conflict"));
            const existingBlob = rowValue(existingProjection, "vector_blob");
            if (!(existingBlob instanceof Uint8Array) || !Buffer.from(existingBlob).equals(blob)) {
              throw new StoreError("job_invalid", new Error("vector_projection_conflict"));
            }
            continue;
          }
          chunkInsert.run(
            chunkId,
            checked.scope_id,
            checked.source_capture_id,
            spanId,
            revisionId,
            BigInt(projection.chunk_index),
            projection.text,
            inputDigest,
            profileId,
            tokenizerVersion,
            chunkerVersion,
            BigInt(chunkGeneration),
            sqlInteger(rowValue(jobRow, "created_commit_seq"), "vector-created-commit"),
          );
          embeddingInsert.run(chunkId, checked.scope_id, profileId, blob, sourceDigest, BigInt(chunkGeneration));
          if (this.vectorQualification !== undefined) {
            const vectorRow = this.database.prepare("SELECT rowid FROM vector_chunk WHERE chunk_id = ?").get(chunkId);
            if (vectorRow === undefined) throw new StoreError("job_write_failed");
            const values = Array.from({ length: VECTOR_DIMENSIONS }, (_, index) => blob.readFloatLE(index * 4));
            this.database.prepare("INSERT INTO vector_embedding_vec(rowid, embedding) VALUES (?, ?)").run(sqlInteger(rowValue(vectorRow, "rowid"), "vector-rowid"), JSON.stringify(values));
          }
        } catch (error: unknown) {
          throw new StoreError("job_write_failed", error);
        }
      }
      const counterRow = this.database.prepare("SELECT commit_seq, data_epoch FROM vault_counter WHERE id = 1").get();
      if (counterRow === undefined) throw new StoreError("job_write_failed");
      const nextDataEpoch = sqlInteger(rowValue(counterRow, "data_epoch"), "vector-data-epoch") + 1n;
      this.database.prepare("UPDATE vault_counter SET data_epoch = ? WHERE id = 1").run(nextDataEpoch);
      const scopeEpochRow = this.database.prepare("SELECT data_epoch FROM scope WHERE scope_id = ?").get(checked.scope_id);
      if (scopeEpochRow === undefined) throw new StoreError("job_write_failed");
      const scopeEpoch = sqlInteger(rowValue(scopeEpochRow, "data_epoch"), "vector-scope-epoch");
      this.database
        .prepare("UPDATE scope SET data_epoch = ? WHERE scope_id = ?")
        .run(nextDataEpoch > scopeEpoch ? nextDataEpoch : scopeEpoch + 1n, checked.scope_id);
      const receipt = {
        version: 1,
        status: "completed",
        job_id: checked.job_id,
        scope_id: checked.scope_id,
        source_capture_id: checked.source_capture_id,
        task_version: checked.task_version,
        owner: checked.owner,
        fence: checked.fence,
        attempts: checked.attempts,
        input_fingerprint: checked.input_fingerprint,
        input_privacy_epoch: checked.input_privacy_epoch,
        completed_at: parsedNow,
        result_digest: digest,
        projection_digest: projectionDigest,
      };
      const updated = this.database
        .prepare(
          `UPDATE job
              SET state = 'completed', owner = NULL, lease_until = NULL, next_at = NULL,
                  pause_reason = NULL, completion_receipt_json = ?
            WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
              AND lease_until = ? AND task_version = ? AND input_fingerprint = ?
              AND input_privacy_epoch = ?`,
        )
        .run(
          JSON.stringify(receipt),
          checked.job_id,
          checked.owner,
          BigInt(checked.fence),
          checked.lease_until,
          checked.task_version,
          checked.input_fingerprint,
          checked.input_privacy_epoch,
        );
      if (sqlInteger(updated.changes, "vector-complete-changes") !== 1n) {
        return this.rollbackVectorProjection("claim_invalid", "running");
      }
      this.database.exec("COMMIT");
      committed = true;
      return { status: "completed", receipt };
    } catch (error: unknown) {
      if (!committed) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the projection failure.
        }
      }
      if (error instanceof StoreError) throw error;
      throw new StoreError("job_write_failed", error);
    }
  }

  private rollbackVectorProjection(reason: string, state: string): { readonly status: "rejected"; readonly reason: string } {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // Preserve the rejection reason.
    }
    return { status: "rejected", reason };
  }

  private pauseVectorJobLocked(
    jobId: string,
    owner: string,
    fence: string,
    leaseUntil: string,
    now: string,
    reason: "source_purged" | "policy_changed",
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE job
            SET state = 'paused', owner = NULL, lease_until = NULL, next_at = NULL, pause_reason = ?
          WHERE job_id = ? AND state = 'running' AND owner = ? AND fence = ?
            AND lease_until IS NOT NULL AND lease_until > ?`,
      )
      .run(reason, jobId, owner, BigInt(fence), now);
    if (sqlInteger(updated.changes, "vector-pause-changes") !== 1n) throw new StoreError("job_claim_conflict");
  }

  private ensureOpen(): void {
    if (this.closed) throw new StoreError("database_closed");
    const state = this.database.prepare("SELECT value FROM schema_meta WHERE key = 'restore_state'").get();
    if (state !== undefined && state.value !== "ready") throw new StoreError("restore_quarantined");
  }
}
/**
 * state transitions are single-row CAS operations guarded by the CHECK
 * constraints in exports.sql / 018-managed-exports.sql; the host-side file
 * work happens in the outbox lane, outside these transactions.
 */

export interface ManagedExportRow {
  readonly scope_id: string;
  readonly export_id: string;
  readonly procedure_item_id: string;
  readonly procedure_revision_id: string;
  readonly binding_id: string;
  readonly output_target: string;
  readonly target_kind: ManagedExportTargetKind;
  readonly root: string;
  readonly path: string;
  readonly expected_owner_hash: string | null;
  readonly root_dev: string | null;
  readonly root_ino: string | null;
  readonly parent_dev: string | null;
  readonly parent_ino: string | null;
  readonly staging_path: string | null;
  readonly staging_hash: string | null;
  readonly purge_operation_id: string | null;
  readonly desired_state: "present" | "absent";
  readonly state: "prepared" | "materialized" | "active" | "revocation_pending" | "host_refresh_pending" | "revoked" | "conflict";
  readonly observed_state: "unknown" | "absent" | "owned_current" | "owned_stale" | "foreign";
  readonly observed_hash: string | null;
  readonly privacy_epoch: string;
  readonly host_refresh_state: "not_required" | "required" | "confirmed";
  readonly outbox_state: "pending" | "running" | "completed" | "failed" | "paused";
  readonly outbox_attempts: number;
  readonly outbox_next_at: string | null;
  readonly outbox_owner: string | null;
  readonly outbox_lease_until: string | null;
  readonly outbox_fence: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const MANAGED_EXPORT_COLUMNS =
  "scope_id, export_id, procedure_item_id, procedure_revision_id, binding_id, output_target, target_kind, root, path, expected_owner_hash, root_dev, root_ino, parent_dev, parent_ino, staging_path, staging_hash, purge_operation_id, desired_state, state, observed_state, observed_hash, privacy_epoch, host_refresh_state, outbox_state, outbox_attempts, outbox_next_at, outbox_owner, outbox_lease_until, outbox_fence, created_at, updated_at";

function readManagedExportRow(row: Record<string, unknown>): ManagedExportRow {
  const str = (field: string): string => sqlText(rowValue(row, field), field);
  const nul = (field: string): string | null => (rowValue(row, field) === null ? null : sqlText(rowValue(row, field), field));
  return {
    scope_id: str("scope_id"),
    export_id: str("export_id"),
    procedure_item_id: str("procedure_item_id"),
    procedure_revision_id: str("procedure_revision_id"),
    binding_id: parseContract(z.uuid(), rowValue(row, "binding_id"), "export-binding"),
    output_target: parseContract(readerTargetSchema, rowValue(row, "output_target"), "export-output-target"),
    target_kind: parseContract(managedExportTargetKindSchema, rowValue(row, "target_kind"), "export-target"),
    root: str("root"),
    path: str("path"),
    expected_owner_hash: nul("expected_owner_hash"),
    root_dev: nul("root_dev"),
    root_ino: nul("root_ino"),
    parent_dev: nul("parent_dev"),
    parent_ino: nul("parent_ino"),
    staging_path: nul("staging_path"),
    staging_hash: nul("staging_hash"),
    purge_operation_id: nul("purge_operation_id"),
    desired_state: parseContract(z.enum(["present", "absent"]), rowValue(row, "desired_state"), "export-desired"),
    state: parseContract(z.enum(["prepared", "materialized", "active", "revocation_pending", "host_refresh_pending", "revoked", "conflict"]), rowValue(row, "state"), "export-state"),
    observed_state: parseContract(z.enum(["unknown", "absent", "owned_current", "owned_stale", "foreign"]), rowValue(row, "observed_state"), "export-observed"),
    observed_hash: nul("observed_hash"),
    privacy_epoch: str("privacy_epoch"),
    host_refresh_state: parseContract(z.enum(["not_required", "required", "confirmed"]), rowValue(row, "host_refresh_state"), "export-refresh"),
    outbox_state: parseContract(z.enum(["pending", "running", "completed", "failed", "paused"]), rowValue(row, "outbox_state"), "export-outbox"),
    outbox_attempts: Number(sqlInteger(rowValue(row, "outbox_attempts"), "export-outbox-attempts")),
    outbox_next_at: nul("outbox_next_at"),
    outbox_owner: nul("outbox_owner"),
    outbox_lease_until: nul("outbox_lease_until"),
    outbox_fence: Number(sqlInteger(rowValue(row, "outbox_fence"), "export-fence")),
    created_at: str("created_at"),
    updated_at: str("updated_at"),
  };
}
