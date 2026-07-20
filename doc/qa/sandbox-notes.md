# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-20

## Overview

`flywheel-qa-sandbox` 是从 `xrliAnnie/flywheel` main seed 出来的 **standalone QA sandbox 仓库**（GitHub 不允许同账号 fork 自己的仓库，所以它不是真正的 fork，而是靠手动同步保持与生产 main 一致，见 `doc/qa/framework/sandbox-sync-guide.md`），作为 Flywheel test-slot E2E 框架（FLY-96 + FLY-115）的目标仓库。`scripts/test-deploy.sh` 会把这个仓库 clone 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，每个 slot 启动一个 test Bridge + test Lead，再通过 `scripts/inject-linear-issue.sh`（POST `/api/runs/start`）注入真实 Linear issue 来 spawn 一个 real Runner。Runner 产生的分支、commit、PR 全部落在这个 sandbox 上，与生产仓库完全隔离。

之所以需要独立 sandbox，是因为 slot 框架不支持 synthetic / fixture 模式——每个 slot 都是 real Runner 端到端跑完整 pipeline（onboard → implement → PR → CI → merge）。如果直接用生产 flywheel 仓库，QA 跑出的测试分支、PR 和 merge commit 会污染生产历史；独立的 sandbox 仓库让 QA 流程可以反复执行、随时重置（参见 `doc/qa/framework/sandbox-sync-guide.md`）。

本文件本身就是一个 QA fixture 的产物：FLY-202 提供了一个真实的、PreHydrator 可见的 Linear issue，供 E2E 测试给 sandbox Runner 派发一个小而稳定的多步骤任务（FLY-197 发现文档中引用的 `FLY-SBX-1` 并不存在，FLY-202 填补了这个空缺）。该 issue 仅供 test-slot 使用，生产 Lead / Runner 不应认领。本次 re-run（2026-07-20）从零重建本文件：上一版（PR #29/#30）在 FLY-1286 的生产全量同步 commit（PR #58）中被移除，目录表与 README 摘要均按同步后的当前仓库状态刷新。

## Top-Level Directories

| Directory | Description |
|-----------|-------------|
| `.claude/` | Claude Code 项目配置：commands、skills、`qa-config.yaml` |
| `.flywheel/` | Flywheel per-project 配置：`config.yaml` + `agents/`（部门 executor role prompts）+ run 状态 |
| `.github/` | GitHub Actions workflows（ci / payload-beta-release / payload-promote） |
| `.lead/` | per-Lead identity 文件（cos / eng / product / infra-bot / interviewer 等 Lead 的 `identity.md`） |
| `.serena/` | Serena MCP 的项目索引与配置 |
| `agents/` | 仓库级 executor prompt fixtures（`generic-executor.md`、`qa-executor.md`） |
| `doc/` | 主文档树：architecture / engineer / plan / qa / reference / retro + `VERSION` |
| `docs/` | 贡献者与运维文档（`CONTRIB.md`、`RUNBOOK.md`、operations、superpowers） |
| `engineering/` | 部门优先 doc-flow 工作区（FLY-205）：engineering 部门的 doc + spike |
| `fleet/` | Fleet 配置（FLY-247）：`README.md` + example 配置样例 |
| `packages/` | pnpm monorepo 包：claude-runner、core、edge-worker、flywheel-comm、qa-framework、teamlead、voice-* 等 |
| `patches/` | pnpm 依赖补丁（`mem0ai@2.3.0.patch`） |
| `product/` | 部门优先 doc-flow 工作区：product 部门的 doc |
| `qa-fly294/` | FLY-294 QA run 残留：报告 + chat-thread / fake-discord 分层测试脚本 |
| `qa-fly310/` | FLY-310 QA run 残留：报告 + Discord E2E setup/teardown/对抗脚本 |
| `scripts/` | 运维与 QA/E2E 脚本（test-deploy、inject-linear-issue、test-teardown、daily-standup 等） |
| `supabase/` | Supabase 配置与数据库 migrations |

## packages/qa-framework/README.md Summary

- `flywheel-qa-framework` 是可复用的 QA Agent 框架，提供 plan-aware 测试 pipeline；从 GeoForge3D 的 QA Agent v2（GEO-308）提取，定义通用 5-step QA protocol，任何项目通过项目侧配置接入。
- 两层架构：Layer 1 是框架本身（agents / skills / orchestrator / TypeScript config loader），Layer 2 是项目侧 `.claude/qa-config.yaml`，经 `config-bridge.sh` 桥接消费。
- Quick Start：复制 `templates/qa-config.yaml` 到项目 → 填写 domains / API 配置 / test skills → 创建 test suite 配置 → QA agent 读取配置运行协议；config schema 见模板注释，TypeScript 类型 `import { QaConfig } from 'flywheel-qa-framework'`，完整示例在 `packages/qa-framework/examples/geoforge3d/`。
- 5-Step Protocol：Onboard → Analyze + Plan → Research → Write + Execute → Finalize。
- Test Slot Framework（FLY-96 + FLY-115）：并行隔离的 test slot，每个 slot 对 `xrliAnnie/flywheel-qa-sandbox` 跑 **real Runner** E2E，不支持 synthetic / fixture 模式。
- 三个核心脚本：`scripts/test-deploy.sh`（clone sandbox 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，启动 test Bridge + test Lead）、`scripts/inject-linear-issue.sh`（POST `/api/runs/start` spawn real Runner）、`scripts/test-teardown.sh`（清理 tmux / Lead / Bridge / worktree / slot 目录 / CommDB）。
- 前置条件：`LINEAR_API_KEY`、`gh` CLI 对 sandbox 有 push 权限、sandbox 仓库存在、被测分支已推到 sandbox——缺任一项 `test-deploy.sh` pre-flight 直接 exit 2；Runner worktree 起点由 `FLYWHEEL_RUNNER_START_POINT` env 控制（仅 test Bridge 设置，生产 launcher 不设，默认 `origin/main` 不变）。
- FLY-60 Hard Gate Enforcement E2E：1 happy path + 6 variants 的手动触发 suite，端到端验证 G1/G2/G3 硬门并回归 sprint v26 trust gates（FLY-108/109/99/83）；driver 为 `scripts/qa-fly-60-driver.sh`，需要 Chrome MCP 的人工步骤以 `MANUAL_PENDING` gate 标出。
- Mirror Mode（FLY-153）：slots 1-3 共享一个 `#test-core-mirror` 频道，测多 Lead shared-channel 场景（如 FLY-152 reply discipline）；Runner E2E 不在 mirror 模式下跑，`inject-linear-issue.sh --allow-mirror` 是唯一逃生口。
- Roundtable Mirror（FLY-529）：`--mode roundtable` 起隔离的 `#test-leads-roundtable`，单一 hostSlot 跑 auto-thread manager（避免多 Bridge 重复建 thread），为 FLY-314 等 restart-gated roundtable 功能提供 pre-ship E2E。
- Alert Mirror（FLY-529）：`--alerts` 把两条告警写路径（Bridge `LeadAlertNotifier` + shell `scripts/lead-alert.sh`）全部隔离到 `#test-flywheel-alerts`；不加 `--alerts` 时所有 override 不设，与生产 byte-compat（有 reverse-compat 测试）。
- Contracts：`packages/qa-framework/contracts/PLAN_SOURCE_CONTRACT.md`（QA agent 跨 worktree 获取 plan 文件）与 `packages/qa-framework/skills/SKILL_INTERFACE.md`（所有 QA test skill 的接口契约）。

## `ls -R doc/ | head -50` Output

```
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
