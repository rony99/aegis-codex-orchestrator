# Snippet: CLI args parser contract

## Purpose

Provide a deterministic command-line parser shape that fails fast on missing values, rejects unknown flags, and keeps command handlers clean.

## Apply when

- You are building a local CLI with subcommands and typed flags.
- You need deterministic pre-SDK validation before any expensive call.

## Do not apply when

- You use a full framework parser (e.g. yargs/commander) and do not need a custom parser.
- The command syntax is intentionally free-form (shell passthrough wrappers).

## Dependencies

- Node.js CLI runtime.
- A test harness that can execute the built CLI without invoking external SDK calls.

## Pattern

1. Parse once into a typed `ParsedArgs` object.
2. Validate numeric/enum flags at parse-time.
3. Throw descriptive errors for missing required values.
4. Reject unknown flags immediately.
5. Keep business logic in command handlers, not in parser branches.

## Verification

```bash
node dist/cli.js --help
node dist/cli.js run
node dist/cli.js run --task examples/todo-exporter-task.md --max-loops 0
```

Expected: help succeeds; invalid invocations fail with descriptive fast-fail errors.

## Common pitfalls

- Do not allow unknown flags to fall through to command handlers.
- Do not parse numeric or enum flags after starting expensive work.
