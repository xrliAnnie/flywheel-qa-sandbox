# Design Review — FLY-1716 plan.md (Round 6)

Date: 2026-08-14
Author: Codex
Status: APPROVED

## Summary

r6 已关闭 Round 5 的两个剩余问题：durable pending claim 现在是真正的 short-circuit authority gate，seq 也从全部 keyed ledger entries 的 durable high-water mark 分配。结合前五轮已完成的 resume 安全证明、gen/lock fencing、注入收口、episode CAS、degraded 告警生命周期与两 PR 排序，本计划在当前架构下可实施，风险和验收覆盖与生产关键性相称。

## What's Good (Keep)

- authority 与业务效果分层清晰：gen/claim 任一失败均零副作用；只有 durable pending 成功后，adopt、write-back、bootstrap 和 action lookup 才各自 best-effort。
- `absent | pending | completed` 三向分支给出了非歧义的 replay 语义；completed 只修 pointer，pending 只审计，均不会重复 adopt 或增加 `lease_retry_count`。
- `max(seq)+1` 扫描 pending + completed keyed receipts，消除了 pointer publish 崩溃后重复 seq；B/C 任意重放顺序测试直接锚住 latest-pointer 不倒退。
- keyed receipt、共享 authority lock、launch-generation fence 与 actionId 三态闭环共同覆盖了 clear、重启、Bridge crash 和旧代 hook 的主要竞态面。
- Lead terminal-action primitive 使用 action-specific predicates、身份/gen/window 复验、double capture 和 audit-before-keystroke，且把现有 Lead rescue 注入迁入同一 choke point。
- `context_limit` 与 `context_relief_degraded` 的 kind contract、dedup identity 和 reconcile 生命周期已与现有 `KindArc`/`AlertChannelHub` 行为一致。
- Wave 1 独立先合入、Wave 2+3 后续合入；statusline 和 mailbox delivery loop 不动，Wave 4 非必要代码已拆出，符合本项目的收敛与简化原则。

## Issues & Recommendations

1. **无阻塞项。** 实现时将 ledger 目录扫描中的不可读/畸形 keyed receipt 视为 claim authority failure（零业务副作用并审计），不要静默跳过后继续分配 seq；这是 r6 fail-closed 合同的直接落实，可在 claim failure harness 中顺手覆盖。

## Verdict

APPROVED — ready to implement
