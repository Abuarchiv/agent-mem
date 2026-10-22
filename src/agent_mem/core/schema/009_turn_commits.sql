-- Agent Mem database schema, version 9: the commits a turn made ("8760496 Viewer: build_snapshot aufgeteilt"). The
-- hash is only in git's output; "which commit did X" finds the turn by its subject and shows the hash.

ALTER TABLE turns ADD COLUMN commits_json TEXT NOT NULL DEFAULT '[]';
