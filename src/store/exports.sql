-- v18 managed export registry (plan §5 managed_export, §7 T18c).
-- A managed export is a consciously produced host skill file snapshot of one
-- procedure revision for one target profile. The DB and the skill file are
-- deliberately NOT atomic: this table is the registered, resumable file
-- reconciliation (intent, owner hash, desired/observed state, privacy epoch
-- and a durable bounded outbox job). File atomicity comes from write-staging
-- + fsync + atomic rename; crash recovery comes from intent/outbox/
-- observed_state, never from an invented DB/file overall transaction.
-- Scope is part of every primary and foreign key (plan §5 invariant 7).
CREATE TABLE IF NOT EXISTS managed_export (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  export_id TEXT NOT NULL CHECK (length(export_id) = 36),
  -- The exported procedure item and the EXACT revision snapshot it carries.
  procedure_item_id TEXT NOT NULL CHECK (length(procedure_item_id) = 36),
  procedure_revision_id TEXT NOT NULL CHECK (length(procedure_revision_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  output_target TEXT NOT NULL CHECK (output_target LIKE 'reader:%'),
  -- Host target profile; the file is compiled into the known host format.
  target_kind TEXT NOT NULL CHECK (target_kind IN ('claude_skill', 'codex_instruction', 'opencode_skill', 'copilot_cli_skill')),
  -- Resolved absolute target root and target-relative path. The pair is
  -- unique per scope so one physical location carries exactly one managed export.
  root TEXT NOT NULL CHECK (length(root) > 1 AND length(root) <= 1024),
  path TEXT NOT NULL CHECK (length(path) > 0 AND length(path) <= 512),
  -- Ownership: sha256 of the file content this registry intends to write or
  -- last confirmed. It is persisted before staging so a rename crash remains
  -- attributable; deletion/disabling requires a matching owner hash.
  expected_owner_hash TEXT CHECK (expected_owner_hash IS NULL OR length(expected_owner_hash) = 64),
  -- Canonical identities are captured before the first rename and checked
  -- again before every deletion or replacement.
  root_dev TEXT,
  root_ino TEXT,
  parent_dev TEXT,
  parent_ino TEXT,
  -- A staged source-bearing artifact is inventory-backed and owner-hashed.
  staging_path TEXT CHECK (staging_path IS NULL OR (length(staging_path) > 1 AND length(staging_path) <= 4096)),
  staging_hash TEXT CHECK (staging_hash IS NULL OR length(staging_hash) = 64),
  purge_operation_id TEXT CHECK (purge_operation_id IS NULL OR length(purge_operation_id) = 36),
  -- Desired file presence: 'present' for an export, 'absent' from the
  -- moment revocation is requested.
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  -- Export lifecycle per plan §7: prepared (intent registered),
  -- materialized (file replaced on disk, DB confirmation pending),
  -- active (observed hash confirmed via CAS), revocation_pending,
  -- host_refresh_pending, revoked, conflict.
  state TEXT NOT NULL CHECK (state IN ('prepared', 'materialized', 'active', 'revocation_pending', 'host_refresh_pending', 'revoked', 'conflict')),
  -- Last observed file state from reconciliation against the filesystem.
  observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'absent', 'owned_current', 'owned_stale', 'foreign')),
  observed_hash TEXT CHECK (observed_hash IS NULL OR length(observed_hash) = 64),
  -- Restrictive privacy epoch snapshot of the scope at intent time; the
  -- reconciliation re-check fails closed on any later epoch change.
  privacy_epoch TEXT NOT NULL CHECK (length(privacy_epoch) > 0),
  -- Host refresh contract per plan §7 step 5: 'required' once the file is
  -- confirmed or cleanup is done; 'confirmed' only through an explicit,
  -- verifiable host restart/controlled-test confirmation. There is no
  -- verifiable hot-unload contract, so without it the export stays
  -- host_refresh_pending.
  host_refresh_state TEXT NOT NULL CHECK (host_refresh_state IN ('not_required', 'required', 'confirmed')),
  -- Durable bounded outbox job carrying ALL host-side filesystem work
  -- outside transactions. Lease/fence CAS like the shared job queue; the
  -- embedded form keeps one outbox row per export target (the shared job
  -- table's (scope, capture, kind, version) uniqueness cannot express
  -- multiple exports of one revision).
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
  -- Revocation flips desired presence and the lifecycle together.
  CHECK ((desired_state = 'absent') = (state IN ('revocation_pending', 'host_refresh_pending', 'revoked'))),
  -- 'active' is only reachable with a confirmed owned, unchanged file.
  CHECK (state <> 'active' OR (expected_owner_hash IS NOT NULL AND observed_state = 'owned_current' AND observed_hash = expected_owner_hash)),
  -- 'materialized' records an actually written file.
  CHECK (state <> 'materialized' OR expected_owner_hash IS NOT NULL),
  -- A conflict is always backed by a concrete foreign observation.
  CHECK (state <> 'conflict' OR observed_state = 'foreign'),
  -- Terminal revocation needs a confirmed refresh contract, except when the
  -- file was never confirmed to the host ('not_required').
  CHECK (state <> 'revoked' OR host_refresh_state IN ('confirmed', 'not_required')),
  CHECK (state <> 'active' OR host_refresh_state = 'required'),
  CHECK (host_refresh_state = 'not_required' OR state IN ('prepared', 'materialized', 'active', 'revocation_pending', 'host_refresh_pending', 'revoked', 'conflict')),
  -- Outbox lease ownership and lease bookkeeping.
  CHECK ((outbox_state = 'running') = (outbox_lease_until IS NOT NULL)),
  CHECK (outbox_state <> 'running' OR outbox_owner IS NOT NULL),
  CHECK (outbox_owner IS NULL OR outbox_state = 'running'),
  CHECK (state = 'prepared' OR created_at <= updated_at)
) STRICT;

CREATE INDEX IF NOT EXISTS managed_export_scope_state
  ON managed_export (scope_id, state);

CREATE INDEX IF NOT EXISTS managed_export_outbox_due
  ON managed_export (outbox_state, outbox_next_at, outbox_lease_until);
