import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const OBSERVER_PROMPT_MAX_CHARS = 40_000;
export const OBSERVER_SECTION_MAX_CHARS = 3_500;
export const OBSERVER_PROTOCOL_HEALTH_MAX_CHARS = 5_000;
export const OBSERVER_SESSION_LOG_MAX_CHARS = 8_000;
export const OBSERVER_SESSION_LOG_MAX_ENTRIES = 8;
export const OBSERVER_SESSION_LOG_ENTRY_MAX_CHARS = 900;
export const OBSERVER_TRUNCATION_MARKER = "truncated";

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

export const discoverySchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["complete", "needs_input"],
      description: "Whether discovery is ready for implementation.",
    },
    discovery_md: {
      type: "string",
      description: "Full markdown content for discovery.md.",
    },
    open_questions: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Only when status=needs_input. Concrete clarification questions.",
    },
  },
  required: ["status", "discovery_md", "open_questions"],
  additionalProperties: false,
} as const;

export function smokePrompt(model: string): string {
  return `You are running a Codex SDK smoke test with model ${model}.

Return exactly one concise sentence confirming that the SDK thread is working.
Do not edit files. Do not run commands.`;
}

export async function discoveryPrompt(task: string, snippetsDir: string, answers: string = ""): Promise<string> {
  const snippets = await readSnippetsSummary(snippetsDir);

  return `You are the discovery agent for Aegis Codex Orchestrator.

Goal:
Run one high-signal clarification pass BEFORE implementation.

Hard constraints:
- Use no tools and no file edits.
- Return JSON-only content that matches the discovery schema.
- If task intent and constraints are clear enough, return status "complete".
- If not, return status "needs_input" and include only high-impact questions that materially affect interface, scope, acceptance, dependencies, or risk.
- Keep questions to 4-8 items when status is needs_input.

Task:
${task}

${answers ? `User answers provided:\n${answers}\n` : ""}

Available snippet context:
${snippets}

Return discovery_md with these sections:
1. Purpose & scope
2. Product requirements
3. Functional constraints
4. Tech stack assumptions
5. API / dependency assumptions
6. Acceptance criteria
7. Open questions (if any)
`;
}

export async function researcherPrompt(task: string, snippetsDir: string): Promise<string> {
  const snippets = await readSnippetsSummary(snippetsDir);

  return `You are the researcher agent for Aegis Codex Orchestrator.

Goal:
Turn the user's task into frozen planning artifacts for a tiny implementation loop.

Hard constraints:
- Write ./spec.md, ./interfaces.md, and ./api-probes/README.md.
- Keep the task small; no UI, no speculative features, and no unrelated systems.
- The developer phase must not need to change public interfaces later.
- Acceptance criteria must be testable.
- Reuse a matching snippet when possible.
- Always write a ./spec.md "Snippet Decision" section with exact fields: Status, Snippet, Reason. Status must be one of used, rejected, none.
- If the task is ambiguous, choose the smallest reasonable behavior and record the assumption in spec.md.
- If the task has no external API/SDK dependency, explicitly write that no probes are needed in ./api-probes/README.md.
- If the task depends on an external API/SDK, create the smallest executable probe script or command note under ./api-probes/, plus a response sample or failure note.
- Do not require OAuth, paid accounts, or user secrets for v0.2 probes. Prefer public no-key endpoints for sample probes.

Files/directories available:
- ./task.md contains the original task.
- ./workspace/ is where implementation will happen later.
- ./api-probes/ is where probe notes, scripts, samples, or failure notes must be written.
- ./progress.md and ./blockers.md exist.
- ./snippets/ catalog summary is provided below and is the primary reuse source.

Available snippets summary:
${snippets}

Required ./spec.md sections:
1. Goal
2. Functional Requirements
3. Acceptance Criteria
4. Non-goals
5. Assumptions
6. Snippet Decision

Required ./interfaces.md sections:
1. CLI Contract
2. Input/Output Contract
3. Error Contract
4. Test Contract

Required ./api-probes/README.md sections:
1. Probe Decision
2. External Dependencies
3. Probe Artifacts
4. Recorded Results
5. Known Limitations

Use these exact markdown headings in ./api-probes/README.md:
- ## Probe Decision
- ## External Dependencies
- ## Probe Artifacts
- ## Recorded Results
- ## Known Limitations

After writing these files, update ./progress.md with a short researcher status.

Original task:
${task}`;
}

export async function managerPrompt(
  loop: number,
  runDir: string,
  snippetsDir: string,
): Promise<string> {
  const [task, discovery, spec, interfaces, progress, blockers, apiProbes, snippets] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "discovery.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
    readOptional(runDir, "blockers.md"),
    readApiProbesSummary(runDir),
    readSnippetsSummary(snippetsDir),
  ]);

  return `You are the manager agent for Aegis Codex Orchestrator.

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

Current discovery.md:
${discovery}

Current spec.md:
${spec}

Current interfaces.md:
${interfaces}

Current progress.md:
${progress}

Current blockers.md:
${blockers}

Current api-probes summary:
${apiProbes}

Current snippet summary:
${snippets}`;
}

export async function developerPrompt(
  decision: ManagerDecisionInput,
  runDir: string,
  snippetsDir: string,
): Promise<string> {
  const [task, discovery, spec, interfaces, progress, apiProbes, snippets] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "discovery.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
    readApiProbesSummary(runDir),
    readSnippetsSummary(snippetsDir),
  ]);

  return `You are the developer agent for Aegis Codex Orchestrator.

Implement only inside ./workspace unless you need to update ./progress.md.

Hard constraints:
- Do not modify ./spec.md or ./interfaces.md. Treat interfaces.md as frozen.
- Keep the implementation minimal.
- Use no external services or account-dependent APIs.
- Add or update tests only if needed to verify the contract.
- Run the relevant test command when possible.
- Update ./progress.md with what changed, commands run, and remaining work.
- If blocked, write the reason to ./blockers.md and stop.
- Treat ./api-probes/ as API ground truth. If probe artifacts contradict your assumptions, follow the probe artifacts.
- Do not invent API request/response shapes when ./api-probes/ contains a sample or failure note.
- Reuse approved snippets and adapt the selected snippet IDs/names from snippets summary.
- Keep changes minimal and avoid introducing dependency creep beyond listed snippets.

Manager decision:
${JSON.stringify(decision, null, 2)}

task.md:
${task}

discovery.md:
${discovery}

spec.md:
${spec}

interfaces.md:
${interfaces}

api-probes summary:
${apiProbes}

snippet summary:
${snippets}

progress.md:
${progress}`;
}

export async function testerPrompt(
  decision: ManagerDecisionInput,
  runDir: string,
  snippetsDir: string,
): Promise<string> {
  const [task, discovery, spec, interfaces, progress, apiProbes, snippets] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "discovery.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
    readApiProbesSummary(runDir),
    readSnippetsSummary(snippetsDir),
  ]);

  return `You are the tester agent for Aegis Codex Orchestrator.

Verify the implementation in ./workspace against spec.md and interfaces.md.

Hard constraints:
- Do not modify ./spec.md or ./interfaces.md.
- Prefer running existing tests. If there are no tests, add the smallest contract test inside ./workspace.
- Run the test command and record the exact command/result in ./progress.md.
- If tests fail, do not hide the failure. Record the failure summary in ./progress.md and write actionable repair notes for the manager.
- If acceptance criteria are fully met, mark that clearly in ./progress.md.
- Use ./api-probes/ to verify API-dependent behavior. If probes are missing for an API-dependent task, record that as a test gap.

Manager decision:
${JSON.stringify(decision, null, 2)}

task.md:
${task}

discovery.md:
${discovery}

spec.md:
${spec}

interfaces.md:
${interfaces}

api-probes summary:
${apiProbes}

snippet summary:
${snippets}

progress.md:
${progress}`;
}

export async function observerPrompt(runDir: string, snippetsDir: string, protocolHealth = ""): Promise<string> {
  const [task, spec, interfaces, progress, blockers, apiProbes, sessionLog, snippets] = await Promise.all([
    readOptional(runDir, "task.md"),
    readOptional(runDir, "spec.md"),
    readOptional(runDir, "interfaces.md"),
    readOptional(runDir, "progress.md"),
    readOptional(runDir, "blockers.md"),
    readApiProbesSummary(runDir),
    readSessionLogSummary(runDir),
    readSnippetsSummary(snippetsDir),
  ]);

  const observedArtifacts = [
    compactObserverSection(
      "Protocol Health",
      protocolHealth || "## Protocol Health\n\nProtocol Health was not evaluated.",
      OBSERVER_PROTOCOL_HEALTH_MAX_CHARS,
    ),
    compactObserverSection("task.md", task, 2_800),
    compactObserverSection("spec.md", spec, 4_000),
    compactObserverSection("interfaces.md", interfaces, 3_500),
    compactObserverSection("progress.md", progress, 5_000),
    compactObserverSection("blockers.md", blockers, 2_000),
    compactObserverSection("api-probes summary", apiProbes, 3_000),
    compactObserverSection("snippet summary", snippets, 3_000),
    compactObserverSection("session-log summary", sessionLog, OBSERVER_SESSION_LOG_MAX_CHARS),
  ].join("\n\n");

  const prompt = `You are the observer agent for Aegis Codex Orchestrator.

Goal:
Review the latest run traces and extract practical lessons for next runs.

Hard constraints:
- Do not use tools or edit files.
- Return the complete markdown content for ./lessons.md as your final response; the driver will write it to disk.
- Your final response must begin exactly with "# Root-cause summary".
- Keep lessons concrete and evidence-based from session-log and protocol files.
- Include what to change in future loops, not only a generic summary.
- Do not claim that lessons.md has already been written; provide the actual lessons markdown.

Required ./lessons.md sections:
1. Root-cause summary
2. Recurring failure patterns
3. Missed discovery/clarification opportunities
4. Agent-specific improvements
5. Reusable snippets candidates
6. Protocol health

In "Reusable snippets candidates", use only this format for each candidate:

### Candidate: <name>

Purpose: <what reusable problem this solves>
Pattern: <the reusable implementation or protocol pattern>
Apply when: <conditions where future runs should use it>

If there are no reusable candidates, write "None." under that section.
Do not use top-level bullets or numbered lists as candidate boundaries.

Use evidence phrases with timestamps/roles from session-log when possible.
If the Protocol Health section below lists issues, mention them in lessons.md with concrete repair suggestions.

Observed artifacts:

${observedArtifacts}`;

  return compactObserverText("observer prompt", prompt, OBSERVER_PROMPT_MAX_CHARS);
}

async function readOptional(runDir: string, file: string): Promise<string> {
  try {
    return await readFile(path.join(runDir, file), "utf8");
  } catch {
    return "(missing)";
  }
}

async function readApiProbesSummary(runDir: string): Promise<string> {
  const probesDir = path.join(runDir, "api-probes");

  try {
    const entries = await readdir(probesDir);
    if (entries.length === 0) {
      return "api-probes/ exists but is empty.";
    }

    const chunks: string[] = [];
    for (const entry of entries.sort()) {
      const filePath = path.join(probesDir, entry);
      const info = await stat(filePath);
      if (!info.isFile()) continue;

      const content = await readFile(filePath, "utf8");
      chunks.push(`--- api-probes/${entry} ---\n${truncate(content, 6000)}`);
    }

  return chunks.length > 0 ? chunks.join("\n\n") : "api-probes/ contains no readable files.";
  } catch {
    return "api-probes/ is missing.";
  }
}

async function readSnippetsSummary(snippetsDir: string): Promise<string> {
  const indexPath = path.join(snippetsDir, "INDEX.md");
  try {
    const index = await readFile(indexPath, "utf8");
    const entries = await readdir(snippetsDir, { withFileTypes: true });
    const snippetFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md")
      .map((entry) => entry.name)
      .sort();

    if (snippetFiles.length === 0) {
      return truncate(`snippets/INDEX.md:
${truncate(index, 5000)}\n\nNo additional snippet files yet.`, 6000);
    }

    const chunks: string[] = [`snippets/INDEX.md:
${truncate(index, 2400)}`];
    for (const file of snippetFiles.slice(0, 4)) {
      const filePath = path.join(snippetsDir, file);
      const content = await readFile(filePath, "utf8");
      chunks.push(`--- snippets/${file} ---\n${truncate(content, 2600)}`);
    }
    return chunks.join("\n\n");
  } catch {
    return "snippets/ is missing or unreadable. Proceed without snippets.";
  }
}

async function readSessionLogSummary(runDir: string): Promise<string> {
  const sessionLogDir = path.join(runDir, "session-log");

  try {
    const entries = await readdir(sessionLogDir);
    if (entries.length === 0) {
      return "session-log exists but is empty.";
    }

    const readableEntries: SessionLogEntrySummary[] = [];
    const sorted = entries.filter((entry) => entry.endsWith(".json")).sort();

    for (const entry of sorted) {
      const filePath = path.join(sessionLogDir, entry);
      const info = await stat(filePath);
      if (!info.isFile()) continue;

      const content = await readFile(filePath, "utf8");
      readableEntries.push(parseSessionLogEntry(entry, content));
    }

    const limitedEntries = readableEntries
      .sort((left, right) => left.time - right.time)
      .slice(-OBSERVER_SESSION_LOG_MAX_ENTRIES);
    const omitted = Math.max(0, readableEntries.length - limitedEntries.length);
    const chunks = limitedEntries.map(formatSessionLogEntry);

    if (omitted > 0) {
      chunks.unshift(`[${OBSERVER_TRUNCATION_MARKER} session-log: ${omitted} older entries omitted]`);
    }

    return chunks.length > 0
      ? compactObserverText("session-log summary", chunks.join("\n\n"), OBSERVER_SESSION_LOG_MAX_CHARS)
      : "session-log is present but has no readable JSON files.";
  } catch {
    return "session-log is missing.";
  }
}

type SessionLogEntrySummary = {
  file: string;
  role: string;
  model?: string;
  threadId?: string;
  startedAt?: string;
  endedAt?: string;
  finalResponse?: string;
  reason?: string;
  error?: string;
  time: number;
  malformed?: boolean;
};

function parseSessionLogEntry(file: string, content: string): SessionLogEntrySummary {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const startedAt = stringValue(parsed.startedAt);
    const endedAt = stringValue(parsed.endedAt);
    const reason = stringValue(parsed.reason) ?? stringValue(parsed.errorReason) ?? stringValue(parsed.errorSummary);
    const error = formatSessionError(parsed.error);

    return {
      file,
      role: stringValue(parsed.role) ?? "unknown",
      model: stringValue(parsed.model),
      threadId: stringValue(parsed.threadId),
      startedAt,
      endedAt,
      finalResponse: stringValue(parsed.finalResponse),
      reason,
      error,
      time: timestampValue(endedAt ?? startedAt ?? file),
    };
  } catch (error) {
    return {
      file,
      role: "unknown",
      reason: error instanceof Error ? error.message : "Could not parse session-log JSON.",
      time: timestampValue(file),
      malformed: true,
    };
  }
}

function formatSessionLogEntry(entry: SessionLogEntrySummary): string {
  const lines = [
    `- role: ${entry.role}`,
    `  file: session-log/${entry.file}`,
    entry.startedAt ? `  startedAt: ${entry.startedAt}` : undefined,
    entry.endedAt ? `  endedAt: ${entry.endedAt}` : undefined,
    entry.model ? `  model: ${entry.model}` : undefined,
    entry.threadId ? `  threadId: ${entry.threadId}` : undefined,
    entry.reason ? `  reason: ${compactInline(entry.reason, 220)}` : undefined,
    entry.error ? `  error: ${compactInline(entry.error, 220)}` : undefined,
    entry.finalResponse ? `  finalResponse: ${compactInline(entry.finalResponse, 360)}` : "  finalResponse: (empty)",
    entry.malformed ? "  malformed: true" : undefined,
  ].filter((line): line is string => Boolean(line));

  return compactObserverText(entry.file, lines.join("\n"), OBSERVER_SESSION_LOG_ENTRY_MAX_CHARS);
}

function compactObserverSection(label: string, value: string, maxChars = OBSERVER_SECTION_MAX_CHARS): string {
  if (label === "Protocol Health") {
    return compactObserverText(label, value, maxChars);
  }

  return `${label}:\n${compactObserverText(label, value, maxChars)}`;
}

export function compactObserverText(label: string, value: string, maxChars = OBSERVER_SECTION_MAX_CHARS): string {
  if (maxChars <= 0) return "";

  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;

  const marker = `\n[${OBSERVER_TRUNCATION_MARKER} ${label}: ${normalized.length - maxChars} chars omitted]`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);

  return `${normalized.slice(0, maxChars - marker.length)}${marker}`;
}

function compactInline(value: string, maxChars: number): string {
  return compactObserverText("inline", value.replace(/\s+/g, " ").trim(), maxChars).replace(/\n/g, " ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatSessionError(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = stringValue(record.name);
    const message = stringValue(record.message);
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
    try {
      return JSON.stringify(record);
    } catch {
      return "Unserializable error object.";
    }
  }
  return String(value);
}

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...<truncated>`;
}
