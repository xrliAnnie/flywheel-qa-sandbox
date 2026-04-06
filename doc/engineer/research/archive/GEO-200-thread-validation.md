# Research: Thread Validation Patterns — GEO-200

**Issue**: GEO-200
**Date**: 2026-03-30
**Source**: `doc/engineer/exploration/new/GEO-200-forum-thread-link-unknown.md`

## 关键发现

### 1. `getThreadByIssue()` 不过滤 archived_at

```sql
SELECT thread_id, channel FROM conversation_threads WHERE issue_id = ?
```

`archived_at` 字段只被 `getEligibleForCleanup()` 使用。Thread 继承和 session fallback 都不检查 `archived_at`，导致已删除/归档的 thread 仍被复用。

### 2. 现有的 archived_at 机制

| 方法 | 用途 |
|------|------|
| `markArchived(threadId)` | 设置 `archived_at = now()` |
| `markCleanupNotified(threadId)` | 设置 `cleanup_notified_at = now()` |
| `clearArchived(threadId)` | 清除 archived_at + cleanup_notified_at |
| `getEligibleForCleanup()` | 查询 `archived_at IS NULL` 的完成 thread |

可以复用 `archived_at` 语义：archived_at 不为 NULL 的 thread 不应被继承。

### 3. Discord Thread 验证 API

```
GET https://discord.com/api/v10/channels/{thread_id}
Authorization: Bot {token}
```

| 状态码 | 含义 | 处理 |
|--------|------|------|
| 200 | Thread 存在 | 继承 |
| 404 | Thread 已删除 | markArchived → 创新 thread |
| 403 | Bot 无权限 | fail-open，继承 |
| 429 / 5xx | Rate limit / 服务错误 | fail-open，继承 |

### 4. ForumPostCreator 是唯一的 thread 创建入口

所有 thread 创建通过 `ForumPostCreator.ensureForumPost()`。验证逻辑放这里最合适 — 每个 session_started 只触发一次，不影响查询性能。

### 5. event-route.ts clearArchived 调用

```typescript
// event-route.ts:193-195
store.clearArchived(existingThread.thread_id);
```

当 session_started 事件到达时，如果 issue 有已知 thread，会 `clearArchived` 重新激活。这与我们的修复兼容 — 只要 ForumPostCreator 先验证再决定是否继承。

## 修复策略

最小改动路径：

1. **`getThreadByIssue()`** 添加 `WHERE archived_at IS NULL` — 防止返回已归档 thread
2. **ForumPostCreator** 继承前用 Discord API 验证 thread 存在 — 404 时 `markArchived()` + 创新 thread
3. **GET /api/sessions/:id** 无需改动 — 因为 `getThreadByIssue()` 已过滤，fallback 自然正确
4. **SOUL.md** 小改 — 添加 "如果 thread_id 为空，说明尚未创建 Forum Post" 提示

不需要 `thread_valid` 字段 — 通过源头修复（ForumPostCreator 验证 + getThreadByIssue 过滤），所有下游消费者自动获得正确数据。
