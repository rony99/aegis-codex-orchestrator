# Snippet: filesystem atomic write + rollback

## Purpose

Write critical files safely by staging to temp files and replacing targets atomically, with rollback on partial failure.

## Apply when

- A command updates protocol files (`progress.md`, `run-summary.json`, `INDEX.md`).
- Partial writes would leave inconsistent state.

## Do not apply when

- File updates are best-effort logs where partial output is acceptable.
- The environment does not support atomic rename semantics for the target path.

## Dependencies

- Node.js filesystem APIs.
- Temp files written in the same directory as the final target.

## Pattern

1. Write content to `*.tmp` in the same directory.
2. fsync if available for critical artifacts.
3. Rename temp file over target.
4. On error, remove temp and keep previous target unchanged.

## Verification

```bash
npm run test:local
node dist/cli.js report --runs-dir runs --limit 3
```

Expected: tests pass and protocol files remain readable after repeated runs.

## Common pitfalls

- Do not stage temp files on a different filesystem from the target.
- Do not leave stale temp files after a failed write path.
