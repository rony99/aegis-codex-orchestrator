# CLI Trial Guide

This guide is the shortest path for testing the core Codex team loop before using
the Web UI. Treat the CLI as the source of truth: Web/server should only reflect
the same run directory and protocol files.

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

## 3. Run a Small Task

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

## 4. Inspect Status

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

## 5. Resume or Export

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

## 6. Local Verification Gates

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
