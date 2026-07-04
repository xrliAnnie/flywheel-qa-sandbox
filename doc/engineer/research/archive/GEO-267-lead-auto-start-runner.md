# Research: Lead 自动启动 Runner + PM Lead (Chief of Staff) — GEO-267

**Issue**: GEO-267
**Date**: 2026-03-27
**Source**: `doc/engineer/exploration/new/GEO-267-lead-auto-start-runner.md`
**Domain**: Backend (orchestration)
**Status**: approved

---

## Research Question

如何让 Lead 通过 Bridge API 自动启动 Runner（去掉手动 run-issue.ts），并支持 PM Lead (Chief of Staff) 在统一 Core Channel 中 triage 和分配任务？

## Executive Summary

- **当前系统**: Runner 只能通过 `run-issue.ts` CLI 手动启动。`RetryDispatcher` 已有在 Bridge daemon 内 fire-and-forget 调用 `Blueprint.run()` 的完整模式。
- **核心发现**: Blueprint.run() 内部已处理 issue 数据 hydration（PreHydrator），所以 start dispatcher 只需传 `{id, blockedBy: []}` + `BlueprintContext` 即可，与 retry 几乎相同。
- **最重要的约束**: IRetryDispatcher 接口是公开 API，扩展时不能 break 现有 retry 流程。每个 Lead 的 Discord channel 由 `DISCORD_STATE_DIR/access.json` 控制——多 channel 监听需要修改此文件。
- **规划方向**: 扩展 RetryDispatcher → RunDispatcher（start + retry），新增 `POST /api/runs/start` endpoint，并发控制加 maxConcurrentRunners。PM Lead 遵循现有 GEO-246 多 Lead 模式创建。

---

## Relevant Files

### Entry points
- `scripts/run-issue.ts:196` — 当前手动启动入口，构建 BlueprintContext 并调用 blueprint.run()
- `packages/teamlead/src/bridge/plugin.ts:187` — Bridge HTTP 服务器入口（startBridge）
- `packages/teamlead/scripts/claude-lead.sh:1` — Lead supervisor 脚本

### Core implementation
- `scripts/lib/retry-dispatcher.ts:22` — RetryDispatcher 实现（fire-and-forget + single-flight）
- `packages/teamlead/src/bridge/retry-dispatcher.ts:23` — IRetryDispatcher 接口定义
- `scripts/lib/setup.ts:71` — setupComponents() 创建 Blueprint + 所有子组件
- `packages/edge-worker/src/Blueprint.ts:50` — BlueprintContext 接口定义
- `packages/teamlead/src/bridge/actions.ts:412` — handleRetry() 完整 retry 流程
- `packages/teamlead/src/bridge/tools.ts:34` — Bridge query routes
- `packages/teamlead/src/ProjectConfig.ts:5` — LeadConfig 接口 + resolveLeadForIssue()
- `packages/teamlead/src/bridge/lead-scope.ts:51` — matchesLead() scope 验证
- `packages/teamlead/src/bridge/runtime-registry.ts:21` — RuntimeRegistry multi-lead 解析
- `packages/teamlead/src/bridge/claude-discord-runtime.ts` — Discord runtime（控制 channel 投递）

### Tests
- `packages/teamlead/src/__tests__/retry-e2e.test.ts` — RetryDispatcher E2E
- `packages/teamlead/src/__tests__/bridge-e2e.test.ts` — Bridge daemon 全生命周期
- `packages/teamlead/src/__tests__/actions.test.ts` — Action handlers 单元测试
- `packages/teamlead/src/__tests__/ProjectConfig.test.ts` — Lead 配置验证

### Config
- `~/.flywheel/projects.json` — 多 Lead 配置（via FLYWHEEL_PROJECTS env）
- `~/.claude/channels/discord-<lead-id>/access.json` — per-lead Discord channel 配置
- `packages/teamlead/src/config.ts:47` — Bridge 配置验证

---

## Data/Control Flow

### Flow A: 现有 Retry 流程（要复用的模式）

```
POST /api/actions/retry {execution_id, reason, leadId}
  → actions.ts:819 — route handler
  → checkLeadScope() — 403 if out of scope
  → handleRetry() at actions.ts:412
    → validate: session exists + status in fromStates (failed/blocked/rejected)
    → validate: no inflight issue (retryDispatcher.getInflightIssues())
    → validate: no active session for same issue (store.getActiveSessions())
    → resolveLeadForIssue() — from stored session labels
    → retryDispatcher.dispatch(req) — IRetryDispatcher
      → single-flight guard (inflight Map)
      → blueprintsByProject.get(projectName) — pre-configured Blueprint
      → new executionId via randomUUID()
      → build BlueprintContext with retryContext + leadId
      → blueprint.run({id, blockedBy:[]}, projectRoot, ctx) — FIRE AND FORGET
      → .finally(() => inflight.delete(issueId))
    → store.setRetrySuccessor() — link predecessor
    → sendActionHook() — notify Lead runtime
  → return {success: true, newExecutionId}
```

### Flow B: 新 Start 流程（vs Retry 的差异分析）

```
POST /api/runs/start {issueId, projectName, leadId, labels?, issueTitle?, issueDescription?}
  → (新 route handler)
  → validate: maxConcurrentRunners 未超限
  → validate: 同一 issue 不在 inflight 中
  → validate: 同一 issue 没有 active session
  → RunDispatcher.start(req)
    → single-flight guard (复用 inflight Map)
    → blueprintsByProject.get(projectName)
    → new executionId
    → build BlueprintContext (无 retryContext)
    → blueprint.run({id, blockedBy:[]}, projectRoot, ctx) — FIRE AND FORGET
  → return {success: true, executionId}
```

**与 Retry 的关键差异**:

| 方面 | Retry | Start |
|------|-------|-------|
| 前置条件 | 需要现有 session（execution_id） | 无前置 session |
| FSM 状态检查 | fromStates: failed/blocked/rejected | 无（全新） |
| Issue 数据 | 从 stored session 取 labels/project | 请求体传入或 PreHydrator 自动 fetch |
| Lead 解析 | 从 stored session labels 解析 | 请求体传入 leadId + labels |
| 并发检查 | single-flight + no active session | 同上 + maxConcurrentRunners |
| Blueprint 调用 | 完全相同 | 完全相同 |

**关键发现**: `Blueprint.run()` 内部通过 `PreHydrator` 处理 issue 数据获取（`Blueprint.ts:84-86`）。Start dispatcher 不需要预先 fetch issue 数据——只需传 `{id: issueId, blockedBy: []}` 和 `BlueprintContext`，Blueprint 自己会 hydrate。

### Flow C: claude-lead.sh 启动 Lead + Discord 连接

```
claude-lead.sh <lead-id> <project-dir> [project-name]
  → validate lead-id format: [a-z0-9][a-z0-9-]*
  → DISCORD_STATE_DIR=~/.claude/channels/discord-<lead-id>/
  → resolve PROJECT_NAME from loadProjects()
  → FLYWHEEL_COMM_DB=~/.flywheel/comm/<project>/comm.db
  → sync agent file: <workspace>/agent.md → ~/.claude/agents/<lead-id>.md (COPY, not symlink)
  → POST /api/bootstrap/<lead-id> → Bridge generates snapshot → sends to controlChannel
  → sleep 3s (wait for bootstrap)
  → claude --agent <lead-id> --channels plugin:discord@claude-plugins-official
    (with optional --resume <session-id>)
```

**Discord channel 连接机制**:
- `DISCORD_STATE_DIR` 指向 `~/.claude/channels/discord-<lead-id>/`
- 该目录包含 `access.json`，定义 bot token 和可访问的 channel
- **每个 Lead 进程有独立的 Discord plugin 实例**，读取自己的 `access.json`
- Bridge 侧 `ClaudeDiscordRuntime` 只投递到单个 `controlChannel`

**多 channel 监听**: 要让 Lead 同时在 core channel + 自己的 forum 中响应，需要在 `access.json` 中添加 core channel。这是 Discord plugin 的配置问题，不需要修改 Flywheel 代码。

---

## Existing Patterns to Follow

### Pattern 1: RetryDispatcher — Single-Flight + Fire-and-Forget
- Where: `scripts/lib/retry-dispatcher.ts:22-111`
- 核心模式: inflight Map + single-flight guard + fire-and-forget blueprint.run() + .finally cleanup
- RunDispatcher 应继承此模式，添加 `start()` method

### Pattern 2: Multi-Lead Config (GEO-246)
- Where: `packages/teamlead/src/ProjectConfig.ts:5-24`
- LeadConfig: `{agentId, forumChannel, chatChannel, match: {labels: []}, botTokenEnv?, controlChannel?, runtime?, statusTagMap?}`
- PM Lead 只需新增一个 entry，match labels 可以设为空或 `["PM"]`

### Pattern 3: Lead Supervisor Script
- Where: `packages/teamlead/scripts/claude-lead.sh:1-184`
- 参数化: lead-id, project-dir, project-name
- Per-lead isolation: DISCORD_STATE_DIR, agent file copy, session ID persistence
- PM Lead 使用完全相同的脚本启动

### Pattern 4: Bridge Route Registration
- Where: `packages/teamlead/src/bridge/plugin.ts:187-300`
- 依赖注入: retryDispatcher, registry, eventFilter, etc.
- 新 start route 遵循相同的注册模式

### Pattern 5: Action Scope Validation
- Where: `packages/teamlead/src/bridge/actions.ts:668-711`
- checkLeadScope(): 非 scope 内的 session 返回 403
- Start 需要不同的 scope 检查（无现有 session，用请求体中的 labels）

### Testing Patterns
- `:memory:` SQLite for StateStore
- Mock exec for subprocess calls
- Mock RuntimeRegistry for lead delivery
- `createInflightDispatcher()` helper for single-flight testing
- Server auto-cleanup in afterEach

---

## Constraints and Non-Negotiables

### Interface Stability
- `IRetryDispatcher` 接口不可 break（5 methods: dispatch, getInflightIssues, stopAccepting, drain, teardownRuntimes）
- Evidence: `packages/teamlead/src/bridge/retry-dispatcher.ts:23-29`
- **建议**: 新建 `IRunDispatcher extends IRetryDispatcher` 添加 `start()` method，或独立 `IStartDispatcher`

### BlueprintContext 必须字段
- `teamName`, `runnerName` 必须。`projectName`, `executionId`, `leadId` 可选但推荐
- Evidence: `packages/edge-worker/src/Blueprint.ts:50-71`

### LeadConfig 新增字段限制
- 所有新字段必须 optional（不 break 现有 projects.json）
- Evidence: `packages/teamlead/src/ProjectConfig.ts:91-158`

### Bridge 配置约束
- Host 只能 loopback (127.0.0.1/localhost/::1)
- Port 1-65535，默认 9876
- Evidence: `packages/teamlead/src/config.ts:47-73`

### TmuxAdapter 环境变量
- 必须注入: FLYWHEEL_COMM_DB, FLYWHEEL_EXEC_ID, FLYWHEEL_CALLBACK_PORT, FLYWHEEL_CALLBACK_TOKEN
- Session 命名: 默认 "flywheel"，retry 用 "retry-${projectName}"
- Evidence: `packages/claude-runner/src/TmuxAdapter.ts:33-40, 123-161`

### Discord Runtime
- `runtime="claude-discord"` 要求非空 `controlChannel`
- Per-lead bot token: `botTokenEnv` env var → Discord REST API
- Delivery timeout: 3000ms
- Evidence: `packages/teamlead/src/bridge/claude-discord-runtime.ts`

### StateStore Session 创建
- 必须字段: execution_id, issue_id, project_name, status
- Terminal statuses 不可逆: completed, approved, failed, rejected, terminated 等
- Evidence: `packages/teamlead/src/StateStore.ts:17-66`

### 并发安全
- Node.js 单线程 → inflight Map 操作是原子的（无需锁）
- 但 maxConcurrentRunners 需要查 StateStore active sessions + inflight count
- Evidence: `scripts/lib/retry-dispatcher.ts:40-41`

---

## Recommendations for Planning

### Phase 1: Bridge Start API (Engine)
1. 新建 `IStartDispatcher` 接口（或扩展 IRetryDispatcher 为 IRunDispatcher）
2. 实现 `RunDispatcher`：复用 RetryDispatcher 的 inflight/blueprint 模式，添加 `start()` + `maxConcurrentRunners` 检查
3. 新增 `POST /api/runs/start` route in tools.ts 或新文件 `runs-route.ts`
4. Issue hydration: 依赖 Blueprint 内部的 PreHydrator（需确认 PreHydrator 能用 LINEAR_API_KEY 直接 fetch）
5. 测试: 复用 retry-e2e 模式，mock Blueprint

### Phase 2: Lead 启动能力
1. 更新 Lead TOOLS.md：添加 `POST /api/runs/start` 文档
2. Lead agent.md 添加行为指令：收到 PM 分配后自动 curl start API

### Phase 3: PM Lead + Core Channel
1. 创建 PM Lead bot（Discord bot 注册 + token）
2. projects.json 添加 PM Lead entry（agentId, channels, 无 Runner 管理）
3. 创建 #geoforge3d-core channel
4. 所有 bot (PM, Peter, Oliver) 加入 core channel → 修改各自 `access.json`
5. PM agent.md：triage 行为（LNO/ICE）+ Linear API 查询 + 分配指令

### Phase 4: PM 自动 Triage
1. PM 定时/按需扫 Linear backlog
2. 生成 triage 报告到 core channel
3. CEO 确认后 PM 分配给各 Lead

### Plan 必须包含的验证步骤
1. Start API → Blueprint.run() → Runner 在 tmux 中启动 ✓
2. 并发限制: 超过 maxConcurrentRunners 返回 429 ✓
3. 重复 issue guard: 同一 issue 不能同时启动两次 ✓
4. Lead 通过 curl 成功启动 Runner（E2E）✓
5. PM Lead 在 core channel 发言，Peter/Oliver 能看到并响应 ✓

### 需要避免的风险
1. **PreHydrator Linear API 依赖**: 如果 LINEAR_API_KEY 未设置，PreHydrator 可能 fallback 到 KNOWN_ISSUES 硬编码。需要确认 Bridge 进程中有 LINEAR_API_KEY。
2. **Trust prompt**: Bridge 启动的 Runner 仍需处理 workspace trust prompt。建议在 Claude Code 配置中 pre-trust 项目目录。
3. **tmux session 命名冲突**: Start 和 Retry 使用不同的 session 命名模式，可能导致冲突。需要统一。

---

## Open Questions — Resolved

### Q1: Issue 数据来源
**决策**: Lead 只传 issueId，Blueprint 的 PreHydrator 自动查 Linear API。技术细节在 plan 阶段由 Codex design review 确认。

### Q2: PM Lead 命名
**决策**: **Simba** (Chief of Staff)。S 打头，对应 Staff/Strategy。Disney 角色: The Lion King 的辛巴。

### Q3: Core Channel 消息路由
**决策**: 自然语言路由 + Simba 默认接管。
- CEO 说 "Peter，XXX" → Peter 回复（Claude 自然理解被叫到）
- CEO 说一般性消息，没指定谁 → Simba 回复
- 实现方式: 每个 bot 的 agent.md 中写明路由规则（prompt-level），不需要额外代码
- 风险: 偶尔可能误判（两人同时回复或没人回复），MVP 可接受，后续可加硬逻辑
