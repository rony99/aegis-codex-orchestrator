import type { Task, TaskDetails, TaskStatus, TaskWorkflow, TeamMode } from "./types";

export async function listTasks(filters: { workflow?: TaskWorkflow; status?: TaskStatus } = {}): Promise<Task[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.workflow) params.set("workflow", filters.workflow);
  if (filters.status) params.set("status", filters.status);
  const response = await fetch(`/api/tasks?${params.toString()}`);
  const body = await readJson<{ tasks: Task[] }>(response);
  return body.tasks;
}

export async function createTask(input: {
  description: string;
  workflow: TaskWorkflow;
  teamMode?: TeamMode;
  targetDir?: string;
  model?: string;
  maxLoops?: number;
}): Promise<Task> {
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await readJson<{ task: Task }>(response);
  return body.task;
}

export async function getTaskDetails(id: string): Promise<TaskDetails> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`);
  return readJson<TaskDetails>(response);
}

export async function replyToTask(id: string, reply: string): Promise<TaskDetails> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  return readJson<TaskDetails>(response);
}

export async function sendGuidance(id: string, message: string, priority = "normal"): Promise<TaskDetails> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/guidance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, priority }),
  });
  return readJson<TaskDetails>(response);
}

export async function stopTask(id: string): Promise<TaskDetails> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: "POST" });
  return readJson<TaskDetails>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { message?: string };
  if (!response.ok) {
    throw new Error(body.message || `Request failed with ${response.status}`);
  }
  return body;
}
