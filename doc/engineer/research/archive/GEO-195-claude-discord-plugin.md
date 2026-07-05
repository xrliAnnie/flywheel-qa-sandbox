# Research: Claude Discord Plugin as Lead Runtime — GEO-195

**Issue**: GEO-195
**Date**: 2026-03-21
**Source**: `doc/engineer/exploration/new/GEO-195-claude-discord-plugin.md`

---

## 研究方法

4 个并行研究 agent，分别调查：
1. Discord Plugin 源码分析
2. Claude Code `--channels` 模式行为
3. Bridge 代码库扩展可行性
4. 进程管理 / supervisor 方案

---

## 1. Discord Plugin 能力验证

### 1.1 Multi-Channel 支持

**确认支持。** Plugin 用 Discord.js 注册 `GuildMessages` + `DirectMessages` intents，`messageCreate` handler 接收所有 guild 消息。通过 `access.json` 的 `groups` 对象按 channel ID 控制哪些 channel 被监听。多个 channel 同时 opt-in 只需添加多个 entry。

配置示例（`~/.claude/channels/discord/access.json`）：
```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["<ceo-user-id>"],
  "groups": {
    "<chat-channel-id>": { "requireMention": false, "allowFrom": [] },
    "<control-channel-id>": { "requireMention": false, "allowFrom": [] }
  }
}
```

**结论**：一个 Lead session 可以同时监听 chat channel + control channel。Exploration 中的保守假设可以放宽。

### 1.2 Forum Thread 能力

**不支持创建。** Plugin 只有 5 个 tools：`reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`。无法创建 forum thread（需要 `ForumChannel.threads.create()`）。

但 **可以向已有 thread 发消息** — 如果 `chat_id` 是 thread 的 channel ID，`reply` 可以 post 进去。

**结论**：Forum thread 创建和生命周期管理必须留在 Bridge。Plugin 可以在已有 thread 里回复。

### 1.3 消息路由

每条消息携带的 metadata：
```typescript
{
  chat_id: "<channel-snowflake>",     // thread 的 own ID，不是 parent
  message_id: "<message-snowflake>",
  user: "<username>",
  user_id: "<user-snowflake>",
  ts: "<ISO 8601>",
  attachment_count?: "<number>",
  attachments?: "<name (type, size); ...>"
}
```

**注意**：不含 guild ID，不含 parent channel ID。Claude 无法从 metadata 判断消息来自 forum thread 还是普通 text channel。但可以通过 `chat_id` 区分不同 channel。

### 1.4 Access 配置 Schema

```json
{
  "dmPolicy": "pairing" | "allowlist" | "disabled",
  "allowFrom": ["<user-snowflake>"],
  "groups": {
    "<channel-snowflake>": {
      "requireMention": true,       // default: true
      "allowFrom": []               // empty = any member
    }
  },
  "mentionPatterns": ["regex"],
  "ackReaction": "emoji",
  "replyToMode": "first" | "all" | "off",
  "textChunkLimit": 2000,
  "chunkMode": "length" | "newline"
}
```

配置文件每条消息都会重新读取（除非 `DISCORD_ACCESS_MODE=static`），修改即时生效无需重启。

---

## 2. Claude Code `--channels` 模式

### 2.1 Session 生命周期

- **无 daemon 模式** — 前台进程，需要 tmux/screen/pm2 包装
- **CLI 无 idle timeout** — 进程存活就持续运行（Desktop 有 300s timeout，CLI 没有）
- **无消息队列** — session 关闭期间的 Discord 消息不会主动投递，但可通过 `fetch_messages` 追赶（最多 100 条）

### 2.2 Context Compaction

- 与普通 Claude Code session 完全相同
- **~83.5% context window** 触发自动 compaction
- 1M context（Opus 4.6 / Sonnet 4.6）下 compaction 频率降低 15%
- **CLAUDE.md 存活 compaction**，对话历史中的旧消息可能丢失
- 可用 `/compact focus on X` 引导 summarization

**对长期运行的影响**：Channel 消息持续填入 context，最终触发 compaction。早期 channel 消息和 Claude 回复可能被 compacted away。CLAUDE.md 是维持持久上下文的主要机制。

### 2.3 Token 消耗

**Idle 成本几乎为零。** API 只在收到消息时被调用。

消耗来源：
1. 收到 channel 消息时处理（主要消耗）
2. 背景 summarization（`--resume` 用，~$0.04/session）
3. MCP tool definitions overhead（每次 API call 都带）

**不是按时间计费** — idle session 不消耗 tokens。

### 2.4 Multiple Channels

**确认支持**：
```bash
claude --channels plugin:discord@claude-plugins-official plugin:telegram@claude-plugins-official
```

每个 plugin 作为独立 MCP server subprocess 运行。所有 channel 消息汇入同一 session context，通过 `<channel source="...">` tag 区分来源。

### 2.5 CLAUDE.md 和 Memory

- **CLAUDE.md**：正常加载，是长期运行 session 的主要持久上下文机制
- **Auto-memory (MEMORY.md)**：前 200 行加载
- **Skills / Agents / MCP servers**：全部正常可用
- **Channel plugin 的 `instructions` 字段**：注入 system prompt

### 2.6 Crash Recovery

- **Session transcript 持久化**为本地 `.jsonl` 文件
- **`claude --continue --channels discord`** 可恢复最近 session 上下文
- **Channel 连接不自动恢复** — 重启 = 新的 Discord bot 连接
- **已知问题**：50MB+ transcript / 200+ subagent 的大 session resume 可能 freeze

### 2.7 Subagent 支持

**完全支持。** Channels session 可以 spawn subagents：
- Subagent 有独立 context window — 不会膨胀主 session
- 支持前台和后台运行
- 背景 subagent 自动拒绝未预批准的 permissions
- **推荐模式**：收到 channel 消息触发重活时，delegate 给 subagent

### 2.8 Permission 阻塞

**关键限制**：Permission prompt 会阻塞整个 session，直到本地终端批准。

无人值守方案：`--dangerously-skip-permissions`（仅限可信环境）。

### 2.9 Research Preview 状态

- v2.1.80+ (2026-03-20 发布)
- 仅限 allowlisted plugins
- API 可能在 Q2-Q3 2026 变化

---

## 3. Bridge 扩展可行性

### 3.1 现有 Discord 能力

Bridge 目前只有一个 Discord API 调用：

- `/api/forum-tag` — `PATCH /channels/{thread_id}` 设置 `applied_tags`
- 使用 `config.discordBotToken`
- 3s timeout，best-effort

### 3.2 事件路由现状

`event-route.ts` 处理 3 种核心事件：

| 事件 | 处理 |
|------|------|
| `session_started` | 存 labels，FSM → running，继承已有 thread |
| `session_completed` | 提取 decision.route，存 metadata，CIPHER 写入 |
| `session_failed` | 设 status → failed，存 last_error |

通知通过 `notifyAgent()` 发送到 OpenClaw — **fire-and-forget，3s timeout**。

已有 multi-lead 路由（GEO-152）：`resolveLeadForIssue()` 按 label 匹配。

### 3.3 Action API

5 个 action：`approve`（含 git push + PR merge）、`retry`（含 IRetryDispatcher）、`reject`、`defer`、`shelve`。

Post-action hook 发送 `action_executed` 事件给 OpenClaw。

### 3.4 State Store Schema

**`sessions` 表**：execution_id (PK), issue_id, status, started_at, last_activity_at, heartbeat_at, decision_route, commit_count, lines_added/removed, diff_summary, issue_labels, retry lineage, thread_id...

**`session_events` 表**：event log (event_id, execution_id, event_type, payload JSON)

**`conversation_threads` 表**：Discord thread ↔ issue 映射

**Bootstrap readiness**：
- ✅ `getActiveSessions()` — running + awaiting_review
- ✅ `getRecentSessions(limit)` — 最近 activity
- ✅ `getStuckSessions(threshold)` — 卡住的 session
- ⚠️ 缺少：event_seq（有序投递）、per-lead ack offset（replay）

### 3.5 LeadRuntime 抽象可行性

**非常高。** 关键证据：

1. `notifyAgent()` 是独立函数，可轻松替换实现
2. `HeartbeatNotifier` interface 已存在（`HeartbeatService.ts:13-19`），是 pluggable notification 的先例
3. `BridgeConfig` 已可扩展（加 `leadRuntimeType`）

**提议 interface：**
```typescript
interface LeadRuntime {
  deliver(event: LeadEventEnvelope): Promise<void>;
  sendBootstrap(snapshot: LeadBootstrap): Promise<void>;
  health(): Promise<LeadRuntimeHealth>;
  shutdown(): Promise<void>;
}
```

**最小改动**：~200 LOC interface + 2 implementations

### 3.6 ForumManager 扩展

Discord REST API 完全支持 thread 管理：
- ✅ 创建 thread：`POST /channels/{parent_id}/threads`
- ✅ 更新 thread 名称：`PATCH /channels/{thread_id}`
- ✅ 归档 thread：`PATCH /channels/{thread_id}` + `archived: true`
- ✅ 设置 tags：已实现
- ✅ 发消息到 thread：`POST /channels/{thread_id}/messages`

**需要新增**：
- Thread 创建模板
- Thread 生命周期 FSM
- Message 模板（摘要更新）
- Tag mapping 策略

### 3.7 工程量估算

| Component | 位置 | 估算 |
|-----------|------|------|
| LeadRuntime interface | 新 `bridge/interfaces.ts` | Trivial |
| OpenClawRuntime adapter | 提取 `hook-payload.ts` | 1h |
| ClaudeDiscordRuntime | 新 `bridge/claude-discord-runtime.ts` | 2h |
| Bootstrap generator | 新 `bridge/bootstrap-generator.ts` | 2h |
| event_seq + ack tracking | `StateStore.ts` migration | 2h |
| ForumManager 扩展 | 新 `bridge/forum-manager.ts` | 3h |
| Runtime config | `config.ts` + `plugin.ts` | 1h |

**总计**：~600 LOC 新代码 + ~150 LOC 修改。约 11h 工作量。

---

## 4. Supervisor 方案对比

### 推荐分层策略

| 阶段 | 方案 | 理由 |
|------|------|------|
| **立即（macOS 开发）** | **pm2** | 最佳 DX，logging 优秀，`pm2 startup` 生成 launchd plist |
| **未来（Linux VPS）** | **systemd user service** | 最佳 restart 控制，`ExecStartPre` 原生 bootstrap hook |
| **深度集成（后期）** | **tmux + watchdog** | 复用 Flywheel 已有 TmuxAdapter，与 StateStore/Bridge 深度集成 |

### 详细对比

| 标准 | pm2 | launchd | systemd | Custom TS | tmux+watchdog |
|------|-----|---------|---------|-----------|---------------|
| 安装复杂度 | 低 | 中 | 低-中 | 中-高 | 低-中 |
| Restart 可靠性 | 好 | 风险（exp backoff） | 优秀 | 好（手写） | 好 |
| Log 管理 | 优秀 | 差 | 优秀 | 需自建 | 中 |
| Bootstrap 注入 | Wrapper script | Wrapper script | ExecStartPre | **最佳** | 好 |
| macOS 支持 | ✅ (via launchd shim) | ✅ 原生 | ❌ | ✅ | ✅ |
| Linux VPS | ✅ | ❌ | ✅ | ✅ | ✅ |
| Flywheel 集成 | 低 | 低 | 低 | **高** | **高** |

### Bootstrap 注入策略（通用）

无论选哪个 supervisor，restart 后的恢复流程：

1. 发 Discord webhook 到 control channel："Session restarted, catching up..."
2. 启动 `claude --continue --channels discord`（恢复最近 session context）
3. Claude 首先调 `fetch_messages` 追赶 missed 消息（最多 100 条）
4. 可选：传 initial prompt 引导恢复行为

---

## 5. 关键发现总结

### 确认可行

| 项目 | 结论 | 信心 |
|------|------|------|
| Multi-channel 监听 | ✅ 一个 session 可同时听多个 guild channel | 高（源码验证） |
| Idle token 成本 | ✅ 几乎为零 | 高（官方文档确认） |
| Subagent 委派 | ✅ channels session 完全支持 Agent tool | 高（官方文档确认） |
| CLAUDE.md 持久上下文 | ✅ 正常加载，存活 compaction | 高 |
| LeadRuntime 抽象 | ✅ Bridge 代码结构已支持 | 高（代码验证） |
| A/B 并行可行 | ✅ adapter pattern + 按 lead 切流 | 高 |

### 确认不可行 / 需自建

| 项目 | 结论 | 影响 |
|------|------|------|
| Forum thread 创建 | ❌ Plugin 不支持 | Bridge 必须自建 ForumManager |
| Daemon 模式 | ❌ 无内置 | 需外部 supervisor（pm2） |
| Permission 自动批准 | ❌ 会阻塞 session | 需 `--dangerously-skip-permissions` |
| 消息队列 | ❌ 无内置 | 依赖 `fetch_messages` 追赶 + Bridge event journal |

### 需要注意的风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Research preview — API 可能变化 | 中 | adapter pattern 隔离影响 |
| 大 session resume freeze | 中 | 定期 `/compact`，限制 transcript 大小 |
| Context compaction 丢失早期 channel 消息 | 中 | 关键状态存 CLAUDE.md / Bridge，不依赖 session memory |
| Permission 阻塞 | 高 | `--dangerously-skip-permissions` + 严格 CLAUDE.md 约束 |

---

## 6. 对 Exploration 结论的修正

基于研究结果，对 exploration doc 的修正：

1. **Multi-channel 从"未验证"升级为"已验证"** — 一个 session 可以同时监听 chat + control channel
2. **Idle 成本从"不透明"修正为"几乎为零"** — 只有消息到来时消耗 token
3. **新增关键限制：Permission 阻塞** — exploration 未提及，这是 autonomous operation 的主要障碍
4. **Supervisor 方案明确**：MVP 用 pm2，后期考虑 tmux + watchdog 深度集成
5. **工程量量化**：~600 LOC 新代码，约 11h 工作量
6. **Bootstrap 策略明确**：`--continue` + `fetch_messages` + Discord webhook
7. **Research preview 风险**：API 可能变化，需要 adapter pattern 隔离

---

## 7. MVP 实施建议（基于研究）

### Phase 1: 最小验证（~2 天）

1. 手动启动 `claude --channels plugin:discord` session
2. 在 `access.json` 配置 chat + control 两个 channel
3. 从 Bridge 通过 Discord webhook 发结构化事件到 control channel
4. 验证 Lead session 能否正确处理事件 + 与 CEO 对话
5. 验证 `fetch_messages` 追赶能力

### Phase 2: Bridge 扩展（~3 天）

1. 定义 `LeadRuntime` interface
2. 提取 `OpenClawRuntime`（不改变现有行为）
3. 实现 `ClaudeDiscordRuntime`（发 Discord webhook 到 control channel）
4. 添加 runtime config 支持 A/B 切换

### Phase 3: 可靠性（~2 天）

1. pm2 supervisor 配置
2. Bootstrap webhook + `--continue` 恢复
3. Event journal + ack tracking
4. ForumManager 基础版（thread 创建）

### 前置依赖

- **GEO-198**: mem0 记忆层归属修正（runner → Lead）
