"""``agent-mem setup <harness> --write`` and ``agent-mem uninstall <harness>``.

Hook files get the **absolute path** of the ``agent-mem`` binary: sessions started from an IDE or a GUI
often have a short ``PATH`` and would not find the bare name. Everything written here is removed
again by :func:`remove`; data stays. Standard library only.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HARNESSES = ("claude", "codex", "copilot", "opencode")
PROVIDERS = ("claude", "codex", "copilot", "ollama")
MARK = "agent-mem"


def binary() -> str:
    """Absolute path of the installed ``agent-mem`` command (falls back to the running interpreter).
    ``AGENT_MEM_EXE``: the Docker launcher on the host, since setup then runs inside the container."""
    found = os.environ.get("AGENT_MEM_EXE") or shutil.which("agent-mem")
    if found:
        return str(Path(found).resolve())
    sibling = Path(sys.executable).with_name("agent-mem.exe" if sys.platform == "win32" else "agent-mem")
    return str(sibling) if sibling.exists() else "agent-mem"


def plugins_dir() -> Path:
    """Plugin files ship inside the wheel (agent_mem/plugins) and live in ./plugins in a checkout."""
    package = Path(__file__).resolve().parents[1]  # src/agent_mem
    packaged = package / "plugins"
    if packaged.is_dir():
        return packaged
    return package.parents[1] / "plugins"


def claude_home() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(override).expanduser() if override else Path.home() / ".claude"


def codex_home() -> Path:
    override = os.environ.get("CODEX_HOME")
    return Path(override).expanduser() if override else Path.home() / ".codex"


def copilot_home() -> Path:
    override = os.environ.get("COPILOT_HOME")
    return Path(override).expanduser() if override else Path.home() / ".copilot"


def opencode_home() -> Path:
    override = os.environ.get("XDG_CONFIG_HOME")
    return (Path(override) if override else Path.home() / ".config") / "opencode"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _load_for_update(path: Path) -> dict[str, Any]:
    """A harness config we are about to rewrite. Unreadable or invalid JSON (a trailing comma, a comment) stops
    setup: reading it as empty and writing it back would delete every setting of the user."""
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SystemExit(
            f"agent-mem: {path} cannot be read as JSON ({error}). Nothing was changed; fix the file and run this again."
        ) from error
    if not isinstance(data, dict):
        raise SystemExit(f"agent-mem: {path} does not hold a JSON object. Nothing was changed.")
    return data


def _write_text(path: Path, text: str) -> None:
    """Atomic, with the previous version kept next to it and the file's permissions unchanged."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".agent-mem-tmp")
    tmp.write_text(text, encoding="utf-8")
    if path.exists():
        shutil.copy2(path, path.with_name(path.name + ".agent-mem-backup"))
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


def _write_json(path: Path, data: dict[str, Any]) -> None:
    _write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def _is_ours(hook: dict[str, Any]) -> bool:
    return any(MARK in str(hook.get(key, "")) for key in ("command", "bash", "powershell"))


def _merge_hooks(existing: dict[str, Any], ours: dict[str, Any]) -> dict[str, Any]:
    """Claude/Codex layout: ``{event: [{matcher?, hooks: [...]}, ...]}``. Ours replace earlier ours."""
    merged = {
        event: [g for g in groups if not all(_is_ours(h) for h in g.get("hooks", []))]
        for event, groups in existing.items()
    }
    for event, groups in ours.items():
        merged.setdefault(event, []).extend(groups)
    return {event: groups for event, groups in merged.items() if groups}


def _strip_hooks(existing: dict[str, Any]) -> dict[str, Any]:
    kept = {}
    for event, groups in existing.items():
        rest = [g for g in groups if not all(_is_ours(h) for h in g.get("hooks", []))]
        if rest:
            kept[event] = rest
    return kept


def _shell(exe: str, key: str) -> str:
    """``exe`` as the first word of a hook command: quoted when it holds a space or another shell character."""
    if not re.search(r"[^\w@%+=:,./\\-]", exe):
        return exe
    if key == "powershell":
        return "& '" + exe.replace("'", "''") + "'"
    return f'"{exe}"' if sys.platform == "win32" else shlex.quote(exe)


def hook_binary(command: str) -> str:
    """The binary a hook command runs, its quoting undone."""
    exe = command.rsplit(" hook ", 1)[0].strip()
    if exe[:1] in {"'", '"'}:
        with contextlib.suppress(ValueError):
            exe = shlex.split(exe)[0]
    return exe


def _plugin_hooks(plugins: Path, harness: str, exe: str) -> dict[str, Any]:
    file = plugins / harness / ("hooks.json" if harness == "codex" else "hooks/hooks.json")
    data = json.loads(file.read_text(encoding="utf-8"))
    for entries in data["hooks"].values():
        for entry in entries:
            for hook in entry.get("hooks", [entry]):
                for key in ("command", "bash", "powershell"):
                    if str(hook.get(key, "")).startswith(f"{MARK} hook"):
                        hook[key] = _shell(exe, key) + hook[key][len(MARK) :]
    return data


# --- write -----------------------------------------------------------------------------------------


def write(harness: str, plugins: Path, exe: str | None = None) -> list[Path]:
    """Register hooks and the MCP server for one harness. Returns the files touched."""
    exe = exe or binary()
    if harness == "claude":
        settings = claude_home() / "settings.json"
        data = _load_for_update(settings)
        data["hooks"] = _merge_hooks(data.get("hooks", {}), _plugin_hooks(plugins, "claude", exe)["hooks"])
        _write_json(settings, data)
        _claude_mcp(exe, add=True)
        return [settings]
    if harness == "codex":
        hooks = codex_home() / "hooks.json"
        data = _load_for_update(hooks)
        data["hooks"] = _merge_hooks(data.get("hooks", {}), _plugin_hooks(plugins, "codex", exe)["hooks"])
        _write_json(hooks, data)
        toml = codex_home() / "config.toml"
        text = toml.read_text(encoding="utf-8") if toml.exists() else ""
        text = _strip_toml(text)
        text = text.rstrip("\n") + ("\n\n" if text.strip() else "") + _toml_block(exe)
        _write_text(toml, text)
        return [hooks, toml]
    if harness == "copilot":
        hooks = copilot_home() / "hooks" / "agent-mem.json"
        _write_json(hooks, _plugin_hooks(plugins, "copilot", exe))
        mcp = copilot_home() / "mcp-config.json"
        data = _load_for_update(mcp)
        servers = data.setdefault("mcpServers", {})
        servers[MARK] = {"type": "local", "command": exe, "args": ["mcp"], "tools": ["*"]}
        _write_json(mcp, data)
        return [hooks, mcp]
    if harness == "opencode":
        target = opencode_home() / "plugins" / "agent-mem.ts"
        source = (plugins / "opencode" / "agent-mem.ts").read_text(encoding="utf-8")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source.replace('spawn("agent-mem"', f"spawn({json.dumps(exe)}"), encoding="utf-8")
        cfg = opencode_home() / "opencode.json"
        data = _load_for_update(cfg)
        data.setdefault("$schema", "https://opencode.ai/config.json")
        data.setdefault("mcp", {})[MARK] = {"type": "local", "command": [exe, "mcp"], "enabled": True}
        _write_json(cfg, data)
        return [target, cfg]
    raise ValueError(f"unknown harness {harness!r}")


def remove(harness: str) -> list[Path]:
    """Undo :func:`write`. Data, config and models stay."""
    touched: list[Path] = []
    if harness == "claude":
        settings = claude_home() / "settings.json"
        data = _load_for_update(settings)
        if "hooks" in data:
            data["hooks"] = _strip_hooks(data["hooks"])
            if not data["hooks"]:
                del data["hooks"]
            _write_json(settings, data)
            touched.append(settings)
        _claude_mcp(None, add=False)
    elif harness == "codex":
        hooks = codex_home() / "hooks.json"
        data = _load_for_update(hooks)
        if "hooks" in data:
            data["hooks"] = _strip_hooks(data["hooks"])
            _write_json(hooks, data)
            touched.append(hooks)
        toml = codex_home() / "config.toml"
        if toml.exists():
            _write_text(toml, _strip_toml(toml.read_text(encoding="utf-8")))
            touched.append(toml)
    elif harness == "copilot":
        hooks = copilot_home() / "hooks" / "agent-mem.json"
        if hooks.exists():
            hooks.unlink()
            touched.append(hooks)
        # The file is agent-mem's own; a second `setup --write` keeps the previous one next to it.
        hooks.with_name(hooks.name + ".agent-mem-backup").unlink(missing_ok=True)
        mcp = copilot_home() / "mcp-config.json"
        data = _load_for_update(mcp)
        if MARK in data.get("mcpServers", {}):
            del data["mcpServers"][MARK]
            _write_json(mcp, data)
            touched.append(mcp)
    elif harness == "opencode":
        plugin = opencode_home() / "plugins" / "agent-mem.ts"
        if plugin.exists():
            plugin.unlink()
            touched.append(plugin)
        cfg = opencode_home() / "opencode.json"
        data = _load_for_update(cfg)
        if MARK in data.get("mcp", {}):
            del data["mcp"][MARK]
            _write_json(cfg, data)
            touched.append(cfg)
    else:
        raise ValueError(f"unknown harness {harness!r}")
    return touched


_TOML_BLOCK = re.compile(r"\n?\[mcp_servers\.agent-mem\]\n(?:[^\[\n][^\n]*\n?)*", re.M)


def _toml_block(exe: str) -> str:
    return f'[mcp_servers.agent-mem]\ncommand = {json.dumps(exe)}\nargs = ["mcp"]\n'


def _strip_toml(text: str) -> str:
    return _TOML_BLOCK.sub("\n", text).strip("\n") + ("\n" if text.strip() else "")


def _claude_mcp(exe: str | None, *, add: bool) -> None:
    """Claude Code keeps user-scope MCP servers in its own file; its CLI is the supported way to edit it."""
    claude = shutil.which("claude")
    if claude is None:
        if add:  # the hooks are written anyway; say that the MCP server is not
            print(
                f"  MCP server not registered (`claude` is not installed). Run: claude mcp add --scope user {MARK} -- {exe} mcp",
                file=sys.stderr,
            )
        return

    def run(*args: str) -> str | None:
        """None when it worked, else the reason."""
        try:
            result = subprocess.run([claude, "mcp", *args], capture_output=True, text=True, timeout=30, check=False)
        except (OSError, subprocess.SubprocessError) as error:
            return f"{type(error).__name__}: {error}"
        return None if result.returncode == 0 else (result.stderr or result.stdout).strip()[-200:]

    # Remove first: `mcp add` refuses an existing name and would keep an entry with an old binary path.
    run("remove", "--scope", "user", MARK)
    if not add:
        return
    failure = run("add", "--scope", "user", MARK, "--", str(exe), "mcp")
    if failure:
        print(
            f"  MCP server not registered ({failure}). Run: claude mcp add --scope user {MARK} -- {exe} mcp",
            file=sys.stderr,
        )


# --- detection -------------------------------------------------------------------------------------


def hook_commands(harness: str) -> list[str]:
    """Commands our hooks would run for this harness as currently installed (for ``doctor``)."""
    found: list[str] = []
    if harness == "claude":
        groups = _read_json(claude_home() / "settings.json").get("hooks", {})
    elif harness == "codex":
        groups = _read_json(codex_home() / "hooks.json").get("hooks", {})
    elif harness == "copilot":
        groups = _read_json(copilot_home() / "hooks" / "agent-mem.json").get("hooks", {})
        return sorted({str(h.get("bash", "")) for entries in groups.values() for h in entries if _is_ours(h)})
    else:
        plugin = opencode_home() / "plugins" / "agent-mem.ts"
        match = re.search(r'spawn\(("[^"]+")', plugin.read_text(encoding="utf-8")) if plugin.exists() else None
        return [json.loads(match.group(1)) + " hook opencode"] if match else []
    for entries in groups.values():
        for group in entries:
            found.extend(str(h["command"]) for h in group.get("hooks", []) if _is_ours(h))
    return sorted(set(found))


def claude_plugin_enabled() -> bool:
    """The marketplace plugin is on as well: then it and ``setup --write`` both run every hook."""
    enabled = _read_json(claude_home() / "settings.json").get("enabledPlugins", {})
    return any(name.split("@")[0] == MARK and on for name, on in enabled.items())


def stale(harness: str) -> bool:
    """Our registered hooks differ from the ones this release ships (an event, matcher or timeout changed since
    ``setup --write``). Compared at the binary path they already use, so only the shipped content counts."""
    commands = hook_commands(harness)
    if not commands:
        return False
    exe = hook_binary(commands[0])
    plugins = plugins_dir()
    if harness == "opencode":
        shipped = (plugins / "opencode" / "agent-mem.ts").read_text(encoding="utf-8")
        current = (opencode_home() / "plugins" / "agent-mem.ts").read_text(encoding="utf-8")
        return current != shipped.replace('spawn("agent-mem"', f"spawn({json.dumps(exe)}")
    want = _plugin_hooks(plugins, harness, exe)
    if harness == "copilot":
        return _read_json(copilot_home() / "hooks" / "agent-mem.json") != want
    path = claude_home() / "settings.json" if harness == "claude" else codex_home() / "hooks.json"
    ours = {
        event: [g for g in groups if all(_is_ours(h) for h in g.get("hooks", []))]
        for event, groups in _read_json(path).get("hooks", {}).items()
    }
    return {event: groups for event, groups in ours.items() if groups} != want["hooks"]


# --- version and upgrade ---------------------------------------------------------------------------


def origin() -> dict[str, Any]:
    """Where this copy was installed from (PEP 610 ``direct_url.json``), empty for an install from an index."""
    from importlib import metadata

    try:
        text = metadata.distribution("agent-mem").read_text("direct_url.json")
        return json.loads(text) if text else {}
    except (metadata.PackageNotFoundError, ValueError):
        return {}


def version() -> str:
    """``1.0.0 (9436f94)`` for a git install: releases are rare, the commit says which build runs."""
    from agent_mem import __version__

    commit = origin().get("vcs_info", {}).get("commit_id")
    return f"{__version__} ({commit[:7]})" if commit else __version__


def upgrade_command(add: list[str] | tuple[str, ...] = ()) -> list[str] | None:
    """The uv call that moves this copy to the newest commit of its source, extras kept plus ``add``. None when it was not
    installed with ``uv tool``. ``uv tool install --upgrade`` swaps the environment in place; ``--reinstall``
    deletes it first and hooks fired in those seconds find no binary."""
    uv = shutil.which("uv")
    if uv is None or not (Path(sys.prefix) / "uv-receipt.toml").exists():
        return None
    present = extras()
    wanted = [name for name in present if present[name] or name in add]
    spec = f"agent-mem[{','.join(wanted)}]" if wanted else "agent-mem"
    source = origin()
    vcs = source.get("vcs_info", {})
    if vcs.get("vcs") != "git":
        return [uv, "tool", "install", "--upgrade", spec] if add else [uv, "tool", "upgrade", "agent-mem"]
    url = source["url"]
    ref = vcs.get("requested_revision")
    if ref and ref != vcs.get("commit_id"):  # a branch or tag stays; a pinned commit would never move
        url += f"@{ref}"
    return [uv, "tool", "install", "--upgrade", f"{spec} @ git+{url}"]


def extras() -> dict[str, bool]:
    import importlib.util

    return {
        "semantic": importlib.util.find_spec("fastembed") is not None,
        "observer": importlib.util.find_spec("mem0") is not None,
    }


def detect() -> dict[str, Any]:
    return {
        "binary": binary(),
        "harnesses": {name: shutil.which(name) for name in HARNESSES},
        "providers": {name: shutil.which(name) for name in PROVIDERS},
        "extras": extras(),
    }
