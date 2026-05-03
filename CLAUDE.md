# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test

```bash
npm run build          # Compile TypeScript
npm run typecheck     # Type-check without emitting
npm run test:core     # CLI parsing, run/status/resume/repair-plan, protocol tests
npm run test:server   # Web/server protocol tests
npm run test:local    # Both test suites
npm run dev -- <cmd>  # Run CLI with tsx (no build required)
```

## Architecture

**Aegis Codex Orchestrator** is an agent orchestration layer. It wraps Codex SDK and Claude Code SDK threads with a file-based protocol so each role gets a clean context and durable state lives in files rather than chat history.

### Three workflows

| Command | Purpose |
|---------|---------|
| `run` | Codex SDK team: researcher → manager → developer → tester (serial loop) |
| `cc-run` | Claude Code SDK team: developer + tester loop via `@anthropic-ai/claude-agent-sdk` |
| `cc-spec` | Claude Code SDK pre-development spec workflow: intake → product → demo → research → architect → reviewer |

### Key source files

- `src/cli.ts` — CLI entry point, argument parsing, output formatting
- `src/codex-team/driver.ts` — Codex orchestration, run/status/resume/repair-plan logic
- `src/cc-team/index.ts` — CC team (`cc-run`) workflow implementation
- `src/cc-team/spec-prompts.ts` — CC spec role prompts and pipeline
- `src/spec-agent.ts` — Lightweight local-only spec generator (no SDK calls)
- `src/prompts.ts` — Shared prompts for manager, observer, compacting logic
- `src/server/` — Optional Express web server for task submission and monitoring

### File protocol

All run state lives under `runs/<timestamp>/`:

```
task.md, discovery.md, spec.md, interfaces.md  # discovery artifacts
progress.md, blockers.md                       # execution state
run-summary.json                               # machine-readable terminal state
session-log/events/                            # ordered SDK event traces per role
session-log/inflight/                          # live role diagnostics
workspace/                                    # generated implementation
api-probes/                                    # API/SDK dependency notes
```

The protocol is inspectable, checkpointable, and replay-friendly. Progress state machine: `running` → `ask_user`/`done`/`max_loops_reached`.

## Environment

Before running SDK workflows (`cc-run`, `cc-spec`, `run`, `observe`), load the local `.env`:

```bash
set -a && source .env && set +a
```

Key variables:
- `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`
- `ANTHROPIC_MODEL=MiniMax-M2.7`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- `API_TIMEOUT_MS=3000000`

## Common Commands

```bash
# Smoke test SDK connectivity
npm run smoke

# Run a task with Codex team
node dist/cli.js run --task examples/todo-exporter-task.md --model gpt-5.4 --max-loops 8

# Run CC spec workflow (pre-development)
node dist/cli.js cc-spec --task /tmp/feature-idea.md --mode new --model "$ANTHROPIC_MODEL"

# Run CC dev team from completed spec
node dist/cli.js cc-run --spec-dir runs/manual-cc-spec --model "$ANTHROPIC_MODEL"

# Inspect a run
node dist/cli.js status --run-dir runs/<timestamp> --json
node dist/cli.js report --runs-dir runs --limit 10

# Repair/recover a failed run
node dist/cli.js repair-plan --run-dir runs/<timestamp>
node dist/cli.js resume --run-dir runs/<timestamp> --execute --model gpt-5.4

# Workspace export/apply
node dist/cli.js export-workspace --run-dir runs/<timestamp> --out patch.file
node dist/cli.js apply-workspace --run-dir runs/<timestamp> --target /path/to/repo --write

# Local spec agent (no SDK, deterministic)
node dist/cli.js spec-agent --task /tmp/task.md --target . --run-dir runs/spec-agent-test
```

## Model aliases

- `codex-5.3-spark` → `gpt-5.3-codex-spark`

## Notes

- Run artifacts under `runs/` are git-ignored; they contain prompts, traces, and generated code.
- `cc-spec` and `spec-agent` are pre-development only; they do not write implementation code.
- The `spec-agent` command is deterministic TypeScript with no network calls.
- `runs/`, `snippets/_candidates/`, `node_modules/`, `.env*` are excluded from npm packaging.
