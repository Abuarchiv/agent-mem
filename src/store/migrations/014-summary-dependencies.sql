-- Schema 14: summary/dependency graph and invalidation ledger (plan §5/§7, T13).
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
CREATE INDEX IF NOT EXISTS dependency_parent ON dependency (scope_id, parent_type, parent_revision_id, child_type, child_revision_id);
CREATE INDEX IF NOT EXISTS dependency_child ON dependency (scope_id, child_type, child_revision_id);

UPDATE schema_meta SET value = '14' WHERE key = 'schema_version';
