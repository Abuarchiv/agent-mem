"""Start the viewer at login: a launchd agent (macOS), a systemd user unit (Linux), a Startup script (Windows)."""

from __future__ import annotations

import os
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from agent_mem.core.config import Config, env_flag
from agent_mem.ui.server import running, url

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
