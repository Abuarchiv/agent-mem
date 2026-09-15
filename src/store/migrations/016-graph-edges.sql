-- Schema 16: T17 relational evidence graph (plan §5 entity/semantic_edge).
-- Domain relations stay separate from the derivation graph: every
-- semantic_edge carries exactly one evidence revision; superseded and purged
-- edges are explicit statuses and are never delivered as current evidence.
-- Scope is part of every primary and foreign key (plan §5 invariant 7).
CREATE TABLE IF NOT EXISTS entity (
  scope_id TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) = 36),
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('resolved', 'candidate')),
  canonical_key TEXT,
  label TEXT NOT NULL CHECK (length(label) > 0 AND length(label) <= 512),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, entity_id),
  UNIQUE (scope_id, canonical_key),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  CHECK (
    (resolution_state = 'candidate' AND canonical_key IS NULL) OR
    (resolution_state = 'resolved' AND canonical_key IS NOT NULL AND length(canonical_key) > 0)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS entity_scope_state ON entity (scope_id, resolution_state);

CREATE TABLE IF NOT EXISTS semantic_edge (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  edge_id TEXT NOT NULL CHECK (length(edge_id) = 36),
  source_entity TEXT NOT NULL CHECK (length(source_entity) = 36),
  target_entity TEXT NOT NULL CHECK (length(target_entity) = 36),
  predicate TEXT NOT NULL CHECK (length(predicate) > 0 AND length(predicate) <= 256),
  qualifiers_json TEXT NOT NULL CHECK (json_valid(qualifiers_json) AND json_type(qualifiers_json) = 'array'),
  evidence_revision TEXT NOT NULL CHECK (length(evidence_revision) = 36),
  valid_from TEXT,
  valid_to TEXT,
  tx_from_seq INTEGER NOT NULL CHECK (tx_from_seq >= 0),
  tx_to_seq INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'purged')),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, edge_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, source_entity) REFERENCES entity (scope_id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, target_entity) REFERENCES entity (scope_id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, evidence_revision) REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT,
  CHECK (source_entity <> target_entity),
  CHECK (valid_from IS NULL OR (length(valid_from) = 20 AND valid_from GLOB '????-??-??T??:??:??Z')),
  CHECK (valid_to IS NULL OR (length(valid_to) = 20 AND valid_to GLOB '????-??-??T??:??:??Z')),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  CHECK (tx_to_seq IS NULL OR tx_to_seq >= tx_from_seq)
) STRICT;

CREATE INDEX IF NOT EXISTS semantic_edge_source_active
  ON semantic_edge (scope_id, source_entity, status);

CREATE INDEX IF NOT EXISTS semantic_edge_target_active
  ON semantic_edge (scope_id, target_entity, status);

CREATE INDEX IF NOT EXISTS semantic_edge_evidence_revision
  ON semantic_edge (scope_id, evidence_revision);

UPDATE schema_meta SET value = '16' WHERE key = 'schema_version';
