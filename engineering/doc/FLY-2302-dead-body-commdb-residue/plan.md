# FLY-2302 死体回滚后 CommDB 注册行残留 — 实施计划

Issue: FLY-2302 (https://linear.app/geoforge3d/issue/FLY-2302/病根-死体被引擎回滚换体后-sessionsstatusblocked-永不终结巡检名册每-tick-假报-missing-pane且是)
日期: 2026-09-03
基于: research.md

## 0. 目标与不变量

**目标**:引擎把死体回滚换体后,死体在 CommDB 的 `sessions` 注册行应在 TURN 移交完成后、该 watch 行
**下一次被 tripwire 巡到时**被封账(DELETE),而不是等最长 1 小时的残留清扫。资格与否决逻辑与每小时清扫
**共用同一个函数**;定点路径在此之上**多一道**「目标未变」CAS。

**不变量**(实现与评审都按这几条核):
1. 删行的资格/否决逻辑 = 现有 `pruneDeadTerminalCommDbSessions` 循环体的逻辑,抽成一个函数后两条路径共用:
   项目匹配 ∧ 终态 status(含 failed/blocked)∧ `probeTmuxWindowLiveness(tmux_window) === "dead"` ∧
   非 parked 声明(查询抛错按 parked)∧ 非 TURN 持有者(事务内再核)。
   **定点路径额外**用 `finalizePaneLossResidue` 做「tmux_window 未变」CAS;**清扫路径保持** `finalizeSessionUnlessTurnHolder`
   不变(现有清扫没有目标 CAS,本计划不给它加)。
2. 不写 StateStore `sessions`;不改 `blocked` 在任何词表里的归属;不改巡检脚本与 owner index。
3. 不新增表、不新增 `workflow_run_event` 种类;幂等只靠「CommDB 行是否存在」。
4. FLY-1385 tripwire 的四类证据一类不少(research R2);本改动只改变删除时刻。
5. 每小时清扫、boot 清扫、`closeRunner`、`crash-reaper` 的行为与测试期望不变。
6. 定点封账是 best-effort:任何异常都在 tripwire 循环内被吞掉并记日志,**绝不**让 `reconcile()` 拒绝,
   绝不阻塞后续引擎阶段;每小时清扫仍是兜底。
7. **方向守卫**(Lead 2026-09-03 裁定):本单的目的是让死体的注册行**拿到终结**,不是给巡检加豁免或白名单。
   任何「让巡检别报它」形状的改动(排除 blocked、按 vendor 过滤、按 ended_at 过滤)一律不做 —— 那是把假阳性换成盲区。

## 1. 改动清单(3 个文件 + 测试)

### 1.1 `packages/teamlead/src/bridge/commdb-session-prune.ts` —— 抽单行函数

新增导出:

```ts
export type DeadTerminalFinalizeOutcome =
  | "finalized" | "no_row" | "kept_project_mismatch" | "kept_status" | "kept_turn_holder"
  | "kept_alive" | "kept_indeterminate" | "kept_parked" | "kept_target_changed" | "failed"
  | "not_wired";   // 仅由 dispatcher 的显式缺省 no-op 返回(§1.2),prune 与 by-id 路径永不返回它

export interface FinalizeDeadTerminalOpts {
  includeCrashPreserve?: boolean;               // 与 prune 同义
  probe?: (tmuxWindow: string) => Promise<TmuxWindowProbe>;
  onFinalizeOutcome?: (executionId: string, projectName: string, result: FinalizeCommDbResult) => void;
}

/** 单行版:对一条已打开的 CommDB 里的 session 行执行与 prune 相同的资格/否决逻辑与删除。
 *  finalizeMode 决定删除原语:"sweep" = finalizeSessionUnlessTurnHolder(清扫沿用),
 *  "point" = finalizePaneLossResidue(exec, session.tmux_window)(定点路径,多一道目标 CAS)。 */
export async function finalizeDeadTerminalCommDbSession(
  db: CommDB, projectName: string, session: Session,
  turnHolders: ReadonlySet<string>,
  opts: FinalizeDeadTerminalOpts & { finalizeMode: "sweep" | "point" },
): Promise<{ outcome: DeadTerminalFinalizeOutcome; result?: FinalizeCommDbResult }>;

/** 按 execution_id 的入口(定点路径):自己开库、getSession(executionId)、取 turn holders,再调单行版(point 模式)。 */
export async function finalizeDeadTerminalCommDbSessionById(
  projectName: string, executionId: string,
  opts: FinalizeDeadTerminalOpts & { dbPath?: string },
): Promise<DeadTerminalFinalizeOutcome>;
```

- `pruneDeadTerminalCommDbSessions` 的 `for (const s of terminal)` 循环体**整体替换**为调用
  `finalizeDeadTerminalCommDbSession(db, projectName, s, turnHolders, { ...opts, finalizeMode: "sweep" })`,
  并把 outcome 折回原计数器:`finalized → pruned++ & provenDeadTargets.push`;
  `kept_turn_holder / kept_parked → parkedVetoed++`;`kept_alive / kept_indeterminate → kept++`;`failed → failed++`。
  日志文案保持现有三条不变(`prune_skipped_turn_holder` / `prune_skipped_parked_conflict` /
  `prune_skipped_turn_holder_at_finalize`,测试断言引用它们)。`failed` 分支保持现有 `onFinalizeOutcome(ok:false)` 审计。
- 按 id 路径与清扫路径的差异,**只有**下面三条,其余逻辑同一份代码:
  1. 行来源是 `db.getSession(executionId)`(SQL 无 project 谓词,`db.ts:6843`),所以**先核**
     `session.project_name === projectName`,不等 ⇒ `kept_project_mismatch`,**不探针、不删**。
  2. 不经过 `listSessions(statuses)` 过滤,所以显式核 status ∈ `completed|timeout` ∪
     (`includeCrashPreserve ? failed|blocked : ∅`),否则 `kept_status`,**不探针**。
  3. 删除原语是 `finalizePaneLossResidue(exec, session.tmux_window)`;其 `target_changed` ⇒ `kept_target_changed`,
     `turn_holder` ⇒ `kept_turn_holder`。
- `resolveCommDbPath(projectName)` 返回 undefined(项目名不安全或库文件不存在)⇒ `no_row`。
- DB 层异常(open/probe 之外的 finalize 抛错)⇒ `failed`,并调 `onFinalizeOutcome(ok:false, error)`;函数本身**不抛**。

### 1.2 `packages/teamlead/src/bridge/workflow-engine-dispatcher.ts` —— 挂载点

- 新增可选依赖(对象入参,便于审计带 issueId):

```ts
finalizeDeadExecutionCommDb?: (input: {
  projectName: string; executionId: string; issueId: string;
}) => Promise<DeadTerminalFinalizeOutcome>;
```

  **缺省值是显式的、可断言的 no-op**(Lead 裁定,不靠「恰好没人调用」):模块导出
  `NOT_WIRED_DEAD_EXECUTION_COMMDB_FINALIZER = async () => "not_wired" as const`,`DeadTerminalFinalizeOutcome`
  增加 `"not_wired"`;dispatcher 收到 `not_wired` 时**只在进程内第一次**记一条日志
  `dead-exec commdb finalizer not wired; registrations converge via hourly prune`,不进 Set、不再重复记。
  单元测试默认 hermetic;生产由 `plugin.ts` 显式接线,见 1.3。
- 新增进程内 `deadExecutionCommDbSettled = new Set<string>()`(与 `unknownLivenessCounts` 同款,不落库)。
  `reconcileDeadExecutionTripwires` 里 `pruneWorkflowDeadExecutionWatches` 返回 `pruned > 0` 时 **`clear()`** 整个 Set
  (重新查一次 `no_row` 的代价可忽略)。上界 = watch 表里**尚未被 prune 的行数**(active + 已 tripped 但未过 TTL 的),
  由 watch 表自己的 24h TTL 修剪生命周期约束,不是进程生命周期。
- 在 `for (const watch of watches)` 里,`evidence === null`(无活动迹象)的分支**之后、`continue` 之前**:

```ts
if (!this.deadExecutionCommDbSettled.has(watch.dead_execution_id)) {
  try {
    const outcome = await this.finalizeDeadExecutionCommDb({
      projectName: watch.project_name,
      executionId: watch.dead_execution_id,
      issueId: watch.issue_id,
    });
    if (outcome === "not_wired") {
      this.logNotWiredOnce();   // 进程内仅一次
    } else if (outcome === "finalized" || outcome === "no_row") {
      this.deadExecutionCommDbSettled.add(watch.dead_execution_id);
      if (outcome === "finalized") {
        this.log(`dead-exec commdb registration finalized for ${watch.dead_execution_id}`);
      }
    } else if (outcome === "failed") {
      this.log(`dead-exec commdb finalize held for ${watch.dead_execution_id}: failed`);
    }
    // kept_* :该 watch 下次被巡到时再试;不记日志(每秒一条会刷屏)
  } catch (error) {
    // 不变量 6:绝不让 reconcile() 拒绝。不进 Set,下次再试。
    this.log(
      `dead-exec commdb finalize held for ${watch.dead_execution_id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- 有活动证据(`evidence !== null`,含 `tmux_output`)的分支**不**封账:那是「可能没死」的信号,交给 tripwire。
- 时延口径:watch 表按 200 行/页 cursor 轮转(`StateStore.ts:40509-40524`),所以承诺是「该 watch **下一次被巡到**」;
  无积压时即下一 tick(1 s)。每个未 settle 的行每次巡到的代价 = 一次可写 CommDB open + 一次 `list-panes`
  (不能复用活动探针的只读句柄,后者自开自关,`dead-exec-activity.ts:48-64`)。

### 1.3 `packages/teamlead/src/bridge/plugin.ts` —— 生产接线(显式)

在 `new WorkflowEngineDispatcher({...})`(`:6599`)增加:

```ts
finalizeDeadExecutionCommDb: ({ projectName, executionId, issueId }) =>
  finalizeDeadTerminalCommDbSessionById(projectName, executionId, {
    includeCrashPreserve: true,
    onFinalizeOutcome: (execId, project, outcome) =>
      store.recordCommDbFinalizeOutcome({
        executionId: execId, issueId, projectName: project,
        ok: outcome.ok, error: outcome.error,
        audit: {
          retiredGateCount: outcome.retiredGateCount,
          retiredAskCount: outcome.retiredAskCount,
          source: "bridge.workflow-engine.dead-rollback",
        },
      }),
  }),
```

与 `:5966-5989` 的 `recordResidueFinalizeOutcome` 同形(仅 source 不同);`includeCrashPreserve: true` 与每小时清扫一致。

### 1.4 不改的文件(明示)

`scripts/lead-patrol-snapshot.sh`、`packages/teamlead/lead-rules-base/runner-patrol-rules.md`、
`packages/claude-runner/src/CodexTmuxAdapter.ts`、`packages/teamlead/src/StateStore.ts`、
`packages/flywheel-comm/src/db.ts`、`residue-harvest.ts`、`commdb-fsm-reconcile.ts`。

## 2. 测试(先写测试,RED → GREEN)

### 2.1 `packages/teamlead/src/__tests__/commdb-session-prune.test.ts`(扩)

- **行为不变证明**:现有 describe 全部原样通过(抽函数不许改任何断言)。
- 新 describe `finalizeDeadTerminalCommDbSessionById (FLY-2302)`(注入 `probe`,真 CommDB 临时目录):
  1. blocked + probe=dead + 无 TURN + 无 parked ⇒ `finalized`;行删除;`onFinalizeOutcome` 收到 ok=true。
  2. blocked + probe=**alive**(Claude 体保留 pane)⇒ `kept_alive`;行仍在。**阳性对照**。
  3. blocked + probe=dead + 该 exec 是 `three_stage_turn.holder_exec_id` ⇒ `kept_turn_holder`;行仍在。
  4. probe=indeterminate ⇒ `kept_indeterminate`;行仍在。
  5. 行不存在 ⇒ `no_row`,**不调 probe**(`vi.fn` 断言零调用)。
  6. status=`running` ⇒ `kept_status`,**不调 probe**。
  7. 行属于另一个 project(`registerSession` 到 `other-project`,但按 `flywheel` 查)⇒ `kept_project_mismatch`,
     **不调 probe**,行仍在。
  8. probe=dead + 有未过期 parked 声明 ⇒ `kept_parked`,行仍在;以及 declared-state 查询抛错(spy 让
     `getEffectiveDeclaredState` throw)⇒ 同样 `kept_parked`(fail-closed)。
  9. 探针期间 `tmux_window` 被改写(probe 回调里 `registerSession` 到新窗)⇒ `kept_target_changed`,行仍在。
  10. `includeCrashPreserve: false` + blocked ⇒ `kept_status`(与 prune 的开关语义一致)。
  11. 强制 DB 层失败(spy `finalizePaneLossResidue` throw)⇒ `failed`;`onFinalizeOutcome` 收到 ok=false + error;
      函数不抛;行仍在。

### 2.2 `commdb-session-prune.fly1329-parked-veto.test.ts` / `commdb-residue-layer-interaction.test.ts`

- 原样通过。它们是「清扫路径仍走 `finalizeSessionUnlessTurnHolder`、veto 顺序未变、provenDeadTargets 仍向
  ghost 扫描传递」的直接证据。

### 2.3 `packages/teamlead/src/__tests__/workflow-engine-dispatcher.test.ts`(扩)

复用死体替换与 tripwire 的现有骨架:`replaces a started execution whose terminal session and liveness prove it dead`
(`:3249`)与 `keeps a durable tripwire and loudly reports activity from a replaced execution after restart`(`:3702`);
注入 `probeDeadExecutionActivity` 与 `finalizeDeadExecutionCommDb`(`vi.fn`):
1. 回滚成功后下一次 `reconcile()`:`probeDeadExecutionActivity` 返回 `null`,`finalizeDeadExecutionCommDb` 被以
   `{projectName, executionId: 死体, issueId}` 调用**恰一次**;返回 `finalized` 后再 `reconcile()` 两次断言**不再调用**(Set 生效)。
2. 返回 `kept_turn_holder` ⇒ 下一次 `reconcile()` **再调一次**(重试);之后返回 `finalized` ⇒ 停。
3. `probeDeadExecutionActivity` 返回 `{kind:"commdb_write"}`(有活动)⇒ `finalizeDeadExecutionCommDb` **零调用**,
   且 watch 被 trip(现有断言)。
4. 返回 `no_row` ⇒ 进 Set,不再调用。
5. `finalizeDeadExecutionCommDb` 注入为**必然 reject** 的函数 ⇒ `reconcile()` 仍 resolve 为正常结果、后续阶段照跑
   (断言同 tick 的 `reconcileDeadExecutions` 仍处理了另一条待回滚节点),日志含 `finalize held`;
   **并且**再 `reconcile()` 一次,断言该函数**以同一个 executionId 再次被调用**(只证不抛不够,要证会重试同一条 —— Lead 要求)。
6. **不注入**时的显式 no-op:构造 dispatcher 时不传该依赖,种一条 active watch + 真 CommDB 临时库里的 blocked 行,
   `reconcile()` 两次 ⇒ 断言 CommDB 行仍在、Set 为空、日志**恰有一条** `finalizer not wired`
   (正向证明「没接线时确实什么都不做」,而不是靠现有 200-watch 轮转测试的沉默)。
7. `pruneWorkflowDeadExecutionWatches` 返回 `pruned > 0` 后,已 settle 的 exec 会被重新查一次(Set 已 clear)。

### 2.4 集成:新文件 `packages/teamlead/src/bridge/__tests__/workflow-engine.fly2302-dead-body-commdb.test.ts`

真 `StateStore`(内存)+ 真 `CommDB`(临时 `FLYWHEEL_COMM_DIR`)+ 注入 `probe` + `plugin.ts` 同形的真闭包:
- 种一个 generalized run,implement 节点 running,session 走 `recordEnrolledTerminalSignal(goal_blocked)`
  ⇒ StateStore blocked + terminal_at;CommDB `registerSession` 到 `runner-flywheel:@1`,`markSessionTerminalStatus(blocked)`;
  CommDB `three_stage_turn` 种死体为 holder;`probeLaunchLiveness → "dead"`;注入的 `probe`(tmux)用 `vi.fn` 包一层以便计数。
  **另种一条**死体发出的、无 checkpoint、无回复、`created_at` 早于 15 分钟宽限(`ASK_CASCADE_GRACE_SQL`)的 ask
  —— 没有它,`finalizeSession` 的 `retiredAskCount = 0`,`recordCommDbFinalizeOutcome` **不会**写任何事件
  (`StateStore.ts:17592-17612`),「持久化审计」就无从断言。
- **tick 1** `reconcile()`:断言 `execution_dead_rolled_back` 事件存在、watch 行存在、CommDB 行仍在。
  注意这一 tick **到不了**定点封账:tripwire 阶段先于 dead-exec 阶段跑(`workflow-engine-dispatcher.ts:298-307`),
  watch 行是同 tick 稍后的回滚事务才插入的,所以 tick 1 的保留不是 TURN 否决的证据。
- **tick 2** `reconcile()`(死体**仍持 TURN**):断言 tmux `probe` 被调用(定点路径真的走到了)、CommDB 行**仍在**、
  Set 不含死体 —— 这才是 `kept_turn_holder` 跨层生效的证据。
- 把 TURN 授给替换体(upsert holder),**tick 3** `reconcile()`:断言 CommDB 行**已删**;StateStore 有一条
  `event_type = commdb_ask_disposed`、`source = bridge.workflow-engine.dead-rollback`、payload `retiredAskCount ≥ 1` 的事件
  (这是**持久化**审计);同时 `onFinalizeOutcome` spy 收到 ok=true;StateStore 行仍是 `blocked` 且 `terminal_at` 未变;
  watch 行仍 `active`。
- 阳性对照:同样流程但 `probe → "alive"` ⇒ tick 3 之后行不删、无 `commdb_ask_disposed` 事件。
- 收尾兼容(只断言 `closeRunner` 合同):对已封账的死体调 `closeRunner`(与 lifecycle-closeout 同参)⇒
  `alreadyGone: true, commDbFinalized: true`(`close-runner.ts:626-675` 的「CommDB 无目标」分支),不抛。
  lifecycle-closeout 把它映射为 `teardown.detail = "already_gone"` 是现有代码(`lifecycle-closeout.ts:1413-1419`),本计划不另写测试。

### 2.5 shell 套件

`bash scripts/__tests__/lead-patrol-snapshot.test.sh` 原样绿(不改脚本,只证明没碰它)。该套件要求
`packages/teamlead/dist/StateStore.js` 与 `packages/flywheel-comm/dist/lib.js` 存在(`:36-40`),所以**先 build**。

### 2.6 运行命令(实现方交付前逐条跑,PR test plan 贴输出)

```bash
pnpm -r build
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/commdb-session-prune.test.ts \
  src/bridge/__tests__/commdb-session-prune.fly1329-parked-veto.test.ts \
  src/bridge/__tests__/commdb-fsm-reconcile.fly1329-parked-veto.test.ts \
  src/bridge/__tests__/commdb-residue-layer-interaction.test.ts \
  src/__tests__/workflow-engine-dispatcher.test.ts \
  src/__tests__/StateStore.fly1385-dead-exec.test.ts \
  src/bridge/__tests__/workflow-engine.fly2302-dead-body-commdb.test.ts
bash scripts/__tests__/lead-patrol-snapshot.test.sh
pnpm --filter flywheel-teamlead test        # 全量
pnpm biome check packages/teamlead/src/bridge/commdb-session-prune.ts \
  packages/teamlead/src/bridge/workflow-engine-dispatcher.ts packages/teamlead/src/bridge/plugin.ts
```

## 3. 验收(QA 节点按此核)

| # | 断言 | 证据 |
|---|---|---|
| A1 | 在隔离 Bridge(`FLYWHEEL_STATE_DIR` / `FLYWHEEL_COMM_DIR` 全部指向临时目录,单一 watch 无积压)里复现:Codex 体 blocked 后 kill 窗口 → 回滚换体 → TURN 移交 → **≤ 2 s** 内 CommDB 行消失 | 隔离 comm.db 前后 `SELECT` + Bridge 日志 `dead-exec commdb registration finalized` |
| A2 | 同环境 Claude 体 blocked、窗口保留 ⇒ 行**不**消失,巡检快照 `ROSTER_EVIDENCE … live_panes=1 findings=none` | 同上 + `lead-patrol-snapshot.sh` 输出 |
| A3 | A1 之后 StateStore 行 `status=blocked`,`terminal_at` 与回滚前一致 | `teamlead.db` 只读查询 |
| A4 | A1 之后 watch 行仍 `active`,tripwire 仍每 tick 探 baseline 目标(注入活动后能 trip) | 单测 2.3-3 + 集成 2.4 |
| A5 | 对 A1 的死体调 `closeRunner`(lifecycle-closeout 同参)⇒ 返回 `alreadyGone: true` 且 `commDbFinalized: true`,不抛(只核 closeRunner 合同,不核 closeout 的 `already_gone` 映射) | 集成 2.4 末条 |
| A6 | §2.6 全部命令绿,并在 PR 的 exact head 上 CI 绿 | CI 链接 |

**不承诺**:FLY-2091 症状的消失(未核对);orphan-reaper identity mismatch 循环(另开 issue)。

## 4. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| 探针 `dead` 假阳性(stale mapping,FLY-1319 形状)删掉活体的行 | 与清扫共用 parked veto + TURN veto;定点路径**额外**目标未变 CAS | revert dispatcher 挂载 + plugin 接线(commit 2),抽函数可保留 |
| 每次巡到对多个未 settle 死体探针造成 tmux 压力 | 每个死体最多探到行删除/no_row 为止;有活动证据的体不探;每小时清扫仍在 | 同上 |
| 抽函数改变清扫路径行为 | 三组现有 veto 测试 + provenDeadTargets 传递测试原样通过为门槛 | revert commit 1 |
| 定点封账抛错拖垮引擎 tick | 不变量 6:循环内 try/catch,reconcile 不拒绝;单测 2.3-5 | 同 commit 2 |
| 死体 CommDB 行被删后 issue 收尾找不到 teardown 目标 | StateStore 行仍在 ⇒ closeout 走 `closeRunner`,其「CommDB 无目标」分支视为 already gone 并幂等封通信(`close-runner.ts:626-675`),closeout 记 `already_gone`(`lifecycle-closeout.ts:1413-1419`) | 无需 |

回退边界:两个 commit —— (1) 抽函数 + 单测(行为不变);(2) 引擎挂载 + plugin 接线 + 单测/集成。出问题 revert (2) 即恢复现状。

## 5. 里程碑

ship 时新建 `engineering/doc/milestones/FLY-2302.md`(一 issue 一文件,按 README 合同),不动 CLAUDE.md 表格。
