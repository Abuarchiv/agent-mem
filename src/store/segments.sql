-- v8 bitemporal projection. Revision rows remain the immutable ledger; these
-- rows are a rebuildable, transaction-time versioned projection of it.
CREATE TABLE IF NOT EXISTS temporal_intent (
  scope_id TEXT NOT NULL,
  revision_id TEXT NOT NULL CHECK (length(revision_id) = 36),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  PRIMARY KEY (scope_id, revision_id),
  FOREIGN KEY (scope_id, revision_id)
    REFERENCES memory_revision (scope_id, revision_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS state_segment (
  scope_id TEXT NOT NULL,
  segment_id TEXT NOT NULL CHECK (length(segment_id) = 36),
  item_id TEXT NOT NULL CHECK (length(item_id) = 36),
  value_revision_id TEXT,
  change_revision_id TEXT NOT NULL CHECK (length(change_revision_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('definite', 'possible', 'unknown', 'gap')),
  valid_from TEXT,
  valid_to TEXT,
  valid_from_precision TEXT,
  valid_to_precision TEXT,
  valid_timezone TEXT,
  valid_from_timezone TEXT,
  valid_to_timezone TEXT,
  valid_from_original TEXT,
  valid_to_original TEXT,
  tx_from_seq INTEGER NOT NULL CHECK (tx_from_seq >= 0),
  tx_to_seq INTEGER CHECK (tx_to_seq IS NULL OR tx_to_seq > tx_from_seq),
  PRIMARY KEY (scope_id, segment_id),
  FOREIGN KEY (scope_id, item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, item_id, value_revision_id)
    REFERENCES memory_revision (scope_id, item_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, item_id, change_revision_id)
    REFERENCES memory_revision (scope_id, item_id, revision_id) ON DELETE RESTRICT,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to),
  CHECK (status = 'gap' OR value_revision_id IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS state_segment_item_tx
  ON state_segment (scope_id, item_id, tx_from_seq, tx_to_seq);

CREATE INDEX IF NOT EXISTS state_segment_valid
  ON state_segment (scope_id, valid_from, valid_to, tx_from_seq, tx_to_seq);

-- A commit clock is metadata for wall-time lookup only. commit_seq remains the
-- ordering/fencing authority, and a row is inserted in the same transaction
-- that allocates that sequence. Historical rows before the marker stay
-- unmappable instead of borrowing source captured_at.
CREATE TABLE IF NOT EXISTS commit_clock_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  history_start_seq INTEGER NOT NULL CHECK (history_start_seq >= 0),
  history_start_wall_time TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS commit_clock (
  commit_seq INTEGER PRIMARY KEY CHECK (commit_seq >= 0),
  recorded_wall_time TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO commit_clock_meta (id, history_start_seq, history_start_wall_time)
SELECT 1, commit_seq, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM vault_counter
 WHERE id = 1;

CREATE INDEX IF NOT EXISTS commit_clock_wall_time
  ON commit_clock (recorded_wall_time, commit_seq);

CREATE TRIGGER IF NOT EXISTS temporal_intent_append_only_update
BEFORE UPDATE ON temporal_intent
BEGIN
  SELECT RAISE(ABORT, 'temporal_intent_append_only');
END;

CREATE TRIGGER IF NOT EXISTS temporal_intent_append_only_delete
BEFORE DELETE ON temporal_intent
BEGIN
  SELECT RAISE(ABORT, 'temporal_intent_append_only');
END;

CREATE TRIGGER IF NOT EXISTS state_segment_append_only_update
BEFORE UPDATE ON state_segment
WHEN NEW.scope_id IS NOT OLD.scope_id
  OR NEW.segment_id IS NOT OLD.segment_id
  OR NEW.item_id IS NOT OLD.item_id
  OR NEW.value_revision_id IS NOT OLD.value_revision_id
  OR NEW.change_revision_id IS NOT OLD.change_revision_id
  OR NEW.status IS NOT OLD.status
  OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.valid_to IS NOT OLD.valid_to
  OR NEW.valid_from_precision IS NOT OLD.valid_from_precision
  OR NEW.valid_to_precision IS NOT OLD.valid_to_precision
  OR NEW.valid_timezone IS NOT OLD.valid_timezone
  OR NEW.valid_from_timezone IS NOT OLD.valid_from_timezone
  OR NEW.valid_to_timezone IS NOT OLD.valid_to_timezone
  OR NEW.valid_from_original IS NOT OLD.valid_from_original
  OR NEW.valid_to_original IS NOT OLD.valid_to_original
  OR NEW.tx_from_seq IS NOT OLD.tx_from_seq
  OR (OLD.tx_to_seq IS NOT NULL AND NEW.tx_to_seq IS NOT OLD.tx_to_seq)
  OR (OLD.tx_to_seq IS NULL AND NEW.tx_to_seq IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'state_segment_append_only');
END;

CREATE TRIGGER IF NOT EXISTS state_segment_append_only_delete
BEFORE DELETE ON state_segment
BEGIN
  SELECT RAISE(ABORT, 'state_segment_append_only');
END;

CREATE TRIGGER IF NOT EXISTS commit_clock_append_only_update
BEFORE UPDATE ON commit_clock
BEGIN
  SELECT RAISE(ABORT, 'commit_clock_append_only');
END;

CREATE TRIGGER IF NOT EXISTS commit_clock_append_only_delete
BEFORE DELETE ON commit_clock
BEGIN
  SELECT RAISE(ABORT, 'commit_clock_append_only');
END;

CREATE TRIGGER IF NOT EXISTS commit_clock_meta_immutable_update
BEFORE UPDATE ON commit_clock_meta
BEGIN
  SELECT RAISE(ABORT, 'commit_clock_meta_immutable');
END;

CREATE TRIGGER IF NOT EXISTS commit_clock_meta_immutable_delete
BEFORE DELETE ON commit_clock_meta
BEGIN
  SELECT RAISE(ABORT, 'commit_clock_meta_immutable');
END;
