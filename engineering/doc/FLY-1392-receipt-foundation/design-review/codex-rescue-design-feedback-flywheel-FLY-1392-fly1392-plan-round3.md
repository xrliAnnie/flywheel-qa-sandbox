# Design Review — FLY-1392 plan.md (Round 3)

Date: 2026-07-20
Author: Codex
Status: CHANGES REQUESTED

## Summary

draft v3 已实质闭合 Round 2 的全部 5 项：push 预算改为先扣后推、ledger failure 回滚整个 UOW、family 单 owner/cap 顺序、`already_answered` 两分、terminal/outbox revalidation，以及 kind-scoped callback 都已写成可测试合同。当前只剩 2 个局部但 blocking 的组合边界：model-lane owner 按现 selector 实际不会被选中，以及跨 cohort 的全局 CLEARING mute 会让 receipt-only reconcile 永久静音 `wake_failed`。修正后即可进入实现，不需改变架构方向。

## What's Good (Keep)

- `push_attempts` 在 claim transaction 内、I/O 前消耗，ordinal completion 不退款；这关闭了 Claude sidecar stale-pending 重写导致预算失真的 crash 窗。
- per-exec admission cap、`suppressed_cap` 与 deterministic `wake_cap` outbox补上了不同 causal key 之间的风暴上限。
- ledger 写失败现在回滚整个 composite UOW，删除了无法自洽的 `suppressed_ledger_unavailable`/recovery leg，恢复了 intent+business 的真正原子性。
- `family_root_id`、`routing_state`、owner transfer 与 cap-before-increment 明确保证零 r3（cap=2）和每个 Discord msgId 一个 escalation family。
- route CLI 正确区分同 UOW 重试和 competitor response；只有本 Lead 的显式 no-route action 才能形成该 founder message 的 evidence。
- outbox cancel/source revalidation 与 terminal cancel/escalate 两分使 terminal-sync-first 的 kill-pane 路径仍能产生 `wake_failed`。
- kind-scoped StateStore query、单 callback/single-flight 和 00/01/10/11 flag matrix是正确的 legacy 隔离方向。

## Issues & Recommendations

1. **[Blocking — Retry liveness] owner transfer 后的 model-lane 行按 §6.1 selector 不会被选中，且其 30min 时钟没有明确绑定 delivered。** `routing_state` 在 §2.1 被定义为 hub-root 字段；model-lane row 只有 `family_root_id`，因此通常是 `routing_state=NULL`。但 §6.1 写的是 SQL 形态 `routing_state NOT IN ('awaiting_rebind','model_promoted')`；SQLite 中 `NULL NOT IN (...)` 的结果是 NULL/false，恰好把转移后的唯一 owner 排除。selector 还没有 `delivered_at IS NOT NULL`，而 §2.1/§4.2 也没规定 model row 的 `next_unprocessed_at` 是在创建还是 LeadInboxLoop delivery 时初始化：创建时启动会在初投尚未成功时进入“未处理”轴，若保持 NULL 则 kill-Lead 永远不重发。**建议：**把 owner 状态做成正值而非靠 NULL，例如 model row 明确写 `routing_state='model_pending'`（扩展枚举），或 selector 写成 `(routing_state IS NULL OR routing_state NOT IN (...))`；同时要求 `delivered_at IS NOT NULL`。owner-transfer transaction 先把 root due 清空，model row 在 transport 成功的 `markConsumed(disposition='delivered')` 同一事务设置 `next_unprocessed_at=delivered_at+WINDOW,resend_round=0`，失败/未 delivered 时只走未送达轴。增加 F-6/A-3 从创建→delivery→30min→r1→cap→单 outbox 的真库测试，以及“model adapter 一直失败时绝不进入未处理轴”的负测。

2. **[Blocking — Cross-cohort deadlock] kind-scoped C3 仍被现有 target-global CLEARING guard 卡住；legacy flag off 时没有任何 pass 会解除它。** v3 只把 reconcile query 按 kind 分组，但 `notifyLeadFirst` 和外层 `notifyUnlessClearing` 仍调用 `hasClearingDetectionEscalationForTarget(targetKey)`，该查询不看 kind（`detection-escalation.ts:155-164`; `detection-reconcile-tick.ts:286-303`; `StateStore.ts:10067-10074`）。场景：同一 execId 留有 legacy kind 的 `CLEARING` row，`legacyDeliveryWatchdogsOn=false`、receipt flag=true；新的 `wake_failed` upsert 后会返回/停在 muted NEW，而 receipt-only pass看不到 legacy row，无法执行原 `CLEARING TTL → NEW` rebound（`detection-escalation.ts:349-369`），因此它会永久静音。这也会破坏 terminal-sync-first kill-pane 验收。**建议：**在 plan 明确 cohort-aware C5 合同。可选其一：(a) receipt notify 只受 receipt cohort 的 CLEARING 约束；或 (b) 将 target-global CLEARING TTL maintenance 拆成无 founder-page 副作用的共享 pass，只要任一 cohort 开启就运行，而 paging/fleet仍严格 kind-scoped。若选 (b)，修订当前“receipt-only 不重置旧行”的矩阵预期：允许只做过期 CLEARING rebound，但仍禁止旧 row page/fleet。必须新增**同一 targetKey** 的 legacy CLEARING + receipt NEW 组合测试，覆盖 fresh mute、TTL 后 receipt 恢复、legacy row 零 page，以及 flags 00/01/10/11。

## Verdict

CHANGES REQUESTED — address items above
