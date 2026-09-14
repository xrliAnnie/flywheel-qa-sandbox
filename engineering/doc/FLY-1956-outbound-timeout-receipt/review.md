# FLY-1956 出站超时与可核回执 — 设计评审收口(review.md)
Issue: FLY-1956 (https://linear.app/geoforge3d/issue/FLY-1956/bridge出站-flywheel-comm-出站调用高频-abortedqa-resultstage-setask-nudge)
日期: 2026-09-13
基于: plan.md(v5)

## 1. Lead 裁定与收口规则

- question `12e8d304`:stage drain 放 CLI 下一次调用前置,本单零 Bridge lifecycle 改动;确定性 harness 是验收门槛,真实 load>30 只作可选证据、永不在生产机诱发。
- question `1563d6c7`:Codex 3 轮 CHANGES REQUESTED 后批 R4 一轮确认轮;R4 APPROVED 即交,否则 **leadAcceptance:R4 条目逐字进 review.md,只修其中阻断级,advisory 归档,不开 R5**;移出本单的 sweeper / inline settle 只在 review.md 列成 follow-up 子单标题,不实现。

## 2. Codex 轮次

| 轮 | 结果 | 项数 | 记录 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 8(5 HIGH) | codex-design-review-r1.md |
| R2 | CHANGES REQUESTED | 8(5 HIGH) | codex-design-review-r2.md |
| R3 | CHANGES REQUESTED | 9(7 HIGH) | codex-design-review-r3.md |
| R4(确认轮) | CHANGES REQUESTED | 10(7 BLOCKING / 3 ADVISORY) | codex-design-review-r4.md |

## 3. R4 处置表(阻断级已在 plan v5 修;advisory 归档)

| R4 # | 级别 | 处置 | plan v5 落点 |
|---|---|---|---|
| 1 `process.exit` 绕过 `finally` | BLOCKING | 已修:`runQaResultCore` 返回 exitCode,锁内零 exit;真实子进程测试 | §3.2, §8.1 |
| 2 `wx` 单文件锁 TOCTOU / PID 复用 | BLOCKING | 已修:QA 与 stage 两处锁复用 `flywheel-config` `withMkdirLock` | §3.2, §4.2 |
| 3 门命令查错 exec / 非线性化 fence | BLOCKING | 已修:wrapper 解析有效 exec;fence 模式在 publisher 同一把锁内 drain+复扫+持锁写入 | §4.3 |
| 4 `applied:true` 无 durable settlement;ProofShot | BLOCKING | 已修:逐分支 Settlement;sink 异常上浮为 pending;ProofShot sink-first + `proofshot:<event_id>:<attempt>` 稳定 id/outputDir | §6.2 |
| 5 `completed` transition 后 finalization 前 crash | BLOCKING | 已修:「同事件已应用」分支重进 `runResumablePostShipFinalization` + 幂等 archive;非法转移 → superseded | §6.2 |
| 6 `insertStageChangedEvent` 契约 / 归档行 | BLOCKING | 已修:inserted/duplicate/payload_conflict 三态 + 完整持久化行(热表或 `findArchivedTerminalRow`);latest 覆盖归档 | §6.1 |
| 7 receipt corrupt 校验漏 family / event_type | BLOCKING | 已修:corrupt 全集(decision_kind=family、issuer_node、capability 绑定、lead event 类型与 payload) | §5.1 |
| 8 follow-up 需真实 issue id | ADVISORY | 归档;follow-up 子单标题见下;建单交 Lead | §14 |
| 9 seq 唯一性措辞 | ADVISORY | 归档;措辞已顺手改为「同时存续项中唯一」并加清空后重 enqueue 测试 | §4.2, §9 |
| 10 `gate --stage` 第二 producer | ADVISORY | 归档;已写入非目标 + follow-up 标题 | §1, §14 |


## 4. Follow-up 子单标题(不实现,建单交 Lead)

1. **stage-queue Bridge sweeper + 终态信号 per-exec 结算围栏** —— 承接 Codex R2 #5/#6、R3 #6/#9、R4 #8:开机 + 60 s 周期 drain(单 inFlight、全局 absolute deadline、`stop()` 与 `store.close` cooperative 合同、未知 exec `.unknown-*`、TTL);`session_completed` / `/decision` 前的 `withSettledStageFence(execId, mutation)`。
2. **`gate --stage` 并入 stage 队列** —— R4 #10。

## 5. R4 条目逐字(Codex 原文)

## Issues & Recommendations

1. **[BLOCKING][HIGH] `process.exit()` 会绕过 `finally`，所以 QA 的整次调用锁在真实 CLI 中不会可靠释放。**

   **为什么重要：** v4 要求锁在 `qaResult()` 入口取得并在 `finally` 释放（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:73-97`），但现有函数在参数拒绝时直接 `process.exit(1)`（`packages/flywheel-comm/src/commands/qa-result.ts:563-595`），预算耗尽时也直接退出（同文件 `:924-939`），确定性拒绝 helper 同样直接退出（同文件 `:1370-1383`）。Node 的 `process.exit()` 不会展开 JavaScript `finally`；**[verified by executing]** 本机最小 Node probe 以 exit 7 终止且 finally 标记未写。现有单测把 `process.exit` mock 成“抛异常”（`packages/flywheel-comm/src/commands/__tests__/qa-result.test.ts:307-318`, `:394-403`），反而会执行 `finally`，因此 v4 所列测试可在生产锁仍残留时误绿。

   **建议修复：** 把持锁核心重构为返回 `{exitCode, outcome}` 或抛 typed sentinel，锁内任何路径都不得调用 `process.exit()`；`runQaResult` 在 awaited core 的 `finally` 已完成后再设置 `process.exitCode`。纯参数校验可移到取锁前。除 mocked-unit tests 外，新增真实 child-process 用例覆盖 deterministic refusal、exhaustion、UNRECORDED 和 marker conflict：进程以预期码退出后，lock 必须不存在或可立即重取。

2. **[BLOCKING][HIGH] 两个 `wx` 单文件锁的 dead-owner 接管仍有 TOCTOU，并且 `started_at` 没有解决 PID reuse。**

   **为什么重要：** v4 的接管步骤是“读 nonce → 判断 ESRCH → 确认 nonce 未变 → unlink → 重新 wx”（计划 `:75-95`, `:139-145`）。文件系统没有 conditional-unlink：两个 contender 都可观察旧 dead nonce，其中一个创建 successor 后，另一个在最后一次读取与 `unlink` 之间删除 successor，形成双 owner。另一方面，崩溃 owner 的 PID 若已被无关活进程复用，`kill(pid,0)` 永远不会给 ESRCH，`started_at` 字段又未参与身份比较，合法 marker/queue 会永久 wedged。

   **建议修复：** 复用代码库已有的 `withMkdirLock`，不要再造共享 pathname 的 file lock。该实现使用 atomic `mkdir` 和唯一 holder marker（`packages/config/src/mkdir-lock.ts:1-15`），用 PID + process start identity 识别 PID reuse且绝不 age-steal 可证明存活的 owner（同文件 `:185-224`），并按已观察 inode 删除 marker、让 replacement holder 导致 `rmdir` fail-closed（同文件 `:227-273`）。它已从 `flywheel-config` 导出（`packages/config/src/index.ts:156-162`），而 `flywheel-comm` 已依赖该包（`packages/flywheel-comm/package.json:74-78`）。为 QA/stage 分别配置 60 s/10 s wait，并新增“stale breaker 与 successor acquisition 交错”及 PID reuse 测试。

3. **[BLOCKING][HIGH] `gate` / `request-review` 的前置检查既可能检查错 exec，也不是与 stage publisher 共享的线性化 fence。**

   **为什么重要：** v4 只在 `main()` 中按 `FLYWHEEL_EXEC_ID` flush（计划 `:147-152`），但当前 `gate` 强制从 `--exec-id` 取目标（`packages/flywheel-comm/src/index.ts:2114-2147`），`request-review` 也优先采用 `opts.execId` 而非 env（`packages/flywheel-comm/src/commands/request-review.ts:53-62`），QA 同样允许 `--exec-id`（`packages/flywheel-comm/src/commands/qa-result.ts:589-595`）。因此 env 缺失或与 flag 不同就会检查错误目录。即使 exec 正确，v4 没要求 flush + 最终空扫描持有 publisher 的同一把锁：gate 可在扫描空之后与一个尚未 publish 的 stage 交错，然后写入 durable question（`packages/flywheel-comm/src/commands/gate.ts:184-213`）；request-review 也会先写 intent、再 POST（`packages/flywheel-comm/src/commands/request-review.ts:97-138`）。这不满足“pending 时零副作用”。

   **建议修复：** 在 command-specific wrapper 中先解析**有效 exec id**，再调用 per-exec preflight；不要让全局 env 猜目标。preflight 必须取得与 publisher 相同的 robust lock，在锁内 drain、再次扫描并把“队列为空”作为 gate/request-review 的线性化点；目录不可读、解析失败或状态无法证明为空时必须 fail-closed。测试加入：(a) flag-only exec；(b) flag 与 env 不同；(c) publisher 卡在 atomic publish 前、preflight 与其竞态；断言 gate/request-review 不会越过在线性化点之前已发布的事件。

4. **[BLOCKING][HIGH] `applied:true` 仍没有等待或检查投影后义务的 durable settlement；dedupe id 只防重复，不能证明已经写入。**

   **为什么重要：** 当前 Codex correction 与 happy-path instruction helper 都捕获写失败并返回 `void`（`packages/teamlead/src/bridge/event-route.ts:375-396`, `:505-527`），而 ProofShot 被 fire-and-forget 调用（同文件 `:2824-2838`）。ProofShot 还会先把状态写成 `pending`，然后才 await mailbox/CommDB 写（`packages/teamlead/src/bridge/proofshot-trigger.ts:236-274`, `:309-368`）；若在两者之间崩溃，同键 replay 在 30 分钟内会把该 pending 当成“active”直接返回（同文件 `:236-248`）。如果 `applyStageEvent` 随即发 `applied:true`，CLI 会删掉唯一 replay 文件，义务可能从未 durable。固定 `proofshot:<event_id>` 还有内容冲突：ProofShot retry 会增加 attempt 并生成新的随机 outputDir（同文件 `:251-307`），而 `insertInstruction` 对同 dedupe id 的不同 content 会抛错（`packages/flywheel-comm/src/db.ts:4281-4307`）。

   **建议修复：** 让 `applyStageEvent` 返回结构化 settlement，并且只有每个适用分支都得到“durably written / exact duplicate”时才回 `applied:true`；任何被捕获的 sink error 必须上浮为 warning/transient，使 queue file 保留。ProofShot 必须 await sink receipt，并重排为“以稳定的 per-event/per-attempt sink id 写入（同 attempt 的完整 payload 必须持久稳定）→ 再标 pending”，或使用 durable outbox；不能靠 pre-write pending 推断 delivery。增加 sink throw、pending-write 后 crash、sink-write 后 state-write 前 crash、TTL retry 四个测试。

5. **[BLOCKING][HIGH] `completed` 的 duplicate replay 仍无法修复“transition 已提交、finalization/archive 未执行”的崩溃窗。**

   **为什么重要：** v4 说重复 transition 被拒绝后可依赖 finalization 自带守卫（计划 `:209-228`），但当前 W2 路径只有本次 `applyTransition` 成功、`transitionApplied=true` 时才调用 `runPostShipFinalization`（`packages/teamlead/src/bridge/event-route.ts:2915-2970`）；首次 transition 成功后若在调用 finalizer 前崩溃，duplicate replay 会因 session 已 completed 而被 FSM 拒绝，finalizer再次被跳过。FLY-324 同理：只有本次 transition 成功才设置 `fly324Completed`（同文件 `:3024-3089`），而 terminal archive enqueue 又要求该 flag（同文件 `:3306-3330`）。此外计划测试声称 `runPostShipFinalization` 返回 `idempotentReplay:true`，实际公开函数签名是 `Promise<void>`（`packages/teamlead/src/bridge/post-ship-finalization.ts:620-635`）；返回 resumable report 的是另一个入口（同文件 `:706-716`）。

   **建议修复：** 为持久 stage event 定义“已由该 event 完成 transition”的可证明 replay 分支：W2 即使 status 已 completed，也必须重新进入并 await resumable finalization；FLY-324 也必须重做幂等 terminal-archive admission。不能把所有 FSM rejection 等同于安全完成，需要区分“同 event 已应用”与真正非法/乱序 transition。把 crash injection 精确放在 `applyTransition` 提交之后、finalizer/enqueue 调用之前；replay 后断言 finalization completion receipt 和 archive admission 均 durable，再允许 `applied:true`。

6. **[BLOCKING][HIGH] `insertStageChangedEvent` 的返回契约不足以实现“以持久事件行为输入”，且没有覆盖已归档 duplicate。**

   **为什么重要：** v4 的方法只返回 `{id, ts}`，但 `applyStageEvent` 需要 event envelope、source 和完整 payload；duplicate 若继续借用当前请求 body，就不再是持久事实驱动，也无法识别同 `event_id` 异 payload。更直接的是，现有 `insertEvent` 在 hot insert 前会先查 terminal archive，命中即返回 duplicate（`packages/teamlead/src/StateStore.ts:9755-9760`）；`stage_changed` 明确属于可归档 event type（`packages/teamlead/src/terminal-row-archive.ts:11-17`），retention 为 7 天（同文件 `:4-8`）。v4 又明确 active `.json` 无 TTL、可能等未来 CLI/follow-up 才重放，所以合法 queue file 可以在源 row 已归档后抵达。计划的 latest SQL 只查 hot `session_events`，此时既拿不到 `thisRow`，也无法安全判断 superseded。

   **建议修复：** 把 StateStore 结果改成显式 union，并返回**完整 canonical persisted row**（hot 或 `workflow_terminal_archive`），例如 inserted / duplicate / payload-conflict；`findArchivedTerminalRow` 已能返回完整 `row_json`（`packages/teamlead/src/terminal-row-archive.ts:230-247`）。latest-stage 判定必须覆盖 hot + archived rows，且所有 envelope/payload 校验使用 persisted row。新增：同 id 异 payload、7 天后 archived-latest replay、archived older row 被 hot newer row supersede 三类测试。

7. **[BLOCKING][MED] receipt corruption 校验仍漏掉 credential family 和 lead-event 类型，未完全实现 Round 3 已接受的 durable binding。**

   **为什么重要：** 首投把 credential `family` 写进 claim 的 `decision_kind`（`packages/teamlead/src/StateStore.ts:56181-56187`），而 family 到 predicate 是封闭映射（`packages/teamlead/src/workflow-claims.ts:42-57`）；v4 的伪代码却只校验 run/node/attempt/issuer execution，没有验证 `claim.decision_kind === credential.family`。同样，现有 receipt helper只把 `event_type='workflow_claim_recorded'` 的行视为 claim receipt（`packages/teamlead/src/StateStore.ts:55869-55906`），v4 的新 SELECT 却仅按 `event_id`，一个错误类型但相同 id 的单行会被当成合法 receipt。既然该分支以 `credential_receipt_corrupt` fail-closed 为合同，这两处不能省略。

   **建议修复：** 至少校验 `decision_kind === family`、`issuer_node_id === credential.node_id`，并校验 claim authority 与 `decision_capability_id` 的现有绑定；lead-event 查询必须限定 `event_type='workflow_claim_recorded'`，并验证 payload 中的 claim/run/node/attempt 与 claim 一致。补 family-crosslink、wrong event type、wrong issuer node/authority 的 zero-write corrupt tests。

8. **[ADVISORY][MED] CLI-only drainer 的残余风险已诚实披露，但 follow-up 必须成为可追踪交付物。**

   **为什么重要：** `stage_changed` 不只是显示字段：它会触发 Codex（`packages/teamlead/src/bridge/event-route.ts:2814-2822`）、ProofShot（同文件 `:2824-2838`）和 completed 路径（同文件 `:2840-3089`）。按 Lead ruling，runner 退出且再无同 exec CLI 调用时，queue 可以无限保留；`STAGE_PENDING_OVERTAKE` 只是观测，不是 settlement。这是已接受边界，不是本轮 blocker。

   **建议修复：** 在本 PR 收口前创建真实 follow-up issue id，替换 `FLY-TBD`，并把 §14 的 R2 #5/#6、R3 #6/#9 acceptance input 原样带入。保留 OVERTAKE 计数/日志作为优先级证据，不要在本单偷偷加入 Bridge lifecycle 行为。

9. **[ADVISORY][LOW] `seq` 的“每 exec 唯一、严格递增”表述与 unlink-on-landed 不一致。**

   **为什么重要：** v4 从“当前已发布文件”的最大前缀加一取 seq，同时 landed 后删除文件（计划 `:139-150`）。当目录完全 drain 后，下一条会重新从 1 开始，所以它只对**同时存续的 pending/renamed 文件**唯一有序，并非 exec 生命周期全局唯一。

   **建议修复：** 若全局唯一不是必要合同，直接把 §4.2/§9 改成“在同时存续的队列项中唯一且严格有序”；若确实需要生命周期单调，则保留 watermark/tombstone。新增“全部 landed/unlink 后再 enqueue”的断言，避免测试只覆盖非空目录。

10. **[ADVISORY][LOW] `gate --stage` 仍是绕过新 stage queue 的第二个 producer，应明确范围。**

   **为什么重要：** 当前 gate 在 durable question 已创建后调用独立的 best-effort stage POST（`packages/flywheel-comm/src/commands/gate.ts:191-218`），其 helper 自己生成新 event id 并直发（同文件 `:364-390`）。因此 v4 只修 `flywheel-comm stage set`，不会让 `gate --stage` 获得 write-ahead/replay 语义。

   **建议修复：** 若本单只承诺显式 `stage set`，在非目标和 follow-up 中明确列出 `gate --stage`；否则让它复用同一个 enqueue API。不要保留两个语义不同却都叫 stage report 的实现而不说明。


