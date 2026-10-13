-- Agent Mem database schema, version 8: tool events by session and time. Clearing a failure (hooks/capture.py
-- _resolve_failures) looks for edits in its session since the failure; without this index it read the events of
-- every session in that window, 819 rows and 11 ms for one twelve-hour session at 6,500 events, on a hook with 400 ms.

CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
