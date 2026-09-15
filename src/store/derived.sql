-- Provisional T13 derived-artifact/dependency substrate. The schema version
-- remains 12 until the orchestrator renumbers this migration with T12.
CREATE TABLE IF NOT EXISTS derived_artifact (
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 36),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'reflection', 'search_enrichment')),
  purpose TEXT NOT NULL CHECK (purpose IN ('historical', 'current')),
  session_id TEXT,
  content_json TEXT NOT NULL CHECK (json_valid(content_json) AND length(content_json) <= 1000000),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  temporal_domain_json TEXT NOT NULL CHECK (json_valid(temporal_domain_json) AND length(temporal_domain_json) <= 65536),
  egress_targets_json TEXT NOT NULL CHECK (json_valid(egress_targets_json) AND length(egress_targets_json) <= 16384),
  status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'purged')),
  status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) <= 128),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  invalidated_commit_seq INTEGER,
  PRIMARY KEY (scope_id, revision_id),
  UNIQUE (scope_id, artifact_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS derived_artifact_scope_status
  ON derived_artifact (scope_id, status, purpose, created_commit_seq);

CREATE TABLE IF NOT EXISTS dependency (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  child_type TEXT NOT NULL CHECK (child_type IN ('derived_artifact', 'memory_revision')),
  child_revision_id TEXT NOT NULL CHECK (length(child_revision_id) = 36),
  parent_type TEXT NOT NULL CHECK (parent_type IN ('derived_artifact', 'memory_revision', 'source_span')),
  parent_revision_id TEXT NOT NULL CHECK (length(parent_revision_id) = 36),
  relation TEXT NOT NULL CHECK (relation IN ('derives', 'supports')),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, child_type, child_revision_id, parent_type, parent_revision_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS dependency_parent
  ON dependency (scope_id, parent_type, parent_revision_id, child_type, child_revision_id);
CREATE INDEX IF NOT EXISTS dependency_child
  ON dependency (scope_id, child_type, child_revision_id);

CREATE TRIGGER IF NOT EXISTS derived_artifact_immutable_update
BEFORE UPDATE ON derived_artifact
WHEN NEW.artifact_id IS NOT OLD.artifact_id
  OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.revision_id IS NOT OLD.revision_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.session_id IS NOT OLD.session_id
  OR NEW.content_json IS NOT OLD.content_json
  OR NEW.content_digest IS NOT OLD.content_digest
  OR NEW.temporal_domain_json IS NOT OLD.temporal_domain_json
  OR NEW.egress_targets_json IS NOT OLD.egress_targets_json
  OR NEW.created_commit_seq IS NOT OLD.created_commit_seq
BEGIN
  SELECT RAISE(ABORT, 'derived_artifact_immutable');
END;

CREATE TRIGGER IF NOT EXISTS dependency_append_only_update
BEFORE UPDATE ON dependency
BEGIN
  SELECT RAISE(ABORT, 'dependency_append_only');
END;

CREATE TRIGGER IF NOT EXISTS dependency_append_only_delete
BEFORE DELETE ON dependency
BEGIN
  SELECT RAISE(ABORT, 'dependency_append_only');
END;
