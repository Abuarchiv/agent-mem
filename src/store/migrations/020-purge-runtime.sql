ALTER TABLE purge_operation ADD COLUMN runtime_reset_state TEXT NOT NULL DEFAULT 'unknown' CHECK (runtime_reset_state IN ('unknown', 'required', 'complete', 'not_required'));
ALTER TABLE purge_operation ADD COLUMN runtime_reset_owner TEXT;
ALTER TABLE purge_operation ADD COLUMN cleanup_batch_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cleanup_batch_ids_json));
UPDATE purge_operation SET state = 'content_deleted' WHERE state = 'completed';
UPDATE schema_meta SET value = '20' WHERE key = 'schema_version';
