-- Minimum reader 25: explicit transfer grants use the ordinary versioned migration.
ALTER TABLE scope_output_grant RENAME TO scope_output_grant_v24;
DROP INDEX scope_output_grant_lookup;
CREATE TABLE IF NOT EXISTS scope_output_grant (
  scope_id TEXT NOT NULL,
  output_target TEXT NOT NULL CHECK (
    output_target = 'local_ui' OR output_target = 'export:jsonl' OR output_target LIKE 'reader:%' OR output_target LIKE 'provider:%'
  ),
  source_class TEXT NOT NULL CHECK (source_class IN (
    'prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, output_target, source_class),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;
INSERT INTO scope_output_grant SELECT * FROM scope_output_grant_v24;
DROP TABLE scope_output_grant_v24;
CREATE INDEX IF NOT EXISTS scope_output_grant_lookup
  ON scope_output_grant (scope_id, output_target, source_class);
UPDATE schema_meta SET value = '25' WHERE key = 'schema_version';
