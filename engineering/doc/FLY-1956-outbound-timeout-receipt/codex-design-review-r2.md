# Design Review — plan.md (Round 2)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 明显推进了设计：Round 1 的 payload-blind singleflight、50 s 服务端上界、body-read deadline、nudge 过度承诺，以及 `recordSpan` 类型接线都已得到实质处理；Bridge sweeper 与 stage 投影事务也是正确的补强方向。

但计划仍未兑现“所有关键写先持久化、同键即可跨进程核回、stage 顺序不丢”的核心合同。当前有五个阻塞面：consumed fast path 无法为现有 legacy admission 产生的合法 claim 重建 digest；QA `claiming` 占位与 resume 规则互相冲突；stage 仍先发网络再入队且序号状态与事件文件不是一个原子提交；升级前 `event stored but session update failed` 的行会被新 Bridge 错认成 `applied:true`；以及 `complete`/`qa-result` 在 live runtime 仍可越过未结算 stage，开机顺序不能补这个并发关系。另有 sweeper 生命周期、触发去重与断连指标口径需要在实现前写实。

## What's Good (Keep)

- 保留 consumed fast path 位于 mutable canonical resolution 之前的方向。当前 `/decision` 确实在 credential lookup 后才进入 `resolveEngineDecisionCanonical`（`packages/teamlead/src/bridge/workflow-decision-routes.ts:715-738`），而 StateStore 已有 `consumed_client_request_id + consumed_submission_digest` exact-replay 判定（`packages/teamlead/src/StateStore.ts:55961-56005`）。
- 保留 singleflight map 的 router-closure 作用域，并仅对相同 client-visible payload digest 合流。当前请求字段就是 `status`、`summary`、`client_pr_head_sha`（`packages/teamlead/src/bridge/workflow-decision-routes.ts:694-713`），v2 的 digest 边界与现有 API 相符。
- 保留 stage event + projection 同事务的方向。`StateStore` 的 transaction wrapper 直接委托 better-sqlite3（`packages/teamlead/src/StateStore.ts:658-663`），`insertEvent` 与 `patchSessionMetadata` 的现有语句也都是同步 SQLite 写（同文件 `:9755-9822`, `:11396-11468`），可抽成一个清晰的原子方法。
- 保留 `pr_created` 的稳定 CommDB `dedupeId`。现有 `insertInstruction` 会对同 id 同内容返回原 id、对同 id 异内容抛错（`packages/flywheel-comm/src/db.ts:4281-4322`），适合作为跨数据库重放的 sink-side dedup。
- Bridge sweeper 的启动位置可行：HTTP server 在 `startBridge()` 中先 listen 并等待 `listening`（`packages/teamlead/src/bridge/plugin.ts:8244-8254`），complete-marker boot drain 后置到 `:11973-12007`，因此可以在二者之间安全做 loopback replay。
- 保留 20 s deadline 覆盖 fetch、body read 与 parse，并保留 25 s 两请求 / 45 s 三请求两个独立 drill。当前 QA timer 确实在 headers 后、`response.text()` 前清除（`packages/flywheel-comm/src/commands/qa-result.ts:704-723`），v2 已准确修正 Round 1 的测试时序问题。
- 保留诚实的 `response_closed_before_finish_total`、finish-only max，以及 nudge 的 healthy-loop 限定。`EventLoopAttribution.recordSpan` 本来就是 >500 ms wall span（`packages/teamlead/src/bridge/event-loop-attribution.ts:186-200`），v2 的接线方式与该合同一致。

## Issues & Recommendations

1. **Consumed fast path 无法重建所有当前支持的合法 receipt（severity HIGH）**

   **Issue:** v2 依赖 `workflow_execution_runtime.vendor` 重建 `subjectProducerVendor`，缺失就返回 `credential_receipt_corrupt`（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:179-205`）。但 canonical digest 确实绑定这个字段（`packages/teamlead/src/StateStore.ts:55961-55973`），而 `workflow_claims` schema、insert 和 row mapper 都没有持久化 `subject_producer_vendor`（同文件 `:26124-26158`, `:56170-56202`, `:61534-61562`）。runtime row 只在 generalized admission 路径显式插入（同文件 `:37706-37724`）；现仍受支持的 `admitWorkflowExecution` 路径会创建 actor、binding 和 submission credential，却不创建 runtime row（同文件 `:33842-33861`, `:33964-34033`）。对应的 legacy `/decision` 分支仍可接受这种 credential，并从 mutable producer session 的 `adapter_type` 计算 vendor（`packages/teamlead/src/bridge/workflow-decision-routes.ts:824-904`）。因此一个已经合法消费的 legacy QA verdict 可以在首投成功，随后每次 exact replay 都永久 409 corrupt。

   **Why it matters:** 这仍直接破坏目标 1 的“服务端已落账后任何重跑都能拿回 receipt”，而且会命中兼容路径，不只是手工损坏数据库。

   **Suggested fix:** 二选一并写成明确合同：(a) schema migration，把首次消费时的 `subject_producer_vendor` 持久化到 claim；或更简单地 (b) 新增 store receipt-replay 方法，校验 credential 的 `claim_id`、`consumed_client_request_id`、`consumed_submission_digest` 与 claim 的 id/request/submission digest 一致，再仅比较 client-visible 的 status/head/summary 与 claim 持久字段，直接返回原 claim receipt，不重建已经存下的 server-only digest。测试必须覆盖 **无 runtime row 的 legacy admission + 已消费 claim** 仍 200，而不是只测 engine-owned 路径。

2. **QA `claiming` 占位不能同时满足恢复和并发 payload 校验（severity HIGH）**

   **Issue:** 占位只含 `{phase:"claiming", client_request_id, pid}`，EEXIST 读取者被要求复用该 id（计划 `:85-89`）；但 resume 规则又规定任何没有 `recoverable_verdict` 的 marker 都改名 `.unreadable` 并按无 marker 处理（计划 `:91-97`）。这与 crash table 的“读占位复用 id”正面冲突（计划 `:103-111`）。并发读取者还无法从该占位判断自己的 target/status/head/summary 是否与 owner 一致：它可能在 owner 尚未 rename 时归档一个仍活跃的占位，或者把同 id 用于不同 payload。

   **Why it matters:** 该窗口会重新产生两个进程、两个 id 或同 id 异 payload，并且可能让一个进程在没有完整 durable verdict 的情况下发请求；正是 write-ahead 要消灭的未知态。

   **Suggested fix:** 把 ownership lock 与 marker 分开。owner 取得 `<exec>.lock` 后原子发布**完整、可比较**的 marker，再释放 lock；EEXIST contender 只等待/读取完整 marker，绝不读取 `claiming` 文件后发送。对 owner crash 定义 PID/liveness 或有界 stale-lock takeover；partial/claiming 只能在确认 owner 已死后归档并生成新 id。补三类测试：owner 卡在 publish 前、owner crash、并发异 payload；所有网络请求都必须发生在完整 marker 可读之后。

3. **Stage 仍不是 write-ahead，且 `event file + next-seq` 有未覆盖的双发布崩溃窗（severity HIGH）**

   **Issue:** 当前 stage 在内存中生成 `event_id` 后直接 POST（`packages/flywheel-comm/src/commands/stage.ts:197-222`）；v2 在队列为空时仍保留“先直发，三次耗尽后才入队”（计划 `:136-139`）。进程若在首个请求发出后、耗尽入队前被 kill，本地没有 id，Bridge 也可能已经落账。其次，计划在锁内先 rename 事件文件、再另一次 rename `next-seq`（计划 `:132-135`）；kill 落在两者之间时，下一进程会再次分配同 seq。因为文件名还含不同 UUID，两文件都存活，但按文件名排序会以 UUID 决定先后，违反“顺序即真相”。

   **Why it matters:** 第一处重新产生跨进程未知态；第二处可在正常 crash recovery 中重排 `design_review`、`pr_created`、`completed`，直接破坏目标 2。

   **Suggested fix:** 简化成“always enqueue, then flush head”：任何 POST 前先原子发布完整 queue item，成功响应后才 unlink。序号在锁内从已发布文件的最大 seq 推导，或先持久化 reservation 并允许 holes；合同应要求 unique/strictly increasing，不必要求无空洞。并发测试应使用真正并行的 `spawn`，不是阻塞且顺序执行的 `spawnSync`。新增 kill-after-POST-before-response 和 kill-between-file/counter 两个验收窗口。

4. **新 duplicate fast path 会把升级前未投影的 stage 错认成 `applied:true`（severity HIGH）**

   **Issue:** 旧 Bridge 先插 `session_events`，duplicate 立即 early-return（`packages/teamlead/src/bridge/event-route.ts:1495-1509`），stage projection 在后面才执行（同文件 `:2757-2765`）；异常时明确返回 `ok:true, warning:"event stored but session update failed"`（同文件 `:3100-3119`）。v2 的新 CLI 会保留这种 warning 文件，但新 Bridge 的 duplicate 设计假设“投影已由首插事务保证”，直接补副作用并回 `{applied:true}`（计划 `:216-225`）。所以在“新 CLI → 旧 Bridge warning → Bridge 升级 → queue replay”的合法部署序列中，已有 event row 仍没有 stage projection，新 Bridge 却删除 queue obligation。

   **Why it matters:** 这是计划自己的独立部署/兼容承诺会制造的永久漏投影；新事务只能保证升级后首插，不能追溯修复旧行。

   **Suggested fix:** duplicate stage 必须有 legacy repair 分支：读取原 event row 的 stage/timestamp，若 projection 缺失或不晚于该 event，则幂等补投影；若已有更新的 stage，则返回明确的 `applied/superseded` receipt，不能回退 read model。只有完成该判断后才能返回 `applied:true`。加一条迁移测试：预置“event row 存在、session_stage 未更新”的旧 warning shape，再重放并断言 projection 和 trigger 最终结算。

5. **开机顺序不能阻止 live runtime 中 `complete` / `qa-result` 越过 pending stage（severity HIGH）**

   **Issue:** v2 只让 `gate`/`request-review` 在 pending 时 fail closed，却显式放行 `complete`/`qa-result`，理由是 sweeper 的开机顺序（计划 `:141-156`）。但 `complete` 会在运行期独立 POST 新的 `session_completed` event（`packages/flywheel-comm/src/commands/complete.ts:481-517`），QA 也会独立 POST `/api/workflow/decision`（`packages/flywheel-comm/src/commands/qa-result.ts:685-723`）；一次 boot ordering 对这些 live 请求没有 happens-before 关系。同时 queued stage 并非都“终态后无价值”：`design_review`/`pr_created` 触发 review side effects（`packages/teamlead/src/bridge/event-route.ts:2814-2822`），`stage=completed` 还进入 merge/post-ship finalization 分支（同文件 `:2840-2889`）。仅凭 session 已终态就把早于 `terminal_at` 的文件改名 `.stale-terminal`（计划 `:153-168`）可能永久丢掉尚未发生的作用。

   **Why it matters:** 队列文件内部有序不等于它与其它 durable 通道有序；目标 2 的“顺序不乱”和 guaranteed drainer 仍有跨通道缺口。

   **Suggested fix:** 要么所有会越过当前 exec stage obligation 的命令（至少 `complete`，以及能终结同一 exec 的 decision）统一 `STAGE_PENDING` fail closed；要么 Bridge 在处理这些端点前先结算该 exec 的 stage queue，并给出明确原子/并发顺序。不要按“当前终态”盲丢具有 side effect 的 stage；只能在 durable applied/superseded proof 后归档。验收应覆盖 live 场景：pending `pr_created` 后立即 `complete`、pending QA stage 后立即 decision、queued `completed` 遇到 terminal row，而不只测启动顺序。

6. **Sweeper 只有 per-exec 上界，没有单轮/关闭上界或不重入保证（severity MED）**

   **Issue:** “每 exec 3 文件 × 10 s”不是全局 bound；N 个 exec 时一轮最坏是 `N × 30 s`。若一轮超过 60 s，计划中的 `setInterval` 没有声明跳过重入，下一轮可与前一轮同时处理同一目录；`close()` 等待“在飞轮次”也可能任意久（计划 `:147-159`）。当前 Bridge 会在 shutdown 中等待各后台 runtime 后才 `server.close()` / `store.close()`（`packages/teamlead/src/bridge/plugin.ts:13632-13700`），因此 sweeper 必须有与这些组件同等级的 cooperative stop。另外，计划 `:157` 的 7 天删除只列 `.rejected/.stale/.unreadable`，但 `:173` 又说未知 exec 的 active `.json` 也会 7 天清理，规则不一致。

   **Why it matters:** 负载积压越大，越可能产生重入 replay 和 forced dirty shutdown；这会把恢复组件本身变成压力放大器。

   **Suggested fix:** 使用唯一 `inFlightPromise`，tick 命中运行中 pass 就 skip；同时设置全局 files-per-pass 或 wall-clock budget，而非仅 per-exec cap。`close()` 应 clear timer、abort 当前 fetch、在明确短上界内 await。未知 exec 文件要么 rename 为 `.unknown-*` 再走 TTL，要么明确 active-file TTL。测试至少使用多个 exec 证明不重入、全局上界和 bounded close。

7. **`design_review` duplicate 的非 happy path 仍会重复投递 correction instruction（severity MED）**

   **Issue:** v2 只说明 design-review happy path 由 manifest `sourceEventId` 去重（计划 `:219-223`）。现有代码在 unsafe/missing plan 时会走 correction 路径（`packages/teamlead/src/bridge/event-route.ts:358-369`, `:464-469`），该路径调用 `insertInstruction` 时没有 `dedupeId`（同文件 `:375-396`）。新 duplicate replay 会重复执行这个分支并产生多条 correction。现有 CommDB 已支持稳定 dedupe（`packages/flywheel-comm/src/db.ts:4281-4322`）。

   **Why it matters:** duplicate 现在是预期恢复路径；只让 happy path 幂等，会在错误路径制造重复 Runner 指令和噪音。

   **Suggested fix:** `handleCodexAutoTrigger` 的所有 instruction-producing 分支都接受 event-based stable id；至少 correction 使用 `codex-trigger-correction:<event_id>`。测试补 missing-plan 与 unsafe-plan duplicate，而不只测成功 manifest。

8. **`client_aborted_total` 的计划判据仍不能可靠排除 server-side destroy（severity MED）**

   **Issue:** 计划用 `req.on("aborted")`、`req.destroyed`、socket/res 状态从 `res.close` 反推客户端发起方，同时要求 server `res.destroy()` 只计总量（计划 `:230-240`, `:269`）。这些 close-time flags 描述连接已毁，不是毁连接的 authority。**[verified by executing]** 在当前 repo 环境的最小 `http.createServer` probe 中，服务端调用 `res.destroy()` 同样触发了 `req` 的 `aborted`，并在 `res.close` 时得到 `req.destroyed=true`、`headersSent=false`；因此计划列出的两个 client 子判据都会把该 server-side branch 计成 client abort。仓库 CI 的 Node 基线是 22（`.node-version:1`），相同三分支测试必须在该版本证明语义，不能依赖“Node 20 仍触发”的假设。

   **Why it matters:** 这会再次给事故面板一个看似精确、实际混入服务端关闭的指标；Round 1 #7 的语义问题尚未真正关闭。

   **Suggested fix:** 如果没有正向、版本稳定的 remote-close signal，就只发布诚实的 `response_closed_before_finish_total`，删除 `client_aborted_total`。若必须保留子集，则显式标记 Bridge 自己发起的 destroy/cancel 并排除，且把“客户端在完整请求后等待响应时断开”与“请求体中途 aborted”分开定义；在 Node 22 跑 client abort / server destroy / finish 三分支真实 socket 测试。

## Verdict

CHANGES REQUESTED — address items above
