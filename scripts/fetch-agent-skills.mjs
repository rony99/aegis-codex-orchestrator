#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO_URL = "https://github.com/addyosmani/agent-skills.git";
const DEFAULT_DEST = path.join(".codex-gtd", "agent-skills", "agent-skills");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const destArgIndex = args.indexOf("--dest");
const dest = path.resolve(destArgIndex >= 0 && args[destArgIndex + 1] ? args[destArgIndex + 1] : DEFAULT_DEST);

if (dryRun) {
  console.log(`Would fetch ${REPO_URL}`);
  console.log(`Destination: ${path.relative(process.cwd(), dest) || "."}`);
  console.log("Use --force to replace a non-git destination.");
  process.exit(0);
}

const relativeDest = path.relative(process.cwd(), dest) || ".";
if (existsSync(dest) && !existsSync(path.join(dest, ".git"))) {
  if (!force) {
    console.error(`${relativeDest} exists but is not a git checkout. Re-run with --force to replace it.`);
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
}

const command = existsSync(path.join(dest, ".git"))
  ? ["git", ["-C", dest, "pull", "--ff-only"]]
  : ["git", ["clone", "--depth", "1", REPO_URL, dest]];

console.log(`${command[0]} ${command[1].join(" ")}`);
const result = spawnSync(command[0], command[1], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`agent-skills ready at ${relativeDest}`);
