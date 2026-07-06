# Research: Lead Agent Behavior Design — GEO-187

**Issue**: GEO-187
**Date**: 2026-03-19
**Source**: `doc/engineer/exploration/new/GEO-187-lead-agent-behavior-design.md`

---

## 1. 当前通知管道分析

### 1.1 四条通知路径

所有通知最终都调用 `notifyAgent()` → `POST /hooks/ingest`。当前 **每条事件都发给 agent**，没有过滤。

| 路径 | 文件 | 触发条件 | 当前行为 |
|------|------|----------|----------|
| **Event Route** | `event-route.ts:385-408` | session_started/completed/failed | 全部通知 |
| **Action Hook** | `actions.ts:54-87` `sendActionHook()` | approve/reject/defer/retry/shelve | 全部通知 |
| **Heartbeat** | `HeartbeatService.ts:158-227` | stuck/orphan 检测 | 已有过滤（仅 stuck/orphan） |
| **DirectEventSink** | `DirectEventSink.ts:164-195` | bridge-local 执行路径 | 全部通知 |
| **CIPHER Proposal** | `index.ts:41-53` | principle 毕业提案 | 专用通知 |

### 1.2 通知 payload 结构

`HookPayload`（`hook-payload.ts:1-24`）包含：
- 核心字段：`event_type`, `execution_id`, `issue_id`, `status`
- 展示字段：`issue_identifier`, `issue_title`, `project_name`
- 数据字段：`commit_count`, `lines_added/removed`, `summary`, `last_error`
- 路由字段：`thread_id`, `channel`
- Action 字段：`action`, `action_source_status`, `action_target_status`, `action_reason`
- Stuck 字段：`minutes_since_activity`

**缺失字段**：没有 `filter_priority`、`notification_target`（chat vs forum）、`labels` 等过滤相关信息。

### 1.3 硬编码的 "product-lead"

所有 `buildHookBody()` 调用都硬编码 `"product-lead"`：

```
event-route.ts:406    → buildHookBody("product-lead", ...)
actions.ts:81         → buildHookBody("product-lead", ...)
HeartbeatService.ts:203 → buildHookBody("product-lead", ...)
DirectEventSink.ts:188  → buildHookBody("product-lead", ...)
index.ts:50           → buildHookBody("product-lead", ...)
```

**GEO-152** 应该把这些改为动态 agentId。GEO-187 的 Event Filter 位于 session update 和 `notifyAgent()` 之间，与 GEO-152 的 routing 自然集成。

### 1.4 Forum Tag 更新 — 当前流程

```
Flywheel event → Bridge → hook to OpenClaw → agent processes SOUL.md rules → agent calls POST /api/forum-tag → Bridge → Discord API
```

Bridge 已有 `/api/forum-tag` endpoint（`plugin.ts:242-296`），使用 `config.discordBotToken` 直接调 Discord API。Agent 只是一个中间人。

---

## 2. Event Filter 设计

### 2.1 注入点

Filter 在 **session update 之后、`notifyAgent()` 之前** 执行。

```
Before:  event → update session → notifyAgent(ALL)
After:   event → update session → EventFilter.classify() →
           notify_agent: notifyAgent(enriched payload)
           forum_only:   ForumTagUpdater.update() directly
           skip:         nothing
```

### 2.2 过滤规则

基于 Annie 的决定（Chat 推决策 + 重要 update，Forum 全量更新）：

```typescript
interface FilterResult {
  action: 'notify_agent' | 'forum_only' | 'skip';
  priority: 'high' | 'normal' | 'low';
  forumTagId?: string;
  reason: string;
}

// 规则表（按优先级排序，第一个匹配的规则生效）
const FILTER_RULES: FilterRule[] = [
  // 必须通知 — 需要 CEO 决策
  { match: { event_type: 'session_completed', decision_route: 'needs_review' },
    result: { action: 'notify_agent', priority: 'high' } },
  { match: { event_type: 'session_completed', decision_route: 'blocked' },
    result: { action: 'notify_agent', priority: 'high' } },
  { match: { event_type: 'session_failed' },
    result: { action: 'notify_agent', priority: 'high' } },

  // 重要 update — 通知但非紧急
  { match: { event_type: 'session_stuck' },
    result: { action: 'notify_agent', priority: 'normal' } },
  { match: { event_type: 'session_orphaned' },
    result: { action: 'notify_agent', priority: 'normal' } },
  { match: { event_type: 'action_executed' },
    result: { action: 'notify_agent', priority: 'normal' } },
  { match: { event_type: 'cipher_principle_proposed' },
    result: { action: 'notify_agent', priority: 'normal' } },

  // 静默 — 只更新 Forum dashboard
  { match: { event_type: 'session_started' },
    result: { action: 'forum_only', priority: 'low' } },
  { match: { event_type: 'session_completed', status: 'approved' },
    result: { action: 'forum_only', priority: 'low' } },
];
```

### 2.3 可配置性

Filter 规则需要支持 per-Lead 或 per-project 的覆盖：

```typescript
interface FilterConfig {
  // 全局默认规则
  defaultRules: FilterRule[];
  // per-Lead 覆盖
  leadOverrides?: Record<string, Partial<FilterRule>[]>;
  // 例：ops-lead 可能希望 session_started 也通知（ops 更关注执行状态）
}
```

Phase 1 只用全局规则，per-Lead 覆盖留到后续。

### 2.4 HookPayload 增强

为了让 agent 知道事件的重要性和上下文，需要在 payload 中添加字段：

```typescript
interface HookPayload {
  // ... 现有字段 ...

  // GEO-187 新增
  filter_priority?: 'high' | 'normal' | 'low';
  notification_context?: string;  // "需要你的决策" | "FYI" | etc.
  forum_tag_updated?: boolean;    // 告知 agent：Bridge 已更新 tag，不需要 agent 再做
  recent_events_summary?: string; // Aggregator 生成的近期事件摘要
}
```

---

## 3. Forum Tag 直接更新

### 3.1 现有基础

Bridge 已有完整的 Discord API 集成（`plugin.ts:242-296`）：
- `config.discordBotToken` 已配置
- `PATCH /channels/{threadId}` + `applied_tags` body
- 错误处理 + 502 fallback

### 3.2 实现方式

从 `/api/forum-tag` endpoint 提取为独立模块 `ForumTagUpdater`：

```typescript
// Status → Discord tag ID 映射（已在 SOUL.md 中定义，移到代码里）
const STATUS_TAG_MAP: Record<string, string> = {
  running:          '1482926857581232310',  // in-progress
  awaiting_review:  '1482927658454089912',  // awaiting-review
  blocked:          '1482929080629329941',  // blocked
  completed:        '1482929593001181214',  // completed
  approved:         '1482929593001181214',  // completed
  failed:           '1482930162491330783',  // failed
};

class ForumTagUpdater {
  constructor(private discordBotToken: string) {}

  async updateTag(threadId: string, status: string): Promise<void> {
    const tagId = STATUS_TAG_MAP[status];
    if (!tagId || !threadId) return;

    // 与 /api/forum-tag 相同的 Discord API 调用
    await fetch(`https://discord.com/api/v10/channels/${threadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${this.discordBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ applied_tags: [tagId] }),
    });
  }
}
```

### 3.3 调用点

在 Event Filter 判定 `forum_only` 或 `notify_agent` 时，同时调用 `ForumTagUpdater`：

```typescript
// event-route.ts 修改后
const filterResult = eventFilter.classify(event.event_type, session, hookPayload);

// 所有非 skip 的事件都更新 Forum tag
if (filterResult.action !== 'skip' && session.thread_id && filterResult.forumTagId) {
  forumTagUpdater.updateTag(session.thread_id, session.status).catch(() => {});
}

// 只有 notify_agent 才发 hook
if (filterResult.action === 'notify_agent') {
  hookPayload.filter_priority = filterResult.priority;
  hookPayload.forum_tag_updated = true;  // 告知 agent 不需要再更新 tag
  notifyAgent(config.gatewayUrl, config.hooksToken, body).catch(() => {});
}
```

### 3.4 Skip 规则（保留现有逻辑）

从 SOUL.md 移过来的规则：
- `retry` action → **不更新 tag**（retry 当前只改状态不 requeue，设 in-progress 会误导）
- `rejected/deferred/shelved` → **不更新 tag**（CEO 操作中间态，可能随后 retry）

---

## 4. Event Aggregator 设计

### 4.1 需求

避免连续 3 条 "GEO-xx 完成了" spam。把近期同类事件合并为一条。

### 4.2 方案

时间窗口 + 事件类型聚合：

```typescript
class EventAggregator {
  private buffer: Map<string, BufferedEvent[]> = new Map(); // agentId → events
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private windowMs = 30_000; // 30 秒窗口

  add(agentId: string, event: FilteredEvent): void {
    const buf = this.buffer.get(agentId) ?? [];
    buf.push(event);
    this.buffer.set(agentId, buf);

    // 首个事件立即发送（不让 CEO 等）
    if (buf.length === 1) {
      this.flush(agentId);
      return;
    }

    // 后续事件等窗口过期后批量发送
    if (!this.timers.has(agentId)) {
      this.timers.set(agentId, setTimeout(() => this.flush(agentId), this.windowMs));
    }
  }

  private flush(agentId: string): void {
    const buf = this.buffer.get(agentId) ?? [];
    if (buf.length === 0) return;

    if (buf.length === 1) {
      // 单个事件直接发
      sendToAgent(agentId, buf[0]!);
    } else {
      // 多个事件合并
      const summary = this.summarize(buf);
      sendToAgent(agentId, summary);
    }

    this.buffer.delete(agentId);
    this.timers.delete(agentId);
  }

  private summarize(events: FilteredEvent[]): AggregatedPayload {
    // "过去 30 秒有 3 个事件：GEO-95 完成(需 review), GEO-96 完成(已合并), GEO-97 失败"
    return {
      event_type: 'aggregated_update',
      events: events.map(e => ({
        issue_identifier: e.issue_identifier,
        event_type: e.event_type,
        status: e.status,
      })),
      high_priority_count: events.filter(e => e.priority === 'high').length,
    };
  }
}
```

### 4.3 Phase 1 简化

Phase 1 可以先不做 Aggregator。Event Filter 已经大幅减少通知量（session_started 和 auto_approve 静默）。如果实际使用中仍觉得 spam，再加 Aggregator。

---

## 5. Agent SOUL.md 重设计

### 5.1 核心变化

| 维度 | 当前 | 目标 |
|------|------|------|
| 角色定义 | "Engineering Manager" | "部门负责人"（per-department 定制） |
| Forum tag | Agent 处理 | Bridge 直接做，agent 不管 |
| 过滤 | Agent 收所有事件自己判断 | Bridge 过滤后只发重要的，agent 专注对话 |
| 工具 | Bridge API + Discord | + Linear API（创建/修改 issue、调优先级） |
| 记忆 | MEMORY.md（通用） | 结构化记忆（CEO 偏好、决策 pattern） |
| 语言 | 中文 | 中文（保持不变） |

### 5.2 Per-Department Persona 框架

```
clawdbot-workspaces/
├── product-lead/
│   ├── SOUL.md         → Product 部门负责人人格
│   ├── TOOLS.md        → Bridge API + Linear API + Discord
│   ├── MEMORY.md       → Product 决策记忆
│   └── DEPARTMENT.md   → Product 部门 scope、团队组成、KPI
├── ops-lead/
│   ├── SOUL.md         → Ops 部门负责人人格
│   ├── TOOLS.md        → Bridge API + Infra tools + Discord
│   ├── MEMORY.md       → Ops 决策记忆
│   └── DEPARTMENT.md   → Ops 部门 scope
└── marketing-lead/
    ├── SOUL.md         → Marketing 部门负责人人格
    └── ...
```

每个 SOUL.md 的公共部分：
- 你是 {department} 部门负责人
- 你管理 N 个 AI sub-agent 执行 coding/运营/营销任务
- 你的 CEO 是 Annie，通过 Discord 与你交流
- 你收到的事件都是经过 Bridge 过滤的重要事件
- `forum_tag_updated: true` 表示 Forum tag 已由 Bridge 更新，你不需要再处理
- 做不到的事情诚实说不能

每个 SOUL.md 的定制部分：
- 部门专业领域和判断标准
- 关注的指标和风险点
- 沟通风格（Product 可能更注重用户影响，Ops 更注重稳定性）

### 5.3 新增 Tools — Linear API

Agent 需要能创建/修改 issue、调优先级：

```
### Linear API (via Bridge proxy)

- `POST /api/linear/create-issue` — 创建 issue: `{"title":"...","description":"...","priority":1-4,"labels":["Product"]}`
- `PATCH /api/linear/update-issue` — 修改 issue: `{"issueId":"...","priority":2,"title":"..."}`
```

**注意**：Linear API 调用走 Bridge proxy（不让 agent 直接持有 LINEAR_API_KEY）。Bridge 新增 2 个 endpoint。

---

## 6. 实现集成点分析

### 6.1 受影响的文件

| File | Change | Priority |
|------|--------|----------|
| **New** `EventFilter.ts` | 过滤规则引擎 | P0 |
| **New** `ForumTagUpdater.ts` | Discord tag 直接更新 | P0 |
| `event-route.ts:385-408` | 插入 Filter + ForumTagUpdater | P0 |
| `hook-payload.ts` | 增加 `filter_priority`, `forum_tag_updated` 字段 | P0 |
| `DirectEventSink.ts:164-195` | 同步改为经 Filter | P0 |
| `actions.ts:54-87` | `sendActionHook` 经 Filter | P1 |
| `HeartbeatService.ts:199-225` | Stuck/orphan 通知经 Filter（已是高优，可能不需要改） | P1 |
| `plugin.ts` | 新增 `/api/linear/create-issue` + `/api/linear/update-issue` | P1 |
| `types.ts` | BridgeConfig 可能需要新字段 | P1 |
| `product-lead/SOUL.md` | 重写 | P0 |
| `product-lead/TOOLS.md` | 新增 Linear API | P1 |
| **New** `DEPARTMENT.md` per lead | 部门定义 | P2 |

### 6.2 与 GEO-152 的关系

GEO-152 正在做 multi-lead routing（1:N leads per project, label-based routing, dual channels）。GEO-187 的 Event Filter 需要在 GEO-152 之后：

```
GEO-152 flow: event → session update → resolveLeadForIssue() → notifyAgent(dynamicAgentId)
GEO-187 flow: event → session update → EventFilter.classify() → resolveLeadForIssue() → notifyAgent(if needed)
```

Filter 在 routing 之前——先决定 "要不要通知"，再决定 "通知谁"。

### 6.3 与 CIPHER 的关系

CIPHER 已提供学习机制：
- `saveSnapshot()`: 记录 awaiting_review session 的特征
- `recordOutcome()`: 记录 CEO 的 approve/reject/defer 决策
- `CipherProposalPayload`: 当 pattern 成熟时提出 principle

**未来集成**：CIPHER 的 pattern statistics 可以输入到 Event Filter：
- 如果某类 issue CEO 总是立刻 approve → Filter 可以降低优先级（甚至静默）
- 如果某类 issue CEO 总是 reject → Filter 提升优先级 + agent 提醒 "类似 issue 之前被 reject 过"

这不在 GEO-187 Phase 1 范围内，但架构上要留好接口。

---

## 7. 风险与约束

| 风险 | 影响 | 缓解 |
|------|------|------|
| Filter 漏掉重要事件 | CEO 错过需要决策的事件 | Phase 1 保守规则 + pass-through fallback |
| Forum tag 更新失败 | Dashboard 不准确 | Fire-and-forget + agent 仍可手动更新 |
| Agent SOUL.md 重写导致行为退化 | Agent 不再正确处理事件 | Shadow mode 验证（新旧并行） |
| GEO-152 未完成时无法测试多 Lead | 阻塞 per-Lead persona 测试 | GEO-187 Phase 1 先只改 product-lead |
| Linear API proxy 安全性 | API key 泄露风险 | Bridge proxy + token auth |
| Discord rate limit | tag 更新被限流 | 合并请求 + 指数退避 |

---

## 8. 建议实现分阶段

### Phase 1: Event Filter + Forum Tag Direct Update (GEO-187 core)

1. 新建 `EventFilter.ts` — 规则引擎
2. 新建 `ForumTagUpdater.ts` — Discord tag 直接更新
3. 修改 `event-route.ts` — 插入 Filter + ForumTagUpdater
4. 修改 `DirectEventSink.ts` — 同步
5. 增强 `HookPayload` — 新字段
6. 重写 `product-lead/SOUL.md` — 移除 tag 逻辑，升级为部门负责人
7. 测试：验证 Filter 规则 + tag 更新 + agent 行为

### Phase 2: Agent 能力扩展

1. Bridge 新增 Linear API proxy endpoints
2. Agent TOOLS.md 新增 Linear 工具
3. Agent 能创建/修改 issue、调优先级
4. 修改执行 context 的能力（retry with different approach）

### Phase 3: Per-Department Personas + Aggregator

1. DEPARTMENT.md 框架定义
2. Ops-lead、Marketing-lead workspace 创建
3. Event Aggregator（如果 Phase 1 后仍觉得 spam）
4. CIPHER → Filter 集成（pattern-based 优先级调整）

---

## 9. 关键技术决策待确认

1. **Filter 规则存储**：硬编码在 TypeScript 里 vs 配置文件？
   - 建议：Phase 1 硬编码，Phase 2 配置化
2. **Aggregator 是否需要**：Phase 1 Filter 已大幅减少通知，Aggregator 可能多余
   - 建议：Phase 1 不做，观察后决定
3. **Linear API proxy 范围**：只支持 create/update issue？还是更多？
   - 建议：Phase 1 只 create + update + set priority
4. **SOUL.md 迁移策略**：一次性重写 vs 渐进？
   - 建议：Shadow mode 验证后一次性切换
