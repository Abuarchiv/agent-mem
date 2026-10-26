"""``setup --write`` and ``uninstall``: absolute binary path, clean removal."""

from __future__ import annotations

import json
import subprocess
import sys
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
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path / ".copilot"))
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
    assert "agent-mem hook claude" not in commands  # never the bare name
    assert install.hook_commands("claude") == [f"{EXE} hook claude"]

    install.write("claude", PLUGINS, EXE)  # idempotent
    assert len(json.loads(settings.read_text())["hooks"]["Stop"]) == 2

    install.remove("claude")
    data = json.loads(settings.read_text())
    assert _hooks_commands(data["hooks"]) == {"other-tool notify"} and data["theme"] == "dark"


def test_foreign_hooks_that_merely_name_agent_mem_survive(homes: Path) -> None:
    """A user's hook from a folder called agent-mem or a tool called agent-memory is theirs, not ours."""
    settings = homes / ".claude" / "settings.json"
    settings.parent.mkdir()
    foreign = ["~/agent-memory-system/hook.sh", "~/Company/agent-mem/scripts/lint.sh", "agent-mem-sync hook push"]
    groups = [{"hooks": [{"type": "command", "command": command}]} for command in foreign]
    settings.write_text(json.dumps({"hooks": {"Stop": groups}}))

    install.write("claude", PLUGINS, EXE)
    install.remove("claude")
    assert _hooks_commands(json.loads(settings.read_text())["hooks"]) == set(foreign)
    for ours in (
        "agent-mem hook claude",
        "'/my tools/agent-mem' hook claude",
        "& 'C:\\a\\agent-mem.exe' hook copilot x",
    ):
        assert install._is_ours({"command": ours})


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
    assert "No agent installed here" in capsys.readouterr().out


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
    if sys.platform != "win32":  # Windows has no Unix permission bits
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


@pytest.mark.skipif(sys.platform == "win32", reason="the fake claude CLI is a shell script")
def test_claude_mcp_entry_is_replaced_and_a_failure_is_reported(homes: Path, monkeypatch, capsys) -> None:
    log = homes / "claude.log"
    fake = homes / "claude"
    fake.write_text(f'#!/bin/sh\necho "$@" >> {log}\n[ "$2" = add ] && {{ echo "boom" >&2; exit 1; }}\nexit 0\n')
    fake.chmod(0o755)
    monkeypatch.setattr(install.shutil, "which", lambda name: str(fake) if name == "claude" else None)
    install.write("claude", PLUGINS, EXE)
    calls = log.read_text().splitlines()
    assert calls[0].startswith("mcp remove --scope user agent-mem") and calls[1].startswith("mcp add --scope user")
    err = capsys.readouterr().err
    assert "MCP server not registered (boom)" in err and "claude mcp add --scope user agent-mem" in err
    monkeypatch.setattr(install.shutil, "which", lambda name: None)
    install.write("claude", PLUGINS, EXE)  # "hooks and MCP server registered" without a word that MCP was not
    assert "MCP server not registered (`claude` is not installed)" in capsys.readouterr().err


def test_hooks_of_an_older_release_are_found_and_doctor_fix_rewrites_them(homes: Path) -> None:
    from agent_mem.cli.health import LABELS, _hook_checks

    exe = homes / "bin" / "agent-mem"
    exe.parent.mkdir()
    exe.write_text("")
    for harness in install.HARNESSES:
        install.write(harness, PLUGINS, str(exe))
        assert not install.stale(harness)

    settings = homes / ".claude" / "settings.json"
    data = json.loads(settings.read_text())
    data["hooks"]["Stop"][0]["hooks"][0]["timeout"] = 99  # a release since changed this timeout
    data["hooks"]["Stop"].insert(0, {"hooks": [{"type": "command", "command": "other-tool notify"}]})
    settings.write_text(json.dumps(data))
    codex = homes / ".codex" / "hooks.json"
    data = json.loads(codex.read_text())
    del data["hooks"]["PreCompact"]  # a release since added this event
    codex.write_text(json.dumps(data))
    copilot = homes / ".copilot" / "hooks" / "agent-mem.json"
    copilot.write_text(copilot.read_text().replace('"timeoutSec"', '"timeout_sec"'))
    plugin = homes / ".config" / "opencode" / "plugins" / "agent-mem.ts"
    plugin.write_text(plugin.read_text() + "\n// older\n")
    assert all(install.stale(harness) for harness in install.HARNESSES)

    shown = {c.name: c for c in _hook_checks(fix=False)}
    assert not shown["Claude Code hooks up to date"].ok and "older" in shown["Claude Code hooks up to date"].detail

    fixed = {c.name: c for c in _hook_checks(fix=True)}
    assert all(fixed[f"{LABELS[h]} hooks up to date"].ok for h in install.HARNESSES)
    assert "/hooks" in fixed["Codex hooks up to date"].detail
    (copilot_line,) = [c for c in _hook_checks(fix=False) if c.name == "Copilot CLI hook command"]
    assert (
        copilot_line.ok and copilot_line.detail.startswith(f"{exe} hook copilot (") and "events)" in copilot_line.detail
    )
    assert not any(install.stale(harness) for harness in install.HARNESSES)
    assert install.hook_commands("claude") == [f"{exe} hook claude"]  # the path they used, not this test's binary
    assert "other-tool notify" in _hooks_commands(json.loads(settings.read_text())["hooks"])


def test_upgrade_moves_to_the_head_of_the_source_and_keeps_extras(
    homes: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(install.shutil, "which", lambda name: "/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(install.sys, "prefix", str(tmp_path))
    monkeypatch.setattr(install, "extras", lambda: {"semantic": True, "observer": False})
    assert install.upgrade_command() is None  # not a `uv tool` environment
    (tmp_path / "uv-receipt.toml").write_text("")

    url = "https://github.com/Abuarchiv/agent-mem"
    pinned = {"url": url, "vcs_info": {"vcs": "git", "commit_id": "abc1234def", "requested_revision": "abc1234def"}}
    monkeypatch.setattr(install, "origin", lambda: pinned)
    assert install.upgrade_command() == ["/bin/uv", "tool", "install", "--upgrade", f"agent-mem[semantic] @ git+{url}"]
    assert install.version().endswith("(abc1234)")

    branch = {"url": url, "vcs_info": {"vcs": "git", "commit_id": "abc1234def", "requested_revision": "beta"}}
    monkeypatch.setattr(install, "origin", lambda: branch)
    assert install.upgrade_command()[-1] == f"agent-mem[semantic] @ git+{url}@beta"

    monkeypatch.setattr(install, "origin", dict)
    assert install.upgrade_command() == ["/bin/uv", "tool", "upgrade", "agent-mem"]


def test_upgrade_adds_extras_on_request(homes: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(install.shutil, "which", lambda name: "/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(install.sys, "prefix", str(tmp_path))
    (tmp_path / "uv-receipt.toml").write_text("")
    monkeypatch.setattr(install, "extras", lambda: {"semantic": False, "observer": False})
    monkeypatch.setattr(install, "origin", lambda: {"url": "https://x/agent-mem", "vcs_info": {"vcs": "git"}})
    assert install.upgrade_command(["observer"])[-1] == "agent-mem[observer] @ git+https://x/agent-mem"
    assert install.upgrade_command()[-1] == "agent-mem @ git+https://x/agent-mem"
    monkeypatch.setattr(install, "origin", dict)  # from an index: `uv tool upgrade` cannot add extras
    assert install.upgrade_command(["semantic"]) == ["/bin/uv", "tool", "install", "--upgrade", "agent-mem[semantic]"]


def test_plugin_and_setup_write_together_are_reported(homes: Path) -> None:
    from agent_mem.cli.health import _hook_checks

    install.write("claude", PLUGINS, EXE)
    assert not install.claude_plugin_enabled()
    settings = homes / ".claude" / "settings.json"
    data = json.loads(settings.read_text())
    data["enabledPlugins"] = {"agent-mem@agent-mem": True, "other@x": True}
    settings.write_text(json.dumps(data))
    assert install.claude_plugin_enabled()
    assert not {c.name: c for c in _hook_checks(fix=False)}["Claude Code connected once"].ok


def test_upgrade_runs_models_and_doctor_with_the_new_binary(config, monkeypatch, capsys) -> None:
    import argparse
    import subprocess

    from agent_mem.cli import commands

    monkeypatch.setattr(install, "upgrade_command", lambda add=(): ["/bin/uv", "tool", "install", "x"])
    monkeypatch.setattr(install, "extras", lambda: {"semantic": True, "observer": True})
    versions = iter(["1.0.0 (aaaaaaa)"])
    monkeypatch.setattr(install, "version", lambda: next(versions))
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        out = "agent-mem 1.0.0 (bbbbbbb)\n" if argv[-1] == "--version" else ""
        return subprocess.CompletedProcess(argv, 0, stdout=out)

    monkeypatch.setattr(subprocess, "run", run)
    assert commands.cmd_upgrade(argparse.Namespace(extras=[]), config) == 0
    assert calls[0] == ["/bin/uv", "tool", "install", "x"]
    assert [c[-2:] for c in calls[2:]] == [["models", "install"], ["doctor", "--fix"]]
    assert all(c[0].endswith(("agent-mem", "agent-mem.exe")) for c in calls[1:])
    assert "1.0.0 (aaaaaaa) -> 1.0.0 (bbbbbbb)" in capsys.readouterr().out


def test_stale_hooks_reach_the_session_start_panel_through_the_indexer(homes: Path, config) -> None:
    from agent_mem.cli import main
    from agent_mem.core import db
    from agent_mem.hooks.hook import problems

    exe = homes / "bin" / "agent-mem"
    exe.parent.mkdir()
    exe.write_text("")
    install.write("claude", PLUGINS, str(exe))
    settings = homes / ".claude" / "settings.json"
    data = json.loads(settings.read_text())
    data["hooks"]["Stop"][0]["hooks"][0]["timeout"] = 99  # written by an older release
    settings.write_text(json.dumps(data))

    data_dir = ["--data-dir", str(config.data_dir)]
    assert main([*data_dir, "index", "--quiet", "--no-download"]) == 0  # what the hooks spawn
    conn = db.connect(config)
    try:
        shown = problems(conn)
        assert any("Claude Code connection" in line and "doctor --fix" in line for line in shown)
    finally:
        conn.close()

    assert main([*data_dir, "doctor", "--fix"]) in (0, 1)
    conn = db.connect(config)
    try:
        assert not any("Claude Code connection" in line for line in problems(conn))
    finally:
        conn.close()


@pytest.mark.skipif(sys.platform == "win32", reason="runs the hook command through sh")
def test_a_binary_path_with_a_space_is_quoted_and_read_back(homes: Path) -> None:
    """Unquoted, `/Users/a b/.local/bin/agent-mem hook claude` would run `/Users/a`."""
    exe = homes / "my apps" / "agent-mem"
    exe.parent.mkdir()
    exe.write_text('#!/bin/sh\necho "ran $*"\n')
    exe.chmod(0o755)
    for harness in ("claude", "codex", "copilot"):
        install.write(harness, PLUGINS, str(exe))
        command = install.hook_commands(harness)[0]
        assert install.hook_binary(command) == str(exe) and not install.stale(harness)
        ran = subprocess.run(["sh", "-c", command], capture_output=True, text=True, check=True)
        assert ran.stdout.startswith(f"ran hook {harness}")
    powershell = json.loads((homes / ".copilot" / "hooks" / "agent-mem.json").read_text())["hooks"]["agentStop"]
    assert powershell[0]["powershell"] == f"& '{exe}' hook copilot agentStop"


def test_uninstall_leaves_no_copy_of_agent_mems_own_copilot_hooks(homes: Path) -> None:
    """A second `setup --write` keeps the previous hooks file as `agent-mem.json.agent-mem-backup`; uninstall removes
    it from ~/.copilot/hooks. The user's own files keep their backups."""
    install.write("copilot", PLUGINS, EXE)
    install.write("copilot", PLUGINS, EXE)
    hooks = homes / ".copilot" / "hooks"
    assert (hooks / "agent-mem.json.agent-mem-backup").exists()
    install.remove("copilot")
    assert list(hooks.iterdir()) == []


def test_docker_install_points_hooks_at_its_launcher(homes: Path, monkeypatch) -> None:
    """setup runs inside the container for a Docker install; the hooks must start the launcher on the host."""
    launcher = homes / ".local" / "bin" / "agent-mem"
    launcher.parent.mkdir(parents=True)
    launcher.write_text("#!/bin/sh\n")
    monkeypatch.setenv("AGENT_MEM_EXE", str(launcher))
    assert install.binary() == str(launcher)
    install.write("claude", PLUGINS)
    assert install.hook_commands("claude") == [f"{launcher} hook claude"]


def test_docker_setup_says_only_what_holds_on_the_host(homes: Path, config, monkeypatch, capsys) -> None:
    """Inside the container no agent is installed and there is no login item; setup must not claim either."""
    import argparse

    from agent_mem.cli import commands

    monkeypatch.setenv("AGENT_MEM_EXE", str(homes / "agent-mem"))
    ns = argparse.Namespace(harness="codex", write=True, no_models=False)
    assert commands.cmd_setup(ns, config) == 0
    out = capsys.readouterr().out
    assert f"registered with {homes / 'agent-mem'}" in out
    assert "Detected" not in out and "not installed" not in out and "autostart" not in out


def test_models_can_live_outside_the_data_folder(config, monkeypatch, tmp_path: Path) -> None:
    """The Docker image ships the models; in the memory volume a newer image could never replace them."""
    assert config.model_dir == config.data_dir / "models"
    monkeypatch.setenv("AGENT_MEM_MODEL_DIR", str(tmp_path / "image-models"))
    assert config.model_dir == tmp_path / "image-models"
