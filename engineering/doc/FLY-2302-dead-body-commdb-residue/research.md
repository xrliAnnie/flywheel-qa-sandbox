# FLY-2302 死体回滚后 CommDB 注册行残留 — 调研

Issue: FLY-2302 (https://linear.app/geoforge3d/issue/FLY-2302/病根-死体被引擎回滚换体后-sessionsstatusblocked-永不终结巡检名册每-tick-假报-missing-pane且是)
日期: 2026-09-03
基于: exploration.md

exploration.md 选定方案 A:引擎在证明死体已死之后,用**与每小时清扫完全相同的谓词**定点封掉死体的
CommDB 注册行。本文逐条核实 A 依赖的事实,并把「放在引擎哪一步」定下来。

## R1. 引擎 tick 与挂载点

**问题**:回滚之后多久能封账?挂在哪一步不会每秒扫全库?

**证据**:
- `WorkflowEngineDispatcher.start(intervalMs = 1_000)`(`workflow-engine-dispatcher.ts:276`),生产
  `workflowEngineDispatcher?.start()` 不传参 ⇒ **每 1 秒** `reconcile()`,内部串行:
  `reconcileWorkflowEngineAlerts → reconcileAdmissionPauseAlert → reconcileWorkflowDivergence →
  reconcileDeadExecutionTripwires → reconcileDeadExecutions → …`(`:300-311`)。
- `reconcileDeadExecutionTripwires`(FLY-1385 误报 tripwire)每 tick 已经用 cursor 分页(200/页)遍历
  `workflow_dead_execution_watch` 的 `active` 行,对**每一条**调 `probeDeadExecutionActivity`,
  而后者每次都 `CommDB.openReadonly` 做 `countMessagesFrom`(`dead-exec-activity.ts:49-63`)。
- `workflow_dead_execution_watch` 行由回滚事务本身插入(`StateStore.ts:41752-41777`),主键
  `dead_execution_id`,TTL 24h(`DEAD_EXECUTION_WATCH_TTL_MS`),真库里 20a31b8b 的 watch 行仍在
  (`state=active, observed_at=2026-09-03T18:20:43.018Z`)。

**结论**:挂在 `reconcileDeadExecutionTripwires` 的循环里,紧接 `probeDeadExecutionActivity` 返回
`null`(死体无活动迹象)之后。枚举集合、分页、CommDB 打开成本都是**已有的**,新增的只是同一次
打开里多一条 `sessions` 行读取 + 一次 tmux `list-panes` 探针。每个死体的 tmux 探针只在其注册行仍在时发生,
行一删就归零。用进程内 `Set<dead_execution_id>` 记「已确认无行」可把后续 tick 的 CommDB 读也省掉
(与现有 `unknownLivenessCounts` 同款的内存态,不落库)。

**时延**:回滚 → TURN 移交(本例 6 秒,seq 22 → seq 28)→ 下一 tick 封账。假 `MISSING_PANE`
窗口从「≤ 60 分钟」压到「≤ TURN 移交 + 1 秒」。

## R2. 删行不会削弱 FLY-1385 误报 tripwire

**问题**:tripwire 的目的是抓「被判死其实还活着」的体;封掉它的 CommDB 注册会不会让 tripwire 失明?

**证据**(`dead-exec-activity.ts`):
- 四类活动证据:`commit_marker`(launch marker mtime)、`session_commit`(StateStore commit_count)、
  `commdb_write`(`countMessagesFrom` = `SELECT COUNT(*) FROM mailbox_message_projection WHERE from_agent=?`,
  `db.ts:5143`,**不看 state**)、`tmux_output`(对 `resolveTmuxTarget` 与 **baseline.tmuxTarget** 两个目标
  各 capture 一次,`:172-179`)。
- `finalizeSession`(`db.ts:6906-6978`)只 UPDATE mailbox 行状态、DELETE `runner_shutdown_controls` /
  `runner_stop_declarations` / `sessions`;**不删 mailbox 行** ⇒ `countMessagesFrom` 不变。
- baseline 在回滚事务前捕获,真库 20a31b8b 的 baseline:
  `{"tmuxTarget":"runner-flywheel:@401","tmuxOutputDigest":null,"commDbMessageCount":30,…}`
  —— 目标已固化在 watch 行里,`sessions` 行删掉后 `resolveTmuxTarget` 返回 `gone`,tripwire 仍探 `@401`。

**结论**:删行后四类证据一类不少。而且今天的每小时清扫本来就对这些 watch 中的死体做同样的删除
(它不看 watch 表),所以 A **不改变**任何 tripwire 语义,只改变删除的时刻。写进 plan 的不变量。

## R3. 「证明已死」谓词可以原样复用

**问题**:定点封账用什么条件?能否与每小时清扫共用一个函数?

**证据**(`commdb-session-prune.ts:148-260` `pruneDeadTerminalCommDbSessions` 循环体):
1. `turnHolders.has(exec)` ⇒ 跳过(FLY-1374)。
2. `status ∈ {completed,timeout} ∪ (includeCrashPreserve ? {failed,blocked} : ∅)`。
3. `probeTmuxWindowLiveness(tmux_window) === "dead"`,即 `list-panes -t <target>` 报
   `isTmuxAbsenceMessage`;`:pending` 一律 `indeterminate`(`tmux-lookup.ts:608-624`)。
4. `getEffectiveDeclaredState(exec).kind !== "parked"`,查询抛错按 parked 处理(FLY-1329 fail-closed)。
5. `finalizeSessionUnlessTurnHolder`(同一 IMMEDIATE 事务内再核 TURN)。
6. `onFinalizeOutcome` → `store.recordCommDbFinalizeOutcome(...)`。

生产调用 `includeCrashPreserve: true` 无开关(`plugin.ts:5987`);`commDbFsmReconcileEnabled = true`
硬编码(`:5916`)。

**结论**:把循环体抽成 `finalizeDeadTerminalCommDbSession(projectName, executionId, opts)`,
返回 `"finalized" | "no_row" | "kept_turn_holder" | "kept_alive" | "kept_indeterminate" | "kept_parked" | "kept_status" | "failed"`;
`pruneDeadTerminalCommDbSessions` 改为对每行调用它并把结果折进原来的计数器。**一个谓词,两个调用者**。
定点路径用 `finalizePaneLossResidue(exec, tmux_window)`(多一道「目标未变」CAS,`db.ts:7013-7041`)
代替 `finalizeSessionUnlessTurnHolder`,清扫路径保持原调用不变(避免改动 FLY-1329 四组 veto 测试的期望)。

**阳性对照必须覆盖**:
- Claude 体 blocked、pane 仍活(`probe → "alive"`)⇒ `kept_alive`,行不删,巡检看到 pane,无 finding。
- 死体仍是 TURN 持有者 ⇒ `kept_turn_holder`,下 tick 重试。
- 探针 `indeterminate`(tmux 超时/服务器不在)⇒ 不删。
- 行已不存在 ⇒ `no_row`,进内存 Set,不再探。

## R4. TURN 移交时序:适配器封账必被否决,引擎封账 6 秒后可行

**证据**:
- `three_stage_turn` 以 `issue_id` 为主键,授予替换体时 `ON CONFLICT(issue_id) DO UPDATE SET holder_exec_id = excluded.holder_exec_id`
  (`db.ts:142-150, 5355-5362`)⇒ 旧持有者行被覆盖,不残留。
- 真库:`FLY-2145 holder=470e0afd epoch=3`;事件 `turn_granted` seq 28 @18:20:49,回滚 seq 22 @18:20:43。
- 适配器 kill 窗口发生在 18:20:42(死体仍是 holder)⇒ 方案 D(适配器自封)确实会被
  `finalizeSessionUnlessTurnHolder` 否决,exploration §4 的否决理由成立。

## R5. 谁在消费 CommDB 的 `blocked` 行 —— 删了不会伤到谁

| 消费者 | 读法 | 删行后 |
|---|---|---|
| Lead 巡检 shell `run_comm_index` | `status IN ('running','blocked') AND 已绑窗` | 目标消失 ⇒ 不再报 MISSING_PANE(**目标效果**) |
| Bridge `patrol-orphan-sweeper.activePatrolTargets` | 同上集合(`plugin.ts:9095`) | pane 早已被 kill,集合少一个死目标,orphan 判定不受影响 |
| `close-runner`(Lead 手动 close / closeout) | 读 CommDB `tmux_window` 做 forcePreserved teardown | 行没了 ⇒ `finalizeCommDbSession` 返回 `no_db`/0 行,closeout 走 `no_session_row_communications_finalized` = done(`lifecycle-closeout.ts:1255`) |
| `lookupTmuxTarget`(引擎/探针) | `gone` | 死体节点已被替换,引擎不再探它;tripwire 用 baseline 目标(R2) |
| `commdb-fsm-reconcile` | 只扫 `running` | 无关 |
| 每小时 `pruneDeadTerminalCommDbSessions` | 同谓词 | 已删 ⇒ `scanned` 少 1 |

无发现任何消费者依赖「blocked 行 + 已死窗口」这个组合。

## R6. 引擎「dead」证据与 prune「dead」证据的关系(为什么不能直接信引擎的 dead)

`probeGeneralizedLaunchLiveness`(`generalized-launch-recovery.ts:49-95`)的 `"dead"` 有三个来源:
(a) tmux 目标存在且 `probeRunnerProcessLiveness ∈ {absent, dead_pin}`;(b) 目标 `:pending` 且主机无同名进程;
(c) CommDB 行 `gone` 且主机无进程。只有 (a) 等价于 prune 的 `list-panes` absent;(b) 的行不在 owner index
(`NOT LIKE '%:pending'`),(c) 根本没有行。所以定点封账**不复用引擎的 liveness 结果**,而是重新跑 prune 谓词
(R3),既避免在两处维护「什么算死」,又天然把 (b)(c) 排除。`dead_pin`(pane 存在但全 dead)时 prune 探针会说
`alive`(list-panes 成功)⇒ 不删,行留给每小时清扫/closeout —— 这是**保守方向**,可接受。

## R7. 测试基座

- `packages/teamlead/src/__tests__/commdb-session-prune.test.ts`:用临时 `FLYWHEEL_COMM_DIR` + `new CommDB` +
  `registerSession` + 注入 `probe` 的 vitest 基座;`commdb-session-prune.fly1329-parked-veto.test.ts` 与
  `commdb-residue-layer-interaction.test.ts` 覆盖 veto 与层间传递。抽函数后这些测试**必须原样通过**(行为不变的证明)。
- `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`:`new WorkflowEngineDispatcher({...})` +
  `reconcile()` 的骨架,已有注入点 `probeLaunchLiveness` / `captureDeadExecutionActivityBaseline` /
  `probeDeadExecutionActivity`。新增可选依赖 `finalizeDeadExecutionCommDb?` 同款注入,生产默认接真函数。
- `scripts/__tests__/lead-patrol-snapshot.test.sh`(CI `ci.yml:975`)的 `MISSING_PANE` 夹具用 `status='running'`
  行;本方案不改脚本,该套件只需保持绿。

## R8. 不做的事(边界)

- 不改 StateStore 的 `blocked` 语义、不改巡检 owner index、不改 Codex 适配器 kill 窗口行为、不改每小时清扫的节奏。
- 不新增 `workflow_run_event` 种类、不新增表;幂等靠「行是否存在」。
- 不处理 exploration §5 的 orphan-reaper identity-mismatch 循环(另开 issue)。
- FLY-2091 无法核对(Linear MCP 401),plan 只承诺「死体注册行在 TURN 移交后一个引擎 tick 内被封」,不承诺对 FLY-2091 的效果。
