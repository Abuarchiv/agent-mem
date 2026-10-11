"""LLM providers for mem0 (docs/PLAN.md §4.4).

Each provider starts the official harness binary under the user's own login. No token is read,
copied or stored. The prompt goes in via stdin, the process runs in an empty temporary directory
with ``AGENT_MEM_INTERNAL=1`` so its own session is never captured.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Any, ClassVar

from mem0.configs.llms.base import BaseLlmConfig
from mem0.llms.base import LLMBase

TIMEOUT_S = 120
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


class ProviderError(RuntimeError):
    """The binary failed, is not logged in, or hit a quota."""


def _flatten(messages: list[dict[str, Any]], wants_json: bool) -> str:
    text = "\n\n".join(f"[{m['role']}]\n{m['content']}" for m in messages)
    if wants_json:
        text += "\n\nAnswer with the requested JSON only, no prose, no code fences."
    return text


def _clean_json(text: str) -> str:
    text = _FENCE.sub("", text.strip()).strip()
    json.loads(text)  # raises on invalid output; mem0 handles the exception and keeps the turn
    return text


def _run(cmd: list[str], prompt: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    env["AGENT_MEM_INTERNAL"] = "1"
    with tempfile.TemporaryDirectory() as cwd:
        try:
            result = subprocess.run(
                cmd, input=prompt, capture_output=True, text=True, cwd=cwd, env=env, timeout=TIMEOUT_S, check=False
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError(f"{cmd[0]}: timeout after {TIMEOUT_S}s") from exc
    if result.returncode != 0:
        raise ProviderError(f"{cmd[0]} exit {result.returncode}: {result.stderr.strip()[:300]}")
    return result.stdout


class ClaudeCliLLM(LLMBase):
    """Stage 1: ``claude -p`` under the subscription login (measured, A.3)."""

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
        "--model",
    )

    def __init__(self, config: BaseLlmConfig | None = None) -> None:
        super().__init__(config or BaseLlmConfig(model="haiku"))
        self.model = str(self.config.model or "haiku")

    def generate_response(self, messages, tools=None, tool_choice="auto", **kwargs):  # type: ignore[override]
        wants_json = kwargs.get("response_format") is not None
        out = _run([*self.CMD, self.model], _flatten(messages, wants_json))
        return _clean_json(out) if wants_json else out.strip()


class CodexCliLLM(LLMBase):
    """Stage 2: ``codex exec`` under the CLI login (measured, A.7)."""

    def __init__(self, config: BaseLlmConfig | None = None) -> None:
        super().__init__(config or BaseLlmConfig(model=""))
        self.model = str(self.config.model or "")

    def generate_response(self, messages, tools=None, tool_choice="auto", **kwargs):  # type: ignore[override]
        wants_json = kwargs.get("response_format") is not None
        with tempfile.TemporaryDirectory() as tmp:
            out_file = os.path.join(tmp, "out.txt")
            cmd = [
                "codex",
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "-o",
                out_file,
            ]
            if self.model:
                cmd += ["-m", self.model]
            _run(cmd, _flatten(messages, wants_json))
            with open(out_file, encoding="utf-8") as fh:
                out = fh.read()
        return _clean_json(out) if wants_json else out.strip()


def make_llm(kind: str, model: str | None = None) -> LLMBase:
    """``claude`` or ``codex`` (harness binaries) or ``ollama`` (local)."""
    if kind == "claude":
        return ClaudeCliLLM(BaseLlmConfig(model=model or "haiku"))
    if kind == "codex":
        return CodexCliLLM(BaseLlmConfig(model=model or ""))
    if kind == "ollama":
        from mem0.llms.ollama import OllamaLLM

        return OllamaLLM(BaseLlmConfig(model=model or "qwen3.5:4b-mlx", temperature=0.0))
    raise ValueError(f"unknown llm provider {kind!r}")
