# Design Review — FLY-1423 plan.md (Round 4)
Date: 2026-07-22
Author: Codex
Status: APPROVED

## Summary

Round 4 已关闭 Round 3 的最后一个 launch-authority 缺口。计划不再把“事务内先 SELECT fence”误当成 writer serialization，而是明确给 `CompatDatabase` 增加 better-sqlite3 `.immediate()` wrapper，并只用于 never_launched rollback 与 `fencedCommitWorkflowLaunch`：先取得 writer lock，再重验 abandonment/owner/node，最后才发布 marker 或提交 abandonment。由此，marker-first 文件事实与 DB fence 有了真实的单一线性化顺序；终态互斥式 `(marker present + committed_generation) XOR (marker absent + abandonment)` 可由双连接测试直接证明。

其余 Round 1-3 合同也保持完整：T1 reservation 无 await 空窗且 drain 生命周期闭合；T2 告警 reason/threshold/payload 均稳定；T3 覆盖 marker crash repair、absent owner、未来 acquire、probe byte compatibility 和 bounded replacement；T4 把 completed-only payload-ignored replay、receipt 不改写、audit、event route、reconciler 与 CLI 作为一个不可拆切片；T5 提供无 Bridge 重启的真机闭环证据。

七项评估均通过：Feasibility 与现有架构匹配；Completeness 已覆盖关键竞态和恢复形态；Correctness 的 authority predicates 均在事务内重验；Risk 由 fail-closed marker/fence、identity cleanup 和 sibling regressions 控制；Scope 没有扩展到 per-bug watchdog/FSM；Sequencing 以 StateStore 原语先行且 T4 原子交付；Consistency 符合 optional seam、append-only fact、stable UID、checked append 和 byte-compatible legacy arm 的项目模式。没有剩余阻塞项。

## What's Good (Keep)

- `transactionImmediate` 只作用于 never_launched 新分支和 marker-first commit，既保证跨连接线性化，又不改变 FLY-1415 probe 路径的既有事务行为。
- writer lock 后重新读取 abandonment/current owner/current node，再进行文件或 DB mutation，正确消除了 marker 与 abandonment 双权威并存窗口。
- abandonment table 覆盖 owner-row-absent，具备明确 schema、append-only no-update/no-delete 合同、无删除路径和 close/reopen 持久性测试。
- 所有 acquire/renew/常规及 repair rotation/commit/repair claim 的 fence 判断都落在各自 mutation transaction 内，而不是 TOCTOU preflight。
- marker present 让位给 `recoverOrAcquireWorkflowLaunch` crash repair、marker unknown hold、marker absent 才准入 never_launched，符合现有 marker-after/DB-before 测试合同。
- deferred lifecycle promise 在 prelaunch failure/abort 时 resolve，错误仍由 `start()` 抛出，保持现有 inflight completion-signal 语义并避免 unhandled rejection。
- probe evidence 在持久化和 replay digest 前规范化为 legacy 两字段 shape，真正兑现旧 callsite、event JSON 和 replay 的字节兼容。
- T4 的 completed-only gate、非-completed 终态负测、reconciler 双守卫和确定性 audit payload 把 digest 放宽限制在声明的范围内。
- E2E 同时验证 Bridge PID/start-time、attempt execution/session identity、CLI replay、预存在 marker 恢复和 QA retest 自动派发，验收信号充分。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[非阻塞实现提醒] 双连接竞态测试必须产生真实并发，而不只是顺序调用两个连接。**

   **Issue:** better-sqlite3 API 是同步的；若两个 StateStore 都在同一 JS 调用栈中顺序执行，测试无法真正覆盖一个连接等待另一个 `IMMEDIATE` writer 的交错。

   **Why it matters:** 该测试是 marker/abandonment XOR 不变量的最强证据，伪并发会遗漏锁取得顺序的回归。

   **Suggested fix:** 实现时用 worker thread/子进程或等价的独立执行上下文，加 barrier 控制 commit-first 与 rollback-first 两种顺序；保留共享临时 DB、最终 marker/owner/fence/node/credential 全量断言。此项是测试实现注意事项，不要求修改设计。

2. **[非阻塞实现提醒] `launch_abandoned` 应在每种返回类型中保持稳定、可断言的拒绝形态。**

   **Issue:** acquire/repair claim 使用 status union，renew/rotation/commit 使用 `{ok:false, reason}`；同一 fence 原因横跨多种返回结构。

   **Why it matters:** 若某入口落回 `stale_launch_owner` 或 generic busy，竞态测试仍可能“拒绝了”但失去审计可观测性，也会削弱计划声明的稳定合同。

   **Suggested fix:** 按各方法既有返回 shape 透传同一个 reason 字符串 `launch_abandoned`，并在 fence 矩阵和 close/reopen sentinel 中逐入口精确断言。此项已经隐含在计划中，代码评审时照此核验即可。

## Verdict

APPROVED — ready to implement
