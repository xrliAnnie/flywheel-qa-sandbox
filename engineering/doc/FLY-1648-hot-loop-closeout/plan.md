# FLY-1648 热循环收口:死账手术 + 恢复循环退避与终态 — 实施计划

Issue: FLY-1648 (https://linear.app/geoforge3d/issue/FLY-1648/workflow-引擎批0-热循环收口held-rework-死账手术fly-1150fly-1596-恢复循环加退避与终态)
日期: 2026-08-06(v4,折入 Codex design review R1 9 项 + R2 6 项 + R3 4 项;**R4 APPROVED**)
基于: research.md

> Codex design review:4 轮 APPROVED。R4 附 3 条 non-blocking 实现注记:① 账本写序(闸→n→attempt→n==1 收据+alert→n>=5 deadend)保持单事务并加代码注释防回归;② 备份走 maintenance-only `backupTo(path)` 包装,不把 raw db handle 暴露给脚本;③ 异常步调 Map 在成功记录/完成时删 key、并对不在当前 candidate 集的 digest 做清理。实现节点照办。

## 0. 一句话

给 workflow 引擎两条「每 tick 无限重试必败操作」的路径接上**既有的**退避+终态骨架(60s·2^n、5 次封顶转 `needs_lead` / dead-end memo 出列;**全部 durable、耐重启**),并新增全防护的合法出口方法,由一次性手术脚本(免 migrate 维护通道)对 3 条死账执行结账——旧栈不重启、刷屏立即停。

**约束(全程生效)**:零 schema 变更、零新 env flag(FLY-1466 铁律)、零新周期任务/watchdog(红线:失败转人工态本身就是出口)、成功路径字节不动。

## 1. 变更清单

| 文件 | 变更 |
| -- | -- |
| `packages/teamlead/src/StateStore.ts` | 新方法 `settleHeldReworkRecoveryFailure`、`completeRunnerShipGateFromPersistedObservation`、`openForMaintenance`(免 migrate);`recordRunnerShipCompletionFailureTx` 扩为 durable 退避账本;`completeWorkflowGateRunAfterShip` 加 terminal-carrier 收口臂(并修 bump 泄漏);`listRunnerShipHoldersForMergeProbe` 加 4 类上下文键控出列探询 |
| `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts` | held 恢复分支接失败结算 + 探针步调(围绕**每次真实探针**);completion 异常归一进 durable 退避路径 |
| `scripts/fly-1648-hot-loop-closeout.mjs` | 一次性手术脚本(真只读 dry-run、preflight-all、备份、有界 busy 重试) |
| `packages/teamlead/src/__tests__/…` | 新增测试(§7);既有 workflow 套件必须全绿 |

## 2. Piece A — StateStore.settleHeldReworkRecoveryFailure(held 恢复失败的退避与终态)

```ts
settleHeldReworkRecoveryFailure(input: {
  requestId: string;
  reason: string;              // e.g. "rework_replacement_target_changed"
  now: string;
  alertIdentity: WorkflowEngineAlertIdentity;
  forceTerminal?: {            // 手术脚本专用(R1#6:必须带证据,不能裸 boolean)
    expectedRunId: string;
    expectedRouteRevision: number;
    expectedTargetNodeId: string;
    expectedTargetAttempt: number;
    expectedTargetExecutionId: string;
    operator: string;          // e.g. "fly1648-surgical-closeout"
  };
}):
  | { ok: true; state: "held" | "needs_lead"; holdCount: number; nextRetryAt: string | null }
  | { ok: false; reason: string }
```

单事务内:

1. **上下文守卫**(全部重读):delivery 存在且 `state='held' && last_error='persisted_target_missing'`;request/route/run 存在;`run.engine_owned=1 && run.status='held'`;`delivery.route_revision === route.revision`(R1#5:CAS 含 route revision)。任一不满足 → `{ok:false, reason:'held_recovery_context_changed'}`,零变异。
2. **forceTerminal 附加守卫**(R1#6):expected 五元组必须与重读的 request/route 逐字一致,且重读 target node 必须**已不可恢复**——`getWorkflowRunNode(run, target_node_id, target_attempt)` 为空、或 `state ∉ {pending, admitted}`、或 `execution_id ≠ expectedTargetExecutionId`(即 materialize 的 target 检查**必然失败**的同款谓词)。target 仍健康 → `{ok:false, reason:'force_terminal_target_still_recoverable'}`。**模型只能对确证死账动刀。**
3. `holdCount = delivery.hold_count + 1`;`exhausted = forceTerminal 存在 || holdCount >= 5`(常量与 FLY-1638 `StateStore.ts:20795` 同款,内联)。
4. **未耗尽**:
   `UPDATE workflow_rework_delivery SET hold_count=?, next_retry_at=?, updated_at=? WHERE request_id=? AND state='held' AND last_error='persisted_target_missing' AND hold_count=? AND route_revision=?`(CAS 含旧 hold_count + route_revision)。
   `next_retry_at = now + 60_000 * 2^(holdCount-1)`(1m/2m/4m/8m)。**`last_error` 不动**——恢复分支谓词(`dispatcher:770`)必须在退避到期后仍能识别此行。
   追加 checked event `rework_held_recovery_failure:{requestId}:{holdCount}`(payload = requestId/holdCount/reason/nextRetryAt)。
5. **耗尽**:
   `UPDATE … SET state='needs_lead', owner_id=NULL, lease_expires_at=NULL, hold_count=?, next_retry_at=NULL, last_error=?, updated_at=? WHERE …(同上 CAS)`——此刻把真实失败原因写进 `last_error`;**同事务**把 `workflow_rework_verification_path` 中 `state IN ('pending','active')` 的行更到 `needs_lead`(R1#5:与 FLY-1638 耗尽路径 `20894-20900` 同款,两本 rework 账本一致)。
   追加 checked event `rework_held_recovery_exhausted:{requestId}`(payload 含 reason、holdCount、forceTerminal 证据与 operator 身份如有)+ `enqueueWorkflowEngineAlertTx` **一次** severe(escalationUid = 该 event uid;文案:「已转 needs_lead,不再自动重试,复活走 operator rework」)。**run 保持 `held`**——正好落在 FLY-1434 `openOperatorRework` 复活路径的合法输入域(run held + needs_lead delivery)。
6. CAS 0 行(并发抢先)→ `{ok:false, reason:'held_recovery_settle_raced'}`,不 throw(tick 不崩)。

## 3. Piece B — dispatcher held 恢复分支接线

`workflow-engine-dispatcher.ts` held 分支(`758-821`):

1. **探针步调围绕每次真实探针**(R1#5):`heldReworkRecoveryProbeAt: Map<string, number>`(形态照抄 `shipReadyFounderRetries:886`)。进入 held 分支先查 `now < nextProbeAt` → `continue`(不计 held、不探针、不开事务)。**在发起探针前**(等价于 try/finally 环绕)写 `nextProbeAt = now + 60_000`——探针抛异常、liveness=alive/unknown、materialize 各种结局**全部**被步调覆盖,不存在 1 次/s 的漏网分支。每轮扫描结束after,对不在本轮 held 候选集内的 key 做 Map 清理(防泄漏)。
2. **materialize 失败**(`814-819`,`materialized.ok === false`):保留现有 log,追加调用 `settleHeldReworkRecoveryFailure({requestId, reason: materialized.reason, now, alertIdentity})`。
3. **materialize 抛异常**(`807-813`):同样追加 settle(reason = 截断后的 error message)。settle 自身抛错 → catch + log(步调 Map 兜底,最多 1 次/min)。

durable 一侧:`next_retry_at` 写入后,`listWorkflowReworkDeliveries` 既有过滤(`20158-20163`)自动跳过未到期行——**重启存活**的退避,lister 零改动。`needs_lead` 不在 dispatcher 查询的 states 里 → 终态后循环彻底不碰(探针数=0、事务数=0)。

## 4. Piece C — completeWorkflowGateRunAfterShip 的 terminal-carrier 收口臂

位置:`StateStore.ts:33321`(sessions UPDATE 0 行处)。当前直接判 `carrier_session_mismatch`;改为先甄别:

```sql
SELECT status, review_question_id, lower(pr_head_sha) AS head, lifecycle_revision, terminal_at, last_activity_at
  FROM sessions WHERE execution_id = ?   -- holder.source_execution_id
```

- **收口臂放行条件**(三条同时,逐字):`review_question_id === input.questionId` **AND** `head === mergedHead` **AND** `isStateStoreIrreversibleTerminalForZombie(status)`(`StateStore.ts:404`)。
  → **跳过 session 变异**,继续既有完成序列:run `active→completed` CAS、gate node → done、`run_completed` event(payload 增加 `carrierDisposition: "carrier_already_terminal:<status>"`;replay 校验只比 mergedHead+fingerprint(`33228-33236`),不受影响)。
  **R1#3 修正**:`bumpLifecycleRevision(source_execution_id)`(`33360`)**只在正常路径**(sessions UPDATE 真实改行)调用——收口臂下终态 session 的 `lifecycle_revision`/`terminal_at`/`last_activity_at` 全部零触碰,不发明没有发生过的 lifecycle 变迁。
  语义:merge 证据全部成立时,run 完成是事实;carrier 的 blocked 是它自己的台账(FLY-1505 deflect),终态免疫(FLY-228/229)禁止回写——诚实账记在 run event 的 disposition 里。
- **其余一切**(行不存在 / question 不符 / head 不符 / status 非终态)→ `carrier_session_mismatch` 失败路径(经 Piece D 的 durable 退避账本)。

评审确认(R1):收口臂位于 holder/subject/authority/observation/approval/claims 全部证据检查**之后**,FLY-1624 证据链不被短路。

## 5. Piece D — completion 失败的 durable 退避 + 上下文键控 dead-end(R1#1/#2/#4 重设计)

**不用进程内 Map 承载正确性**(重启清零 = 重启风暴下永不封顶,而本缺陷恰恰死于重启场景)。退避与封顶全部落在 StateStore 事务里:

1. **稳定的 pre-attempt context digest**(R1#2 + R2#1 + R3#2:**身份与诊断分离**):共享 helper `runnerShipCompletionContextDigest(holder, now)`(claims 解析吃 `now`,`StateStore.ts:29901`——两侧必须传同一时刻)= `sha256(canonical-json{questionId, holderState, holderHead, authorityFingerprint, observationProjection:{status, headSha}, sourceExecutionId, carrier:{exists, status, reviewQuestionId, prHeadSha}, claims:{valid, reason}})`,可空字段显式规范化(null 哨兵 + lowercase hex)。**只含尝试前可读的状态,绝不含失败结果或异常文本**——lister 与记录事务调用同一 helper,两侧可算且必然一致;可变异常文本不再能把计数打散。上下文任一维修复(carrier 重绑、source execution 替换、claims 修复、head 换新、重批)都改变 digest → 退避/终态自动失效、candidate 自动回归。失败原因与截断后的诊断细节**只进 attempt event payload**(规范化 error code + bounded detail),不进任何 uid/digest。
2. **durable 退避账本 + 写侧闸 + episode 首击收据**(R2#2 + R3#1):`recordRunnerShipCompletionFailureTx` 重构(同一事务):
   - **写侧闸先行**:事务内重算稳定 digest;若已存在 `runner_ship_completion_deadend:{digest}`、或最新 attempt 的 `nextRetryAt > now` → **不追加任何 event**,返回 `not_due`(并发的第二个写者不烧预算——两进程同时列到同一 due candidate 时只落一 strike,五个竞争者不可能在 15 分钟内烧穿封顶)。
   - 过闸后:追加 checked event `runner_ship_completion_attempt:{digest}:{n}`(n = 本 digest 下既有 attempt 数 + 1,事务内 COUNT;payload = questionId/errorCode/boundedDetail/mergedHead/digest/n/nextRetryAt),`nextRetryAt = now + 60_000 * 2^(n-1)`。**每次 attempt 的可变诊断只住在这里。**
   - **episode 首击收据(R3#1)**:`appendWorkflowRunEventCheckedTx` 对重复 uid 要求 payload 逐字一致(`28095-28140`),`enqueueWorkflowEngineAlertTx` 对已有 escalationUid 不同 payload 会 throw(`23169-23188`)——所以稳定键的 failure 收据 `runner_ship_completion_failure:{digest}` 与其 severe alert **只在 n === 1 时写/发一次**,payload 完全由稳定上下文构成(零可变文本)。第 2..n 击只落 attempt event,绝不重放收据/告警 → 不可能 uid conflict 回滚。
   - `n >= 5` → 同事务追加 `runner_ship_completion_deadend:{digest}`。**不发第二个告警**——首击 severe 已经是人工接手通知;dead-end 只执行「停止重试」。
3. **lister 源头出列**(R1#1/#2/#4):`listRunnerShipHoldersForMergeProbe(now)`(**加 now 参数**,由 dispatcher 显式传入,R2#2)对每个 candidate 用同一 helper 重算稳定 digest(candidate 数量级为个位数,代价可忽略):
   - 存在 `runner_ship_completion_deadend:{digest}` → skip(终态;digest 变了自动回归);
   - 最新 `runner_ship_completion_attempt:{digest}:{n}` 的 `nextRetryAt > now` → skip(退避中;probe/classify/completion 全链在退避期零执行);
   - **`authority_conflict` 出列**(R1#4):其 checked event uid 含精确上下文 digest,lister 以「当前上下文 uid 已有记录 → skip」出列,上下文变化自动回归;
   - **legacy merged anomaly 出列**(R2#5 + R3#4):其既有 uid 尾部是探针后才知道的 anomaly 分类(`StateStore.ts:33506`),lister 在探针**之前**无法重构精确 uid → 改用**本地上下文前缀查询** `runner_ship_legacy_merge_anomaly:{questionId}:{holderState}:{holderHead}:{prNumber}:%`(**以 uid 分隔符收尾**——否则 PR 12 会误匹配 PR 123 的旧收据):前缀下存在任意 anomaly 收据即视为终态,直到本地 authority 输入(state/head/prNumber)变化才回归。零新 event kind,零新告警。
4. **completion 异常归一**(R1#4 + R2#3 + R3#2):`recordRunnerShipCompletionFailureTx` 是私有且吃已加载 holder 的事务内 helper;completion 抛异常时其事务已回滚,dispatcher 不能直接复用。新增**公开** `recordRunnerShipCompletionException({questionId, expectedContextDigest, errorCode, boundedDetail, now, alertIdentity})`:lister 把算好的稳定 digest 投影到 candidate 上,dispatcher 原样传回;新事务重读 holder/membership/证据、**重算 digest 并与 expectedContextDigest 比对**——不一致(失败与记录之间上下文已被修复)→ 返回 `candidate_changed`,绝不把旧异常记到修复后的上下文头上;一致 → 过同一写侧闸。返回 `recorded | not_due | dead_ended | candidate_changed`。dispatcher 在 `completeWorkflowGateRunAfterShip` 调用点包 try/catch,异常 → 规范化 error code(如 `completion_exception`)+ 截断 detail 走此入口。账本写入自身也失败(极端 DB 故障)→ 进程内**仅异常步调** Map(键 = candidate 上投影的稳定 digest,连账本都写不了时依然可用;非正确性承载)保底 1 次/min。

## 6. Piece E — 手术脚本 `scripts/fly-1648-hot-loop-closeout.mjs`(R1#7/#8 重设计)

**通道**:新增 `StateStore.openForMaintenance(dbPath, { readonly })`(R2#4)——文件必须已存在(缺失即 abort,**绝不 mkdir、绝不新建**)、**不跑 migrate()**、开机做**精确 schema preflight**(所需表/列/CHECK 状态逐项核对:`workflow_rework_delivery` 的 needs_lead CHECK、hold_count/next_retry_at 列、`workflow_run_event`、gate/session 表形态;任何漂移 → abort 并打印差异)。readonly 模式只设 connection-local `busy_timeout=5000`(不设 journal_mode/synchronous,不改持久状态);apply 模式**断言**期望 journal_mode=WAL 而非改写它,并额外设置 connection-local `foreign_keys=ON`。维护实例走**免 checkpoint 的 raw close**——脚本退出绝不对活 Bridge 的 WAL 做 `wal_checkpoint(TRUNCATE)`(既有 `close()` 会,`StateStore.ts:1342-1360`)。生产 DB 的 schema/pragma 演进权**始终归 Bridge 部署**,脚本零 DDL。

- **dry-run(默认)**:`{readonly: true}` 只读连接,打印每条账的当前行(delivery/run/holder/session/observation)与将发生的转移。只读连接物理上写不了——「零写入」由连接模式保证,不靠纪律。
- **`--apply`**:
  1. **构建校验(commit-bound,R2#6)**:runbook 在动刀前一步强制 `pnpm build`(teamlead),脚本动态 import dist 并把 `git rev-parse HEAD` 记入手术输出;mtime 不作为证据。
  2. **preflight-all**:先对全部目标账做一遍与事务内相同的守卫检查,任一不符 → 整体 abort(第一刀之前零变异)。
  3. **备份**:better-sqlite3 online `backup()` 到 `~/.flywheel/backups/teamlead-pre-fly1648-<ts>.db`(WAL-safe),成功才继续。
  4. 逐账执行(每账独立事务):
     - retire → `settleHeldReworkRecoveryFailure({…, forceTerminal: {expectedRunId, expectedRouteRevision, expectedTargetNodeId, expectedTargetAttempt, expectedTargetExecutionId, operator: 'fly1648-surgical-closeout'}})`(期望值由脚本从 dry-run 输出复核后内嵌于调用,与库内重读逐字比对);
     - gate → `completeRunnerShipGateFromPersistedObservation({questionId, now, alertIdentity})`:事务内读 holder → `resolveRunnerShipAuthority` → 载入**已持久化** observation projection(`status='valid'` 且 head === holder.head_sha,否则 fail-closed,**绝不触网**)→ 以派生参数走 `completeWorkflowGateRunAfterShip`(经 Piece C 收口臂完成)。
  5. **busy 语义如实**(R1#8):`busy_timeout=5000` 只是锁等待,不是自动重放。识别为 `SQLITE_BUSY`/`SQLITE_LOCKED` 的失败 → 有界重试(3 次、间隔 2s);CAS 0 行 → 重读打印现状后按「该账失败」处理。**允许部分成功**:每账独立、幂等(settle 撞 `held_recovery_context_changed`/`_raced`、complete 撞 idempotentReplay),失败账重跑脚本即可;脚本明确打印每账 applied/skipped/failed 三态与原因。
  6. **收尾核验**:`PRAGMA quick_check` + 手术前/后 `foreign_key_check` exact baseline 对比(允许生产库既有、与本单无关的历史 FK 债,但本窗口零增删)+ 逐账 after 行 + 落下的 event uid 清单(手术证据)。
- **参数**:`--db`(默认 `~/.flywheel/teamlead.db`)、`--retire-held-rework <requestId>`(可重复)、`--complete-gate <questionId>`(可重复)、`--apply`。
- **本次手术清单(runbook,全 ID)**:
  `--retire-held-rework rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af --retire-held-rework rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67 --complete-gate workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c`。**不含**冷账 d90e10f0/1eb8e15(工具能力覆盖,是否结由 Tadashi/Annie 决定)。
- **生效机制**(无需重启旧 Bridge):needs_lead 出 `['pending','turn_granted','held']` 列表、completed run 出 candidate 列表 → 旧栈下一 tick 起两类刷屏归零。预期副作用:2 条 needs_lead severe alert(runbook 预告,不算事故)。

## 7. TDD 测试清单(先红后绿)

| # | 测试 | 断言 |
| -- | -- | -- |
| T1 | settle 失败 1-4 次 | hold_count/next_retry_at 精确(1m/2m/4m/8m)、state 仍 held、**last_error 仍 persisted_target_missing**、checked event 落 uid |
| T2 | settle 第 5 次 | needs_lead、owner/lease 清空、next_retry_at=NULL、last_error=真实原因、verification_path 同步 needs_lead、exhausted event、**恰一条** severe alert、run 仍 held |
| T3 | forceTerminal | 死 target(failed/缺失/execution 不符)→ 直接 needs_lead;**健康 target(pending+execution 匹配)→ 拒绝零变异**;expected 五元组不符 → 拒绝 |
| T4 | settle 守卫/CAS | 状态/route revision 被并发改动 → `{ok:false}` 零变异 |
| T5 | lister 退避 | held 行 next_retry_at 未到期不返回、到期返回;needs_lead 永不返回 |
| T6 | **验收#2 复现**:必败 held rework 全链 | fake probe(dead)+ 真 StateStore:N 次 tick 后 needs_lead;之后再 tick,probe 调用数与 materialize 调用数**均为 0** |
| T7 | **验收#3 回归**:健康 held pane-loss | target 仍 pending/admitted + actor 真死 → materialize 成功换人,行为与现状逐字一致;既有全套 workflow 测试绿 |
| T8 | terminal-carrier 收口臂 | carrier blocked + question/head 逐字匹配 → run completed、node done、payload 带 carrierDisposition;**session 全行深比对零变化(含 lifecycle_revision/terminal_at/last_activity_at)**;重放幂等 |
| T9 | 收口臂负例 | head 不符 / question 不符 / status='running' / 行缺失 → 各自仍 `carrier_session_mismatch`,零完成;正常路径(carrier 真在 approved_to_ship)完成时 bump 仍发生 |
| T10 | completion durable 退避+dead-end | 连续失败:attempt event n/nextRetryAt 精确;**进程重建(新 StateStore 实例)不清零计数**;第 5 次落 deadend event;lister 退避期与终态后都不出该 candidate、**无第二条 alert**;**same-head 修复(改 carrier 绑定/换 source execution/claims 修复)→ digest 变 → candidate 回归**;**可变异常文本不打散计数(两次不同 message 的异常 → 同 digest、n 递增)**(R2#1);**episode 首击收据:不同诊断的多次失败 → 恰两条 attempt event、恰一条 failure 收据、恰一行 alert outbox、零 uid conflict**(R3#1);**写侧闸:未到期/已 deadend 时记录入口返回 not_due 零追加**(R2#2);`recordRunnerShipCompletionException` 各返回态(recorded/not_due/dead_ended/candidate_changed)+ **rollback→记录间隙上下文被修复 → candidate_changed 不误记**(R3#2)+ 账本写入失败 → 步调 Map 保底(R2#3) |
| T11 | needs_lead 复活衔接 | settle 判终后,`openOperatorRework`(run held + needs_lead)成功接手(集成一条) |
| T12 | 手术脚本 | fixture DB 复刻 3 账形态:dry-run 只读连接下**逻辑状态零变化(行/schema/event 逐项比对;`-shm` 是 SQLite 锁/索引瞬态,不作字节断言)**(R2#4)、缺 DB 文件 → abort、schema 漂移 → abort、readonly/apply 都断言 `foreign_keys=1` + `busy_timeout=5000`、close 不 checkpoint；fixture 注入既有 FK violation,验证手术前后 exact baseline 不变；`--apply` 达到预期终态+event；首次 preflight 已被新 Bridge 合法自愈的账以 exact event/alert evidence 接受为 `already_applied`；二次 `--apply` 幂等 replay；部分失败(一账被并发抢先)→ 其余账照常、退出码与三态打印如实 |
| T13 | 双连接/双进程竞态(R1#8 + R2#2) | 真两连接:手术事务与模拟 tick 事务并发跑两类手术操作,终态唯一、无双写、CAS 失败方零变异;**两个并发写者对同一 due candidate 记录失败 → 只落一 strike(写侧闸)** |
| T14 | authority_conflict / legacy anomaly 出列(R1#4 + R2#5 + R3#4) | 已记录 conflict(精确 uid)/anomaly(**本地上下文前缀,分隔符收尾**)的 candidate 不再进扫描、不再每 tick 探针;state/head/prNumber 任一变化后回归;**PR 12 vs 123 前缀碰撞负例** |

## 8. 验收映射

1. **旧栈 30 分钟零刷屏**:merge 后从 main checkout(fresh build)跑手术脚本 `--apply` → 备份/quick_check 通过 → 对 `/tmp/flywheel-bridge.log` 做手术时刻后的 30 分钟窗口 grep 计数,`rework_replacement_target_changed` 与 `carrier_session_mismatch` 新增行数均为 0(before 基线:近 2000 行中 1656 行,见 exploration §1)。由独立 QA 节点执行,不由实现者自报。
2. **必败账终态停手**:T6 + T10(重启不清零)。
3. **正常恢复回归**:T7 + T9 正常路径 + 全仓 gates(`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`)。
4. **r4 关联**:验收通过后回报 Tadashi,r4 runbook「热循环检查」打绿。

## 9. 风险与对策

| 风险 | 对策 |
| -- | -- |
| 手术脚本对生产 DB 的写入风险 | `openForMaintenance`:零 migrate、零 DDL、schema preflight 漂移即 abort;dry-run 物理只读;apply 前 preflight-all + online backup;busy 有界重试;每账独立幂等事务,允许部分成功重跑 |
| settle/complete 与旧栈 tick 竞态 | 全 CAS + WAL 单写者;busy_timeout 只当锁等待用,不当重放承诺;T13 真双连接验证;任一方失配即零变异 |
| dead-end 键过宽误伤未来修复 | 稳定 pre-attempt digest 覆盖 holder/authority/observation/carrier/claims 全维(**不含失败结果**);same-head 修复改变 digest 自动回归(T10) |
| 并发写者烧穿重试预算 | 写侧闸:记录事务内先查 deadend/未到期,不过闸零追加(T13) |
| 脚本 close 干扰活 Bridge WAL | 维护实例 raw close,零 checkpoint(T12) |
| forceTerminal 误伤健康账 | 期望五元组 + 事务内重读 target 必须已不可恢复,否则拒绝(T3) |
| transient 失败被误判终态 | 5 次预算跨 ≥15 分钟;digest 键控使修复自动解除;needs_lead 有复活路径 |
| needs_lead alert 措辞误导 | 文案明确「不再自动重试;复活走 operator rework」 |

## 10. 诚实边界(本单不做什么)

- **不裁决** FLY-1150 / FLY-1596 两个 held run 的业务终局(再 rework 还是关单)——只终结无限重试,把账停进设计好的人工决策态(needs_lead + 既有 severe 通知),裁决权在 Lead/founder。
- **不动**消息层重投(FLY-1646,不同器官)、tick 节奏、任何成功路径、生产 DB schema(脚本零 DDL)。
- **不加**监控/watchdog/周期告警/env flag/schema。
- **不结**两条冷账(d90e10f0 / 1eb8e15)——工具能力已覆盖,执行与否留 Lead 决定。
- FLY-1596 head-drift 五本账台账问题本身不在本单(本单只让它的卡死 gate 以 merge 事实收口)。

## 11. 里程碑与流程

- 分支:`flywheel-FLY-1648`(已在);PR base = `main`;版本号 ship 时取空号(暂记 v1.5x)。
- **实施顺序(R1#9)**:StateStore 层先行——Piece C(收口臂+bump 修正,T8/T9)→ Piece D(durable 退避账本+lister 出列,T10/T14)→ Piece A(settle,T1-T5)→ dispatcher 接线 Piece B(T6/T7)→ 最后 Piece E(openForMaintenance + 脚本,T12/T13)→ 全仓 gates → codex code review 循环 → PR。
- 手术执行属 ship 节点 runbook(merge 后、r4 前,顺序:fresh build → dry-run 核对 → backup → apply → quick_check → 30 分钟窗口),验收#1 由独立 QA 把关。
- **执行权限(Tadashi design 验收附带指令,2026-08-06)**:对活账本跑手术是 **operator 级动作**——实现节点在 PR 里交付的是 dry-run 模式 + 执行手册(runbook),`--apply` 的真执行**由 Lead/founder 侧触发**,runner 自己绝不对生产库执行。implement 须把脚本的执行时机与幂等语义(重跑安全、部分成功语义)在代码与 runbook 里写明。
