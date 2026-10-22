"""``agent-mem serve``: the viewer at http://localhost:<port>, always on.

Read-only and local. It binds the loopback interface only and answers GET for one page, rebuilt whenever the database
changed, so an open tab stays current by reloading itself. After an upgrade it exits on the next request and is
restarted with the new code. The login item and the SessionStart
hook start it detached when nothing answers on the port. Loaded by the CLI only, never on the hook path.
"""

from __future__ import annotations

import html
import http.server
import os
import plistlib
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http import HTTPStatus
from pathlib import Path

from agent_mem import __version__
from agent_mem.core import db
from agent_mem.core.config import Config, env_flag

HOST = "127.0.0.1"
HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # The page carries its own policy (script by hash, no network); the header adds what a meta tag cannot.
    "Content-Security-Policy": "frame-ancestors 'none'",
}


def url(config: Config) -> str:
    return f"http://localhost:{config.viewer.port}/"


def running(config: Config, timeout: float = 1.0) -> bool:
    """True when an agent-mem viewer answers on the configured port."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{config.viewer.port}/health", timeout=timeout) as response:
            return response.read(16).startswith(b"agent-mem")
    except (OSError, ValueError):
        return False


def _message_page(title: str, detail: str) -> bytes:
    return (
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>agent-mem</title>'
        '<meta name="color-scheme" content="light dark">'
        '<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">'
        f'<h1 style="font-size:1.4rem">{html.escape(title)}</h1><p>{html.escape(detail)}</p></body></html>'
    ).encode()


class _Server(http.server.ThreadingHTTPServer):
    # SO_REUSEADDR on Windows lets a second process take a port that is in use.
    allow_reuse_address = sys.platform != "win32"
    daemon_threads = True

    def __init__(self, config: Config) -> None:
        self.config = config
        self.code = _code_stamp()
        self.restart = False  # set when the installed code changed: serve() then exits non-zero and is restarted
        self.cache: dict[str | None, tuple[tuple[int, ...], float, bytes]] = {}
        port = config.viewer.port
        self.hosts = {HOST, "localhost"}
        # Docker publishes the port to the host's 127.0.0.1 only; inside the container loopback is unreachable.
        super().__init__((os.environ.get("AGENT_MEM_VIEWER_BIND") or HOST, port), _Handler)


class _Handler(http.server.BaseHTTPRequestHandler):
    server: _Server  # pyright: ignore[reportIncompatibleVariableOverride]
    server_version = "agent-mem"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        pass  # no access log: there is nothing in it worth keeping

    def _send(
        self, status: HTTPStatus, body: bytes, headers: dict[str, str] | None = None, content_type: str = "text/html"
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in {**HEADERS, **(headers or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        # A foreign Host header means a page on another site resolved its own name to 127.0.0.1 (DNS rebinding).
        # The name decides, not the port: Docker publishes the viewer on whatever host port was free.
        name, _, port = (self.headers.get("Host") or "").rpartition(":")
        if name not in self.server.hosts or not port.isdigit():
            self._send(HTTPStatus.FORBIDDEN, _message_page("Forbidden", f"Open {url(self.server.config)} instead."))
            return
        parts = urllib.parse.urlsplit(self.path)
        if parts.path == "/health":
            self._send(HTTPStatus.OK, f"agent-mem {__version__}".encode(), content_type="text/plain")
            return
        if parts.path != "/":
            self._send(
                HTTPStatus.NOT_FOUND, _message_page("Not found", f"The viewer lives at {url(self.server.config)}.")
            )
            return
        project = (urllib.parse.parse_qs(parts.query).get("project") or [""])[0]
        try:
            if _code_stamp() != self.server.code:
                raise _Outdated
            body = self._cached(project or None)
        except (_Outdated, db.SchemaTooNewError):
            # This process still runs the code from before an upgrade (and a newer one may have migrated the
            # database). Answer, then exit: launchd or the next session start runs the new code.
            self.server.restart = True  # before the answer: whoever reads it may already check the flag
            self._send(
                HTTPStatus.SERVICE_UNAVAILABLE,
                _message_page("agent-mem was updated", "The viewer restarts with the new version; this page reloads."),
                {"Refresh": "3"},
            )
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        except (sqlite3.Error, OSError, db.MigrationInProgressError) as error:
            self._send(
                HTTPStatus.SERVICE_UNAVAILABLE,
                _message_page(
                    "agent-mem cannot read its memory",
                    f"{type(error).__name__}: {error}. Run `agent-mem doctor` in a terminal; this page retries on reload.",
                ),
                {"Refresh": "10"},
            )
            return
        self._send(HTTPStatus.OK, body)

    def _cached(self, project_id: str | None) -> bytes:
        """The page is rebuilt only when the database changed, at most once a minute otherwise: an open tab reloads
        every few seconds, and a full snapshot costs a third of a second on a 13 MB database."""
        stamp = _db_stamp(self.server.config)
        hit = self.server.cache.get(project_id)
        if hit is not None and hit[0] == stamp and time.monotonic() - hit[1] < 60:
            return hit[2]
        body = self._page(project_id).encode("utf-8")
        if len(self.server.cache) >= 16:  # the key comes from the address; any string must not grow it for good
            self.server.cache.clear()
        self.server.cache[project_id] = (stamp, time.monotonic(), body)
        return body

    def _page(self, project_id: str | None) -> str:
        from agent_mem import ui

        config = self.server.config
        conn = db.connect(config, busy_timeout_ms=5000)
        try:
            known = project_id and conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone()
            snapshot = ui.build_snapshot(conn, config, project_id if known else None)
        finally:
            conn.close()
        return ui.render({**snapshot, "refresh": config.viewer.refresh_seconds, "served": True})


class _Outdated(Exception):
    pass


def _code_stamp() -> tuple[int, ...]:
    """Modification times of the installed package's key files; an upgrade rewrites them."""
    package = Path(__file__).resolve().parents[1]
    files = [package / "__init__.py", package / "ui" / "app.js", package / "ui" / "server.py"]
    files += sorted((package / "core" / "schema").glob("*.sql"))
    stamps = []
    for path in files:
        try:
            stamps.append(path.stat().st_mtime_ns)
        except OSError:
            stamps.append(0)
    return tuple(stamps)


def _db_stamp(config: Config) -> tuple[int, ...]:
    """Changes whenever anything is written: the WAL file grows or a checkpoint rewrites the database."""
    stamps = []
    for path in (config.db_path, Path(f"{config.db_path}-wal")):
        try:
            info = path.stat()
            stamps += [info.st_mtime_ns, info.st_size]
        except OSError:
            stamps += [0, 0]
    return tuple(stamps)


def serve(config: Config, *, quiet: bool = False) -> int:
    try:
        server = _Server(config)
    except OSError as error:
        if running(config):
            if not quiet:
                print(f"The viewer already runs at {url(config)}. Open it with `agent-mem view`.")
            return 0
        print(
            f"Cannot start the viewer on {HOST}:{config.viewer.port}: {error.strerror or error}. "
            f'Another program uses this port; set "viewer": {{"port": <free port>}} in {config.config_path}.',
            file=sys.stderr,
        )
        return 1
    if not quiet:
        print(f"Viewer at {url(config)} (open it with `agent-mem view`). Stop with Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    # EX_TEMPFAIL: launchd and systemd restart a failed run (KeepAlive SuccessfulExit false, Restart=on-failure).
    return 75 if server.restart else 0


# Autostart at login, so the viewer is reachable after a restart without starting an agent first.
LABEL = "io.github.abuarchiv.agent-mem.viewer"


def _argv() -> list[str]:
    executable = Path(sys.executable)
    if sys.platform == "win32" and (executable.parent / "pythonw.exe").exists():
        executable = executable.parent / "pythonw.exe"  # no console window
    return [str(executable), "-m", "agent_mem", "serve", "--quiet"]


def autostart_path() -> Path | None:
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        folder = Path(base) if base else home / "AppData" / "Roaming"
        return folder / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "agent-mem-viewer.cmd"
    if shutil.which("systemctl") is None:
        return None
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else home / ".config") / "systemd" / "user" / "agent-mem-viewer.service"


def _quiet(*argv: str) -> bool:
    try:
        return subprocess.run(argv, capture_output=True, timeout=15, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _launchd_plist(target: Path, argv: list[str], data_dir: str, path: str) -> str:
    return plistlib.dumps(
        {
            "Label": LABEL,
            # Through sh: once `uv tool uninstall` removed the interpreter, the item deletes itself instead of
            # failing every ten seconds for good.
            "ProgramArguments": [
                "/bin/sh",
                "-c",
                f'[ -x "$1" ] && exec "$@"; rm -f {shlex.quote(str(target))}; '
                f"launchctl bootout gui/$(id -u)/{LABEL}; exit 0",
                "agent-mem-viewer",
                *argv,
            ],
            "EnvironmentVariables": {"AGENT_MEM_DATA_DIR": data_dir, "AGENT_MEM_INTERNAL": "1", "PATH": path},
            "RunAtLoad": True,
            # Restart after a crash, not after a clean exit (another viewer already answers).
            "KeepAlive": {"SuccessfulExit": False},
            "ThrottleInterval": 10,
            "ProcessType": "Background",
        }
    ).decode("utf-8")


def _windows_startup(argv: list[str], data_dir: str) -> str:
    quoted = " ".join(f'"{part}"' for part in argv)
    return (
        f'@echo off\r\nset "AGENT_MEM_DATA_DIR={data_dir}"\r\nset AGENT_MEM_INTERNAL=1\r\n'
        # Uninstalled: remove this file instead of showing an error at every login.
        f'if exist "{argv[0]}" (start "" {quoted}) else (del "%~f0")\r\n'
    )


def _systemd_unit(argv: list[str], data_dir: str, path: str) -> str:
    quoted = " ".join('"' + part.replace("\\", "\\\\").replace('"', '\\"') + '"' for part in argv)
    return (
        # Uninstalled: the unit is skipped instead of failing and restarting.
        f"[Unit]\nDescription=agent-mem viewer on 127.0.0.1\nConditionPathExists={argv[0]}\n\n[Service]\n"
        f'Environment="AGENT_MEM_DATA_DIR={data_dir}" AGENT_MEM_INTERNAL=1 "PATH={path}"\nExecStart={quoted}\n'
        "Restart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n"
    )


def _start_login_item(target: Path) -> bool:
    """Hand the written item to the service manager now. Windows has none; its Startup folder runs at login only."""
    if sys.platform == "darwin":
        domain = f"gui/{os.getuid()}"
        _quiet("launchctl", "bootout", f"{domain}/{LABEL}")
        return _quiet("launchctl", "bootstrap", domain, str(target))
    if sys.platform == "win32":
        return False
    return _quiet("systemctl", "--user", "daemon-reload") and _quiet(
        "systemctl", "--user", "enable", "--now", "agent-mem-viewer.service"
    )


def install_autostart(config: Config) -> str:
    """Register the viewer as a login item and start it now. Returns one line for the user."""
    target = autostart_path()
    if target is None:
        return "viewer autostart: no systemd on this machine; add `agent-mem serve --quiet` to your login items."
    argv = _argv()
    data_dir = str(config.data_dir)
    # Login items start with a bare PATH; the health page looks up claude, codex and copilot on it.
    path = os.environ.get("PATH", "")
    if sys.platform == "darwin":
        content = _launchd_plist(target, argv, data_dir, path)
    elif sys.platform == "win32":
        content = _windows_startup(argv, data_dir)
    else:
        content = _systemd_unit(argv, data_dir, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="")
    if env_flag("AGENT_MEM_NO_SPAWN"):
        return f"viewer: login item written to {target} (not started: AGENT_MEM_NO_SPAWN)."
    if not _start_login_item(target) and not running(config):
        from agent_mem.hooks.hook import spawn_viewer

        spawn_viewer(config, force=True)
    return f"viewer: {url(config)}, starts at login ({target})."


def remove_autostart() -> Path | None:
    target = autostart_path()
    if target is None or not target.exists():
        return None
    # The service manager is per user, not per HOME: tests (AGENT_MEM_NO_SPAWN) must not stop the real viewer.
    if sys.platform == "darwin" and not env_flag("AGENT_MEM_NO_SPAWN"):
        _quiet("launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}")
    elif sys.platform not in ("darwin", "win32") and not env_flag("AGENT_MEM_NO_SPAWN"):
        _quiet("systemctl", "--user", "disable", "--now", "agent-mem-viewer.service")
    target.unlink()
    return target
