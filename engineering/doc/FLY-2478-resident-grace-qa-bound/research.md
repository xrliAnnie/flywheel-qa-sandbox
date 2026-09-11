# FLY-2478 停驻体 resident 宽限改按 QA 判决绑定 — 调研
Issue: FLY-2478 (https://linear.app/geoforge3d/issue/FLY-2478/引擎resident-停驻体的-resident-宽限不按-30-分钟固定钟改按-qa-判决绑定pass-立即释放fail)
日期: 2026-09-11
基于: exploration.md

本文把 exploration §5 的方案 C 落到 HEAD `ca869ad6d` 的精确接缝上,每个接缝给出「现在的行为 → 要改成什么 → 为什么这里改」。行号均为 HEAD 的行号。Lead 裁定(2026-09-11,对本单非阻塞提问):FLY-2477 没有独立 runner,联动两点按本单实现成独立 chunk,范围只这两点。

## 1. 接缝清单

### S1 释放触发点:`StateStore.commitWorkflowTransitionTx`(`StateStore.ts:55713`)

现状:`:55952-55965` 用 `edge = edges.find(from===node && condition===outcome)` / `loop = loops.find(from===node && loop_when===outcome)`,二选一;`:56290-56309` 把源节点标 done、写 `node_completed`;`:56310` 起若是 loop 则写 `loop_iteration` 并铸 rework request(preferred actor = `selectPreferredWorkflowActorTx`,`:41084`)。

判决合同已有一个通用出口:`resolveWorkflowDecisionContract(snapshot, nodeId)`(`workflow-run-snapshot.ts:160-195`)对「唯一一条 `loop_when ∈ {qa_fail, review_fail}` 且 `exit_when` 有对应 edge」的源节点返回 `{family, passOutcome, failOutcome, …}`;引擎已在 `:56132` 用它找 QA 决策节点。

要改:在 `edge` 分支(非 loop)、`node_completed` 事件写入之后、同一事务内新增:

```
contract = resolveWorkflowDecisionContract(snapshot, input.nodeId)   // 抛错则视为无合同,不释放
if (contract && input.outcome === contract.passOutcome) {
  verdictLoop = loops.find(l => l.from === input.nodeId && l.loop_when === contract.failOutcome)
  releaseResidentHoldsForNodeTx({ runId, nodeId: verdictLoop.to, cause: 'verdict_pass', sourceEventUid: transitionUid, now })
}
```

`releaseResidentHoldsForNodeTx`:`UPDATE workflow_resident_hold SET grace_expires_at = ?, release_cause = 'verdict_pass', release_source = ?, updated_at = ? WHERE run_id = ? AND node_id = ? AND state = 'resident' AND (release_cause IS NULL)`。不动 state,不动 revision。founder 打回循环(`loop_when = founder_feedback_kickback`)没有 decision contract,天然不触发——与 issue「PASS 即释放,land 不需要体」一致。

为什么不在 QA 节点 claim 写入处(`resolveWorkflowDecisionClaim`)触发:claim 是 QA 体自己交的证据,transition 才是引擎接受该判决的权威动作;本单的口径是「引擎接受判决 = 释放」。

### S2 兜底常量与守卫:`resident-hold.ts:1`、`fly2268-mechanism-guards.test.ts:123`

`RESIDENT_GRACE_MS = 1_800_000 → 10_800_000`。守卫测试逐字钉着 `1_800_000`,同 PR 改成 `10_800_000`。守卫 `:103-113` 还禁止该文件出现 `qa|implement|design` 与 `process.env`——新增的常量名/注释不能含这些词(用 `verdict`、`release` 措辞)。

### S3 `release_cause` 列:`StateStore.ts:25306`(建表)+ guarded ALTER

`workflow_resident_hold.state` 的 CHECK 是四值枚举,加值要重建表,不做。新增两列(建表语句加列 + 对老库 `workflowTableColumns('workflow_resident_hold')`(`:4127`)判缺再 `ALTER TABLE … ADD COLUMN`,写法同 `:25444` 的 `workflow_gate_holder` 循环):

- `release_cause TEXT NULL CHECK (release_cause IS NULL OR release_cause IN ('verdict_pass'))`
- `release_source TEXT NULL`(触发它的 `transitionUid`,只做审计/幂等回读)

`WorkflowResidentHoldRow`(`:371`)同步加两个可空字段。`fly2268-mechanism-guards.test.ts:21-66` 只钉表名/索引名,不钉列集合,不受影响;本单在同一测试文件加一条「列恰好多这两列」的钉子。

### S4 到期 saga 的 ACK 死锁:`delivery-operations.ts:143-171`(applied 阶段)

现状(Codex 分支):只认 `runner_shutdown_controls.state = 'acked'`;`requested` 就 `continue`。真机 53 行 `expired/applied` 永远等不到 ACK。

要改:`applied` 阶段先看 shutdown 行;若不是 `acked`,再查**死证**:

```
commSession = commDb.getSession(executionId)            // db.ts:8071
deadByRegistry = !commSession || commSession.status !== 'running'
if (!deadByRegistry) continue                            // 体可能还活着:等
liveness = await residentExpiry.probeTarget(executionId)  // 新 dep,复用 probeClaude 的实现(lookupTmuxTarget + probeRunnerProcessLiveness)
acknowledged = liveness === 'dead_pin' || liveness === 'absent'
```

`residentExpiry` deps(`delivery-operations.ts:42-49`)从 `{terminateClaude, probeClaude}` 扩成 `{terminateClaude, probeTarget}`,Codex/Claude 共用同一探针(plugin `:8777-8785` 的实现本来就不分 vendor)。测试 `fly2268-resident-expiry.test.ts` 的 `operations()` helper 同步改名。

为什么放在 saga 而不是另起清理 job:saga 已经是「一条关体路径」,只是它的 ACK 口径比现实窄;把死证接进来,现存 53 行陈旧 `expired/applied` 在部署后第一个维护 tick 自然收敛,零迁移脚本。

### S5 释放/到期落地为 completed:`StateStore.projectResidentExpiry`(`:38290-38352`)

现状:hold `expired → closed(expired)` + op `sent → projected` + run event `resident_hold_expired`。sessions 不动。

要改(同一事务,在 hold CAS 之后):

1. `closed_reason = CASE WHEN release_cause IS NOT NULL THEN 'released' ELSE 'expired' END`。`closeResidentHold` 的 reason 联合类型加 `'released'`。
2. 读 `sessions`:若 `status = 'ship_parked'` 且 `resolveCurrentWorkflowActivation(executionId)` 为 `current` 且其 `activation_id === operation.target_activation_id`,则 `UPDATE sessions SET status='completed', last_activity_at=? WHERE execution_id=? AND status='ship_parked'`(FSM `ship_parked → completed` 合法,`workflow-fsm.ts:138`),`applyTerminalTimestamp(executionId, 'ship_parked', 'completed')`(`:10298`,它会把 `woken` hold 关成 terminal——本 hold 已是 closed,无副作用)、`bumpLifecycleRevision`。
   - activation 不匹配(体已被替身接管/换代)→ 不动 sessions,只关 hold;事件 payload 记 `sessionSettled: false, reason`。
   - status 不是 ship_parked(已被别的路径终结)→ 同上不动。
3. park 账本:对该 execution 最新一代 `park_opened(reason='rework_reachable_wait')` 写 `engine-park-settle`(复用 `appendWorkflowEngineParkSettlementClearTx`,`:20621`)。run terminal 时 `settleWorkflowEngineParksForRunTx` 再跑到它:session 已终态 → 走 `:20808` 的 ledger-only 分支,而 `appendWorkflowEngineParkSettlementClearTx` 对已存在同 eventId 的 clear 做等值校验后返回,幂等。
4. 事件:kind 改为按 cause 二选一——`resident_hold_released`(payload 加 `cause`, `releaseSource`, `sessionSettled`)/ `resident_hold_expired`(payload 加 `sessionSettled`)。真机 grep:`resident_hold_expired` 除 StateStore 自身无消费者(`scripts/`、`packages/*/src` 零命中),改名安全;新 kind 要进 `hook-payload.ts` 的事件白名单吗——`hook-payload.ts:495` 是 rework delivery 状态词表,不是 run event kind 词表,不需要。

divergence 检查(`listWorkflowDivergenceCandidates`,`:757`;`commitWorkflowDivergenceObservation`)对 `completed` 明确判 `divergence: false`,释放体不会触发 `workflow_node_session_divergence`。

### S6 「1 分钟内释放」:dispatcher 1s tick(`workflow-engine-dispatcher.ts:321`)

现状:`runResidentExpiryPass` 只挂维护 tick(`plugin.ts:8821`,`stuckCheckIntervalMs` 默认 300_000,本机未覆盖)。

要改:`WorkflowEngineDispatcherOptions` 加可选 `runResidentExpiryPass?: (now: string) => Promise<void>`;`reconcile()` 在 `reconcileWorkflowReworks` 之前调用一次「有候选才跑」:

```
if (store.countDueResidentHolds(now) > 0) await options.runResidentExpiryPass(now)
```

`countDueResidentHolds`:`SELECT count(*) FROM workflow_resident_hold WHERE state='resident' AND grace_expires_at < ?`(命中 `idx_wrh_expiring`)**加上** `state='expired'` 且 op 未 projected 的行(否则 applied 阶段的死证推进仍要等 5 分钟)。为了一条索引扫描就够,把第二类用 `state IN ('resident','expired')` 一起数——`expired` 行在稳定态下为 0,不会造成每秒空跑。

plugin 侧:把维护 tick 里那段 `new DeliveryOperations({...residentExpiry})` 的构造抽成 `createProjectDeliveryOperations(projectName, commDb)`,dispatcher 的回调用同一构造(每次调用开/关自己的 CommDB,与维护 tick 的 `deliveryCommDb` 生命周期互不共享),并用一个 per-project 单飞标志避免与维护 tick 重叠——saga 每步都是 CAS,重叠只是浪费不是错。维护 tick 原样保留作兜底。

### S7 下游 A:返工遇 released/expired 体直接换体

- `sessions = completed` 路:`workflow-rework-coordinator.ts:520` `actor && isStateStoreIrreversibleTerminalForZombie(actor.status) → markReplacementPending('actor_session_terminal:completed')` 已存在(真机 9-5 起 27 次)。零改动,加一条端到端测试钉住「释放体 → 替身」。
- 体活、hold 死(`wake_failed:resident_hold_expired`,真机 5 次 → 5 轮退避 → `needs_lead`):`:804-818` 的 `woke.error === 'resident_hold_expired'` 分支改为 `markReplacementPending(actor.execution_id, 'resident_hold_expired')`。同时 `deliverResidentWake`(`resident-wake-fence.ts:16-19`)对 `state ∈ {expired, closed}` 保持拒绝(它是最后一道 fence),只是上游不再当 retryable。
  - 注意 `markReplacementPending` 定义在 `reconcile()` 闭包内(`:449-470`),wake 分支在同一函数,可直接用。
  - 替身铸造 `materializeWorkflowReworkReplacement` 会 `terminalizeProvenDeadSessionTx`(`:35002`)把老 session 写 failed——对「体活但 hold 死」的老体,还需要真的关掉它:saga 的到期路径已经在关(hold expired ⇒ op 已 staged/applied),不需要新动作。

### S8 下游 B:pane-loss 与巡检

- `reconcilePaneLoss` 候选集 `getReadoptCandidateSessions`(`:11707`)不含 `completed` → 释放体零通知、零事件。不改代码;新增负向测试:seed 一个 `completed` + `adapter_type=codex-tmux` + 无 tmux target 的 session,断言 `scanned=0`、无 `runner_pane_loss_detected`、`notify` 未被调用。
- STEP 2 / MISSING_PANE / STALLED_60M(`lead-patrol-snapshot.sh:284,395,496`)读 CommDB `sessions.status IN ('running','blocked')`。Codex 体在受控关停时 `CodexTmuxAdapter.ts:1791` 写 `completed/timeout`;死证等价 ACK 的前提本来就是 CommDB 已非 running。验收用 CommDB 状态做观察点。Claude 分支:`terminateClaude` 杀 pane 后 `TmuxAdapter.ts:1120-1131` 在 `finally` 写 `timeout`,同样掉出 roster——这是假设,plan 的 QA 节标为「Claude 分支只做单测,不做真机」。
- STEP DWELL(node-dwell-control)看的是节点停留与 founder gate,不看体;`node-dwell-control.ts:98-103` 只用 CommDB running/blocked 找 owner。无关。

### S9 FLY-2477 联动(Lead 裁定纳入本单,独立 chunk)

- Bridge:`enterResidentHold`(`:37903`)在 `existing.state === 'resident' && existing.boundary_seq < input.boundarySeq` 时**续期**:`UPDATE … SET boundary_seq=?, grace_started_at=now, grace_expires_at=now+RESIDENT_GRACE_MS, release_cause=NULL, release_source=NULL, updated_at=now WHERE execution_id=? AND revision=? AND state='resident'`,返回 `{ok:true, revision: existing.revision, graceExpiresAt}`。revision 不变——正在飞的 `wakeResidentHold(rev)` CAS 仍能成功,不会把一次已投递的 wake 误判成 `resident_hold_expired`。`existing.state === 'resident' && existing.boundary_seq > input.boundarySeq` 仍是 `stale_boundary`(真正的旧边界)。
  - 为什么续期要清 `release_cause`:续期意味着体又完成了一轮(通常是 wake 后的返工),上一轮的 PASS 释放对新头不成立。
- Adapter:`codex-phase-lifecycle.ts:461-469` 对 `stale_boundary` 不再 `throw`。改为:调 `residentHold.current({executionId})`;若返回 `state ∈ {resident, woken}` 且 `activationId/nodeId` 与本地一致 → 以其 `revision/graceExpiresAt` 写本地 `phaseHold`(adopt),继续 held;否则(`closed` / 无行 / activation 不符)仍 `throw`(那是真的不该常驻)。`activation_mismatch` / `invalid_input` 行为不变。
  - 触发形状(真机 7 例):Bridge 重启后 runner 走 `codex-daemon-client.ts:1476-1486` 的 `observeBoundary().kind === 'parked'` 分支,本地 `phaseHold` 不在,`enterHold` 以 `boundarySeq+1` 重进,Bridge 侧 hold 仍 `resident` → 现在是 `stale_boundary` → `throw` → 体死。续期 + adopt 之后两侧都不会死。

### S10 文案

`packages/flywheel-comm/src/commands/complete.ts:534`:「已 park 等待返工唤醒(常驻宽限 30 分钟)」→「已 park 等本头的判决:判决通过即释放、打回则原体接返工;兜底 3 小时。等 wake,勿自行轮询。」

## 2. 不动的东西(与 issue 边界对齐)

- turn 边界 / drain(`completion-drain.ts`、`codex-turn-barrier.ts`)零改动。
- merge/authority/gate:`workflow_gate_holder`、runner_ship 分支(`:59055`、`:60104`、`:65604`、`:65795`)零改动;本单只碰 land 权威下 `rework_reachable_wait` 这一种 park。
- pane-loss 代码零改动(只加负向测试)。
- `sessions.status` 词表零新增。

## 3. 数据与迁移

- 新列 2(`release_cause`、`release_source`),可空,老行 NULL 语义 = 从未释放;无回填。
- 部署后第一个维护 tick:真机 53 行 `expired/applied` 走 S4 死证 → `sent` → S5 投影:hold `closed(expired)`,其中 2 行 `ship_parked` session(activation 若仍 current)会写 `completed` 并 settle park;37 行已 completed 的只关 hold。这是**预期的一次性收敛**,plan 要给出部署前/后计数命令,QA 节点核对。
- 回滚 = 回滚代码;新列留着无害(旧代码不读)。`RESIDENT_GRACE_MS` 回滚回 30 分钟即回到旧行为。

## 4. 测试面(plan 逐条落到文件)

| 层 | 文件 | 要钉的行为 |
|---|---|---|
| StateStore | `fly2478-resident-release.test.ts`(新) | S1 PASS 释放 / FAIL 不释放 / founder 打回不释放 / 同 run 多 hold 只释放目标节点 / 重放幂等;S3 列钉子;S5 投影写 completed + park settle + 事件 kind/cause;activation 不符不动 session;S9 续期(boundary 更大)与真 stale(boundary 更小)分流、续期清 release_cause、飞行中 wake CAS 仍成功 |
| saga | `fly2268-resident-expiry.test.ts`(改) | S4 三分支:acked / CommDB 非 running + target dead ⇒ 等价 ACK / CommDB running ⇒ 继续等;Claude 分支不变 |
| dispatcher | `workflow-engine-dispatcher` 现有测试族(加) | S6 有候选才调 `runResidentExpiryPass`,无候选零调用 |
| coordinator | `workflow-rework-coordinator.test.ts`(加) | S7 `wake_failed:resident_hold_expired` ⇒ `replacement_pending`(不再 retryable);completed actor ⇒ `replacement_pending` 已有用例引用 |
| pane-loss | `pane-loss-reconcile.test.ts`(加) | S8 negative |
| adapter | `packages/claude-runner/test/fly2268-resident-receiver.test.ts`(加) | S9 adopt on stale_boundary;closed 仍 throw |
| guards | `fly2268-mechanism-guards.test.ts`(改) | 常量 `10_800_000`;列钉子 |
| 真机(QA 节点) | — | issue 验收三条 + 2477 形状(park 过再 complete 的体不死)+ 部署收敛计数 |
