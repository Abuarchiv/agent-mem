import base64
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
from importlib import resources
from pathlib import Path

from agent_mem import cli, ui
from agent_mem.core import db, identity
from agent_mem.core.config import Config
from tests.conftest import Driver

INJECTION = "</script><script>alert(1)</script><!--"


def _teach(driver: Driver) -> None:
    driver.start("s1")
    driver.prompt("s1", "Fix the failing search tests")
    driver.bash(
        "s1", "pytest tests/test_search.py", "FAILED tests/test_search.py::test_rank - AssertionError", failed=True
    )
    driver.edit("s1", "app.py")
    driver.bash("s1", "pytest tests/test_search.py", "3 passed")
    driver.stop("s1", "Adjusted the ranking weight; tests pass.")
    driver.prompt("s1", INJECTION)
    driver.stop("s1", "done")


def _payload(html: str) -> dict:
    match = re.search(r'<script id="agent-mem-data" type="application/json">(.*?)</script>', html, re.S)
    assert match
    return json.loads(match.group(1))


def test_snapshot_holds_turns_actions_and_learning(conn, config: Config, driver: Driver):
    _teach(driver)
    snapshot = ui.build_snapshot(conn, config)
    assert snapshot["counts"]["turns"] == 2 and snapshot["counts"]["sessions"] == 1
    first = next(turn for turn in snapshot["turns"] if "failing search" in turn["prompt"])
    actions = snapshot["actions"][str(first["id"])]
    assert [action["failed"] for action in actions if action["tool"] == "Bash"] == [True, False]
    assert actions[0]["resolved"] and "AssertionError" in (actions[0]["error_line"] or "")
    agents = {row["harness"]: row for row in snapshot["agents"]}
    assert set(agents) == {"claude", "codex", "copilot", "opencode"}
    assert all(row["enabled"] and "connected" in row and "facts_ok_today" in row for row in agents.values())
    assert agents["opencode"]["stage"] is None  # its turns are kept as written unless ollama is opted in
    # what the hooks gave the agent, per session: a second session's prompt recalls the first session's fix
    driver.start("s2")
    driver.prompt("s2", "the failing search tests again, what was the ranking fix")
    recalls = ui.build_snapshot(conn, config)["recalls"]
    assert recalls and {r["session_id"] for r in recalls} == {"claude:s2"}
    assert {r["kind"] for r in recalls} <= {"injected", "shown"}
    assert snapshot["recipes"] and snapshot["recipes"][0]["command_key"]
    assert snapshot["learning"]["errors_fixed"] >= 1
    assert snapshot["projects"][0]["name"] == "demo"
    json.dumps(snapshot)


def test_project_filter_excludes_other_projects(conn, config: Config, driver: Driver, tmp_path: Path):
    _teach(driver)
    other_root = tmp_path / "other"
    other_root.mkdir()
    subprocess.run(["git", "init", "-q", str(other_root)], check=True)
    other = Driver(conn, config, other_root, harness="codex")
    other.prompt("o1", "Unrelated work in another repository")
    other.stop("o1", "ok")
    everything = ui.build_snapshot(conn, config)
    assert everything["counts"]["projects"] == 2
    project_id = next(project["id"] for project in everything["projects"] if project["name"] == "demo")
    scoped = ui.build_snapshot(conn, config, project_id)
    assert {turn["project_id"] for turn in scoped["turns"]} == {project_id}
    assert [project["id"] for project in scoped["projects"]] == [project_id]
    assert scoped["counts"]["turns"] == 2


def test_page_is_self_contained_and_locked_down(conn, config: Config, driver: Driver):
    _teach(driver)
    html = ui.render(ui.build_snapshot(conn, config))
    policy = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', html)
    assert policy
    rules = dict(part.strip().split(" ", 1) for part in policy.group(1).split(";") if part.strip())
    assert rules["default-src"] == "'none'" and rules["connect-src"] == "'none'"
    script = re.search(r"<script>(.*)</script>\n</body>", html, re.S)
    assert script
    digest = base64.b64encode(hashlib.sha256(script.group(1).encode("utf-8")).digest()).decode()
    assert rules["script-src"] == f"'sha256-{digest}'"
    # Captured text cannot close the data block or add markup.
    assert html.count("<script") == 2 and INJECTION not in html
    assert any(turn["prompt"] == INJECTION for turn in _payload(html)["turns"])
    assert not re.search(r"(src|href)=\"https?:", html)
    assert "data:font/woff2;base64," in html


def test_view_command_writes_a_private_page_and_purge_removes_it(
    config: Config, driver: Driver, project: Path, tmp_path: Path, capsys
):
    _teach(driver)
    base = ["--data-dir", str(config.data_dir)]
    assert cli.main([*base, "view", "--no-open"]) == 0
    page = ui.view_dir(config) / ui.PAGE_NAME
    assert str(page) in capsys.readouterr().out
    assert "Fix the failing search tests" in page.read_text(encoding="utf-8")
    if sys.platform != "win32":
        assert stat.S_IMODE(page.stat().st_mode) == 0o600
        assert stat.S_IMODE(page.parent.stat().st_mode) == 0o700
    assert cli.main([*base, "view", "--no-open", "--project", str(project)]) == 0
    assert cli.main([*base, "view", "--no-open", "--project", str(tmp_path / "nowhere")]) == 2
    uncaptured = tmp_path / "uncaptured"
    uncaptured.mkdir()
    assert cli.main([*base, "view", "--no-open", "--project", str(uncaptured)]) == 2
    conn = db.connect(config)
    try:
        assert conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 1
    finally:
        conn.close()
    assert cli.main([*base, "purge", "--id", "T1", "--yes"]) == 0
    assert not ui.view_dir(config).exists()


def _serve(config: Config):
    import socket
    import threading

    from agent_mem.ui import server

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        config.viewer.port = probe.getsockname()[1]
    httpd = server._Server(config)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def _get(config: Config, path: str, headers: dict[str, str] | None = None):
    import http.client

    client = http.client.HTTPConnection("127.0.0.1", config.viewer.port, timeout=10)
    client.request("GET", path, headers={"Host": f"127.0.0.1:{config.viewer.port}", **(headers or {})})
    response = client.getresponse()
    return response.status, dict(response.getheaders()), response.read().decode("utf-8")


def test_served_viewer_builds_a_fresh_page_on_localhost(config: Config, driver: Driver, monkeypatch):
    from agent_mem.ui import server

    _teach(driver)
    httpd = _serve(config)
    try:
        assert server.running(config) and server.url(config) == f"http://localhost:{config.viewer.port}/"
        assert _get(config, "/", {"Host": "evil.example:80"})[0] == 403  # DNS rebinding
        assert _get(config, "/", {"Host": f"localhost:{config.viewer.port}"})[0] == 200
        status, headers, page = _get(config, "/")
        assert status == 200 and headers["Cache-Control"] == "no-store"
        payload = _payload(page)
        assert payload["served"] is True and payload["refresh"] == config.viewer.refresh_seconds
        driver.prompt("s1", "Asked after the page was first served")
        assert any(
            t["prompt"] == "Asked after the page was first served" for t in _payload(_get(config, "/")[2])["turns"]
        )

        def broken(*args, **kwargs):
            raise sqlite3.DatabaseError("file is not a database")

        monkeypatch.setattr(ui, "build_snapshot", broken)
        status, _, page = _get(config, "/")
        assert status == 503 and "agent-mem doctor" in page
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_second_viewer_on_the_same_port_exits_cleanly(config: Config, capsys):
    from agent_mem.ui import server

    httpd = _serve(config)
    try:
        assert server.serve(config) == 0
        assert "already runs" in capsys.readouterr().out
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_autostart_writes_and_removes_a_login_item(config: Config):
    from agent_mem.ui import server

    target = server.autostart_path()
    if target is None:
        return  # Linux without systemd: nothing to register
    assert "login item written" in server.install_autostart(config)
    assert target.exists() and str(config.data_dir) in target.read_text(encoding="utf-8")
    if not target.name.endswith(".cmd"):  # Windows startup scripts inherit the user's PATH
        assert os.environ["PATH"] in target.read_text(encoding="utf-8")  # the health page finds claude, codex, copilot
    assert server.remove_autostart() == target and not target.exists()


def test_view_output_into_a_folder_and_export_into_a_new_folder(config: Config, driver: Driver, tmp_path: Path):
    _teach(driver)
    base = ["--data-dir", str(config.data_dir)]
    folder = tmp_path / "pages"
    folder.mkdir()
    assert cli.main([*base, "view", "--no-open", "--output", str(folder)]) == 0
    assert _payload((folder / ui.PAGE_NAME).read_text(encoding="utf-8"))["refresh"] is None
    assert cli.main([*base, "export", "--output", str(tmp_path / "new" / "dir" / "export.json")]) == 0


def test_view_assets_ship_with_the_package():
    folder = resources.files("agent_mem.ui")
    for name in ("app.js", "app.css", *(f"fonts/{file}" for _, _, file in ui.FONTS)):
        assert folder.joinpath(name).is_file(), name
    for license_file in ("bricolage-grotesque-OFL.txt", "figtree-OFL.txt", "jetbrains-mono-OFL.txt"):
        assert "Open Font License" in folder.joinpath(f"fonts/{license_file}").read_text(encoding="utf-8")


def test_is_within_compares_whole_path_segments(tmp_path: Path):
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    assert identity.is_within(root, root)
    assert identity.is_within(str(root / "src"), root)
    assert not identity.is_within(str(tmp_path / "proj2"), root)
