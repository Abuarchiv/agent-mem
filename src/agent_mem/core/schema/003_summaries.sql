-- Agent Mem database schema, version 3: what happened, in words a reader skims.
-- The observer titles each turn and keeps one running summary per session. Empty without a model:
-- readers fall back to the prompt.

ALTER TABLE turns ADD COLUMN title TEXT;
-- bugfix | feature | change | discovery | decision | question
ALTER TABLE turns ADD COLUMN type TEXT;
ALTER TABLE sessions ADD COLUMN title TEXT;
-- {"learned": [...], "completed": [...], "next_steps": [...]}
ALTER TABLE sessions ADD COLUMN summary_json TEXT;
