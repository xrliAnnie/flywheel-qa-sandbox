# Design Review — plan.md (Round 3)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 对 Round 2 的 8 项反馈都做了实质响应：receipt replay 不再重建不可重建的 digest；QA marker 与所有权锁分离；stage 改为 enqueue-before-send；Bridge 增加 sweeper 与终态前 inline settlement；duplicate repair、触发 dedupe、shutdown 和指标口径也都明显更完整。这些方向应保留。

但当前版本仍未闭合核心的“持久义务只能由可核回执删除”保证。最直接的反例是：新 CLI 对旧 Bridge 首次收到 `ok+warning` 后保留文件，下一次同键重放会收到裸 `duplicate:true`，v3 却把它当 landed 并删除；现有 Bridge 的 duplicate early-return 确实发生在 `stage_changed` 投影之前。另有 QA 锁过早释放、两种 age-only 锁接管、秒级 timestamp 排序、inline settlement 缺少跨进程 fence，以及已消费 receipt 被 settlement 阻塞等并发/恢复缺口。因此本轮仍需修改后再实施。

## What's Good (Keep)

- 新的 `replayWorkflowDecisionReceipt` 方向正确。现有 credential 已持久化 `consumed_client_request_id`、`consumed_submission_digest` 和 `claim_id`（`packages/teamlead/src/StateStore.ts:54418-54425`），claim 也持久化 predicate、subject digest、submission digest、client request id 与 evidence（`packages/teamlead/src/StateStore.ts:61534-61562`），足以实现不依赖 git/gh 的 receipt 校验。
- 保留“claim、lead-event receipt、credential consumption 同一事务”的边界是正确的；当前首投路径确实在一个事务中写 claim、确保 lead event、再写 credential consumed columns（`packages/teamlead/src/StateStore.ts:56170-56235`）。
- `stage set` 改成无直发路径、POST 前已有稳定 `event_id`，并让 warning 保留文件，比 v2 的 crash window 更可靠。现有 CLI 每次生成新 `event_id` 后立即直发（`packages/flywheel-comm/src/commands/stage.ts:178-213`），所以该改动直接修复了 kill-before-enqueue 缺口。
- 把 event insert 与 stage read-model projection合并进事务是正确方向。当前事件先独立提交（`packages/teamlead/src/bridge/event-route.ts:1495-1504`），投影稍后才发生（`packages/teamlead/src/bridge/event-route.ts:2757-2765`），而异常仍返回 2xx warning（`packages/teamlead/src/bridge/event-route.ts:3100-3119`）。
- 给 correction 与 happy-path instruction 使用事件稳定 dedupe id 是必要的。现有 correction 和普通 code-review 分支都调用无 dedupe id 的 `insertInstruction`（`packages/teamlead/src/bridge/event-route.ts:375-385`, `packages/teamlead/src/bridge/event-route.ts:505-517`），而 CommDB 已支持并校验 caller-supplied `dedupeId`（`packages/flywheel-comm/src/db.ts:4281-4305`）。
- pressure metric 删除无法证明发起方的 `client_aborted_total`、仅保留 close-before-finish，以及把 `recordSpan` 接到 composition root，口径是诚实的；现有 `EventLoopAttribution.recordSpan` 已有清晰的 >500 ms 语义（`packages/teamlead/src/bridge/event-loop-attribution.ts:186-200`）。
- nudge 新文案与现有系统一致：doorbell 只是提示（`packages/flywheel-comm/src/lead-inbox-nudge.ts:34-37`），Lead loop 的 idle poll 默认确实为 30 秒（`packages/teamlead/src/bridge/lead-inbox-loop.ts:29-30`, `packages/teamlead/src/bridge/lead-inbox-loop.ts:193-203`）。

## Issues & Recommendations

1. **旧 Bridge 的裸 `duplicate:true` 仍被误当成 applied receipt。**  
   **为什么重要：** §4.1 把无 `applied` 的旧 Bridge duplicate 分类为 landed 并 unlink（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:126-134`），但现有 Bridge 在发现重复 event 后立刻返回 `{ok:true, duplicate:true}`（`packages/teamlead/src/bridge/event-route.ts:1495-1509`）；`stage_changed` 投影在其后很远才执行（`packages/teamlead/src/bridge/event-route.ts:2757-2765`）。因此确定性失败序列仍是：第一次 insert 成功、投影异常、Bridge 返回 warning；文件保留；对同一个旧 Bridge 重放得到裸 duplicate；CLI 删除文件；升级后的 legacy repair 永远没有重放载体。这也直接反驳 §10 声称的“新 CLI → 旧 Bridge warning → Bridge 升级 → 重放”保证（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:311-318`）。  
   **建议修复：** 对缺少 `applied`/`superseded` 的 duplicate 一律视为“receipt 不足”，保留文件并停止该 exec；只有新 Bridge 的显式 `applied:true` 或 `superseded:true` 才 unlink。把 §8.1 的“旧 Bridge duplicate → unlink”改为两步迁移测试：old warning → old naked duplicate 仍保留；切换新 Bridge → repair 返回 applied/superseded 后删除。  
   **严重度：HIGH**

2. **QA 所有权锁在首次 fetch 前释放，却把后续换 id + push 当作仍由“同一 owner”拥有。**  
   **为什么重要：** §3.2 明确在 marker rename 后 unlink lock，再允许 fetch，但授权 land-head push 前的 marker 更新“不再取锁”（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:71-100`）。现有授权路径会生成新的 `client_request_id`、覆写 marker，然后执行 push（`packages/flywheel-comm/src/commands/qa-result.ts:799-854`）。两个同 exec 进程可在首个 marker 发布后同时发送旧 id，随后分别生成新 id、并发覆写 marker并 push；最终一个 id 可能已消费而磁盘留下另一个 id，下一次只能得到 payload mismatch。状态图还说 lock 年龄 >60 秒即可 takeover，而正文同时说活 owner 在 60 秒后应 exit 2，合同自相矛盾（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:75-95`）。  
   **建议修复：** 最简单且安全的边界是让 owner 持锁覆盖整个 `qaResult` invocation：初始 marker、所有重试、authorized id transition、push、最终 clear/terminal marker 全部在同一 ownership tenure 内；在 `finally` 释放。活 PID 无论锁年龄都不得 takeover，超过等待预算只 exit 2；只有确认 ESRCH 的 dead owner 才接管。新增“contender 在首个 409 后、authorized marker/push 前启动”的确定性测试，并断言只有一个新 id 和一次 mutation budget。  
   **严重度：HIGH**

3. **stage enqueue 的 age-only `.lock` 接管可让两个活 writer 分配同一 seq。**  
   **为什么重要：** §4.2 规定目录锁 mtime 超过 30 秒就无条件 `rmdir`，同时承诺 seq 唯一且严格递增（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:136-141`）。若 owner 被 `SIGSTOP`、I/O stall 或长暂停超过 30 秒，第二个进程会移除仍有效的锁并从同一个 published maximum 计算相同 seq；第一个恢复后也会 publish。因为文件名还含不同 UUID，两份文件都能存在，却共享 seq，排序只能退化为 UUID 字典序，违反声明的 runner 顺序。  
   **建议修复：** 锁内持久化 `{pid, started_at, nonce}`，只在确认 PID 不存活时接管；或使用无需 stale-age stealing 的原子 sequence reservation/CAS。与 QA 锁保持同一 liveness 规则。测试必须覆盖“mtime >30 秒但 PID 仍活时不可偷锁”和“dead PID 可恢复”，不能只测强制移除 stale lock。  
   **严重度：HIGH**

4. **legacy repair 用秒级 timestamp 判断先后，无法处理同一秒内的两个 stage。**  
   **为什么重要：** §6 用 `Date.parse(session.stage_updated_at) < Date.parse(row.ts)` 决定应用还是 supersede（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:222-235`）。但 `session_events.ts` 的默认值是 SQLite `datetime('now')`，只有秒级精度，且表已经有严格递增的 `id INTEGER PRIMARY KEY AUTOINCREMENT`（`packages/teamlead/src/StateStore.ts:5282-5293`）；Bridge 的 `sqliteDatetime()` 同样主动去掉毫秒（`packages/teamlead/src/bridge/types.ts:6-10`）。若 stage A 已投影，随后同一秒的 stage B 只插行后 warning，升级后重放 B 会看到相等 timestamp + 不同 stage，从而错误返回 superseded，永久保留 A。代码库自己也明确记录过“1s resolution 不能决定 latest”的先例（`packages/flywheel-comm/src/db.ts:4273-4277`）。  
   **建议修复：** legacy repair 以 `session_events.id` 为顺序权威，而不是 `ts`。无 schema 变更的做法是：重放时选该 exec 最新的有效 `stage_changed` row（按 id），把 read model投影到最新 row；当前 replay row 不是最新则返回 superseded。新增两个 event 强制同 ts 的测试：A 已投影、B legacy-warning 后重放 B 必须应用 B；再加 B 后已有 C 时重放 B 不得回退 C。  
   **严重度：HIGH**

5. **已消费 credential 的不可变 receipt replay 被可失败的 stage settlement 前置阻断。**  
   **为什么重要：** §4.5 要求 `/decision` 基础校验后先 `settleExec`，失败即 503；§5.2 又把 settlement 与 receipt fast path 都放进 `runDecision`，但没有规定 consumed receipt 优先（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:166-172`, `engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:214-220`）。于是一个已经成功消费但丢失响应的 QA 重跑，可因后来出现的 stage 文件、warning 或 Bridge loopback 故障持续得到 503，而不是由已持久化 claim 得到回执。这违反目标 1 的“任何后续重跑”以及 receipt 只依赖持久事实的设计。当前 route 在基础校验后已经先取得 credential row（`packages/teamlead/src/bridge/workflow-decision-routes.ts:694-720`），因此可安全分流。  
   **建议修复：** 顺序固定为：基础字段校验 → credential lookup → `replayWorkflowDecisionReceipt`。它返回 success/mismatch/corrupt 时立即响应；仅返回 `undefined`（未消费）时才执行 `settleExec`，随后进入 mutable canonical/consume。这样新 mutation 仍服从 stage happens-before，旧 receipt 不引入任何新状态变化。为“consumed credential + pending/transient stage file”加测试，必须仍返回原 200 receipt 且不调用 sweeper/git/gh。  
   **严重度：HIGH**

6. **inline settlement 只是 pre-check，没有把“队列为空 → 终态提交”围成一个跨进程 linearization fence。**  
   **为什么重要：** §4.5 声称终态接受前同 exec 的 stage 已全部 settled（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:166-172`），但 `inFlight` 只串行化 Bridge sweeper/settle 调用；CLI publisher 是另一个进程，只遵守 §4.2 的文件锁。`settleExec` 最后一次扫描为空后、route 消费 credential 或持久化 `session_completed` 之前，CLI 仍可 publish 一个更早启动的 stage 文件，终态随后越过它。  
   **建议修复：** 定义并实现 per-exec `withSettledStageFence(execId, terminalMutation)`：取得与 publisher 共享的健壮锁，drain 后在锁内重新扫描为空，并持续持锁到终态 StateStore mutation/credential consume 已提交；随后释放。新 stage 只能线性化在终态之前并被 drain，或在线性化于终态之后。新增 barrier 测试：publisher 卡在 publish 前，settlement 完成最后扫描时释放 publisher；断言不可能出现“stage 文件已发布但终态先提交”。  
   **严重度：HIGH**

7. **新 Bridge 的 duplicate `applied` 路径没有覆盖现有 `stage_changed` 的全部 post-projection 义务。**  
   **为什么重要：** §6 只列出 display refresh、reconnecting 与 Codex auto-trigger 的补做（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:222-237`），但现有 stage handler 在投影后还启动 ProofShot（`packages/teamlead/src/bridge/event-route.ts:2824-2837`），并对 `stage=completed` 执行 merge eligibility/FSM/post-ship finalization（`packages/teamlead/src/bridge/event-route.ts:2840-3023`）或 FLY-324 terminalization（`packages/teamlead/src/bridge/event-route.ts:3024-3089`），后者还驱动 terminal archive enqueue（`packages/teamlead/src/bridge/event-route.ts:3306-3330`）。Bridge 若在新原子 insert+projection 提交后、这些分支前 crash，重放若只补 §6 所列动作却返回 `applied:true`，sweeper 就会删除唯一重放载体。§4.4 自己也承认 completed 分支是不可盲丢的 side-effect obligation（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:149-164`）。  
   **建议修复：** 抽出一个以持久 event row 为输入的幂等 `applyStageEvent`/settlement pipeline，并明确 `applied:true` 的边界：所有需要 replay 的 stage 分支均已持久完成或已有各自 durable outbox/checkpoint。至少把 ProofShot 与两种 completed 路径纳入 duplicate replay/恢复矩阵；为“事务已提交后、Codex/ProofShot/completed 分支前 crash”分别加测试。不能在只修 read model 后就发 `applied:true`。  
   **严重度：HIGH**

8. **receipt 方法仍通过 mutable identity resolver“补造”lead event，与“返回原始 receipt”不一致。**  
   **为什么重要：** §5.1 的新方法签名没有 identity，却在伪代码中调用 `ensureWorkflowClaimLeadEventTx({claim, run, identity})`，随后又要求从当前 session/run 解析 identity（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:189-212`）。现有 helper 确实要求 `run` 和 `identity`，且当 event 不存在时会用当前 identity 创建新 lead event（`packages/teamlead/src/StateStore.ts:55863-55906`）；composition-root resolver 又读取当前 run、session labels 和 projects 配置（`packages/teamlead/src/bridge/plugin.ts:881-949`）。但首投事务在标记 credential consumed 前已经确保 lead event 存在（`packages/teamlead/src/StateStore.ts:56203-56235`），所以合法 receipt replay 不应重新解析 owner或创建新 receipt。  
   **建议修复：** `replayWorkflowDecisionReceipt` 只查询 `event_id=workflow_claim:<claimId>` 的唯一 `workflow_claim_recorded` row并返回其 seq；缺失/多行即 `credential_receipt_corrupt`，不得 ensure/create。并校验 claim 的 `workflow_run_id/node_id/attempt/issuer_execution_id/decision_kind` 与 credential 的 durable binding一致，避免仅靠不绑定 credential identity 的 submission digest接受交叉链接。相应测试应删除/改变 projects owner与 session labels后仍返回同一个 `leadEventSeq`，删除 lead event则 corrupt且零写入。  
   **严重度：MED**

9. **sweeper 的 wall-clock 与 shutdown 上界尚未形成可实现的单一 deadline 合同。**  
   **为什么重要：** §4.4 规定 pass ≤45 秒、每 fetch 10 秒、`stop()` 等待 ≤12 秒；§4.5 又允许先等已有 global `inFlight` ≤12 秒，再执行最多 30 秒的 inline settle，却仍声称 inline ≤30 秒（`engineering/doc/FLY-1956-outbound-timeout-receipt/plan.md:149-172`）。若只在文件之间检查时间，44 秒时开始一个 10 秒 fetch 会超过 45 秒；若 inline 的 12 秒排队不计预算，则总时长可到 42 秒。更危险的是，`stop()` 用 timeout 提前返回而原 Promise 仍活着时，后续 `store.close()` 会与残留任务竞态；现有 shutdown 特意在关闭 store 前 await 异步 reconciler，注释明确禁止 pass 在 closed store 上继续写（`packages/teamlead/src/bridge/plugin.ts:13688-13700`）。  
   **建议修复：** 所有 pass/inline 操作共享一个 absolute deadline；排队时间计入总预算，每次 fetch timeout 为 `min(10s, remaining)`。明确 `stop()` 只有在 in-flight 实际 settle 后才能让 close 继续；若仍要 12 秒硬上界，则任务必须在此之前变为完全 cooperative-aborted，并以 stopped/generation fence保证之后不再访问 filesystem/store，不能只 `Promise.race` 后遗留 Promise。新增 fake-clock 边界测试及“stop 返回后 store spy 零调用”的测试。  
   **严重度：MED**

## Verdict

CHANGES REQUESTED — address items above
