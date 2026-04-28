# Snippet: HTTP JSON error contract

## Purpose

Standardize HTTP JSON calls so failures return structured context (status, endpoint, body excerpt) and can be surfaced in run artifacts.

## Apply when

- You call external HTTP APIs and need reproducible diagnostics.
- You persist probe results to markdown/json artifacts.

## Do not apply when

- The task has no external HTTP dependency.
- The upstream SDK already guarantees equivalent structured errors.

## Dependencies

- A JSON-capable HTTP client.
- A caller that can persist bounded success and failure probe artifacts.

## Pattern

1. Wrap request execution in a single helper.
2. On non-2xx, capture `status`, `url`, and a bounded body excerpt.
3. Emit a stable error shape consumed by report/repair flows.
4. Persist one success sample and one failure explanation in `api-probes/`.

## Verification

```bash
npm run test:local
node dist/cli.js repair-plan --run-dir runs/<timestamp>
```

Expected: tests pass and repair-plan can reference clear HTTP probe failures.

## Common pitfalls

- Do not store unbounded response bodies in probe artifacts.
- Do not collapse all HTTP errors into the same message without status and URL context.
