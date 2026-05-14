import { Router, type Request, type Response } from "express";
import { addTaskGuidance, createTask, getTask, listTasks, getTaskDetails, replyToTask, stopTask, streamTaskEvents, type Task, type TaskStatus } from "./task-manager.js";

const router = Router();

interface CreateTaskRequest {
  description: string;
  workflow?: "run" | "cc-team-run";
  teamMode?: "supervised" | "multi-role";
  targetDir?: string;
  model?: string;
  maxLoops?: number;
  skipDiscovery?: boolean;
  monitorSdk?: boolean;
}

interface ReplyTaskRequest {
  reply: string;
}

interface GuidanceTaskRequest {
  message: string;
  priority?: string;
}

function formatTaskResponse(task: Task) {
  return {
    id: task.id,
    runDir: task.runDir,
    workflow: task.workflow,
    teamMode: task.teamMode,
    status: task.status,
    description: task.description,
    targetDir: task.targetDir,
    model: task.model,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    reason: task.reason,
    terminalRole: task.terminalRole,
    failureCategory: task.failureCategory,
    currentStage: task.currentStage,
    recommendedAction: task.recommendedAction,
  };
}

router.post("/tasks", async (req: Request, res: Response) => {
  try {
    const body = req.body as CreateTaskRequest;

    if (!body.description || typeof body.description !== "string") {
      res.status(400).json({
        error: "Bad Request",
        message: "Task description is required",
      });
      return;
    }

    const task = await createTask(body.description, {
      workflow: body.workflow === "run" ? "run" : "cc-team-run",
      teamMode: body.teamMode === "multi-role" ? "multi-role" : "supervised",
      targetDir: body.targetDir,
      model: body.model,
      maxLoops: body.maxLoops,
      skipDiscovery: body.skipDiscovery,
      monitorSdk: body.monitorSdk,
    });

    res.status(201).json({
      task: formatTaskResponse(task),
      message: "Task created and started",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: "Internal Server Error",
      message,
    });
  }
});

router.get("/tasks", async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const workflow = req.query.workflow === "run" || req.query.workflow === "cc-team-run" ? req.query.workflow : undefined;
    const status = typeof req.query.status === "string" ? req.query.status as TaskStatus : undefined;
    const tasks = await listTasks({ limit, workflow, status });

    res.json({
      tasks: tasks.map(formatTaskResponse),
      total: tasks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: "Internal Server Error",
      message,
    });
  }
});

router.get("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const taskIdParam = req.params.id;
    const taskId = Array.isArray(taskIdParam) ? taskIdParam[0] : taskIdParam;
    const details = await getTaskDetails(taskId);

    if (!details) {
      res.status(404).json({
        error: "Not Found",
        message: `Task ${taskId} not found`,
      });
      return;
    }

    res.json({
      task: formatTaskResponse(details.task),
      progress: details.progress,
      log: details.log,
      blockers: details.blockers,
      spec: details.spec,
      summary: details.summary,
      teamState: details.teamState,
      workerRegistry: details.workerRegistry,
      artifacts: details.artifacts,
      cockpitMarkdown: details.cockpitMarkdown,
      dashboardSummary: details.dashboardSummary,
      events: details.events,
      guidance: details.guidance,
      diagnostic: details.diagnostic,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: "Internal Server Error",
      message,
    });
  }
});

router.post("/tasks/:id/reply", async (req: Request, res: Response) => {
  try {
    const taskIdParam = req.params.id;
    const taskId = Array.isArray(taskIdParam) ? taskIdParam[0] : taskIdParam;
    const body = req.body as ReplyTaskRequest;

    if (!body.reply || typeof body.reply !== "string" || body.reply.trim().length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message: "Reply is required",
      });
      return;
    }

    const details = await replyToTask(taskId, body.reply);
    res.json({
      task: formatTaskResponse(details.task),
      progress: details.progress,
      log: details.log,
      blockers: details.blockers,
      spec: details.spec,
      summary: details.summary,
      teamState: details.teamState,
      workerRegistry: details.workerRegistry,
      artifacts: details.artifacts,
      cockpitMarkdown: details.cockpitMarkdown,
      dashboardSummary: details.dashboardSummary,
      events: details.events,
      guidance: details.guidance,
      diagnostic: details.diagnostic,
      message: "Reply recorded and task restarted",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 400;
    res.status(status).json({
      error: status === 404 ? "Not Found" : "Bad Request",
      message,
    });
  }
});

router.post("/tasks/:id/stop", async (req: Request, res: Response) => {
  try {
    const taskIdParam = req.params.id;
    const taskId = Array.isArray(taskIdParam) ? taskIdParam[0] : taskIdParam;
    const details = await stopTask(taskId);

    res.json({
      task: formatTaskResponse(details.task),
      progress: details.progress,
      log: details.log,
      blockers: details.blockers,
      spec: details.spec,
      summary: details.summary,
      teamState: details.teamState,
      workerRegistry: details.workerRegistry,
      artifacts: details.artifacts,
      cockpitMarkdown: details.cockpitMarkdown,
      dashboardSummary: details.dashboardSummary,
      events: details.events,
      guidance: details.guidance,
      diagnostic: details.diagnostic,
      message: "Task stopped",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 400;
    res.status(status).json({
      error: status === 404 ? "Not Found" : "Bad Request",
      message,
    });
  }
});

router.post("/tasks/:id/guidance", async (req: Request, res: Response) => {
  try {
    const taskIdParam = req.params.id;
    const taskId = Array.isArray(taskIdParam) ? taskIdParam[0] : taskIdParam;
    const body = req.body as GuidanceTaskRequest;

    if (!body.message || typeof body.message !== "string" || body.message.trim().length === 0) {
      res.status(400).json({
        error: "Bad Request",
        message: "Guidance message is required",
      });
      return;
    }

    const details = await addTaskGuidance(taskId, body.message, { priority: body.priority });
    res.json({
      task: formatTaskResponse(details.task),
      progress: details.progress,
      log: details.log,
      blockers: details.blockers,
      spec: details.spec,
      summary: details.summary,
      teamState: details.teamState,
      workerRegistry: details.workerRegistry,
      artifacts: details.artifacts,
      cockpitMarkdown: details.cockpitMarkdown,
      dashboardSummary: details.dashboardSummary,
      events: details.events,
      guidance: details.guidance,
      diagnostic: details.diagnostic,
      message: "Guidance recorded for leader",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 400;
    res.status(status).json({
      error: status === 404 ? "Not Found" : "Bad Request",
      message,
    });
  }
});

router.get("/tasks/:id/stream", async (req: Request, res: Response) => {
  const taskIdParam = req.params.id;
  const taskId = Array.isArray(taskIdParam) ? taskIdParam[0] : taskIdParam;
  try {
    await streamTaskEvents(taskId, res);
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: "Internal Server Error", message });
  }
});

export { router as apiRouter };
