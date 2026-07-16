# FLY-1066 Bridge 侧残留收割 — 调研

Issue: FLY-1066 (https://linear.app/geoforge3d/issue/FLY-1066/infra-bridge-侧残留收割-commdb-孤儿注册清理-statestorecommdb-终态同步-scope-free-清理入口)
日期: 2026-07-16
基于: exploration.md

以下事实基于本分支 head(= main `3d862dea2` 分叉点)代码审计 + 生产库只读快照(2026-07-16),供 Implement 段直接引用。

## 1. 两本账的结构事实

### 1.1 CommDB(per-project,`~/.flywheel/comm/<project>/comm.db`,better-sqlite3)

- schema:`packages/flywheel-comm/src/db.ts:27-36`。`sessions(execution_id PK, tmux_window NOT NULL, project_name NOT NULL, issue_id NULL, lead_id NULL, started_at, ended_at, status DEFAULT 'running' CHECK IN ('running','completed','timeout','blocked'), vendor)`。
- **CHECK 表达不了 failed/terminated** → CommDB 行的唯一退出方式 = DELETE(FLY-817 模块注释明文)。
- 写路径:
  - `registerSession`(db.ts:1866,INSERT OR REPLACE)——两处调用:dispatcher 预注册 `run-dispatcher.ts:869`(占位 `${tmuxSession}:pending`,在 spawn 前,`:623`/`:1207` 两个路径)+ Runner 自注册(覆盖占位为真实 window)。
  - `unregisterPendingSession`(db.ts:1903,FLY-80)——只删仍是 `%:pending` 的行;dispatcher 的 spawn-失败 catch 调它(run-dispatcher.ts:842/897)。样本②③证明 auto-QA 路径存在不走此 catch 的泄漏(GEO-441,2026-07-03)。
  - `updateSessionStatus`(db.ts:1911)——只接受 completed/timeout/blocked。
  - `finalizeSession`(db.ts:1934,FLY-1238)——**收割原语**:单事务内 retire 该 exec 所有未答 checkpoint gate(豁免 review_design/review_code)+ 清 runner_phase_wakes/runner_shutdown_controls + 删 sessions 行,返回 `{retiredQuestionCount, deletedSessionCount}`。幂等。
  - `deleteSession`(db.ts:1984,FLY-638)/`deleteSessionAndRunnerPhaseLifecycle`(db.ts:1991,FLY-1269)。
- 读模型:`getActiveSessions`(db.ts:2006,status='running')、`listSessions(project?, statuses?)`(db.ts:2021)、`getRecentTerminalSessions`(db.ts:2052,只查 completed/timeout)→ `runner_terminal_list`/Lead bootstrap。

### 1.2 StateStore(`~/.flywheel/teamlead.db`,sql.js,Bridge 单写者)

- `Session` 接口:`packages/teamlead/src/StateStore.ts:696+`。关键列:`status`、`tmux_session`(**只有 session 名,无 window id**;StateStore.ts:604/708/1312)、`started_at`、`heartbeat_at`、`chat_thread_role`、`terminal_at`(FLY-1257)。
- 枚举方法:`getActiveSessions()`(:3660)、`getRunningSessions()`(:4066)、`getSessionsByIssueAndStatuses`(:4342)。面③扫描可复用/仿写(具体选型归 implement,注意 sql.js 全库扫描成本低——行数千级)。
- FSM 合法边:`packages/core/src/workflow-fsm.ts` `WORKFLOW_TRANSITIONS`:
  - `awaiting_review → [approved_to_ship, completed, rejected, deferred, shelved, terminated]` —— **没有 failed**;
  - `approved_to_ship → [awaiting_review, completed, blocked, failed, terminated]`;
  - `running → [awaiting_review, completed, blocked, failed, terminated, design_done]`;`design_done → [completed, blocked, failed, terminated]`;`pending → [running, terminated]`。
  - ⇒ **`terminated` 是唯一从全部非终态都合法的终态** → 面③ finalize 统一目标(与 crash-reaper 先例一致)。

## 2. 既有清理机制(候选枚举 → 盲区)锚点

| 机制 | 文件 | 扫描集 | 删除条件 | 盲区(=本票) |
|---|---|---|---|---|
| FLY-638 boot prune | `bridge/commdb-session-prune.ts:116` `pruneDeadTerminalCommDbSessions` | CommDB `{completed,timeout}` | probe==="dead" → finalizeSession | 不扫 running |
| FLY-817 FSM reconcile | `bridge/commdb-fsm-reconcile.ts:88` `reconcileCommDbRunningAgainstFsm` | CommDB `{running}` | FSM∈`RECONCILE_DELETABLE_STATES`(AUTO_CLOSE ∪ approved)AND probe==="dead" | 面①:`!fsm → keptNonTerminal`(:130-135);面②:`CRASH_PRESERVE → keptPreserve`(:124-129,注释「tracked separately」) |
| FLY-720 crash-reaper | `bridge/crash-reaper.ts`(心跳 tick,Phase1 own dead-pin → Phase2 reap → `terminated`) | StateStore running + **CommDB 目标可得** | dead-pin 确认 + crash grace | 面③:no-target 明确不 own(模块头注释) |
| FLY-742 stale-blocker-guard | `bridge/stale-blocker-guard.ts`(409 路径) | awaiting_review/approved_to_ship blocker | PR merged/closed → finalize_proceed(→completed);open/unknown → alert_block | 面③ PR open/unknown 时只告警不自愈 |
| FLY-324 done-but-running / FLY-172 marker drain | plugin.ts boot | stage=completed 僵尸 / 孤儿 marker | — | 不涉及本票四面 |

- boot 接线:`bridge/plugin.ts:5547-5602` —— per-project fire-and-forget 循环,顺序 = FLY-817 reconcile(`fsmStatusOf = (id) => store.getSession(id)?.status`,:5572)→ FLY-638 prune;`onFinalizeOutcome → store.recordCommDbFinalizeOutcome`(:5550-5563);kill-switch `FLYWHEEL_COMMDB_FSM_RECONCILE`(:5549,registry 注册在 `packages/config/src/feature-flags/registry.ts:1288`)。
- `projects` 来源 = Bridge config(生产 `~/.flywheel/projects.json`:geoforge3d/joycon-typeless/personal-assistant/growth/flywheel/tidal-echo + sub)。**`~/.flywheel/comm/` 目录下另有 ~13 个非配置项目**(fire-test、qa-fly-123、test-slot-2、flywheel-qa-1259…)= QA-slot/scratch CommDB,其 StateStore 在别的库——证实 exploration §3.5「不枚举全目录」的必要性。
- 状态集:`bridge/close-runner.ts:53-65` `AUTO_CLOSE_STATES={completed,rejected,deferred,shelved,terminated}`,`CRASH_PRESERVE_STATES={failed,blocked}`;`commdb-fsm-reconcile.ts:59` `RECONCILE_DELETABLE_STATES = AUTO_CLOSE ∪ {approved}`。
- probe:`bridge/tmux-lookup.ts:296-314` `probeTmuxWindowLiveness` 三态;`isTmuxAbsenceMessage`(:248)认 `can't find pane/window/session`、`no server running` 为可证死亡;超时/ENOENT/EACCES → indeterminate。**注意**:窗口按名字目标(如 `runner-flywheel:FLY-1262-implement-…`)走 tmux fnmatch,同名新窗会让死行 probe 出 alive → keep(保守方向,无害,只延迟收割)。
- scope 对照:`bridge/actions.ts:1462` `checkLeadScope`(GEO-259)——close_runner/terminate 等 action 的 per-Lead 403;`No session found for execution_id`(actions.ts:225/510/653/1309)= store.getSession undefined。Bridge 内部 sweep 天然无此两层。

## 3. 生产取证(只读快照,2026-07-16)

### 3.1 三个验收样本(全部在场)

```
-- ~/.flywheel/comm/geoforge3d/comm.db sessions
d2f31930-abba-…|%194                        |geoforge3d|NULL(issue)|NULL(lead)|2026-05-11 06:15:35|running   ← 面①
e4d3b29d-3905-…|runner-geoforge3d:pending   |geoforge3d|9619b712-…(UUID)      |2026-07-03 05:53:47|running   ← 面②
e90f3962-0c73-…|runner-geoforge3d:pending   |geoforge3d|9619b712-…(UUID)      |2026-07-03 08:50:20|running   ← 面②
-- StateStore:d2f31930 无 row;e4d3b29d/e90f3962 status=failed
```

### 3.2 同型残留规模(横扫全部配置 project 的 running 行 × StateStore 状态)

| project | CommDB running | 判读 |
|---|---|---|
| geoforge3d | 6 | 面①×1(d2f31930)+ 面②×5(上述 2 + GEO-342 `2692122f`@156 / GEO-424 `5491a2a1`@63 / GEO-347 `da6c6c3d`@121,StateStore 均 failed) |
| flywheel | 13 | 面②×8(failed×6:63ac4e95:pending/be8e3e48/d0ed7c15/ddc9e9cb/58830870/b9e597a9;blocked×2:6c02221e:pending/6cccffaa)+ **合法行×5**(running×2、awaiting_review×1、design_done×2——后者是三段式 park 保活 holder,收割哨兵) |
| joycon-typeless | 4 | 未逐行判读(implement 段跑收割时以 dry-run 计数复核) |
| growth 2 / sub 1 / personal-assistant 0 / tidal-echo 0 | — | 同上 |

6 个已知样本 tmux 目标实测:`%194` → `can't find pane`;`runner-geoforge3d:pending` → `can't find window`;`@156/@63/@121` → `can't find window`。全部 = probe "dead"。

### 3.3 面③④ 事故实证(2026-07-15 夜,Tadashi brainstorm gate 提供)

- 面③:Asha 3 个夜跑位被 StateStore 幽灵(非终态 + CommDB row 缺失 + terminal 死)吃掉,close_runner 全线 No session found;boot sweep 从 CommDB 行出发结构上看不见它。
- 面④:`detection_escalations` 表 pending 行的 target exec 在 sessions 表 0 命中(两本账双无主),65 条告警风暴的驱动源。

### 3.4 面④ 表结构

- `StateStore.ts:2529` `CREATE TABLE detection_escalations`;状态机 `NEW → LEAD_NOTIFIED → (ACKED | ESCALATED) → RESOLVED` + CLEARING(:524-532);主键 = (target_key, kind, episode_fingerprint) 且 upsert 为 INSERT OR IGNORE(:9029-9049)→ 同 tuple 不可能建新行;方法族 :8980-9143。**复活契约(最终,随 plan M3)**:现行复活条件只认 `resolved_via === 'recovery'`(:9062-9084);本票把 `'residue_harvest'` 定为与 'recovery' 同级的 machine-proven clear,**复活 predicate 扩为两者**——更晚 firstDetectedAtMs 的同指纹事故把行复活为 NEW 并全量重置;`resolved_via='lead'` 仍不复活。置结走「按 target 批量 RESOLVED('residue_harvest')」方法(新增)。
- `targetKey` 形态:runner = execId,lead = `<project>:<leadId>`(`bridge/detection-escalation.ts:24`)——**收割只处理 execId 形态的 target**,lead 状态键不涉两本账、不碰。

## 4. 入口与节奏的接线锚点

- **boot**:`plugin.ts:5547` 既有 per-project 循环内追加(先 817 → 新收割 → 638;或合并进扩展后的 reconcile 单 pass,implement 定,注意每行只 probe 一次的去重)。
- **心跳搭车**(Codex R1 #4 修正):`HeartbeatService` 已有 **`onMaintenanceTick` seam + tick counter + detached 单飞行**(HeartbeatService.ts:467-515),生产 maintenance 注入在 plugin.ts:5204-5273——搭车 = 把 residue cadence 组合进该既有 seam,不加第二套 counter/构造器参数;N 由真实 `config.stuckCheckIntervalMs` 换算 ~1h。**注意**:分支必须独立于 `worktreeAutocleanEnabled()` 的 early return,否则 FLYWHEEL_WORKTREE_AUTOCLEAN=0 会成为未声明的 residue 关闸。(早稿曾引 plugin.ts:6249——那是 focused-frame scheduler 的 interval,与 HeartbeatService 无关,勿用。)收割体 fire-and-forget + 三入口共享单飞行,不得阻塞 tick 管线。
- **定点触发**(Codex R1 #3 修正):`bridge/runs-route.ts:169` `staleBlockerGuard.handleActiveBlocker(blocker)`(FLY-742,409 路径;`createStaleBlockerGuard` 在 plugin.ts:3255 构造、:3352 注入)。guard 现行序:`enabled`(`FLYWHEEL_CRON_STALE_GUARD`)检查 → local classify(running / fresh-parked / 缺 anchor → block_silent 直接返回)→ stale parked 才查 PR(stale-blocker-guard.ts:525-553)。⇒ 插点若放在 alert_block 前则 running ghost 与 <120min 的 fresh-parked ghost 永远到不了 → **插点必须在 guard 顶部 / runs-route 409 分支,早于 FLY-742 的 enabled 检查与 local classify**,且仅由 `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 控制(CRON_STALE_GUARD=0 不得关闭它)。ghost 判据不满足时逐字节回落 FLY-742 原路径(含其自身 flag 检查);PR-证据路径(merged/closed → finalize_proceed)不动。
- **kill-switch**:新 flag `FLYWHEEL_COMMDB_RESIDUE_HARVEST`(default on,`=0` 关四面全部新行为,含定点插点),注册 `packages/config/src/feature-flags/registry.ts`(FLY-1050 注册先例:PR #528 head commit)。

## 5. 面③ finalize 的复用路径

- 转移原语(Codex R1 #1/R2 #4 修正):`applyTransition`(crash-reaper.ts:33-36 同款 import)**只做** FSM 校验 + StateStore 持久化 + audit directive + `onTransition`(生产 hook 仅 display refresh enqueue,applyTransition.ts:42-82 / plugin.ts:3749-3760)——**不是完整 teardown,不自动带 archive/QA-loss/session event**。TransitionContext 真实字段 = { executionId, issueId, projectName, trigger }(无 actor/reason 字段)。**失败(FSM 拒绝/竞态)即 keep + console warn,绝不 forceStatus**(FLY-1185 §2.12 先例:pending→terminated 边已为「never-started 收尸」而加)。
- 侧效必须显式做,对齐 crash-reaper 的真实序列(crash-reaper.ts:316-389):`finalizeCommDbSession` **先行**(fail-closed;本形态 sessions 行不存在、幂等,但还清 runner_phase_wakes/shutdown_controls)→ applyTransition → 显式 qa-loss hook(仅 qa 行,plugin.ts 闭包注入)+ terminated archive = `archiveIssueThreadIfNoOtherActive(..., { allowStatuses: ["terminated"] })`(生产接线 plugin.ts:5064-5074;**maybeArchiveThreadOnClose 只允许 completed、排除 terminated,勿用**)+ session event。**无 tmux teardown 步骤**(无目标可拆)。
- 三段式行注意:`applyTransition` **不带** qa-loss——M2 在 transition 成功后**必须显式调用**注入的 `onQaPhaseTerminated` 同型 hook(仅 chat_thread_role==='qa' 的行;crash-reaper 同款闭包注入)。是否 respawn 由 FLY-1050 现有守卫链自行决定(F8a-F8d 已证防御正确),收割器不新增判据。

## 6. 竞态与安全边界(判据推演)

(R2/R3 已按 Codex design R1 #6 的实核顺序改写:fresh 与 retry 两条 dispatch 路径都在 Blueprint 启动及 StateStore 事件**之前**先执行 `preRegisterCommDb`——run-dispatcher.ts:618-630 / :1203-1214。)

| # | 场景 | 判据表现 | 结论 |
|---|---|---|---|
| R1 | mid-dispatch 面③方向:StateStore row 在、CommDB row 缺(preRegisterCommDb 是 best-effort、失败被吞;Runner 自注册有延迟) | 面③证据可同时短暂为真 | 行龄>30min 护栏(窗口秒~分钟计;heartbeat_at 新鲜可作加强证据但不依赖) |
| R2 | mid-dispatch 面①方向:**CommDB 预注册先于 StateStore 行落库**——「CommDB running(`:pending`)+ StateStore 无 row + probe dead」是每次 spawn 的**正常瞬态** | 面①三证据在 spawn 途中同时为真 | **24h 行龄是实际安全边界(非纵深备份)**;时间戳缺失/非法/未来 → fail-closed keep |
| R3 | 面①孤儿的真实来源 | 历史重置(FLY-663 类 StateStore 重建)/外部写入/超过 24h 仍未被 StateStore 认领的注册 | 与 R2 的瞬态以 24h 龄区分 |
| R4 | tmux server 整体 down | 一切 probe = `no server running` → dead? **注意**:isTmuxAbsenceMessage 把 `no server running` 算「可证死亡」——server down 时全部窗口确实不存在(tmux 无持久化),FLY-638/817 已按此语义运行;面③ session 级 probe 同语义 | 与既有 sweep 语义一致,不新增风险面 |
| R5 | 同名新窗(retry 复用 issue 名) | probe alive → keep | 保守无害,延迟收割 |
| R6 | 心跳搭车轮与 boot 轮并发 | 单飞行守卫 + finalizeSession/applyTransition 幂等 | 双跑无害 |
| R7 | awaiting_review + terminal 活 | probe=alive → keep(结构性) | 硬约束原文进 plan 验收 |
| R8 | design_done park 保活(生产实存 ×2) | CommDB row 在 + StateStore 非 CRASH_PRESERVE → 面①②不触;面③要求 CommDB row 缺失 → 不触 | 哨兵测试固化 |

## 7. 测试地形

- 既有可抄模式:`bridge/__tests__/commdb-fsm-reconcile.test.ts`(injectable dbPath/probe/finalizeSession;若无此文件则以 commdb-session-prune 测试为模)、`phase-orchestrator.fly1050-qa-respawn.test.ts` makeHarness、FLY-1070 `qa-f8-harness.mjs`(真 CommDB registerSession 构造面①形态的先例,engineering/doc/FLY-1070-qa-respawn-verify/evidence/)。
- 反向哨兵:FLY-205/FLY-529 的 reverse-compat sentinel 形态——flag=0 时新分支零调用、既有 keptNonTerminal/keptPreserve 计数逐字节不变。
- **负向断言必须突变验证**(MEMORY 红线:vacuous green)——「不收割 design_done/alive 行」的测试要配一个把守卫拆掉后测试转红的突变对照。
- 真机验收:部署重启后查生产 comm.db(样本③个 + 附带 ~11 条);dry-run 计数先行(implement 段先跑 log-only 一轮再放开删除,或直接以 flag 分级——implement 定)。

## 8. 环境事实

- 生产 Bridge 多项目单机;Bridge 重启频繁(近日每天多次)→ boot sweep 的实际收割延迟以小时计。
- comm.db = better-sqlite3(同步),teamlead.db = sql.js(内存+export);收割全在 Bridge 进程内,无跨进程写者问题(CommDB 的其它写者 = runner CLI,行级 INSERT/UPDATE,better-sqlite3 WAL 容忍)。
- 快照留存:`<scratchpad>/geoforge3d-comm.db` 等 7 份,QA/验收对照基线。

## 9. ①根因层审计(scope 重开后新增;②层事实见 §1-§8,原样成立)

### 9.1 FSM 转移咽喉与 hook 先例

- `applyTransition`(`packages/teamlead/src/applyTransition.ts:1-60`)自注释:「Unified entry point for
  ALL status changes」——**但该声称对 failed/blocked 不完整**(Codex design R1 #1 证伪):
  `DirectEventSink` 明文说明它**故意**用 `upsertSession` 直写、不经 applyTransition
  (DirectEventSink.ts:102-108;run-infra.ts:554-556 再次自述为生产设计)——in-process completion 的
  `route==="blocked"` 在 DirectEventSink.ts:647,758-785 直写 blocked;`emitFailed`(:1036-1088)直写
  failed/blocked。另有 `complete-marker-reconciler.ts:731-758` 的 forceStatus fallback。
  ⇒ **①层的生产写入面 = 五个确定点**:共享 onTransition、stale-guard onTransition、DES blocked
  completion、DES emitFailed、marker forceStatus fallback(plan A2 inventory)。
- **FLY-907 hook 先例**:`ApplyTransitionOpts.onTransition`(:14-34)——composition root(plugin.ts)在
  两个 ApplyTransitionOpts 实例上注入;hook 契约 = **只做微秒级 enqueue**、try/catch、永不破坏
  transition(:19-27,71-80)。注意 `CommDB` 构造器是重量级(mkdir/WAL/全量 SCHEMA/migrations/
  purgeExpired/busy_timeout 5000,db.ts:224-237)——**不得在 hook 内开库**,必须 enqueue+drain 分离
  (Codex R1 #2)。
- **经 applyTransition 的 failed/blocked 产生方**(grep 实核):HeartbeatService(reapOrphans
  force-fail、FLY-1282 zombie declaration)、event-route、DecisionLayer 路由、run-infra /
  run-dispatcher(spawn 失败)、auto-qa-effects。
- **其余 forceStatus 调用点**(StateStore.ts:3505-3530 legacy 直写):多数注明生产总会传
  transitionOpts;implement 逐点写死「生产不可达 failed/blocked」证明 + 守卫测试 pin,证明不成立的
  并入五面 inventory(Codex R1 #1)。

### 9.2 CommDB 侧原语现状(①层直接复用)

- `updateSessionStatus(execId, 'completed'|'timeout'|'blocked')`(db.ts:1911)——带 ended_at 的 UPDATE。
  ①层**不扩它**,而是:新 `markSessionTerminalStatus`(权威 mark,first-terminal ended_at)+ adapter
  尾写调用点改 CAS(见下)+ CHECK 加 `'failed'`(FLY-1279 整表重建迁移模式,db.ts:370-405 逐字可仿)。
- adapter 受控退出已写 CommDB:TmuxAdapter.ts:703(waitForCompletion finally → completed/timeout)、
  CodexTmuxAdapter.ts:821/898(controlled shutdown → completed/timeout)。⇒ S4(completed 家族)在
  adapter 在场的死法下已有实时同步;①层不重复。
- `unregisterPendingSession`(db.ts:1903)——只删 `%:pending` 行;调用点仅 run-dispatcher.ts:842/897/923
  (abortPreLaunch/cleanupPreRegistration,FLY-80)。GEO-441 形态(auto-QA spawn 失败)未走到 → S3。
- CommDB status 读方矩阵(新值 'failed' 兼容性,Codex R1 #4 修正后):`lifecycle.ts:20`
  classifyRunnerRow 能分类任意终态,**但 marked 行到不了它**——`runner_terminal_list` 的终态候选取自
  `getRecentTerminalSessions`/`countTerminalSessions`,两者硬编码 `('completed','timeout')`
  (db.ts:2052-2065,2073-2082;terminal-mcp/index.ts:182-198)⇒ A1 必须同步扩这两条 SQL,否则 mark
  对 Lead 视图不可见。`cleanup.ts:67`(显式 ['completed','timeout'],**刻意不扩**——它 kill 窗口,与
  preserve 政策冲突)、FLY-638/817 显式状态列表、`types.ts:67` union(编译期扩)、wake/send 路径
  (按 execId 取 row,不 switch status)。
- **updateSessionStatus 是无条件 last-writer-wins**(db.ts:1911-1919,且每次重写 ended_at)——
  adapter 尾写(TmuxAdapter finally / CodexTmuxAdapter controlled shutdown)可覆盖 mark;
  `registerSession` 是 INSERT OR REPLACE(db.ts:1875-1887),晚自注册可覆盖终态 mark。
  ⇒ plan A1 定义写入优先级(adapter 尾写 CAS status='running';mark = first-terminal-write ended_at;
  late-register 审计),Codex R1 #3。

### 9.3 exit-path × 残留物 owner 矩阵(①层的完整视野)

| exit path | CommDB row | app-server/MCP 子进程 | worktree/分支 |
|---|---|---|---|
| Lead close/terminate(B) | ✅ closeRunner→finalizeCommDbSession(close-runner.ts:373;actions.ts:1402) | ✅ closeRunner MCP-descendant reap(FLY-228) | ✅ lifecycle-closeout(FLY-1185) |
| ship-terminal(A) | ✅ post-ship-finalization → closeout | ✅ 同上 | ✅ Layer A ship closeout(FLY-1185 §2.4) |
| crash reap(C,FLY-720) | ✅ crash-reaper.ts:319 finalize | ✅ teardown 序列 | ➖ periodic sweep(E)兜 |
| issue-terminal reconcile(D)/periodic sweep(E) | ✅ lifecycle-closeout.ts:243 | ✅ | ✅ |
| adapter 受控退出 | ✅ §9.2 completed/timeout | ✅ adapter 自身 teardown | ➖ 不归 adapter |
| **FSM → failed/blocked(S1/S2/S3)** | ❌ **无 owner(①层 L-A 的靶子)** | CRASH_PRESERVE 政策性保留窗口(非泄漏);codex resident 场景由 FLY-1269 协作关停 | 保留(retry 可能复用;closeout 时清) |
| SIGKILL/OOM/Bridge crash(S6) | ②收割 | crash-reaper + FLY-1269 provably-absent backstop | FLY-1185 periodic sweep |
| StateStore 重建(S7) | ②面① | n/a(进程早死) | FLY-1185 periodic sweep |

已知独立 open item(不并入本票,plan 引为边界):FLY-603 worktree autoclean 曾未触发的调查
(team task #108);FLY-1148 infra-bot 进程泄漏(已另票)。

### 9.4 ①层 kill-switch 与 byte-compat

- 新 flag(plan 定名,倾向 `FLYWHEEL_TERMINAL_COMMDB_SYNC`,default on)控制 L-A hook;=0 时
  onTransition 只保留 FLY-907 原行为,逐字节一致(反向哨兵)。与②的
  `FLYWHEEL_COMMDB_RESIDUE_HARVEST` 相互独立(矩阵测试)。
- CHECK 迁移是 schema 层、不可 flag 化——但迁移本身零行为变化(只放宽约束),旧值全兼容;
  迁移幂等判据 = schema sql 含 `'failed'`(FLY-1279 同款)。

## 10. 下游

双层实施计划(Part A = ①层 L-A/L-B/L-C;Part B = ②层 as-built 引用 + FLY-638 prune 扩展增量;
TDD 顺序、验收清单、FLY-817 BLOCKER-1 修订立节)→ 同文件夹 `plan.md`
