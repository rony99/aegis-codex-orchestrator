#!/usr/bin/env node

import { applyWorkspacePatch, auditSnippets, buildResumePlan, buildRunRepairPlan, buildRunStatus, executeResumePlan, exportWorkspacePatch, promoteSnippetCandidate, runObserver, runOrchestration, runReport, runSdkProbe, runSmokeTest, type ApplyWorkspaceResult, type ExecuteResumeResult, type ExportWorkspaceResult, type ResumePlan, type RunRepairPlan, type RunReport, type RunStatus, type SdkProbeResult, type SnippetAuditResult, type WebSearchMode } from "./driver.js";

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
  category?: string;
  tags?: string[];
  outFile?: string;
  traceFile?: string;
  targetDir?: string;
  write?: boolean;
  execute?: boolean;
  sdkContinue?: boolean;
  observe?: boolean;
  monitorSdk?: boolean;
  skipDiscovery?: boolean;
  rawCli?: boolean;
  webSearchMode?: WebSearchMode;
  turnTimeoutMs?: number;
  maxLoops?: number;
  limit?: number;
  json?: boolean;
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

    if (arg === "--category") {
      if (!next) throw new Error("--category requires a category name");
      parsed.category = next;
      i += 1;
      continue;
    }

    if (arg === "--tags") {
      if (!next) throw new Error("--tags requires a comma-separated list");
      parsed.tags = next.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
      i += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) throw new Error("--out requires a patch file path");
      parsed.outFile = next;
      i += 1;
      continue;
    }

    if (arg === "--trace-file") {
      if (!next) throw new Error("--trace-file requires a file path");
      parsed.traceFile = next;
      i += 1;
      continue;
    }

    if (arg === "--target") {
      if (!next) throw new Error("--target requires a repository directory");
      parsed.targetDir = next;
      i += 1;
      continue;
    }

    if (arg === "--write") {
      parsed.write = true;
      continue;
    }

    if (arg === "--execute") {
      parsed.execute = true;
      continue;
    }

    if (arg === "--sdk-continue") {
      parsed.sdkContinue = true;
      continue;
    }

    if (arg === "--observe") {
      parsed.observe = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
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

    if (arg === "--raw-cli") {
      parsed.rawCli = true;
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
  codex-gtd run --task <task-file> [--run-dir <run-dir>] [--model <model>] [--web-search <disabled|cached|live>] [--runs-dir <dir>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe] [--monitor-sdk|--skip-sdk-monitor] [--skip-discovery]
  codex-gtd observe --run-dir <run-dir> [--model <model>] [--web-search <disabled|cached|live>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]
  codex-gtd promote-snippet --candidate <candidate-file> --slug <slug> [--title <title>] [--category <name>] [--tags <a,b,c>] [--snippets-dir <dir>]
  codex-gtd audit-snippets [--snippets-dir <dir>] [--json]
  codex-gtd report [--runs-dir <dir>] [--limit <n>]
  codex-gtd status --run-dir <run-dir> [--json]
  codex-gtd repair-plan --run-dir <run-dir> [--json]
  codex-gtd export-workspace --run-dir <run-dir> [--out <patch-file>]
  codex-gtd apply-workspace --run-dir <run-dir> --target <repo-dir> [--write]
  codex-gtd resume --run-dir <run-dir> [--target <repo-dir>] [--execute] [--sdk-continue] [--write] [--model <model>] [--web-search <disabled|cached|live>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe]
  codex-gtd smoke [--model <model>] [--web-search <disabled|cached|live>]
  codex-gtd sdk-probe [--model <model>] [--web-search <disabled|cached|live>] [--turn-timeout-ms <ms>] [--trace-file <json-file>] [--raw-cli] [--json]

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
  console.log(`Snippets directory: ${report.snippetsDir}`);
  console.log(`Total runs: ${report.totalRuns}`);
  console.log(`Done: ${report.statuses.done}`);
  console.log(`Ask user: ${report.statuses.ask_user}`);
  console.log(`Max loops reached: ${report.statuses.max_loops_reached}`);
  console.log(`Average duration: ${formatDuration(report.averageDurationMs)}`);
  console.log(`SDK monitor failures: ${report.sdkMonitorFailures}`);
  console.log(`Observer failures: ${report.observerFailures}`);
  console.log(`Snippet usage: used=${report.snippetUsage.used} rejected=${report.snippetUsage.rejected} none=${report.snippetUsage.none} unknown=${report.snippetUsage.unknown}`);
  console.log(`Snippet metadata usage: categories=${formatCountMap(report.snippetMetadataUsage.categories)} tags=${formatCountMap(report.snippetMetadataUsage.tags)} unmatched-used=${report.snippetMetadataUsage.unmatchedUsedDecisions}`);
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

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}:${value}`).join(",");
}

function printRepairPlan(plan: RunRepairPlan): void {
  console.log("Repair plan:");
  console.log(`Run directory: ${plan.runDir}`);
  console.log(`Action: ${plan.action}`);
  console.log(`Resumable: ${plan.resumable ? "yes" : "no"}`);
  console.log(`Failure category: ${plan.failureCategory}`);
  if (plan.status) console.log(`Status: ${plan.status}`);
  if (plan.terminalRole) console.log(`Terminal role: ${plan.terminalRole}`);
  if (plan.reason) console.log(`Reason: ${plan.reason}`);
  console.log(`Summary: ${plan.summary}`);

  if (plan.issues.length > 0) {
    console.log("Issues:");
    for (const issue of plan.issues) {
      console.log(`- ${issue}`);
    }
  }

  if (plan.commands.length > 0) {
    console.log("Suggested commands:");
    for (const command of plan.commands) {
      console.log(`- ${command}`);
    }
  }
}

function printWorkspaceExport(result: ExportWorkspaceResult): void {
  console.log(`Workspace patch: ${result.outFile}`);
  console.log(`Run directory: ${result.runDir}`);
  console.log(`Workspace directory: ${result.workspaceDir}`);
  console.log(`Files: ${result.fileCount}`);
  console.log(`Bytes: ${result.byteCount}`);
}

function printWorkspaceApply(result: ApplyWorkspaceResult): void {
  console.log(`Workspace patch: ${result.patchFile}`);
  console.log(`Run directory: ${result.runDir}`);
  console.log(`Target directory: ${result.targetDir}`);
  console.log(`Mode: ${result.applied ? "write" : "dry-run"}`);
  console.log("Patch check: passed");
  console.log(`Files: ${result.fileCount}`);
  console.log(`Bytes: ${result.byteCount}`);
}

function printResumePlan(plan: ResumePlan): void {
  console.log("Resume plan:");
  console.log(`Run directory: ${plan.runDir}`);
  console.log(`Action: ${plan.action}`);
  console.log(`Ready: ${plan.ready ? "yes" : "no"}`);
  console.log(`Source: ${plan.source}`);
  console.log(`Summary: ${plan.summary}`);

  if (plan.issues.length > 0) {
    console.log("Issues:");
    for (const issue of plan.issues) {
      console.log(`- ${issue}`);
    }
  }

  if (plan.commands.length > 0) {
    console.log("Suggested commands:");
    for (const command of plan.commands) {
      console.log(`- ${command}`);
    }
  }
}

function printResumeExecution(result: ExecuteResumeResult): void {
  console.log(`Executed: ${result.plan.action}`);
  if (result.rerunResult) {
    console.log(`Rerun directory: ${result.rerunResult.runDir}`);
    console.log(`Rerun status: ${result.rerunResult.status}`);
    if (result.rerunResult.reason) console.log(`Rerun reason: ${result.rerunResult.reason}`);
  }
  if (result.exportResult) {
    printWorkspaceExport(result.exportResult);
  }
  if (result.applyResult) {
    printWorkspaceApply(result.applyResult);
  }
  if (result.runResult) {
    console.log(`Run status: ${result.runResult.status}`);
    console.log(`Run directory: ${result.runResult.runDir}`);
    if (result.runResult.reason) console.log(`Reason: ${result.runResult.reason}`);
    if (result.runResult.observer) console.log(`Observer status: ${result.runResult.observer.status}`);
  }
}

function printRunStatus(status: RunStatus): void {
  console.log("Run status:");
  console.log(`Run directory: ${status.runDir}`);
  console.log(`Terminal status: ${status.terminalStatus}`);
  console.log(`Failure category: ${status.failureCategory}`);
  if (status.terminalRole) console.log(`Terminal role: ${status.terminalRole}`);
  if (status.reason) console.log(`Reason: ${status.reason}`);
  console.log(`Protocol health: ${status.protocolHealth}`);
  if (status.protocolIssues.length > 0) {
    console.log("Protocol issues:");
    for (const issue of status.protocolIssues) {
      console.log(`- ${issue}`);
    }
  }
  if (status.diagnostic) {
    console.log(`Current diagnosis: ${status.diagnostic.classification}`);
    console.log(`Diagnostic detail: ${status.diagnostic.detail}`);
    console.log(`Diagnostic role: ${status.diagnostic.role}`);
    console.log(`Diagnostic idle: ${formatDuration(status.diagnostic.idleMs)}`);
    if (status.diagnostic.lastEventType) console.log(`Diagnostic last event: ${status.diagnostic.lastEventType}`);
  }
  console.log(`Recommended action: ${status.recommendedAction}`);
  console.log(`Summary: ${status.summary}`);
  if (status.commands.length > 0) {
    console.log("Suggested commands:");
    for (const command of status.commands) {
      console.log(`- ${command}`);
    }
  }
}

function printSdkProbe(result: SdkProbeResult): void {
  console.log("SDK probe:");
  console.log(`Status: ${result.status}`);
  console.log(`Model: ${result.model}`);
  console.log(`Thread ID: ${result.threadId ?? "unknown"}`);
  console.log(`Duration: ${formatDuration(result.durationMs)}`);
  console.log(`Events: ${result.events.length}`);
  if (result.traceFile) console.log(`Trace file: ${result.traceFile}`);
  if (result.rawCli) {
    console.log(`Raw CLI exit: ${result.rawCli.signal ? `signal ${result.rawCli.signal}` : `code ${result.rawCli.exitCode ?? 0}`}`);
    console.log(`Raw CLI stdout lines: ${result.rawCli.stdoutLines.length}`);
    if (result.rawCli.warnings && result.rawCli.warnings.length > 0) {
      console.log("Raw CLI warnings:");
      const warningCounts = new Map<string, number>();
      for (const warning of result.rawCli.warnings) {
        const key = `${warning.severity}/${warning.category}`;
        warningCounts.set(key, (warningCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of [...warningCounts.entries()].sort()) {
        console.log(`- ${key}: ${count}`);
      }
    }
    if (result.rawCli.stderr) console.log(`Raw CLI stderr: ${result.rawCli.stderr}`);
  }
  if (result.events.length > 0) {
    const last = result.events.at(-1);
    if (last) {
      console.log(`Last event: ${last.event.type}`);
      console.log(`Diagnosis: ${last.classification}`);
      console.log(`Detail: ${last.detail}`);
    }
  }
  if (result.error) {
    console.log(`Error: ${result.error.message}`);
    console.log(`Error classification: ${result.error.classification}`);
    console.log(`Error detail: ${result.error.detail}`);
  } else if (result.finalResponse) {
    console.log(`Final response: ${result.finalResponse}`);
  }
}

function printSnippetAudit(result: SnippetAuditResult): void {
  console.log("Snippet audit:");
  console.log(`Snippets directory: ${result.snippetsDir}`);
  console.log(`Snippets: ${result.snippetCount}`);
  console.log(`Passed: ${result.passed}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Warnings: ${result.warnings}`);

  const entriesWithIssues = result.entries.filter((entry) => entry.issues.length > 0);
  if (entriesWithIssues.length === 0) {
    console.log("All snippets pass the first-version quality gate.");
    return;
  }

  console.log("Issues:");
  for (const entry of entriesWithIssues) {
    for (const issue of entry.issues) {
      console.log(`- ${entry.file}: ${issue.severity}/${issue.code}: ${issue.message}`);
    }
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

  if (args.command === "sdk-probe") {
    const result = await runSdkProbe({
      model: args.model,
      webSearchMode: args.webSearchMode,
      turnTimeoutMs: args.turnTimeoutMs,
      traceFile: args.traceFile,
      rawCli: args.rawCli,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSdkProbe(result);
    }
    if (result.status !== "done") {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "run") {
    if (!args.task) {
      throw new Error("run requires --task <task-file>");
    }

    const result = await runOrchestration({
      taskFile: args.task,
      model: args.model,
      runDir: args.runDir,
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
      category: args.category,
      tags: args.tags,
    });

    console.log(`Snippet status: ${result.status}`);
    console.log(`Snippet file: ${result.snippetFile}`);
    console.log(`Index file: ${result.indexFile}`);
    return;
  }

  if (args.command === "audit-snippets") {
    const result = await auditSnippets({
      snippetsDir: args.snippetsDir ?? "snippets",
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSnippetAudit(result);
    }
    if (result.failed > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "report") {
    const report = await runReport({
      runsDir: args.runsDir,
      snippetsDir: args.snippetsDir,
      limit: args.limit,
    });
    printReport(report);
    return;
  }

  if (args.command === "repair-plan") {
    if (!args.runDir) {
      throw new Error("repair-plan requires --run-dir <run-dir>");
    }

    const plan = await buildRunRepairPlan({ runDir: args.runDir });
    if (args.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      printRepairPlan(plan);
    }
    if (plan.action === "repair_protocol" || plan.action === "inspect") {
      process.exitCode = 1;
    }
    return;
  }

  if (args.command === "status") {
    if (!args.runDir) {
      throw new Error("status requires --run-dir <run-dir>");
    }

    const status = await buildRunStatus({ runDir: args.runDir });
    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printRunStatus(status);
    return;
  }

  if (args.command === "export-workspace") {
    if (!args.runDir) {
      throw new Error("export-workspace requires --run-dir <run-dir>");
    }

    const result = await exportWorkspacePatch({
      runDir: args.runDir,
      outFile: args.outFile,
    });
    printWorkspaceExport(result);
    return;
  }

  if (args.command === "apply-workspace") {
    if (!args.runDir) {
      throw new Error("apply-workspace requires --run-dir <run-dir>");
    }
    if (!args.targetDir) {
      throw new Error("apply-workspace requires --target <repo-dir>");
    }

    const result = await applyWorkspacePatch({
      runDir: args.runDir,
      targetDir: args.targetDir,
      patchFile: args.outFile,
      write: args.write,
    });
    printWorkspaceApply(result);
    return;
  }

  if (args.command === "resume") {
    if (!args.runDir) {
      throw new Error("resume requires --run-dir <run-dir>");
    }

    if (args.execute) {
      const result = await executeResumePlan({
        runDir: args.runDir,
        targetDir: args.targetDir,
        write: args.write,
        model: args.model,
        snippetsDir: args.snippetsDir,
        observe: args.observe,
        webSearchMode: args.webSearchMode,
        turnTimeoutMs: args.turnTimeoutMs,
        maxLoops: args.maxLoops,
        sdkContinue: args.sdkContinue,
      });
      printResumePlan(result.plan);
      printResumeExecution(result);
      if (result.runResult && (result.runResult.status !== "done" || result.runResult.observer?.status === "failed")) {
        process.exitCode = 1;
      }
      return;
    }

    const plan = await buildResumePlan({
      runDir: args.runDir,
      targetDir: args.targetDir,
    });
    printResumePlan(plan);
    if (!plan.ready) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
