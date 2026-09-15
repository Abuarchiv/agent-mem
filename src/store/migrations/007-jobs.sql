-- Explicit v6 -> v7 job queue extension. Existing source rows remain
-- authoritative; old jobs receive their immutable source fingerprint and a
-- unknown privacy baseline because v6 did not record that snapshot. A due
-- legacy job is paused for policy_changed and can only requeue through the
-- repository's checked resume CAS, which records a fresh current snapshot.
DROP INDEX IF EXISTS job_ready;
ALTER TABLE job RENAME TO job_v6;

CREATE TABLE job (
  job_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  source_capture_id TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK (task_kind = 'extract'),
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

INSERT INTO job (
  job_id, scope_id, source_capture_id, task_kind, task_version, state,
  dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
  input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
)
SELECT
  j.job_id, j.scope_id, j.source_capture_id, j.task_kind, j.task_version, j.state,
  j.dedupe_key, j.attempts, j.next_at, j.owner, j.lease_until, j.fence, j.created_commit_seq,
  e.fingerprint, '0', NULL, NULL
FROM job_v6 AS j
LEFT JOIN source_event AS e
  ON e.scope_id = j.scope_id AND e.capture_id = j.source_capture_id;

DROP TABLE job_v6;

CREATE INDEX job_ready ON job (state, next_at, lease_until);
CREATE INDEX job_scope_state ON job (scope_id, state, next_at);

UPDATE schema_meta SET value = '7' WHERE key = 'schema_version';
