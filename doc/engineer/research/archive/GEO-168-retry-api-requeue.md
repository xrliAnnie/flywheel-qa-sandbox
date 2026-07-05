# Research: Retry API Requeue Implementation — GEO-168

**Issue**: GEO-168
**Date**: 2026-03-15
**Source**: `doc/engineer/exploration/new/GEO-168-retry-api-requeue.md`

## 1. StateStore Schema 验证

### 已有字段（无需 migration）

- `run_attempt INTEGER DEFAULT 0` — **已存在**（`StateStore.ts:242` migration）
- `SessionUpsert.run_attempt` — **已存在**（`StateStore.ts:56`）
- `Session.run_attempt` — **已存在**（`StateStore.ts:87`）

### 需要 migration 的字段

```sql
-- 只需要两列，run_attempt 已存在
ALTER TABLE sessions ADD COLUMN retry_predecessor TEXT;
ALTER TABLE sessions ADD COLUMN retry_successor TEXT;
```

**Migration 模式**：follow existing pattern（`StateStore.ts:226-245`），用 try/catch 包装使其 idempotent：

```typescript
try { this.db.run("ALTER TABLE sessions ADD COLUMN retry_predecessor TEXT"); } catch { }
try { this.db.run("ALTER TABLE sessions ADD COLUMN retry_successor TEXT"); } catch { }
```

### 需要新增的 StateStore 方法

```typescript
setRetrySuccessor(executionId: string, successorId: string): void {
  this.db.run(
    "UPDATE sessions SET retry_successor = ? WHERE execution_id = ?",
    [successorId, executionId]
  );
  this.save();
}
```

`SessionUpsert` 和 `Session` 接口需加 `retry_predecessor?: string` 和 `retry_successor?: string`。

## 2. Dashboard allowedActions 验证

**好消息**：`dashboard-data.ts:26` 已有 `allowedActions: string[]` 字段，使用 `allowedActionsForState(s.status)` 生成（`dashboard-data.ts:58`）。

**需要改的**：`toDashboardSession()` 需要额外参数来检查 retry eligibility：

```typescript
// 当前
allowedActions: allowedActionsForState(s.status)

// 需要改为
allowedActions: allowedActionsForState(s.status).filter(action => {
  if (action === "retry") {
    // 过滤掉：已有 in-flight retry 或 active execution
    if (inflightIssues?.has(s.issue_id)) return false;
    // 过滤掉：已有 running/awaiting_review 的 execution
    // 注意：dashboard 中可能有多个 execution for same issue
    return true;
  }
  return true;
})
```

**依赖注入**：`buildDashboardPayload()` 需要接受 optional `inflightIssues: Set<string>`。

## 3. Existing Retry Tests（需要重写）

`actions.test.ts` 中 4 个 retry 测试（lines 237-275）：

| Test | 当前断言 | 新断言 |
|------|---------|--------|
| `retry transitions failed to running` | `session.status === "running"` | 旧 session 保持 `"failed"`, 新 session 创建 |
| `retry transitions rejected to running` | `session.status === "running"` | 旧 session 保持 `"rejected"` |
| `retry transitions blocked to running` | `session.status === "running"` | 旧 session 保持 `"blocked"` |
| `retry from awaiting_review fails` | `result.success === false` | **不变** — awaiting_review 仍不可 retry |

**新增测试**：
- retry 创建新 execution_id（不同于旧的）
- retry 设置 retry_successor 和 retry_predecessor
- retry run_attempt 递增
- retry single-flight: 同一 issue 并发 retry 返回 409
- retry 无 dispatcher 时返回 501
- retry 已有 running execution 时返回 409
- retry 成功后 Linear comment 被调用（mock）

## 4. FSM WORKFLOW_TRANSITIONS 变更

`core/src/workflow-fsm.ts:120-137`：

```typescript
// 当前
failed: ["running", "shelved"],
blocked: ["running", "deferred", "shelved"],
rejected: ["running", "shelved"],

// 变更后
failed: ["shelved"],
blocked: ["deferred", "shelved"],
rejected: ["shelved"],
```

**影响范围**：
- `WorkflowFSM.test.ts` — 需要更新相关 transition 断言
- `applyTransition.ts` — 不需改（仅验证 FSM，retry 不再走这条路径）
- `HeartbeatService` — 不受影响（只处理 running → failed/orphaned）

**`ACTION_DEFINITIONS` retry entry**：保留但含义变更——`fromStates` 用于资格检查，`targetState` 不再直接使用（新 execution 从 pending → running）。

## 5. Hook Notification 基础设施

`hook-payload.ts` 已导出所有需要的工具：
- `notifyAgent(gatewayUrl, hooksToken, body)` — 3s timeout, fire-and-forget
- `buildSessionKey(session)` — `"flywheel:{identifier}"`
- `buildHookBody(agentId, payload, sessionKey)` — 包装为 OpenClaw 格式
- `HookPayload` interface — 包含所有字段

**DirectEventSink 可直接复用这些函数**，无需重新实现 notification 逻辑。

## 6. Linear SDK Comment API

`LinearIssueTrackerService.ts:560` 确认 API：

```typescript
this.linearClient.createComment({ issueId, body, parentId? })
```

**注意**：这里的 `issueId` 是 Linear internal UUID（不是 GEO-168 这样的 identifier）。Bridge session 存储的是 `issue_id`（internal UUID），可直接使用。

**问题**：Flywheel 项目当前没有直接依赖 `@linear/sdk`（teamlead 包没有）。`@linear/sdk` 在 `linear-event-transport` 包中。

**方案**：
- Option A：在 retry handler 中直接 `import { LinearClient } from "@linear/sdk"` — 需要加 dependency
- Option B：通过现有 `LinearIssueTrackerService` — 需要注入实例
- **推荐 Option A**：最简单，`@linear/sdk` 已在 monorepo 中（`linear-event-transport` 的 dep），不需要额外安装

## 7. Blueprint Prompt Injection 精确位置

`Blueprint.ts:282-284`：
```typescript
systemPromptLines.push("Do not ask questions — implement your best judgment.");
const baseSystemPrompt = systemPromptLines.join("\n");
```

**retryContext 注入点**：在 `push("Do not ask questions...")` 之前插入 retry context block。这样 retry context 成为 system prompt 的一部分，但在 "Do not ask questions" 之前。

## 8. `createBridgeApp` 签名变更

当前：
```typescript
function createBridgeApp(
  store: StateStore,
  projects: ProjectEntry[],
  config: BridgeConfig,
  broadcaster?: SseBroadcaster,
  transitionOpts?: ApplyTransitionOpts,
): express.Application
```

需要新增：
```typescript
function createBridgeApp(
  store: StateStore,
  projects: ProjectEntry[],
  config: BridgeConfig,
  broadcaster?: SseBroadcaster,
  transitionOpts?: ApplyTransitionOpts,
  retryDispatcher?: IRetryDispatcher,  // NEW
): express.Application
```

传递到 `createActionRouter(store, projects, retryDispatcher?, config?)` 和 `createQueryRouter(store, retryDispatcher?)`.

## 9. `startBridge` Two-Phase Refactor

当前 `startBridge` 内部创建 `store`：
```typescript
const store = await StateStore.create(config.dbPath);  // line 196
```

**最小变更**：
```typescript
export async function startBridge(
  config: BridgeConfig,
  projects: ProjectEntry[],
  opts?: {
    store?: StateStore;
    retryDispatcher?: IRetryDispatcher;
  },
): Promise<...> {
  const store = opts?.store ?? await StateStore.create(config.dbPath);
  // ... pass retryDispatcher through
}
```

**向后兼容**：现有 `index.ts` 调用 `startBridge(config, projects)` 不传 opts，行为不变。

## 10. `setupComponents` eventEmitterOverride

当前 `SetupOptions`（`setup.ts:66-83`）没有 `eventEmitterOverride`。需要新增：

```typescript
export interface SetupOptions {
  // ... existing fields
  eventEmitterOverride?: ExecutionEventEmitter;
}
```

在 `setupComponents()` 中（`setup.ts:166-170`）：
```typescript
const eventEmitter: ExecutionEventEmitter = opts.eventEmitterOverride
  ?? (teamleadUrl ? new TeamLeadClient(teamleadUrl, teamleadToken) : new NoOpEventEmitter());
```

## 11. Implementation Wave 分解

| Wave | 范围 | 文件 | 风险 |
|------|------|------|------|
| 1 | Schema + Interface | StateStore (migration + types), IRetryDispatcher interface, EventEnvelope extension, BlueprintContext extension | Low — additive |
| 2 | FSM + Core | workflow-fsm.ts (remove running from terminal), ACTION_DEFINITIONS comment | Medium — behavioral change |
| 3 | DirectEventSink + RetryDispatcher | 新文件 + setupComponents override | Medium — new code |
| 4 | Bridge wiring | actions.ts retry handler, plugin.ts two-phase, tools.ts resolve-action, dashboard-data.ts | High — integration |
| 5 | Blueprint prompt | Blueprint.ts retryContext → prompt injection | Low — additive |
| 6 | Linear comment | postRetryComment function | Low — best-effort |
| 7 | Tests | Rewrite 4 retry tests, add ~10 new tests | Medium |

## 12. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| FSM 变更导致其他 action 行为改变 | High | `failed/blocked/rejected` 只移除 `→ running`，其他转换不变。shelve/defer 不受影响 |
| DirectEventSink 与 event-route 逻辑 drift | Medium | 提取 shared helper 或直接复用 event-route 中的映射逻辑 |
| Long-running Blueprint 在 Bridge 内 crash | Medium | drain() + orphan marking + HeartbeatService 兜底 |
| `@linear/sdk` import 增加 teamlead 包大小 | Low | 可选依赖，LINEAR_API_KEY 不存在时 skip |
| 并发 retry race condition | Low | dispatch() 内部 synchronous guard（Node.js 单线程） |
