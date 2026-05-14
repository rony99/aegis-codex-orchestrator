import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const TEAM_SKILL_GUIDANCE_VERSION = "team-skill-guidance-v1";

export type TeamSkillId =
  | "team-leader-lifecycle"
  | "spec-driven-development"
  | "planning-and-task-breakdown"
  | "incremental-implementation"
  | "test-driven-development"
  | "machine-verification"
  | "code-review-and-quality"
  | "shipping-and-launch";

export const TEAM_SKILL_IDS: readonly TeamSkillId[] = [
  "team-leader-lifecycle",
  "spec-driven-development",
  "planning-and-task-breakdown",
  "incremental-implementation",
  "test-driven-development",
  "machine-verification",
  "code-review-and-quality",
  "shipping-and-launch",
];

const TEAM_SKILL_GUIDANCE: Record<TeamSkillId, string[]> = {
  "team-leader-lifecycle": [
    "Drive spec, plan, build, test, review, and ship as gated stages.",
    "Ask humans only for high-impact choices: product scope, credentials, paid/external authority, data or integration boundaries, and blockers the local team cannot resolve.",
    "Turn low-impact uncertainty into explicit assumptions and keep the run moving.",
    "Hand work to workers through complete task documents with objective, context, allowed paths, acceptance criteria, verification command, and failure categories.",
  ],
  "spec-driven-development": [
    "Produce a concrete spec before implementation work.",
    "State objective, audience, core user loop, boundaries, success criteria, and open risks.",
    "Use the repo and task context as source of truth before asking for more input.",
  ],
  "planning-and-task-breakdown": [
    "Break work into ordered vertical slices, not frontend/backend/test layers.",
    "Each task must be independently executable and verifiable in one worker session.",
    "Name dependencies, allowed edit scope, acceptance checks, and machine verification.",
  ],
  "incremental-implementation": [
    "Build the smallest complete slice that satisfies the task document.",
    "Keep edits scoped to allowed paths and avoid speculative abstractions.",
    "When blocked, classify the failure as task_doc_defect, execution_defect, skill_context_defect, credentials, user_decision, or verification_failed.",
  ],
  "test-driven-development": [
    "Prefer a failing behavior test or public-interface check before implementation when the repo has a suitable seam.",
    "Implement only enough to pass the task's acceptance criteria.",
    "Leave the tester an exact verification command and evidence path.",
  ],
  "machine-verification": [
    "Run real non-destructive verification commands; never mark done from appearance or intuition.",
    "Reject missing, failing, long-running, watch-mode, manual-only, or truncated verification.",
    "Return the exact command, result, and smallest likely fix area when verification fails.",
  ],
  "code-review-and-quality": [
    "Review correctness, security, maintainability, test coverage, and integration risk.",
    "Mark Critical, REQUEST CHANGES, or NO-GO for blocking issues.",
    "Prefer concrete file or behavior findings over broad style commentary.",
  ],
  "shipping-and-launch": [
    "Prepare local delivery artifacts only; do not commit, push, deploy, or purchase services.",
    "Summarize verification evidence, deploy plan, rollback plan, residual risks, and next human actions.",
    "Keep delivery reversible and inspectable from local artifacts.",
  ],
};

const TEAM_SKILL_FILE_HINTS: Record<TeamSkillId, string[]> = {
  "team-leader-lifecycle": ["team", "lifecycle", "agent", "leader", "project"],
  "spec-driven-development": ["spec", "requirements", "prd", "research"],
  "planning-and-task-breakdown": ["plan", "task", "breakdown", "implementation"],
  "incremental-implementation": ["build", "implement", "development", "incremental"],
  "test-driven-development": ["test", "tdd", "verification"],
  "machine-verification": ["verify", "verification", "test", "quality"],
  "code-review-and-quality": ["review", "quality", "security"],
  "shipping-and-launch": ["ship", "launch", "release", "deploy"],
};

export function teamSkillsForRole(role: string): TeamSkillId[] {
  if (role === "leader") return ["team-leader-lifecycle"];
  if (role === "supervisor") return ["machine-verification", "code-review-and-quality", "shipping-and-launch"];
  if (role === "planner") return ["spec-driven-development", "planning-and-task-breakdown"];
  if (role === "developer") return ["incremental-implementation", "test-driven-development"];
  if (role === "tester") return ["machine-verification"];
  if (role === "reviewer") return ["code-review-and-quality"];
  if (role === "shipper") return ["shipping-and-launch"];
  return [];
}

export function teamSkillsForStage(stage: string): TeamSkillId[] {
  if (stage === "spec") return ["spec-driven-development"];
  if (stage === "plan") return ["planning-and-task-breakdown"];
  if (stage === "build") return ["incremental-implementation", "test-driven-development"];
  if (stage === "test") return ["machine-verification"];
  if (stage === "review") return ["code-review-and-quality"];
  if (stage === "ship") return ["shipping-and-launch"];
  return [];
}

export function formatTeamSkillGuidance(skillIds: readonly TeamSkillId[]): string {
  const uniqueSkillIds = [...new Set(skillIds)];
  if (!uniqueSkillIds.length) return "";
  const externalGuidance = readConfiguredAgentSkillGuidance(uniqueSkillIds);
  if (externalGuidance) {
    return [
      `Skill Guidance Version: ${TEAM_SKILL_GUIDANCE_VERSION}`,
      "Local Agent Skills Source: configured skill files. Use this as fixed SDK role guidance.",
      externalGuidance,
      "",
      "Condensed fallback rules for gaps:",
      formatCondensedTeamSkillGuidance(uniqueSkillIds),
    ].join("\n");
  }
  return formatCondensedTeamSkillGuidance(uniqueSkillIds);
}

function formatCondensedTeamSkillGuidance(skillIds: readonly TeamSkillId[]): string {
  const lines = [
    `Skill Guidance Version: ${TEAM_SKILL_GUIDANCE_VERSION}`,
    "These repo-local skills are condensed from agent-skills-style lifecycle practice; use them as execution guidance, not copied external prompt text.",
  ];
  for (const skillId of skillIds) {
    lines.push("", `<team-skill id="${skillId}">`);
    for (const rule of TEAM_SKILL_GUIDANCE[skillId]) {
      lines.push(`- ${rule}`);
    }
    lines.push("</team-skill>");
  }
  return lines.join("\n");
}

function readConfiguredAgentSkillGuidance(skillIds: readonly TeamSkillId[]): string | undefined {
  const root = resolveConfiguredSkillsRoot();
  if (!root) return undefined;
  const files = findMatchingSkillFiles(root, skillIds);
  if (!files.length) return undefined;

  const sections: string[] = [];
  let totalChars = 0;
  for (const file of files) {
    const content = safeReadText(file);
    if (!content) continue;
    const remaining = EXTERNAL_SKILL_GUIDANCE_MAX_CHARS - totalChars;
    if (remaining <= 0) break;
    const clipped = content.length > remaining ? `${content.slice(0, remaining)}\n\n[truncated by cc-team skill loader]\n` : content;
    totalChars += clipped.length;
    sections.push([
      `<external-skill path="${path.relative(root, file)}">`,
      clipped.trim(),
      "</external-skill>",
    ].join("\n"));
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

function resolveConfiguredSkillsRoot(): string | undefined {
  const candidates = [
    process.env.CODEX_GTD_AGENT_SKILLS_DIR,
    process.env.CC_TEAM_SKILLS_DIR,
    process.env.AGENT_SKILLS_DIR,
    path.join(process.cwd(), ".codex-gtd", "agent-skills"),
    path.join(process.cwd(), ".codex-gtd", "agent-skills", "agent-skills"),
    path.join(process.cwd(), "agent-skills"),
    path.join(process.cwd(), ".agent-skills"),
    path.join(process.cwd(), "vendor", "agent-skills"),
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Ignore unreadable configured roots and fall back to condensed guidance.
    }
  }
  return undefined;
}

function findMatchingSkillFiles(root: string, skillIds: readonly TeamSkillId[]): string[] {
  const wantedHints = new Set(skillIds.flatMap((skillId) => TEAM_SKILL_FILE_HINTS[skillId]));
  const allSkillFiles = collectSkillFiles(root);
  const scored = allSkillFiles
    .map((file) => {
      const haystack = path.relative(root, file).toLowerCase();
      const score = [...wantedHints].reduce((sum, hint) => sum + (haystack.includes(hint) ? 1 : 0), 0);
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  return scored.slice(0, EXTERNAL_SKILL_FILE_LIMIT).map((entry) => entry.file);
}

function collectSkillFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > EXTERNAL_SKILL_SEARCH_DEPTH || files.length >= EXTERNAL_SKILL_FILE_LIMIT * 3) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (/^(SKILL|README)\.md$/i.test(entry)) {
        files.push(fullPath);
      }
    }
  };
  visit(root, 0);
  return files;
}

function safeReadText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

const EXTERNAL_SKILL_FILE_LIMIT = 8;
const EXTERNAL_SKILL_SEARCH_DEPTH = 4;
const EXTERNAL_SKILL_GUIDANCE_MAX_CHARS = 60_000;
