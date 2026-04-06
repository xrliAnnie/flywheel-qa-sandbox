# Exploration: Forum Thread Link "unknown" Fix — GEO-200

**Issue**: GEO-200 (Forum Thread link 显示 'unknown')
**Date**: 2026-03-30
**Status**: Complete

## 问题描述

Agent 在 Chat channel 通知 Annie 时，Forum Thread link 显示为 `# unknown` 而不是可点击的链接。三个根因：

1. Agent 回写的 `thread_id` 可能指向已删除的 Forum Post
2. Agent 构建 `https://discord.com/channels/{guild_id}/{thread_id}` 时没有验证 thread 是否存在
3. Bridge 的 thread 继承逻辑（同 issue_id 复用 thread）导致新 execution 继承旧的已删除 thread

## 代码分析

### 1. Thread 继承（ForumPostCreator.ts:44）

```typescript
const existing = this.store.getThreadByIssue(ctx.issueId);
if (existing) {
  return { created: false, threadId: existing.thread_id };
}
```

问题：`getThreadByIssue()` 只查本地 SQLite，不验证 Discord 侧 thread 是否仍存在。如果 thread 被人工删除，后续所有 execution 都继承这个 stale thread_id。

### 2. Session API 返回 stale thread_id（tools.ts:107-113）

```typescript
if (!session.thread_id) {
  const thread = store.getThreadByIssue(session.issue_id);
  if (thread) {
    (result as Record<string, unknown>).thread_id = thread.thread_id;
  }
}
```

问题：fallback 查 `conversation_threads` 表也可能返回已删除 thread 的 ID。

### 3. Hook payload 传递未验证 thread_id（event-route.ts:499）

```typescript
thread_id: session.thread_id,
```

问题：event 投递给 Lead 时，thread_id 可能是 stale 的。

### 4. SOUL.md 无验证指引（SOUL.md:88-93）

SOUL.md 告诉 Agent："If `thread_id` exists: append link"，没有提到需要先验证。

## 修复方案对比

### 方案 A: Bridge 侧验证（推荐）

在 Bridge 侧验证 thread 存在性，使 API 消费者（Lead Agent）无需关心。

**修改点**：
1. **ForumPostCreator**: 继承 thread 前调 Discord API `GET /channels/{thread_id}` 验证。如 404 → 清理旧记录，创建新 thread
2. **GET /api/sessions/:id**: 返回 `thread_valid` 字段（或在 fallback 时也做 Discord 验证）
3. **Hook payload**: 添加 `thread_valid` 字段，基于 ForumPostCreator 创建/验证结果

**优点**：
- 单一责任 — Bridge 是 thread 管理者，验证逻辑集中
- Agent 无需改动 SOUL.md/TOOLS.md
- 所有消费者自动受益

**缺点**：
- ForumPostCreator 增加 Discord API 调用（每次 session_started 时验证一次）
- GET /api/sessions 如果做实时验证会增加延迟

### 方案 B: Agent 侧验证

在 SOUL.md 中要求 Agent 先 GET thread 确认存在。

**修改点**：
- SOUL.md: 添加 "先 GET /api/thread/{thread_id} 确认 found:true 再构建链接"
- TOOLS.md: 补充 thread 验证文档

**优点**：简单，无 Bridge 代码改动

**缺点**：
- 每个 Agent 都要学会验证（多 Lead = 多个需改的 agent 文件）
- Agent 不一定每次都执行（LLM 行为不可靠）
- 根因未修 — stale thread 仍在数据库中

### 方案 C: 混合（推荐最终方案）

Bridge 侧做 thread 继承验证 + 添加 `thread_valid` 提示；Agent 侧 SOUL.md 更新为防御性检查。

1. **ForumPostCreator.ensureForumPost()**: 继承 thread 前 Discord API 验证。404 → 删旧记录 + 创新 thread
2. **GET /api/sessions/:id**: 添加 `thread_valid` 字段（基于本地 `conversation_threads.archived_at` 状态，不做实时 API 调用）
3. **SOUL.md**: 更新为 "if `thread_id` exists AND `thread_valid` is not false: append link"
4. **不动 hook payload** — hook 已有 `forum_tag_update_result: "no_thread"` 作为信号

## 推荐方案

**方案 C（混合）**。关键点：

- ForumPostCreator 是 thread 创建/继承的唯一入口，在这里验证最准确
- Discord API 验证只在 `session_started` 时触发一次，不是每次查询
- `thread_valid` 字段让 GET API 消费者知道 thread 状态，不增加查询延迟
- SOUL.md 只需小改动作为防御层

## 技术细节

### Discord API 验证

```
GET https://discord.com/api/v10/channels/{thread_id}
Authorization: Bot {token}
```

- 200 → thread 存在
- 404 (10003 Unknown Channel) → thread 已删除
- 其他错误 → 按存在处理（fail-open，不因 API 抖动阻塞创建）

### conversation_threads 表

现有字段：`thread_id, channel, issue_id, summary, last_updated, archived_at, cleanup_notified_at`

不需要新增列 — 可复用 `archived_at`：当 Discord 验证 404 时 set `archived_at = now()`，ForumPostCreator 看到 `archived_at` 不 null 就跳过继承。

## 影响范围

| 文件 | 改动 |
|------|------|
| `ForumPostCreator.ts` | 验证 thread 存在性 |
| `tools.ts` | GET session 添加 `thread_valid` |
| `StateStore.ts` | 可能无需改（复用 archived_at） |
| `product-lead-SOUL.md` | 更新 Forum link 构建规则 |
| `product-lead-TOOLS.md` | 文档更新 thread_valid |
| Tests | ForumPostCreator 验证测试 + API 响应测试 |

## 未解决问题

- hook payload 是否也需 `thread_valid`？→ 不需要，ForumPostCreator 在 session_started 时已验证/修复，后续 hook 拿到的 thread_id 是验证过的
- 是否需要定期扫描所有 thread？→ 不需要，GEO-270 stale session patrol 已有清理机制
