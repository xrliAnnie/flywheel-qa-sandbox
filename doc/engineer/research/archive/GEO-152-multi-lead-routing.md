# Research: Multi-Lead / Multi-Team Routing — GEO-152

**Issue**: GEO-152
**Date**: 2026-03-18
**Source**: `doc/engineer/exploration/new/v1.1-multi-lead.md`
**Status**: approved

---

## Research Question

当前 Flywheel 的所有通知和交互硬编码到单个 Lead agent (`"product-lead"`) + 单个 Discord channel。如何将 event routing、action handling、thread management 改造为配置驱动，支持多个 Lead agent 对应不同项目/团队？

## Executive Summary

- Flywheel Bridge 是通知路由的核心——接收 session event，更新状态，推送 HookPayload 到 OpenClaw agent。当前所有路径都硬编码为 `"product-lead"` + 单一 `notificationChannel`
- 主要 flow 有四条：Event Ingest、Action Handling、Thread Management、StuckWatcher/Heartbeat，共 **3 处** `buildHookBody("product-lead", ...)` 硬编码 + **1 处** 单一 channel config
- 最重要的约束是 **conversation_threads 表的 1:1 issue→thread 映射**（unique index），多 lead 场景下同一 issue 只能属于一个 lead 的 channel
- 建议方向：扩展 `ProjectEntry` 添加 `lead` 配置，在 event routing 层根据 session 的 `project_name` 解析对应 lead，替换所有硬编码点

## Relevant Files

### Entry points
- `packages/teamlead/src/bridge/event-route.ts:86` — POST /events/ 入口，event ingest 主路由
- `packages/teamlead/src/bridge/actions.ts:395` — POST /actions/:action 入口，CEO action 处理
- `packages/teamlead/src/HeartbeatService.ts:60` — Stuck/orphan 检测 + 通知

### Core implementation (hardcoded single-lead locations)
- `packages/teamlead/src/bridge/event-route.ts:346` — `buildHookBody("product-lead", hookPayload, sessionKey)`
- `packages/teamlead/src/bridge/actions.ts:81` — `buildHookBody("product-lead", ...)` in `sendActionHook()`
- `packages/teamlead/src/HeartbeatService.ts:203` — `buildHookBody("product-lead", ...)` in `WebhookHeartbeatNotifier`
- `packages/teamlead/src/config.ts:62` — `notificationChannel` 单一 channel，默认 `"CD5QZVAP6"`
- `packages/teamlead/src/bridge/types.ts:16` — `BridgeConfig.notificationChannel: string`

### Project & config types
- `packages/teamlead/src/ProjectConfig.ts:5-9` — `ProjectEntry` 缺少 `lead` 字段
- `packages/config/src/types.ts:91-104` — `AgentConfig` with `match.labels`/`match.keywords`（execution-side routing 参考模式）
- `packages/config/src/types.ts:122-145` — `FlywheelConfig`, `TeamConfig` 结构

### State persistence
- `packages/teamlead/src/StateStore.ts:187` — `sessions.thread_id` column
- `packages/teamlead/src/StateStore.ts:192-199` — `conversation_threads` table（thread_id PK, channel, issue_id unique）
- `packages/teamlead/src/StateStore.ts:759-776` — `upsertThread()` enforces 1 issue = 1 thread

### Discord integration
- `packages/teamlead/src/CleanupService.ts:22-76` — `DiscordClient` interface (sendMessage, archiveThread)

### Tests
- `packages/teamlead/src/__tests__/event-route.test.ts:357` — asserts `agentId: "product-lead"`
- `packages/teamlead/src/__tests__/bridge-e2e.test.ts:263` — E2E verifies `agentId: "product-lead"`
- `packages/teamlead/src/__tests__/hook-payload.test.ts:36-50` — `buildHookBody()` unit tests
- `packages/teamlead/src/__tests__/StuckWatcher.test.ts:130` — heartbeat notifier tests
- `packages/teamlead/src/__tests__/HeartbeatService.test.ts:264,314` — orphan/stuck notification tests

### Config / env
- `TEAMLEAD_NOTIFICATION_CHANNEL` — 单一 channel ID（需改为 per-lead）
- `OPENCLAW_GATEWAY_URL` — OpenClaw gateway endpoint（不变）
- `OPENCLAW_HOOKS_TOKEN` — Hooks auth token（不变）
- `FLYWHEEL_PROJECTS` / `~/.flywheel/projects.json` — 项目配置来源

## Data/Control Flow

### Flow A: Event Ingest（核心路径）

```
POST /events/ (orchestrator → Bridge)
    ↓
event-route.ts:86 — 校验 required fields
    ↓
store.insertEvent() — 幂等写入，duplicate 直接返回
    ↓
Branch on event_type:
  session_started → FSM transition to "running"
                  → Thread inheritance: store.getThreadByIssue(issue_id)
  session_completed → Map decision.route to status
  session_failed → Transition to "failed"
    ↓
event-route.ts:326-348 — 构建 HookPayload:
  channel = config.notificationChannel  ← 🔴 单一 channel
  thread_id = session.thread_id
    ↓
event-route.ts:346 — buildHookBody("product-lead", ...) ← 🔴 硬编码
    ↓
hook-payload.ts:35 — notifyAgent() POST {gatewayUrl}/hooks/ingest
                      Fire-and-forget (3s timeout)
```

### Flow B: Action Handling

```
POST /actions/:action (dashboard/OpenClaw → Bridge)
    ↓
actions.ts:395 — Dispatch by action type
    ↓
approve → actions.ts:88 — verify status, ApproveHandler (git merge), FSM transition
retry   → actions.ts:262 — eligibility check, retryDispatcher.dispatch(), link predecessor
reject/defer/shelve → actions.ts:173 — FSM transition
    ↓
sendActionHook() — actions.ts:53-86:
  channel = config.notificationChannel  ← 🔴 单一 channel
  buildHookBody("product-lead", ...)    ← 🔴 硬编码
    ↓
notifyAgent() — POST hooks/ingest (same as Flow A)
```

### Flow C: Thread Management

```
Thread 创建: OpenClaw agent 在 Discord 创建 forum thread
    ↓
store.upsertThread(threadId, channel, issueId) — 写入 conversation_threads
    注意: DELETE WHERE issue_id = ? 先删旧映射，确保 1 issue = 1 thread
    ↓
Thread 继承 (retry): event-route.ts:174-181
    store.getThreadByIssue(issue_id) → 复用旧 thread_id
    ↓
Thread 清理: CleanupService.ts:99-136
    查找 completed/approved + threshold 过期 → Discord archive + mark archived_at
    ↓
Thread 恢复 (retry): store.clearArchived(thread_id) — 清除 archived_at
```

### Flow D: StuckWatcher / Heartbeat

```
HeartbeatService.ts:60-88 — checkStuck():
    store.getStuckSessions(thresholdMinutes) → 找 running + last_activity_at 过期
    ↓
HeartbeatService.ts:92-151 — reapOrphans():
    store.getOrphanSessions() → 找 running + heartbeat_at stale → FSM force-fail
    ↓
WebhookHeartbeatNotifier.sendHook() — HeartbeatService.ts:199-226:
    buildHookBody("product-lead", ...)  ← 🔴 硬编码
    channel = this.notificationChannel  ← 🔴 从 config.notificationChannel 传入
```

## Existing Patterns to Follow

### Pattern A: Config-Driven Agent Dispatch (edge-worker)
- Where: `packages/edge-worker/src/AgentDispatcher.ts:24-81`
- What: 通过 `AgentConfig.match.labels[]` + `match.keywords[]` 将 Linear issue 路由到不同的 agent executor
- 与 multi-lead 的关系：这是 **execution-side** routing（哪个 agent 跑任务）。GEO-152 需要的是 **notification-side** routing（通知哪个 OpenClaw agent），可以镜像此模式

### Pattern B: Session-Based Project Resolution
- Where: `packages/teamlead/src/ActionExecutor.ts:24-60`
- What: `ProjectAwareApproveHandler` 从 session 的 `project_name` 查找 `ProjectConfig`，获取 project-specific 信息
- 与 multi-lead 的关系：已有从 session → project 的解析链路，可以扩展为 session → project → lead

### Pattern C: Thread-Issue Canonical Mapping
- Where: `packages/teamlead/src/StateStore.ts:759-810`
- What: `conversation_threads` 表确保 1 issue = 1 canonical thread (unique index on issue_id)
- 重要约束：多 lead 场景不需要改变此约束——一个 issue 只属于一个 project，一个 project 只对应一个 lead

### Testing patterns
- Bridge 测试用 `:memory:` SQLite，mock `notifyAgent`，验证 payload 结构
- E2E tests 用 `startSession()` helper 构建完整 flow
- Agent ID assertion 分散在多个 test files 中，需全部更新

## Constraints and Non-Negotiables

### Hard constraints

| Constraint | Evidence | Impact |
|-----------|----------|--------|
| `conversation_threads` 1:1 issue→thread | `StateStore.ts:769` unique index `idx_threads_issue` | 同一 issue 不能有多个 thread（但一个 issue 本身只属于一个 project，所以 OK） |
| `IAgentRunner` interface stability | `core/agent-runner-types.ts:197` deprecated 但仍在用 | 不能改 IAgentRunner 签名，GEO-157 才处理 |
| CI gate: build + typecheck + lint + test | `.github/workflows/ci.yml:26-44` | 所有 PR 必须通过 |
| Loopback-only host | `config.ts:7,24-27` | Bridge API 只允许 localhost binding |
| `FlywheelConfig` backward compatibility | `config/types.ts:122-145` | 新增字段必须 optional，不能 break 现有 config |

### Public APIs that must not break

1. **Bridge ingest API** (`POST /events/`) — orchestrator 依赖此接口，payload 格式不能变
2. **Bridge action API** (`POST /api/actions/:action`) — OpenClaw agent 依赖
3. **HookPayload structure** — OpenClaw agent 的 hook handler 消费此结构
4. **ProjectEntry interface** — 新增 `lead` 字段必须 optional（backward compatible）
5. **BridgeConfig interface** — 保留 `notificationChannel` 作为 default fallback

### Build/test gates

```bash
pnpm build          # TypeScript compilation
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check
pnpm test:packages:run  # vitest suites
```

## Recommendations for Planning

### Recommended approach: ProjectEntry-driven lead resolution

核心思路：
1. **扩展 `ProjectEntry`**：添加 **required** `lead: { agentId: string; channel: string }` 字段
2. **创建 `resolveLeadForSession()` 函数**：session → project_name → ProjectConfig lookup → lead config
3. **替换 3 处硬编码**：`event-route.ts:346`、`actions.ts:81`、`HeartbeatService.ts:203` 调用 `resolveLeadForSession()` 而非字面量 `"product-lead"`
4. **无 fallback**：每个 project 必须配置 lead，未配置则报错

### Why NOT other approaches

- **Per-label routing (like AgentDispatcher)**: 过于复杂，notification routing 不需要 keywords/Haiku 分类。Project→Lead 是 1:1 静态映射
- **Database-stored lead config**: 增加复杂度，config file 足够
- **Multi-thread per issue**: 不需要——一个 issue 只属于一个 project，因此只对应一个 lead
- **Optional lead with fallback**: 不需要——Annie 要求每个 project 必须配 lead，不配就不对

### Plan must include these verification steps

1. 确认 `ProjectConfig` 加载时 validate lead 字段存在
2. 确认 `resolveLeadForSession()` 在 session 无 project_name 时给出明确报错
3. 更新所有 test assertions（至少 5 个 test files 引用 `"product-lead"`）
4. E2E 验证：两个 project 配置不同 lead → event 路由到各自 agent
5. 先在 OpenClaw 创建第二个 agent（如 `eng-lead`），用真实 agent 做 E2E 测试

### Additional scope (confirmed by Annie)

- **GEO-148 清理**: 在此 PR 中顺便将 Linear GEO-148 标记为 Cancelled（Slack Threading 已被 Discord 替代）
- **v1.0-lead-experience.md 更新**: 在此 PR 中将文档中的 Slack 引用更新为 Discord 上下文

### Risk areas

- **HeartbeatService constructor 时序**: `WebhookHeartbeatNotifier` 在启动时构造，拿到的是单一 channel。改为动态解析需要重构构造方式（per-notification resolve 而非 per-instance）
- **Thread channel 一致性**: `conversation_threads.channel` 存储的值目前与 lead 无关联，确保新 thread 创建时写入正确的 lead-specific channel
- **现有 projects.json 迁移**: 需更新现有配置文件添加 lead 字段，否则启动会失败

## Resolved Questions

| # | Question | Answer | Source |
|---|----------|--------|--------|
| 1 | OpenClaw multi-agent routing | **已验证：支持。** `/hooks/agent` 根据 body 中 `agentId` 字段自动路由到对应 agent。见 `openclaw/src/gateway/server-http.ts:550-606` 和 `hooks.ts:268-281`。No blocker. | Code investigation |
| 2 | Default lead 策略 | **Required，不做 fallback。** 每个 project 必须配置 lead，未配置则报错。 | Annie 确认 |
| 3 | GEO-148 清理 | **在 GEO-152 PR 中顺便关掉**，标记为 Cancelled。 | Annie 确认 |
| 4 | v1.0-lead-experience.md 更新 | **在 GEO-152 PR 中一起做**，Slack → Discord 上下文更新。 | Annie 确认 |
| 5 | 测试策略 | **先在 OpenClaw 创建第二个 agent**，用真实 agent 做 E2E 测试。 | Annie 确认 |
