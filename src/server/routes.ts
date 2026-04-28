import { Router, type Request, type Response } from "express";
import { createTask, getTask, listTasks, getTaskDetails, replyToTask, type Task } from "./task-manager.js";

const router = Router();

interface CreateTaskRequest {
  description: string;
  model?: string;
  maxLoops?: number;
  skipDiscovery?: boolean;
  monitorSdk?: boolean;
}

interface ReplyTaskRequest {
  reply: string;
}

function formatTaskResponse(task: Task) {
  return {
    id: task.id,
    runDir: task.runDir,
    status: task.status,
    description: task.description,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    reason: task.reason,
    terminalRole: task.terminalRole,
    failureCategory: task.failureCategory,
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
    const tasks = await listTasks({ limit });

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

export { router as apiRouter };
