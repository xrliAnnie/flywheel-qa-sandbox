# Design Review — plan.md (Round 1)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

方向是对的：跨进程稳定幂等键、同键重放、单机 singleflight，以及把客户端断连暴露到 `/health`，都直接针对已量到的故障形状。尤其是复用现有 `/events` 的 `event_id` 去重和 workflow credential 的 durable replay，而不是新增一套 receipt API，整体 scope 克制。

但 v1 还不能实现摘要承诺的“三种终局且不再有未知态”。有五个阻塞问题：workflow exact replay 仍先依赖可变 worktree/activation；singleflight 没有绑定 payload；stage queue 没有 guaranteed drainer 且允许后续命令越过失败的 flush；`duplicate:true` 只证明 event row 存在、不证明 stage projection/auto-trigger 已完成；两类本地 write-ahead 在写失败、半写和并发进程下仍会丢唯一恢复键。另有 timeout/harness 与观测口径问题需要在实施前写实。

## What's Good (Keep)

- 保留“同键重放即回执”的主线。StateStore 已经在同一事务路径里比较 `consumed_client_request_id + consumed_submission_digest`，exact match 返回原 `claimId/serverSeq` 和 `idempotentReplay:true`，不同 payload 返回 `replay_payload_mismatch`（`packages/teamlead/src/StateStore.ts:55961-56005`）。
- `stage set` 复用现有 `event_id` 是合适的低复杂度基础：Bridge 在处理前先插 `session_events`，唯一键重复会返回 `{ok:true, duplicate:true}`（`packages/teamlead/src/bridge/event-route.ts:1495-1508`；`packages/teamlead/src/StateStore.ts:9755-9822`）。
- 不把 ingest token/credential 放进 marker/queue 的边界正确。现有 QA marker 也只落 recoverable verdict，并在写失败日志中只打印该安全投影（`packages/flywheel-comm/src/commands/qa-result.ts:1390-1421`）。
- 观测面选择合理：现有 `/health` 已经是无鉴权的追加式 JSON，并在 provider 失败时降级返回空 event-loop snapshot（`packages/teamlead/src/bridge/plugin.ts:2298-2356`）；`EventLoopAttribution.recordSpan` 也已有明确的 >500 ms wall-span 合同（`packages/teamlead/src/bridge/event-loop-attribution.ts:186-200`）。
- nudge 保持 doorbell、durable queue row 保持 authority 的边界正确；Lead loop 的默认 active/idle interval 确实是 1 s / 30 s（`packages/teamlead/src/bridge/lead-inbox-loop.ts:29-30`）。

## Issues & Recommendations

1. **Exact replay 仍被当前 worktree/activation 挡在 durable receipt 之前（severity HIGH）**

   **Issue:** `/decision` 取得 credential row 后，无论 `consumed_at` 是否已有值，都会先执行 `resolveEngineDecisionCanonical`（`packages/teamlead/src/bridge/workflow-decision-routes.ts:715-738`）。QA canonical 又读取当前 worktree HEAD（同文件 `:205-208`），而该读取要求 session/worktree 仍存在并重新跑 `git rev-parse HEAD`（`packages/teamlead/src/bridge/head-authority.ts:18-41`）。只有走完这些可变检查后，StateStore 才有机会命中 immutable replay predicate（`packages/teamlead/src/StateStore.ts:55975-56005`）。因此首投已经消费 credential、响应丢失后，只要 activation 已推进、worktree 被清理/不可读或 HEAD 漂移，重跑仍会在 durable receipt 之前 409；计划 §3 的“任何后续重跑都拿到 `idempotentReplay:true`”不成立。

   **Why it matters:** 这是本单要消灭的核心未知态。CLI marker 再可靠，也无法绕过服务端在 receipt 之前重新依赖易变事实的顺序。

   **Suggested fix:** 在 credential 基础校验后增加 consumed fast path：用持久化的 client-request projection/digest 校验 `client_request_id + normalized status + normalized summary + optional asserted head`，exact match 直接返回已存 `claimId/serverSeq`，不得再访问 activation、worktree、git 或 gh；payload 不同仍 409。若现有 claim/credential 列不足以无歧义重建该比较，就在消费事务内新增并持久化 client payload digest，并相应撤回“无 schema migration”。补三条集成测试：落账后删除 worktree、推进 activation/改变 HEAD、Bridge restart；三者 exact replay 都应 200，而 divergent payload 仍 mismatch。

2. **Singleflight key 没有绑定 payload，会把冲突请求错误地回成成功（severity HIGH）**

   **Issue:** 计划的 key 只有 `hash(credential):client_request_id`。但现有 API 还接受 `status`、`summary`、`client_pr_head_sha`（`packages/teamlead/src/bridge/workflow-decision-routes.ts:694-713`），StateStore 的 canonical digest 明确绑定 predicate、subject 和 evidence，并把不一致重放拒为 `replay_payload_mismatch`（`packages/teamlead/src/StateStore.ts:55961-56005`）。两个并发请求若 credential/id 相同但一个是 pass/summary A、另一个是 fail/summary B，后到者会 await 先到者的 Promise，并收到同一个成功 body，绕过现有冲突合同。

   **Why it matters:** 这会让调用方把“另一个 payload 落账”误认成“我的 payload 落账”，比当前超时更危险；也直接违反 §10.1 的负面守卫精神。

   **Suggested fix:** map value 保存 `{clientPayloadDigest, promise}`。同 credential/id 且 digest 相同才 await；同 credential/id 但 digest 不同应立即返回 409 `replay_payload_mismatch`（或让其独立到 store 得到同一结果），绝不能共享成功响应。map 应放在 `createWorkflowDecisionRouter` closure 内而不是模块全局，避免多 app/store 实例互相合流。测试必须加入同 id + 不同 status、summary、client head 三个冲突用例，而不只测“不同 id”。

3. **Stage queue 没有 guaranteed drainer，并且失败 flush 会被后续有副作用命令越过（severity HIGH）**

   **Issue:** §4.2 只有“下一次、同 exec 的任意 flywheel-comm 调用”会尝试 drain；一次 transient 后又明确继续主命令。可是 `stage set completed` 本身就是 runner 的 mandatory final command（`packages/edge-worker/src/Blueprint.ts:2783-2786`），merge 路径也以它收尾（同文件 `:2683-2691`），所以它入队后完全可能没有下一次调用。相反，`pr_created`/`design_review` 在 Bridge 上会触发 Codex auto-trigger（`packages/teamlead/src/bridge/event-route.ts:2814-2822`）；如果下一个 `gate`/`request-review` 调用的前置 flush transient 后仍继续，后续动作就会越过尚未到达的 stage。队列只保证队列文件之间排序，不能保证 runner 行为的实际顺序。

   **Why it matters:** `completed` 可永久滞留；review/gate 相关 stage 可被后续命令超车。两者都推翻目标 2 的“不丢、顺序不乱”。每次最多 flush 三条只是成本上界，不是 liveness 所有权。

   **Suggested fix:** 明确一个不依赖“也许会有下一条 CLI 命令”的 guaranteed drain owner，并给出启动、重启、token 获取和终止条件。若坚持纯 CLI，则 pending stage 未 settled 时，所有依赖它的 mutation/gate 命令必须 fail closed，且 runner 的退出/收尾路径必须有一个被监督的 drain；否则应重新打开被 §1 排除的 Bridge/lifecycle reconciler 方案。补验收：`completed` 是最后一条命令仍最终落账；`pr_created` flush 失败时 approve/review gate 不得先发生；进程在入队后立即退出并重启仍能 drain。

4. **`duplicate:true` / warning 只证明 event row 已存，不证明 stage 已应用（severity HIGH）**

   **Issue:** `/events` 在 `store.insertEvent` 后立刻对 duplicate early-return（`packages/teamlead/src/bridge/event-route.ts:1495-1508`），而 `session_stage` 更新、reconnecting 清理和 Codex auto-trigger 都在后面的 stage branch（同文件 `:2757-2822`）。现有 catch 甚至明确返回 `ok:true, warning:"event stored but session update failed"`（同文件 `:3100-3119`）。计划却把 duplicate/warning 都定为 landed 并删除队列。Bridge 若在 insert 后、stage projection 前 crash，或 projection 抛错，后续同键重放只会 duplicate-return，永远不会补做 stage；自动 review 门也可能永远没触发。

   **Why it matters:** 当前 receipt 证明的是“session_events 行存在”，不是计划所依赖的“stage 语义已结算”。§4.3 漏掉了这个服务端 crash window。

   **Suggested fix:** 先写清 landed 的权威对象。如果目标包括 session stage/auto-trigger，就需要 durable application receipt：让 stage projection 与 event insert 原子化，或让 duplicate 路径检测并幂等补做未完成 projection/trigger；warning 不能被 flush 当作完整 settled 后直接 unlink。补“insert 后 kill、projection throw、duplicate replay”三类测试，断言最终 session_stage 与 trigger receipt，而不只断言 event row。

5. **Write-ahead 仍然 fail-open、非原子且没有跨进程互斥（severity HIGH）**

   **Issue:** §3.2 明写 QA write-ahead 失败后仍发送；现有 `writeMarker` 也只返回 false 并直接覆盖 `<execId>.json`（`packages/flywheel-comm/src/commands/qa-result.ts:1390-1421`）。这样响应再丢失时，唯一 request id 仍未持久化。两个同 exec 的 QA 进程也可先后覆盖 marker、各带不同 id 发送，丢掉真正消费 credential 的那把钥匙。Stage 侧同样把半写文件改名 `.unreadable` 后继续、目录不可写仍 exit 0；这既会丢 obligation，也不符合 `DEFERRED = key persisted`。仓库已有同目录 temp-file + rename 的原子发布模式可复用（`packages/flywheel-comm/src/commands/complete.ts:681-707`）。

   **Why it matters:** 计划最核心的 write-ahead invariant 在磁盘故障、kill-during-write 和并发重跑三个窗口均不成立；日志中的 JSON 不是 durable queue，也不能标成 deferred。

   **Suggested fix:** QA 首投必须在 marker 原子、权限正确且成功发布后才允许发网络请求；失败则 fail closed、零请求。使用 same-dir temp + fsync/close + rename（并说明是否承诺 power-loss durability），对初始 owner 用 exclusive create/lock/CAS；并发者读取并复用 winner，不能 clobber。Stage enqueue 同样原子发布；无法持久化时应返回独立的 `UNRECORDED`/nonzero 终局，而不是 exit 0 的 DEFERRED。队列顺序若声称跨进程严格有序，也要用锁下单调序号，而不是仅靠毫秒时间戳。补双进程竞争和 kill-during-write 测试。

6. **Timeout 上界与 §7.2 harness 需要修正（severity MED）**

   **Issue:** 当前 QA timer 在 `fetch()` 返回 headers 后就清除，然后才 `response.text()`（`packages/flywheel-comm/src/commands/qa-result.ts:709-723`）；因此 headers 已到、body 卡住时，“20 s attempt”仍可无限挂。计划为了识别 duplicate/warning 也必须读取 stage response body，但未把 body consumption 纳入 deadline。服务端 pass 路径的串行上界也至少是 5 s 的 workflow HEAD probe（`packages/teamlead/src/bridge/head-authority.ts:27-31`）+ repository 15 s top-level、15 s remote/head 并行段（`packages/teamlead/src/bridge/repository-authority.ts:70-87`）+ 15 s gh probe（`packages/teamlead/src/bridge/workflow-pr-probe.ts:18-30`）= 50 s，而不是 §3.1/测试断言里的 45 s。最后，§7.2 #2 设首投 25 s 落账；顺序重试在 t=20 abort、退避后 t=21 发第二次并于 t=25 成功，第三次根本不会发生，所以测试描述的“第 2、3 次在落账前到达”不可实现。

   **Why it matters:** 预算与 map settlement 的论证不完整，fake-timer drill 也没有覆盖它声称覆盖的第三尝试窗口。

   **Suggested fix:** timer 覆盖 fetch + bounded body read/parse，参考 `complete` 把 clear 放在整个 response 处理的 finally（`packages/flywheel-comm/src/commands/complete.ts:507-523,585-592`）。把上界和断言改为至少 50 s，并分别测试 headers-only/body-stall。若要覆盖第三次 singleflight follower，把落账点放到第二次 20 s 窗口之后（例如 >41 s 且 <63 s）；否则把 25 s case 正确写成两次请求。

7. **Outbound-pressure 的口径和依赖接线尚未闭合（severity MED）**

   **Issue:** `res.close && !res.writableEnded` 能证明 response 未正常 finish，但也可能来自服务端主动 destroy，并不天然等于 client abort；计划没有说明如何区分。schema 声明了 `max_ms`，规则却没有说明 aborted request 是否更新 max、何时更新，也没有对应断言。另一个直接的接线缺口是 `BridgeAppOptions.eventLoopAttribution` 当前只暴露 `healthSnapshot()`/`snapshot()`，没有 `recordSpan()`（`packages/teamlead/src/bridge/plugin.ts:1421-1432`），而计划要求 meter 调它。

   **Why it matters:** 名为 `client_aborted_total` 的健康指标若混入 server-side closes，会误导事故判断；缺少明确更新规则也会让实现与测试各自猜测。

   **Suggested fix:** 将 `req.aborted`/socket 状态与 response close 原因组合成明确判据，或把指标诚实命名为 `response_closed_before_finish_total`。定义 finish/abort 两条 duration、slow、max 更新规则；扩展注入类型并在 composition root 传入 `recordSpan`。测试增加 server-side destroy、client abort、normal finish 三分支及 `max_ms` 单调性。

8. **Nudge 文案把健康条件省略成了 30 s 保证（severity LOW）**

   **Issue:** endpoint 在找不到对应 Lead loop 时会直接 404（`packages/teamlead/src/bridge/plugin.ts:3188-3193`），而 `LeadInboxLoop.nudge()` 在 stopped 状态也会 no-op（`packages/teamlead/src/bridge/lead-inbox-loop.ts:181-190`）。因此“Lead polls it within 30 s”只在 loop 存活并正常调度时成立，不是所有 warn 分支都成立。

   **Why it matters:** 本单正要消除误导性日志，不应把旧误导替换成新的无条件时限承诺。

   **Suggested fix:** 改为 `durable queue row retained; a healthy Lead loop retries on its next poll (nominally <=30s)`，并让 404/401/403 保留具体 status/detail。

## Verdict

CHANGES REQUESTED — address items above
