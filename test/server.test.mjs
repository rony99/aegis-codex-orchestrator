import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTask,
  getTaskDetails,
  listTasks,
  replyToTask,
  resetTaskManagerForTest,
  setTaskProcessRunnerForTest,
} from "../dist/server/task-manager.js";

function fakeChild() {
  return new EventEmitter();
}

test.afterEach(() => {
  resetTaskManagerForTest();
});

test("server task list restores existing runs from disk", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-runs-"));
  const taskId = "2026-04-28T02-18-21Z";
  const runDir = path.join(runsDir, taskId);

  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nInspect the web UI.\n", "utf8");
  await writeFile(path.join(runDir, "progress.md"), "Progress log\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    status: "ask_user",
    reason: "Discovery needs input",
    startedAt: "2026-04-28T02:18:21.000Z",
    endedAt: "2026-04-28T02:18:24.000Z",
    terminalRole: "discovery",
    failureCategory: "discovery_needed",
  }, null, 2)}\n`, "utf8");

  const tasks = await listTasks({ runsDir });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, taskId);
  assert.equal(tasks[0].status, "ask_user");
  assert.equal(tasks[0].description, "Inspect the web UI.");
  assert.equal(tasks[0].createdAt, "2026-04-28T02:18:21.000Z");
});

test("server task details can read a restored run", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-detail-"));
  const taskId = "2026-04-28T02-29-59Z";
  const runDir = path.join(runsDir, taskId);

  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nCheck the detail page.\n", "utf8");
  await writeFile(path.join(runDir, "progress.md"), "Progress log\n", "utf8");
  await writeFile(path.join(runDir, "blockers.md"), "Need user input\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    status: "ask_user",
    reason: "Discovery needs input",
    startedAt: "2026-04-28T02:29:59.000Z",
    endedAt: "2026-04-28T02:30:49.000Z",
    terminalRole: "discovery",
    failureCategory: "discovery_needed",
  }, null, 2)}\n`, "utf8");

  const details = await getTaskDetails(taskId, { runsDir });

  assert.equal(details?.task.id, taskId);
  assert.equal(details?.task.status, "ask_user");
  assert.equal(details?.log, "Progress log\n");
  assert.equal(details?.blockers, "Need user input\n");
});

test("server-created task runs in the tracked task run directory", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-create-"));
  const runnerCalls = [];

  setTaskProcessRunnerForTest((command, args) => {
    const child = fakeChild();
    runnerCalls.push({ command, args });
    const runDir = args[args.indexOf("--run-dir") + 1];
    queueMicrotask(async () => {
      await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
        status: "done",
        reason: "fake run completed",
        startedAt: "2026-04-28T03:00:00.000Z",
        endedAt: "2026-04-28T03:00:01.000Z",
        terminalRole: "manager",
        failureCategory: "none",
      }, null, 2)}\n`, "utf8");
      child.emit("exit", 0);
    });
    return child;
  });

  const task = await createTask("Track the real run directory.", {
    runsDir,
    skipDiscovery: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  const details = await getTaskDetails(task.id, { runsDir });
  const tasks = await listTasks({ runsDir });

  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].args.includes("--run-dir"));
  assert.equal(runnerCalls[0].args[runnerCalls[0].args.indexOf("--run-dir") + 1], task.runDir);
  assert.equal(details?.task.runDir, task.runDir);
  assert.equal(details?.task.status, "done");
  assert.equal(tasks.filter((candidate) => candidate.id === task.id).length, 1);
});

test("server task details include latest SDK inflight diagnostic", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-diagnostic-"));
  const taskId = "2026-04-28T03-10-00Z";
  const runDir = path.join(runsDir, taskId);
  const inflightDir = path.join(runDir, "session-log", "inflight");

  await mkdir(inflightDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nShow SDK status.\n", "utf8");
  await writeFile(path.join(runDir, "progress.md"), "Progress log\n", "utf8");
  await writeFile(path.join(inflightDir, "2026-04-28T03-10-01.000Z-manager.json"), `${JSON.stringify({
    role: "manager",
    model: "gpt-5.4",
    threadId: "thread-1",
    status: "running",
    startedAt: "2026-04-28T03:10:01.000Z",
    lastUpdatedAt: "2026-04-28T03:10:05.000Z",
    lastEventAt: "2026-04-28T03:10:04.000Z",
    idleMs: 1000,
    classification: "model_running",
    detail: "The SDK turn started.",
    lastEventType: "turn.started",
  }, null, 2)}\n`, "utf8");

  const details = await getTaskDetails(taskId, { runsDir });

  assert.equal(details?.diagnostic?.role, "manager");
  assert.equal(details?.diagnostic?.model, "gpt-5.4");
  assert.equal(details?.diagnostic?.status, "running");
  assert.equal(details?.diagnostic?.classification, "model_running");
  assert.equal(details?.diagnostic?.detail, "The SDK turn started.");
  assert.equal(details?.diagnostic?.idleMs, 1000);
});

test("server reply records user input and restarts ask_user tasks", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-reply-"));
  const taskId = "2026-04-28T03-20-00Z";
  const runDir = path.join(runsDir, taskId);
  const runnerCalls = [];

  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nBuild a thing.\n", "utf8");
  await writeFile(path.join(runDir, "progress.md"), "Progress log\n", "utf8");
  await writeFile(path.join(runDir, "blockers.md"), "Need API key\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    status: "ask_user",
    reason: "Need API key",
    startedAt: "2026-04-28T03:20:00.000Z",
    endedAt: "2026-04-28T03:20:30.000Z",
    terminalRole: "manager",
    failureCategory: "blocker",
  }, null, 2)}\n`, "utf8");

  setTaskProcessRunnerForTest((command, args) => {
    const child = fakeChild();
    runnerCalls.push({ command, args });
    return child;
  });

  const result = await replyToTask(taskId, "Use TEST_KEY from the local environment.", { runsDir });
  const replies = await readFile(path.join(runDir, "user-replies.md"), "utf8");
  const continuation = await readFile(path.join(runDir, "reply-continuation-task.md"), "utf8");

  assert.equal(result.task.status, "running");
  assert.match(replies, /Use TEST_KEY from the local environment/);
  assert.match(continuation, /Need API key/);
  assert.match(continuation, /Use TEST_KEY from the local environment/);
  assert.equal(runnerCalls.length, 1);
  assert.ok(runnerCalls[0].args.includes("--run-dir"));
  assert.equal(runnerCalls[0].args[runnerCalls[0].args.indexOf("--run-dir") + 1], runDir);
  assert.ok(runnerCalls[0].args.includes("--skip-discovery"));
});
