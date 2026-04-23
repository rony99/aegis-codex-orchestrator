import { readFile } from "node:fs/promises";
import path from "node:path";

type ManagerDecisionInput = {
  next_action: "develop" | "test" | "done" | "ask_user";
  target?: string;
  instructions?: string;
  reason: string;
};

export const managerSchema = {
  type: "object",
  properties: {
    next_action: {
      type: "string",
      enum: ["develop", "test", "done", "ask_user"],
    },
    target: {
      type: ["string", "null"],
      description: "The module, file, or test target for the next role.",
    },
    instructions: {
      type: ["string", "null"],
      description: "Concrete instructions for the next role.",
    },
    reason: {
      type: "string",
      description: "Brief reason for the decision.",
    },
  },
  required: ["next_action", "target", "instructions", "reason"],
  additionalProperties: false,
} as const;

export function smokePrompt(model: string): string {
  return `You are running a Codex SDK smoke test with model ${model}.

Return exactly one concise sentence confirming that the SDK thread is working.
Do not edit files. Do not run commands.`;
}

export function researcherPrompt(task: string): string {
  return `You are the researcher agent for codex-gtd v0.1.

Goal:
Turn the user's task into frozen planning artifacts for a tiny implementation loop.

Hard constraints:
- Write ./spec.md and ./interfaces.md.
- Keep v0.1 small; no UI, no external services, no speculative features.
- The developer phase must not need to change public interfaces later.
- Acceptance criteria must be testable.
- If the task is ambiguous, choose the smallest reasonable behavior and record the assumption in spec.md.

Files/directories available:
- ./task.md contains the original task.
- ./workspace/ is where implementation will happen later.
- ./progress.md and ./blockers.md exist.

Required ./spec.md sections:
1. Goal
2. Functional Requirements
3. Acceptance Criteria
4. Non-goals
5. Assumptions

Required ./interfaces.md sections:
1. CLI Contract
2. Input/Output Contract
3. Error Contract
4. Test Contract

After writing both files, update ./progress.md with a short researcher status.

Original task:
${task}`;
}

export async function managerPrompt(loop: number, runDir: string): Promise<string> {
  const [task, spec, interfaces, progress, blockers] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
    readOptional(runDir, "blockers.md"),
  ]);

  return `You are the manager agent for codex-gtd v0.1.

Loop: ${loop}

Responsibilities:
- Read the file protocol state.
- Decide exactly one next action.
- Update ./progress.md before returning if status has changed.
- Avoid interrupting the user unless truly necessary.

Allowed next_action values:
- develop: developer should implement or fix code in ./workspace.
- test: tester should write/run tests or verify acceptance criteria.
- done: all acceptance criteria are met and progress.md reflects completion.
- ask_user: only for product decisions, account/key actions, or a hard dead end.

Decision rules:
- If spec.md or interfaces.md is missing/incomplete, choose develop only if the developer can proceed safely; otherwise ask_user with a concrete reason.
- If implementation does not exist or is incomplete, choose develop.
- If implementation exists but has not been verified against acceptance criteria, choose test.
- If tests failed and the failure appears fixable, choose develop with repair instructions.
- If tests passed and acceptance criteria are met, choose done.

Return JSON only. Match the provided schema.

Current task.md:
${task}

Current spec.md:
${spec}

Current interfaces.md:
${interfaces}

Current progress.md:
${progress}

Current blockers.md:
${blockers}`;
}

export async function developerPrompt(decision: ManagerDecisionInput, runDir: string): Promise<string> {
  const [task, spec, interfaces, progress] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
  ]);

  return `You are the developer agent for codex-gtd v0.1.

Implement only inside ./workspace unless you need to update ./progress.md.

Hard constraints:
- Do not modify ./spec.md or ./interfaces.md. Treat interfaces.md as frozen.
- Keep the implementation minimal.
- Use no external services or account-dependent APIs.
- Add or update tests only if needed to verify the contract.
- Run the relevant test command when possible.
- Update ./progress.md with what changed, commands run, and remaining work.
- If blocked, write the reason to ./blockers.md and stop.

Manager decision:
${JSON.stringify(decision, null, 2)}

task.md:
${task}

spec.md:
${spec}

interfaces.md:
${interfaces}

progress.md:
${progress}`;
}

export async function testerPrompt(decision: ManagerDecisionInput, runDir: string): Promise<string> {
  const [task, spec, interfaces, progress] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
  ]);

  return `You are the tester agent for codex-gtd v0.1.

Verify the implementation in ./workspace against spec.md and interfaces.md.

Hard constraints:
- Do not modify ./spec.md or ./interfaces.md.
- Prefer running existing tests. If there are no tests, add the smallest contract test inside ./workspace.
- Run the test command and record the exact command/result in ./progress.md.
- If tests fail, do not hide the failure. Record the failure summary in ./progress.md and write actionable repair notes for the manager.
- If acceptance criteria are fully met, mark that clearly in ./progress.md.

Manager decision:
${JSON.stringify(decision, null, 2)}

task.md:
${task}

spec.md:
${spec}

interfaces.md:
${interfaces}

progress.md:
${progress}`;
}

async function readOptional(runDir: string, file: string): Promise<string> {
  try {
    return await readFile(path.join(runDir, file), "utf8");
  } catch {
    return "(missing)";
  }
}
