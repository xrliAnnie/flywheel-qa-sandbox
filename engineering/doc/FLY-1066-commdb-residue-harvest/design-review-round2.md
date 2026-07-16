# Design Review — plan.md (FLY-1066) (Round 2)

Date: 2026-07-16
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已把 Round 1 的八项主问题实质性纳入主计划：M2 现在是 fail-closed 的真实 crash-reaper 序列，M3 改为全局一次且 DB 不可读即全 keep，M4 的入口/flag/maintenance 接线与 M6 preflight 也都可按现架构实现。剩余阻塞集中在 face-4：新 `resolved_via` 的复活语义仍未作决定，presence-index 的竞态证明又依赖一个已被源码推翻的 dispatch 顺序；另有 M2 archive 锚点和上游文档仍可能把实现带回错误路径，因此本轮仍请求小范围修改。

## What's Good (Keep)

- 保留 §2 的硬安全约束及其结构性哨兵：只有 `probe === "dead"` 才能删除/终态化，`alive`/`indeterminate` 永远 keep，尤其 `awaiting_review + alive` 不可触。24h/30min age guard 与 missing/invalid/future timestamp fail-closed 的方向正确。
- M2 的核心顺序已经修正到可实现且 fail-closed：per-issue lifecycle mutex、probe 后重读、CommDB finalize 先于 FSM transition、真实 `TransitionContext`，以及成功后显式 QA-loss/archive/event。finalize 失败不 transition，能保留下一轮重试入口。
- M3 已正确承认 escalation row 没有 project identity，改为每个 full pass 只运行一次，并对全部 configured-project CommDB 建全局 presence index；任一 DB open/read 失败即全 face-4 abort，符合 `indeterminate != absent`。
- ACKED 纳入双无主清除是合理的：现有 recovery contract 本就枚举全部 non-RESOLVED 行，机器证明的 extinction 不应因 ACKED 而例外。
- M4 接线收敛得很好：复用现有 `onMaintenanceTick`，不新增 timer/counter/constructor seam；targeted reconcile 位于旧 FLY-742 enabled/local-classify 之前，且 residue flag 不受 `FLYWHEEL_CRON_STALE_GUARD` 或 worktree-autoclean 的意外辖制。
- 可选 `result.harvest`、M4 同 commit 注册 flag、M5 flag matrix，以及 M6 default-on 前 mandatory same-predicate preflight，均正确闭合了兼容性、提交可绿和首次生产 blast-radius 问题。
- FLY-817 BLOCKER-1 修订仍然成立：failed/blocked 只在 tmux 可证死亡时 finalize；alive/indeterminate 分支继续保留 teardown target 与 scrollback，未削弱原 CRASH_PRESERVE 安全边界。

## Issues & Recommendations

1. **[HIGH] M3 的 `residue_harvest` 复活语义仍留给实现阶段二选一，而现有代码会永久静音同指纹复发。** `plan.md:99` 写成“同指纹新事故仍可建新行/或按既有语义，以实核为准”，但这不是开放的实现细节：`detection_escalations` 的主键是 `(target_key, kind, episode_fingerprint)`（`StateStore.ts:2529-2544`），upsert 又是 `INSERT OR IGNORE`（`:9029-9049`），所以同一 tuple 根本不能“建新行”。现有复活条件还只接受 `resolved_via === "recovery"`（`:9062-9084`）；新增 token 后不改该条件，就会让 harvester 清掉的 fingerprint 永久保持 RESOLVED。源码允许预绑定 execution id 的同 ID replay/re-drive（`run-dispatcher.ts:487-570`），因此这会真实吞掉未来复发告警。**建议：**现在就定契约：把 `residue_harvest` 视为与 `recovery` 同级的 machine-proven clear，并把 revival predicate 扩为两者；测试必须证明更晚的 `firstDetectedAtMs` 会把同一行复活为 NEW、重置通知/ack/page/clearing/attempts，而 `resolved_via='lead'` 仍不复活。若不想扩 predicate，就复用 `recovery` 并另记审计事件，但不能保留当前“实现时再定”。

2. **[HIGH] M3 presence-index 的 TOCTOU 对策建立在错误的 dispatch 顺序上，不能证明 RESOLVE 时仍是双无主。** `plan.md:145` 声称“新 spawn 的 exec 必有 StateStore 行（dispatch 先建行）”，但同一计划 `:142`、修正后的 research §6 以及真实 fresh/retry 路径都证明相反：`preRegisterCommDb` 在 Blueprint/StateStore session 之前（`run-dispatcher.ts:618-630,1203-1214`）。因此初始 index 建完后，一个同 ID replay 可先写入 CommDB，而 StateStore 仍暂时 absent；M3 若只查旧 index，就会错误 RESOLVE 一个已重新出现的 target。它不删除 session，但会违反 face-4 的“双账都 absent”契约并静音告警。**建议：**把全局 index 仅作为首轮筛选；每个候选 UPDATE 前同步重读 StateStore，并再次对全部 configured-project CommDB 查询该 target，任一 presence/read error 都 keep。增加可注入的 race test：初始 index 后、resolve 前向任一 CommDB 注册同 exec，断言不 RESOLVE；同时修正风险表 `:145`。若要求 commit 时刻的绝对证明，则需进一步定义跨 DB 的 serialization/barrier，而不能用当前顺序断言替代。

3. **[MEDIUM] M2 的 terminated archive 仍引用了一个不会 archive terminated 的具体 helper，现有测试形态可能只证明“回调被调用”而漏掉生产 no-op。** `plan.md:75-76` 写“terminated archive (`maybeArchiveThreadOnClose` 同族)”，但 `maybeArchiveThreadOnClose` 明确只允许 `completed`，并排除 `terminated`（`done-thread-archiver.ts:350-374`）。crash-reaper 的真实 production wiring 是 `archiveIssueThreadIfNoOtherActive(..., { allowStatuses: ["terminated"] })`（`plugin.ts:5064-5074`）。**建议：**计划直接写明复用后者及其 `allowStatuses`，并加一条 production-wiring sentinel，证明 terminated ghost 实际进入该 closure，而不只是在 M2 单元测试里调用一个无约束 spy。

4. **[MEDIUM] 两份“substantiation”文档及一处测试清单仍与已接受的 Round 1 修正冲突。** `research.md:91-93` 仍写不存在的 actor/reason context，并声称 applyTransition 会自动带 archive/QA-loss；这正是 M2 已纠正的旧错误。`exploration.md:82-84` 仍把 face-4 写成“该 project CommDB”且 active-status 列表漏 ACKED，和全局 M3 相反；其 `:90-95` 图也仍把 face-4 挂在 per-project harvester 下。另外 `plan.md:81` 的 M2 timestamp 测试只显式列 invalid，未像 M1 一样列 missing/invalid/future 三个负例，虽总验收 `:127` 有提及。**建议：**在实施前同步改正 research §5、exploration §3.4/流程图，并把 M2 三个 timestamp 负例逐项写进里程碑测试清单，避免实现者按错误锚点或只完成一个代表性用例。

## Verdict

CHANGES REQUESTED — address items above
