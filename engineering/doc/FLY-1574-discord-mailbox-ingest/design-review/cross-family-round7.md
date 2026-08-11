# FLY-1574 Discord 收编 — 设计评审 R7

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md R6

Verdict: `CHANGES_REQUESTED`
Request: `45fe0171-aa69-4c73-9d46-530849bd8bdb`

## Blocking finding 与处理

1. `guard-does-not-fence-inbox-socket`(HIGH):采纳。R7 把所有权拆成两个 parent-coupled `fcntl.flock`:常驻 `codex-mailbox-socket.lock` 与随 flag 的 `discord-inbound.lock`;只有 socket owner 才能 listen inbox socket、启动 gateway、竞争 ingress 锁,因此 ingress 与 last-mile 必定归属同一 runtime。loser 不得 unlink/rebind socket,也不能 accept/ACK。

## Advisories 与处理

- `membership-conflict-silent-dead`(MEDIUM):采纳。Discord membership conflict 先发带 id 的 `discord_mailbox_undeliverable`,再进明确 quarantine;禁止静默 `markDead`。
- `undeliverable-discord-row-never-terminal`(MEDIUM):采纳。暂态故障持续 retry 且每 30 分钟重告;确定性 poison 行有告警后进入 `discord_undeliverable:*` quarantine。runbook 区分 rollback 已生效、drain 未完成与 quarantine 台账。
- `collapse-key-squats-reserved-field`(MEDIUM):采纳。`collapse_key` 保持 NULL;claim 事务从受信 machine envelope 导出 route key 分批。
- `route-metadata-needs-protocol-version-bump`(MEDIUM):采纳。socket 协议升 v2,route 字段必校验并进入 HMAC;旧 consumer 明确拒绝。
- `submitbatch-missing-topic-engaged`(MEDIUM):采纳。`submitBatch` 显式补一次 `onTopicEngaged`,不再声称原样生效。
- `machine-envelope-in-delivered-text`(MEDIUM):采纳。DB `content` 保存 machine envelope,模型只收干净 `delivery_content`;Bridge parser 与 adapter 的读取列写清并纳入测试。
