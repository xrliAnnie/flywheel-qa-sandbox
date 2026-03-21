# Research: Discord Migration Technical Feasibility — GEO-163

**Issue**: GEO-163
**Date**: 2026-03-15
**Source**: `doc/exploration/new/GEO-163-slack-discord-migration.md`

---

## 1. sql.js SQLite RENAME COLUMN 支持

### 结论：✅ 安全可用

| 项目 | 值 |
|------|-----|
| Flywheel 使用的 sql.js 版本 | `1.14.1`（`packages/teamlead/package.json`） |
| sql.js 1.14.1 内置 SQLite 版本 | **3.49+** |
| `ALTER TABLE RENAME COLUMN` 最低要求 | SQLite 3.25.0（2018-09-15） |

sql.js 1.14.1 远超最低版本要求，`RENAME COLUMN` 功能已稳定 6+ 年。

### Migration 策略

直接在 `StateStore.migrate()` 中使用：

```typescript
// sessions 表: slack_thread_ts → thread_id
try {
    this.db.run("ALTER TABLE sessions RENAME COLUMN slack_thread_ts TO thread_id");
} catch { /* already renamed or column doesn't exist */ }

// conversation_threads 表: thread_ts → thread_id
try {
    this.db.run("ALTER TABLE conversation_threads RENAME COLUMN thread_ts TO thread_id");
} catch { /* already renamed */ }
```

**无需 create-copy-drop-rename 回退方案。**

---

## 2. Discord Forum Channel API

### 2.1 Channel 类型

Discord Forum Channel = channel type **15**（REST API v10+）。

### 2.2 创建 Forum Post

```http
POST /channels/{forum_channel_id}/threads
Content-Type: application/json

{
  "name": "[GEO-155] Disable auto-approve",
  "message": {
    "content": "Initial post content"
  },
  "applied_tags": ["tag_id_1", "tag_id_2"]
}
```

Response 返回 thread snowflake ID（用于后续所有回复）：
```json
{
  "id": "thread_snowflake_id",
  "parent_id": "forum_channel_id",
  "name": "[GEO-155] ...",
  "applied_tags": [...]
}
```

### 2.3 回复 Forum Post

Forum Post **就是** thread，回复方式和 text channel thread 相同：

```http
POST /channels/{thread_id}/messages
Content-Type: application/json

{"content": "Reply in thread"}
```

### 2.4 Forum Tags

- Tags 需要在 Discord UI（或 API）**预先创建**
- Bot 只能 apply 已有的 tag ID
- 通过 `GET /channels/{channel_id}` 返回 `available_tags` 数组
- 通过编辑 thread 修改 `applied_tags` 更新状态

计划 tags：`reviewing`, `approved`, `blocked`, `merged`, `failed`

### 2.5 Text Channel vs Forum Channel

| 特性 | Text Channel | Forum Channel |
|------|-------------|---------------|
| Thread 创建 | 手动 | 自动（每个 post = thread） |
| Auto-archive | 无 | 有（可配 24h/3d/7d） |
| Tag 支持 | 无 | 有 |
| Overview | 消息流 | Post 列表（看板视图） |
| Typing indicator | 在 channel 显示 | 在 thread 内显示 |

### 2.6 Bot 权限需求

| Permission | 是否必需 | 用途 |
|-----------|----------|------|
| `SEND_MESSAGES` | 必需 | 回复 thread |
| `MANAGE_THREADS` | 必需 | 创建 Forum Post / 管理 archive |
| `SEND_MESSAGES_IN_THREADS` | 必需 | 在 Forum thread 内发消息 |
| `READ_MESSAGE_HISTORY` | 建议 | 读取上下文 |
| `MANAGE_MESSAGES` | 可选 | 编辑/删除消息 |

---

## 3. OpenClaw Discord 集成

### 3.1 当前配置状态

| 配置项 | 状态 |
|--------|------|
| Discord plugin | ✅ 已启用 |
| Bot token | ✅ 已配置 |
| Guild | `1138242789382037545` (little piggy) |
| 当前 channel | `1479341196022382622` (#ideas) — **Text Channel** |
| product-lead binding | ⚠️ 绑定到 Slack，未绑定 Discord |

### 3.2 可用 Discord 工具

OpenClaw 内置以下 Discord 工具（agent 可直接使用）：

| 工具 | 功能 | Forum 支持 |
|------|------|-----------|
| `send` / `sendMessage` | 发送消息到 channel/thread | ✅ |
| `thread-create` | **创建 thread / Forum Post** | ✅ 支持 `threadName` + `appliedTags` + `content` |
| `edit` | 编辑消息 | ✅ |
| `delete` | 删除消息 | ✅ |
| `read` | 读取 channel 消息 | ✅ |
| `react` | 添加 reaction | ✅ |
| `search` | 搜索消息 | ✅ |
| `pin` / `unpin` | 固定/取消固定 | ✅ |
| `set-presence` | 设置 bot 状态 | ✅ |

### 3.3 Forum Channel 操作映射

| 操作 | OpenClaw 工具 | 参数 |
|------|---------------|------|
| 创建 Forum Post | `thread-create` | `threadName`, `content`, `appliedTags`, `autoArchiveMinutes` |
| 回复 Forum Post | `sendMessage` | target: thread ID |
| 更新 Forum Tag | `edit` (thread metadata) | `appliedTags` |
| Typing indicator | 自动 | Discord 原生支持 |

### 3.4 关键发现

**✅ OpenClaw 完全支持 Discord Forum Channel 操作**

- `thread-create` 直接支持 Forum Post 创建（带标题、内容、tags）
- 回复通过 thread ID 发送消息
- Typing indicator 由 Discord 原生处理

**⚠️ 不支持的操作**：
- 无法通过工具列出 Forum Tags（需硬编码 tag ID）
- 无法通过工具搜索 Forum Posts by tag

### 3.5 product-lead Workspace 更新需求

当前 SOUL.md 和 TOOLS.md 只定义了 Slack 工具：

```
# 当前（TOOLS.md）
- `slack:sendMessage` — 发送 Slack 消息

# 目标
- `discord:sendMessage` — 发送消息到 Discord channel/thread
- `discord:thread-create` — 创建 Forum Post
```

SOUL.md 中 13 处 Slack 引用需要更新为 Discord + Forum Post 行为。

---

## 4. 综合评估

### 4.1 技术可行性

| 维度 | 评估 | 详情 |
|------|------|------|
| SQLite migration | ✅ 无障碍 | `RENAME COLUMN` 完全支持 |
| Discord Forum API | ✅ 成熟稳定 | Type 15, 标准 REST API |
| OpenClaw Forum 工具 | ✅ 原生支持 | `thread-create` + `appliedTags` |
| Bot 权限 | ⚠️ 需确认 | 可能需要在 Discord UI 调整 |
| Tag 管理 | ⚠️ 半手动 | 预创建 tags，硬编码 ID |

### 4.2 阻塞项

**无阻塞项。** 所有技术路径都已验证可行。

### 4.3 实施建议

1. **Wave 1（代码）先行**：纯重命名 + config 提取，不依赖 Discord 环境
2. **Wave 2（配置）和 Wave 3（Discord 搭建）可并行**
3. **Forum Tag ID 获取**：创建 Forum Channel + Tags 后，通过 Discord API 获取 tag IDs，写入 SOUL.md
4. **Bot 权限**：在 Discord Developer Portal 确认 bot 有 `MANAGE_THREADS` 权限

### 4.4 SOUL.md 更新要点

| 当前行为 | 迁移后行为 |
|----------|-----------|
| `slack:sendMessage` 发消息 | `discord:sendMessage` 或 `discord:thread-create` |
| `slack:sendMessage` 带 `threadTs` = 回复 thread | 向 thread ID 发消息 |
| 创建 parent message（不带 threadTs） | `discord:thread-create` 创建 Forum Post |
| 回写 `thread_ts`（Slack timestamp） | 回写 `thread_id`（Discord snowflake） |
| `slack_thread_ts` 查询 | `thread_id` 查询 |
| Channel `CD5QZVAP6` | Forum Channel ID（TBD） |

---

## 5. 开放问题已解答

| 问题（来自 Exploration） | 答案 |
|--------------------------|------|
| OpenClaw 是否支持 Forum Post 创建？ | ✅ 是，`thread-create` 原生支持 |
| sql.js 是否支持 RENAME COLUMN？ | ✅ 是，SQLite 3.49+ 远超要求 |
| Forum Tags API？ | 预创建 + `applied_tags` 参数，无法通过工具列出 |
| Bot 权限？ | 需要 `MANAGE_THREADS` + `SEND_MESSAGES`，需在 Discord UI 确认 |
| 已有 Slack thread 数据？ | 迁移后语义失效但不需清理，新 Discord thread 从头开始 |
