import { EventEmitter } from "node:events";
import http from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../dist/server/index.js";
import { createSqliteTaskStore } from "../dist/server/task-store.js";
import {
  addTaskGuidance,
  createTask,
  getTaskDetails,
  listTasks,
  replyToTask,
  resetTaskManagerForTest,
  setTaskProcessRunnerForTest,
  stopTask,
  streamTaskEvents,
} from "../dist/server/task-manager.js";

function fakeChild() {
  return new EventEmitter();
}

test.afterEach(() => {
  resetTaskManagerForTest();
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          body: JSON.parse(body),
        });
      });
    }).on("error", reject);
  });
}

test("server falls back to the next port when the requested port is busy", async () => {
  const blocker = http.createServer((_req, res) => {
    res.end("busy");
  });
  await new Promise((resolve) => blocker.listen(0, resolve));

  const requestedPort = blocker.address().port;
  const originalLog = console.log;
  let server;

  try {
    console.log = () => {};
    server = await startServer(requestedPort);
    const actualPort = server.address().port;

    assert.ok(actualPort > requestedPort);

    const response = await getJson(`http://127.0.0.1:${actualPort}/api/tasks?limit=1`);

    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body.tasks));
  } finally {
    console.log = originalLog;
    if (server) await closeServer(server);
    await closeServer(blocker);
  }
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

test("sqlite task store persists tasks, status updates, replies, and guidance", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-sqlite-"));
  const dbPath = path.join(rootDir, "history.sqlite");
  const store = createSqliteTaskStore(dbPath);

  store.upsertTask({
    id: "task-1",
    runDir: path.join(rootDir, "runs", "task-1"),
    workflow: "cc-team-run",
    status: "queued",
    description: "Build a local team dashboard.",
    targetDir: rootDir,
    model: "MiniMax-M2.7",
    createdAt: "2026-05-13T01:00:00.000Z",
  });
  store.updateTask("task-1", {
    status: "ask_user",
    startedAt: "2026-05-13T01:00:01.000Z",
    endedAt: "2026-05-13T01:00:10.000Z",
    reason: "Need credentials",
    failureCategory: "credentials",
    currentStage: "spec",
    recommendedAction: "answer_user",
  });
  store.recordReply("task-1", "Use local credentials.");
  store.recordGuidance("task-1", "Prioritize the boss dashboard.", "high");
  store.close();

  const reopened = createSqliteTaskStore(dbPath);
  const task = reopened.getTask("task-1");
  const replies = reopened.listReplies("task-1");
  const guidance = reopened.listGuidance("task-1");

  assert.equal(task?.workflow, "cc-team-run");
  assert.equal(task?.status, "ask_user");
  assert.equal(task?.reason, "Need credentials");
  assert.equal(task?.currentStage, "spec");
  assert.equal(task?.recommendedAction, "answer_user");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].reply, "Use local credentials.");
  assert.equal(guidance.length, 1);
  assert.equal(guidance[0].message, "Prioritize the boss dashboard.");
  assert.equal(guidance[0].priority, "high");
  reopened.close();
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

test("server-created team task uses cc-team-run CLI arguments and stores workflow history", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-team-create-"));
  const targetDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-team-target-"));
  const runnerCalls = [];

  setTaskProcessRunnerForTest((command, args) => {
    const child = fakeChild();
    runnerCalls.push({ command, args });
    const runDir = args[args.indexOf("--run-dir") + 1];
    queueMicrotask(async () => {
      await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
        workflow: "cc-team-run",
        status: "done",
        reason: "team lifecycle completed",
        currentStage: "ship",
        recommendedAction: "inspect",
        startedAt: "2026-05-13T02:00:00.000Z",
        endedAt: "2026-05-13T02:00:01.000Z",
        failureCategory: "none",
      }, null, 2)}\n`, "utf8");
      child.emit("exit", 0);
    });
    return child;
  });

  const task = await createTask("Build the React dashboard.", {
    runsDir,
    workflow: "cc-team-run",
    teamMode: "supervised",
    targetDir,
    model: "MiniMax-M2.7",
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  const details = await getTaskDetails(task.id, { runsDir });

  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].args[1], "cc-team-run");
  assert.ok(runnerCalls[0].args.includes("--team-mode"));
  assert.equal(runnerCalls[0].args[runnerCalls[0].args.indexOf("--team-mode") + 1], "supervised");
  assert.ok(runnerCalls[0].args.includes("--target"));
  assert.equal(runnerCalls[0].args[runnerCalls[0].args.indexOf("--target") + 1], targetDir);
  assert.equal(details?.task.workflow, "cc-team-run");
  assert.equal(details?.task.currentStage, "ship");
  assert.equal(details?.task.recommendedAction, "inspect");
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

test("server task details expose team state, worker registry, and artifacts", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-team-detail-"));
  const taskId = "2026-05-13T03-10-00Z";
  const runDir = path.join(runsDir, taskId);

  await mkdir(path.join(runDir, "artifacts"), { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nShow team details.\n", "utf8");
  await writeFile(path.join(runDir, "progress.md"), "Team progress log\n", "utf8");
  await writeFile(path.join(runDir, "team-state.json"), `${JSON.stringify({
    schemaVersion: 1,
    workflow: "cc-team-run",
    status: "ask_user",
    currentStage: "spec",
    recommendedAction: "answer_user",
    tasks: [],
    blockers: [{ kind: "credentials", question: "Which key?" }],
    assumptions: [],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "worker-registry.json"), `${JSON.stringify({
    workers: [{ id: "worker-1", role: "developer", cwd: runDir, sessionId: "session-1", status: "healthy", skills: [], updatedAt: "2026-05-13T03:10:00.000Z" }],
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "artifacts", "ship-report.md"), "# Ship Report\n\nReady locally.\n", "utf8");
  await writeFile(path.join(runDir, "artifacts", "team-cockpit.md"), "# Team Cockpit\n\n## Current Work\n\nLeader is waiting for credentials.\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    workflow: "cc-team-run",
    status: "ask_user",
    reason: "Need credentials",
    currentStage: "spec",
    recommendedAction: "answer_user",
    startedAt: "2026-05-13T03:10:00.000Z",
    endedAt: "2026-05-13T03:10:10.000Z",
  }, null, 2)}\n`, "utf8");

  const details = await getTaskDetails(taskId, { runsDir });

  assert.equal(details?.teamState?.currentStage, "spec");
  assert.equal(details?.workerRegistry?.workers[0].sessionId, "session-1");
  assert.equal(details?.artifacts?.["ship-report.md"], "# Ship Report\n\nReady locally.\n");
  assert.equal(details?.cockpitMarkdown, "# Team Cockpit\n\n## Current Work\n\nLeader is waiting for credentials.\n");
  assert.equal(details?.dashboardSummary?.currentStage, "spec");
  assert.match(details?.dashboardSummary?.latestBlocker || "", /Which key/);
  assert.equal(details?.task.workflow, "cc-team-run");
});

test("server guidance writes leader guidance and exposes guidance history", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-guidance-"));
  const dbPath = path.join(runsDir, "server.sqlite");
  const taskId = "2026-05-13T04-00-00Z";
  const runDir = path.join(runsDir, taskId);

  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nBuild a team cockpit.\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    workflow: "cc-team-run",
    status: "done",
    reason: "Paused for inspection",
    currentStage: "plan",
    recommendedAction: "inspect",
    startedAt: "2026-05-13T04:00:00.000Z",
    endedAt: "2026-05-13T04:00:10.000Z",
  }, null, 2)}\n`, "utf8");

  const details = await addTaskGuidance(taskId, "Focus on the leader/supervisor cockpit first.", {
    runsDir,
    dbPath,
    priority: "high",
  });

  const guidanceDoc = await readFile(path.join(runDir, "leader-guidance.md"), "utf8");
  assert.match(guidanceDoc, /Focus on the leader\/supervisor cockpit first/);
  assert.equal(details.guidance?.length, 1);
  assert.equal(details.guidance?.[0].priority, "high");
  assert.match(details.dashboardSummary?.ownerGuidance || "", /leader\/supervisor cockpit/);
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

test("server reply resumes cc-team-run tasks with --run-dir and --reply", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-team-reply-"));
  const taskId = "2026-05-13T03-30-00Z";
  const runDir = path.join(runsDir, taskId);
  const runnerCalls = [];

  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nBuild a team feature.\n", "utf8");
  await writeFile(path.join(runDir, "blockers.md"), "Need deployment credentials\n", "utf8");
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify({
    workflow: "cc-team-run",
    status: "ask_user",
    reason: "Need deployment credentials",
    currentStage: "spec",
    recommendedAction: "answer_user",
    startedAt: "2026-05-13T03:30:00.000Z",
    endedAt: "2026-05-13T03:30:30.000Z",
  }, null, 2)}\n`, "utf8");

  setTaskProcessRunnerForTest((command, args) => {
    const child = fakeChild();
    runnerCalls.push({ command, args });
    return child;
  });

  const result = await replyToTask(taskId, "Use local staging only.", { runsDir });

  assert.equal(result.task.status, "running");
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0].args[1], "cc-team-run");
  assert.ok(runnerCalls[0].args.includes("--run-dir"));
  assert.equal(runnerCalls[0].args[runnerCalls[0].args.indexOf("--run-dir") + 1], runDir);
  assert.ok(runnerCalls[0].args.includes("--reply"));
  assert.match(runnerCalls[0].args[runnerCalls[0].args.indexOf("--reply") + 1], /reply-/);
  assert.ok(!runnerCalls[0].args.includes("--skip-discovery"));
});

test("server stop terminates the active task and records a stopped summary", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-stop-"));
  let killedWithSignal;

  setTaskProcessRunnerForTest(() => {
    const child = fakeChild();
    child.kill = (signal) => {
      killedWithSignal = signal;
      return true;
    };
    return child;
  });

  const task = await createTask("Stop this task from the web UI.", {
    runsDir,
    skipDiscovery: true,
  });

  const details = await stopTask(task.id, { runsDir });
  const summary = JSON.parse(await readFile(path.join(task.runDir, "run-summary.json"), "utf8"));

  assert.equal(killedWithSignal, "SIGTERM");
  assert.equal(details.task.status, "stopped");
  assert.equal(summary.status, "stopped");
  assert.equal(summary.failureCategory, "stopped_by_user");
});

test("task list page renders stopped status with a localized label", async () => {
  const indexHtml = await readFile(path.resolve("web/index.html"), "utf8");

  assert.match(indexHtml, /stopped:\s*'已停止'/);
  assert.match(indexHtml, /\.status-badge\.stopped/);
});

function createFakeSseResponse() {
  const emitter = new EventEmitter();
  const writes = [];
  let status = 200;
  let ended = false;
  const headers = {};
  const fake = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      headers[name] = value;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end() {
      if (ended) return;
      ended = true;
      emitter.emit("close");
    },
    status(code) {
      status = code;
      this.statusCode = code;
      return {
        json(body) {
          fake._jsonBody = body;
          return fake;
        },
      };
    },
    on(event, listener) {
      emitter.on(event, listener);
      return this;
    },
    once(event, listener) {
      emitter.once(event, listener);
      return this;
    },
    emit(event, ...args) {
      emitter.emit(event, ...args);
    },
    _writes: writes,
    _headers: headers,
    get _ended() { return ended; },
    get _status() { return status; },
  };
  return fake;
}

function parseSseFrames(buffer) {
  const frames = [];
  for (const block of buffer.split("\n\n")) {
    if (!block.trim()) continue;
    let event;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(": ")) continue;
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return frames;
}

async function seedStreamRun(runsDir, taskId, opts = {}) {
  const runDir = path.join(runsDir, taskId);
  const streamDir = path.join(runDir, "session-log", "stream");
  await mkdir(streamDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), "# Task\n\nstream test\n", "utf8");
  if (opts.summary) {
    await writeFile(
      path.join(runDir, "run-summary.json"),
      `${JSON.stringify(opts.summary, null, 2)}\n`,
      "utf8",
    );
  }
  return { runDir, streamDir };
}

test("streamTaskEvents replays existing entries and emits end for terminal tasks", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-stream-replay-"));
  const taskId = "2026-05-10T01-00-00Z";
  const { streamDir } = await seedStreamRun(runsDir, taskId, {
    summary: {
      status: "done",
      reason: "completed",
      startedAt: "2026-05-10T01:00:00.000Z",
      endedAt: "2026-05-10T01:00:30.000Z",
      terminalRole: "developer",
      failureCategory: "none",
    },
  });

  const streamFile = path.join(streamDir, "2026-05-10T01-00-05.000Z-developer.ndjson");
  const entries = [
    {
      ts: "2026-05-10T01:00:05.000Z",
      role: "developer",
      model: "gpt-5.4",
      threadId: "thread-1",
      turnStartedAt: "2026-05-10T01:00:05.000Z",
      kind: "turn_started",
      payload: {},
    },
    {
      ts: "2026-05-10T01:00:06.000Z",
      role: "developer",
      model: "gpt-5.4",
      threadId: "thread-1",
      turnStartedAt: "2026-05-10T01:00:05.000Z",
      kind: "agent_message",
      payload: { text: "hello" },
    },
    {
      ts: "2026-05-10T01:00:07.000Z",
      role: "developer",
      model: "gpt-5.4",
      threadId: "thread-1",
      turnStartedAt: "2026-05-10T01:00:05.000Z",
      kind: "turn_completed",
      payload: { usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3 } },
    },
  ];
  await writeFile(streamFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  const res = createFakeSseResponse();
  await streamTaskEvents(taskId, res, {
    runsDir,
    tailIntervalMs: 50,
    heartbeatIntervalMs: 60_000,
  });

  // Wait until end fires (terminal task → close after first tick).
  await new Promise((resolve) => {
    if (res._ended) return resolve();
    res.on("close", resolve);
  });

  const frames = parseSseFrames(res._writes.join(""));
  const dataFrames = frames.filter((frame) => !frame.event);
  const endFrames = frames.filter((frame) => frame.event === "end");

  assert.equal(res._headers["Content-Type"], "text/event-stream");
  assert.equal(dataFrames.length, 3);
  assert.equal(JSON.parse(dataFrames[0].data).kind, "turn_started");
  assert.equal(JSON.parse(dataFrames[1].data).payload.text, "hello");
  assert.equal(JSON.parse(dataFrames[2].data).kind, "turn_completed");
  assert.equal(endFrames.length, 1);
  assert.equal(JSON.parse(endFrames[0].data).status, "done");
});

test("streamTaskEvents tails appended entries while task is active", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-stream-tail-"));
  const taskId = "2026-05-10T02-00-00Z";
  const { streamDir } = await seedStreamRun(runsDir, taskId);

  const streamFile = path.join(streamDir, "2026-05-10T02-00-05.000Z-manager.ndjson");
  const baseEntry = {
    role: "manager",
    model: "gpt-5.4",
    threadId: "tid",
    turnStartedAt: "2026-05-10T02:00:05.000Z",
  };
  const initialEntry = {
    ...baseEntry,
    ts: "2026-05-10T02:00:05.000Z",
    kind: "turn_started",
    payload: {},
  };
  await writeFile(streamFile, JSON.stringify(initialEntry) + "\n", "utf8");

  const res = createFakeSseResponse();
  // No run-summary.json present, so task status is unknown — non-terminal.
  // We use maxTicks to bound the test.
  const streamPromise = streamTaskEvents(taskId, res, {
    runsDir,
    tailIntervalMs: 30,
    heartbeatIntervalMs: 60_000,
    maxTicks: 10,
  });

  // Append a second entry once the first tick has cleared.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const followUp = {
    ...baseEntry,
    ts: "2026-05-10T02:00:06.000Z",
    kind: "agent_message",
    payload: { text: "second" },
  };
  await appendFile(streamFile, JSON.stringify(followUp) + "\n", "utf8");

  await streamPromise;
  await new Promise((resolve) => {
    if (res._ended) return resolve();
    res.on("close", resolve);
  });

  const frames = parseSseFrames(res._writes.join(""));
  const dataFrames = frames.filter((frame) => !frame.event);
  assert.ok(dataFrames.length >= 2, `expected at least 2 data frames, got ${dataFrames.length}`);
  const kinds = dataFrames.map((frame) => JSON.parse(frame.data).kind);
  assert.deepEqual(kinds.slice(0, 2), ["turn_started", "agent_message"]);
});

test("streamTaskEvents returns 404 for an unknown task", async () => {
  const runsDir = await mkdtemp(path.join(tmpdir(), "codex-gtd-server-stream-missing-"));
  const res = createFakeSseResponse();

  await streamTaskEvents("nope-no-such", res, { runsDir });

  assert.equal(res._status, 404);
  assert.equal(res._jsonBody?.error, "Not Found");
});
