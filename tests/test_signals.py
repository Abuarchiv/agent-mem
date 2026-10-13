from agent_mem.core import signals


def test_command_keys():
    assert signals.command_key("npm test -- --watch") == "npm test"
    assert signals.command_key("FOO=1 sudo pytest -q tests/x.py") == "pytest"
    assert signals.command_key("python -m pytest -x") == "python -m pytest"
    assert signals.command_key("pnpm run build && echo ok") == "pnpm run build"
    assert signals.command_key("uv run ruff check .") == "uv run ruff"
    assert signals.command_key("cargo test --all") == "cargo test"
    assert signals.command_key("/usr/bin/git status") == "git status"
    # the working part, not the shell setup in front of it
    assert signals.command_key("cd app && uv run pytest -q") == "uv run pytest"
    assert signals.command_key("S=/tmp; cd $S && python -m pytest") == "python -m pytest"
    assert signals.command_key("f=$(ls -t logs/* | head -1); grep x $f") == "grep"
    assert not signals.fixable("cat") and not signals.fixable("grep") and signals.fixable("uv run pytest")
    assert not signals.fixable("cd") and not signals.fixable("-t") and not signals.fixable(None)
    assert signals.command_key("for f in a b; do uv run pytest $f; done") == "uv run pytest"
    assert signals.command_key("timeout 600 uv run pytest -q") == "uv run pytest"
    assert signals.command_key("git -C /repo status") == "git status" and signals.command_key("150") is None


def test_command_kinds():
    assert signals.command_kind("pytest -q") == "test"
    assert signals.command_kind("npm run lint") == "lint"
    assert signals.command_kind("tsc -p .") == "build"
    assert signals.command_kind("pnpm add zod") == "install"
    assert signals.command_kind('git commit -m "x"') == "commit"
    assert signals.command_kind("git checkout -- src/a.py") == "revert"
    assert signals.command_kind("git stash list") is None
    assert signals.command_kind("git stash push -q src/a.py") is None  # shelved to test without it, then popped


def test_reverted_files():
    assert signals.reverted_files("git checkout -- a.py b.py") == ["a.py", "b.py"]
    assert signals.reverted_files("git restore --staged src/x.ts") == ["src/x.ts"]
    assert signals.reverted_files("git reset --hard HEAD") == ["*"]


def test_files_from_tool_inputs():
    assert signals.files_of("edit", {"file_path": "/r/a.py"}) == ["/r/a.py"]
    patch = "*** Begin Patch\n*** Update File: src/a.py\n@@\n*** Add File: src/b.py\n*** End Patch"
    assert signals.files_of("edit", {"input": patch}) == ["src/a.py", "src/b.py"]
    assert signals.files_of("edit", patch) == ["src/a.py", "src/b.py"]
    assert signals.files_of("edit", {"edits": [{"file_path": "x.py"}]}) == ["x.py"]


def test_command_from_argv_list():
    assert signals.command_of({"command": ["bash", "-lc", "pytest -q"]}) == "pytest -q"
    assert signals.command_of({"command": ["ls", "-la"]}) == "ls -la"


def test_tool_classification():
    assert signals.classify_tool("Bash") == "shell"
    assert signals.classify_tool("exec_command") == "shell"
    assert signals.classify_tool("apply_patch") == "edit"
    assert signals.classify_tool("WebFetch") == "web"
    assert signals.classify_tool("mcp__github__get_issue") == "mcp"
    assert signals.classify_tool("Read") == "read"


def test_error_signature_is_stable_across_paths_and_numbers():
    a = signals.error_signature(
        "Traceback...\n  File \"/home/a/x.py\", line 10\nModuleNotFoundError: No module named 'requests'"
    )
    b = signals.error_signature(
        "Traceback...\n  File \"/tmp/b/y.py\", line 99\nModuleNotFoundError: No module named 'numpy'"
    )
    c = signals.error_signature("TypeError: unsupported operand")
    assert a and b and c
    assert a[0] == b[0]
    assert a[0] != c[0]


def test_corrections_and_preferences():
    assert signals.is_correction("nein, nicht so")
    assert signals.is_correction("No, that's wrong")
    assert signals.is_correction("Ich habe doch gesagt pnpm")
    assert not signals.is_correction("Please add a test for the parser")
    assert signals.mentions_rule("nutze nie npm") and signals.mentions_rule("always use uv")
    for filler in ("da sind immer noch die alten Sachen", "wie immer", "noch nie gesehen", "never mind"):
        assert not signals.mentions_rule(filler), filler
    assert ("npm", "pnpm") in signals.preference_pairs("nutze pnpm statt npm")
    assert ("npm", "pnpm") in signals.preference_pairs("use pnpm instead of npm")
    assert signals.preference_pairs("Use pnpm instead of npm.") == [("npm", "pnpm")]  # sentence end
    # The observer's rule form; prose about paths or "keine lokalen LLMs" is not a command rule.
    assert signals.canonical_rule("Nutze `uv` statt `pip`, weil schneller.") == ("pip", "uv")
    assert signals.canonical_rule("Use ruff instead of black.") == ("black", "ruff")
    assert signals.canonical_rule("Do not use npm; use pnpm.") == ("npm", "pnpm")
    assert signals.canonical_rule("Do not use npm, but use pnpm.") == ("npm", "pnpm")
    assert signals.canonical_rule("Nicht `npm`, sondern `pnpm`.") == ("npm", "pnpm")
    assert signals.canonical_rule("Nicht `npm`, sondern nutze `pnpm`.") == ("npm", "pnpm")
    assert signals.canonical_rule("Nutze absolute Pfade wie `/x` statt relativer Pfade") is None
    assert signals.canonical_rule("Nutze keine lokalen LLMs") is None
    # Everyday contrast is no tool rule; a git/npm avoidance keeps its subcommand.
    assert signals.canonical_rule("Never commit, use local commits only.") is None
    assert signals.canonical_rule("Do not install, use the venv.") is None
    for prose in [
        "nein, nicht so, sondern anders",
        "nicht hier, sondern im viewer",
        "nutze die neue api statt der alten",
    ]:
        assert signals.preference_pairs(prose) == [], prose
    assert signals.preference_pairs("kein git push mehr bitte") == [("git push", None)]
    assert signals.preference_pairs("nie npm benutzen") == [("npm", None)]
    assert ("yarn", "bun") in signals.preference_pairs("nicht yarn, sondern bun")
    assert ("requests", None) in signals.preference_pairs("never use requests here")


def test_decisions():
    assert signals.decision_sentences("Ok. Wir nehmen Postgres für die Queue. Danke")
    assert signals.decision_sentences("We decided to use SQLite.")
    assert not signals.decision_sentences("How does the parser work?")


def test_packages():
    assert signals.packages_of("npm install lodash@4 zod") == ["lodash", "zod"]
    assert signals.packages_of("pip install requests==2.31") == ["requests"]


def test_task_notification_reads_as_its_summary():
    notice = (
        "<task-notification>\n<task-id>b1</task-id>\n<status>failed</status>\n"
        '<summary>Background command "Run eval" failed with exit code 144</summary>\n</task-notification>'
    )
    assert signals.request_text(notice) == 'Background command "Run eval" failed with exit code 144'
    assert signals.request_text("fix the parser") == "fix the parser"
    assert signals.request_text(None) == ""


def test_a_runner_and_its_options_do_not_hide_the_command():
    """Copilot ran `uv run --with pytest python3 -m pytest -q`: the value of --with was taken for the command."""
    assert signals.command_key("uv run --with pytest python3 -m pytest -q") == "uv run pytest"
    assert signals.command_key("uv run --with requests python app.py") == "uv run python"
    assert signals.command_key("uv run -m pytest -x") == "uv run pytest"
    assert signals.command_key("poetry run --directory api pytest") == "poetry run pytest"
    # the same tool, however it is started: a failure of one is fixed by a pass of the other
    assert signals.same_tool("python -m pytest", "uv run pytest") and signals.same_tool("pytest", "uv run pytest")
    assert not signals.same_tool("uv run ruff", "uv run pytest") and not signals.same_tool("npm test", "pytest")
