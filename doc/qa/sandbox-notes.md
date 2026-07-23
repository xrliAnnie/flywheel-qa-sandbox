# flywheel-qa-sandbox Notes

**Issue:** FLY-202
**Date:** 2026-07-23

`flywheel-qa-sandbox` 是 Flywheel test-slot 框架运行 real-Runner E2E 的隔离目标仓库。测试从 Flywheel 主仓库的代码快照部署这个 sandbox，让真实 Runner 完成 onboarding、修改文件、提交分支、创建 PR、等待 CI 与审批等完整流程，同时避免把测试分支和 merge commit 写进生产仓库。

slot harness 通过 `scripts/test-deploy.sh` 建立隔离的 Bridge、Lead 和 sandbox clone，再由 `scripts/inject-linear-issue.sh` 调用 `POST /api/runs/start` 注入真实 Linear issue；测试完成后，`scripts/test-teardown.sh` 清理 slot 进程、worktree、临时目录和 CommDB。整个路径使用真实 Runner，不提供 synthetic 或 fixture 执行模式，但所有写入都限制在 sandbox 资源内。

FLY-202 是供这条链路重复使用的、PreHydrator 可见的 Linear fixture。它给 sandbox Runner 一个小而稳定的多步骤文档任务，从而让 QA 在执行中途观察 Runner 状态，并验证从 issue 注入到 PR 落地的完整生命周期；生产 Lead 和 Runner 不应认领这个 issue。

## Top-Level Directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude 项目命令、orchestrator 脚本、QA 配置与项目技能。 |
| `.flywheel/` | sandbox 的 Flywheel runner 配置与通用 executor 声明。 |
| `.github/` | GitHub Actions workflow 与仓库自动化配置。 |
| `.lead/` | 各 Flywheel Lead 的 identity 文件和共享行为规则。 |
| `.serena/` | Serena MCP 的项目索引与配置。 |
| `agents/` | 通用 executor 与 QA executor 的角色提示词。 |
| `doc/` | 架构、工程、计划、QA、参考资料和复盘等主文档树。 |
| `docs/` | 贡献指南、运行手册与运维文档。 |
| `engineering/` | 按 issue 组织的工程文档和技术 spike。 |
| `fleet/` | 去密后的 Flywheel fleet 拓扑快照、示例和迁移输入。 |
| `packages/` | Flywheel TypeScript monorepo 的核心 package 与服务。 |
| `patches/` | pnpm 管理的第三方依赖补丁。 |
| `product/` | 产品侧的 issue 文档与设计资料。 |
| `qa-fly294/` | FLY-294 的 QA 报告、fixture 与分层测试脚本。 |
| `qa-fly310/` | FLY-310 的 QA 报告、Discord E2E 脚本与验证证据。 |
| `scripts/` | 开发、部署、运维、发布和 QA/E2E 自动化脚本及其测试。 |
| `supabase/` | Supabase 数据库 migration 与本地 CLI 状态目录。 |

## `packages/qa-framework/README.md` Summary

- `flywheel-qa-framework` 是可复用、plan-aware 的 QA Agent 框架；它把通用 agents、skills、orchestrator 和 TypeScript config loader 与项目侧 `.claude/qa-config.yaml` 分成两层。
- Quick Start 要求复制配置模板、填写 domain/API/test skill、创建 test suite；运行协议依次为 Onboard、Analyze + Plan、Research、Write + Execute、Finalize。
- 配置 schema 由 `templates/qa-config.yaml` 说明，消费者可导入 `QaConfig` 类型，`examples/geoforge3d/` 提供完整项目示例。
- FLY-115 test-slot framework 对 `xrliAnnie/flywheel-qa-sandbox` 启动并行隔离的 real Runner；`test-deploy.sh`、`inject-linear-issue.sh` 和 `test-teardown.sh` 覆盖部署、注入与清理，不支持 synthetic 模式。
- real-Runner E2E 依赖 `LINEAR_API_KEY`、可写 sandbox 的 `gh` 认证和已推送的被测分支；test Bridge 可用 `FLYWHEEL_RUNNER_START_POINT` 选择 worktree 起点，README 另列 real-runner 与 sandbox-sync 指南。
- FLY-60 manual-trigger suite 用一个 happy path 加六个 variants 验证 hard gates，保存 StateStore、CommDB、alert queue 等证据，并在指定步骤使用 Chrome MCP 完成 Discord 交互。
- FLY-153 Mirror Mode 让 slots 1–3 共用隔离的 `#test-core-mirror` 来测试多 Lead shared-channel 行为，同时明确禁止默认在该模式运行 Runner E2E。
- FLY-529 Roundtable Mirror 建立隔离的 roundtable channel、单一 auto-thread host 和专用状态表，用于 merge 前验证 thread 与 membership 行为。
- FLY-529 Alert Mirror 把 Bridge 与 shell 两条 alert writer 路径都重定向到隔离目录和测试频道，避免测试告警进入生产 queue。
- `contracts/PLAN_SOURCE_CONTRACT.md` 规定 QA agent 跨 worktree 获取 plan 的方式，`skills/SKILL_INTERFACE.md` 规定所有 QA test skill 的接口。

## `ls -R doc/ | head -50` Output

```text
VERSION
architecture
engineer
plan
qa
reference
retro

doc/architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
infra-alerts-spec.md
product-experience-spec.md
v0.2-architecture.md
v2.0-product-vision.md

doc/architecture/archive:
v0.1.0-flywheel-orchestrator.md

doc/engineer:
deep-research
exploration
implementation
onboarding
plan
qa
research

doc/engineer/deep-research:
001-decision-layer-gemini.md
002-decision-layer-chatgpt.md
003-stripe-minions-part1.md
004-stripe-minions-part2.md
005-cloudflare-code-mode.md
006-boris-cherny-claude-code-future.md
007-parallel-ai-agents-pkarnal.md
008-agent-orchestrator-ao.md
009-ramp-inspect-background-agent.md
010-ai-agent-frameworks-2026.md
010-gastown-steve-yegge.md
claude-code-terminal-pane-management.md
multi-agent-architecture-best-practices.md

doc/engineer/exploration:
archive
backlog
new
```
