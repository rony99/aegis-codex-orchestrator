import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { summarizeTargetRepository } from "./cc-team/index.js";

export type SpecAgentOptions = {
  taskFile?: string;
  targetDir?: string;
  runDir?: string;
  runsDir?: string;
};

export type SpecAgentResult = {
  runDir: string;
  targetDir?: string;
  status: "done" | "failed";
  reason: string;
  artifacts: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

const DEFAULT_RUNS_DIR = "runs";

const REQUIRED_ARTIFACTS = [
  "task.md",
  "questions.md",
  "product-brief.md",
  "research.md",
  "spec.md",
  "agent-spec.md",
  "tasks.md",
  "run-summary.json",
] as const;

type RequiredArtifact = (typeof REQUIRED_ARTIFACTS)[number];

const PLACEHOLDER_ARTIFACTS: Record<RequiredArtifact, string> = {
  "task.md": "",
  "questions.md": "# Questions\n\nNo clarifying questions at this time.\n",
  "product-brief.md": "# Product Brief\n\nPending.\n",
  "research.md": "# Research\n\nPending.\n",
  "spec.md": "# Spec\n\nPending.\n",
  "agent-spec.md": "# Agent Spec\n\nPending.\n",
  "tasks.md": "# Tasks\n\nPending.\n",
  "run-summary.json": "{}",
};

/**
 * Detect whether a task text contains signals that make it ambiguous.
 * Returns true when the task lacks sufficient detail for immediate implementation.
 */
function isAmbiguousTask(task: string): boolean {
  const text = task.trim();
  // Very short tasks with no explicit scope are ambiguous.
  if (text.length < 80) return true;
  // Tasks that only describe a goal with no acceptance criteria.
  if (!/(?:must|should|will|require|accept|criteria|verify|test)/i.test(text)) return true;
  // Tasks that say "implement X" with no additional context.
  if (/^#?\s*implement\s+\w+\s*$/i.test(text)) return true;
  return false;
}

/**
 * Detect task domain signals to enable domain-specific artifact generation.
 * Returns flags for known product categories.
 */
function detectTaskDomain(task: string): {
  isDetailedGame: boolean;
  isEnglishLearning: boolean;
  isRomanceCompanion: boolean;
  isVisualNovel: boolean;
  hasLLMSignals: boolean;
  hasTTSAudioSignals: boolean;
  hasImageGenSignals: boolean;
} {
  const text = task.toLowerCase();

  const isDetailedGame = /game|visual novel|romance|narrative|dialogue|character|affection|trust|arc|chapter|scene/i.test(text);
  const isEnglishLearning = /english|learning|listen|comprehension|vocabulary|pronunciation|fluency/i.test(text);
  const isRomanceCompanion = /romance|companion|relationship|affection|emotional|intimacy|love|deepspace/i.test(text);
  const isVisualNovel = /visual novel|2d|web|pc|browser|choice|branching|narrative/i.test(text);

  const hasLLMSignals = /llm|gpt|claude|openai|generate|ai|text.?gen|dialogue.?gen|narrative/i.test(text);
  const hasTTSAudioSignals = /tts|text.?to.?speech|speech|synth|voice|audio|listen|sound/i.test(text);
  const hasImageGenSignals = /image.?gen|portrait|background|cg|visual|sprite|character.?art|illustration/i.test(text);

  return { isDetailedGame, isEnglishLearning, isRomanceCompanion, isVisualNovel, hasLLMSignals, hasTTSAudioSignals, hasImageGenSignals };
}

/**
 * Detect competitor products, external APIs, SDKs, packages, or local reference paths
 * that require explicit sourcing.
 *
 * Competitor/product references are captured as complete multi-word phrases where possible,
 * avoiding splitting on individual capitalised words (e.g., "Love and Deepspace" not "Love").
 */
function extractSourcingSignals(task: string): {
  competitorSignals: string[];
  apiSignals: string[];
  packageSignals: string[];
  localPathSignals: string[];
} {
  const competitorSignals: string[] = [];
  const apiSignals: string[] = [];
  const packageSignals: string[] = [];
  const localPathSignals: string[] = [];

  // Match "inspired by", "like X and Y" multi-word competitor patterns, capturing up to 7 words after the lead.
  const multiWordProductRe = /(?:(?:[Ii]nspired by|[Ll]ike|[Ss]imilar to|vs\.?|versus|[Cc]ompared to|[Cc]ompetitor|[Aa]lternative to)\s+)([A-Z][a-zA-Z0-9]*(?:\s+(?:and|the|of|a|an|in|on|for|with)\s+[A-Z][a-zA-Z0-9]*){0,6})/g;
  let match: RegExpExecArray | null;
  while ((match = multiWordProductRe.exec(task)) !== null) {
    const phrase = trimProductReference(match[1]);
    if (phrase.split(" ").length >= 2) {
      competitorSignals.push(phrase);
    }
  }

  // Also match single capitalised words for competitors (fallback for short names).
  // Only match when NOT followed by another capitalised word (avoids splitting "Love and Deepspace").
  const singleCompetitorRe = /(?:(?:[Ll]ike|[Ss]imilar to|vs\.?|versus|[Cc]ompared to|[Cc]ompetitor|[Aa]lternative to)\s+)([A-Z][a-zA-Z0-9_-]+)\b(?!\s+(?:and|the|of|a|an|in|on|for|with)\s+[A-Z])/g;
  while ((match = singleCompetitorRe.exec(task)) !== null) {
    const name = match[1];
    if (!competitorSignals.some((c) => c.includes(name))) {
      competitorSignals.push(name);
    }
  }

  // Match API/SDK references (e.g., "Stripe API", "OpenAI SDK", "GitHub API").
  const apiRe = /\b([A-Z][a-zA-Z0-9_-]+)\s*(?:API|SDK|api|sdk)\b/g;
  while ((match = apiRe.exec(task)) !== null) {
    const name = match[1];
    if (!competitorSignals.includes(name)) {
      apiSignals.push(name);
    }
  }

  // Match package references (e.g., "npm package", "pypi", "crates.io", "use X").
  const packageRe = /\b(?:npm|npmjs|pypi|crates\.io|packagist|pub\.dev|gem)\b|\buse\s+([a-z@][a-z0-9_-]*\/[a-z0-9_-]+)\b/gi;
  while ((match = packageRe.exec(task)) !== null) {
    if (match[1]) packageSignals.push(match[1]);
  }

  // Match local reference paths:
  // - Relative: ../, ./src/, lib/, etc.
  // - Absolute: /Users/, /home/, /repo/, /workspace/, etc.
  const localPathRe = /\.\.\/[\w.\-]+|[\.\/\\](?:src|lib|packages?|internal|shared|tools?|workspace|dist|build)\b|\/(?:Users|home|repo|src|var|opt|etc|workspace)[\/\w]*/gi;
  while ((match = localPathRe.exec(task)) !== null) {
    localPathSignals.push(match[0]);
  }

  return { competitorSignals, apiSignals, packageSignals, localPathSignals };
}

function trimProductReference(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+(?:in terms(?: of)?|with respect to|rather than|instead of|but|because)\b.*$/i, "")
    .trim();
}

/**
 * Inspect a local reference path for capability signals.
 * Reads readme, package.json, and doc hints without reading secrets, .env, node_modules, or large generated files.
 * Returns evidence of what was found including LLM/TTS/image generation signals.
 */
async function inspectLocalReference(baseDir: string, refPath: string): Promise<string> {
  const candidate = path.isAbsolute(refPath) ? refPath : path.join(baseDir, refPath);
  try {
    const statResult = await stat(candidate);
    if (!statResult.isDirectory()) {
      return `Local path verified (file, not directory): ${candidate}`;
    }

    const entries = await readdir(candidate, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const evidenceParts: string[] = [`Local path verified: ${candidate}`];

    // Top-level files and dirs
    const visibleFiles = files.filter((f) => !isExcludedFile(f));
    const visibleSubdirs = subdirs.filter((d) => !isExcludedDir(d));
    evidenceParts.push(`Files: ${visibleFiles.slice(0, 30).join(", ") || "none"}`);
    evidenceParts.push(`Subdirs: ${visibleSubdirs.slice(0, 20).join(", ") || "none"}`);

    // Read README hints
    const readmeHint = await detectReadmeHint(candidate);
    if (readmeHint) evidenceParts.push(readmeHint);

    // Read package.json for capability signals
    const packageHint = await detectPackageHint(candidate);
    if (packageHint) evidenceParts.push(packageHint);

    // Detect capability signals from file/dir names
    const allNames = [...visibleFiles, ...visibleSubdirs].join(" ").toLowerCase();
    const capabilities: string[] = [];
    if (/\b(llm|gpt|claude|openai|minimax|text.?gen|textgen|generative)\b/.test(allNames)) {
      capabilities.push("LLM/text generation");
    }
    if (/\b(tts|text.?to.?speech|speech|synth|voice|audio|ttsapi)\b/.test(allNames)) {
      capabilities.push("TTS/speech synthesis");
    }
    if (/\b(image.?gen|stable.?diffusion|midjourney|sd|sdxl|dalle|img2img|img.?gen|portrait|background.?gen)\b/.test(allNames)) {
      capabilities.push("Image generation");
    }
    if (capabilities.length > 0) {
      evidenceParts.push(`Capability signals detected: ${capabilities.join(", ")}`);
    }

    return evidenceParts.join("\n");
  } catch {
    return `Local path not found or not accessible: ${refPath}`;
  }
}

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower === ".gitignore" || lower === ".npmrc" ||
    lower.startsWith(".env") || lower === "package-lock.json" ||
    lower.endsWith(".cache") || lower.endsWith(".log") ||
    lower.includes("secret") || lower.includes("credential") ||
    lower.includes("key") && (lower.endsWith(".pem") || lower.endsWith(".key") || lower.includes("token"));
}

function isExcludedDir(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "node_modules" || lower === ".git" || lower === "dist" ||
    lower === "build" || lower === ".cache" || lower === ".next" ||
    lower === ".turbo" || lower === "coverage" || lower.endsWith(".log") ||
    lower.includes("secret") || lower.includes("credential");
}

async function detectReadmeHint(dirPath: string): Promise<string> {
  for (const name of ["README.md", "readme.md", "README", "readme.txt", "CAPABILITIES.md", "capabilities.md"]) {
    try {
      const content = await readFile(path.join(dirPath, name), "utf8");
      const firstLines = content.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join(" ");
      if (firstLines.length > 0) {
        return `README hint: ${firstLines.slice(0, 200)}`;
      }
    } catch {
      // continue
    }
  }
  return "";
}

async function detectPackageHint(dirPath: string): Promise<string> {
  try {
    const content = await readFile(path.join(dirPath, "package.json"), "utf8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; name?: string };
    const hints: string[] = [];
    if (pkg.name) hints.push(`name: ${pkg.name}`);
    const scriptKeys = Object.keys(pkg.scripts ?? {}).slice(0, 8).join(", ");
    if (scriptKeys) hints.push(`scripts: ${scriptKeys}`);
    const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 10).join(", ");
    if (deps) hints.push(`deps: ${deps}`);
    return hints.length > 0 ? `package.json: ${hints.join(" | ")}` : "";
  } catch {
    return "";
  }
}

/**
 * Build the initial questions artifact when the task is ambiguous.
 */
function buildQuestionsFromAmbiguousTask(task: string): string {
  const lines = ["# Questions", "", "The following questions clarify the task before implementation can begin.", ""];

  // Core scope question.
  lines.push("1. **Scope & MVP**: What is the minimum viable scope for this task?");
  lines.push("   - Which features are essential vs nice-to-have?");

  // Target users / context.
  lines.push("2. **Context**: Who are the primary users? What environment will this run in?");

  // Acceptance criteria.
  lines.push("3. **Acceptance Criteria**: How will we know this is done?");
  lines.push("   - What commands will verify the result?");
  lines.push("   - What manual checks are acceptable?");

  // Edge cases.
  lines.push("4. **Edge Cases**: Are there any boundary conditions or error scenarios to handle?");

  // Technology / stack constraints.
  lines.push("5. **Constraints**: Are there any technology, library, or style constraints?");

  lines.push("");
  lines.push("Original task:");
  lines.push(task);

  return lines.join("\n");
}

/**
 * Build the product brief from task text and target summary.
 * When domain signals are detected (game, learning, romance), produce concrete content
 * with no unresolved TBD placeholders.
 */
function buildProductBrief(task: string, targetSummary: string, domain: ReturnType<typeof detectTaskDomain> | null): string {
  const lines: string[] = ["# Product Brief", "", "## Overview", ""];
  lines.push("This document captures the product purpose, scope, and constraints derived from the task.");

  // ── Game / visual novel / romance companion ──────────────────────────────────
  if (domain?.isDetailedGame && domain?.isRomanceCompanion) {
    const audience = extractNamedField(task, /target audience[:\s]*([^\n]+)/i) ||
      (domain.isEnglishLearning ? "male users seeking English listening practice with emotional engagement" : "male users seeking narrative and companionship");

    const castRaw = extractNamedField(task, /main cast[:\s]*([^\n]+)/i) || "female romance/companionship characters";
    const learningGoal = domain.isEnglishLearning
      ? "English listening comprehension — the player gradually understands characters better through English audio"
      : "narrative engagement and relationship building";

    const platform = /pc web|web|first|desktop|browser/i.test(task) ? "PC web (desktop browser)" : "PC web";
    const format = /2d|japanese.?style|visual novel/i.test(task) ? "2D Japanese-style romance visual novel" : "2D visual novel";
    const balance = /50.?percent|50%|50.?50|half game|half learning/i.test(task) ? "50% game / 50% learning" : "balanced game and learning";

    const hasOpeningScenario = /opening scenario|custom scenario|player can enter/i.test(task);
    const hasAffectionFeedback = /affection|trust|feedback|warm|relationship.?progress/i.test(task);
    const hasRetryCost = /replay|retry|cost|heavy|light/i.test(task);

    lines.push("", "## Task Summary", task.trim(), "");
    lines.push("## Primary Users", audience, "");
    lines.push("## Core Value Proposition", "");
    lines.push(`- **${platform}**: ${format}`);
    lines.push(`- **Balance**: ${balance}`);
    lines.push(`- **Learning goal**: ${learningGoal}`);
    lines.push(`- **Emotional tone**: slow-burn companionship, ambiguity, relationship warming`);
    if (hasOpeningScenario) {
      lines.push("- **Opening scenario**: player enters custom opening; system generates setting/characters/arcs");
    }
    lines.push("");

    lines.push("## MVP Scope");
    lines.push("- Core listening scene with TTS audio and comprehension choices");
    lines.push("- Female character roster with individual personalities and emotional arcs");
    lines.push("- Affection/reward system that responds to player comprehension choices");
    if (hasOpeningScenario) {
      lines.push("- Opening scenario input → LLM-generated setting, player identity, and character roster");
    }
    lines.push("- Short English text reply interaction (no speech recognition in MVP)");
    if (hasRetryCost) {
      lines.push("- Replay carries a relationship/reward cost to prevent grinding");
    }
    lines.push("- LLM-generated dialogue and narrative with structured state to avoid personality drift");
    lines.push("");

    lines.push("## Core Loop");
    lines.push("1. Player enters opening scenario (or accepts default)");
    lines.push("2. LLM generates world, player identity, female characters, and initial arcs");
    lines.push("3. Player sees/hears a scene (TTS audio) and chooses the meaning or infers emotion");
    lines.push("4. Correct: relationship progresses, character reacts warmly");
    lines.push("5. Incorrect: relationship slows, character reacts colder/awkwardly");
    lines.push("6. Replay allowed but carries a light affection cost");
    lines.push("7. Short English text reply interaction for active production");
    lines.push("");

    lines.push("## Success Metrics");
    lines.push("- Player completes listening scenes with comprehension verified by choice accuracy");
    lines.push("- Affection/trust scores increase over correct interactions");
    lines.push("- No speech recognition — purely receptive (listen) and productive (short text) skill use");
    lines.push("- Replay cost prevents unbounded grinding while still allowing learning");
    lines.push("");

    lines.push("## Risks & Open Questions");
    lines.push("- LLM generation must be bounded to avoid personality drift: structured state + arc guards");
    lines.push("- TTS audio quality and latency must be acceptable for a learning context");
    lines.push("- Opening scenario generation must gracefully handle empty/weak input with defaults");
    lines.push("- Character national/cultural flavor must express in English, not by switching away from English");
    lines.push("- MVP scope is PC web only; mobile and native app are deferred post-MVP");

  } else {
    // Generic fallback
    lines.push("", "## Task Summary", task.trim(), "");
    lines.push("## Primary Users", "TBD — specify primary users for this feature.", "");
    lines.push("## Job-to-be-Done", "TBD — what is the user trying to accomplish?", "");
    lines.push("## MVP Scope", "- Core feature loop to be defined.", "- Supporting features to be deferred.", "");
    lines.push("## Acceptance Criteria", "- Criteria to be defined based on user input.", "");
    lines.push("## Success Metrics", "TBD.", "");
    lines.push("## Risks & Open Questions", "- Risks and open questions to be captured during spec elaboration.", "");
  }

  if (targetSummary) {
    lines.push("", "## Target Repository Context");
    lines.push(targetSummary);
  }

  return lines.join("\n");
}

/** Extract a named field from task text, e.g. "Target audience: male users" → "male users" */
function extractNamedField(task: string, pattern: RegExp): string | undefined {
  const match = task.match(pattern);
  return match?.[1]?.trim();
}

/**
 * Build the research artifact from sourcing signals.
 */
function buildResearch(
  task: string,
  signals: ReturnType<typeof extractSourcingSignals>,
  localEvidence: Map<string, string>,
  targetSummary: string,
): string {
  const lines = ["# Research", "", "## Source Verification Note", ""];
  lines.push("This first version of spec-agent does **not perform live web or API research**.");
  lines.push("All sources listed below are **pending human verification** or verification by a future agent with live-research capability.");
  lines.push("");

  if (
    signals.competitorSignals.length === 0 &&
    signals.apiSignals.length === 0 &&
    signals.packageSignals.length === 0 &&
    signals.localPathSignals.length === 0
  ) {
    lines.push("## External Sources");
    lines.push("None identified in the task.");
    lines.push("");
    lines.push("## Local References");
    lines.push("No local reference paths were found in the task.");
  } else {
    if (signals.competitorSignals.length > 0) {
      lines.push("## Competitor / Alternative Products");
      for (const name of signals.competitorSignals) {
        lines.push(`- **${name}**: Source is pending verification. A human or future agent must verify capabilities, API surface, and any relevant documentation URL.`);
      }
      lines.push("");
    }

    if (signals.apiSignals.length > 0) {
      lines.push("## External APIs / SDKs");
      for (const name of signals.apiSignals) {
        lines.push(`- **${name}**: Source is pending verification. A human or future agent must verify official documentation URL, stable version, and license.`);
      }
      lines.push("");
    }

    if (signals.packageSignals.length > 0) {
      lines.push("## Package References");
      for (const name of signals.packageSignals) {
        lines.push(`- **${name}**: Source is pending verification. A human or future agent must verify the package registry, version, and license.`);
      }
      lines.push("");
    }

    if (signals.localPathSignals.length > 0) {
      lines.push("## Local Reference Paths");
      for (const refPath of signals.localPathSignals) {
        const evidence = localEvidence.get(refPath) ?? `Local path: ${refPath} — verification pending.`;
        lines.push(`- **${refPath}**: ${evidence}`);
      }
      lines.push("");
    }
  }

  if (targetSummary) {
    lines.push("");
    lines.push("## Target Repository Summary");
    lines.push(targetSummary);
  }

  return lines.join("\n");
}

/**
 * Build the spec artifact.
 * When domain signals are detected (game, learning, romance), produces a concrete spec
 * with functional and non-functional requirements — no unresolved TBD.
 */
function buildSpec(task: string, domain: ReturnType<typeof detectTaskDomain> | null): string {
  // ── Visual novel / romance game spec ─────────────────────────────────────
  if (domain?.isDetailedGame && domain?.isRomanceCompanion) {
    const lines: string[] = ["# Spec", "", "## Overview", ""];

    // Extract concrete details from task
    const format = /2d|japanese.?style|visual novel/i.test(task)
      ? "2D Japanese-style romance visual novel (PC web)"
      : "2D visual novel (PC web)";
    const balance = /50.?percent|50%|50.?50|half/i.test(task) ? "50% game / 50% learning" : "game and learning balance TBD";
    const learningGoal = domain.isEnglishLearning
      ? "English listening comprehension — players understand characters via English audio"
      : "narrative and relationship engagement";

    lines.push(`An English-learning romance visual novel with ${format} format.`);
    lines.push(`Product balance: ${balance}.`);
    lines.push(`Primary learning goal: ${learningGoal}.`);
    lines.push("");

    lines.push("## Game Experience");
    lines.push("- Player is immersed in a slow-burn companionship narrative with foreign female characters.");
    lines.push("- Each character has a distinct personality, cultural background, and emotional arc.");
    lines.push("- National/cultural flavor shows through expression style, humor, and lifestyle — not by switching away from English.");
    lines.push("- Main sense of achievement: player gradually understands the girls better in English; feedback is rising affection/trust.");
    lines.push("");

    lines.push("## Core Loop");
    lines.push("1. **Opening**: Player enters custom scenario OR accepts system-generated default setup.");
    lines.push("2. **Generation**: LLM creates world/setting, player identity, female character roster, personality, and initial arcs.");
    lines.push("3. **Listening scene**: Character speaks via TTS audio; player chooses meaning or infers emotion.");
    lines.push("4. **Feedback**:");
    lines.push("   - Correct choice → affection/trust increases, character reacts warmly.");
    lines.push("   - Incorrect choice → relationship progress slows, character reacts colder or awkwardly.");
    lines.push("5. **Replay**: Replaying a listening scene carries a light affection/reward cost.");
    lines.push("6. **Text reply**: Player submits a short English text reply; evaluated for comprehension and warmth.");
    lines.push("7. **Arc progression**: Characters warm up over time; relationship trajectories evolve based on accumulated choices.");
    lines.push("");

    lines.push("## Character Direction");
    lines.push("- Girls come from different countries; interaction language is always English.");
    lines.push("- Each character has a distinct personality (e.g., direct vs indirect, formal vs casual, humorous vs serious).");
    lines.push("- Character arcs are structured to avoid drift: bounded LLM prompts + session state guards.");
    lines.push("- MVP: female cast only; male characters are post-MVP.");
    lines.push("");

    lines.push("## MVP Scope");
    lines.push("**In MVP**:");
    lines.push("- PC web visual novel shell (HTML/CSS/JS or lightweight framework).");
    lines.push("- Opening scenario input → LLM-generated setting/characters/arcs.");
    lines.push("- Character/profile/arc state management.");
    lines.push("- Listening scene with TTS audio and choice-based comprehension.");
    lines.push("- Comprehension choice (pick meaning) and emotion inference (infer intent).");
    lines.push("- Affection/retry/failure rules with relationship consequences.");
    lines.push("- LLM adapter for dialogue/narrative generation.");
    lines.push("- TTS adapter for English voice synthesis.");
    lines.push("- Image adapter for character portraits and background/CG generation.");
    lines.push("**Out of scope for MVP**:");
    lines.push("- Speech recognition / voice input.");
    lines.push("- Mobile or native apps.");
    lines.push("- Male characters.");
    lines.push("- Multiplayer or social features.");
    lines.push("");

    lines.push("## Milestones");
    lines.push("1. **M1**: Web shell scaffolded, opening scenario flow works end-to-end.");
    lines.push("2. **M2**: Character roster and state management implemented; TTS listening scenes functional.");
    lines.push("3. **M3**: Affection/retry/failure rules and LLM/TTS/image adapters integrated.");
    lines.push("4. **M4**: First playable prototype with full MVP loop; internal testing.");
    lines.push("");

    lines.push("## Functional Requirements");
    lines.push("- Opening scenario input field with graceful fallback to system-generated default.");
    lines.push("- LLM adapter interface: `generateWorld()`, `generateCharacters()`, `generateDialogue(sessionId, sceneId)`.");
    lines.push("- TTS adapter interface: `synthesize(text: string): Promise<AudioBuffer>`.");
    lines.push("- Image adapter interface: `generatePortrait(characterId): Promise<string>` (returns URL or base64).");
    lines.push("- Session state: `{ playerId, characters: Character[], currentSceneId, affectionScores: Map }`.");
    lines.push("- Choice evaluation: `evaluateChoice(characterId, choiceIndex): { correct: boolean, feedback: string }`.");
    lines.push("- Affection system: scores increment on correct choices, decrement on failure/retries.");
    lines.push("- Replay cost: repeating a scene within N turns reduces affection score by a fixed amount.");
    lines.push("");

    lines.push("## Non-Functional Requirements");
    lines.push("- TTS latency must be < 2s for a responsive listening experience.");
    lines.push("- LLM dialogue generation must complete within 5s per scene turn.");
    lines.push("- Session state persisted in browser localStorage or server-side session store.");
    lines.push("- No user credentials or PII stored outside the session context.");
    lines.push("- All external API calls (LLM, TTS, image gen) are mediated by typed adapter interfaces.");
    lines.push("");

    lines.push("## Acceptance Criteria");
    lines.push("- Player can enter a custom opening scenario and receive a generated world/characters.");
    lines.push("- TTS audio plays for each character line; player can select from multiple-choice responses.");
    lines.push("- Correct choice increases affection score; incorrect choice reduces it.");
    lines.push("- Replaying a scene carries a measurable affection cost.");
    lines.push("- Character portraits and scene backgrounds are generated or sourced via the image adapter.");
    lines.push("- Session survives page reload (state persistence).");
    lines.push("- Speech recognition is NOT implemented in MVP.");

    return lines.join("\n");
  }

  // Generic fallback — no TBD for detailed non-game tasks either
  const hasDetail = task.length > 200 && /feature|implement|build|create|system|service/i.test(task);
  if (hasDetail) {
    const lines: string[] = ["# Spec", "", "## Overview", task.trim(), ""];
    lines.push("## Functional Requirements");
    lines.push("- Core functionality defined by the task description above.");
    lines.push("- Edge cases and boundary conditions to be handled by implementation.");
    lines.push("");
    lines.push("## Non-Functional Requirements");
    lines.push("- Performance: operations should complete within reasonable time bounds.");
    lines.push("- Reliability: errors must be handled gracefully with informative messages.");
    lines.push("");
    lines.push("## Acceptance Criteria");
    lines.push("- Implementation matches the described feature.");
    lines.push("- Code compiles and passes typecheck and test suite.");
    return lines.join("\n");
  }

  // Truly minimal task — delegate to clarifying questions
  return [
    "# Spec\n",
    "## Overview\n",
    task.trim(), "\n",
    "## Functional Requirements\n",
    "TBD — task is insufficiently detailed; clarify via questions.md.\n",
    "## Non-Functional Requirements\n",
    "TBD.\n",
    "## Acceptance Criteria\n",
    "TBD.\n",
  ].join("");
}

/**
 * Build the agent spec with all required sections.
 * When domain signals are detected (game, learning), includes game-specific implementation contract.
 */
function buildAgentSpec(task: string, targetSummary: string, domain: ReturnType<typeof detectTaskDomain> | null): string {
  const lines: string[] = [
    "# Agent Spec",
    "",
    "## Development Boundaries",
    "",
    "- Work must remain inside the target repository or designated run directory.",
    "- Do not write implementation deliverables outside the agreed scope.",
    "- Do not call network APIs or external services in v1 unless explicitly specified in this spec.",
    "- Do not hard-code user identities; derive from session context.",
  ];

  // ── Visual novel / romance game implementation contract ─────────────────
  if (domain?.isDetailedGame && domain?.isRomanceCompanion) {
    lines.push("", "## Page Structure");
    lines.push("| Screen | Description |");
    lines.push("|--------|-------------|");
    lines.push("| `/` (title) | Opening scenario input, start button, default generation option |");
    lines.push("| `/game` | Main game loop: character portrait, TTS audio, dialogue text, choice buttons |");
    lines.push("| `/character/:id` | Character profile: name, personality summary, affection score, arc progress |");
    lines.push("| `/review` | End-of-session summary: scores, progress, choices made |");

    lines.push("", "## Data Model");
    lines.push("```typescript");
    lines.push("interface Player { id: string; }  // session-derived, never hardcoded");
    lines.push("interface Character { id: string; name: string; country: string; personality: string;");
    lines.push("  affectionScore: number; arcProgress: number; currentMood: Mood; }");
    lines.push("interface Scene { id: string; characterId: string; dialogue: string; ttsText: string;");
    lines.push("  choices: string[]; correctChoice: number; arcHint: string; }");
    lines.push("interface GameSession { playerId: string; characters: Character[]; scenes: Scene[];");
    lines.push("  currentSceneId: string; startedAt: string; }");
    lines.push("```");

    lines.push("", "## State Flow");
    lines.push("1. **Title screen** → player enters opening scenario (or selects default).");
    lines.push("2. **Opening generation**: `LLMAdapter.generateWorld(openingScenario)` → `{ setting, playerIdentity, characters }`.");
    lines.push("3. **Scene loop**:");
    lines.push("   - TTS plays: `TTSAdapter.synthesize(scene.ttsText)`");
    lines.push("   - Player selects choice.");
    lines.push("   - `GameLogic.evaluateChoice(scene, choiceIndex)` → `{ correct, feedback, newAffection }`.");
    lines.push("   - Affection score updated; mood shifts based on correctness.");
    lines.push("4. **Replay cost**: If `sceneId` was already visited, deduct `REPLAY_COST = 2` from affection.");
    lines.push("5. **Arc progression**: After every 3 correct choices, `arcProgress += 1` and mood warms.");
    lines.push("6. **State persistence**: GameSession serialized to localStorage on every update.");

    lines.push("", "## LLM Adapter Interface Boundary");
    lines.push("```typescript");
    lines.push("interface LLMAdapter {");
    lines.push("  generateWorld(scenario: string): Promise<World>;       // setting + player identity");
    lines.push("  generateCharacters(world: World): Promise<Character[]>; // roster with personalities");
    lines.push("  generateDialogue(session: GameSession, sceneId: string): Promise<Scene>;");
    lines.push("  generateCharacterArc(characterId: string, progress: number): Promise<ArcUpdate>;");
    lines.push("}");
    lines.push("```");
    lines.push("- Bounded prompts prevent personality drift: max 512 tokens context, explicit character traits in system prompt.");
    lines.push("- State guards: LLM output validated against `Character.personality` before applying arc changes.");
    lines.push("- No live web or external search within LLM adapter in MVP.");

    lines.push("", "## TTS Adapter Interface Boundary");
    lines.push("```typescript");
    lines.push("interface TTSAdapter {");
    lines.push("  synthesize(text: string): Promise<AudioBuffer>;  // English TTS, < 2s latency");
    lines.push("  preload(sceneId: string): Promise<void>;         // optional preloading for smooth playback");
    lines.push("}");
    lines.push("```");
    lines.push("- MVP: one voice per character gender (female primary).");
    lines.push("- TTS provider: configurable; default target is MiniMax TTS from local repo or configurable external API.");
    lines.push("- Graceful degradation: if TTS fails, show text transcript and allow player to continue.");

    lines.push("", "## Image Adapter Interface Boundary");
    lines.push("```typescript");
    lines.push("interface ImageAdapter {");
    lines.push("  generatePortrait(characterId: string): Promise<string>;  // returns URL or base64");
    lines.push("  generateBackground(sceneId: string): Promise<string>;      // scene mood → background");
    lines.push("  getStaticPortrait(characterId: string, mood: Mood): string;  // fallback to static asset");
    lines.push("}");
    lines.push("```");
    lines.push("- MVP: static placeholder portraits if image gen is unavailable.");
    lines.push("- Image gen provider: configurable; target is MiniMax/other image API from local repo.");
    lines.push("- Portraits cached in localStorage by `characterId + mood` key.");

    lines.push("", "## Error Handling");
    lines.push("- **TTS failure**: Show dialogue text, enable \"skip\" and \"retry\" options; do not block progress.");
    lines.push("- **LLM generation failure**: Fall back to scripted scene from pre-authored scene pool.");
    lines.push("- **Image gen failure**: Use static placeholder image; log failure for later retry.");
    lines.push("- **State corruption**: If localStorage deserialization fails, show \"start over\" option; do not crash.");
    lines.push("- **Invalid choice index**: Treat as incorrect; apply affection penalty and advance scene.");

    lines.push("", "## Test Scenarios");
    lines.push("| ID | Scenario | Expected result |");
    lines.push("|----|----------|-----------------|");
    lines.push("| T1 | Open title screen | Show scenario input, \"Start\" and \"Use Default\" buttons |");
    lines.push("| T2 | Enter custom scenario, start | LLM generates world; game screen appears with ≥1 character |");
    lines.push("| T3 | Play listening scene | TTS audio plays; choice buttons visible; correct answer triggers warm reaction |");
    lines.push("| T4 | Choose incorrect answer | Affection decreases; character mood shifts colder |");
    lines.push("| T5 | Replay same scene | Affection cost applied; scene replays correctly |");
    lines.push("| T6 | Refresh page | Session restored from localStorage; game resumes at current scene |");
    lines.push("| T7 | TTS unavailable | Graceful degradation: text shown, skip/retry available |");
    lines.push("| T8 | Character arc progression | After 3 correct in a row, mood warms and arc progresses |");

    lines.push("", "## MVP vs Post-MVP Boundaries");
    lines.push("**MVP only**:");
    lines.push("- PC web browser; no mobile or native.");
    lines.push("- Female cast; no male characters.");
    lines.push("- Text reply (short English); no speech recognition.");
    lines.push("- Single-player; no multiplayer.");
    lines.push("- One TTS voice per gender.");
    lines.push("**Deferred post-MVP**:");
    lines.push("- Mobile apps, native clients.");
    lines.push("- Male character cast.");
    lines.push("- Voice input / speech recognition.");
    lines.push("- Multiplayer or social features.");
    lines.push("- Multiple TTS voices per character.");

    lines.push("", "## Acceptance Criteria");
    lines.push("- All 8 test scenarios pass (automated or manual verification).");
    lines.push("- `npm run typecheck && npm run build && npm run test:core` passes.");
    lines.push("- No hardcoded userId or player identity — always derived from session context.");
    lines.push("- TTS latency < 2s on simulated network conditions.");
    lines.push("- LLM adapter has mock implementation; real adapter is drop-in replacement.");
    lines.push("- State persists across page refresh without data loss.");
    lines.push("");
    lines.push("## Interfaces and Data Flow");
    lines.push("");
    lines.push("### Input");
    lines.push(`- Task: ${task.trim().slice(0, 120)}${task.trim().length > 120 ? "..." : ""}`);
    lines.push("");
    lines.push("### Output Artifacts");
    lines.push("- task.md");
    lines.push("- questions.md");
    lines.push("- product-brief.md");
    lines.push("- research.md");
    lines.push("- spec.md");
    lines.push("- agent-spec.md");
    lines.push("- tasks.md");
    lines.push("- run-summary.json");
    lines.push("");
    lines.push("### Data Flow");
    lines.push("spec-agent reads the task, detects domain signals, analyzes for ambiguity, scans the target repo (if provided), and generates structured artifacts in the run directory.");
    lines.push("");
    lines.push("## Test Requirements");
    lines.push("- Each task in tasks.md must include a `verify:` command or a clear manual acceptance check.");
    lines.push("- Automated tests: `npm run typecheck && npm run build && npm run test:core`.");
    lines.push("- All implementation artifacts are written to the run directory; no external state is modified.");
    lines.push("");
    lines.push("## Non-goals");
    lines.push("- This agent does not perform live web research or API lookups.");
    lines.push("- This agent does not write production implementation code.");
    lines.push("- This agent does not modify the target repository.");
    lines.push("- This agent does not call Codex SDK, Claude Code SDK, or any remote API.");
    lines.push("- This agent does not handle user credential or secret management.");

  } else {
    // Generic fallback
    lines.push("", "## Acceptance Criteria");
    lines.push("- Specific acceptance criteria to be defined based on task scope.");
    lines.push("- Automated verification commands must be defined for each task.");
    lines.push("");
    lines.push("## Interfaces and Data Flow");
    lines.push("");
    lines.push("### Input");
    lines.push(`- Task: ${task.trim().slice(0, 120)}${task.trim().length > 120 ? "..." : ""}`);
    lines.push("");
    lines.push("### Output Artifacts");
    lines.push("- task.md");
    lines.push("- questions.md");
    lines.push("- product-brief.md");
    lines.push("- research.md");
    lines.push("- spec.md");
    lines.push("- agent-spec.md");
    lines.push("- tasks.md");
    lines.push("- run-summary.json");
    lines.push("");
    lines.push("### Data Flow");
    lines.push("spec-agent reads the task, analyzes for ambiguity, scans the target repo (if provided), and generates structured artifacts in the run directory.");
    lines.push("");
    lines.push("## Test Requirements");
    lines.push("- Each task in tasks.md must include either a `verify:` command or a clear manual acceptance check.");
    lines.push("- Automated tests should be run via the project's existing test tooling (npm test, etc.).");
    lines.push("- All implementation artifacts are written to the run directory; no external state is modified.");
    lines.push("");
    lines.push("## Non-goals");
    lines.push("- This agent does not perform live web research or API lookups.");
    lines.push("- This agent does not write production implementation code.");
    lines.push("- This agent does not modify the target repository.");
    lines.push("- This agent does not call Codex SDK, Claude Code SDK, or any remote API.");
    lines.push("- This agent does not handle user credential or secret management.");
  }

  if (targetSummary) {
    lines.push("");
    lines.push("## Target Repository Context");
    lines.push(targetSummary);
  }

  return lines.join("\n");
}

/**
 * Build the tasks artifact.
 * When domain signals are detected (game, learning), produces a concrete development plan
 * with specific tasks, each having a verify: command.
 */
function buildTasks(task: string, domain: ReturnType<typeof detectTaskDomain> | null): string {
  // ── Visual novel / romance game tasks ───────────────────────────────────
  if (domain?.isDetailedGame && domain?.isRomanceCompanion) {
    const lines: string[] = ["# Tasks", "", "## Task", task.trim(), "", "## Development Tasks", ""];

    lines.push("- [ ] T1 Scaffold PC web visual novel shell");
    lines.push("  - description: Set up HTML/CSS/JS or lightweight framework; title screen, navigation, layout for portrait/dialogue/TTS controls.");
    lines.push("  - verify: Serve locally; title screen loads, \"Start\" and \"Use Default\" buttons respond.");

    lines.push("- [ ] T2 Opening scenario input and LLM generation flow");
    lines.push("  - description: Text input for custom opening; \"Use Default\" path; call LLM adapter to generate world, player identity, character roster.");
    lines.push("  - verify: Enter custom scenario → LLM generates ≥1 character; or accept default → scene starts.");

    lines.push("- [ ] T3 Character/profile/arc state management");
    lines.push("  - description: Player, Character, Scene, GameSession interfaces; state transitions; localStorage persistence.");
    lines.push("  - verify: Refresh page during game → session restores at current scene; no crash on corrupted state.");

    lines.push("- [ ] T4 Listening scene with TTS audio");
    lines.push("  - description: TTS adapter synthesize(); audio playback on character line; choice buttons rendered after audio.");
    lines.push("  - verify: Audio plays; if TTS fails, text shown with skip/retry options.");

    lines.push("- [ ] T5 Comprehension choice and emotion inference interaction");
    lines.push("  - description: Present 3-4 choices per scene; evaluateChoice() returns correct/incorrect and feedback.");
    lines.push("  - verify: Correct choice → warm reaction; incorrect → cold/awkward reaction; scores update.");

    lines.push("- [ ] T6 Affection/retry/failure rules");
    lines.push("  - description: Affection scores per character; replay cost (REPLAY_COST = 2); arc progression after 3 correct in a row.");
    lines.push("  - verify: Replay same scene → affection decreases by 2; 3 correct in a row → mood warms.");

    lines.push("- [ ] T7 LLM adapter implementation");
    lines.push("  - description: generateWorld(), generateCharacters(), generateDialogue(), generateCharacterArc() with bounded prompts and state guards.");
    lines.push("  - verify: Mock adapter works in all 8 test scenarios; real adapter is drop-in replacement.");

    lines.push("- [ ] T8 TTS adapter implementation");
    lines.push("  - description: synthesize() with < 2s latency; preload() for smooth playback; graceful degradation on failure.");
    lines.push("  - verify: TTS latency measured < 2s; on failure, text transcript shown and skip available.");

    lines.push("- [ ] T9 Image adapter for portraits and backgrounds");
    lines.push("  - description: generatePortrait() and generateBackground(); cache in localStorage; static placeholder fallback.");
    lines.push("  - verify: Portrait loads; on image gen failure, static placeholder shown.");

    lines.push("- [ ] T10 End-of-session review screen");
    lines.push("  - description: Show character affection scores, arc progress, choices made, total scenes completed.");
    lines.push("  - verify: /review screen shows scores and progress; \"Play Again\" restarts session.");

    lines.push("- [ ] T11 Integration tests for full MVP loop");
    lines.push("  - description: End-to-end test from title → opening generation → 3 listening scenes → review screen.");
    lines.push("  - verify: `npm run typecheck && npm run build && npm run test:core` passes.");

    lines.push("", "## Verification", "");
    lines.push("Run: `npm run typecheck && npm run build && npm run test:core`", "");
    lines.push("All 8 core test scenarios must pass (automated or manual verification).");
    lines.push("No hardcoded userId or player identity in source code.");
    lines.push("TTS latency < 2s on simulated network conditions.");
    lines.push("State persists across page refresh without data loss.");

    return lines.join("\n");
  }

  // Generic fallback
  return [
    "# Tasks",
    "",
    "## Task",
    task.trim(),
    "",
    "## Development Tasks",
    "",
    "- [ ] T1 Analyze and elaborate",
    "  - verify: (manual review of questions.md and product-brief.md)",
    "",
    "- [ ] T2 Implement core functionality",
    "  - verify: npm run typecheck && npm run build",
    "",
    "- [ ] T3 Add tests",
    "  - verify: npm run test:core",
    "",
    "## Verification",
    "",
    "Run: `npm run typecheck && npm run build && npm run test:core`",
    "",
    "Manual acceptance checks:",
    "- All artifacts are present and non-empty.",
    "- tasks.md contains verify commands or manual acceptance criteria.",
  ].join("\n");
}

/**
 * Create a run directory name following existing runs/ conventions.
 */
function createSpecAgentRunDirectory(runsDir: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(runsDir, `spec-agent-${stamp}`);
}

export async function runSpecAgent(options: SpecAgentOptions): Promise<SpecAgentResult> {
  if (!options.taskFile) {
    throw new Error("spec-agent requires --task <task-file>");
  }

  const taskFile = path.resolve(options.taskFile);
  const task = await readFile(taskFile, "utf8");
  const runDir = path.resolve(options.runDir ?? createSpecAgentRunDirectory(options.runsDir ?? DEFAULT_RUNS_DIR));
  const targetDir = options.targetDir ? path.resolve(options.targetDir) : undefined;

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();

  let status: SpecAgentResult["status"] = "done";
  let reason = "spec artifacts written successfully";

  try {
    await mkdir(runDir, { recursive: true });

    // Always copy the original task.
    await writeFile(path.join(runDir, "task.md"), task, "utf8");

    // Detect ambiguity and domain signals.
    const ambiguous = isAmbiguousTask(task);
    const domain = detectTaskDomain(task);

    // Detect sourcing signals.
    const signals = extractSourcingSignals(task);

    // Inspect local reference paths found in the task (relative to task file or absolute).
    const localEvidence = new Map<string, string>();
    {
      const taskBase = path.dirname(taskFile);
      for (const refPath of signals.localPathSignals) {
        const evidence = await inspectLocalReference(taskBase, refPath);
        localEvidence.set(refPath, evidence);
      }
    }

    // Summarize target repository if provided (via --target).
    const targetSummary = targetDir ? await summarizeTargetRepository(targetDir) : "";

    // Write questions.md.
    if (ambiguous) {
      const questions = buildQuestionsFromAmbiguousTask(task);
      await writeFile(path.join(runDir, "questions.md"), questions, "utf8");
    } else {
      await writeFile(
        path.join(runDir, "questions.md"),
        "# Questions\n\nNo clarifying questions — the task is sufficiently detailed.\n",
        "utf8",
      );
    }

    // Write product-brief.md.
    const productBrief = buildProductBrief(task, targetSummary, domain);
    await writeFile(path.join(runDir, "product-brief.md"), productBrief, "utf8");

    // Write research.md.
    const research = buildResearch(task, signals, localEvidence, targetSummary);
    await writeFile(path.join(runDir, "research.md"), research, "utf8");

    // Write spec.md.
    const spec = ambiguous ? "# Spec\n\nPending.\n" : buildSpec(task, domain);
    await writeFile(path.join(runDir, "spec.md"), spec, "utf8");

    // Write agent-spec.md.
    const agentSpec = buildAgentSpec(task, targetSummary, domain);
    await writeFile(path.join(runDir, "agent-spec.md"), agentSpec, "utf8");

    // Write tasks.md.
    const tasks = buildTasks(task, domain);
    await writeFile(path.join(runDir, "tasks.md"), tasks, "utf8");

    // Write run-summary.json.
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAtMs;
    const summary = {
      schemaVersion: 1,
      workflow: "spec-agent",
      runDir,
      targetDir,
      status,
      reason,
      artifacts: [...REQUIRED_ARTIFACTS],
      startedAt,
      endedAt,
      durationMs,
    };
    await writeFile(path.join(runDir, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch (error) {
    status = "failed";
    reason = error instanceof Error ? error.message : String(error);
  }

  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;

  return {
    runDir,
    targetDir,
    status,
    reason,
    artifacts: [...REQUIRED_ARTIFACTS],
    startedAt,
    endedAt,
    durationMs,
  };
}
