-- Explicit v2 -> v3 search expansion. The caller wraps this file and the
-- shared search.sql definitions in one BEGIN IMMEDIATE/COMMIT transaction.
ALTER TABLE source_span ADD COLUMN root TEXT NOT NULL DEFAULT 'payload'
  CHECK (root IN ('payload', 'event'));

UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
