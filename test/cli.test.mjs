import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
}

test("help documents run options without invoking Codex SDK", () => {
  const output = execFileSync(process.execPath, [CLI, "--help"], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });

  assert.match(output, /codex-gtd v0\.3/);
  assert.match(output, /--skip-discovery/);
  assert.match(output, /--monitor-sdk\|--skip-sdk-monitor/);
  assert.match(output, /codex-5\.3-spark -> gpt-5\.3-codex-spark/);
});

test("run requires a task path before any SDK call", () => {
  const result = runCli(["run"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /run requires --task <task-file>/);
});

test("invalid numeric flags fail fast before any SDK call", () => {
  const timeoutResult = runCli(["run", "--task", "examples/todo-exporter-task.md", "--turn-timeout-ms", "0"]);
  assert.equal(timeoutResult.status, 1);
  assert.match(timeoutResult.stderr, /--turn-timeout-ms must be a positive integer/);

  const loopResult = runCli(["run", "--task", "examples/todo-exporter-task.md", "--max-loops", "0"]);
  assert.equal(loopResult.status, 1);
  assert.match(loopResult.stderr, /--max-loops must be a positive integer/);
});

test("unknown flags fail fast before any SDK call", () => {
  const result = runCli(["run", "--task", "examples/todo-exporter-task.md", "--not-a-real-flag"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument: --not-a-real-flag/);
});
