-- Explicit v3 -> v4 policy, pause, replay-marker and source-purge tables.
-- The caller wraps this file in BEGIN IMMEDIATE/COMMIT.
CREATE TABLE scope_policy (
  scope_id TEXT PRIMARY KEY,
  capture_paused INTEGER NOT NULL DEFAULT 0 CHECK (capture_paused IN (0, 1)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

INSERT INTO scope_policy (scope_id, capture_paused, updated_at)
SELECT scope_id, 0, created_at FROM scope;

CREATE TABLE scope_output_grant (
  scope_id TEXT NOT NULL,
  output_target TEXT NOT NULL CHECK (
    output_target = 'local_ui' OR output_target LIKE 'reader:%' OR output_target LIKE 'provider:%'
  ),
  source_class TEXT NOT NULL CHECK (source_class IN (
    'prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, output_target, source_class),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX scope_output_grant_lookup ON scope_output_grant (scope_id, output_target, source_class);

CREATE TABLE capture_replay_marker (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'capture_paused'),
  rejected_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE purge_operation (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  expected_privacy_epoch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('barrier', 'content_deleted', 'completed')),
  selected_count INTEGER NOT NULL CHECK (selected_count >= 1),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE purge_tombstone (
  capture_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (operation_id) REFERENCES purge_operation (operation_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX purge_tombstone_scope ON purge_tombstone (scope_id, operation_id);

UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';
