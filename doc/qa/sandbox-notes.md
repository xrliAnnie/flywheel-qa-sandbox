# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-06-04

## Overview

`flywheel-qa-sandbox` 是从 `xrliAnnie/flywheel` main seed 出来的 **standalone QA sandbox 仓库**（GitHub 不允许同账号 fork 自己的仓库，所以它不是真正的 fork，而是靠手动同步保持与生产 main 一致，见 `doc/qa/framework/sandbox-sync-guide.md` §3），作为 Flywheel test-slot E2E 框架（FLY-96 + FLY-115）的目标仓库。`scripts/test-deploy.sh` 会把这个仓库 clone 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，每个 slot 启动一个 test Bridge + test Lead，再通过 `scripts/inject-linear-issue.sh`（POST `/api/runs/start`）注入真实 Linear issue 来 spawn 一个 real Runner。Runner 产生的分支、commit、PR 全部落在这个 sandbox 上，与生产仓库完全隔离。

之所以需要独立 sandbox，是因为 slot 框架不支持 synthetic / fixture 模式——每个 slot 都是 real Runner 端到端跑完整 pipeline（onboard → implement → PR → CI → merge）。如果直接用生产 flywheel 仓库，QA 跑出的测试分支、PR 和 merge commit 会污染生产历史；独立的 sandbox 仓库让 QA 流程可以反复执行、随时重置（参见 `doc/qa/framework/sandbox-sync-guide.md`）。

本文件本身就是一个 QA fixture 的产物：FLY-202 提供了一个真实的、PreHydrator 可见的 Linear issue，供 E2E 测试给 sandbox Runner 派发一个小而稳定的多步骤任务（FLY-197 发现文档中引用的 `FLY-SBX-1` 并不存在，FLY-202 填补了这个空缺）。该 issue 仅供 test-slot 使用，生产 Lead / Runner 不应认领。

## Top-Level Directories

| Directory | Description |
|-----------|-------------|
| `.claude/` | Claude Code 项目配置：commands、skills、orchestrator、`qa-config.yaml` |
| `.github/` | GitHub Actions workflows（CI） |
| `.serena/` | Serena MCP 的项目索引与配置 |
| `doc/` | 主文档树：architecture / engineer / plan / qa / reference / retro + `VERSION` |
| `docs/` | 贡献者文档（`CONTRIB.md`、`RUNBOOK.md`） |
| `packages/` | pnpm monorepo 包：claude-runner、core、edge-worker、flywheel-comm、qa-framework、teamlead 等 |
| `patches/` | pnpm 依赖补丁（`mem0ai@2.3.0.patch`） |
| `scripts/` | 运维与 QA/E2E 脚本（test-deploy、inject-linear-issue、test-teardown、daily-standup 等） |
| `supabase/` | Supabase 配置与数据库 migrations |

## packages/qa-framework/README.md Summary

- `flywheel-qa-framework` 是可复用的 QA Agent 框架，提供 plan-aware 的测试 pipeline。
- 从 GeoForge3D 的 QA Agent v2（GEO-308）提取，定义通用 5-step QA protocol，任何项目通过项目侧配置即可接入。
- 两层架构：Layer 1 是框架本身（agents / skills / orchestrator / TypeScript config loader），Layer 2 是项目侧的 `.claude/qa-config.yaml`，经 `config-bridge.sh` 桥接消费。
- Quick Start：复制 `templates/qa-config.yaml` 到项目 → 填写 domains / API 配置 / test skills → 创建 test suite 配置 → QA agent 读取配置运行协议。
- 5-Step Protocol：Onboard → Analyze + Plan → Research → Write + Execute → Finalize。
- Config schema 见 `templates/qa-config.yaml`（带完整注释）；TypeScript 类型通过 `import { QaConfig } from 'flywheel-qa-framework'` 获得。
- `examples/geoforge3d/` 提供完整的 GeoForge3D 配置示例。
- Test Slot Framework（FLY-96 + FLY-115）：并行隔离的 test slot，每个 slot 对 `xrliAnnie/flywheel-qa-sandbox` 跑 real Runner E2E，不支持 synthetic / fixture 模式。
- 三个核心脚本：`test-deploy.sh`（clone sandbox + 启动 test Bridge/Lead）、`inject-linear-issue.sh`（直接 POST `/api/runs/start` spawn Runner）、`test-teardown.sh`（清理 tmux/Lead/Bridge、worktree、slot 目录与 CommDB）。
- 前置条件：`LINEAR_API_KEY`、`gh` CLI 对 sandbox 仓库有 push 权限、sandbox 仓库存在（README 中称 "fork"，实际为 standalone repo）、被测分支已推到 sandbox；缺任一项 `test-deploy.sh` pre-flight 直接 exit 2。
- Runner worktree 起点由 `FLYWHEEL_RUNNER_START_POINT` env 控制（仅 test Bridge 设置；生产 launcher 不设置，默认 `origin/main` 行为不变）。
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

doc//architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
product-experience-spec.md
v0.2-architecture.md
v2.0-product-vision.md

doc//architecture/archive:
v0.1.0-flywheel-orchestrator.md

doc//engineer:
deep-research
exploration
implementation
plan
research

doc//engineer/deep-research:
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

doc//engineer/exploration:
archive
backlog
new

doc//engineer/exploration/archive:
FLY-11-terminal-mcp-tool.md
```

> Reviewed note: QA-S1 revision marker 20260604-1044
