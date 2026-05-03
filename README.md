# Aegis Codex Orchestrator

**Aegis** is an experimental orchestration layer for Codex-powered software development.

It is not trying to turn a product brief into a perfect production app. The narrower goal is more practical: reduce the babysitting required when running AI coding agents on multi-step engineering work.

Before coding starts, Aegis should help drive structured discovery: clarify the product purpose, requirements, constraints, technology stack, external APIs, non-goals, and acceptance criteria. Those decisions are then frozen into files so later Codex threads do not repeatedly ask the same questions or forget the original intent during a long run.

Start a task, walk away, and come back to a structured run directory with a spec, frozen interfaces, progress notes, blockers, session traces, implementation output, and test evidence.

> Current status: v0.5 alpha. API probe, snippet pool, observer lessons, bounded observer context, and snippet promotion are active; this is still a research prototype.

## Why This Exists

Single coding-agent sessions are useful, but they often break down on longer tasks:

- they ask for confirmation too often;
- they drift as conversation history grows;
- they mix planning, coding, and testing in one context;
- their intermediate state is hard to inspect or replay.

Aegis adds a small manager layer around Codex SDK threads. Each role gets a clean context, and durable project state lives in files instead of chat history.

The first defense against babysitting is not better code generation. It is better pre-development discovery: ask the important product and engineering questions up front, record the answers, and make every later agent work from that shared ground truth.

## How It Works

v0.5 runs a serial loop:

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
progress.md        # human log plus machine-readable state block
blockers.md        # issues that require user attention or cannot be self-resolved
run-summary.json   # machine-readable terminal state, failure category, and role metrics
session-log/       # raw Codex turn traces for future observer/reflection work
session-log/events/ # ordered SDK event traces for role turn diagnosis
api-probes/        # API/SDK probe notes, scripts, samples, or failure records
workspace/         # generated implementation and tests
```

v0.5 alpha currently generates the files above and also reads a global snippet catalog:

snippets/INDEX.md  # reusable implementation snippets for prompt grounding

The target protocol includes:

- `discovery.md` with clarification and open questions.
- `lessons.md` in v0.4 from observer review.

For v0.4, you can now generate an observer pass:

- `codex-gtd observe --run-dir <run-dir> [--model <model>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]`
- `codex-gtd run --task <task-file> ... --observe`
- `codex-gtd report [--runs-dir <dir>] [--limit <n>]`
- `codex-gtd status --run-dir <run-dir> [--json]`
- `codex-gtd repair-plan --run-dir <run-dir> [--json]`
- `codex-gtd export-workspace --run-dir <run-dir> [--out <patch-file>]`
- `codex-gtd apply-workspace --run-dir <run-dir> --target <repo-dir> [--write]`
- `codex-gtd resume --run-dir <run-dir> [--target <repo-dir>] [--execute] [--model <model>] [--turn-timeout-ms <ms>]`
- `codex-gtd sdk-probe [--model <model>] [--turn-timeout-ms <ms>] [--trace-file <json-file>] [--raw-cli] [--json]`
- `codex-gtd cc-run --task <task-file> [--target <repo-dir>] [--run-dir <run-dir>] [--model <model>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--json]`
- `codex-gtd cc-spec --task <task-file> [--mode new|change] [--target <repo-dir>] [--run-dir <dir>] [--model <model>] [--turn-timeout-ms <ms>] [--json]`
- `codex-gtd cc-spec --run-dir <dir> [--reply <reply-file>] [--json]`
- `codex-gtd spec-agent --task <task-file> [--target <repo-dir>] [--run-dir <dir>] [--runs-dir <dir>] [--json]`

Observer writes `lessons.md` from current run traces for operator review. Report summarizes `run-summary.json` files across runs, including terminal status, failure categories, SDK/observer failures, and recent run details.

The manager decides one next action at a time:

- `develop`
- `test`
- `done`
- `ask_user`

`ask_user` is intended to be rare: product decisions, account/key actions, or hard dead ends.

## Features

- Real Codex SDK integration through `@openai/codex-sdk`.
- Minimal Claude Code SDK team workflow through `codex-gtd cc-run`, using a developer/tester loop and `@anthropic-ai/claude-agent-sdk`.
- Pre-development Claude Code SDK spec workflow through `codex-gtd cc-spec`, using intake/product/demo/research/architect/reviewer roles before implementation starts.
- Lightweight local spec artifact generator through `codex-gtd spec-agent`, a deterministic TypeScript CLI that produces task.md, questions.md, product-brief.md, research.md, spec.md, agent-spec.md, tasks.md, and run-summary.json without calling any SDK. It detects ambiguous tasks and writes clarifying questions, inspects local reference paths read-only, scans the target repo when `--target` is provided, and records sourcing gaps for competitor/API/package references.
- Local `cc-spec` quality gate before accepting `done`, checking required PM artifacts, sourced research, implementation-agent contract signals, and executable `tasks.md`.
- Pre-development research artifact generation through the researcher role.
- Per-run `api-probes/` artifacts for API/SDK dependency grounding.
- Optional Codex SDK web search for open-source framework and current documentation discovery (`--web-search live`).
- Global `snippets/INDEX.md` prompt-time retrieval before implementation.
- Independent Codex thread per role to reduce context pollution.
- File-based protocol that is inspectable, checkpointable, and replay-friendly.
- Structured manager decisions using JSON schema output.
- Driver-level closeout gate before accepting `done`, checking protocol files, API probe sections, workspace output, and verification evidence.
- Local protocol helpers and tests for run initialization, progress state repair, API probe README sections, protocol drift, and manager decision parsing.
- Session logs containing prompts, final responses, thread IDs, usage, and Codex items.
- Streaming role diagnostics in `session-log/inflight/` so long-running turns can be distinguished from no SDK events, active commands/tools, timeout, or permission/approval failures.
- Ordered role event traces in `session-log/events/`; role error logs include `eventTraceFile` when a streamed trace is available.
- SDK probe command (`codex-gtd sdk-probe`) that records raw streamed SDK events, final diagnosis, and an optional trace JSON file for reconnect/debugging cases. `--raw-cli` bypasses the SDK wrapper and captures Codex CLI stdout JSONL, stderr, exit code, and signal for subprocess-level diagnostics.
- Fast test mode with the `codex-5.3-spark` alias, mapped to `gpt-5.3-codex-spark`.
- Bounded manager prompt context so long `progress.md`, probe notes, and snippets do not make later manager turns unnecessarily large.
- Role-level fallback from spark to `gpt-5.4` for unsupported tool/model errors and spark turn timeouts.
- Observer pass command (`codex-gtd observe`) to generate `lessons.md` with protocol health context, or use `--observe` with `run` to auto-run it.
- Snippet promotion command (`codex-gtd promote-snippet`) to move reviewed candidates into the reusable catalog.
- Snippet audit command (`codex-gtd audit-snippets`) to check the first-version quality gate for reusable snippet files.
- Report command (`codex-gtd report`) for done/ask-user/max-loop counts, failure categories, SDK/observer failures, protocol health, and recent run summaries, including timeout and unsupported-tool classification.
- Status command (`codex-gtd status`) for one-run diagnostics, including protocol health, latest inflight role diagnosis, and the recommended next operator action.
- Repair plan command (`codex-gtd repair-plan`) for deterministic local recovery guidance after failed runs.
- Workspace export command (`codex-gtd export-workspace`) to turn generated `workspace/` output into a reviewable patch before applying it elsewhere.
- Guarded apply command (`codex-gtd apply-workspace`) that checks the target git repo is clean and validates the patch before writing.
- Resume command (`codex-gtd resume`) that routes completed runs to export/apply and recoverable failed runs to SDK-backed continuation using saved role thread IDs, with `--sdk-continue` accepted for retry guidance compatibility.
- Snippet usage reporting from `spec.md` decisions (`used`, `rejected`, `none`, `unknown`).
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

For a CLI-first manual trial of `doctor`, `sdk-probe`, `run`, `status`, `resume`, and workspace export/apply, see [docs/CLI_TRIAL.md](docs/CLI_TRIAL.md). For the pre-development Claude Code spec workflow, see [docs/CC_SPEC.md](docs/CC_SPEC.md).

For SDK stream debugging, use the probe command to keep the ordered event transcript:

```bash
node dist/cli.js sdk-probe --model gpt-5.4 --turn-timeout-ms 600000 --trace-file /tmp/codex-gtd-sdk-probe.json --json
node dist/cli.js sdk-probe --model gpt-5.4 --turn-timeout-ms 600000 --trace-file /tmp/codex-gtd-raw-cli-probe.json --raw-cli --json
```

`sdk-probe` uses `runStreamed()` and records each SDK event with a diagnosis. A top-level SDK `error` event returns a failed probe result with the event type, classification, and detail instead of losing the stream output. Use `--raw-cli` when you need stderr and process exit details that the SDK wrapper does not expose. Raw CLI traces keep both the compatible `stdoutLines` array and `stdoutLineEvents[]` with per-line receive timestamps, plus structured stderr `warnings[]` for known plugin, MCP process-group, rollout-recording, and generic CLI warning/error lines.

Normal role turns also write ordered event traces under `session-log/events/<timestamp>-<role>.json`. When a role fails, the matching `session-log/*-error.json` includes `eventTraceFile`, so you can jump from the failure summary to the complete streamed transcript.

### Run the Codex team

Use `run` for the main Codex-powered team workflow. It drives the discovery/manager/developer/tester loop, writes protocol files into one run directory, and leaves generated output under `workspace/`.

```bash
cat > /tmp/codex-gtd-task.md <<'EOF'
Create workspace/HELLO.md with exactly this line:
hello from codex team
EOF

node dist/cli.js run \
  --task /tmp/codex-gtd-task.md \
  --run-dir runs/manual-codex-team \
  --model gpt-5.4 \
  --turn-timeout-ms 600000 \
  --max-loops 3 \
  --skip-discovery
```

Inspect the result:

```bash
node dist/cli.js status --run-dir runs/manual-codex-team --json
node dist/cli.js report --runs-dir runs --limit 5
```

If `status` recommends a resume, use:

```bash
node dist/cli.js resume \
  --run-dir runs/manual-codex-team \
  --execute \
  --model gpt-5.4 \
  --turn-timeout-ms 600000 \
  --max-loops 3
```

For a successful run, review or export the generated workspace before applying it elsewhere:

```bash
node dist/cli.js export-workspace \
  --run-dir runs/manual-codex-team \
  --out /tmp/codex-gtd-codex-team.patch
```

### Run the CC team

Use `cc-run` for the experimental Claude Code SDK team workflow. It runs a smaller developer/tester loop through `@anthropic-ai/claude-agent-sdk`, writes SDK progress into `session-log/events/` and `session-log/inflight/`, and records the terminal result in `run-summary.json`.

Set Anthropic-compatible environment variables before running it. Do not commit real tokens.
A safe starter template is available in `.env.example`.

```bash
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

For a Claude-compatible provider, set that provider's base URL and model instead:

```bash
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_MODEL="MiniMax-M2.7"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

Run a small task:

```bash
cat > /tmp/codex-gtd-cc-task.md <<'EOF'
Build a tiny static Focus Timer app under workspace/.
Create index.html, styles.css, and app.js.
The page must show "Focus Timer", a 25:00 timer, and Start/Pause/Reset buttons.
EOF

node dist/cli.js cc-run \
  --task /tmp/codex-gtd-cc-task.md \
  --run-dir runs/manual-cc-team \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --max-loops 2 \
  --json
```

Check these files first:

```text
runs/manual-cc-team/
  progress.md
  blockers.md
  run-summary.json
  tester-decision.json
  interaction-request.json        # only when SDK/user input is required
  session-log/events/
  session-log/inflight/
  workspace/
```

`cc-run` uses Claude Code SDK `tools` and `allowedTools` separately: developer can write under the run directory, tester reads and returns structured JSON, and user-interaction requests are captured as `ask_user` instead of being guessed or ignored.

For existing-repo development, pass `--target <repo-dir>`. In that mode the Claude Code SDK role cwd is the target repository, while `--run-dir` remains the diagnostics directory for progress, blockers, `run-summary.json`, and SDK event traces.

### Run a CC spec review

Use `cc-spec` before implementation when the input is still a feature idea or rough requirement. It does not write business code. The staged roles are intake, product, demo, research, architect, and reviewer. The product role writes `product-brief.md` and `decision-log.md` so real-world user, MVP-loop, constraints, assumptions, and open questions stay explicit before research and architecture. The demo role writes `demo.html` and pauses for user validation before research begins. The research role is instructed to prefer official docs, official GitHub repositories, and official package pages. The architect writes `spec.md`, `agent-spec.md`, and `tasks.md`; reviewer `done` is accepted only after a local quality gate confirms the artifacts are ready for a downstream development team.

Detailed artifact semantics, resume rules, and the local quality gate are documented in [docs/CC_SPEC.md](docs/CC_SPEC.md).

```bash
node dist/cli.js cc-spec \
  --task /tmp/feature-idea.md \
  --target . \
  --run-dir runs/manual-cc-spec \
  --model "$ANTHROPIC_MODEL" \
  --json
```

If the workflow stops at `ask_user`, answer in a file and resume the same run:

```bash
node dist/cli.js cc-spec \
  --run-dir runs/manual-cc-spec \
  --reply /tmp/cc-spec-reply.md \
  --json
```

If a later role times out after writing artifacts, rerun the same directory
without `--reply`; `cc-spec` resumes from the first missing artifact stage and
runs reviewer when `product-brief.md`, `decision-log.md`, `demo.html`, `research.md`,
`spec.md`, `agent-spec.md`, and `tasks.md` already exist and pass the basic
artifact checks.

Primary artifacts are `context.md`, `questions.md`, `user-replies.md`, `product-brief.md`, `decision-log.md`, `demo.html`, `research.md`, `spec.md`, `agent-spec.md`, `tasks.md`, `progress.md`, `blockers.md`, `interaction-request.json`, `run-summary.json`, and the usual `session-log/events/` plus `session-log/inflight/` diagnostics. When `--target <repo-dir>` is provided, the target repo is scanned read-only and summarized into `context.md`.

### Run local tests

```bash
npm run test:local
```

`test:local` runs the CLI/core Codex team tests first, then the Web/server protocol tests. Treat `test:core` as the core orchestration gate and `test:server` as the Web/API communication gate:

```bash
npm run test:core
npm run test:server
```

The core tests cover CLI parsing, run/status/resume/repair-plan behavior, progress files, SDK diagnostics, and the machine-readable `run-summary.json` shape without invoking live Codex SDK turns. The server tests cover Web task submission, same-runDir tracking, diagnostics exposure, ask_user replies, and stopping active tasks.

### Summarize runs

```bash
node dist/cli.js report --runs-dir runs --limit 10
```

The report command is local-only. It reads `run-summary.json` files and prints aggregate counts, average duration, failure categories, SDK monitor failures, observer failures, protocol health counts, and recent runs.

It also reports snippet usage from each run's `spec.md` `Snippet Decision` section, so you can see whether promoted snippets are actually being reused.

### Inspect one run

```bash
node dist/cli.js status --run-dir runs/<timestamp>
node dist/cli.js status --run-dir runs/<timestamp> --json
```

The status command is local-only. It reads `run-summary.json`, protocol health, progress drift, and `session-log/inflight/` diagnostics, then recommends the next action such as `wait`, `rerun`, `export_workspace`, `resume_sdk`, `repair_protocol`, or `inspect`. Use `--json` when a script or monitor needs machine-readable output.

### Get a repair plan for a failed run

```bash
node dist/cli.js repair-plan --run-dir runs/<timestamp>
node dist/cli.js repair-plan --run-dir runs/<timestamp> --json
```

This command is local-only. It reads `run-summary.json`, protocol health, and progress drift, then prints a deterministic next action such as `rerun`, `repair_protocol`, `answer_user`, or `inspect`. Rerun commands preserve recorded `--skip-discovery` and `--web-search` options when the failed run captured them. Use `--json` for machine-readable recovery plans.

### Export generated workspace output

```bash
node dist/cli.js export-workspace --run-dir runs/<timestamp> --out workspace.patch
```

This writes a git-style patch for text files under the run's `workspace/`. It is intentionally review-first: inspect the patch and run `git apply --check workspace.patch` in the target repository before applying it.

### Safely apply generated workspace output

```bash
node dist/cli.js apply-workspace --run-dir runs/<timestamp> --target /path/to/repo
node dist/cli.js apply-workspace --run-dir runs/<timestamp> --target /path/to/repo --write
```

By default this only checks the patch. With `--write`, it applies the patch after verifying that the target is a git repository, the target working tree is clean, and `git apply --check` passes.

### Choose the next recovery step

```bash
node dist/cli.js resume --run-dir runs/<timestamp>
node dist/cli.js resume --run-dir runs/<timestamp> --target /path/to/repo
node dist/cli.js resume --run-dir runs/<timestamp> --target /path/to/repo --execute
node dist/cli.js resume --run-dir runs/<timestamp> --target /path/to/repo --execute --write
node dist/cli.js resume --run-dir runs/<timestamp> --execute --model gpt-5.4 --turn-timeout-ms 600000 --observe
node dist/cli.js resume --run-dir runs/<timestamp> --execute --sdk-continue
```

This command is a planner by default. For completed runs it suggests `export-workspace` or `apply-workspace`; for failed runs with `turn_timeout`, `unsupported_tool`, `role_failed`, `invalid_manager_decision`, or `max_loops`, it plans `resume_sdk` when a saved non-observer role `threadId` exists in `session-log/`. With `--execute`, `resume_sdk` reconstructs that Codex SDK thread and appends continuation output to the original run directory. Applying workspace output still stays dry-run unless `--write` is also present.

Resume does not bypass user blockers: `blocker`, `discovery_needed`, `sdk_failed`, `observer_failed`, missing protocol files, protocol drift, or missing local Codex session IDs still require repair, user input, or a fresh run. Timeout threads that only reached `turn.started` and completed no SDK work are also treated as rerun-only because resuming that incomplete turn can reconnect to a broken SDK stream.

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

### Promote a reviewed snippet candidate

After a successful `--observe` run produces `snippets/_candidates/*.md`, review the candidate file manually. Promote only approved content:

```bash
node dist/cli.js promote-snippet \
  --candidate snippets/_candidates/example-candidates.md \
  --slug approved-parser \
  --title "Approved parser" \
  --category parser \
  --tags validation,edge-cases
```

The command writes `snippets/approved-parser.md` and updates `snippets/INDEX.md`. Optional `--category` and `--tags` metadata are validated (lowercase letters/numbers/hyphens), stored in snippet metadata, and appended to index entries for faster retrieval. It is idempotent for identical content and refuses to overwrite an existing snippet with different content.

### Audit snippet quality

Run the local snippet quality gate before relying on promoted snippets in dogfood tasks:

```bash
node dist/cli.js audit-snippets --snippets-dir snippets
```

Use `--json` for automation. The first-version gate fails snippets that are missing the `# Snippet: <title>` heading, `Purpose`, or `Dependencies`. Missing verification guidance, common pitfalls, or apply-when guidance are warnings so the existing catalog can be improved incrementally.

### Generated files and privacy

Run artifacts are written to `runs/` and are intentionally ignored by git and npm packaging. They can contain local file paths, prompts, model traces, and generated workspace code. Do not publish `runs/` unless you have reviewed and sanitized it.

## CLI

```text
  codex-gtd run --task <task-file> [--run-dir <run-dir>] [--model <model>] [--web-search <disabled|cached|live>] [--runs-dir <dir>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe] [--skip-discovery] [--monitor-sdk|--skip-sdk-monitor]
  codex-gtd observe --run-dir <run-dir> [--model <model>] [--web-search <disabled|cached|live>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]
  codex-gtd promote-snippet --candidate <candidate-file> --slug <slug> [--title <title>] [--category <name>] [--tags <a,b,c>] [--snippets-dir <dir>]
  codex-gtd audit-snippets [--snippets-dir <dir>] [--json]
  codex-gtd report [--runs-dir <dir>] [--limit <n>]
  codex-gtd status --run-dir <run-dir> [--json]
  codex-gtd repair-plan --run-dir <run-dir> [--json]
  codex-gtd export-workspace --run-dir <run-dir> [--out <patch-file>]
  codex-gtd apply-workspace --run-dir <run-dir> --target <repo-dir> [--write]
  codex-gtd resume --run-dir <run-dir> [--target <repo-dir>] [--execute] [--write] [--model <model>] [--web-search <disabled|cached|live>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe]
  codex-gtd cc-run --task <task-file> [--target <repo-dir>] [--run-dir <run-dir>] [--model <model>] [--runs-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--json]
  codex-gtd cc-run --spec-dir <cc-spec-run-dir> [--target <repo-dir>] [--run-dir <run-dir>] [--model <model>] [--runs-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--json]
  codex-gtd cc-spec --task <task-file> [--mode new|change] [--target <repo-dir>] [--run-dir <dir>] [--model <model>] [--turn-timeout-ms <ms>] [--json]
  codex-gtd cc-spec --run-dir <dir> [--reply <reply-file>] [--json]
  codex-gtd spec-agent --task <task-file> [--target <repo-dir>] [--run-dir <dir>] [--runs-dir <dir>] [--json]
  codex-gtd smoke [--model <model>] [--web-search <disabled|cached|live>]
  codex-gtd sdk-probe [--model <model>] [--web-search <disabled|cached|live>] [--turn-timeout-ms <ms>] [--trace-file <json-file>] [--raw-cli] [--json]
```

Defaults:

- model: `CODEX_GTD_MODEL` or `gpt-5.4`
- runs directory: `runs`
- snippets directory: `snippets`
- turn timeout: `300000` ms (5 分钟), or `CODEX_GTD_TURN_TIMEOUT_MS`
- web search: `CODEX_GTD_WEB_SEARCH` or `--web-search`, one of `disabled`, `cached`, `live`
- loops: `8`
- sdk monitor: `CODEX_GTD_MONITOR_SDK` (`true` by default, set to `0`/`false`/`off` to disable)

Model alias:

- `codex-5.3-spark` -> `gpt-5.3-codex-spark`

### Claude Code SDK cc-run

`cc-run` is an experimental simplified team workflow for Claude Code SDK-compatible providers. It does not replace the Codex team loop. The first version runs one developer role and one tester role per loop, records role events under `session-log/events/`, writes latest role diagnostics under `session-log/inflight/`, and closes with `run-summary.json`. Without `--target`, deliverables stay under the run directory `workspace/`. With `--target <repo-dir>`, the SDK roles run in the target repository and edit that repository directly while diagnostics remain in `--run-dir`. It also accepts `--spec-dir <cc-spec-run-dir>` to build a development task directly from `spec.md`, `agent-spec.md`, and `tasks.md`.

The command reads normal Anthropic-compatible environment variables such as `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`. For the MiniMax-compatible endpoint tested during development, use `MiniMax-M2.7` as the model and keep `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### Claude Code SDK cc-spec

`cc-spec` is the pre-development companion to `cc-run`. It turns rough input into `product-brief.md`, `decision-log.md`, `demo.html`, `research.md`, `spec.md` for users, and `agent-spec.md` plus `tasks.md` for implementation agents. It supports 0-1 projects by default and switches to existing-repo change review when `--target <repo-dir>` is provided. Target scanning is read-only and records package scripts, README/docs signals, top-level directories, and dependency hints in `context.md`. A local quality gate rejects `done` when core artifacts are pending, `demo.html` is missing, research recommendations lack source evidence, `agent-spec.md` misses mandatory contract sections, `tasks.md` is missing executable checklist items or per-task verification, or `agent-spec.md` leaves unsafe identity boundaries ambiguous.

See [docs/CC_SPEC.md](docs/CC_SPEC.md) for the role pipeline, artifact table, resume behavior, and smoke-test evidence.

### Lightweight spec-agent

`spec-agent` is a lightweight, local-only Product Manager / requirements clarification agent. Unlike `cc-spec`, it does **not** call any SDK (Codex SDK, Claude Code SDK, or any network API). It runs deterministically in TypeScript and produces structured spec artifacts that can be handed to later development agents.

```bash
node dist/cli.js spec-agent --task /tmp/feature-idea.md --target . --run-dir runs/manual-spec-agent --json
```

`spec-agent` writes these artifacts to `--run-dir`:

- `task.md` — copy of the original input.
- `questions.md` — concrete clarifying questions when the task is ambiguous; otherwise a brief confirmation.
- `product-brief.md` — structured product brief with target repo context when `--target` is provided.
- `research.md` — sourcing record: records competitor/API/package references as pending verification and inspects local reference paths read-only. Does **not** perform live web research.
- `spec.md` — functional requirements skeleton.
- `agent-spec.md` — implementation contract with Development Boundaries, Acceptance Criteria, Interfaces and Data Flow, Test Requirements, and Non-goals.
- `tasks.md` — executable development tasks with `verify:` commands or manual acceptance checks.
- `run-summary.json` — machine-readable run metadata (schemaVersion, workflow, runDir, targetDir, status, reason, artifacts, startedAt, endedAt, durationMs).

When `--target <repo-dir>` is provided, `spec-agent` scans the target read-only (package.json scripts, README, docs, top-level directories, dependencies) and includes the summary in `product-brief.md`, `research.md`, and `agent-spec.md`. It does not modify the target repository.

V1 limitations: `spec-agent` does not perform live web research or API lookups. All competitor, API, and package references are recorded as pending human verification or future-agent verification.

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

`progress.md` starts with a `codex-gtd:progress-state` JSON block containing `status`, `lastRole`, `loop`, `terminal`, and optional `reason`, then keeps the human-readable log below it. `run-summary.json` includes `failureCategory`, `terminalRole`, and per-role turn counts under `metrics.roleTurns`. Older summaries without these fields still load in `report` and are categorized as `unknown`.

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

- `runs/`, `snippets/_candidates/`, `node_modules/`, build caches, logs, archives, and `.env*` files are ignored.
- `package.json` uses a `files` allowlist for npm packaging.
- No credentials are required in the repository; use your normal Codex environment/auth setup locally.

## Roadmap

Near-term hardening:

- Continue discovery hardening for non-interactive and ambiguous tasks.
- Run more medium/large dogfood passes now that observer and manager input are compacted.
- Run more `--observe` dogfood passes and refine lesson quality.
- Run more real SDK tasks to build a small corpus of failure categories and observer lessons.

Planned versions:

- v0.2: API probe mechanism to reduce SDK/API hallucinations. Implemented.
- v0.3: snippet reuse pool for agent-friendly private components. Initial support is implemented.
- v0.4: observer pass available (`codex-gtd observe`) to produce `lessons.md`; observer input is bounded before the SDK turn.
- v0.5: snippet candidate generation and reviewed promotion into the reusable `snippets/` catalog.
- v0.6+: parallel developers after interfaces are frozen.

## Philosophy

Aegis is built around a few constraints:

- File protocol over chat protocol.
- Frozen interfaces before implementation.
- Fewer user interruptions.
- Small loops before ambitious automation.
- Logs are future training data for better orchestration.

The first milestone is not perfection. It is a measurable improvement over manually babysitting a single coding agent.
