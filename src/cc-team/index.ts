import { query, type Options as ClaudeCodeOptions, type OutputFormat, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CC_MODEL = "MiniMax-M2.7";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_MAX_LOOPS = 2;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEVELOPER_MAX_TURNS = 4;
const TESTER_MAX_TURNS = 6;
const ASK_USER_TOOL = "AskUserQuestion";

type CcRole = "developer" | "tester";
type CcTeamStatus = "done" | "ask_user" | "max_loops_reached" | "failed";

export type CcTesterDecision = {
  status: "done" | "develop" | "ask_user";
  reason: string;
};

export type CcRoleRunRequest = {
  role: CcRole;
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  maxTurns: number;
  tools: string[];
  allowedTools: string[];
  outputFormat?: OutputFormat;
  permissionMode: "acceptEdits" | "dontAsk";
  abortController: AbortController;
  interactionRequests: CcInteractionRequest[];
};

export type CcRoleRunner = (request: CcRoleRunRequest) => AsyncIterable<SDKMessage | unknown>;

export type CcTeamRunOptions = {
  taskFile: string;
  runDir?: string;
  runsDir?: string;
  model?: string;
  maxLoops?: number;
  turnTimeoutMs?: number;
  runner?: CcRoleRunner;
};

export type CcTeamRunResult = {
  runDir: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  durationMs: number;
};

type CcRoleTurnResult = {
  role: CcRole;
  sessionId: string | null;
  finalResponse: string;
  events: unknown[];
  interactionRequests: CcInteractionRequest[];
};

export type CcInteractionRequest = {
  role: CcRole;
  type: "ask_user" | "permission";
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID?: string;
  recordedAt: string;
};

type CcRoleDiagnostic = {
  role: CcRole;
  model: string;
  sessionId: string | null;
  status: "running" | "completed" | "failed";
  startedAt: string;
  lastUpdatedAt: string;
  classification: string;
  detail: string;
  lastEventType?: string;
};

type CcTeamRunSummary = {
  schemaVersion: 1;
  provider: "claude-code";
  runDir: string;
  status: CcTeamStatus;
  reason?: string;
  model: string;
  taskFile: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  maxLoops: number;
  turnTimeoutMs: number;
  metrics: {
    sessionLogEntries: number;
    roleTurns: Record<CcRole, number>;
  };
};

const CC_TESTER_DECISION_OUTPUT_FORMAT: OutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["done", "develop", "ask_user"] },
      reason: { type: "string" },
    },
    required: ["status", "reason"],
    additionalProperties: false,
  },
};

export async function runCcTeam(options: CcTeamRunOptions): Promise<CcTeamRunResult> {
  const taskFile = path.resolve(options.taskFile);
  const task = await readFile(taskFile, "utf8");
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CC_MODEL;
  const maxLoops = options.maxLoops ?? DEFAULT_MAX_LOOPS;
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const runDir = path.resolve(options.runDir ?? createCcRunDirectoryName(options.runsDir ?? DEFAULT_RUNS_DIR));
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const roleTurns: Record<CcRole, number> = { developer: 0, tester: 0 };
  const runner = options.runner ?? defaultCcRoleRunner;

  await initializeCcRunProtocol({ runDir, task, model, startedAt });

  let finalStatus: CcTeamStatus = "max_loops_reached";
  let finalReason = `cc team did not finish within ${maxLoops} loop(s).`;
  let sessionLogEntries = 0;

  try {
    for (let loop = 1; loop <= maxLoops; loop += 1) {
      await appendCcProgress(runDir, `\n## Loop ${loop}\n\nDeveloper started.\n`);
      roleTurns.developer += 1;
      const developerTurn = await runCcRole({
        role: "developer",
        model,
        runDir,
        prompt: buildCcDeveloperPrompt(task, loop),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;
      const developerInteraction = firstAskUserInteraction(developerTurn.interactionRequests);
      if (developerInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(developerInteraction);
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, developerInteraction);
        break;
      }

      await appendCcProgress(runDir, `\nTester started.\n`);
      roleTurns.tester += 1;
      const testerTurn = await runCcRole({
        role: "tester",
        model,
        runDir,
        prompt: buildCcTesterPrompt(task, loop),
        runner,
        turnTimeoutMs,
      });
      sessionLogEntries += 1;
      const testerInteraction = firstAskUserInteraction(testerTurn.interactionRequests);
      if (testerInteraction) {
        finalStatus = "ask_user";
        finalReason = summarizeCcInteraction(testerInteraction);
        await appendCcBlocker(runDir, finalReason);
        await writeCcInteractionRequest(runDir, testerInteraction);
        break;
      }

      const decision = parseCcTesterDecision(testerTurn.finalResponse);
      await writeFile(path.join(runDir, "tester-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");

      if (decision.status === "done") {
        finalStatus = "done";
        finalReason = decision.reason;
        break;
      }

      if (decision.status === "ask_user") {
        finalStatus = "ask_user";
        finalReason = decision.reason;
        await appendCcBlocker(runDir, decision.reason);
        break;
      }

      await appendCcProgress(runDir, `\nTester requested another developer pass: ${decision.reason}\n`);
    }
  } catch (error) {
    finalStatus = "failed";
    finalReason = summarizeError(error);
    await appendCcBlocker(runDir, finalReason);
  }

  await appendCcProgress(runDir, `\n## Finished\n\nStatus: ${finalStatus}\nReason: ${finalReason}\n`);
  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const summary: CcTeamRunSummary = {
    schemaVersion: 1,
    provider: "claude-code",
    runDir,
    status: finalStatus,
    reason: finalReason,
    model,
    taskFile,
    startedAt,
    endedAt,
    durationMs,
    maxLoops,
    turnTimeoutMs,
    metrics: {
      sessionLogEntries,
      roleTurns,
    },
  };
  await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  return { runDir, status: finalStatus, reason: finalReason, model, durationMs };
}

export function parseCcTesterDecision(finalResponse: string): CcTesterDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalResponse);
  } catch {
    throw new Error(`cc tester returned non-JSON response: ${finalResponse}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`cc tester returned non-JSON response: ${finalResponse}`);
  }

  const candidate = parsed as Partial<CcTesterDecision>;
  if (candidate.status !== "done" && candidate.status !== "develop" && candidate.status !== "ask_user") {
    throw new Error(`cc tester returned invalid status: ${finalResponse}`);
  }
  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
    throw new Error(`cc tester returned invalid reason: ${finalResponse}`);
  }

  return {
    status: candidate.status,
    reason: candidate.reason,
  };
}

function createCcRunDirectoryName(runsDir: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(runsDir, `cc-${stamp}`);
}

async function initializeCcRunProtocol(input: {
  runDir: string;
  task: string;
  model: string;
  startedAt: string;
}): Promise<void> {
  await mkdir(path.join(input.runDir, "workspace"), { recursive: true });
  await mkdir(path.join(input.runDir, "session-log", "events"), { recursive: true });
  await mkdir(path.join(input.runDir, "session-log", "inflight"), { recursive: true });
  await writeFile(path.join(input.runDir, "task.md"), input.task, "utf8");
  await writeFile(path.join(input.runDir, "blockers.md"), "", "utf8");
  await writeFile(
    path.join(input.runDir, "progress.md"),
    `# CC Team Progress\n\nModel: ${input.model}\nStarted: ${input.startedAt}\n`,
    "utf8",
  );
}

async function runCcRole(input: {
  role: CcRole;
  model: string;
  runDir: string;
  prompt: string;
  runner: CcRoleRunner;
  turnTimeoutMs: number;
}): Promise<CcRoleTurnResult> {
  const startedAt = new Date().toISOString();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), input.turnTimeoutMs);
  const events: unknown[] = [];
  const interactionRequests: CcInteractionRequest[] = [];
  let sessionId: string | null = null;
  let finalResponse = "";
  let classification = "waiting_for_first_cc_event";
  let detail = "No Claude Code SDK event has been received yet.";
  let lastEventType: string | undefined;

  const diagnosticPath = ccDiagnosticPath(input.runDir, startedAt, input.role);
  const eventTracePath = ccEventTracePath(input.runDir, startedAt, input.role);
  const writeDiagnostic = async (status: CcRoleDiagnostic["status"]) => {
    await writeFile(diagnosticPath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status,
      startedAt,
      lastUpdatedAt: new Date().toISOString(),
      classification,
      detail,
      lastEventType,
    } satisfies CcRoleDiagnostic, null, 2)}\n`, "utf8");
  };

  await writeDiagnostic("running");
  try {
    for await (const event of input.runner({
      role: input.role,
      model: input.model,
      cwd: input.runDir,
      prompt: input.prompt,
      systemPrompt: buildCcSystemPrompt(input.role),
      maxTurns: input.role === "developer" ? DEVELOPER_MAX_TURNS : TESTER_MAX_TURNS,
      tools: input.role === "developer" ? ["Read", "Write", "Edit", ASK_USER_TOOL] : ["Read", ASK_USER_TOOL],
      allowedTools: input.role === "developer" ? ["Read", "Write", "Edit"] : ["Read"],
      outputFormat: input.role === "tester" ? CC_TESTER_DECISION_OUTPUT_FORMAT : undefined,
      permissionMode: input.role === "developer" ? "acceptEdits" : "dontAsk",
      abortController,
      interactionRequests,
    })) {
      events.push(event);
      const diagnosis = diagnoseCcEvent(event);
      classification = diagnosis.classification;
      detail = diagnosis.detail;
      lastEventType = formatCcEventType(event);
      sessionId = readStringProperty(event, "session_id") ?? sessionId;
      finalResponse = extractCcFinalResponse(event) ?? finalResponse;
      await writeDiagnostic("running");
      if (shouldAppendCcProgress(diagnosis.classification)) {
        await appendCcProgress(input.runDir, `\n- ${input.role}: ${diagnosis.detail}\n`);
      }
    }

    classification = "turn_completed";
    detail = "The Claude Code SDK role turn completed.";
    await writeDiagnostic("completed");
    await writeFile(eventTracePath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status: "completed",
      startedAt,
      endedAt: new Date().toISOString(),
      events,
    }, null, 2)}\n`, "utf8");
    return { role: input.role, sessionId, finalResponse, events, interactionRequests };
  } catch (error) {
    classification = abortController.signal.aborted ? "turn_timeout" : "cc_sdk_error";
    detail = summarizeError(error);
    await writeDiagnostic("failed");
    await writeFile(eventTracePath, `${JSON.stringify({
      role: input.role,
      model: input.model,
      sessionId,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      events,
      error: detail,
    }, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function defaultCcRoleRunner(request: CcRoleRunRequest): AsyncIterable<SDKMessage> {
  const sdkOptions: ClaudeCodeOptions = {
    model: request.model,
    cwd: request.cwd,
    maxTurns: request.maxTurns,
    tools: request.tools,
    allowedTools: request.allowedTools,
    settingSources: [],
    permissionMode: request.permissionMode,
    abortController: request.abortController,
    outputFormat: request.outputFormat,
    includePartialMessages: true,
    includeHookEvents: true,
    canUseTool: async (toolName, input, context): Promise<PermissionResult> => {
      const interaction = {
        role: request.role,
        type: toolName === ASK_USER_TOOL ? "ask_user" : "permission",
        toolName,
        input,
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        toolUseID: context.toolUseID,
        recordedAt: new Date().toISOString(),
      } satisfies CcInteractionRequest;
      request.interactionRequests.push(interaction);
      return {
        behavior: "deny",
        message: toolName === ASK_USER_TOOL
          ? "User input is required. cc-run recorded this request for the operator."
          : `Tool ${toolName} is not approved for the ${request.role} role.`,
        toolUseID: context.toolUseID,
      };
    },
    systemPrompt: request.systemPrompt,
    settings: {
      includeCoAuthoredBy: false,
      skipDangerousModePermissionPrompt: true,
    },
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1",
    },
  };
  return query({ prompt: request.prompt, options: sdkOptions });
}

function buildCcSystemPrompt(role: CcRole): string {
  if (role === "developer") {
    return "You are the cc developer. Implement only inside the current run directory, preferably under ./workspace. Keep changes minimal.";
  }
  return "You are the cc tester. Verify the workspace result and return JSON only.";
}

function buildCcDeveloperPrompt(task: string, loop: number): string {
  return `You are the developer role in a simplified cc team workflow.

Loop: ${loop}

Task:
${task}

Rules:
- Work in the current directory only.
- Put deliverables under ./workspace unless the task explicitly says otherwise.
- Keep the implementation small.
- Do not run verification commands; the tester role handles verification.
- After making the requested file edits, briefly state what changed and stop.`;
}

function buildCcTesterPrompt(task: string, loop: number): string {
  return `You are the tester role in a simplified cc team workflow.

Loop: ${loop}

Task:
${task}

Verify the files under ./workspace against the task.
Use the Read tool for file verification. Do not use Bash.
Return JSON only with this shape:
{"status":"done"|"develop"|"ask_user","reason":"short reason"}

Use "develop" when the developer can fix the issue in another pass.
Use "ask_user" only for missing product decisions, credentials, or hard blockers.`;
}

function ccDiagnosticPath(runDir: string, startedAt: string, role: CcRole): string {
  return path.join(runDir, "session-log", "inflight", `${startedAt.replaceAll(":", "-")}-${role}.json`);
}

function ccEventTracePath(runDir: string, startedAt: string, role: CcRole): string {
  return path.join(runDir, "session-log", "events", `${startedAt.replaceAll(":", "-")}-${role}.json`);
}

async function appendCcProgress(runDir: string, message: string): Promise<void> {
  const progressPath = path.join(runDir, "progress.md");
  const existing = await readFile(progressPath, "utf8");
  await writeFile(progressPath, `${existing}${message}`, "utf8");
}

async function appendCcBlocker(runDir: string, reason: string): Promise<void> {
  const blockerPath = path.join(runDir, "blockers.md");
  const existing = await readFile(blockerPath, "utf8");
  await writeFile(blockerPath, `${existing}${existing ? "\n" : ""}- ${reason}\n`, "utf8");
}

async function writeCcInteractionRequest(runDir: string, request: CcInteractionRequest): Promise<void> {
  await writeFile(path.join(runDir, "interaction-request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

function firstAskUserInteraction(requests: CcInteractionRequest[]): CcInteractionRequest | undefined {
  return requests.find((request) => request.type === "ask_user");
}

function summarizeCcInteraction(request: CcInteractionRequest): string {
  const title = request.title ?? request.displayName ?? request.toolName;
  return `${request.role} requested user input via ${request.toolName}: ${title}`;
}

function diagnoseCcEvent(event: unknown): { classification: string; detail: string } {
  const type = readStringProperty(event, "type");
  const subtype = readStringProperty(event, "subtype");
  if (type === "system" && subtype === "init") return { classification: "session_started", detail: "Claude Code SDK session started." };
  if (type === "system" && subtype === "api_retry") return { classification: "api_retry", detail: "Claude Code SDK reported an API retry." };
  if (type === "system" && subtype === "status") return { classification: "status", detail: `Claude Code SDK status: ${readStringProperty(event, "status") ?? "unknown"}.` };
  if (type === "system" && subtype === "notification") return { classification: "notification", detail: readStringProperty(event, "text") ?? "Claude Code SDK emitted a notification." };
  if (type === "system" && subtype === "hook_started") return { classification: "hook_started", detail: `Hook started: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "system" && subtype === "hook_progress") return { classification: "hook_progress", detail: `Hook progress: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "system" && subtype === "hook_response") return { classification: "hook_response", detail: `Hook finished: ${readStringProperty(event, "hook_event") ?? "unknown"}.` };
  if (type === "stream_event") return diagnoseCcStreamEvent(event);
  if (type === "tool_progress") {
    return {
      classification: "tool_progress",
      detail: `${readStringProperty(event, "tool_name") ?? "Tool"} is running for ${readNumberProperty(event, "elapsed_time_seconds") ?? 0}s.`,
    };
  }
  if (type === "tool_use_summary") return { classification: "tool_summary", detail: readStringProperty(event, "summary") ?? "Claude Code SDK summarized tool use." };
  if (type === "auth_status") return { classification: "auth_status", detail: readStringProperty(event, "error") ?? "Claude Code SDK authentication status changed." };
  if (type === "rate_limit_event") return { classification: "rate_limit", detail: "Claude Code SDK rate-limit status changed." };
  if (type === "assistant" && hasAssistantToolUse(event)) return { classification: "tool_requested", detail: "Assistant requested a tool call." };
  if (type === "assistant") return { classification: "assistant_message", detail: "Assistant produced content." };
  if (type === "user") return { classification: "tool_result", detail: "Tool result was returned to the assistant." };
  if (type === "result" && subtype === "success") return { classification: "turn_completed", detail: "Claude Code SDK returned a successful result." };
  if (type === "result") return { classification: "turn_finished", detail: `Claude Code SDK returned result subtype ${subtype ?? "unknown"}.` };
  return { classification: "cc_event", detail: `Claude Code SDK event: ${type ?? "unknown"}.` };
}

function diagnoseCcStreamEvent(event: unknown): { classification: string; detail: string } {
  const streamEvent = readObjectProperty(event, "event");
  const eventType = readStringProperty(streamEvent, "type");
  if (eventType === "content_block_start") {
    const contentBlock = readObjectProperty(streamEvent, "content_block");
    if (readStringProperty(contentBlock, "type") === "tool_use") {
      return { classification: "tool_input_streaming", detail: `Claude is preparing ${readStringProperty(contentBlock, "name") ?? "a tool"} input.` };
    }
  }
  if (eventType === "content_block_delta") {
    const delta = readObjectProperty(streamEvent, "delta");
    if (readStringProperty(delta, "type") === "text_delta") {
      return { classification: "text_streaming", detail: "Claude is streaming text." };
    }
    if (readStringProperty(delta, "type") === "input_json_delta") {
      return { classification: "tool_input_streaming", detail: "Claude is streaming tool input." };
    }
  }
  return { classification: "stream_event", detail: `Claude Code SDK stream event: ${eventType ?? "unknown"}.` };
}

function shouldAppendCcProgress(classification: string): boolean {
  return [
    "api_retry",
    "auth_status",
    "hook_response",
    "notification",
    "rate_limit",
    "session_started",
    "status",
    "tool_input_streaming",
    "tool_progress",
    "tool_requested",
    "tool_summary",
    "turn_completed",
  ].includes(classification);
}

function hasAssistantToolUse(event: unknown): boolean {
  const content = readMessageContent(event);
  return content.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "tool_use");
}

function extractCcFinalResponse(event: unknown): string | undefined {
  if (readStringProperty(event, "type") === "result") {
    const structuredOutput = readUnknownProperty(event, "structured_output");
    if (structuredOutput !== undefined) {
      return JSON.stringify(structuredOutput);
    }
    return readStringProperty(event, "result");
  }
  const text = readMessageContent(event)
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? (item as { text?: unknown }).text
      : undefined)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
  return text || undefined;
}

function readMessageContent(event: unknown): unknown[] {
  if (!event || typeof event !== "object") return [];
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function readStringProperty(event: unknown, key: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberProperty(event: unknown, key: string): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function readObjectProperty(event: unknown, key: string): Record<string, unknown> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readUnknownProperty(event: unknown, key: string): unknown {
  if (!event || typeof event !== "object") return undefined;
  return (event as Record<string, unknown>)[key];
}

function formatCcEventType(event: unknown): string | undefined {
  const type = readStringProperty(event, "type");
  const subtype = readStringProperty(event, "subtype");
  if (subtype) return `${type}.${subtype}`;
  if (type === "stream_event") {
    const streamEvent = readObjectProperty(event, "event");
    const eventType = readStringProperty(streamEvent, "type");
    return eventType ? `${type}.${eventType}` : type;
  }
  return type;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
