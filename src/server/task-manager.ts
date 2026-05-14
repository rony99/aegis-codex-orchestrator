import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Response } from "express";
import { createRunDirectory } from "../codex-team/driver.js";
import { createSqliteTaskStore, type StoredTaskWorkflow, type StoredTeamMode, type TaskEventRecord, type TaskGuidanceRecord, type TaskRecord, type TaskStore } from "./task-store.js";

const DEFAULT_RUNS_DIR = path.resolve(process.cwd(), "runs");
const CLI_PATH = path.resolve(process.cwd(), "dist", "cli.js");

export type TaskStatus = "queued" | "running" | "done" | "ask_user" | "max_loops_reached" | "failed" | "stopped" | "unknown";

export interface Task {
  id: string;
  runDir: string;
  workflow: StoredTaskWorkflow;
  teamMode?: StoredTeamMode;
  status: TaskStatus;
  description: string;
  createdAt: string;
  targetDir?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  terminalRole?: string;
  failureCategory?: string;
  currentStage?: string;
  recommendedAction?: string;
}

interface ActiveTask {
  id: string;
  runDir: string;
  process: TaskProcess;
}

type TaskProcess = Pick<ReturnType<typeof spawn>, "on" | "kill">;
type TaskProcessRunner = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => TaskProcess;

export interface TaskDiagnostic {
  role: string;
  model: string;
  threadId: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  lastUpdatedAt: string;
  lastEventAt: string;
  idleMs: number;
  classification: string;
  detail: string;
  lastEventType?: string;
  lastItem?: unknown;
}

export interface TaskDashboardSummary {
  currentStage?: string;
  recommendedAction?: string;
  latestBlocker?: string;
  ownerGuidance?: string;
  supervisorSummary?: string;
  cockpitSource: "cockpit" | "fallback";
}

const activeTasks = new Map<string, ActiveTask>();
let taskProcessRunner: TaskProcessRunner = (command, args, options) => spawn(command, args, options);
const storeCache = new Map<string, TaskStore>();

export function setTaskProcessRunnerForTest(runner: TaskProcessRunner): void {
  taskProcessRunner = runner;
}

export function resetTaskManagerForTest(): void {
  activeTasks.clear();
  for (const store of storeCache.values()) {
    store.close();
  }
  storeCache.clear();
  taskProcessRunner = (command, args, options) => spawn(command, args, options);
}

function getStore(dbPath?: string): TaskStore {
  const key = dbPath ?? "__default__";
  let store = storeCache.get(key);
  if (!store) {
    store = createSqliteTaskStore(dbPath);
    storeCache.set(key, store);
  }
  return store;
}

function taskIdToRunDir(taskId: string, runsDir: string): string {
  return path.join(runsDir, taskId);
}

function createdAtFromTaskId(taskId: string): string {
  const match = taskId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z(?:-\d+)?$/);
  if (!match) return new Date().toISOString();

  const [, date, hours, minutes, seconds, milliseconds = "000"] = match;
  const parsed = new Date(`${date}T${hours}:${minutes}:${seconds}.${milliseconds}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function descriptionFromTaskFile(content: string): string {
  return content.replace(/^# Task\s*/, "").trim();
}

function normalizeTaskStatus(status: unknown): TaskStatus {
  return status === "queued"
    || status === "running"
    || status === "done"
    || status === "ask_user"
    || status === "max_loops_reached"
    || status === "failed"
    || status === "stopped"
    || status === "unknown"
    ? status
    : "unknown";
}

function normalizeWorkflow(workflow: unknown): StoredTaskWorkflow {
  return workflow === "cc-team-run" ? "cc-team-run" : "run";
}

function normalizeTeamMode(teamMode: unknown): StoredTeamMode | undefined {
  if (teamMode === "supervised" || teamMode === "multi-role") return teamMode;
  return undefined;
}

function taskFromRecord(record: TaskRecord): Task {
  return {
    id: record.id,
    runDir: record.runDir,
    workflow: record.workflow,
    teamMode: record.teamMode,
    status: normalizeTaskStatus(record.status),
    description: record.description,
    targetDir: record.targetDir,
    model: record.model,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    reason: record.reason,
    terminalRole: record.terminalRole,
    failureCategory: record.failureCategory,
    currentStage: record.currentStage,
    recommendedAction: record.recommendedAction,
  };
}

async function loadTaskFromRunDir(taskId: string, runDir: string, store: TaskStore): Promise<Task | undefined> {
  let description = "";

  try {
    description = descriptionFromTaskFile(await readFile(path.join(runDir, "task.md"), "utf8"));
  } catch {
    return undefined;
  }

  const task: Task = {
    id: taskId,
    runDir,
    workflow: "run",
    status: "unknown",
    description,
    createdAt: createdAtFromTaskId(taskId),
  };

  try {
    const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8")) as {
      status?: unknown;
      workflow?: unknown;
      teamMode?: unknown;
      reason?: string;
      terminalRole?: string;
      failureCategory?: string;
      startedAt?: string;
      endedAt?: string;
      targetDir?: string;
      model?: string;
      currentStage?: string;
      recommendedAction?: string;
    };

    task.workflow = normalizeWorkflow(summary.workflow);
    task.teamMode = normalizeTeamMode(summary.teamMode);
    task.status = normalizeTaskStatus(summary.status);
    task.reason = summary.reason;
    task.terminalRole = summary.terminalRole;
    task.failureCategory = summary.failureCategory;
    task.targetDir = summary.targetDir;
    task.model = summary.model;
    task.currentStage = summary.currentStage;
    task.recommendedAction = summary.recommendedAction;
    task.startedAt = summary.startedAt;
    task.endedAt = summary.endedAt;
  } catch {
    // A run with task.md but no summary is either still being written or incomplete.
  }

  store.upsertTask(task);
  return task;
}

async function loadTasksFromRunsDir(runsDir: string, store: TaskStore): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const existing = store.getTask(entry.name);
    if (existing && isTaskInRunsDir(existing, runsDir)) continue;
    await loadTaskFromRunDir(entry.name, taskIdToRunDir(entry.name, runsDir), store);
  }
}

export async function createTask(
  description: string,
  options: {
    workflow?: StoredTaskWorkflow;
    teamMode?: StoredTeamMode;
    model?: string;
    maxLoops?: number;
    skipDiscovery?: boolean;
    monitorSdk?: boolean;
    runsDir?: string;
    targetDir?: string;
    dbPath?: string;
  } = {}
): Promise<Task> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const store = getStore(options.dbPath);
  const runDir = await createRunDirectory(runsDir);
  const taskId = path.basename(runDir);
  const workflow = options.workflow ?? "cc-team-run";

  const taskMdPath = path.join(runDir, "task.md");
  await writeFile(taskMdPath, `# Task

${description}
`, "utf8");

  const task: Task = {
    id: taskId,
    runDir,
    workflow,
    teamMode: workflow === "cc-team-run" ? options.teamMode ?? "supervised" : undefined,
    status: "queued",
    description,
    targetDir: options.targetDir ? path.resolve(options.targetDir) : undefined,
    model: options.model,
    createdAt: new Date().toISOString(),
  };

  store.upsertTask(task);

  startTask(taskId, {
    workflow,
    teamMode: task.teamMode,
    model: options.model,
    maxLoops: options.maxLoops,
    skipDiscovery: options.skipDiscovery,
    monitorSdk: options.monitorSdk,
    runsDir,
    taskFile: taskMdPath,
    targetDir: task.targetDir,
    dbPath: options.dbPath,
  });

  return task;
}

function startTask(
  taskId: string,
  options: {
    workflow?: StoredTaskWorkflow;
    teamMode?: StoredTeamMode;
    model?: string;
    maxLoops?: number;
    skipDiscovery?: boolean;
    monitorSdk?: boolean;
    runsDir: string;
    taskFile?: string;
    replyFile?: string;
    targetDir?: string;
    dbPath?: string;
  }
): void {
  const store = getStore(options.dbPath);
  const task = store.getTask(taskId);
  if (!task) return;

  const workflow = options.workflow ?? task.workflow ?? "run";
  const args = workflow === "cc-team-run"
    ? [
      CLI_PATH,
      "cc-team-run",
      ...(options.taskFile ? ["--task", options.taskFile] : []),
      "--run-dir",
      task.runDir,
    ]
    : [
      CLI_PATH,
      "run",
      "--task",
      options.taskFile ?? path.join(task.runDir, "task.md"),
      "--run-dir",
      task.runDir,
    ];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (workflow === "cc-team-run" && options.targetDir) {
    args.push("--target", options.targetDir);
  }
  if (workflow === "cc-team-run" && (options.teamMode ?? task.teamMode)) {
    args.push("--team-mode", options.teamMode ?? task.teamMode ?? "supervised");
  }
  if (workflow === "cc-team-run" && options.replyFile) {
    args.push("--reply", options.replyFile);
  }
  if (options.maxLoops) {
    args.push("--max-loops", String(options.maxLoops));
  }
  if (workflow === "run" && options.skipDiscovery) {
    args.push("--skip-discovery");
  }
  if (workflow === "run" && options.monitorSdk === false) {
    args.push("--skip-sdk-monitor");
  }

  store.updateTask(taskId, {
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: undefined,
    reason: undefined,
  });

  const child = taskProcessRunner(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  activeTasks.set(taskId, {
    id: taskId,
    runDir: task.runDir,
    process: child,
  });

  child.on("exit", async () => {
    activeTasks.delete(taskId);
    await refreshTaskStatus(taskId, { dbPath: options.dbPath });
  });

  child.on("error", async () => {
    activeTasks.delete(taskId);
    store.updateTask(taskId, {
      status: "failed",
      endedAt: new Date().toISOString(),
      reason: "Failed to start task process",
    });
  });
}

export async function getTask(
  taskId: string,
  options: { runsDir?: string; dbPath?: string } = {}
): Promise<Task | undefined> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const store = getStore(options.dbPath);
  let task = store.getTask(taskId);
  if (task && !isTaskInRunsDir(task, runsDir)) {
    task = undefined;
  }
  if (!task) {
    task = await loadTaskFromRunDir(taskId, taskIdToRunDir(taskId, runsDir), store);
  }
  if (!task) return undefined;

  if (task.status === "running") {
    await refreshTaskStatus(taskId, { dbPath: options.dbPath });
  }

  const refreshed = store.getTask(taskId);
  return refreshed ? taskFromRecord(refreshed) : undefined;
}

function isTaskInRunsDir(task: TaskRecord, runsDir: string): boolean {
  const prefix = `${path.resolve(runsDir)}${path.sep}`;
  return path.resolve(task.runDir).startsWith(prefix);
}

async function refreshTaskStatus(taskId: string, options: { dbPath?: string } = {}): Promise<void> {
  const store = getStore(options.dbPath);
  const task = store.getTask(taskId);
  if (!task) return;

  if (activeTasks.has(taskId)) {
    store.updateTask(taskId, { status: "running" });
    return;
  }

  const summaryPath = path.join(task.runDir, "run-summary.json");
  try {
    const summaryContent = await readFile(summaryPath, "utf8");
    const summary = JSON.parse(summaryContent) as {
      status: unknown;
      workflow?: unknown;
      teamMode?: unknown;
      reason?: string;
      terminalRole?: string;
      failureCategory?: string;
      startedAt?: string;
      endedAt?: string;
      targetDir?: string;
      model?: string;
      currentStage?: string;
      recommendedAction?: string;
    };

    store.updateTask(taskId, {
      workflow: normalizeWorkflow(summary.workflow),
      teamMode: normalizeTeamMode(summary.teamMode) ?? task.teamMode,
      status: normalizeTaskStatus(summary.status),
      reason: summary.reason,
      terminalRole: summary.terminalRole,
      failureCategory: summary.failureCategory,
      targetDir: summary.targetDir,
      model: summary.model,
      currentStage: summary.currentStage,
      recommendedAction: summary.recommendedAction,
      startedAt: summary.startedAt ?? task.startedAt,
      endedAt: summary.endedAt ?? task.endedAt,
    });
  } catch {
    if (task.status === "queued") {
      store.updateTask(taskId, { status: "unknown" });
    }
  }
}

export async function listTasks(
  options: { limit?: number; runsDir?: string; workflow?: StoredTaskWorkflow; status?: TaskStatus; dbPath?: string } = {}
): Promise<Task[]> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const store = getStore(options.dbPath);
  await loadTasksFromRunsDir(runsDir, store);

  for (const task of store.listTasks({ runsDir })) {
    const taskId = task.id;
    if (activeTasks.has(taskId)) {
      store.updateTask(taskId, { status: "running" });
    } else {
      await refreshTaskStatus(taskId, { dbPath: options.dbPath });
    }
  }

  return store.listTasks({
    runsDir,
    workflow: options.workflow,
    status: options.status,
    limit: options.limit,
  }).map(taskFromRecord);
}

export async function getTaskDetails(
  taskId: string,
  options: { runsDir?: string; dbPath?: string } = {}
): Promise<{
  task: Task;
  progress?: {
    status: string;
    lastRole: string;
    loop: number;
    terminal: boolean;
    reason?: string;
  };
  log?: string;
  blockers?: string;
  spec?: string;
  summary?: unknown;
  teamState?: unknown;
  workerRegistry?: unknown;
  artifacts?: Record<string, string>;
  cockpitMarkdown?: string;
  dashboardSummary?: TaskDashboardSummary;
  events?: TaskEventRecord[];
  guidance?: TaskGuidanceRecord[];
  diagnostic?: TaskDiagnostic;
} | undefined> {
  const task = await getTask(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!task) return undefined;

  const result: {
    task: Task;
    progress?: {
      status: string;
      lastRole: string;
      loop: number;
      terminal: boolean;
      reason?: string;
    };
    log?: string;
    blockers?: string;
    spec?: string;
    summary?: unknown;
    teamState?: unknown;
    workerRegistry?: unknown;
    artifacts?: Record<string, string>;
    cockpitMarkdown?: string;
    dashboardSummary?: TaskDashboardSummary;
    events?: TaskEventRecord[];
    guidance?: TaskGuidanceRecord[];
    diagnostic?: TaskDiagnostic;
  } = { task };

  const progressPath = path.join(task.runDir, "progress.md");
  try {
    const progressContent = await readFile(progressPath, "utf8");
    const stateMatch = progressContent.match(
      /<!-- codex-gtd:progress-state:start -->([\s\S]*?)<!-- codex-gtd:progress-state:end -->/
    );
    if (stateMatch) {
      try {
        result.progress = JSON.parse(stateMatch[1].trim());
      } catch {
        // Ignore parse errors
      }
    }
    result.log = progressContent;
  } catch {
    // Ignore missing files
  }

  const blockersPath = path.join(task.runDir, "blockers.md");
  try {
    result.blockers = await readFile(blockersPath, "utf8");
  } catch {
    // Ignore missing files
  }

  const specPath = path.join(task.runDir, "spec.md");
  try {
    result.spec = await readFile(specPath, "utf8");
  } catch {
    // Ignore missing files
  }

  const summaryPath = path.join(task.runDir, "run-summary.json");
  try {
    const summaryContent = await readFile(summaryPath, "utf8");
    result.summary = JSON.parse(summaryContent);
  } catch {
    // Ignore missing files
  }

  const teamStatePath = path.join(task.runDir, "team-state.json");
  try {
    result.teamState = JSON.parse(await readFile(teamStatePath, "utf8"));
  } catch {
    // Ignore missing or malformed team state.
  }

  const workerRegistryPath = path.join(task.runDir, "worker-registry.json");
  try {
    result.workerRegistry = JSON.parse(await readFile(workerRegistryPath, "utf8"));
  } catch {
    // Ignore missing or malformed registry.
  }

  result.artifacts = await readArtifactFiles(path.join(task.runDir, "artifacts"));
  const cockpitFromArtifact = result.artifacts["team-cockpit.md"];
  result.cockpitMarkdown = cockpitFromArtifact || await buildFallbackCockpitMarkdown(task, result.teamState, result.summary);
  const store = getStore(options.dbPath);
  result.events = store.listEvents(taskId);
  result.guidance = store.listGuidance(taskId);
  result.dashboardSummary = buildDashboardSummary(task, {
    teamState: result.teamState,
    cockpitSource: cockpitFromArtifact ? "cockpit" : "fallback",
    supervisorReport: result.artifacts["supervisor-report.md"],
    guidance: result.guidance,
  });

  result.diagnostic = await readLatestInflightDiagnostic(task.runDir);

  return result;
}

export async function replyToTask(
  taskId: string,
  reply: string,
  options: { runsDir?: string; dbPath?: string } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskDetails>>>> {
  const trimmedReply = reply.trim();
  if (!trimmedReply) {
    throw new Error("Reply is required");
  }

  const store = getStore(options.dbPath);
  const task = await getTask(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  if (task.status !== "ask_user") {
    throw new Error(`Task ${taskId} is not waiting for user input`);
  }

  const now = new Date().toISOString();
  store.recordReply(taskId, trimmedReply, now);
  const blockers = await readOptionalFile(path.join(task.runDir, "blockers.md"));
  const repliesPath = path.join(task.runDir, "user-replies.md");
  const existingReplies = await readOptionalFile(repliesPath);
  const nextReplies = `${existingReplies.trimEnd() || "# User Replies"}\n\n## Reply ${now}\n\n${trimmedReply}\n`;
  await writeFile(repliesPath, nextReplies, "utf8");
  const replyFilePath = path.join(task.runDir, `reply-${now.replaceAll(":", "-")}.md`);
  await writeFile(replyFilePath, trimmedReply, "utf8");

  let continuationPath: string | undefined;
  if (task.workflow === "run") {
    continuationPath = path.join(task.runDir, "reply-continuation-task.md");
    await writeFile(
      continuationPath,
      `# Task

Continue this Aegis run after user input.

## Original Task

${task.description}

## Prior Blockers

${blockers.trim() || "None."}

## User Reply

${trimmedReply}

Use the user reply as authoritative context. Continue implementation with the existing file protocol in this run directory.
`,
      "utf8",
    );
  }

  store.updateTask(taskId, {
    status: "running",
    reason: undefined,
    startedAt: now,
    endedAt: undefined,
  });

  startTask(taskId, {
    workflow: task.workflow,
    runsDir: options.runsDir ?? DEFAULT_RUNS_DIR,
    skipDiscovery: true,
    monitorSdk: false,
    taskFile: continuationPath,
    replyFile: task.workflow === "cc-team-run" ? replyFilePath : undefined,
    targetDir: task.targetDir,
    model: task.model,
    teamMode: task.teamMode,
    dbPath: options.dbPath,
  });

  const details = await getTaskDetails(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!details) {
    throw new Error(`Task ${taskId} not found after reply`);
  }
  return details;
}

export async function addTaskGuidance(
  taskId: string,
  message: string,
  options: { runsDir?: string; dbPath?: string; priority?: string } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskDetails>>>> {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error("Guidance message is required");
  }

  const store = getStore(options.dbPath);
  const task = await getTask(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const now = new Date().toISOString();
  const priority = options.priority || "normal";
  store.recordGuidance(taskId, trimmed, priority, now);
  store.recordEvent({
    taskId,
    ts: now,
    kind: "guidance_added",
    role: "owner",
    message: trimmed,
    payloadJson: JSON.stringify({ priority }),
  });

  const guidancePath = path.join(task.runDir, "leader-guidance.md");
  const existing = await readOptionalFile(guidancePath);
  const next = `${existing.trimEnd() || "# Leader Guidance"}\n\n## Guidance ${now}\n\nPriority: ${priority}\n\n${trimmed}\n`;
  await writeFile(guidancePath, next, "utf8");

  const details = await getTaskDetails(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!details) {
    throw new Error(`Task ${taskId} not found after guidance`);
  }
  return details;
}

export async function stopTask(
  taskId: string,
  options: { runsDir?: string; dbPath?: string } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskDetails>>>> {
  const store = getStore(options.dbPath);
  const task = await getTask(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const activeTask = activeTasks.get(taskId);
  if (!activeTask) {
    throw new Error(`Task ${taskId} is not running`);
  }

  const now = new Date().toISOString();
  store.updateTask(taskId, {
    status: "stopped",
    endedAt: now,
    reason: "Stopped from Web",
    failureCategory: "stopped_by_user",
  });
  activeTasks.delete(taskId);

  await writeFile(path.join(task.runDir, "run-summary.json"), `${JSON.stringify({
    status: "stopped",
    reason: "Stopped from Web",
    startedAt: task.startedAt,
    endedAt: now,
    terminalRole: task.terminalRole,
    failureCategory: "stopped_by_user",
  }, null, 2)}\n`, "utf8");

  activeTask.process.kill("SIGTERM");

  const details = await getTaskDetails(taskId, { runsDir: options.runsDir, dbPath: options.dbPath });
  if (!details) {
    throw new Error(`Task ${taskId} not found after stop`);
  }
  return details;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readArtifactFiles(artifactsDir: string): Promise<Record<string, string>> {
  let entries: Dirent[];
  try {
    entries = await readdir(artifactsDir, { withFileTypes: true });
  } catch {
    return {};
  }

  const artifacts: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      artifacts[entry.name] = await readFile(path.join(artifactsDir, entry.name), "utf8");
    } catch {
      // Ignore files that disappear while reading.
    }
  }
  return artifacts;
}

async function buildFallbackCockpitMarkdown(task: Task, teamState: unknown, summary: unknown): Promise<string> {
  const state = isRecord(teamState) ? teamState : {};
  const terminal = isRecord(summary) ? summary : {};
  const currentStage = readString(state.currentStage) || readString(terminal.currentStage) || task.currentStage || "-";
  const recommendedAction = readString(state.recommendedAction) || readString(terminal.recommendedAction) || task.recommendedAction || "-";
  const blockers = Array.isArray(state.blockers)
    ? state.blockers
      .filter(isRecord)
      .map((blocker) => `- ${readString(blocker.kind) || "blocker"}: ${readString(blocker.question) || "No question"}`)
      .join("\n")
    : "- none";
  return [
    "# Team Cockpit",
    "",
    "## Current Goal",
    task.description || task.id,
    "",
    "## Current Status",
    `- Status: ${task.status}`,
    `- Current stage: ${currentStage}`,
    `- Recommended action: ${recommendedAction}`,
    "",
    "## Blockers",
    blockers || "- none",
    "",
    "## Next Step",
    recommendedAction,
    "",
  ].join("\n");
}

function buildDashboardSummary(task: Task, input: {
  teamState?: unknown;
  cockpitSource: "cockpit" | "fallback";
  supervisorReport?: string;
  guidance?: TaskGuidanceRecord[];
}): TaskDashboardSummary {
  const state = isRecord(input.teamState) ? input.teamState : {};
  const blockers = Array.isArray(state.blockers) ? state.blockers.filter(isRecord) : [];
  const latestBlocker = blockers.length
    ? `${readString(blockers.at(-1)?.kind) || "blocker"}: ${readString(blockers.at(-1)?.question) || ""}`.trim()
    : task.reason;
  const latestGuidance = input.guidance?.at(-1)?.message;
  return {
    currentStage: readString(state.currentStage) || task.currentStage,
    recommendedAction: readString(state.recommendedAction) || task.recommendedAction,
    latestBlocker,
    ownerGuidance: latestGuidance,
    supervisorSummary: firstNonEmptyLine(input.supervisorReport),
    cockpitSource: input.cockpitSource,
  };
}

function firstNonEmptyLine(value?: string): string | undefined {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readLatestInflightDiagnostic(runDir: string): Promise<TaskDiagnostic | undefined> {
  const inflightDir = path.join(runDir, "session-log", "inflight");
  let entries: string[];
  try {
    entries = (await readdir(inflightDir)).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return undefined;
  }

  const diagnostics: TaskDiagnostic[] = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(await readFile(path.join(inflightDir, entry), "utf8")) as Partial<TaskDiagnostic>;
      if (
        typeof parsed.role === "string"
        && typeof parsed.model === "string"
        && (parsed.threadId === null || typeof parsed.threadId === "string")
        && (parsed.status === "running" || parsed.status === "completed" || parsed.status === "failed")
        && typeof parsed.startedAt === "string"
        && typeof parsed.lastUpdatedAt === "string"
        && typeof parsed.lastEventAt === "string"
        && typeof parsed.idleMs === "number"
        && typeof parsed.classification === "string"
        && typeof parsed.detail === "string"
      ) {
        diagnostics.push(parsed as TaskDiagnostic);
      }
    } catch {
      continue;
    }
  }

  return diagnostics
    .sort((left, right) => left.lastUpdatedAt.localeCompare(right.lastUpdatedAt))
    .at(-1);
}

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "done",
  "ask_user",
  "max_loops_reached",
  "failed",
  "stopped",
]);
const STREAM_TAIL_INTERVAL_MS = 750;
const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export interface StreamTaskEventsOptions {
  runsDir?: string;
  dbPath?: string;
  tailIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** Test hook: stop tailing after this many ticks. */
  maxTicks?: number;
}

export async function streamTaskEvents(
  taskId: string,
  res: Response,
  options: StreamTaskEventsOptions = {},
): Promise<void> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const store = getStore(options.dbPath);
  const task = await getTask(taskId, { runsDir, dbPath: options.dbPath });
  if (!task) {
    res.status(404).json({ error: "Not Found", message: `Task ${taskId} not found` });
    return;
  }

  const tailIntervalMs = options.tailIntervalMs ?? STREAM_TAIL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? STREAM_HEARTBEAT_INTERVAL_MS;
  const streamDir = path.join(task.runDir, "session-log", "stream");
  const offsets = new Map<string, number>();

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  const writeData = (line: string): boolean => {
    if (closed) return false;
    return res.write(`data: ${line}\n\n`);
  };
  const writeNamedEvent = (eventName: string, data: unknown): boolean => {
    if (closed) return false;
    return res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const writeComment = (text: string): boolean => {
    if (closed) return false;
    return res.write(`: ${text}\n\n`);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(tailTimer);
    clearInterval(heartbeatTimer);
    try {
      res.end();
    } catch {
      // ignore
    }
  };

  res.on("close", close);
  res.on("error", close);

  const readNewLinesFromFile = async (filePath: string): Promise<string[]> => {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(filePath);
    } catch {
      return [];
    }
    const previous = offsets.get(filePath) ?? 0;
    if (stats.size <= previous) {
      offsets.set(filePath, stats.size);
      return [];
    }
    const length = stats.size - previous;
    const buffer = Buffer.alloc(length);
    const handle = await open(filePath, "r");
    try {
      await handle.read(buffer, 0, length, previous);
    } finally {
      await handle.close();
    }
    offsets.set(filePath, stats.size);
    const text = buffer.toString("utf8");
    return text.split("\n").filter((line) => line.length > 0);
  };

  const listStreamFiles = async (): Promise<string[]> => {
    let entries: Dirent[];
    try {
      entries = await readdir(streamDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
      .map((entry) => entry.name)
      .sort();
  };

  const flushNewEntries = async (): Promise<void> => {
    const files = await listStreamFiles();
    for (const file of files) {
      const filePath = path.join(streamDir, file);
      const lines = await readNewLinesFromFile(filePath);
      for (const line of lines) {
        if (!writeData(line)) return;
      }
    }
  };

  const isTaskTerminal = async (): Promise<{ terminal: boolean; status: TaskStatus }> => {
    if (activeTasks.has(taskId)) {
      return { terminal: false, status: "running" };
    }
    await refreshTaskStatus(taskId, { dbPath: options.dbPath });
    const current = store.getTask(taskId);
    const status = current?.status ?? "unknown";
    return { terminal: TERMINAL_TASK_STATUSES.has(status), status };
  };

  // Initial replay of any existing stream files.
  await flushNewEntries();
  if (closed) return;

  let ticks = 0;
  const tailTimer = setInterval(() => {
    void (async () => {
      if (closed) return;
      ticks += 1;
      try {
        await flushNewEntries();
      } catch {
        // Ignore transient FS errors; next tick will retry.
      }
      const { terminal, status } = await isTaskTerminal();
      if (terminal) {
        // Drain anything written between last flush and termination detection.
        await flushNewEntries();
        writeNamedEvent("end", { status });
        close();
        return;
      }
      if (options.maxTicks && ticks >= options.maxTicks) {
        writeNamedEvent("end", { status });
        close();
      }
    })();
  }, tailIntervalMs);

  const heartbeatTimer = setInterval(() => {
    writeComment("ping");
  }, heartbeatIntervalMs);

  // If task already terminal at first read, send end event immediately after replay.
  const initialState = await isTaskTerminal();
  if (initialState.terminal && !closed) {
    writeNamedEvent("end", { status: initialState.status });
    close();
  }
}
