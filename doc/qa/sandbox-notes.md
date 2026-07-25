# `flywheel-qa-sandbox` Notes

**Issue:** FLY-202
**Date:** 2026-07-25

## Purpose

`flywheel-qa-sandbox` 是 Flywheel test-slot 框架运行 real-Runner E2E 的隔离目标仓库。测试把待验证的 Flywheel 代码同步到这个 sandbox，让真实 Runner 在其中创建 branch、commit 和 PR，运行 CI 并走完审批与交付路径；这些副作用都留在沙箱边界内，不会把测试历史或资源写进生产仓库。

slot harness 通过 `scripts/test-deploy.sh` 建立隔离的 sandbox clone、test Bridge 和 test Lead，再由 `scripts/inject-linear-issue.sh` 调用 `POST /api/runs/start` 注入真实 Linear issue。Bridge 的 PreHydrator 校验 issue 后在独立 worktree 中启动 Runner；测试结束时，`scripts/test-teardown.sh` 清理 Runner、Lead、Bridge、worktree、临时目录和 slot-local CommDB。整个路径使用真实 Runner，不提供 synthetic execution mode。

FLY-202 是供这条链路重复使用的、PreHydrator 可见的 Linear fixture。它给 sandbox Runner 一个小而稳定的多步骤文档任务，从而让 QA 有足够的 mid-work window 观察 onboard、brainstorm、实现、review、PR 和 ship 状态；生产 Lead 和 Runner 不应认领这个 issue，所有工作也必须留在 sandbox clone 内。

## Top-Level Directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude Code 项目命令、QA 配置、skills 与旧 orchestrator 工具。 |
| `.flywheel/` | Flywheel 项目配置与 Runner agent 声明。 |
| `.github/` | GitHub Actions 的 CI、发布与自动化 workflows。 |
| `.lead/` | 各类 Flywheel Lead 的 identity 文件与共享行为规则。 |
| `.serena/` | Serena MCP 的项目索引配置与忽略规则。 |
| `agents/` | 随仓库交付的 generic 与 QA executor 提示词。 |
| `doc/` | 架构、工程、QA、reference、retro 与版本等主文档树。 |
| `docs/` | 贡献指南、运行手册和 operations runbooks。 |
| `engineering/` | 按 Linear issue 组织的工程设计、实现证据与 spike 资料。 |
| `fleet/` | 去密的 Flywheel fleet 示例、manifest、projects 配置与迁移输入。 |
| `packages/` | Flywheel pnpm monorepo 的 Runner、Bridge、Comm、QA framework 等 TypeScript packages。 |
| `patches/` | 由 pnpm 应用的第三方依赖补丁。 |
| `product/` | 按 Linear issue 组织的产品研究、需求与体验设计文档。 |
| `qa-fly294/` | FLY-294 chat-thread auto-archive QA 的脚本、fixture 与报告。 |
| `qa-fly310/` | FLY-310 read-exfil hardening 的对抗脚本、证据与报告。 |
| `scripts/` | 开发、部署、运维、发布和 QA/test-slot 自动化脚本及其测试。 |
| `supabase/` | Supabase 本地元数据和数据库 migrations。 |

## packages/qa-framework/README.md Summary

- `flywheel-qa-framework` 是从 GeoForge3D QA Agent v2 抽取的可复用、plan-aware QA Agent 框架；框架层提供 agents、skills、orchestrator 和 TypeScript config loader，项目层提供 `.claude/qa-config.yaml` 与项目 test suite。
- Quick Start 是复制配置模板、填写 domains/API/test skills、创建 test suite，再依次执行 Onboard、Analyze + Plan、Research、Write + Execute、Finalize 五步协议。
- FLY-96 + FLY-115 test-slot framework 会针对 `xrliAnnie/flywheel-qa-sandbox` 启动并行隔离的 real Runner；`test-deploy.sh`、`inject-linear-issue.sh`、`test-teardown.sh` 分别负责部署、注入与清理，且不支持 synthetic mode。
- real-Runner E2E 需要 `LINEAR_API_KEY`、对 sandbox 有 push 权限的 `gh` 登录状态和已推送的被测分支；test Bridge 通过 `FLYWHEEL_RUNNER_START_POINT` 选择 Runner worktree 起点，生产默认行为不变。
- FLY-60 manual-trigger suite 用 1 个 happy path 和 6 个 variants 验证 G1/G2/G3 hard gates，并区分 StateStore、CommDB、alert queue 等证据来源；指定 Discord 步骤需要 Chrome MCP。
- FLY-153 Mirror Mode 让 slots 1–3 共享隔离的 `#test-core-mirror` 来验证多 Lead shared-channel 行为，同时默认拒绝在该拓扑运行 Runner E2E。
- FLY-529 Roundtable Mirror 提供单一 auto-thread host 和独立状态表，Alert Mirror 则隔离 Bridge 与 shell 两条 alert writer 路径，避免测试告警进入生产 queue。
- 完整 config schema 在 `templates/qa-config.yaml`，消费者可导入 `QaConfig` TypeScript 类型，`examples/geoforge3d/` 提供完整项目配置示例。
- FLY-60 的 happy path 使用生产 `flywheel-comm respond` approve wire；StateStore 与 CommDB 是两个不同数据库，alert evidence 则来自 slot-local claims DB 与 filesystem queue。
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
