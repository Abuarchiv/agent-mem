"""``agent-mem setup <harness> --write`` and ``agent-mem uninstall <harness>`` (docs/PLAN.md §14, I2 to I6).

Hook files get the **absolute path** of the ``agent-mem`` binary: sessions started from an IDE or a GUI
often have a short ``PATH`` and would not find the bare name (I2). Everything written here is removed
again by :func:`remove`; data stays. Standard library only.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HARNESSES = ("claude", "codex", "copilot", "opencode")
PROVIDERS = ("claude", "codex", "copilot", "ollama")
MARK = "agent-mem"


def binary() -> str:
    """Absolute path of the installed ``agent-mem`` command (falls back to the running interpreter)."""
    found = shutil.which("agent-mem")
    if found:
        return str(Path(found).resolve())
    sibling = Path(sys.executable).with_name("agent-mem.exe" if sys.platform == "win32" else "agent-mem")
    return str(sibling) if sibling.exists() else "agent-mem"


def claude_home() -> Path:
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(override).expanduser() if override else Path.home() / ".claude"


def codex_home() -> Path:
    override = os.environ.get("CODEX_HOME")
    return Path(override).expanduser() if override else Path.home() / ".codex"


def copilot_home() -> Path:
    return Path.home() / ".copilot"


def opencode_home() -> Path:
    override = os.environ.get("XDG_CONFIG_HOME")
    return (Path(override) if override else Path.home() / ".config") / "opencode"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


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


def _plugin_hooks(plugins: Path, harness: str, exe: str) -> dict[str, Any]:
    file = plugins / harness / ("hooks.json" if harness == "codex" else "hooks/hooks.json")
    text = file.read_text(encoding="utf-8").replace(f'"{MARK} hook', f'"{json.dumps(exe)[1:-1]} hook')
    return json.loads(text)


# --- write -----------------------------------------------------------------------------------------


def write(harness: str, plugins: Path, exe: str | None = None) -> list[Path]:
    """Register hooks and the MCP server for one harness. Returns the files touched."""
    exe = exe or binary()
    if harness == "claude":
        settings = claude_home() / "settings.json"
        data = _read_json(settings)
        data["hooks"] = _merge_hooks(data.get("hooks", {}), _plugin_hooks(plugins, "claude", exe)["hooks"])
        _write_json(settings, data)
        _claude_mcp(exe, add=True)
        return [settings]
    if harness == "codex":
        hooks = codex_home() / "hooks.json"
        data = _read_json(hooks)
        data["hooks"] = _merge_hooks(data.get("hooks", {}), _plugin_hooks(plugins, "codex", exe)["hooks"])
        _write_json(hooks, data)
        toml = codex_home() / "config.toml"
        text = toml.read_text(encoding="utf-8") if toml.exists() else ""
        text = _strip_toml(text)
        text = text.rstrip("\n") + ("\n\n" if text.strip() else "") + _toml_block(exe)
        toml.parent.mkdir(parents=True, exist_ok=True)
        toml.write_text(text, encoding="utf-8")
        return [hooks, toml]
    if harness == "copilot":
        hooks = copilot_home() / "hooks" / "agent-mem.json"
        _write_json(hooks, _plugin_hooks(plugins, "copilot", exe))
        mcp = copilot_home() / "mcp-config.json"
        data = _read_json(mcp)
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
        data = _read_json(cfg)
        data.setdefault("$schema", "https://opencode.ai/config.json")
        data.setdefault("mcp", {})[MARK] = {"type": "local", "command": [exe, "mcp"], "enabled": True}
        _write_json(cfg, data)
        return [target, cfg]
    raise ValueError(f"unknown harness {harness!r}")


def remove(harness: str) -> list[Path]:
    """Undo :func:`write`. Data, config and models stay (I6)."""
    touched: list[Path] = []
    if harness == "claude":
        settings = claude_home() / "settings.json"
        data = _read_json(settings)
        if "hooks" in data:
            data["hooks"] = _strip_hooks(data["hooks"])
            if not data["hooks"]:
                del data["hooks"]
            _write_json(settings, data)
            touched.append(settings)
        _claude_mcp(None, add=False)
    elif harness == "codex":
        hooks = codex_home() / "hooks.json"
        data = _read_json(hooks)
        if "hooks" in data:
            data["hooks"] = _strip_hooks(data["hooks"])
            _write_json(hooks, data)
            touched.append(hooks)
        toml = codex_home() / "config.toml"
        if toml.exists():
            toml.write_text(_strip_toml(toml.read_text(encoding="utf-8")), encoding="utf-8")
            touched.append(toml)
    elif harness == "copilot":
        hooks = copilot_home() / "hooks" / "agent-mem.json"
        if hooks.exists():
            hooks.unlink()
            touched.append(hooks)
        mcp = copilot_home() / "mcp-config.json"
        data = _read_json(mcp)
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
        data = _read_json(cfg)
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
        return
    cmd = (
        [claude, "mcp", "add", "--scope", "user", MARK, "--", str(exe), "mcp"]
        if add
        else [claude, "mcp", "remove", "--scope", "user", MARK]
    )
    with open(os.devnull, "w") as sink:
        subprocess.run(cmd, stdout=sink, stderr=sink, check=False, timeout=30)


# --- detection (I4) --------------------------------------------------------------------------------


def hook_commands(harness: str) -> list[str]:
    """Commands our hooks would run for this harness as currently installed (for ``doctor``, I5)."""
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
