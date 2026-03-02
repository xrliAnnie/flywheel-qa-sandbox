---
version: "v0.1.0"
phase: 1
title: "Core Loop — Linear issue → Claude Code → GitHub PR"
architecture_ref: "doc/architecture/v0.1.0-flywheel-orchestrator.md"
status: codex-approved
---

# Phase 1: Core Loop

**一个 PR 交付。** 做完后 Flywheel 能接一个 GeoForge3D Linear issue，自动写代码、跑测试、创建 PR。

## Goal

```
Linear issue (GeoForge3D) → DAG 排序 → Blueprint 编排 → Claude Code CLI → GitHub PR
```

## Architecture Reference

详细设计、伪代码、接口定义见 `doc/architecture/v0.1.0-flywheel-orchestrator.md` (Phase 1 部分, Task 1-7)。

本 plan 只写 **执行顺序和验收标准**，不重复架构文档里的代码。

## Tasks

按顺序执行，每个 task 完成后跑一次 `pnpm build && pnpm test`。

### Task 1: Fork Cyrus & Setup

**做什么**: Fork Cyrus, rename `@cyrus` → `@flywheel`, 确认能 build。

**关键子任务**:
- 锁定 `IAgentRunner` 真实接口签名 (spawn CLI? Agent SDK?)
- 确认 `claude` CLI 非交互模式参数 (`--print`, `--max-turns`, `--allowedTools`)
- 确认 session resume 机制 (`claude --resume`)
- **兼容性 spike (24-48h)**: 逐包验证实际复用情况，输出复用率结论
- 输出: `doc/reference/cyrus-contract-snapshot.md` — 包含:
  - `IAgentRunner` 真实签名 vs 我们的目标契约
  - 保留/修改/移除的包清单
  - 预计复用率
  - 主要 adapter 风险

**验收**: `pnpm install && pnpm build && pnpm test` 全 pass，契约快照 + 兼容性 spike 结论写完。

**Commit**: `chore: fork Cyrus, rename to @flywheel scope + contract snapshot`

### Task 2: Clean Up + ClaudeCodeRunner Adaptation

**做什么**: 删掉不需要的 runners + 适配 `ClaudeCodeRunner` 为 CLI spawn 模式。

**2a. 清理**:
- 删除: `codex-runner/`, `cursor-runner/`, `gemini-runner/`, `simple-agent-runner/`, `cloudflare-tunnel-client/`, `f1 app`
- 保留 `IAgentRunner` 接口和 `RunnerSelectionService` — 只删实现，不简化接口

**2b. ClaudeCodeRunner 适配** (改 `packages/claude-runner/`):
- 改为 CLI spawn 模式: `execFile("claude", ["--print", "--max-turns", ...])`
- 返回契约: `{ success, costUsd, sessionId }` — 解析 `--output-format json` 的结构化输出
- 支持 `sessionId` 参数 (传 `--resume` 给 CLI) 用于 session resume
- 支持 `timeoutMs` (进程级超时, 默认 30min)
- Phase 1 仅注册 `ClaudeCodeRunner`, 接口保持 model-agnostic

**测试覆盖**:
- `RunnerSelectionService`: single runner → returns it, unknown name → throws, default fallback
- `ClaudeCodeRunner`: mock `execFile` 验证参数组装、JSON 输出解析、timeout 处理、resume 参数传递

**验收**: Build pass, `ClaudeCodeRunner.run()` 能 spawn CLI 并返回 `success/costUsd/sessionId`。

**Commit**: `chore: remove unused runners + adapt ClaudeCodeRunner to CLI spawn`

### Task 3: DAG Resolver — Core Algorithm

**做什么**: `packages/dag-resolver/` — Kahn 拓扑排序。

**测试覆盖** (TDD, 先写测试):
- 空输入
- 无依赖 (全部 ready)
- 线性链
- 钻石依赖
- 循环检测
- 未知 blocker (阻断 + warning)
- 未知 blocker 显式 resolve
- Shelve 阻断下游
- Shelve bypass 模式
- Remaining count

**验收**: 10+ 测试全 pass。

**Commit**: `feat: DAG resolver with Kahn's algorithm (topological sort)`

### Task 4: DAG Resolver — Linear Integration

**做什么**: `LinearGraphBuilder` — Linear SDK issues → `DagNode[]`。

**测试覆盖**:
- 正常转换
- 过滤 completed issues (by `state.type`, not `state.name`)
- 过滤 canceled issues
- 自定义 terminal types

**验收**: 测试 pass, 使用 `state.type` 而非 `state.name`。

**Commit**: `feat: LinearGraphBuilder — Linear issues to DAG nodes`

### Task 5: Project Config

**做什么**: `packages/config/` — `.flywheel/config.yaml` loader。

**Schema 要点**: project name, Linear team_id, runners (default + available), agent_nodes config, teams, decision_layer (autonomy_level), CI rounds (`ci.max_rounds`, default 2)。Reactions config 留接口但 Phase 1 不实现。

**Budget 口径**: Phase 1 只有 `per-issue budget` (`teams[].orchestrators[].budget_per_issue`)。Daily budget cap 属于 Phase 3 auto-loop。

**验收**: ConfigLoader 读 YAML, 验证必填字段, 返回 typed config。测试 pass。

**Commit**: `feat: project config loader (.flywheel/config.yaml)`

### Task 6: Blueprint Dispatcher

**做什么**: Blueprint 混合编排 — 确定性节点 + agent 节点。

**流程**:
```
Pre-Hydrate (确定性) → Implement (agent: spawn CLI) → Lint + Codegen (确定性) → Push + CI (确定性)
  └─ CI fail → Fix (agent) → Push + CI → CI rounds 用完则 shelve
```

**关键组件**:
- `PreHydrator`: 拉 Linear issue 详情 + 相关代码 + CLAUDE.md
- `Blueprint`: 编排执行流程, 通过 `IAgentRunner` (即 Task 2b 的 `ClaudeCodeRunner`) 调 agent
- `DagDispatcher`: 循环拿 next ready → Blueprint → markDone
- **PR creation + Linear 状态更新**: 复用 Cyrus 的 `github-event-transport` (PR creation) 和 `linear-event-transport` (issue status sync)。如 Task 1 spike 发现这些 transport 不可直接复用，则在本 task 内实现替代 wiring

**测试覆盖**:
- Blueprint happy path (mock runner)
- CI fail → fix → retry (configurable `ci.max_rounds`)
- Max retries → shelve
- Per-issue budget cap enforcement
- Pre-hydrator context assembly
- Session interrupt + resume (mock: 第一次 run 被 kill → 用返回的 sessionId resume)
- Configurable CI rounds (config 改为 3 → 验证 3 轮重试)

**验收**: Blueprint 编排完整, 测试 pass, 包含 session resume 和 CI rounds 测试。

**Commit**: `feat: Blueprint dispatcher — deterministic + agent hybrid orchestration`

### Task 7: E2E Verification

**做什么**: GeoForge3D issues 跑完全流程。Happy path 用单 issue; shelve 验证用最小 2-issue chain (A → B, shelve A, 验证 B 不会被执行)。

**验证**:
- Linear issue → Claude Code → GitHub PR (手动触发, 观察结果)
- PR 出现在 GitHub (Cyrus transport 或替代 wiring)
- Linear issue 状态更新为 Done
- DAG 正确跳过已完成 issues
- Per-issue budget cap 生效
- Shelve 阻断下游 (2-issue chain: shelve A → B stays blocked)

**验收**: PR 出现在 GitHub, Linear issue 状态更新, 截图/日志作为证据。

**Commit**: `test: end-to-end verification — single issue pipeline`

## PR 交付

一个 PR 包含 Task 1-7 的所有 commits。PR review 按 commit 分段:
- **Segment 1** (Task 1-2): Fork/rename/cleanup — 大量机械性改动, 重点看 `ClaudeCodeRunner` 适配和契约测试
- **Segment 2** (Task 3-5): DAG + Config — 新 packages, 重点看算法正确性和 schema 设计
- **Segment 3** (Task 6-7): Blueprint + E2E — 核心编排逻辑, 重点看流程完整性和测试覆盖

PR 描述包含 E2E 验证结果截图。

## Phase 1 之后

- **不做**: Decision Layer, Slack notification, Reactions, CIPHER learning, auto-loop, daily budget cap
- **做**: 根据 Phase 1 实际情况更新 architecture doc, 然后写 Phase 2 plan

## Risk

| Risk | Mitigation |
|------|-----------|
| Cyrus fork 结构和预期不符 | Task 1 兼容性 spike 先验证, 不匹配就提前调整方案 |
| `claude` CLI 接口不匹配 | Task 1 确认参数 + Task 2b 适配, 记录 adapter 需求 |
| Cyrus transport 不可复用 | Task 1 spike 提前发现, Task 6 内实现替代 wiring |
| Linear API rate limit | 开发阶段用 mock, E2E 用真实 API |
| CI 轮次不够 | Config 控制 (`ci.max_rounds`), 默认 2 轮 |
