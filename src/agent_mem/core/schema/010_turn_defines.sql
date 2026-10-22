-- Agent Mem database schema, version 10: the functions and classes a turn's changes defined ("drawEdges",
-- "_claude_usage"). They are only in the change itself; "which function draws the edges" finds the turn by them.

ALTER TABLE turns ADD COLUMN defines_json TEXT NOT NULL DEFAULT '[]';
