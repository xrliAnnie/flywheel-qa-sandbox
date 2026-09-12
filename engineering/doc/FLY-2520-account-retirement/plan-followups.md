# FLY-2520 账号到期排序 — 评审后续项
Issue: FLY-2520
日期: 2026-09-12
基于: plan.md

Implement@2 R1 MEDIUM/LOW，按 Lead 限制仅归档，不在返工中实现；不修改 pinned plan。完整原文见 code-review-rework-r1.json。

- MEDIUM `retirement-reuses-any-unavailable-mark`：Retirement reuses whatever `unavailable` mark already exists instead of the first retirement mark
- MEDIUM `switch-notification-drops-from-to-labels`：Switch notification drops the 原账号/新账号 labels whenever retiresAt is set
- MEDIUM `panorama-body-size-vs-discord-limit`：panoramaBody grew ~7x per account with no truncation on the 2000-char Discord path
- MEDIUM `full-snapshot-read-every-pass`：Retirement check reads the full snapshot (keychain subprocess + pool listing) on every 60s pass
- MEDIUM `plain-message-widened-by-kind`：--plain-message opened to every quota_monitor_down producer, not just retirement warnings
- MEDIUM `malformed-retiresat-silently-unselectable`：A typo in the hand-edited retiresAt silently removes an account from the switch pool with no alert
- LOW `retirement-label-dead-code`：`retirementLabel` is exported dead code
- LOW `patrol-capacity-payload-growth`：Patrol tick capacity section grows from one line to ~8 lines per account
