import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createTask, getTaskDetails, listTasks, replyToTask, sendGuidance, stopTask } from "./api";
import type { StreamEntry, Task, TaskDetails, TaskEventRecord, TaskStatus, TaskWorkflow, TeamMode } from "./types";
import "./styles.css";

const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  ask_user: "等待输入",
  max_loops_reached: "循环上限",
  failed: "失败",
  stopped: "已停止",
  unknown: "未知",
};

const teamStages = ["spec", "plan", "build", "test", "review", "ship"];

function App() {
  const initialTaskId = parseTaskId(location.pathname);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialTaskId);
  const [details, setDetails] = useState<TaskDetails | undefined>();
  const [events, setEvents] = useState<StreamEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedId), [tasks, selectedId]);

  async function refreshTasks() {
    const nextTasks = await listTasks();
    setTasks(nextTasks);
    if (!selectedId && nextTasks[0]) setSelectedId(nextTasks[0].id);
  }

  async function refreshDetails(taskId = selectedId) {
    if (!taskId) return;
    const nextDetails = await getTaskDetails(taskId);
    setDetails(nextDetails);
  }

  useEffect(() => {
    void refreshTasks().catch((err: Error) => setError(err.message));
    const timer = window.setInterval(() => {
      void refreshTasks().catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    history.replaceState(null, "", `/task/${selectedId}`);
    setEvents([]);
    void refreshDetails(selectedId).catch((err: Error) => setError(err.message));
    const source = new EventSource(`/api/tasks/${encodeURIComponent(selectedId)}/stream`);
    source.onmessage = (event) => {
      try {
        setEvents((items) => [...items.slice(-199), JSON.parse(event.data) as StreamEntry]);
      } catch {
        setEvents((items) => [...items.slice(-199), { kind: "raw", payload: { text: event.data } }]);
      }
    };
    source.addEventListener("end", () => {
      source.close();
      void refreshTasks();
      void refreshDetails(selectedId);
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [selectedId]);

  async function handleCreate(input: CreateTaskInput) {
    setError(undefined);
    const task = await createTask(input);
    setTasks((items) => [task, ...items.filter((item) => item.id !== task.id)]);
    setSelectedId(task.id);
  }

  async function handleReply(reply: string) {
    if (!selectedId) return;
    const nextDetails = await replyToTask(selectedId, reply);
    setDetails(nextDetails);
    await refreshTasks();
  }

  async function handleGuidance(message: string, priority?: string) {
    if (!selectedId) return;
    const nextDetails = await sendGuidance(selectedId, message, priority);
    setDetails(nextDetails);
    await refreshTasks();
  }

  async function handleStop() {
    if (!selectedId) return;
    const nextDetails = await stopTask(selectedId);
    setDetails(nextDetails);
    await refreshTasks();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Codex GTD Team Console</h1>
          <p>本地 Claude Code 团队生命周期控制台</p>
        </div>
        <button className="ghost-button" onClick={() => void refreshTasks()}>刷新</button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="workspace">
        <section className="left-pane">
          <TaskCreateForm onCreate={(input) => void handleCreate(input).catch((err: Error) => setError(err.message))} />
          <TaskList tasks={tasks} selectedId={selectedId} onSelect={setSelectedId} />
        </section>

        <section className="right-pane">
          {selectedId && details
            ? <TaskDetail details={details} events={events} selectedTask={selectedTask} onReply={handleReply} onGuidance={handleGuidance} onStop={() => void handleStop().catch((err: Error) => setError(err.message))} />
            : <EmptyState />}
        </section>
      </main>
    </div>
  );
}

type CreateTaskInput = {
  description: string;
  workflow: TaskWorkflow;
  teamMode?: TeamMode;
  targetDir?: string;
  model?: string;
  maxLoops?: number;
};

function TaskCreateForm({ onCreate }: { onCreate: (input: CreateTaskInput) => void }) {
  const [description, setDescription] = useState("");
  const [workflow, setWorkflow] = useState<TaskWorkflow>("cc-team-run");
  const [teamMode, setTeamMode] = useState<TeamMode>("supervised");
  const [targetDir, setTargetDir] = useState("");
  const [model, setModel] = useState("MiniMax-M2.7");
  const [maxLoops, setMaxLoops] = useState("4");
  const canSubmit = description.trim().length > 0;

  return (
    <form className="panel create-panel" onSubmit={(event) => {
      event.preventDefault();
      if (!canSubmit) return;
      onCreate({
        description: description.trim(),
        workflow,
        teamMode: workflow === "cc-team-run" ? teamMode : undefined,
        targetDir: targetDir.trim() || undefined,
        model: model.trim() || undefined,
        maxLoops: maxLoops ? Number(maxLoops) : undefined,
      });
      setDescription("");
    }}>
      <div className="panel-title">
        <h2>新任务</h2>
        <span>默认团队生命周期</span>
      </div>
      <label>
        <span>任务描述</span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="描述你想让团队完成的目标..." />
      </label>
      <div className="form-grid">
        <label>
          <span>Workflow</span>
          <select value={workflow} onChange={(event) => setWorkflow(event.target.value as TaskWorkflow)}>
            <option value="cc-team-run">cc-team-run</option>
            <option value="run">run</option>
          </select>
        </label>
        <label>
          <span>Model</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
      </div>
      {workflow === "cc-team-run" && (
        <label>
          <span>Team mode</span>
          <select value={teamMode} onChange={(event) => setTeamMode(event.target.value as TeamMode)}>
            <option value="supervised">supervised: Leader + Supervisor</option>
            <option value="multi-role">multi-role: multi SDK roles</option>
          </select>
        </label>
      )}
      <label>
        <span>Target repo</span>
        <input value={targetDir} onChange={(event) => setTargetDir(event.target.value)} placeholder="/Users/rony/me/project" />
      </label>
      <label>
        <span>Max loops</span>
        <input type="number" min="1" value={maxLoops} onChange={(event) => setMaxLoops(event.target.value)} />
      </label>
      <button className="primary-button" disabled={!canSubmit}>启动</button>
    </form>
  );
}

function TaskList({ tasks, selectedId, onSelect }: { tasks: Task[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <section className="panel task-list-panel">
      <div className="panel-title">
        <h2>History</h2>
        <span>{tasks.length} 个任务</span>
      </div>
      <div className="task-list">
        {tasks.map((task) => (
          <button key={task.id} className={`task-row ${task.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(task.id)}>
            <div>
              <strong>{task.description || task.id}</strong>
              <small>{task.workflow}{task.teamMode ? `/${task.teamMode}` : ""} · {task.currentStage || task.terminalRole || "pending"} · {formatTime(task.createdAt)}</small>
            </div>
            <StatusBadge status={task.status} />
          </button>
        ))}
      </div>
    </section>
  );
}

function TaskDetail({ details, events, selectedTask, onReply, onGuidance, onStop }: {
  details: TaskDetails;
  events: StreamEntry[];
  selectedTask?: Task;
  onReply: (reply: string) => Promise<void>;
  onGuidance: (message: string, priority?: string) => Promise<void>;
  onStop: () => void;
}) {
  const task = details.task || selectedTask;
  const artifacts = Object.entries(details.artifacts || {}).filter(([name]) => !["team-cockpit.md", "supervisor-report.md"].includes(name));
  const supervisorReport = details.artifacts?.["supervisor-report.md"];
  const stage = details.dashboardSummary?.currentStage || task.currentStage;
  const timelineEvents = combineTimeline(details.events || [], events);
  return (
    <div className="detail-stack">
      <section className="panel detail-header">
        <div>
          <div className="task-title-line">
            <h2>{task.description}</h2>
            <StatusBadge status={task.status} />
          </div>
          <p>{task.workflow}{task.teamMode ? ` · ${task.teamMode}` : ""} · stage {stage || "-"} · action {details.dashboardSummary?.recommendedAction || task.recommendedAction || "-"}</p>
          <code>{task.runDir}</code>
        </div>
        {task.status === "running" && <button className="danger-button" onClick={onStop}>停止</button>}
      </section>

      {task.status === "ask_user" && <ReplyPanel blockers={details.blockers} onReply={onReply} />}

      <StageProgress currentStage={stage} status={task.status} />

      <section className="metrics-grid">
        <InfoBox label="当前阶段" value={stage || "-"} />
        <InfoBox label="推荐动作" value={details.dashboardSummary?.recommendedAction || task.recommendedAction || "-"} />
        <InfoBox label="最新阻塞" value={details.dashboardSummary?.latestBlocker || "-"} />
        <InfoBox label="老板 Guidance" value={details.dashboardSummary?.ownerGuidance || "-"} />
      </section>

      <div className="dashboard-grid">
        <section className="panel cockpit-panel">
          <div className="panel-title"><h2>老板驾驶舱</h2><span>{details.dashboardSummary?.cockpitSource || "fallback"}</span></div>
          <pre className="cockpit-markdown">{details.cockpitMarkdown || "还没有 cockpit 文档，等待 leader 更新。"}</pre>
        </section>

        <section className="side-stack">
          <SupervisorPanel report={supervisorReport} summary={details.dashboardSummary?.supervisorSummary} />
          <GuidancePanel guidance={details.guidance || []} onGuidance={onGuidance} />
        </section>
      </div>

      <section className="panel timeline-panel">
        <div className="panel-title"><h2>状态流转</h2><span>{timelineEvents.length} events</span></div>
        {timelineEvents.length ? (
          <div className="timeline">
            {timelineEvents.slice(-80).reverse().map((event, index) => (
              <div className="timeline-item" key={`${event.ts}-${event.kind}-${index}`}>
                <time>{formatTime(event.ts)}</time>
                <strong>{event.role || event.kind || "event"}</strong>
                <span>{event.message || formatEventPayload(event)}</span>
              </div>
            ))}
          </div>
        ) : <p className="muted">还没有状态事件。</p>}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>交付产物</h2><span>{artifacts.length}</span></div>
        {artifacts.length ? artifacts.map(([name, content]) => (
          <details className="artifact" key={name}>
            <summary>{name}</summary>
            <pre>{content}</pre>
          </details>
        )) : <p className="muted">还没有交付产物。</p>}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Live Log</h2><span>{events.length} events</span></div>
        <pre className="log-view">{events.length ? events.map(formatEvent).join("\n") : details.log || "等待事件..."}</pre>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Team State</h2><span>JSON</span></div>
        <pre className="json-view">{JSON.stringify(details.teamState || details.summary || {}, null, 2)}</pre>
      </section>
    </div>
  );
}

function StageProgress({ currentStage, status }: { currentStage?: string; status: TaskStatus }) {
  const activeIndex = Math.max(0, teamStages.indexOf(currentStage || ""));
  const isDone = status === "done";
  return (
    <section className="panel stage-panel" aria-label="Team lifecycle progress">
      {teamStages.map((stage, index) => {
        const state = isDone || index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
        return (
          <div className={`stage-step ${state}`} key={stage}>
            <span>{index + 1}</span>
            <strong>{stage}</strong>
          </div>
        );
      })}
    </section>
  );
}

function SupervisorPanel({ report, summary }: { report?: string; summary?: string }) {
  return (
    <section className="panel supervisor-panel">
      <div className="panel-title"><h2>Supervisor</h2><span>监督摘要</span></div>
      <p>{summary || firstLines(report, 2) || "等待 supervisor 检查。"}</p>
      {report && (
        <details className="artifact">
          <summary>查看完整监督记录</summary>
          <pre>{report}</pre>
        </details>
      )}
    </section>
  );
}

function GuidancePanel({ guidance, onGuidance }: {
  guidance: Array<{ id: number; ts: string; message: string; priority: string }>;
  onGuidance: (message: string, priority?: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  return (
    <section className="panel guidance-panel">
      <div className="panel-title"><h2>给 Leader 发引导</h2><span>{guidance.length} 条</span></div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!message.trim()) return;
        setSubmitting(true);
        void onGuidance(message.trim(), priority).then(() => {
          setMessage("");
        }).finally(() => setSubmitting(false));
      }}>
        <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="说明下一步重点、产品取舍或新的方向..." />
        <div className="guidance-actions">
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="normal">normal</option>
            <option value="high">high</option>
            <option value="low">low</option>
          </select>
          <button className="primary-button" disabled={!message.trim() || submitting}>{submitting ? "发送中" : "发送"}</button>
        </div>
      </form>
      {guidance.length ? (
        <div className="guidance-list">
          {guidance.slice(-4).reverse().map((item) => (
            <div key={item.id}>
              <span>{formatTime(item.ts)} · {item.priority}</span>
              <p>{item.message}</p>
            </div>
          ))}
        </div>
      ) : <p className="muted">还没有老板 guidance。</p>}
    </section>
  );
}

function ReplyPanel({ blockers, onReply }: { blockers?: string; onReply: (reply: string) => Promise<void> }) {
  const [reply, setReply] = useState("");
  return (
    <section className="panel reply-panel">
      <div>
        <h2>需要你确认</h2>
        <pre>{blockers || "当前任务正在等待输入。"}</pre>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!reply.trim()) return;
        void onReply(reply.trim()).then(() => setReply(""));
      }}>
        <textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="输入决策、凭据说明或功能取舍..." />
        <button className="primary-button">提交回复并恢复</button>
      </form>
    </section>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status ${status}`}>{statusLabels[status] || status}</span>;
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return <div className="info-box"><span>{label}</span><strong>{value}</strong></div>;
}

function EmptyState() {
  return <section className="panel empty-state"><h2>选择或创建一个任务</h2><p>团队运行状态、日志和交付产物会显示在这里。</p></section>;
}

function parseTaskId(pathname: string): string | undefined {
  const match = pathname.match(/^\/task\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function formatTime(value?: string): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatEvent(event: StreamEntry): string {
  const text = typeof event.payload?.text === "string" ? event.payload.text : JSON.stringify(event.payload || {});
  return `[${event.ts || "-"}] ${event.role || "-"} ${event.kind || "event"} ${text}`;
}

function combineTimeline(stored: TaskEventRecord[], live: StreamEntry[]): TaskEventRecord[] {
  const liveEvents = live.map((event, index) => ({
    id: -index - 1,
    ts: event.ts || new Date().toISOString(),
    kind: event.kind || "stream",
    role: event.role,
    message: formatEventPayload(event),
  }));
  return [...stored, ...liveEvents].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function formatEventPayload(event: Pick<StreamEntry, "payload"> & { payloadJson?: string }): string {
  if ("payloadJson" in event && event.payloadJson) return event.payloadJson;
  if (typeof event.payload?.text === "string") return event.payload.text;
  if (typeof event.payload?.message === "string") return event.payload.message;
  return JSON.stringify(event.payload || {});
}

function firstLines(value?: string, count = 2): string {
  if (!value) return "";
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, count).join("\n");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
