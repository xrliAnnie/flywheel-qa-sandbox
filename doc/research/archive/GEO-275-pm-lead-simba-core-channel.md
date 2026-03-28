# Research: PM Lead Simba + Core Channel — GEO-275

**Issue**: GEO-275
**Date**: 2026-03-27
**Source**: `doc/exploration/new/GEO-275-pm-lead-simba-core-channel.md`

---

## 研究目标

验证 Exploration 中的设计方案在现有代码库中的可行性，重点回答：

1. Bridge 能否处理没有 forumChannel 的 Lead？
2. Discord 设置流程是否支持 Core Channel？
3. 需要哪些代码修改？

---

## 发现 1: forumChannel 是 REQUIRED — 需要修改

### 类型定义

`packages/teamlead/src/ProjectConfig.ts` line 7:
```typescript
export interface LeadConfig {
  agentId: string;
  forumChannel: string;      // ← REQUIRED（无 ?）
  chatChannel: string;       // ← REQUIRED（无 ?）
  match: { labels: string[] };
  runtime?: "openclaw" | "claude-discord";
  controlChannel?: string;   // optional ✅
  statusTagMap?: Record<string, string[]>;  // optional ✅
  botTokenEnv?: string;      // optional ✅
  botToken?: string;         // optional ✅
}
```

### 加载时验证（会 throw）

`ProjectConfig.ts` lines 103-110:
```typescript
if (typeof lead.forumChannel !== "string" || lead.forumChannel.length === 0) {
  throw new Error(`...leads[${i}].forumChannel: must be a non-empty string`);
}
```

**结论**: 不改代码就无法加载没有 forumChannel 的 Lead。

### 运行时访问点（均无 null guard）

| 文件 | 行 | 代码 | 风险 |
|------|-----|------|------|
| DirectEventSink.ts | 216 | `lead.forumChannel` fallback | undefined → 无效 channel ID |
| HeartbeatService.ts | 224 | `resolved.lead.forumChannel` fallback | 同上 |
| actions.ts | 78 | `lead.forumChannel` fallback | 同上 |
| event-route.ts | 206 | `fpLead.forumChannel` passed to ForumPostCreator | Discord API 400 |
| ForumPostCreator.ts | 65-72 | URL 构造用 `ctx.forumChannelId` | URL malformed |

### 安全的代码（不需 forumChannel）

| 模块 | 状态 |
|------|------|
| Bootstrap Generator | ✅ 不访问 forumChannel |
| lead-scope.ts | ✅ 不访问 forumChannel |
| RuntimeRegistry | ✅ 不访问 forumChannel |
| ClaudeDiscordRuntime | ✅ 只用 controlChannel |
| RunDispatcher | ✅ 不访问 forumChannel |
| ForumTagUpdater | ✅ statusTagMap 已是 optional，有 fallback |

### 推荐修改方案

**Option 1: 使 forumChannel optional（推荐）**

```typescript
// ProjectConfig.ts
forumChannel?: string;  // 改为 optional
chatChannel?: string;   // Simba 用 core channel 替代，也改 optional
```

在所有访问点加 guard:
```typescript
// 每个 fallback 处
const forumChannel = existingThread?.channel ?? lead.forumChannel;
if (!forumChannel) { /* skip forum operations */ }
```

工作量: ~6 处 guard，低风险，改动集中。

**Option 2: 给 Simba 设 dummy forumChannel**

不推荐 — 违反 "explicit is better than implicit"，dummy 值可能导致意外 Discord API 调用。

---

## 发现 2: chatChannel 也需要考虑

Simba 的 "chatChannel" 是 core channel（共享的）。当前 `chatChannel` 在类型中也是 required。

但 Simba 确实有 chatChannel — 就是 core channel ID。所以 chatChannel 可以保留 required，Simba 填 core channel ID 即可。

这意味着: Peter/Oliver 的 chatChannel 保持各自独立，Simba 的 chatChannel = core channel。Core channel 中 Simba 收到消息并用 NLP 路由判断是否回复。

---

## 发现 3: Discord 设置流程完善

`/setup-discord-lead` skill 提供 9 步流程：

1. 创建 Discord Application + Bot
2. 设置 Disney 角色头像（Simba = The Lion King）
3. 邀请 Bot 到 Server（权限 277025459264）
4. 创建 DISCORD_STATE_DIR (`~/.claude/channels/discord-pm-lead/`)
5. 保存 Token 到 `~/.flywheel/.env`
6. 清理 default state dir
7. 创建 Control Channel（可选）
8. 创建 Agent File
9. 更新 projects.json + 启动测试

**Simba 特殊需求**：
- 步骤中需额外创建 #geoforge3d-core channel
- Peter/Oliver 的 access.json 需添加 core channel
- Simba 的 access.json 需包含 core + control

---

## 发现 4: Core Channel 路由零基础设施改动

NLP 路由完全在 agent.md prompt 层实现。验证点：

1. **Claude Discord Plugin 行为**: 每个 bot 收到所在 channel 的所有消息。Plugin 层不做 mention 过滤 — 由 agent prompt 决定是否回复。
2. **access.json `requireMention`**: 现有配置均为 `false`。Core channel 也应设为 `false`，让 agent prompt 自行判断。
3. **多 bot 竞争**: 三个 bot 都在 core channel，都收到消息，各自决定回复与否。这是设计意图。

---

## 发现 5: claude-lead.sh 无需修改

启动脚本已支持任意 lead-id：

```bash
./scripts/claude-lead.sh pm-lead /path/to/geoforge3d geoforge3d
```

- DISCORD_STATE_DIR 自动用 `~/.claude/channels/discord-pm-lead/`
- Agent file 从 `{project}/.lead/pm-lead/agent.md` 同步到 `~/.claude/agents/pm-lead.md`
- Workspace 用 `~/.flywheel/lead-workspace/pm-lead/`
- flywheel-comm 可选（Simba 不需要也没问题）

---

## 修改清单

### Flywheel Repo 修改（需 PR）

| # | 文件 | 修改 | 风险 |
|---|------|------|------|
| 1 | `ProjectConfig.ts` (type) | `forumChannel?: string` | Low — 仅 type 改动 |
| 2 | `ProjectConfig.ts` (validation) | 移除 forumChannel 非空检查，改为存在时验证 | Low |
| 3 | `DirectEventSink.ts:216` | 加 `if (!forumChannel) return;` guard | Low |
| 4 | `HeartbeatService.ts:224` | 加 guard | Low |
| 5 | `actions.ts:78` | 加 guard | Low |
| 6 | `event-route.ts:206` | 加 `if (!fpLead.forumChannel)` skip ForumPostCreator | Low |
| 7 | `projects.json` | 添加 pm-lead 条目（无 forumChannel） | Low |

### GeoForge3D Repo 修改（需 PR）

| # | 文件 | 修改 |
|---|------|------|
| 8 | `.lead/pm-lead/agent.md` | 新建 — Simba 身份 + triage 行为 |
| 9 | `.lead/pm-lead/TOOLS.md` | 新建 — Bridge API + Lead channel IDs |
| 10 | `.lead/product-lead/agent.md` | 添加 core channel 路由规则 |
| 11 | `.lead/ops-lead/agent.md` | 添加 core channel 路由规则 |

### 手动操作（非代码）

| # | 操作 |
|---|------|
| 12 | Discord: 创建 Simba bot application + 设头像 |
| 13 | Discord: 创建 #geoforge3d-core text channel |
| 14 | Discord: 创建 #pm-lead-control hidden channel |
| 15 | Discord: 邀请 Simba bot 到 server |
| 16 | Discord: 确保 Peter/Oliver bot 有 core channel 权限 |
| 17 | `~/.flywheel/.env`: 添加 `SIMBA_BOT_TOKEN` |
| 18 | `~/.claude/channels/discord-pm-lead/`: 创建 access.json + .env |
| 19 | Peter access.json: 添加 core channel |
| 20 | Oliver access.json: 添加 core channel |

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| forumChannel optional 改动引入回归 | Low | Medium | 充分测试现有 Peter/Oliver 流程 |
| 多 bot 同时回复 core channel | Medium | Low | 可接受，观察后调整 prompt |
| Simba 误回复不该回复的消息 | Medium | Low | Channel 隔离 + prompt 强化 |
| Core channel 消息过多干扰各 Lead | Low | Medium | 各 Lead 只关注叫到自己的消息 |

---

## 结论

GEO-275 技术可行，主要工作分两类：

1. **Flywheel Bridge 改动**（~7 处小改动）：使 forumChannel optional，加 null guards
2. **配置 + Agent 文件**（~10 个文件）：Discord setup + agent.md + access.json

不需要修改: claude-lead.sh, EventFilter, RuntimeRegistry, Bootstrap, RunDispatcher, lead-scope.ts
