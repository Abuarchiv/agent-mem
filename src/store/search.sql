-- FTS5 external-content index for exact, sanitized source spans.
-- The canonical source_span/source_event rows remain authoritative; this is
-- rebuildable derived state and is mutated only by the triggers below.
CREATE TABLE search_document (
  span_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  root TEXT NOT NULL CHECK (root IN ('payload', 'event')),
  path TEXT NOT NULL CHECK (length(path) > 0),
  start_utf16 INTEGER NOT NULL CHECK (start_utf16 >= 0),
  end_utf16 INTEGER NOT NULL CHECK (end_utf16 > start_utf16),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  text TEXT NOT NULL CHECK (length(text) > 0),
  representation TEXT NOT NULL CHECK (representation = 'lexical'),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  FOREIGN KEY (scope_id, source_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_id, span_id) REFERENCES source_span (source_id, span_id) ON DELETE RESTRICT,
  UNIQUE (source_id, span_id)
) STRICT;

CREATE INDEX search_document_scope_eligible
  ON search_document (scope_id, eligible, generation);

CREATE VIRTUAL TABLE search_fts USING fts5(
  text,
  content = 'search_document',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER search_document_ai AFTER INSERT ON search_document BEGIN
  INSERT INTO search_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER search_document_ad AFTER DELETE ON search_document BEGIN
  INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER search_document_au AFTER UPDATE ON search_document BEGIN
  INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO search_fts (rowid, text) VALUES (new.rowid, new.text);
END;
