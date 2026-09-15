-- v25 -> v26: explicit installed capture-class selection and store-owned
-- acceptance time. The caller wraps this file in BEGIN EXCLUSIVE.
ALTER TABLE scope_policy ADD COLUMN capture_policy_enrolled INTEGER NOT NULL DEFAULT 0 CHECK (capture_policy_enrolled IN (0, 1));

CREATE TABLE scope_capture_policy (
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

CREATE INDEX scope_capture_policy_lookup
  ON scope_capture_policy (scope_id, source_class);

ALTER TABLE capture_replay_marker RENAME TO capture_replay_marker_v25;
CREATE TABLE capture_replay_marker (
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
INSERT INTO capture_replay_marker (capture_id, scope_id, reason, rejected_at)
SELECT capture_id, scope_id, reason, rejected_at FROM capture_replay_marker_v25;
DROP TABLE capture_replay_marker_v25;

CREATE TABLE capture_acceptance (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  retention_seconds INTEGER CHECK (retention_seconds IS NULL OR retention_seconds > 0),
  FOREIGN KEY (scope_id, capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX capture_acceptance_scope_time
  ON capture_acceptance (scope_id, accepted_at, capture_id);

UPDATE schema_meta SET value = '26' WHERE key = 'schema_version';
