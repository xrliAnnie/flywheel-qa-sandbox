# FLY-1570 拆 watchdog 全家 — 调研

Issue: FLY-1570 (https://linear.app/geoforge3d/issue/FLY-1570/消息层重构-a-批次1-拆-watchdog-全家)
日期: 2026-08-03
基于: exploration.md

## 0. 审计方法

5 个只读审计并行覆盖全 scope:① patrol/loop-health 集群 ② detection 集群 + founder-reply-watchdog ③ stuck 集群 + auto-qa-coordinator ④ LeadWatchdog + 墓碑 + flag 真相层 ⑤ plugin.ts wiring + 保留清单逐条定位。全部 `rg` 全仓(packages/ + scripts/),import 精确到 file:line。本文是五份审计的裁定后合并;行号基于分支 `flywheel-FLY-1570` @ `05e7b451`。

### 实施核验更正(2026-08-04)

最终残留扫描证明初次审计把「确认追人告警是否误报」误当成独立保留能力,与 issue 明确要求的「卡死检测器 + 升级全删」冲突。最终以 issue scope 为准:`HeartbeatService.checkStuck()` / `onSessionStuck` 与 `stuck-pane-confirm` / `watchdog-judge*` 整链删除;`detection-config-source` / `detection-escalation*` / `detection-gap-scan` / `detection-suspicious` / orphan reconcile 整链删除。`founder_decision_dropped` 保留收敛点直接走既有 routed alert sink,不再借 detection 升级层。W-4 健康清单只留 Lead blocked 行;RunnerIdle 进程存活、crash reaper、monitor-loss readopt、quota/auth 与 founder-reply unreachable-runner 保持原链。下文与此更正冲突的预实施「保留」判断均由本段取代。

## 1. 五个改变切割方案的重大发现

### 发现 1:大半「要删的检测器」在生产里已经是死代码 —— 删除是零行为变化

墓碑机制:`watchdog-minimum-set.ts:39-44` 的 `retiredWatchdogLaneEnabled()` **硬 return 字面量 `false`**(参数带下划线故意不读,env 救不活)→ `legacy-delivery-watchdog-policy.ts` → `plugin.ts:3929` boot 时捕获成 `legacyDeliveryWatchdogsOn = false` → 分发到 12+ 个注入点。因此以下路径**今天一行都不跑**:

| 已死路径 | 闸点 |
| -- | -- |
| gap-scan 全部 | `plugin.ts:8330` `onGapScanTick` 永远 undefined |
| park-watch 全部 | `plugin.ts:8317` 同上 |
| misroute 巡逻全部 | `plugin.ts:8366-8369` 同上 |
| delivery 对账 reconcile pass | `plugin.ts:6377` `enabled: false` |
| detection 集群的 legacyPass(runDetectionReconcileTick / FN4 投递对账 / resolveClearedGapEpisodes) | `plugin.ts:7705` `legacyEnabled: false` |
| LeadWatchdog `pane_hash_stuck` / `pane_error_stalled` 告警 | `LeadWatchdog.ts:641-647` emitAlert 开头直接 Silent;`:599` fireSuspicious 被挡 |
| stuck-runner-detector 的 checkSession 驱动 | `RunnerIdleWatchdog.ts:216-235` 包在恒 false 的门里 |
| RunnerIdleWatchdog 的 waiting / unknown 两条追人巷 | `RunnerIdleWatchdog.ts:266-273` 早退 |
| founder-reply-watchdog **全部三个检测器**(含要保留的 unreachable-runner) | `gate-poller.ts:557-559,637,1210,3603-3605` |
| lead-pending-escalation | `gate-poller.ts:1123,2062` 双闸 |
| account-switch watchdog(Bridge 侧) | `quota-daemon-cutover.ts:18-19` 硬 false(FLY-1456,外部 quota daemon 是唯一执行者) |

**仍活着、真正产生行为的追人型**只有:runner-receipt-patrol、lead-receipt-patrol(receipt cohort 及其 detection 升级)、codex-hold 两个 reconcile、notify-digest-expect、workflow-route-reminder-drain、inbox-loop-health-checker、mailbox 溢出扫描、LeadWatchdog 的 W-4 blocked 告警(保留项)。

### 发现 2:blocked 关键字分类(W-4)是保留项,FLY-218/FLY-220 的代码属于它

`usage_limit / rate_limit / login_expired / permission_blocked` 四类告警是「外部事实型」:registry.ts:148-179 flag `watchdog_blocked`,note 原文「**Annie 裁定保留且默认开:宁愿误报,不希望不报**」;`/health` 的 `w4_lead_blocked` 在 `REQUIRED_WATCHDOG_ROWS`(truth.ts:377-382),删了 manifest 校验直接 fail。

由此推论(修正 exploration.md 的初步假设):
- **FLY-218 `isTransientThrottlePane`(529 短路)保留** —— 它保护的是 usage_limit 误报,且被 `plugin.ts:10979` 注入 runner-quota-scan(保留项)
- **FLY-220 `ownStateRegion` / episode latch 保留** —— blocked 链的 echo 免疫基座;`pane-live-region.ts` 整文件保留
- **「2 轮判卡」(`paneHashStuckCycles`,`tickLead:537`)保留** —— blocked 的 pattern-first 确认也用它;真正只服务 pane-hash 的是「3 轮告警」(`paneHashAlertCycles:614-626`)和 `cooldownMs`(实测是**零读取的死字段**,所谓「冷却 30min」实际由 cooldownSignature 实现)

### 发现 3(实施时纠正):`stuck-pane-confirm.ts` 仍属于要删除的追人告警链

它虽然是 FLY-1234 给 `HeartbeatService.checkStuck()` 加的误报确认层,但输入仍是「多久没动/面板是否变化」,输出仍是 `session_stuck` 追人告警。保留确认层就必须保留被 issue 明确要求拆掉的卡死判定、judge、gap reader 与 suspicious 路由全家,会留下另一套完整追人系统。因此最终裁定是整链物理删除,不是把确认层留成开关。

### 发现 4:「保留 unreachable-runner」意味着要把它重新接活

founder-reply-watchdog 三个检测器共用 `legacyWatchdogsEnabled()` 门,**今天全部关死**。物理删除墓碑门之后,unreachable-runner 的门只剩 `FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0"`(默认开)—— 即**拆墓碑的副作用是把这个检测器复活**。这符合 issue 意图(「抓的是真实数据不一致」→ 状态收敛型),但它是本单唯一「从不跑变成跑」的行为变化,要在 plan 的风险节和验收里显式点名。

### 发现 5:三处 outbox 的生产者不在删除清单 —— 只删消费者会造成「无界积压 + 零告警」

| 队列 | 生产者(继续写) | 消费者(本单删) | 裁定 |
| -- | -- | -- | -- |
| `runner_phase_wakes`(comm.db) | codex-phase-lifecycle.ts:382、flywheel-comm send.ts:133 / respond.ts:337、runner-wake.ts:152 | runner-receipt-patrol | 生产者是投递逻辑(D 单红线),**不动**;接受 pending 行积压,C 单合表 + D 单租约重投接管。PR 点名此已知行为变更 |
| `workflow_route_reminder_outbox`(StateStore) | runs-route.ts:3336 + StateStore.ts:17582 内联 INSERT | workflow-route-reminder-drain | 生产者本身就是「提醒」机制的一半,**同删**(生产+消费+accessors+DDL) |
| `lead_inbox.next_unprocessed_at` 等重发记账 | Lead 侧继续写 | lead-receipt-patrol(全仓唯一 `markUnprocessedReceiptEscalated` 调用者) | 字段属 C 单账本,**不动**;写了没人读是良性残留 |

另:`ExternalReceiptSaga` 的 `external_saga_unknown` 告警只有 lead-receipt-patrol drain —— 删后告警滞留 outbox,对账本体不受影响。接受为批 1→D 单之间的已知间隙,写进 PR。

## 2. 分集群切割细目

### 2.1 整文件删除(连同专属测试)

| 文件 | 行数 | wiring 拆除点 | 备注 |
| -- | -- | -- | -- |
| `bridge/runner-receipt-patrol.ts` | 522 | plugin.ts:527-530(import)、:7887-8108(构造闭包)、:8308(`await receiptWakePatrol.pass()` **仅此一行**) | ⚠️ :8301-8310 的 `onReceiptWakePatrolTick` 上还有 park outbox 投影 + terminal 收据结算两个保留对账,回调本体不能删;测试 runner-receipt-patrol.test.ts;e2e qa-fly-1392-receipt-foundation-e2e.mjs 同删 |
| `bridge/lead-receipt-patrol.ts` | 221 | plugin.ts:384-387、:8110-8299、:8309 | 删后回调只剩保留对账,改名 `onReconcilePatrolTick`(gate-poller.ts:326/328/695/1324/1412 + 契约测试同步);registry.ts:206-215 `receipt_activation_dry_run` 读点条目删(否则 feature-flags-registry.test.ts:284 红) |
| `bridge/lead-pending-escalation.ts` | 171 | gate-poller.ts:86-91(import)、:1037-1040、:1119-1136、:2041-2044、:2057-2246+、config :379 | StateStore.ts:32 type import + `lead_pending_escalation` 表 4 方法(:11062-11141)+ DDL(:3085-3096)同删;`seenLeadPendingQids`/`leadPendingPollComplete` 记账散布在与 FLY-605 founder relay 共用的循环里,逐处确认;watchdog-health.ts:70 `RETIRING_WATCHDOGS` 摘 "lead_pending_escalation";e2e qa-fly-695 同删 |
| `bridge/notify-digest-expect.ts` | 100 | plugin.ts:451-452(import,`defaultReceiptsPath` 随之孤儿)、:11310-11328 | ⚠️ bash 独立链路不动:token-usage-daily.sh:83 自发同 kind、lead-alert.sh allowlist、kind-contract.ts:178;notify-receipts.ts 的 `readNotifyReceipts` 变测试-only(写半边 reports-route.ts:44 保留) |
| `bridge/workflow-route-reminder-drain.ts` | 79 | plugin.ts:658、:8602-8612、:11422-11433(宿主 leadAlertDrainTimer 保留) | **生产者同删**(见发现 5);kind `workflow_route_input_rejected` 契约面一并清 |
| `bridge/inbox-loop-health-checker.ts` | 88 | plugin.ts:339-341、:6153-6164、:6299 | **前置:先把 `InboxLoopHealthTarget` + `inboxLoopStallMs` 搬进 watchdog-health.ts**(watchdog-health.ts:1 type-import + plugin.ts:4628 是保留面),顺序颠倒直接编译失败;w2_delivery_loop manifest 组件降级处理;comm.db `loop_heartbeat` 读半边(getHeartbeat)保留 |
| `bridge/stuck-runner-detector.ts` | 710 | plugin.ts:569,586,10923-10945;stuck-escalation.ts:46;RunnerIdleWatchdog.ts:29(type-only) | 生产 import 仅 3 处(2 处 type-only);测试 3 个文件同删 |
| `StuckWatcher.ts`(src/ 根) | 7 | 仅自己的测试 | GEO-157 @deprecated re-export shim,与 FLY-195 无关,纯删 |
| `bridge/detection-detector-wiring.ts` | 249 | plugin.ts:224-229;detection-reconcile-tick.ts:24-30 | 纯 wiring;残留:detection-escalation-sinks.ts describeKind 的死 case(gap/FN4/CASE_C 字面量)+ plugin.ts:7631 `progressResolvableKinds` 的 CASE_C 引用同步清 |
| `bridge/focused-frame-scheduler.ts` + `bridge/pane-frames.ts` | ~270 | plugin.ts:7286-7368(创建)、:7494(唯一调用,位于 gapScanTick 尾部) | 条件孤儿:gap-scan 铲掉 + LeadWatchdog multiFrame 删掉后无消费者;env FLYWHEEL_FRAME_* (truth.ts:239,241)同删 |
| `bridge/legacy-delivery-watchdog-policy.ts` | 12 | plugin.ts:391,3929 + `legacyDeliveryWatchdogsOn` 全部分支 | 墓碑机制本体;连带核查 lead-event-ack-policy.ts(纯转调,疑整文件孤儿) |

### 2.2 文件内手术(混合模块)

**`LeadWatchdog.ts`(1555 行,实际在 src/ 根)— 删面板哈希链,留 tick + W-4 blocked:**
- 删:`tickLead` 的 426-433(multiFrame 帧收集)、483-485(pane-hash recovery 分支,顺带修掉 blocked 同 kind 面板变化时的边缘误报)、546-612(isIdleHealthyPane 门 + veto1 `pane_error_stalled` + veto2 `fireSuspicious`)、614-626(3 轮 `pane_hash_stuck`)、628-630(Suspicious 态);`fireSuspicious`(772-802);`isIdleHealthyPane`(971-986)及专属常量 `WORKING_MARKERS`/`FROZEN_THINKING_RESIDUE`;`leadPaneLiveHash`/`leadPaneHasErrorSignature`(唯一消费者是 AlertChannelHub.ts:996-1015 两个待删分支);`titleFor`/`bodyFor`/`AlertEventType` 的两个 kind;config 字段 `paneHashAlertCycles`/`cooldownMs`(死字段)/`store`(死字段)/`suppressIdleHealthy`/`multiFrame`/`multiFrameMinSpanMs`/`onSuspicious`/`legacyDeliveryWatchdogsEnabled` 及 plugin.ts:11163-11164,11189,11200,11330-11344 对应注入;LeadState 的 `lastSuspiciousHash`/`lastAlertAtMs`;影子 env `FLYWHEEL_PANE_IDLE_SUPPRESS`
- 留:`scheduleNextStaggeredPoll` 10min 交错 tick(294-323)、`onPollComplete` 及其 9 个搭车对账、W-4 blocked 全链(classify→ownStateRegion→BLOCKED_KEYWORDS→2 轮确认→episode latch→FLY-218 短路→claims.db 去重→emitAlert/fireRecovery)、导出纯函数 `isSafeResumeMenuForEnter`/`isTransientThrottlePane`/`classifyLeadAlertPane`/`computeEventId`/`ALERT_ECHO_START`、`IDLE_READY_MARKERS`(被 isTransientThrottlePane:1094 用)
- 测试:LeadWatchdog-fly1048-multiframe.test.ts 整删;LeadWatchdog.test.ts / fly368 / fly927-acceptance / fly927-echo 按 case 精删(pane-hash/idle 组删,blocked/529/episode/echo 契约组留);fixtures 中 idle-*/error-stalled/frozen-extended-thinking 删,rate-limit/usage-limit/throttle-529/login-expired/freeze-* 留

**`founder-reply-watchdog.ts`(249 行)— 删 pass-dead + cursor-pin,留 unreachable-runner:**
- 删:pass-dead(常量 34-35、字段 65-68、notePassSuccess/Failure 82-94、checkHang 170-193、gate-poller.ts:637-644 钩子、:1149-1154 调用、env `FLYWHEEL_FOUNDER_REPLY_DELIVER`)、cursor-pin(PIN_THRESHOLD_MS:36、listFounderReplyRetries dep:39、resolveThreadRoute:46-48、pinAlerted:69、tick 200-230、gate-poller.ts:543-556 founderThreadRoutes + :3100,3152)
- 留:UnreachableEntry、begin/note/endUnreachableSweep(98-129)、emit()(131-163)、tick 的 unreachable 段(232-247)
- **接活改动**:gate-poller.ts:1210-1220 去 legacyWatchdogsEnabled 门;:3604-3605 `watchdogOn` 只看 `FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0"`;验证 runZombieGateHygiene(:3662-3663 注入点)照常执行
- `founder_reply_retry` 表不删(founder-reply-deliverer.ts:131 仍写;schema 归 C 单);测试 zombie-gate-watchdog.test.ts 按 describe 精删(560 unreachable 留),ask-hygiene-poller-wiring.test.ts 断言随 watchdogOn 改

**`auto-qa-coordinator.ts` — 删两个 codex-hold reconcile:**
- 删::749-826 `reconcileStuckCodexHolds`、:866-914 `reconcileCodexHoldNudges`、:833-864 `queueCodexNudgeIntents`(两删后孤儿)、:45 import;plugin.ts:8925-8942(boot)+ :11259-11274(onPollComplete);codex-gate.ts:31,34;StateStore `claimCodexHoldStuckNotify`(:8026)+ `stuck_notified_at` 写侧;founder-action-drain.ts:164,206,218 两个 codex_nudge_* kind 分支 + StateStore.ts:390-391;registry codex_hold_nudge 两条(:1509-1550)
- ⚠️ 别误删同名近亲 `reconcileCodexHolds()`(:2042-2074,FLY-827 重启补火,保留);`codexHold()`(:716-747)保留但 :711-714 注释要改;核查 auto-qa-effects.ts `alertCodexGateBlocked`(:551,589)是否变孤儿

**`stuck-escalation.ts`(724 行)/ `stuck-candidate.ts`(479 行)— 先搬保留符号,再删残余:**
- 从 stuck-escalation 搬走(8 个保留符号):`idleWatchdogPollMs`/`DEFAULT_IDLE_POLL_MS`(RunnerIdleWatchdog 轮询节拍,plugin.ts:3952,10949)、`stuckCommActivityMs`(plugin.ts:6058,7272 pane-confirm assembly)、`hasPendingGateFromCommDb`(AutoRepairBot :10459、receipt-nudge :7998、remanage-routes:47)、`hasPendingBlockingGateFromCommDb`(AutoContinueArmer :11038)、`probeDeclaredStateFromCommDb`(FLY-1329 boot sweep :6434)、`probeQuietSignals`(HeartbeatService+RunnerIdleWatchdog quietSignalsProbe :6057)、`UnhandledAlertSink`(gate-poller type)、`parseNonNegativeIntEnv` → 新模块 `bridge/commdb-probes.ts`(+cadence 常量可并入)
- 从 stuck-candidate 搬走(4 个):`fingerprintOutput`(AlertChannelHub/detection-wiring→删后仍有 runner-recovery-nudge、plugin.ts:7991)、`sigFingerprint`、`detectInputBoxPresent`(autocontinue-arming:88、runner-recovery-nudge Gate-4)、`isStuckEligibleStatus`(quiet-classifier:68)→ 新模块 `bridge/pane-fingerprint.ts`
- 删残余:检测判定(evaluateStuckCandidate 等)、升级发射(createStuckEscalationEmitter/createStuckUnhandledAlerter/buildStuckRunnerDetector)、env stuck_detect/stuck_founder_page 两条 retiring flag
- `STUCK_LATCH_TTL_MS` 随 remanage 路由 2 的去留定

**`stuck-remanage-routes.ts`(753 行)— 拆路由:**
- 留:路由 1 `POST /api/leads/:leadId/detection-ack`(FLY-1448 E3)、路由 3 `POST /api/sessions/:executionId/detection-ack`(FLY-1048 统一检测 ACK;:664-670 写 stuck_dispositions 的 CASE_C 镜像分支摘除)、路由 4 `recovery-nudge` 外壳(op 本体 runner-recovery-nudge 保留)
- 删:路由 2 `stuck-disposition`(唯一读者是被删 detector)
- `runner-recovery-nudge.ts` 保留;其对 stuck_dispositions 的写(:359,:390)删检测器后无读者,但牵动 disposition-receipt outbox 链 —— 单独一刀处理

**实施更正:`detection-escalation.ts` 及其 config/sinks/reconcile/gap/suspicious 全家整删。** `founder_decision_dropped` 改走既有 routed alert sink,不再借 detection 层。receipt 首次 writer 与 `listPendingReceiptAlerts` 驱动的旧 episode 回放 writer 同时消失;生产代码对 `StateStore.upsertDetectionEscalation()` 零调用。表与历史 receipt settlement/ACK 接口保留(不创建新行),满足不动 schema 红线。QA 不以送达时间判新增,用 `max(first_detected_at_ms)` + 未结无界 COUNT 斜率 + 基线后新 rowid 三指标,观察至少两个实测 3–12h 回放周期。

**`detection-reconcile-tick.ts`(333 行)— 只留 `runDetectionReconcileCohorts`(39-50):**
- 建议把 cohorts 壳内联进 plugin.ts:7699-7720(去掉 legacyEnabled/legacyPass 参数)后整文件删;FN4 lead_events 投递对账(132-227)随之物理消失 —— 今天字节路径没跑,非回归,PR 点名让 D 单知道要重建

**`detection-gap-scan.ts`(446 行)— 只留 `openGapReader` + 类型:**
- 留:openGapReader(299-446)+ OutboundSignal/GapCommEvidence(41-69)—— watchdog-judge-assembly.ts:25,289(保留链)的 park 证据源
- 删:evaluateGapSuspicion/createSuspicionRegistry/defaultGapThresholds(其 FN4 消费点 plugin.ts:7663 也在删除范围)等全部 gap 判定

**`detection-suspicious.ts`(270 行)— 整文件保留,零行删除**(watchdog-judge 全家的 DTO + 投递层);LeadWatchdog fireSuspicious 删除后它的上游只剩 judge 侧,注释更新即可。⚠️ stuck 全家删后核查 `routeSuspiciousReport`/`decideJudgeOutcome`(watchdog-judge.ts)是否变孤儿 —— judge 本体因 stuck-pane-confirm(保留)仍有消费者,不删。

**`plugin.ts` 的 mailbox 溢出扫描:**
- 删 :11361-11398(定义)+ :11476-11477(调用);宿主 leadAlertDrainTimer 保留
- **生产侧同删**:agent-team-transport/mailbox-prune.ts `updateOverflowMarker`(255-345)+ ClaudeMailboxCodec.ts:346,938,997 三个调用点 + `FLYWHEEL_MAILBOX_UNREAD_WARN` + mailbox-prune.test.ts:359-460 + MetaAlertReason 联合去 `"mailbox_overflow"`(否则留下无人消费的热路径磁盘写)

**`RunnerIdleWatchdog.ts` — 摘追人巷,保 W-1:**
- 删:config `stuckDetector`(:54)、:162-164 pruneInactive、:214-233 checkSession、waiting/unknown 巷(289-325)+ `waitingThresholdCycles`、`legacyDeliveryWatchdogsEnabled` 字段;`legacyDeliveryWatchdogsEnabled/watchdogLivenessEnabled` 双门简化为单门
- 留:poll 主体、idle 巷 + emitIdleEvent(W-1 收尸)、isReconnecting 抑制、quiet 抑制(FLY-626/637)、runnerQuotaScan 挂钩(1h 节流,quota/auth 扫描搭它的抓屏 —— 不是搭 LeadWatchdog)

### 2.3 墓碑铲除(gate-poller / watchdog-minimum-set / flag 真相层)

- misroute 巡逻:gate-poller.ts 内嵌全段(:128,138,167,175,1645-1790+,874-875,1080-1091)+ plugin.ts:6728-6746,8366-8369;下游 hook-payload misroute_* 渲染字段与 lead_events 数据不动(schema 红线)
- park-watch.ts:删 runParkWatch 等;`PARK_KIND_PREFIX`/`LEAD_ONLY_PARK_KINDS`/`parkFounderGraceMs` 的消费点(plugin.ts:7632-7644)在同删的 detectionReconcileTick 里 → 一并删;StateStore listParkWatchSessions/listParkWatchAutoQaRecords 孤儿同删
- delivery 对账:lead-event-delivery.ts 只删 `reconcile()` pass + plugin/gate-poller wiring;`deliver()`/ack token 函数保留(protocol-ingress 在用);legacy-ack-drain.ts **不删**(一次性 cutover 迁移工具,状态收敛型)
- zombie-gate-resolve 墓碑:gate-poller.ts:3596-3605 + `RETIRED_WATCHDOG_ENV_VARS`(watchdog-minimum-set.ts:8-11)+ `retiredWatchdogLaneEnabled`(39-44);watchdog-minimum-set 其余(W-1/W-2/W-4 三开关 + qaStallInboxLoopLead)保留
- flag 真相层:registry 6 条 `retiring: "FLY-1393"` flag(misroute_patrol/founder_reply_watchdog/zombie_gate_resolve/lead_pending_escalation/stuck_detect/stuck_founder_page_killswitch)→ 移入 truth.ts RETIRED_FLAGS;flag-truth.test.ts 同步;watchdog-health.ts 摘 `RETIRING_WATCHDOGS`/`buildRetiringWatchdogRows`/`retiring` 字段(w1-w4 REQUIRED 行不动)
- scripts 残留:qa-fly-1189-room-smoke.sh:92-93,135、qa-multilead.sh:405-420、test-deploy-multilead.test.sh:484-495、qa-fly-1282-zombie-replay.md 的 env 引用清理

## 3. 保留清单定位(验收标准 5 的验证底座)

| 保留项 | 位置 | 触发 | 与删除集群的耦合 |
| -- | -- | -- | -- |
| Bridge 主循环自杀 watchdog | bridge/BridgeEventLoopWatchdog.ts;构造 :8499,start :8505 | 自有双计时器(心跳 1s SharedArrayBuffer / worker 检查 5s / 60s SIGKILL) | 零 |
| RunnerIdleWatchdog W-1(idle 收尸) | src/RunnerIdleWatchdog.ts;:10950-11012 | 自有 3s setInterval(idleWatchdogPollMs —— 从 stuck-escalation 搬走的常量) | stuckDetector 注入摘除;quiet-classifier 保留 |
| runner 额度/登录扫描 | bridge/runner-quota-scan.ts + runner-auth-scan.ts;IIFE :10974-11008 | 搭 RunnerIdleWatchdog 抓屏,per-exec 1h 节流 | 依赖 LeadWatchdog 导出的 isTransientThrottlePane(保留) |
| 五个 reaper | crash(HeartbeatService tick)、chrome(自有 60s)、terminal-tab(boot 一次)、mcp-descendant(HeartbeatService maintenance + 事件)、viewer(boot 一次) | 各自独立 | 零 |
| QA 孤儿清扫 | auto-qa-coordinator sweepOrphanedQaRecords;:8320 onQaReconcileTick | GatePoller | 与被删的两个 codex-hold reconcile 同类但不同函数 |
| external-merge-reconcile | :6959,:8358;gate-poller patrol 档 ~60s | GatePoller | 零 |
| issue-gate-supersede / gate-materializer / land-executor / disposition-receipt | :8298/:8299/:8300/:8341-8348 | GatePoller 每 tick | 零 |
| workflow-engine park outbox + terminal-receipt-settlement | :8301-8310(与被删 patrol 同回调!) | GatePoller ~60s | 只删 patrol 两行,回调保留改名 |
| lease episode 对账 / lead 身份扫描 / leaseAuditOutbox / fleet-sensors / alertHub.reconcile | plugin.ts:11219-11259 | LeadWatchdog onPollComplete 10min | 宿主类保留(手术不摘 tick) |
| account-switch watchdog | :11274-11309(Bridge 侧已 dormant,FLY-1456 移交外部 daemon) | — | 验收「还在工作」= daemon 侧证据 |
| founder_decision_dropped 收敛 | gate-poller.ts:1200 → plugin.ts:8228 → notifyLeadFirst | GatePoller | 依赖保留的 detection-escalation 残余 |
| unreachable-runner 检测器 | founder-reply-watchdog.ts 232-247 + gate-poller 注入 | GatePoller(拆墓碑后复活) | 见发现 4 |
| watchdog-judge 全家 + stuck-pane-confirm | judge/judge-assembly/stuck-pane-confirm | HeartbeatService 心跳 tick | 依赖保留的 openGapReader、detection-suspicious |
| runner-recovery-nudge + AutoRepairBot | :10453-10455 | 事件驱动 | 依赖搬走的 detectInputBoxPresent/fingerprintOutput/hasPendingGateFromCommDb |
| lead_events dead-letter → founder page | :8613-8614 → createFounderPager | 事件驱动 | 依赖保留的 detection-escalation-sinks |

## 4. 孤儿判定汇总

| 模块 | 判定 |
| -- | -- |
| pane-live-region.ts | **不孤儿,保留**(blocked 链基座) |
| pane-frames.ts + focused-frame-scheduler.ts | 条件孤儿 → **删** |
| detection-escalation-sinks.ts / detection-config-source.ts / detection-suspicious.ts / watchdog-judge*.ts / quiet-classifier.ts / error-signatures.ts / runner-recovery-nudge.ts / disposition-receipt.ts | **保留**(活消费者) |
| lead-event-ack-policy.ts | 疑似整文件孤儿 → 实现时核查后删 |
| notify-receipts.ts readNotifyReceipts | 测试-only → 随测试处置 |
| auto-qa-effects.ts alertCodexGateBlocked | 疑似孤儿 → 核查后删 |
| StateStore:lead_pending_escalation 表 + 4 方法、claimCodexHoldStuckNotify、listParkWatch*、workflow_route_reminder_outbox accessors + DDL | 孤儿 → 删代码(已建 DB 里的表原地留,不跑迁移 —— 「删代码不删数据」) |

## 5. 需要向 Lead 报备的边界修正(相对 issue 原文)

1. `stuck-pane-confirm.ts` 误列,不删(发现 3)
2. `stuck-escalation.ts` / `stuck-candidate.ts` / `stuck-remanage-routes.ts` / `detection-escalation.ts` / `detection-gap-scan.ts` / `detection-reconcile-tick.ts` 是**拆**不是**删**(各托管保留侧共享符号/活接口)
3. unreachable-runner 检测器会从「墓碑关死」变为「真的在跑」(发现 4)
4. FN4 投递对账代码随 detection-reconcile-tick 物理消失(本来就没跑,D 单重建)
5. `runner_phase_wakes` pending 行在批 1→C/D 之间无人推进(发现 5)

## 6. 删除顺序(每刀独立可编译、可测)

1. 零风险孤立件:StuckWatcher.ts、workflow-route-reminder-drain(+生产者)、notify-digest-expect、mailbox 溢出扫描(+生产侧)
2. 搬迁刀:stuck-escalation/stuck-candidate 保留符号 → commdb-probes.ts / pane-fingerprint.ts;InboxLoopHealthTarget+inboxLoopStallMs → watchdog-health.ts(纯搬迁,零行为变更)
3. stuck 集群主刀:detector/candidate/escalation 残余 + RunnerIdleWatchdog 摘巷 + remanage 路由 2 + auto-qa 两 reconcile
4. patrol 双刀:runner-receipt-patrol、lead-receipt-patrol(+回调改名)、lead-pending-escalation、inbox-loop-health-checker
5. 墓碑刀:misroute → park-watch → gap-scan(保 openGapReader)→ delivery reconcile → legacy-delivery-watchdog-policy + 全部 legacyDeliveryWatchdogsOn 分支 + zombie-gate 墓碑段
6. LeadWatchdog 手术 + founder-reply-watchdog 手术(墓碑删掉后死支路显式暴露,顺序放墓碑后)
7. 孤儿收尾:pane-frames/focused-frame-scheduler、detection-detector-wiring、lead-event-ack-policy 核查、sinks 死 case
8. flag 真相层收尾 + scripts 残留 + 文档(lead-rules-base/stuck-runner-remanage.md、runner-patrol-rules.md 引用、lead-rules-bundle.test.ts:117 断言)

## 7. 验收 rg 谓词(验收标准 1 的机器形式)

```
rg "runner-receipt-patrol|lead-receipt-patrol|lead-pending-escalation|notify-digest-expect|workflow-route-reminder-drain|inbox-loop-health-checker|stuck-runner-detector|StuckWatcher|evaluateStuckCandidate|buildStuckRunnerDetector|reconcileStuckCodexHolds|reconcileCodexHoldNudges|checkMailboxOverflowMarkers|updateOverflowMarker|pane_hash_stuck|pane_error_stalled|fireSuspicious|isIdleHealthyPane|misroutePatrol|runParkWatch|evaluateGapSuspicion|runDetectionReconcileTick|resolveRecoveredDetectionTargets|legacyDeliveryWatchdogsOn|retiredWatchdogLaneEnabled|RETIRED_WATCHDOG_ENV_VARS|checkHang|notePassSuccess|FLYWHEEL_PANE_IDLE_SUPPRESS" --type ts
```
预期:只剩 truth.ts RETIRED_FLAGS 的墓碑字符串与本 doc 文件夹。
