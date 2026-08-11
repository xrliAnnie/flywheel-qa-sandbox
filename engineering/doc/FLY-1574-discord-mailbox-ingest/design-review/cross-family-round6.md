# FLY-1574 Discord 收编 — 设计评审 R6

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md R5

Verdict: `CHANGES_REQUESTED`
Request: `2722e15c-22ce-4c73-9d46-530849bd8bdb`

## Blocking findings 与处理

1. `codex-mailbox-loses-reply-route`(HIGH):采纳。R6 将 resolver 已算好的 `replyChannelId/replyRoute` 持久化进 machine envelope,以 `collapse_key` 做 route-homogeneous batch fence,并扩展 Codex socket/`acceptBatch` 保留 route。
2. `headless-codex-has-no-mailbox-last-mile`(HIGH):采纳。headless 补与 TUI 同构的 `CodexLeadInboxServer`,严格 listen-before-gateway / stop-gateway-before-close。
3. `founder-msg-silent-dead-letter`(HIGH):采纳。D 接管前 `discord_chat` transport failure 不耗尽,保留 bounded backoff;第 5 次起每 stall episode 发一次可查告警,恢复后继续送。

## Advisories 与处理

- `claude-visible-form-misspecified`(MEDIUM):采纳。Claude 以 `<channel receipt_id>` 携 id,Codex 才有 `[receipt:]`;明示 teammate `from=bridge` 与 DB `from_agent` 的信任边界。
- `mutex-unconditional-no-escape`(MEDIUM):采纳。guard 跟随同一 flag:OFF bypass/release,ON 必须持锁;钉死 parent-pipe EOF 释锁与 orphan 诊断。
- `discord-priority-reordering`(MEDIUM):采纳。Discord 全部 priority 1,保留 seq。
- `flag-spec-field-name-and-discord-limit`(LOW):采纳。改为 `toggleable`;base 正文上限改为 2000,Nitro 4000。
