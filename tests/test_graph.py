"""The graph: the observer's entities and typed relations, stored per memory and drawn by the viewer."""

import json

from agent_mem import ui
from agent_mem.core import db
from agent_mem.core.config import Config
from agent_mem.memory import store
from agent_mem.observe import relations


class Answer:
    def __init__(self, data: dict) -> None:
        self.text = json.dumps(data)
        self.prompts: list[str] = []

    def generate_response(self, messages, **kwargs) -> str:
        self.prompts.append(messages[0]["content"])
        return self.text


def _memories(conn) -> list[int]:
    conn.execute("INSERT INTO projects(id, name, root, created_at) VALUES ('p', 'shop', '/p', 't')")
    bodies = ("search.py uses SQLite FTS5 for word search.", "The retry in hook.py fixes `database is locked`.")
    return [
        int(store.add_memory(conn, project_id="p", kind="fact", title="", body=b, source="agent", trust="user") or 0)
        for b in bodies
    ]


def test_relations_are_stored_per_memory_and_vague_or_foreign_ones_dropped(conn) -> None:
    first, second = _memories(conn)
    answer = Answer(
        {
            "entities": [{"name": "src/shop/search.py", "type": "file"}, {"name": "SQLite FTS5", "type": "library"}],
            "relations": [
                {"source": "src/shop/search.py", "type": "uses", "target": "SQLite FTS5", "memory": first},
                {"source": "`search.py`", "type": "uses", "target": "sqlite fts5", "memory": first},  # same pair
                {"source": "hook.py", "type": "fixes", "target": "database is locked", "memory": second},
                {"source": "hook.py", "type": "related_to", "target": "search.py", "memory": second},  # vague
                {"source": "hook.py", "type": "uses", "target": "shop", "memory": second},  # the project itself
                {"source": "hook.py", "type": "uses", "target": "x.py", "memory": 999},  # not in the batch
            ],
        }
    )
    [(project_id, rows)] = relations.pending(conn)
    assert relations.extract(conn, answer, project_id, rows) == 2
    assert "[" + str(first) + " · fact] search.py uses SQLite FTS5" in answer.prompts[0]
    stored = conn.execute(
        "SELECT s.label, r.type, t.label FROM relations r JOIN concepts s ON s.id = r.source_id "
        "JOIN concepts t ON t.id = r.target_id ORDER BY r.id"
    ).fetchall()
    assert [tuple(row) for row in stored] == [
        ("search.py", "uses", "SQLite FTS5"),
        ("hook.py", "fixes", "database is locked"),
    ]
    assert relations.pending(conn) == []  # read once

    graph = ui.memory_graph(conn, None)
    labels = {node["label"]: node for node in graph["nodes"]}
    assert labels["search.py"]["type"] == "file" and labels["SQLite FTS5"]["type"] == "library"
    assert {edge["type"] for edge in graph["edges"]} == {"uses", "fixes"}
    assert graph["read"] == graph["total"] == 2

    with db.transaction(conn):  # forgetting a memory takes its relations and the things only it named
        store.delete_owner(conn, "m", second)
    assert [row[0] for row in conn.execute("SELECT type FROM relations")] == ["uses"]
    assert "hook.py" not in {row[0] for row in conn.execute("SELECT label FROM concepts")}


def test_graph_calls_use_their_own_purpose_in_the_call_log(config: Config) -> None:
    conn = db.connect(config)
    conn.execute(
        "INSERT INTO observe_calls(ts, provider, purpose, seconds, ok, prompt_chars, turn_ids) "
        "VALUES ('t', 'claude', 'graph', 1, 1, 0, '[]')"
    )
    assert conn.execute("SELECT purpose FROM observe_calls").fetchone()[0] == "graph"
    conn.close()


def test_the_page_embeds_d3_force_in_its_one_hashed_script(conn, config: Config) -> None:
    page = ui.render(ui.build_snapshot(conn, config))
    script = page.rsplit("<script>", 1)[1]
    assert "forceSimulation" in script and "function graphView" in script  # one script, one hash in the CSP
