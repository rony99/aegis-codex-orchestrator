# Aegis Codex Orchestrator — 产品规划

> 项目展示名: Aegis Codex Orchestrator  
> npm/CLI 当前包名: `codex-gtd`  
> 当前版本状态: v0.4 alpha

---

## 一、产品定位

**一句话定位**:一个面向 Codex / Claude Code / Cursor 等 coding agent 的轻量编排层,目标是减少长任务开发中的 babysitting。

Aegis 不追求"一份产品文档自动生成完美商用软件"。它追求一个更具体、可验证的价值:

> 用户先和 Codex 驱动的 discovery 阶段把目的、需求、技术栈、API、验收标准讲清楚;进入开发后,系统尽量自动推进,避免反复问"是否继续"、"是否确认"、"这个怎么做"。

最终用户体验目标:

- 开发前:重要问题集中澄清,形成可执行、可验证、可冻结的文件协议。
- 开发中:manager/developer/tester 基于文件协议推进,不依赖长对话记忆。
- 开发后:用户回来看到阶段性成果、测试证据、阻塞项和完整 session trace。

---

## 二、核心思想

### 2.1 先 discovery,再 development

开发前由 Codex 主导和用户完成结构化澄清:

- 为什么做、给谁用、解决什么问题
- 必须功能、可选功能、明确不做什么
- 技术栈选择和理由
- 外部 API、SDK、账号、密钥和数据源
- 模块边界、接口契约、错误约定
- 可测试的验收标准

这些结果应固化为:

- `discovery.md`: 用户澄清记录、关键决策、未决问题
- `spec.md`: 功能清单、验收标准、非目标
- `interfaces.md`: 冻结接口契约
- `api-probes/`: 真实可运行的 API/SDK 验证脚本和响应样例

当前 v0.4 已实现 discovery 前置：run 会先走 discovery 流程，生成高影响澄清问题并补齐 `discovery.md`。如有未决高影响问题，TTY 下会向用户提问一次并写入回答；非交互环境可用 `--skip-discovery` 直接进入 researcher。

### 2.2 文件协议,不是对话协议

agent 之间不靠长对话历史传状态,而是读写 run 目录文件。这样状态可观察、可恢复、可 replay,也能为后续 observer 提供材料。

### 2.3 接口冻结

`interfaces.md` 是开发阶段的硬约束。developer 可以自由实现内部细节,但不能擅自修改公开接口。发现接口有问题时,应回到 discovery/researcher 阶段重新评审。

### 2.4 少打扰用户

只有三类情况应该中断用户:

1. 业务层面的产品决策
2. 必须用户本人操作的账号、密钥、支付、授权
3. 系统长时间卡死且无法自解

其他事项由 manager 根据 `discovery.md` / `spec.md` / `interfaces.md` 自决并记录理由。

### 2.5 复用和反思形成复利

后续通过 snippets、api-probes、observer、lessons 把失败案例和成功组件沉淀为可复用资产。通用 agent 每次从零开始,Aegis 的长期差异化来自用户/团队自己的复用池。

---

## 三、系统架构

### 3.1 Agent 角色

| 角色 | 职责 | 当前 v0.4 状态 |
|---|---|---|
| researcher | 先执行 discovery，再产出 `discovery.md`、`spec.md`、`interfaces.md`；负责 `api-probes/` 准备 | 已实现 discovery + single-pass clarification, 带用户互动复核 |
| manager | 读取文件协议,决定 `develop` / `test` / `done` / `ask_user` | 已实现 JSON schema 决策 |
| developer | 基于冻结接口实现 `workspace/` | 已实现 |
| tester | 基于契约和验收标准测试实现 | 已实现 |
| observer | 审视 session trace,提炼 lessons/snippets | 已实现，并在 `run --observe` 下可自动挂接 |

### 3.2 当前 v0.4 文件协议

当前 v0.4 真实生成:

```text
runs/<timestamp>/
  task.md
  discovery.md
  spec.md
  interfaces.md
  progress.md
  blockers.md
  run-summary.json
  session-log/
  api-probes/
  workspace/
  sdk-health.json (可选, 运行前 SDK 健康基线)
```

可选未来增强:

- `lessons.md`（v0.4 起）用于 observer 提炼的经验。

`run-summary.json` 当前记录终态 `status` / `reason`、`failureCategory`、`terminalRole`、`metrics.roleTurns`、SDK health、observer 结果和 snippet candidates。`report` 会聚合这些 summary，并兼容旧 summary 中缺失的新字段。

`progress.md` 当前采用双层结构：顶部是 `codex-gtd:progress-state` JSON block，包含 `status`、`lastRole`、`loop`、`terminal`、`reason` 等最小机器状态；下方 `## Log` 保留人类可读过程记录。这样后续 driver/observer 可以稳定判断 run 状态，而不需要解析自然语言日志。

run-local 协议初始化、manager decision parser、API probe README validator、protocol drift detector 已拆成可测试 helper。当前本地测试覆盖 run 目录结构、progress state 修复、plain/fenced JSON decision、非法 action、缺失 reason fallback、missing protocol entries、API probe README section 检查，以及 progress/run-summary drift。

### 3.3 当前主循环

```text
researcher writes spec.md/interfaces.md

while not done:
  manager decides next_action
  if next_action == ask_user: stop and write blocker
  if next_action == done: stop
  if next_action == develop: run developer
  if next_action == test: run tester
```

当前限制:

- `maxLoops` 配合 `turnTimeoutMs` 控制循环与单轮超时，但 discovery 非交互环境下仍需用户决定是否使用 `--skip-discovery`。
- role 失败已统一落盘到 `blockers.md` / `progress.md` / `session-log/<timestamp>-<role>-error.json`，并按轮次超时中断。
- `ask_user` 路径已用缺少外部 API key/账号的 blocker task 验证；后续需要更多真实任务样本来校准失败分类。

---

## 四、分期计划

### v0.1 alpha — 最小闭环

目标:跑通"调研 → 开发 → 测试"最简循环,验证 Codex SDK + 文件协议 + 多 role thread 是否可行。

当前已交付:

- TypeScript CLI 项目
- `@openai/codex-sdk@0.123.0`
- `codex-gtd run --task <task-file>`
- `codex-gtd smoke`
- 模型配置:默认 `gpt-5.4`,支持 `CODEX_GTD_MODEL` 和 `--model`
- `codex-5.3-spark` alias → `gpt-5.3-codex-spark`
- researcher / manager / developer / tester prompts
- run 目录文件协议
- session log 保存
- Markdown TODO exporter pilot

验证记录:

- `npm install` 成功
- `npm run typecheck` 通过
- `npm run build` 通过
- `npm run smoke` 通过
- 成功 run: `runs/2026-04-23T08-27-29Z`
- 成功链路: researcher → manager → developer → manager → tester → manager

### v0.1 hardening — 让最小闭环可无人值守

目标:补齐 alpha 暴露出的可靠性缺口。

TODO:

- 已完成: 为 run 增加 SDK 预检与回归监控（记录 `sdk-health.json`，对比 baseline 失败时停在 ask_user）。

- 已完成 discovery 阶段接入:
  - Codex 先生成高影响澄清问题
  - 非交互时可用 `--skip-discovery` 跳过；否则用户回答后写入 `discovery.md`
  - researcher 基于 `discovery.md` 产出 `spec.md` / `interfaces.md`
  - 开发前明确 freeze
- 已完成: 增加 `--turn-timeout-ms`（默认 5 分钟，可由 env 配置）
- 已完成: 用 `AbortController` 限制单个 `thread.run()`
- 已完成: role 失败时写入:
  - `blockers.md`
  - `progress.md`
  - `session-log/<timestamp>-<role>-error.json`
- 已完成: CLI 在端到端失败时返回非零退出码（`ask_user` 与 `max_loops_reached` 视为失败终态）
- 已完成: 增加 blocker 路径验收 task。
- 已完成: 规范 `progress.md` 最小状态字段。

### v0.2 — API 可靠性强化

目标:解决 AI 调用外部 API/SDK 时的幻觉问题。

当前已交付:

- `api-probes/` 目录协议
- researcher 对每个外部依赖生成可执行 probe
- 保存真实命令、响应样例、失败原因
- developer prompt 强制引用 probe 结果作为 ground truth
- 跑通一个低门槛外部 API 样例: `https://httpbin.org/json`

### v0.3 — Snippet 复用池

目标:让 agent 在开发前和开发中可复用用户已有资产。

当前已交付:

- `snippets/INDEX.md`
- snippet markdown 样例:
  - 用途
  - 依赖
  - 配置/密钥
  - 代码
  - 真实响应样例
  - 常见坑
- driver 层 snippet 检索
- researcher 开始实现前先检索 snippets

### v0.4 — Observer 与 lessons

目标:用真实 session trace 反思系统错误模式。

已交付:

- 新增 `observe` 命令
- 基于现有 run 的 `session-log` 产出 `lessons.md`
- 已完成: 在主循环增加可配置的自动 observer 触发（`run --observe`）
- 新增 `run-summary.json`
- 新增 `report` 命令，汇总 `done` / `ask_user` / `max_loops_reached`、failure categories、平均耗时、SDK monitor failures、observer failures
- 已完成: summary/report 增加 `failureCategory`、`terminalRole`、`metrics.roleTurns`
- 已完成: run-local 协议与 manager decision parser 的本地测试覆盖
- 已完成: API probe artifact validator 与 progress/run-summary protocol drift helper
- 已完成: `report` 输出 protocol health 聚合计数和 recent run compact flags
- 已完成: observer prompt 注入 protocol health context，要求 lessons 记录协议健康问题
- 已完成: observer 输入压缩，`task/spec/interfaces/progress/blockers/api-probes/snippets/session-log` 在进入 SDK 前有确定性长度上限，并保留 session error reason

待补:

- 从 5-10 个真实任务里提炼更稳定的失败模式
- 继续用中等/大型真实 run 验证压缩后的 observer lesson 质量

### v0.5 — Snippet 自增长

目标:成功模块可沉淀为候选 snippet。

已交付:

- 通过 observer 提取 `Reusable snippets candidates`，并自动生成 `snippets/_candidates/` 候选文件（`run --observe` + `done` + observer 成功）。

待实现:

- 用户审核后入库（从 candidates 提升到 `snippets/` 并更新 `snippets/INDEX.md`）。

### v0.6+ — 并行与更大任务

目标:在接口冻结后支持多个 developer 并行推进。

方向:

- task queue
- per-module workspace/checkpoint
- merge/conflict strategy
- 更丰富的专业角色,例如 UI/security/performance

---

## 五、当前结论

v0.4 已证明核心方向持续可行：Codex SDK 可承载串行闭环 + discovery 先行澄清 + snippet 检索 + summary/report 指标化 + observer lessons 的试运行路径。

当前优先级转向稳定性验证（尤其是 `ask_user` 与非交互场景）和价值沉淀（observation、snippet 候选到正式入库）。
