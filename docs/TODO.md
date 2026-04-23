# Aegis TODO

> 本文件记录真实实现状态和下一步计划。它以当前代码为准,避免把未来目标写成已经完成。

---

## 当前真实实现(v0.1 alpha)

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
  - `workspace/`
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
- [x] 真实 Codex SDK smoke test 已通过。
- [x] Markdown TODO exporter pilot 已跑通。

## 验证记录

- [x] `npm install`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm run smoke`
- [x] 成功 run:
  - `runs/2026-04-23T08-27-29Z`
  - 状态: `done`
  - session log 数量: 6
  - 链路: researcher → manager → developer → manager → tester → manager
- [x] 成功 run 中的测试脚本复跑通过:
  - `runs/2026-04-23T08-27-29Z/workspace/todo-exporter-test.sh`

## 与最终目标的差距

- [ ] 还没有真正的多轮 discovery。
  - 当前: `run --task` 直接进入 researcher,根据单个 task 文件生成 `spec.md` / `interfaces.md`。
  - 目标: Codex 先主导澄清目的、需求、边界、技术栈、API、账号/密钥、验收标准,写入 `discovery.md`,再进入开发。
- [ ] 还没有 `api-probes/`。
  - 当前: pilot task 无外部 API。
  - 目标: 外部 API/SDK 必须先 probe,保存真实响应样例。
- [ ] 还没有 snippets。
- [ ] 还没有 observer / lessons。
- [ ] 还没有并行 developer。

## v0.1 hardening TODO

- [ ] 增加 discovery 阶段。
  - `codex-gtd discover --task <task-file>` 或 `run` 的第一阶段先进入 discovery。
  - Codex 生成高影响澄清问题。
  - 用户回答后写入 `discovery.md`。
  - researcher 基于 `discovery.md` 生成 `spec.md` / `interfaces.md`。
  - 开发前明确 freeze。
- [ ] 增加 `--turn-timeout-ms`,默认 5-10 分钟。
- [ ] 使用 `AbortController` 传入 SDK `thread.run(prompt, { signal })`。
- [ ] 每个 role turn 加 `try/catch`。
- [ ] role 失败时写:
  - `blockers.md`
  - `progress.md`
  - `session-log/<timestamp>-<role>-error.json`
- [ ] 端到端失败时 CLI 返回非零退出码。
- [ ] 增加 blocker 验收 task。
- [ ] 规范 `progress.md` 最小结构:
  - status
  - current loop
  - last action
  - commands run
  - remaining work
  - blockers
- [ ] 增加轻量本地测试脚本:
  - CLI 参数解析
  - model alias
  - run 目录结构
  - manager decision JSON 解析

## v0.2 TODO — API probes

- [ ] 创建 `api-probes/` 目录协议。
- [ ] researcher prompt 增加规则:凡是外部 API/SDK,必须先生成并运行 probe。
- [ ] session log 记录 probe 命令、响应样例、失败原因。
- [ ] developer prompt 强制引用 probe 结果作为 API ground truth。
- [ ] 选一个低门槛外部 API/SDK 做验证。

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

v0.1 alpha 已完成:最小闭环真实跑通,验证了 Codex SDK + 文件协议 + 多 role thread 的基本方向。

但它还没有完整实现最终目标。要让 Aegis 真正减少 babysitting,下一步必须先补 discovery、turn timeout、失败落盘和 blocker 路径验收。
