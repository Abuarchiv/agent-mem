"""Build hook: the viewer script ``src/agent_mem/ui/app.ts`` becomes ``app.js`` with its type annotations erased.

Node's own type stripping does it, so a build needs no npm and no TypeScript compiler; Node comes from a wheel
(``nodejs-wheel-binaries``). The script uses erasable TypeScript only (``erasableSyntaxOnly`` in the tsconfig),
so the result is the source without its types. ``app.js`` is generated and never committed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

SOURCE = "src/agent_mem/ui/app.ts"
SCRIPT = "src/agent_mem/ui/app.js"
_STRIP = 'process.stdout.write(require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0, "utf8")))'


def build_viewer_script(root: Path) -> None:
    from nodejs_wheel import node

    done = node(
        ["--no-warnings", "-e", _STRIP],
        return_completed_process=True,
        input=(root / SOURCE).read_bytes(),
        capture_output=True,
    )
    if done.returncode != 0:
        raise RuntimeError(f"could not build {SCRIPT} from {SOURCE}: {done.stderr.decode(errors='replace')}")
    # Unchanged output is not rewritten: a running viewer reads a new modification time as an upgrade.
    target = root / SCRIPT
    if not target.exists() or target.read_bytes() != done.stdout:
        target.write_bytes(done.stdout)


class ViewerScriptHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        build_viewer_script(Path(self.root))
        build_data["artifacts"].append(SCRIPT)
