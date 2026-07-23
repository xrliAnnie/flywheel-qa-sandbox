# Design Review — FLY-1423 plan.md (Round 3)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已把 Round 2 的五项要求逐项落实：marker present/unknown 现在 fail closed；absent-owner 由独立 durable abandonment fact 覆盖；probe evidence 保留旧 payload bytes；reservation 使用不换 identity 的 deferred lifecycle promise；alert/audit payload 也已确定化。T1、T2、T4、T5 以及 T3 的判据、存储模型和测试矩阵现在整体完整，scope、顺序和 sibling-contract 隔离均合理。

本轮只剩一个阻塞，但它仍位于 launch authority 的线性化点：计划写出了“旧 commit 与 rollback 只能一个赢家”的目标，却没有给出现有事务实现如何在 marker 文件写入前取得 SQLite writer serialization。`StateStore` 当前的 wrapper 调用默认 `raw.transaction(fn)()`，没有使用 `IMMEDIATE`；`fencedCommitWorkflowLaunch` 又在第一次 DB 写之前先写最终 marker。若只是先 SELECT abandonment fence，跨连接时仍可能出现旧 commit 已写 marker、never-launched rollback 随后插入 fence 并提交、旧 commit 再因 stale snapshot/锁竞争而无法写 `committed_generation` 的矛盾状态。marker 已经对 runner gate 可见，而 DB 又宣称 launch abandoned，这比原事故更危险。

因此 Feasibility 仍高，且除这一点外 Completeness/Correctness 已满足；Risk 只剩 marker-first 文件事实与 DB fence 的原子排序；Scope 无需扩大，只需为这两个 mutation 选择明确的 writer-lock/CAS 机制；Sequencing 与 Consistency 已符合 StateStore-first、fail-closed、checked-append 和 reverse-compat 模式。补齐下面第 1 项后，计划即可进入实现。

## What's Good (Keep)

- T1 的同步 reservation、同 exec replay、全路径 expected-entry cleanup、资源清理解耦与 drain-during-reservation 测试已经构成完整的单飞生命周期合同。
- T2 同时覆盖 throw/return-false，重启后先观察当前 held，且 threshold time 从 durable intent 时间确定计算，符合 outbox exact-payload 约束。
- legacy probe arm 使用 optional discriminator，并在持久化和 replay digest 前规范化回旧 shape，解决了 Round 2 的字节兼容矛盾。
- 独立 abandonment table 能覆盖 owner row 不存在的情况，也避免修改 `delivery_state` CHECK；对 acquire/renew/rotation/commit/repair 的拒绝矩阵方向正确。
- T3b 明确要求 baseline 成功且 commit marker 必须 absent；present 让位 crash repair、unknown hold，保护了既有 marker-after/DB-before 恢复合同。
- T4 的 completed-only payload-ignored replay、确定性 checked audit、reconciler 双守卫和 pre-existing-marker E2E 已经闭环；FLY-1427 非-completed 终态仍 fail closed。
- T5 的无重启证明、execution/session identity、CLI 与 marker 双形态、以及 FLY-1415/1427/1425 定向回归足以支撑最终验收。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[阻塞] marker-first commit 与 abandonment rollback 之间还缺少真实的 DB writer linearization point。**

   **Issue:** `CompatDatabase.transaction` 当前只是 `this.raw.transaction(fn)()`（`packages/teamlead/src/StateStore.ts:193-194`），没有调用 better-sqlite3 的 immediate transaction 变体。`fencedCommitWorkflowLaunch` 在事务里先读 owner（`:15479-15490`），随后写/rename/readback 最终 marker（`:15496-15513`），直到 `:15514-15520` 才执行第一条 DB UPDATE。Round 3 第 82/89 行说所有入口“先查 fence”并由 StateStore 事务保证一个赢家，但一个 SELECT 不会在 marker 写入前取得 writer reservation。

   一个合法的跨连接交错仍然是：A 读取“无 abandonment + owner 有效”→ A 写出最终 marker → B 的 never-launched 事务 INSERT abandonment、换出 node 并提交 → A 尝试把 read transaction 升级为 writer 时失败/抛 busy。此时 A 的最终 marker 不会被清除，runner gate 可能已经看到它；B 的 durable fence 又让 crash repair 永久返回 `launch_abandoned`。现有 marker repair 和新 abandonment 两套权威事实发生冲突，计划声称的“exactly one winner”并未由当前 API 自动提供。

   **Why it matters:** 这是 T3 的最后一个双活窗口。判据、fence table 和后续入口拒绝全部正确，也无法修复“文件 commit 已发布、DB rollback 已提交”这一不可兼容结果。

   **Suggested fix:** 在计划中选择并写死一个 marker-before-publish 的 writer serialization 机制。推荐给 StateStore wrapper 增加 `transactionImmediate`（better-sqlite3 transaction 的 `.immediate()`），仅让 never_launched rollback 分支和 `fencedCommitWorkflowLaunch` 使用它：取得 writer lock 后重新检查 abandonment/current owner/current node，再写 marker/committed_generation 或插入 abandonment/换 node。这样 commit 先拿锁时 rollback 等待并最终看见 committed；rollback 先拿锁时 commit 在写 marker 前看见 abandonment 并返回 `launch_abandoned`。等价方案是 marker 写入前做一条带 `NOT EXISTS abandonment` 的条件 DB write/CAS 来取得 writer reservation，并把 marker write 与最终 owner update 保持在同一事务；不能只做事务外或事务内 SELECT precheck。

   abandonment 检查也应明确位于各 acquire/renew/rotation/commit/repair mutation 自己的事务内，而不是 TOCTOU preflight。把“两种交错”测试落成两个独立 StateStore 连接指向同一临时 DB，并断言最终只能是 `(marker present + committed_generation)` 或 `(marker absent + abandonment)`，绝不允许 marker 与 abandonment 同时存在；loser 返回稳定 `launch_abandoned`/committed refusal，node 与 credential 状态与赢家一致。若使用 IMMEDIATE，只对 never_launched 新分支启用，保持 FLY-1415 probe transaction 模式不变。

2. **[重要] abandonment table 应明确为不可撤销事实，并增加跨 reopen 的持久性 sentinel。**

   **Issue:** 计划称其为 durable fence，但尚未明确表的最小审计字段与是否允许 UPDATE/DELETE。单纯“没有当前删除调用”可以工作，却没有把永久 fence 变成数据库合同。

   **Why it matters:** 任何后续 cleanup/migration 若删除该行，immutable execution binding 仍在，旧 exec 又可被 `recoverOrAcquireWorkflowLaunch` 重新 acquire。

   **Suggested fix:** 表至少包含 `execution_id PRIMARY KEY`、run/node/attempt、`abandoned_at`、reason，并不提供删除路径；按项目现有 append-only 习惯增加 no-update/no-delete trigger，或在 schema contract test 中锁定等价约束。增加 close/reopen StateStore 后所有 launch-authority 入口仍返回 `launch_abandoned` 的测试。此项可与第 1 项一起写回，不需要新增 FSM 或后台任务。

3. **[建议] deferred lifecycle promise 应保持现有 inflight promise 的“completion signal”语义。**

   **Issue:** 计划要求所有失败路径 settle deferred，但未说明 resolve 还是 reject。现有 Blueprint promise 链有 catch 并最终 resolve；若新 deferred 在 prelaunch failure 时 reject，而 `drain()` 尚未订阅，可能产生 unhandled rejection。

   **Why it matters:** start 调用本身已经向 caller throw；inflight promise 的职责只是 drain 等待生命周期结束，不需要再承载错误传播。

   **Suggested fix:** deferred 在 prelaunch failure/abort 时 resolve completion，错误继续由 `start()` 原 promise 抛出；或在创建时立即安装 rejection handler。相应 drain 测试同时监听 unhandled rejection sentinel。该项不改变 T1 总体设计。

## Verdict

CHANGES REQUESTED — address items above
