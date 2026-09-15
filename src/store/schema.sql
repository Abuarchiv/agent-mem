-- Current schema v26: explicit installed capture-class policy.
-- 021 is unused; 023 is reserved for the separate cross-host migration.
-- The database connection appends search.sql, revisions.sql,
-- segments.sql, attempts.sql, vectors.sql, extraction.sql, graph.sql,
-- procedures.sql and exports.sql before applying this schema. It applies
-- WAL/FULL/FK pragmas before use.
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '26');

CREATE TABLE IF NOT EXISTS vault_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  commit_seq INTEGER NOT NULL CHECK (commit_seq >= 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch >= 0)
) STRICT;

INSERT OR IGNORE INTO vault_counter (id, commit_seq, data_epoch) VALUES (1, 0, 0);

CREATE TABLE IF NOT EXISTS scope (
  scope_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'personal')),
  owner_ref TEXT NOT NULL CHECK (length(owner_ref) > 0),
  data_epoch INTEGER NOT NULL DEFAULT 0 CHECK (data_epoch >= 0),
  privacy_epoch INTEGER NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  host_kind TEXT NOT NULL,
  surface TEXT NOT NULL,
  execution_domain_kind TEXT NOT NULL,
  execution_domain_id TEXT NOT NULL,
  host_instance_id TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  coverage TEXT NOT NULL DEFAULT 'open',
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, session_id),
  UNIQUE (
    scope_id, host_kind, surface, execution_domain_kind, execution_domain_id,
    host_instance_id, host_session_id
  )
) STRICT;

CREATE INDEX IF NOT EXISTS session_scope_identity
  ON session (scope_id, host_kind, surface, execution_domain_kind, execution_domain_id, host_instance_id, host_session_id);

CREATE TABLE IF NOT EXISTS source_event (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  adapter_version TEXT NOT NULL,
  observed_stage TEXT NOT NULL CHECK (observed_stage IN (
    'session_start', 'prompt_submitted', 'prompt_transformed', 'tool_started',
    'tool_result', 'assistant_final', 'stop', 'compaction', 'resume',
    'message_part', 'error'
  )),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN (
    'prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic'
  )),
  native_session_id TEXT,
  native_turn_id TEXT,
  native_message_id TEXT,
  native_part_id TEXT,
  native_tool_call_id TEXT,
  captured_at TEXT NOT NULL,
  occurred_at TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  truncation_json TEXT NOT NULL CHECK (json_valid(truncation_json)),
  redaction_json TEXT NOT NULL CHECK (json_valid(redaction_json)),
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  commit_seq INTEGER NOT NULL CHECK (commit_seq >= 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch >= 0),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, session_id) REFERENCES session (scope_id, session_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, capture_id)
) STRICT;

CREATE INDEX IF NOT EXISTS source_event_scope_commit
  ON source_event (scope_id, commit_seq);

CREATE TABLE IF NOT EXISTS source_span (
  span_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  root TEXT NOT NULL DEFAULT 'payload' CHECK (root IN ('payload', 'event')),
  path TEXT NOT NULL CHECK (length(path) > 0),
  start_utf16 INTEGER NOT NULL CHECK (start_utf16 >= 0),
  end_utf16 INTEGER NOT NULL CHECK (end_utf16 > start_utf16),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  FOREIGN KEY (scope_id, source_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  UNIQUE (source_id, span_id)
) STRICT;

CREATE INDEX IF NOT EXISTS source_span_source ON source_span (scope_id, source_id);

CREATE TABLE IF NOT EXISTS job (
  job_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  source_capture_id TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('extract', 'embed')),
  task_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_extraction', 'running', 'completed', 'failed', 'paused')),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) = 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at TEXT,
  owner TEXT,
  lease_until TEXT,
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  input_privacy_epoch TEXT NOT NULL CHECK (length(input_privacy_epoch) > 0),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN (
    'authorization_required', 'handler_unavailable', 'source_purged',
    'quota_exhausted', 'budget_unknown', 'execution_deadline', 'policy_changed', 'shutdown', 'manual'
  )),
  completion_receipt_json TEXT CHECK (completion_receipt_json IS NULL OR json_valid(completion_receipt_json)),
  FOREIGN KEY (scope_id, source_capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, source_capture_id, task_kind, task_version),
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  CHECK (state = 'completed' OR completion_receipt_json IS NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS job_ready ON job (state, next_at);
CREATE INDEX IF NOT EXISTS job_scope_state ON job (scope_id, state, next_at);

CREATE TABLE IF NOT EXISTS auth_registry (
  version INTEGER NOT NULL CHECK (version = 1),
  account_ref TEXT PRIMARY KEY CHECK (length(account_ref) = 36),
  -- Kept while revoked cleanup is pending; cleared after all owned entries
  -- have been deleted and the registry transition is committed.
  entry_id TEXT CHECK (entry_id IS NULL OR length(entry_id) = 36),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0 AND length(client_id) <= 128),
  issuer TEXT NOT NULL CHECK (issuer = 'https://github.com'),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 20 AND account_id NOT GLOB '*[^0-9]*' AND account_id NOT GLOB '0*'),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'refreshing', 'cleanup_pending', 'revoked')),
  auth_generation TEXT NOT NULL CHECK (length(auth_generation) = 36),
  pending_entry_id TEXT CHECK (pending_entry_id IS NULL OR length(pending_entry_id) = 36),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) = 36),
  retiring_entry_id TEXT CHECK (retiring_entry_id IS NULL OR length(retiring_entry_id) = 36),
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  granted_scope TEXT NOT NULL,
  refresh_started_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'provisioning' AND pending_entry_id IS NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NOT NULL) OR
    (state = 'ready' AND pending_entry_id IS NULL AND operation_id IS NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NULL) OR
    (state = 'refreshing' AND pending_entry_id IS NOT NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NOT NULL) OR
    (state = 'cleanup_pending' AND pending_entry_id IS NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NOT NULL AND refresh_started_at IS NULL) OR
    (state = 'revoked' AND refresh_started_at IS NULL AND
      (entry_id IS NOT NULL OR (pending_entry_id IS NULL AND operation_id IS NULL AND retiring_entry_id IS NULL)))
  )
) STRICT;

CREATE INDEX IF NOT EXISTS auth_registry_state ON auth_registry (state, updated_at);

-- Provider-specific API credential metadata; secrets remain in the OS store.
CREATE TABLE IF NOT EXISTS api_auth_registry (
  version INTEGER NOT NULL CHECK (version = 1),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  account_ref TEXT PRIMARY KEY CHECK (length(account_ref) = 36),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  auth_generation TEXT NOT NULL CHECK (length(auth_generation) = 36),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  state TEXT NOT NULL CHECK (state IN ('ready', 'revoked')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS api_auth_registry_state ON api_auth_registry (provider_id, state, updated_at);

-- An operation is registered before an awaited credential write. It remains
-- pending across crashes and across processes until its owner has observed
-- the write and completed the corresponding cleanup obligation.
CREATE TABLE IF NOT EXISTS auth_operations (
  version INTEGER NOT NULL CHECK (version = 1),
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
  account_ref TEXT NOT NULL CHECK (length(account_ref) = 36),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0 AND length(client_id) <= 128),
  issuer TEXT NOT NULL CHECK (issuer = 'https://github.com'),
  owner_pid INTEGER NOT NULL CHECK (owner_pid >= 0),
  owner_nonce TEXT NOT NULL CHECK (length(owner_nonce) = 36),
  auth_generation TEXT CHECK (auth_generation IS NULL OR length(auth_generation) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('authorization', 'provisioning', 'refresh')),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS auth_operations_account_state ON auth_operations (account_ref, state);

-- A deletion receipt is separate from the registry pointer. A false result
-- from delete is not recorded while a writer for the same entry is pending.
CREATE TABLE IF NOT EXISTS auth_cleanup_entries (
  version INTEGER NOT NULL CHECK (version = 1),
  account_ref TEXT NOT NULL CHECK (length(account_ref) = 36),
  revoked_generation TEXT NOT NULL CHECK (length(revoked_generation) = 36),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_ref, revoked_generation, entry_id)
) STRICT;

CREATE INDEX IF NOT EXISTS auth_cleanup_entries_state ON auth_cleanup_entries (account_ref, revoked_generation, state);

-- Scope policy is separate from host/provider egress. A reader binding or
-- model request cannot create these rows; only a branded setup binding may.
CREATE TABLE IF NOT EXISTS scope_policy (
  scope_id TEXT PRIMARY KEY,
  capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
  capture_policy_enrolled INTEGER NOT NULL DEFAULT 0 CHECK (capture_policy_enrolled IN (0, 1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

-- Empty rows mean deny-all only after explicit enrollment in scope_policy.
-- Unenrolled legacy/API scopes retain the established capture contract.
CREATE TABLE IF NOT EXISTS scope_capture_policy (
  scope_id TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN (
    'prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic'
  )),
  retention_mode TEXT NOT NULL CHECK (retention_mode IN ('until_deleted', 'finite')),
  retention_seconds INTEGER CHECK (
    (retention_mode = 'until_deleted' AND retention_seconds IS NULL) OR
    (retention_mode = 'finite' AND retention_seconds IS NOT NULL AND retention_seconds > 0)
  ),
  selected_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, source_class),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS scope_capture_policy_lookup
  ON scope_capture_policy (scope_id, source_class);

CREATE TABLE IF NOT EXISTS scope_output_grant (
  scope_id TEXT NOT NULL,
  output_target TEXT NOT NULL CHECK (
    output_target = 'local_ui' OR output_target = 'export:jsonl' OR output_target LIKE 'reader:%' OR output_target LIKE 'provider:%'
  ),
  source_class TEXT NOT NULL CHECK (source_class IN (
    'prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, output_target, source_class),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS scope_output_grant_lookup
  ON scope_output_grant (scope_id, output_target, source_class);

-- A paused capture ID is a content-free replay fence. It prevents a retry
-- after resume from silently materializing the previously rejected payload.
CREATE TABLE IF NOT EXISTS capture_replay_marker (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('capture_paused', 'capture_class_excluded')),
  native_binding_id TEXT CHECK (native_binding_id IS NULL OR length(native_binding_id) = 36),
  native_session_id TEXT CHECK (native_session_id IS NULL OR (length(native_session_id) > 0 AND length(native_session_id) <= 256)),
  native_identity_kind TEXT CHECK (native_identity_kind IS NULL OR native_identity_kind IN ('event', 'part_snapshot')),
  native_identity_key TEXT CHECK (native_identity_key IS NULL OR (length(native_identity_key) > 0 AND length(native_identity_key) <= 512)),
  rejected_at TEXT NOT NULL,
  CHECK ((native_binding_id IS NULL AND native_session_id IS NULL AND native_identity_kind IS NULL AND native_identity_key IS NULL) OR
    (native_binding_id IS NOT NULL AND native_session_id IS NOT NULL AND native_identity_kind IS NOT NULL AND native_identity_key IS NOT NULL)),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

-- Store acceptance time is owned by this database, never copied from an
-- envelope clock. Legacy rows may have no entry until a future migration can
-- establish a trustworthy basis.
CREATE TABLE IF NOT EXISTS capture_acceptance (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  retention_seconds INTEGER CHECK (retention_seconds IS NULL OR retention_seconds > 0),
  FOREIGN KEY (scope_id, capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS capture_acceptance_scope_time
  ON capture_acceptance (scope_id, accepted_at, capture_id);

CREATE TABLE IF NOT EXISTS purge_operation (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  expected_privacy_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('barrier', 'content_deleted', 'completed')),
  selected_count INTEGER NOT NULL CHECK (selected_count >= 1),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  runtime_reset_state TEXT NOT NULL DEFAULT 'unknown' CHECK (runtime_reset_state IN ('unknown', 'required', 'complete', 'not_required')),
  runtime_reset_owner TEXT,
  cleanup_batch_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cleanup_batch_ids_json)),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

-- Tombstones intentionally contain no source fingerprint, payload, or span.
-- They remain after physical source deletion to fence replay and make purge
-- idempotent across restart.
CREATE TABLE IF NOT EXISTS purge_tombstone (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES purge_operation (operation_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS purge_tombstone_scope ON purge_tombstone (scope_id, operation_id);

-- Query traces contain only non-secret identifiers, snapshots, diagnostics and
-- delivery state. Query and source text intentionally never enter this table.
CREATE TABLE IF NOT EXISTS query_trace (
  query_id TEXT PRIMARY KEY CHECK (length(query_id) = 36),
  injection_id TEXT NOT NULL UNIQUE CHECK (length(injection_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
  scope_ids_json TEXT NOT NULL CHECK (json_valid(scope_ids_json)),
  watermark TEXT NOT NULL CHECK (length(watermark) > 0),
  known_at_seq TEXT NOT NULL CHECK (length(known_at_seq) > 0),
  scope_epochs_json TEXT NOT NULL CHECK (json_valid(scope_epochs_json)),
  candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json)),
  output_ids_json TEXT NOT NULL CHECK (json_valid(output_ids_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  mode TEXT NOT NULL CHECK (mode IN ('current', 'historical', 'timeline', 'degraded')),
  token_unit TEXT NOT NULL CHECK (token_unit IN ('tokens', 'utf8_bytes')),
  tokens_used INTEGER NOT NULL CHECK (tokens_used >= 0),
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('prepared', 'returned'))
) STRICT;

CREATE INDEX IF NOT EXISTS query_trace_created ON query_trace (created_at, query_id);
