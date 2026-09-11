# FLY-2478 停驻体 resident 宽限改按 QA 判决绑定 — 实施计划
Issue: FLY-2478 (https://linear.app/geoforge3d/issue/FLY-2478/引擎resident-停驻体的-resident-宽限不按-30-分钟固定钟改按-qa-判决绑定pass-立即释放fail)
日期: 2026-09-11
基于: research.md, exploration.md

> 基线 HEAD `ca869ad6d`(main)。行号以该 HEAD 为准。Lead 裁定(2026-09-11):FLY-2477 联动两点纳入本单为独立 chunk(C8),范围只这两点。

## 0. 目标、边界、验收

**目标**(= issue「要做」1–4):
1. 停驻体的宽限跟随本头的判决:判决 PASS → 立即释放;判决 FAIL → 原体直接接返工(hold 仍 resident,走现有 wake 路,零换体);兜底上限 3 小时(常量,无 flag)。
2. 释放是明确状态:`workflow_resident_hold` 关闭与 `sessions` 推进在**同一事务**;释放/到期后 `sessions` 进入 `completed`(终态、可换体),不再滞留 `ship_parked`。
3. 下游读到:pane-loss 巡检对释放体零通知;返工投递遇到释放体直接铸替身,不再 5 轮 wake 重试。
4. FLY-2477:`enterResidentHold` 对 `state=resident` 且 boundary 更大的行按续期;adapter 对 `stale_boundary` 不拆体。

**不做**(issue 边界):不改 merge/authority/gate、founder ship 卡流程、FLY-2268 的 turn 边界 / drain;`sessions.status` 词表零新增;pane-loss 代码零改动;不加 env/flag。

**验收**(issue 原文 → 本计划的证据):

| issue 验收 | 证据 |
|---|---|
| 真机:一具停驻 Codex 体在 QA FAIL 时原体接返工、零换体 | C9-1:`workflow_resident_hold` 行 `resident(r) → woken(r)`;无 `rework_replacement_materialized` |
| QA PASS 后 1 分钟内释放且 founder thread 无失联告警 | C9-2:`resident_hold_released` 事件 `at` − QA `node_completed(qa_pass)` `at` ≤ 60 s;sessions `completed`;issue thread 无 `runner_pane_loss` 帖 |
| 兜底 3 小时到期后 released 状态可被返工自动换体 | 单测 C4+C6(3h 用 `nowMs` 注入);真机 C9-3 用 founder 打回触发返工,断言 `replacement_pending → rework_replacement_materialized(reason=actor_session_terminal:completed)` |
| 巡检 STEP 2/DWELL 对 released 体不再报 STALLED/MISSING | C9-2 同时抓 `lead-patrol-snapshot.sh` 一轮:CommDB session 非 running,roster 不含该 target |
| 2477 形状:park 过再 complete 的体不再死 | C8 单测 + C9-4 真机 Bridge 重启后停驻体存活 |

## 1. 稳定标识与显示标签(一处定义,全文复用)

| 类别 | 标识 | 说明 |
|---|---|---|
| 常量 | `RESIDENT_GRACE_MS = 10_800_000` | `resident-hold.ts`,导出;无 env |
| 列 | `workflow_resident_hold.release_cause` ∈ {NULL, `'verdict_pass'`} | NULL = 从未释放 |
| 列 | `workflow_resident_hold.release_source` TEXT NULL | 触发释放的 `transitionUid`;审计 |
| closed_reason | `'released'` / `'expired'` | 投影时按 `release_cause IS NOT NULL` 二选一;`closeResidentHold` reason 联合加 `'released'` |
| run event kind | `resident_hold_released` / `resident_hold_expired` | eventUid 都 = operationId(`resident-expiry:<exec>:r<rev>`);payload 见 C4 |
| operation | `kind='resident_expiry'`,id 不变 | 释放复用到期 saga,不加新 kind |
| coordinator reason | `resident_hold_expired` | 现有 fence 错误串,C6 改成 replacement 原因 |
| saga dep | `residentExpiry.probeTarget(executionId)` | 取代 `probeClaude`,两 vendor 共用 |
| StateStore 新方法 | `releaseResidentHoldsForNodeTx`、`countDueResidentHolds` | 私有 tx + 公开只读计数 |
| CLI 文案 | `loop_park` 提示 | `complete.ts:534` |

## 2. 分块(每块:改哪里 → 测试先红 → 实现 → 守卫)

### C0 常量、守卫、文案

- `packages/teamlead/src/bridge/resident-hold.ts`:`RESIDENT_GRACE_MS = 10_800_000`。文件内不得出现 `qa|implement|design`(守卫 `fly2268-mechanism-guards.test.ts:110`);注释用「verdict / release」措辞。
- `packages/teamlead/src/__tests__/fly2268-mechanism-guards.test.ts:123`:`toContain("RESIDENT_GRACE_MS = 10_800_000")`。
- `packages/flywheel-comm/src/commands/complete.ts:534`:「已 park 等本头的判决:判决通过即释放、打回则原体接返工;兜底 3 小时。等 wake,勿自行轮询。」对应 CLI 测试(grep `常驻宽限 30 分钟` 的测试断言若有则同改;HEAD 上 `packages/flywheel-comm` 无此断言,实施时再 grep 一次)。

### C1 schema:两个可空列

- `StateStore.ts:25306` 建表语句加 `release_cause TEXT CHECK (release_cause IS NULL OR release_cause IN ('verdict_pass'))`、`release_source TEXT`。
- 老库迁移:紧随建表处新增 `migrateResidentHoldReleaseColumns()`:`workflowTableColumns('workflow_resident_hold')`(`:4127`)缺哪列 `ALTER TABLE workflow_resident_hold ADD COLUMN …`(写法同 `:25444`)。ALTER 无法带 CHECK 的部分不强求:CHECK 只在建表语句里,老库靠代码路径只写 `'verdict_pass'`。
- `WorkflowResidentHoldRow`(`:371`)加 `release_cause: "verdict_pass" | null; release_source: string | null`。
- 测试(RED):`fly2268-mechanism-guards.test.ts` 新 case「列集合 = 旧 13 列 + `release_cause` + `release_source`」;`fly2478-resident-release.test.ts`「用旧建表语句造库再 open ⇒ 两列存在且老行为 NULL」(照 `fly-2006` 系列的 raw db 造旧表方式)。

### C2 释放触发:`commitWorkflowTransitionTx`

位置:`StateStore.ts:56290-56309`(源节点标 done + `node_completed` 之后、`if (loop)` 之前),仅 `edge` 分支。

```
if (edge) {
  let contract; try { contract = resolveWorkflowDecisionContract(snapshot, input.nodeId); } catch { contract = undefined; }
  if (contract && input.outcome === contract.passOutcome) {
    const verdictLoop = snapshot.manifest.loops.find(l => l.from === input.nodeId && l.loop_when === contract.failOutcome);
    if (verdictLoop) this.releaseResidentHoldsForNodeTx({ runId: input.runId, nodeId: verdictLoop.to, cause: "verdict_pass", source: transitionUid, now });
  }
}
```

`releaseResidentHoldsForNodeTx`(私有):

```
UPDATE workflow_resident_hold
   SET grace_expires_at = ?, release_cause = ?, release_source = ?, updated_at = ?
 WHERE run_id = ? AND node_id = ? AND state = 'resident' AND release_cause IS NULL
```

返回受影响行数;>0 时追加 run event `resident_hold_release_requested`(eventUid `resident-release:<transitionUid>`,payload `{nodeId, executionIds[], cause}`),供巡检/HTML 读「释放已请求但尚未投影」。

不变量:
- 只碰 `state='resident'`;`woken`(体正在返工)不动——该体完成后会以新 revision 重新进 hold,那时再等下一头的判决。
- founder 打回循环(`loop_when='founder_feedback_kickback'`)无 decision contract → 永不触发。
- transition 重放(`prior` 已存在,`:55757` 起走幂等分支)不会再进这段;即使进,`release_cause IS NULL` 让它 no-op。
- 所有写在 transition 的 `this.db.transaction` 内,与 `node_completed` 原子。

测试(RED,`fly2478-resident-release.test.ts`,fixture 照 `fly2268-replay.test.ts:12` 的 `residentStore` + `legacyEngineeringSeed` 的 qa_retry/founder_rework 两条 loop):
1. implement 体 resident → QA `qa_pass` transition ⇒ `grace_expires_at == now`、`release_cause='verdict_pass'`、`release_source=transitionUid`、事件存在。
2. QA `qa_fail` ⇒ hold 不变(grace 仍在未来),rework request 的 preferred actor = 该体。
3. founder gate `founder_feedback_kickback` ⇒ hold 不变。
4. 同 run 两个 loop 目标(测试 manifest 加一个 design 目标)只释放 `verdictLoop.to`。
5. hold 已 `woken` ⇒ 不动。
6. 同一 transition 重放 ⇒ 幂等,事件不重复。

### C3 saga ACK 死证等价:`DeliveryOperations.runResidentExpiryPass`

位置:`delivery-operations.ts:143-171`(`applied` 阶段)。

- deps 形状:`residentExpiry?: { terminateClaude(executionId); probeTarget(executionId): Promise<PhaseLiveness> }`(`probeClaude` 改名,plugin `:8777` 实现不变)。
- Codex 分支:

```
shutdown = commDb.getRunnerShutdownRequest(exec, opId)   // 保持
if (shutdown?.state === 'failed') fail(...)
acknowledged = shutdown?.state === 'acked'
if (!acknowledged) {
  const registered = commDb.getSession(exec)              // db.ts:8071
  const deadByRegistry = !registered || registered.status !== 'running'
  if (deadByRegistry) {
    const liveness = await residentExpiry.probeTarget(exec)
    acknowledged = liveness === 'dead_pin' || liveness === 'absent'
  }
}
if (!acknowledged) continue
```

- `residentExpiry` 缺失时 Codex 分支退回只认 `acked`(不 fail,保持旧行为);Claude 分支缺失仍 `fail('claude_resident_expiry_effects_missing')`。
- `indeterminate` ⇒ 继续等(fail-closed)。
- 崩溃窗口:探针在 `markResidentExpirySent` CAS 之前,崩溃则下一 tick 重探;死体不会复活,重探结论稳定。

测试(RED,`fly2268-resident-expiry.test.ts` 加 case):codex `requested` + CommDB session 不存在 + `probeTarget→absent` ⇒ `sent → projected`;`requested` + CommDB session `running` ⇒ 仍 `applied`,`probeTarget` 未被调用;`requested` + 非 running + `indeterminate` ⇒ 仍 `applied`;既有 acked / failed 用例不变;Claude 用例把 `probeClaude` 改名后全绿。

### C4 投影落地:`projectResidentExpiry`

位置:`StateStore.ts:38290-38352`。同一事务顺序:

1. SELECT 时多取 `hold.release_cause, hold.release_source, hold.activation_id`。
2. hold CAS:`SET state='closed', closed_reason = CASE WHEN release_cause IS NOT NULL THEN 'released' ELSE 'expired' END`(保持 `WHERE … AND state='expired'`,rowsModified≠1 抛 `resident_expiry_hold_cas_failed`)。
3. sessions:
   ```
   session = getSession(root_id); activation = resolveCurrentWorkflowActivation(root_id)
   settle = session?.status === 'ship_parked' && activation.kind === 'current' && activation.binding.activation_id === operation.target_activation_id
   if (settle) { UPDATE sessions SET status='completed', last_activity_at=? WHERE execution_id=? AND status='ship_parked' (rowsModified≠1 抛 resident_release_session_cas_failed);
                 applyTerminalTimestamp(root_id,'ship_parked','completed'); bumpLifecycleRevision(root_id); settleResidentParkTx(root_id) }
   ```
   `settleResidentParkTx`:取该 execution 最新一代 `park_opened` 且 `reason='rework_reachable_wait'` 的行,调 `appendWorkflowEngineParkSettlementClearTx({open, createdAt: now})`(`:20621`,已幂等)。`runner_ship_gate_wait` 的 park 不在本单范围(不会出现在 loop 目标体上,若出现则跳过并在 payload 记 `parkSkipped`)。
4. op `sent → projected`(不变)。
5. 事件:kind = `release_cause ? 'resident_hold_released' : 'resident_hold_expired'`;payload `{executionId, activationId, nodeId, revision, requestId, cause: release_cause ?? 'grace_timeout', releaseSource, sessionSettled: settle, sessionStatusBefore, parkSettled}`。

不变量 / no-clobber:
- sessions 写只在 `status='ship_parked'` 且 activation 精确匹配;换代/替身接管后的体只关 hold。
- run terminal 的 `settleWorkflowEngineParksForRunTx` 再跑到该 execution:session 已终态 → `:20808` ledger-only 分支 → `appendWorkflowEngineParkSettlementClearTx` 等值校验通过 → 幂等。
- divergence:`commitWorkflowDivergenceObservation` 对 `completed` 判 `divergence:false`(`:~800`),不告警。
- 不回填历史:部署后陈旧 `expired/applied` 行经 C3 收敛到本步时,`session.status` 多为 `completed/failed` → 只关 hold。

测试(RED,`fly2478-resident-release.test.ts`):释放路 ⇒ closed_reason `released`、事件 kind `resident_hold_released`、sessions `completed`、`terminal_at` 有值、`lifecycle_revision` +1、park_cleared 行存在;到期路 ⇒ `expired` / `resident_hold_expired`,其余同;activation 不匹配 ⇒ hold 关、sessions 不动、payload `sessionSettled:false`;session 已 `failed` ⇒ 不动;随后 `settleWorkflowEngineParksForRunTx` 重跑不抛、不重复写;`listWorkflowDivergenceCandidates` 对该体 `commit…Observation` 返回 `divergence:false`。

### C5 一分钟释放:dispatcher 快车道

- `StateStore.countDueResidentHolds(now: string): number`:`SELECT count(*) FROM workflow_resident_hold WHERE state IN ('resident','expired') AND grace_expires_at < ?`(走 `idx_wrh_expiring`)。
- `WorkflowEngineDispatcherOptions` 加 `runResidentExpiryPass?: (now: string) => Promise<void>`;`reconcile()`(`workflow-engine-dispatcher.ts:340`)在 `reconcileWorkflowReworks` 之前:
  ```
  if (options.runResidentExpiryPass && store.countDueResidentHolds(now) > 0) await options.runResidentExpiryPass(now)   // 异常 log 不抛
  ```
- plugin:把维护 tick(`plugin.ts:8732-8788`)里 `new DeliveryOperations({... residentExpiry})` 抽成 `createProjectDeliveryOperations(projectName, commDb)`;dispatcher 回调 = 对每个 project 开 `new CommDB(path,false)` → `createProjectDeliveryOperations(...).runResidentExpiryPass(now)` → close;per-project 单飞 `Set<string>`,在飞则跳过。维护 tick 原样保留(兜底)。
- 零新定时器;`countDueResidentHolds` 为 0 时零 CommDB 打开(测试钉住)。

测试(RED):dispatcher 测试族加「count>0 调用一次 / count=0 零调用 / 回调抛错不影响 reconcile 其余步骤」;StateStore 加 `countDueResidentHolds` 三态(resident 未到期 0 / 到期 1 / expired 未投影 1)。

### C6 返工遇 hold 已死:直接换体

位置:`workflow-rework-coordinator.ts:804-818`。

```
if (!woke.ok) {
  if (woke.error === 'resident_hold_expired') return markReplacementPending(actor.execution_id, 'resident_hold_expired')
  return this.releaseRetryable({...})
}
```

`markReplacementPending` 定义在同一 `reconcile()` 闭包(`:449`)。`deliverResidentWake` 不改(仍是最后 fence)。dispatcher `:1022` 接 `replacement_pending` → `materializeWorkflowReworkReplacement`(会把老 session 写 failed 并 settle rework park,`:35002-35019`)。

测试(RED,`workflow-rework-coordinator.test.ts` 加):wakeActor 返回 `{ok:false,error:'resident_hold_expired'}` ⇒ outcome `replacement_pending`,delivery state `replacement_pending`,`hold_count` 不增;其它 wake 错误仍 `retryable`。

### C7 pane-loss 负向测试(代码零改动)

`pane-loss-reconcile.test.ts` 加:seed `status:'completed', adapter_type:'codex-tmux'`,无 tmux target ⇒ `reconcilePaneLoss` 返回 `scanned:0`,无 `runner_pane_loss_detected` 事件,`notify` 零调用。再加一条对照:同 seed 但 `status:'ship_parked'` ⇒ `advisories:1`(钉住「释放前会报、释放后不报」的差异是状态而不是巧合)。

### C8 FLY-2477 联动(独立 chunk,Lead 裁定纳入)

**C8a Bridge 续期**:`enterResidentHold`(`StateStore.ts:37903`),在「`existing.state==='resident' && boundary_seq === input.boundarySeq` ⇒ 幂等返回」之后、`woken` 分支之前加:

```
if (existing.state === 'resident' && existing.boundary_seq < input.boundarySeq) {
  UPDATE workflow_resident_hold SET boundary_seq=?, grace_started_at=?, grace_expires_at=?, release_cause=NULL, release_source=NULL, updated_at=?
   WHERE execution_id=? AND revision=? AND state='resident' AND boundary_seq=?      // CAS 旧 boundary
  rowsModified===1 ? {ok:true, revision: existing.revision, graceExpiresAt} : {ok:false, reason:'stale_boundary'}
}
```
revision 不变。`boundary_seq > input.boundarySeq` 仍 `stale_boundary`。

同时 `enterResidentHoldForCompletionTx`(`:52107-52140`,woken → resident 的 revision+1 路径)加 `release_cause=NULL, release_source=NULL`——体被唤醒返工后再次停驻,上一头的释放不再成立。

**C8b adapter 不拆体**:`codex-phase-lifecycle.ts:461-469`:

```
if (!resident.ok && resident.reason === 'stale_boundary' && this.options.residentHold.current) {
  const cur = await this.options.residentHold.current({ executionId })
  if (cur && (cur.state==='resident' || cur.state==='woken') && cur.activationId===opts.activationId && cur.nodeId===opts.nodeId) {
    adopt: 写本地 phaseHold {residentRevision: cur.revision, graceExpiresAt: cur.graceExpiresAt, ...}; residentBoundarySeq = cur.boundarySeq; return
  }
}
if (!resident.ok) throw new Error(`resident hold refused: ${resident.reason}`)   // 其余原样
```
`residentHold.current` 已在 deps 里(`CodexTmuxAdapter.ts:1188`,`run-infra.ts:1585`)。`activation_mismatch` / `invalid_input` / closed 行为不变(那是真的不该常驻)。

测试(RED):StateStore——resident + boundary+1 ⇒ 续期(revision 同、grace 前移、release_cause 清空)、boundary−1 ⇒ `stale_boundary`、续期后飞行中的 `wakeResidentHold(旧 revision)` 仍成功、续期后 `expireResidentHoldsTx(旧 grace 之后、新 grace 之前)` 不过期;adapter(`packages/claude-runner/test/fly2268-resident-receiver.test.ts` 或 `codex-phase-lifecycle.test.ts`)——`enter` 返回 `stale_boundary` 且 `current` 为 resident 同 activation ⇒ 不抛、本地 phaseHold 采用 Bridge 的 revision;`current` 为 closed ⇒ 仍抛。

### C9 真机验收(QA 节点执行;design 只写路书)

前置计数(只读,部署前后各一次):
```
sqlite3 "file:$HOME/.flywheel/teamlead.db?mode=ro&immutable=1" \
 "SELECT state, coalesce(closed_reason,'-') r, coalesce(release_cause,'-') c, count(*) FROM workflow_resident_hold GROUP BY 1,2,3;
  SELECT h.state, s.status, count(*) FROM workflow_resident_hold h LEFT JOIN sessions s USING(execution_id) GROUP BY 1,2;"
```
预期部署后 ≤ 1 个维护 tick(5 min):`expired` 行归零(全部 `closed/expired`),`ship_parked` 且 hold 非 resident 的组合归零。

1. **FAIL 复用**:选一张走 implement→qa 的小单,让 QA 出 `qa_fail`(或用 FLY-2456 台架的 simple_code 配方);断言 hold `resident(r1)→woken(r1)`、`workflow_rework_delivery` 直达 `awaiting_receipt→completed`、零 `rework_replacement_materialized`。
2. **PASS 释放 ≤ 60 s + 静默**:QA `qa_pass` 后抓 `resident_hold_released.at − node_completed(qa_pass).at`;sessions `completed`;CommDB session 非 running;`lead-patrol-snapshot.sh` 一轮 roster 不含该 target;issue thread 从 PASS 到 land 无 `runner_pane_loss` 帖。
3. **释放后可换体**:同一单 founder 打回 ⇒ `rework_replacement_materialized(reason=actor_session_terminal:completed)`,新体接单。
4. **2477 形状**:停驻期间重启 Bridge(FLY-2456 路书的受控重启),体存活、hold 仍 resident、`grace_expires_at` 被续期。
5. Claude 分支:仅单测(C3/C4 的 claude 用例),不做真机。

## 3. 数据、迁移、回滚

- 新列 2,可空,无回填;建表语句与 guarded ALTER 双写。
- 一次性收敛:部署后陈旧 `expired/applied`(真机 53 行)经 C3 → C4 关闭;其中 activation 仍 current 且 session `ship_parked` 的(真机 2 行)会写 `completed` 并 settle park。这是预期行为,C9 前置计数核对。
- 回滚 = 回滚代码。旧代码不读新列;`RESIDENT_GRACE_MS` 回到 30 min;已被写成 `completed` 的 session 不回退(它们本来也是终态候选)。回滚不跨 authority fence(不碰 gate/merge 表)。

## 4. 负向守卫(实施必须钉住)

1. `resident-hold.ts` 无 `qa|implement|design|process.env`(现有守卫)。
2. 释放只对 `state='resident'` 行;`woken/expired/closed` 永不被 C2 改写(测试)。
3. sessions 只在 `ship_parked` + activation 精确匹配时写;其它状态零写(测试)。
4. C4 只 settle `rework_reachable_wait` park;`runner_ship_gate_wait` 零触碰(测试用一个 runner_ship park 行做对照)。
5. C5 `countDueResidentHolds()===0` ⇒ 零 CommDB 打开、零回调(测试 spy)。
6. C6 只对 `resident_hold_expired` 错误串短路;其它 wake 错误保持 retryable(测试)。
7. founder 打回循环永不触发释放(测试)。
8. `fly2268-mechanism-guards`:表/索引集合不变;列集合恰好 +2。

## 5. 测试证据(PR body 逐条引用)

| 命令 | 覆盖 |
|---|---|
| `pnpm -C packages/teamlead test -- src/__tests__/fly2478-resident-release.test.ts` | C1 C2 C4 C5(store) C8a |
| `pnpm -C packages/teamlead test -- src/__tests__/fly2268-resident-expiry.test.ts src/__tests__/fly2268-replay.test.ts src/__tests__/fly2268-mechanism-guards.test.ts` | C0 C1 C3 回归 |
| `pnpm -C packages/teamlead test -- src/bridge/__tests__/workflow-rework-coordinator.test.ts src/bridge/__tests__/pane-loss-reconcile.test.ts src/bridge/__tests__/resident-wake-fence.test.ts` | C6 C7 |
| `pnpm -C packages/teamlead test -- src/bridge/__tests__/workflow-engine-dispatcher*.test.ts` | C5(dispatcher) |
| `pnpm -C packages/claude-runner test -- test/fly2268-resident-receiver.test.ts test/codex-phase-lifecycle.test.ts` | C8b |
| `pnpm -C packages/flywheel-comm test` | C0 文案 |
| 全量 `pnpm test` + `pnpm typecheck` + `pnpm lint` | 合并门 |

全部新 case 先 RED 再 GREEN;PR body 贴 RED 输出摘要。

## 6. 实施顺序与提交切片

C0+C1(schema/常量) → C2 → C3 → C4 → C5 → C6 → C7 → C8a → C8b → C0 文案。每块一个 commit,commit message 带 `FLY-2478`。C9 由 QA 节点执行。

## 7. 风险与开放点

- C3 把「CommDB 行不存在」当死证的一半:CommDB 行在 Bridge 里也会被 prune(`commdb-fsm-reconcile.ts`),prune 的前提是 FSM 终态 + 目标 proven dead,与本判据一致;再加 tmux 探针二次确认,`indeterminate` 不放行。
- C5 每秒一次 `count(*)` 索引扫描,表规模 1 行/execution,可忽略。
- C8b adopt 后本地 `residentBoundarySeq` 以 Bridge 值为准,避免下一次再 +1 撞 stale。
- founder 打回落在 PASS 释放之后 ⇒ 替身(issue 已接受);founder HTML「边界」卡写明。
