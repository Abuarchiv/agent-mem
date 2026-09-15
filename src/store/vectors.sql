-- T15 vector projection in the same SQLite database. No second database or
-- vector server. Chunks are relational and rebuildable; embedding blobs are
-- derived ranking data and never evidence or support status.
-- Isolated branch migration 010-vectors; root renumbers during integration.
CREATE TABLE IF NOT EXISTS vector_chunk (
  chunk_id TEXT PRIMARY KEY CHECK (length(chunk_id) = 36),
  scope_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  revision_id TEXT CHECK (revision_id IS NULL OR length(revision_id) = 36),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  text TEXT NOT NULL CHECK (length(text) > 0),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 128),
  tokenizer_version TEXT NOT NULL CHECK (length(tokenizer_version) > 0 AND length(tokenizer_version) <= 128),
  chunker_version TEXT NOT NULL CHECK (length(chunker_version) > 0 AND length(chunker_version) <= 128),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  created_commit_seq INTEGER NOT NULL CHECK (created_commit_seq >= 0),
  FOREIGN KEY (scope_id, source_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, span_id) REFERENCES source_span (source_id, span_id) ON DELETE RESTRICT,
  UNIQUE (scope_id, source_id, span_id, chunk_index, profile_id, generation, revision_id)
) STRICT;

CREATE INDEX IF NOT EXISTS vector_chunk_scope_eligible
  ON vector_chunk (scope_id, eligible, generation, created_commit_seq);

CREATE INDEX IF NOT EXISTS vector_chunk_source
  ON vector_chunk (scope_id, source_id, span_id);

CREATE TABLE IF NOT EXISTS vector_embedding (
  chunk_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (length(profile_id) > 0 AND length(profile_id) <= 128),
  dim INTEGER NOT NULL CHECK (dim = 384),
  dtype TEXT NOT NULL CHECK (dtype = 'f32'),
  vector_blob BLOB NOT NULL CHECK (length(vector_blob) = 1536),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  FOREIGN KEY (chunk_id) REFERENCES vector_chunk (chunk_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS vector_embedding_scope_generation
  ON vector_embedding (scope_id, generation, profile_id);

-- Single-row generation authority. Projection writes target the active
-- generation; reindex builds N+1 and switches this row atomically. Readers
-- pin the generation observed in their snapshot.
CREATE TABLE IF NOT EXISTS vector_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation INTEGER NOT NULL CHECK (active_generation >= 1),
  updated_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO vector_generation (id, active_generation, updated_at)
VALUES (1, 1, '2026-09-07T00:00:00Z');
