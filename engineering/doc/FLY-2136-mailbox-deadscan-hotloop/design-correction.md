# FLY-2136 设计更正附录 — design-correction

Issue: FLY-2136 (https://linear.app/geoforge3d/issue/FLY-2136/urgentbridge-稳定-mailbox-死信扫描热循环饿死事件循环每-tick-全表重扫-66-万终态行事务内)
日期: 2026-08-28
基于: plan.md(codex APPROVED R4,blob 312ef186)+ Lead 指令 [lead-instruction ade35c72-4a41-4fb5-a3b6-bf4c029f71d8]

## 1. 基线变更事实(Lead 通报,2026-08-29T01:23Z)

Tadashi 奉 founder 直令,已把 **66,272 条终态行(ACKED/DEAD)从 mailbox 单事务搬入同库新表 `mailbox_archive`**(备份:`~/.flywheel/patrol-repairs/comm-mailbox-pre-archive-20260829T012116Z.db`)。效果:p99 30752ms → 279ms。

**这同时解开了 exploration.md §2.7 的悬案**:01:15–01:24Z 之间 6.5 万行「带外 DELETE、无 mailbox_log 归档事件」的出处 = 此次止血搬移(单事务 INSERT INTO mailbox_archive + DELETE,不走 archiveFamily 协议,故无 archived 事件;freelist 41333 页即其产物)。§2.7 的「出处未确认」以本附录为准更正为已确认;该节按当时所知如实记录,不回改。

## 2. 对已批准 plan 的影响逐条核对

| plan 内容 | 影响 | 处置 |
|---|---|---|
| 刀 1(索引)/ 刀 2(节流)/ 刀 4(gate-marker 缓存) | 无影响 | 照做 |
| 刀 3 周期归档 | **不变更设计**:止血是一次性的,累积机制原封不动(Lead 明示「这是止血不是修法,你的单子照做…把这次手动归档变成常驻行为」)。归档协议仍走既有 `archiveFamily`(mailbox_log 全量快照 + identity tombstone,可审计) | 照做 |
| `mailbox_archive` 新表共存 | 该表现存 66,272 行,不在任何既有协议内。与刀 3 的 mailbox_log 归档并行存在**无冲突**(刀 3 只动 mailbox 热表行) | 实施节点评估「规整」:最小做法 = 保留 mailbox_archive 为止血纪念表不再写入,常驻归档统一走 archiveFamily;若 Lead 要求沿用 mailbox_archive 作为归档目的地,则属协议变更,需回到设计层再议 —— 默认不改 plan |
| 性能阳性对照基线 | Lead 指定用归档前数据(FLY-2058 §4.5 profile)。plan 的 66K 合成基准(63,007 ACKED + 3,212 DEAD)正是按该基线规模构造,已满足;生产 p99 对照基线 = 30752ms(修法生效后应稳定维持在 ms 级,且**不再依赖手动止血**) | 已满足,无改动 |

## 3. 结论

plan.md(blob 312ef186)**维持原文不动**——本附录只记录基线事实与实施节点注意事项,不构成 plan 变更(APPROVED 后不动 plan,防 blob 漂移)。
