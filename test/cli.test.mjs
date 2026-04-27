import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProgressDocument,
  buildRunRepairPlan,
  buildRunSummary,
  buildResumePlan,
  classifyRunFailure,
  evaluateCloseoutGate,
  applyWorkspacePatch,
  executeResumePlan,
  exportWorkspacePatch,
  runSdkProbe,
  resolveRoleFallbackModel,
  buildObserverProtocolHealthSection,
  initializeRunProtocol,
  parseManagerDecision,
  parseSnippetCandidateEntries,
  parseSnippetDecision,
  parseProgressState,
  promoteSnippetCandidate,
  runReport,
  selectObserverLessonsContent,
  RUN_PROTOCOL_ENTRIES,
  updateProgressDocument,
  validateApiProbesReadme,
  validateRunProtocol,
  compareProgressRunSummary,
} from "../dist/driver.js";
import {
  MANAGER_PROMPT_MAX_CHARS,
  OBSERVER_PROMPT_MAX_CHARS,
  OBSERVER_SESSION_LOG_MAX_ENTRIES,
  OBSERVER_TRUNCATION_MARKER,
  compactObserverText,
  managerPrompt,
  observerPrompt,
} from "../dist/prompts.js";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const VALID_API_PROBES_README = `# API Probes

## Probe Decision
No external dependency.

## External Dependencies
None.

## Probe Artifacts
None.

## Recorded Results
Not required.

## Known Limitations
None.
`;

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

async function writeHealthyRunSummary(runsDir, id, overrides = {}) {
  const runDir = path.join(runsDir, id);
  await initializeRunProtocol({
    runDir,
    task: "# Task\n\nBuild a local CLI.",
    model: "gpt-5.4",
    startedAt: "2026-04-24T00:00:00.000Z",
  });
  await writeFile(path.join(runDir, "spec.md"), "# Spec\n\nNo-op implementation.\n", "utf8");
  await writeFile(path.join(runDir, "interfaces.md"), "# Interfaces\n\nNo-op interface.\n", "utf8");
  await writeFile(path.join(runDir, "api-probes", "README.md"), VALID_API_PROBES_README, "utf8");

  const summary = await writeSummary(runsDir, id, {
    status: "done",
    failureCategory: "none",
    terminalRole: "manager",
    reason: "protocol health check",
    endedAt: "2026-04-24T00:00:01.000Z",
    durationMs: 1000,
    metrics: {
      sessionLogEntries: 1,
      roleTurns: {
        manager: 2,
      },
    },
    ...overrides,
  });
  const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
    status: "done",
    lastUpdatedAt: summary.endedAt,
    lastRole: summary.terminalRole ?? "manager",
    loop: summary.metrics.roleTurns.manager ?? 0,
    terminal: true,
    reason: summary.reason,
  });
  await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
  return summary;
}

test("help documents run options without invoking Codex SDK", () => {
  const output = execFileSync(process.execPath, [CLI, "--help"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });

  assert.match(output, /codex-gtd v0\.5/);
  assert.match(output, /--skip-discovery/);
  assert.match(output, /codex-gtd report \[--runs-dir <dir>\] \[--limit <n>\]/);
  assert.match(output, /codex-gtd repair-plan --run-dir <run-dir> \[--json\]/);
  assert.match(output, /codex-gtd export-workspace --run-dir <run-dir> \[--out <patch-file>\]/);
  assert.match(output, /codex-gtd apply-workspace --run-dir <run-dir> --target <repo-dir> \[--write\]/);
  assert.match(output, /codex-gtd resume --run-dir <run-dir> \[--target <repo-dir>\] \[--execute\] \[--write\] \[--model <model>\] \[--web-search <disabled\|cached\|live>\] \[--snippets-dir <dir>\] \[--turn-timeout-ms <ms>\] \[--max-loops <n>\] \[--observe\]/);
  assert.match(output, /codex-gtd promote-snippet --candidate <candidate-file> --slug <slug>/);
  assert.match(output, /--monitor-sdk\|--skip-sdk-monitor/);
  assert.match(output, /--web-search <disabled\|cached\|live>/);
  assert.match(output, /codex-gtd status --run-dir <run-dir> \[--json\]/);
  assert.match(output, /codex-gtd sdk-probe \[--model <model>\]/);
  assert.match(output, /\[--raw-cli\]/);
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

test("invalid web search mode fails fast before any SDK call", () => {
  const result = runCli(["run", "--task", "examples/todo-exporter-task.md", "--web-search", "auto"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--web-search must be one of: disabled, cached, live/);
});

test("sdk probe records streamed events to a trace file", async () => {
  const probeDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-sdk-probe-"));
  const traceFile = path.join(probeDir, "trace.json");

  try {
    const fakeCodex = {
      startThread(options) {
        assert.equal(options.model, "gpt-5.4");
        assert.equal(options.sandboxMode, "read-only");
        assert.equal(options.approvalPolicy, "never");
        assert.equal(options.skipGitRepoCheck, true);
        return {
          id: "probe-thread",
          async runStreamed(prompt, runOptions) {
            assert.match(prompt, /Codex SDK smoke test/);
            assert.ok(runOptions.signal);
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: "probe-thread" };
                yield { type: "turn.started" };
                yield {
                  type: "item.completed",
                  item: {
                    id: "message-1",
                    type: "agent_message",
                    text: "probe ok",
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: 1,
                  },
                };
              })(),
            };
          },
        };
      },
    };

    const result = await runSdkProbe({
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
      traceFile,
    });

    assert.equal(result.status, "done");
    assert.equal(result.threadId, "probe-thread");
    assert.equal(result.events.length, 4);
    assert.equal(result.finalResponse, "probe ok");

    const trace = JSON.parse(await readFile(traceFile, "utf8"));
    assert.equal(trace.status, "done");
    assert.equal(trace.events.length, 4);
    assert.equal(trace.events[0].event.type, "thread.started");
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("sdk probe captures top-level stream errors as diagnostics", async () => {
  const fakeCodex = {
    startThread() {
      return {
        id: "probe-thread-error",
        async runStreamed() {
          return {
            events: (async function* () {
              yield { type: "thread.started", thread_id: "probe-thread-error" };
              yield { type: "turn.started" };
              yield {
                type: "error",
                message: "Reconnecting... 2/5 (timeout waiting for child process to exit)",
              };
            })(),
          };
        },
      };
    },
  };

  const result = await runSdkProbe({
    codex: fakeCodex,
    model: "gpt-5.4",
    turnTimeoutMs: 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.events.length, 3);
  assert.equal(result.error?.eventType, "error");
  assert.equal(result.error?.classification, "sdk_reconnect_failed");
  assert.match(result.error?.detail ?? "", /Codex SDK stream reconnected or disconnected/);
});

test("sdk probe can use raw Codex CLI output for subprocess diagnostics", async () => {
  const probeDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-raw-cli-probe-"));
  const traceFile = path.join(probeDir, "trace.json");

  try {
    const result = await runSdkProbe({
      rawCli: true,
      rawCliRunner: async ({ args, input }) => {
        assert.deepEqual(args, [
          "exec",
          "--experimental-json",
          "--model",
          "gpt-5.4",
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--config",
          'approval_policy="never"',
        ]);
        assert.match(input, /Codex SDK smoke test/);
        return {
          stdoutLines: [
            JSON.stringify({ type: "thread.started", thread_id: "raw-thread" }),
            JSON.stringify({ type: "turn.started" }),
            JSON.stringify({
              type: "error",
              message: "Reconnecting... 2/5 (timeout waiting for child process to exit)",
            }),
          ],
          stderr: "raw stderr details",
          exitCode: 0,
          signal: null,
        };
      },
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
      traceFile,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.threadId, "raw-thread");
    assert.equal(result.events.length, 3);
    assert.equal(result.rawCli?.stderr, "raw stderr details");
    assert.equal(result.rawCli?.exitCode, 0);
    assert.equal(result.error?.eventType, "error");
    assert.equal(result.error?.classification, "sdk_reconnect_failed");

    const trace = JSON.parse(await readFile(traceFile, "utf8"));
    assert.equal(trace.rawCli.stderr, "raw stderr details");
    assert.equal(trace.rawCli.stdoutLines.length, 3);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
});

test("unknown flags fail fast before any SDK call", () => {
  const result = runCli(["run", "--task", "examples/todo-exporter-task.md", "--not-a-real-flag"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --not-a-real-flag/);
});

test("promote-snippet requires candidate and slug before any SDK call", () => {
  const noCandidate = runCli(["promote-snippet", "--slug", "approved-snippet"]);
  assert.equal(noCandidate.status, 1);
  assert.match(noCandidate.stderr, /promote-snippet requires --candidate <candidate-file>/);

  const noSlug = runCli(["promote-snippet", "--candidate", "snippets/_candidates/example.md"]);
  assert.equal(noSlug.status, 1);
  assert.match(noSlug.stderr, /promote-snippet requires --slug <slug>/);
});

test("promote-snippet rejects unsafe slugs before any SDK call", () => {
  const result = runCli(["promote-snippet", "--candidate", "snippets/_candidates/example.md", "--slug", "../bad"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /slug must use lowercase letters, numbers, and hyphens/);
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
    await writeFile(path.join(runsDir, "run-a", "spec.md"), `# Spec

## Snippet Decision
Status: used
Snippet: Parser edge-case validation
Reason: Parser validation checks match the task.
`, "utf8");
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
    await writeFile(path.join(runsDir, "run-b", "spec.md"), `# Spec

## Snippet Decision
Status: none
Snippet: none
Reason: No matching snippet.
`, "utf8");
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
    await writeFile(path.join(runsDir, "run-c", "spec.md"), `# Spec

## Snippet Decision
Status: rejected
Snippet: HTTP JSON fetch + summary
Reason: Task has no HTTP dependency.
`, "utf8");
    await writeSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      endedAt: "2026-04-23T00:00:00.500Z",
      durationMs: 500,
    });
    await writeSummary(runsDir, "run-unsupported-tool", {
      status: "ask_user",
      reason: "Manager failed: Tool 'image_generation' is not supported with gpt-5.3-codex-spark",
      failureCategory: "unsupported_tool",
      endedAt: "2026-04-23T00:00:00.250Z",
      durationMs: 250,
    });

    const report = await runReport({ runsDir, limit: 2 });
    assert.deepEqual(report.snippetUsage, {
      used: 1,
      rejected: 1,
      none: 1,
      unknown: 2,
    });
    assert.equal(report.failureCategories.turn_timeout, 1);
    assert.equal(report.failureCategories.unsupported_tool, 1);
    assert.equal(report.recentRuns[0].failureCategory, "none");
    assert.equal(report.recentRuns[1].failureCategory, "sdk_failed");

    const result = runCli(["report", "--runs-dir", runsDir, "--limit", "5"]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Total runs: 5/);
    assert.match(result.stdout, /Done: 1/);
    assert.match(result.stdout, /Ask user: 3/);
    assert.match(result.stdout, /Max loops reached: 1/);
    assert.match(result.stdout, /Average duration: 1s/);
    assert.match(result.stdout, /SDK monitor failures: 1/);
    assert.match(result.stdout, /Observer failures: 1/);
    assert.match(result.stdout, /Failure categories:/);
    assert.match(result.stdout, /Snippet usage: used=1 rejected=1 none=1 unknown=2/);
    assert.match(result.stdout, /none: 1/);
    assert.match(result.stdout, /sdk_failed: 1/);
    assert.match(result.stdout, /turn_timeout: 1/);
    assert.match(result.stdout, /unsupported_tool: 1/);
    assert.match(result.stdout, /max_loops: 1/);
    assert.match(result.stdout, /ask_user\/sdk_failed/);
    assert.match(result.stdout, /ask_user\/turn_timeout/);
    assert.match(result.stdout, /ask_user\/unsupported_tool/);
    assert.match(result.stdout, /snippet=used:Parser edge-case validation/);
    assert.match(result.stdout, /snippet=none/);
    assert.match(result.stdout, /run-a/);
    assert.match(result.stdout, /run-b/);
    assert.match(result.stdout, /run-c/);
    assert.match(result.stdout, /run-timeout/);
    assert.match(result.stdout, /run-unsupported-tool/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status recommends workspace export for a completed run", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-done-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-done", {
      status: "done",
      failureCategory: "none",
      reason: "finished with verification",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-done");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Run status:/);
    assert.match(result.stdout, /Terminal status: done/);
    assert.match(result.stdout, /Failure category: none/);
    assert.match(result.stdout, /Protocol health: clean/);
    assert.match(result.stdout, /Recommended action: export_workspace/);
    assert.match(result.stdout, /codex-gtd export-workspace --run-dir/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status can emit machine-readable json", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-json-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-done", {
      status: "done",
      failureCategory: "none",
      reason: "finished with verification",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-done");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");

    const result = runCli(["status", "--run-dir", runDir, "--json"]);

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Run status:/);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.runDir, runDir);
    assert.equal(parsed.terminalStatus, "done");
    assert.equal(parsed.failureCategory, "none");
    assert.equal(parsed.protocolHealth, "clean");
    assert.equal(parsed.recommendedAction, "export_workspace");
    assert.ok(parsed.commands.some((command) => command.includes("codex-gtd export-workspace")));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status surfaces inflight diagnostics for a currently running turn", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-running-"));

  try {
    const runDir = path.join(runsDir, "run-running");
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    await mkdir(path.join(runDir, "session-log", "inflight"), { recursive: true });
    await writeFile(path.join(runDir, "session-log", "inflight", "2026-04-24T00-00-01-manager.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-running",
      status: "running",
      startedAt: "2026-04-24T00:00:01.000Z",
      lastUpdatedAt: "2026-04-24T00:00:31.000Z",
      lastEventAt: "2026-04-24T00:00:30.000Z",
      idleMs: 1000,
      classification: "command_running",
      detail: "Command is still running: npm test",
      lastEventType: "item.started",
    }, null, 2)}\n`, "utf8");

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: running/);
    assert.match(result.stdout, /Current diagnosis: command_running/);
    assert.match(result.stdout, /Diagnostic detail: Command is still running: npm test/);
    assert.match(result.stdout, /Recommended action: wait/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status treats progress drift as pending while a turn is running", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-running-drift-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-resuming", {
      status: "ask_user",
      reason: "Manager failed before resume",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-resuming");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "running",
      lastUpdatedAt: "2026-04-24T00:00:31.000Z",
      lastRole: "driver",
      loop: 2,
      terminal: false,
      reason: undefined,
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
    await mkdir(path.join(runDir, "session-log", "inflight"), { recursive: true });
    await writeFile(path.join(runDir, "session-log", "inflight", "2026-04-24T00-00-31-manager.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-running",
      status: "running",
      startedAt: "2026-04-24T00:00:31.000Z",
      lastUpdatedAt: "2026-04-24T00:01:01.000Z",
      lastEventAt: "2026-04-24T00:01:00.000Z",
      idleMs: 1000,
      classification: "model_running",
      detail: "The SDK turn started and is waiting for model/tool events.",
      lastEventType: "turn.started",
    }, null, 2)}\n`, "utf8");

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: running/);
    assert.match(result.stdout, /Protocol health: pending/);
    assert.doesNotMatch(result.stdout, /Progress\/run-summary drift/);
    assert.match(result.stdout, /Recommended action: wait/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status recommends sdk resume for a recoverable failed run", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-resume-sdk-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.3-codex-spark",
      threadId: "thread-manager-timeout",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "manager prompt",
      error: { name: "AbortError", message: "The operation was aborted" },
    }, null, 2)}\n`, "utf8");

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: ask_user/);
    assert.match(result.stdout, /Failure category: turn_timeout/);
    assert.match(result.stdout, /Protocol health: clean/);
    assert.match(result.stdout, /Recommended action: resume_sdk/);
    assert.match(result.stdout, /codex-gtd resume --run-dir/);
    assert.match(result.stdout, /--execute/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status recommends rerun for timeout threads without completed sdk work", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-incomplete-timeout-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-timeout",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "manager prompt",
      diagnostic: {
        classification: "idle_until_turn_timeout",
        lastEventType: "turn.started",
      },
    }, null, 2)}\n`, "utf8");

    const result = runCli(["status", "--run-dir", runDir, "--json"]);

    assert.equal(result.status, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.protocolHealth, "clean");
    assert.equal(status.recommendedAction, "rerun");
    assert.match(status.summary, /timed out before completing any SDK work/);
    assert.ok(status.commands.some((command) => command.includes("codex-gtd run --task")));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status prioritizes protocol repair for broken runs", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-repair-protocol-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-broken", {
      status: "ask_user",
      reason: "Manager failed: invalid decision",
      failureCategory: "invalid_manager_decision",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-broken");
    await rm(path.join(runDir, "interfaces.md"), { force: true });

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: ask_user/);
    assert.match(result.stdout, /Protocol health: unhealthy/);
    assert.match(result.stdout, /Missing required protocol entries: interfaces\.md/);
    assert.match(result.stdout, /Recommended action: repair_protocol/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status gives sdk failure guidance when sdk fails before protocol artifacts", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-early-sdk-failed-"));

  try {
    const runDir = path.join(runsDir, "run-sdk-failed");
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    const summary = await writeSummary(runsDir, "run-sdk-failed", {
      status: "ask_user",
      reason: "Researcher failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
      failureCategory: "sdk_failed",
      terminalRole: "researcher",
      taskFile: path.join(runDir, "task.md"),
      endedAt: "2026-04-24T00:00:03.000Z",
      metrics: {
        sessionLogEntries: 1,
        roleTurns: {
          researcher: 1,
        },
      },
      options: {
        observe: false,
        monitorSdk: false,
        skipDiscovery: true,
      },
    });
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "blocked",
      lastUpdatedAt: summary.endedAt,
      lastRole: "researcher",
      loop: 0,
      terminal: true,
      reason: summary.reason,
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    const result = runCli(["status", "--run-dir", runDir, "--json"]);

    assert.equal(result.status, 0);
    const status = JSON.parse(result.stdout);
    assert.equal(status.protocolHealth, "unhealthy");
    assert.equal(status.failureCategory, "sdk_failed");
    assert.equal(status.recommendedAction, "inspect");
    assert.match(status.summary, /SDK\/CLI failed before required protocol artifacts/);
    assert.ok(status.commands.some((command) => command.includes("codex-gtd smoke --model gpt-5.4")));
    assert.ok(status.commands.some((command) => command.includes("codex-gtd run --task")));
    assert.ok(status.commands.some((command) => command.includes("--skip-discovery")));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status recommends inspect when no summary exists and no turn is running", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-inspect-"));

  try {
    const runDir = path.join(runsDir, "run-no-summary");
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    await writeFile(path.join(runDir, "spec.md"), "# Spec\n\nNo-op implementation.\n", "utf8");
    await writeFile(path.join(runDir, "interfaces.md"), "# Interfaces\n\nNo-op interface.\n", "utf8");
    await writeFile(path.join(runDir, "api-probes", "README.md"), VALID_API_PROBES_README, "utf8");

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: unknown/);
    assert.match(result.stdout, /Failure category: unknown/);
    assert.match(result.stdout, /Protocol health: clean/);
    assert.match(result.stdout, /Recommended action: inspect/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("status reclassifies historical observer-failed sdk reconnect summaries", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-status-reconnect-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-reconnect", {
      status: "ask_user",
      reason: "Manager failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
      failureCategory: "observer_failed",
      terminalRole: "observer",
      observer: {
        runDir: path.join(runsDir, "run-reconnect"),
        status: "failed",
        reason: "Observer failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
      },
      options: {
        observe: true,
        monitorSdk: false,
        skipDiscovery: true,
      },
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-reconnect");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "observer",
      loop: 2,
      terminal: true,
      reason: "Manager failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    const plan = await buildRunRepairPlan({ runDir });
    assert.equal(plan.action, "inspect");
    assert.equal(plan.failureCategory, "sdk_failed");
    assert.match(plan.summary, /Codex SDK\/CLI failed/);
    assert.ok(plan.commands.some((command) => command.includes("codex-gtd smoke --model gpt-5.4")));
    assert.ok(plan.commands.some((command) => command.includes("codex-gtd run --task")));
    assert.ok(plan.commands.some((command) => command.includes("--skip-discovery")));

    const result = runCli(["status", "--run-dir", runDir]);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Terminal status: ask_user/);
    assert.match(result.stdout, /Failure category: sdk_failed/);
    assert.match(result.stdout, /Protocol health: clean/);
    assert.match(result.stdout, /Recommended action: inspect/);
    assert.match(result.stdout, /Codex SDK\/CLI failed/);
    assert.match(result.stdout, /codex-gtd smoke --model gpt-5\.4/);
    assert.match(result.stdout, /--skip-discovery/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("parseSnippetDecision reads structured spec decisions", () => {
  assert.deepEqual(parseSnippetDecision(`# Spec

## Snippet Decision
Status: used
Snippet: Parser edge-case validation
Reason: Reuses parser edge cases.
`), {
    status: "used",
    snippet: "Parser edge-case validation",
    reason: "Reuses parser edge cases.",
  });

  assert.deepEqual(parseSnippetDecision(`# Spec

## Snippet Decision
- Status: rejected
- Snippet: HTTP JSON fetch + summary
- Reason: No HTTP dependency.
`), {
    status: "rejected",
    snippet: "HTTP JSON fetch + summary",
    reason: "No HTTP dependency.",
  });

  assert.deepEqual(parseSnippetDecision("# Spec\n\nNo decision.\n"), {
    status: "unknown",
  });
});

test("report aggregates protocol health without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-protocol-report-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-healthy", {
      endedAt: "2026-04-24T00:00:04.000Z",
      durationMs: 1000,
    });

    await writeHealthyRunSummary(runsDir, "run-missing-required", {
      endedAt: "2026-04-24T00:00:03.000Z",
      durationMs: 1000,
    });
    await rm(path.join(runsDir, "run-missing-required", "interfaces.md"), { force: true });

    await writeHealthyRunSummary(runsDir, "run-invalid-api-probes", {
      endedAt: "2026-04-24T00:00:02.000Z",
      durationMs: 1000,
    });
    await writeFile(path.join(runsDir, "run-invalid-api-probes", "api-probes", "README.md"), `# API Probes

## Probe Decision
No external dependency.

## Probe Artifacts
None.

## Known Limitations
None.
`, "utf8");

    await writeHealthyRunSummary(runsDir, "run-drift", {
      endedAt: "2026-04-24T00:00:01.000Z",
      durationMs: 1000,
    });
    const driftProgress = updateProgressDocument(await readFile(path.join(runsDir, "run-drift", "progress.md"), "utf8"), {
      status: "running",
      lastRole: "driver",
      loop: 0,
      terminal: false,
      reason: "not finished",
    });
    await writeFile(path.join(runsDir, "run-drift", "progress.md"), driftProgress, "utf8");

    const report = await runReport({ runsDir, limit: 4 });
    assert.deepEqual(report.protocolHealth, {
      missingRequiredProtocolEntriesCount: 1,
      invalidOrMissingApiProbesReadmeSectionsCount: 1,
      progressRunSummaryDriftCount: 1,
    });
    assert.equal(report.recentRuns[0].protocolHealth.missingRequiredEntries, false);
    assert.equal(report.recentRuns[1].protocolHealth.missingRequiredEntries, true);
    assert.equal(report.recentRuns[2].protocolHealth.invalidApiProbesReadmeSections, true);
    assert.equal(report.recentRuns[3].protocolHealth.progressRunSummaryDrift, true);

    const result = runCli(["report", "--runs-dir", runsDir, "--limit", "4"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Protocol health: missing-required-entries=1/);
    assert.match(result.stdout, /Protocol health: invalid-or-missing-api-probes-readme-sections=1/);
    assert.match(result.stdout, /Protocol health: progress-run-summary-drift=1/);
    assert.match(result.stdout, /protocolHealth=/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("repair-plan recommends deterministic recovery for timeout runs without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-repair-plan-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Researcher failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "researcher",
      model: "gpt-5.3-codex-spark",
      taskFile: path.join(runsDir, "task.md"),
      turnTimeoutMs: 300000,
      options: {
        observe: false,
        monitorSdk: true,
        skipDiscovery: true,
        webSearchMode: "live",
      },
      metrics: {
        sessionLogEntries: 1,
        roleTurns: {
          researcher: 1,
        },
      },
      endedAt: "2026-04-24T00:00:03.000Z",
    });

    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "researcher",
      loop: 0,
      terminal: true,
      reason: "Researcher failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    const plan = await buildRunRepairPlan({ runDir });

    assert.equal(plan.action, "rerun");
    assert.equal(plan.resumable, false);
    assert.equal(plan.failureCategory, "turn_timeout");
    assert.match(plan.summary, /timed out/i);
    assert.deepEqual(plan.issues, []);
    assert.ok(plan.commands.some((command) => command.includes("--model gpt-5.4")));
    assert.ok(plan.commands.some((command) => command.includes("--turn-timeout-ms 600000")));
    assert.ok(plan.commands.some((command) => command.includes("--skip-discovery")));
    assert.ok(plan.commands.some((command) => command.includes("--web-search live")));

    const result = runCli(["repair-plan", "--run-dir", runDir]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Repair plan:/);
    assert.match(result.stdout, /Action: rerun/);
    assert.match(result.stdout, /--model gpt-5\.4/);
    assert.match(result.stdout, /--turn-timeout-ms 600000/);
    assert.match(result.stdout, /--skip-discovery/);
    assert.match(result.stdout, /--web-search live/);

    const jsonResult = runCli(["repair-plan", "--run-dir", runDir, "--json"]);
    assert.equal(jsonResult.status, 0);
    assert.doesNotMatch(jsonResult.stdout, /Repair plan:/);
    const parsed = JSON.parse(jsonResult.stdout);
    assert.equal(parsed.action, "rerun");
    assert.equal(parsed.failureCategory, "turn_timeout");
    assert.ok(parsed.commands.some((command) => command.includes("--skip-discovery")));
    assert.ok(parsed.commands.some((command) => command.includes("--web-search live")));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("repair-plan blocks resume when protocol health is broken", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-repair-protocol-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-broken", {
      status: "ask_user",
      reason: "Manager failed: invalid decision",
      failureCategory: "invalid_manager_decision",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-broken");
    await rm(path.join(runDir, "interfaces.md"), { force: true });

    const plan = await buildRunRepairPlan({ runDir });

    assert.equal(plan.action, "repair_protocol");
    assert.equal(plan.resumable, false);
    assert.match(plan.summary, /protocol health/i);
    assert.ok(plan.issues.some((issue) => issue.includes("Missing required protocol entries: interfaces.md")));

    const result = runCli(["repair-plan", "--run-dir", runDir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Action: repair_protocol/);
    assert.match(result.stdout, /Missing required protocol entries: interfaces\.md/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("export-workspace writes a reviewable patch without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-export-workspace-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-with-workspace", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-with-workspace");
    await mkdir(path.join(runDir, "workspace", "src"), { recursive: true });
    await writeFile(path.join(runDir, "workspace", "src", "cli.js"), "console.log('hello');\n", "utf8");
    await writeFile(path.join(runDir, "workspace", "README.md"), "# Exported tool\n", "utf8");
    const outFile = path.join(runsDir, "workspace.patch");

    const result = await exportWorkspacePatch({ runDir, outFile });
    const patch = await readFile(outFile, "utf8");

    assert.equal(result.fileCount, 2);
    assert.equal(result.outFile, outFile);
    assert.match(patch, /diff --git a\/README\.md b\/README\.md/);
    assert.match(patch, /\+\# Exported tool/);
    assert.match(patch, /diff --git a\/src\/cli\.js b\/src\/cli\.js/);
    assert.match(patch, /\+console\.log\('hello'\);/);

    const cliResult = runCli(["export-workspace", "--run-dir", runDir, "--out", path.join(runsDir, "cli.patch")]);
    assert.equal(cliResult.status, 0);
    assert.match(cliResult.stdout, /Workspace patch:/);
    assert.match(cliResult.stdout, /Files: 2/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("export-workspace rejects empty workspaces", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-export-empty-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-empty", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-empty");

    await assert.rejects(
      () => exportWorkspacePatch({ runDir }),
      /workspace is empty/,
    );

    const cliResult = runCli(["export-workspace", "--run-dir", runDir]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stderr, /workspace is empty/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("apply-workspace dry-runs by default and writes only with explicit flag", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-apply-workspace-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-target-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-with-workspace", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-with-workspace");
    await mkdir(path.join(runDir, "workspace", "src"), { recursive: true });
    await writeFile(path.join(runDir, "workspace", "src", "cli.js"), "console.log('applied');\n", "utf8");
    execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });

    const dryRun = await applyWorkspacePatch({ runDir, targetDir });
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.fileCount, 1);
    await assert.rejects(
      () => readFile(path.join(targetDir, "src", "cli.js"), "utf8"),
      /ENOENT/,
    );

    const cliDryRun = runCli(["apply-workspace", "--run-dir", runDir, "--target", targetDir]);
    assert.equal(cliDryRun.status, 0);
    assert.match(cliDryRun.stdout, /Mode: dry-run/);
    assert.match(cliDryRun.stdout, /Patch check: passed/);

    const applied = await applyWorkspacePatch({ runDir, targetDir, write: true });
    assert.equal(applied.applied, true);
    assert.equal(await readFile(path.join(targetDir, "src", "cli.js"), "utf8"), "console.log('applied');\n");
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("apply-workspace refuses dirty target repositories", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-apply-dirty-run-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-apply-dirty-target-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-with-workspace", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-with-workspace");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });
    await writeFile(path.join(targetDir, "dirty.txt"), "untracked\n", "utf8");

    await assert.rejects(
      () => applyWorkspacePatch({ runDir, targetDir }),
      /target repository has uncommitted changes/,
    );

    const cliResult = runCli(["apply-workspace", "--run-dir", runDir, "--target", targetDir, "--write"]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stderr, /target repository has uncommitted changes/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("resume plans export or apply for completed runs with workspace output", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-plan-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-target-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-done", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-done");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });

    const exportPlan = await buildResumePlan({ runDir });
    assert.equal(exportPlan.action, "export_workspace");
    assert.equal(exportPlan.ready, true);
    assert.ok(exportPlan.commands.some((command) => command.includes("export-workspace")));

    const applyPlan = await buildResumePlan({ runDir, targetDir });
    assert.equal(applyPlan.action, "apply_workspace");
    assert.equal(applyPlan.ready, true);
    assert.ok(applyPlan.commands.some((command) => command.includes("apply-workspace")));
    assert.ok(applyPlan.commands.some((command) => command.includes("--write")));

    const cliResult = runCli(["resume", "--run-dir", runDir, "--target", targetDir]);
    assert.equal(cliResult.status, 0);
    assert.match(cliResult.stdout, /Resume plan:/);
    assert.match(cliResult.stdout, /Action: apply_workspace/);
    assert.match(cliResult.stdout, /apply-workspace/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("resume delegates user-blocked failed runs to repair-plan", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-failed-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-blocked", {
      status: "ask_user",
      reason: "Missing paid provider API key",
      failureCategory: "blocker",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-blocked");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "blocked",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Missing paid provider API key",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    const plan = await buildResumePlan({ runDir });

    assert.equal(plan.action, "answer_user");
    assert.equal(plan.ready, false);
    assert.equal(plan.source, "repair-plan");
    assert.equal(plan.commands.length, 0);

    const cliResult = runCli(["resume", "--run-dir", runDir]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stdout, /Source: repair-plan/);
    assert.match(cliResult.stdout, /Action: answer_user/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume plans sdk continuation for recoverable failed runs", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-plan-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.3-codex-spark",
      threadId: "thread-manager-timeout",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "manager prompt",
      error: { name: "AbortError", message: "The operation was aborted" },
    }, null, 2)}\n`, "utf8");

    const plan = await buildResumePlan({ runDir });

    assert.equal(plan.action, "resume_sdk");
    assert.equal(plan.ready, true);
    assert.equal(plan.source, "resume");
    assert.match(plan.summary, /Resume manager/);
    assert.ok(plan.commands.some((command) => command.includes("resume")));
    assert.ok(plan.commands.some((command) => command.includes("--execute")));

    const cliResult = runCli(["resume", "--run-dir", runDir]);
    assert.equal(cliResult.status, 0);
    assert.match(cliResult.stdout, /Action: resume_sdk/);
    assert.match(cliResult.stdout, /Ready: yes/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume blocks sdk continuation when recoverable run has no thread id", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-missing-thread-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    const plan = await buildResumePlan({ runDir });

    assert.equal(plan.action, "resume_sdk");
    assert.equal(plan.ready, false);
    assert.equal(plan.source, "resume");
    assert.ok(plan.issues.some((issue) => issue.includes("No resumable thread")));

    const cliResult = runCli(["resume", "--run-dir", runDir]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stdout, /Action: resume_sdk/);
    assert.match(cliResult.stdout, /Ready: no/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume blocks sdk continuation for timeout threads without completed sdk work", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-incomplete-timeout-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Researcher failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "researcher",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "researcher",
      loop: 0,
      terminal: true,
      reason: "Researcher failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-researcher-error.json"), `${JSON.stringify({
      role: "researcher",
      model: "gpt-5.4",
      threadId: "thread-researcher-timeout",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "researcher prompt",
      diagnostic: {
        role: "researcher",
        model: "gpt-5.4",
        threadId: "thread-researcher-timeout",
        status: "failed",
        startedAt: "2026-04-24T00:00:02.000Z",
        lastUpdatedAt: "2026-04-24T00:00:03.000Z",
        lastEventAt: "2026-04-24T00:00:02.100Z",
        idleMs: 900,
        classification: "idle_until_turn_timeout",
        detail: "No SDK event arrived before the 1000ms turn timeout after turn.started.",
        lastEventType: "turn.started",
      },
    }, null, 2)}\n`, "utf8");

    const plan = await buildResumePlan({ runDir });

    assert.equal(plan.action, "resume_sdk");
    assert.equal(plan.ready, false);
    assert.ok(plan.issues.some((issue) => issue.includes("timed out before completing any SDK work")));

    const cliResult = runCli(["resume", "--run-dir", runDir]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stdout, /Ready: no/);
    assert.match(cliResult.stdout, /timed out before completing any SDK work/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute exports completed workspace output", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-execute-export-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-done", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-done");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");

    const result = await executeResumePlan({ runDir });
    assert.equal(result.plan.action, "export_workspace");
    assert.equal(result.executed, true);
    assert.equal(result.exportResult?.fileCount, 1);
    assert.match(await readFile(path.join(runDir, "workspace.patch"), "utf8"), /diff --git a\/tool\.js b\/tool\.js/);

    const cliResult = runCli(["resume", "--run-dir", runDir, "--execute"]);
    assert.equal(cliResult.status, 0);
    assert.match(cliResult.stdout, /Executed: export_workspace/);
    assert.match(cliResult.stdout, /Workspace patch:/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute applies only when target and write are explicit", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-execute-apply-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-execute-target-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-done", {
      status: "done",
      failureCategory: "none",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-done");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    execFileSync("git", ["init"], { cwd: targetDir, stdio: "ignore" });

    const dryRun = await executeResumePlan({ runDir, targetDir });
    assert.equal(dryRun.plan.action, "apply_workspace");
    assert.equal(dryRun.executed, true);
    assert.equal(dryRun.applyResult?.applied, false);
    await assert.rejects(
      () => readFile(path.join(targetDir, "tool.js"), "utf8"),
      /ENOENT/,
    );

    const cliWrite = runCli(["resume", "--run-dir", runDir, "--target", targetDir, "--execute", "--write"]);
    assert.equal(cliWrite.status, 0);
    assert.match(cliWrite.stdout, /Executed: apply_workspace/);
    assert.match(cliWrite.stdout, /Mode: write/);
    assert.equal(await readFile(path.join(targetDir, "tool.js"), "utf8"), "console.log('tool');\n");
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("resume execute refuses non-ready repair plans", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-execute-refuse-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-timeout");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), progress, "utf8");

    await assert.rejects(
      () => executeResumePlan({ runDir }),
      /resume plan is not ready/,
    );

    const cliResult = runCli(["resume", "--run-dir", runDir, "--execute"]);
    assert.equal(cliResult.status, 1);
    assert.match(cliResult.stderr, /resume plan is not ready/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute continues a recoverable manager thread and rewrites terminal summary", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-execute-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-manager-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-manager-timeout");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.3-codex-spark",
      threadId: "thread-manager-timeout",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "old manager prompt",
      error: { name: "AbortError", message: "The operation was aborted" },
    }, null, 2)}\n`, "utf8");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager failed: AbortError: The operation was aborted",
    });
    await writeFile(path.join(runDir, "progress.md"), `${progress}\nVerification command: node workspace/tool.js\nVerification result: passed\n`, "utf8");

    const resumedThreads = [];
    const fakeCodex = {
      resumeThread(threadId, options) {
        resumedThreads.push({ threadId, options });
        return {
          id: threadId,
          async run() {
            return {
              finalResponse: JSON.stringify({
                next_action: "done",
                target: "workspace/",
                instructions: "finish",
                reason: "resumed manager confirmed existing verification",
              }),
              usage: null,
              items: [],
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
      maxLoops: 4,
    });

    assert.equal(result.plan.action, "resume_sdk");
    assert.equal(result.executed, true);
    assert.equal(result.runResult?.status, "done");
    assert.deepEqual(resumedThreads.map((entry) => entry.threadId), ["thread-manager-timeout"]);
    assert.equal(resumedThreads[0].options.workingDirectory, runDir);

    const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.status, "done");
    assert.equal(summary.failureCategory, "none");
    assert.match(summary.reason, /resumed manager confirmed/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute continues max-loops runs from the next manager loop", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-max-loops-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-max-loops", {
      status: "max_loops_reached",
      reason: "Manager did not finish within 2 loop(s).",
      failureCategory: "max_loops",
      terminalRole: "manager",
      maxLoops: 2,
      endedAt: "2026-04-24T00:00:03.000Z",
      metrics: {
        sessionLogEntries: 2,
        roleTurns: {
          manager: 2,
        },
      },
    });
    const runDir = path.join(runsDir, "run-max-loops");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-loop-2",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      prompt: "manager loop 2 prompt",
    }, null, 2)}\n`, "utf8");
    const progress = updateProgressDocument(await readFile(path.join(runDir, "progress.md"), "utf8"), {
      status: "failed",
      lastUpdatedAt: "2026-04-24T00:00:03.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "Manager did not finish within 2 loop(s).",
    });
    await writeFile(path.join(runDir, "progress.md"), `${progress}\nVerification command: node workspace/tool.js\nVerification result: passed\n`, "utf8");

    const prompts = [];
    const fakeCodex = {
      resumeThread(threadId) {
        return {
          id: threadId,
          async run(prompt) {
            prompts.push(prompt);
            return {
              finalResponse: JSON.stringify({
                next_action: "done",
                target: "workspace/",
                instructions: "finish",
                reason: "resumed max loops from next manager loop",
              }),
              usage: null,
              items: [],
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
    });

    assert.equal(result.plan.action, "resume_sdk");
    assert.equal(result.plan.sdkTarget?.nextLoop, 3);
    assert.equal(result.runResult?.status, "done");
    assert.match(prompts[0], /Loop: 3/);

    const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.status, "done");
    assert.equal(summary.maxLoops, 3);
    assert.match(summary.reason, /resumed max loops/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute records streamed role diagnostics while a turn is running", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-diagnostics-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-manager-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-manager-timeout");
    await writeFile(path.join(runDir, "workspace", "tool.js"), "console.log('tool');\n", "utf8");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-streamed",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "old manager prompt",
    }, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "progress.md"), `${await readFile(path.join(runDir, "progress.md"), "utf8")}\nVerification command: node workspace/tool.js\nVerification result: passed\n`, "utf8");

    const fakeCodex = {
      resumeThread(threadId) {
        return {
          id: threadId,
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: threadId };
                yield { type: "turn.started" };
                yield {
                  type: "item.started",
                  item: {
                    id: "cmd-1",
                    type: "command_execution",
                    command: "node workspace/tool.js",
                    aggregated_output: "",
                    status: "in_progress",
                  },
                };
                yield {
                  type: "item.completed",
                  item: {
                    id: "msg-1",
                    type: "agent_message",
                    text: JSON.stringify({
                      next_action: "done",
                      target: "workspace/",
                      instructions: "finish",
                      reason: "streamed resume completed",
                    }),
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: 1,
                  },
                };
              })(),
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
    });

    assert.equal(result.runResult?.status, "done");

    const inflightEntries = await readdir(path.join(runDir, "session-log", "inflight"));
    assert.equal(inflightEntries.length, 1);
    const diagnostic = JSON.parse(await readFile(path.join(runDir, "session-log", "inflight", inflightEntries[0]), "utf8"));
    assert.equal(diagnostic.status, "completed");
    assert.equal(diagnostic.classification, "turn_completed");
    assert.equal(diagnostic.lastEventType, "turn.completed");

    const eventEntries = await readdir(path.join(runDir, "session-log", "events"));
    assert.equal(eventEntries.length, 1);
    const eventTrace = JSON.parse(await readFile(path.join(runDir, "session-log", "events", eventEntries[0]), "utf8"));
    assert.equal(eventTrace.role, "manager");
    assert.equal(eventTrace.model, "gpt-5.4");
    assert.equal(eventTrace.threadId, "thread-manager-streamed");
    assert.equal(eventTrace.events.length, 5);
    assert.equal(eventTrace.events[0].event.type, "thread.started");
    assert.equal(eventTrace.events.at(-1).event.type, "turn.completed");
    assert.equal(eventTrace.events.at(-1).classification, "turn_completed");
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute classifies permission waits as user-action blockers", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-permission-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-manager-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-manager-timeout");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-permission",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "old manager prompt",
    }, null, 2)}\n`, "utf8");

    const fakeCodex = {
      resumeThread(threadId) {
        return {
          id: threadId,
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: threadId };
                yield { type: "turn.started" };
                yield {
                  type: "turn.failed",
                  error: {
                    message: "Permission denied: approval required for this operation",
                  },
                };
              })(),
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
    });

    assert.equal(result.runResult?.status, "ask_user");

    const errorLogs = (await readdir(path.join(runDir, "session-log"))).filter((entry) => entry.endsWith("-error.json")).sort();
    const errorLog = JSON.parse(await readFile(path.join(runDir, "session-log", errorLogs.at(-1)), "utf8"));
    assert.equal(errorLog.diagnostic.classification, "permission_or_approval_blocked");

    const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8"));
    assert.equal(summary.failureCategory, "blocker");
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute classifies sdk reconnect stream failures distinctly", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-reconnect-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-manager-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-manager-timeout");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-reconnect",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "old manager prompt",
    }, null, 2)}\n`, "utf8");

    const fakeCodex = {
      resumeThread(threadId) {
        return {
          id: threadId,
          async runStreamed() {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: threadId };
                yield { type: "turn.started" };
                yield {
                  type: "error",
                  message: "Reconnecting... 2/5 (timeout waiting for child process to exit)",
                };
              })(),
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 1000,
    });

    assert.equal(result.runResult?.status, "ask_user");

    const errorLogs = (await readdir(path.join(runDir, "session-log"))).filter((entry) => entry.endsWith("-error.json")).sort();
    const errorLog = JSON.parse(await readFile(path.join(runDir, "session-log", errorLogs.at(-1)), "utf8"));
    assert.equal(errorLog.diagnostic.classification, "sdk_reconnect_failed");
    assert.match(errorLog.diagnostic.detail, /Codex SDK stream reconnected or disconnected/);
    assert.match(errorLog.eventTraceFile, /session-log\/events\/.+-manager\.json$/);

    const eventTrace = JSON.parse(await readFile(errorLog.eventTraceFile, "utf8"));
    assert.equal(eventTrace.status, "failed");
    assert.equal(eventTrace.role, "manager");
    assert.equal(eventTrace.events.length, 3);
    assert.equal(eventTrace.events.at(-1).event.type, "error");
    assert.equal(eventTrace.events.at(-1).classification, "sdk_reconnect_failed");

    const statusResult = runCli(["status", "--run-dir", runDir, "--json"]);
    assert.equal(statusResult.status, 0);
    const status = JSON.parse(statusResult.stdout);
    assert.equal(status.diagnostic.classification, "sdk_reconnect_failed");
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("resume execute preserves event trace when a turn times out after sdk events", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-resume-sdk-timeout-trace-"));

  try {
    await writeHealthyRunSummary(runsDir, "run-manager-timeout", {
      status: "ask_user",
      reason: "Manager failed: AbortError: The operation was aborted",
      failureCategory: "turn_timeout",
      terminalRole: "manager",
      endedAt: "2026-04-24T00:00:03.000Z",
    });
    const runDir = path.join(runsDir, "run-manager-timeout");
    await writeFile(path.join(runDir, "session-log", "2026-04-24T00-00-02-manager-error.json"), `${JSON.stringify({
      role: "manager",
      model: "gpt-5.4",
      threadId: "thread-manager-timeout-trace",
      startedAt: "2026-04-24T00:00:02.000Z",
      endedAt: "2026-04-24T00:00:03.000Z",
      reason: "AbortError: The operation was aborted",
      prompt: "old manager prompt",
    }, null, 2)}\n`, "utf8");

    const fakeCodex = {
      resumeThread(threadId) {
        return {
          id: threadId,
          async runStreamed(_prompt, runOptions) {
            return {
              events: (async function* () {
                yield { type: "thread.started", thread_id: threadId };
                yield { type: "turn.started" };
                await new Promise((_, reject) => {
                  runOptions.signal.addEventListener("abort", () => {
                    const error = new Error("The operation was aborted");
                    error.name = "AbortError";
                    reject(error);
                  }, { once: true });
                });
              })(),
            };
          },
        };
      },
    };

    const result = await executeResumePlan({
      runDir,
      codex: fakeCodex,
      model: "gpt-5.4",
      turnTimeoutMs: 10,
    });

    assert.equal(result.runResult?.status, "ask_user");

    const errorLogs = (await readdir(path.join(runDir, "session-log"))).filter((entry) => entry.endsWith("-error.json")).sort();
    const errorLog = JSON.parse(await readFile(path.join(runDir, "session-log", errorLogs.at(-1)), "utf8"));
    assert.equal(errorLog.diagnostic.classification, "idle_until_turn_timeout");
    assert.match(errorLog.eventTraceFile, /session-log\/events\/.+-manager\.json$/);

    const eventTrace = JSON.parse(await readFile(errorLog.eventTraceFile, "utf8"));
    assert.equal(eventTrace.status, "failed");
    assert.equal(eventTrace.events.length, 2);
    assert.equal(eventTrace.events.at(-1).event.type, "turn.started");
    assert.equal(eventTrace.diagnostic.classification, "idle_until_turn_timeout");
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

test("failure classification keeps sdk reconnect failures ahead of observer failures", () => {
  const failureCategory = classifyRunFailure({
    runDir: "/tmp/aegis-run",
    status: "ask_user",
    reason: "Manager failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
    observer: {
      runDir: "/tmp/aegis-run",
      status: "failed",
      reason: "Observer failed: Error: Reconnecting... 2/5 (timeout waiting for child process to exit)",
    },
    snippetCandidates: [],
  }, "manager");

  assert.equal(failureCategory, "sdk_failed");
});

test("resolveRoleFallbackModel falls back from spark on unsupported tool and timeout errors", () => {
  assert.equal(
    resolveRoleFallbackModel(
      "gpt-5.3-codex-spark",
      "Error: Tool 'image_generation' is not supported with gpt-5.3-codex-spark",
    ),
    "gpt-5.4",
  );
  assert.equal(
    resolveRoleFallbackModel("gpt-5.4", "Error: Tool 'image_generation' is not supported"),
    undefined,
  );
  assert.equal(
    resolveRoleFallbackModel("gpt-5.3-codex-spark", "AbortError: The operation was aborted"),
    "gpt-5.4",
  );
});

test("progress document keeps a machine-readable state block", () => {
  const document = buildProgressDocument({
    schemaVersion: 1,
    status: "initialized",
    model: "gpt-5.4",
    startedAt: "2026-04-24T00:00:00.000Z",
    lastUpdatedAt: "2026-04-24T00:00:00.000Z",
    lastRole: "driver",
    loop: 0,
    terminal: false,
  }, "- Status: initialized\n");

  assert.match(document, /<!-- codex-gtd:progress-state:start -->/);
  assert.match(document, /<!-- codex-gtd:progress-state:end -->/);
  assert.deepEqual(parseProgressState(document), {
    schemaVersion: 1,
    status: "initialized",
    model: "gpt-5.4",
    startedAt: "2026-04-24T00:00:00.000Z",
    lastUpdatedAt: "2026-04-24T00:00:00.000Z",
    lastRole: "driver",
    loop: 0,
    terminal: false,
  });

  const updated = updateProgressDocument(document, {
    status: "blocked",
    lastUpdatedAt: "2026-04-24T00:01:00.000Z",
    lastRole: "manager",
    loop: 1,
    terminal: true,
    reason: "missing credentials",
  }, "\n## Failed\n\nmissing credentials\n");

  assert.deepEqual(parseProgressState(updated), {
    schemaVersion: 1,
    status: "blocked",
    model: "gpt-5.4",
    startedAt: "2026-04-24T00:00:00.000Z",
    lastUpdatedAt: "2026-04-24T00:01:00.000Z",
    lastRole: "manager",
    loop: 1,
    terminal: true,
    reason: "missing credentials",
  });
  assert.match(updated, /## Failed/);
});

test("progress document can restore state when an agent overwrites the header", () => {
  const overwrittenByAgent = "# Progress\n\nResearcher updated this file without preserving the state block.\n";
  const restored = updateProgressDocument(overwrittenByAgent, {
    status: "blocked",
    model: "gpt-5.3-codex-spark",
    startedAt: "2026-04-24T00:00:00.000Z",
    lastUpdatedAt: "2026-04-24T00:02:00.000Z",
    lastRole: "manager",
    loop: 1,
    terminal: true,
    reason: "missing credentials",
  });

  assert.deepEqual(parseProgressState(restored), {
    schemaVersion: 1,
    status: "blocked",
    model: "gpt-5.3-codex-spark",
    startedAt: "2026-04-24T00:00:00.000Z",
    lastUpdatedAt: "2026-04-24T00:02:00.000Z",
    lastRole: "manager",
    loop: 1,
    terminal: true,
    reason: "missing credentials",
  });
  assert.match(restored, /Researcher updated this file/);
});

test("manager decision parser accepts plain and fenced JSON", () => {
  assert.deepEqual(parseManagerDecision('{"next_action":"test","target":"workspace","instructions":"run tests","reason":"implementation exists"}'), {
    next_action: "test",
    target: "workspace",
    instructions: "run tests",
    reason: "implementation exists",
  });

  assert.deepEqual(parseManagerDecision("```json\n{\"next_action\":\"done\",\"target\":null,\"instructions\":null,\"reason\":\"tests passed\"}\n```"), {
    next_action: "done",
    target: undefined,
    instructions: undefined,
    reason: "tests passed",
  });
});

test("manager decision parser rejects invalid actions and defaults missing reason", () => {
  assert.throws(
    () => parseManagerDecision('{"next_action":"ship","target":null,"instructions":null,"reason":"no"}'),
    /invalid next_action/,
  );

  assert.deepEqual(parseManagerDecision('{"next_action":"develop"}'), {
    next_action: "develop",
    target: undefined,
    instructions: undefined,
    reason: "No reason provided.",
  });
});

test("initializeRunProtocol creates required files and directories without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-protocol-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });

    const entries = new Set(await readdir(runDir));
    for (const entry of ["task.md", "discovery.md", "progress.md", "blockers.md", "session-log", "api-probes", "workspace"]) {
      assert.equal(entries.has(entry), true, `${entry} should exist`);
    }

    assert.equal(await readFile(path.join(runDir, "task.md"), "utf8"), "# Task\n\nBuild a local CLI.");
    assert.match(await readFile(path.join(runDir, "blockers.md"), "utf8"), /None\./);
    const progress = await readFile(path.join(runDir, "progress.md"), "utf8");
    assert.deepEqual(parseProgressState(progress), {
      schemaVersion: 1,
      status: "initialized",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
      lastUpdatedAt: "2026-04-24T00:00:00.000Z",
      lastRole: "driver",
      loop: 0,
      terminal: false,
    });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("validateRunProtocol reports missing required entries without invoking Codex SDK", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-protocol-missing-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    await rm(path.join(runDir, "workspace"), { recursive: true, force: true });

    const result = await validateRunProtocol(runDir);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["spec.md", "interfaces.md", "workspace/", "run-summary.json"]);
    assert.equal(result.found.includes("task.md"), true);
    assert.equal(result.found.includes("workspace/"), false);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("validateApiProbesReadme reports valid and missing sections", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-api-probes-"));
  const validRunDir = path.join(runsDir, "valid");
  const mixedHeadingRunDir = path.join(runsDir, "mixed-heading");
  const invalidRunDir = path.join(runsDir, "invalid");

  try {
    await mkdir(path.join(validRunDir, "api-probes"), { recursive: true });
    await writeFile(path.join(validRunDir, "api-probes", "README.md"), `# API Probes

## Probe Decision
No external dependency.

## External Dependencies
None.

## Probe Artifacts
None.

## Recorded Results
Not required.

## Known Limitations
None.
`);
    await mkdir(path.join(mixedHeadingRunDir, "api-probes"), { recursive: true });
    await writeFile(path.join(mixedHeadingRunDir, "api-probes", "README.md"), `# Probe Decision
No external dependency.

### External Dependencies
None.

#### Probe Artifacts
None.

##### Recorded Results
Not required.

###### Known Limitations
None.
`);
    await mkdir(path.join(invalidRunDir, "api-probes"), { recursive: true });
    await writeFile(path.join(invalidRunDir, "api-probes", "README.md"), `# API Probes

## Probe Decision
No external dependency.

## Probe Artifacts
None.

## Known Limitations
None.
`);

    assert.deepEqual(await validateApiProbesReadme(validRunDir), {
      ok: true,
      missingSections: [],
      presentSections: [
        "Probe Decision",
        "External Dependencies",
        "Probe Artifacts",
        "Recorded Results",
        "Known Limitations",
      ],
    });
    assert.deepEqual(await validateApiProbesReadme(mixedHeadingRunDir), {
      ok: true,
      missingSections: [],
      presentSections: [
        "Probe Decision",
        "External Dependencies",
        "Probe Artifacts",
        "Recorded Results",
        "Known Limitations",
      ],
    });
    assert.deepEqual(await validateApiProbesReadme(invalidRunDir), {
      ok: false,
      missingSections: ["External Dependencies", "Recorded Results"],
      presentSections: ["Probe Decision", "Probe Artifacts", "Known Limitations"],
    });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("compareProgressRunSummary reports consistency and drift", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-drift-"));
  const matchRunDir = path.join(runsDir, "match");
  const driftRunDir = path.join(runsDir, "drift");

  try {
    for (const runDir of [matchRunDir, driftRunDir]) {
      await initializeRunProtocol({
        runDir,
        task: "# Task\n\nBuild a local CLI.",
        model: "gpt-5.4",
        startedAt: "2026-04-24T00:00:00.000Z",
      });
    }

    const summary = buildRunSummary({
      runDir: matchRunDir,
      status: "done",
      reason: "tests passed",
      model: "gpt-5.4",
      taskFile: path.join(matchRunDir, "task.md"),
      startedAt: "2026-04-24T00:00:00.000Z",
      endedAt: "2026-04-24T00:01:00.000Z",
      durationMs: 60000,
      maxLoops: 4,
      turnTimeoutMs: 300000,
      options: {
        observe: false,
        monitorSdk: true,
        skipDiscovery: true,
      },
      snippetCandidates: [],
      terminalRole: "manager",
      failureCategory: "none",
      metrics: {
        sessionLogEntries: 3,
        roleTurns: {
          manager: 2,
        },
      },
    });
    const terminalProgress = updateProgressDocument(await readFile(path.join(matchRunDir, "progress.md"), "utf8"), {
      status: "done",
      lastUpdatedAt: "2026-04-24T00:01:00.000Z",
      lastRole: "manager",
      loop: 2,
      terminal: true,
      reason: "tests passed",
    });
    await writeFile(path.join(matchRunDir, "progress.md"), terminalProgress);
    await writeFile(path.join(matchRunDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    const driftSummary = { ...summary, runDir: driftRunDir, status: "ask_user", failureCategory: "blocker", reason: "missing key" };
    await writeFile(path.join(driftRunDir, "run-summary.json"), `${JSON.stringify(driftSummary, null, 2)}\n`);

    assert.deepEqual(await compareProgressRunSummary(matchRunDir), {
      ok: true,
      mismatches: [],
      details: [],
    });
    assert.deepEqual(await compareProgressRunSummary(driftRunDir), {
      ok: false,
      mismatches: [
        {
          key: "status",
          progressValue: "initialized",
          summaryValue: "blocked",
        },
        {
          key: "terminal",
          progressValue: false,
          summaryValue: true,
        },
        {
          key: "lastRole",
          progressValue: "driver",
          summaryValue: "manager",
        },
        {
          key: "loop",
          progressValue: 0,
          summaryValue: 2,
        },
        {
          key: "reason",
          progressValue: undefined,
          summaryValue: "missing key",
        },
      ],
      details: [],
    });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("evaluateCloseoutGate accepts protocol-complete runs with verification evidence", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-closeout-ok-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-25T00:00:00.000Z",
    });
    await writeFile(path.join(runDir, "spec.md"), "# Spec\n\nAcceptance criteria.\n");
    await writeFile(path.join(runDir, "interfaces.md"), "# Interfaces\n\nCLI contract.\n");
    await writeFile(path.join(runDir, "api-probes", "README.md"), VALID_API_PROBES_README, "utf8");
    await writeFile(path.join(runDir, "workspace", "cli.js"), "console.log('ok');\n", "utf8");
    await writeFile(path.join(runDir, "session-log", "001-manager.json"), "{}\n", "utf8");
    await writeFile(path.join(runDir, "progress.md"), buildProgressDocument({
      schemaVersion: 1,
      status: "running",
      model: "gpt-5.4",
      startedAt: "2026-04-25T00:00:00.000Z",
      lastUpdatedAt: "2026-04-25T00:00:01.000Z",
      lastRole: "tester",
      loop: 1,
      terminal: false,
    }, "- Verification command: `bash workspace/verify.sh`\n- Verification result: PASS\n"));

    assert.deepEqual(await evaluateCloseoutGate(runDir), { ok: true, issues: [] });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("evaluateCloseoutGate blocks done without verification evidence", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-closeout-missing-evidence-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-25T00:00:00.000Z",
    });
    await writeFile(path.join(runDir, "spec.md"), "# Spec\n\nAcceptance criteria.\n");
    await writeFile(path.join(runDir, "interfaces.md"), "# Interfaces\n\nCLI contract.\n");
    await writeFile(path.join(runDir, "api-probes", "README.md"), VALID_API_PROBES_README, "utf8");
    await writeFile(path.join(runDir, "workspace", "cli.js"), "console.log('ok');\n", "utf8");
    await writeFile(path.join(runDir, "session-log", "001-manager.json"), "{}\n", "utf8");

    const gate = await evaluateCloseoutGate(runDir);
    assert.equal(gate.ok, false);
    assert.match(gate.issues.join("\n"), /progress\.md missing verification evidence/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("observer protocol health section describes clean and unhealthy runs", () => {
  const clean = buildObserverProtocolHealthSection({
    runProtocol: { ok: true, missing: [], found: ["task.md"] },
    apiProbesReadme: {
      ok: true,
      missingSections: [],
      presentSections: ["Probe Decision", "External Dependencies"],
    },
    progressDrift: { ok: true, mismatches: [], details: [] },
  });
  assert.match(clean, /## Protocol Health/);
  assert.match(clean, /Protocol Health is clean\./);
  assert.doesNotMatch(clean, /Mention these protocol health issues in lessons\.md\./);

  const unhealthy = buildObserverProtocolHealthSection({
    runProtocol: { ok: false, missing: ["interfaces.md", "run-summary.json"], found: ["task.md"] },
    apiProbesReadme: {
      ok: false,
      missingSections: ["Recorded Results"],
      presentSections: ["Probe Decision"],
    },
    progressDrift: {
      ok: false,
      mismatches: [
        { key: "status", progressValue: "running", summaryValue: "done" },
      ],
      details: ["progress.md missing valid progress state block"],
    },
  });
  assert.match(unhealthy, /Missing required protocol entries:/);
  assert.match(unhealthy, /- interfaces\.md/);
  assert.match(unhealthy, /Missing api-probes\/README\.md sections:/);
  assert.match(unhealthy, /- Recorded Results/);
  assert.match(unhealthy, /Progress\/run-summary drift:/);
  assert.match(unhealthy, /- status: progress="running" summary="done"/);
  assert.match(unhealthy, /Protocol health details:/);
  assert.match(unhealthy, /- progress\.md missing valid progress state block/);
  assert.match(unhealthy, /Mention these protocol health issues in lessons\.md\./);
});

test("observer prompt includes protocol health context", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-observer-prompt-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: "# Task\n\nBuild a local CLI.",
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    const prompt = await observerPrompt(runDir, path.join(runsDir, "snippets"), "## Protocol Health\n\nProtocol Health is clean.\n");
    assert.match(prompt, /## Protocol Health/);
    assert.match(prompt, /Protocol Health is clean\./);
    assert.match(prompt, /Required \.\/lessons\.md sections:/);
    assert.match(prompt, /Do not use tools or edit files/);
    assert.match(prompt, /final response must begin exactly with "# Root-cause summary"/);
    assert.match(prompt, /### Candidate: <name>/);
    assert.match(prompt, /Purpose:/);
    assert.match(prompt, /Apply when:/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("observer lessons selection preserves tool-written lessons over status final response", () => {
  const writtenLessons = `# Root-cause summary

Evidence.

# Recurring failure patterns

Pattern.

# Missed discovery/clarification opportunities

Opportunity.

# Agent-specific improvements

Improvement.

# Reusable snippets candidates

- Reusable parser snippet.

# Protocol health

Clean.
`;
  const finalResponse = "`./lessons.md` has been written as the only modified artifact.";

  assert.equal(selectObserverLessonsContent(writtenLessons, finalResponse), writtenLessons.trimEnd());
});

test("observer lessons selection ignores stale pre-existing lessons on re-observe", () => {
  const staleLessons = `# Root-cause summary

Old evidence.

# Recurring failure patterns

Old pattern.

# Missed discovery/clarification opportunities

Old opportunity.

# Agent-specific improvements

Old improvement.

# Reusable snippets candidates

- Old candidate.

# Protocol health

Old health.
`;
  const finalResponse = `# Root-cause summary

Fresh evidence.

# Recurring failure patterns

Fresh pattern.

# Missed discovery/clarification opportunities

Fresh opportunity.

# Agent-specific improvements

Fresh improvement.

# Reusable snippets candidates

### Candidate: fresh-candidate
Purpose: Fresh purpose.
Pattern: Fresh pattern.
Apply when: Future runs need it.

# Protocol health

Fresh health.
`;

  assert.equal(
    selectObserverLessonsContent(staleLessons, finalResponse, staleLessons),
    finalResponse.trimEnd(),
  );
});

test("observer lessons selection falls back to final response when no valid lessons file exists", () => {
  const finalResponse = "# Root-cause summary\n\nFallback content.\n";

  assert.equal(selectObserverLessonsContent("placeholder", finalResponse), finalResponse.trimEnd());
});

test("snippet candidate parser keeps structured candidate blocks intact", () => {
  const section = `Intro text that should not become a candidate.

### Candidate: Parser edge-case validation

Purpose: Catch edge cases in parser-like CLI helpers.
Pattern:
- duplicate keys use the last explicit value
- empty values are ignored
Apply when: The task introduces markdown or key-value parsing.

### Candidate: API probe validator

Purpose: Verify API probe artifacts before manager decisions.
Pattern:
1. Check required headings.
2. Report missing sections.
Apply when: The run depends on an external SDK or API.
`;

  assert.deepEqual(parseSnippetCandidateEntries(section), [
    {
      title: "Parser edge-case validation",
      body: `Purpose: Catch edge cases in parser-like CLI helpers.
Pattern:
- duplicate keys use the last explicit value
- empty values are ignored
Apply when: The task introduces markdown or key-value parsing.`,
    },
    {
      title: "API probe validator",
      body: `Purpose: Verify API probe artifacts before manager decisions.
Pattern:
1. Check required headings.
2. Report missing sections.
Apply when: The run depends on an external SDK or API.`,
    },
  ]);
});

test("snippet candidate parser ignores unstructured bullet lists", () => {
  const section = `- Reusable run-summary comparison helper.
- Purpose: detect drift.
- Pattern: compare protocol fields.
- Apply when: report needs consistency checks.
`;

  assert.deepEqual(parseSnippetCandidateEntries(section), []);
});

test("published snippets are focused reusable snippets, not raw candidate bundles", async () => {
  const snippetsDir = path.join(new URL("..", import.meta.url).pathname, "snippets");
  const files = (await readdir(snippetsDir)).filter((file) => file.endsWith(".md") && file !== "INDEX.md");

  assert.ok(files.length > 0);
  for (const file of files) {
    const content = await readFile(path.join(snippetsDir, file), "utf8");
    assert.doesNotMatch(content, /^# Snippet candidates/m, `${file} should not embed raw candidate bundles`);
    assert.doesNotMatch(content, /^## Candidates extracted from observer lessons/m, `${file} should not embed candidate extraction sections`);
  }
});

test("observer text compaction uses a deterministic truncation marker", () => {
  const compacted = compactObserverText("task.md", "x".repeat(1200), 160);

  assert.ok(compacted.length <= 160);
  assert.match(compacted, new RegExp(OBSERVER_TRUNCATION_MARKER));
  assert.match(compacted, /\[truncated task\.md:/);
});

test("observer prompt compacts medium runs while preserving protocol health and error reasons", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-observer-compact-"));
  const runDir = path.join(runsDir, "run-a");

  try {
    await initializeRunProtocol({
      runDir,
      task: `# Task\n\n${"Collect a medium sized trace. ".repeat(900)}`,
      model: "gpt-5.4",
      startedAt: "2026-04-24T00:00:00.000Z",
    });
    await writeFile(path.join(runDir, "spec.md"), `# Spec\n\n${"Large spec detail. ".repeat(900)}`, "utf8");
    await writeFile(path.join(runDir, "interfaces.md"), `# Interfaces\n\n${"Large interface detail. ".repeat(900)}`, "utf8");
    await writeFile(path.join(runDir, "api-probes", "README.md"), `${VALID_API_PROBES_README}\n${"Probe output. ".repeat(900)}`, "utf8");
    await mkdir(path.join(runDir, "session-log"), { recursive: true });

    for (let index = 0; index < OBSERVER_SESSION_LOG_MAX_ENTRIES + 8; index += 1) {
      const entry = {
        role: index === 0 ? "observer" : "manager",
        threadId: `thread-${index}`,
        startedAt: `2026-04-24T00:${String(index).padStart(2, "0")}:00.000Z`,
        endedAt: `2026-04-24T00:${String(index).padStart(2, "0")}:30.000Z`,
        model: "gpt-5.4",
        finalResponse: `final response ${index} ${"verbose trace item ".repeat(300)}`,
        items: Array.from({ length: 30 }, (_, itemIndex) => ({ itemIndex, text: "large item payload ".repeat(40) })),
      };
      await writeFile(path.join(runDir, "session-log", `000${index}-manager.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    }

    await writeFile(path.join(runDir, "session-log", "999-observer-error.json"), `${JSON.stringify({
      role: "observer",
      startedAt: "2026-04-24T01:00:00.000Z",
      endedAt: "2026-04-24T01:05:00.000Z",
      status: "error",
      reason: "AbortError: observer turn exceeded deadline",
      error: {
        name: "AbortError",
        message: "This operation was aborted",
      },
      finalResponse: "",
    }, null, 2)}\n`, "utf8");

    const prompt = await observerPrompt(runDir, path.join(runsDir, "snippets"), "## Protocol Health\n\nProtocol Health is clean.\n");
    const roleMatches = prompt.match(/^- role:/gm) ?? [];

    assert.ok(prompt.length <= OBSERVER_PROMPT_MAX_CHARS);
    assert.match(prompt, /## Protocol Health/);
    assert.match(prompt, /Protocol Health is clean\./);
    assert.match(prompt, /AbortError: observer turn exceeded deadline/);
    assert.match(prompt, new RegExp(OBSERVER_TRUNCATION_MARKER));
    assert.ok(roleMatches.length <= OBSERVER_SESSION_LOG_MAX_ENTRIES);
    assert.ok(!prompt.includes("large item payload ".repeat(20)));
    assert.ok(!prompt.includes("verbose trace item ".repeat(80)));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("manager prompt compacts large run context while preserving decision-critical state", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-manager-prompt-"));
  const runDir = path.join(runsDir, "run-a");
  const snippetsDir = path.join(runsDir, "snippets");

  try {
    await mkdir(path.join(runDir, "api-probes"), { recursive: true });
    await mkdir(snippetsDir, { recursive: true });
    await writeFile(path.join(runDir, "task.md"), `# Task\n\n${"build todo exporter ".repeat(200)}\n`, "utf8");
    await writeFile(path.join(runDir, "discovery.md"), `# Discovery\n\n${"confirmed scope ".repeat(200)}\n`, "utf8");
    await writeFile(path.join(runDir, "spec.md"), `# Spec\n\n${"acceptance criterion ".repeat(500)}\n`, "utf8");
    await writeFile(path.join(runDir, "interfaces.md"), `# Interfaces\n\n${"cli contract ".repeat(500)}\n`, "utf8");
    await writeFile(path.join(runDir, "blockers.md"), `# Blockers\n\nNone.\n${"old blocker detail ".repeat(200)}\n`, "utf8");
    await writeFile(path.join(runDir, "api-probes", "README.md"), `${VALID_API_PROBES_README}\n${"probe details ".repeat(800)}\n`, "utf8");
    await writeFile(path.join(snippetsDir, "INDEX.md"), `# Snippets\n\n${"snippet index ".repeat(800)}\n`, "utf8");
    await writeFile(path.join(snippetsDir, "large.md"), `# Large snippet\n\n${"snippet implementation guidance ".repeat(800)}\n`, "utf8");
    await writeFile(path.join(runDir, "progress.md"), `<!-- codex-gtd:progress-state
status: testing
lastUpdatedAt: 2026-04-24T00:00:00.000Z
lastRole: tester
loop: 2
terminal: false
reason: tests are still running
-->

# Progress

## State

Status: testing

## Log

${"old progress detail ".repeat(900)}

## Latest Verification

Command: npm test
Result: pending
`, "utf8");

    const prompt = await managerPrompt(2, runDir, snippetsDir);

    assert.ok(prompt.length <= MANAGER_PROMPT_MAX_CHARS);
    assert.match(prompt, /codex-gtd:progress-state/);
    assert.match(prompt, /Latest Verification/);
    assert.match(prompt, /driver closeout gate/i);
    assert.match(prompt, new RegExp(OBSERVER_TRUNCATION_MARKER));
    assert.ok(!prompt.includes("acceptance criterion ".repeat(120)));
    assert.ok(!prompt.includes("old progress detail ".repeat(120)));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("promoteSnippetCandidate writes snippet and updates index idempotently", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-promote-"));
  const snippetsDir = path.join(rootDir, "snippets");
  const candidatePath = path.join(snippetsDir, "_candidates", "candidate.md");

  try {
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(path.join(snippetsDir, "INDEX.md"), `# Aegis Snippets

## Available snippets

- [Existing snippet](./existing.md)

## How to use

Keep snippets focused.
`, "utf8");
    await writeFile(candidatePath, `# Snippet candidates

Source run: /tmp/codex-gtd-test/repo/runs/run-a

## Candidates extracted from observer lessons

### 1

Use a small parser and keep tests local.
`, "utf8");

    const first = await promoteSnippetCandidate({
      candidateFile: candidatePath,
      snippetsDir,
      slug: "approved-parser",
      title: "Approved parser",
    });
    const second = await promoteSnippetCandidate({
      candidateFile: candidatePath,
      snippetsDir,
      slug: "approved-parser",
      title: "Approved parser",
    });

    const snippet = await readFile(path.join(snippetsDir, "approved-parser.md"), "utf8");
    const index = await readFile(path.join(snippetsDir, "INDEX.md"), "utf8");

    assert.equal(first.status, "created");
    assert.equal(second.status, "unchanged");
    assert.match(snippet, /# Snippet: Approved parser/);
    assert.match(snippet, /<!-- snippet-promotion: \{"slug":"approved-parser","title":"Approved parser"/);
    assert.match(snippet, /Source candidate:/);
    assert.match(snippet, /Use a small parser and keep tests local\./);
    assert.doesNotMatch(snippet, /\/tmp\/codex-gtd-test/);
    assert.match(snippet, /Source run: \(redacted local path\)\/run-a/);
    assert.equal((index.match(/approved-parser\.md/g) ?? []).length, 1);
    assert.match(index, /- \[Approved parser\]\(\.\/approved-parser\.md\)/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("promoteSnippetCandidate rejects conflicting existing snippet files", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-promote-conflict-"));
  const snippetsDir = path.join(rootDir, "snippets");
  const candidatePath = path.join(rootDir, "candidate.md");

  try {
    await mkdir(snippetsDir, { recursive: true });
    await writeFile(candidatePath, "# Candidate\n\nApproved content.\n", "utf8");
    await writeFile(path.join(snippetsDir, "approved-parser.md"), "# Different\n", "utf8");

    await assert.rejects(
      () => promoteSnippetCandidate({
        candidateFile: candidatePath,
        snippetsDir,
        slug: "approved-parser",
      }),
      /Refusing to overwrite existing snippet/,
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
