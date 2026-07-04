# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-03
**基于**: `packages/qa-framework/README.md` + repo 现场勘查(exec dfb48176 sandbox Runner 产出)

## What this repo is for

`xrliAnnie/flywheel-qa-sandbox` 是生产 Flywheel 主仓的 **QA 沙箱 fork**。它以 squash-snapshot 的形式从主仓同步(见 git log:`chore(FLY-836 QA): squash-snapshot ... for sandbox push`),作为 test-slot 框架跑 **real-Runner E2E** 时的目标仓库存在:每个 test slot 会把本仓 clone 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`,在里面 spawn 一个真实的 Runner,让它走完整的 onboard → brainstorm → implement → PR 生命周期。

之所以需要一个独立沙箱,是因为 slot 框架(FLY-96 + FLY-115)**不支持任何 synthetic / fixture 模式** —— 每个 slot 跑的都是真 Runner,需要真实的 repo 可以建分支、commit、开 PR,也需要一个 PreHydrator 可见的真实 Linear issue(FLY-202 本身就是为此而设的 fixture issue)。所有副作用 —— Runner 分支、E2E 产生的 PR、CI 运行 —— 全部落在本沙箱仓库,生产 Flywheel 仓库零污染。

边界与生命周期:Runner 分支名从 slot 目录 basename 派生(`project-slot-<N>-<ISSUE>`,slot 后缀避免多 slot 跑同一 issue 时在 remote 撞名);多次 E2E run 会在本仓累积分支和 PR,属预期现象。沙箱与主仓的同步流程见 `doc/qa/framework/sandbox-sync-guide.md`,端到端使用指南见 `doc/qa/framework/real-runner-e2e-guide.md`。**生产 Lead / Runner 不得认领 FLY-202** —— 它只服务于 QA harness。

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `agents/` | Runner agent 提示词(`generic-executor.md` fallback + `qa-executor.md`) |
| `doc/` | 主文档树:architecture spec、engineer 流水线文档(exploration/research/plan)、qa 报告与框架指南、reference、retro |
| `docs/` | 运维侧文档(`CONTRIB.md`、`RUNBOOK.md`、`operations/`) |
| `engineering/` | doc-flow 部门优先布局(FLY-205)的 engineering 部门文档区(`engineering/doc/<ISSUE>-<slug>/`) |
| `fleet/` | Lead fleet 配置(FLY-247):README + `example/`(env.example、manifest.json、projects.json) |
| `packages/` | pnpm monorepo 包:core、teamlead、edge-worker、flywheel-comm、qa-framework、claude-runner、dag-resolver、各 event-transport、inbox-mcp、terminal-mcp、token-usage 等 |
| `patches/` | pnpm 依赖补丁(`mem0ai@2.3.0.patch`) |
| `qa-fly294/` | FLY-294 的 ad-hoc QA harness 与证据(layerA/B/C 测试脚本、QA 报告) |
| `qa-fly310/` | FLY-310 的 ad-hoc QA harness 与证据(Discord E2E setup/teardown 脚本、QA 报告) |
| `scripts/` | 运维与 QA 脚本:`test-deploy.sh`、`inject-linear-issue.sh`、`test-teardown.sh`、alert 工具链、launchd 模板等 |
| `supabase/` | Supabase `migrations/`(memory 系统 pgvector,GEO-145) |

## packages/qa-framework/README.md summary

- **定位**:可复用的 QA Agent 框架("plan-aware testing pipeline"),从 GeoForge3D 的 QA Agent v2(GEO-308)抽取,任何项目提供自己的配置即可接入。
- **两层架构**:Layer 1 = qa-framework 包本身(agent 提示词、test skill、orchestrator、TypeScript config loader);Layer 2 = 项目侧配置(`.claude/qa-config.yaml` + 项目 test-suite 文件),经 `config-bridge.sh` 消费。
- **5-Step Protocol**:Onboard → Analyze + Plan → Research → Write + Execute → Finalize(载配置/取 plan → 提取验收标准生成 test spec → 读 OpenAPI/领域文档/既有测试 → 迭代写并跑 ad-hoc 测试直到全绿 → 更新 skill 文件、回归、出报告)。
- **Test Slot 框架(FLY-96 + FLY-115)**:并行的隔离 slot,每个 slot 对着 `xrliAnnie/flywheel-qa-sandbox` 跑**真 Runner** E2E,无 synthetic 模式;核心三脚本 = `test-deploy.sh`(clone + 起 test Bridge/Lead)、`inject-linear-issue.sh`(POST `/api/runs/start` spawn Runner)、`test-teardown.sh`(清理进程、worktree、slot 目录)。
- **前置条件**(deploy 预检 fail-fast):shell 导出 `LINEAR_API_KEY`、`gh` 已认证且对 sandbox fork 有 push 权限、sandbox fork 存在、被测分支已推到 sandbox。
- **Runner 起点控制**:`FLYWHEEL_RUNNER_START_POINT` 只设在 test Bridge 进程上,让 WorktreeManager 从被测分支建 Runner worktree;生产不设,默认 `origin/main` 行为不变。
- **FLY-60 Hard Gate 套件**:1 happy path + 6 variants 验证 G1/G2/G3 硬门,`qa-fly-60-driver.sh` 全程编排(deploy → 跑场景 → 收证据 → HTML 报告 → teardown),需 Chrome MCP 处理 `MANUAL_PENDING` 人工步骤;关键 wire facts:approve 走生产 `flywheel-comm respond` 路径(Bridge `approveExecution` 会死锁)、StateStore 与 CommDB 是两个不同的库。
- **Mirror 模式(FLY-153)**:slots 1-3 共享一个 `#test-core-mirror` 频道模拟生产多 Lead 同频道场景(reply discipline 类测试);Runner E2E 在 mirror 模式下明确 out of scope,`inject-linear-issue.sh` 默认拒绝 mirror slot。
- **Roundtable / Alert 镜像(FLY-529)**:`--mode roundtable` 提供隔离的 `#test-leads-roundtable`(单 host 跑 auto-thread manager);`--alerts` 把 Bridge 与 shell 两条 alert 写路径全部隔离到 `#test-flywheel-alerts` + slot-local queue/claims 目录;两者均字节兼容 —— 不加参数时生产路径逐字不变。
- **契约文档**:`contracts/PLAN_SOURCE_CONTRACT.md`(QA agent 跨 worktree 获取 plan 文件的方式)与 `skills/SKILL_INTERFACE.md`(所有 QA test skill 的接口契约)。

## `ls -R doc/ | head -50` output

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
