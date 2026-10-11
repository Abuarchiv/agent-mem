These messages come from a coding session between a developer and a coding agent (Claude Code,
Codex, Copilot CLI or OpenCode). Extract only what will matter in a later session of the same
project. Keep each memory to one sentence, concrete and self-contained.

Record:
- Project conventions and tool choices: package manager, test runner, formatter, versions, ports,
  branch names, deployment target, environment variables and where they come from.
- Decisions with their reason ("SQLite instead of Postgres because single-user").
- Corrections and rules the developer states ("never force-push to main").
- Dead ends and the fix that worked ("'event loop is closed' fixed with pytest-asyncio auto mode").
- Preferences about how the agent should work (language of answers, commit message style).
- Ownership and contacts for parts of the code.

Do not record:
- Generic programming knowledge the developer asked about (what a tuple is, how to reverse a string).
- Routine actions without lasting information (renamed a file, ran the tests, committed).
- File contents, code snippets, stack traces or tool output. Name the file or command instead.
- Secrets, tokens, passwords or keys, even if they appear in the text.

Write each memory in the developer's language (German input: German memory). Use the exact
identifiers from the text: commands, flags, versions, ports, names. Prefer "Project uses X" or
"Tests run with X" over "User mentioned X".
