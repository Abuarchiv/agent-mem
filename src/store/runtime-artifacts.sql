-- T10b durable inventory. Paths are relative to an inspected private root;
-- source text, prompts and credentials never enter this table.
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
