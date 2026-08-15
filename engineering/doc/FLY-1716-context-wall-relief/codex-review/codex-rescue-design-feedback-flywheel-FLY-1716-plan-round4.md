# Design Review — FLY-1716 plan.md (Round 4)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r4 实质性关闭了 Round 3 的四个核心问题：completed replay 有了不可覆盖的 keyed ledger，终端动作改成 action-specific predicates，degraded 告警获得独立身份，hook 查询也具备正确的三态降级语义。总体架构已经接近可实施，但 kind 生命周期以及 ledger 的首次乱序/崩溃线性化仍有 3 个正确性缺口；它们会造成严重告警被静默 resolve，或让旧 hook 重复 adopt、最新 receipt 永久不可见，因此本轮仍请求局部修订。

## What's Good (Keep)

- 保留按 `(gen,newSessionId)` 永久分键、pending→completed 原地推进的 receipt ledger；它正确挡住了 `B completed → C completed → replay B`，也比单槽 receipt 更适合审计。
- 保留 `resume_menu_enter | compact | clear` 的独立 pane predicate，以及 identity/gen/window 复验、double capture、audit-before-key 和统一 choke point；这与现有 rescue recognizer 的安全边界一致。
- 保留 `context_relief_degraded` 的独立 event type/eventId。`<episode>:continuity_degraded` 与 `<episode>:receipt_missing` 解决了 notifier/Flow 2 去重吞掉终态异常的问题。
- 保留 `matched | none_proven | unknown` 查询结果；只有成功的空查询才能判定 manual clear，而 StateStore 缺表、busy 或解析失败均进入 causality-unknown，是正确的 fail-closed 方向。
- 保留 PR-1 的只读/query-only reader 和“绝不由 hook 创建/迁移 StateStore”边界，以及 PR-1 → PR-2 的显式合入顺序。

## Issues & Recommendations

1. **[BLOCKER] `context_relief_degraded` 的 kind contract 与 reconcile 生命周期不成立。** 计划写的是 `arc: escalate`，但 `packages/teamlead/src/bridge/kind-contract.ts:52` 的合法值只有 `auto | none_escalate | human_by_design`，而且每个 contract 都必须明确 `owner`。更关键的是，计划要求把 degraded kind 加入 `LEAD_KINDS`；`AlertChannelHub.ts:789-800,979-981` 会用 `classifyLeadAlertPane(pane) !== eventType` 自动 resolve 其中的告警，而 pane classifier 永远不会返回 `context_relief_degraded`，所以这个 severe continuity 告警可能在下一 tick 被静默关闭。建议将合同钉死为 `owner: "claude", arc: "none_escalate"`（自动动作已经耗尽，直接升级），仅把 `context_limit` 加入 `LEAD_KINDS`；degraded kind 应走显式 continuity/manual disposition 生命周期。新增 reconcile 反例：无论 pane 仍是 `context_limit` 还是已经 idle，active degraded row 都不得因 pane mismatch 自动 resolve；routing=1 与 raw fallback 均验证一次可见且保持正确状态。

2. **[HIGH] `stale_first_claim` 的 seq 判据没有可比较的入站顺序，且当前步骤仍允许旧 hook 执行 adopt。** 对一个从未出现过的 `(gen,newSessionId)` key，计划没有在延迟发生前绑定 seq；它拿锁后若按 `current.seq + 1` 分配，自然会被视为“最新”，无法区分合法的同 body 第二次 `/clear` 与较早但延迟到达的首次 hook。计划的“只落 claim/adopt 审计”还把 adopt 放在 stale 判定后的可执行路径上；真实 SQL 会把当时所有匹配的 `LEASED` 行重排并递增 `lease_retry_count`，因此即使跳过 session-id 回写，也没有守住“一次换代只 adopt 一次”。建议二选一并写成唯一权威契约：若同步 SessionStart + timeout-kill 已足以证明首次乱序不可达，就删除这条不可实现的第二防线及其伪测试；若仍要防御该场景，则必须在可能延迟之前产生可比较的 event ordinal，并在 pending claim、adopt、write-back、bootstrap 之前判 stale，stale 路径零业务副作用。测试必须是“B 的首次 hook 延迟到 C completed 之后”，并断言 adopt 调用与 `lease_retry_count` 均不增加，而不只是 completed B replay。

3. **[HIGH] keyed receipt 的 completed 写入与 `current.json` 更新之间仍有永久断链窗口。** 两者是两个独立原子写；若进程在本 key 写成 completed 后、更新 current pointer 前退出，重放会命中“已 completed → 全部 no-op”，于是 `current.json` 永久停在旧 key。rider/launcher 按计划只查 current，便会漏掉真实 clear receipt，无法完成 actionId 闭环，最终误入 receipt_missing/degraded。建议在 pending claim 中就持久化分配好的 seq，并把重放规则明确为：`pending` 零副作用；`completed` 绝不重做 adopt/write-back/bootstrap，但在 authority lock 内以 monotonic max 条件修复 `current.json`。增加精确 fault-injection 测试：completed 文件落盘后、pointer 更新前崩溃；重放后 pointer 指向该 completed key，且 adopt 与 `lease_retry_count` 不变。

## Verdict

CHANGES REQUESTED — address items above
