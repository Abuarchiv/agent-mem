-- Explicit v4 -> v5 context query-trace table.
-- The caller wraps this file in BEGIN IMMEDIATE/COMMIT.
CREATE TABLE query_trace (
  query_id TEXT PRIMARY KEY CHECK (length(query_id) = 36),
  injection_id TEXT NOT NULL UNIQUE CHECK (length(injection_id) = 36),
  binding_id TEXT NOT NULL CHECK (length(binding_id) = 36),
  packet_digest TEXT NOT NULL CHECK (length(packet_digest) = 64),
  scope_ids_json TEXT NOT NULL CHECK (json_valid(scope_ids_json)),
  watermark TEXT NOT NULL CHECK (length(watermark) > 0),
  known_at_seq TEXT NOT NULL CHECK (length(known_at_seq) > 0),
  scope_epochs_json TEXT NOT NULL CHECK (json_valid(scope_epochs_json)),
  candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json)),
  output_ids_json TEXT NOT NULL CHECK (json_valid(output_ids_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  mode TEXT NOT NULL CHECK (mode IN ('current', 'historical', 'timeline', 'degraded')),
  token_unit TEXT NOT NULL CHECK (token_unit IN ('tokens', 'utf8_bytes')),
  tokens_used INTEGER NOT NULL CHECK (tokens_used >= 0),
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('prepared', 'returned'))
) STRICT;

CREATE INDEX query_trace_created ON query_trace (created_at, query_id);

UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
