import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunSummary, RUN_PROTOCOL_ENTRIES } from "../dist/driver.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
}

async function writeSummary(runsDir, id, overrides = {}) {
  const runDir = path.join(runsDir, id);
  await mkdir(runDir, { recursive: true });
  const summary = buildRunSummary({
    runDir,
    status: "done",
    reason: "ok",
    model: "gpt-5.4",
    taskFile: path.join(runDir, "task.md"),
    startedAt: "2026-04-23T00:00:00.000Z",
    endedAt: "2026-04-23T00:00:01.000Z",
    durationMs: 1000,
    maxLoops: 8,
    turnTimeoutMs: 300000,
    options: {
      observe: false,
      monitorSdk: true,
      skipDiscovery: false,
    },
    snippetCandidates: [],
    failureCategory: "none",
    metrics: {
      sessionLogEntries: 3,
      roleTurns: {
        manager: 1,
        tester: 1,
        developer: 1,
      },
    },
    ...overrides,
  });
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

test("help documents run options without invoking Codex SDK", () => {
  const output = execFileSync(process.execPath, [CLI, "--help"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });

  assert.match(output, /codex-gtd v0\.3/);
  assert.match(output, /--skip-discovery/);
  assert.match(output, /codex-gtd report \[--runs-dir <dir>\] \[--limit <n>\]/);
  assert.match(output, /--monitor-sdk\|--skip-sdk-monitor/);
  assert.match(output, /codex-5\.3-spark -> gpt-5\.3-codex-spark/);
});

test("run requires a task path before any SDK call", () => {
  const result = runCli(["run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /run requires --task <task-file>/);
});

test("invalid numeric flags fail fast before any SDK call", () => {
  const timeoutResult = runCli(["run", "--task", "examples/todo-exporter-task.md", "--turn-timeout-ms", "0"]);
  assert.equal(timeoutResult.status, 1);
  assert.match(timeoutResult.stderr, /--turn-timeout-ms must be a positive integer/);

  const loopResult = runCli(["run", "--task", "examples/todo-exporter-task.md", "--max-loops", "0"]);
  assert.equal(loopResult.status, 1);
  assert.match(loopResult.stderr, /--max-loops must be a positive integer/);
});

test("unknown flags fail fast before any SDK call", () => {
  const result = runCli(["run", "--task", "examples/todo-exporter-task.md", "--not-a-real-flag"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --not-a-real-flag/);
});

test("report summarizes run-summary files without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-report-"));

  try {
    await writeSummary(runsDir, "run-a", {
      status: "done",
      reason: "finished",
      endedAt: "2026-04-23T00:00:03.000Z",
      durationMs: 3000,
      sdkMonitor: {
        status: "ok",
        model: "gpt-5.4",
        sdkVersion: "0.123.0",
        passed: true,
        checkedAt: "2026-04-23T00:00:00.100Z",
      },
    });
    await writeSummary(runsDir, "run-b", {
      status: "ask_user",
      reason: "missing key",
      failureCategory: "sdk_failed",
      endedAt: "2026-04-23T00:00:02.000Z",
      durationMs: 1000,
      sdkMonitor: {
        status: "failed",
        model: "gpt-5.4",
        sdkVersion: "0.123.0",
        passed: false,
        reason: "probe failed",
        checkedAt: "2026-04-23T00:00:00.100Z",
      },
    });
    await writeSummary(runsDir, "run-c", {
      status: "max_loops_reached",
      reason: "loop limit",
      failureCategory: "max_loops",
      endedAt: "2026-04-23T00:00:01.000Z",
      durationMs: 2000,
      observer: {
        runDir: path.join(runsDir, "run-c"),
        status: "failed",
        reason: "observer failed",
      },
    });

    const result = runCli(["report", "--runs-dir", runsDir, "--limit", "2"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Total runs: 3/);
    assert.match(result.stdout, /Done: 1/);
    assert.match(result.stdout, /Ask user: 1/);
    assert.match(result.stdout, /Max loops reached: 1/);
    assert.match(result.stdout, /Average duration: 2s/);
    assert.match(result.stdout, /SDK monitor failures: 1/);
    assert.match(result.stdout, /Observer failures: 1/);
    assert.match(result.stdout, /Failure categories:/);
    assert.match(result.stdout, /none: 1/);
    assert.match(result.stdout, /sdk_failed: 1/);
    assert.match(result.stdout, /max_loops: 1/);
    assert.match(result.stdout, /ask_user\/sdk_failed/);
    assert.match(result.stdout, /run-a/);
    assert.match(result.stdout, /run-b/);
    assert.doesNotMatch(result.stdout, /run-c/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("run summary captures machine-readable terminal state", () => {
  const summary = buildRunSummary({
    runDir: "/tmp/aegis-run",
    status: "ask_user",
    reason: "missing credentials",
    model: "gpt-5.3-codex-spark",
    taskFile: "/tmp/task.md",
    startedAt: "2026-04-23T00:00:00.000Z",
    endedAt: "2026-04-23T00:00:01.000Z",
    durationMs: 1000,
    maxLoops: 2,
    turnTimeoutMs: 300000,
    options: {
      observe: false,
      monitorSdk: true,
      skipDiscovery: true,
    },
    sdkMonitor: {
      status: "ok",
      model: "gpt-5.3-codex-spark",
      sdkVersion: "0.123.0",
      passed: true,
      checkedAt: "2026-04-23T00:00:00.100Z",
    },
    snippetCandidates: [],
    terminalRole: "manager",
    failureCategory: "blocker",
    metrics: {
      sessionLogEntries: 2,
      roleTurns: {
        manager: 2,
      },
    },
  });

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.status, "ask_user");
  assert.equal(summary.model, "gpt-5.3-codex-spark");
  assert.equal(summary.options.skipDiscovery, true);
  assert.equal(summary.sdkMonitor?.passed, true);
  assert.equal(summary.terminalRole, "manager");
  assert.equal(summary.failureCategory, "blocker");
  assert.equal(summary.metrics.sessionLogEntries, 2);
  assert.deepEqual(summary.metrics.roleTurns, { manager: 2 });
  assert.deepEqual(summary.protocol.requiredEntries, RUN_PROTOCOL_ENTRIES);
  assert.ok(summary.protocol.requiredEntries.includes("run-summary.json"));
});
