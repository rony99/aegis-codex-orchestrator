import { Codex, type Thread, type WebSearchMode as CodexWebSearchMode } from "@openai/codex-sdk";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  discoveryPrompt,
  developerPrompt,
  observerPrompt,
  discoverySchema,
  managerPrompt,
  managerSchema,
  researcherPrompt,
  smokePrompt,
  testerPrompt,
} from "./prompts.js";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_SNIPPETS_DIR = "snippets";
const DEFAULT_MAX_LOOPS = 8;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_MONITOR_SDK = true;
const SDK_MONITOR_DIR = ".codex-gtd";
const SDK_MONITOR_FILE = "sdk-health-baseline.json";
const SDK_MONITOR_RUN_FILE = "sdk-health.json";
const RUN_SUMMARY_FILE = "run-summary.json";
const PROGRESS_STATE_START = "<!-- codex-gtd:progress-state:start -->";
const PROGRESS_STATE_END = "<!-- codex-gtd:progress-state:end -->";
const MODEL_ALIASES: Record<string, string> = {
  "codex-5.3-spark": "gpt-5.3-codex-spark",
};
const ROLE_FALLBACK_MODEL = "gpt-5.4";
const WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const;

export type WebSearchMode = CodexWebSearchMode;

export const RUN_PROTOCOL_ENTRIES = [
  "task.md",
  "discovery.md",
  "spec.md",
  "interfaces.md",
  "progress.md",
  "blockers.md",
  "session-log/",
  "api-probes/",
  "workspace/",
  "run-summary.json",
] as const;

export const API_PROBE_README_SECTIONS = [
  "Probe Decision",
  "External Dependencies",
  "Probe Artifacts",
  "Recorded Results",
  "Known Limitations",
] as const;

const CLOSEOUT_PROTOCOL_ENTRIES = RUN_PROTOCOL_ENTRIES.filter((entry) => entry !== RUN_SUMMARY_FILE);

type Role = "discovery" | "researcher" | "manager" | "developer" | "tester" | "smoke" | "observer";
type CodexTurn = Awaited<ReturnType<Thread["run"]>>;
export type FailureCategory =
  | "none"
  | "sdk_failed"
  | "discovery_needed"
  | "blocker"
  | "max_loops"
  | "observer_failed"
  | "role_failed"
  | "turn_timeout"
  | "unsupported_tool"
  | "invalid_manager_decision"
  | "unknown";

export type RunOptions = {
  taskFile: string;
  model?: string;
  runsDir?: string;
  snippetsDir?: string;
  observe?: boolean;
  monitorSdk?: boolean;
  skipDiscovery?: boolean;
  webSearchMode?: WebSearchMode;
  turnTimeoutMs?: number;
  maxLoops?: number;
};

export type RunResult = {
  runDir: string;
  status: "done" | "ask_user" | "max_loops_reached";
  reason?: string;
  observer?: ObserveResult;
  snippetCandidates?: string[];
  sdkMonitor?: SdkHealthResult;
};

export type ObserveOptions = {
  runDir: string;
  model?: string;
  snippetsDir?: string;
  turnTimeoutMs?: number;
  webSearchMode?: WebSearchMode;
};

export type ReportOptions = {
  runsDir?: string;
  limit?: number;
};

export type RepairPlanOptions = {
  runDir: string;
};

export type RepairPlanAction =
  | "none"
  | "rerun"
  | "repair_protocol"
  | "answer_user"
  | "inspect";

export type RunRepairPlan = {
  runDir: string;
  action: RepairPlanAction;
  resumable: boolean;
  status?: RunResult["status"];
  failureCategory: FailureCategory;
  terminalRole?: string;
  reason?: string;
  summary: string;
  issues: string[];
  commands: string[];
};

export type ExportWorkspaceOptions = {
  runDir: string;
  outFile?: string;
};

export type ExportWorkspaceResult = {
  runDir: string;
  workspaceDir: string;
  outFile: string;
  fileCount: number;
  byteCount: number;
};

export type ApplyWorkspaceOptions = {
  runDir: string;
  targetDir: string;
  patchFile?: string;
  write?: boolean;
};

export type ApplyWorkspaceResult = {
  runDir: string;
  targetDir: string;
  patchFile: string;
  fileCount: number;
  byteCount: number;
  applied: boolean;
};

export type ResumePlanOptions = {
  runDir: string;
  targetDir?: string;
};

export type ResumePlanAction =
  | "export_workspace"
  | "apply_workspace"
  | RepairPlanAction;

export type ResumePlan = {
  runDir: string;
  action: ResumePlanAction;
  ready: boolean;
  source: "resume" | "repair-plan";
  summary: string;
  issues: string[];
  commands: string[];
};

export type ObserveResult = {
  runDir: string;
  status: "done" | "failed";
  reason?: string;
};

export type CloseoutGateResult = {
  ok: boolean;
  issues: string[];
};

export type RunReport = {
  runsDir: string;
  totalRuns: number;
  statuses: Record<RunResult["status"], number>;
  failureCategories: Record<FailureCategory, number>;
  snippetUsage: Record<SnippetDecisionStatus, number>;
  averageDurationMs: number;
  sdkMonitorFailures: number;
  observerFailures: number;
  protocolHealth: {
    missingRequiredProtocolEntriesCount: number;
    invalidOrMissingApiProbesReadmeSectionsCount: number;
    progressRunSummaryDriftCount: number;
  };
  recentRuns: Array<{
    runDir: string;
    status: RunResult["status"];
    failureCategory: FailureCategory;
    reason?: string;
    model: string;
    durationMs: number;
    endedAt: string;
    snippetDecision: SnippetDecision;
    protocolHealth: {
      missingRequiredEntries: boolean;
      invalidApiProbesReadmeSections: boolean;
      progressRunSummaryDrift: boolean;
    };
  }>;
};

export type SnippetDecisionStatus = "used" | "rejected" | "none" | "unknown";

export type SnippetDecision = {
  status: SnippetDecisionStatus;
  snippet?: string;
  reason?: string;
};

export type RunProtocolValidation = {
  ok: boolean;
  missing: string[];
  found: string[];
};

export type ApiProbeReadmeValidation = {
  ok: boolean;
  missingSections: string[];
  presentSections: string[];
};

export type ProtocolDriftMismatch = {
  key: string;
  progressValue?: unknown;
  summaryValue?: unknown;
};

export type ProtocolDriftReport = {
  ok: boolean;
  mismatches: ProtocolDriftMismatch[];
  details: string[];
};

export type ObserverProtocolHealthInput = {
  runProtocol: RunProtocolValidation;
  apiProbesReadme: ApiProbeReadmeValidation;
  progressDrift: ProtocolDriftReport;
};

type SdkHealthResult = {
  status: "ok" | "failed" | "degraded";
  model: string;
  sdkVersion: string;
  passed: boolean;
  reason?: string;
  previousPassed?: boolean;
  previousReason?: string;
  checkedAt: string;
};

export type RunSummary = {
  schemaVersion: 1;
  runDir: string;
  status: RunResult["status"];
  reason?: string;
  model: string;
  taskFile: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  maxLoops: number;
  turnTimeoutMs: number;
  options: {
    observe: boolean;
    monitorSdk: boolean;
    skipDiscovery: boolean;
    webSearchMode?: WebSearchMode;
  };
  sdkMonitor?: SdkHealthResult;
  observer?: ObserveResult;
  snippetCandidates: string[];
  terminalRole?: string;
  failureCategory: FailureCategory;
  metrics: {
    sessionLogEntries: number;
    roleTurns: Record<string, number>;
  };
  protocol: {
    requiredEntries: readonly string[];
  };
};

type RunMeta = {
  taskFile: string;
  startedAt: string;
  startedAtMs: number;
  maxLoops: number;
  turnTimeoutMs: number;
  observe: boolean;
  monitorSdk: boolean;
  skipDiscovery: boolean;
  webSearchMode?: WebSearchMode;
};

type RunSummaryInput = Omit<RunSummary, "schemaVersion" | "protocol">;

type SessionLogMetrics = {
  sessionLogEntries: number;
  roleTurns: Record<string, number>;
  terminalRole?: string;
};

export type ProgressStatus = "initialized" | "running" | "blocked" | "done" | "max_loops_reached" | "failed";

export type ProgressState = {
  schemaVersion: 1;
  status: ProgressStatus;
  model: string;
  startedAt: string;
  lastUpdatedAt: string;
  lastRole: string;
  loop: number;
  terminal: boolean;
  reason?: string;
};

export type RunProtocolInitOptions = {
  runDir: string;
  task: string;
  model: string;
  startedAt: string;
};

type ProgressStatePatch = Partial<Omit<ProgressState, "schemaVersion" | "model" | "startedAt">> & {
  schemaVersion?: 1;
  model?: string;
  startedAt?: string;
};

type ManagerDecision = {
  next_action: "develop" | "test" | "done" | "ask_user";
  target?: string;
  instructions?: string;
  reason: string;
};

type DiscoveryDecision = {
  status: "complete" | "needs_input";
  discovery_md: string;
  open_questions: string[];
};

type RunContext = {
  codex: Codex;
  model: string;
  turnTimeoutMs: number;
  runDir: string;
  workspaceDir: string;
  snippetsDir: string;
  task: string;
  webSearchMode?: WebSearchMode;
  threads: Map<Role, Thread>;
};

type ObserverContext = {
  codex: Codex;
  model: string;
  turnTimeoutMs: number;
  runDir: string;
  snippetsDir: string;
  webSearchMode?: WebSearchMode;
  threads: Map<Role, Thread>;
};

export async function runSmokeTest(
  options: { model?: string; turnTimeoutMs?: number; webSearchMode?: WebSearchMode } = {},
): Promise<CodexTurn> {
  const resolvedModel = resolveModel(options.model);
  const turnTimeoutMs = resolveTurnTimeout(options.turnTimeoutMs);
  const webSearchMode = resolveWebSearchMode(options.webSearchMode);
  return runSmokeTestWithSignal(resolvedModel, turnTimeoutMs, webSearchMode);
}

async function runSmokeTestWithSignal(model: string, turnTimeoutMs: number, webSearchMode?: WebSearchMode): Promise<CodexTurn> {
  const codex = new Codex();
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, turnTimeoutMs);

  const thread = codex.startThread({
    model,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode,
  });

  try {
    return await thread.run(smokePrompt(model), { signal: abortController.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readSdkVersion(): Promise<string> {
  try {
    const packagePath = path.resolve("package.json");
    const packageContent = await readFile(packagePath, "utf8");
    const packageJson = JSON.parse(packageContent) as { dependencies?: Record<string, string> };
    return packageJson.dependencies?.["@openai/codex-sdk"] ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function runDiscovery(
  context: RunContext,
  task: string,
  snippetsDir: string,
  userAnswers = "",
): Promise<{ ok: boolean; result?: DiscoveryDecision; reason?: string }> {
  const prompt = await discoveryPrompt(task, snippetsDir, userAnswers);
  const role = "discovery";
  const thread = getThread(context, role);
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, context.turnTimeoutMs);

  try {
    const turn = await thread.run(prompt, { outputSchema: discoverySchema, signal: abortController.signal });
    const endedAt = new Date().toISOString();
    await writeSessionLog(context, {
      role,
      prompt,
      turn,
      startedAt,
      endedAt,
      threadId: thread.id,
    });

    const parsed = parseDiscoveryDecision(turn.finalResponse);
    return { ok: true, result: parsed };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const reason = summarizeError(error);

    await writeRoleErrorLog(context, {
      role,
      prompt,
      reason,
      error,
      startedAt,
      endedAt,
      threadId: thread.id,
    });
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function collectDiscoveryAnswers(questions: string[]): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answers: string[] = [];

  try {
    for (const [index, question] of questions.entries()) {
      const title = question.trim() === "" ? `Question ${index + 1}` : question.trim();
      const answer = await rl.question(`\n${index + 1}. ${title}\n> `);
      answers.push(`Q: ${title}\nA: ${answer.trim() || "Not provided"}`);
    }
  } finally {
    await rl.close();
  }

  return answers.join("\n\n");
}

export async function runOrchestration(options: RunOptions): Promise<RunResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const model = resolveModel(options.model);
  const runDir = await createRunDirectory(options.runsDir ?? DEFAULT_RUNS_DIR);
  const workspaceDir = path.join(runDir, "workspace");
  const apiProbesDir = path.join(runDir, "api-probes");
  const snippetsDir = path.resolve(options.snippetsDir ?? DEFAULT_SNIPPETS_DIR);
  const webSearchMode = resolveWebSearchMode(options.webSearchMode);
  const task = await readFile(path.resolve(options.taskFile), "utf8");

  await ensureSnippetCatalog(snippetsDir);
  await initializeRunProtocol({
    runDir,
    task,
    model,
    startedAt,
  });

  const context: RunContext = {
    codex: new Codex(),
    model,
    turnTimeoutMs: resolveTurnTimeout(options.turnTimeoutMs),
    runDir,
    workspaceDir,
    snippetsDir,
    task,
    webSearchMode,
    threads: new Map<Role, Thread>(),
  };

  const maxLoops = options.maxLoops ?? DEFAULT_MAX_LOOPS;
  const runMonitorSdk = resolveMonitorSdk(options.monitorSdk);
  const turnTimeoutMs = resolveTurnTimeout(options.turnTimeoutMs);
  const runMeta: RunMeta = {
    taskFile: path.resolve(options.taskFile),
    startedAt,
    startedAtMs,
    maxLoops,
    turnTimeoutMs,
    observe: Boolean(options.observe),
    monitorSdk: runMonitorSdk,
    skipDiscovery: Boolean(options.skipDiscovery),
    webSearchMode,
  };
  let sdkMonitor: SdkHealthResult | undefined;

  if (runMonitorSdk) {
    const monitorModel = options.model;
    const health = await runSdkHealthCheck({
      model: monitorModel,
      turnTimeoutMs,
      runDir,
      webSearchMode,
    });
    await writeFile(path.join(context.runDir, SDK_MONITOR_RUN_FILE), `${JSON.stringify(health, null, 2)}\n`, "utf8");
    sdkMonitor = health;
    await appendProgress(
      context.runDir,
      `\n## SDK Health (${health.checkedAt})\n\nStatus: ${health.status}\nModel: ${health.model}\nSDK Version: ${health.sdkVersion}\nResult: ${health.passed ? "passed" : "failed"}\n${health.reason ? `Reason: ${health.reason}\n` : ""}\n`,
    );

    if (!health.passed) {
      const reason = `SDK monitor failed: ${health.reason ?? "codex sdk probe failed"}`;
      await appendBlocker(context.runDir, reason);
      return await finishRun(context, {
        runDir,
        status: "ask_user",
        reason,
        observer: undefined,
        snippetCandidates: [],
        sdkMonitor: health,
      }, runMeta);
    }
  }

  if (!options.skipDiscovery) {
    const discoveryResult = await runDiscovery(context, task, snippetsDir);
    if (!discoveryResult.ok) {
      const reason = `Discovery failed: ${discoveryResult.reason}`;
      await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
      await appendBlocker(context.runDir, reason);
      return await finishRun(context, {
        runDir,
        status: "ask_user",
        reason,
        observer: undefined,
        snippetCandidates: [],
        sdkMonitor,
      }, runMeta);
    }

    const discoveryDecision = discoveryResult.result;
    if (!discoveryDecision) {
      const reason = "Discovery result missing after successful run.";
      await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
      await appendBlocker(context.runDir, reason);
      return await finishRun(context, {
        runDir,
        status: "ask_user",
        reason,
        observer: undefined,
        snippetCandidates: [],
        sdkMonitor,
      }, runMeta);
    }

    await writeFile(path.join(context.runDir, "discovery.md"), discoveryDecision.discovery_md);
    if (discoveryDecision.status !== "complete") {
      if (!process.stdin.isTTY) {
        const askUserReason = "Discovery has high-impact open questions. Re-run with --skip-discovery for non-interactive usage.";
        await appendBlocker(
          context.runDir,
          `Discovery incomplete (non-interactive): ${discoveryDecision.open_questions.join("; ")}`,
        );
        await appendProgress(
          context.runDir,
          `\n## Failed\n\nDiscovery requires user input but CLI is not interactive.\n`,
        );
        return await finishRun(context, {
          runDir,
          status: "ask_user",
          reason: askUserReason,
          observer: options.observe
            ? await safeRunObserver({
              runDir,
              model: options.model,
              snippetsDir: options.snippetsDir,
              turnTimeoutMs: options.turnTimeoutMs,
            })
            : undefined,
          sdkMonitor,
          snippetCandidates: [],
        }, runMeta);
      }

      const answers = await collectDiscoveryAnswers(discoveryDecision.open_questions);
      const finalDiscoveryResult = await runDiscovery(context, task, snippetsDir, answers);
      if (!finalDiscoveryResult.ok) {
        const reason = `Discovery finalization failed: ${finalDiscoveryResult.reason}`;
        await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
        await appendBlocker(context.runDir, reason);
        return await finishRun(context, {
          runDir,
          status: "ask_user",
          reason,
          observer: options.observe
            ? await safeRunObserver({
              runDir,
              model: options.model,
              snippetsDir: options.snippetsDir,
              turnTimeoutMs: options.turnTimeoutMs,
            })
            : undefined,
          sdkMonitor,
          snippetCandidates: [],
        }, runMeta);
      }

      if (!finalDiscoveryResult.result) {
        const reason = "Discovery finalization completed without payload.";
        await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
        await appendBlocker(context.runDir, reason);
        return await finishRun(context, {
          runDir,
          status: "ask_user",
          reason,
          observer: options.observe
            ? await safeRunObserver({
              runDir,
              model: options.model,
              snippetsDir: options.snippetsDir,
              turnTimeoutMs: options.turnTimeoutMs,
            })
            : undefined,
          sdkMonitor,
          snippetCandidates: [],
        }, runMeta);
      }

      await writeFile(path.join(context.runDir, "discovery.md"), finalDiscoveryResult.result.discovery_md);
      if (finalDiscoveryResult.result.status !== "complete") {
        const askUserReason = "Discovery still has open questions after one clarification round.";
        await appendBlocker(
          context.runDir,
          `Discovery incomplete: ${finalDiscoveryResult.result.open_questions.join("; ")}`,
        );
        return await finishRun(context, {
          runDir,
          status: "ask_user",
          reason: askUserReason,
          observer: options.observe
            ? await safeRunObserver({
              runDir,
              model: options.model,
              snippetsDir: options.snippetsDir,
              turnTimeoutMs: options.turnTimeoutMs,
            })
            : undefined,
          sdkMonitor,
          snippetCandidates: [],
        }, runMeta);
      }
    }
  }

  const researcherResult = await runRole(context, "researcher", await researcherPrompt(task, snippetsDir));
  if (!researcherResult.ok) {
    const reason = `Researcher failed: ${researcherResult.reason}`;
    await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
    await appendBlocker(context.runDir, reason);
    return await finishRun(context, {
      runDir,
      status: "ask_user",
      reason,
      observer: options.observe
        ? await safeRunObserver({
          runDir,
          model: options.model,
          snippetsDir: options.snippetsDir,
          turnTimeoutMs: options.turnTimeoutMs,
        })
        : undefined,
      sdkMonitor,
      snippetCandidates: [],
    }, runMeta);
  }

  let finalStatus: RunResult["status"] = "max_loops_reached";
  let finalReason: string | undefined;

  for (let loop = 1; loop <= maxLoops; loop += 1) {
    const managerRoleResult = await runRole(context, "manager", await managerPrompt(loop, context.runDir, context.snippetsDir));
    if (!managerRoleResult.ok) {
      const reason = `Manager failed: ${managerRoleResult.reason}`;
      await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
      await appendBlocker(context.runDir, reason);
      finalStatus = "ask_user";
      finalReason = reason;
      break;
    }

    let decision: ManagerDecision;
    try {
      decision = parseManagerDecision(managerRoleResult.turn.finalResponse);
    } catch (error) {
      const reason = `Manager returned invalid decision: ${summarizeError(error)}`;
      await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
      await appendBlocker(context.runDir, reason);
      finalStatus = "ask_user";
      finalReason = reason;
      break;
    }

    if (decision.next_action === "done") {
      const closeoutGate = await evaluateCloseoutGate(context.runDir);
      if (!closeoutGate.ok) {
        const reason = `Closeout gate failed: ${closeoutGate.issues.join("; ")}`;
        await appendProgress(context.runDir, `\n## Closeout Gate\n\n${reason}\n`);

        if (loop >= maxLoops) {
          await appendBlocker(context.runDir, reason);
          finalStatus = "ask_user";
          finalReason = reason;
          break;
        }

        const testerRoleResult = await runRole(context, "tester", await testerPrompt({
          next_action: "test",
          target: "closeout",
          instructions: `Resolve closeout gate issues before completion: ${closeoutGate.issues.join("; ")}`,
          reason,
        }, context.runDir, context.snippetsDir));
        if (!testerRoleResult.ok) {
          const testerReason = `Tester failed after closeout gate: ${testerRoleResult.reason}`;
          await appendProgress(context.runDir, `\n## Failed\n\n${testerReason}\n`);
          await appendBlocker(context.runDir, testerReason);
          finalStatus = "ask_user";
          finalReason = testerReason;
          break;
        }
        continue;
      }

      await appendProgress(context.runDir, `\n## Final\n\nDone: ${decision.reason}\n`);
      finalStatus = "done";
      finalReason = decision.reason;
      break;
    }

    if (decision.next_action === "ask_user") {
      await appendBlocker(context.runDir, decision.reason);
      finalStatus = "ask_user";
      finalReason = decision.reason;
      break;
    }

    if (decision.next_action === "develop") {
      const developerRoleResult = await runRole(context, "developer", await developerPrompt(decision, context.runDir, context.snippetsDir));
      if (!developerRoleResult.ok) {
        const reason = `Developer failed: ${developerRoleResult.reason}`;
        await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
        await appendBlocker(context.runDir, reason);
        finalStatus = "ask_user";
        finalReason = reason;
        break;
      }
      continue;
    }

    if (decision.next_action === "test") {
      const testerRoleResult = await runRole(context, "tester", await testerPrompt(decision, context.runDir, context.snippetsDir));
      if (!testerRoleResult.ok) {
        const reason = `Tester failed: ${testerRoleResult.reason}`;
        await appendProgress(context.runDir, `\n## Failed\n\n${reason}\n`);
        await appendBlocker(context.runDir, reason);
        finalStatus = "ask_user";
        finalReason = reason;
        break;
      }
      continue;
    }
  }

  if (finalStatus === "max_loops_reached" && !finalReason) {
    finalReason = `Manager did not finish within ${maxLoops} loop(s).`;
    await appendBlocker(context.runDir, finalReason);
  }

  const observer = options.observe
    ? await safeRunObserver({
      runDir,
      model: options.model,
      snippetsDir: options.snippetsDir,
      turnTimeoutMs: options.turnTimeoutMs,
      webSearchMode,
    })
    : undefined;

  const snippetCandidates = finalStatus === "done" && observer?.status === "done"
    ? await safeGenerateSnippetCandidates({
      runDir,
      snippetsDir,
    })
    : [];

  return await finishRun(context, {
    runDir,
    status: finalStatus,
    reason: finalReason,
    observer,
    snippetCandidates,
    sdkMonitor,
  }, runMeta);
}

async function runSdkHealthCheck(options: {
  model?: string;
  turnTimeoutMs: number;
  runDir: string;
  webSearchMode?: WebSearchMode;
}): Promise<SdkHealthResult> {
  const model = resolveModel(options.model);
  const checkedAt = new Date().toISOString();
  const sdkVersion = await readSdkVersion();
  const monitorDir = path.resolve(SDK_MONITOR_DIR);
  const baselinePath = path.join(monitorDir, SDK_MONITOR_FILE);
  await mkdir(monitorDir, { recursive: true });

  let previous: SdkHealthResult | undefined;
  try {
    const baselineContent = await readFile(baselinePath, "utf8");
    previous = JSON.parse(baselineContent) as SdkHealthResult;
  } catch {
    previous = undefined;
  }

  let smokeError: string | undefined;
  try {
    await runSmokeTestWithSignal(model, options.turnTimeoutMs, options.webSearchMode);
  } catch (error) {
    smokeError = summarizeError(error);
  }

  const currentPassed = smokeError === undefined;
  const health: SdkHealthResult = {
    status: currentPassed ? "ok" : "failed",
    model,
    sdkVersion,
    passed: currentPassed,
    checkedAt,
    previousPassed: previous?.passed,
    previousReason: previous?.reason,
  };

  if (previous && previous.passed === true && !currentPassed) {
    health.status = "degraded";
    health.reason = `SDK health regressed since last run: ${previous.reason ?? "previous smoke passed"} -> now failed (${smokeError ?? "no response"})`;
  } else if (!currentPassed && smokeError) {
    health.reason = smokeError;
  } else {
    health.reason = smokeError;
  }

  await writeFile(baselinePath, `${JSON.stringify({
    checkedAt: health.checkedAt,
    model: health.model,
    sdkVersion: health.sdkVersion,
    passed: health.passed,
    status: health.status,
    reason: health.reason,
  }, null, 2)}\n`, "utf8");

  return health;
}

export function buildRunSummary(input: RunSummaryInput): RunSummary {
  return {
    schemaVersion: 1,
    runDir: input.runDir,
    status: input.status,
    reason: input.reason,
    model: input.model,
    taskFile: input.taskFile,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    maxLoops: input.maxLoops,
    turnTimeoutMs: input.turnTimeoutMs,
    options: input.options,
    sdkMonitor: input.sdkMonitor,
    observer: input.observer,
    snippetCandidates: input.snippetCandidates,
    terminalRole: input.terminalRole,
    failureCategory: input.failureCategory,
    metrics: input.metrics,
    protocol: {
      requiredEntries: RUN_PROTOCOL_ENTRIES,
    },
  };
}

export async function runReport(options: ReportOptions = {}): Promise<RunReport> {
  const runsDir = path.resolve(options.runsDir ?? DEFAULT_RUNS_DIR);
  const limit = options.limit ?? 10;
  const summaries = await readRunSummaries(runsDir);
  summaries.sort((a, b) => b.endedAt.localeCompare(a.endedAt));

  const statuses: Record<RunResult["status"], number> = {
    done: 0,
    ask_user: 0,
    max_loops_reached: 0,
  };
  const failureCategories = createFailureCategoryCounts();
  let totalDurationMs = 0;
  let sdkMonitorFailures = 0;
  let observerFailures = 0;
  const protocolHealthByRunDir = new Map<string, RunReport["recentRuns"][number]["protocolHealth"]>();
  const snippetDecisionByRunDir = new Map<string, SnippetDecision>();
  const snippetUsage = createSnippetUsageCounts();
  const protocolHealth = {
    missingRequiredProtocolEntriesCount: 0,
    invalidOrMissingApiProbesReadmeSectionsCount: 0,
    progressRunSummaryDriftCount: 0,
  };

  for (const summary of summaries) {
    statuses[summary.status] += 1;
    const failureCategory = normalizeSummaryFailureCategory(summary);
    failureCategories[failureCategory] += 1;
    totalDurationMs += summary.durationMs;
    if (summary.sdkMonitor && !summary.sdkMonitor.passed) {
      sdkMonitorFailures += 1;
    }
    if (summary.observer?.status === "failed") {
      observerFailures += 1;
    }

    const snippetDecision = await readRunSnippetDecision(summary.runDir);
    snippetDecisionByRunDir.set(summary.runDir, snippetDecision);
    snippetUsage[snippetDecision.status] += 1;

    const runProtocol = await validateRunProtocol(summary.runDir);
    const apiProbesReadme = await validateApiProbesReadme(summary.runDir);
    const progressDrift = await compareProgressRunSummary(summary.runDir);
    const runProtocolHealth = {
      missingRequiredEntries: !runProtocol.ok,
      invalidApiProbesReadmeSections: !apiProbesReadme.ok,
      progressRunSummaryDrift: !progressDrift.ok,
    };
    protocolHealthByRunDir.set(summary.runDir, runProtocolHealth);
    if (runProtocolHealth.missingRequiredEntries) {
      protocolHealth.missingRequiredProtocolEntriesCount += 1;
    }
    if (runProtocolHealth.invalidApiProbesReadmeSections) {
      protocolHealth.invalidOrMissingApiProbesReadmeSectionsCount += 1;
    }
    if (runProtocolHealth.progressRunSummaryDrift) {
      protocolHealth.progressRunSummaryDriftCount += 1;
    }
  }

  return {
    runsDir,
    totalRuns: summaries.length,
    statuses,
    failureCategories,
    snippetUsage,
    averageDurationMs: summaries.length === 0 ? 0 : Math.round(totalDurationMs / summaries.length),
    sdkMonitorFailures,
    observerFailures,
    protocolHealth,
    recentRuns: summaries.slice(0, limit).map((summary) => ({
      runDir: summary.runDir,
      status: summary.status,
      failureCategory: normalizeSummaryFailureCategory(summary),
      reason: summary.reason,
      model: summary.model,
      durationMs: summary.durationMs,
      endedAt: summary.endedAt,
      snippetDecision: snippetDecisionByRunDir.get(summary.runDir) ?? { status: "unknown" },
      protocolHealth: protocolHealthByRunDir.get(summary.runDir) ?? {
        missingRequiredEntries: true,
        invalidApiProbesReadmeSections: true,
        progressRunSummaryDrift: true,
      },
    })),
  };
}

export async function buildRunRepairPlan(options: RepairPlanOptions): Promise<RunRepairPlan> {
  const runDir = path.resolve(options.runDir);
  const [summary, runProtocol, apiProbesReadme, progressDrift] = await Promise.all([
    readRunSummary(runDir),
    validateRunProtocol(runDir),
    validateApiProbesReadme(runDir),
    compareProgressRunSummary(runDir),
  ]);

  const issues: string[] = [];
  if (!runProtocol.ok) {
    issues.push(`Missing required protocol entries: ${runProtocol.missing.join(", ")}`);
  }
  if (!apiProbesReadme.ok) {
    issues.push(`Missing api-probes/README.md sections: ${apiProbesReadme.missingSections.join(", ")}`);
  }
  if (!progressDrift.ok) {
    issues.push(...progressDrift.details);
    for (const mismatch of progressDrift.mismatches) {
      issues.push(`Progress/run-summary drift: ${mismatch.key} progress=${JSON.stringify(mismatch.progressValue)} summary=${JSON.stringify(mismatch.summaryValue)}`);
    }
  }

  if (!summary) {
    return {
      runDir,
      action: "repair_protocol",
      resumable: false,
      failureCategory: "unknown",
      summary: "Run is missing a readable run-summary.json; repair protocol files before attempting recovery.",
      issues: issues.length > 0 ? issues : ["run-summary.json missing or unreadable"],
      commands: [],
    };
  }

  const failureCategory = normalizeSummaryFailureCategory(summary);
  if (issues.length > 0) {
    return {
      runDir,
      action: "repair_protocol",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "Run has protocol health issues; repair the file protocol before rerunning or resuming.",
      issues,
      commands: [],
    };
  }

  if (summary.status === "done" && failureCategory === "none") {
    return {
      runDir,
      action: "none",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "Run is already done; no repair action is needed.",
      issues: [],
      commands: [],
    };
  }

  if (failureCategory === "turn_timeout") {
    const timeoutMs = Math.max(summary.turnTimeoutMs * 2, 600_000);
    return {
      runDir,
      action: "rerun",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "The last run timed out. Re-run the original task with the stable model and a longer turn timeout.",
      issues: [],
      commands: [
        `codex-gtd run --task ${shellQuote(summary.taskFile)} --model ${ROLE_FALLBACK_MODEL} --turn-timeout-ms ${timeoutMs} --skip-sdk-monitor`,
      ],
    };
  }

  if (failureCategory === "unsupported_tool") {
    return {
      runDir,
      action: "rerun",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "The selected model hit an unsupported tool path. Re-run the task with the stable model.",
      issues: [],
      commands: [
        `codex-gtd run --task ${shellQuote(summary.taskFile)} --model ${ROLE_FALLBACK_MODEL} --skip-sdk-monitor`,
      ],
    };
  }

  if (failureCategory === "discovery_needed" || failureCategory === "blocker") {
    return {
      runDir,
      action: "answer_user",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "Run needs user input or external access before it can continue.",
      issues: summary.reason ? [summary.reason] : [],
      commands: [],
    };
  }

  if (failureCategory === "max_loops") {
    return {
      runDir,
      action: "rerun",
      resumable: false,
      status: summary.status,
      failureCategory,
      terminalRole: summary.terminalRole,
      reason: summary.reason,
      summary: "Run reached the loop limit. Inspect progress.md, then re-run with a higher loop budget if the remaining work is clear.",
      issues: [],
      commands: [
        `codex-gtd run --task ${shellQuote(summary.taskFile)} --model ${shellQuote(summary.model)} --max-loops ${summary.maxLoops + 2} --skip-sdk-monitor`,
      ],
    };
  }

  return {
    runDir,
    action: "inspect",
    resumable: false,
    status: summary.status,
    failureCategory,
    terminalRole: summary.terminalRole,
    reason: summary.reason,
    summary: "No deterministic automatic recovery is available yet. Inspect progress.md, blockers.md, and session-log/.",
    issues: summary.reason ? [summary.reason] : [],
    commands: [],
  };
}

export async function exportWorkspacePatch(options: ExportWorkspaceOptions): Promise<ExportWorkspaceResult> {
  const runDir = path.resolve(options.runDir);
  const workspaceDir = path.join(runDir, "workspace");
  const outFile = path.resolve(options.outFile ?? path.join(runDir, "workspace.patch"));
  const files = await collectWorkspaceTextFiles(workspaceDir);

  if (files.length === 0) {
    throw new Error("workspace is empty");
  }

  const chunks = [
    `# Workspace export from ${runDir}`,
    `# Review before applying. Generated files are relative to workspace/.`,
    "",
  ];
  let byteCount = 0;

  for (const file of files) {
    const raw = await readFile(file.absolutePath);
    if (isLikelyBinary(raw)) {
      throw new Error(`workspace contains a binary or non-text file: ${file.relativePath}`);
    }

    const content = raw.toString("utf8");
    byteCount += raw.byteLength;
    chunks.push(formatNewFilePatch(file.relativePath, content));
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, chunks.join("\n"), "utf8");

  return {
    runDir,
    workspaceDir,
    outFile,
    fileCount: files.length,
    byteCount,
  };
}

export async function applyWorkspacePatch(options: ApplyWorkspaceOptions): Promise<ApplyWorkspaceResult> {
  const targetDir = path.resolve(options.targetDir);
  assertCleanGitTarget(targetDir);

  const exportResult = await exportWorkspacePatch({
    runDir: options.runDir,
    outFile: options.patchFile,
  });

  runGit(targetDir, ["apply", "--check", exportResult.outFile]);

  if (options.write) {
    runGit(targetDir, ["apply", exportResult.outFile]);
  }

  return {
    runDir: exportResult.runDir,
    targetDir,
    patchFile: exportResult.outFile,
    fileCount: exportResult.fileCount,
    byteCount: exportResult.byteCount,
    applied: Boolean(options.write),
  };
}

export async function buildResumePlan(options: ResumePlanOptions): Promise<ResumePlan> {
  const runDir = path.resolve(options.runDir);
  const repairPlan = await buildRunRepairPlan({ runDir });

  if (repairPlan.action !== "none") {
    return {
      runDir,
      action: repairPlan.action,
      ready: false,
      source: "repair-plan",
      summary: repairPlan.summary,
      issues: repairPlan.issues,
      commands: repairPlan.commands,
    };
  }

  const workspaceFiles = await collectWorkspaceTextFiles(path.join(runDir, "workspace"));
  if (workspaceFiles.length === 0) {
    return {
      runDir,
      action: "inspect",
      ready: false,
      source: "resume",
      summary: "Run is done, but workspace is empty. Nothing can be exported or applied.",
      issues: ["workspace is empty"],
      commands: [],
    };
  }

  if (options.targetDir) {
    const targetDir = path.resolve(options.targetDir);
    return {
      runDir,
      action: "apply_workspace",
      ready: true,
      source: "resume",
      summary: "Run is done and workspace output is ready for guarded apply.",
      issues: [],
      commands: [
        `codex-gtd apply-workspace --run-dir ${shellQuote(runDir)} --target ${shellQuote(targetDir)}`,
        `codex-gtd apply-workspace --run-dir ${shellQuote(runDir)} --target ${shellQuote(targetDir)} --write`,
      ],
    };
  }

  return {
    runDir,
    action: "export_workspace",
    ready: true,
    source: "resume",
    summary: "Run is done and workspace output is ready to export as a reviewable patch.",
    issues: [],
    commands: [
      `codex-gtd export-workspace --run-dir ${shellQuote(runDir)}`,
    ],
  };
}

async function readRunSummaries(runsDir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const entry of entries) {
    const summaryPath = path.join(runsDir, entry, RUN_SUMMARY_FILE);
    try {
      const raw = await readFile(summaryPath, "utf8");
      const parsed = JSON.parse(raw) as RunSummary;
      if (isRunSummary(parsed)) {
        summaries.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return summaries;
}

async function readRunSummary(runDir: string): Promise<RunSummary | undefined> {
  try {
    const raw = await readFile(path.join(runDir, RUN_SUMMARY_FILE), "utf8");
    const parsed = JSON.parse(raw) as RunSummary;
    return isRunSummary(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type WorkspaceTextFile = {
  absolutePath: string;
  relativePath: string;
};

async function collectWorkspaceTextFiles(workspaceDir: string): Promise<WorkspaceTextFile[]> {
  const files: WorkspaceTextFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new Error("workspace is missing or unreadable");
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".DS_Store") {
        continue;
      }

      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      files.push({
        absolutePath,
        relativePath: toPatchPath(path.relative(workspaceDir, absolutePath)),
      });
    }
  }

  await visit(workspaceDir);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

function formatNewFilePatch(relativePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const hunkLineCount = lines.length === 1 && lines[0] === "" ? 0 : lines.length;
  const body = hunkLineCount === 0 ? "" : `${lines.map((line) => `+${line}`).join("\n")}\n`;
  const noNewlineMarker = normalized.endsWith("\n") || hunkLineCount === 0 ? "" : "\\ No newline at end of file\n";

  return `diff --git a/${relativePath} b/${relativePath}
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/${relativePath}
@@ -0,0 +1,${hunkLineCount} @@
${body}${noNewlineMarker}`;
}

function toPatchPath(value: string): string {
  return value.split(path.sep).join("/");
}

function isLikelyBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function assertCleanGitTarget(targetDir: string): void {
  try {
    runGit(targetDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error("target must be a git repository");
  }

  const status = runGit(targetDir, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error("target repository has uncommitted changes");
  }
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }
    throw error;
  }
}

function isRunSummary(value: unknown): value is RunSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RunSummary>;
  return candidate.schemaVersion === 1
    && (candidate.status === "done" || candidate.status === "ask_user" || candidate.status === "max_loops_reached")
    && typeof candidate.runDir === "string"
    && typeof candidate.model === "string"
    && typeof candidate.endedAt === "string"
    && typeof candidate.durationMs === "number";
}

async function finishRun(
  context: RunContext,
  result: RunResult,
  meta: RunMeta,
): Promise<RunResult> {
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const sessionMetrics = await readSessionLogMetrics(context.runDir);
  const failureCategory = classifyFailure(result, sessionMetrics.terminalRole);
  await appendProgress(context.runDir, "", {
    status: progressStatusForResult(result, failureCategory),
    model: context.model,
    startedAt: meta.startedAt,
    lastUpdatedAt: endedAt,
    lastRole: sessionMetrics.terminalRole ?? "driver",
    loop: sessionMetrics.roleTurns.manager ?? 0,
    terminal: true,
    reason: result.reason,
  });
  const summary = buildRunSummary({
    runDir: result.runDir,
    status: result.status,
    reason: result.reason,
    model: context.model,
    taskFile: meta.taskFile,
    startedAt: meta.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAtMs - meta.startedAtMs),
    maxLoops: meta.maxLoops,
    turnTimeoutMs: meta.turnTimeoutMs,
    options: {
      observe: meta.observe,
      monitorSdk: meta.monitorSdk,
      skipDiscovery: meta.skipDiscovery,
      webSearchMode: meta.webSearchMode,
    },
    sdkMonitor: result.sdkMonitor,
    observer: result.observer,
    snippetCandidates: result.snippetCandidates ?? [],
    terminalRole: sessionMetrics.terminalRole,
    failureCategory,
    metrics: {
      sessionLogEntries: sessionMetrics.sessionLogEntries,
      roleTurns: sessionMetrics.roleTurns,
    },
  });

  await writeFile(path.join(context.runDir, RUN_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return result;
}

function progressStatusForResult(result: RunResult, failureCategory: FailureCategory): ProgressStatus {
  if (result.status === "done" && failureCategory === "none") return "done";
  if (result.status === "max_loops_reached") return "max_loops_reached";
  if (result.status === "ask_user" && (failureCategory === "blocker" || failureCategory === "discovery_needed" || failureCategory === "sdk_failed")) {
    return "blocked";
  }
  return "failed";
}

export async function validateRunProtocol(
  runDir: string,
  requiredEntries: readonly string[] = RUN_PROTOCOL_ENTRIES,
): Promise<RunProtocolValidation> {
  const found: string[] = [];
  const missing: string[] = [];

  for (const entry of requiredEntries) {
    const isDirectory = entry.endsWith("/");
    const entryPath = path.join(runDir, isDirectory ? entry.slice(0, -1) : entry);
    try {
      const stats = await stat(entryPath);
      if ((isDirectory && stats.isDirectory()) || (!isDirectory && stats.isFile())) {
        found.push(entry);
      } else {
        missing.push(entry);
      }
    } catch {
      missing.push(entry);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    found,
  };
}

export async function validateApiProbesReadme(
  runDir: string,
  requiredSections: readonly string[] = API_PROBE_README_SECTIONS,
): Promise<ApiProbeReadmeValidation> {
  let markdown = "";
  try {
    markdown = await readFile(path.join(runDir, "api-probes", "README.md"), "utf8");
  } catch {
    return {
      ok: false,
      missingSections: [...requiredSections],
      presentSections: [],
    };
  }

  const headings = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    const heading = match[1]?.trim();
    if (heading) headings.add(heading);
  }

  const presentSections = requiredSections.filter((section) => headings.has(section));
  const missingSections = requiredSections.filter((section) => !headings.has(section));
  return {
    ok: missingSections.length === 0,
    missingSections,
    presentSections,
  };
}

export async function evaluateCloseoutGate(runDir: string): Promise<CloseoutGateResult> {
  const issues: string[] = [];

  const runProtocol = await validateRunProtocol(runDir, CLOSEOUT_PROTOCOL_ENTRIES);
  if (!runProtocol.ok) {
    issues.push(`missing protocol entries: ${runProtocol.missing.join(", ")}`);
  }

  const apiProbesReadme = await validateApiProbesReadme(runDir);
  if (!apiProbesReadme.ok) {
    issues.push(`missing api-probes/README.md sections: ${apiProbesReadme.missingSections.join(", ")}`);
  }

  try {
    const workspaceEntries = await readdir(path.join(runDir, "workspace"));
    if (workspaceEntries.length === 0) {
      issues.push("workspace is empty");
    }
  } catch {
    issues.push("workspace is missing or unreadable");
  }

  let progress = "";
  try {
    progress = await readFile(path.join(runDir, "progress.md"), "utf8");
  } catch {
    issues.push("progress.md is missing or unreadable");
  }

  if (progress) {
    const hasCommandEvidence = /(?:verification command|test command|ran `?|executed verification command|command:)/i.test(progress);
    const hasResultEvidence = /(?:verification result|pass\b|passed|successfully|exit code\s*[:=]?\s*0|matching structural output|acceptance[^.\n]*verified)/i.test(progress);
    if (!hasCommandEvidence || !hasResultEvidence) {
      issues.push("progress.md missing verification evidence");
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export async function compareProgressRunSummary(runDir: string): Promise<ProtocolDriftReport> {
  const details: string[] = [];
  let progressState: ProgressState | undefined;
  let summary: RunSummary | undefined;

  try {
    progressState = parseProgressState(await readFile(path.join(runDir, "progress.md"), "utf8"));
    if (!progressState) details.push("progress.md missing valid progress state block");
  } catch {
    details.push("progress.md missing or unreadable");
  }

  try {
    const parsed = JSON.parse(await readFile(path.join(runDir, RUN_SUMMARY_FILE), "utf8")) as RunSummary;
    if (isRunSummary(parsed)) {
      summary = parsed;
    } else {
      details.push("run-summary.json is not a valid run summary");
    }
  } catch {
    details.push("run-summary.json missing or unreadable");
  }

  if (!progressState || !summary) {
    return { ok: false, mismatches: [], details };
  }

  const expected = progressStateFromSummary(summary);
  const mismatches: ProtocolDriftMismatch[] = [];
  for (const key of ["status", "terminal", "lastRole", "loop", "reason"] as const) {
    if (progressState[key] !== expected[key]) {
      mismatches.push({
        key,
        progressValue: progressState[key],
        summaryValue: expected[key],
      });
    }
  }

  return {
    ok: mismatches.length === 0 && details.length === 0,
    mismatches,
    details,
  };
}

export function buildObserverProtocolHealthSection(input: ObserverProtocolHealthInput): string {
  const lines = ["## Protocol Health", ""];
  const hasIssues = !input.runProtocol.ok || !input.apiProbesReadme.ok || !input.progressDrift.ok;

  if (!hasIssues) {
    lines.push("Protocol Health is clean.");
    return `${lines.join("\n")}\n`;
  }

  if (!input.runProtocol.ok) {
    lines.push("Missing required protocol entries:");
    for (const entry of input.runProtocol.missing) {
      lines.push(`- ${entry}`);
    }
    lines.push("");
  }

  if (!input.apiProbesReadme.ok) {
    lines.push("Missing api-probes/README.md sections:");
    for (const section of input.apiProbesReadme.missingSections) {
      lines.push(`- ${section}`);
    }
    lines.push("");
  }

  if (!input.progressDrift.ok) {
    if (input.progressDrift.mismatches.length > 0) {
      lines.push("Progress/run-summary drift:");
      for (const mismatch of input.progressDrift.mismatches) {
        lines.push(`- ${mismatch.key}: progress=${JSON.stringify(mismatch.progressValue)} summary=${JSON.stringify(mismatch.summaryValue)}`);
      }
      lines.push("");
    }
    if (input.progressDrift.details.length > 0) {
      lines.push("Protocol health details:");
      for (const detail of input.progressDrift.details) {
        lines.push(`- ${detail}`);
      }
      lines.push("");
    }
  }

  lines.push("Mention these protocol health issues in lessons.md.");
  lines.push("Include concrete repair suggestions.");
  return `${lines.join("\n")}\n`;
}

async function buildObserverProtocolHealthSectionForRun(runDir: string): Promise<string> {
  try {
    const [runProtocol, apiProbesReadme, progressDrift] = await Promise.all([
      validateRunProtocol(runDir),
      validateApiProbesReadme(runDir),
      compareProgressRunSummary(runDir),
    ]);
    return buildObserverProtocolHealthSection({
      runProtocol,
      apiProbesReadme,
      progressDrift,
    });
  } catch (error) {
    return `## Protocol Health

Protocol health evaluation failed: ${summarizeError(error)}
Mention this protocol health evaluation failure in lessons.md.
`;
  }
}

function progressStateFromSummary(summary: RunSummary): Pick<ProgressState, "status" | "terminal" | "lastRole" | "loop" | "reason"> {
  return {
    status: progressStatusForSummary(summary),
    terminal: true,
    lastRole: summary.terminalRole ?? "driver",
    loop: summary.metrics.roleTurns.manager ?? 0,
    reason: summary.reason,
  };
}

function progressStatusForSummary(summary: RunSummary): ProgressStatus {
  if (summary.status === "done" && summary.failureCategory === "none") return "done";
  if (summary.status === "max_loops_reached") return "max_loops_reached";
  if (
    summary.status === "ask_user"
    && (summary.failureCategory === "blocker" || summary.failureCategory === "discovery_needed" || summary.failureCategory === "sdk_failed")
  ) {
    return "blocked";
  }

  return "failed";
}

function createFailureCategoryCounts(): Record<FailureCategory, number> {
  return {
    none: 0,
    sdk_failed: 0,
    discovery_needed: 0,
    blocker: 0,
    max_loops: 0,
    observer_failed: 0,
    role_failed: 0,
    turn_timeout: 0,
    unsupported_tool: 0,
    invalid_manager_decision: 0,
    unknown: 0,
  };
}

function createSnippetUsageCounts(): Record<SnippetDecisionStatus, number> {
  return {
    used: 0,
    rejected: 0,
    none: 0,
    unknown: 0,
  };
}

async function readRunSnippetDecision(runDir: string): Promise<SnippetDecision> {
  try {
    const spec = await readFile(path.join(runDir, "spec.md"), "utf8");
    return parseSnippetDecision(spec);
  } catch {
    return { status: "unknown" };
  }
}

export function parseSnippetDecision(spec: string): SnippetDecision {
  const section = extractMarkdownSection(spec, "Snippet Decision");
  if (!section.trim()) {
    return { status: "unknown" };
  }

  const status = normalizeSnippetDecisionStatus(readLabeledLine(section, "Status"));
  if (status === "unknown") {
    return { status };
  }

  const snippet = readLabeledLine(section, "Snippet");
  const reason = readLabeledLine(section, "Reason");
  return {
    status,
    ...(snippet && snippet.toLowerCase() !== "none" ? { snippet } : {}),
    ...(reason ? { reason } : {}),
  };
}

function normalizeSnippetDecisionStatus(value: string | undefined): SnippetDecisionStatus {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "used" || normalized === "rejected" || normalized === "none") {
    return normalized;
  }

  return "unknown";
}

function readLabeledLine(text: string, label: string): string | undefined {
  const labelRegex = new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(label)}\\s*:\\s*(.+?)\\s*$`, "im");
  return text.match(labelRegex)?.[1]?.trim();
}

function normalizeFailureCategory(value: unknown): FailureCategory {
  if (
    value === "none"
    || value === "sdk_failed"
    || value === "discovery_needed"
    || value === "blocker"
    || value === "max_loops"
    || value === "observer_failed"
    || value === "role_failed"
    || value === "turn_timeout"
    || value === "unsupported_tool"
    || value === "invalid_manager_decision"
    || value === "unknown"
  ) {
    return value;
  }

  return "unknown";
}

function normalizeSummaryFailureCategory(summary: RunSummary): FailureCategory {
  const normalized = normalizeFailureCategory(summary.failureCategory);
  if (normalized !== "role_failed") return normalized;

  return classifyFailure({
    runDir: summary.runDir,
    status: summary.status,
    reason: summary.reason,
    observer: summary.observer,
    snippetCandidates: summary.snippetCandidates,
    sdkMonitor: summary.sdkMonitor,
  }, summary.terminalRole);
}

function classifyFailure(result: RunResult, terminalRole?: string): FailureCategory {
  if (result.observer?.status === "failed") return "observer_failed";
  if (result.sdkMonitor && !result.sdkMonitor.passed) return "sdk_failed";
  if (result.status === "done") return "none";
  if (result.status === "max_loops_reached") return "max_loops";

  const reason = (result.reason ?? "").toLowerCase();
  if (reason.includes("discovery")) return "discovery_needed";
  if (reason.includes("aborterror") || reason.includes("operation was aborted")) return "turn_timeout";
  if (reason.includes("not supported") && reason.includes("tool")) return "unsupported_tool";
  if (reason.includes("invalid decision") || reason.includes("invalid next_action")) {
    return "invalid_manager_decision";
  }
  if (reason.includes("failed")) return "role_failed";
  if (
    reason.includes("missing")
    || reason.includes("credential")
    || reason.includes("secret")
    || reason.includes("api key")
    || reason.includes("blocked")
    || reason.includes("blocker")
    || reason.includes("ask_user")
    || result.status === "ask_user"
  ) {
    return "blocker";
  }
  if (terminalRole === "discovery") return "discovery_needed";

  return "unknown";
}

async function readSessionLogMetrics(runDir: string): Promise<SessionLogMetrics> {
  try {
    const sessionLogDir = path.join(runDir, "session-log");
    const entries = (await readdir(sessionLogDir)).filter((entry) => entry.endsWith(".json")).sort();
    const roleTurns: Record<string, number> = {};
    let terminalRole: string | undefined;
    let terminalStartedAt = "";

    for (const entry of entries) {
      let role = inferRoleFromSessionLogName(entry);
      let startedAt = entry;

      try {
        const raw = await readFile(path.join(sessionLogDir, entry), "utf8");
        const parsed = JSON.parse(raw) as { role?: unknown; startedAt?: unknown };
        if (typeof parsed.role === "string" && parsed.role.trim().length > 0) {
          role = parsed.role;
        }
        if (typeof parsed.startedAt === "string" && parsed.startedAt.trim().length > 0) {
          startedAt = parsed.startedAt;
        }
      } catch {
        startedAt = entry;
      }

      roleTurns[role] = (roleTurns[role] ?? 0) + 1;
      if (startedAt >= terminalStartedAt) {
        terminalStartedAt = startedAt;
        terminalRole = role;
      }
    }

    return {
      sessionLogEntries: entries.length,
      roleTurns,
      terminalRole,
    };
  } catch {
    return { sessionLogEntries: 0, roleTurns: {} };
  }
}

function inferRoleFromSessionLogName(entry: string): string {
  const baseName = entry.replace(/\.json$/, "");
  const markerIndex = baseName.lastIndexOf("Z-");
  const rawRole = markerIndex >= 0 ? baseName.slice(markerIndex + 2) : baseName;
  return rawRole.replace(/-error$/, "") || "unknown";
}

async function safeRunObserver(options: ObserveOptions): Promise<ObserveResult> {
  try {
    return await runObserver(options);
  } catch (error) {
    return { runDir: path.resolve(options.runDir), status: "failed", reason: `Observer failed: ${summarizeError(error)}` };
  }
}

export async function runObserver(options: ObserveOptions): Promise<ObserveResult> {
  const runDir = path.resolve(options.runDir);
  const model = resolveModel(options.model);
  const snippetsDir = path.resolve(options.snippetsDir ?? DEFAULT_SNIPPETS_DIR);
  const webSearchMode = resolveWebSearchMode(options.webSearchMode);

  try {
    const sessionLogDir = path.join(runDir, "session-log");
    const entries = await readdir(sessionLogDir);
    if (entries.length === 0) {
      return { runDir, status: "failed", reason: `No observer input: session-log is empty in ${runDir}` };
    }
  } catch {
    return { runDir, status: "failed", reason: `No observer input: session-log is missing in ${runDir}` };
  }

  await ensureSnippetCatalog(snippetsDir);

  const context: ObserverContext = {
    codex: new Codex(),
    model,
    turnTimeoutMs: resolveTurnTimeout(options.turnTimeoutMs),
    runDir,
    snippetsDir,
    webSearchMode,
    threads: new Map<Role, Thread>(),
  };

  const protocolHealth = await buildObserverProtocolHealthSectionForRun(runDir);
  const observerResult = await runObserverRole(context, await observerPrompt(runDir, context.snippetsDir, protocolHealth));
  if (!observerResult.ok) {
    return { runDir, status: "failed", reason: `Observer failed: ${observerResult.reason}` };
  }

  return { runDir, status: "done" };
}

async function ensureSnippetCatalog(snippetsDir: string): Promise<void> {
  await mkdir(snippetsDir, { recursive: true });
  const indexPath = path.join(snippetsDir, "INDEX.md");
  try {
    await readFile(indexPath, "utf8");
    return;
  } catch {
    await writeFile(indexPath, defaultSnippetIndex(), "utf8");
  }
}

function defaultSnippetIndex(): string {
  return `# Snippets

This repository is starting with a minimal snippet reuse pool.

## How to use

- Add reusable implementation patterns as markdown files in this directory.
- Keep each snippet under ~200 lines.
- Document dependencies, assumptions, and test evidence for quick reuse.
- The researcher reads this index and selected snippets before implementing.
`;
}

type RunRoleResult =
  | {
      ok: true;
      turn: CodexTurn;
    }
  | {
      ok: false;
      reason: string;
    };

export function resolveRoleFallbackModel(model: string, reason: string): string | undefined {
  const normalizedReason = reason.toLowerCase();
  const isSparkModel = model.includes("codex-spark");
  const isUnsupportedTool = normalizedReason.includes("not supported") && normalizedReason.includes("tool");
  const isTurnTimeout = normalizedReason.includes("aborterror") || normalizedReason.includes("operation was aborted");

  if (isSparkModel && (isUnsupportedTool || isTurnTimeout)) {
    return ROLE_FALLBACK_MODEL;
  }

  return undefined;
}

async function runRole(
  context: RunContext,
  role: Role,
  prompt: string,
): Promise<RunRoleResult> {
  return runRoleWithModel(context, role, prompt, context.model, false);
}

async function runRoleWithModel(
  context: RunContext,
  role: Role,
  prompt: string,
  model: string,
  isFallback: boolean,
): Promise<RunRoleResult> {
  const thread = isFallback ? createRoleThread(context, role, model) : getThread(context, role);
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, context.turnTimeoutMs);

  try {
    const turn = role === "manager"
      ? await thread.run(prompt, { outputSchema: managerSchema, signal: abortController.signal })
      : await thread.run(prompt, { signal: abortController.signal });
    const endedAt = new Date().toISOString();

    await writeSessionLog(context, {
      role: isFallback ? `${role}-fallback` : role,
      model,
      prompt,
      turn,
      startedAt,
      endedAt,
      threadId: thread.id,
    });

    return { ok: true, turn };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const reason = summarizeError(error);
    const fallbackModel = isFallback ? undefined : resolveRoleFallbackModel(model, reason);

    await writeRoleErrorLog(context, {
      role: isFallback ? `${role}-fallback` : role,
      model,
      prompt,
      reason,
      error,
      startedAt,
      endedAt,
      threadId: thread.id,
    });

    if (fallbackModel) {
      await appendProgress(
        context.runDir,
        `\n## Role Fallback\n\n${role} failed on ${model}: ${reason}\nRetrying ${role} with ${fallbackModel}.\n`,
      );
      return runRoleWithModel(context, role, prompt, fallbackModel, true);
    }

    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

async function runObserverRole(
  context: ObserverContext,
  prompt: string,
): Promise<RunRoleResult> {
  const thread = getObserverThread(context);
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort();
  }, context.turnTimeoutMs);

  try {
    const lessonFile = path.join(context.runDir, "lessons.md");
    const previousLessons = await readOptionalFile(lessonFile);
    const turn = await thread.run(prompt, { signal: abortController.signal });
    const endedAt = new Date().toISOString();
    const existingLessons = await readOptionalFile(lessonFile);
    const lessons = selectObserverLessonsContent(existingLessons, turn.finalResponse, previousLessons);
    await writeFile(lessonFile, `${lessons}\n`, "utf8");

    await writeSessionLog(context, {
      role: "observer",
      prompt,
      turn,
      startedAt,
      endedAt,
      threadId: thread.id,
    });

    return { ok: true, turn };
  } catch (error) {
    const endedAt = new Date().toISOString();
    const reason = summarizeError(error);

    await writeRoleErrorLog(context, {
      role: "observer",
      prompt,
      reason,
      error,
      startedAt,
      endedAt,
      threadId: thread.id,
    });

    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

const OBSERVER_LESSONS_REQUIRED_SECTIONS = [
  "Root-cause summary",
  "Recurring failure patterns",
  "Missed discovery/clarification opportunities",
  "Agent-specific improvements",
  "Reusable snippets candidates",
  "Protocol health",
] as const;

export function selectObserverLessonsContent(
  existingLessons: string,
  finalResponse: string,
  previousLessons = "",
): string {
  const existing = existingLessons.trimEnd();
  const previous = previousLessons.trimEnd();
  if (existing !== previous && hasObserverLessonsRequiredSections(existing)) {
    return existing;
  }

  return finalResponse.trimEnd();
}

function hasObserverLessonsRequiredSections(markdown: string): boolean {
  return OBSERVER_LESSONS_REQUIRED_SECTIONS.every((section) => {
    const sectionRegex = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, "im");
    return sectionRegex.test(markdown);
  });
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function getThread(context: RunContext, role: Role): Thread {
  const existing = context.threads.get(role);
  if (existing) return existing;

  const thread = createRoleThread(context, role, context.model);
  context.threads.set(role, thread);
  return thread;
}

function createRoleThread(context: RunContext, role: Role, model: string): Thread {
  const thread = context.codex.startThread({
    model,
    workingDirectory: context.runDir,
    skipGitRepoCheck: true,
    sandboxMode: role === "smoke" ? "read-only" : "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    webSearchMode: context.webSearchMode,
  });
  return thread;
}

function getObserverThread(context: ObserverContext): Thread {
  const existing = context.threads.get("observer");
  if (existing) return existing;

  const thread = context.codex.startThread({
    model: context.model,
    workingDirectory: context.runDir,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: true,
    webSearchMode: context.webSearchMode,
  });
  context.threads.set("observer", thread);
  return thread;
}

async function writeSessionLog(
  context: RunContext | ObserverContext,
  entry: {
    role: string;
    model?: string;
    prompt: string;
    turn: CodexTurn;
    startedAt: string;
    endedAt: string;
    threadId: string | null;
  },
): Promise<void> {
  const safeStartedAt = entry.startedAt.replaceAll(":", "-");
  const file = path.join(
    context.runDir,
    "session-log",
    `${safeStartedAt}-${entry.role}.json`,
  );

  await writeFile(
    file,
    `${JSON.stringify(
      {
        role: entry.role,
        model: entry.model ?? context.model,
        threadId: entry.threadId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        prompt: entry.prompt,
        finalResponse: entry.turn.finalResponse,
        usage: entry.turn.usage,
        items: entry.turn.items,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeRoleErrorLog(
  context: RunContext | ObserverContext,
  entry: {
    role: string;
    model?: string;
    prompt: string;
    reason: string;
    error: unknown;
    startedAt: string;
    endedAt: string;
    threadId: string | null;
  },
): Promise<void> {
  const safeStartedAt = entry.startedAt.replaceAll(":", "-");
  const file = path.join(
    context.runDir,
    "session-log",
    `${safeStartedAt}-${entry.role}-error.json`,
  );

  await writeFile(
    file,
    `${JSON.stringify(
      {
        role: entry.role,
        model: entry.model ?? context.model,
        threadId: entry.threadId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        reason: entry.reason,
        prompt: entry.prompt,
        error:
          entry.error instanceof Error
            ? { name: entry.error.name, message: entry.error.message }
            : String(entry.error),
      },
      null,
      2,
    )}\n`,
  );
}

export function parseManagerDecision(finalResponse: string): ManagerDecision {
  const parsed = parseJsonObject(finalResponse);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Manager returned non-JSON response: ${finalResponse}`);
  }

  const candidate = parsed as Partial<ManagerDecision>;
  if (
    candidate.next_action !== "develop"
    && candidate.next_action !== "test"
    && candidate.next_action !== "done"
    && candidate.next_action !== "ask_user"
  ) {
    throw new Error(`Manager returned invalid next_action: ${finalResponse}`);
  }

  return {
    next_action: candidate.next_action,
    target: typeof candidate.target === "string" ? candidate.target : undefined,
    instructions: typeof candidate.instructions === "string" ? candidate.instructions : undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason : "No reason provided.",
  };
}

function parseDiscoveryDecision(finalResponse: string): DiscoveryDecision {
  const parsed = parseJsonObject(finalResponse);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Discovery returned non-JSON response: ${finalResponse}`);
  }

  const candidate = parsed as Partial<DiscoveryDecision>;
  if (candidate.status !== "complete" && candidate.status !== "needs_input") {
    throw new Error(`Discovery returned invalid status: ${finalResponse}`);
  }
  if (typeof candidate.discovery_md !== "string" || candidate.discovery_md.trim().length === 0) {
    throw new Error(`Discovery returned invalid discovery_md: ${finalResponse}`);
  }
  if (!Array.isArray(candidate.open_questions)) {
    throw new Error(`Discovery returned invalid open_questions: ${finalResponse}`);
  }

  return {
    status: candidate.status,
    discovery_md: candidate.discovery_md,
    open_questions: candidate.open_questions.filter((q) => typeof q === "string"),
  };
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    return JSON.parse(text.slice(first, last + 1));
  }
}

async function createRunDirectory(runsDir: string): Promise<string> {
  const absoluteRunsDir = path.resolve(runsDir);
  await mkdir(absoluteRunsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const runDir = path.join(absoluteRunsDir, stamp);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function initializeRunProtocol(options: RunProtocolInitOptions): Promise<void> {
  const workspaceDir = path.join(options.runDir, "workspace");
  const apiProbesDir = path.join(options.runDir, "api-probes");

  await mkdir(path.join(options.runDir, "session-log"), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(apiProbesDir, { recursive: true });
  await writeFile(path.join(options.runDir, "task.md"), options.task);
  await writeFile(path.join(options.runDir, "progress.md"), initialProgress(options.model, options.startedAt));
  await writeFile(path.join(options.runDir, "blockers.md"), "# Blockers\n\nNone.\n");
  await writeFile(path.join(options.runDir, "discovery.md"), "# Discovery\n\nPending discovery.\n");
}

function resolveModel(model?: string): string {
  const requested = model ?? process.env.CODEX_GTD_MODEL ?? DEFAULT_MODEL;
  return MODEL_ALIASES[requested] ?? requested;
}

function resolveWebSearchMode(mode?: WebSearchMode): WebSearchMode | undefined {
  const requested = mode ?? process.env.CODEX_GTD_WEB_SEARCH;
  if (requested === undefined || requested === "") return undefined;
  if (isWebSearchMode(requested)) return requested;
  throw new Error("CODEX_GTD_WEB_SEARCH must be one of: disabled, cached, live");
}

function isWebSearchMode(value: string): value is WebSearchMode {
  return (WEB_SEARCH_MODES as readonly string[]).includes(value);
}

function initialProgress(model: string, startedAt: string): string {
  return buildProgressDocument({
    schemaVersion: 1,
    status: "initialized",
    model,
    startedAt,
    lastUpdatedAt: startedAt,
    lastRole: "driver",
    loop: 0,
    terminal: false,
  }, `- Status: initialized
- Model: ${model}
- Run URL: ${pathToFileURL(process.cwd()).href}

`);
}

export function buildProgressDocument(state: ProgressState, log = ""): string {
  return `# Progress

${PROGRESS_STATE_START}
${JSON.stringify(state, null, 2)}
${PROGRESS_STATE_END}

## Log

${log}`;
}

export function parseProgressState(document: string): ProgressState | undefined {
  const start = document.indexOf(PROGRESS_STATE_START);
  const end = document.indexOf(PROGRESS_STATE_END);
  if (start === -1 || end === -1 || end <= start) return undefined;

  const jsonStart = start + PROGRESS_STATE_START.length;
  const rawJson = document.slice(jsonStart, end).trim();
  try {
    const parsed = JSON.parse(rawJson) as Partial<ProgressState>;
    if (
      parsed.schemaVersion !== 1
      || !isProgressStatus(parsed.status)
      || typeof parsed.model !== "string"
      || typeof parsed.startedAt !== "string"
      || typeof parsed.lastUpdatedAt !== "string"
      || typeof parsed.lastRole !== "string"
      || typeof parsed.loop !== "number"
      || typeof parsed.terminal !== "boolean"
    ) {
      return undefined;
    }

    const state: ProgressState = {
      schemaVersion: 1,
      status: parsed.status,
      model: parsed.model,
      startedAt: parsed.startedAt,
      lastUpdatedAt: parsed.lastUpdatedAt,
      lastRole: parsed.lastRole,
      loop: parsed.loop,
      terminal: parsed.terminal,
    };
    if (typeof parsed.reason === "string") state.reason = parsed.reason;
    return state;
  } catch {
    return undefined;
  }
}

export function updateProgressDocument(
  document: string,
  patch: ProgressStatePatch,
  logEntry = "",
): string {
  const currentState = parseProgressState(document);
  const fallbackNow = new Date().toISOString();
  const nextState: ProgressState = {
    schemaVersion: 1,
    status: patch.status ?? currentState?.status ?? "running",
    model: patch.model ?? currentState?.model ?? "unknown",
    startedAt: patch.startedAt ?? currentState?.startedAt ?? fallbackNow,
    lastUpdatedAt: patch.lastUpdatedAt ?? currentState?.lastUpdatedAt ?? fallbackNow,
    lastRole: patch.lastRole ?? currentState?.lastRole ?? "driver",
    loop: patch.loop ?? currentState?.loop ?? 0,
    terminal: patch.terminal ?? currentState?.terminal ?? false,
  };
  const reason = patch.reason ?? currentState?.reason;
  if (reason !== undefined) nextState.reason = reason;

  const existingLog = extractProgressLog(document);
  return buildProgressDocument(nextState, `${existingLog}${logEntry}`);
}

function isProgressStatus(value: unknown): value is ProgressStatus {
  return value === "initialized"
    || value === "running"
    || value === "blocked"
    || value === "done"
    || value === "max_loops_reached"
    || value === "failed";
}

function extractProgressLog(document: string): string {
  const marker = "\n## Log\n\n";
  const markerIndex = document.indexOf(marker);
  if (markerIndex >= 0) {
    return document.slice(markerIndex + marker.length);
  }

  return document.replace(/^# Progress\s*/u, "");
}

async function appendProgress(
  runDir: string,
  text: string,
  patch: ProgressStatePatch = { status: "running", lastUpdatedAt: new Date().toISOString() },
): Promise<void> {
  const current = await readFile(path.join(runDir, "progress.md"), "utf8");
  await writeFile(path.join(runDir, "progress.md"), updateProgressDocument(current, patch, text));
}

async function appendBlocker(runDir: string, reason: string): Promise<void> {
  const current = await readFile(path.join(runDir, "blockers.md"), "utf8");
  const next = current.replace(/\nNone\.\n?$/, "\n");
  await writeFile(path.join(runDir, "blockers.md"), `${next}\n- ${reason}\n`);
}

function resolveTurnTimeout(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }

  const envTimeout = process.env.CODEX_GTD_TURN_TIMEOUT_MS;
  if (envTimeout !== undefined) {
    const parsed = Number.parseInt(envTimeout, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return DEFAULT_TURN_TIMEOUT_MS;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveMonitorSdk(flag?: boolean): boolean {
  if (flag !== undefined) return flag;

  const raw = process.env.CODEX_GTD_MONITOR_SDK;
  if (raw === undefined) return DEFAULT_MONITOR_SDK;

  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

type SnippetCandidateOptions = {
  runDir: string;
  snippetsDir: string;
};

export type SnippetCandidateEntry = {
  title: string;
  body: string;
};

export type PromoteSnippetOptions = {
  candidateFile: string;
  snippetsDir: string;
  slug: string;
  title?: string;
};

export type PromoteSnippetResult = {
  status: "created" | "unchanged";
  snippetFile: string;
  indexFile: string;
};

export async function promoteSnippetCandidate(options: PromoteSnippetOptions): Promise<PromoteSnippetResult> {
  validateSnippetSlug(options.slug);

  const snippetsDir = path.resolve(options.snippetsDir);
  const candidateFile = path.resolve(options.candidateFile);
  const snippetFile = path.join(snippetsDir, `${options.slug}.md`);
  const indexFile = path.join(snippetsDir, "INDEX.md");
  const title = options.title?.trim() || titleFromSlug(options.slug);
  const candidateContent = await readFile(candidateFile, "utf8");
  const promotedContent = formatPromotedSnippet({
    title,
    slug: options.slug,
    candidateFile,
    candidateContent,
  });

  await ensureSnippetCatalog(snippetsDir);
  await mkdir(snippetsDir, { recursive: true });

  let status: PromoteSnippetResult["status"] = "created";
  try {
    const existing = await readFile(snippetFile, "utf8");
    if (existing !== promotedContent) {
      throw new Error(`Refusing to overwrite existing snippet: ${snippetFile}`);
    }
    status = "unchanged";
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing to overwrite")) {
      throw error;
    }
    await writeFile(snippetFile, promotedContent, "utf8");
  }

  const index = await readFile(indexFile, "utf8");
  const updatedIndex = addSnippetToIndex(index, {
    title,
    slug: options.slug,
  });
  if (updatedIndex !== index) {
    await writeFile(indexFile, updatedIndex, "utf8");
  }

  return {
    status,
    snippetFile,
    indexFile,
  };
}

async function generateSnippetCandidates(options: SnippetCandidateOptions): Promise<string[]> {
  const runDir = path.resolve(options.runDir);
  const snippetsDir = path.resolve(options.snippetsDir);
  const lessonsPath = path.join(runDir, "lessons.md");
  const candidatesDir = path.join(snippetsDir, "_candidates");
  const generated: string[] = [];

  let lessons = "";
  try {
    lessons = await readFile(lessonsPath, "utf8");
  } catch {
    return generated;
  }

  const sectionText = extractMarkdownSection(lessons, "Reusable snippets candidates");
  if (!sectionText.trim()) {
    return generated;
  }

  const entries = parseSnippetCandidateEntries(sectionText);
  if (entries.length === 0) {
    return generated;
  }

  await mkdir(candidatesDir, { recursive: true });
  const runId = path.basename(runDir);
  const safeRunId = runId.replaceAll("-", "_");
  const candidateFile = path.join(candidatesDir, `${safeRunId}-candidates.md`);

  const body = formatSnippetCandidateDocument({
    runDir,
    entries,
  });

  await writeFile(candidateFile, body, "utf8");
  generated.push(candidateFile);
  return generated;
}

async function safeGenerateSnippetCandidates(options: SnippetCandidateOptions): Promise<string[]> {
  try {
    return await generateSnippetCandidates(options);
  } catch {
    return [];
  }
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const headingRegex = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const startIdx = lines.findIndex((line) => headingRegex.test(line));
  if (startIdx === -1) return "";

  const startPrefix = lines[startIdx].match(/^(#+)\s+/)?.[1].length ?? 1;
  const section: string[] = [];

  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+/);
    if (headingMatch && headingMatch[1].length <= startPrefix) {
      break;
    }
    section.push(line);
  }

  return section.join("\n").trim();
}

export function parseSnippetCandidateEntries(sectionText: string): SnippetCandidateEntry[] {
  const lines = sectionText.split("\n");
  const entries: SnippetCandidateEntry[] = [];
  let currentTitle = "";
  let currentBody: string[] = [];
  const candidateHeading = /^#{3,6}\s+Candidate:\s+(.+?)\s*$/i;

  const flush = () => {
    const body = currentBody.join("\n").trim();
    if (currentTitle && body) {
      entries.push({ title: currentTitle, body });
    }
    currentTitle = "";
    currentBody = [];
  };

  for (const line of lines) {
    const match = line.match(candidateHeading);
    if (match) {
      flush();
      currentTitle = match[1].trim();
      continue;
    }

    if (!currentTitle) {
      continue;
    }

    currentBody.push(line);
  }

  flush();

  return entries;
}

function formatSnippetCandidateDocument(params: { runDir: string; entries: SnippetCandidateEntry[] }): string {
  const lines = [
    "# Snippet candidates (Aegis v0.5)",
    "",
    `Source run: ${params.runDir}`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Candidates extracted from observer lessons",
    "",
  ];

  for (const entry of params.entries) {
    lines.push(`### Candidate: ${entry.title}`);
    lines.push("");
    lines.push(entry.body);
    lines.push("");
  }

  lines.push("## Acceptance before promotion");
  lines.push("");
  lines.push("- Run tests on the extracted snippet in your repo context.");
  lines.push("- Validate assumptions against current tech stack (runtime, dependencies, error contract).");
  lines.push("- Move approved snippets to `snippets/` and add to `snippets/INDEX.md`.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function validateSnippetSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("slug must use lowercase letters, numbers, and hyphens");
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPromotedSnippet(params: {
  title: string;
  slug: string;
  candidateFile: string;
  candidateContent: string;
}): string {
  return `# Snippet: ${params.title}

<!-- snippet-promotion: ${JSON.stringify({
    slug: params.slug,
    title: params.title,
    source: path.basename(params.candidateFile),
    status: "approved",
    createdBy: "promote-snippet",
  })} -->

## Promotion

- Status: approved
- Slug: ${params.slug}
- Source candidate: ${path.basename(params.candidateFile)}
- Promoted by: codex-gtd promote-snippet

## Content

${sanitizePromotedSnippetContent(params.candidateContent).trim()}
`;
}

function sanitizePromotedSnippetContent(content: string): string {
  return content.replace(
    /^(Source run:\s+)\/(?:Users|home|tmp)\/[^\n]*\/([^/\n]+)$/gm,
    "$1(redacted local path)/$2",
  );
}

function addSnippetToIndex(index: string, params: { title: string; slug: string }): string {
  const entry = `- [${params.title}](./${params.slug}.md)`;
  if (index.includes(`](./${params.slug}.md)`)) {
    return index;
  }

  const lines = index.trimEnd().split("\n");
  const headingIndex = lines.findIndex((line) => /^##\s+Available snippets\s*$/i.test(line));
  if (headingIndex === -1) {
    return `${index.trimEnd()}

## Available snippets

${entry}
`;
  }

  let insertIndex = headingIndex + 1;
  while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
    insertIndex += 1;
  }

  lines.splice(insertIndex, 0, entry);
  return `${lines.join("\n")}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
