"""Background observer (docs/PLAN.md §4.3 to §4.6).

Only this package imports mem0 and qdrant. Nothing on the hook path imports it (rule R2).
Phase 0 ships the adapter and the LLM providers so the measurements in §8 can run; the
worker, queue and contradiction layer follow in Phase 1.
"""
