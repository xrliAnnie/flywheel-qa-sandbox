# Research: Stale Session 巡检技术方案 — GEO-270

**Issue**: GEO-270
**Date**: 2026-03-27
**Source**: `doc/engineer/exploration/new/GEO-270-runner-tmux-cleanup.md` (v3)

## 核心发现

**大部分基础设施已经存在。** HeartbeatService 已经是定期巡检机制，RuntimeRegistry + LeadRuntime 已经是通知 Lead 的管道。GEO-270 本质上是在现有框架里加一个新的检查类型。

## 1. 巡检数据源：StateStore（主）+ CommDB（辅）

### StateStore（Bridge 内存 SQLite）

`packages/teamlead/src/StateStore.ts`

| 字段 | 用途 |
|------|------|
| `execution_id` | PK |
| `status` | running / completed / blocked / failed |
| `last_activity_at` | Runner 最后活动时间 ✅ |
| `heartbeat_at` | Runner 最后心跳时间 ✅ |
| `project_name` | 所属项目 |
| `issue_id` | Linear issue |
| `issue_labels` | 用于 Lead 路由（multi-lead） |
| `tmux_session` | tmux session name |
| `thread_id` | Discord forum post ID |
| `started_at` | 启动时间 |
| `summary` | 执行摘要 |

**已有的相关查询方法**：
- `getStuckSessions(thresholdMinutes)` — running + last_activity 超时
- `getOrphanSessions(thresholdMinutes)` — running + heartbeat 超时

**缺少的查询**: "已完成但 tmux 还活着" — 需要新增:
```sql
SELECT * FROM executions
WHERE status IN ('completed', 'failed', 'blocked')
  AND last_activity_at < datetime('now', '-N hours')
```

### CommDB（Runner 通信 DB）

`packages/flywheel-comm/src/db.ts`

辅助用途：
- `tmux_window` — 精确的 tmux target（如 `"GEO-270:@0"`）
- `lead_id` — session 的 Lead 归属
- `ended_at` — 完成时间

**巡检不需要 CommDB**。StateStore 有足够信息。CommDB 仅在 Lead 需要关闭 session 时用来查 `tmux_window`。

## 2. 巡检机制：扩展 HeartbeatService

### 现有机制

`packages/teamlead/src/HeartbeatService.ts`

```typescript
class HeartbeatService {
    timer: NodeJS.Timeout;
    intervalMs: number;  // 默认 5 分钟

    async check() {
        await this.checkStuck();    // 15min 无活动 → 通知 Lead "session stuck"
        await this.reapOrphans();   // 60min 无心跳 → force-fail + 通知
    }
}
```

- 在 Bridge 启动时 `start()`, 关闭时 `stop()`
- 每 5 分钟执行一次 `check()`
- 通过 `RegistryHeartbeatNotifier` → `RuntimeRegistry` → `LeadRuntime.deliver()` 通知 Lead

### 新增巡检

在 `check()` 中加一个新方法 `checkStaleCompleted()`:

```typescript
async check() {
    await this.checkStuck();
    await this.reapOrphans();
    await this.checkStaleCompleted();  // 新增
}
```

**检测逻辑**:
- status IN (completed, failed, blocked)
- last_activity_at > N 小时（可配置，默认 24h）
- tmux session 仍然存活（`tmux has-session`）

**频率问题**: 当前 HeartbeatService 每 5 分钟跑一次，但 stale session 巡检不需要这么频繁。两种方式：
1. 在 `checkStaleCompleted()` 内部做节流（记录上次巡检时间，间隔 < N 小时则跳过）
2. 或用独立 interval

推荐方式 1 — 简单，不改 HeartbeatService 架构。

## 3. 通知路径：已全部存在

```
HeartbeatService.checkStaleCompleted()
    → StateStore.getStaleCompletedSessions(thresholdHours)
    → for each session:
        → RegistryHeartbeatNotifier.onSessionStale(session, hours)
            → RuntimeRegistry.resolveWithLead(projects, project_name, labels)
            → runtime.deliver(envelope)  // → Discord 或 OpenClaw
```

### 通知内容

新 HookPayload event type: `"session_stale_completed"`

```typescript
{
    event_type: "session_stale_completed",
    execution_id: "exec-123",
    issue_id: "GEO-208",
    project_name: "geoforge3d",
    status: "completed",
    hours_since_completion: 26,
    tmux_session: "GEO-208",
}
```

Lead 收到后在 Discord 看到类似：
```
🔍 Stale Session Alert

GEO-208 completed 26 hours ago but tmux session still alive.
Please check if this session can be closed.
```

### 防重复通知

HeartbeatService 已有 `notifiedOrphans` Set 防重复。同样模式：

```typescript
private notifiedStale = new Set<string>();
// 通知一次后加入 Set，不再重复
// 如果 session 被关闭（状态变化），从 Set 中移除
```

## 4. Lead 关闭 Session：新 Bridge API

### 端点设计

`POST /api/sessions/:executionId/close`

```typescript
// Request
{ projectName: string; leadId?: string; }

// Response
{ closed: boolean; error?: string; }
```

### 实现

基于 `session-capture.ts` 的模式（`packages/teamlead/src/bridge/session-capture.ts`）：

1. 从 CommDB 获取 `tmux_window`（或从 StateStore 获取 `tmux_session`）
2. `execFileAsync("tmux", ["kill-session", "-t", target])`
3. 更新 StateStore status（如果不是已经 terminal）
4. 返回结果

### Lead 如何调用？

- **OpenClaw Lead**: 通过 Bridge API（HTTP POST）
- **Claude Discord Lead**: 通过 MCP tool 或 flywheel-comm CLI
- 可以在 Lead 的 TOOLS.md 中添加 close session 的说明

## 5. PR 状态查询

**结论**: 不需要在 GEO-270 中实现。

当前系统没有 GitHub API 集成（只有 webhook 接收）。PR 状态查询留给 Sprint 收尾流程的新 issue。

巡检只需要告诉 Lead "这个 session 完成了 N 小时还开着"，Lead 自己有能力判断 PR 状态。

## 6. 实现复杂度评估

| 组件 | 工作量 | 说明 |
|------|--------|------|
| `StateStore.getStaleCompletedSessions()` | 小 | 新增一个 SQL 查询方法 |
| `HeartbeatService.checkStaleCompleted()` | 中 | 新增检查方法 + 节流逻辑 + 防重复 |
| `RegistryHeartbeatNotifier.onSessionStale()` | 小 | 新增通知方法（复制 onSessionStuck 模式） |
| `Bridge API POST /api/sessions/:id/close` | 中 | 新端点 + tmux kill + 状态更新 |
| 配置项 | 小 | `STALE_COMPLETED_THRESHOLD_HOURS` 默认 24 |
| 测试 | 中 | StateStore 查询 + HeartbeatService 检查 + API 端点 |

**总计**: 中等复杂度。大部分是在现有框架上扩展，不需要新架构。

## 设计决策摘要

| 决策 | 选择 | 原因 |
|------|------|------|
| 数据源 | StateStore（主） | 有 last_activity_at，在 Bridge 进程内 |
| 巡检机制 | 扩展 HeartbeatService | 已有定期检查 + 通知管道 |
| 巡检频率 | 每 5min 跑一次但内部节流到每 N 小时 | 复用现有 interval，不过度检查 |
| 通知路径 | RuntimeRegistry → LeadRuntime.deliver() | 已存在，支持 OpenClaw + Discord |
| 防重复 | notifiedStale Set | 对齐 notifiedOrphans 模式 |
| 关闭 session | Bridge API `POST /api/sessions/:id/close` | Lead 通过 HTTP 调用 |
| 超时阈值 | 24h（可配置） | CEO 可能隔天才看 |
| PR 查询 | 不做 | 留给 Sprint 收尾 issue |

→ Plan 阶段
