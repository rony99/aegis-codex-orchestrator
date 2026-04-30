# CLI Trial Guide

This guide is the shortest path for testing the core team loops before using the
Web UI. Treat the CLI as the source of truth: Web/server should only reflect the
same run directory and protocol files.

## 1. Build and Check Local Prerequisites

```bash
npm install
npm run build
node dist/cli.js doctor --json
```

Expected result:

- `status` is `ok`.
- `checks` includes `node`, `npm`, and `codex-sdk`.
- `sdk-health-baseline` may be a warning on a fresh machine until a probe or run
  records the first baseline.

## 2. Probe Codex SDK Connectivity

Use this before a longer run when you want to isolate SDK/CLI connectivity from
the orchestration loop:

```bash
node dist/cli.js sdk-probe \
  --model gpt-5.4 \
  --turn-timeout-ms 600000 \
  --trace-file /tmp/codex-gtd-sdk-probe.json \
  --raw-cli \
  --json
```

Expected result:

- `status` is `done`.
- `finalResponse` is present.
- `rawCli` includes exit details and warning classification if stderr produced
  known local-tooling warnings.

## 3. Run a Small Codex Team Task

`run` is the main Codex team workflow. It uses the Codex SDK for the
researcher/manager/developer/tester roles and writes all durable state to the run
directory.

Create a small task file outside `runs/`:

```bash
cat > /tmp/codex-gtd-cli-smoke.md <<'EOF'
Create workspace/SMOKE.md with exactly this line:
CLI smoke ok.
EOF
```

Run one manager loop first:

```bash
node dist/cli.js run \
  --task /tmp/codex-gtd-cli-smoke.md \
  --run-dir runs/manual-cli-smoke \
  --model gpt-5.4 \
  --turn-timeout-ms 600000 \
  --max-loops 1 \
  --skip-discovery
```

Expected result:

- `runs/manual-cli-smoke/` contains `progress.md`, `run-summary.json`,
  `session-log/`, `session-log/events/`, `session-log/inflight/`, and
  `workspace/`.
- If the run stops at `max_loops_reached`, that is acceptable for this short
  first pass.

## 4. Run a Small CC Team Task

`cc-run` is the experimental Claude Code SDK workflow. It is intentionally
smaller than the Codex team loop: one developer turn writes under `workspace/`,
one tester turn verifies the files and returns structured JSON. Use this when
you want to validate Claude Code SDK connectivity and inspect what CC is doing
through `session-log/events/` and `session-log/inflight/`.

Set Anthropic-compatible environment variables first. Use real values in your
shell only; do not write tokens into repository files.

```bash
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
export ANTHROPIC_MODEL="claude-sonnet-4-5"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

For a Claude-compatible provider, substitute that provider's URL and model:

```bash
export ANTHROPIC_AUTH_TOKEN="..."
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_MODEL="MiniMax-M2.7"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

Create a small task:

```bash
cat > /tmp/codex-gtd-cc-smoke.md <<'EOF'
Create workspace/cc-smoke.txt with exactly this line:
CC smoke ok.
EOF
```

Run the CC team:

```bash
node dist/cli.js cc-run \
  --task /tmp/codex-gtd-cc-smoke.md \
  --run-dir runs/manual-cc-smoke \
  --model "$ANTHROPIC_MODEL" \
  --turn-timeout-ms 300000 \
  --max-loops 2 \
  --json
```

Expected result:

- `run-summary.json` has `provider: "claude-code"` and terminal `status`.
- `workspace/cc-smoke.txt` exists when the run is `done`.
- `tester-decision.json` records the tester's `done`, `develop`, or `ask_user`
  decision.
- `session-log/events/` contains ordered Claude Code SDK events for each role
  turn.
- `session-log/inflight/` contains latest role diagnostics with the role, model,
  status, classification, and detail.
- `interaction-request.json` exists only when Claude Code SDK asks for user input
  or an unapproved permission.

## 5. Inspect Codex Team Status

```bash
node dist/cli.js status --run-dir runs/manual-cli-smoke --json
```

Use these fields first:

- `terminalStatus`: final run state when `run-summary.json` exists.
- `failureCategory`: coarse reason for failed or incomplete runs.
- `protocolHealth`: should be `clean` for a usable run directory.
- `diagnostic`: latest SDK inflight role status when a turn is still active.
- `recommendedAction`: the next operator action, such as `resume_sdk`,
  `export_workspace`, `rerun`, or `inspect`.

## 6. Resume or Export Codex Team Output

If status recommends SDK resume:

```bash
node dist/cli.js resume \
  --run-dir runs/manual-cli-smoke \
  --execute \
  --model gpt-5.4 \
  --turn-timeout-ms 600000 \
  --max-loops 3
```

If status recommends exporting workspace output:

```bash
node dist/cli.js export-workspace \
  --run-dir runs/manual-cli-smoke \
  --out /tmp/codex-gtd-workspace.patch
```

Before applying generated output to another repository, prefer the guarded dry
run:

```bash
node dist/cli.js apply-workspace \
  --run-dir runs/manual-cli-smoke \
  --target /path/to/repo
```

Then apply only when the target repo is clean and the dry run passes:

```bash
node dist/cli.js apply-workspace \
  --run-dir runs/manual-cli-smoke \
  --target /path/to/repo \
  --write
```

## 7. Local Verification Gates

Run these before treating a CLI change as ready:

```bash
npm run typecheck
npm run test:core
git diff --check
```

Use `npm run test:local` when a change also touches Web/server protocol behavior.

## Troubleshooting

- `doctor` warning on `sdk-health-baseline`: run `sdk-probe` or a small `run` to
  establish a fresh local baseline.
- `status` recommends `wait`: inspect `session-log/inflight/` or rerun
  `status --json` after the active turn has had time to emit events.
- `status` recommends `resume_sdk`: run `resume --run-dir <run-dir>` first to see
  the suggested command; it preserves the recorded model, timeout, and max loop
  settings.
- `protocolHealth` is not `clean`: use `repair-plan --run-dir <run-dir>` before
  trying to resume.
