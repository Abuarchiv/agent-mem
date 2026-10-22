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
    assert a[1] == "ModuleNotFoundError: No module named 'requests'"


def test_error_signature_names_the_error_not_the_header():
    key_error = "Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\nKeyError: 'compliance'"
    chained = (
        'Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad\n\n'
        "During handling of the above exception, another exception occurred:\n\n"
        'Traceback (most recent call last):\n  File "b.py", line 2\nRuntimeError: wrapped'
    )
    pytest_run = (
        ".................F.                                                      [100%]\n"
        "=================================== FAILURES ===================================\n"
        "_______ test_finish_closes_codex ________\n"
        "tests/test_codex.py:461: in test_finish_closes_codex\n"
        "    assert clients[0].interrupts == [('thread-1', 'turn-1')]\n"
        "E   AssertionError: assert [] == [('thread-1', 'turn-1')]\n"
        "=========================== short test summary info ============================\n"
        "FAILED tests/test_codex.py::test_finish_closes_codex\n"
        "1 failed, 18 passed in 1.85s"
    )
    other_test = pytest_run.replace("test_finish_closes_codex", "test_start_opens_codex")
    narrow = pytest_run.replace("test_finish_closes_codex\n1 failed", "test_finish_closes_codex - Ass...\n1 failed")
    assert signals.error_signature(narrow)[0] == signals.error_signature(pytest_run)[0]  # type: ignore[index]
    assert signals.error_signature(key_error)[1] == "KeyError: 'compliance'"  # type: ignore[index]
    assert signals.error_signature(chained)[1] == "RuntimeError: wrapped"  # type: ignore[index]
    assert signals.error_signature(pytest_run)[1] == "FAILED tests/test_codex.py::test_finish_closes_codex"  # type: ignore[index]
    assert signals.error_signature(pytest_run)[0] != signals.error_signature(other_test)[0]  # type: ignore[index]
    assert signals.error_signature(key_error)[0] != signals.error_signature(chained)[0]  # type: ignore[index]
    bare = 'Traceback (most recent call last):\n  File "check.py", line 9, in verify_export\nAssertionError'
    assert signals.error_signature(bare)[1] == "AssertionError in verify_export"  # type: ignore[index]
    for header in (
        "Traceback (most recent call last):",
        "=" * 30 + " FAILURES " + "=" * 30,
        "_____ ERROR at setup of t _____",
    ):
        assert not signals.looks_like_error(header), header


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
    """In `uv run --with pytest python3 -m pytest -q` the value of --with is not the command."""
    assert signals.command_key("uv run --with pytest python3 -m pytest -q") == "uv run pytest"
    assert signals.command_key("uv run --with requests python app.py") == "uv run python"
    assert signals.command_key("uv run -m pytest -x") == "uv run pytest"
    assert signals.command_key("poetry run --directory api pytest") == "poetry run pytest"
    # the same tool, however it is started: a failure of one is fixed by a pass of the other
    assert signals.same_tool("python -m pytest", "uv run pytest") and signals.same_tool("pytest", "uv run pytest")
    assert not signals.same_tool("uv run ruff", "uv run pytest") and not signals.same_tool("npm test", "pytest")


def test_a_chain_is_keyed_by_the_command_that_does_the_work():
    """`cat test_parser.py && uv run … pytest | tail` is keyed by the test run, not by `cat`."""
    chained = 'cd "Mein Projekt" && cat test_parser.py && uv run --with pytest python3 -m pytest -q 2>&1 | tail -20'
    assert signals.command_key(chained) == "uv run pytest"
    assert signals.command_key("cd x && sed -i '' s/a/b/ p.py && cat p.py && uv run pytest") == "uv run pytest"
    assert signals.command_key("cd x && ls -la && cat README") == "ls"  # only looking around: the first look
    assert signals.command_key("git status && git diff") == "git status"


def test_not_x_verb_but_y_is_a_preference():
    """The verb may stand between the avoided name and the comma."""
    assert signals.preference_pairs("Nicht pip benutzen, sondern uv.") == [("pip", "uv")]
    assert signals.preference_pairs("Bitte nicht npm verwenden, sondern pnpm") == [("npm", "pnpm")]
    assert signals.preference_pairs("nicht so machen, sondern anders") == []


def test_a_word_swap_inside_a_long_complaint_is_not_a_command_rule():
    """A complaint about wording ("Redo anstatt Reuse zu nennen", "wirklich anstatt einfach") is no command rule.
    "X statt Y" without a verb is a tool swap only in a short correction or with names in backticks."""
    complaint = (
        "Also es gibt viele Stellen, wo wirklich sprachlich bzw. einfach ein User verwirren. Zum Beispiel, also ich "
        "kann dir das viele Beispiele nennen, zum Beispiel Redo anstatt Reuse zu nennen oder View gibt es so viele "
        "Sachen, die einfach wirklich anstatt einfach einfacher auszudrücken, machst du komplexer"
    )
    assert signals.preference_pairs(complaint) == []
    assert signals.preference_pairs("pnpm statt npm") == [("npm", "pnpm")]
    assert signals.preference_pairs(complaint + " Und bitte `pnpm` statt `npm`.") == [("npm", "pnpm")]
    assert signals.preference_pairs(complaint + " Nutze uv statt pip.") == [("pip", "uv")]


def test_codex_apply_patch_names_its_files():
    """Codex 0.162 sends apply_patch as {"command": "*** Begin Patch …"}."""
    patch = (
        "*** Begin Patch\n*** Update File: /repo/stats.py\n@@\n-    return 1\n+    return 0\n"
        "*** Add File: docs/new.md\n+hello\n*** End Patch\n"
    )
    signal = signals.analyze_tool("apply_patch", {"command": patch})
    assert signal.category == "edit" and list(signal.files) == ["/repo/stats.py", "docs/new.md"]


def test_read_only_git_and_queries_fix_nothing():
    """`git status`, `git diff` and `sqlite3` only look: they fix no error, and in a chain they do not hide the
    command that does the work."""
    for key in ("git status", "git diff", "git log", "git show", "git worktree", "sqlite3", "nl", "ugrep"):
        assert not signals.fixable(key), key
    assert signals.fixable("git commit") and signals.fixable("uv run pytest")
    assert signals.command_key("git status --short && uv run pytest -q") == "uv run pytest"
    assert signals.command_key('sqlite3 db "select 1" && git diff') == "sqlite3"  # only looking: the first look


def test_a_rule_sees_the_tool_each_part_of_a_command_runs():
    """A rule "use uv instead of pip" catches `cd x && python3 -m pip install` and `pip3 install` and lets
    `uv pip install` through: it looks at the tool each part runs, not at the first words of the line."""
    assert "pip" in signals.tools_run("cd x && python3 -m pip install requests")
    assert "pip" in signals.tools_run("pip3 install requests") and "pip" in signals.tools_run("sudo pip install x")
    assert "pip" not in signals.tools_run("uv pip install requests")
    assert "pip" not in signals.tools_run('echo "we use uv, not pip"')
    assert "git push" in signals.tools_run("git add . && git push origin main")
    assert "npm" in signals.tools_run("cd web && npm install")


def test_commits_made_reads_git_output():
    assert signals.commits_made("[main (root-commit) 2431488] Erster Stand\n 3 files changed") == [
        "2431488 Erster Stand"
    ]
    quiet = "git commit -q -m 'Aufräumen' && git log --oneline -3"
    log = " M src/app.py\n8760496 Aufräumen\n5050025 OpenCode-Plugin\n74d1b9e Provider"
    assert signals.commits_made(log, quiet) == ["8760496 Aufräumen"]  # the newest line is the new commit
    assert signals.commits_made(log, "git log --oneline -3") == ["8760496 Aufräumen"]
    assert signals.commits_made(log) == []  # without the command no log line counts
