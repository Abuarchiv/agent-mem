-- Agent Mem database schema, version 7: the graph. The observer reads memories and names the things they are about
-- (files, functions, tools, errors, ...) and how they relate ("search.py uses fts5", "the patch fixes the lock
-- error"), as agentmemory's graph extraction does. Things reuse the concepts table; spaCy's concepts from version 5
-- named plain words and are cleared. Each relation keeps the memory it was read from, so forgetting the memory
-- removes it. The call log learns the purpose 'graph'.

DELETE FROM concept_links;
DELETE FROM concepts;

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  UNIQUE (source_id, target_id, type, memory_id)
);
CREATE INDEX IF NOT EXISTS relations_memory ON relations(memory_id);
CREATE INDEX IF NOT EXISTS relations_target ON relations(target_id);

CREATE TABLE observe_calls_v7 (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract', 'judge', 'summary', 'review', 'graph')),
  seconds REAL NOT NULL,
  ok INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  turn_ids TEXT NOT NULL,
  error TEXT
);
INSERT INTO observe_calls_v7 SELECT id, ts, provider, purpose, seconds, ok, prompt_chars, turn_ids, error FROM observe_calls;
DROP TABLE observe_calls;
ALTER TABLE observe_calls_v7 RENAME TO observe_calls;
CREATE INDEX observe_calls_ts ON observe_calls(ts);
