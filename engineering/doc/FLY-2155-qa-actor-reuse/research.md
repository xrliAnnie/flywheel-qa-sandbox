# FLY-2155 QA 侧 actor 复用 — 调研(代码审计 + 生产取证)

Issue: FLY-2155 (https://linear.app/geoforge3d/issue/FLY-2155/引擎不对称-体做完留着继续用只对-implement-生效qa-侧新一轮必须换体而活着的旧体反过来把起跑道占死-死结)
日期: 2026-08-29
基于: exploration.md

## 1. 生产取证:FLY-2139 run `8b8a7fd7` 完整时间线(2026-08-29, UTC)

来源:`~/.flywheel/teamlead.db`(只读 `immutable=1` 打开)`workflow_run_event` / `workflow_rework_request` / `workflow_rework_route_revision` / `workflow_rework_verification_path`。

| 时间 | seq | 事件 | 解读 |
|------|-----|------|------|
| 12:23 | 21 | `node_dispatched qa 5871392f` | 第一轮 QA,edge traversal 正常铸新体(此时 qa 无历史 actor,铸新是对的) |
| 13:43 | 30–35 | qa_fail → `rework_requested implement`,preferred=`5e6eafcf` | QA kickback → **implement 复用路径,成立** |
| 15:59 | 67 | `rework_delivery_wake_delivered` | implement 旧体被 wake,第二轮返工(复用成功) |
| 16:59 | 91 | `rework_activation_stalled_held` | receipt 未回,run 被冻 held |
| 17:08 | 94 | `completion_transition_refused`,reason=`engine_run_not_active` | implement 完工被拒(run 还是 held) |
| 17:10:26 | — | path `rework:10dc71e62` 被置 `completed`(current=implement/2) | **时间戳为空格格式(`datetime('now')`),与代码里 traversal 站点的 ISO 格式不同 → 协议外人工 SQL 解冻**(FLY-2139 现场抢修) |
| 17:11 | 95–97 | implement 完工 → `edge_traversed` → **`node_dispatched qa 52b963f6`(铸新!)** | path 已非 active → `chainedRework=false` → **fallback 分支无条件 `randomUUID()`**(病根 A)。payload 实证:`successorExecutionId: 52b963f6-…` |
| 17:11–17:16 | 101–399 | `submission_credential_rotated` 每秒一条,~300 条 | 新体起不来,runway 被活着的 `5871392f` 占死(病根 C);伴生热循环 |
| 17:21 | 699 | `unlaunched_admission_rolled_back qa 52b963f6` | 10min hard TTL;session 标 failed、凭证吊销、run 冻 held —— **node 行仍 admitted 绑着 52b963f6**(病根 D) |
| 18:31 | 703–706 | `operator_rework_requested implement`(不是 qa) | 对 qa 开门失败(`target_attempt_already_reserved` → 人工补 failed 后 `base_revision_unavailable`,病根 D/E),只好绕道返工 implement |
| 18:43:59 | 717 | `generalized_teardown_recorded qa 5871392f` | **活着的旧 QA 体被 founder 门关掉** —— 它此时已完成复验、结论 PASS、报告绑定正确头,但判决交不上去(它的 attempt 1 已 done,attempt 2 绑在幽灵上) |
| 18:46 | 719–728 | implement 旧体判 dead → 替身 `13022860` materialize + launch | implement 侧 dead→替身路径工作正常 |
| 19:08 | 739–744 | implement 完工 → **chained rework 到 qa attempt 3,preferred=`52b963f6`(幽灵!)** | chained 分支这次触发了,但选择器选了「账面最近」的幽灵而不是任何活体(病根 B;此刻 5871392f 已被关,若未被关本应选它) |
| 19:08–19:23 | 746–757 | 5× `rework_delivery_failure` reason=`actor_session_missing` → `rework_retry_exhausted`(onExhausted=needs_lead) | 幽灵投递必然失败;probe 按 retryable hold 处理(病根 G),run 又冻 |
| 20:00–20:03 | 759–775 | 人工重开 → dead 判定 → 替身 `8c3b5c14` materialize + launch | **第三个 QA 体从零重跑** —— founder 要避免的浪费 |
| 20:20–21:09 | 782–797 | QA PASS → founder gate → land → run completed | 全程人工干预 ~3 小时,死结才解开 |

**净效果实证**:一次 qa_fail 返工周期里,QA 侧消耗了 3 个 execution(5871392f 活体被关 / 52b963f6 幽灵 / 8c3b5c14 重跑),其中活体已完成的复验成果全部丢弃;implement 侧全程 1 个体(+1 次 pane 死亡后的正当替身)。

## 2. 代码审计:六个病根的精确位置

### A. fallback 铸新体 — `StateStore.commitWorkflowTransitionTx`(~L38467)
```ts
const successorExecutionId =
  target.type === "gate" ? undefined
  : reworkAuthority ? undefined
  : (input.successorExecutionId ?? randomUUID());
```
`reworkAuthority` 只在两种情况非空:qa/founder kickback(loop 边),或 `chainedRework && !chainedFreshDispatch`。`chainedRework` 要求「有 state='active' 且 current_node/attempt 精确匹配的 verification path」——path 一旦被提前 completed/needs_lead/cancelled,implement→qa 的正常推进就落到 fallback,无条件铸新。

### B. preferred actor 选择器 — 两处同型
```ts
// commitWorkflowTransitionTx (~L38566) 与 openOperatorRework (~L32095) 同构:
preferredActorExecutionId = targetAttempts
  .filter((c) => c.execution_id)
  .sort((l, r) => right.attempt - left.attempt)[0]?.execution_id;
```
按 attempt 倒序取第一个带 execution_id 的 —— 不查 session 状态。幽灵(rollback 后 node 仍绑着它)attempt 最大,永远排第一。

### C. runway 释放判据 — `run-dispatcher.currentInflightEntry`(L725)
in-memory `inflight` Map,key=`${issueId}:${normalizedRole}`;只有 `inflightSessionTerminal(executionId)`(run-infra 注入 `isStateStoreIrreversibleTerminalForZombie`,终态集合={completed, failed, terminated, blocked, rejected, deferred, shelved})为 true 才释放。probe 失败 fail-closed(保持占用)。`start()` 里已有同 executionId 收敛路径(L1459-1474):`generalizedExecution.executionId === inflightEntry.executionId` 时直接返回在飞条目 —— 这就是 issue 要做#4「既有 actor 就是目标 actor」的现成形状,但引擎铸新体时永远走不进去。

### D. rollback 不重置 node — `StateStore.rollbackUnlaunchedWorkflowAdmission`(L24338–24575)
同事务做了:凭证 revoke、lifecycle claim close、`sessions.status='failed'`、ledger `abandoned`、run `held`、(replacement 模式)delivery 回 held。**没有任何一条 UPDATE 碰 `workflow_run_node`** —— 该 attempt 永久 `state='admitted'` + `execution_id=幽灵`。下游两处直接中毒:`openOperatorRework` 的 `target_attempt_already_reserved` 检查(latest attempt ended_at IS NULL 且 state∈{pending,admitted,running});病根 B 的选择器。

### E. base revision 只认 pr_head_sha — `openOperatorRework`(~L32100)
```ts
const baseRevision = this.getSession(preferredActorExecutionId)?.pr_head_sha?...
if (!baseRevision || !/^[0-9a-f]{40}$/.test(baseRevision))
  return { ok: false, reason: "base_revision_unavailable" };
```
`pr_head_sha` 由 `setReviewBinding` 在批准绑定时写入,禁止人工写(FLY-2139 实测此路封死)。QA 角色不产 head,故对 QA 目标结构性不可用。对照:引擎侧 chained rework 的 base 取 `input.subjectDigest ?? activeRequest.base_revision ?? "unavailable"`,并有 `MaterializedHeadAuthority`/`getWorkflowMaterializedHead(runId, producerNodeId)` 这一权威 head 读口(gate 入口已在用)。

### F. materialize 不标死体终态 — `materializeWorkflowReworkReplacement`(L26999–)
函数体内唯一的状态类 UPDATE 是 `workflow_run SET status='active'`(held 恢复);对 `deadExecutionId` 的 session 状态不落终态。死体 session 若仍 'running'(pane 亡而未收割),runway 依旧被占,替身 launch 会被 `Run already in progress` 拒绝 —— FLY-2139 没撞上只是因为旧活体先被人工关掉、幽灵 session 已被 rollback 标 failed。

### G. 幽灵 probe 按 retryable 处理 — rework coordinator
`actor_session_missing` 走 hold+backoff(5 次、onExhausted=needs_lead),而 rollback 事件 `unlaunched_admission_rolled_back`(event_uid 含 execution_id)是该 execution 从未启动的**持久回执** —— 本可即刻判 dead 直进 replacement。

## 3. 现有可复用机制清单(不新造)

| 机制 | 位置 | 复用方式 |
|------|------|----------|
| rework request/route/delivery/verification_path 四表 + coordinator(probe→wake→replacement) | `StateStore` + `workflow-rework-coordinator.ts` | 方向一的整条投递通道 |
| `chainedRework` 造链式请求(含 preferred actor、reserve target attempt) | `commitWorkflowTransitionTx` | fallback 分支对齐它的形状 |
| `getWorkflowMaterializedHead(runId, producerNodeId)` / `MaterializedHeadAuthority` | `materialized-head-authority.ts` | E 的 base revision fallback |
| `start()` 同 executionId 收敛 + `isStateStoreIrreversibleTerminalForZombie` 释放 | `run-dispatcher.ts` | C/F:不放宽判据,让 materialize 把死体落终态后由现有判据自然释放 |
| `probeTerminalLaunchLiveness` / held recovery(`persisted_target_missing` + dead probe → materialize) | `workflow-engine-dispatcher.ts` L841–932 | G 可在同型位置加「rollback 回执 = 已死」的短路 |

## 4. 关键约束

- traversal 是同步 SQL 事务,存活判定必须留在 coordinator(异步 probe)—— 这正是 implement 侧的既有分工,不可在事务内 probe。
- `workflow_rework_request.authority` 现值 'qa'/'founder'(operator 门也落 'founder')。新一轮复用请求需要可区分的标记(route 的 `interpreted_by` 已有先例:`engine:qa_verdict` / `engine:rework_verification` / `legacy_default`),避免把「正常推进」伪装成「返工」造成语义混淆。
- 幂等:traversal 的 receipt(`edge_traversed` payload)与 rework request_id 均由 digest 派生,新分支必须保持 replay 幂等。
- 单写者:所有改动落在 StateStore 事务 + coordinator/dispatcher 既有 tick 里,不新增后台循环。
