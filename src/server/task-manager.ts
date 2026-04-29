import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunDirectory } from "../codex-team/driver.js";

const DEFAULT_RUNS_DIR = path.resolve(process.cwd(), "runs");
const CLI_PATH = path.resolve(process.cwd(), "dist", "cli.js");

export type TaskStatus = "queued" | "running" | "done" | "ask_user" | "max_loops_reached" | "failed" | "stopped" | "unknown";

export interface Task {
  id: string;
  runDir: string;
  status: TaskStatus;
  description: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  terminalRole?: string;
  failureCategory?: string;
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

const activeTasks = new Map<string, ActiveTask>();
const taskStore = new Map<string, Task>();
let taskProcessRunner: TaskProcessRunner = (command, args, options) => spawn(command, args, options);

export function setTaskProcessRunnerForTest(runner: TaskProcessRunner): void {
  taskProcessRunner = runner;
}

export function resetTaskManagerForTest(): void {
  activeTasks.clear();
  taskStore.clear();
  taskProcessRunner = (command, args, options) => spawn(command, args, options);
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

async function loadTaskFromRunDir(taskId: string, runDir: string): Promise<Task | undefined> {
  let description = "";

  try {
    description = descriptionFromTaskFile(await readFile(path.join(runDir, "task.md"), "utf8"));
  } catch {
    return undefined;
  }

  const task: Task = {
    id: taskId,
    runDir,
    status: "unknown",
    description,
    createdAt: createdAtFromTaskId(taskId),
  };

  try {
    const summary = JSON.parse(await readFile(path.join(runDir, "run-summary.json"), "utf8")) as {
      status?: unknown;
      reason?: string;
      terminalRole?: string;
      failureCategory?: string;
      startedAt?: string;
      endedAt?: string;
    };

    task.status = normalizeTaskStatus(summary.status);
    task.reason = summary.reason;
    task.terminalRole = summary.terminalRole;
    task.failureCategory = summary.failureCategory;
    task.startedAt = summary.startedAt;
    task.endedAt = summary.endedAt;
  } catch {
    // A run with task.md but no summary is either still being written or incomplete.
  }

  taskStore.set(taskId, task);
  return task;
}

async function loadTasksFromRunsDir(runsDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || taskStore.has(entry.name)) continue;
    await loadTaskFromRunDir(entry.name, taskIdToRunDir(entry.name, runsDir));
  }
}

export async function createTask(
  description: string,
  options: {
    model?: string;
    maxLoops?: number;
    skipDiscovery?: boolean;
    monitorSdk?: boolean;
    runsDir?: string;
  } = {}
): Promise<Task> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  const runDir = await createRunDirectory(runsDir);
  const taskId = path.basename(runDir);

  const taskMdPath = path.join(runDir, "task.md");
  await writeFile(taskMdPath, `# Task

${description}
`, "utf8");

  const task: Task = {
    id: taskId,
    runDir,
    status: "queued",
    description,
    createdAt: new Date().toISOString(),
  };

  taskStore.set(taskId, task);

  startTask(taskId, {
    model: options.model,
    maxLoops: options.maxLoops,
    skipDiscovery: options.skipDiscovery,
    monitorSdk: options.monitorSdk,
    runsDir,
    taskFile: taskMdPath,
  });

  return task;
}

function startTask(
  taskId: string,
  options: {
    model?: string;
    maxLoops?: number;
    skipDiscovery?: boolean;
    monitorSdk?: boolean;
    runsDir: string;
    taskFile?: string;
  }
): void {
  const task = taskStore.get(taskId);
  if (!task) return;

  const args = [
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
  if (options.maxLoops) {
    args.push("--max-loops", String(options.maxLoops));
  }
  if (options.skipDiscovery) {
    args.push("--skip-discovery");
  }
  if (options.monitorSdk === false) {
    args.push("--skip-sdk-monitor");
  }

  task.status = "running";
  task.startedAt = new Date().toISOString();
  taskStore.set(taskId, task);

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
    await refreshTaskStatus(taskId);
  });

  child.on("error", async () => {
    activeTasks.delete(taskId);
    task.status = "failed";
    task.endedAt = new Date().toISOString();
    task.reason = "Failed to start task process";
    taskStore.set(taskId, task);
  });
}

export async function getTask(
  taskId: string,
  options: { runsDir?: string } = {}
): Promise<Task | undefined> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  let task = taskStore.get(taskId);
  if (!task) {
    task = await loadTaskFromRunDir(taskId, taskIdToRunDir(taskId, runsDir));
  }
  if (!task) return undefined;

  if (task.status === "running") {
    await refreshTaskStatus(taskId);
  }

  return taskStore.get(taskId);
}

async function refreshTaskStatus(taskId: string): Promise<void> {
  const task = taskStore.get(taskId);
  if (!task) return;

  if (activeTasks.has(taskId)) {
    task.status = "running";
    taskStore.set(taskId, task);
    return;
  }

  const summaryPath = path.join(task.runDir, "run-summary.json");
  try {
    const summaryContent = await readFile(summaryPath, "utf8");
    const summary = JSON.parse(summaryContent) as {
      status: unknown;
      reason?: string;
      terminalRole?: string;
      failureCategory?: string;
      startedAt?: string;
      endedAt?: string;
    };

    task.status = normalizeTaskStatus(summary.status);
    task.reason = summary.reason;
    task.terminalRole = summary.terminalRole;
    task.failureCategory = summary.failureCategory;
    if (summary.startedAt) {
      task.startedAt = summary.startedAt;
    }
    if (summary.endedAt) {
      task.endedAt = summary.endedAt;
    }
  } catch {
    if (task.status === "queued") {
      task.status = "unknown";
    }
  }

  taskStore.set(taskId, task);
}

export async function listTasks(
  options: { limit?: number; runsDir?: string } = {}
): Promise<Task[]> {
  const runsDir = options.runsDir ?? DEFAULT_RUNS_DIR;
  await loadTasksFromRunsDir(runsDir);

  for (const taskId of [...taskStore.keys()]) {
    if (activeTasks.has(taskId)) {
      const task = taskStore.get(taskId);
      if (task) {
        task.status = "running";
        taskStore.set(taskId, task);
      }
    } else {
      await refreshTaskStatus(taskId);
    }
  }

  const tasks = [...taskStore.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt)
  );

  return options.limit ? tasks.slice(0, options.limit) : tasks;
}

export async function getTaskDetails(
  taskId: string,
  options: { runsDir?: string } = {}
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
  diagnostic?: TaskDiagnostic;
} | undefined> {
  const task = await getTask(taskId, { runsDir: options.runsDir });
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

  result.diagnostic = await readLatestInflightDiagnostic(task.runDir);

  return result;
}

export async function replyToTask(
  taskId: string,
  reply: string,
  options: { runsDir?: string } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskDetails>>>> {
  const trimmedReply = reply.trim();
  if (!trimmedReply) {
    throw new Error("Reply is required");
  }

  const task = await getTask(taskId, { runsDir: options.runsDir });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  if (task.status !== "ask_user") {
    throw new Error(`Task ${taskId} is not waiting for user input`);
  }

  const now = new Date().toISOString();
  const blockers = await readOptionalFile(path.join(task.runDir, "blockers.md"));
  const repliesPath = path.join(task.runDir, "user-replies.md");
  const existingReplies = await readOptionalFile(repliesPath);
  const nextReplies = `${existingReplies.trimEnd() || "# User Replies"}\n\n## Reply ${now}\n\n${trimmedReply}\n`;
  await writeFile(repliesPath, nextReplies, "utf8");

  const continuationPath = path.join(task.runDir, "reply-continuation-task.md");
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

  task.status = "running";
  task.reason = undefined;
  task.startedAt = now;
  task.endedAt = undefined;
  taskStore.set(taskId, task);

  startTask(taskId, {
    runsDir: options.runsDir ?? DEFAULT_RUNS_DIR,
    skipDiscovery: true,
    monitorSdk: false,
    taskFile: continuationPath,
  });

  const details = await getTaskDetails(taskId, { runsDir: options.runsDir });
  if (!details) {
    throw new Error(`Task ${taskId} not found after reply`);
  }
  return details;
}

export async function stopTask(
  taskId: string,
  options: { runsDir?: string } = {},
): Promise<NonNullable<Awaited<ReturnType<typeof getTaskDetails>>>> {
  const task = await getTask(taskId, { runsDir: options.runsDir });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const activeTask = activeTasks.get(taskId);
  if (!activeTask) {
    throw new Error(`Task ${taskId} is not running`);
  }

  const now = new Date().toISOString();
  task.status = "stopped";
  task.endedAt = now;
  task.reason = "Stopped from Web";
  task.failureCategory = "stopped_by_user";
  taskStore.set(taskId, task);
  activeTasks.delete(taskId);

  await writeFile(path.join(task.runDir, "run-summary.json"), `${JSON.stringify({
    status: "stopped",
    reason: task.reason,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    terminalRole: task.terminalRole,
    failureCategory: task.failureCategory,
  }, null, 2)}\n`, "utf8");

  activeTask.process.kill("SIGTERM");

  const details = await getTaskDetails(taskId, { runsDir: options.runsDir });
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
