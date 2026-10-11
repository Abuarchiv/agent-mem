"""Background observer (docs/PLAN.md §4.3 to §4.6).

Only this package imports mem0 and qdrant. Nothing on the hook path imports it (rule R2).
Phase 0 ships the adapter and the LLM providers so the measurements in §8 can run; the
worker, queue and contradiction layer follow in Phase 1.

mem0 reads ``MEM0_TELEMETRY`` and ``MEM0_DIR`` once, at import time (``mem0/memory/telemetry.py``,
``mem0/memory/setup.py``). With telemetry on it also opens a second Qdrant store under
``MEM0_DIR/migrations_qdrant`` and posts to PostHog. Both variables are therefore fixed here, before
any submodule imports mem0 (§6, point 4). A caller may set them earlier to override.
"""

from __future__ import annotations

import os

from ..config import default_data_dir

os.environ.setdefault("MEM0_TELEMETRY", "False")
os.environ.setdefault("MEM0_DIR", str(default_data_dir() / "mem0"))
