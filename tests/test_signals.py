from agent_mem import signals


def test_command_keys():
    assert signals.command_key("npm test -- --watch") == "npm test"
    assert signals.command_key("FOO=1 sudo pytest -q tests/x.py") == "pytest"
    assert signals.command_key("python -m pytest -x") == "python -m pytest"
    assert signals.command_key("pnpm run build && echo ok") == "pnpm run build"
    assert signals.command_key("uv run ruff check .") == "uv run ruff"
    assert signals.command_key("cargo test --all") == "cargo test"
    assert signals.command_key("/usr/bin/git status") == "git status"


def test_command_kinds():
    assert signals.command_kind("pytest -q") == "test"
    assert signals.command_kind("npm run lint") == "lint"
    assert signals.command_kind("tsc -p .") == "build"
    assert signals.command_kind("pnpm add zod") == "install"
    assert signals.command_kind('git commit -m "x"') == "commit"
    assert signals.command_kind("git checkout -- src/a.py") == "revert"
    assert signals.command_kind("git stash list") is None


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
    assert ("npm", "pnpm") in signals.preference_pairs("nutze pnpm statt npm")
    assert ("npm", "pnpm") in signals.preference_pairs("use pnpm instead of npm")
    assert ("yarn", "bun") in signals.preference_pairs("nicht yarn, sondern bun")
    assert ("requests", None) in signals.preference_pairs("never use requests here")


def test_decisions():
    assert signals.decision_sentences("Ok. Wir nehmen Postgres für die Queue. Danke")
    assert signals.decision_sentences("We decided to use SQLite.")
    assert not signals.decision_sentences("How does the parser work?")


def test_packages():
    assert signals.packages_of("npm install lodash@4 zod") == ["lodash", "zod"]
    assert signals.packages_of("pip install requests==2.31") == ["requests"]
