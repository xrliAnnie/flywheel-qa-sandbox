# Design Review — FLY-1423 plan.md (Round 1)
Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向正确，而且以当前架构可以落地：T1 处理内存 launch 排他，T3 处理 durable never-born 回收，T4 处理 completion receipt 的内容感知幂等，这三个机制边界与 RC-1..RC-4 基本对齐；T2 复用 reconcile tick 和 alert outbox、T5 要求不重启 Bridge 的真机证据，也都合理。

但计划按现文实现会遇到五个实质问题：never-born 会被现有 StateStore 事务守卫拒绝且未 fence 仍可提交的旧 launch owner；inflight 顶替在第一个 `await` 前没有原子占位；marker reconciler 会在 HTTP 前后两次拒绝 digest 刷新；digest 放宽没有限定 `completed`，也不能证明“仅 evidence 变化”；launch-held 告警与现有 outbox 的 exact-payload 去重合同不兼容。因此本轮结论是 **CHANGES REQUESTED**。这些是机制合同缺口，不是实现细节或风格问题。

按评审维度看：Feasibility 高，但需补齐原子 mutation/fence；Completeness 和 Correctness 目前有上述缺口；Risk 主要落在旧 exec 晚提交、双 successor、以及误放宽 FLY-1427 终态合同；Scope 仍可维持一个 PR，无需引入新 watchdog；Sequencing 大方向可用，但 T3 应先定义 StateStore 原语、T4 必须把 store 与 reconciler 作为同一原子交付；Consistency 应继续遵循 fail-closed、identity-check cleanup、稳定 UID 和事务内重验。

## What's Good (Keep)

- 保留 RC-1/2/3 与 RC-4 的分治：launch “已 admit、未出生”问题不应靠 completion 或 per-bug watchdog 掩盖。
- T1 只允许 generalized lane 且只认可 `isNoOutEdgeTerminalStatus`，并把 seam 设计成 optional，符合车道隔离与 fail-closed 的方向。
- T3 复用 FLY-1415 的 bounded blind replacement、held 和 Lead alert，而不是新增另一套 replacement FSM；`basis` 入审计也是必要的。
- T4 坚持异 exec/异 route 仍为真冲突、原 receipt 不改写，并要求 declared-not-landed 补账合同测试，能保护权威边界与后继派发。
- T2 不加新 timer，T5 明确证明“不重启 Bridge 即出现 attempt2 session”，验收信号足够接近本次生产故障。
- TDD、reverse-compat sentinel、兄弟合同回归以及一个 PR 交付是合适的；拆开 T1/T4/T3 会留下可观测但不可恢复的中间态。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[阻塞] T3 的 never-born rollback 按现计划既执行不了，也没有 fence 晚到的旧 launch。**

   **Issue:** `rollbackDeadWorkflowNodeExecution` 当前在自己的事务里再次要求旧 exec 有 terminal session 或显式 teardown；无 session 的 ghost 会返回 `execution_not_terminal`（`packages/teamlead/src/StateStore.ts:17367-17377`）。仅给 `livenessEvidence` 增加可选 `basis` 不会改变这个结果。更危险的是，`recoverOrAcquireWorkflowLaunch` 对同 owner 的每次 reconcile 都会刷新 `acquired_at/lease_expires_at`（`:14823-14843`），所以“intent 60 分钟 = launch lease/凭据自然过期”并不成立；`fencedCommitWorkflowLaunch` 只检查 owner/generation/lease 后即可提交（`:15480-15524`），而现有 rollback 不会废弃该 owner。于是即使先换出新 exec，旧 attempt 仍可能晚到 commit/launch，形成双活。

   **Why it matters:** 这是修 1b 的权威 mutation 边界。只在 dispatcher 做四判据存在 TOCTOU，既会被 StateStore 拒绝，也无法保证 rollback 后旧 execution 永远不能出生；这直接违反“幽灵有界回收且不误双活”的验收目标。

   **Suggested fix:** 把 evidence 改为 discriminated union，而不是松散的可选字段：`{basis:"probe", ...}` 保持现有 FLY-1415 路径逐字节语义；`{basis:"never_launched", intentCreatedAt, ...}` 进入新的事务分支。该分支必须在同一 StateStore 事务内重验：current node/execution 未变、latest ordinal dispatch 确属该 exec 且仍为 `intent_recorded`、session 仍不存在、launch owner 仍无 `committed_generation`、durable intent 已过阈值；随后先原子 fence/abandon owner generation 并 revoke 未消费 credential，再分配 replacement。为 owner 增加明确的 abandoned/fenced 状态或 generation CAS，确保旧 `fencedCommitWorkflowLaunch` 必然得到 stale/fenced。dispatcher 仍应保留现有 activity-baseline capture 与 fail-closed tripwire，而不是从四判据直接跳过到 rollback。增加 StateStore 级逐判据/TOCTOU 测试、baseline capture 失败测试，以及“rollback 后旧 owner 晚 commit 必须失败且不能创建 session”的竞态测试。

2. **[阻塞] T1 的 `delete → 正常 start` 不是原子顶替，cleanup 改法也缺少可用的 identity。**

   **Issue:** start guard 在 `packages/teamlead/src/bridge/run-dispatcher.ts:1195-1207`；通过 guard 后会先 `await admitLifecycle(...)`（`:1234-1240`），到 `:1242-1246` 才构造并写入新 entry。计划先 `this.inflight.delete(key)` 会让 key 在这个 await 窗口为空，两个并发 successor 都可能通过。另一个不完整点是计划要求把 `abortPreLaunch` 的 `:1036` 改成 `entry` identity-check，但该函数当前根本没有 `entry` 参数，且被多个 prelaunch/dispatch/catch 路径调用；如果旧 promise 在顶替后进入该函数，它仍可删除新 entry。生产装配位置也不是 `plugin.ts` 的直接构造：单一生产构造在 `packages/teamlead/src/bridge/run-infra.ts:631-666`，而 `RunDispatcher` 自己还有一层构造函数（`run-dispatcher.ts:1089-1132`）需要透传 seam。

   **Why it matters:** 顶替修的是排他锁本身。没有原子 reservation 与全路径 identity cleanup，会把“前任错误挡住 successor”变成“双 successor 同时 launch”或“旧 cleanup 删除新锁”，TURN belt 不能代替这里的 launch 单飞合同。

   **Suggested fix:** 在首次 `await` 前用唯一 successor reservation/token 原子替换旧 entry；同 exec replay 识别该 reservation，其他 contender 继续 held。admission 失败、正常 finally、以及 `abortPreLaunch` 都必须携带 expected entry/token，只有 `this.inflight.get(key) === expected` 才删除 map；旧 execution 的 registry/claim 清理与 map 删除应拆开，不能因 identity 不同而漏掉旧资源清理。给 `RetryDispatcher` 和 `RunDispatcher` 都追加 optional seam，并在 `createRunInfraDispatcher` 传入 store lookup；lookup 抛错时应记录并按现有 busy 行为拒绝顶替，而不是把 DB 异常泄漏成新的 start 失败语义。补充两个 successor 同时 start、旧 promise resolve/reject/abort 均不删除新 entry、lookup throws、以及所有 no-out-edge 终态的参数化测试。

3. **[阻塞] T4 对 marker reconciler 的“无需新码”判断与现有实现及测试相反。**

   **Issue:** reconciler 在发 HTTP 前就会把同 exec/route 但 digest 不同的 marker quarantine（`packages/teamlead/src/bridge/complete-marker-reconciler.ts:415-431`）；现有测试明确锁定这一行为（`packages/teamlead/src/bridge/__tests__/complete-marker-reconciler.test.ts:614-649`）。即使移除这道预检，HTTP 200 后的验证仍要求 receipt digest 等于 marker digest（`complete-marker-reconciler.ts:647-674`），而新合同又明确“不改写 receipt”，所以该路径会变成 transient failure，仍不会 unlink。

   **Why it matters:** 生产事故的 marker 已经进入 reconciler。只修改 StateStore/event-route/CLI 不能救这一条真实路径；它仍会在 Bridge 本地被隔离或永久保留，修 2 的 E2E 结论会是假阳性。

   **Suggested fix:** 显式修改 reconciler 的两道守卫。预检应维持异 exec/异 route quarantine；只有同 exec+route、权威 session 为 `completed` 且 digest 不同时才向 Bridge replay，让 StateStore 记录 refresh audit。收到 200 后，仅在响应明确 `evidenceRefreshed:true`、receipt 仍等于原值且 canonical binding/route 未变时接受并 unlink；其余 fail closed。把现有 changed-evidence quarantine 测试改为 completed-only refresh success，并保留/新增 terminated、异 exec、异 route、缺失 session 的 quarantine 测试。T5 或一条集成测试还应从“预先存在 marker”开始，不能只调用成功的 CLI，因为后者不会覆盖 reconciler 恢复路径。

4. **[阻塞] T4 的 digest 放宽未限定 `completed`，也没有实现“仅 evidence 变化”的语义边界。**

   **Issue:** receipt replay 分支位于 session terminal 判断之前（`packages/teamlead/src/StateStore.ts:17821-17842`）。按计划只检查 exec+route，会让 `terminated`、`shelved`、`approved` 甚至 session 缺失时的不同 digest 也返回成功；这扩大了 FLY-1427 刻意排除 `completed` 的合同。现有 FLY-1427 测试已经覆盖 terminated + legacy receipt 的精确 replay（`packages/teamlead/src/__tests__/StateStore.fly1427-terminal-immunity.test.ts:220-256`），新分支不能顺手放宽它。其次，digest 覆盖整个 `completionSubmission`，不只是 evidence；仅凭 exec+route 不能证明 `reviewQuestionId`、`sessionRole`、summary、design evidence 等非 evidence 字段没有变化。

   **Why it matters:** 这是 authority-boundary 放宽。范围不准会把本应 409 的终态/内容冲突误判成幂等成功，并使“仅刷新证据”这一审计陈述不真实。

   **Suggested fix:** 新分支必须额外读取并要求 `session.status === "completed"`；其余所有 no-out-edge 状态和 rowless 情形维持 `completion_conflict`。再二选一明确合同：(a) 保存/读取原 canonical submission，比较非 evidence 的语义投影，只允许 evidence 字段变化；或 (b) 把合同诚实改为“completed + same exec/route 的新 payload 被承认但所有变化均忽略”，并测试这些字段绝不会改写 receipt、binding、route 或投影。refresh audit 必须定义确定性 UID：同一新 digest 重放只一条，不同新 digest 可分别审计；建议用 checked append，并测试相同请求的幂等之幂等。event-route 应只透传 StateStore 的明确结果，不自行推断。

5. **[重要] T2 的 held-reason 采集和 outbox 去重合同会漏报或在第二个 tick 抛错。**

   **Issue:** reconcile 中只有异常进入 catch（`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:260-267`），但 launch owner busy/hold 的主路径返回 `false`（`:1180-1187`），所以“catch 存 error.message”拿不到关键 held 原因。另一方面，`enqueueWorkflowEngineAlertTx` 对相同 UID 要求 `payload_json` 完全相同，否则抛 `workflow_alert_uid_conflict`（`packages/teamlead/src/StateStore.ts:16654-16681`）；标题中的动态 blocked duration 或“最近原因”若每 tick 变化，并不会只靠主键自然去重。重启也不会重置 durable intent 的 `created_at`，因此内存 reason map 丢失后可能在首次新失败之前就尝试报警。alert metadata 的 disposition union（`StateStore.ts:23070-23099`）也尚无 `launch_held`。

   **Why it matters:** 1c 是 ghost 回收前的唯一有界可观测性。漏掉 non-throwing hold 会漏报本次主要形态；payload 漂移则可能让整个 reconcile tick 出错，影响其他 run。

   **Suggested fix:** 让 consume 返回结构化的 `{started:false, heldReason}`（或等价结果），统一覆盖 false 与 throw；只在“本 tick 再次确认 held”后评估 15 分钟阈值。用稳定、不可变 payload（固定 intent 创建时间、首次越阈值时间和当次原文原因），并在 enqueue 前查询 UID 是否已存在，或提供显式 idempotent enqueue API；后续 tick 不再构造变化 payload。current exec/side-effect 离开 `intent_recorded` 时清理内存 map。补齐 `launch_held` 类型并测试：`<15m` 无告警、false/throw 两类 reason、跨 1 小时 reconcile 不抛且仍一条、重启后先观察到一次当前 held 才告警。

6. **[建议但需写回计划] 收紧交付顺序和验收矩阵，避免局部绿而机制仍断。**

   **Issue:** 顶层 `T1 → T4 → T2 → T3 → T5` 可以接受，但 T3 目前从 dispatcher 描述开始、T4 又把 reconciler 当作无需改动，容易出现 caller 已放行而 durable mutation/finalizer 尚未具备合同的中间提交。T5 的 assertion C 若只重发一次成功 CLI，也不会证明已有 quarantined/pending marker 可以被恢复。

   **Why it matters:** 这类故障横跨 admission、launch fence、receipt 与 marker finalization；单层单测绿色不能证明闭环。

   **Suggested fix:** T3 内部先实现并验证 StateStore 的 never-launched CAS/fence，再接 dispatcher predicate；T4 将 StateStore + event-route + reconciler + CLI 作为不可拆的合同切片。T5 除现有 A/B/C 外记录 Bridge PID/启动时间以证明无重启，断言 attempt1/attempt2 executionId 与 session 归属，并加入预存在 changed-evidence marker 经 reconcile 后 unlink、receipt 不变、refresh audit 存在且无 quarantine 的证据。最后再跑 FLY-1415 dead/output tripwire、FLY-1427 terminal immunity、FLY-1425 CLI classification 的定向回归，然后全仓测试。

## Verdict

CHANGES REQUESTED — address items above
