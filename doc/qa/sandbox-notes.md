# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-15

## Overview

`flywheel-qa-sandbox` 是从 `xrliAnnie/flywheel` 的 `main` seed 出来的 standalone QA sandbox。GitHub 不允许同一账号 fork 自己的仓库，所以它不是 GitHub fork，而是通过手动同步维持与生产仓库足够接近的独立仓库。它提供一个可安全 push、开 PR 和运行 CI 的目标，避免真实 QA 流程污染生产 `flywheel` 的分支与提交历史。

Flywheel 的 test-slot E2E 框架会用 `scripts/test-deploy.sh` 把 sandbox clone 到隔离的 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，启动 slot 专属的 test Bridge 和 test Lead，再由 `scripts/inject-linear-issue.sh` 通过 `POST /api/runs/start` 注入真实 Linear issue。每个 slot 都运行真实 Runner，而不是 synthetic 模式；Runner 产生的 worktree、branch、commit 和 PR 都留在 sandbox 范围内。

FLY-202 本身是这条链路的稳定 fixture：它替代文档里并不存在的 `FLY-SBX-1`，为 PreHydrator 提供一个真实可见、步骤小而稳定的 Linear issue，从而验证 onboard、文档编辑、commit、PR、review、CI 和 ship 等完整阶段。它仅供 test-slot real-Runner E2E 使用，生产 Lead 或 Runner 不应认领。

## Top-Level Directories

| Directory | Description |
|-----------|-------------|
| `.claude/` | Claude Code commands、orchestrator 脚本与项目侧运行配置。 |
| `.flywheel/` | Flywheel 项目配置、agent 定义与 label-based routing 规则。 |
| `.github/` | GitHub Actions CI、payload release 与 comment-triggered ship workflows。 |
| `.lead/` | 各类 Flywheel Lead 的 identity 定义。 |
| `.serena/` | Serena 的项目索引与配置。 |
| `agents/` | 随仓库发布的 generic executor 与 QA runner prompts。 |
| `doc/` | Architecture、engineering、QA、reference、retro 等主文档树与版本信息。 |
| `docs/` | Contributor/operations runbooks 与 Superpowers plan/progress ledgers。 |
| `engineering/` | Issue-scoped engineering design、evidence 与 spike artifacts。 |
| `fleet/` | Fleet deployment 说明、示例环境与 manifest。 |
| `packages/` | pnpm monorepo packages，包括 runner、Bridge、comm 与 `qa-framework`。 |
| `patches/` | 由 pnpm 管理的第三方 dependency patches。 |
| `product/` | Issue-scoped product exploration、research、plan 与 review artifacts。 |
| `qa-fly294/` | FLY-294 的 QA harness、分层测试与报告。 |
| `qa-fly310/` | FLY-310 的 Discord E2E harness、脚本与报告。 |
| `scripts/` | Development、operations、release 与 QA/E2E automation。 |
| `supabase/` | Supabase 临时配置与数据库 migrations。 |

## packages/qa-framework/README.md Summary

- `flywheel-qa-framework` 是从 GeoForge3D QA Agent v2（GEO-308）提取的可复用、plan-aware QA Agent 框架，向不同项目提供通用 5-step 测试协议。
- 架构分两层：Layer 1 是框架自身的 agents、skills、orchestrator 和 TypeScript config loader；Layer 2 是项目提供的 `.claude/qa-config.yaml` 与项目专属 test suite 配置。
- Quick Start 是复制 `templates/qa-config.yaml`、填写 domains/API/test skills、创建 test suite 配置，然后让 QA agent 读取配置执行协议。
- 5-Step Protocol 依次为 Onboard、Analyze + Plan、Research、Write + Execute、Finalize，最后会更新 skill、跑 regression 并生成报告。
- 完整 config schema 在 `templates/qa-config.yaml`；`QaConfig` TypeScript 类型可从 package import，`examples/geoforge3d/` 提供完整示例。
- Test Slot Framework（FLY-96 + FLY-115）在并行隔离 slot 中对 `xrliAnnie/flywheel-qa-sandbox` 运行 real Runner E2E，不支持 synthetic/fixture execution mode。
- 三个核心脚本分别是 `scripts/test-deploy.sh`（clone + 启动 test Bridge/Lead）、`scripts/inject-linear-issue.sh`（调用 `/api/runs/start` spawn Runner）和 `scripts/test-teardown.sh`（清理进程、worktree、slot 与 CommDB）。
- 运行前需要 `LINEAR_API_KEY`、已认证且可 push sandbox 的 `gh`、存在的 sandbox repo 与已推送的被测分支；test Bridge 用 `FLYWHEEL_RUNNER_START_POINT` 固定 Runner 起点，生产默认行为不变。
- README 还记录 FLY-60 manual hard-gate suite，以及 mirror、roundtable 和 alert 等隔离测试模式；这些模式分别覆盖共享频道、Lead 协作和 alert 双写路径，同时明确各自的 Runner E2E 边界。
- 跨 worktree 获取 plan 的合同见 `packages/qa-framework/contracts/PLAN_SOURCE_CONTRACT.md`，QA test skill 接口合同见 `packages/qa-framework/skills/SKILL_INTERFACE.md`。

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
