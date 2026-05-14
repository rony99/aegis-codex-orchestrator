# CC Team 开发文档与记录

## Product Goal

CC Team 的目标是把 Claude Code SDK 变成一个本地可运行的产品开发团队。用户只需要提出目标或观点，系统团队就能主动完成 spec、plan、build、test、review、ship 的项目周期，并只在高影响问题上打断用户。

第一版面向本地单用户使用，强调三件事：

- 拆解：把模糊目标变成可执行计划、阶段任务和验收条件。
- 协作：用 SDK role prompt、skill guidance、运行文档和监督检查组织工作。
- 验收：每个阶段有可读 cockpit 文档和机器验证，不能只靠“看起来可以”完成。

## User Perspective

用户在产品里是老板视角，而不是一线执行者。老板需要看到：

- 团队当前目标和整体计划。
- 当前处于 spec、plan、build、test、review、ship 的哪一步。
- Leader 正在做什么、已经完成什么、下一步准备做什么。
- Supervisor 是否建议继续、返工、补验证，还是需要询问老板。
- 状态流转记录，包括阶段开始、阶段完成、验证结果、监督意见和老板 guidance。
- 一个入口可以给 Leader 发方向性引导，作为下一轮执行的输入。

普通实现细节使用默认工程判断处理；只有核心功能取舍、数据/集成边界、凭据权限、成本明显扩大、本地团队无法继续等问题才进入 ask_user。

## SDK and Model Boundary

第一版只基于 Claude Code SDK 做团队 runtime，不实现 Codex SDK runtime。当前 repo 按 AGENTS.md 使用 MiniMax Anthropic-compatible 配置，本地运行 Claude Code SDK workflow 前需要加载 `.env`，但文档、日志和 artifacts 不写入 secret。

默认模型边界：

- `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`
- `ANTHROPIC_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_OPUS_MODEL=MiniMax-M2.7`
- `ANTHROPIC_DEFAULT_SONNET_MODEL=MiniMax-M2.7`

这些值是非 secret 的本地配置口径；实际密钥仍只来自 ignored `.env`。

## Lifecycle Skill Guidance

Leader 的 role prompt 必须加载 lifecycle skill guidance，作为每次启动 SDK 的固有信息，而不是依赖用户每次传入。项目必须先把开源 `addyosmani/agent-skills` 下载到本地 ignored 目录，SDK 启动时优先读取这些完整 skill 文件；不可用时才使用 repo-local condensed guidance 兜底。

本地下载/更新命令：

```bash
npm run fetch:agent-skills
```

默认下载位置：

```text
.codex-gtd/agent-skills/agent-skills
```

该目录由 `.gitignore` 忽略，不把第三方 repo 和长 prompt 文本提交进当前仓库。也可以用 `CODEX_GTD_AGENT_SKILLS_DIR`、`CC_TEAM_SKILLS_DIR` 或 `AGENT_SKILLS_DIR` 指向其他本地 skills 目录。

固有指导原则：

- spec before code：先澄清目标和边界。
- vertical task breakdown：计划拆成可交付的垂直切片。
- incremental build：先 demo，再验证，再补 MVP 和健壮性。
- TDD/verification：用机器验证证明完成。
- review before ship：发货前独立检查 correctness、security、coverage。
- local delivery gate：第一版只做本地交付报告，不自动 commit、push、deploy。

## Phase 1: Plan B, Leader + Supervisor

Phase 1 使用 `teamMode: "supervised"`，也是 `cc-team-run` 的默认模式。

运行结构：

- `leader`：一个 Claude Code SDK session，加载完整 lifecycle skill guidance，串行执行 spec、plan、build、test、review、ship。
- `supervisor`：一个独立 Claude Code SDK session，只做审计、督促和下一步建议，不直接改产品代码。
- `artifacts/team-cockpit.md`：唯一串行维护的老板驾驶舱文档，由 Leader 阶段后更新，Supervisor 检查后补充监督摘要。
- `leader-guidance.md`：老板 guidance 的队列文件，Leader 下一轮读取。

Phase 1 不做多 worker 并行，不自动 commit、push、deploy。它的核心目标是快速跑通老板视角产品闭环。

## Phase 2: Multi-Agent Team

Phase 2 在 Phase 1 稳定后升级到 `teamMode: "multi-role"` 的多 Agent 团队。

升级方向：

- Leader 负责拆解和调度，不再独自执行所有工作。
- Planner、Developer、Tester、Reviewer、Shipper 分别使用自己的 SDK session。
- Worker registry 记录历史 session、role、cwd、能力标签和健康状态，同 role 同 cwd 优先复用。
- 每个 SDK 维护自己的状态文档，例如 `planner-status.md`、`developer-status.md`、`tester-status.md`、`reviewer-status.md`。
- Supervisor 读取多文档后生成总览 `team-cockpit.md`。
- 用任务文档协议交接：目标、上下文、输入文件、允许改动范围、验收标准、验证命令、失败分类。

## Cockpit Document Protocol

Phase 1 只使用一个串行 cockpit 文档，避免并发写冲突：

`artifacts/team-cockpit.md`

文档必须覆盖：

- 当前目标。
- 阶段状态。
- 计划。
- 已完成事项。
- 正在做什么。
- 阻塞和 assumptions。
- Supervisor 摘要、风险、下一步建议。
- 老板 guidance 摘要。

Web UI 优先读取 `team-cockpit.md` 展示；`team-state.json`、`run-summary.json`、SQLite events 是结构化状态和 fallback。

## UI Prototype Requirements

React Web UI 使用“老板驾驶舱”布局：

- 顶部：任务目标、状态、当前阶段、推荐动作、最新 blocker。
- 进度：`spec -> plan -> build -> test -> review -> ship` 阶段条。
- 主体：展示 `team-cockpit.md` 的计划、进度、当前工作和下一步。
- 监督：展示 supervisor 检查摘要、风险提醒和是否建议继续/返工/询问老板。
- Timeline：展示阶段开始、阶段完成、验证结果、监督意见、老板 guidance。
- Guidance：提供输入框，把方向性要求写入 `leader-guidance.md` 和 SQLite。

## Acceptance Criteria

Phase 1 完成标准：

- `cc-team-run` 默认使用 `teamMode: "supervised"`。
- CLI 支持 `--team-mode supervised|multi-role`。
- supervised 模式按阶段调用 Leader，再调用 Supervisor。
- Leader/Supervisor 维护 `artifacts/team-cockpit.md`。
- `run-summary.json` 写入 `workflow: "cc-team-run"` 和 `teamMode`。
- Supervisor 判定缺少验证或 Critical issue 时不能进入 ship-ready。
- Web 创建团队任务默认传 `teamMode: "supervised"`。
- API 支持 `POST /api/tasks/:id/guidance`。
- `GET /api/tasks/:id` 返回 cockpit markdown、dashboard summary、events、guidance。
- UI 能从老板视角看到计划、进度、当前工作、监督摘要、状态流转，并能给 Leader 发 guidance。

## Phase 1 Status

Status: implemented and locally verified.

Implemented in this phase:

- Added `teamMode: "supervised" | "multi-role"` runtime boundary.
- Made `cc-team-run` default to supervised mode.
- Added Leader + Supervisor supervised lifecycle execution.
- Added `npm run fetch:agent-skills` and downloaded `addyosmani/agent-skills` into the local ignored runtime directory.
- Added role prompt handling so Leader receives downloaded lifecycle skill guidance as fixed SDK context, with condensed guidance as fallback.
- Added `artifacts/team-cockpit.md` and `artifacts/supervisor-report.md` maintenance.
- Added boss guidance persistence to SQLite and `leader-guidance.md`.
- Added dashboard API fields for cockpit markdown, summary, events, and guidance.
- Updated React UI into a first-pass boss cockpit.

Validation commands:

- Passed: `PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run typecheck`
- Passed: `PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run test:local`
- Passed: `PATH=/Users/rony/.nvm/versions/node/v20.19.5/bin:$PATH npm run build:web`
- Passed: `git diff --check`

Known follow-ups:

- Dogfood with a small CRUD demo to tune how much detail the cockpit should show.
- Add richer Markdown rendering if plain preformatted cockpit display becomes hard to read.
- Promote role-specific status documents in Phase 2 when multi SDK execution becomes default.

## Update Log

- 2026-05-13: Created the PRD/development record and implemented Phase 1 supervised runtime, cockpit protocol, guidance API, and boss cockpit UI.
