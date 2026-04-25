#!/usr/bin/env node

import { promoteSnippetCandidate, runObserver, runOrchestration, runReport, runSmokeTest, type RunReport, type WebSearchMode } from "./driver.js";

type ParsedArgs = {
  command: string;
  task?: string;
  runDir?: string;
  model?: string;
  runsDir?: string;
  snippetsDir?: string;
  candidate?: string;
  slug?: string;
  title?: string;
  observe?: boolean;
  monitorSdk?: boolean;
  skipDiscovery?: boolean;
  webSearchMode?: WebSearchMode;
  turnTimeoutMs?: number;
  maxLoops?: number;
  limit?: number;
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

    if (arg === "--run-dir") {
      if (!next) throw new Error("--run-dir requires a directory");
      parsed.runDir = next;
      i += 1;
      continue;
    }

    if (arg === "--model") {
      if (!next) throw new Error("--model requires a model name");
      parsed.model = next;
      i += 1;
      continue;
    }

    if (arg === "--web-search") {
      if (!next) throw new Error("--web-search requires a mode");
      if (!isWebSearchMode(next)) {
        throw new Error("--web-search must be one of: disabled, cached, live");
      }
      parsed.webSearchMode = next;
      i += 1;
      continue;
    }

    if (arg === "--runs-dir") {
      if (!next) throw new Error("--runs-dir requires a directory");
      parsed.runsDir = next;
      i += 1;
      continue;
    }

    if (arg === "--snippets-dir") {
      if (!next) throw new Error("--snippets-dir requires a directory");
      parsed.snippetsDir = next;
      i += 1;
      continue;
    }

    if (arg === "--candidate") {
      if (!next) throw new Error("--candidate requires a file path");
      parsed.candidate = next;
      i += 1;
      continue;
    }

    if (arg === "--slug") {
      if (!next) throw new Error("--slug requires a slug");
      parsed.slug = next;
      i += 1;
      continue;
    }

    if (arg === "--title") {
      if (!next) throw new Error("--title requires a title");
      parsed.title = next;
      i += 1;
      continue;
    }

    if (arg === "--observe") {
      parsed.observe = true;
      continue;
    }

    if (arg === "--skip-discovery") {
      parsed.skipDiscovery = true;
      continue;
    }

    if (arg === "--monitor-sdk") {
      parsed.monitorSdk = true;
      continue;
    }

    if (arg === "--skip-sdk-monitor") {
      parsed.monitorSdk = false;
      continue;
    }

    if (arg === "--turn-timeout-ms") {
      if (!next) throw new Error("--turn-timeout-ms requires milliseconds");
      const turnTimeoutMs = Number.parseInt(next, 10);
      if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
        throw new Error("--turn-timeout-ms must be a positive integer");
      }
      parsed.turnTimeoutMs = turnTimeoutMs;
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

    if (arg === "--limit") {
      if (!next) throw new Error("--limit requires a number");
      const limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      parsed.limit = limit;
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

function isWebSearchMode(value: string): value is WebSearchMode {
  return value === "disabled" || value === "cached" || value === "live";
}

function printHelp(): void {
  console.log(`codex-gtd v0.5

Usage:
  codex-gtd run --task <task-file> [--model <model>] [--web-search <disabled|cached|live>] [--runs-dir <dir>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe] [--monitor-sdk|--skip-sdk-monitor] [--skip-discovery]
  codex-gtd observe --run-dir <run-dir> [--model <model>] [--web-search <disabled|cached|live>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]
  codex-gtd promote-snippet --candidate <candidate-file> --slug <slug> [--title <title>] [--snippets-dir <dir>]
  codex-gtd report [--runs-dir <dir>] [--limit <n>]
  codex-gtd smoke [--model <model>] [--web-search <disabled|cached|live>]

Defaults:
  model: CODEX_GTD_MODEL or gpt-5.4
  runs-dir: runs
  snippets-dir: snippets
  turn-timeout-ms: 300000
  web-search: CODEX_GTD_WEB_SEARCH or Codex SDK default
  sdk monitor: CODEX_GTD_MONITOR_SDK (default: true)

Model aliases:
  codex-5.3-spark -> gpt-5.3-codex-spark
`);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function printReport(report: RunReport): void {
  console.log(`Runs directory: ${report.runsDir}`);
  console.log(`Total runs: ${report.totalRuns}`);
  console.log(`Done: ${report.statuses.done}`);
  console.log(`Ask user: ${report.statuses.ask_user}`);
  console.log(`Max loops reached: ${report.statuses.max_loops_reached}`);
  console.log(`Average duration: ${formatDuration(report.averageDurationMs)}`);
  console.log(`SDK monitor failures: ${report.sdkMonitorFailures}`);
  console.log(`Observer failures: ${report.observerFailures}`);
  console.log(`Snippet usage: used=${report.snippetUsage.used} rejected=${report.snippetUsage.rejected} none=${report.snippetUsage.none} unknown=${report.snippetUsage.unknown}`);
  console.log(`Protocol health: missing-required-entries=${report.protocolHealth.missingRequiredProtocolEntriesCount}`);
  console.log(`Protocol health: invalid-or-missing-api-probes-readme-sections=${report.protocolHealth.invalidOrMissingApiProbesReadmeSectionsCount}`);
  console.log(`Protocol health: progress-run-summary-drift=${report.protocolHealth.progressRunSummaryDriftCount}`);
  console.log("Failure categories:");
  for (const [category, count] of Object.entries(report.failureCategories)) {
    if (count > 0) {
      console.log(`- ${category}: ${count}`);
    }
  }

  if (report.recentRuns.length === 0) {
    console.log("Recent runs: none");
    return;
  }

  console.log("Recent runs:");
  for (const run of report.recentRuns) {
    const reason = run.reason ? ` - ${run.reason}` : "";
    const snippet = run.snippetDecision.snippet
      ? ` snippet=${run.snippetDecision.status}:${run.snippetDecision.snippet}`
      : ` snippet=${run.snippetDecision.status}`;
    const hasProtocolIssue = run.protocolHealth.missingRequiredEntries
      || run.protocolHealth.invalidApiProbesReadmeSections
      || run.protocolHealth.progressRunSummaryDrift;
    const protocolHealth = hasProtocolIssue ? ` protocolHealth=${JSON.stringify(run.protocolHealth)}` : "";
    console.log(`- ${run.endedAt} ${run.status}/${run.failureCategory} ${formatDuration(run.durationMs)} ${run.model} ${run.runDir}${snippet}${protocolHealth}${reason}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "smoke") {
    const result = await runSmokeTest({ model: args.model, webSearchMode: args.webSearchMode });
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
      snippetsDir: args.snippetsDir,
      observe: args.observe,
      monitorSdk: args.monitorSdk,
      skipDiscovery: args.skipDiscovery,
      webSearchMode: args.webSearchMode,
      turnTimeoutMs: args.turnTimeoutMs,
      maxLoops: args.maxLoops,
    });

    console.log(`Run directory: ${result.runDir}`);
    console.log(`Status: ${result.status}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    if (result.observer?.status === "done") {
      console.log(`Observer: ${result.observer.status}`);
    } else if (result.observer?.status === "failed") {
      console.log(`Observer: ${result.observer.status}`);
      if (result.observer.reason) console.log(`Observer reason: ${result.observer.reason}`);
    }
    if ((result.snippetCandidates?.length ?? 0) > 0) {
      console.log(`Snippet candidates: ${result.snippetCandidates?.length}`);
      for (const candidate of result.snippetCandidates ?? []) {
        console.log(`- ${candidate}`);
      }
    }
    if (result.sdkMonitor) {
      console.log(`SDK monitor: ${result.sdkMonitor.status}`);
      console.log(`SDK version: ${result.sdkMonitor.sdkVersion}`);
      if (result.sdkMonitor.reason) console.log(`SDK monitor reason: ${result.sdkMonitor.reason}`);
    }

    if (result.status !== "done" || result.observer?.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "observe") {
    if (!args.runDir) {
      throw new Error("observe requires --run-dir <run-dir>");
    }

    const result = await runObserver({
      runDir: args.runDir,
      model: args.model,
      snippetsDir: args.snippetsDir,
      webSearchMode: args.webSearchMode,
      turnTimeoutMs: args.turnTimeoutMs,
    });

    console.log(`Run directory: ${result.runDir}`);
    console.log(`Observer status: ${result.status}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);

    if (result.status !== "done") {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "promote-snippet") {
    if (!args.candidate) {
      throw new Error("promote-snippet requires --candidate <candidate-file>");
    }
    if (!args.slug) {
      throw new Error("promote-snippet requires --slug <slug>");
    }

    const result = await promoteSnippetCandidate({
      candidateFile: args.candidate,
      snippetsDir: args.snippetsDir ?? "snippets",
      slug: args.slug,
      title: args.title,
    });

    console.log(`Snippet status: ${result.status}`);
    console.log(`Snippet file: ${result.snippetFile}`);
    console.log(`Index file: ${result.indexFile}`);
    return;
  }

  if (args.command === "report") {
    const report = await runReport({
      runsDir: args.runsDir,
      limit: args.limit,
    });
    printReport(report);
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
