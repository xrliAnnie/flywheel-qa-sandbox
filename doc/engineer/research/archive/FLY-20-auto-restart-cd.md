# Research: Auto-restart Bridge + Lead after Merge — FLY-20

**Issue**: FLY-20
**Date**: 2026-03-30
**Source**: `doc/engineer/exploration/new/FLY-20-auto-restart-cd.md`

---

## 1. Current Post-Merge Flow

### GitHub Actions (ship-on-comment.yml)
- `:cool:` comment → CI (build/typecheck/lint/test) → squash merge → 删除分支 → 成功 comment
- **无任何本地重启逻辑**

### Bridge Post-Merge (post-merge.ts)
- `approveExecution()` → `onApproved` callback → `postMergeCleanup()`
- 只做: 关 Runner tmux session + 审计 event
- **不涉及 Bridge/Lead 自身重启**

### Orchestrator (orchestrator.md Section 7)
- Worker 完成 merge 后: 归档文档 → 更新 CLAUDE.md/VERSION/MEMORY.md → 清理 worktree → 更新 Linear
- **这是 `/restart-services` skill 的最佳插入点** — 在所有 cleanup 完成后

---

## 2. Bridge API — 检查 In-flight Sessions

### `GET /health` (无需 auth)
```json
{ "ok": true, "uptime": 12345, "sessions_count": 3 }
```

### `GET /api/sessions?mode=active` (需要 Bearer token)
- 返回 status 为 `running` 或 `awaiting_review` 的 session
- 支持 `leadId` 过滤
- 响应包含 execution_id, issue_id, project_name, status, last_activity_at

### 无 "pause dispatch" API
- `retryDispatcher.stopAccepting()` 只在 SIGTERM 时内部调用
- **需要新增**: `POST /api/dispatch/pause` 和 `/resume` 端点（或在 restart script 中直接等 active count = 0）

---

## 3. Process Management

### Bridge
- 入口: `npx tsx scripts/run-bridge.ts`
- **无 PID file** — 需要通过 `pgrep` 或 launchd 管理
- SIGTERM → graceful shutdown: stop services → drain inflight → teardown runtimes → close DB → exit 0
- **关键**: Bridge exit 后无人重启（除非 launchd KeepAlive）

### Lead (claude-lead.sh)
- PID 在内存变量 `CLAUDE_PID` 中，**无 PID file**
- SIGTERM → forward to Claude child → wait → exit 0
- Supervisor loop 的 `SHOULD_EXIT=1` 阻止重启循环
- **关键**: SIGTERM 后 supervisor 彻底退出，不会自动重启

### 进程查找方式
```bash
# Bridge
pgrep -f "run-bridge.ts"

# Lead (each)
pgrep -f "claude.*--agent product-lead"
pgrep -f "claude.*--agent ops-lead"
pgrep -f "claude.*--agent cos-lead"
```

---

## 4. Discord 通知

### FetchDiscordClient (CleanupService.ts:22-76)
```typescript
POST https://discord.com/api/v10/channels/{channelId}/messages
Headers: Authorization: Bot ${botToken}
Body: { content: "message" }
```

### Bot Token 来源
- `~/.flywheel/.env` 中的 `DISCORD_BOT_TOKEN`（全局）
- Per-lead: `PETER_BOT_TOKEN`, `OLIVER_BOT_TOKEN`, `SIMBA_BOT_TOKEN`

### 消息分块
- `splitDiscordMessage()` in `discord-utils.ts` — 1900 char 安全上限

### 用于 restart 通知
- 可复用 standup 的 curl 模式，直接 POST Discord API
- 或通过 Bridge API 转发（但 Bridge 可能正在重启）
- **推荐**: restart script 直接用 curl 调 Discord API（不依赖 Bridge）

---

## 5. launchd 模式

### 现有模板 (com.flywheel.daily-standup.plist)
- Label: `com.flywheel.daily-standup`
- ProgramArguments: `/bin/bash` + 脚本绝对路径
- StartCalendarInterval: `{ Hour: 3, Minute: 0 }`
- 日志: `/tmp/flywheel-standup.log`

### 两次/天调度
```xml
<key>StartCalendarInterval</key>
<array>
    <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
</array>
```

### 环境变量
- 脚本内 `source ~/.flywheel/.env`，不用 plist EnvironmentVariables
- `set -euo pipefail` + bash array for curl

### KeepAlive 进程管理
```xml
<key>KeepAlive</key><true/>
```
- 进程 exit 后 launchd 自动重启
- 适合 Bridge 和 Lead 的长驻进程管理
- 需要 PID tracking — launchd 自动管理

---

## 6. Diff 分析 — 智能重启规则

```bash
# 获取自上次更新后的变更文件
CHANGED=$(git diff --name-only $OLD_HEAD $NEW_HEAD)
```

| 变更路径 | 重启目标 |
|---------|---------|
| `packages/teamlead/src/**` | Bridge |
| `packages/teamlead/scripts/claude-lead.sh` | 所有 Lead |
| `packages/teamlead/scripts/post-compact*` | 所有 Lead |
| `scripts/run-bridge.ts` | Bridge |
| `.lead/product-lead/**` (GeoForge3D repo) | Peter |
| `.lead/ops-lead/**` (GeoForge3D repo) | Oliver |
| `.lead/cos-lead/**` (GeoForge3D repo) | Simba |
| `doc/**`, `.claude/**`, `tests/**` | 无需重启 |
| `package.json`, `pnpm-lock.yaml` | Bridge + 所有 Lead (依赖变更) |

**注意**: `.lead/` 文件在 GeoForge3D repo 而非 Flywheel repo。FLY-20 先只覆盖 Flywheel repo 的变更。

---

## 7. 关键设计问题

### Q1: SIGTERM 后谁来重启？
- **当前**: 无人重启 — Bridge exit 后就停了，Lead supervisor exit 后也停了
- **方案 A**: restart script 自己 SIGTERM → sleep → 再启动新进程（串行）
- **方案 B**: launchd KeepAlive（推荐）— 进程 exit 后 launchd 自动重启
- **方案 C**: 修改 claude-lead.sh，区分 "restart" vs "shutdown" 信号（USR1 = restart, TERM = stop）

### Q2: Build 期间服务不可用
- `pnpm install` + `pnpm build` 通常 10-30 秒
- Bridge 停止后到新进程启动，有 downtime
- Lead 在此期间的 Discord 消息会排队，不会丢失（Discord 有 message buffer）

### Q3: 并发安全
- restart script 需要加锁（flock），防止 Orchestrator 主路径和 launchd 兜底同时触发
- 锁文件: `~/.flywheel/restart.lock`

---

## 8. 推荐架构

```
scripts/
├── restart-services.sh          # 核心重启逻辑（Orchestrator + launchd 共用）
├── update-flywheel.sh           # launchd 兜底脚本（git fetch → 调 restart-services.sh）
├── com.flywheel.updater.plist   # launchd plist (12:00 + 00:00)
└── daily-standup.sh             # 现有
```

`.claude/commands/` 或 `.claude/skills/`:
```
restart-services.md              # Orchestrator 调用的 skill
```

Orchestrator 在 ship+cleanup 最后一步调用 `/restart-services`。
