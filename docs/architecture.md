# V1 architecture

```text
Host hook/plugin
      │ stdio MCP or local IPC
      ▼
Authenticated broker
      │ one owner
      ▼
Source runtime ── SQLite source vault ── FTS5
      │                   │
      ├─ E5 embed jobs    ├─ provenance / scopes / purge
      ├─ bounded fusion   └─ source-backed reports
      ├─ optional rerank
      └─ bounded metadata graph
```

Capture and retrieval never call a generative model. E5 and the optional reranker are local model inference only. The host's own model remains outside this repository.

## Durable data

- `source_event` and `source_span` retain original host evidence and provenance.
- FTS5 is available immediately; E5 projection is asynchronous and can fail without losing the source.
- `memory_write` stores a versioned source-backed report with cited source IDs and compare-and-swap replacement.
- Purge fences reads, vectors, reports, feedback and runtime cleanup before returning completion.
- Historical schema tables remain for safe vault reads and purge compatibility; V1 does not generate new extraction artifacts.

## Search

Search uses lexical and E5 candidates, bounded fusion, optional one-pass local reranking and structural metadata expansion. Every stage is scoped, budgeted and fail-safe. Feedback changes only bounded local weights; it never trains a model or sends data away.
