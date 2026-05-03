export type CcSpecRole = "intake" | "product" | "demo" | "research" | "architect" | "reviewer";
export type CcSpecMode = "new" | "change";

export const CC_SPEC_ROLES: readonly CcSpecRole[] = ["intake", "product", "demo", "research", "architect", "reviewer"];

export function buildCcSpecSystemPrompt(role: CcSpecRole): string {
  const shared = [
    "You are part of the cc-spec pre-development review workflow.",
    "This workflow produces requirements and technical specs only. Do not write business implementation code.",
    "Use public spec-driven workflow ideas as structure only; do not copy long prompt text from external projects.",
    "Follow skill-guided-v1 engineering discipline: clarify only high-impact unknowns, prefer vertical slices, and make verification explicit.",
    "If a high-impact decision is missing, call AskUserQuestion instead of guessing.",
  ].join(" ");

  if (role === "demo") {
    return `${shared} You are the demo role. Write a single self-contained demo.html file (<400 lines, inline CSS and JS only, no CDN or external URLs). The demo must cover the entire happy-path user loop with realistic hardcoded data. After writing demo.html, call AskUserQuestion to ask the user whether the demo matches their vision and what changes they want.`;
  }
  if (role === "research") {
    return `${shared} You are the technical research role. Prefer official documentation, official GitHub repositories, and official package registry pages. Treat unofficial blog posts as non-authoritative unless no official source exists.`;
  }
  if (role === "reviewer") {
    return `${shared} You are the reviewer role. Read the produced artifacts and return JSON only.`;
  }
  return shared;
}

export function buildCcSpecRolePrompt(input: {
  role: CcSpecRole;
  task: string;
  mode: CcSpecMode;
  targetSummary: string;
  userReplies: string;
  productBrief?: string;
  decisionLog?: string;
  runDir?: string;
}): string {
  const artifactRules = `Artifact rules:
- The current working directory is the run directory.
- Use artifact file names relative to the current directory, for example context.md, research.md, spec.md, agent-spec.md, and tasks.md.
- When a stage is explicitly asked to update an artifact file, use Write for whole-file replacement and Edit only for small targeted updates.
- Do not read or write the target repository directly. Use the target summary below as read-only context.`;

  const context = `${artifactRules}

Mode: ${input.mode}

Original task:
${input.task}

Target repository context:
${input.targetSummary || "No target repository was provided."}

User replies so far:
${input.userReplies || "No follow-up replies have been recorded."}

Product manager brief so far:
${input.productBrief || "No product-brief.md has been produced yet."}

Decision log so far:
${input.decisionLog || "No decision-log.md has been produced yet."}`;

  if (input.role === "intake") {
    return `${context}

Stage: intake

Extract the user, scenario, goal, constraints, obvious gaps, and whether this is a 0-1 new project or a 1-n change to an existing repo.
Use the target repository context first: answer what can be inferred from code/docs locally, and ask only questions that would change MVP behavior, data model, integration boundaries, or acceptance criteria.
Capture domain terms and ambiguous vocabulary in context.md so later roles use consistent language.
Update context.md with a concise intake section. If the missing information blocks a meaningful review, ask the user.`;
  }

  if (input.role === "product") {
    return `${context}

Stage: product

Clarify the product contract: primary user, why they need this, core MVP behavior, non-goals, completion bar, acceptance criteria, and success signals.
Keep the MVP small, but make it complete enough that a user can feel and test the result. Ask the user for high-impact product decisions instead of filling them in silently.
Act like a real-world product manager: separate confirmed decisions from assumptions, mark unresolved risks, define the smallest complete user loop, and make the plan testable by a real user.
Ask only for decisions that would materially change the MVP, data model, integration boundary, or acceptance criteria. For low- or medium-impact details, choose a conservative default, record it as an assumption in decision-log.md, and keep moving.
If the user's latest reply asks you to choose conservative defaults for remaining details, do not ask another product clarification question unless the missing decision makes the MVP impossible to test. Prefer defaults such as manual status changes, archive instead of hard delete, and dashboard-only visibility over automation.
Return exactly this shape as your final answer:
<product-brief.md>
...complete product-brief.md Markdown with user, job-to-be-done, MVP loop, non-goals, acceptance criteria, metrics, constraints, and real-world risks...
</product-brief.md>
<decision-log.md>
...complete decision-log.md Markdown with confirmed decisions, assumptions, open questions, blocked decisions, and ask_user triggers...
</decision-log.md>`;
  }

  if (input.role === "demo") {
    return `${context}

Stage: demo

The run directory is: ${input.runDir ?? "."}

Read product-brief.md, then write a single self-contained demo.html to the run directory.

Requirements:
- Fewer than 400 lines, inline CSS and JS only, no external URLs or CDN links.
- Cover the complete happy-path user loop with realistic hardcoded data (no fetch/API calls).
- Show the core screens: list/dashboard view, detail/form view, at least one action (create, update, or delete).
- After writing demo.html, call AskUserQuestion with this message: "I've written demo.html to the run directory. Please open it in your browser and tell me: (1) does this match your vision? (2) what changes or additions do you want before I continue to research and spec?".`;
  }

  if (input.role === "research") {
    return `${context}

Stage: research

Search for reusable official APIs, SDKs, package registry entries, and open-source projects that could materially change the implementation plan.
If the task names an existing product or competitor, search the web for that exact product name and comparable products before writing recommendations.
Use at most 4 WebSearch calls total. Do not Read task.md or context.md; the needed context is already in this prompt.
For each named product, competitor, API, SDK, package, or open-source project, include a source URL and classify it as official, registry, source repository, or unofficial. If no authoritative source is found for a named product, say that explicitly instead of presenting unsourced claims.
For each recommended package or API, record the current stable version from the registry entry and the license for all direct dependencies.
Keep research.md under 160 lines. Use compact tables and bullets. Do not include code examples, long pricing tables, or long copied feature descriptions.
If web search fails or a competitor cannot be verified, mark it as unverified inspiration only; do not turn unverified feature claims into requirements.
For each recommended source, record what it provides, integration cost, risks, and whether to integrate it. Prefer official sources. Do not rely on unofficial blogs by default.
Do not write files. Return the complete Markdown content for research.md as your final answer.`;
  }

  if (input.role === "architect") {
    return `${context}

Stage: architect

Read context.md and research.md, then produce three Markdown artifacts:
- spec.md: concise user-facing spec with functionality, technical stack, architecture, and milestones.
- agent-spec.md: detailed development-agent contract with all mandatory sections listed below.
- tasks.md: executable development task list with task ids, dependencies, target files/directories, acceptance checks, verification commands, and parallelization notes.

agent-spec.md mandatory sections (development cannot start without all of them):
- ## API Contracts — table of every endpoint/function with method, path, request shape, response shape, and status codes.
- ## Data Model — table of every entity with fields, types, nullability, and relationships.
- ## Error Handling — table of each error case with HTTP/exit code and user-facing message.
- ## Test Scenarios — Given/When/Then list covering the happy path plus at least two edge or failure cases.
- ## UI State Inventory — list of distinct screen states and the triggers that cause each transition.
- ## TDD Plan — which behavior should get the first failing test or public-interface check before implementation.
- ## Diagnosis Plan — exact repro commands, failure symptoms to capture, and likely boundary to inspect when verification fails.
- ## Verification Surface — public interfaces and user-visible states that define acceptance.

Keep spec.md under 180 lines, agent-spec.md under 300 lines, and tasks.md under 180 lines. Prefer dense checklists and tables over long prose.
tasks.md must be tracer-bullet vertical slices, not horizontal frontend/backend/database/test layer work. Each task must:
- have a task id;
- be marked AFK or HITL;
- describe one end-to-end user-visible behavior;
- name the public interface or files/directories likely touched;
- include its own inline verification command on a "verify:" line, or a filled per-task verify table column.
Separate HITL decisions from AFK executable tasks. Do not hide user decisions inside AFK tasks.
For 1-n changes, agent-spec.md must name existing-code integration boundaries and areas that should not be touched.
Do not introduce SDKs, APIs, or package dependencies that research.md did not verify. For AI providers, use an explicit provider boundary and the confirmed OpenAI-compatible SDK path unless research.md verifies another SDK.
Do not include full Prisma schema or TypeScript implementation code blocks. Describe data models, enums, and API contracts in tables so corrupted code tokens cannot become the development contract.
If a named competitor is unverified, treat it as inspiration only and ground requirements in the user's stated goals and acceptance criteria.
Include explicit rate-limit and quota requirements as configurable product constraints; do not cite unverified provider limits.
For identity and tenancy boundaries, require session-derived user identity and explicitly forbid hardcoded user ids.
Do not write files. Return exactly this shape as your final answer:
<spec.md>
...complete spec.md Markdown...
</spec.md>
<agent-spec.md>
...complete agent-spec.md Markdown...
</agent-spec.md>
<tasks.md>
...complete tasks.md Markdown...
</tasks.md>`;
  }

  return `${context}

Stage: reviewer

Review context.md, research.md, spec.md, agent-spec.md, and tasks.md. Decide whether development can start directly from agent-spec.md and tasks.md.
Also verify product-brief.md and decision-log.md: the plan must identify a real user, a concrete job-to-be-done, the smallest complete testable user loop, non-goals, acceptance criteria, real-world constraints, risks, and confirmed vs assumed decisions.
Return JSON only:
{"status":"done"|"ask_user","reason":"short reason"}

Use "ask_user" if required product, architecture, integration, research-source, or testing decisions are missing. Verify that named competitors/products have source URLs or explicit no-authoritative-source notes. Verify agent-spec.md includes API Contracts, Data Model, Error Handling, Test Scenarios, UI State Inventory, TDD Plan, Diagnosis Plan, and Verification Surface sections. Verify tasks.md is split into AFK/HITL vertical slices with per-task verify commands instead of horizontal layer tasks. Otherwise use "done".`;
}
