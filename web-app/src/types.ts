export type TaskStatus = "queued" | "running" | "done" | "ask_user" | "max_loops_reached" | "failed" | "stopped" | "unknown";
export type TaskWorkflow = "run" | "cc-team-run";
export type TeamMode = "supervised" | "multi-role";

export interface Task {
  id: string;
  runDir: string;
  workflow: TaskWorkflow;
  teamMode?: TeamMode;
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

export interface TaskEventRecord {
  id?: number;
  taskId?: string;
  ts: string;
  kind: string;
  role?: string;
  message?: string;
  payloadJson?: string;
}

export interface TaskGuidanceRecord {
  id: number;
  taskId: string;
  ts: string;
  message: string;
  priority: string;
}

export interface TaskDashboardSummary {
  currentStage?: string;
  recommendedAction?: string;
  latestBlocker?: string;
  ownerGuidance?: string;
  supervisorSummary?: string;
  cockpitSource: "cockpit" | "fallback";
}

export interface TaskDetails {
  task: Task;
  progress?: unknown;
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
  diagnostic?: {
    role: string;
    model: string;
    status: string;
    classification: string;
    detail: string;
    idleMs: number;
  };
}

export interface StreamEntry {
  ts?: string;
  role?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}
