# Exploration: Discord Typing Indicator 消失 — GEO-283

**Issue**: GEO-283 (Lead Discord typing indicator 消失)
**Date**: 2026-03-30
**Status**: Complete

## Problem

当 Claude Lead 正在处理消息（思考、执行工具调用、等待 API 响应）时，Discord typing indicator 在 ~10 秒后消失。Annie 无法区分 "Lead 正在工作" 和 "Lead 已断连/崩溃"。

## Root Cause

Discord MCP plugin (`server.ts:851-853`) 在收到消息时只调用一次 `sendTyping()`：

```typescript
// Typing indicator — signals "processing" until we reply (or ~10s elapses).
if ('sendTyping' in msg.channel) {
  void msg.channel.sendTyping().catch(() => {})
}
```

Discord API 的 typing indicator 在 **~10 秒后自动过期**（除非刷新）。Claude Lead 处理消息通常需要几十秒到几分钟，所以 typing indicator 很快就消失了。

## Analysis

### Discord Typing Behavior
- `channel.sendTyping()` 触发 typing indicator，持续 ~10 秒
- 需要周期性调用才能维持 typing 状态
- Discord.js 文档确认无内置 auto-refresh 机制
- 安全做法：每 8 秒刷新（10 秒过期前有 2 秒余量）

### Current Plugin Architecture
- 消息接收 → `sendTyping()` 一次 → MCP notification 传递给 Claude
- Claude 处理完后调用 `reply` tool → 消息发回 Discord
- 中间没有任何 typing 刷新机制

### Fix Location
修改位于 Discord MCP plugin fork (`xrliAnnie/claude-plugins-official`)，不在 Flywheel 核心代码中。

## Proposed Fix

### Approach: Typing Keepalive with Auto-Stop

```
Message received → startTypingKeepalive(channel, chatId)
                   ├── sendTyping() immediately
                   ├── setInterval(sendTyping, 8000)  // refresh every 8s
                   └── setTimeout(stop, 600000)        // safety: 10min max
                   
Reply sent       → stopTypingKeepalive(chatId)
```

### Implementation Details

1. **State tracking**: `Map<string, TypingState>` keyed by `chatId`
   - `interval`: 8-second refresh timer
   - `safety`: 10-minute max duration timeout
   
2. **Start**: On message receive (replace lines 850-853)
   - Clear any existing keepalive for this channel (idempotent)
   - Start immediate `sendTyping()` + 8-second interval

3. **Stop**: On `reply` tool call (add before send logic at line 605)
   - Clear interval + safety timeout
   - Remove from Map

4. **Safety**: 
   - 10-minute max auto-stop (prevents infinite typing on crash)
   - Circuit breaker: stop on 2 consecutive `sendTyping()` failures
   - `edit_message` does NOT stop typing (edits are interim updates)

5. **Error handling**: `sendTyping()` failures are fire-and-forget (logged but non-fatal)

### Changes Required

| File | Change |
|------|--------|
| `external_plugins/discord/server.ts` | Add typing keepalive Map + start/stop helpers, wire into message handler + reply tool |

### Not Needed
- No changes to Flywheel core
- No changes to agent files
- No changes to Bridge API
- No new tools or configuration

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Infinite typing on crash | 10-minute safety timeout |
| API rate limit from sendTyping | 8-second interval well within Discord rate limits |
| Memory leak (intervals never cleared) | Safety timeout + idempotent start (clears previous) |
| Multiple messages in same channel | New message resets keepalive (correct behavior) |

## Decision

Fix is clear and minimal. Proceed directly to implementation in the fork repo.

**Deployment path**:
1. Commit to fork repo → push to `xrliAnnie/claude-plugins-official`
2. Run `~/.flywheel/bin/update-discord-plugin.sh` to deploy
3. Restart running Leads to pick up changes
