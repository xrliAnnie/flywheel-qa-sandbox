# QA Sandbox Notes — `flywheel-qa-sandbox`

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-20

## Purpose

`flywheel-qa-sandbox` 是从 Flywheel 主仓库 seed 出来的独立 QA 仓库，专门承接 test-slot 的 real-Runner E2E 副作用。GitHub 不允许同一账号 fork 自己的仓库，因此它不是 GitHub fork，而是通过手动同步保持接近生产 `main`；Runner 创建的 branch、commit 和 PR 都留在这里，不会污染生产仓库历史或触发生产交付流程。

QA slot harness 会用 `scripts/test-deploy.sh` 把该仓库 clone 到 `/tmp/flywheel-test-slot-<N>/project-slot-<N>`，启动隔离的 test Bridge 与 test Lead，再由 `scripts/inject-linear-issue.sh` 调用 `POST /api/runs/start`。Bridge 会通过 PreHydrator 校验真实 Linear issue，并在独立 worktree 中启动真实 Runner，完整覆盖 onboard、实现、PR、review gate 和 ship 等路径；框架不提供 synthetic 或 fixture Runner 模式。

FLY-202 本身就是这条链路的稳定输入：FLY-197 曾发现文档引用的 `FLY-SBX-1` 在当时并不存在，FLY-202 因此补上了 slot harness 真实派发所需的 fixture issue，让 sandbox Runner 获得一个小而多步、容易观察中间进度的任务。注意它并不取代 `FLY-SBX-1` —— FLY-60 hard-gate suite 的 driver 至今仍以 `FLY-SBX-1` 作为自己的 preflight fixture 引用，两者服务于不同 suite。本 issue 只供 test-slot harness 使用，生产 Lead 和 Runner 不应认领。

## Top-Level Directories

| Directory | Description |
|---|---|
| `.claude/` | Claude Code 项目命令、QA 配置、skills 与旧 orchestrator 工具。 |
| `.flywheel/` | Flywheel 项目配置和按标签路由的 Runner agent 定义。 |
| `.github/` | GitHub Actions 的 CI、release、promotion 与 comment-triggered ship workflows。 |
| `.lead/` | 各类 Lead agent 的项目级 identity manifests。 |
| `.serena/` | Serena MCP 的项目索引配置与忽略规则。 |
| `agents/` | 随仓库交付的 generic executor 与 QA executor 角色提示。 |
| `doc/` | 架构、工程、QA、reference、retro 与版本等主文档树。 |
| `docs/` | 贡献指南、运行手册和运维 runbooks。 |
| `engineering/` | 按 Linear issue 组织的工程设计、实现证据与 spike 资料。 |
| `fleet/` | 零密钥的 fleet topology 示例、manifest 和迁移输入。 |
| `packages/` | pnpm monorepo 的 TypeScript packages，包括 Runner、Bridge、Comm 与 QA framework。 |
| `patches/` | 由 pnpm 应用的第三方依赖补丁。 |
| `product/` | 按 Linear issue 组织的产品研究、需求与体验设计文档。 |
| `qa-fly294/` | FLY-294 chat-thread auto-archive 可靠性 E2E 的脚本与报告。 |
| `qa-fly310/` | FLY-310 read-exfil hardening 独立对抗验证的脚本、证据与报告。 |
| `scripts/` | 部署、运维、测试、slot harness 与各类自动化脚本。 |
| `supabase/` | Supabase 本地元数据和数据库 migrations。 |

## `packages/qa-framework/README.md` Summary

- `flywheel-qa-framework` 是从 GeoForge3D QA Agent v2 抽取的可复用、plan-aware QA Agent 框架。
- 它采用两层结构：框架层提供 agents、skills、orchestrator 与 TypeScript config loader，项目层提供 `.claude/qa-config.yaml` 和项目测试套件。
- Quick Start 是复制模板配置、填写 domains/API/test skills、创建 test suite，然后由 QA agent 按配置执行。
- 核心流程分为五步：Onboard、Analyze + Plan、Research、Write + Execute、Finalize。
- 完整 config schema 在 `packages/qa-framework/templates/qa-config.yaml`，`QaConfig` 提供 TypeScript 类型，`packages/qa-framework/examples/geoforge3d/` 提供完整示例。
- Test Slot Framework（FLY-96 + FLY-115）会并行启动隔离环境，并对 `xrliAnnie/flywheel-qa-sandbox` 运行真实 Runner；不支持 synthetic 或 fixture mode。
- 三个生命周期脚本分别负责部署 slot、注入真实 Linear issue，以及清理 Runner/Lead/Bridge/worktree/CommDB。
- 运行前需要 `LINEAR_API_KEY`、可向 sandbox push 的 `gh` 登录状态和可用目标分支；`FLYWHEEL_RUNNER_START_POINT` 只由 test Bridge 设置，生产默认行为不变。
- FLY-60 Hard Gate Enforcement E2E 复用 slot 框架，以 1 happy path + 6 variants 的手动触发 suite 端到端验证 G1/G2/G3 硬门，并回归 sprint v26 trust gates。
- Mirror（FLY-153）、Roundtable Mirror 与 Alert Mirror（均 FLY-529）为共享频道、圆桌和告警路径提供隔离测试拓扑，并明确限制不适用的 Runner E2E 场景。
- 框架用 `packages/qa-framework/contracts/PLAN_SOURCE_CONTRACT.md` 约束跨 worktree 的 plan 获取，用 `packages/qa-framework/skills/SKILL_INTERFACE.md` 约束 QA test skill 接口，并链接 real-Runner 与 sandbox lifecycle guides。

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
