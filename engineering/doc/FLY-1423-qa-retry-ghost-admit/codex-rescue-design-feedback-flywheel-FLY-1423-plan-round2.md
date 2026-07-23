# Design Review — FLY-1423 plan.md (Round 2)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 是明显的实质改进，Round 1 的五项阻塞和第 6 项交付建议都已写回：T1 现在有同步 reservation、全路径 identity cleanup 和正确的 `run-infra.ts` 装配；T2 覆盖 false/throw 两类 held 且遵守 outbox exact-payload 合同；T4 已限定 completed-only、明确“新 payload 全忽略”的合同，并同时修改 reconciler 两道守卫；T3 也已经把权威重验与 fence 放回 StateStore 事务边界。T4、T2、T5 的设计可以按现计划实施，整体 scope 与交付顺序也合理。

本轮仍不能批准，原因集中在两个新暴露的 launch 权威边界：第一，`committed_generation IS NULL` 时仍可能已经存在 marker-first commit 文件，现有代码把这种状态定义为可恢复的 committed launch，而计划会把它纳入 never-born；第二，owner 行可以根本不存在，此时“更新旧 owner 为 abandoned / bump generation”没有对象可更新，晚到的 `recoverOrAcquireWorkflowLaunch` 仍可为已经被换出的旧 exec 新建 owner。另有两个需要写清的兼容/生命周期问题：probe evidence 的 required `basis` 与“逐字节不变、调用点零改”互相矛盾；pending reservation promise 若未贯穿整个 prelaunch 生命周期，会让 `drain()` 过早完成或永久等待。

按七项 rubric：Feasibility 仍然高；Completeness/Correctness 需要补齐 marker-repair 与 absent-owner fence；Risk 主要是把已物理 commit 的 runner 误回滚，或 rollback 后旧 exec 重新 acquire；Scope 无需扩大到 watchdog/FSM，只需收紧 launch fence；Sequencing 已正确调整为 StateStore-first 和 T4 indivisible slice；Consistency 大体符合 fail-closed/checked-append 模式，但上述 byte-compat 与 shutdown 合同仍需明确。

## What's Good (Keep)

- T1 在首次 `await` 前同步替换 entry，两个 successor 的竞争被压到单一同步临界区；lookup throw、非引擎车道和所有非终态继续 fail closed。
- `abortPreLaunch` 增加 expected entry/token、资源清理与 map 删除解耦、resolve/reject/abort 三态测试，是正确的 cleanup 合同。
- T2 只在本 tick 再次观察到 held 后告警，并让 false/throw 共用结构化 reason；稳定 UID/payload、UID 预检和 restart 行为都已对齐 outbox。
- T3a 先于 T3b、事务内重读 durable intent/current node/session/owner、明确不用持续刷新的 lease 作为年龄依据，以及 late commit 竞态测试，均应保留。
- T4 选择 completed + same exec/route 的新 payload 全部忽略，是简单且可审计的合同；其它 no-out terminal/rowless 仍 409，保护了 FLY-1427。
- reconciler 现在明确修改 pre-check 与 post-200 两道守卫，并为 pre-existing marker 增加 E2E，已覆盖真实事故恢复路径。
- T5 的 Bridge PID/start-time、execution/session identity、定向 sibling regressions 和最终全套测试，构成了可信的无重启验收证据。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[阻塞] never-born 判据必须显式排除 marker-after/DB-before 的可恢复 committed launch。**

   **Issue:** `fencedCommitWorkflowLaunch` 是 marker-first：先写/rename/readback marker，再更新 `committed_generation`（`packages/teamlead/src/StateStore.ts:15496-15524`）。现有测试专门模拟 marker 写完后抛错，并证明此时 marker 存在但 owner 的 `committed_generation` 仍为 null，随后 `recoverOrAcquireWorkflowLaunch` 将它修复为 committed（`packages/teamlead/src/__tests__/StateStore.generalized-execution.test.ts:519-548`；修复实现见 `StateStore.ts:14745-14795`）。Round 2 的四个 durable 判据仍会把这一状态当 never-launched；“保留 activity baseline capture”还不够，因为 `captureDeadExecutionActivityBaseline` 会正常返回 `{state:"present"}` 或 `{state:"unknown"}`，当前计划没有要求这两种状态停止 rollback。

   **Why it matters:** marker 是 runner launch gate 的物理 commit 证据。误把 marker-present/DB-null 当 ghost，会绕过既有 crash repair，换出一个实际已获准启动的 exec，正好制造 T3 试图消灭的双活，并与 delivery-repair 合同冲突。

   **Suggested fix:** 把 T3b 的 fail-closed 条件写成：activity baseline 必须成功，且 `commitMarker.state === "absent"` 才允许调用 never-launched StateStore 原语；`present` 让位给 `recoverOrAcquireWorkflowLaunch` 的 marker repair，`unknown` 本 tick hold。StateStore 事务仍负责 owner/current-node CAS；marker absence 采样后若并发 commit 开始，SQLite owner transaction/fence 必须保证“旧 commit 先完成则 rollback 看见 committed 并拒绝；rollback 先 fence 则旧 commit 拒绝”。新增三项测试：marker-after/DB-before 不回滚并可修复为 committed；marker stat unknown 不回滚；absence snapshot 与 late commit 的两种事务交错都只能有一个赢家。将该条件加入计划图、T3 判据与风险表，而不只是 baseline 采集说明。

2. **[阻塞] fence 必须覆盖“owner 行不存在”以及 rollback 后的重新 acquire，不能只更新已有 generation。**

   **Issue:** T3 判据“owner 无 committed_generation”包含 `getWorkflowLaunchOwner(exec) === undefined`。但计划第 79 行描述的是更新“旧 owner”为 abandoned/fenced 或 generation CAS；无 owner 行时没有更新目标。当前 `recoverOrAcquireWorkflowLaunch` 只检查 immutable execution binding，然后在 owner 缺失时直接 INSERT generation 1（`StateStore.ts:14732-14814`），并不验证该 exec 仍是 current node。即使 owner 原来存在，单纯 bump generation 也只会让已经捕获的旧 token stale；若没有永久 fence，晚到的 recovery 仍可能以新 generation 重新 acquire。现有竞态测试只覆盖 late `fencedCommitWorkflowLaunch`，没有覆盖 late acquire/renew/rotation。

   **Why it matters:** never-born 的定义恰好允许 launch owner 尚未建立。rollback 与 owner acquisition 的先后顺序必须在 durable 层线性化，否则“成功回滚”后旧 exec 仍能获得新 owner/新 credential 并出生，事务内重验就失去意义。

   **Suggested fix:** 在计划中选定一个具体、可迁移的永久 fence，而不是保留“新增状态或 generation CAS”两个未决实现。推荐增加按 executionId 键控的 durable launch-abandonment/fence 事实（独立表可避免修改现有 `delivery_state` CHECK），由 never-launched rollback 在同一事务中无条件 INSERT，即使 owner 不存在；`recoverOrAcquireWorkflowLaunch`、renew、output/submission rotation、`fencedCommitWorkflowLaunch` 和 delivery-repair 入口均先检查该 fence 并返回稳定的 `launch_abandoned`。也可采用等价设计，但必须同时解决 absent owner 和 future acquire。测试矩阵增加：无 owner rollback 后 late acquire 被拒；有 owner 后 late acquire/renew/两类 rotation/commit 全拒；fence INSERT/CAS 失败时 node 与 side-effect 均不改变；probe legacy 路径不写 abandonment。

3. **[重要] `{basis:"probe"}` 与“FLY-1415 逐字节不变、既有调用零触碰”目前是互相冲突的合同。**

   **Issue:** 计划第 70-72 行把 `basis` 设为 required discriminator，但第 71/142 行又要求 legacy probe 路径逐字节不变、既有调用零改。现有调用传的是 `{liveness:"dead", observedAt}`；StateStore 又把 `livenessEvidence` 原样写入 `execution_dead_rolled_back` payload（`StateStore.ts:17458-17472`），并在 idempotent replay 时对 evidence 做 canonical digest 比较（`:17301-17312`）。新增 `basis:"probe"` 会改变持久化 payload bytes，也要求修改所有调用点。

   **Why it matters:** 这是计划宣称保护的 FLY-1415 reverse-compat sentinel。实现者无法同时满足当前两条指令，容易在类型修正时无意改变已有 event/audit 合同。

   **Suggested fix:** 二选一并写死。若要真正 byte-compatible，类型使用 legacy arm `{basis?:"probe", liveness:"dead", observedAt}`，undefined 视为 probe，并在持久化/receipt digest 前规范化为旧的两字段 shape；never_launched arm 才要求明确 discriminator。增加旧调用无需改动、旧 event payload JSON 精确相等、旧 idempotent replay 仍成功的 sentinel。若决定 required `basis:"probe"`，则删除“逐字节/调用零改”承诺并显式迁移所有调用和合同测试；前者更符合本计划的兼容目标。

4. **[重要] T1 reservation 的 promise 必须有完整 settlement 合同，否则 Bridge drain 会挂死或过早 teardown。**

   **Issue:** inflight entry 的 `promise` 被 `drain()` 直接快照并 `Promise.allSettled`（`packages/teamlead/src/bridge/run-dispatcher.ts:1073-1075`）。计划建议在任何 await 前放 `{executionId, promise: pending}`，但没有说明这个 pending promise 如何在 admission failure、TURN/guard abort、Blueprint promise 安装与最终 settle 时贯通。如果后续只是把 `entry.promise` 换成另一个 promise，已开始的 drain 仍持有旧 pending promise，可能永久等待；若用 resolved/null placeholder，drain 又会在 start 仍处于 prelaunch 时提前完成并 teardown runtime。

   **Why it matters:** 该 reservation 是新引入的可见 inflight 状态，必须同时满足单飞与 shutdown。incident path 可通过而 Bridge shutdown 卡死，仍属于高风险生命周期回归。

   **Suggested fix:** 明确 reservation 持有一个 deferred lifecycle promise：从同步安装开始有效；所有 prelaunch success/failure/abort 路径都 settle 它；Blueprint 启动后 deferred 链到真实 run promise，且 entry identity 不更换。增加 drain-during-reservation 测试：admission reject/abort 后 drain 必须完成；admission 成功时 drain 必须等到 Blueprint promise settle；superseded old promise settle 不得 settle 或删除 successor reservation。

5. **[建议] 把 checked-append/alert 的“稳定 payload”落实为确定性字段，避免实现阶段重新引入 exact-payload 冲突。**

   **Issue:** T4 已给 refresh audit 确定性 UID，T2 也声明 stable payload，但两处尚未明确禁止把当前 `now`、HTTP `event_id` 或每 tick reason 放入同 UID payload。`appendWorkflowRunEventCheckedTx`/alert outbox 都会对同 UID 不同 payload fail closed。

   **Why it matters:** 现有“幂等之幂等”和跨一小时测试大概率会捕获问题，但把字段合同写入计划能避免先实现出冲突再返工。

   **Suggested fix:** refresh audit payload 只含 run/node/attempt、原 receipt digest、新 digest、固定合同版本，不含 request eventId/当前时间；若需要时间，使用可重复读取的原 receipt/intent 时间。launch-held 的 threshold time 用 `intent.created_at + 15min` 计算，而不是某个进程首次观察到的 wall clock。保留现有 checked-append 与跨 tick 测试。

## Verdict

CHANGES REQUESTED — address items above
