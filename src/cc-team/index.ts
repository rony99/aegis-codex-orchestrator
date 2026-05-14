import { query, type Options as ClaudeCodeOptions, type OutputFormat, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCcSpecRolePrompt, buildCcSpecSystemPrompt, CC_SPEC_ROLES, type CcSpecMode, type CcSpecRole } from "./spec-prompts.js";
import { formatTeamSkillGuidance, TEAM_SKILL_GUIDANCE_VERSION, TEAM_SKILL_IDS, teamSkillsForRole } from "./team-skills.js";

export type { CcSpecMode, CcSpecRole } from "./spec-prompts.js";
export { TEAM_SKILL_GUIDANCE_VERSION, TEAM_SKILL_IDS } from "./team-skills.js";

const DEFAULT_CC_MODEL = "MiniMax-M2.7";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_MAX_LOOPS = 2;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const MANAGER_MAX_TURNS = 14;
const DEVELOPER_MAX_TURNS = 80;
const TESTER_MAX_TURNS = 20;
const ASK_USER_TOOL = "AskUserQuestion";
const SKILL_GUIDANCE_VERSION = "skill-guided-v1";

/** Up to three developer passes: foundation → feature work → integration & verification prep. */
export type CcWorkStreamId = "foundation" | "feature" | "integration";

export type CcWorkStream = {
  id: CcWorkStreamId;
  title: string;
  focus: string;
  out_of_scope: string;
  behavior: string;
  public_interface: string;
  test_target: string;
  verification_command: string;
};

export type CcManagerPlan = {
  streams: CcWorkStream[];
  notes?: string;
};

export type CcTeamWorkerRole = "manager" | "developer" | "tester";
export type TeamStage = "spec" | "plan" | "build" | "test" | "review" | "ship";
export type TeamMode = "supervised" | "multi-role";
export type WorkerRole = "leader" | "supervisor" | "planner" | "developer" | "tester" | "reviewer" | "shipper";
export type TeamTaskStatus = "pending" | "running" | "done" | "blocked" | "failed";
export type BlockerKind = "user_decision" | "credentials" | "task_doc_defect" | "execution_defect" | "skill_context_defect" | "verification_failed";
export type CcRole = CcTeamWorkerRole | CcSpecRole | WorkerRole;
type CcWorkflow = "cc-run" | "cc-spec" | "cc-team-run";
type CcTeamStatus = "done" | "ask_user" | "max_loops_reached" | "failed";

export type CcTesterDecision = {
  status: "done" | "develop" | "ask_user";
  reason: string;
};

export type CcSpecReviewerDecision = {
  status: "done" | "ask_user";
  reason: string;
};

export type CcRoleRunRequest = {
  role: CcRole;
  workflow?: CcWorkflow;
  teamMode?: TeamMode;
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  maxTurns: number;
  tools: string[];
  allowedTools: string[];
  outputFormat?: OutputFormat;
  permissionMode: "acceptEdits" | "dontAsk";
  abortController: AbortController;
  interactionRequests: CcInteractionRequest[];
  resumeSessionId?: string;
};

export type CcRoleRunner = (request: CcRoleRunRequest) => AsyncIterable<SDKMessage | unknown>;

export type CcTeamRunOptions = {
  taskFile?: string;
  specDir?: string;
  targetDir?: string;
  runDir?: string;
  runsDir?: string;
  model?: string;
  maxLoops?: number;
  turnTimeoutMs?: number;
  runner?: CcRoleRunner;
};

export type CcTeamLifecycleRunOptions = {
  taskFile?: string;
  replyFile?: string;
  targetDir?: string;
  runDir?: string;
  runsDir?: string;
  model?: string;
  turnTimeoutMs?: number;
  maxLoops?: number;
  teamMode?: TeamMode;
  runner?: CcRoleRunner;
};

export type CcSpecRunOptions = {
  taskFile?: string;
  replyFile?: string;
  runDir?: string;
  runsDir?: string;
  model?: string;
  mode?: CcSpecMode;
  targetDir?: string;
  turnTimeoutMs?: number;
  runner?: CcRoleRunner;
};

export type CcTeamRunResult = {
  runDir: string;
  targetDir?: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  durationMs: number;
};

export type CcSpecRunResult = CcTeamRunResult & {
  mode: CcSpecMode;
};

export type CcTeamLifecycleRunResult = CcTeamRunResult & {
  workflow: "cc-team-run";
  stage: TeamStage;
  recommendedAction: string;
  teamMode: TeamMode;
};

export type TeamTask = {
  id: string;
  stage: TeamStage;
  role: WorkerRole;
  title: string;
  status: TeamTaskStatus;
  objective: string;
  context: string;
  inputFiles: string[];
  allowedPaths: string[];
  acceptanceCriteria: string[];
  verificationCommand: string;
  failureCategories: BlockerKind[];
};

export type WorkerRegistryEntry = {
  id: string;
  role: WorkerRole;
  cwd: string;
  sessionId: string;
  status: "healthy" | "failed" | "retired";
  skills: string[];
  lastTaskId?: string;
  updatedAt: string;
};

export type WorkerRegistry = {
  workers: WorkerRegistryEntry[];
};

export type TeamBlocker = {
  kind: BlockerKind;
  question: string;
  stage?: TeamStage;
  taskId?: string;
};

export type TeamState = {
  schemaVersion: 1;
  workflow: "cc-team-run";
  status: CcTeamStatus | "running";
  currentStage: TeamStage;
  recommendedAction: string;
  teamMode: TeamMode;
  skillGuidanceVersion: typeof TEAM_SKILL_GUIDANCE_VERSION;
  appliedSkills: readonly string[];
  tasks: TeamTask[];
  blockers: TeamBlocker[];
  assumptions: string[];
  latestVerification?: {
    command: string;
    status: "passed" | "failed" | "missing";
    detail: string;
  };
};

type CcRoleTurnResult = {
  role: CcRole;
  sessionId: string | null;
  finalResponse: string;
  events: unknown[];
  interactionRequests: CcInteractionRequest[];
};

export type CcInteractionRequest = {
  role: CcRole;
  type: "ask_user" | "permission";
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  recordedAt: string;
};

type CcRoleDiagnostic = {
  role: CcRole;
  model: string;
  sessionId: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  lastUpdatedAt: string;
  classification: string;
  detail: string;
  lastEventType?: string;
};

type CcTeamRunSummary = {
  schemaVersion: 1;
  provider: "claude-code";
  workflow: "cc-run";
  runDir: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  taskFile?: string;
  specDir?: string;
  targetDir?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  maxLoops: number;
  turnTimeoutMs: number;
  metrics: {
    sessionLogEntries: number;
    roleTurns: Record<CcTeamWorkerRole, number>;
  };
  lastManagerPlan?: CcManagerPlan;
};

type CcSpecRunSummary = {
  schemaVersion: 1;
  provider: "claude-code";
  workflow: "cc-spec";
  workflowGuidance: typeof SKILL_GUIDANCE_VERSION;
  runDir: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  mode: CcSpecMode;
  taskFile?: string;
  targetDir?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnTimeoutMs: number;
  metrics: {
    sessionLogEntries: number;
    roleTurns: Record<CcSpecRole, number>;
  };
};

type CcTeamLifecycleRunSummary = {
  schemaVersion: 1;
  provider: "claude-code";
  workflow: "cc-team-run";
  runDir: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  taskFile?: string;
  targetDir?: string;
  currentStage: TeamStage;
  recommendedAction: string;
  teamMode: TeamMode;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  turnTimeoutMs: number;
  skillGuidanceVersion: typeof TEAM_SKILL_GUIDANCE_VERSION;
  appliedSkills: readonly string[];
  metrics: {
    sessionLogEntries: number;
    roleTurns: Record<WorkerRole, number>;
  };
  latestVerification?: TeamState["latestVerification"];
};

const CC_TESTER_DECISION_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "develop", "ask_user"] },
      reason: { type: "string" },
    },
    required: ["status", "reason"],
    additionalProperties: false,
  },
};

const CC_MANAGER_PLAN_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      streams: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ["foundation", "feature", "integration"] },
            title: { type: "string" },
            focus: { type: "string" },
            out_of_scope: { type: "string" },
            behavior: { type: "string" },
            public_interface: { type: "string" },
            test_target: { type: "string" },
            verification_command: { type: "string" },
          },
          required: ["id", "title", "focus", "out_of_scope", "behavior", "public_interface", "test_target", "verification_command"],
          additionalProperties: false,
        },
      },
      notes: { type: "string" },
    },
    required: ["streams"],
    additionalProperties: false,
  },
};

const TEAM_LEADER_DECISION_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["continue", "ask_user", "done"] },
      stage: { type: "string", enum: ["spec", "plan", "build", "test", "review", "ship"] },
      reason: { type: "string" },
      recommendedAction: { type: "string" },
      assumptions: { type: "array", items: { type: "string" } },
      blocker: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["user_decision", "credentials", "task_doc_defect", "execution_defect", "skill_context_defect", "verification_failed"] },
          question: { type: "string" },
        },
        required: ["kind", "question"],
        additionalProperties: false,
      },
      task: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          context: { type: "string" },
          inputFiles: { type: "array", items: { type: "string" } },
          allowedPaths: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          verificationCommand: { type: "string" },
          failureCategories: { type: "array", items: { type: "string", enum: ["user_decision", "credentials", "task_doc_defect", "execution_defect", "skill_context_defect", "verification_failed"] } },
        },
        required: ["id", "title", "objective", "context", "inputFiles", "allowedPaths", "acceptanceCriteria", "verificationCommand", "failureCategories"],
        additionalProperties: false,
      },
    },
    required: ["status", "stage", "reason", "recommendedAction"],
    additionalProperties: false,
  },
};

// Matches task IDs in checkbox lists (- [ ] T1), table cells (| T1 |), markdown headers (## T1), or bold labels (**ID:** T1).
const TASK_ID_PATTERN = /- \[[ x]\]\s*T\d+(?:\.\d+)?|\|\s*T\d+(?:\.\d+)?\s*\||\|\s*[^|\n]+\s*\|\s*T\d+(?:\.\d+)?\s*\||##\s+T\d+(?:\.\d+)?\b|\*\*ID:\*\*\s*T\d+(?:\.\d+)?/i;

const CC_SPEC_REVIEWER_DECISION_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "ask_user"] },
      reason: { type: "string" },
    },
    required: ["status", "reason"],
    additionalProperties: false,
  },
};

export async function runCcTeam(options: CcTeamRunOptions): Promise<CcTeamRunResult> {
  if (!options.taskFile && !options.specDir) {
    throw new Error("cc-run requires taskFile or specDir");
  }
  const taskFile = options.taskFile ? path.resolve(options.taskFile) : undefined;
  const task = taskFile
    ? await readFile(taskFile, "utf8")
    : await buildTaskFromSpec(path.resolve(options.specDir!));
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CC_MODEL;
  const maxLoops = options.maxLoops ?? DEFAULT_MAX_LOOPS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const runDir = path.resolve(options.runDir ?? createCcRunDirectoryName(options.runsDir ?? DEFAULT_RUNS_DIR));
  const targetDir = options.targetDir ? path.resolve(options.targetDir) : undefined;
  const executionDir = targetDir ?? runDir;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const roleTurns: Record<CcTeamWorkerRole, number> = { manager: 0, developer: 0, tester: 0 };
  const runner = options.runner ?? defaultCcRoleRunner;

  await initializeCcRunProtocol({ runDir, task, model, startedAt, specDir: options.specDir ? path.resolve(options.specDir) : undefined, targetDir });

  let finalStatus: CcTeamStatus = "max_loops_reached";
  let finalReason = `cc team did not finish within ${maxLoops} loop(s).`;
  let sessionLogEntries = 0;
  let lastManagerPlan: CcManagerPlan | undefined;
  let testerRepairHint = "";

  try {
    for (let loop = 1; loop <= maxLoops; loop += 1) {
      await appendCcProgress(runDir, `\n## Loop ${loop}\n\nManager started.\n`);
      roleTurns.manager += 1;
      const managerTurn = await runCcRole({
        role: "manager",
        model,
        runDir,
        cwd: executionDir,
        prompt: buildCcManagerPrompt({ task, loop, targetDir, testerRepairHint }),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;
      const managerInteraction = firstAskUserInteraction(managerTurn.interactionRequests);
      if (managerInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(managerInteraction);
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, managerInteraction);
        break;
      }

      let plan: CcManagerPlan;
      try {
        plan = parseCcManagerPlan(managerTurn.finalResponse);
      } catch (error) {
        const detail = summarizeError(error);
        await appendCcBlocker(runDir, `manager plan invalid: ${detail}`);
        plan = fallbackCcManagerPlan();
      }
      lastManagerPlan = plan;
      await writeFile(path.join(runDir, "manager-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

      for (const stream of plan.streams) {
        await appendCcProgress(runDir, `\nDeveloper started (${stream.id}: ${stream.title}).\n`);
        roleTurns.developer += 1;
        const developerTurn = await runCcRole({
          role: "developer",
          model,
          runDir,
          cwd: executionDir,
          prompt: buildCcDeveloperStreamPrompt({ task, loop, stream, plan, targetDir, testerRepairHint }),
          runner,
          turnTimeoutMs,
        });
        sessionLogEntries += 1;
        const developerInteraction = firstAskUserInteraction(developerTurn.interactionRequests);
        if (developerInteraction) {
          finalStatus = "ask_user";
          finalReason = summarizeCcInteraction(developerInteraction);
          await appendCcBlocker(runDir, finalReason);
          await writeCcInteractionRequest(runDir, developerInteraction);
          break;
        }
      }

      if (finalStatus === "ask_user") break;

      await appendCcProgress(runDir, `\nTester started.\n`);
      roleTurns.tester += 1;
      const testerTurn = await runCcRole({
        role: "tester",
        model,
        runDir,
        cwd: executionDir,
        prompt: buildCcTesterPrompt(task, loop, targetDir, lastManagerPlan),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;
      const testerInteraction = firstAskUserInteraction(testerTurn.interactionRequests);
      if (testerInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(testerInteraction);
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, testerInteraction);
        break;
      }

      const decision = parseCcTesterDecision(testerTurn.finalResponse);
      applyCcTesterVerificationGate(decision, testerTurn.events);
      await writeFile(path.join(runDir, "tester-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");

      if (decision.status === "done") {
        finalStatus = "done";
        finalReason = decision.reason;
        break;
      }

      if (decision.status === "ask_user") {
        finalStatus = "ask_user";
        finalReason = decision.reason;
        await appendCcBlocker(runDir, decision.reason);
        break;
      }

      testerRepairHint = decision.reason;
      await appendCcProgress(runDir, `\nTester requested another development pass: ${decision.reason}\n`);
    }
  } catch (error) {
    finalStatus = "failed";
    finalReason = summarizeError(error);
    await appendCcBlocker(runDir, finalReason);
  }

  await appendCcProgress(runDir, `\n## Finished\n\nStatus: ${finalStatus}\nReason: ${finalReason}\n`);
  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const summary: CcTeamRunSummary = {
    schemaVersion: 1,
    provider: "claude-code",
    workflow: "cc-run",
    runDir,
    status: finalStatus,
    reason: finalReason,
    model,
    taskFile,
    specDir: options.specDir ? path.resolve(options.specDir) : undefined,
    targetDir,
    startedAt,
    endedAt,
    durationMs,
    maxLoops,
    turnTimeoutMs,
    metrics: {
      sessionLogEntries,
      roleTurns,
    },
    lastManagerPlan,
  };
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { runDir, targetDir, status: finalStatus, reason: finalReason, model, durationMs };
}

export async function runCcSpec(options: CcSpecRunOptions): Promise<CcSpecRunResult> {
  if (!options.taskFile && !options.runDir) {
    throw new Error("cc-spec requires taskFile unless runDir is provided");
  }
  if (options.replyFile && !options.runDir) {
    throw new Error("cc-spec reply mode requires runDir");
  }

  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CC_MODEL;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const runDir = path.resolve(options.runDir ?? createCcRunDirectoryName(options.runsDir ?? DEFAULT_RUNS_DIR, "cc-spec"));
  const taskFile = options.taskFile ? path.resolve(options.taskFile) : undefined;
  const task = taskFile ? await readFile(taskFile, "utf8") : await readFile(path.join(runDir, "task.md"), "utf8");
  const targetDir = options.targetDir ? path.resolve(options.targetDir) : undefined;
  const existingContext = taskFile ? "" : await readTextIfExists(path.join(runDir, "context.md"));
  const mode = targetDir ? "change" : options.mode ?? readCcSpecModeFromContext(existingContext) ?? "new";
  const targetSummary = targetDir ? await summarizeTargetRepository(targetDir) : existingContext;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const roleTurns = createEmptySpecRoleTurns();
  const runner = options.runner ?? defaultCcRoleRunner;

  if (taskFile) {
    await initializeCcSpecRunProtocol({ runDir, task, model, mode, targetSummary, startedAt });
  } else {
    await ensureCcSpecRunProtocol({ runDir, model, mode, targetSummary, startedAt });
  }

  if (options.replyFile) {
    const reply = await readFile(path.resolve(options.replyFile), "utf8");
    await appendUserReply(runDir, reply);
    await appendReplyToContext(runDir, reply);
    await writeFile(path.join(runDir, "questions.md"), "", "utf8");
    await appendCcProgress(runDir, "\nReply appended. Resuming spec workflow.\n");
  }

  const userReplies = await readTextIfExists(path.join(runDir, "user-replies.md"));
  const rolesToRun = taskFile
    ? [...CC_SPEC_ROLES]
    : options.replyFile
      ? await rolesAfterLastInteraction(runDir)
      : await rolesForCcSpecContinuation(runDir);
  let [productBrief, decisionLog] = await Promise.all([
    readTextIfExists(path.join(runDir, "product-brief.md")),
    readTextIfExists(path.join(runDir, "decision-log.md")),
  ]);
  let finalStatus: CcTeamStatus = "failed";
  let finalReason = "cc-spec did not complete.";
  let sessionLogEntries = 0;

  try {
    for (const role of rolesToRun) {
      await appendCcProgress(runDir, `\n${role} started.\n`);
      roleTurns[role] += 1;
      const turn = await runCcRole({
        role,
        model,
        runDir,
        prompt: buildCcSpecRolePrompt({ role, task, mode, targetSummary, userReplies, productBrief, decisionLog, runDir }),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;

      const interaction = firstAskUserInteraction(turn.interactionRequests);
      if (interaction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(interaction);
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, interaction);
        await writeCcQuestions(runDir, interaction);
        break;
      }

      if (role === "demo") {
        const demoReady = await isDemoArtifactReady(runDir);
        if (!demoReady) {
          finalStatus = "ask_user";
          finalReason = "demo role did not produce demo.html — check the run directory and reply to continue";
          await appendCcBlocker(runDir, finalReason);
          const syntheticInteraction: CcInteractionRequest = {
            role: "demo",
            type: "ask_user",
            toolName: ASK_USER_TOOL,
            input: { questions: [{ question: "The demo role did not write demo.html. Please check the run directory and reply when ready to continue." }] },
            recordedAt: new Date().toISOString(),
          };
          await writeCcInteractionRequest(runDir, syntheticInteraction);
          await writeCcQuestions(runDir, syntheticInteraction);
          break;
        }
        // demo.html exists; AskUserQuestion was intercepted above if the agent called it.
        // If neither happened, the agent wrote demo.html without asking — proceed silently.
        continue;
      }

      await persistCcSpecRoleArtifacts(runDir, role, turn.finalResponse);
      if (role === "product") {
        [productBrief, decisionLog] = await Promise.all([
          readTextIfExists(path.join(runDir, "product-brief.md")),
          readTextIfExists(path.join(runDir, "decision-log.md")),
        ]);
      }

      if (role === "reviewer") {
        const decision = parseCcSpecReviewerDecision(turn.finalResponse);
        await writeFile(path.join(runDir, "reviewer-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
        finalStatus = decision.status;
        finalReason = decision.reason;
        if (decision.status === "ask_user") {
          await appendCcBlocker(runDir, decision.reason);
        } else {
          const qualityIssues = await validateCcSpecQualityGate(runDir);
          if (qualityIssues.length > 0) {
            finalStatus = "failed";
            finalReason = `cc-spec quality gate failed: ${qualityIssues.join("; ")}`;
            await appendCcBlocker(runDir, finalReason);
          }
        }
      }
    }
  } catch (error) {
    finalStatus = "failed";
    finalReason = summarizeError(error);
    await appendCcBlocker(runDir, finalReason);
  }

  await appendCcProgress(runDir, `\n## Finished\n\nStatus: ${finalStatus}\nReason: ${finalReason}\n`);
  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const summary: CcSpecRunSummary = {
    schemaVersion: 1,
    provider: "claude-code",
    workflow: "cc-spec",
    workflowGuidance: SKILL_GUIDANCE_VERSION,
    runDir,
    status: finalStatus,
    reason: finalReason,
    model,
    mode,
    taskFile,
    targetDir,
    startedAt,
    endedAt,
    durationMs,
    turnTimeoutMs,
    metrics: {
      sessionLogEntries,
      roleTurns,
    },
  };
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { runDir, status: finalStatus, reason: finalReason, model, durationMs, mode };
}

const TEAM_STAGES: readonly TeamStage[] = ["spec", "plan", "build", "test", "review", "ship"];

export async function runCcTeamLifecycle(options: CcTeamLifecycleRunOptions): Promise<CcTeamLifecycleRunResult> {
  if (!options.taskFile && !options.runDir) {
    throw new Error("cc-team-run requires taskFile or runDir");
  }
  if (options.replyFile && !options.runDir) {
    throw new Error("cc-team-run reply mode requires runDir");
  }

  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CC_MODEL;
  const teamMode = options.teamMode ?? "supervised";
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const taskFile = options.taskFile ? path.resolve(options.taskFile) : undefined;
  const runDir = path.resolve(options.runDir ?? createCcRunDirectoryName(options.runsDir ?? DEFAULT_RUNS_DIR, "cc-team"));
  const targetDir = options.targetDir ? path.resolve(options.targetDir) : undefined;
  const executionDir = targetDir ?? runDir;
  const task = taskFile ? await readFile(taskFile, "utf8") : await readFile(path.join(runDir, "task.md"), "utf8");
  const runner = options.runner ?? defaultCcRoleRunner;
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const roleTurns = createEmptyLifecycleRoleTurns();
  let sessionLogEntries = 0;
  let finalStatus: CcTeamStatus = "failed";
  let finalReason = "cc-team-run did not complete.";
  let currentStage: TeamStage = "spec";
  let recommendedAction = "inspect";

  await initializeCcTeamLifecycleProtocol({ runDir, task, model, startedAt, targetDir, teamMode });
  if (options.replyFile) {
    const reply = await readFile(path.resolve(options.replyFile), "utf8");
    await appendUserReply(runDir, reply);
    await appendCcProgress(runDir, "\nReply appended. Resuming team lifecycle.\n");
  }

  let state = await readTeamState(runDir);
  let registry = await readWorkerRegistry(runDir);
  const startStageIndex = state.status === "done" ? TEAM_STAGES.length : Math.max(0, TEAM_STAGES.indexOf(state.currentStage));

  if (teamMode === "supervised") {
    return runCcTeamLifecycleSupervised({
      task,
      taskFile,
      runDir,
      targetDir,
      executionDir,
      model,
      startedAt,
      startedAtMs,
      turnTimeoutMs,
      runner,
      state,
      startStageIndex,
    });
  }

  try {
    if (state.status === "done") {
      finalStatus = "done";
      finalReason = "cc-team-run already completed.";
      currentStage = state.currentStage;
      recommendedAction = state.recommendedAction || "inspect";
    }

    for (const stage of TEAM_STAGES.slice(startStageIndex)) {
      currentStage = stage;
      state.currentStage = stage;
      state.status = "running";
      state.recommendedAction = "continue";
      await writeTeamState(runDir, state);

      await appendCcProgress(runDir, `\n## Stage: ${stage}\n\nLeader started.\n`);
      roleTurns.leader += 1;
      const leaderTurn = await runCcRole({
        role: "leader",
        workflow: "cc-team-run",
        teamMode,
        model,
        runDir,
        cwd: executionDir,
        prompt: buildTeamLeaderPrompt({ stage, task, runDir, targetDir, state }),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;
      const leaderInteraction = firstAskUserInteraction(leaderTurn.interactionRequests);
      if (leaderInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(leaderInteraction);
        recommendedAction = "answer_user";
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, leaderInteraction);
        break;
      }

      const decision = parseTeamLeaderDecision(leaderTurn.finalResponse, stage);
      recommendedAction = decision.recommendedAction;
      state.assumptions.push(...decision.assumptions);

      if (decision.status === "ask_user") {
        const blocker = decision.blocker ?? { kind: "user_decision" as BlockerKind, question: decision.reason };
        finalStatus = "ask_user";
        finalReason = decision.reason;
        recommendedAction = decision.recommendedAction || "answer_user";
        state.blockers.push({ ...blocker, stage });
        await appendCcBlocker(runDir, `${blocker.kind}: ${blocker.question}`);
        await writeTeamInteractionRequest(runDir, stage, blocker);
        break;
      }

      if (decision.status === "done") {
        finalStatus = "done";
        finalReason = decision.reason;
        break;
      }

      const taskDocument = decision.task;
      if (!taskDocument) {
        finalStatus = "failed";
        finalReason = `leader did not provide a task document for ${stage}`;
        state.blockers.push({ kind: "task_doc_defect", question: finalReason, stage });
        await appendCcBlocker(runDir, finalReason);
        break;
      }

      const teamTask = normalizeTeamTask(stage, taskDocument);
      state.tasks.push(teamTask);
      await writeTeamTaskDocument(runDir, teamTask);
      await writeTeamState(runDir, state);

      const worker = workerRoleForStage(stage);
      const reusable = selectReusableWorker(registry, { role: worker, cwd: executionDir });
      await appendCcProgress(runDir, `\n${worker} started for ${teamTask.id}${reusable ? ` (resuming ${reusable.sessionId})` : ""}.\n`);
      roleTurns[worker] += 1;
      teamTask.status = "running";
      await writeTeamState(runDir, state);
      const workerTurn = await runCcRole({
        role: worker,
        workflow: "cc-team-run",
        teamMode,
        model,
        runDir,
        cwd: executionDir,
        prompt: buildTeamWorkerPrompt({ stage, role: worker, task: teamTask, runDir, targetDir }),
        runner,
        turnTimeoutMs,
        resumeSessionId: reusable?.sessionId,
      });
      sessionLogEntries += 1;

      const workerInteraction = firstAskUserInteraction(workerTurn.interactionRequests);
      if (workerInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(workerInteraction);
        recommendedAction = "answer_user";
        teamTask.status = "blocked";
        state.blockers.push({ kind: "user_decision", question: finalReason, stage, taskId: teamTask.id });
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, workerInteraction);
        break;
      }

      await persistTeamStageArtifact(runDir, stage, workerTurn.finalResponse);
      await upsertWorkerRegistryEntry(runDir, registry, {
        role: worker,
        cwd: executionDir,
        sessionId: workerTurn.sessionId,
        taskId: teamTask.id,
        status: "healthy",
      });
      registry = await readWorkerRegistry(runDir);

      if (stage === "test") {
        const decision = parseCcTesterDecision(workerTurn.finalResponse);
        applyCcTesterVerificationGate(decision, workerTurn.events);
        await writeFile(path.join(runDir, "tester-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
        state.latestVerification = latestVerificationFromTesterDecision(teamTask, decision);
        if (decision.status !== "done") {
          finalStatus = decision.status === "ask_user" ? "ask_user" : "failed";
          finalReason = decision.reason;
          recommendedAction = decision.status === "ask_user" ? "answer_user" : "rerun";
          teamTask.status = decision.status === "ask_user" ? "blocked" : "failed";
          state.blockers.push({ kind: "verification_failed", question: decision.reason, stage, taskId: teamTask.id });
          await appendCcBlocker(runDir, decision.reason);
          break;
        }
      }

      if (stage === "review" && /(^|\n)\s*(Critical|REQUEST CHANGES|NO-GO)\b/i.test(workerTurn.finalResponse)) {
        finalStatus = "failed";
        finalReason = "review found blocking issues; rerun build/test after addressing review.md";
        recommendedAction = "rerun";
        teamTask.status = "failed";
        state.blockers.push({ kind: "verification_failed", question: finalReason, stage, taskId: teamTask.id });
        await appendCcBlocker(runDir, finalReason);
        break;
      }

      teamTask.status = "done";
      state.recommendedAction = "continue";
      await writeTeamState(runDir, state);
      finalStatus = "done";
      finalReason = `${stage} completed.`;
    }
  } catch (error) {
    finalStatus = "failed";
    finalReason = summarizeError(error);
    recommendedAction = "inspect";
    await appendCcBlocker(runDir, finalReason);
  }

  if (finalStatus === "done" && currentStage === "ship") {
    finalReason = "cc-team-run completed local delivery lifecycle.";
    recommendedAction = "inspect";
  }

  state = await readTeamState(runDir);
  state.status = finalStatus;
  state.currentStage = currentStage;
  state.recommendedAction = recommendedAction;
  await writeTeamState(runDir, state);
  await appendCcProgress(runDir, `\n## Finished\n\nStatus: ${finalStatus}\nReason: ${finalReason}\n`);

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const summary: CcTeamLifecycleRunSummary = {
    schemaVersion: 1,
    provider: "claude-code",
    workflow: "cc-team-run",
    runDir,
    status: finalStatus,
    reason: finalReason,
    model,
    taskFile,
    targetDir,
    currentStage,
    recommendedAction,
    teamMode,
    startedAt,
    endedAt,
    durationMs,
    turnTimeoutMs,
    skillGuidanceVersion: TEAM_SKILL_GUIDANCE_VERSION,
    appliedSkills: TEAM_SKILL_IDS,
    metrics: {
      sessionLogEntries,
      roleTurns,
    },
    latestVerification: state.latestVerification,
  };
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { runDir, targetDir, status: finalStatus, reason: finalReason, model, durationMs, workflow: "cc-team-run", stage: currentStage, recommendedAction, teamMode };
}

async function runCcTeamLifecycleSupervised(input: {
  task: string;
  taskFile?: string;
  runDir: string;
  targetDir?: string;
  executionDir: string;
  model: string;
  startedAt: string;
  startedAtMs: number;
  turnTimeoutMs: number;
  runner: CcRoleRunner;
  state: TeamState;
  startStageIndex: number;
}): Promise<CcTeamLifecycleRunResult> {
  const teamMode: TeamMode = "supervised";
  const roleTurns = createEmptyLifecycleRoleTurns();
  let sessionLogEntries = 0;
  let state = input.state;
  let finalStatus: CcTeamStatus = "failed";
  let finalReason = "cc-team-run supervised mode did not complete.";
  let currentStage: TeamStage = state.currentStage;
  let recommendedAction = "inspect";

  await writeTeamCockpit(input.runDir, {
    task: input.task,
    state,
    stage: currentStage,
    leaderReport: "Supervised lifecycle initialized.",
    supervisorReport: "Supervisor pending first inspection.",
    targetDir: input.targetDir,
  });

  try {
    if (state.status === "done") {
      finalStatus = "done";
      finalReason = "cc-team-run already completed.";
      recommendedAction = state.recommendedAction || "inspect";
    }

    for (const stage of TEAM_STAGES.slice(input.startStageIndex)) {
      currentStage = stage;
      state.currentStage = stage;
      state.status = "running";
      state.teamMode = teamMode;
      state.recommendedAction = "continue";
      await writeTeamState(input.runDir, state);
      await appendCcProgress(input.runDir, `\n## Stage: ${stage}\n\nLeader started in supervised mode.\n`);

      const guidance = await readTextIfExists(path.join(input.runDir, "leader-guidance.md"));
      roleTurns.leader += 1;
      const leaderTurn = await runCcRole({
        role: "leader",
        workflow: "cc-team-run",
        teamMode,
        model: input.model,
        runDir: input.runDir,
        cwd: input.executionDir,
        prompt: buildSupervisedLeaderPrompt({ stage, task: input.task, runDir: input.runDir, targetDir: input.targetDir, state, guidance }),
        runner: input.runner,
        turnTimeoutMs: input.turnTimeoutMs,
      });
      sessionLogEntries += 1;

      const leaderInteraction = firstAskUserInteraction(leaderTurn.interactionRequests);
      if (leaderInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(leaderInteraction);
        recommendedAction = "answer_user";
        await appendCcBlocker(input.runDir, finalReason);
        await writeCcInteractionRequest(input.runDir, leaderInteraction);
        break;
      }

      await persistTeamStageArtifact(input.runDir, stage, leaderTurn.finalResponse);
      upsertSupervisedStageTask(state, stage, "done", leaderTurn.finalResponse);
      await writeTeamState(input.runDir, state);
      await writeTeamCockpit(input.runDir, {
        task: input.task,
        state,
        stage,
        leaderReport: leaderTurn.finalResponse,
        supervisorReport: "Supervisor inspection pending.",
        targetDir: input.targetDir,
        guidance,
      });

      roleTurns.supervisor += 1;
      const cockpit = await readTextIfExists(path.join(input.runDir, "artifacts", "team-cockpit.md"));
      const supervisorTurn = await runCcRole({
        role: "supervisor",
        workflow: "cc-team-run",
        teamMode,
        model: input.model,
        runDir: input.runDir,
        cwd: input.executionDir,
        prompt: buildSupervisorPrompt({ stage, task: input.task, runDir: input.runDir, targetDir: input.targetDir, state, cockpit, leaderReport: leaderTurn.finalResponse }),
        runner: input.runner,
        turnTimeoutMs: input.turnTimeoutMs,
      });
      sessionLogEntries += 1;

      const supervisorInteraction = firstAskUserInteraction(supervisorTurn.interactionRequests);
      if (supervisorInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(supervisorInteraction);
        recommendedAction = "answer_user";
        state.blockers.push({ kind: "user_decision", question: finalReason, stage });
        await appendCcBlocker(input.runDir, finalReason);
        await writeCcInteractionRequest(input.runDir, supervisorInteraction);
        break;
      }

      await appendSupervisorReport(input.runDir, stage, supervisorTurn.finalResponse);
      await writeTeamCockpit(input.runDir, {
        task: input.task,
        state,
        stage,
        leaderReport: leaderTurn.finalResponse,
        supervisorReport: supervisorTurn.finalResponse,
        targetDir: input.targetDir,
        guidance,
      });

      if (isSupervisorNoGo(supervisorTurn.finalResponse)) {
        finalStatus = "failed";
        finalReason = `supervisor blocked ${stage}: ${firstMeaningfulLine(supervisorTurn.finalResponse)}`;
        recommendedAction = "rerun";
        state.recommendedAction = recommendedAction;
        state.blockers.push({ kind: "verification_failed", question: finalReason, stage });
        await appendCcBlocker(input.runDir, finalReason);
        await writeTeamState(input.runDir, state);
        break;
      }

      state.recommendedAction = "continue";
      await writeTeamState(input.runDir, state);
      finalStatus = "done";
      finalReason = `${stage} completed under leader/supervisor mode.`;
    }
  } catch (error) {
    finalStatus = "failed";
    finalReason = summarizeError(error);
    recommendedAction = "inspect";
    await appendCcBlocker(input.runDir, finalReason);
  }

  if (finalStatus === "done" && currentStage === "ship") {
    finalReason = "cc-team-run completed local delivery lifecycle.";
    recommendedAction = "inspect";
  }

  state = await readTeamState(input.runDir);
  state.status = finalStatus;
  state.currentStage = currentStage;
  state.teamMode = teamMode;
  state.recommendedAction = recommendedAction;
  await writeTeamState(input.runDir, state);
  await writeTeamCockpit(input.runDir, {
    task: input.task,
    state,
    stage: currentStage,
    leaderReport: `Final status: ${finalStatus}. ${finalReason}`,
    supervisorReport: `Supervisor Report: Recommended action: ${recommendedAction}.`,
    targetDir: input.targetDir,
    guidance: await readTextIfExists(path.join(input.runDir, "leader-guidance.md")),
  });
  await appendCcProgress(input.runDir, `\n## Finished\n\nStatus: ${finalStatus}\nReason: ${finalReason}\n`);

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - input.startedAtMs;
  const summary: CcTeamLifecycleRunSummary = {
    schemaVersion: 1,
    provider: "claude-code",
    workflow: "cc-team-run",
    runDir: input.runDir,
    status: finalStatus,
    reason: finalReason,
    model: input.model,
    taskFile: input.taskFile,
    targetDir: input.targetDir,
    currentStage,
    recommendedAction,
    teamMode,
    startedAt: input.startedAt,
    endedAt,
    durationMs,
    turnTimeoutMs: input.turnTimeoutMs,
    skillGuidanceVersion: TEAM_SKILL_GUIDANCE_VERSION,
    appliedSkills: TEAM_SKILL_IDS,
    metrics: {
      sessionLogEntries,
      roleTurns,
    },
    latestVerification: state.latestVerification,
  };
  await writeFile(path.join(input.runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { runDir: input.runDir, targetDir: input.targetDir, status: finalStatus, reason: finalReason, model: input.model, durationMs, workflow: "cc-team-run", stage: currentStage, recommendedAction, teamMode };
}

export function parseCcTesterDecision(finalResponse: string): CcTesterDecision {
  return parseDecisionJson<CcTesterDecision>(finalResponse, "cc tester", ["done", "develop", "ask_user"]);
}

export function parseCcSpecReviewerDecision(finalResponse: string): CcSpecReviewerDecision {
  return parseDecisionJson<CcSpecReviewerDecision>(finalResponse, "cc-spec reviewer", ["done", "ask_user"]);
}

const CC_STREAM_ORDER: readonly CcWorkStreamId[] = ["foundation", "feature", "integration"];

export function parseCcManagerPlan(finalResponse: string): CcManagerPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalResponse);
  } catch {
    throw new Error(`cc manager returned non-JSON response: ${finalResponse}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`cc manager returned non-JSON response: ${finalResponse}`);
  }
  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.streams) || root.streams.length === 0 || root.streams.length > 3) {
    throw new Error(`cc manager plan must include 1-3 streams: ${finalResponse}`);
  }

  const streams: CcWorkStream[] = [];
  const seen = new Set<CcWorkStreamId>();
  for (const item of root.streams) {
    if (!item || typeof item !== "object") throw new Error(`cc manager stream invalid: ${finalResponse}`);
    const row = item as Record<string, unknown>;
    const id = row.id;
    if (id !== "foundation" && id !== "feature" && id !== "integration") {
      throw new Error(`cc manager stream id must be foundation|feature|integration: ${finalResponse}`);
    }
    if (seen.has(id)) throw new Error(`cc manager duplicate stream id ${id}: ${finalResponse}`);
    seen.add(id);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const focus = typeof row.focus === "string" ? row.focus.trim() : "";
    const out_of_scope = typeof row.out_of_scope === "string" ? row.out_of_scope.trim() : "";
    const behavior = typeof row.behavior === "string" ? row.behavior.trim() : "";
    const public_interface = typeof row.public_interface === "string" ? row.public_interface.trim() : "";
    const test_target = typeof row.test_target === "string" ? row.test_target.trim() : "";
    const verification_command = typeof row.verification_command === "string" ? row.verification_command.trim() : "";
    if (!title || !focus || !out_of_scope) {
      throw new Error(`cc manager stream missing title, focus, or out_of_scope: ${finalResponse}`);
    }
    if (!behavior || !public_interface || !test_target || !verification_command) {
      throw new Error(`cc manager stream missing behavior, public_interface, test_target, or verification_command: ${finalResponse}`);
    }
    streams.push({ id, title, focus, out_of_scope, behavior, public_interface, test_target, verification_command });
  }

  streams.sort((a, b) => CC_STREAM_ORDER.indexOf(a.id) - CC_STREAM_ORDER.indexOf(b.id));

  const notes = typeof root.notes === "string" ? root.notes.trim() : undefined;
  return { streams, notes: notes || undefined };
}

function fallbackCcManagerPlan(): CcManagerPlan {
  return {
    streams: [
      {
        id: "feature",
        title: "Full delivery",
        focus: "Implement the complete task in one pass. If the task already lists phases, follow that order within this pass.",
        out_of_scope: "None — single-stream fallback after an invalid manager plan.",
        behavior: "Deliver one complete user-visible behavior through the public interface.",
        public_interface: "The CLI, API, or UI surface described by the task.",
        test_target: "A behavior-level test or verification command through the public interface.",
        verification_command: "npm test",
      },
    ],
    notes: "fallback single stream",
  };
}

function applyCcTesterVerificationGate(decision: CcTesterDecision, events: unknown[]): void {
  if (decision.status !== "done") return;

  const verification = collectCcTesterVerification(events);
  if (verification.failed.length > 0) {
    decision.status = "develop";
    decision.reason = `tester verification failed. Repro command and failure symptom: ${verification.failed.join("; ")}`;
    return;
  }

  if (verification.passed.length === 0) {
    decision.status = "develop";
    decision.reason = "tester did not run any machine verification command, so cc-run cannot mark the task done";
  }
}

function collectCcTesterVerification(events: unknown[]): { passed: string[]; failed: string[] } {
  const bashToolUses = new Map<string, string>();
  const passed: string[] = [];
  const failed: string[] = [];

  for (const event of events) {
    for (const item of readMessageContent(event)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type === "tool_use" && record.name === "Bash" && typeof record.id === "string") {
        bashToolUses.set(record.id, readBashCommand(record.input));
        continue;
      }
      if (record.type !== "tool_result") continue;
      const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : undefined;
      if (!toolUseId || !bashToolUses.has(toolUseId)) continue;
      const command = bashToolUses.get(toolUseId) ?? "Bash verification";
      const content = stringifyToolResultContent(record.content);
      const errored = record.is_error === true || looksLikeFailedVerification(content);
      if (errored) {
        failed.push(`${command}: ${firstNonEmptyLine(content) || "failed"}`);
      } else {
        // Reject truncated/piped core verification commands — they can mask failures.
        const truncatedReason = detectTruncatedCommand(command);
        if (truncatedReason) {
          failed.push(`${command}: truncated/piped command is invalid for verification — ${truncatedReason}`);
        } else {
          passed.push(command);
        }
      }
    }
  }

  return { passed, failed };
}

// Commands that can truncate or filter output and mask verification failures.
const OUTPUT_TRUNCATION_PATTERNS = /\|\s*(?:head|tail|sed\s+-n|awk|grep\s+-[0-9a-zA-Z]|cut|less|more)\b/;
const CORE_VERIFICATION_COMMAND_PATTERN = /\b(npm\s+run\s+(?:typecheck|test(?::[a-z0-9_-]+)?|build)|node\s+--test|git\s+diff\s+--check|tsc\b)/i;

function detectTruncatedCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (CORE_VERIFICATION_COMMAND_PATTERN.test(trimmed) && OUTPUT_TRUNCATION_PATTERNS.test(trimmed)) {
    return "pipe to head/tail/sed -n/awk/grep/cut/less/more can truncate output and mask failures";
  }
  return undefined;
}

function readBashCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "Bash verification";
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command.trim() : "Bash verification";
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        return (item as { text: string }).text;
      }
      return JSON.stringify(item);
    }).join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function looksLikeFailedVerification(content: string): boolean {
  return /\b(error TS\d+|failed tests?|tests? failed|ERR!|AssertionError|not ok|exit code\s*[:=]?\s*[1-9]|Command failed)\b/i.test(content);
}

function parseDecisionJson<T extends { status: string; reason: string }>(
  finalResponse: string,
  agentLabel: string,
  validStatuses: readonly string[],
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalResponse);
  } catch {
    throw new Error(`${agentLabel} returned non-JSON response: ${finalResponse}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${agentLabel} returned non-JSON response: ${finalResponse}`);
  }
  const candidate = parsed as Record<string, unknown>;
  if (!validStatuses.includes(candidate.status as string)) {
    throw new Error(`${agentLabel} returned invalid status: ${finalResponse}`);
  }
  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
    throw new Error(`${agentLabel} returned invalid reason: ${finalResponse}`);
  }
  return { status: candidate.status, reason: candidate.reason } as T;
}

function createCcRunDirectoryName(runsDir: string, prefix: "cc" | "cc-spec" | "cc-team" = "cc"): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(runsDir, `${prefix}-${stamp}`);
}

async function ensureSessionLogDirs(runDir: string): Promise<void> {
  await mkdir(path.join(runDir, "session-log", "events"), { recursive: true });
  await mkdir(path.join(runDir, "session-log", "inflight"), { recursive: true });
}

async function initializeCcRunProtocol(input: {
  runDir: string;
  task: string;
  model: string;
  startedAt: string;
  specDir?: string;
  targetDir?: string;
}): Promise<void> {
  await mkdir(path.join(input.runDir, "workspace"), { recursive: true });
  await ensureSessionLogDirs(input.runDir);
  const progressLines = [
    "# CC Team Progress",
    "",
    `Model: ${input.model}`,
  ];
  if (input.specDir) progressLines.push(`Spec: ${input.specDir}`);
  if (input.targetDir) progressLines.push(`Target: ${input.targetDir}`);
  progressLines.push(`Started: ${input.startedAt}`, "");
  const progressHeader = `${progressLines.join("\n")}\n`;
  await Promise.all([
    writeFile(path.join(input.runDir, "task.md"), input.task, "utf8"),
    writeFile(path.join(input.runDir, "blockers.md"), "", "utf8"),
    writeFile(path.join(input.runDir, "progress.md"), progressHeader, "utf8"),
  ]);
}

async function initializeCcSpecRunProtocol(input: {
  runDir: string;
  task: string;
  model: string;
  mode: CcSpecMode;
  targetSummary: string;
  startedAt: string;
}): Promise<void> {
  await ensureSessionLogDirs(input.runDir);
  await Promise.all([
    writeFile(path.join(input.runDir, "task.md"), input.task, "utf8"),
    writeFile(path.join(input.runDir, "blockers.md"), "", "utf8"),
    writeFile(path.join(input.runDir, "questions.md"), "", "utf8"),
    writeFile(path.join(input.runDir, "user-replies.md"), "", "utf8"),
    writeFile(path.join(input.runDir, "product-brief.md"), "# Product Brief\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "decision-log.md"), "# Decision Log\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "research.md"), "# Research\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "spec.md"), "# Spec\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "agent-spec.md"), "# Agent Spec\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "tasks.md"), "# Tasks\n\nPending.\n", "utf8"),
    writeFile(path.join(input.runDir, "context.md"), buildCcSpecContext(input.mode, input.targetSummary), "utf8"),
    writeFile(path.join(input.runDir, "progress.md"), `# CC Spec Progress\n\nModel: ${input.model}\nStarted: ${input.startedAt}\n`, "utf8"),
  ]);
}

async function ensureCcSpecRunProtocol(input: {
  runDir: string;
  model: string;
  mode: CcSpecMode;
  targetSummary: string;
  startedAt: string;
}): Promise<void> {
  await ensureSessionLogDirs(input.runDir);
  const files = [
    "context.md", "progress.md", "blockers.md", "questions.md", "user-replies.md",
    "product-brief.md", "decision-log.md", "research.md", "spec.md", "agent-spec.md", "tasks.md",
  ] as const;
  const contents = await Promise.all(files.map((f) => readTextIfExists(path.join(input.runDir, f))));
  const [ctx, prog, blk, q, rep, pb, dl, res, sp, as, tk] = contents;
  const placeholders: Record<string, string> = {
    "context.md": buildCcSpecContext(input.mode, input.targetSummary),
    "progress.md": `# CC Spec Progress\n\nModel: ${input.model}\nStarted: ${input.startedAt}\n`,
    "blockers.md": "",
    "questions.md": "",
    "user-replies.md": "",
    "product-brief.md": "# Product Brief\n\nPending.\n",
    "decision-log.md": "# Decision Log\n\nPending.\n",
    "research.md": "# Research\n\nPending.\n",
    "spec.md": "# Spec\n\nPending.\n",
    "agent-spec.md": "# Agent Spec\n\nPending.\n",
    "tasks.md": "# Tasks\n\nPending.\n",
  };
  const existing = [ctx, prog, blk, q, rep, pb, dl, res, sp, as, tk];
  const writes = files
    .map((f, i) => (!existing[i] ? writeFile(path.join(input.runDir, f), placeholders[f], "utf8") : null))
    .filter((p): p is Promise<void> => p !== null);
  await Promise.all(writes);
}

async function initializeCcTeamLifecycleProtocol(input: {
  runDir: string;
  task: string;
  model: string;
  startedAt: string;
  teamMode: TeamMode;
  targetDir?: string;
}): Promise<void> {
  await mkdir(path.join(input.runDir, "tasks"), { recursive: true });
  await mkdir(path.join(input.runDir, "artifacts"), { recursive: true });
  await mkdir(path.join(input.runDir, "workspace"), { recursive: true });
  await ensureSessionLogDirs(input.runDir);
  const progressLines = [
    "# CC Team Lifecycle Progress",
    "",
    `Model: ${input.model}`,
  ];
  if (input.targetDir) progressLines.push(`Target: ${input.targetDir}`);
  progressLines.push(`Started: ${input.startedAt}`, "");

  const existingState = await readTextIfExists(path.join(input.runDir, "team-state.json"));
  await Promise.all([
    writeFile(path.join(input.runDir, "task.md"), input.task, "utf8"),
    writeFile(path.join(input.runDir, "blockers.md"), await readTextIfExists(path.join(input.runDir, "blockers.md")), "utf8"),
    writeFile(path.join(input.runDir, "progress.md"), existingState ? await readTextIfExists(path.join(input.runDir, "progress.md")) || `${progressLines.join("\n")}\n` : `${progressLines.join("\n")}\n`, "utf8"),
  ]);
  if (!existingState) {
    await writeTeamState(input.runDir, {
      schemaVersion: 1,
      workflow: "cc-team-run",
      status: "running",
      currentStage: "spec",
      recommendedAction: "continue",
      teamMode: input.teamMode,
      skillGuidanceVersion: TEAM_SKILL_GUIDANCE_VERSION,
      appliedSkills: TEAM_SKILL_IDS,
      tasks: [],
      blockers: [],
      assumptions: [],
    });
  }
  if (!await readTextIfExists(path.join(input.runDir, "worker-registry.json"))) {
    await writeWorkerRegistry(input.runDir, { workers: [] });
  }
}

type TeamLeaderDecision = {
  status: "continue" | "ask_user" | "done";
  stage: TeamStage;
  reason: string;
  recommendedAction: string;
  assumptions: string[];
  blocker?: { kind: BlockerKind; question: string };
  task?: Omit<TeamTask, "stage" | "role" | "status">;
};

function parseTeamLeaderDecision(finalResponse: string, expectedStage: TeamStage): TeamLeaderDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalResponse);
  } catch {
    throw new Error(`team leader returned non-JSON response: ${finalResponse}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`team leader returned non-JSON response: ${finalResponse}`);
  }
  const row = parsed as Record<string, unknown>;
  const status = row.status;
  if (status !== "continue" && status !== "ask_user" && status !== "done") {
    throw new Error(`team leader returned invalid status: ${finalResponse}`);
  }
  const stage = row.stage;
  if (!isTeamStage(stage)) {
    throw new Error(`team leader returned invalid stage: ${finalResponse}`);
  }
  if (stage !== expectedStage) {
    throw new Error(`team leader returned stage ${stage} while ${expectedStage} was expected`);
  }
  const reason = typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : "No reason provided.";
  const recommendedAction = typeof row.recommendedAction === "string" && row.recommendedAction.trim() ? row.recommendedAction.trim() : "continue";
  const assumptions = Array.isArray(row.assumptions) ? row.assumptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const blocker = parseTeamBlocker(row.blocker);
  const task = row.task && typeof row.task === "object" ? parseTeamTaskPayload(row.task as Record<string, unknown>) : undefined;
  return { status, stage, reason, recommendedAction, assumptions, blocker, task };
}

function parseTeamBlocker(value: unknown): { kind: BlockerKind; question: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  const question = typeof row.question === "string" ? row.question.trim() : "";
  if (!isBlockerKind(kind) || !question) return undefined;
  return { kind, question };
}

function parseTeamTaskPayload(row: Record<string, unknown>): Omit<TeamTask, "stage" | "role" | "status"> {
  const id = readRequiredString(row, "id");
  const title = readRequiredString(row, "title");
  const objective = readRequiredString(row, "objective");
  const context = readRequiredString(row, "context");
  const inputFiles = readStringArray(row.inputFiles);
  const allowedPaths = readStringArray(row.allowedPaths);
  const acceptanceCriteria = readStringArray(row.acceptanceCriteria);
  const verificationCommand = readRequiredString(row, "verificationCommand");
  const failureCategories = readStringArray(row.failureCategories).filter(isBlockerKind);
  if (failureCategories.length === 0) {
    throw new Error(`team task ${id} must include at least one valid failure category`);
  }
  return { id, title, objective, context, inputFiles, allowedPaths, acceptanceCriteria, verificationCommand, failureCategories };
}

function readRequiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`team task missing ${key}`);
  }
  return value.trim();
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function normalizeTeamTask(stage: TeamStage, task: Omit<TeamTask, "stage" | "role" | "status">): TeamTask {
  return {
    ...task,
    stage,
    role: workerRoleForStage(stage),
    status: "pending",
  };
}

function workerRoleForStage(stage: TeamStage): WorkerRole {
  if (stage === "spec" || stage === "plan") return "planner";
  if (stage === "build") return "developer";
  if (stage === "test") return "tester";
  if (stage === "review") return "reviewer";
  return "shipper";
}

function isTeamStage(value: unknown): value is TeamStage {
  return value === "spec" || value === "plan" || value === "build" || value === "test" || value === "review" || value === "ship";
}

function isBlockerKind(value: unknown): value is BlockerKind {
  return value === "user_decision"
    || value === "credentials"
    || value === "task_doc_defect"
    || value === "execution_defect"
    || value === "skill_context_defect"
    || value === "verification_failed";
}

function createEmptyLifecycleRoleTurns(): Record<WorkerRole, number> {
  return { leader: 0, supervisor: 0, planner: 0, developer: 0, tester: 0, reviewer: 0, shipper: 0 };
}

async function readTeamState(runDir: string): Promise<TeamState> {
  const raw = await readTextIfExists(path.join(runDir, "team-state.json"));
  if (!raw) {
    return {
      schemaVersion: 1,
      workflow: "cc-team-run",
      status: "running",
      currentStage: "spec",
      recommendedAction: "continue",
      teamMode: "supervised",
      skillGuidanceVersion: TEAM_SKILL_GUIDANCE_VERSION,
      appliedSkills: TEAM_SKILL_IDS,
      tasks: [],
      blockers: [],
      assumptions: [],
    };
  }
  const parsed = JSON.parse(raw) as TeamState;
  return {
    ...parsed,
    teamMode: parsed.teamMode ?? "supervised",
    skillGuidanceVersion: parsed.skillGuidanceVersion ?? TEAM_SKILL_GUIDANCE_VERSION,
    appliedSkills: parsed.appliedSkills ?? TEAM_SKILL_IDS,
  };
}

async function writeTeamState(runDir: string, state: TeamState): Promise<void> {
  await writeFile(path.join(runDir, "team-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readWorkerRegistry(runDir: string): Promise<WorkerRegistry> {
  const raw = await readTextIfExists(path.join(runDir, "worker-registry.json"));
  return raw ? JSON.parse(raw) as WorkerRegistry : { workers: [] };
}

async function writeWorkerRegistry(runDir: string, registry: WorkerRegistry): Promise<void> {
  await writeFile(path.join(runDir, "worker-registry.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function selectReusableWorker(registry: WorkerRegistry, input: { role: WorkerRole; cwd: string }): WorkerRegistryEntry | undefined {
  return registry.workers
    .filter((worker) => worker.role === input.role && worker.cwd === input.cwd && worker.status === "healthy")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function upsertWorkerRegistryEntry(
  runDir: string,
  registry: WorkerRegistry,
  input: { role: WorkerRole; cwd: string; sessionId: string | null; taskId: string; status: WorkerRegistryEntry["status"] },
): Promise<void> {
  if (!input.sessionId) return;
  const now = new Date().toISOString();
  const existing = registry.workers.find((worker) => worker.role === input.role && worker.cwd === input.cwd && worker.sessionId === input.sessionId);
  if (existing) {
    existing.status = input.status;
    existing.lastTaskId = input.taskId;
    existing.updatedAt = now;
  } else {
    registry.workers.push({
      id: `worker-${input.role}-${registry.workers.length + 1}`,
      role: input.role,
      cwd: input.cwd,
      sessionId: input.sessionId,
      status: input.status,
      skills: skillsForWorker(input.role),
      lastTaskId: input.taskId,
      updatedAt: now,
    });
  }
  await writeWorkerRegistry(runDir, registry);
}

function skillsForWorker(role: WorkerRole): string[] {
  return teamSkillsForRole(role);
}

async function writeTeamTaskDocument(runDir: string, task: TeamTask): Promise<void> {
  const text = [
    `# Team Task: ${task.id}`,
    "",
    `stage: ${task.stage}`,
    `role: ${task.role}`,
    `status: ${task.status}`,
    "",
    "## Objective",
    task.objective,
    "",
    "## Context",
    task.context,
    "",
    "## Input Files",
    ...task.inputFiles.map((item) => `- ${item}`),
    "",
    "## Allowed Paths",
    ...task.allowedPaths.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    ...task.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Verification Command",
    task.verificationCommand,
    "",
    "## Failure Categories",
    ...task.failureCategories.map((item) => `- ${item}`),
    "",
  ].join("\n");
  await writeFile(path.join(runDir, "tasks", `${task.id}.md`), text, "utf8");
}

export function parseTeamTaskDocument(text: string): TeamTask {
  const required = ["Objective", "Context", "Input Files", "Allowed Paths", "Acceptance Criteria", "Verification Command", "Failure Categories"];
  const missing = required.filter((section) => !new RegExp(`^##\\s+${section}\\s*$`, "im").test(text));
  if (missing.length > 0) {
    throw new Error(`team task document missing required sections: ${missing.join(", ")}`);
  }
  const stage = readFrontMatterValue(text, "stage");
  const role = readFrontMatterValue(text, "role");
  const status = readFrontMatterValue(text, "status") || "pending";
  if (!isTeamStage(stage)) throw new Error("team task document has invalid stage");
  if (!isWorkerRole(role)) throw new Error("team task document has invalid role");
  if (!isTeamTaskStatus(status)) throw new Error("team task document has invalid status");
  const id = text.match(/^#\s+Team Task:\s*(\S+)/im)?.[1] ?? "task_unknown";
  const failureCategories = readListSection(text, "Failure Categories").filter(isBlockerKind);
  return {
    id,
    stage,
    role,
    status,
    title: id,
    objective: readSection(text, "Objective"),
    context: readSection(text, "Context"),
    inputFiles: readListSection(text, "Input Files"),
    allowedPaths: readListSection(text, "Allowed Paths"),
    acceptanceCriteria: readListSection(text, "Acceptance Criteria"),
    verificationCommand: readSection(text, "Verification Command"),
    failureCategories,
  };
}

function isWorkerRole(value: unknown): value is WorkerRole {
  return value === "leader" || value === "supervisor" || value === "planner" || value === "developer" || value === "tester" || value === "reviewer" || value === "shipper";
}

function isTeamTaskStatus(value: unknown): value is TeamTaskStatus {
  return value === "pending" || value === "running" || value === "done" || value === "blocked" || value === "failed";
}

function readFrontMatterValue(text: string, key: string): string {
  return text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
}

function readSection(text: string, section: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${section}\\s*$`, "i").test(line.trim()));
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function readListSection(text: string, section: string): string[] {
  return readSection(text, section)
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

async function persistTeamStageArtifact(runDir: string, stage: TeamStage, finalResponse: string): Promise<void> {
  const fileByStage: Record<TeamStage, string> = {
    spec: "spec.md",
    plan: "plan.md",
    build: "build-result.md",
    test: "test-result.md",
    review: "review.md",
    ship: "ship-report.md",
  };
  await writeFile(path.join(runDir, "artifacts", fileByStage[stage]), `${finalResponse.trim()}\n`, "utf8");
}

function upsertSupervisedStageTask(state: TeamState, stage: TeamStage, status: TeamTaskStatus, report: string): void {
  const id = `task_${stage}_leader`;
  const existing = state.tasks.find((task) => task.id === id);
  const summary = firstMeaningfulLine(report);
  const task: TeamTask = {
    id,
    stage,
    role: "leader",
    title: `${stage} leader execution`,
    status,
    objective: `Leader executes the ${stage} stage in supervised mode.`,
    context: summary,
    inputFiles: ["task.md", "leader-guidance.md", "artifacts/team-cockpit.md"],
    allowedPaths: ["**/*"],
    acceptanceCriteria: [`${stage} produces a boss-readable stage report and updates cockpit context.`],
    verificationCommand: stage === "test" ? "leader-provided verification evidence" : "supervisor inspection",
    failureCategories: ["execution_defect", "skill_context_defect", "verification_failed", "credentials", "user_decision"],
  };
  if (existing) {
    Object.assign(existing, task);
  } else {
    state.tasks.push(task);
  }
}

async function appendSupervisorReport(runDir: string, stage: TeamStage, report: string): Promise<void> {
  const reportPath = path.join(runDir, "artifacts", "supervisor-report.md");
  const existing = await readTextIfExists(reportPath);
  const next = `${existing.trimEnd() || "# Supervisor Report"}\n\n## Stage: ${stage}\n\n${report.trim()}\n`;
  await writeFile(reportPath, next, "utf8");
}

async function writeTeamCockpit(runDir: string, input: {
  task: string;
  state: TeamState;
  stage: TeamStage;
  leaderReport: string;
  supervisorReport: string;
  targetDir?: string;
  guidance?: string;
}): Promise<void> {
  const stageRows = TEAM_STAGES.map((stage) => {
    const marker = stage === input.state.currentStage
      ? "active"
      : TEAM_STAGES.indexOf(stage) < TEAM_STAGES.indexOf(input.state.currentStage) || input.state.status === "done"
        ? "done"
        : "pending";
    return `- ${stage}: ${marker}`;
  }).join("\n");
  const doneTasks = input.state.tasks.filter((task) => task.status === "done");
  const runningTasks = input.state.tasks.filter((task) => task.status === "running");
  const blockers = input.state.blockers.map((blocker) => `- ${blocker.kind}: ${blocker.question}`).join("\n") || "- none";
  const assumptions = input.state.assumptions.map((item) => `- ${item}`).join("\n") || "- none";
  const guidance = input.guidance?.trim() || "No owner guidance yet.";
  const text = [
    "# Team Cockpit",
    "",
    "## Current Goal",
    input.task.replace(/^#\s*Task\s*/i, "").trim() || "No task text.",
    "",
    "## Current Status",
    `- Status: ${input.state.status}`,
    `- Current stage: ${input.state.currentStage}`,
    `- Recommended action: ${input.state.recommendedAction}`,
    `- Target: ${input.targetDir ?? "run workspace"}`,
    "",
    "## Stage Progress",
    stageRows,
    "",
    "## Current Work",
    runningTasks.length ? runningTasks.map((task) => `- ${task.id}: ${task.title}`).join("\n") : `- Leader just worked on ${input.stage}.`,
    "",
    "## Completed Work",
    doneTasks.length ? doneTasks.map((task) => `- ${task.stage}: ${task.context}`).join("\n") : "- none yet",
    "",
    "## Latest Leader Summary",
    input.leaderReport.trim() || "No leader report yet.",
    "",
    "## Latest Supervisor Summary",
    input.supervisorReport.trim() || "No supervisor report yet.",
    "",
    "## Blockers",
    blockers,
    "",
    "## Assumptions",
    assumptions,
    "",
    "## Owner Guidance",
    guidance,
    "",
    "## Next Step",
    input.state.recommendedAction,
    "",
  ].join("\n");
  await writeFile(path.join(runDir, "artifacts", "team-cockpit.md"), text, "utf8");
}

function isSupervisorNoGo(report: string): boolean {
  return /(^|\n)\s*(NO-GO|REQUEST CHANGES|Critical)\b/i.test(report);
}

function firstMeaningfulLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "No details provided.";
}

function latestVerificationFromTesterDecision(task: TeamTask, decision: CcTesterDecision): TeamState["latestVerification"] {
  return {
    command: task.verificationCommand,
    status: decision.status === "done" ? "passed" : "failed",
    detail: decision.reason,
  };
}

async function writeTeamInteractionRequest(runDir: string, stage: TeamStage, blocker: { kind: BlockerKind; question: string }): Promise<void> {
  await writeFile(path.join(runDir, "interaction-request.json"), `${JSON.stringify({
    role: "leader",
    type: "ask_user",
    toolName: ASK_USER_TOOL,
    input: {
      stage,
      kind: blocker.kind,
      questions: [{ question: blocker.question }],
    },
    title: blocker.question,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

async function runCcRole(input: {
  role: CcRole;
  workflow?: CcWorkflow;
  teamMode?: TeamMode;
  model: string;
  runDir: string;
  cwd?: string;
  prompt: string;
  runner: CcRoleRunner;
  turnTimeoutMs: number;
  resumeSessionId?: string;
}): Promise<CcRoleTurnResult> {
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), input.turnTimeoutMs);
  const events: unknown[] = [];
  const interactionRequests: CcInteractionRequest[] = [];
  let sessionId: string | null = null;
  let finalResponse = "";
  let classification = "waiting_for_first_cc_event";
  let detail = "No Claude Code SDK event has been received yet.";
  let lastEventType: string | undefined;

  const diagnosticPath = ccDiagnosticPath(input.runDir, startedAt, input.role);
  const eventTracePath = ccEventTracePath(input.runDir, startedAt, input.role);
  const writeDiagnostic = async (status: CcRoleDiagnostic["status"]) => {
    await writeFile(diagnosticPath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status,
      startedAt,
      lastUpdatedAt: new Date().toISOString(),
      classification,
      detail,
      lastEventType,
    } satisfies CcRoleDiagnostic, null, 2)}\n`, "utf8");
  };

  await writeDiagnostic("running");
  try {
    for await (const event of input.runner({
      role: input.role,
      workflow: input.workflow,
      teamMode: input.teamMode,
      model: input.model,
      cwd: input.cwd ?? input.runDir,
      prompt: input.prompt,
      systemPrompt: buildCcSystemPrompt(input.role, input.workflow, input.teamMode),
      maxTurns: maxTurnsForRole(input.role, input.workflow, input.teamMode),
      tools: toolsForRole(input.role, input.workflow, input.teamMode),
      allowedTools: allowedToolsForRole(input.role, input.workflow, input.teamMode),
      outputFormat: outputFormatForRole(input.role, input.workflow, input.teamMode),
      permissionMode: permissionModeForRole(input.role, input.workflow, input.teamMode),
      abortController,
      interactionRequests,
      resumeSessionId: input.resumeSessionId,
    })) {
      events.push(event);
      const diagnosis = diagnoseCcEvent(event);
      classification = diagnosis.classification;
      detail = diagnosis.detail;
      lastEventType = formatCcEventType(event);
      sessionId = readStringProperty(event, "session_id") ?? sessionId;
      finalResponse = extractCcFinalResponse(event) ?? finalResponse;
      await writeDiagnostic("running");
      if (shouldAppendCcProgress(diagnosis.classification)) {
        await appendCcProgress(input.runDir, `\n- ${input.role}: ${diagnosis.detail}\n`);
      }
    }

    classification = "turn_completed";
    detail = "The Claude Code SDK role turn completed.";
    await writeDiagnostic("completed");
    await writeFile(eventTracePath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status: "completed",
      startedAt,
      endedAt: new Date().toISOString(),
      events,
    }, null, 2)}\n`, "utf8");
    return { role: input.role, sessionId, finalResponse, events, interactionRequests };
  } catch (error) {
    classification = abortController.signal.aborted ? "turn_timeout" : "cc_sdk_error";
    detail = summarizeError(error);
    await writeDiagnostic("failed");
    await writeFile(eventTracePath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      events,
      error: detail,
    }, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultCcRoleRunner(request: CcRoleRunRequest): AsyncIterable<SDKMessage> {
  const sdkOptions: ClaudeCodeOptions = {
    model: request.model,
    cwd: request.cwd,
    resume: request.resumeSessionId,
    maxTurns: request.maxTurns,
    tools: request.tools,
    allowedTools: request.allowedTools,
    settingSources: [],
    permissionMode: request.permissionMode,
    abortController: request.abortController,
    outputFormat: request.outputFormat,
    includePartialMessages: true,
    includeHookEvents: true,
    canUseTool: async (toolName, input, context): Promise<PermissionResult> => {
      const interaction = {
        role: request.role,
        type: toolName === ASK_USER_TOOL ? "ask_user" : "permission",
        toolName,
        input,
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        toolUseID: context.toolUseID,
        recordedAt: new Date().toISOString(),
      } satisfies CcInteractionRequest;
      request.interactionRequests.push(interaction);
      return {
        behavior: "deny",
        message: toolName === ASK_USER_TOOL
          ? "User input is required. cc-run recorded this request for the operator."
          : `Tool ${toolName} is not approved for the ${request.role} role.`,
        toolUseID: context.toolUseID,
      };
    },
    systemPrompt: request.systemPrompt,
    settings: {
      includeCoAuthoredBy: false,
      skipDangerousModePermissionPrompt: true,
    },
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
    },
  };
  return query({ prompt: request.prompt, options: sdkOptions });
}

function buildCcSystemPrompt(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): string {
  if (workflow !== "cc-team-run" && isCcSpecRole(role)) {
    return buildCcSpecSystemPrompt(role);
  }
  if (workflow === "cc-team-run") {
    const skillIds = role === "leader" && teamMode === "supervised" ? TEAM_SKILL_IDS : teamSkillsForRole(role);
    const skillGuidance = formatTeamSkillGuidance(skillIds);
    if (role === "leader") {
      if (teamMode === "supervised") {
        return [
          "You are the Claude Code team leader and primary execution SDK for cc-team-run supervised mode.",
          "Execute the full lifecycle yourself: spec, plan, build, test, review, and ship.",
          "Maintain boss-readable progress in artifacts/team-cockpit.md when you can edit files; the runtime will also refresh the cockpit from your reports.",
          "Read leader-guidance.md before each stage and treat owner guidance as directional input, unless it conflicts with safety or local constraints.",
          "Ask the user only for high-impact product decisions, credentials, paid/external deployment authority, data/integration boundaries, or blockers the local team cannot self-resolve.",
          "Do not commit, push, deploy, purchase services, or perform externally visible actions.",
          skillGuidance,
        ].join("\n\n");
      }
      return [
        "You are the Claude Code team leader for the cc-team-run lifecycle.",
        "Run the lifecycle as spec, plan, build, test, review, and ship.",
        "Ask the user only for high-impact product decisions, credentials, paid/external deployment authority, data/integration boundaries, or blockers the team cannot self-resolve.",
        "For low-impact defaults, choose popular low-cost conventional choices, record assumptions, and keep moving.",
        "Return JSON only. Do not edit product code.",
        skillGuidance,
      ].join(" ");
    }
    if (role === "planner") {
      return [
        "You are a planner/spec worker. Produce concise lifecycle artifacts from the assigned team task. Use spec-before-code and vertical task breakdown discipline.",
        skillGuidance,
      ].join("\n\n");
    }
    if (role === "developer") {
      return [
        "You are a developer worker. Execute the assigned task document fully, keep edits scoped, and report task_doc_defect/execution_defect/skill_context_defect/credentials when blocked.",
        skillGuidance,
      ].join("\n\n");
    }
    if (role === "tester") {
      return [
        "You are a tester worker. Run non-destructive machine verification and return JSON only.",
        skillGuidance,
      ].join("\n\n");
    }
    if (role === "reviewer") {
      return [
        "You are a reviewer worker. Review correctness, security, maintainability, and test coverage. Mark Critical or REQUEST CHANGES for blockers.",
        skillGuidance,
      ].join("\n\n");
    }
    if (role === "shipper") {
      return [
        "You are a shipper worker. Produce local delivery, deployment, and rollback reports. Do not commit, push, or deploy.",
        skillGuidance,
      ].join("\n\n");
    }
    if (role === "supervisor") {
      return [
        "You are the independent supervisor SDK for cc-team-run supervised mode.",
        "Do not edit product code. Inspect the leader report, cockpit, team state, artifacts, blockers, and verification evidence.",
        "Return a concise supervisor report with: current status, risks, missing verification, whether to continue, rerun, ask the user, or ship-ready.",
        "Use NO-GO, REQUEST CHANGES, or Critical when the run must not continue.",
        skillGuidance,
      ].join("\n\n");
    }
  }
  if (role === "manager") {
    return [
      "You are the cc team manager.",
      "Split work into 1-3 developer passes only. Each pass must be independently actionable.",
      "Use stream id foundation for layout, types, config, migrations, shared utilities.",
      "Use feature for primary user-visible behavior and core business logic.",
      "Use integration for wiring, automated tests, docs updates, error paths, and polish.",
      "For tiny tasks, emit a single feature stream. Do not invent more splits than the task needs.",
      "Do not write or edit product code — planning and JSON output only.",
    ].join(" ");
  }
  if (role === "developer") {
    return "You are the cc developer. Implement only inside the current working directory. Keep changes minimal and scoped to the task.";
  }
  return "You are the cc tester. Verify the current working directory result and return JSON only.";
}

function maxTurnsForRole(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): number {
  if (workflow === "cc-team-run" && role === "leader") return teamMode === "supervised" ? DEVELOPER_MAX_TURNS : 12;
  if (workflow === "cc-team-run" && role === "supervisor") return 16;
  if (workflow === "cc-team-run" && role === "planner") return 20;
  if (workflow === "cc-team-run" && (role === "shipper" || role === "reviewer")) return 16;
  if (role === "manager") return MANAGER_MAX_TURNS;
  if (role === "developer") return DEVELOPER_MAX_TURNS;
  if (role === "tester") return TESTER_MAX_TURNS;
  if (role === "demo") return 12;
  if (role === "research") return 16;
  if (role === "architect") return 12;
  return 8;
}

function toolsForRole(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): string[] {
  if (workflow === "cc-team-run" && role === "leader" && teamMode === "supervised") return ["LS", "Glob", "Grep", "Read", "Write", "Edit", "Bash", ASK_USER_TOOL];
  if (workflow === "cc-team-run" && role === "leader") return ["LS", "Glob", "Grep", "Read", ASK_USER_TOOL];
  if (workflow === "cc-team-run" && role === "supervisor") return ["LS", "Glob", "Grep", "Read", ASK_USER_TOOL];
  if (workflow === "cc-team-run" && role === "planner") return ["LS", "Glob", "Grep", "Read", "Write", "Edit", ASK_USER_TOOL];
  if (workflow === "cc-team-run" && (role === "shipper" || role === "reviewer")) return ["LS", "Glob", "Grep", "Read", ASK_USER_TOOL];
  if (role === "manager") return ["LS", "Glob", "Grep", "Read", ASK_USER_TOOL];
  if (role === "tester") return ["LS", "Glob", "Grep", "Read", "Bash", ASK_USER_TOOL];
  if (role === "reviewer") return ["Read", ASK_USER_TOOL];
  if (role === "product") return [ASK_USER_TOOL];
  if (role === "demo") return ["Write", "Read", ASK_USER_TOOL];
  if (role === "research") return ["WebSearch", ASK_USER_TOOL];
  if (role === "architect") return ["Read", ASK_USER_TOOL];
  if (role === "intake") return ["Read", "Write", "Edit", ASK_USER_TOOL];
  return ["LS", "Glob", "Grep", "Read", "Write", "Edit", ASK_USER_TOOL];
}

function allowedToolsForRole(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): string[] {
  if (workflow === "cc-team-run" && role === "leader" && teamMode === "supervised") return ["LS", "Glob", "Grep", "Read", "Write", "Edit", "Bash"];
  if (workflow === "cc-team-run" && role === "leader") return ["LS", "Glob", "Grep", "Read"];
  if (workflow === "cc-team-run" && role === "supervisor") return ["LS", "Glob", "Grep", "Read"];
  if (workflow === "cc-team-run" && role === "planner") return ["LS", "Glob", "Grep", "Read", "Write", "Edit"];
  if (workflow === "cc-team-run" && (role === "shipper" || role === "reviewer")) return ["LS", "Glob", "Grep", "Read"];
  if (role === "manager") return ["LS", "Glob", "Grep", "Read"];
  if (role === "tester") return ["LS", "Glob", "Grep", "Read", "Bash"];
  if (role === "reviewer") return ["Read"];
  if (role === "product") return [];
  if (role === "demo") return ["Write", "Read"];
  if (role === "research") return ["WebSearch"];
  if (role === "architect") return ["Read"];
  if (role === "intake") return ["Read", "Write", "Edit"];
  return ["LS", "Glob", "Grep", "Read", "Write", "Edit"];
}

function outputFormatForRole(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): OutputFormat | undefined {
  if (workflow === "cc-team-run" && role === "leader" && teamMode !== "supervised") return TEAM_LEADER_DECISION_OUTPUT_FORMAT;
  if (workflow === "cc-team-run" && role === "supervisor") return undefined;
  if (workflow === "cc-team-run" && role === "reviewer") return undefined;
  if (role === "manager") return CC_MANAGER_PLAN_OUTPUT_FORMAT;
  if (role === "tester") return CC_TESTER_DECISION_OUTPUT_FORMAT;
  if (role === "reviewer") return CC_SPEC_REVIEWER_DECISION_OUTPUT_FORMAT;
  return undefined;
}

function permissionModeForRole(role: CcRole, workflow?: CcWorkflow, teamMode?: TeamMode): "acceptEdits" | "dontAsk" {
  if (workflow === "cc-team-run" && role === "leader" && teamMode === "supervised") return "acceptEdits";
  if (workflow === "cc-team-run" && (role === "leader" || role === "supervisor" || role === "tester" || role === "reviewer" || role === "shipper")) return "dontAsk";
  if (workflow === "cc-team-run" && role === "planner") return "acceptEdits";
  if (role === "manager" || role === "tester" || role === "reviewer") return "dontAsk";
  return "acceptEdits";
}

function buildCcManagerPrompt(input: { task: string; loop: number; targetDir?: string; testerRepairHint: string }): string {
  const { task, loop, targetDir, testerRepairHint } = input;
  const scope = targetDir
    ? `The implementation cwd is the target repository: ${targetDir}. Plan file changes there.`
    : "Developers write under ./workspace in the run directory unless the task says otherwise.";
  const repair = testerRepairHint.trim()
    ? `Tester feedback from the previous loop (address in this plan and assign to the right stream):\n${testerRepairHint.trim()}\n`
    : "No prior tester feedback — first planning pass.\n";
  return `You are the manager role in the cc team workflow.

Loop: ${loop}

${scope}

${repair}

Full task (context for splitting):
${task}

Return JSON only matching the schema. streams must have 1-3 items with distinct id values chosen from: foundation, feature, integration.
Each stream needs a short title, a concrete focus (what this developer implements in one pass), and out_of_scope (what they must not change in that pass to avoid thrash).
Each stream also needs:
- behavior: the end-to-end user-visible behavior this vertical slice proves.
- public_interface: the CLI/API/UI surface the behavior is verified through.
- test_target: the behavior-level test or check the developer should create or preserve.
- verification_command: the exact non-destructive command the tester should run. It must be a machine verification command that terminates by itself; do not use long-running servers, browser-opening commands, watch mode, or manual-only instructions.

Optional notes field: coordination hints for developers (dependencies, sequencing).`;
}

function buildCcDeveloperStreamPrompt(input: {
  task: string;
  loop: number;
  stream: CcWorkStream;
  plan: CcManagerPlan;
  targetDir?: string;
  testerRepairHint: string;
}): string {
  const workRule = input.targetDir
    ? `- The current directory is the target repository: ${input.targetDir}.
- Edit the target repository directly and keep changes scoped to this stream.
- Do not write implementation deliverables into the cc-run diagnostics directory.`
    : `- Work in the current run directory only.
- Put deliverables under ./workspace unless the task explicitly says otherwise.`;
  const otherStreams = input.plan.streams.filter((s) => s.id !== input.stream.id);
  const planNotes = input.plan.notes ? `\nManager notes:\n${input.plan.notes}\n` : "";
  const repair = input.testerRepairHint.trim()
    ? `\nTester feedback to respect when relevant:\n${input.testerRepairHint.trim()}\n`
    : "";

  return `You are the developer role in the cc team workflow.

Current stream: ${input.stream.id} — ${input.stream.title}
Loop: ${input.loop}

Your focus for this pass:
${input.stream.focus}

User-visible behavior to prove:
${input.stream.behavior}

Public interface for this slice:
${input.stream.public_interface}

TDD target:
${input.stream.test_target}

Expected tester command:
${input.stream.verification_command}

Out of scope for this pass (do not do these here):
${input.stream.out_of_scope}

Other streams in this loop will cover:${otherStreams.length ? `\n${otherStreams.map((s) => `- ${s.id}: ${s.title}`).join("\n")}` : "\n- (none — single stream)"}
${planNotes}${repair}
Full task (shared context):
${input.task}

Rules:
${workRule}
- Implement only what belongs to this stream; do not expand into other streams' work.
- Work test-first when the repo has a suitable test seam: add or update one behavior test through the public interface, watch that path fail, then implement the smallest passing slice.
- If no suitable automated seam exists, keep the implementation minimal and leave the tester a direct verification command/evidence path.
- Do not add speculative abstractions or broad configurability beyond this stream.
- Keep the change set small and coherent for this pass.
- Use LS, Glob, or Grep to find relevant files before reading many files.
- Do not run verification commands; the tester role handles verification.
- After making the requested file edits, briefly state what changed and stop.`;
}

function buildCcTesterPrompt(task: string, loop: number, targetDir?: string, managerPlan?: CcManagerPlan): string {
  const scope = targetDir
    ? `Verify the target repository at ${targetDir} against the task.`
    : "Verify the files under ./workspace against the task.";
  let planContext = "";
  if (managerPlan?.streams?.length) {
    const streamLines = managerPlan.streams.map((s) => `- ${s.id}: ${s.title}; behavior=${s.behavior}; verify=${s.verification_command}`).join("\n");
    planContext = `Manager split this loop into developer streams:\n${streamLines}\n`;
    if (managerPlan.notes) {
      planContext += `Manager notes: ${managerPlan.notes}\n`;
    }
  }
  return `You are the tester role in a simplified cc team workflow.

Loop: ${loop}

Task:
${task}

${planContext}${scope}
Use LS, Glob, Grep, and Read for file verification.
Use Bash only for non-destructive verification commands such as typecheck, build, tests, and git diff --check.
**Verification commands must be run directly — do not pipe to 'head', 'tail', 'grep', 'sed -n', 'awk', 'cut', 'less', 'more', or similar output limiters.** Piped commands can truncate output and mask failures.
Do not install dependencies, mutate files, or run destructive shell commands.
Run the smallest relevant verification set. Once the decisive verification passes or fails, stop immediately and return the JSON decision.
When verification fails, diagnose before returning: include the exact repro command, the observed failure symptom, and the smallest likely fix area in reason.
Return JSON only with this shape:
{"status":"done"|"develop"|"ask_user","reason":"short reason"}

Use "develop" when the developer can fix the issue in another pass.
Use "ask_user" only for missing product decisions, credentials, or hard blockers.`;
}

function buildTeamLeaderPrompt(input: {
  stage: TeamStage;
  task: string;
  runDir: string;
  targetDir?: string;
  state: TeamState;
}): string {
  const target = input.targetDir
    ? `Target repository: ${input.targetDir}. Local edits are allowed, but do not commit, push, or deploy.`
    : "No target repository was provided. Implementation deliverables should stay under the run directory workspace/.";
  return `You are the team leader for cc-team-run.

Stage: ${input.stage}
Run directory: ${input.runDir}
${target}

Original user task:
${input.task}

Current team state:
${JSON.stringify(input.state, null, 2)}

Lifecycle policy:
- Keep the /spec -> /plan -> /build -> /test -> /review -> /ship rhythm.
- Ask the user only for high-impact product decisions, credentials, paid/external deployment authority, data/integration boundaries, or blockers the team cannot self-resolve.
- For ordinary low-impact details, choose popular low-cost defaults, record them in assumptions, and continue.
- Every continue decision must include one task document payload for the worker.
- The task must be complete enough that one worker can execute it without guessing.
- The task must include objective, context, inputFiles, allowedPaths, acceptanceCriteria, verificationCommand, and failureCategories.

Return JSON only matching the schema.`;
}

function buildSupervisedLeaderPrompt(input: {
  stage: TeamStage;
  task: string;
  runDir: string;
  targetDir?: string;
  state: TeamState;
  guidance: string;
}): string {
  const target = input.targetDir
    ? `Target repository: ${input.targetDir}. Edit locally only; do not commit, push, or deploy.`
    : `No target repository was provided. Put implementation deliverables under ${input.runDir}/workspace when writing product code.`;
  return `You are the leader SDK in cc-team-run supervised mode.

Stage: ${input.stage}
Run directory: ${input.runDir}
${target}

Original user task:
${input.task}

Owner guidance queued for you:
${input.guidance.trim() || "None."}

Current team state:
${JSON.stringify(input.state, null, 2)}

Instructions:
- Execute the current lifecycle stage yourself.
- Follow the full lifecycle skill guidance in your system prompt.
- Maintain a boss-readable cockpit if you edit files: ${input.runDir}/artifacts/team-cockpit.md.
- For low-impact details, choose conventional low-cost defaults and state the assumption.
- Ask the user only for high-impact decisions, credentials, data/integration boundaries, paid/external authority, or blockers you cannot resolve locally.
- Do not commit, push, deploy, purchase services, or perform externally visible actions.

Return a concise Markdown stage report with: completed work, current work, verification evidence if any, blockers, assumptions, and next step.`;
}

function buildSupervisorPrompt(input: {
  stage: TeamStage;
  task: string;
  runDir: string;
  targetDir?: string;
  state: TeamState;
  cockpit: string;
  leaderReport: string;
}): string {
  return `You are the independent supervisor SDK for cc-team-run supervised mode.

Stage: ${input.stage}
Run directory: ${input.runDir}
Target: ${input.targetDir ?? "run workspace"}

Original user task:
${input.task}

Team state:
${JSON.stringify(input.state, null, 2)}

Current cockpit document:
${input.cockpit.trim() || "No cockpit document yet."}

Latest leader report:
${input.leaderReport.trim() || "No leader report."}

Instructions:
- Inspect whether the leader can continue to the next lifecycle stage.
- Do not edit product code.
- Use NO-GO, REQUEST CHANGES, or Critical if the lifecycle must stop or rerun.
- Otherwise recommend continue, ask_user, rerun, or ship_ready.
- Call out missing machine verification, high-impact blockers, and owner decisions clearly.

Return a concise Markdown supervisor report.`;
}

function buildTeamWorkerPrompt(input: {
  stage: TeamStage;
  role: WorkerRole;
  task: TeamTask;
  runDir: string;
  targetDir?: string;
}): string {
  const scope = input.targetDir
    ? `Current directory is the target repository: ${input.targetDir}. Edit locally only; do not commit, push, or deploy.`
    : `Current directory is the run directory: ${input.runDir}. Put implementation deliverables under workspace/ when writing product code.`;
  return `You are the ${input.role} worker in cc-team-run.

Stage: ${input.stage}
Task id: ${input.task.id}
${scope}

Objective:
${input.task.objective}

Context:
${input.task.context}

Input files:
${input.task.inputFiles.map((item) => `- ${item}`).join("\n") || "- none"}

Allowed paths:
${input.task.allowedPaths.map((item) => `- ${item}`).join("\n") || "- current working directory"}

Acceptance criteria:
${input.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}

Verification command:
${input.task.verificationCommand}

Failure categories you must use if blocked:
${input.task.failureCategories.map((item) => `- ${item}`).join("\n")}

Rules:
- Complete the task document as written.
- If the task cannot be completed, say whether the defect is task_doc_defect, execution_defect, skill_context_defect, credentials, user_decision, or verification_failed.
- Do not ask the user for low-impact details; choose conventional defaults and state the assumption.
- ${input.role === "tester" ? "Run machine verification with Bash and return JSON only: {\"status\":\"done\"|\"develop\"|\"ask_user\",\"reason\":\"short reason\"}." : "Return a concise artifact/report for this stage."}
- Do not commit, push, deploy, or perform externally visible actions.`;
}

function ccDiagnosticPath(runDir: string, startedAt: string, role: CcRole): string {
  return path.join(runDir, "session-log", "inflight", `${startedAt.replaceAll(":", "-")}-${role}.json`);
}

function ccEventTracePath(runDir: string, startedAt: string, role: CcRole): string {
  return path.join(runDir, "session-log", "events", `${startedAt.replaceAll(":", "-")}-${role}.json`);
}

async function appendCcProgress(runDir: string, message: string): Promise<void> {
  const progressPath = path.join(runDir, "progress.md");
  const existing = await readTextIfExists(progressPath);
  await writeFile(progressPath, `${existing}${message}`, "utf8");
}

async function appendCcBlocker(runDir: string, reason: string): Promise<void> {
  const blockerPath = path.join(runDir, "blockers.md");
  const existing = await readTextIfExists(blockerPath);
  await writeFile(blockerPath, `${existing}${existing ? "\n" : ""}- ${reason}\n`, "utf8");
}

async function writeCcInteractionRequest(runDir: string, request: CcInteractionRequest): Promise<void> {
  await writeFile(path.join(runDir, "interaction-request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

async function writeCcQuestions(runDir: string, request: CcInteractionRequest): Promise<void> {
  const questions = Array.isArray(request.input.questions) ? request.input.questions : [];
  const lines = ["# Questions", ""];
  for (const [index, question] of questions.entries()) {
    if (question && typeof question === "object") {
      const value = question as Record<string, unknown>;
      const text = typeof value.question === "string" ? value.question : JSON.stringify(value);
      lines.push(`${index + 1}. ${text}`);
    } else {
      lines.push(`${index + 1}. ${String(question)}`);
    }
  }
  if (questions.length === 0) {
    lines.push(JSON.stringify(request.input, null, 2));
  }
  await writeFile(path.join(runDir, "questions.md"), `${lines.join("\n")}\n`, "utf8");
}

async function appendUserReply(runDir: string, reply: string): Promise<void> {
  const replyPath = path.join(runDir, "user-replies.md");
  const existing = await readTextIfExists(replyPath);
  const stamp = new Date().toISOString();
  await writeFile(replyPath, `${existing}${existing ? "\n" : ""}## ${stamp}\n\n${reply.trim()}\n`, "utf8");
}

async function appendReplyToContext(runDir: string, reply: string): Promise<void> {
  const contextPath = path.join(runDir, "context.md");
  const existing = await readTextIfExists(contextPath);
  const stamp = new Date().toISOString();
  await writeFile(contextPath, `${existing}${existing.endsWith("\n") ? "" : "\n"}\n## User Reply ${stamp}\n\n${reply.trim()}\n`, "utf8");
}

async function persistCcSpecRoleArtifacts(runDir: string, role: CcSpecRole, finalResponse: string): Promise<void> {
  const trimmed = finalResponse.trim();
  if (!trimmed) return;

  if (role === "product") {
    const productBrief = extractTaggedArtifact(trimmed, "product-brief.md");
    const decisionLog = extractTaggedArtifact(trimmed, "decision-log.md");
    if (productBrief && decisionLog) {
      await Promise.all([
        writeFile(path.join(runDir, "product-brief.md"), `${productBrief.trim()}\n`, "utf8"),
        writeFile(path.join(runDir, "decision-log.md"), `${decisionLog.trim()}\n`, "utf8"),
      ]);
      return;
    }
    // Tags not found — tolerate if files were already written by a prior tool call.
    const [existingProductBrief, existingDecisionLog] = await Promise.all([
      readTextIfExists(path.join(runDir, "product-brief.md")),
      readTextIfExists(path.join(runDir, "decision-log.md")),
    ]);
    if (!isCcSpecArtifactReady(existingProductBrief, "Product Brief") || !isCcSpecArtifactReady(existingDecisionLog, "Decision Log")) {
      throw new Error("cc-spec product response did not include product-brief.md and decision-log.md tagged artifacts");
    }
    return;
  }

  if (role === "research") {
    const researchPath = path.join(runDir, "research.md");
    const existing = await readTextIfExists(researchPath);
    if (/^#\s+Research\b/im.test(trimmed) || !isCcSpecArtifactReady(existing, "Research")) {
      await writeFile(researchPath, `${trimmed}\n`, "utf8");
    }
    return;
  }

  if (role !== "architect") return;

  const spec = extractTaggedArtifact(trimmed, "spec.md");
  const agentSpec = extractTaggedArtifact(trimmed, "agent-spec.md");
  const tasks = extractTaggedArtifact(trimmed, "tasks.md");
  if (spec && agentSpec && tasks) {
    await Promise.all([
      writeFile(path.join(runDir, "spec.md"), `${spec.trim()}\n`, "utf8"),
      writeFile(path.join(runDir, "agent-spec.md"), `${agentSpec.trim()}\n`, "utf8"),
      writeFile(path.join(runDir, "tasks.md"), `${tasks.trim()}\n`, "utf8"),
    ]);
    return;
  }
  // Tags not found — tolerate if files were already written by a prior tool call.
  const [existingSpec, existingAgentSpec, existingTasks] = await Promise.all([
    readTextIfExists(path.join(runDir, "spec.md")),
    readTextIfExists(path.join(runDir, "agent-spec.md")),
    readTextIfExists(path.join(runDir, "tasks.md")),
  ]);
  if (!isCcSpecArtifactReady(existingSpec, "Spec") || !isCcSpecArtifactReady(existingAgentSpec, "Agent Spec") || !isCcSpecArtifactReady(existingTasks, "Tasks")) {
    throw new Error("cc-spec architect response did not include spec.md, agent-spec.md, and tasks.md tagged artifacts");
  }
}

function extractTaggedArtifact(text: string, tag: "product-brief.md" | "decision-log.md" | "spec.md" | "agent-spec.md" | "tasks.md"): string | undefined {
  const start = `<${tag}>`;
  const end = `</${tag}>`;
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex < 0) return undefined;
  if (endIndex > startIndex) {
    return text.slice(startIndex + start.length, endIndex);
  }

  // Closing tag is missing (model used the wrong close tag, e.g. </spec.md> for <agent-spec.md>).
  // Use the next artifact open tag as a proxy end boundary, then strip any stray trailing close tag.
  const contentStart = startIndex + start.length;
  const artifactStarts = ["<product-brief.md>", "<decision-log.md>", "<spec.md>", "<agent-spec.md>", "<tasks.md>"]
    .map((candidate) => text.indexOf(candidate, contentStart))
    .filter((candidate) => candidate >= 0)
    .sort((a, b) => a - b);
  const fallbackEnd = artifactStarts[0] ?? text.length;
  const recovered = text
    .slice(contentStart, fallbackEnd)
    .replace(/\n?<\/(?:product-brief|decision-log|spec|agent-spec|tasks)\.md>\s*$/i, "");
  return recovered.trim() ? recovered : undefined;
}

async function rolesAfterLastInteraction(runDir: string): Promise<CcSpecRole[]> {
  const interaction = await readJsonIfExists(path.join(runDir, "interaction-request.json")) as Partial<CcInteractionRequest> | undefined;
  if (!interaction || !interaction.role || !isCcSpecRole(interaction.role)) {
    return rolesForCcSpecContinuation(runDir);
  }
  if (interaction.role === "demo") {
    const userReplies = await readTextIfExists(path.join(runDir, "user-replies.md"));
    const lastReply = userReplies.split(/^##\s+\d{4}/m).at(-1) ?? "";
    return classifyDemoReply(lastReply) === "approved"
      ? ["research", "architect", "reviewer"]
      : ["demo", "research", "architect", "reviewer"];
  }
  const index = CC_SPEC_ROLES.indexOf(interaction.role);
  if (index < 0) return rolesForCcSpecContinuation(runDir);
  return CC_SPEC_ROLES.slice(index);
}

async function rolesForCcSpecContinuation(runDir: string): Promise<CcSpecRole[]> {
  const [productBrief, decisionLog, research, spec, agentSpec, tasks] = await Promise.all([
    readTextIfExists(path.join(runDir, "product-brief.md")),
    readTextIfExists(path.join(runDir, "decision-log.md")),
    readTextIfExists(path.join(runDir, "research.md")),
    readTextIfExists(path.join(runDir, "spec.md")),
    readTextIfExists(path.join(runDir, "agent-spec.md")),
    readTextIfExists(path.join(runDir, "tasks.md")),
  ]);

  if (!isCcSpecArtifactReady(productBrief, "Product Brief") || !isCcSpecArtifactReady(decisionLog, "Decision Log")) {
    return ["product", "demo", "research", "architect", "reviewer"];
  }
  const demoReady = await isDemoArtifactReady(runDir);
  if (!demoReady) {
    return ["demo", "research", "architect", "reviewer"];
  }
  if (!isResearchArtifactReady(research)) {
    return ["research", "architect", "reviewer"];
  }
  if (!isCcSpecArtifactReady(spec, "Spec") || !isCcSpecArtifactReady(agentSpec, "Agent Spec") || !isCcSpecArtifactReady(tasks, "Tasks")) {
    return ["architect", "reviewer"];
  }
  const qualityIssues = await validateCcSpecQualityGate(runDir);
  if (qualityIssues.some((issue) => /^(spec\.md|agent-spec\.md|tasks\.md)/.test(issue))) {
    return ["architect", "reviewer"];
  }
  return ["reviewer"];
}

function isCcSpecArtifactReady(text: string, title: string): boolean {
  const normalized = text.trim().replace(/\r\n/g, "\n");
  if (!normalized) return false;
  if (normalized === `# ${title}\n\nPending.`) return false;
  return normalized.length >= 32;
}

async function isDemoArtifactReady(runDir: string): Promise<boolean> {
  const content = await readTextIfExists(path.join(runDir, "demo.html"));
  return content.length >= 512 && content.includes("<html");
}

function isResearchArtifactReady(text: string): boolean {
  return isCcSpecArtifactReady(text, "Research") && validateResearchArtifact(text).length === 0;
}

function classifyDemoReply(reply: string): "approved" | "changes_requested" {
  const text = reply.trim();
  if (!text) return "changes_requested";
  const hasChangeSignal = /\b(but|except|change|changes|adjust|revise|update|add|addition|different|instead)\b|但是|但|不过|修改|调整|改成|改为|增加|补充|不要|希望|需要/i.test(text);
  if (hasChangeSignal) return "changes_requested";
  const hasApprovalSignal = /\b(approved|approve|looks good|lgtm|ship it|proceed|continue|yes|yep|ok|okay)\b|通过|继续|可以|就这样|没问题|符合/i.test(text);
  return hasApprovalSignal ? "approved" : "changes_requested";
}

async function validateCcSpecQualityGate(runDir: string): Promise<string[]> {
  const [productBrief, decisionLog, research, spec, agentSpec, tasks, demoHtml] = await Promise.all([
    readTextIfExists(path.join(runDir, "product-brief.md")),
    readTextIfExists(path.join(runDir, "decision-log.md")),
    readTextIfExists(path.join(runDir, "research.md")),
    readTextIfExists(path.join(runDir, "spec.md")),
    readTextIfExists(path.join(runDir, "agent-spec.md")),
    readTextIfExists(path.join(runDir, "tasks.md")),
    readTextIfExists(path.join(runDir, "demo.html")),
  ]);
  const artifacts = { productBrief, decisionLog, research, spec, agentSpec, tasks };
  const issues: string[] = [];

  if (!demoHtml || demoHtml.length < 512) {
    issues.push("demo.html is missing or empty — demo role must produce a working UI mockup");
  }

  const requiredArtifacts: Array<[keyof typeof artifacts, string, string, RegExp[]]> = [
    ["productBrief", "product-brief.md", "Product Brief", [/primary user|target user|用户/i, /job-to-be-done|JTBD|核心需求/i, /MVP|loop|闭环/i, /acceptance|验收/i, /risk|风险/i]],
    ["decisionLog", "decision-log.md", "Decision Log", [/confirmed|已确认/i, /assumptions?|假设/i, /ask[_ -]?user|询问用户|open question|user.*(?:input|reply|decision)|explicit user/i]],
    ["spec", "spec.md", "Spec", [/功能|functionality|feature|command|operation|workflows?|核心流程|用户流程|MVP Scope/i, /技术|stack|architecture|架构/i, /验收|acceptance|acceptance criteria|criteria|verification|验证|milestone/i]],
    ["agentSpec", "agent-spec.md", "Agent Spec", [/functional|功能|api|contract|endpoint|target|integration/i, /constraint|约束/i, /test|测试/i, /boundar|边界/i]],
    ["tasks", "tasks.md", "Tasks", [TASK_ID_PATTERN, /verify|验证|test|测试/i]],
  ];

  for (const [key, fileName, title, patterns] of requiredArtifacts) {
    if (!isCcSpecArtifactReady(artifacts[key], title)) {
      issues.push(`${fileName} is missing or still pending`);
      continue;
    }
    for (const pattern of patterns) {
      if (!pattern.test(artifacts[key])) {
        issues.push(`${fileName} is missing required signal ${pattern.source}`);
        break;
      }
    }
  }

  issues.push(...validateResearchArtifact(artifacts.research).map((issue) => `research.md ${issue}`));
  issues.push(...validateAgentSpecArtifact(artifacts.agentSpec).map((issue) => `agent-spec.md ${issue}`));
  issues.push(...validateAgentSpecCompleteness(artifacts.agentSpec));
  issues.push(...validateTasksVerification(artifacts.tasks));
  issues.push(...validateTasksVerticalSlices(artifacts.tasks));
  return issues;
}

function validateResearchArtifact(research: string): string[] {
  const text = research.trim();
  const issues: string[] = [];
  if (!isCcSpecArtifactReady(text, "Research")) {
    issues.push("is missing or still pending");
    return issues;
  }
  if (/based on my knowledge/i.test(text)) {
    issues.push("must not rely on model memory; use sourced research or state no external sources");
  }
  const declaresNoExternalSources = /\b(no|none)\b.{0,40}\b(external|dependency|dependencies|source|sources|integration|integrations|research)\b/i.test(text);
  const hasSourceUrl = /https?:\/\//i.test(text);
  if (!hasSourceUrl && !declaresNoExternalSources) {
    issues.push("must include source URLs or explicitly state no external sources are needed");
  }
  if (hasSourceUrl && !/\b(official|registry|source repository|unofficial)\b/i.test(text)) {
    issues.push("must classify sources as official, registry, source repository, or unofficial");
  }
  if (!declaresNoExternalSources && requiresResearchVersionCoverage(text) && !/\b(version|stable version|latest version|v\d+\.\d+|\d+\.\d+\.\d+)\b/i.test(text)) {
    issues.push("must record stable versions for recommended packages or APIs");
  }
  if (!declaresNoExternalSources && requiresResearchLicenseCoverage(text) && !/\blicense\b/i.test(text)) {
    issues.push("must record licenses for recommended direct dependencies");
  }
  return issues;
}

function requiresResearchVersionCoverage(text: string): boolean {
  return /\b(npmjs\.com|package|packages|sdk|api|registry|github\.com|integration|integrate)\b/i.test(text);
}

function requiresResearchLicenseCoverage(text: string): boolean {
  return /\b(npmjs\.com|package|packages|sdk|dependency|dependencies|github\.com|direct dependenc)\b/i.test(text);
}

function validateAgentSpecArtifact(agentSpec: string): string[] {
  const issues: string[] = [];
  if (/userId\s*(硬编码|hardcoded|hard-coded|hard code)|硬编码\s*userId/i.test(agentSpec)) {
    issues.push("must forbid hardcoded userId and require session-derived user identity");
  }
  if (/userId[^。\n]*硬编码[^。\n]*(?:或|or)[^。\n]*session/i.test(agentSpec)) {
    issues.push("must not present hardcoded userId as an acceptable alternative to session checks");
  }
  return issues;
}

function validateAgentSpecCompleteness(agentSpec: string): string[] {
  const signals: Array<[RegExp, string]> = [
    [/##\s*(?:\d+[\).]?\s*)?(api contracts?|endpoints?|routes?)/i, "agent-spec.md must include an ## API Contracts section"],
    [/##\s*(?:\d+[\).]?\s*)?(data model|entities?|schema)/i, "agent-spec.md must include a ## Data Model section"],
    [/error|exception|fail|4\d\d|5\d\d/i, "agent-spec.md must include error handling coverage"],
    [/given|when.*then|test (case|scenario)/i, "agent-spec.md must include structured test scenarios"],
    [/##\s*(?:\d+[\).]?\s*)?(ui state inventory|ui states?|screen states?|state inventory)/i, "agent-spec.md must include a ## UI State Inventory section"],
    [/##\s*(?:\d+[\).]?\s*)?(tdd plan|test-driven plan|test first plan)/i, "agent-spec.md must include a ## TDD Plan section"],
    [/##\s*(?:\d+[\).]?\s*)?(diagnosis plan|diagnostic plan|debugging plan)/i, "agent-spec.md must include a ## Diagnosis Plan section"],
    [/##\s*(?:\d+[\).]?\s*)?(verification surface|acceptance surface|public verification surface)/i, "agent-spec.md must include a ## Verification Surface section"],
  ];
  return signals.filter(([re]) => !re.test(agentSpec)).map(([, msg]) => msg);
}

function validateTasksVerification(tasks: string): string[] {
  const taskCount = (tasks.match(/\bT\d+(?:\.\d+)?\b/gi) ?? []).length;
  const verifyCount = (tasks.match(/verify\s*:/gi) ?? []).length;
  const hasVerifyTableColumn = /^\|[^\n]*\bverify\b[^\n]*\|/im.test(tasks);
  const tableVerifyRows = hasVerifyTableColumn
    ? tasks.split("\n").filter((line) => {
      if (!/^\|\s*T\d+(?:\.\d+)?\s*\|/i.test(line)) return false;
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      const verifyCell = cells.at(-1) ?? "";
      return verifyCell.length > 0 && !/^(n\/a|none|tbd|pending)$/i.test(verifyCell);
    }).length
    : 0;
  if (taskCount > 1 && verifyCount < 2) {
    if (tableVerifyRows < 2) {
      return ["tasks.md: each task should have an inline verification command (verify:) or a verify table column with per-task checks"];
    }
  }
  return [];
}

function validateTasksVerticalSlices(tasks: string): string[] {
  const taskIds = tasks.match(/\bT\d+(?:\.\d+)?\b/gi) ?? [];
  if (taskIds.length <= 1) return [];

  const issues: string[] = [];
  const taskLines = tasks.split("\n").filter((line) => /\bT\d+(?:\.\d+)?\b/i.test(line));
  const unclassifiedTask = taskLines.some((line) => !/\b(?:AFK|HITL)\b/i.test(line));
  if (taskLines.length > 0 && unclassifiedTask) {
    issues.push("tasks.md must classify each vertical slice as HITL or AFK");
  }

  const horizontalLayerPattern = /\b(?:frontend|backend|api|database|db|schema|components?|tests?)\s+(?:layer|only)\b|\b(?:build|implement|add)\s+(?:the\s+)?(?:frontend|backend|api|database|db|schema|components?|tests?)\b/i;
  if (horizontalLayerPattern.test(tasks) && !/\b(?:end-to-end|vertical slice|user can|user-visible|through the public interface|complete flow)\b/i.test(tasks)) {
    issues.push("tasks.md must use vertical slices, not horizontal layer tasks");
  }

  if (!/\b(?:behavior|user can|user-visible|end-to-end|complete flow|slice)\b/i.test(tasks)) {
    issues.push("tasks.md must describe the behavior each vertical slice proves");
  }

  return issues;
}

async function buildTaskFromSpec(specDir: string): Promise<string> {
  const [agentSpec, tasks, specMd] = await Promise.all([
    readTextIfExists(path.join(specDir, "agent-spec.md")),
    readTextIfExists(path.join(specDir, "tasks.md")),
    readTextIfExists(path.join(specDir, "spec.md")),
  ]);
  if (!agentSpec || agentSpec.includes("Pending.")) {
    throw new Error(`cc-run --spec-dir: agent-spec.md not found or still pending in ${specDir}`);
  }
  if (!tasks || tasks.includes("Pending.")) {
    throw new Error(`cc-run --spec-dir: tasks.md not found or still pending in ${specDir}`);
  }
  const parts = [
    "# Development Task",
    "",
    "Implement the following spec. Work inside ./workspace unless agent-spec.md specifies existing-repo integration boundaries.",
    "",
  ];
  if (specMd && !specMd.includes("Pending.")) {
    parts.push("## User-Facing Spec", "", specMd.trim(), "", "---", "");
  }
  parts.push("## Agent Spec (Implementation Contract)", "", agentSpec.trim(), "", "---", "", "## Tasks", "", tasks.trim());
  return parts.join("\n");
}

function buildCcSpecContext(mode: CcSpecMode, targetSummary: string): string {
  return `# Context

Mode: ${mode}

## Target Repository

${targetSummary || "No target repository was provided."}
`;
}

function readCcSpecModeFromContext(context: string): CcSpecMode | undefined {
  const match = context.match(/^Mode:\s*(new|change)\s*$/m);
  return match?.[1] === "new" || match?.[1] === "change" ? match[1] : undefined;
}

function createEmptySpecRoleTurns(): Record<CcSpecRole, number> {
  return {
    intake: 0,
    product: 0,
    demo: 0,
    research: 0,
    architect: 0,
    reviewer: 0,
  };
}

function isCcSpecRole(role: CcRole): role is CcSpecRole {
  return (CC_SPEC_ROLES as readonly string[]).includes(role);
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function readJsonIfExists(filePath: string): Promise<unknown | undefined> {
  const text = await readTextIfExists(filePath);
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function summarizeTargetRepository(targetDir: string): Promise<string> {
  const entries = await readdir(targetDir, { withFileTypes: true });
  const names = entries
    .map((entry) => entry.name)
    .filter((name) => ![".git", "node_modules", "dist", "build", "runs"].includes(name))
    .sort();
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ![".git", "node_modules", "dist", "build", "runs"].includes(name))
    .sort();
  const lines = [`Path: ${targetDir}`];
  if (directories.length > 0) {
    lines.push(`Directories: ${directories.map((name) => `${name}/`).join(", ")}`);
  }
  if (names.length > 0) {
    lines.push(`Top-level entries: ${names.join(", ")}`);
  }

  const [packageJson, readme, docSignals] = await Promise.all([
    readTextIfExists(path.join(targetDir, "package.json")),
    firstExistingReadme(targetDir),
    summarizeDocs(targetDir),
  ]);
  if (packageJson) appendPackageSummary(lines, packageJson);
  if (readme) lines.push(`README: ${firstNonEmptyLine(readme)}`);
  if (docSignals) lines.push(docSignals);

  return lines.join("\n");
}

function appendPackageSummary(lines: string[], packageJson: string): void {
  try {
    const parsed = JSON.parse(packageJson) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (parsed.scripts) {
      for (const key of ["build", "test", "typecheck", "lint"]) {
        const value = parsed.scripts[key];
        if (typeof value === "string") {
          lines.push(`${key}: ${value}`);
        }
      }
    }
    const dependencies = Object.keys(parsed.dependencies ?? {}).slice(0, 12);
    const devDependencies = Object.keys(parsed.devDependencies ?? {}).slice(0, 12);
    if (dependencies.length > 0) lines.push(`Dependencies: ${dependencies.join(", ")}`);
    if (devDependencies.length > 0) lines.push(`Dev dependencies: ${devDependencies.join(", ")}`);
  } catch {
    lines.push("package.json: present but could not be parsed");
  }
}

async function firstExistingReadme(targetDir: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "README"]) {
    const content = await readTextIfExists(path.join(targetDir, name));
    if (content) return content;
  }
  return "";
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

async function summarizeDocs(targetDir: string): Promise<string> {
  const docsDir = path.join(targetDir, "docs");
  try {
    const docsStat = await stat(docsDir);
    if (!docsStat.isDirectory()) return "";
    const docs = (await readdir(docsDir)).filter((entry) => entry.endsWith(".md")).sort().slice(0, 8);
    return docs.length > 0 ? `Docs: ${docs.join(", ")}` : "Docs: present";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function firstAskUserInteraction(requests: CcInteractionRequest[]): CcInteractionRequest | undefined {
  return requests.find((request) => request.type === "ask_user");
}

function summarizeCcInteraction(request: CcInteractionRequest): string {
  const title = request.title ?? request.displayName ?? request.toolName;
  return `${request.role} requested user input via ${request.toolName}: ${title}`;
}

function diagnoseCcEvent(event: unknown): { classification: string; detail: string } {
  const type = readStringProperty(event, "type");
  const subtype = readStringProperty(event, "subtype");
  if (type === "system" && subtype === "init") return { classification: "session_started", detail: "Claude Code SDK session started." };
  if (type === "system" && subtype === "api_retry") return { classification: "api_retry", detail: "Claude Code SDK reported an API retry." };
  if (type === "system" && subtype === "status") return { classification: "status", detail: `Claude Code SDK status: ${readStringProperty(event, "status") ?? "unknown"}.` };
  if (type === "system" && subtype === "notification") return { classification: "notification", detail: readStringProperty(event, "text") ?? "Claude Code SDK emitted a notification." };
  if (type === "system" && subtype === "hook_started") return { classification: "hook_started", detail: `Hook started: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "system" && subtype === "hook_progress") return { classification: "hook_progress", detail: `Hook progress: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "system" && subtype === "hook_response") return { classification: "hook_response", detail: `Hook finished: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "stream_event") return diagnoseCcStreamEvent(event);
  if (type === "tool_progress") {
    return {
      classification: "tool_progress",
      detail: `${readStringProperty(event, "tool_name") ?? "Tool"} is running for ${readNumberProperty(event, "elapsed_time_seconds") ?? 0}s.`,
    };
  }
  if (type === "tool_use_summary") return { classification: "tool_summary", detail: readStringProperty(event, "summary") ?? "Claude Code SDK summarized tool use." };
  if (type === "auth_status") return { classification: "auth_status", detail: readStringProperty(event, "error") ?? "Claude Code SDK authentication status changed." };
  if (type === "rate_limit_event") return { classification: "rate_limit", detail: "Claude Code SDK rate-limit status changed." };
  if (type === "assistant" && hasAssistantToolUse(event)) return { classification: "tool_requested", detail: "Assistant requested a tool call." };
  if (type === "assistant") return { classification: "assistant_message", detail: "Assistant produced content." };
  if (type === "user") return { classification: "tool_result", detail: "Tool result was returned to the assistant." };
  if (type === "result" && subtype === "success") return { classification: "turn_completed", detail: "Claude Code SDK returned a successful result." };
  if (type === "result") return { classification: "turn_finished", detail: `Claude Code SDK returned result subtype ${subtype ?? "unknown"}.` };
  return { classification: "cc_event", detail: `Claude Code SDK event: ${type ?? "unknown"}.` };
}

function diagnoseCcStreamEvent(event: unknown): { classification: string; detail: string } {
  const streamEvent = readObjectProperty(event, "event");
  const eventType = readStringProperty(streamEvent, "type");
  if (eventType === "content_block_start") {
    const contentBlock = readObjectProperty(streamEvent, "content_block");
    if (readStringProperty(contentBlock, "type") === "tool_use") {
      return { classification: "tool_input_streaming", detail: `Claude is preparing ${readStringProperty(contentBlock, "name") ?? "a tool"} input.` };
    }
  }
  if (eventType === "content_block_delta") {
    const delta = readObjectProperty(streamEvent, "delta");
    if (readStringProperty(delta, "type") === "text_delta") {
      return { classification: "text_streaming", detail: "Claude is streaming text." };
    }
    if (readStringProperty(delta, "type") === "input_json_delta") {
      return { classification: "tool_input_streaming", detail: "Claude is streaming tool input." };
    }
  }
  return { classification: "stream_event", detail: `Claude Code SDK stream event: ${eventType ?? "unknown"}.` };
}

function shouldAppendCcProgress(classification: string): boolean {
  return [
    "api_retry",
    "auth_status",
    "hook_response",
    "notification",
    "rate_limit",
    "session_started",
    "status",
    "tool_input_streaming",
    "tool_progress",
    "tool_requested",
    "tool_summary",
    "turn_completed",
  ].includes(classification);
}

function hasAssistantToolUse(event: unknown): boolean {
  const content = readMessageContent(event);
  return content.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "tool_use");
}

function extractCcFinalResponse(event: unknown): string | undefined {
  if (readStringProperty(event, "type") === "result") {
    const structuredOutput = readUnknownProperty(event, "structured_output");
    if (structuredOutput !== undefined) {
      return JSON.stringify(structuredOutput);
    }
    return readStringProperty(event, "result");
  }
  const text = readMessageContent(event)
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? (item as { text?: unknown }).text
      : undefined)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  return text || undefined;
}

function readMessageContent(event: unknown): unknown[] {
  if (!event || typeof event !== "object") return [];
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function readStringProperty(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberProperty(event: unknown, key: string): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function readObjectProperty(event: unknown, key: string): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readUnknownProperty(event: unknown, key: string): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>)[key];
}

function formatCcEventType(event: unknown): string | undefined {
  const type = readStringProperty(event, "type");
  const subtype = readStringProperty(event, "subtype");
  if (subtype) return `${type}.${subtype}`;
  if (type === "stream_event") {
    const streamEvent = readObjectProperty(event, "event");
    const eventType = readStringProperty(streamEvent, "type");
    return eventType ? `${type}.${eventType}` : type;
  }
  return type;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
