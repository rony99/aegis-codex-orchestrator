# Aegis TODO

> 本文件记录真实实现状态和下一步计划。它以当前代码为准,避免把未来目标写成已经完成。

---

## 当前真实实现(v0.2 alpha)

- [x] TypeScript 项目初始化。
- [x] 使用 `@openai/codex-sdk@0.123.0`。
- [x] CLI:
  - `codex-gtd run --task <task-file> [--model <model>] [--runs-dir <dir>] [--max-loops <n>]`
  - `codex-gtd smoke [--model <model>]`
- [x] 模型配置:
  - 默认 `gpt-5.4`
  - `CODEX_GTD_MODEL`
  - `--model`
  - `codex-5.3-spark` alias → `gpt-5.3-codex-spark`
- [x] 四个 role thread:
  - researcher
  - manager
  - developer
  - tester
- [x] 当前 run 文件协议:
  - `task.md`
  - `spec.md`
  - `interfaces.md`
  - `progress.md`
  - `blockers.md`
  - `session-log/`
  - `api-probes/`
  - `workspace/`
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

## 验证记录

- [x] `npm install`
- [x] `npm run typecheck`
- [x] `npm run build`
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

## 与最终目标的差距

- [ ] 还没有真正的多轮 discovery。
  - 当前: `run --task` 直接进入 researcher。
  - 目标: Codex 先主导澄清目的、需求、边界、技术栈、API、账号/密钥、验收标准,写入 `discovery.md`,再进入开发。
- [ ] API probes 仍是 run-local 文件,还没有跨 run 缓存或 snippet 化。
- [ ] 还没有 snippets。
- [ ] 还没有 observer / lessons。
- [ ] 还没有并行 developer。

## v0.2 hardening TODO

- [ ] 增加 discovery 阶段。
- [ ] 增加 `--turn-timeout-ms`,默认 5-10 分钟。
- [ ] 使用 `AbortController` 传入 SDK `thread.run(prompt, { signal })`。
- [ ] 每个 role turn 加 `try/catch`。
- [ ] role 失败时写:
  - `blockers.md`
  - `progress.md`
  - `session-log/<timestamp>-<role>-error.json`
- [ ] 端到端失败时 CLI 返回非零退出码。
- [ ] 增加 blocker 验收 task。
- [ ] 规范 `progress.md` 最小结构。
- [ ] 增加轻量本地测试脚本:
  - CLI 参数解析
  - model alias
  - run 目录结构
  - manager decision JSON 解析
  - `api-probes/` 目录和 README 创建

## v0.3 TODO — Snippet 池

- [ ] 创建 `snippets/INDEX.md`。
- [ ] 设计 snippet markdown 模板:
  - 用途
  - 依赖
  - 配置/密钥
  - 代码
  - 真实响应样例
  - 常见坑
- [ ] 实现 driver 层 snippet 检索。
- [ ] researcher prompt 增加"设计模块前先检索 snippets"约束。

## v0.4 TODO — Observer

- [ ] 实现 observer role。
- [ ] 创建 `lessons.md`。
- [ ] 输入 session-log,输出错误模式和改进建议。
- [ ] 先基于 5-10 个真实任务 trace 再启用。

## v0.5 TODO — Snippet 自增长

- [ ] observer 判断成功模块是否值得抽成 snippet。
- [ ] 自动生成 `/snippets/_candidates/`。
- [ ] 用户审核后入库。

## 当前判断

v0.2 alpha 已完成:API probe 目录协议、researcher probe 要求、developer/tester probe 注入和真实 public API dogfood 都已跑通。

但它还没有完整实现最终目标。要让 Aegis 真正减少 babysitting,下一步仍应优先补 discovery、turn timeout、失败落盘和 blocker 路径验收。
