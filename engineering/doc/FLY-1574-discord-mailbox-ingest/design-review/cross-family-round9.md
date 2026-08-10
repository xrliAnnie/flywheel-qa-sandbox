# FLY-1574 Discord 收编 — 设计评审 R9

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md R8

Verdict: `CHANGES_REQUESTED`
Request: `3198c4cf-e8a0-4d1f-9b68-0fba55522fe0`

## Blocking finding 与处理

1. `unlocked-socket-bind-fallback`(HIGH):采纳。R9 钉死「永远不无锁 bind;只有 lock holder 能 unlink stale socket 后 bind」;unavailable+OFF 只启 legacy Discord gateway、零 socket side effect。owner bind 失败也进入 jitter retry 与周期告警。

## Advisories 与处理

- `unavailable-branch-skips-live-owner-probe`(MEDIUM):采纳。conflict/unavailable 都先认证 probe;有 live owner 必 standby,无人服务的 unavailable 才可 OFF legacy-only。
- `non-discord-rows-die-during-socket-outage`(MEDIUM):采纳。typed Codex transport outage 期间该 Lead 全部 model rows 不耗尽,复用 outage 告警;其他既有 retry 语义不动。
- `v1-discord-wrapper-payload-sniffing`(MEDIUM):采纳。删除文本 sniff,由 `LeadDeliveryBatch.kind` + adapter capabilities negotiation 决定;旧 v1 只收普通 model,Discord 永不降级。
- `deploy-order-contradicts-restart-tooling`(MEDIUM):采纳。沿用 Bridge-first;新 adapter 对旧 server negotiation 后普通 batch 自动 v1,flag OFF 保证无新 Discord mailbox 行;Lead wave 后 census 再 ON。
- `capabilities-ownerepoch-name-overload`(LOW):采纳。改名 `socketOwnerId=randomUUID()`,startup log 关联 runtime/helper pid,与 Bridge `ownerEpoch` 分离。
