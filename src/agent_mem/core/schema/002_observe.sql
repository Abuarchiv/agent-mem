-- Agent Mem database schema, version 2: background observer.

-- One row per closed turn. The Stop hook inserts it; the worker leases and finishes it.
CREATE TABLE observe_queue (
  turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'raw', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try TEXT NOT NULL,
  lease_until TEXT,
  provider TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX observe_queue_state ON observe_queue(state, next_try);

-- Every model call the worker makes: stage, purpose, duration, size. Never contains
-- prompt text.
CREATE TABLE observe_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('extract', 'judge')),
  seconds REAL NOT NULL,
  ok INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  turn_ids TEXT NOT NULL,
  error TEXT
);
CREATE INDEX observe_calls_ts ON observe_calls(ts);

-- Facts deleted in SQLite (mem_forget, purge) whose mem0 copy still has to go. The hook path and
-- the MCP server never import mem0; they leave the id here and the next worker run deletes it
-- from Qdrant, the entity store and history.db.
CREATE TABLE observe_forget (
  mem0_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);
