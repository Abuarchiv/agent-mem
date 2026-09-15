-- Explicit v8 -> v9 meaning/receipt extension. Legacy revisions remain
-- meaning-null; no polarity, modality, attribution, or resolver decision is
-- inferred during migration. Replay may infer only the old v8 candidate
-- result status from its candidate-only writer invariant, and labels that
-- provenance as legacy_v8_candidate_status_inferred.
ALTER TABLE memory_revision ADD COLUMN meaning_json TEXT CHECK (meaning_json IS NULL OR json_valid(meaning_json));
ALTER TABLE memory_revision ADD COLUMN meaning_digest TEXT CHECK (meaning_digest IS NULL OR length(meaning_digest) = 64);
ALTER TABLE revision_operation ADD COLUMN result_item_status TEXT CHECK (result_item_status IS NULL OR result_item_status IN ('candidate', 'supported', 'disputed', 'superseded', 'retracted'));
ALTER TABLE revision_operation ADD COLUMN resolver_disposition TEXT CHECK (resolver_disposition IS NULL OR resolver_disposition IN ('candidate', 'ignored'));
ALTER TABLE revision_operation ADD COLUMN resolver_reason TEXT CHECK (resolver_reason IS NULL OR resolver_reason IN ('candidate_only_until_t11b', 'duplicate_evidence', 'explicit_ignore', 'legacy_v8_candidate_status_inferred'));

CREATE TRIGGER IF NOT EXISTS revision_operation_resolver_pair_insert
BEFORE INSERT ON revision_operation
WHEN (NEW.result_item_status IS NULL AND (NEW.resolver_disposition IS NOT NULL OR NEW.resolver_reason IS NOT NULL))
  OR (NEW.result_item_status IS NOT NULL AND (NEW.resolver_disposition IS NULL OR NEW.resolver_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'revision_operation_resolver_pair');
END;

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

CREATE TRIGGER IF NOT EXISTS memory_revision_meaning_pair_insert
BEFORE INSERT ON memory_revision
WHEN (NEW.meaning_json IS NULL) IS NOT (NEW.meaning_digest IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory_revision_meaning_pair');
END;

UPDATE schema_meta SET value = '9' WHERE key = 'schema_version';
