-- Main migration v10 -> v11 (011-vectors), after durable T10a attempts.
--
-- 1. Widens job.task_kind to ('extract','embed') without a parallel job table.
--    Existing UNIQUE(scope, source, task_kind, task_version) already separates
--    extract deduplication from embed (input/model/generation) deduplication.
-- 2. Creates T15 vector projection tables in the same database.
-- 3. Initializes the vector generation authority at 1.
DROP INDEX IF EXISTS job_ready;
DROP INDEX IF EXISTS job_scope_state;
ALTER TABLE job RENAME TO job_v9;

CREATE TABLE job (
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

INSERT INTO job (
  job_id, scope_id, source_capture_id, task_kind, task_version, state,
  dedupe_key, attempts, next_at, owner, lease_until, fence, created_commit_seq,
  input_fingerprint, input_privacy_epoch, pause_reason, completion_receipt_json
)
SELECT
  j.job_id, j.scope_id, j.source_capture_id, j.task_kind, j.task_version, j.state,
  j.dedupe_key, j.attempts, j.next_at, j.owner, j.lease_until, j.fence, j.created_commit_seq,
  j.input_fingerprint, j.input_privacy_epoch, j.pause_reason, j.completion_receipt_json
FROM job_v9 AS j;

DROP TABLE job_v9;

CREATE INDEX job_ready ON job (state, next_at, lease_until);
CREATE INDEX job_scope_state ON job (scope_id, state, next_at);
CREATE INDEX job_kind_state ON job (task_kind, state, next_at);

CREATE TABLE IF NOT EXISTS vector_chunk (
  chunk_id TEXT PRIMARY KEY CHECK (length(chunk_id) = 36),
  scope_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  revision_id TEXT CHECK (revision_id IS NULL OR length(revision_id) = 36),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  text TEXT NOT NULL CHECK (length(text) > 0),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 128),
  tokenizer_version TEXT NOT NULL CHECK (length(tokenizer_version) > 0 AND length(tokenizer_version) <= 128),
  chunker_version TEXT NOT NULL CHECK (length(chunker_version) > 0 AND length(chunker_version) <= 128),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  FOREIGN KEY (scope_id, source_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, span_id) REFERENCES source_span (source_id, span_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, source_id, span_id, chunk_index, profile_id, generation, revision_id)
) STRICT;

CREATE INDEX IF NOT EXISTS vector_chunk_scope_eligible
  ON vector_chunk (scope_id, eligible, generation, created_commit_seq);

CREATE INDEX IF NOT EXISTS vector_chunk_source
  ON vector_chunk (scope_id, source_id, span_id);

CREATE TABLE IF NOT EXISTS vector_embedding (
  chunk_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 128),
  dim INTEGER NOT NULL CHECK (dim = 384),
  dtype TEXT NOT NULL CHECK (dtype = 'f32'),
  vector_blob BLOB NOT NULL CHECK (length(vector_blob) = 1536),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  FOREIGN KEY (chunk_id) REFERENCES vector_chunk (chunk_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS vector_embedding_scope_generation
  ON vector_embedding (scope_id, generation, profile_id);

CREATE TABLE IF NOT EXISTS vector_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation INTEGER NOT NULL CHECK (active_generation >= 1),
  updated_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO vector_generation (id, active_generation, updated_at)
VALUES (1, 1, '2026-09-07T00:00:00Z');

UPDATE schema_meta SET value = '11' WHERE key = 'schema_version';
