# FLY-2498 设计体交接后 CommDB 注册行永不终结 — 探索

Issue: FLY-2498 (https://linear.app/geoforge3d/issue/FLY-2498/病根-eng-design-交接后-bridge-会话已-completedcommdb-sessions-行仍-statusrunning)
日期: 2026-09-11
基于: 无

## 0. 一句话

Codex 车道的 eng_design 体交接(`complete --route phase_design_complete`)之后,**按合同**继续活着做「设计上下文持有者」
(StateStore `completed`、CommDB `running` + `phase_keep_alive=1`、声明 `parked`);这段「活着停驻」期间 CommDB `running`
是正确的(它是 phase 唤醒的门栓)。病根不在交接,而在**体真正死掉的那一刻没人给 CommDB 行盖终态**:Lead 用
`close-tmux` 杀窗 + 收割 daemon 后,该端点只写 StateStore 审计事件,不碰 CommDB;Codex 适配器只在**受控关停**
(close-runner 的 phase-controller 路径)或目标自然结束时才写 CommDB `completed`,而那条受控路径在本案被
`phase_shutdown_controller_lease_stale_live_pane` 拒掉,Lead 才退而用 close-tmux。于是一条「窗口已死、daemon 已收、
status 仍 running」的注册行留在巡检 owner index(`status IN ('running','blocked')`)里,每 tick 报 `MISSING_PANE`,
直到 issue ship 时 post-ship 收尾用 close-runner 全量删行;**从不 ship 的 issue(FLY-2107 run 已 terminated)则永久残留**。
今天(09-11 07:24Z)又有 4 具同形体被 close-tmux 关掉,正在成为下一批 34 次告警。

## 1. 真库取证(只读,2026-09-11 17:5x UTC)

### 1.1 issue 点名的六具体(StateStore `~/.flywheel/teamlead.db`)

| exec | issue | status | adapter | role | node | terminal_at | workflow_run |
|---|---|---|---|---|---|---|---|
| `1492b1f6` | FLY-2107 | completed | codex-tmux | design | eng_design | 09-08 20:04:06 | **terminated** @ founder_gate |
| `1ac67591` | FLY-2455 | completed | codex-tmux | design | eng_design | 09-09 04:04:45 | terminated @ implement |
| `8e14ae65` | FLY-2465 | completed | codex-tmux | design | eng_design | 09-09 19:41:31 | completed (land) |
| `9e620c82` | FLY-2483 | completed | codex-tmux | design | eng_design | 09-10 05:36:27 | completed (land) |
| `8cade830` | FLY-2485 | completed | codex-tmux | design | eng_design | 09-10 05:32:55 | completed (land) |
| `7d9c1ac5` | FLY-2389 | completed | codex-tmux | design | eng_design | 09-10 05:59:52 | completed (land) |

六具全是 **Codex** 体(`adapter_type=codex-tmux`,`runner_model=gpt-6-astra`),`chat_thread_role=design`,
StateStore 终态戳齐全 —— 与 issue 描述一致。

### 1.2 CommDB(`~/.flywheel/comm/flywheel/comm.db`)—— 现在只剩一条

```
SELECT execution_id, status, tmux_window, ended_at, vendor, phase_keep_alive FROM sessions WHERE execution_id LIKE '1492b1f6%';
1492b1f6-…|running|runner-flywheel:@2998|(NULL)|codex|1
-- 其余五具:无行(已被 DELETE)
SELECT status, count(*) FROM sessions GROUP BY status;
-- blocked 2 · completed 2 · failed 7 · running 19 · timeout 4
```

五条行的离场路径(session_events,`source=bridge.close-runner`):

| exec | 离场事件 | 时刻 (UTC) |
|---|---|---|
| `1ac67591` | `lead_close_runner` reason=`DAG workflow ship finalization` + `commdb_ask_disposed`(retiredAskCount=15) | 09-10 08:06:16 |
| `8e14ae65` | 同上(retiredAskCount=13) | 09-10 08:07:34 |
| `7d9c1ac5` | 同上(9) | 09-10 23:29:10 |
| `8cade830` | 同上(6) | 09-10 23:30:19 |
| `9e620c82` | 同上(7) | 09-11 00:42:35 |
| `1492b1f6` | **无** —— run 在 founder_gate 被 terminated,永远不会有 ship 收尾 | — |

⇒ 「永不终结」对 ship 了的 issue 实际是「从关窗到 ship 收尾之间」(本批 1–17 小时);对不 ship 的 issue 才是真的永不。

### 1.3 1492b1f6 的完整时间线(session_events)

| 时刻 (UTC) | 事件 | 来源 |
|---|---|---|
| 09-08 19:19:23 | `session_started` | direct-event-sink |
| 09-08 20:04:06 | `session_completed` route=`phase_design_complete`(StateStore → completed,node → done) | workflow-generalized-completion |
| 09-08 20:06 | CommDB `runner_declared_states` kind=`parked`「design complete, inbox empty, awaiting design wake」;`runner_stop_declarations` `RUNNER-STOPPED reason=done` | 体自己 |
| 09-10 01:07:31 | `lead_close_runner_failed` reason=`fly867_stale_terminal`,`phaseShutdownError=phase_shutdown_controller_lease_stale_live_pane` | bridge.close-runner |
| 09-10 07:07:33 | `exec_host_processes_reaped` outcome=**absent**(pgid 56544);`tmux_closed` window `runner-flywheel:@2998` | **bridge.close-tmux** |
| 09-10 07:45:55 | 巡检首报 `MISSING_PANE`(本单首见) | Lead patrol |
| 09-11 16:29 起 | 每 5 分钟一条 `codex_app_server_orphan_identity_mismatch`(reaper 台账里有它,CODEX_HOME 清单里没有) | codex-runner-orphan-reaper |

`tmux list-windows -a` 现在没有 `@2998`;pgid 56544 无进程。**体已死,行仍 running。**

### 1.4 今天的下一批(同形,已在发生)

| exec | issue | StateStore | CommDB | 声明 | 窗口 | close-tmux |
|---|---|---|---|---|---|---|
| `57b4aeec` | FLY-2399 | completed 01:12 | running, ka=1 | parked | `@4325` 不存在 | 09-11 07:24:26 leadId=unknown |
| `9e7f71d7` | FLY-2459 | completed 02:26 | running, ka=1 | parked | `@4328` 不存在 | 同批 |
| `5b4fbd44` | FLY-2393 | completed 02:22 | running, ka=1 | — | `@4335` 不存在 | 同批 |
| `f073a538` | FLY-2505 | completed 02:30 | running, ka=1 | parked | `@4338` 不存在 | 09-11 07:24:25 |

对照:Claude 车道 2026-09-01 以来 ~50 具 `eng_design` completed 体,CommDB 里**一条都不在**(TmuxAdapter 在
`waitForCompletion` 返回后的 `finally` 里 `updateSessionStatusIfRunning`,行随后被每小时清扫删掉)。
本病只在 Codex 车道。

## 2. 代码路径(逐点核实)

### 2.1 交接只翻 StateStore,合同上就不该碰 CommDB

- `complete --route phase_design_complete` 走 HTTP `/events` → `event-route.ts:1229-1354` 通用节点完成
  (`workflow-generalized-completion`,StateStore `sessions.status=completed`,`workflow_run_node.state=done`)。
  `DirectEventSink.emitCompleted` 对该 route 直接拒绝(`DirectEventSink.ts:661-667`),所以只有这一条路。
- CommDB 终态写点只有三处:适配器自己(`TmuxAdapter.ts:1130`、`CodexTmuxAdapter.ts:1791/1891` 的
  `updateSessionStatusIfRunning`)、FLY-1066 异步镜像(`terminal-commdb-sync.ts`,**只镜像 failed/blocked**)、
  FLY-2313 的 `finalizeSessionCommunications` 提升 CAS(**只提升 failed/blocked**)。没有任何路径给 `completed` 的
  Codex 体写 CommDB `completed`,除非适配器自己结束。
- 交接后体**应当活着**:Blueprint 对 Codex 设计体注入 `phaseKeepAlive:{role:"design"}`(`Blueprint.ts:1755-1764`,仅
  `isCodexRunner && shareParentBranch`),提示词写明「do NOT exit … park … you stay alive as the design-context
  holder until ship; the Bridge closes you after ship」(`Blueprint.ts:2169`)。CommDB `running + phase_keep_alive=1`
  是 phase 唤醒的门栓(`db.ts:5007-5012 assertPhaseKeepAliveSessionRunning`、`db.ts:4516`)。
  ⇒ **在交接时盖终态是错的**(会把还活着的持有者从唤醒路由里踢掉);issue 的 `next` 里「交接路径盖戳」这一支应否决。

### 2.2 体死的两条路,一条封账、一条不封

| 路径 | 杀窗 | daemon | CommDB | 结果 |
|---|---|---|---|---|
| `close-runner`(phase-controller 受控关停,`close-runner.ts:440-545` + `codex-phase-shutdown.ts`) | 适配器自己 | 适配器 drain | 适配器 `updateSessionStatusIfRunning(completed)` 后 `finalizeCommDbSession` DELETE | 干净 |
| `close-runner` 直接清理(controller 不可达) | Bridge `killTmuxWindow` | `reapCodexDaemonForSession` | `res.killed` ⇒ `full` finalize(DELETE + 退 ask/gate)(`close-runner.ts:945-990`) | 干净 |
| **`close-tmux`**(`plugin.ts:3226-3316`) | Bridge `killTmuxWindow` | `reapCodexDaemonForSession` | **只 `store.insertEvent(tmux_closed)`,零 CommDB 写** | 残留 |

`close-tmux` 的 FLY-44 守卫只拦 StateStore `running/ship_parked/awaiting_review/approved_to_ship`;`completed` 放行。
本案 Lead 先试 close-runner,被 `phase_shutdown_controller_lease_stale_live_pane` 拒(controller 心跳陈旧但 pane 还活,
FLY-1269 fail-closed),于是按 founder 放权走 close-tmux。今天那 4 具的 `leadId=unknown` 说明是另一个调用面
(action router / founder-consent),同样零封账。

### 2.3 为什么没有兜底能收敛

| 兜底 | 为什么收不到 |
|---|---|
| 每小时/boot 清扫 `pruneDeadTerminalCommDbSessions`(`commdb-session-prune.ts:514`) | 只扫 `completed/timeout(/failed/blocked)` 行;`running` 行不在扫描集(`kept_status`) |
| FLY-2302 定点封账(`finalizeDeadTerminalCommDbSessionById`) | 只挂在引擎「死体回滚 tripwire」上;正常完成的体没有 `workflow_dead_execution_watch` 行 |
| FLY-1066 `terminal-commdb-sync` | `isTerminalStatus` 只认 failed/blocked |
| FLY-1204 停驻体回收(`HeartbeatService.checkStaleParkedPhases`) | 候选包含 `completed`+design,但回收前 `probePhaseLiveness !== "alive" → continue`(`HeartbeatService.ts:1705-1706`):**死体永远跳过**;它只回收活着的进程 |
| Bridge 重启再收养(`getReadoptCandidateSessions`,`StateStore.ts:11709`) | `status IN (running, ship_parked, awaiting_review, design_done, approved_to_ship)`,`completed` 不在 ⇒ 适配器内存态(那个 `Promise.race([goal, waitForShutdown()])`)重启后彻底消失,再没有进程会替它写 CommDB |
| FLY-2313 `finalizeSessionCommunications` | 要求 `recordedTerminal`(status 终态 + ended_at)或 failed/blocked 提升;`running` + `completed` 目标 ⇒ `terminal_evidence_changed` |
| post-ship 收尾 `closeRunner("DAG workflow ship finalization")` | **能收**(full finalize 不看 CommDB status),但只在 ship 时;terminated run 永远等不到 |

### 2.4 巡检这一侧(不改,记事实)

`scripts/lead-patrol-snapshot.sh:260-305` owner index SQL:`status IN ('running','blocked') AND tmux_window <> ''
AND tmux_window NOT LIKE '%:pending'`;`runner-patrol-rules.md:75/93` 把「owning status 是 running|blocked」写成合同;
Bridge orphan sweeper 同口径(`patrol-orphan-sweeper.ts:276`)。FLY-2302 plan §0 不变量 7(Lead 2026-09-03 裁定):
**目的是让死体的注册行拿到终结,不是给巡检加豁免**。本单沿用。

## 3. 方案空间

| 方案 | 结论 | 理由 |
|---|---|---|
| **A. `close-tmux` 杀窗成功且执行证明已死后,CAS 给 CommDB 行盖终态**(`running → completed/timeout/failed/blocked`,按 StateStore 终态映射,绑定 `tmux_window`) | **采纳(主修)** | 本案与今天 4 具的真实触发面就是它;与 close-runner 的「杀窗即封账」对齐;最小改动 |
| **B. 每小时/boot 清扫增加「盖戳相」:CommDB `running` 行 ∧ StateStore 终态 ∧ 家族感知探针(`probeRunExecutionLiveness`)证明已死 ⇒ 同一 CAS 盖终态;下一轮清扫按既有规则删** | **采纳(收敛网)** | 收 1492b1f6 这类存量、Bridge 重启丢适配器、手工 `tmux kill-window` 等所有「死了没盖戳」的形状;复用 FLY-2302 的清扫框架与审计 |
| C. 交接路径(`phase_design_complete`)给 CommDB 写 completed | 否决 | 交接后体按合同活着停驻,`running+phase_keep_alive` 是唤醒门栓(§2.1);盖戳会把活体踢出路由 |
| D. owner index 与 StateStore 状态取交集 / 排除 completed | 否决 | FLY-2302 不变量 7;把假阳性换成盲区(Claude blocked 体窗口保留是合法名下目标) |
| E. `close-tmux` 直接走 close-runner 的 full finalize(DELETE + 退 ask/gate) | 不采纳 | close-tmux 是资源清道夫(FLY-44),不是生命周期终结;退 ask/gate 是 close-runner 语义;ship 收尾还要靠 `owner_closed` 退 ask。盖戳保留身份,让既有清扫和 ship 收尾各自完成本职 |
| F. 修 `lease_stale_live_pane` 让 close-runner 受控路径不再拒 | 另开 issue | FLY-1269 fail-closed 有其理由(杀活 controller 的窗会孤儿化 daemon);本单不改 |
| G. Bridge 重启再收养 `completed` 的停驻体 | 否决 | 「再收养终态」= 复活死者(`StateStore.ts:11704` 明确排除) |

## 4. 需要设计时钉死的点(进 research)

1. 「执行证明已死」在两条路径各用什么证据:close-tmux 有 `killTmuxWindow.killed` + `reapCodexDaemonForSession` 结果;
   清扫用 `probeRunExecutionLiveness`(Codex 先 daemon 后 tmux/discovery/host)。
2. StateStore 终态词表取哪份:`flywheel-comm/session-terminal` 的 `isMailboxTerminalStatus`(OUTCOME 去掉 approved_to_ship,
   且不含 awaiting_review)。映射:failed/blocked → 同名;其余 → `completed`。
3. CAS 原语:`UPDATE sessions SET status=?, ended_at=datetime('now') WHERE execution_id=? AND tmux_window=? AND status='running'
   AND ended_at IS NULL`,同事务 `disposeRunnerDoorbellsForTerminal`(与 `updateSessionStatusIfRunning` 同款),
   **并清 `runner_declared_states`**(parked 是活进程的声明;证明死了的进程不能再持有它,否则清扫在 sweep 模式会
   `kept_parked` 永不删行,`finalizeSessionCommunications` 也会以 `parked` 否决)。
4. 审计:`store.recordCommDbFinalizeOutcome` 已有;盖戳不是 finalize,需要一个新的 `session_events` 种类
   (`commdb_terminal_stamped` / `commdb_terminal_stamp_skipped`),`insertEvent` 无白名单。
5. 负向守卫:`:pending` 目标不盖(无法证明);探针 `alive/unknown` 不盖;StateStore 行缺失或非终态不盖;
   CAS 0 行(目标已变 / 已终态)不盖;任何异常只记日志,不让 close-tmux 返回 5xx、不让清扫抛出。
6. 现有测试族:`commdb-session-prune.test.ts`(3 组 veto 必须原样绿)、`founder-consent-integration.test.ts`(close-tmux
   路由用 stub handler,不覆盖真 handler)、`scripts/__tests__/lead-patrol-snapshot.test.sh:885`(MISSING_PANE 用例)。

## 5. 未验证 / 边界

- Linear MCP 401,issue 正文只来自派单 prompt;`class_key` 与 34 次计数未从 Linear 复核。
- 今天 4 具的 `close-tmux leadId=unknown` 调用方未追(不影响修法:端点内部封账对所有调用方生效)。
- `codex_app_server_orphan_identity_mismatch` 每 5 分钟一条的噪音是另一形状(reaper 台账 vs CODEX_HOME 清单不一致),不在本单。
- CommDB 里两条 2026-08 的 `runner-flywheel:pending` running 行(`35f0dbf9`/`296488f3`)是另一种残留(从未拿到窗口 id),
  本单的 CAS 明确不碰 `:pending`。
