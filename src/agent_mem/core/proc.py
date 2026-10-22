"""How agent-mem starts other programs: on Windows never with a window. Standard library only (hook path)."""

from __future__ import annotations

import subprocess
import sys
from typing import Any


def hidden(*, new_group: bool = False) -> dict[str, Any]:
    """``Popen`` keywords for a process the user never sees. On Windows it gets a console of its own that is not
    shown (``CREATE_NO_WINDOW``); without one (``DETACHED_PROCESS``) Windows opens a new visible console for every
    console program it starts in turn, such as git or a model CLI. ``new_group`` lets a timeout stop it with its
    children; elsewhere that is a new session."""
    if sys.platform == "win32":
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if new_group:
            flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return {"creationflags": flags}
    return {"start_new_session": True} if new_group else {}
