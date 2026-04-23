# Aegis TODO

> 本文件记录真实实现状态和下一步计划。它以当前代码为准,避免把未来目标写成已经完成。

---

## 当前真实实现(v0.3 alpha)

- [x] TypeScript 项目初始化。
- [x] 使用 `@openai/codex-sdk@0.123.0`。
- [x] CLI:
  - `codex-gtd run --task <task-file> [--model <model>] [--runs-dir <dir>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>] [--max-loops <n>] [--observe] [--skip-discovery] [--monitor-sdk|--skip-sdk-monitor]`
  - `codex-gtd report [--runs-dir <dir>] [--limit <n>]`
  - `codex-gtd smoke [--model <model>]`
- [x] 本地测试脚本:
  - `npm run test:local`
  - 覆盖 CLI help、必填 task、非法 numeric flags、未知 flags 的 fast-fail 路径
- [x] 模型配置:
  - 默认 `gpt-5.4`
  - `CODEX_GTD_MODEL`
  - `--model`
  - `codex-5.3-spark` alias → `gpt-5.3-codex-spark`
- [x] 六个 role 线程（含手动 observer）:
  - researcher
  - discovery
  - manager
  - developer
  - tester
  - observer
- [x] observer 命令:
  - `codex-gtd observe --run-dir <run-dir> [--model <model>] [--snippets-dir <dir>] [--turn-timeout-ms <ms>]`
- [x] `run --observe` 自动触发 observer 并在 run 结束后写入 `lessons.md`。
- [x] 当前 run 文件协议:
  - `task.md`
  - `discovery.md`
  - `spec.md`
  - `interfaces.md`
  - `progress.md`
  - `blockers.md`
  - `run-summary.json`
  - `session-log/`
  - `api-probes/`
  - `workspace/`
  - `sdk-health.json`
- [x] 当前全局 snippet 目录协议:
  - `snippets/INDEX.md`
  - snippets 检索注入到 researcher/manager/developer/tester prompt
- [x] researcher 必须写 `api-probes/README.md`。
- [x] 无外部依赖任务会记录 no-probe 决策。
- [x] 外部 API/SDK 任务会生成 probe artifact 和响应样例或失败说明。
- [x] manager / developer / tester prompts 会读取并注入 `api-probes/` 摘要。
- [x] manager 使用 structured JSON output:
  - `develop`
  - `test`
  - `done`
  - `ask_user`
- [x] 每个 role turn 写入 `session-log/*.json`:
  - role
  - model
  - threadId
  - startedAt / endedAt
  - prompt
  - finalResponse
  - usage
  - items
- [x] role 失败时写入 `session-log/*-error.json`、`progress.md` 和 `blockers.md`；
- [x] 每个 role turn 使用 `AbortController`（`thread.run(..., { signal })`）实现超时保护；`--turn-timeout-ms` 和 `CODEX_GTD_TURN_TIMEOUT_MS` 可配置。
- [x] 每个 run 终态写入 `run-summary.json`:
  - `status` / `reason`
  - `model`
  - `startedAt` / `endedAt` / `durationMs`
  - `maxLoops` / `turnTimeoutMs`
  - `sdkMonitor` / `observer`
  - `snippetCandidates`
  - `sessionLogEntries`
- [x] 本地 report:
  - 读取 `run-summary.json`
  - 汇总 `done` / `ask_user` / `max_loops_reached`
  - 汇总平均耗时、SDK monitor failures、observer failures
  - 输出最近 N 次 run

## 验证记录

- [x] `npm install`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run test:local`
- [x] `npm run smoke`
- [x] v0.1 pilot run:
  - `runs/2026-04-23T08-27-29Z`
  - 状态: `done`
  - 链路: researcher → manager → developer → manager → tester → manager
- [x] v0.2 dogfood spec run:
  - `runs-dogfood-v02/2026-04-23T09-20-58Z`
  - 产出 v0.2 `spec.md` / `interfaces.md`
- [x] v0.2 no-probe verification:
  - `runs-dogfood-v02-verify/2026-04-23T09-24-38Z`
  - 生成 `api-probes/README.md`
  - 记录 no-probe 决策
- [x] v0.2 public API probe verification:
  - `runs-dogfood-v02-api/2026-04-23T09-26-25Z`
  - 生成 `api-probes/httpbin-json-probe.sh`
  - 生成 `api-probes/httpbin-json-response.json`
  - 使用 `https://httpbin.org/json` 捕获真实响应样例
- [x] blocker-path verification:
  - `runs-blocker-verify/2026-04-23T11-23-42Z`
  - task: `examples/blocker-api-key-task.md`
  - 状态: `ask_user`
  - SDK monitor: `ok`
  - 生成 `api-probes/sms-provider-probe.sh`
  - `blockers.md` 记录缺少 paid SMS provider credentials / sender ID / billing setup
- [x] run summary verification:
  - `runs-summary-verify/2026-04-23T11-30-25Z`
  - 状态: `ask_user`
  - 生成 `run-summary.json`
  - summary 记录 `status` / `reason` / `model` / `durationMs` / `sdkMonitor` / `sessionLogEntries`
- [x] report verification:
  - `node dist/cli.js report --runs-dir runs-summary-verify --limit 5`
  - 汇总 1 条真实 `ask_user` run
  - SDK monitor failures: `0`
  - Observer failures: `0`

## 与最终目标的差距

- [x] discovery 仍有改进空间，但已落地前置澄清。
  - 当前: `run` 已支持 discovery 阶段与 TTY 追问；`--skip-discovery` 用于非交互环境。
  - 目标: 维持一次澄清+一次追问的真实闭环，继续减少不必要的人机往返。
- [ ] API probes 仍是 run-local 文件,未对接跨 run 的质量门控。
- [ ] Snippets 还在扩充中，缺少覆盖关键场景的模板和治理规则。
- [x] observer 命令可生成 lessons（基础版），且 `run --observe` 已挂接到主循环。
- [ ] 还没有并行 developer。

## v0.2 hardening TODO

- [x] 增加 discovery 阶段。
- [x] 增加 `--turn-timeout-ms`,默认 5 分钟（可通过 env 调整）。
- [x] 使用 `AbortController` 传入 SDK `thread.run(prompt, { signal })`。
- [x] 每个 role turn 加 `try/catch`。
- [x] role 失败时写:
  - `blockers.md`
  - `progress.md`
  - `session-log/<timestamp>-<role>-error.json`
- [x] 端到端失败时 CLI 返回非零退出码。
- [x] 增加 blocker 验收 task。
- [ ] 规范 `progress.md` 最小结构。
- [x] 增加轻量本地测试脚本:
  - CLI 参数解析
  - model alias 文档输出
  - fast-fail 错误路径
  - `run-summary.json` schema shape
  - fake `run-summary.json` report 汇总
- [ ] 扩展本地测试:
  - run 目录结构
  - manager decision JSON 解析
  - `api-probes/` 目录和 README 创建

## v0.3 TODO — Snippet 池

- [ ] 增加 snippets 分类与标签。
- [ ] 补齐常见 API/CLI 场景模板。
- [ ] 记录并追踪 snippet 命中率。
- [ ] researcher 写入选用 snippet 的原因和替代决策。

## v0.4 TODO — Observer 与 lessons

- [x] 实现 `observe` 命令。
- [x] 产出 `lessons.md`（基于现有 run 的 `session-log`）。
- [ ] 输入多轮真实任务 trace，提炼更稳定的错误模式和改进建议。
- [x] 决定 observer 挂接策略（`run --observe` 自动触发）。

## v0.5 TODO — Snippet 自增长

- [x] observer 判断通过测试实现是否值得抽象（通过 lessons 中候选片段区提取）。
- [x] 自动生成 `/snippets/_candidates/`。
- [ ] 用户审核后入库。

## 当前判断

v0.3 alpha 已完成: discovery 接入、API probe 与 snippet 检索通路、prompt 接入、版本与文档同步都已打通。

但它仍未完全闭环。下一步优先补 blocker 路径验收和非交互场景下 discovery 可靠性。
