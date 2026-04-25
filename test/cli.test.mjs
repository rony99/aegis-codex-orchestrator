import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProgressDocument,
  buildRunSummary,
  evaluateCloseoutGate,
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
  OBSERVER_PROMPT_MAX_CHARS,
  OBSERVER_SESSION_LOG_MAX_ENTRIES,
  OBSERVER_TRUNCATION_MARKER,
  compactObserverText,
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
  assert.match(output, /codex-gtd promote-snippet --candidate <candidate-file> --slug <slug>/);
  assert.match(output, /--monitor-sdk\|--skip-sdk-monitor/);
  assert.match(output, /--web-search <disabled\|cached\|live>/);
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

    const report = await runReport({ runsDir, limit: 2 });
    assert.deepEqual(report.snippetUsage, {
      used: 1,
      rejected: 1,
      none: 1,
      unknown: 0,
    });
    assert.equal(report.recentRuns[0].snippetDecision.status, "used");
    assert.equal(report.recentRuns[0].snippetDecision.snippet, "Parser edge-case validation");
    assert.equal(report.recentRuns[1].snippetDecision.status, "none");

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
    assert.match(result.stdout, /Snippet usage: used=1 rejected=1 none=1 unknown=0/);
    assert.match(result.stdout, /none: 1/);
    assert.match(result.stdout, /sdk_failed: 1/);
    assert.match(result.stdout, /max_loops: 1/);
    assert.match(result.stdout, /ask_user\/sdk_failed/);
    assert.match(result.stdout, /snippet=used:Parser edge-case validation/);
    assert.match(result.stdout, /snippet=none/);
    assert.match(result.stdout, /run-a/);
    assert.match(result.stdout, /run-b/);
    assert.doesNotMatch(result.stdout, /run-c/);
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
