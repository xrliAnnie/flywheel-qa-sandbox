# Design Review — FLY-1716 plan.md (Round 5)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r5 已正确关闭 Round 4 的三项意见：degraded kind 采用合法合同且脱离 pane-driven reconcile，不可实现的 `stale_first_claim` 被诚实删除，completed replay 也具备 pointer repair。总体方案无需再改架构，但 hook ledger 仍有两个相互关联的线性化缺口：authority claim 失败时计划允许副作用继续，以及 seq 从 completed pointer 分配会在崩溃后复用；两者会破坏 claim-before-effect 或让“最新 receipt”失去确定顺序。

## What's Good (Keep)

- 保留 `context_relief_degraded = { owner: "claude", arc: "none_escalate" }`，并只把 `context_limit` 加入 `LEAD_KINDS`；这与 `KindArc` 和 `AlertChannelHub` 的实际契约一致。
- 保留 degraded 的显式 continuity/manual disposition 生命周期，以及 context-wall/idle 两种 pane 下均不得自动 resolve 的反例测试。
- 保留删除 `stale_first_claim` 的决定。以已留证的同步 SessionStart 契约作为唯一首次执行顺序假设，比保留一个无法比较、仍会 adopt 的伪防线更准确。
- 保留 keyed completed replay 的业务副作用 no-op、锁内 monotonic pointer repair，以及 completed-file/pointer 间 fault injection。
- 保留 action-specific terminal predicates、actionId 三态查询、共享 authority lock/gen fence 和 Wave 1 → Wave 2+3 的合入顺序。

## Issues & Recommendations

1. **[BLOCKER] claim-before-effect 与“各步骤独立失败不短路”仍直接冲突。** §2.3 一方面要求 pending claim 在 adopt 前持久化，并规定 `pending` replay 零业务副作用；另一方面 hook 步骤写成“已 completed → 全部 no-op，否则写 pending”，随后无条件进入 adopt，且测试仍要求“各步骤独立失败不短路”。若 pending 文件的 tmp/mv 失败，按此文字仍会 adopt、回写和 bootstrap，却没有 durable claim；重放即可再次 adopt，真实 `mailbox-queue.ts:298-325` 会再次递增 `lease_retry_count`。现有步骤 2 也把已存在的 `pending` 落入“否则”，与前面的 replay 规则矛盾。建议把步骤 2 改成明确的三向 authority branch：`absent` → 成功原子写 pending 后才允许继续；`pending` → 仅审计并 return 0；`completed` → 仅执行 pointer repair 后 return 0。gen/lock/claim 都是必须短路的 authority gate；只有 durable pending 成功后的 adopt、write-back、bootstrap、action lookup 可以各自 best-effort、不互相短路。新增 claim mkdir/tmp/write/mv 各失败点的反例，断言 adopt、session-id、bootstrap、action lookup 全部零副作用。

2. **[HIGH] `seq = current.seq + 1` 不是 durable high-water mark，pointer 崩溃后会重复分配 seq。** `current.json` 只在 completed 后更新；若 B 已写 pending 或 completed(seq=11)但 pointer 仍为 10，随后合法的 C clear 会再次分到 11。upstream 串行只保证 hook 不并发，不能阻止 B 的 hook 退出/被 kill 后再发生 C。此时两个 completed key 可同 seq；若两次 pointer publish 都中断，之后的 monotonic-max repair 无法确定 B/C 谁更新，`current.json` 的“最新 receipt”会依赖 replay 顺序。建议在 authority lock 内从所有 keyed ledger（pending + completed）计算 `max(seq)+1` 后写入新 pending；该目录每个 Lead 的 clear 数量很小，比再引入一个有双写窗口的 counter 文件更简单。pointer repair 使用严格的 seq 比较，并把“不覆盖更高 seq”写成合同。补测试：B completed 后 pointer publish 崩溃 → C 在 B replay 前 claim/complete → C 获得更高 seq；随后任意顺序 replay B/C，current 始终指向 C，且 adopt 次数不变。

## Verdict

CHANGES REQUESTED — address items above
