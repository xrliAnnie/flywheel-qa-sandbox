# FLY-2900 撞墙后自动续上 — 调研
Issue: FLY-2900 (https://linear.app/geoforge3d/issue/FLY-2900/codex额度墙-撞额度墙后-held-的-run额度恢复-切号成功后自动续上换体或唤醒不再挂起等人)
日期: 2026-09-25
基于: exploration.md

## 0. Lead 裁定（改变了 exploration §4/§6 的建议）

- **Q2（question `31bb8011`）**：「额度待命」是本单主线，不许推迟。撞墙时**不把 execution 判终态失败**，进入额度待命；切号成功 / 额度恢复后用**同一个 exec id** 起新 Codex 进程 `thread/resume` 原 thread 接着干。founder 9-16 原则「撞额度只切号，不换体」。FLY-2465 替身只作兜底：thread 恢复失败、进程起不来时才用。exploration §4「额度待命放后续单」作废。
- **Q1**：`codex_quota_claude_fallback` 默认开，附六条：①全部 Codex 号撞墙**且最早恢复 > 30 分钟**才改派；②每次改派留记录（dispatch 原因 `codex_quota_fallback`），额度页可见；③模型报告把这些节点标 fallback，不进 Codex 档也不进 Claude 正常分流样本；④Codex 恢复后新派节点回正常分流，已改派在跑的在 Claude 上跑完；⑤same_vendor_review 照守；⑥OpenAI 服务端宕机不属额度，本单不处理。
- **FLY-2895 方向**（question `fe80c115`）：改派 Claude 必须是显式开关 + 每次留审计，**走同一条 dispatch 解析路径**，以后 FLY-2895 推荐器能接管；FLY-2891 会删掉现有 `applyImplementQuotaDegradation`，本单不能依赖它、也不能另起硬编码旁路。
- **FLY-2371**：额度墙时引擎盲换三具 → `retry_limit_escalated`；建议不盲换、hold 带 reset 时刻或订阅轮换事件自动重臂。**FLY-2521**：自动切号从未部署完成；incident 在 readiness 失败时不应 pause root；缺「对当前号主动探额度恢复」。

## 1. 生产数据（只读，窗口 09-11 23:31Z → 09-25）

| 量 | 值 | 来源 SQL / 文件 |
|---|---|---|
| usage-limited 执行体 | 231，全 Codex；implement 214 / eng_design 11 / qa 6 | `session_events.payload.failureKind='goal_usage_limited'` × `workflow_execution_runtime` |
| 紧跟盲换 | 195（中位 4 分钟） | 同 run/node 下一 execution |
| 额度关联 hold | retry_limit_escalated 31 / unlaunched_admission_rolled_back 40 / delivery_reroute 14 | `workflow_run_event` kind + 同 node 前序 usageLimited |
| 释放方式 | 全部 `principal:"master"`（Lead） | `hold_resumed.payload` |
| K1 浪费（普查口径） | 207.8h，其中挂着等人 185.9h；后继为 Codex 的 214 起 119.4h，后继改派 Claude 的 9 起 88.5h（几乎全是等人） | FLY-2893 `incidents.csv` 按 successor_vendor 聚合 |
| 自动切号 | 0 次；129 条信号全 manual；root 代数 5→16 全人工 | `codex_quota_signal_event`、`codex_quota_switch_audit` |
| Claude 侧 | 0 次额度失败，0 hold；quota-monitor 42 次成功切号 | `quota-monitor.log` |

## 2. 代码事实（基线 6523b997c）

### 2.1 撞墙当下发生了什么

1. `codex-daemon-client.ts:1511-1520` `settleTerminal` 只对 blocked+gate / complete+phase 持有；`usageLimited` 走 terminal 出循环。
2. `CodexTmuxAdapter.ts:2481+` 收尾：`runtime.stop()` 杀 app-server、`killFounderWindow()` 杀 TUI、CommDB 写 `timeout`（L2551）、释放 keyed home lease；**`session.json`（thread id、daemon pgid）不删**，在 `~/.flywheel/state/codex-sessions/<execId>/`。
3. `codex-daemon-adapter-helpers.ts:224-256` `goalQuotaFailure` → `failureKind:"goal_usage_limited"` + `quotaSignal`；`Blueprint.ts:3243-3257` 短路 → `ExecutionEventEmitter.ts:233-244` `session_failed`。
4. Bridge：`DirectEventSink.ts:1376-1473` / `event-route.ts:1312-1330` → `StateStore.recordEnrolledTerminalSignal`（L50014）：同一事务里 `codexQuota.recordSignal`（L50127）→ `session_events` → `sessions.status='failed'` → `generalized_teardown_recorded`（L50214）。teardown 事实是 dead-exec sweep 的扳机。
5. 之后：自动模式下 incident 暂停 → 切号 → `run-recovery.ts` terminate + `/api/runs/start`（**新 run、新 execution**）；manual 模式或无 binding 时暂停不生效或永不解除，引擎盲换 → hold。

### 2.2 同一 execution 重新拉起的现成件

- `CodexTmuxAdapter.ts:2087-2104`：`resumeThreadId = ctx.previousSession?.threadId ?? readPersistedThreadId(executionId)`；`processLifecycle.mode==="resume"` 要求 thread id 存在且等于 `expectedSessionId`；`reapOrphanPid` 收旧孤儿；`onThreadReady` 核对 thread/model/cwd（L1939+）。
- `codex-daemon-goal-runtime.ts:514-540` 有 id 就 `thread/resume`。
- `plugin.ts:14453` `resumeStandbyActor`（FLY-2808）：runtime/binding 当前、读 manifest `session.json`、thread id、`resolvedModel===runtime.model`、cwd realpath = worktree realpath、读 HEAD/dirty（漂移 → `headDriftNotice`）、CommDB 冻结 lead id、180 秒内确认身份，再 `startDispatcher.start(buildStandbyResumeStartRequest(...))`（`workflow-resume-identity.ts:49`）。**只被 rework 协调器调用**（`workflow-rework-coordinator.ts:1044`），且依赖 `workflow_execution_process_body`（L34899）。
- FLY-2808 载体表是 `workflow_execution_process_body`（active/retiring/standby/resuming/resume_failed/closed），**只在 `node_standby_resume` 开着时于 admission 登记**（默认关），进入 standby **只能从阶段完成**（session `ship_parked`）。
- 目标预检（`codex-daemon-client.ts:1573-1664`）：我们自己的 goal 若是 `paused`/`blocked` 有分支；**`usageLimited` 无分支**，落到 `activateGoal()` + `startInitialTurn()`（重放完整 kickText）。`reactivateWake`（L1211-1240）是「注入一回合 + goal active」的现成模式，但要求活 daemon。

### 2.3 谁会对「非终态但无进程」的 execution 动手

| 组件 | 触发 | 今天的豁免 |
|---|---|---|
| dead-exec sweep `workflow-engine-dispatcher.ts:1975-2180` → `rollbackDeadWorkflowNodeExecution` | session 终态或有 teardown 事实，且探活 dead | 完成回执、operator close、`deferDeadExecutionForReadyResume`、`codex_quota_paused` |
| `HeartbeatService.reapOrphans`（L2125/L20610） | running 且心跳陈旧 → 强置 failed | 无载体检查 |
| zombie declare（HeartbeatService L1188）/ `crash-reaper.ts` | running + dead → failed/terminated | 仅 parked readopt 看 body |
| `CodexSessionReowner`（`codex-session-reown.ts:528-540`） | 候选状态含 running；daemon 缺失 → 收掉并**用快照复活同一 exec** | `isIntentionalStandby`（plugin L10151-10157，body retiring/standby/resuming） |
| resident hold 过期（StateStore L49236-49245） | resident 超 grace | body 非 closed |
| `codex-terminal-harvest.ts` / `codex-runner-orphan-reaper.ts` | 终态 / 无主 app-server | owned、resident |
| `codex-quota/stale-running-tracker.ts`、`runner-recovery-nudge.ts`、`turn-wake-patrol.ts` | running 无活动 | 需逐个核 |
| turn-belt `turn-belt-reconcile.ts:133` | 死 holder 改派 TURN | engine-owned 全豁免 |

### 2.4 放行条件相关

- `coordinator.ts` 每 3 秒一 tick（`GatePoller.onLandOperationTick`，`plugin.ts:12929/12951`）。
- 选号前 `runtime.ts:223-233`：当 canonical 链活跃时，**canonical 账号（正是撞墙的那个）被记 `in_use_unshared`、不读额度**（`occupancy.ts:44-51`）。于是 `candidate-selector.ts:193-220` 永远到不了 `pool_exhausted`，落 `no_usable_credentials` 每 60 秒空转；原号回血看不见；`getCurrentPoolExhaustionFact`（`codex-quota-store.ts:1875`）永远无事实。
- 读数调度器（FLY-2869/2830）已用**只读 WHAM GET**（`readonly-usage-reader.ts`，不刷新 token、不耗额度）每 15 分钟读全部号、并在 100% 窗口 reset+60 秒补读（`reading-scheduler.ts:16-40`），写 `codex-accounts.json`（含 `identityKey`、`activeAccount`）。这正是判断「原号回血」和「全池满」所缺的数据。
- 人工切号 `reconcileExternalRoot`（`codex-quota-store.ts:~360-420`）：root 代数 +1，旧 incident → `identity_uncertain`，此后无自动出口。
- `isExecutionPaused`（`codex-quota-store.ts:2014-2035`）：target 未 recovered/abandoned、或 manual/pending 信号代数 ≥ root 代数、或 execution_pause 关联未提交 incident。原号回血不改代数 → 永不解除。

### 2.5 改派相关

- `resolveNodeDispatchAtLaunch`（`workflow-dispatch-resolution.ts:175`）是 launch 时唯一派发解析；`applyImplementQuotaDegradation`（L36-78）只覆盖 implement + 特定臂 + 有池满事实，FLY-2891 将删除。
- admission 的 same_vendor_review 检查（`StateStore.ts:46764-46784`）作用于解析后的 dispatch；Codex 暂停检查只对 vendor=codex（L46786）。
- 评分表 `workflow-model-assignment.ts:199-216` 读 `model_arm_degraded` 事件把降级样本单列；新增的 quota fallback 需要同样被识别。
- `allocateWorkflowResumeFallback`（`StateStore.ts:48330`）用 ledger purpose `resume_fallback` + `source_demand_id` 分配新 execution（同 run/node/attempt），**不计入盲换预算**（`countWorkflowFaultReplacements` 只数 `fault_replacement`，L48551）；但它绑定 process_body + rework demand。
- 接管脏工作树：`Blueprint.ts:1509-1545` 非 resume 路径的 takeover 要求 clean 且 HEAD 可复用，否则 `worktree_takeover_failed`（E9 与 40 次 `unlaunched_admission_rolled_back` 的成因之一）。

### 2.6 通知

- issue thread 一句话：`emitIssueThreadInfraNotification`（`founder-thread-notifier.ts:653`），带 `onUndeliverable` 兜底。
- Lead 事件：`appendLeadEvent` + `enqueueLead`（`codex-quota/outbox.ts:182-250` 的 lead_summary 模式）。

## 3. 方案比较

| 方案 | 结论 | 理由 |
|---|---|---|
| A 额度待命：同 exec、新进程、`thread/resume` + 短 continue 回合；失败兜底才换体 | **采用**（Lead Q2） | 保上下文、不浪费 token；exec id 与开发者指令一致，没有「新 exec 接旧 thread」的身份错位 |
| B 仅 FLY-2465 新 run 替身，补放行条件 | 否 | 丢上下文；新 run 缺上游节点产物；违背 founder「只切号不换体」 |
| C 复用 `workflow_execution_process_body` 作载体 | 否 | 该表绑定 `ship_parked`/阶段完成语义与 `node_standby_resume`（默认关）登记；给未登记体补行会把之后的阶段完成拖进 FLY-2808 退下协议 |
| D 新建 `codex_quota_standby` 载体表 + 从 `resumeStandbyActor` 抽出「同 exec 拉起」效果 | **采用** | 复用身份核验，与 FLY-2808 生命周期互不干扰；一个谓词供所有巡检查询 |
| E 在飞 app-server 热换凭据 | 否 | FLY-2869 实测不跟随 |
| F 发 `continue` 给原 pane（Claude 式） | 否 | 原进程缓存旧号 token（Lead 9-20 实测） |
| G 兜底接管脏树：quarantine（FLY-1707）vs WIP 提交 | WIP 提交 | quarantine 需要现成 checkpoint 锚点且把改动移出分支；WIP 提交后接班体在 `git log` 直接看到，工作树 clean 可正常 takeover |
| H 在用号用真探针（exec）确认回血 | 否 | 从副本刷新会使 canonical 刷新链互相作废（FLY-2404）；只读 WHAM GET 足够且不耗额度；真正的验证是被拉起的体本身，失败有预算兜底 |

## 4. 需要真 Codex 才能证明的两件事（演练项，失败均安全落兜底）

1. daemon 是否接受在 `thread/resume` 之后对状态为 `usageLimited` 的 goal 做 `thread/goal/set active` 并开新回合。
2. 在账号 A 上开的 thread，换到账号 B 的新进程里能否继续（加密 reasoning 条目是否跨账号可用）。

两者失败都表现为一次 resume attempt 失败 → 计数 → 达上限走 Codex 新体兜底，不会卡住或重复派。

**2026-09-26 00:07Z 真 Codex 预实验（plan.md §0）**：两件事在「A 侧尚无推理内容」的 thread 上均成立（personal2 撞墙 → shopping 新进程 `thread/resume` + `goal/set active` 接受 + 回合完成且记得首条消息）。A 侧已有加密推理内容的跨号回放未证，列为演练必证（plan.md §10）。
