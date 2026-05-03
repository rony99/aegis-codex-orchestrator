# CC Spec Workflow

`cc-spec` is the pre-development Claude Code SDK workflow. It turns a rough
feature idea or requirement document into a product and engineering contract
that a later development agent team can implement. It does not write business
implementation code.

Use it when the input is still ambiguous, when a product/technical decision
could materially change implementation, or when an existing repository needs a
bounded change plan before coding starts.

## Commands

Start a new spec run:

```bash
node dist/cli.js cc-spec \
  --task /path/to/task.md \
  --mode new \
  --run-dir runs/manual-cc-spec \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --json
```

Review a change against an existing repository:

```bash
node dist/cli.js cc-spec \
  --task /path/to/task.md \
  --target /path/to/repo \
  --run-dir runs/manual-cc-spec \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --json
```

Resume after the workflow asks the user a blocking question:

```bash
node dist/cli.js cc-spec \
  --run-dir runs/manual-cc-spec \
  --reply /path/to/reply.md \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --json
```

Resume a run that already has artifacts:

```bash
node dist/cli.js cc-spec \
  --run-dir runs/manual-cc-spec \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --json
```

Hand off a completed spec to `cc-run` for development:

```bash
node dist/cli.js cc-run \
  --spec-dir runs/manual-cc-spec \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --json
```

`cc-run --spec-dir` reads `spec.md`, `agent-spec.md`, and `tasks.md` from the completed
cc-spec run directory and combines them into a single development task. Without
`--target`, the developer implements under the run directory `./workspace`. With
`--target <repo-dir>`, developer and tester roles run in that target repository while
the cc-run directory remains the diagnostics/protocol location. A final `done`
requires successful machine verification evidence from the tester.

## Role Pipeline

| Role | Responsibility | Main Output |
|------|----------------|-------------|
| `intake` | Classify 0-1 new project vs. 1-n repo change, extract scenario, goals, constraints, and obvious gaps. | `context.md` |
| `product` | Clarify the product contract: real user, job-to-be-done, MVP loop, non-goals, completion bar, acceptance criteria, success signals, risks, and assumptions. | `product-brief.md`, `decision-log.md` |
| `demo` | Write a self-contained HTML mockup (<400 lines, no external deps) covering the happy-path user loop with realistic hardcoded data. Pauses for user validation before research begins. | `demo.html` |
| `research` | Look up official docs, official GitHub repos, package registry pages, APIs, SDKs, comparable products, and open-source options. Named competitors must have source URLs or explicit no-authoritative-source notes. Record stable versions and licenses for recommended packages, SDKs, APIs, and direct dependencies. | `research.md` |
| `architect` | Convert product and research context into user-facing and development-agent specs, plus executable tasks. `agent-spec.md` must include API Contracts, Data Model, Error Handling, Test Scenarios, and UI State Inventory sections. Each task in `tasks.md` must have a `verify:` command. | `spec.md`, `agent-spec.md`, `tasks.md` |
| `reviewer` | Decide whether development can start directly from `agent-spec.md` and `tasks.md`, or whether more user input is required. | `reviewer-decision.json` |

High-impact missing decisions should stop at `ask_user`. Low-impact details
should be resolved with conservative defaults and recorded as assumptions.

## Artifacts

| File | Purpose |
|------|---------|
| `task.md` | Original user task or requirement document. |
| `context.md` | Mode, target repository summary, intake findings, and appended user replies. |
| `questions.md` | Current questions waiting for user input when status is `ask_user`. |
| `user-replies.md` | Append-only record of reply files used to continue a run. |
| `product-brief.md` | Human-readable PM brief with user, JTBD, MVP loop, acceptance criteria, risks, constraints, and success signals. |
| `decision-log.md` | Confirmed decisions, assumptions, open questions, blocked decisions, and ask-user triggers. |
| `demo.html` | Self-contained UI mockup (<400 lines, no external deps) covering the happy-path user loop. Produced by the demo role; user validation required before research begins. |
| `research.md` | Sourced technical and product research, with URL, source classification, stable version, and license. |
| `spec.md` | Concise user-facing spec: functionality, stack, architecture, milestones, and verification criteria. |
| `agent-spec.md` | Detailed development-agent contract with mandatory sections: API Contracts, Data Model, Error Handling, Test Scenarios, and UI State Inventory. |
| `tasks.md` | Executable development task list with IDs, dependencies, target files/directories, per-task `verify:` commands or a `verify` table column, and parallelization notes. |
| `progress.md` | Human-readable progress log for the cc-spec role pipeline. |
| `blockers.md` | Blocking questions, quality-gate failures, SDK errors, or other issues that need attention. |
| `interaction-request.json` | Structured Claude Code SDK user-interaction request when present. |
| `run-summary.json` | Terminal machine-readable status, model, mode, duration, and role metrics. |
| `session-log/events/` | Ordered Claude Code SDK event traces per role turn. |
| `session-log/inflight/` | Latest role diagnostics for active or completed turns. |

## Existing Repo Mode

Passing `--target <repo-dir>` switches the run to change-review mode. The target
repository is scanned read-only. The summary records package/build/test scripts,
README/docs signals, top-level directories, dependency hints, and technology
stack clues in `context.md`.

For existing repositories, `agent-spec.md` must name:

- the existing-code integration boundary;
- files or areas likely to change;
- areas that should not be touched;
- expected verification commands;
- assumptions that need confirmation before implementation.

`cc-spec` must not modify the target repository.

## Quality Gate

The reviewer can only propose `done`; the driver still runs a deterministic
local quality gate before accepting the run.

The gate rejects `done` when:

- required artifacts are missing or still pending;
- `demo.html` is missing or smaller than 512 bytes;
- `product-brief.md` lacks user, job-to-be-done, MVP loop, acceptance, or risk signals;
- `decision-log.md` lacks confirmed decisions, assumptions, or ask-user triggers;
- `research.md` relies on model memory, lacks source URLs, or fails to classify sources as official, registry, source repository, or unofficial;
- `spec.md` lacks functionality or workflow, technical/architecture, or acceptance/verification signals;
- `agent-spec.md` lacks functional contract, constraints, tests, or boundaries;
- `agent-spec.md` is missing a required section: API Contracts, Data Model, Error Handling, Test Scenarios, or UI State Inventory;
- `agent-spec.md` presents hardcoded `userId` as an acceptable identity boundary;
- `tasks.md` lacks task IDs or verification/test signals;
- `tasks.md` has multiple tasks but fewer than two inline `verify:` commands or per-task checks in a `verify` table column.
- `research.md` recommends packages, SDKs, or APIs without recording stable version and license coverage.

The research gate allows a run to state that no external sources or integrations
are needed. For named competitors or products, it must either provide source
URLs or explicitly mark the product as unverified inspiration.

## Resume Rules

`cc-spec --run-dir <dir> --reply <reply-file>` appends the reply to
`user-replies.md`, clears `questions.md`, updates `context.md`, and resumes after
the last user interaction.

When the last interaction was from the `demo` role, the reply is inspected for
approval signals (e.g. "looks good", "proceed", "yes"). Approval only counts when
the reply does not also request changes. Replies that include both approval and
change requests re-run the demo role before research.

`cc-spec --run-dir <dir>` resumes from the first invalid stage:

| Current State | Roles Rerun |
|---------------|-------------|
| Missing or pending `product-brief.md` / `decision-log.md` | `product`, `demo`, `research`, `architect`, `reviewer` |
| `product-brief.md` ready but `demo.html` missing or invalid | `demo`, `research`, `architect`, `reviewer` |
| Invalid or unsourced `research.md` | `research`, `architect`, `reviewer` |
| Missing or pending `spec.md`, `agent-spec.md`, or `tasks.md` | `architect`, `reviewer` |
| All core artifacts exist | `reviewer` |

## Known Limits

- `cc-spec` depends on the available Claude Code SDK tools. If the SDK runtime
  cannot perform web search, the research role should not fabricate facts. It
  should mark named products as unverified and ground requirements in user input
  plus verified sources it can cite.
- The first version only produces pre-development artifacts. It does not call
  `cc-run` automatically.
- The quality gate is intentionally heuristic. It catches common incomplete or
  unsafe specs, but it does not replace human review for large product bets.

## Current Smoke Evidence

Verified locally on 2026-04-30:

| Scenario | Result | Notes |
|----------|--------|-------|
| Static consultant discovery-call tracker | `done` | Produced PM brief, decision log, sourced research, user spec, agent spec, and `tasks.md`. |
| Chinese novel writing system similar to Xingyue Writing | `done` | Asked blocking product questions, researched comparable writing tools, marked Xingyue Writing as unverified because no authoritative source was available in the SDK run, and produced complete architecture/tasks for implementation. |

Verified with repo-local Claude Code config on 2026-05-03:

| Scenario | Result | Notes |
|----------|--------|-------|
| Love-story vocabulary web game | `done` | Used `.env` Claude Code/MiniMax config, paused for intake clarification and demo approval, resumed successfully, generated `demo.html`, `spec.md`, `agent-spec.md`, and `tasks.md`; `status --json` reports protocol health `clean`. |

Local verification commands:

```bash
npm run typecheck
npm run test:local
git diff --check
```
