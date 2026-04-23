#!/usr/bin/env node

import { runOrchestration, runSmokeTest } from "./driver.js";

type ParsedArgs = {
  command: string;
  task?: string;
  model?: string;
  runsDir?: string;
  maxLoops?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help" };
  }

  const [command, ...rest] = argv;
  const parsed: ParsedArgs = { command };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];

    if (arg === "--task") {
      if (!next) throw new Error("--task requires a file path");
      parsed.task = next;
      i += 1;
      continue;
    }

    if (arg === "--model") {
      if (!next) throw new Error("--model requires a model name");
      parsed.model = next;
      i += 1;
      continue;
    }

    if (arg === "--runs-dir") {
      if (!next) throw new Error("--runs-dir requires a directory");
      parsed.runsDir = next;
      i += 1;
      continue;
    }

    if (arg === "--max-loops") {
      if (!next) throw new Error("--max-loops requires a number");
      const maxLoops = Number.parseInt(next, 10);
      if (!Number.isFinite(maxLoops) || maxLoops < 1) {
        throw new Error("--max-loops must be a positive integer");
      }
      parsed.maxLoops = maxLoops;
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.command = "help";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  console.log(`codex-gtd v0.1

Usage:
  codex-gtd run --task <task-file> [--model <model>] [--runs-dir <dir>] [--max-loops <n>]
  codex-gtd smoke [--model <model>]

Defaults:
  model: CODEX_GTD_MODEL or gpt-5.4
  runs-dir: runs

Model aliases:
  codex-5.3-spark -> gpt-5.3-codex-spark
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "smoke") {
    const result = await runSmokeTest({ model: args.model });
    console.log(result.finalResponse);
    return;
  }

  if (args.command === "run") {
    if (!args.task) {
      throw new Error("run requires --task <task-file>");
    }

    const result = await runOrchestration({
      taskFile: args.task,
      model: args.model,
      runsDir: args.runsDir,
      maxLoops: args.maxLoops,
    });

    console.log(`Run directory: ${result.runDir}`);
    console.log(`Status: ${result.status}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
