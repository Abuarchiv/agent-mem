-- Agent Mem v2 schema, version 1.
-- Owners are addressed as (owner_type, owner_id): owner_type 't' = turn, 'm' = memory.

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  remote TEXT,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE project_paths (
  path TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX project_paths_project ON project_paths(project_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  branch TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_event_at TEXT NOT NULL,
  summarized_at TEXT
);
CREATE INDEX sessions_project ON sessions(project_id, last_event_at);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'ok', 'error', 'unknown')),
  importance REAL NOT NULL DEFAULT 0.1,
  trust TEXT NOT NULL DEFAULT 'user',
  files_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]',
  indexed_at TEXT
);
CREATE INDEX turns_session ON turns(session_id, id);
CREATE INDEX turns_project ON turns(project_id, started_at);
CREATE INDEX turns_open ON turns(outcome, started_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id INTEGER REFERENCES turns(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  tool_use_id TEXT,
  command_key TEXT,
  exit_code INTEGER,
  error_sig TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  files_json TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL,
  trust TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  trimmed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_turn ON events(turn_id);
CREATE INDEX events_session_failures ON events(session_id, command_key, resolved) WHERE error_sig IS NOT NULL;
CREATE INDEX events_ts ON events(ts);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'summary', 'fact', 'decision', 'dead_end', 'preference', 'correction', 'lesson', 'native_note'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hook', 'agent', 'native', 'harness_summary', 'import', 'user')),
  trust TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  turn_id INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  origin TEXT,
  valid_from TEXT NOT NULL,
  invalid_at TEXT,
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX memories_project ON memories(project_id, kind, invalid_at);

CREATE TABLE search_keys (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL
);
CREATE INDEX search_keys_owner ON search_keys(owner_type, owner_id);

CREATE VIRTUAL TABLE search_fts USING fts5(text, tokenize = 'trigram');

CREATE TABLE vectors (
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);

CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'command', 'error', 'package', 'symbol')),
  key TEXT NOT NULL,
  UNIQUE (project_id, kind, key)
);

CREATE TABLE links (
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_type, owner_id, entity_id)
);
CREATE INDEX links_entity ON links(entity_id);

CREATE TABLE edges (
  a INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight REAL NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX edges_b ON edges(b);

CREATE TABLE anchors (
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id, path)
);

CREATE TABLE accesses (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'shown', 'injected', 'get', 'used', 'cited', 'warned')),
  session_id TEXT
);
CREATE INDEX accesses_owner ON accesses(owner_type, owner_id, ts);
CREATE INDEX accesses_session ON accesses(session_id, kind, ts);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  error_sig TEXT NOT NULL,
  error_text TEXT NOT NULL,
  command_key TEXT NOT NULL,
  files_json TEXT NOT NULL,
  successes INTEGER NOT NULL DEFAULT 1,
  recurrences INTEGER NOT NULL DEFAULT 0,
  last_turn_id INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, error_sig, command_key)
);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('avoid_command')),
  pattern TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  overrides INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_hit_at TEXT,
  UNIQUE (project_id, kind, pattern)
);

CREATE TABLE profile (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key, value)
);

CREATE TABLE health (
  component TEXT PRIMARY KEY,
  last_ok_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
