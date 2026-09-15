# Non-generative search

V1 search is local and deterministic:

1. FTS5 provides exact and lexical candidates.
2. Bundled multilingual E5 adds semantic candidates.
3. Fusion applies bounded, explicit weights.
4. The optional local cross-encoder reranks one bounded candidate set.
5. Structural metadata relationships add at most the configured hop budget.

No stage calls a provider or generates text. Reranking changes order only; it cannot create facts. Graph edges come from stored event metadata and explicit source relationships, not inferred causes. Feedback is explicit and local. Registered procedure hints point to existing sources and never execute commands.

If E5 or the reranker is unavailable, the service reports the degraded stage and continues with the safe lower stage.
