# Aegis Codex Orchestrator

**Aegis** is an experimental orchestration layer for Codex-powered software development.

It is not trying to turn a product brief into a perfect production app. The narrower goal is more practical: reduce the babysitting required when running AI coding agents on multi-step engineering work.

Before coding starts, Aegis should help drive structured discovery: clarify the product purpose, requirements, constraints, technology stack, external APIs, non-goals, and acceptance criteria. Those decisions are then frozen into files so later Codex threads do not repeatedly ask the same questions or forget the original intent during a long run.

Start a task, walk away, and come back to a structured run directory with a spec, frozen interfaces, progress notes, blockers, session traces, implementation output, and test evidence.

> Current status: v0.3 alpha. API probe and snippet pool support is now active, and this is still a research prototype.

## Why This Exists

Single coding-agent sessions are useful, but they often break down on longer tasks:

- they ask for confirmation too often;
- they drift as conversation history grows;
- they mix planning, coding, and testing in one context;
- their intermediate state is hard to inspect or replay.

Aegis adds a small manager layer around Codex SDK threads. Each role gets a clean context, and durable project state lives in files instead of chat history.

The first defense against babysitting is not better code generation. It is better pre-development discovery: ask the important product and engineering questions up front, record the answers, and make every later agent work from that shared ground truth.

## How It Works

v0.3 runs a serial loop:

```text
researcher -> manager -> developer -> tester

Observer is optional and can be run after the loop (or during run via --observe).
```

The intended lifecycle has two phases:

1. **Discovery before development**: Codex helps clarify purpose, scope, requirements, stack, APIs, acceptance criteria, and non-goals, then writes `spec.md`, `interfaces.md`, and `api-probes/`.
2. **Execution after freeze**: manager/developer/tester operate against those files instead of relying on a long, fragile chat history.

Each role communicates through a file protocol inside `runs/<timestamp>/`:

```text
task.md            # original user task
discovery.md       # clarification pass and open questions (interactive unless --skip-discovery)
spec.md            # functional requirements, acceptance criteria, non-goals
interfaces.md      # frozen contract for implementation and testing
progress.md        # current status and executed commands
blockers.md        # issues that require user attention or cannot be self-resolved
run-summary.json   # machine-readable terminal state, failure category, and role metrics
session-log/       # raw Codex turn traces for future observer/reflection work
api-probes/        # API/SDK probe notes, scripts, samples, or failure records
workspace/         # generated implementation and tests
```

v0.3 alpha currently generates the files above and also reads a global snippet catalog:

snippets/INDEX.md  # reusable implementation snippets for prompt grounding

The target protocol includes:

- `discovery.md` with clarification and open questions.
- `lessons.md` in v0.4 from observer review.

For v0.4, you can now generate an observer pass:

- `codex-gtd observe --run-dir <run-dir> [--model <model>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]`
- `codex-gtd run --task <task-file> ... --observe`
- `codex-gtd report [--runs-dir <dir>] [--limit <n>]`

Observer writes `lessons.md` from current run traces for operator review. Report summarizes `run-summary.json` files across runs, including terminal status, failure categories, SDK/observer failures, and recent run details.

The manager decides one next action at a time:

- `develop`
- `test`
- `done`
- `ask_user`

`ask_user` is intended to be rare: product decisions, account/key actions, or hard dead ends.

## Features

- Real Codex SDK integration through `@openai/codex-sdk`.
- Pre-development research artifact generation through the researcher role.
- Per-run `api-probes/` artifacts for API/SDK dependency grounding.
- Global `snippets/INDEX.md` prompt-time retrieval before implementation.
- Independent Codex thread per role to reduce context pollution.
- File-based protocol that is inspectable, checkpointable, and replay-friendly.
- Structured manager decisions using JSON schema output.
- Session logs containing prompts, final responses, thread IDs, usage, and Codex items.
- Fast test mode with the `codex-5.3-spark` alias, mapped to `gpt-5.3-codex-spark`.
- Observer pass command (`codex-gtd observe`) to generate `lessons.md`, or use `--observe` with `run` to auto-run it.
- Report command (`codex-gtd report`) for done/ask-user/max-loop counts, failure categories, SDK/observer failures, and recent run summaries.
- Included pilot task: Markdown TODO exporter.

## Quick Start

### Prerequisites

- Node.js 18 or newer.
- npm.
- A working Codex setup for the machine running this project. The easiest check is that Codex can run normally in your environment before using this orchestrator.

### Install and build

```bash
git clone https://github.com/rony99/aegis-codex-orchestrator.git
cd aegis-codex-orchestrator
npm install
npm run build
```

### Verify Codex SDK access

```bash
npm run smoke
```

The smoke command starts a real Codex SDK thread with `gpt-5.4`, which is the most reliable default for this project. You can still pass `--model codex-5.3-spark` for faster experimental runs when that model is supported by your Codex account.

### Run local tests

```bash
npm run test:local
```

These tests cover CLI parsing and fast-fail behavior without invoking the Codex SDK.
They also validate the machine-readable `run-summary.json` shape.

### Summarize runs

```bash
node dist/cli.js report --runs-dir runs --limit 10
```

The report command is local-only. It reads `run-summary.json` files and prints aggregate counts, average duration, failure categories, SDK monitor failures, observer failures, and recent runs.

### Run the included pilot task

```bash
node dist/cli.js run \
  --task examples/todo-exporter-task.md \
  --model codex-5.3-spark \
  --observe
```

This creates a local `runs/<timestamp>/` directory containing:

- `task.md`
- `discovery.md`
- `spec.md`
- `interfaces.md`
- `progress.md`
- `blockers.md`
- `run-summary.json`
- `session-log/`
- `api-probes/`
- `workspace/`
- `lessons.md` (if `observe` is enabled)
- `snippets/_candidates/<timestamp>-candidates.md` (if observer outputs candidate snippets)

### Verify blocker behavior

The repository includes a task that should stop before implementation because it requires a paid SMS provider account and secrets:

```bash
node dist/cli.js run \
  --task examples/blocker-api-key-task.md \
  --model codex-5.3-spark \
  --skip-discovery \
  --max-loops 2
```

Expected result: `Status: ask_user`, with the missing credentials recorded in `blockers.md`.

### Development mode

```bash
npm run dev -- run \
  --task examples/todo-exporter-task.md \
  --model codex-5.3-spark
```

Optional local CLI link:

```bash
npm link
codex-gtd run --task examples/todo-exporter-task.md --model codex-5.3-spark
```

### Generated files and privacy

Run artifacts are written to `runs/` and are intentionally ignored by git and npm packaging. They can contain local file paths, prompts, model traces, and generated workspace code. Do not publish `runs/` unless you have reviewed and sanitized it.

## CLI

```text
codex-gtd run --task <task-file> [--model <model>] [--runs-dir <dir>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe] [--skip-discovery] [--monitor-sdk|--skip-sdk-monitor]
codex-gtd observe --run-dir <run-dir> [--model <model>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]
codex-gtd report [--runs-dir <dir>] [--limit <n>]
codex-gtd smoke [--model <model>]
```

Defaults:

- model: `CODEX_GTD_MODEL` or `gpt-5.4`
- runs directory: `runs`
- snippets directory: `snippets`
- turn timeout: `300000` ms (5 分钟), or `CODEX_GTD_TURN_TIMEOUT_MS`
- loops: `8`
- sdk monitor: `CODEX_GTD_MONITOR_SDK` (`true` by default, set to `0`/`false`/`off` to disable)

Model alias:

- `codex-5.3-spark` -> `gpt-5.3-codex-spark`

## Example Output

A successful run creates a directory like:

```text
runs/2026-04-23T08-27-29Z/
  task.md
  spec.md
  interfaces.md
  progress.md
  blockers.md
  run-summary.json
  session-log/
  session-log/*-error.json (if a role fails or times out)
  api-probes/
  workspace/
  lessons.md         # optional, created by observer pass
  snippets/_candidates/
    <timestamp>-candidates.md  # optional, created by candidate extraction
  sdk-health.json    # optional, SDK smoke/health trace for this run
```

`run-summary.json` includes `failureCategory`, `terminalRole`, and per-role turn counts under `metrics.roleTurns`. Older summaries without these fields still load in `report` and are categorized as `unknown`.

The v0.1 pilot run completed the full chain:

```text
researcher -> manager -> developer -> manager -> tester -> manager
```

and produced a working Markdown TODO exporter with a passing shell test.

## Project Docs

- [Product plan](docs/PLAN.md)
- [Decision record](docs/DECISIONS.md)
- [Current status and TODO](docs/TODO.md)

## Release Hygiene

The repository is configured to publish only code and documentation:

- `runs/`, `node_modules/`, build caches, logs, archives, and `.env*` files are ignored.
- `package.json` uses a `files` allowlist for npm packaging.
- No credentials are required in the repository; use your normal Codex environment/auth setup locally.

## Roadmap

Near-term hardening:

- Continue discovery hardening for non-interactive and ambiguous tasks.
- Normalize `progress.md` into a more machine-readable status format.
- Add more local tests around run directory creation and manager decision parsing.
- Run more real SDK tasks to build a small corpus of failure categories and observer lessons.

Planned versions:

- v0.2: API probe mechanism to reduce SDK/API hallucinations. Implemented.
- v0.3: snippet reuse pool for agent-friendly private components. Initial support is implemented.
- v0.4: observer pass available (`codex-gtd observe`) to produce `lessons.md`.
- v0.5: snippet candidate generation from successful runs into `snippets/_candidates/`.
- v0.6+: parallel developers after interfaces are frozen.

## Philosophy

Aegis is built around a few constraints:

- File protocol over chat protocol.
- Frozen interfaces before implementation.
- Fewer user interruptions.
- Small loops before ambitious automation.
- Logs are future training data for better orchestration.

The first milestone is not perfection. It is a measurable improvement over manually babysitting a single coding agent.
