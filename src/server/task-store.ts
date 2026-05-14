import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type StoredTaskStatus = "queued" | "running" | "done" | "ask_user" | "max_loops_reached" | "failed" | "stopped" | "unknown";
export type StoredTaskWorkflow = "run" | "cc-team-run";
export type StoredTeamMode = "supervised" | "multi-role";

export interface TaskRecord {
  id: string;
  runDir: string;
  workflow: StoredTaskWorkflow;
  teamMode?: StoredTeamMode;
  status: StoredTaskStatus;
  description: string;
  createdAt: string;
  targetDir?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  failureCategory?: string;
  terminalRole?: string;
  currentStage?: string;
  recommendedAction?: string;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  ts: string;
  kind: string;
  role?: string;
  message?: string;
  payloadJson?: string;
}

export interface TaskReplyRecord {
  id: number;
  taskId: string;
  ts: string;
  reply: string;
}

export interface TaskGuidanceRecord {
  id: number;
  taskId: string;
  ts: string;
  message: string;
  priority: string;
}

export interface TaskListFilter {
  limit?: number;
  runsDir?: string;
  workflow?: StoredTaskWorkflow;
  status?: StoredTaskStatus;
}

export interface TaskStore {
  upsertTask(task: TaskRecord): void;
  updateTask(id: string, patch: Partial<Omit<TaskRecord, "id">>): void;
  getTask(id: string): TaskRecord | undefined;
  listTasks(filter?: TaskListFilter): TaskRecord[];
  recordEvent(event: Omit<TaskEventRecord, "id">): void;
  listEvents(taskId: string): TaskEventRecord[];
  recordReply(taskId: string, reply: string, ts?: string): void;
  listReplies(taskId: string): TaskReplyRecord[];
  recordGuidance(taskId: string, message: string, priority?: string, ts?: string): void;
  listGuidance(taskId: string): TaskGuidanceRecord[];
  close(): void;
}

type TaskRow = {
  id: string;
  run_dir: string;
  workflow: StoredTaskWorkflow;
  team_mode: StoredTeamMode | null;
  status: StoredTaskStatus;
  description: string;
  target_dir: string | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  reason: string | null;
  failure_category: string | null;
  terminal_role: string | null;
  current_stage: string | null;
  recommended_action: string | null;
};

type ReplyRow = {
  id: number;
  task_id: string;
  ts: string;
  reply: string;
};

type GuidanceRow = {
  id: number;
  task_id: string;
  ts: string;
  message: string;
  priority: string;
};

type EventRow = {
  id: number;
  task_id: string;
  ts: string;
  kind: string;
  role: string | null;
  message: string | null;
  payload_json: string | null;
};

const DEFAULT_DB_PATH = path.resolve(process.cwd(), ".codex-gtd", "server.sqlite");

export function defaultTaskStorePath(): string {
  return path.resolve(process.env.CODEX_GTD_SERVER_DB_PATH || DEFAULT_DB_PATH);
}

export function createSqliteTaskStore(dbPath: string = defaultTaskStorePath()): TaskStore {
  const resolvedPath = path.resolve(dbPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initializeSchema(db);

  const upsertTaskStmt = db.prepare(`
    INSERT INTO tasks (
      id, run_dir, workflow, team_mode, status, description, target_dir, model, created_at,
      started_at, ended_at, reason, failure_category, terminal_role, current_stage, recommended_action
    ) VALUES (
      @id, @runDir, @workflow, @teamMode, @status, @description, @targetDir, @model, @createdAt,
      @startedAt, @endedAt, @reason, @failureCategory, @terminalRole, @currentStage, @recommendedAction
    )
    ON CONFLICT(id) DO UPDATE SET
      run_dir = excluded.run_dir,
      workflow = excluded.workflow,
      team_mode = excluded.team_mode,
      status = excluded.status,
      description = excluded.description,
      target_dir = excluded.target_dir,
      model = excluded.model,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      reason = excluded.reason,
      failure_category = excluded.failure_category,
      terminal_role = excluded.terminal_role,
      current_stage = excluded.current_stage,
      recommended_action = excluded.recommended_action
  `);

  return {
    upsertTask(task) {
      upsertTaskStmt.run(toTaskParams(task));
    },

    updateTask(id, patch) {
      const existing = this.getTask(id);
      if (!existing) return;
      this.upsertTask({ ...existing, ...patch, id });
    },

    getTask(id) {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      return row ? fromTaskRow(row) : undefined;
    },

    listTasks(filter = {}) {
      const rows = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as TaskRow[];
      let tasks = rows.map(fromTaskRow);
      if (filter.runsDir) {
        const prefix = `${path.resolve(filter.runsDir)}${path.sep}`;
        tasks = tasks.filter((task) => path.resolve(task.runDir).startsWith(prefix));
      }
      if (filter.workflow) {
        tasks = tasks.filter((task) => task.workflow === filter.workflow);
      }
      if (filter.status) {
        tasks = tasks.filter((task) => task.status === filter.status);
      }
      return filter.limit ? tasks.slice(0, filter.limit) : tasks;
    },

    recordEvent(event) {
      db.prepare(`
        INSERT INTO task_events (task_id, ts, kind, role, message, payload_json)
        VALUES (@taskId, @ts, @kind, @role, @message, @payloadJson)
      `).run({
        taskId: event.taskId,
        ts: event.ts,
        kind: event.kind,
        role: event.role ?? null,
        message: event.message ?? null,
        payloadJson: event.payloadJson ?? null,
      });
    },

    listEvents(taskId) {
      const rows = db.prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY id ASC").all(taskId) as EventRow[];
      return rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        ts: row.ts,
        kind: row.kind,
        role: row.role ?? undefined,
        message: row.message ?? undefined,
        payloadJson: row.payload_json ?? undefined,
      }));
    },

    recordReply(taskId, reply, ts = new Date().toISOString()) {
      db.prepare("INSERT INTO task_replies (task_id, ts, reply) VALUES (?, ?, ?)").run(taskId, ts, reply);
    },

    listReplies(taskId) {
      const rows = db.prepare("SELECT * FROM task_replies WHERE task_id = ? ORDER BY id ASC").all(taskId) as ReplyRow[];
      return rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        ts: row.ts,
        reply: row.reply,
      }));
    },

    recordGuidance(taskId, message, priority = "normal", ts = new Date().toISOString()) {
      db.prepare("INSERT INTO task_guidance (task_id, ts, message, priority) VALUES (?, ?, ?, ?)").run(taskId, ts, message, priority);
    },

    listGuidance(taskId) {
      const rows = db.prepare("SELECT * FROM task_guidance WHERE task_id = ? ORDER BY id ASC").all(taskId) as GuidanceRow[];
      return rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        ts: row.ts,
        message: row.message,
        priority: row.priority,
      }));
    },

    close() {
      db.close();
    },
  };
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      run_dir TEXT NOT NULL,
      workflow TEXT NOT NULL DEFAULT 'run',
      team_mode TEXT,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      target_dir TEXT,
      model TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      reason TEXT,
      failure_category TEXT,
      terminal_role TEXT,
      current_stage TEXT,
      recommended_action TEXT
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT,
      message TEXT,
      payload_json TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      reply TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_guidance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_run_dir ON tasks(run_dir);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_replies_task_id ON task_replies(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_guidance_task_id ON task_guidance(task_id);
  `);
  ensureColumn(db, "tasks", "team_mode", "TEXT");
}

function toTaskParams(task: TaskRecord): Record<string, string | null> {
  return {
    id: task.id,
    runDir: task.runDir,
    workflow: task.workflow,
    teamMode: task.teamMode ?? null,
    status: task.status,
    description: task.description,
    targetDir: task.targetDir ?? null,
    model: task.model ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    endedAt: task.endedAt ?? null,
    reason: task.reason ?? null,
    failureCategory: task.failureCategory ?? null,
    terminalRole: task.terminalRole ?? null,
    currentStage: task.currentStage ?? null,
    recommendedAction: task.recommendedAction ?? null,
  };
}

function fromTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    runDir: row.run_dir,
    workflow: row.workflow,
    teamMode: row.team_mode ?? undefined,
    status: row.status,
    description: row.description,
    targetDir: row.target_dir ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    reason: row.reason ?? undefined,
    failureCategory: row.failure_category ?? undefined,
    terminalRole: row.terminal_role ?? undefined,
    currentStage: row.current_stage ?? undefined,
    recommendedAction: row.recommended_action ?? undefined,
  };
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
