-- Agent Mem database schema, version 5: the concepts mem0 links to each memory (its entity store, mirrored so
-- the viewer can draw them without opening mem0's index). New tables; entities keeps its CHECK unchanged.

CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  -- 1 for a concrete thing (a name, code, a compound term); plain nouns like "Fehler" stay out of the graph
  specific INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS concept_links (
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (concept_id, memory_id)
);
CREATE INDEX IF NOT EXISTS concept_links_memory ON concept_links(memory_id);
