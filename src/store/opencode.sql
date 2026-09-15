-- Durable HP3 observation state. Native payloads remain in source_event; these
-- tables retain only the identifiers needed to replay, reconcile, or purge.
CREATE TABLE IF NOT EXISTS opencode_observation_receipt (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 256),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('event', 'part_snapshot')),
  identity_key TEXT NOT NULL CHECK (length(identity_key) BETWEEN 1 AND 1024),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 256),
  part_id TEXT CHECK (part_id IS NULL OR length(part_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  content_digest TEXT CHECK (content_digest IS NULL OR length(content_digest) = 64),
  first_observed_at TEXT NOT NULL,
  occurred_at TEXT,
  commit_seq INTEGER NOT NULL CHECK (commit_seq >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'purged')),
  PRIMARY KEY (scope_id, binding_id, identity_kind, identity_key, generation),
  UNIQUE (scope_id, capture_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  CHECK ((identity_kind = 'event' AND generation = 0) OR identity_kind = 'part_snapshot'),
  CHECK ((state = 'active') = (content_digest IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS opencode_receipt_capture
  ON opencode_observation_receipt (scope_id, capture_id);
CREATE INDEX IF NOT EXISTS opencode_receipt_identity
  ON opencode_observation_receipt (scope_id, binding_id, native_session_id, identity_kind, identity_key, generation);

CREATE TABLE IF NOT EXISTS opencode_observation_head (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 256),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  part_id TEXT NOT NULL CHECK (length(part_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  current_capture_id TEXT CHECK (current_capture_id IS NULL OR length(current_capture_id) = 36),
  current_digest TEXT CHECK (current_digest IS NULL OR length(current_digest) = 64),
  first_observed_at TEXT,
  last_observed_at TEXT,
  last_commit_seq INTEGER NOT NULL CHECK (last_commit_seq >= 0),
  last_scan_id TEXT CHECK (last_scan_id IS NULL OR length(last_scan_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('active', 'blocked')),
  PRIMARY KEY (scope_id, binding_id, native_session_id, message_id, part_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  CHECK ((state = 'active') = (current_capture_id IS NOT NULL AND current_digest IS NOT NULL AND first_observed_at IS NOT NULL)),
  CHECK ((current_capture_id IS NULL) = (current_digest IS NULL)),
  CHECK ((state = 'blocked') OR last_observed_at IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS opencode_head_capture
  ON opencode_observation_head (scope_id, current_capture_id);

CREATE TABLE IF NOT EXISTS opencode_reconcile_scan (
  scan_id TEXT PRIMARY KEY CHECK (length(scan_id) = 36),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 256),
  watermark INTEGER NOT NULL CHECK (watermark >= 0),
  cursor_json TEXT CHECK (cursor_json IS NULL OR json_valid(cursor_json)),
  state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'invalidated')),
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS opencode_scan_active
  ON opencode_reconcile_scan (scope_id, binding_id, native_session_id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS opencode_scan_scope_state
  ON opencode_reconcile_scan (scope_id, state, updated_at);

-- Identity-only purge fence. It deliberately stores no payload, fingerprint, or
-- digest, so a deleted native address cannot be revived from an old snapshot.
CREATE TABLE IF NOT EXISTS opencode_identity_tombstone (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  native_session_id TEXT NOT NULL CHECK (length(native_session_id) BETWEEN 1 AND 256),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('event', 'part_snapshot')),
  identity_key TEXT NOT NULL CHECK (length(identity_key) BETWEEN 1 AND 1024),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 256),
  part_id TEXT CHECK (part_id IS NULL OR length(part_id) BETWEEN 1 AND 256),
  operation_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, binding_id, identity_kind, identity_key),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES purge_operation (operation_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS opencode_tombstone_scope
  ON opencode_identity_tombstone (scope_id, native_session_id, identity_kind);
