-- Agent Mem database schema, version 6: the tokens the agent spent on a turn, read from the harness transcript
-- (memory/work.py). NULL until measured; what a memory "cost to learn" is its turn's share.

ALTER TABLE turns ADD COLUMN work_tokens INTEGER;
-- A memory's share is its turn's work divided by the memories that turn produced; counted per injection.
CREATE INDEX IF NOT EXISTS memories_turn ON memories(turn_id);
