# Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-06-04

## What this repo is for

`flywheel-qa-sandbox` 是 Flywheel 主仓库（`xrliAnnie/flywheel`）的一个专用 fork，唯一用途是为 QA Test Slot Framework（FLY-96 + FLY-115）提供一个**安全的真实 Runner E2E 演练场**。每个 test slot 会把本仓库 clone 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，然后启动一个测试 Bridge 和测试 Lead，再通过 `scripts/inject-linear-issue.sh`（即 `POST /api/runs/start`）注入一个真实的 Linear issue，spawn 出一个真实的 Claude Code Runner 对着这个 sandbox 工作。

之所以需要独立的 sandbox fork，是因为 E2E 测试中的 Runner 是「真的」—— 它会建 branch、提交 commit、推送到 remote、开 PR、甚至 merge。这些副作用如果发生在生产仓库上会污染主线历史、触发生产 CI/CD、并与真实开发工作冲突。把所有副作用隔离在 fork 里，QA 流水线就可以反复全链路演练（onboard → implement → PR → review gate → ship）而不产生任何生产风险。仓库里散落的 `qa-probe.txt`、`qa-verify.txt` 等文件就是历次演练留下的痕迹。

本文件本身也是一个 QA fixture：FLY-202 之所以存在，是因为 `inject-linear-issue.sh` 需要一个真实存在、PreHydrator 可见的 Linear issue 来 spawn sandbox Runner（FLY-197 指出文档里引用的 `FLY-SBX-1` 并不存在）。这个任务被刻意设计成小而多步（写文档 → 加表格 → 总结 README → 嵌入命令输出 → 开 PR），从而给 QA harness 一个可观测的「工作中途窗口」。

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `doc/` | 主文档树：architecture、engineer（exploration/research/plan）、qa、reference、retro 及 `VERSION` |
| `docs/` | 轻量运维文档：`CONTRIB.md` 与 `RUNBOOK.md` |
| `packages/` | pnpm monorepo 的 TypeScript 包（claude-runner、core、edge-worker、flywheel-comm、qa-framework 等） |
| `patches/` | pnpm 依赖补丁（当前仅 `mem0ai@2.3.0.patch`） |
| `scripts/` | 运维与 E2E 脚本：test slot 部署/注入/清理、daily standup、session cleanup 等 |
| `supabase/` | Supabase 资产（`migrations/` 数据库迁移） |

## Summary of `packages/qa-framework/README.md`

- `flywheel-qa-framework` 是可复用的 QA Agent 框架，提供 plan-aware 的测试流水线，从 GeoForge3D 的 QA Agent v2（GEO-308）抽取而来。
- 双层架构：Layer 1 是框架本身（agents、skills、orchestrator、TypeScript config loader），Layer 2 是各项目的 `.claude/qa-config.yaml` 等项目侧配置，通过 `config-bridge.sh` 桥接。
- Quick Start：复制 `templates/qa-config.yaml` 到项目、填入 domains/API/test skills、创建 test suite 配置，QA agent 即按配置执行。
- 核心是 5-Step Protocol：① Onboard（加载配置、获取 plan、校验环境）② Analyze + Plan（提取验收标准、生成 test spec）③ Research（读 OpenAPI/领域文档/既有测试）④ Write + Execute（写 ad hoc 测试并迭代到全绿）⑤ Finalize（更新 skill 文件、回归、出报告）。
- 配置 schema 见 `templates/qa-config.yaml`，TypeScript 类型经 `import { QaConfig } from 'flywheel-qa-framework'` 暴露。
- Test Slot Framework（FLY-96 + FLY-115）支持并行隔离的 slot 环境，每个 slot 跑**真实 Runner** 对接 `xrliAnnie/flywheel-qa-sandbox`，不支持任何 synthetic/fixture 模式。
- 三个关键脚本：`test-deploy.sh`（clone sandbox 到 slot 目录并启动测试 Bridge/Lead）、`inject-linear-issue.sh`（直接 POST `/api/runs/start` spawn Runner）、`test-teardown.sh`（杀进程、清 worktree/branch、删 SLOT_DIR 与 CommDB）。
- 前置条件：shell 导出 `LINEAR_API_KEY`、`gh` CLI 对 sandbox fork 有 push 权限、fork 已存在、被测分支已推送到 sandbox；`test-deploy.sh` 在 pre-flight 缺任一项即 exit 2 快速失败。
- Runner worktree 起点由 `FLYWHEEL_RUNNER_START_POINT` 环境变量控制（FLY-95 的 `WorktreeManager.create()` fallback），仅测试 Bridge 设置该变量，生产行为保持 `origin/main` 不变。
- 配套文档与契约：`doc/qa/framework/real-runner-e2e-guide.md`（端到端演练）、`sandbox-sync-guide.md`（fork 生命周期）、`contracts/PLAN_SOURCE_CONTRACT.md`（plan 文件获取契约）、`skills/SKILL_INTERFACE.md`（测试 skill 接口契约）。

## `ls -R doc/ | head -50` output

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
