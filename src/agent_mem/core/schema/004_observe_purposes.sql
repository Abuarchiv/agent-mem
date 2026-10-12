-- Agent Mem database schema, version 4: the observer also titles turns ('summary') and reviews a project's facts
-- once a day ('review'). SQLite cannot change a CHECK constraint, so the call log is copied into a new table.

CREATE TABLE observe_calls_v4 (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract', 'judge', 'summary', 'review')),
  seconds REAL NOT NULL,
  ok INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  turn_ids TEXT NOT NULL,
  error TEXT
);
INSERT INTO observe_calls_v4 SELECT id, ts, provider, purpose, seconds, ok, prompt_chars, turn_ids, error FROM observe_calls;
DROP TABLE observe_calls;
ALTER TABLE observe_calls_v4 RENAME TO observe_calls;
CREATE INDEX observe_calls_ts ON observe_calls(ts);
