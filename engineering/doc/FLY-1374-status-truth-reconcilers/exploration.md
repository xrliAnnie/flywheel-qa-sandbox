# FLY-1374 状态真相双对账器 — 探索

Issue: FLY-1374 (https://linear.app/geoforge3d/issue/FLY-1374/状态真相-discord-显示与-session-现实对齐-双对账器进程db-dbdiscord-幂等重渲染)
日期: 2026-07-23
基于: 无

---

## 0. 一句话理解

Annie 不敢信 Discord 上的状态,因为 **sessions 表本身就不等于进程现实**(主因,七成),而显示层只是忠实渲染了这份错误的真相;修法 = 与 FLY-1373 同一哲学 —— 一次性事件不可信,用**循环对账**核对真相:对账器 1(进程现实 → sessions 表)+ 对账器 2(sessions 表 → Discord 显示)。

## 1. 审计对 issue 假设的重要修正(先说结论)

> 本节遵循「审计推翻 issue 假设」纪律(FLY-208 / FLY-217 先例):issue 写于 2026-07-19,基于 07-18 深夜深诊;代码审计发现其中「次因」的描述已部分过时。

| Issue 的说法 | 审计结论(2026-07-23,分支 HEAD `0ff4fbf4`) |
|---|---|
| 「显示层 fire-and-forget,ChatThreadCreator『下一个 stage_changed 会补上』,parked/死掉的永远没有下一个 → 永久停格」 | **部分过时**。FLY-907(#479,**2026-07-06 已 merge,深诊时就在生产**)建了统一 `IssueDisplayRefresher`:从真实状态派生三个 founder 可见面(A 标题 badge / B pinned pipeline header / C 三段式状态行),触发面覆盖 park/wake/kill/reset/finalize(不只 stage_changed),并带双层 `runSweep()` reconcile 兜底,默认**每 60 个 GatePoller tick(~3 分钟)**搭车跑一次(`plugin.ts:8115-8126`,零新 timer)。`ChatThreadCreator.ts:687` 的「The next stage_changed reconciles a dropped write」注释仍在,但同函数注释已声明「The issue-display sweep owns the later retry」(`ChatThreadCreator.ts:684-687`) |
| 「把 StateStore 里已有的半截 `display_reconciled_at` 列建完」 | **已建完**。`chat_threads.display_fingerprint` + `display_reconciled_at`(`StateStore.ts:2306-2307`,迁移 `:12118-12126`)由 `setChatThreadDisplayFingerprint`(`:7949`)在**所有启用面确认 changed/noop 之后**写入;`listDisplayReconcileCandidates`(`:7972`)/`listDisplaySweepActiveIssues`(`:8019`)双层扫描在用它 |
| 「主因 = sessions 表 ≠ 进程现实,无对账器」 | **成立,是本单主活**。显示管线(对账器 2 骨架)07-06 起就在生产,而 Annie 07-18 仍然「不敢信」—— 恰好佐证:refresher 忠实渲染了错误的 sessions 表。进程现实 → sessions 表方向确实没有周期对账器(现有机制均为事件驱动/单点,见 §3) |

**推论**:对账器 1 = 从零建(主活);对账器 2 = 在 FLY-907 refresher 上**审计收尾 + 补洞**,不是重建。重建反而违反「勿重复建设」。

## 2. 现状地图 — 显示层(对账器 2 侧,已亲验)

### 2.1 FLY-907 IssueDisplayRefresher(默认 ON)

- `packages/teamlead/src/bridge/issue-display-refresher.ts`。`FLYWHEEL_ISSUE_DISPLAY_REFRESH !== "0"` 即启用(`plugin.ts:4150-4151`);holder 空 = 全部触发点休眠(byte-compat 逃生口)。
- **per-issue coalesce-to-latest**(`refresh()`,`:527-546`):in-flight 吸收新触发,中间态坍缩,最新赢。
- **runSweep 双层**(`:554-590`):
  - Layer 1:`listDisplayReconcileCandidates`(keyset 游标,limit 50)对比 stored fingerprint 的 sessions 分量 vs 现算 → 不符才 enqueue。**含终态 issue**(crashed finalization 的停格面不许隐身)。
  - Layer 2:`listDisplaySweepActiveIssues`(轮转游标,limit 10)对**非终态** issue 无条件重渲染(refresher 重读 CommDB;零漂移 pass 由 writer 端 no-op 保护)。
- **park probe**(`readParkProbe`,`:594-625`):读 comm.db `runner_declared_states`,`kind==='parked'` 且未过期 → `parked`;探测失败 → `unknown`(**绝不**读成 "was woken",Codex R1 #2 教训)。

### 2.2 标题写入 = GET+PATCH 幂等(FLY-630)

`ChatThreadCreator.writeTitleOnce`(`:701-800`):每次写**真 GET 现值** → 只管 leading badge 位、保留其余标题(含人工改名)→ `currentName === desired` 则 no-op 跳过 PATCH → 429 按 Retry-After 重试(上限后交给 sweep)。per-thread coalescing writer(`titleWriters`,`:302,594-692`)防并发 rename 竞态。

**含义**:验收 ②(人为改错标题下轮自动纠正)对**非终态** issue 今天就基本成立(layer-2 轮转会带 GET+PATCH 重渲染);真正修不到的是: (a) badge 位以外的标题体(by design 视为人工 curation 保留); (b) **终态 issue** 被外部改错(layer 1 只看 sessions fingerprint,无 session 变化就不再 enqueue)。

### 2.3 wake_failed 指纹跑步机(已亲验定位)

`plugin.ts:7899-7934` `notifyWakeFailure`:`episodeFingerprint = sha256(wake.message_id).slice(0,16)`。**每条新积压的 mailbox 消息 = 新 message_id = 新指纹** → 绕过 detection-escalation 的 episode 去重 → 同一个死/停 session 反复报警(一晚 5+ 条、~35 条手工 resolve 史的机制解释)。修向:指纹按 `(execution_id, kind)` 收敛为 episode 级;且对账器 1 把死 session 落终态后,wake 生产端对终态 session 应停止铸新 wake 尝试(真相侧断根)。

### 2.3a wake_failed 的完整再铸链(Explore 复核补全)

三个再铸位点 + 一个缺失守卫:
1. `runner-wake.ts:229-237`:wake 失败落 StateStore 事件,`event_id = wake-failed-${executionId}-${Date.now()}` —— **每次失败新 id,零去重**。
2. `runner-receipt-patrol.ts:99-115`:receipt-wake 巡检对 target session 判 `targetState`——`running`→live,**其余(含 completed/terminated)→terminal→按 `terminal_before_started` 升级报警**,而不是把针对终态会话的积压 wake 处置掉。
3. `plugin.ts:7909-7913`:`episodeFingerprint=sha256(message_id)`(§2.3);另 `detection-escalation.ts:261-267` 的事件 id 还掺 `first_detected_at_ms`,同 (target,kind,fingerprint) 复发也铸新 id。
4. **缺失守卫**:巡检与 `notifyWakeFailure` 都不先问「session 已终态?」——终态正是 `terminal_before_started` 的触发条件本身。
5. **#690 已被无罪化**:git 史(`1796fa9c`/`27a7c3fc`,FLY-1447 bisect)明确记录 #690 的 gate-poller +39 行与看门狗 dedup 无关;wake_failed 再铸面完整保留待修,不与 #690 重复。

### 2.5 状态→emoji 映射:三份表(560/626 复核对象)

- **A** `stage-utils.ts:66-126`:`STAGE_EMOJI` + `STAGE_WORD`(13 个 stage;🧠规划/👀设计审/🔨实现中/🧪QA/👀代码审/📬PR已开/⏳待批/🚀ship/✅完成)+ 跨切 `🔴受阻` / `⚠️重连中`。
- **B** `packages/config/src/three-stage-phases.ts:271-287`:`PHASE_THREAD_BADGE`(🎨设计/🔨实现/🧪QA)——三段式 issue 上**替换** A 的前缀(FLY-892)。
- **C** `issue-display.ts:225-241`:`PHASE_DISPLAY_GLYPHS`(✅完成/▶进行中/◾未开始/🔴受阻)——用于 pinned header/状态行,非标题。
- FLY-907 已合并过 C 系的前身重复表;A vs B 的分裂仍在(`stage-utils.ts:15,165,192` 靠 longest-first peel 共存)。「560/626 残余错位」的深诊页已 404,需在 research 阶段以这三份表 × 全部 status/stage 组合重数一遍。

### 2.4 与 FLY-1448 的边界(勿重复建设)

FLY-1448(P1,related)= **批准断路急修**:session 卡 `running` 无 durable park → wake 拒投 → founder 批准读到即丢 + 零告警。其修法在 park/wake 记账对齐 + fail-loud。两单都点名了 wake_failed 指纹跑步机;边界定为:
- **FLY-1374(本单)**:真相侧 —— 死进程落终态(饿死死会话的 wake 尝试源头)+ 指纹 episode 化(告警面止血)。
- **FLY-1448**:投递侧 —— 活着的 gate-等待 session 的 park/wake 合同 + founder 批准 fail-loud。
- 实现期需检查 FLY-1448 是否已 land,land 了就按其实际改动收缩本单指纹项。

## 3. 现状地图 — sessions 真相层(对账器 1 侧)

### 3.0 两个 SQLite,两张 sessions 表

- **Bridge StateStore**(`packages/teamlead/src/StateStore.ts`,`teamlead.db`,FLY-663 后 = better-sqlite3 套 sql.js 兼容壳):**本单要对账的 FSM 状态表**。
- **per-project CommDB**(`packages/flywheel-comm/src/db.ts`,每项目一个 comm.db,better-sqlite3 WAL):另一张更小的 sessions 表 + park / DAG turn holder 表。既有交叉对账器(crash-reaper / commdb-fsm-reconcile / statestore-ghost-reconcile / zombie-scan)都是把这两库和 tmux 探针 join 着看。

### 3.1 状态模型的三个纠偏事实(设计前提)

1. **`monitoring_lost` 不是 status**。它只是 advisory 事件 `session_monitoring_lost` + tmux 标题「⚠️重连中」(`HeartbeatService.ts:2801`);sessions 表不会因此变列。issue 里「活进程判监控丢失」指的是这个 advisory 面,不是 FSM。
2. **`parked` 也不是 status**。park 有**三种表示**:(a) FSM 的 `ship_parked`(DAG actor 完成本节点等终点 Gate,FLY-1441,`StateStore.ts:26260-26279`);(b) CommDB `runner_declared_states.kind='parked'`(Runner 自宣「做完但活着」,FLY-626,`db.ts:71-78,4997`);(c) DAG turn holder(CommDB `three_stage_turn.holder_exec_id` + `runner_workflow_activation` + StateStore `workflow_gate_holder`)。对账器**必须把三种都当「安静≠死,不许收割」**。
3. **FSM 单一真相** = `packages/core/src/workflow-fsm.ts`(`WORKFLOW_TRANSITIONS`,:120-189)。终态(零出边):`approved` / `completed` / `shelved` / `terminated`。写入统一走 `applyTransition()`(`applyTransition.ts:42-83`,带 display-refresh hook);现实压倒 FSM 时的 fail-closed 旁路 = `forceStatus()`(`StateStore.ts:4240`,调用者:HeartbeatService zombie reap、marker-reconciler fallback、actions、plugin)。

### 3.2 既有探针/对账机制清单(碎片化,9 件)

| 机制 | 触发 | 探什么 | 写什么 |
|---|---|---|---|
| `probeRunnerProcessLiveness`(`tmux-lookup.ts:371-401`) | 被动原语 | `#{pane_dead}` per pane → 4 态 `alive/dead_pin/absent/indeterminate`(indeterminate 视为活,GEO-374) | 无(**可复用的 canonical 探针**) |
| `reconcileMonitorLoss`(FLY-172/623,`HeartbeatService.ts:901-`) | 心跳 tick(默认 **5min**) | 候选=`getOrphanSessions`(running+heartbeat 陈旧);marker 先行→tmux 探 | 活而陈旧→re-adopt(刷 heartbeat + 标题 + 一次性 advisory);**从不改 status** |
| `reapOrphans`(HeartbeatService) | 心跳 tick;orphan 阈值默认 **60min** | 同上候选 | 死→`failed`(`:1382-1427`) |
| crash-reaper(FLY-720,`bridge/crash-reaper.ts`) | 心跳 tick | running 且探得 `dead_pin` | 宽限后拆 tmux→`terminated`+清 CommDB |
| complete-marker-reconciler(FLY-172) | boot drain | 孤儿 complete 标记 | 经 `/events` 重放;fallback `forceStatus`(:874) |
| done-running-reconciler(FLY-324) | boot + stage_changed | running 但 stage=completed | `running→completed` |
| statestore-ghost-reconcile(FLY-1066③) | CommDB prune 触发 | StateStore-only 非终态鬼 + 探死 | 终态化(活/indeterminate/parked/fresh 全保) |
| commdb-fsm-reconcile(FLY-817) | 事件触发 | StateStore 终态 + CommDB 还 running + tmux 死 | 删 CommDB running 行 |
| zombie-scan(FLY-1082,`bridge/zombie-scan.ts`) | 周期 | 三形态:commdb_orphan / terminal_desync / stale_target | **只检测不收割** |

**缺口(=对账器 1 要补的)**:没有任何一个「每 N 分钟把**全部**非终态 session 走一遍、直连探现实、双向纠偏」的全量扫描 —— 现状全是事件邻接/阈值门控/单方向的碎片(monitor-loss 要等 heartbeat 陈旧、crash-reaper 要等 orphan 龄、ghost-reconcile 要等 CommDB prune 触发、zombie-scan 只报不改)。

### 3.3 open session 枚举(现成查询)

`listNonTerminalSessions()`(`StateStore.ts:4405-4418`,`status NOT IN (completed,terminated,rejected,deferred,shelved,approved,timeout)`)= 全量扫描的现成候选集;另有 `getActiveSessions` / `getReadoptCandidateSessions`(+design_done)/ `listParkWatchSessions`(+blocked)/ `getOrphanSessions`(heartbeat 陈旧)。

### 3.4 可搭车的周期设施(零新 timer 纪律)

- **GatePoller**(`gate-poller.ts:616-634`,**3s** tick,`plugin.ts:8037`):已挂 ~12 个 cadence-gated 子巡检(`(tickCount-1)%N===0` 模式,各自 try/catch 隔离),含 `onDisplayReconcileTick`(60 tick≈3min)。**对账器 1 的惯用落点 = 新增一个 `onSessionRealityReconcileTick`,低 cadence(如 40-100 tick ≈ 2-5min)**。
- **HeartbeatService**(**5min** tick,`:562-569`):已是活性链之家(monitor-loss→server-loss→crash-reaper→stuck→reapOrphans,FLY-1282 单飞)。备选落点。
- RunnerIdleWatchdog(~3s per-session capture-pane):per-session 粒度,不适合全表扫。

### 3.5 FLY-1369 并入的 ground truth 判据(issue 原文,设计必须遵守)

- **唯一可信死活/身份判据 = 绕开中介直连进程层**:`tmux pane_pid / pane_dead` + `pgrep 锚真实进程签名`(`--agent-id runner-` 防 pgrep 自我误命中)+ **先自检仪器**。
- 中介的 `runner_terminal_capture` / `monitoring_lost` 本身就是中介的,**不是 ground truth**(07-18 铁证:29 pane 直连全活,中介全体报 monitoring_lost;窗口映射串位把死 session 报成别人窗口里的 running)。
- **活性三分,不许混**:①存在(ps)②健康(pane_dead + 直连 capture)③活性(CPU delta;**零增量 ≠ 死**,idle/parked 本来零 CPU)。
- 对照现状:`probeRunnerProcessLiveness` 已是直连 tmux 的 4 态探针(①②),但**窗口身份映射**(exec → tmux window 的 lookup 链,FLY-1369 的「串位」病)与 **pgrep 进程签名锚定**(①的进程维)在探针原语里还没有;CPU delta(③)只有 fleet-data 批量面(`fleet-data.ts:918-958`)。

## 4. 现状地图 — 复用会话病族(2026-07-23 晚实锤)

### 4.0 统一根因(审计定论)

DAG 的 park/wake 引擎 = `PhaseOrchestrator`(`phase-orchestrator.ts:1757` handoff,`:1878-1961` wake-or-spawn 决策)。**WAKE(复用)分支只写一个 store(TURN,`grantTurn` :1915-1921),五步 spawn setup 一步都不重跑**,全靠 parked holder 首次 spawn 的 CommDB 行 / StateStore 行 / tmux window / env 还有效。四个症状 = 这个缺失的「reuse 再水合(re-hydrate)」步骤的四张脸:

| Setup 步骤 | FRESH spawn | WAKE 复用 | 对应症状 |
|---|---|---|---|
| CommDB sessions 行 | ✅ `preRegisterCommDb`→`registerSession`(`run-dispatcher.ts:714,975-1005`) | ❌ 跳过,靠旧行 | ①③ |
| StateStore sessions 行 | ✅ 新 execId `status=running` | ❌ 复用旧行(可能带终态残留) | ② |
| mailbox 身份/注册 | ✅ `buildAgentTeamIdentity`(`run-dispatcher.ts:351-360`) | ❌ wake 时按同 execId+leadId 重推导 —— **仅当 CommDB 行还在才有效** | ③ |
| tmux window | ✅ 新窗 | ❌ 原地唤醒 | (FLY-1319 串位形) |
| env 注入(`TEAMLEAD_API_TOKEN`/`FLYWHEEL_PROGRESS_PATH` 等) | ✅ `tmux new-window -e`(`TmuxAdapter.ts:441-490`) | ❌ 冻结在首次 spawn;token 轮换后变 stale | ④ |
| TURN grant | ✅ 派发前 seam | ✅ **唯一会写的**(wake 前 grant) | —— TURN 有效但 holder 看不见(①) |

### 4.1 症状 ① comm.db 行缺失 → no-turn

`turn.ts:43-52`:`turnStatus()` 先 `getSession(execId)`,**行没了直接返 `no-turn`**,TURN 本体(`getTurn`)根本没被问到。行是被谁删的:`finalizeSession` `DELETE FROM sessions`(`db.ts:5553,5621`),由 `commdb-session-prune.ts:148-230` / `commdb-fsm-reconcile.ts:163-260` 驱动;prune 的保命条件 = 窗口探得 alive/indeterminate 或未过期 parked 声明veto(`:187-219`)—— **活着的复用 holder 若 `tmux_window` 映射串位(FLY-1319 形)就会漏过 veto 被误 finalize**。orchestrator 自己已能检出这个洞:`reconcileOneTurn` 标 `"holder session row missing (... dispatch remnant)"`(`phase-orchestrator.ts:2227-2232`),但只检不修。

### 4.2 症状 ② StateStore 终态残留卡 progress 单写权

`progress.ts:112-141` 两道门,**竞争键 = `issue_identifier` + `session_role`(非 branch 非 execId)**:(1) own-row 门:`readSession(execId)` 必须存在且 `status==='running'` —— 复用 holder 的行还停在旧 run 终态就被拒;(2) latest-active-writer 门(`:341-362`):同 issue+role 的 `status='running'` 按 `last_activity_at` 最新者才是合法 writer —— 同 issue 残留的旧 running 行会顶掉新 run。

### 4.3 症状 ③ 复用会话收不到信箱

`wake.ts:75-78`:`wakeRunnerMailbox` 先 `getSession(execId)`,**行缺失或缺 `lead_id` → 静默 skip(best-effort 不抛)**。信箱身份 `deriveRunnerMailboxIdentity`(`path-helpers.ts:163-168`)= `runner-${execId前8}` + leadId 的纯函数 —— 身份不是分歧点,**行存在性门才是**。①③同根。

### 4.4 症状 ④ ask 求救信 nudge 401

`runAsk`(`index.ts:413-460`)durable 落 `questions` 表(权威)后,`nudgeLeadInboxBestEffort` 用 **tmux env 冻结的 `TEAMLEAD_API_TOKEN`** 打 Bridge `/api/lead-inbox/nudge`(`lead-inbox-nudge.ts:26-46`);Bridge `tokenAuthMiddleware`(`plugin.ts:1015-1044`)token 不符 → 401,客户端 warn 后吞掉。durable 行留底,但 **Lead 只有收到成功 nudge 才缩短轮询** —— 401 = 门铃永远不响。复用挂钩:token 轮换后,复用 holder 的每次 ask 门铃全 401。

### 4.5 现成的修复 seam

`PhaseOrchestrator.reconcileTurnBelt` / `reconcileOneTurn`(`phase-orchestrator.ts:2166-2312`)已检出 holder-row-missing 与 terminal-holder TURN(带 `TURN_GRANT_GRACE_MS` 在途宽限);wake 分支(`:1900-1952`)是挂「reuse 再水合」的天然位置。另注意:resume dispatch(`$FLYWHEEL_PROGRESS_PATH`,`run-dispatcher.ts:1386-1478`)是**新 execId 的 fresh spawn**,会正常注册 —— 与 WAKE 复用是两条不同路径,病只在 WAKE。

## 5. 现状地图 — Discord 卫生同族小修(审计后逐项重定位)

### 5.1 路由守卫(reply-guard)

`bridge/reply-guard.ts:87-126` `evaluateReplyGuard`:core-channel 全放;**channel 顶层 + 任意 issue token → 硬拒**(`issue_at_top_level`);**issue-thread 内出现他单 token → 只软遥测 `potential_wrong_thread`,v1 不硬拒**。路由 `POST /api/discord/reply-guard`(`tools.ts:1178-1258`),plugin fork 在 reply/edit 前调用。
**审计结论**:Annie 被逼删单号的硬拦不出自 `evaluateReplyGuard` 的 thread 分支 —— 要么来自顶层硬拒分支(她在 channel 顶层发含单号消息),要么来自 plugin fork 侧/其他执法点。「钝化」的落点要先用真实被拦样本定位到执法点再改,不能凭 issue 描述猜。

### 5.2 重启 archive 级联(403 locked)

两个级联面,都汇到 `done-thread-archiver.ts` 的 `archiveThreadAndRecord`:
- `done-thread-reconcile.ts`(FLY-1165/369,boot 15s + 周期 tick):候选=`getUnarchivedIssueChatThreads` → **双门:(a) 现查 Linear 必须 `{completed,canceled}`(:70,:421) (b) PATCH 前 liveness 复核veto**(:588-589)。
- `terminal-thread-archive.ts`(FLY-1282 Part C,完成时触发):更严 —— `{completed,terminated}` 全别名行终态 + pane 探活 veto + 探后 fingerprint 复读 + sink 前 Linear 复查。
**审计结论**:「级联前校验 issue 终态」**字面上已存在**;活单仍被锁死(team-lead 任务板 #117 实证)说明 bug 在门的**漏洞**里:候选枚举/active-set 检查的 FLY-270 别名键错配(`getSessionsByIssueAndStatuses` 若只按单键查会漏活着的后继 session)、或 Linear 查询失败被 fail-open 当终态。另:archive PATCH 只设 `{archived:true}` 不设 `locked`(`chat-thread-utils.ts:142`)——**403 "Thread is locked" 的 lock 从哪来是未解之谜**,research 需实证(Discord 侧行为/plugin fork/人工)。修向 = 门补洞(别名集 + fail-closed)+ 自愈(发现活单 thread 被 archive/lock → 主动 un-archive 再投递)。

### 5.3 chat-threads/send 长文

**审计修正**:分片**已存在** —— `discord-utils.ts` `splitDiscordMessage`(1900 界,按最后换行分)+ `postDiscordMessageToChannel` 逐片发、首片挂 reply anchor、中途失败返回 `remainingText`;`/api/chat-threads/send`(`tools.ts:672,891`)走的就是它。issue 说的「缺口」需要重定位:嫌疑 = 其他直连 Discord POST 的调用点没走该 helper,或失败片的 `remainingText` 无人重投。research 阶段 `rg` 全量枚举 POST 调用点定位。

### 5.4 lead_inbox 双命名空间收据

同一条 founder/chat 消息铸两套收据行,生命周期独立:
- `chat:<leadId>:<messageId>`(`chat-receipt.ts:86-91`,FLY-1426 durable chat 收据道)
- `founder_msg:<leadId>:<msgId>`(root)+ `founder_route:<leadId>:<msgId>`(route)(`founder-reply-routing.ts:19-25`,由 `founder-reply-deliverer.ts:454` 用)
`markProcessed` 各标各的(`db.ts:2080-2081,2194-2196,2299-2301`);一边 processed 一边 pending → 未关的那边重投。检测层甚至按前缀分支特判(`detection-escalation-sinks.ts:288-308`)——两道并行有据,未统一。**类级修** = 同一外部 msgId 的跨命名空间结算联动(settle 一边时按 msgId 联动另一边,或收敛为单 canonical 行 + alias)。

## 6. 开放问题(带到 research/plan)

1. 对账器 1 的校正动作边界:进程死 → 落哪个终态(terminated vs failed)按什么上下文判?现有先例:crash-reaper 死 pin→`terminated`,reapOrphans 陈旧→`failed`,marker-reconciler 有 marker→按 marker 真实终态 —— 对账器要统一这套判据还是逐个委托给既有机制?
2. 对账器 1 与既有 9 件碎片机制的关系:**倾向 = 复用探针原语 + 委托校正动作,自己只做「全量枚举 + 判定 + 分派」**,避免第 10 个平行收割者互相打架(如与 crash-reaper 的 dead_pin 认领竞争)。plan 定案。
3. 复用病族:治因(WAKE 分支补「再水合」)为主 + 治果(对账器把 holder-row-missing 从「只检」升级为「检+修」)兜底 —— reconcileTurnBelt 已有检出逻辑,补修复动作即可。plan 定案。
4. 「560/626 残余错位」深诊页已 404 无法复core;research 以三份映射表 × FSM status × stage 全组合重数,以代码现状为准。
5. 验收 ⑥(复用 holder 三通)要求真 DAG park/wake;529 房需确认能跑 PhaseOrchestrator 的 wake 分支。
6. 403 "Thread is locked" 的 lock 来源未在代码中找到(archive 只设 archived:true)—— research/实现期需真机取证。
7. FLY-1448(批准断路)与本单并行在跑;实现期需检查其落地范围,收缩本单 wake_failed 指纹项避免撞车(本单只做:终态会话不再被 receipt-patrol 升级报警 + 指纹 episode 化;park/wake 投递合同归 1448)。
