# Design Review — plan.md (Round 4)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已把 R3 明列的五项修复真实落进 plan/research：状态翻转 CAS 有 per-attempt token，kernel-action 有 claimed→succeeded 原语，branch-delete 拆成两种可恢复模式，关键测试也进入 §8。不过效果探针和 attempt 探针仍各有一条未 fenced 的事务外回写路径，kernel-action delegate 的 denied 零副作用合同也没有被接口强制；这些都是会在竞态或错误 delegate 下破坏权威账的实施阻塞项。

## What's Good (Keep)

- `retry_count` 已进入 accept/intent/terminal/requeue/budget/probe-reschedule/K 的 CAS，reconcile release 还精确匹配 observed lease；这正确关闭了 R3 实测的 attempt 0 迟到结算 attempt 1。
- `commandCasClaimedSucceeded`、deterministic `bu:<id>:<retry_count>`、delegate 注册检查先于 capability consume，以及 K 异常全事务回滚，补齐了 kernel-action 的基本可实现路径。
- `github_branch_delete` 已明确拆成 merged-cleanup 与 recovery-delete；fresh merge proof、bundle verify/list-heads、force-with-lease 和四个零删除测试共同构成了“不进 manual_gate”的正确前提方向。
- §8 已真实包含 schema equal-set、malformed JSON、head+base、attempt token、跨 attempt streak、预算边界及 branch-delete mutation controls；research 的 429、422、分片保序和姊妹 delegate 接缝也已同步。
- 补偿 command 不豁免 notify-then-do、由 planner 自动附带通知依赖，以及 Discord edit/typing/pin 等表现层效果不进 outbox，这三项裁决继续成立。

## Issues & Recommendations

1. **[HIGH] effect probe 的 unknown 簿记仍不在 canonical attempt-token CAS 族中。** §3.2 声明 claimed 后“每一条 CAS”都带 token（`plan.md:80-84`），但 canonical SQL 没有 `commandCasRecordProbeUnknown`；§6.4 只用伪码要求 `streak+1/first_unknown_at/last_probe_at`（`:352-355`）。此外 adopt 分支承诺清 streak（`:345`），而 `commandCasExecutingSucceeded` 并不清这些列（`:96-99`）。这意味着 attempt 0 的慢 unknown probe 若在重排/reclaim 后才回写，实施者没有被 canonical SQL 强制用 `retry_count` 拒掉它；若“加 streak→读阈值→终局”又被拆开，还会提前冻结 attempt 1。**建议**：新增 typed `recordCommandProbeUnknown`/canonical CAS，完整匹配 owner+generation+retry_count，在一个 kernel 事务内原子更新 streak/time 并决定是否 `effect_unknown`+obligation；为 probe-adopt 增独立成功 CAS（或让成功 CAS原子清簿记）。新增变异测试：attempt 0 unknown probe 返回前已重排并 claim attempt 1，迟到回写必须 0 行且 attempt 1 streak 不变。

2. **[HIGH] attempts 探针的事务外快照没有写回 token，能在 FLY-1498 已终结 attempt 后新开永久 obligation。** §6.5 从批量 tmux 枚举直接写 `observed_state/event/obligation`（`plan.md:364-371`），没有规定写回时仍须匹配 `desired_state IN ('dispatched','started')`、原 generation/host_epoch。当前 0002 trigger 只在 attempt **发生** active→terminal 更新时 tombstone 已存在的 obligation（`0002-obligations-rebuild.ts:59-64`）；若探针先读 active、FLY-1498 随后终结、探针最后插入 `attempt_absent`，trigger 已经过期。我按该 trigger 语义用 SQLite 3.51.0 实测，terminal 之后插入的 episode 保持 `open`，而探针以后又不再扫描 terminal attempt，形成永久假告警。**建议**：在 kernel 增加 `recordAttemptObservation(tx, snapshotToken, result)` typed op；同一事务先做带 `id+generation+host_epoch+active desired_state` 的 CAS，再写 observation event，并原子 open/resolve episode，0 行即丢弃陈旧结果。§8 增双连接竞态：absent/unknown 外呼期间 attempt terminalize 或 host_epoch 改代，旧结果不得写 observation、不得产生 open obligation。

3. **[HIGH] kernel-action delegate 可以“先改业务状态、再返回 denied”，计划仍会把业务副作用提交。** §6.7 把完整 `WriteTx` 交给 delegate，并允许其返回 `denied`（`plan.md:393-400`），随后同一 K 事务照常写 denied audit/rejected；但 `WriteTx` 暴露任意 `run/cas`（`kernel.ts:36-39`），且 kernel 明确禁止 SAVEPOINT（`:71-82`），所以接口无法回滚 delegate 在返回 denied 前已经成功的写。现有正反测试只会覆盖“诚实的 denied delegate”，证明不了终版 P12 的“未授权零业务副作用”。**建议**：把 delegate 拆成只读 preflight/decision 与 granted-only apply 两阶段，或限制为由 kernel 执行的单个 canonical business CAS（0 行=denied，1 行=granted）；不要让可返回 denied 的回调同时持有无限制 WriteTx。加入恶意/变异 delegate“写一行后返回 denied”，断言整个动作必须回滚或被接口拒绝。

4. **[HIGH] branch-delete 的 fresh exact-binding 前提尚无权威数据源或跨批次接口。** 表中要求 executor fresh 校验 binding（`plan.md:266`），但 executor 合同又是“纯外发、无 DB 权”（`:286`）；批次1 schema 只有 `attempts.worktree_id`，没有 repo/branch binding，而所引用的 v1 实现实际读取 `StateStore.getWorktreeBinding()`（`branch-cleanup.ts:367-373`）。§6.6 也没有把 binding resolver 冻结给 FLY-1498。实现者只能三选一：违反 adapter 合同直连 v1 DB、把 admission payload 当“fresh”事实，或自行发明权威源；后两者会让错误分支在同 SHA 时仍通过 lease 删除。**建议**：明确一个只读 `resolveBranchBinding` 接缝及其权威（v2 kernel/FLY-1498，或有明确退役期的 v1 StateStore transitional adapter），返回并绑定 repo+branch+worktree/attempt generation；B1/execute 前 fresh resolve，无法确定即零删除。把该接缝加入 §6.6，并让 binding-mismatch 测试覆盖 admission 后权威 binding 变更。research §3.5 也应把“sha 入 payload=可恢复”修成 plan 的“两模式+binding+merge/bundle evidence”条件，避免下游误读成 SHA 单独足够。

## Verdict

CHANGES REQUESTED
