-- T02 schema v1. The database connection applies WAL/FULL/FK pragmas before use.
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');

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
  task_kind TEXT NOT NULL CHECK (task_kind = 'extract'),
  task_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_extraction', 'running', 'completed', 'failed')),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) = 64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at TEXT,
  owner TEXT,
  lease_until TEXT,
  fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  FOREIGN KEY (scope_id, source_capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, source_capture_id, task_kind, task_version)
) STRICT;

CREATE INDEX IF NOT EXISTS job_ready ON job (state, next_at);
