import type { DatabaseSync } from "node:sqlite";

/** Recreate actual pre-026 policy tables, preserving prior policy/replay rows. */
export function removeCapturePolicySchema(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE capture_acceptance;
    DROP TABLE scope_capture_policy;
    ALTER TABLE scope_policy DROP COLUMN capture_policy_enrolled;
    ALTER TABLE capture_replay_marker RENAME TO capture_replay_marker_v26;
    CREATE TABLE capture_replay_marker (
      capture_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason = 'capture_paused'),
      rejected_at TEXT NOT NULL,
      FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO capture_replay_marker (capture_id, scope_id, reason, rejected_at)
      SELECT capture_id, scope_id, reason, rejected_at FROM capture_replay_marker_v26;
    DROP TABLE capture_replay_marker_v26;
  `);
}

/** Schema24 and earlier cannot represent export:jsonl grants. */
export function restorePreTransferPolicySchema(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM scope_output_grant WHERE output_target = 'export:jsonl';
    DROP INDEX scope_output_grant_lookup;
    ALTER TABLE scope_output_grant RENAME TO scope_output_grant_current;
    CREATE TABLE scope_output_grant (
      scope_id TEXT NOT NULL,
      output_target TEXT NOT NULL CHECK (output_target = 'local_ui' OR output_target LIKE 'reader:%' OR output_target LIKE 'provider:%'),
      source_class TEXT NOT NULL CHECK (source_class IN ('prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, output_target, source_class),
      FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO scope_output_grant SELECT * FROM scope_output_grant_current;
    DROP TABLE scope_output_grant_current;
    CREATE INDEX scope_output_grant_lookup ON scope_output_grant (scope_id, output_target, source_class);
  `);
}
