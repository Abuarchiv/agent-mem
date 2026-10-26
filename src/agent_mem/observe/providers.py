"""LLM providers for mem0.

Each provider starts the official harness binary under the user's own login. No token is read,
copied or stored. The prompt goes in via stdin, the process runs in an empty temporary directory
with ``AGENT_MEM_INTERNAL=1`` so its own session is never captured.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from typing import Any, ClassVar

from mem0.configs.llms.base import BaseLlmConfig
from mem0.llms.base import LLMBase

from agent_mem.core import db, proc, timeutil
from agent_mem.core.config import Config

TIMEOUT_S = 120
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class ProviderError(RuntimeError):
    """The binary failed, is not logged in, or hit a quota. ``kind`` is quota | login | timeout | other."""

    def __init__(self, message: str, kind: str | None = None) -> None:
        super().__init__(message)
        self.kind = kind or classify(message)


# "exceeded" alone also matches "context length exceeded", which is about the turn, not the plan.
_QUOTA = re.compile(
    r"rate.?limit|usage limit|quota|too many requests|\b429\b|limit reached|hit your limit|spend limit", re.I
)
_LOGIN = re.compile(r"not logged in|unauthori[sz]ed|login|authenticat|\b401\b|\b403\b|invalid api key", re.I)
_ERROR_LINE = re.compile(r"^\s*(?:ERROR|Error|error)\b.*$", re.M)


def classify(message: str) -> str:
    if _QUOTA.search(message):
        return "quota"
    if _LOGIN.search(message):
        return "login"
    if "timeout" in message.lower():
        return "timeout"
    return "other"


# Which stage a harness's turns may use without leaving their vendor (cross_vendor=False).


def _flatten(messages: list[dict[str, Any]], wants_json: bool) -> str:
    text = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages)
    if wants_json:
        text += "\n\nAnswer with the requested JSON only, no prose, no code fences."
    return text


def _clean_json(text: str) -> str:
    """The answer's JSON object. CLIs sometimes add something after it (``claude -p`` a second line, ``opencode
    run`` the whole answer again) or prose before it: the first object in the stream is the answer."""
    text = _FENCE.sub("", text.strip()).strip()
    start = text.find("{")
    if start >= 0:
        with contextlib.suppress(ValueError):
            obj, end = json.JSONDecoder().raw_decode(text[start:])
            if isinstance(obj, dict):
                return text[start : start + end]
    json.loads(text)  # raises on invalid output; mem0 handles the exception and keeps the turn
    return text


def _run(cmd: list[str], prompt: str, extra_env: dict[str, str] | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    env["AGENT_MEM_INTERNAL"] = "1"
    env.update(extra_env or {})
    # npm installs the CLIs as copilot.cmd on Windows; CreateProcess finds only .exe files by bare name.
    name = cmd[0]
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as cwd:
        process = subprocess.Popen(
            [shutil.which(name) or name, *cmd[1:]],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",  # a Windows pipe defaults to cp1252
            errors="replace",
            cwd=cwd,
            env=env,
            **proc.hidden(new_group=True),
        )
        try:
            stdout, stderr = process.communicate(prompt, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired as exc:
            # The CLIs start helper processes; killing only the CLI would leave them running (and spending quota).
            _kill_group(process)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.communicate(timeout=5)
            raise ProviderError(f"{name}: timeout after {TIMEOUT_S}s") from exc
    if process.returncode != 0:
        raise ProviderError(f"{name} exit {process.returncode}: {_error_text(stdout, stderr)}")
    return stdout


def _error_text(stdout: str, stderr: str) -> str:
    """The part of a failed run that says why. codex echoes the prompt into stderr before its ``ERROR:``
    line, so explicit error lines win; ``claude -p`` prints its error on stdout and only a tag on stderr, so
    otherwise both tails count."""
    lines = _ERROR_LINE.findall(stderr) or _ERROR_LINE.findall(stdout)
    if lines:
        return "\n".join(line.strip() for line in lines[-3:])[-600:]
    return " | ".join(part.strip()[-300:] for part in (stdout, stderr) if part.strip())


def _kill_group(process: subprocess.Popen[str]) -> None:
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True, check=False, **proc.hidden()
            )
        else:
            os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(OSError):
        process.kill()


# A plan without the model, or an older CLI without the flag (``--auto-tier``, ``-c``).
_NO_MODEL = re.compile(
    r"model\b.{0,80}\bnot (?:available|supported)|unexpected argument|unknown (?:option|argument)"
    r"|unrecognized_model|issue with the selected model",
    re.I | re.S,
)


def _run_model(cmd: list[str], model_args: list[str], prompt: str, extra_env: dict[str, str] | None = None) -> str:
    """Runs with the configured model; if the CLI refuses it, once more with the CLI's own default."""
    if not model_args:
        return _run(cmd, prompt, extra_env)
    try:
        return _run([*cmd, *model_args], prompt, extra_env)
    except ProviderError as error:
        if not _NO_MODEL.search(str(error)):
            raise
        return _run(cmd, prompt, extra_env)


class _CliLLM(LLMBase):
    """A harness CLI as a mem0 LLM: the messages go in as one prompt, the answer comes back as text or JSON."""

    DEFAULT_MODEL: ClassVar[str] = ""

    def __init__(self, config: BaseLlmConfig | None = None) -> None:
        super().__init__(config or BaseLlmConfig(model=self.DEFAULT_MODEL))
        self.model = str(self.config.model or self.DEFAULT_MODEL)

    def generate_response(self, messages, tools=None, tool_choice="auto", **kwargs):  # type: ignore[override]
        wants_json = kwargs.get("response_format") is not None
        out = self._ask(_flatten(messages, wants_json))
        return _clean_json(out) if wants_json else out.strip()

    def _ask(self, prompt: str) -> str:
        raise NotImplementedError


class ClaudeCliLLM(_CliLLM):
    """Stage 1: ``claude -p`` under the subscription login."""

    DEFAULT_MODEL = "haiku"
    CMD: ClassVar[tuple[str, ...]] = (
        "claude",
        "-p",
        "--restricted",
        "--setting-sources",
        "",
        "--tools",
        "",
        "--strict-mcp-config",
        "--no-session-persistence",
    )

    def _ask(self, prompt: str) -> str:
        return _run_model(list(self.CMD), ["--model", self.model], prompt)


class CodexCliLLM(_CliLLM):
    """Stage 2: ``codex exec`` under the CLI login. Default ``gpt-6-luna`` at low effort,
    the cheapest model in the Codex catalog."""

    def _ask(self, prompt: str) -> str:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            out_file = os.path.join(tmp, "out.txt")
            cmd = [
                "codex",
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                # Plugin hooks (claude-mem, agent-mem itself) and Codex memories would capture the bundle.
                "--disable",
                "hooks",
                "--disable",
                "memories",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "-o",
                out_file,
            ]
            model_args = ["-m", self.model, "-c", "model_reasoning_effort=low"] if self.model else []
            _run_model(cmd, model_args, prompt)
            with open(out_file, encoding="utf-8") as fh:
                return fh.read()


def copilot_config() -> Path:
    home = os.environ.get("COPILOT_HOME")
    return (Path(home).expanduser() if home else Path.home() / ".copilot") / "config.json"


class CopilotCliLLM(_CliLLM):
    """Stage 3: ``copilot -s`` with the prompt on stdin (``-p`` ignores stdin and drops prompts over roughly 30k
    characters on argv; stdin-only mode works under the GitHub login).
    Memory and tools are off by default in prompt mode. Default ``auto`` with the efficiency tier: a fixed
    model is refused when it is not in the plan's picker (Free plan refuses all of them); auto resolves to
    ``gpt-6-luna``, the cheapest catalog model."""

    def _ask(self, prompt: str) -> str:
        model_args = ["--model", self.model] if self.model else []
        if self.model == "auto":
            model_args += ["--auto-tier", "efficiency"]  # only valid together with auto
        cmd = ["copilot", "-s", "--no-custom-instructions", "--disable-builtin-mcps"]
        # A private COPILOT_HOME per call: in the user's own, every call would be a saved session (listed in the
        # Copilot app) and would run the user's hooks, plugins and MCP servers. The keychain login works from any
        # home; config.json comes along for a login kept there on machines without one. On Windows its helpers can
        # still hold a file in it for a moment: a folder left behind beats losing the answer.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as home:
            login = copilot_config()
            if login.is_file():
                shutil.copy(login, home)
            return _run_model(cmd, model_args, prompt, {"COPILOT_HOME": home})


class OpencodeCliLLM(_CliLLM):
    """Stage for OpenCode turns: ``opencode run`` with the configured model, e.g. the free
    ``opencode/big-pickle``. ``--standalone`` uses a private server, so the run does not attach to the
    shared service; ``AGENT_MEM_INTERNAL`` (set by ``_run``) makes agent-mem's own OpenCode plugin skip it.
    ``--agent plan`` keeps the extractor read-only."""

    DEFAULT_MODEL = "opencode/big-pickle"
    CMD: ClassVar[tuple[str, ...]] = ("opencode", "run", "--standalone", "--agent", "plan")

    def _ask(self, prompt: str) -> str:
        return _run_model(list(self.CMD), ["--model", self.model], prompt)


class FakeLLM(LLMBase):
    """Test double. Reads canned answers from the file named in ``AGENT_MEM_FAKE_LLM`` (JSON list,
    consumed in order, last one repeats). Without the file it extracts one fact per user message."""

    calls: ClassVar[dict[str, int]] = {}  # per answer file, across instances (the worker makes one per call)

    def __init__(self, config: BaseLlmConfig | None = None) -> None:
        super().__init__(config or BaseLlmConfig(model="fake"))

    def generate_response(self, messages, tools=None, tool_choice="auto", **kwargs):  # type: ignore[override]
        prompt = "\n".join(str(m.get("content", "")) for m in messages)
        path = os.environ.get("AGENT_MEM_FAKE_LLM")
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                answers = json.load(fh)
            index = min(FakeLLM.calls.get(path, 0), len(answers) - 1)
            FakeLLM.calls[path] = index + 1
            answer = answers[index]
            return answer if isinstance(answer, str) else json.dumps(answer)
        facts = re.findall(r"^\s*user:\s*(.+)$", prompt, re.M | re.I) or re.findall(r"^\[user\]\n(.+)$", prompt, re.M)
        return json.dumps({"memory": [{"text": f.strip()} for f in facts[-3:]]})


def make_llm(kind: str, model: str | None = None) -> LLMBase:
    """``claude``, ``codex``, ``copilot`` or ``opencode`` (harness binaries), ``ollama`` (local) or ``fake`` (tests)."""
    if kind == "fake":
        return FakeLLM()
    if kind == "claude":
        return ClaudeCliLLM(BaseLlmConfig(model=model or "haiku"))
    if kind == "codex":
        return CodexCliLLM(BaseLlmConfig(model=model or ""))
    if kind == "copilot":
        return CopilotCliLLM(BaseLlmConfig(model=model or ""))
    if kind == "opencode":
        return OpencodeCliLLM(BaseLlmConfig(model=model or ""))
    if kind == "ollama":
        from mem0.llms.ollama import OllamaLLM

        return OllamaLLM(BaseLlmConfig(model=model or "qwen3.5:4b-mlx", temperature=0.0))
    raise ValueError(f"unknown llm provider {kind!r}")


# --- chain ---------------------------------------------------------------------------------------


def model_for(config: Config, name: str) -> str | None:
    return {
        "claude": config.observe.claude_model,
        "codex": config.observe.codex_model,
        "copilot": config.observe.copilot_model,
        "opencode": config.observe.opencode_model,
        "ollama": config.observe.ollama_model,
    }.get(name) or None


def available(name: str) -> bool:
    if name == "fake":
        return True
    return shutil.which(name) is not None


def paused_until(conn: sqlite3.Connection, name: str) -> str | None:
    return db.get_meta(conn, f"observe.pause.{name}")


def provider_error(error: BaseException | None) -> ProviderError | None:
    """The ProviderError behind ``error``: mem0 re-raises it as the cause of its LLMError."""
    while error is not None:
        if isinstance(error, ProviderError):
            return error
        error = error.__cause__
    return None


def note_failure(conn: sqlite3.Connection, config: Config, name: str, error: ProviderError) -> None:
    """A quota or login failure pauses the stage for ``pause_minutes`` instead of punishing the turn. So do two timeouts
    in a row (the call is recorded first): a hanging stage keeps hanging, and each turn waited 120 s on it."""
    if error.kind == "timeout":
        last = conn.execute(
            "SELECT ok, COALESCE(error, '') FROM observe_calls WHERE provider = ? ORDER BY id DESC LIMIT 2", (name,)
        ).fetchall()
        if len(last) < 2 or any(ok or classify(text) != "timeout" for ok, text in last):
            return
    elif error.kind not in {"quota", "login"}:
        return
    # Replayed on the call log: 10 minutes caught 13 of 20 repeat timeouts, 60 also moved 69 calls that answered.
    minutes = 10 if error.kind == "timeout" else config.observe.pause_minutes
    until = timeutil.iso(timeutil.now() + timedelta(minutes=minutes))
    db.set_meta(conn, f"observe.pause.{name}", until)
    db.set_meta(conn, f"observe.pause_kind.{name}", error.kind)


def chain(config: Config, harness: str, conn: sqlite3.Connection) -> list[str]:
    """Stages a turn from ``harness`` may use, in order, minus missing binaries and paused stages."""
    if "fake" in config.observe.providers:
        return ["fake"]
    names = _names(config, harness)
    now = timeutil.iso()
    out = []
    for name in names:
        if not available(name):
            continue
        until = paused_until(conn, name)
        if until and until > now:
            continue
        out.append(name)
    return out


def any_left(config: Config, harness: str) -> bool:
    """True while some stage might still succeed later (paused, not missing)."""
    return any(available(n) for n in _names(config, harness))


def resumes_at(config: Config, harness: str, conn: sqlite3.Connection) -> str | None:
    """When the first paused stage for ``harness`` may run again; None when none is paused."""
    now = timeutil.iso()
    pauses = [paused_until(conn, n) for n in _names(config, harness) if available(n)]
    return min((until for until in pauses if until and until > now), default=None)


def _names(config: Config, harness: str) -> list[str]:
    """The configured stages a turn from ``harness`` may use (its own vendor, unless ``cross_vendor``)."""
    names = list(config.observe.providers)
    if not config.observe.cross_vendor:
        names = [n for n in names if n in {"ollama", harness}]
    return names
