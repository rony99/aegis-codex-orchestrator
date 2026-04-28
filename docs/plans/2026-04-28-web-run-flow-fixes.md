# Web Run Flow Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Web-submitted tasks track the real Codex run directory, expose SDK run diagnostics, and provide a minimal user-reply path for `ask_user` stops.

**Architecture:** Keep the CLI/driver file protocol as the source of truth. The server should not invent a parallel task state machine; it should submit work into a known run directory, read protocol files from that directory, and resume or rerun through existing driver/CLI mechanisms when possible.

**Tech Stack:** TypeScript, Express 5, Node child processes, existing `src/driver.ts` run protocol helpers, Node test runner.

---

### Task 1: Reproduce Web Run Directory Drift

**Files:**
- Modify: `test/server.test.mjs`
- Later modify: `src/driver.ts`
- Later modify: `src/server/task-manager.ts`

**Step 1: Write failing tests**

Add tests that prove:
- `createTask()` returns a task whose `runDir` becomes the actual completed run directory after the child exits.
- `listTasks()` does not show both the placeholder Web task directory and the actual CLI-created run directory for one submitted task.

Use a fake CLI runner or injectable task runner so the test does not invoke the real Codex SDK.

**Step 2: Run test to verify it fails**

Run:

```bash
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run build
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH node --test test/server.test.mjs
```

Expected: FAIL because current server creates `runs/<taskId>` but CLI writes to a separate run directory.

**Step 3: Implement minimal fix**

Prefer one of these minimal designs:
- Add an optional `runDir` override to `runOrchestration()` and a CLI `--run-dir` execution mode if that does not conflict with existing `resume --run-dir`.
- Or make `createTask()` avoid pre-creating a final run directory and parse the spawned CLI stdout for `Run directory: ...`.

Prefer the explicit run directory approach because Web already needs a stable task id. Ensure `runOrchestration()` refuses to initialize a non-empty incompatible directory unless it is the expected Web-created task directory.

**Step 4: Verify green**

Run the server test file, then full local tests.

---

### Task 2: Prevent Run Directory Collisions

**Files:**
- Modify: `test/cli.test.mjs` or a driver-focused test section in the existing test file
- Modify: `src/driver.ts`

**Step 1: Write failing test**

Add a test that creates two run directories in the same second and asserts they are distinct.

**Step 2: Run test to verify it fails**

Run targeted tests with Node 20.

Expected: FAIL with duplicate directory path or overwritten protocol artifacts.

**Step 3: Implement minimal fix**

Change `createRunDirectory()` to keep milliseconds and, if needed, append a short numeric suffix while using non-recursive final `mkdir` so collisions are detected instead of silently shared.

**Step 4: Verify green**

Run targeted tests.

---

### Task 3: Expose SDK Diagnostics To Web

**Files:**
- Modify: `test/server.test.mjs`
- Modify: `src/server/task-manager.ts`
- Modify: `src/server/routes.ts`
- Modify: `web/task.html`

**Step 1: Write failing tests**

Add a test that creates `session-log/inflight/*.json` and asserts `getTaskDetails()` returns the latest diagnostic with `role`, `model`, `status`, `classification`, `detail`, and `idleMs`.

**Step 2: Run test to verify it fails**

Run `node --test test/server.test.mjs`.

Expected: FAIL because details currently omit diagnostics.

**Step 3: Implement minimal server change**

Add a small local reader in `task-manager.ts` for latest inflight diagnostics. Do not import private driver internals unless exporting them is clearly cleaner.

**Step 4: Implement minimal UI change**

Show a compact SDK status block on `web/task.html` when diagnostics exist. Keep it read-only.

**Step 5: Verify green**

Run server tests and typecheck.

---

### Task 4: Add Minimal ask_user Reply/Resume Path

**Files:**
- Modify: `test/server.test.mjs`
- Modify: `src/server/task-manager.ts`
- Modify: `src/server/routes.ts`
- Modify: `web/task.html`

**Step 1: Write failing tests**

Add tests for a new endpoint, likely `POST /api/tasks/:id/reply`, that:
- Rejects empty replies.
- Appends the reply to a deterministic file under the run directory, such as `user-replies.md`.
- Starts a continuation path only when the task is in `ask_user`.

**Step 2: Decide minimal continuation behavior**

For first pass, use the existing CLI/driver recovery commands rather than inventing a new Web-only protocol:
- For `discovery_needed` or `blocker`, record the answer and start a new run with `--skip-discovery`, including the original task plus answer context.
- For recoverable categories where `resume_sdk` is ready, call `resume --run-dir <runDir> --execute`.

If this is too broad during implementation, split it:
- First commit stores replies and returns the recommended action.
- Second commit executes supported continuation actions.

**Step 3: Implement minimal server route**

Return updated task details and a clear message when automatic continuation is not supported.

**Step 4: Implement minimal UI**

When task status is `ask_user`, show a textarea and submit button below blockers. After submit, refresh task details.

**Step 5: Verify green**

Run server tests, typecheck, and local baseline.

---

### Task 5: Final Verification

**Files:**
- No planned production edits.

**Step 1: Run focused tests**

```bash
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH node --test test/server.test.mjs
```

**Step 2: Run full local baseline**

```bash
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run test:local
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run typecheck
git diff --check
```

**Step 3: Manual smoke**

Start the server:

```bash
PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run dev-server
```

Submit a small Web task with `--skip-discovery` equivalent checked. Verify:
- List shows one task.
- Detail page points at the real run directory.
- SDK diagnostic appears while running.
- `ask_user` runs show blockers plus a reply form.
