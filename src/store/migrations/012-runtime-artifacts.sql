-- T10b removes only the source/job foreign-key blockers. Attempt and batch
-- identifiers stay durable so source tombstones never cascade cleanup history.
CREATE TABLE execution_batch_v11 (
  batch_id TEXT PRIMARY KEY CHECK (length(batch_id) = 36),
  job_id TEXT NOT NULL CHECK (length(job_id) = 36),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  source_capture_id TEXT NOT NULL CHECK (length(source_capture_id) = 36),
  task_version TEXT NOT NULL CHECK (length(task_version) > 0 AND length(task_version) <= 128),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  input_privacy_epoch TEXT NOT NULL CHECK (length(input_privacy_epoch) > 0),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 256),
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) > 0 AND length(runtime_id) <= 256),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0 AND length(model_id) <= 256),
  reasoning TEXT CHECK (reasoning IS NULL OR (length(reasoning) > 0 AND length(reasoning) <= 256)),
  provider_id TEXT NOT NULL CHECK (length(provider_id) > 0 AND length(provider_id) <= 256),
  provider_target TEXT NOT NULL CHECK (provider_target LIKE 'provider:%'),
  account_ref TEXT NOT NULL CHECK (length(account_ref) > 0 AND length(account_ref) <= 256),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  auth_generation TEXT CHECK (auth_generation IS NULL OR length(auth_generation) = 36),
  auth_entry_id TEXT CHECK (auth_entry_id IS NULL OR length(auth_entry_id) = 36),
  job_owner TEXT NOT NULL CHECK (length(job_owner) > 0 AND length(job_owner) <= 256),
  job_fence INTEGER NOT NULL CHECK (job_fence >= 0),
  job_lease_until TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'active', 'terminal_observed', 'reconciled', 'paused', 'failed')),
  extract_starts INTEGER NOT NULL DEFAULT 0 CHECK (extract_starts >= 0 AND extract_starts <= 2),
  verify_starts INTEGER NOT NULL DEFAULT 0 CHECK (verify_starts >= 0 AND verify_starts <= 2),
  total_starts INTEGER NOT NULL DEFAULT 0 CHECK (total_starts >= 0 AND total_starts <= 4),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  failure_reason TEXT CHECK (failure_reason IS NULL OR (length(failure_reason) > 0 AND length(failure_reason) <= 128)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO execution_batch_v11 SELECT * FROM execution_batch;
DROP TABLE execution_batch;
ALTER TABLE execution_batch_v11 RENAME TO execution_batch;
CREATE INDEX execution_batch_job ON execution_batch (job_id, state, updated_at);

CREATE TABLE execution_attempt_v11 (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  job_id TEXT NOT NULL CHECK (length(job_id) = 36),
  phase TEXT NOT NULL CHECK (phase IN ('extract', 'verify')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 2),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  input_privacy_epoch TEXT NOT NULL CHECK (length(input_privacy_epoch) > 0),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  profile_hash TEXT NOT NULL CHECK (length(profile_hash) = 64),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 256),
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) > 0 AND length(runtime_id) <= 256),
  model_id TEXT NOT NULL CHECK (length(model_id) > 0 AND length(model_id) <= 256),
  reasoning TEXT CHECK (reasoning IS NULL OR (length(reasoning) > 0 AND length(reasoning) <= 256)),
  provider_id TEXT NOT NULL CHECK (length(provider_id) > 0 AND length(provider_id) <= 256),
  account_ref TEXT NOT NULL CHECK (length(account_ref) > 0 AND length(account_ref) <= 256),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  auth_generation TEXT CHECK (auth_generation IS NULL OR length(auth_generation) = 36),
  auth_entry_id TEXT CHECK (auth_entry_id IS NULL OR length(auth_entry_id) = 36),
  owner TEXT NOT NULL CHECK (length(owner) > 0 AND length(owner) <= 256),
  job_fence INTEGER NOT NULL CHECK (job_fence >= 0),
  lease_until TEXT NOT NULL,
  reservation_id TEXT NOT NULL CHECK (length(reservation_id) = 36),
  accounting_period_day TEXT CHECK (accounting_period_day IS NULL OR length(accounting_period_day) = 10),
  accounting_period_month TEXT CHECK (accounting_period_month IS NULL OR length(accounting_period_month) = 7),
  deadline_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatch_intent', 'session_observed', 'prompt_dispatched', 'terminal_observed', 'cleanup_pending', 'reconciled', 'failed', 'aborted')),
  runtime_session_id TEXT CHECK (runtime_session_id IS NULL OR (length(runtime_session_id) > 0 AND length(runtime_session_id) <= 256)),
  provider_attempt_id TEXT CHECK (provider_attempt_id IS NULL OR (length(provider_attempt_id) > 0 AND length(provider_attempt_id) <= 256)),
  terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN ('completed', 'refused', 'invalid_output', 'timeout', 'aborted', 'failed')),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  result_receipt_json TEXT CHECK (result_receipt_json IS NULL OR (json_valid(result_receipt_json) AND length(result_receipt_json) <= 16384)),
  usage_status TEXT NOT NULL DEFAULT 'unknown' CHECK (usage_status IN ('unknown', 'partial', 'observed')),
  usage_json TEXT CHECK (usage_json IS NULL OR (json_valid(usage_json) AND length(usage_json) <= 8192)),
  usage_complete_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(usage_complete_json) AND length(usage_complete_json) <= 1024),
  cleanup_state TEXT NOT NULL DEFAULT 'not_started' CHECK (cleanup_state IN ('not_started', 'pending', 'confirmed', 'unknown')),
  cleanup_reason TEXT CHECK (cleanup_reason IS NULL OR (length(cleanup_reason) > 0 AND length(cleanup_reason) <= 128)),
  budget_violation TEXT CHECK (budget_violation IS NULL OR (json_valid(budget_violation) AND length(budget_violation) <= 1024)),
  started_at TEXT,
  terminal_at TEXT,
  cleanup_at TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES execution_batch (batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id) REFERENCES budget_reservation (reservation_id) ON DELETE RESTRICT,
  UNIQUE (batch_id, phase, ordinal),
  CHECK ((result_digest IS NULL) = (result_receipt_json IS NULL)),
  CHECK (usage_json IS NULL OR usage_status <> 'unknown')
) STRICT;
INSERT INTO execution_attempt_v11 SELECT * FROM execution_attempt;
DROP TABLE execution_attempt;
ALTER TABLE execution_attempt_v11 RENAME TO execution_attempt;
CREATE INDEX execution_attempt_batch ON execution_attempt (batch_id, phase, state, ordinal);
CREATE TRIGGER execution_attempt_receipt_immutable_update
BEFORE UPDATE ON execution_attempt
WHEN OLD.result_receipt_json IS NOT NULL
 AND (NEW.result_receipt_json IS NOT OLD.result_receipt_json OR NEW.result_digest IS NOT OLD.result_digest)
BEGIN
  SELECT RAISE(ABORT, 'execution_attempt_receipt_immutable');
END;

CREATE TABLE IF NOT EXISTS runtime_artifact (
  artifact_id TEXT PRIMARY KEY CHECK (length(artifact_id) = 36),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  job_id TEXT NOT NULL CHECK (length(job_id) = 36),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  source_capture_id TEXT NOT NULL CHECK (length(source_capture_id) = 36),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 256),
  account_ref TEXT NOT NULL CHECK (length(account_ref) > 0 AND length(account_ref) <= 256),
  kind TEXT NOT NULL CHECK (kind IN ('runtime_root', 'session', 'file', 'log', 'input', 'output', 'backup')),
  trusted_root TEXT NOT NULL CHECK (length(trusted_root) > 0),
  trusted_root_identity_json TEXT NOT NULL CHECK (json_valid(trusted_root_identity_json) AND length(trusted_root_identity_json) <= 2048),
  relative_path TEXT CHECK (relative_path IS NULL OR (length(relative_path) > 0 AND length(relative_path) <= 2048)),
  native_session_id TEXT CHECK (native_session_id IS NULL OR (length(native_session_id) > 0 AND length(native_session_id) <= 256)),
  ownership_evidence_json TEXT NOT NULL CHECK (json_valid(ownership_evidence_json) AND length(ownership_evidence_json) <= 4096),
  state TEXT NOT NULL CHECK (state IN ('planned', 'present', 'cleanup_pending', 'removed', 'ownership_uncertain')),
  cleanup_evidence_json TEXT CHECK (cleanup_evidence_json IS NULL OR (json_valid(cleanup_evidence_json) AND length(cleanup_evidence_json) <= 4096)),
  cleanup_owner TEXT,
  cleanup_lease_until TEXT,
  cleanup_fence INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_fence >= 0),
  execution_close_state TEXT NOT NULL DEFAULT 'unknown' CHECK (execution_close_state IN ('unknown', 'confirmed')),
  execution_closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES execution_attempt (attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES execution_batch (batch_id) ON DELETE RESTRICT,
  UNIQUE (attempt_id, kind, trusted_root, relative_path, native_session_id)
) STRICT;
CREATE INDEX IF NOT EXISTS runtime_artifact_attempt ON runtime_artifact (attempt_id, state, updated_at);
CREATE INDEX IF NOT EXISTS runtime_artifact_source ON runtime_artifact (scope_id, source_capture_id, state, updated_at);
CREATE INDEX IF NOT EXISTS runtime_artifact_profile ON runtime_artifact (profile_id, account_ref, state, updated_at);
UPDATE schema_meta SET value = '12' WHERE key = 'schema_version';
