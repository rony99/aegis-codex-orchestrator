import { Codex, type Thread } from "@openai/codex-sdk";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
const MODEL_ALIASES: Record<string, string> = {
  "codex-5.3-spark": "gpt-5.3-codex-spark",
};

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

type Role = "discovery" | "researcher" | "manager" | "developer" | "tester" | "smoke" | "observer";
type CodexTurn = Awaited<ReturnType<Thread["run"]>>;

export type RunOptions = {
  taskFile: string;
  model?: string;
  runsDir?: string;
  snippetsDir?: string;
  observe?: boolean;
  monitorSdk?: boolean;
  skipDiscovery?: boolean;
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
};

export type ObserveResult = {
  runDir: string;
  status: "done" | "failed";
  reason?: string;
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
  };
  sdkMonitor?: SdkHealthResult;
  observer?: ObserveResult;
  snippetCandidates: string[];
  metrics: {
    sessionLogEntries: number;
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
};

type RunSummaryInput = Omit<RunSummary, "schemaVersion" | "protocol">;

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
  threads: Map<Role, Thread>;
};

type ObserverContext = {
  codex: Codex;
  model: string;
  turnTimeoutMs: number;
  runDir: string;
  snippetsDir: string;
  threads: Map<Role, Thread>;
};

export async function runSmokeTest(
  options: { model?: string; turnTimeoutMs?: number } = {},
): Promise<CodexTurn> {
  const resolvedModel = resolveModel(options.model);
  const turnTimeoutMs = resolveTurnTimeout(options.turnTimeoutMs);
  return runSmokeTestWithSignal(resolvedModel, turnTimeoutMs);
}

async function runSmokeTestWithSignal(model: string, turnTimeoutMs: number): Promise<CodexTurn> {
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
  const task = await readFile(path.resolve(options.taskFile), "utf8");

  await mkdir(path.join(runDir, "session-log"), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(apiProbesDir, { recursive: true });
  await ensureSnippetCatalog(snippetsDir);
  await writeFile(path.join(runDir, "task.md"), task);
  await writeFile(path.join(runDir, "progress.md"), initialProgress(model));
  await writeFile(path.join(runDir, "blockers.md"), "# Blockers\n\nNone.\n");
  await writeFile(path.join(runDir, "discovery.md"), "# Discovery\n\nPending discovery.\n");

  const context: RunContext = {
    codex: new Codex(),
    model,
    turnTimeoutMs: resolveTurnTimeout(options.turnTimeoutMs),
    runDir,
    workspaceDir,
    snippetsDir,
    task,
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
  };
  let sdkMonitor: SdkHealthResult | undefined;

  if (runMonitorSdk) {
    const monitorModel = options.model;
    const health = await runSdkHealthCheck({
      model: monitorModel,
      turnTimeoutMs,
      runDir,
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
    await runSmokeTestWithSignal(model, options.turnTimeoutMs);
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
    metrics: input.metrics,
    protocol: {
      requiredEntries: RUN_PROTOCOL_ENTRIES,
    },
  };
}

async function finishRun(
  context: RunContext,
  result: RunResult,
  meta: RunMeta,
): Promise<RunResult> {
  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
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
    },
    sdkMonitor: result.sdkMonitor,
    observer: result.observer,
    snippetCandidates: result.snippetCandidates ?? [],
    metrics: {
      sessionLogEntries: await countSessionLogEntries(context.runDir),
    },
  });

  await writeFile(path.join(context.runDir, RUN_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return result;
}

async function countSessionLogEntries(runDir: string): Promise<number> {
  try {
    const entries = await readdir(path.join(runDir, "session-log"));
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
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
    threads: new Map<Role, Thread>(),
  };

  const observerResult = await runObserverRole(context, await observerPrompt(runDir, context.snippetsDir));
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

This repository is starting v0.3 with a minimal snippet reuse pool.

## How to use

- Add reusable implementation patterns as markdown files in this directory.
- Keep each snippet under ~200 lines.
- Document dependencies, assumptions, and test evidence for quick reuse.
- In v0.3, the researcher reads this index and selected snippets before implementing.
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

async function runRole(
  context: RunContext,
  role: Role,
  prompt: string,
): Promise<RunRoleResult> {
  const thread = getThread(context, role);
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
      role,
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
    const turn = await thread.run(prompt, { signal: abortController.signal });
    const endedAt = new Date().toISOString();
    const lessonFile = path.join(context.runDir, "lessons.md");
    await writeFile(lessonFile, `${turn.finalResponse}\n`, "utf8");

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

function getThread(context: RunContext, role: Role): Thread {
  const existing = context.threads.get(role);
  if (existing) return existing;

  const thread = context.codex.startThread({
    model: context.model,
    workingDirectory: context.runDir,
    skipGitRepoCheck: true,
    sandboxMode: role === "smoke" ? "read-only" : "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
  });
  context.threads.set(role, thread);
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
  });
  context.threads.set("observer", thread);
  return thread;
}

async function writeSessionLog(
  context: RunContext | ObserverContext,
  entry: {
      role: Role;
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
        model: context.model,
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
    role: Role;
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
        model: context.model,
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

function parseManagerDecision(finalResponse: string): ManagerDecision {
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

function resolveModel(model?: string): string {
  const requested = model ?? process.env.CODEX_GTD_MODEL ?? DEFAULT_MODEL;
  return MODEL_ALIASES[requested] ?? requested;
}

function initialProgress(model: string): string {
  return `# Progress

- Status: initialized
- Model: ${model}
- Run URL: ${pathToFileURL(process.cwd()).href}

`;
}

async function appendProgress(runDir: string, text: string): Promise<void> {
  const current = await readFile(path.join(runDir, "progress.md"), "utf8");
  await writeFile(path.join(runDir, "progress.md"), current + text);
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

  const entries = parseBulletEntries(sectionText);
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

function parseBulletEntries(sectionText: string): string[] {
  const lines = sectionText.split("\n");
  const entries: string[] = [];
  let current: string[] = [];
  const bulletStart = /^(?:-|\d+\.)\s+/;

  for (const line of lines) {
    if (bulletStart.test(line)) {
      if (current.length > 0) {
        entries.push(current.join("\n").trim());
      }
      current = [line.replace(/^\s*(?:-|\d+\.)\s+/, "").trim()];
      continue;
    }

    if (line.trim() === "") {
      continue;
    }

    if (current.length > 0) {
      current.push(line.trim());
    }
  }

  if (current.length > 0) {
    entries.push(current.join("\n").trim());
  }

  return entries.filter((entry) => entry.length > 0);
}

function formatSnippetCandidateDocument(params: { runDir: string; entries: string[] }): string {
  const lines = [
    "# Snippet candidates (Aegis v0.5)",
    "",
    `Source run: ${params.runDir}`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Candidates extracted from observer lessons",
    "",
  ];

  for (const [index, entry] of params.entries.entries()) {
    lines.push(`### ${index + 1}`);
    lines.push("");
    lines.push(entry);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
