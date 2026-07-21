# FLY-1393 看门收编 — 调研(证据卷)

Issue: FLY-1393 (https://linear.app/geoforge3d/issue/FLY-1393/foundation看门收编-watchdog-最小集落地-开关真值修复-关掉的检测按-1391-四条清单收编假开关拆除1392-之后)
日期: 2026-07-21
基于: exploration.md

> 本文是证据卷:exploration.md 的每条裁定倾向在这里给 file:line。凡标 unverified 的,plan.md 不得给确定裁定。
> **Provenance**:代码事实指向本分支工作树(`flywheel-FLY-1393`,HEAD `91817ec80`,与 main 同源);
> 运行事实 = 2026-07-21 活 Bridge 进程(pid 36285,`ps eww` 阳性对照 59 个 `FLYWHEEL_*` 变量,与 FLY-1391 快照条数一致)。
> FLY-1391 已核事实直接引用不重查;本文的增量核查两条来源:① 本单 Explore 子代理 code audit(11 问,行号逐条与 1391 对表,
> 漂移已标)② 本 Runner 亲手 grep/读码(§1 全部、§3 的 env 残留、§6 的 confirm 层)。

## 0. 一句话结论

> 病灶不是「有 watchdog 被关了」,是**开关拓扑说谎**:一个 legacy 总闸压死了七个巷,其中六个巷各自的
> per-lane flag 在 registry 里显示 default_on;另有两个 env 变量是已退役 flag 的尸体;一个活 flag 未注册;
> 一条**真正在岗且今晚刚触发**的 stuck 巷反而**没有任何开关**。收编 = 让「哪些在岗」重新可查,再按 1391
> 四条清单归位。

## 1. 【Tadashi 钉死项】今晚 FLY-1395 两次 session_stuck 的门控真相

问题:Confirm-Note = repeated_error_signature 的 session_stuck 告警由什么门控?
「FLYWHEEL_STUCK_ERRORSIG=1 灰度」的口径是否成立?

**结论:不成立。完整链条(全部本 Runner 亲核):**

| 环节 | 事实 | 证据 |
|------|------|------|
| 发射巷 | `HeartbeatService.checkStuckInner` — heartbeat 主链的 stuck 安静路径:`store.getStuckSessions(thresholdMinutes)` = status=running + `last_activity_at` 停滞超阈值,纯 DB,无 pane 证据 | `HeartbeatService.ts:1857-1861`;主链调用 `:685` |
| 该巷的开关 | **没有专属 feature flag**。不在 legacy 闸内(全文件仅 `:596`/`:701` 两处 legacy 闸,分别是 guardrail 重投与 gate_timed_out,与此无关);唯一前置是 `runLivenessChain = livenessOwner \|\| !zombieOn`(`:633`)—— liveness 所有权条件,单 Bridge 生产恒真,非 flag | `HeartbeatService.ts:596, 701, 633, 684-685` |
| 抑制器(非开关) | tmuxHeld / monitorSuppressed / zombieHeld / episode dedup / FLY-626 quiet 抑制 | `:1884-1901` |
| Confirm-Note 来源 | FLY-1234 确认层 emit reason `repeated_error_signature` = 「两帧同一 normalized 错误签名 = 高置信卡死,不经 judge」 | `stuck-pane-confirm.ts:124`(enum)、`:157-158`(prose)、`:217-219`(emit) |
| 确认层的开关 | `FLYWHEEL_STUCK_PANE_CONFIRM !== "0"`(**call-time 读**,default_on;registry `stuck_pane_confirm` :1536-1543)—— 注意它管的是「emit 前做不做 pane/process 确认」,**不是**告警巷的总闸;关掉它 = 回到无确认的 legacy 直发,告警**更多**不是更少 | `HeartbeatService.ts:1853-1855, 1906` |
| judge 步 | 确认层 step ③ 走 FLY-1048 共享 `routeSuspiciousReport`;`FLYWHEEL_WATCHDOG_JUDGE === "1"`(call-time,生产 =0)→ judge 不可用时 fail-open emit(`judge_unavailable`) | `plugin.ts:6522`;`stuck-pane-confirm.ts:161-164` |
| `FLYWHEEL_STUCK_ERRORSIG` 的角色 | **零关系**。FLY-1243 已退役(固化 default-on),生产代码零读取(仅存注释);它生前门控的是**另一条** error-sig 巷 —— `stuck-candidate.ts` `evaluateStuckCandidate`(focusedFrames/gap-scan 簇成员,整簇被 legacy 总闸压死,见 §4.2) | `stuck-candidate.ts:313`(注释);读取点全仓 grep 零命中(本 Runner 亲跑,阳性对照:同 grep 模式能命中注释行) |

⇒ **修正后的口径**:今晚的告警来自「无开关的 heartbeat 安静路径 + FLY-1234 确认层拿到了两帧同签名的正面卡死证据」。
env 里的 `FLYWHEEL_STUCK_ERRORSIG=1` 是尸体残留,什么也不门控 —— **假开关病最有力的展品**:
founder 被按一个死开关的名义解释了一次真告警。
(已于 2026-07-21 经 flywheel-comm ask --report 提前回报 Tadashi,question id 3b6b5993。)

**对本单分类的影响**:session_stuck 巷 + FLY-1234 确认层是**1391 审计没盘到的活跃 W-4 巷**(runner 侧
「活着但干不了活」),且自带 false-positive 硬化(确认层 = FLY-1234 对 2026-07-13 5/5 误报事故的治理)。
初稿把 `stuck_pane_confirm`/`watchdog_judge` 划进死簇随簇退役是**错的**,已更正(§2 表)。

## 2. 收编分类表(定稿,逐行带证据)

> 归属判据 = `watchdog-minimum-set.md §0`;「退役」全部走**先禁后删两拍**(Tadashi gate 裁定③):
> 批 1 禁 + tombstone + soak,批 2 在 1392 替代语义检查单通过后删码删 flag。

### 2.1 W-1 存活(保留;告警巷接回,独立开关)

| 组件 | 现状 | 证据 | 目标态 |
|------|------|------|--------|
| `probeRunnerProcessLiveness` 四态基元 | ✅ 在跑 | `bridge/tmux-lookup.ts:371-401` | 不动,不设开关(被回收类消费者共用) |
| HeartbeatService 五态 `probeSessionLiveness` + 「仅肯定 alive 才刷 heartbeat」守卫 | ✅ 在跑(`zombie_reconcile` default_on,非 legacy) | `HeartbeatService.ts:1217-1236, 1240-1265, 1286, 1595-1625`;registry:3195-3204 | 不动;守卫必须保留(minimum-set §3.5) |
| 探测消费者:crash-reaper / phase-orchestrator / terminal-thread-archive / done-thread-reconcile / codex-phase-shutdown / generalized-launch-recovery / lifecycle-closeout | ✅ 在跑,**全部零 legacy 依赖**(Explore 逐文件 grep 核) | `crash-reaper.ts:14`、`phase-orchestrator.ts:328`、`terminal-thread-archive.ts:137`、`done-thread-reconcile.ts:294`、`codex-phase-shutdown.ts:152`、`lifecycle-closeout.ts:1159` 等 | 不动 |
| fleet 级 tmux server-loss 协调器 | ✅ 在跑(`fleet_sensor_tmux` default_on) | registry:2667-2676 | 不动 |
| **RunnerIdleWatchdog `idle` 发射巷** —— `idle` 语义 = 「tmux 窗口活着但 Claude 进程没了(bare shell)」,即**进程死亡的人可见告警** | ❌ legacy 闸死:`:257` 在状态机与 `emitIdleEvent` 之前 early-return | `RunnerIdleWatchdog.ts:257`(闸)、`runner-status.ts:9-21`(四态分类)、`emitIdleEvent :413-496`(发 `runner_idle_detected` 给 owning Lead) | **移出 legacy → 新独立开关(W-1)**;capture 与 runnerQuotaScan 本就不受闸(`:223-236`),不动 |
| G-1 `stale_approved_ship_dead`(founder 已批 + runner 已死,仅 console.warn + 无人读审计行) | ⚠️ 零人类触达 | `gate-poller.ts:3844-3866`(FLY-1391 已核,本单不重查) | 接线到统一告警频道(修法=接已有记录到人能看见的巷,非补记录) |

### 2.2 W-2 投递循环心跳(保留;外部探针补一个维度)

现状四层(全部在跑):

| 层 | 机制 | 证据 |
|----|------|------|
| in-Bridge checker | per-Lead `loop_heartbeat` 表(`lead_id/last_started_at/last_success_at/stall_episode_at`)由消费循环写;`InboxLoopHealthChecker.check()` 按 episode latch 发 `inbox_loop_stalled`(默认 stall 阈值 10min,启动 grace 5min);挂在 HeartbeatService maintenance tick(**非 legacy 闸**);告警经 routedAlertSink→统一频道(kind-contract owner founder_direct) | `lead-inbox-queue.ts:45-50, 92-97, 730-755, 764-812`;`inbox-loop-health-checker.ts:20, 43-79`;`plugin.ts:5527-5531, 5647, 9058`;`LeadAlertNotifier.ts:297`;`kind-contract.ts:107` |
| Bridge event-loop 自看门 | `BridgeEventLoopWatchdog`:主循环写 SharedArrayBuffer 心跳,worker 线程检查,>60s 停滞 → SIGKILL 自身 → 把「挂死」转化为 launchd 可重生的「崩溃」;`bridge_watchdog` default_on | `BridgeEventLoopWatchdog.ts:35, 69-140, 138, 227-230, 249-274`;registry:1575-1582 |
| launchd KeepAlive | Bridge 进程死亡自动重生 | `~/Library/LaunchAgents/com.flywheel.bridge.plist`(KeepAlive=true,本 Runner 亲核) |
| **外部探针(独立 failure domain,FLY-1082,1391 未提)** | `bridge-liveness-probe.sh`:launchd StartInterval 60s、**部署在 Codex Infra Bot 的 launchd 域**(「nobody rescues their own side」)、curl /health、连续 5min 不通 → episode-latched 单条 @Annie(读 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` :44 + `FLYWHEEL_FOUNDER_DISCORD_USER_ID` :45)、恢复单条 all-clear | `scripts/bridge-liveness-probe.sh:2-15, 43-45, 50, 65-83, 89-92, 101-111`;`scripts/launchd/com.flywheel.bridge-liveness-probe.plist:49-51` |

**精确残余缺口**:in-Bridge checker 挂在 HeartbeatService tick 上 —— HeartbeatService tick 卡死而 event loop
与 HTTP 仍活(如 tick 内 await 悬死)时,投递循环卡死无人报;外部探针只探 /health 通不通,看不见这一形态。
⇒ 目标态 = /health 加 watchdog manifest(请求时**现读 DB**,不依赖任何 in-Bridge tick)+ 探针加一个检查维度,
复用既有 episode-latch/频道/去重。

**G-13 已修**(1391 research §6.2 引用的 FLY-915 文档行陈旧):`lead-alert.sh:244` 读
`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(FLY-927,统一频道优先级最高 `:313-323`),且生产 `~/.flywheel/.env`
里 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 与 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 都已设(本 Runner 亲核),
脚本每次运行 source .env。⇒ 只需验收实测。
(shell-only 告警 kind 仅剩 `companion_config_error`/`external_config_error` 两种 —— Explore 全仓 cross-check。)

### 2.3 W-3 外部世界漂移(盘点确认在岗;不设开关、不造新巡检)

| 成员 | 形态 | 证据 |
|------|------|------|
| verify-approval `pr_head_sha` 校验 | inline guard(merge authority 机制,**可关反而是安全洞**) | FLY-1391 已核(`architecture-current.md` W-3 行),不重查 |
| `gh pr checks` CI 探针 | inline guard(approve gate 前置) | 协议文本(Runner 提示词)+ 既有流程 |
| `isArchivedThreadError`(Discord 50083) | inline guard(仅改名路径;发言路径不检查 = G-16,归 1388/1392,不在本单) | `ChatThreadCreator.ts:80-85`(1391 已核) |
| runnerQuotaScan(配额监控) | RunnerIdleWatchdog 的搭车任务,**不受 legacy 闸**(仅要求 capture 成功) | `RunnerIdleWatchdog.ts:223-236` |
| 账号 auth 过期检测 | LeadWatchdog blocked-keyword 巷的 login_expired 类(见 §2.4)+ codex 侧自检 | `LeadWatchdog.ts` BLOCKED_KEYWORDS |
| account-switch / cmux pane-died hook | 圈外在跑(FLY-1373 定案) | FLY-1373 plan §7(原文引用) |

⇒ W-3 的「落地」= 上表进 plan 的盘点清单 + 验收在岗抽验(head 漂移拒 ship / 归档错误处理),**零新代码**。

### 2.4 W-4 活着但干不了活(保留;一个独立开关罩全 W-4;去留呈 Annie)

W-4 实际有**三个子巷**(1391 只盘到第一个):

| 子巷 | 现状 | 证据 | 目标态 |
|------|------|------|--------|
| **Lead 侧 blocked-keyword 巷**(rate_limit/usage_limit/login_expired/permission_blocked)+ 三硬约束:episode-latch(`state.episodeKind :461, 446-449, 374`)、ownStateRegion 回声免疫(`:359, 386, 749, 819, 893-895`)、isTransientThrottlePane 529 短路(`:435-438, 951-`) | ✅ 在跑,**不受 legacy 闸**(`:561-567` 的抑制名单只含 pane_hash_stuck/pane_error_stalled 两种) | `LeadWatchdog.ts` 上列各行;`pane_idle_suppress` registry:1491-1498 | 保留;归入 W-4 独立开关 |
| **Runner 侧 session_stuck 巷 + FLY-1234 确认层**(§1 全链)| ✅ 在跑(今晚刚触发,行为正确:两帧同签名 = 真卡死证据) | §1 | 保留;归入 W-4 独立开关(现状**无开关**,违反 minimum-set §4,收编时补) |
| **冻结巷**:pane_hash_stuck / pane_error_stalled(`:561-567`)+ 多帧 suspicious 报告巷 fireSuspicious(`:519-526`) | ❌ legacy 闸死 | `LeadWatchdog.ts:519, 561-567` | **保持退役 → 批 2 删码**(Tadashi gate 已预同意「尸体没人想复活」);漏报由 1392 30min 升级兜 |

W-4 附属(保留,不动):`stuck_pane_confirm`(确认层开关,关=告警更多)、`watchdog_judge`(judge 步 opt-in,
生产 =0 诚实关,judge 不可用时确认层 fail-open)、`pane_idle_suppress`(误报抑制层)。

### 2.5 投递类 → 退役(先禁后删;每行绑 1392 替代语义,见 §5)

| 组件/巷 | 闸点 | per-lane flag(现状真值) | 1392 替代语义 |
|---------|------|------------------------|--------------|
| misroute 捞回 | `gate-poller.ts:1012`;transport/archiveDir 同闸 `plugin.ts:7077-7080` | `misroute_patrol` registry:991-998 default_on(**双闸病**) | 入队时拒绝未知收件人(target §6) |
| lead-pending 催办+升级+清理 | `gate-poller.ts:1881, 1054, 3594(Z2 合取)` | `lead_pending_escalation` registry:1810-1817 default_on(双闸病) | processed_at 超时 → §3/§4 升级(连带 G-18 P3 错位一起消失) |
| founder-reply-watchdog(hang 检查 + detector tick + Z2) | `gate-poller.ts:606, 1133, 3594` | `founder_reply_watchdog` registry:1282-1289 default_on(双闸病) | 收据 + 重发闭环 |
| delivery-ack / redeliver / dead-letter 腿 | `plugin.ts:4280, 4329`;`lead-event-ack-policy.ts:13, 21` | (并入 legacy 合取) | 队列内建(target §3/§5) |
| HeartbeatService guardrail 5min 重投腿 | `HeartbeatService.ts:596` | — | 队列重发 |
| HeartbeatService `gate_timed_out`(FLY-191 review 超时) | `HeartbeatService.ts:701`(emitter `:735`,event `:797-812`,POST `:814`) | — | 无收据超时升级 |
| gap-scan / detection-reconcile / park-watch / delivery-reconcile 四 tick | `plugin.ts:7016-7018, 7019, 7039, 7049-7051`(legacy 三元,off → undefined 永不调) | `park_watch` registry:3096-3104 default_on(双闸病);gap-scan 与 detection-escalation 的 flag 已被 FLY-1243 退役(仅注释 `plugin.ts:6619, 6707, 6842, 6908`) | 缺口=无收据,队列自见 |
| FLY-195/FLY-818 StuckRunnerDetector 簇(detector + stuck-escalation founder page) | 两个馈送口全 legacy 闸:`RunnerIdleWatchdog.ts:202`(+prune `:149`)与 `plugin.ts:6637`(仅 gapScanTick `:6832` 可达)⇒ **生产零馈送,episode 永不推进** | `stuck_detect` registry:2102-2109 default_on + `stuck_founder_page_killswitch` registry:2646-2655 default_on(读点 `stuck-escalation.ts:54, 480`)——**双闸病×2** | 卡死的终态表现 = 无收据 → 30min 升级;W-4 活巷(§2.4)已覆盖「有 pane 证据的卡死」 |
| checkpoint-park 巡检(1h patrol) | `gate-poller.ts:2103-2105`(`=== "1"`,独立 opt-in,生产 =0) | **未注册 flag** `FLYWHEEL_CHECKPOINT_WATCHDOG`(仅 drift 测试引用 :268) | processed_at 超时 |
| Z1 僵尸门清理 | `zombieGateResolveEnabled()`(非 legacy;生产 env=0 诚实关) | `zombie_gate_resolve` registry:1302-1309 default_on,env 覆盖为 0 | 门被答 → 判据满足 → 自动销账 |
| AlertChannelHub **T2 按年龄升级腿**(G-15 缺陷所在;当前唯一在跑的升级腿) | ✅ 在跑(`reconcile` 30s,非 legacy) | FLY-1391 §11.1(不重查) | 收据驱动升级;**退役必须押 1392 升级闭环在岗证明**(Tadashi gate 裁定④) |

### 2.6 在岗不动(非投递类,盘点标注)

`lead_dual_active_scan`(FLY-1309 身份完整性)· AlertChannelHub T1(建工单/告警线程/路由)· auto-QA ·
AutoRepairBot · runner-recovery-nudge(其 5 道活状态闸 `runner-recovery-nudge.ts:178-230` 是 G-15 修法范本,留作 1388 参照)·
complete-marker-reconciler(~~W-5~~,MQ 崩溃语义旁路补偿,1392/后续吸收)。

## 3. 开关真值病理(定稿,四形态)

| 形态 | 实例(全部 2026-07-21 活进程实测) | 证据 |
|------|-------------------------------|------|
| A. 陈旧 env 残留(flag 已退役,零读取) | `FLYWHEEL_DETECTION_GAP_SCAN=1` · `FLYWHEEL_STUCK_ERRORSIG=1` | 读取点全仓 grep 零命中(仅注释 `plugin.ts:6619,6707` / `stuck-candidate.ts:313`);FLY-1243 plan 记录退役 |
| B. 真·假开关(有读取,组件不可达) | `FLYWHEEL_STUCK_FOUNDER_PAGE=1`(读 `stuck-escalation.ts:480`,但 detector 生产零馈送,§2.5) | `plugin.ts:9357-9374`(构造)+ 两馈送口全闸 |
| C. 双闸(per-lane flag default_on,legacy 总闸压死) | `misroute_patrol` / `founder_reply_watchdog` / `lead_pending_escalation` / `park_watch` / `stuck_detect` / `stuck_founder_page_killswitch` 六个 | §2.5 各行 |
| D. 未注册活 flag | `FLYWHEEL_CHECKPOINT_WATCHDOG`(活读 `gate-poller.ts:2104`,registry 缺席) | Explore Q1 [DRIFT];drift 测试仅 :268 引用 |
| (反向)无开关活巷 | session_stuck 发射巷(§1)—— 「显示关不掉的在跑」与「显示开着的没跑」是同一病的两面 | §1 |

**现有工具的缺口**(检查脚本要补的维度):FLY-709 drift test(`feature-flags-drift.test.ts`)正向 =
「新 gate 必须注册」、反向 = 「注册的 flag 在声明文件里真的被读」—— 但**不验可达性**(形态 B 漏过)、
**不验 env 残留**(形态 A 漏过;NON_FLAG_ALLOWLIST 只管代码里出现的变量)、形态 D 之所以漏是 allowlist/测试引用
挡住了正向扫描。registry(FLY-709)有 readSites/timing 基建可借;**无 tombstone 概念**(FLY-1243 的退役 = 直接删定义)。

## 4. 与 FLY-1392 的接口(运行事实更正)

- **1392 实际状态(Tadashi gate 裁定①)**:design 已 codex-APPROVED(5 轮 19 条),implement 进行中(Codex 后端)——
  Linear status=Backlog 是陈旧的。⇒ 批 2 的检查单核对对象是**已落 main 的 1392 实现**,批 1 ship 前 rebase 含 1392 的 main。
- 替代语义映射(检查单母表)= §2.5 第四列;plan.md 把它落成逐条可勾的验证项。

## 5. unverified 清单(plan.md 不得基于这些给确定裁定)

1. `stuck_pane_confirm` / `watchdog_judge` / `pane_idle_suppress` 之外,是否还有其它组件消费 StuckRunnerDetector 的
   产物(episode 表 / remanage routes)—— **批 2 删簇前需全量消费者 grep**(`stuck-remanage-routes.ts` 未盘)。
2. 今晚两次 session_stuck 是否为真阳性(FLY-1395 runner 当时真卡死了吗)—— 本文只证明了**门控链**与
   confirm-note 语义,没验证该次告警的事实正确性;不影响分类,但 W-4 决策 brief 引用今晚案例时要标注。
3. `runner_idle_detected` 重新接线后的下游消费(Lead 收到后的处置路径)在 1392 收件箱语义下的形态 ——
   属 implement 期与 1392 对齐项。
4. ~~bridge-liveness-probe.sh 是否已在生产 launchd 实际加载~~ — 实施前确认未部署，随后 Lead 已完成安装并提供 `runs`/`last exit code`/连续 tick 证据，见下方「实施期部署补证」。
5. G-1 接线的具体巷(LeadAlertNotifier kind 选择)—— plan 给方向,implement 定 kind。
## 实施期部署补证(2026-07-20)

- 实施前 `launchctl print gui/501/com.flywheel.bridge-liveness-probe` 返回 not found：FLY-1082 的脚本与 plist 模板曾经只有仓库骨架，没有部署到真实用户域，不能算 W-2/W-3 在岗。
- Lead 已补齐部署：plist 安装到 `~/Library/LaunchAgents/com.flywheel.bridge-liveness-probe.plist`（0600），`launchctl bootstrap gui/501` 成功，`launchctl print` 显示 `StartInterval=60`、`runs=2`、`last exit code=0`，日志连续两个 tick 为 `ok`。
- 部署时 FLY-913 restart guard 曾把“新 LaunchAgent 安装”误判为“服务重启”；后续检查必须区分 install/bootstrap 与 restart，不能让防重启 guard 阻断首次安装。

## Watchdog 谁做 / 什么频率 / 怎么发现

> **生产实值，调整以此表为准。** 2026-07-20 Annie 裁定：检测巷价值在「会发现」，不在「秒级发现」，并追加确认「even run every 10 min is OK」。Lead W-4 从历史拍脑袋的 30s 调整为默认 10min；多 Lead 按一轮 10min 等分错峰，双帧观察窗仍保持 `2 × poll` 语义。
> 代价也显式记账：FLY-368 restart-safe alert-thread reconcile 搭车每轮完成回调，因此 Bridge restart 后
> 缺少实时 recovery hook 的线程恢复，最坏同样延迟到 10min；这是本轮 cadence 裁定的已知后果。

| 巷 | 谁做 | 什么频率 | 怎么发现 | 开关 / 调参变量 |
|---|---|---|---|---|
| W-4 Lead blocked | `LeadWatchdog`（Bridge 内） | 每个 Lead 默认 10min；多 Lead 错峰，不齐步扫 | 终端 blocked 关键词 + 双帧观察窗（`2 × poll`） | `FLYWHEEL_WATCHDOG_BLOCKED`（默认开）；`FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS`（默认 `600000`） |
| W-4 Runner blocked | `HeartbeatService`（Bridge 内） | `TEAMLEAD_STUCK_INTERVAL` 默认 5min | 台账 `TEAMLEAD_STUCK_THRESHOLD` 默认 15min 无活动列为疑似，再由 FLY-1234 确认层取得双帧正面证据才发 `session_stuck` | `FLYWHEEL_WATCHDOG_BLOCKED`（默认开）；`TEAMLEAD_STUCK_INTERVAL=300000`；`TEAMLEAD_STUCK_THRESHOLD=15` |
| W-1 Runner 存活 | `RunnerIdleWatchdog`（Bridge 内） | 默认 3s 轮询 pane；搭车 quota/auth classifier 独立保持 1h | legacy 总闸关闭时只保留 `idle`/裸 shell 存活异常；`waiting`、`unknown`、冻结检测不发告警；token-expensive classifier 不随 3s 放大 | `FLYWHEEL_WATCHDOG_LIVENESS`（默认开）；`FLYWHEEL_IDLE_POLL_MS`（默认 `3000`） |
| W-2 / W-3 外部兜底 | 独立 launchd `com.flywheel.bridge-liveness-probe`（今晚已部署） | `StartInterval=60s` ping `/health` | `/health.ok` 连续失败 5min 直接 page founder；Bridge 可达时另验 `watchdogs` schema/wiring、retiring 全 OFF、W-3 `observation=static_contract` 与逐 Lead loop freshness；manifest rollout grace 从探针首次连续 invalid 观察起算，不误用 Bridge uptime；支持的 kill switch 立即提醒、默认每日复提醒、重开 all-clear，且不遮其它巷；down 期间冻结 degraded/stalled，避免盲清 | `FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN`（默认 `5`）；`FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN`（默认 `5`）；`FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN`（默认 `3`）；`FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN`（默认 `2`）；`FLYWHEEL_WATCHDOG_DISABLED_REMINDER_MIN`（默认 `1440`）；Bridge 内 `FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT`（默认开） |
