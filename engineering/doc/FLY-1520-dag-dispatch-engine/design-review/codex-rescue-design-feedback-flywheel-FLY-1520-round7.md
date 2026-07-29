# Design Review — FLY-1520 plan.md (Round 7)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 已正确关闭 Round 6 的三项问题：absence evidence 现在必须锁内 fresh、launched-before-exec crash 明确转入 T6→T2 下一 attempt、T2/T7/Ports 也统一到唯一 `launchOnce`。剩余一个阻塞竞态位于 T4 的多 session 锁集合：计划按事务前看到的 active suites 取锁，但没有要求持锁后及最终 write 中断言“当前 active session 集合恰等于已持锁集合”，因此并发 T2 仍能插入一个未加锁的新 activation。评审基于当前 HEAD `f7d20453` 的完整计划与真实 kernel/engine API/DDL；checkout 无 `node_modules`，未声称运行实现测试。

## What's Good (Keep)

- T4/T6/T7 已明确把锁外 absence packet 降为预筛，terminal authority 只能来自持锁后的 fresh exact-session probe。
- fresh packet 额外绑定 launch_claim revision，并在 kernel.write 内断言未变；这与 OS lock 一起封住同一已知 session 的 probe→launch→terminal 窗口。
- T4 的顺序已改为 requestStop→canonical-order 取齐锁→逐 session fresh probe；present 时零 DB 变化并释放全部锁，符合 fail-closed quiescence。
- `CAS claimed→launched` 后未 exec 的恢复现在走 T6 terminal suite、task→ready、再由 T2 创建下一 attempt；T7 明确只处理 non-terminal live resume。
- T2 与 T7 都只调用 `launchOnce`，其顺序为锁内 revalidate→CAS launched/receipt→commit 后仍持锁 exec；SpawnPort 成为唯一 exec 位点。
- LaunchLockPort 的 participant 列表已同步覆盖 claim-confirm、takeover、launchOnce、T3、T4、T6、T7，Ports 与核心状态机不再分叉。
- admission matrix、capability 三 helper 调用图、actions trigger 映射、evidence closure、ship target snapshot、四态 gate 和 hard scope constraints 均继续自洽。
- 现有真实 DDL 的 task/attempt/activation partial uniques与 `registerAgentTx`/`attachRunner` 公开形状仍能承载该计划，没有新增 migration 或 v2-engine 编辑需求。

## Issues & Recommendations

1. **[阻塞] T4 只锁住预读时存在的 active sessions；并发 dispatch 可在取锁期间创建一个不在锁集合里的新 suite。** 当前顺序是“对闭包内 active suites requestStop→按这些 session_ref 取齐锁→fresh probe→kernel.write 释放闭包 active suites”（`plan.md:394-412`）。但在 T4 的预读/取锁阶段，闭包中的另一个 ready downstream 仍满足 T2 eligibility；T2 可提交新 attempt/activation/`launch_claim`，其新 session_ref 不在 T4 已持锁集合。若该新 session 的 `launchOnce` 同时执行，T4 最终事务按“闭包 active 套件全 release”会终结一个自己从未持锁、也未 fresh probe 的 activation，重新打开 launch-vs-terminal 竞态。tasks/attempts/activations 的 partial uniques只限制单 task/attempt，不提供 issue/closure 级 quiesce fence。**修正**：把 T4 定义为 stable-set acquisition loop：①预读 dependency closure 与 sorted active session_ref set S；②requestStop(S)并按序取锁；③持锁后重新读 closure/current active set，若不精确等于 S，释放全部锁并从①重试；④对 S 锁内 fresh probe；⑤进入单一 kernel.write 后再次断言 closure active set==S、每个 claim revision/evidence 未变，再执行 release→reset→acquire。这样在③与⑤之间提交的新 dispatch 会令⑤回滚，而不能被无锁 terminal。也可引入 issue-scoped quiesce fence 让 T2 eligibility 拒绝新 dispatch，但这需要明确的新 authority key；stable-set loop 更符合现有零迁移映射。增加 barrier 测试：T4 预读后，一个 ready downstream 经 T2 提交并进入 launchOnce；T4 必须检测 locked-set mismatch、零业务写并重试，绝不能 terminal 新 session。

## Verdict

CHANGES REQUESTED — address items above
