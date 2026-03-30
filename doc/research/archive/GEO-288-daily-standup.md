# Research: Daily Standup Implementation — GEO-288

**Issue**: GEO-288
**Date**: 2026-03-28
**Source**: `doc/exploration/new/GEO-288-daily-standup.md`

## Research Questions

1. 现有 Bridge 中定时任务的模式是什么？如何复用？
2. Linear 查询需要哪些新能力？
3. Discord 消息投递的最佳模式？
4. 数据聚合需要哪些 StateStore 查询？

## Findings

### 1. 定时任务模式 — HeartbeatService

HeartbeatService 是现有的 interval-based checker:
- `setInterval()` 定期触发 `check()`
- `start()` / `stop()` 生命周期
- 去重机制（`notifiedStuck` / `notifiedOrphans` / `notifiedStale` Set）
- `lastStaleCheckAt` 时间戳避免频繁检查

**StandupScheduler 可以复用这个模式**:
- `setInterval()` 每 30 分钟检查是否到了 standup 时间
- `lastStandupDate` 记录上次触发日期，避免同一天重复触发
- `start()` / `stop()` 生命周期

### 2. Linear 查询 — 已有 GET /api/linear/issues

Bridge 已有 `GET /api/linear/issues` endpoint (GEO-276):
- 支持 `project`, `state`, `labels`, `limit` 过滤
- 返回 `id`, `identifier`, `title`, `priority`, `priorityLabel`, `state`, `stateType`, `labels`, `assignee`, `url`

**Standup 需要的查询**:
- Triage issues: `state=triage`
- Backlog issues: `state=backlog`
- Started/In-progress issues: `state=started`
- 所有这些 Bridge 内部可以直接用 LinearClient 查询，不需要走 HTTP

但为了保持 standup endpoint 的独立性和可测试性，**直接内部调用 LinearClient** 更高效，避免自己调自己的 HTTP。

### 3. Discord 消息投递

两种模式:
1. **Control channel delivery** (ClaudeDiscordRuntime.deliver) — 发给 Lead 的私有控制 channel
2. **Direct Discord REST** (scan-stale pattern) — 直接发到 chatChannel/generalChannel

Standup 应该发到 **generalChannel** (#geoforge3d-core)，因为:
- 这是所有 Lead + Annie 都能看到的公共频道
- Simba 负责发起，Peter/Oliver 在同一频道回应
- 不需要走 control channel（那是给 Claude Code agent 内部通信用的）

**模式**: 复用 scan-stale 的 Discord REST 直发模式。

### 4. StateStore 查询

需要的数据:
- `getActiveSessions()` — running + awaiting_review
- `getRecentSessions(50)` — 过去的 sessions，过滤 24h 内完成的
- `getStuckSessions(thresholdMinutes)` — stuck sessions
- `getStaleCompletedSessions(24)` — stale sessions

**已有方法全部覆盖，无需新增 StateStore 查询。**

### 5. 配置方案

Bridge 目前的配置来源:
1. 环境变量 → `BridgeConfig`（在 `plugin.ts` / `startBridge()`）
2. `projects.json` → `ProjectEntry[]`

Standup 配置应通过环境变量:
- `STANDUP_HOUR` — 目标小时 (0-23, default 8)
- `STANDUP_ENABLED` — 开关 (default "true")
- `STANDUP_LEAD_ID` — 发送者 Lead ID (default: 项目中标记为 cos-lead 的 agent)

generalChannel 已在 ProjectEntry 中存在。

### 6. Report 格式

Standup report 应该是 Discord Markdown，参考 scan-stale 的格式:
```markdown
## Daily Standup — 2026-03-28

### System Status
- Active Runners: 2/3
- Stuck: 0 | Stale: 1

### Yesterday's Completions (3)
1. **GEO-123** — Feature X [completed]
2. **GEO-124** — Fix Y [completed]
3. **GEO-125** — Refactor Z [approved]

### Blockers (1)
1. **GEO-126** — Integration test failure [failed] — Error: timeout

### Backlog Triage (5 issues)
| Priority | Issue | Title | Labels |
|----------|-------|-------|--------|
| Urgent | GEO-127 | ... | Product |
| High | GEO-128 | ... | Ops |

### Suggested Actions
@Peter 请关注 GEO-127 (Urgent product issue)
@Oliver 请检查 GEO-126 的失败原因
```

## Conclusion

技术上完全可行，主要复用现有模式:
- **定时**: 复用 HeartbeatService 的 interval 模式
- **数据**: StateStore 现有查询 + LinearClient 直接查
- **投递**: 复用 scan-stale 的 Discord REST 直发模式
- **配置**: 环境变量，与 Bridge 其他配置一致

无需新增外部依赖（不需要 node-cron，interval timer + date check 足够）。
