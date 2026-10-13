"""Replaced memories are never returned by a search; they must not take its ranks either."""

from agent_mem.memory import search, store


def _memory(conn, text: str) -> int:
    memory_id = store.add_memory(
        conn, project_id="p", kind="fact", title=text, body=text, source="agent", trust="observer", dedupe=text
    )
    assert memory_id is not None
    return memory_id


def test_retired_duplicates_leave_the_index_so_the_valid_fact_ranks_first(conn) -> None:
    """Live data, 'wo läuft der viewer': five replaced duplicates held FTS ranks 0 to 4, the valid fact sat at 5 and
    the prompt hook stayed silent."""
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p', 'p', '/p', 't')")
    valid = _memory(conn, "Der Viewer läuft lokal unter localhost 37778 als Dienst mit eigenem Label")
    retired = [_memory(conn, f"Der Viewer läuft auf Port 37778 (Variante {n})") for n in range(5)]
    conn.execute("INSERT INTO vectors(owner_type, owner_id, model, vec) VALUES ('m', ?, 'x', x'00')", (retired[0],))
    for old in retired:
        store.retire(conn, old, valid)
    assert search.fts_candidates(conn, ["läuft", "viewer"])[0] == ("m", valid)
    assert conn.execute("SELECT COUNT(*) FROM vectors WHERE owner_id = ?", (retired[0],)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM memories WHERE invalid_at IS NOT NULL").fetchone()[0] == 5  # rows stay


def test_the_indexer_clears_keys_of_memories_retired_elsewhere(conn) -> None:
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p', 'p', '/p', 't')")
    old = _memory(conn, "Tests laufen mit pytest")
    conn.execute("UPDATE memories SET invalid_at = 't' WHERE id = ?", (old,))  # a path that bypasses supersede
    assert store.drop_retired_keys(conn) == 1
    assert search.fts_candidates(conn, ["tests", "pytest"]) == []
    assert store.drop_retired_keys(conn) == 0
