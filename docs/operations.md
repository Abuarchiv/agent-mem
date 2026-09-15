# V1 operations

## Start

```sh
memory --data-dir /absolute/data status --json
memory --data-dir /absolute/data start
```

Start owns one vault, one E5 instance and one scheduler. A second owner is rejected. `status` reports the local runtime, embedding/index state, jobs, projects and reranker state; it does not report provider qualification or LLM state.

## Maintenance

```sh
memory --data-dir /absolute/data pause
memory --data-dir /absolute/data resume
memory --data-dir /absolute/data forget CAPTURE_ID --project /absolute/project
```

Forget is source-scoped and durable. A pending physical cleanup is reported as pending; it is never reported as complete early.

## Backup

Use the existing runtime backup operation only while the service is quiesced. Do not copy a live SQLite WAL file manually. Restore can intentionally reintroduce old evidence and must be treated as a separate maintenance action.

## Failure behavior

- Missing E5 assets: capture and FTS remain explicit; semantic search reports unavailable.
- Reranker failure: baseline fusion continues.
- Host/MCP failure: the host continues without memory; the event is a capture gap, not a fabricated success.
- Network/provider credentials are not required and are not a fallback.

## OpenCode concurrent sessions

OpenCode `1.18.30` can race its shared Git snapshot garbage collection when
multiple `opencode run` processes use the same worktree. This can produce a
host-side `gc.pid.lock` error even while the Memory broker remains healthy.
Until the upstream fix is available, run one OpenCode session at a time per
worktree or use separate host snapshot/data roots. Track the issue at
[#49190](https://github.com/anomalyco/opencode/issues/49190); this is a host
limitation, not a Memory data-loss fallback.
