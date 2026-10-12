"""``setup --write`` and ``uninstall`` (docs/PLAN.md §14, I2 and I6): absolute binary path, clean removal."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_mem.cli import install

PLUGINS = Path(__file__).resolve().parents[1] / "plugins"
EXE = "/opt/agent-mem/bin/agent-mem"


@pytest.fixture
def homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / ".codex"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    monkeypatch.setattr(install.shutil, "which", lambda name: None)  # no `claude mcp add` subprocess
    return tmp_path


def _hooks_commands(hooks: dict) -> set[str]:
    return {h["command"] for groups in hooks.values() for g in groups for h in g["hooks"]}


def test_claude_hooks_get_absolute_path_and_keep_foreign_hooks(homes: Path) -> None:
    settings = homes / ".claude" / "settings.json"
    settings.parent.mkdir()
    foreign = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "other-tool notify"}]}]}, "theme": "dark"}
    settings.write_text(json.dumps(foreign))

    install.write("claude", PLUGINS, EXE)
    data = json.loads(settings.read_text())
    assert data["theme"] == "dark"
    commands = _hooks_commands(data["hooks"])
    assert f"{EXE} hook claude" in commands and "other-tool notify" in commands
    assert "agent-mem hook claude" not in commands  # never the bare name (I2)
    assert install.hook_commands("claude") == [f"{EXE} hook claude"]

    install.write("claude", PLUGINS, EXE)  # idempotent
    assert len(json.loads(settings.read_text())["hooks"]["Stop"]) == 2

    install.remove("claude")
    data = json.loads(settings.read_text())
    assert _hooks_commands(data["hooks"]) == {"other-tool notify"} and data["theme"] == "dark"


def test_codex_hooks_and_toml_block(homes: Path) -> None:
    toml = homes / ".codex" / "config.toml"
    toml.parent.mkdir()
    toml.write_text('model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n')
    install.write("codex", PLUGINS, EXE)
    text = toml.read_text()
    assert "[mcp_servers.agent-mem]" in text and f'command = "{EXE}"' in text and "[mcp_servers.other]" in text
    hooks = json.loads((homes / ".codex" / "hooks.json").read_text())["hooks"]
    assert _hooks_commands(hooks) == {f"{EXE} hook codex"}

    install.write("codex", PLUGINS, EXE)
    assert toml.read_text().count("[mcp_servers.agent-mem]") == 1

    install.remove("codex")
    assert "agent-mem" not in toml.read_text() and "[mcp_servers.other]" in toml.read_text()
    assert json.loads((homes / ".codex" / "hooks.json").read_text())["hooks"] == {}


def test_copilot_and_opencode_files(homes: Path) -> None:
    install.write("copilot", PLUGINS, EXE)
    hooks = json.loads((homes / ".copilot" / "hooks" / "agent-mem.json").read_text())["hooks"]
    assert hooks["sessionStart"][0]["bash"] == f"{EXE} hook copilot sessionStart"
    mcp = json.loads((homes / ".copilot" / "mcp-config.json").read_text())
    assert mcp["mcpServers"]["agent-mem"]["command"] == EXE
    assert install.hook_commands("copilot")[0].startswith(EXE)

    install.write("opencode", PLUGINS, EXE)
    plugin = (homes / ".config" / "opencode" / "plugins" / "agent-mem.ts").read_text()
    assert f'spawn("{EXE}"' in plugin and 'spawn("agent-mem"' not in plugin
    cfg = json.loads((homes / ".config" / "opencode" / "opencode.json").read_text())
    assert cfg["mcp"]["agent-mem"]["command"] == [EXE, "mcp"]
    assert install.hook_commands("opencode") == [f"{EXE} hook opencode"]

    for harness in ("copilot", "opencode"):
        install.remove(harness)
        assert install.hook_commands(harness) == []
    assert not (homes / ".copilot" / "hooks" / "agent-mem.json").exists()
    assert "agent-mem" not in json.loads((homes / ".config" / "opencode" / "opencode.json").read_text())["mcp"]


def test_detect_reports_binary_and_extras(homes: Path) -> None:
    found = install.detect()
    assert set(found["harnesses"]) == set(install.HARNESSES)
    assert set(found["extras"]) == {"semantic", "observer"}
    assert found["binary"]


def test_setup_all_writes_only_harnesses_on_path(homes: Path, config, monkeypatch, capsys) -> None:
    import argparse

    from agent_mem.cli import commands

    monkeypatch.setattr(install.shutil, "which", lambda name: "/usr/bin/codex" if name == "codex" else None)
    config.viewer.enabled = False
    ns = argparse.Namespace(harness="all", write=True, no_models=True)
    assert commands.cmd_setup(ns, config) == 0
    assert (homes / ".codex" / "hooks.json").exists()
    assert not (homes / ".claude" / "settings.json").exists() and not (homes / ".copilot").exists()

    commands.cmd_uninstall(argparse.Namespace(harness="all"), config)
    assert install.hook_commands("codex") == []

    monkeypatch.setattr(install.shutil, "which", lambda name: None)
    assert commands.cmd_setup(ns, config) == 1
    assert "No harness on PATH" in capsys.readouterr().out


def test_setup_never_rewrites_a_config_it_cannot_parse(homes: Path) -> None:
    settings = homes / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    broken = '{\n  "model": "opus",\n  "permissions": {"allow": ["Bash(git status)"]},\n}\n'  # trailing comma
    settings.write_text(broken)
    with pytest.raises(SystemExit, match="cannot be read as JSON"):
        install.write("claude", PLUGINS, EXE)
    with pytest.raises(SystemExit):
        install.remove("claude")
    assert settings.read_text() == broken


def test_setup_keeps_permissions_and_a_backup(homes: Path) -> None:
    import stat

    settings = homes / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text('{"model": "opus"}')
    settings.chmod(0o600)
    install.write("claude", PLUGINS, EXE)
    assert stat.S_IMODE(settings.stat().st_mode) == 0o600
    assert json.loads(settings.read_text())["model"] == "opus"
    backup = settings.with_name("settings.json.agent-mem-backup")
    assert json.loads(backup.read_text()) == {"model": "opus"}
    toml = homes / ".codex" / "config.toml"
    toml.parent.mkdir(parents=True, exist_ok=True)
    toml.write_text('model = "gpt"\n')
    install.write("codex", PLUGINS, EXE)
    assert toml.read_text().startswith('model = "gpt"') and "[mcp_servers.agent-mem]" in toml.read_text()
    assert toml.with_name("config.toml.agent-mem-backup").read_text() == 'model = "gpt"\n'
