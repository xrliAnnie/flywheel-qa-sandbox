# Exploration: Stale Session 巡检 + 通知 Lead — GEO-270

**Issue**: GEO-270 (Runner 完成后自动清理 tmux session)
**Date**: 2026-03-27
**Status**: Complete (v4 — 产品设计确认)

> **v1-v3 回顾**: v1 (PR #54) 被 CEO 否决（自动杀不合理）。v2-v3 确定了方向（巡检 + 通知 Lead），但实现缺产品设计。v4 基于 CEO 直接输入确认完整产品形态。

## 产品设计（CEO 确认）

### 通知发到哪里

发到每个 Lead 的 **chatChannel**（Discord chat channel）。

### 通知路由逻辑

Scanner 扫描所有项目的所有 stale session，然后：

```mermaid
graph TD
    A["Scanner 检测所有 stale session"] --> B["按 project + issue_labels<br/>resolve 到对应 Lead"]
    B --> C["按 Lead 分组"]
    C --> D["给每个 Lead 的 chatChannel<br/>发一条汇总消息"]
```

**关键**：每个 session 通过 `resolveLeadForIssue(projects, projectName, labels)` 确定归属哪个 Lead → 发到那个 Lead 的 chatChannel。

### 通知格式

**一条汇总消息**，列出该 Lead 名下所有 stale session：

```
🔍 Stale Session Patrol

你名下有 2 个 session 已完成但 tmux 仍然开着：

1. GEO-208 — Floating Buildings Fix
   状态: completed | 完成时间: 26h ago

2. GEO-215 — Texture Pipeline Refactor
   状态: failed | 完成时间: 18h ago

请检查并处理。处理完后请回报结果。
```

### 每次 scan 都发（不去重）

**重要设计决策**：每次 scan 都把当前所有 stale session 发出来，不做跨 scan 去重。

原因：
- CEO 可以在 channel 里看到 Lead 有没有处理
- 如果 Lead 没处理，下次 scan 同样的 session 会再次出现 — 这是 feature，不是 bug
- CEO 看到连续几次都出现同一个 session → 知道 Lead 没处理 → 可以介入

### Lead 处理方式

Lead 收到通知后：
1. **自己判断 + 处理** — 检查每个 session 状态，该关的关，关完后在 channel 回报结果
2. **不确定 → 问 CEO** — 在 channel 里问 CEO，CEO 告诉他哪些关哪些留
3. **不处理** — 下次 scan 还会出现，CEO 在 channel 里能看到没被处理

### Lead 关闭 tmux 的方式

Lead 需要能调用 Bridge API `POST /api/sessions/:id/close-tmux`。方式：
- Lead agent 在 TOOLS.md 中有 close-tmux 的说明
- Lead 使用 flywheel-comm CLI 或直接 curl
- 或 Lead 通过 MCP tool 调用

### Scanner 触发方式

**定时触发**：cron / launchd 调用 Bridge API `POST /api/patrol/scan-stale`。
**手动触发**：CEO 随时可以 curl 或通过脚本触发。

HeartbeatService 内部的定时巡检作为**后备**（Bridge 运行时自动跑），但主要触发方式是外部 cron。

## 当前实现差距

| 需要 | 代码现状 | 缺什么 |
|------|----------|--------|
| scan-stale → 发 Discord 通知 | scan-stale 只返回 JSON | 需要加 Discord 发送逻辑 |
| 按 Lead 分组通知 | HeartbeatService 逐条通知 | 需要改成 grouped batch |
| 发到 chatChannel | deliverHook 发到 control channel | 需要改为 chatChannel |
| 每次都发（不去重） | notifiedStale Set 去重 | 需要移除或绕过去重 |
| Lead 从 Discord 调 close-tmux | 没有 | 需要更新 Lead TOOLS.md |
| Lead 回报结果 | 没有 | Lead agent 行为 |

## 实现方案

### 方案：scan-stale endpoint 直接发 Discord

`POST /api/patrol/scan-stale` 增加 `notify: true` 参数：
- `notify: false`（默认）→ 只返回 JSON（查询用）
- `notify: true` → 返回 JSON + 按 Lead 分组发 Discord

**Discord 发送**：复用现有 `FetchDiscordClient.sendMessage()` 模式，用每个 Lead 的 botToken 发到其 chatChannel。

**不经过 HeartbeatService / RegistryHeartbeatNotifier** — 那条路是 per-session 逐条通知，且有去重。scan-stale 需要的是 grouped batch + 每次都发。

### 需要新增/修改的代码

1. **scan-stale endpoint** — 加 `notify` 参数，加 Discord 发送逻辑
2. **Discord 发送 helper** — 用 Lead 的 botToken 发 markdown 到 chatChannel
3. **Lead TOOLS.md** — 加 close-tmux API 说明
4. **HeartbeatService dedup** — 考虑是否移除 notifiedStale Set（如果外部 cron 是主触发，内部定时变后备）

### 不需要改的

- close-tmux endpoint — 已实现，工作正常
- tmux-lookup helper — 已实现
- StateStore query — 已实现
- EventFilter rule — 已实现（HeartbeatService 用）

## 下一步

→ 实现 scan-stale + Discord 通知 + E2E 测试（真实 Discord bot）
