"""Plugin manifests stay consistent with the package: valid JSON, same version, known events."""

import json
import re
from pathlib import Path

from agent_mem import __version__
from agent_mem.normalize import claude, copilot, opencode

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT / "plugins"


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_versions_match_package():
    manifests = [
        PLUGINS / "claude" / ".claude-plugin" / "plugin.json",
        PLUGINS / "codex" / ".codex-plugin" / "plugin.json",
        PLUGINS / "copilot" / "plugin.json",
    ]
    for manifest in manifests:
        assert _json(manifest)["version"] == __version__, manifest
    marketplaces = {
        ".claude-plugin/marketplace.json": "./plugins/claude",
        ".agents/plugins/marketplace.json": "./plugins/codex",
        ".github/plugin/marketplace.json": "./plugins/copilot",
    }
    for path, source in marketplaces.items():
        entry = _json(ROOT / path)["plugins"][0]
        assert entry["version"] == __version__, path
        location = entry["source"]["path"] if isinstance(entry["source"], dict) else entry["source"]
        assert location == source and (ROOT / location).is_dir(), path
    pyproject = (ROOT / "pyproject.toml").read_text()
    assert f'version = "{__version__}"' in pyproject


def test_claude_hooks_cover_supported_events():
    hooks = _json(PLUGINS / "claude" / "hooks" / "hooks.json")["hooks"]
    assert set(hooks) == set(claude._KINDS)
    for groups in hooks.values():
        for group in groups:
            for hook in group["hooks"]:
                assert hook["command"] == "agent-mem hook claude"


def test_codex_hooks_use_codex_normalizer():
    manifest = _json(PLUGINS / "codex" / ".codex-plugin" / "plugin.json")
    assert manifest["hooks"] == "./hooks.json" and manifest["mcpServers"] == "./.mcp.json"
    hooks = _json(PLUGINS / "codex" / "hooks.json")["hooks"]
    assert set(hooks) <= set(claude._KINDS) | {"PostCompact"}
    assert {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"} <= set(hooks)
    commands = {h["command"] for groups in hooks.values() for g in groups for h in g["hooks"]}
    assert commands == {"agent-mem hook codex"}


def test_copilot_hooks_pass_event_name():
    manifest = _json(PLUGINS / "copilot" / "plugin.json")
    hooks = _json(PLUGINS / "copilot" / manifest["hooks"])["hooks"]
    assert set(hooks) == set(copilot._KINDS)
    for event, entries in hooks.items():
        assert entries[0]["bash"] == f"agent-mem hook copilot {event}"
        assert entries[0]["powershell"] == f"agent-mem hook copilot {event}"


def test_opencode_plugin_events_match_normalizer():
    source = (PLUGINS / "opencode" / "agent-mem.ts").read_text()
    used = set(re.findall(r'callHook\("([a-z.]+)"', source))
    assert used <= set(opencode._KINDS)
    assert {"session.start", "chat.message", "tool.before", "tool.after", "session.idle"} <= used


def test_mcp_configs_start_the_server():
    for path in PLUGINS.rglob(".mcp.json"):
        server = _json(path)["mcpServers"]["agent-mem"]
        assert server["command"] == "agent-mem" and server["args"] == ["mcp"]
