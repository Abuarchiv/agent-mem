-- v6 identity and append-only revision ledger.
-- The canonical source/event rows remain authoritative evidence. These tables
-- only record structurally validated candidate mutations and their provenance.
CREATE UNIQUE INDEX IF NOT EXISTS source_span_scope_span
  ON source_span (scope_id, span_id);

CREATE UNIQUE INDEX IF NOT EXISTS source_span_scope_capture_span
  ON source_span (scope_id, source_id, span_id);

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

CREATE TABLE IF NOT EXISTS memory_item (
  scope_id TEXT NOT NULL,
  item_id TEXT NOT NULL CHECK (length(item_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN (
    'observation', 'plan', 'fact', 'decision', 'preference', 'lesson', 'procedure'
  )),
  entity_id TEXT,
  predicate TEXT NOT NULL CHECK (length(predicate) > 0 AND length(predicate) <= 256),
  qualifiers_json TEXT NOT NULL CHECK (json_valid(qualifiers_json) AND json_type(qualifiers_json) = 'array'),
  qualifiers_digest TEXT NOT NULL CHECK (length(qualifiers_digest) = 64),
  cardinality TEXT NOT NULL CHECK (cardinality IN ('exclusive', 'multi')),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'supported', 'disputed', 'superseded', 'retracted')),
  current_revision_id TEXT,
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, item_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, entity_id) REFERENCES entity (scope_id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, current_revision_id) REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS memory_item_scope_predicate
  ON memory_item (scope_id, predicate, status);

CREATE TABLE IF NOT EXISTS memory_revision (
  scope_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 36),
  item_id TEXT NOT NULL CHECK (length(item_id) = 36),
  parent_revision_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN (
    'ADD', 'SUPPORT', 'SUPERSEDE', 'CORRECT', 'DISPUTE', 'IGNORE', 'RETRACT'
  )),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  actor_binding_id TEXT NOT NULL CHECK (length(actor_binding_id) = 36),
  actor_host_kind TEXT NOT NULL CHECK (length(actor_host_kind) > 0),
  actor_surface TEXT NOT NULL CHECK (length(actor_surface) > 0),
  actor_execution_domain_kind TEXT NOT NULL CHECK (length(actor_execution_domain_kind) > 0),
  actor_execution_domain_id TEXT NOT NULL CHECK (length(actor_execution_domain_id) > 0),
  actor_host_instance_id TEXT NOT NULL CHECK (length(actor_host_instance_id) > 0),
  actor_host_session_id TEXT NOT NULL CHECK (length(actor_host_session_id) > 0),
  meaning_json TEXT CHECK (meaning_json IS NULL OR json_valid(meaning_json)),
  meaning_digest TEXT CHECK (meaning_digest IS NULL OR length(meaning_digest) = 64),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, revision_id),
  FOREIGN KEY (scope_id, item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, item_id, parent_revision_id)
    REFERENCES memory_revision (scope_id, item_id, revision_id) ON DELETE RESTRICT,
  CHECK ((meaning_json IS NULL) = (meaning_digest IS NULL))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS memory_revision_scope_item_revision
  ON memory_revision (scope_id, item_id, revision_id);

CREATE TABLE IF NOT EXISTS revision_source (
  scope_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 36),
  source_capture_id TEXT NOT NULL CHECK (length(source_capture_id) = 36),
  source_span_id TEXT NOT NULL CHECK (length(source_span_id) = 36),
  PRIMARY KEY (scope_id, revision_id, source_span_id),
  FOREIGN KEY (scope_id, revision_id) REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, source_capture_id, source_span_id)
    REFERENCES source_span (scope_id, source_id, span_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, source_capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS revision_source_span
  ON revision_source (scope_id, source_span_id);

CREATE TABLE IF NOT EXISTS semantic_slot (
  scope_id TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) = 36),
  predicate TEXT NOT NULL CHECK (length(predicate) > 0 AND length(predicate) <= 256),
  qualifiers_json TEXT NOT NULL CHECK (json_valid(qualifiers_json) AND json_type(qualifiers_json) = 'array'),
  qualifiers_digest TEXT NOT NULL CHECK (length(qualifiers_digest) = 64),
  cardinality TEXT NOT NULL CHECK (cardinality IN ('exclusive', 'multi')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  PRIMARY KEY (scope_id, entity_id, predicate, qualifiers_digest),
  FOREIGN KEY (scope_id, entity_id) REFERENCES entity (scope_id, entity_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS semantic_slot_member (
  scope_id TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) = 36),
  predicate TEXT NOT NULL CHECK (length(predicate) > 0 AND length(predicate) <= 256),
  qualifiers_digest TEXT NOT NULL CHECK (length(qualifiers_digest) = 64),
  member_digest TEXT NOT NULL CHECK (length(member_digest) = 64),
  item_id TEXT NOT NULL CHECK (length(item_id) = 36),
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 36),
  PRIMARY KEY (scope_id, entity_id, predicate, qualifiers_digest, member_digest),
  UNIQUE (scope_id, entity_id, predicate, qualifiers_digest, item_id),
  FOREIGN KEY (scope_id, entity_id, predicate, qualifiers_digest)
    REFERENCES semantic_slot (scope_id, entity_id, predicate, qualifiers_digest) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, revision_id) REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS semantic_slot_member_item
  ON semantic_slot_member (scope_id, item_id);

CREATE TABLE IF NOT EXISTS revision_operation (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
  scope_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('committed', 'rejected')),
  result_item_id TEXT,
  result_revision_id TEXT,
  result_slot_generation TEXT CHECK (result_slot_generation IS NULL OR length(result_slot_generation) > 0),
  result_code TEXT,
  result_item_status TEXT CHECK (result_item_status IS NULL OR result_item_status IN ('candidate', 'supported', 'disputed', 'superseded', 'retracted')),
  resolver_disposition TEXT CHECK (resolver_disposition IS NULL OR resolver_disposition IN ('candidate', 'ignored')),
  resolver_reason TEXT CHECK (resolver_reason IS NULL OR resolver_reason IN ('candidate_only_until_t11b', 'duplicate_evidence', 'explicit_ignore', 'legacy_v8_candidate_status_inferred')),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, result_item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, result_revision_id) REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'committed' AND result_item_id IS NOT NULL AND result_revision_id IS NOT NULL AND result_code IS NULL) OR
    (status = 'rejected' AND result_code IS NOT NULL AND result_slot_generation IS NULL)
  ),
  CHECK (
    (result_item_status IS NULL AND resolver_disposition IS NULL AND resolver_reason IS NULL) OR
    (result_item_status IS NOT NULL AND resolver_disposition IS NOT NULL AND resolver_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS revision_operation_scope
  ON revision_operation (scope_id, created_commit_seq);

CREATE TRIGGER IF NOT EXISTS revision_operation_append_only_update
BEFORE UPDATE ON revision_operation
BEGIN
  SELECT RAISE(ABORT, 'revision_operation_append_only');
END;

CREATE TRIGGER IF NOT EXISTS revision_operation_append_only_delete
BEFORE DELETE ON revision_operation
BEGIN
  SELECT RAISE(ABORT, 'revision_operation_append_only');
END;

CREATE TRIGGER IF NOT EXISTS memory_revision_append_only_update
BEFORE UPDATE ON memory_revision
BEGIN
  SELECT RAISE(ABORT, 'memory_revision_append_only');
END;

CREATE TRIGGER IF NOT EXISTS memory_revision_append_only_delete
BEFORE DELETE ON memory_revision
BEGIN
  SELECT RAISE(ABORT, 'memory_revision_append_only');
END;

CREATE TRIGGER IF NOT EXISTS revision_source_append_only_update
BEFORE UPDATE ON revision_source
BEGIN
  SELECT RAISE(ABORT, 'revision_source_append_only');
END;

CREATE TRIGGER IF NOT EXISTS revision_source_append_only_delete
BEFORE DELETE ON revision_source
BEGIN
  SELECT RAISE(ABORT, 'revision_source_append_only');
END;
