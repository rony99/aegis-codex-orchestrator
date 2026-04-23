import { Codex, type Thread } from "@openai/codex-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  developerPrompt,
  managerPrompt,
  managerSchema,
  researcherPrompt,
  smokePrompt,
  testerPrompt,
} from "./prompts.js";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_RUNS_DIR = "runs";
const DEFAULT_MAX_LOOPS = 8;
const MODEL_ALIASES: Record<string, string> = {
  "codex-5.3-spark": "gpt-5.3-codex-spark",
};

type Role = "researcher" | "manager" | "developer" | "tester" | "smoke";
type CodexTurn = Awaited<ReturnType<Thread["run"]>>;

export type RunOptions = {
  taskFile: string;
  model?: string;
  runsDir?: string;
  maxLoops?: number;
};

export type RunResult = {
  runDir: string;
  status: "done" | "ask_user" | "max_loops_reached";
  reason?: string;
};

type ManagerDecision = {
  next_action: "develop" | "test" | "done" | "ask_user";
  target?: string;
  instructions?: string;
  reason: string;
};

type RunContext = {
  codex: Codex;
  model: string;
  runDir: string;
  workspaceDir: string;
  task: string;
  threads: Map<Role, Thread>;
};

export async function runSmokeTest(options: { model?: string } = {}): Promise<CodexTurn> {
  const model = resolveModel(options.model);
  const codex = new Codex();
  const thread = codex.startThread({
    model,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });

  return thread.run(smokePrompt(model));
}

export async function runOrchestration(options: RunOptions): Promise<RunResult> {
  const model = resolveModel(options.model);
  const runDir = await createRunDirectory(options.runsDir ?? DEFAULT_RUNS_DIR);
  const workspaceDir = path.join(runDir, "workspace");
  const task = await readFile(path.resolve(options.taskFile), "utf8");

  await mkdir(path.join(runDir, "session-log"), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(runDir, "task.md"), task);
  await writeFile(path.join(runDir, "progress.md"), initialProgress(model));
  await writeFile(path.join(runDir, "blockers.md"), "# Blockers\n\nNone.\n");

  const context: RunContext = {
    codex: new Codex(),
    model,
    runDir,
    workspaceDir,
    task,
    threads: new Map<Role, Thread>(),
  };

  await runRole(context, "researcher", researcherPrompt(task));

  const maxLoops = options.maxLoops ?? DEFAULT_MAX_LOOPS;
  for (let loop = 1; loop <= maxLoops; loop += 1) {
    const managerTurn = await runRole(context, "manager", await managerPrompt(loop, context.runDir));
    const decision = parseManagerDecision(managerTurn.finalResponse);

    if (decision.next_action === "done") {
      await appendProgress(context.runDir, `\n## Final\n\nDone: ${decision.reason}\n`);
      return { runDir, status: "done", reason: decision.reason };
    }

    if (decision.next_action === "ask_user") {
      await appendBlocker(context.runDir, decision.reason);
      return { runDir, status: "ask_user", reason: decision.reason };
    }

    if (decision.next_action === "develop") {
      await runRole(context, "developer", await developerPrompt(decision, context.runDir));
      continue;
    }

    if (decision.next_action === "test") {
      await runRole(context, "tester", await testerPrompt(decision, context.runDir));
      continue;
    }
  }

  const reason = `Manager did not finish within ${maxLoops} loop(s).`;
  await appendBlocker(context.runDir, reason);
  return { runDir, status: "max_loops_reached", reason };
}

async function runRole(context: RunContext, role: Role, prompt: string): Promise<CodexTurn> {
  const thread = getThread(context, role);
  const startedAt = new Date().toISOString();
  const turn = role === "manager"
    ? await thread.run(prompt, { outputSchema: managerSchema })
    : await thread.run(prompt);
  const endedAt = new Date().toISOString();

  await writeSessionLog(context, {
    role,
    prompt,
    turn,
    startedAt,
    endedAt,
    threadId: thread.id,
  });

  return turn;
}

function getThread(context: RunContext, role: Role): Thread {
  const existing = context.threads.get(role);
  if (existing) return existing;

  const thread = context.codex.startThread({
    model: context.model,
    workingDirectory: context.runDir,
    skipGitRepoCheck: true,
    sandboxMode: role === "smoke" ? "read-only" : "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: true,
  });
  context.threads.set(role, thread);
  return thread;
}

async function writeSessionLog(
  context: RunContext,
  entry: {
    role: Role;
    prompt: string;
    turn: CodexTurn;
    startedAt: string;
    endedAt: string;
    threadId: string | null;
  },
): Promise<void> {
  const safeStartedAt = entry.startedAt.replaceAll(":", "-");
  const file = path.join(
    context.runDir,
    "session-log",
    `${safeStartedAt}-${entry.role}.json`,
  );

  await writeFile(
    file,
    `${JSON.stringify(
      {
        role: entry.role,
        model: context.model,
        threadId: entry.threadId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        prompt: entry.prompt,
        finalResponse: entry.turn.finalResponse,
        usage: entry.turn.usage,
        items: entry.turn.items,
      },
      null,
      2,
    )}\n`,
  );
}

function parseManagerDecision(finalResponse: string): ManagerDecision {
  const parsed = parseJsonObject(finalResponse);

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Manager returned non-JSON response: ${finalResponse}`);
  }

  const candidate = parsed as Partial<ManagerDecision>;
  if (
    candidate.next_action !== "develop"
    && candidate.next_action !== "test"
    && candidate.next_action !== "done"
    && candidate.next_action !== "ask_user"
  ) {
    throw new Error(`Manager returned invalid next_action: ${finalResponse}`);
  }

  return {
    next_action: candidate.next_action,
    target: typeof candidate.target === "string" ? candidate.target : undefined,
    instructions: typeof candidate.instructions === "string" ? candidate.instructions : undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason : "No reason provided.",
  };
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    return JSON.parse(text.slice(first, last + 1));
  }
}

async function createRunDirectory(runsDir: string): Promise<string> {
  const absoluteRunsDir = path.resolve(runsDir);
  await mkdir(absoluteRunsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const runDir = path.join(absoluteRunsDir, stamp);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

function resolveModel(model?: string): string {
  const requested = model ?? process.env.CODEX_GTD_MODEL ?? DEFAULT_MODEL;
  return MODEL_ALIASES[requested] ?? requested;
}

function initialProgress(model: string): string {
  return `# Progress

- Status: initialized
- Model: ${model}
- Run URL: ${pathToFileURL(process.cwd()).href}

`;
}

async function appendProgress(runDir: string, text: string): Promise<void> {
  const current = await readFile(path.join(runDir, "progress.md"), "utf8");
  await writeFile(path.join(runDir, "progress.md"), current + text);
}

async function appendBlocker(runDir: string, reason: string): Promise<void> {
  const current = await readFile(path.join(runDir, "blockers.md"), "utf8");
  const next = current.replace(/\nNone\.\n?$/, "\n");
  await writeFile(path.join(runDir, "blockers.md"), `${next}\n- ${reason}\n`);
}
