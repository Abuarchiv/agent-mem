"""Install lifecycle commands: models, setup, uninstall, upgrade."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

from agent_mem.core.config import Config
from agent_mem.core.harness import HARNESSES
from agent_mem.ui import autostart

SETUP = {
    "claude": """Claude Code
  1. /plugin marketplace add Abuarchiv/agent-mem
  2. /plugin install agent-mem@agent-mem
  3. Restart Claude Code. Hooks and the MCP server are registered by the plugin.
  Manual alternative: copy the "hooks" object from {plugins}/claude/hooks/hooks.json into
  ~/.claude/settings.json and run `claude mcp add agent-mem -- agent-mem mcp`.""",
    "codex": """Codex CLI
  1. codex plugin marketplace add Abuarchiv/agent-mem
  2. codex plugin add agent-mem@agent-mem
  3. Start codex and trust the hooks once with /hooks (Codex requires this review).
  Manual alternative: merge {plugins}/codex/hooks.json into ~/.codex/hooks.json and add to ~/.codex/config.toml:
    [mcp_servers.agent-mem]
    command = "agent-mem"
    args = ["mcp"]""",
    "copilot": """GitHub Copilot CLI
  1. Inside copilot: /plugin marketplace add Abuarchiv/agent-mem, then /plugin install agent-mem@agent-mem
     (or install the bundled copy by path: /plugin install {plugins}/copilot)
  Manual alternative: copy {plugins}/copilot/hooks/hooks.json to ~/.copilot/hooks/agent-mem.json and add the
  MCP server with /mcp add (command: agent-mem, args: mcp).""",
    "opencode": """OpenCode
  1. agent-mem setup opencode --write      (copies the plugin to ~/.config/opencode/plugins/agent-mem.ts)
  2. Add to ~/.config/opencode/opencode.json:
     "mcp": {{ "agent-mem": {{ "type": "local", "command": ["agent-mem", "mcp"], "enabled": true }} }}
  Run OpenCode sessions serially per repository (upstream snapshot lock).""",
}


def cmd_models(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.memory import semantic

    embedder, reason = semantic.load_embedder_verbose(config, allow_download=ns.action == "install")
    if embedder is None:
        print(f"Search by meaning is not available: {reason}. Search by words keeps working.")
        return 1 if ns.action == "install" else 0
    print(f"Model ready: {embedder.model} (cache {config.model_dir}).")
    from agent_mem.cli import install

    if not install.extras()["observer"]:
        return 0
    from agent_mem.observe import spacy_model

    name = config.observe.entity_model
    path = spacy_model.model_path(config)
    if path is None and ns.action == "install":
        try:
            path = spacy_model.download_model(config)
        except (OSError, ValueError) as error:
            print(f"Topic model {name} not downloaded: {error}. Facts still work, they are just not linked by topic.")
            return 1
    print(
        f"Topic model {'ready: ' + name + f' ({path})' if path else name + ' missing: run `agent-mem models install`'}."
    )
    return 0


def _detect_table(found: dict[str, Any]) -> str:
    rows = [f"  agent-mem binary: {found['binary']}"]
    for name, path in found["harnesses"].items():
        rows.append(f"  agent {name:9s} {'found ' + path if path else 'not installed'}")
    for name, path in found["providers"].items():
        if name == "ollama":
            state = "found (to use it, add 'ollama' to observe.providers)" if path else "not installed (optional)"
        else:
            state = "found, uses your existing login" if path else "not installed"
        rows.append(f"  facts by {name:8s} {state}")
    extras = found["extras"]
    rows.append(f"  search by meaning: {'installed' if extras['semantic'] else 'missing (search by words only)'}")
    rows.append(f"  facts: {'installed' if extras['observer'] else 'missing (requests are saved word for word)'}")
    return "\n".join(rows)


def _targets(harness: str, found: dict[str, Any]) -> list[str]:
    """``all`` means every harness on PATH, so someone using only Codex or all four sets up the same way."""
    if harness != "all":
        return [harness]
    return [name for name, path in found["harnesses"].items() if path]


def cmd_setup(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli import install

    folder = install.plugins_dir()
    found = install.detect()
    targets = _targets(ns.harness, found)
    if not targets:
        print(
            "No agent installed here (claude, codex, copilot, opencode). Install one, or name it: `agent-mem setup codex`."
        )
        print("\nDetected:\n" + _detect_table(found))
        return 1
    if not ns.write:
        for name in targets:
            print(SETUP[name].format(plugins=folder) + "\n")
        print("Or let agent-mem write the files with absolute paths: `agent-mem setup " + ns.harness + " --write`.")
        print("\nDetected:\n" + _detect_table(found))
        return 0
    # Docker install: setup runs in the container, where no agent is installed and the models ship in the image.
    docker = bool(os.environ.get("AGENT_MEM_EXE"))
    for name in targets:
        touched = install.write(name, folder)
        print(f"{name}: hooks and MCP server registered with {found['binary']}.")
        for path in touched:
            print(f"  wrote {path}")
        if name == "codex":
            print("  Codex asks you to trust the hooks once: start codex and run /hooks.")
        if name == "claude" and install.claude_plugin_enabled():
            print("  The agent-mem plugin is enabled too; keep one: /plugin uninstall agent-mem@agent-mem.")
        if docker or not found["extras"]["observer"]:
            continue
        if name == "opencode":
            print('  facts: OpenCode requests are saved word for word unless you add "ollama" to observe.providers.')
        elif found["providers"].get(name):
            model = getattr(config.observe, f"{name}_model") or "the CLI default"
            print(f"  facts: written in the background by `{name}` ({model}), with your existing login.")
        else:
            print(f"  facts: `{name}` is not installed; its requests are saved word for word until it is.")
    if docker:
        return 0
    if found["extras"]["semantic"] and not ns.no_models:
        from agent_mem.memory import semantic

        embedder, reason = semantic.load_embedder_verbose(config, allow_download=True)
        print(f"search model {embedder.model} ready." if embedder else f"search model not available: {reason}")
    if found["extras"]["observer"] and not ns.no_models:
        # The spaCy model (about 13 MB), so doctor is green right after setup.
        from agent_mem.observe import spacy_model

        if spacy_model.model_path(config) is None:
            try:
                print(f"topic model {config.observe.entity_model} ready ({spacy_model.download_model(config)}).")
            except (OSError, ValueError) as error:
                print(f"topic model not downloaded: {error}. Facts still work, they are just not linked by topic.")
    if config.viewer.enabled:
        print(autostart.install_autostart(config))
    print("\nDetected:\n" + _detect_table(found))
    print("\nStart a session, then run `agent-mem doctor`. `agent-mem view` opens the viewer.")
    return 0


def cmd_uninstall(ns: argparse.Namespace, config: Config) -> int:
    from agent_mem.cli import install

    for name in HARNESSES if ns.harness == "all" else [ns.harness]:
        touched = install.remove(name)
        if touched:
            print(f"{name}: removed agent-mem hooks and MCP entries from:")
            for path in touched:
                print(f"  {path}")
        elif ns.harness != "all":
            print(f"{name}: nothing written by `setup --write` was found.")
    from agent_mem.cli.health import harness_installed

    if not any(harness_installed(name) for name in HARNESSES):
        removed = autostart.remove_autostart()
        if removed:
            print(f"  removed the viewer login item {removed} (no agent left)")
    print(f"Data stays in {config.data_dir}; `agent-mem purge --all` deletes it.")
    return 0


def _upgrade_after_exit(command: list[str], exe: str, steps: list[list[str]], config: Config) -> int:
    """Windows cannot replace an install a program runs from, and this command runs from it: ~/.local/bin/agent-mem.exe
    starts Scripts\\python.exe of the install, as do the viewer, background jobs and every open session's MCP server.
    uv then stopped half way and left agent-mem without its package. A PowerShell script takes over: it waits for this
    command to end, stops the rest, upgrades and runs the follow-up steps with the new code."""
    from agent_mem.hooks.hook import _spawn

    def quote(text: str) -> str:
        return "'" + text.replace("'", "''") + "'"

    def call(argv: list[str]) -> str:  # piped so the transcript gets the output
        return "& " + " ".join(quote(arg) for arg in argv) + ' 2>&1 | ForEach-Object { "$_" }'

    config.log_dir.mkdir(parents=True, exist_ok=True)
    log, script = config.log_dir / "upgrade.log", config.log_dir / "upgrade.ps1"
    lines = [
        f"Start-Transcript -Path {quote(str(log))} | Out-Null",
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8",  # agent-mem prints UTF-8; the console default is OEM
        f"Wait-Process -Id {os.getpid()} -ErrorAction SilentlyContinue",
        f"$prefix = {quote(sys.prefix.lower())}",
        "$running = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and "
        "($_.Name -eq 'agent-mem.exe' -or $_.CommandLine.ToLower().Contains($prefix)) })",
        "$running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        "Start-Sleep 1",
        call(command),
        "if ($LASTEXITCODE -ne 0) { 'Upgrade failed; uv names the cause above.' } else {",
        "if ($running | Where-Object { $_.CommandLine -match ' serve' }) {",
        f"Start-Process {quote(exe)} -ArgumentList 'serve','--quiet' -WindowStyle Hidden }}",
        *(call([exe, *step]) for step in steps),
        call([exe, "--version"]),
        "}",
        "Stop-Transcript | Out-Null",
    ]
    script.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")  # the BOM makes PowerShell 5.1 read UTF-8
    if not _spawn(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], config):
        print("Could not start PowerShell for the upgrade.", file=sys.stderr)
        return 1
    print(
        "Windows cannot replace a running program, so the upgrade starts when this command ends. It stops the "
        "viewer, background jobs and the agent-mem connection of open sessions (restart those sessions), upgrades "
        f"and checks the setup. Progress: {log}"
    )
    return 0


def cmd_upgrade(ns: argparse.Namespace, config: Config) -> int:
    import shlex
    import subprocess

    from agent_mem.cli import install

    command = install.upgrade_command(ns.extras)
    if command is None:
        print(
            "This copy was not installed with `uv tool` (the install script uses it). Upgrade it the way you "
            "installed it, then run `agent-mem doctor --fix`.",
            file=sys.stderr,
        )
        return 1
    before = install.version()
    exe = str(Path(sys.executable).with_name("agent-mem.exe" if sys.platform == "win32" else "agent-mem"))
    # Run by the new code: models a new default or extra needs (a no-op when cached), the database migration, and
    # hooks an older release wrote.
    steps = [["models", "install"]] if install.extras()["semantic"] or "semantic" in ns.extras else []
    steps.append(["doctor", "--fix"])
    if sys.platform == "win32":
        # Already the newest commit: nothing to replace, so the viewer and open sessions keep running.
        wanted = [name for name in ns.extras if not install.extras().get(name)]
        if wanted or not install.source_is_current():
            return _upgrade_after_exit(command, exe, steps, config)
        print(f"agent-mem {before} is the newest version.")
    else:
        print("$ " + shlex.join(command), flush=True)
        if subprocess.run(command, check=False).returncode != 0:
            print("Upgrade failed; uv names the cause above.", file=sys.stderr)
            return 1
        after = subprocess.run([exe, "--version"], capture_output=True, text=True, check=False).stdout.strip()
        after = after.removeprefix("agent-mem ") or "?"
        if after == before:
            added = f", now with {' and '.join(ns.extras)}" if ns.extras else ""
            print(f"agent-mem {after} is the newest version{added}.")
        else:
            print(
                f"agent-mem {before} -> {after}. Hooks use it now; running sessions keep their MCP server until "
                "restart.",
                flush=True,
            )
    code = 0
    for step in steps:
        print(f"$ agent-mem {' '.join(step)}", flush=True)
        code = subprocess.run([exe, "--data-dir", str(config.data_dir), *step], check=False).returncode
    return code
