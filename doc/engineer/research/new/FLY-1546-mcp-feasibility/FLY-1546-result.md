# Research: FLY-1546 MCP 可行性小测试 — 三项全 PASS,放行 FLY-1547

**Issue**: FLY-1546([v2] MCP 可行性小测试)/ 执行于 FLY-1547 generic 节点内(1546 无独立执行记录,作为 1547 的拦路门先跑)
**Date**: 2026-07-30
**Source**: Linear FLY-1546 issue 正文
**执行环境**: 生产机真实 `~/.flywheel/v2/flywheel-v2.db`;spike 程序 `spike-mailbox-mcp.mjs`(~120 行,零 npm 依赖,裸 JSON-RPC over stdio + `sqlite3 -readonly`,绝不写库)

## 判定:三个全成 → 放行 FLY-1547(信箱服务)开工

| # | 检查 | 结果 | 证据 |
|---|------|------|------|
| 1 | Claude 能连:一个 Claude 会话经 MCP 调 `next` 取到一封真信 | ✅ PASS | `evidence-check1-claude.log` — 取到 `f9631ae9-5be6-4a5a-8ee1-d06194335688` (kind=instruction, 2026-07-30T20:40:27Z) |
| 2 | Codex 能连:一个 Codex 会话同样取到 | ✅ PASS | `evidence-check2-codex.log` — 取到 `94b27e7f-c661-45db-b147-707da46d4ac7` (kind=instruction, 2026-07-30T20:44:32Z) |
| 3 | 能主动推:channel 协议把测试消息推进一个**正在跑**的 Claude 会话 | ✅ PASS | `evidence-check3-channel-push.log` — pane 可见 `← fly1546-spike: FLY-1546 push check…` 注入 + 模型回 `CHANNEL-RECEIVED` + 原文逐字 |

## 复现方式

```bash
# 检查 1(headless Claude)
claude -p --mcp-config spike-mcp-config.json \
  --allowedTools "mcp__fly1546-spike__next" \
  "Call mcp__fly1546-spike__next with {\"recipient\":\"flywheel-eng-lead\"} …"

# 检查 2(headless Codex)
codex exec --sandbox workspace-write --skip-git-repo-check \
  -c 'mcp_servers.fly1546_spike.command="node"' \
  -c 'mcp_servers.fly1546_spike.args=["…/spike-mailbox-mcp.mjs"]' \
  -c 'mcp_servers.fly1546_spike.default_tools_approval_mode="approve"' \
  "Call the MCP tool named 'next' …"

# 检查 3(交互 Claude + channel 推送)
tmux new-session -d -s fly1546-spike \
  "claude --mcp-config spike-mcp-config.json \
     --dangerously-load-development-channels 'server:fly1546-spike' \
     --permission-mode bypassPermissions '…READY…'"
# 确认 consent 对话框(send-keys 1 + Enter)
echo '测试消息' > /tmp/fly1546-spike-push.txt   # spike server 轮询到即推 notifications/claude/channel
tmux capture-pane -p -t fly1546-spike           # 看到 ← fly1546-spike: … 注入
```

## 对 FLY-1547 有直接约束力的四条实测发现

1. **Codex 侧 MCP 工具调用默认会被 approval 门取消**(headless `codex exec` 显示 `user cancelled MCP tool call`)。必须给信箱 server 配 `mcp_servers.<name>.default_tools_approval_mode="approve"`(per-server 键;全局同名键**无效**,实测两次取消后仅 per-server 生效)。这与 FLY-398 记载一致(`buildCodexLeadMcpArgv.ts:84-103`)。
2. **channel 推送有硬门链**(vendor 源 `channelNotification.ts` `gateChannelServer`):capability `experimental["claude/channel"]` → 运行时开关 → **claude.ai OAuth(API-key 会话被拒)** → `--channels` 或 `--dangerously-load-development-channels "server:<name>"` 白名单。v2 runner 的 per-activation `CLAUDE_CONFIG_DIR` 已链接 operator 凭据(`.credentials.json`),OAuth 门实测可过。
3. **dev-channels 有 TUI consent 对话框**(`❯ 1. I am using this for local development`),headless 起不来时会挂死;生产接入需 launcher 侧 auto-confirm(claude-lead.sh:1392-1419 的 capture-pane poller 是已验证前例)或改走正式 `--channels` 白名单。
4. **注入形态**:channel 消息以 `← <server>: <content>` 形式作为 next-priority prompt 进入活会话,模型立即处理——与 founder↔Lead 生产路径同机制,可靠性符合 issue 预期。

## 备注

- 检查 1/2 的"取信"是 **read-only**(`sqlite3 -readonly`),不产生 processing_attempts、不销账——真实 next 的"同事务记已读"语义由 FLY-1547 正式实现(复用 v2 host `pollRunnerDelivery`,其 processing_attempts 行即服务端已读留痕)。
- spike server 同时声明了 tools 与 `claude/channel` capability——证明"一个进程,MCP 工具面 + Claude 推送面"共存可行;Codex 发送器(app-server JSON-RPC `turn/start`)前例在 `packages/teamlead/src/lead-backends/codex/CodexLeadProcess.ts`,本 spike 未重复验证(生产 Mufasa Lead 每日在用,视为已验证)。
