-- Known v20 -> v22 managed-export format migration.
-- Migration 021 is reserved for the backup worker. This step deliberately
-- rebuilds only managed_export, preserving every existing row and lifecycle
-- field while expanding the target-kind CHECK. Do not edit deployed 018.

ALTER TABLE managed_export RENAME TO managed_export_v20;

CREATE TABLE managed_export (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  export_id TEXT NOT NULL CHECK (length(export_id) = 36),
  procedure_item_id TEXT NOT NULL CHECK (length(procedure_item_id) = 36),
  procedure_revision_id TEXT NOT NULL CHECK (length(procedure_revision_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  output_target TEXT NOT NULL CHECK (output_target LIKE 'reader:%'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claude_skill', 'codex_instruction', 'opencode_skill', 'copilot_cli_skill')),
  root TEXT NOT NULL CHECK (length(root) > 1 AND length(root) <= 1024),
  path TEXT NOT NULL CHECK (length(path) > 0 AND length(path) <= 512),
  expected_owner_hash TEXT CHECK (expected_owner_hash IS NULL OR length(expected_owner_hash) = 64),
  root_dev TEXT,
  root_ino TEXT,
  parent_dev TEXT,
  parent_ino TEXT,
  staging_path TEXT CHECK (staging_path IS NULL OR (length(staging_path) > 1 AND length(staging_path) <= 4096)),
  staging_hash TEXT CHECK (staging_hash IS NULL OR length(staging_hash) = 64),
  purge_operation_id TEXT CHECK (purge_operation_id IS NULL OR length(purge_operation_id) = 36),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'materialized', 'active', 'revocation_pending', 'host_refresh_pending', 'revoked', 'conflict')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'absent', 'owned_current', 'owned_stale', 'foreign')),
  observed_hash TEXT CHECK (observed_hash IS NULL OR length(observed_hash) = 64),
  privacy_epoch TEXT NOT NULL CHECK (length(privacy_epoch) > 0),
  host_refresh_state TEXT NOT NULL CHECK (host_refresh_state IN ('not_required', 'required', 'confirmed')),
  outbox_state TEXT NOT NULL CHECK (outbox_state IN ('pending', 'running', 'completed', 'failed', 'paused')),
  outbox_attempts INTEGER NOT NULL CHECK (outbox_attempts >= 0),
  outbox_next_at TEXT,
  outbox_owner TEXT CHECK (outbox_owner IS NULL OR (length(outbox_owner) > 0 AND length(outbox_owner) <= 256)),
  outbox_lease_until TEXT,
  outbox_fence INTEGER NOT NULL CHECK (outbox_fence >= 0),
  outbox_last_error TEXT CHECK (outbox_last_error IS NULL OR (length(outbox_last_error) > 0 AND length(outbox_last_error) <= 256)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, export_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, procedure_item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, root, path),
  CHECK ((root_dev IS NULL) = (root_ino IS NULL)),
  CHECK ((parent_dev IS NULL) = (parent_ino IS NULL)),
  CHECK ((staging_path IS NULL) = (staging_hash IS NULL)),
  CHECK ((desired_state = 'absent') = (state IN ('revocation_pending', 'host_refresh_pending', 'revoked'))),
  CHECK (state <> 'active' OR (expected_owner_hash IS NOT NULL AND observed_state = 'owned_current' AND observed_hash = expected_owner_hash)),
  CHECK (state <> 'materialized' OR expected_owner_hash IS NOT NULL),
  CHECK (state <> 'conflict' OR observed_state = 'foreign'),
  CHECK (state <> 'revoked' OR host_refresh_state IN ('confirmed', 'not_required')),
  CHECK (state <> 'active' OR host_refresh_state = 'required'),
  CHECK (host_refresh_state = 'not_required' OR state IN ('prepared', 'materialized', 'active', 'revocation_pending', 'host_refresh_pending', 'revoked', 'conflict')),
  CHECK ((outbox_state = 'running') = (outbox_lease_until IS NOT NULL)),
  CHECK (outbox_state <> 'running' OR outbox_owner IS NOT NULL),
  CHECK (outbox_owner IS NULL OR outbox_state = 'running'),
  CHECK (state = 'prepared' OR created_at <= updated_at)
) STRICT;

INSERT INTO managed_export (
  scope_id, export_id, procedure_item_id, procedure_revision_id, binding_id,
  output_target, target_kind, root, path, expected_owner_hash, root_dev,
  root_ino, parent_dev, parent_ino, staging_path, staging_hash,
  purge_operation_id, desired_state, state, observed_state, observed_hash,
  privacy_epoch, host_refresh_state, outbox_state, outbox_attempts,
  outbox_next_at, outbox_owner, outbox_lease_until, outbox_fence,
  outbox_last_error, created_at, updated_at
)
SELECT
  scope_id, export_id, procedure_item_id, procedure_revision_id, binding_id,
  output_target, target_kind, root, path, expected_owner_hash, root_dev,
  root_ino, parent_dev, parent_ino, staging_path, staging_hash,
  purge_operation_id, desired_state, state, observed_state, observed_hash,
  privacy_epoch, host_refresh_state, outbox_state, outbox_attempts,
  outbox_next_at, outbox_owner, outbox_lease_until, outbox_fence,
  outbox_last_error, created_at, updated_at
FROM managed_export_v20;

DROP TABLE managed_export_v20;

CREATE INDEX IF NOT EXISTS managed_export_scope_state
  ON managed_export (scope_id, state);

CREATE INDEX IF NOT EXISTS managed_export_outbox_due
  ON managed_export (outbox_state, outbox_next_at, outbox_lease_until);

UPDATE schema_meta SET value = '22' WHERE key = 'schema_version';
