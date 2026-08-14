# FLY-1560 拆掉 v1 看门狗全家 — 调研(代码级审计定稿)

Issue: FLY-1560 (https://linear.app/geoforge3d/issue/FLY-1560/b方案阶段1-拆掉-v1-看门狗全家-逐个拆线回归1-2-天)
日期: 2026-08-14
基于: exploration.md

> 审计基线:worktree `flywheel-FLY-1560` @ main(post FLY-1570/1571/1572/1573/1574/1687)。
> 三路并行代码审计(Runner 侧 / Lead 侧 / 残留清单)+ 生产库、生产进程 env 实测。
> 起点数字:`grep -ril watchdog packages/teamlead/src` = **91 文件**(36 个在 `__tests__/`,55 个生产文件)。

## 1. 判定总表(本单的删/留/搬/改名裁定,逐条带证据)

| # | 对象 | 裁定 | 一句话依据 |
| -- | -- | -- | -- |
| 1 | `RunnerIdleWatchdog.ts`(448 行) | **删** | idle 检测零自动消费者,纯噪音(§2);额度/登录扫描搭车件搬家(§4) |
| 2 | `LeadWatchdog.ts`(1229 行) | **拆三份后删本体** | 面板监视本体删;文案注册表 + 纯识别函数 + tick 载体三样是别人的地基(§3) |
| 3 | `runner-status.ts` 的 `applyStallWatchdog` + `STALL_THRESHOLD_MS` | **删** | 45 秒 pane 指纹不变 ⇒ 降级 executing→waiting 的纯超时推断引擎(§2.1) |
| 4 | `account-heal/account-switch-watchdog.ts` | **删** | FLY-1456 硬常量 `runAccountSwitchWatchdog: false`(quota-daemon-cutover.ts:19)永久关死,结构性死代码 |
| 5 | `lead-backends/codex/LeadHealthProbe.ts` | **删** | 30 分钟静默推断 = stuck-detection 形态;verdict 无任何生产消费者行动(死端 API,§5.3) |
| 6 | `lead-event-ack-policy.ts` 死脚手架 | **删(冻结值内联)** | `legacyLeadWatchdogEnabled()`/`deliveryAckEnabled()` 硬编码 return false;FLY-1570 §3.8 冻结的常量行为内联到调用点 |
| 7 | `HeartbeatService.ts`(2736 行) | **整体保留,只改注释** | 不是看门狗:Bridge 唯一的收尸/对账调度器,9 项职责无第二驱动(§5.1) |
| 8 | `BridgeEventLoopWatchdog.ts` | **保留行为,改名** | 盯自己进程的事件循环、挂死自杀由 launchd 拉起;真存活探测,救过命(sql.js 主循环卡死 10 分钟 Discord 黑洞) |
| 9 | `bridge/founder-reply-watchdog.ts`(unreachable-runner) | **保留行为,改名** | 真实数据不一致检测(session LIVE 但 CommDB 登记行没了),证据型非猜测型;FLY-1570 QA 正面注入验证过 |
| 10 | `watchdog-health.ts` + `watchdog-minimum-set.ts` + `/health` manifest | **契约重塑 + 改名** | 跨包外部契约(config truth / check-flag-truth CI / bridge-liveness-probe.sh),§6 |
| 11 | `LeadAlertNotifier.ts` + `AlertChannelHub.ts` + FLY-927 票据机 + `lead-alert.sh` | **不动(1764 地盘)** | 通用告警传输,57 个生产文件 import;watchdog 只是众多生产者之一(routedAlertSink 有 ~15 个非-watchdog 调用点) |
| 12 | `patrol-tick.ts`(1687)/ `turn-wake-patrol.ts` / `stuck-remanage-routes.ts` / `ticket-escalation.ts` | **不动** | 分别是:巡检闹钟 / 耐久 outbox 排水 / detection-ack HTTP 路由 / FLY-927 纯策略函数 —— 名字误导,行为都不是追人 |
| 13 | 7 个已无发射器的死事件 kind | **顺手清理(渲染面按 1570 姿态保留)** | `session_stuck`/`runner_stuck_escalation`/`runner_lead_pending_escalation`/`detection_suspicious`/`detection_escalation`/`detection_fleet_aggregate`/`detection_page_undeliverable` |

## 2. Runner 侧:RunnerIdleWatchdog 解剖

### 2.1 今天只剩一条检测巷 + 一个搭车座

- **idle 巷(W-1)**:`checkSession()`(:177-271)每 tick 对每个 `running` session `tmux capture-pane`,尾 3 行命中裸 shell 提示符(`IDLE_PATTERNS`,runner-status.ts:52-55)才发 `runner_idle_detected`。tick = `idleWatchdogPollMs()` **3 秒**(commdb-probes.ts:30-36)—— 这就是 founder 看到的每天 43 条的来源。
- **它不收尸**:从不 `applyTransition`、不杀 tmux、不碰 CommDB;`unknown`(tmux 不可达)直接 return(:241-245)。测试钉着这个行为(runner-idle-watchdog.test.ts:210/:245/:432)。**收尸 100% 是 HeartbeatService 的活**。
- **`applyStallWatchdog`**(runner-status.ts:127-163):pane SHA-256 指纹 45 秒(`STALL_THRESHOLD_MS`,:103)不变 ⇒ 把 `executing` 降级成 `waiting`,理由字符串就叫 "stall watchdog"。纯超时推断,零进程证据 —— issue 原文点名的「timeout 推断」本体。
- **搭车座**:同一次抓屏喂给 `runnerQuotaScan`(1 小时/session 一次,`claimRunnerQuotaScan` :321-331)。

### 2.2 `runner_idle_detected` 的消费者 = 没有(机器侧)

全仓非测试代码恰好 3 处引用:发射器自己两处 + `lead-runtime.ts:22` 的 `GUARDRAIL_EVENT_TYPES` 成员。
- event-route 无路由、EventFilter 无规则(落 default normal)、无 Discord/auto-page/founder 通路、无 FSM 反应。
- 终点消费者 = **Lead(LLM)读信箱**。即:系统花 3 秒/次 × 每 runner 的抓屏,产出一条只有 LLM 会看的 FYI。
- `GUARDRAIL_EVENT_TYPES` 成员资格已是死重:FLY-1570 删掉了 HeartbeatService 的 lead-event 重投循环,`getUndeliveredLeadEventsForReconcile`(StateStore.ts:14011)**零生产调用者** —— 重试语义已由 FLY-1573 mailbox 租约/死信接管。

### 2.3 替代件(已在 main)

| 旧职能 | 今天的替代 |
| -- | -- |
| 「叫 Lead 看一眼 runner」 | FLY-1687 patrol-tick(名册 + mailbox settlement,per-Lead 60 分钟,GatePoller `onLeadPatrolTick`) |
| 「runner 退到 shell 了,是不是停了」 | FLY-1571 stop 通知(Stop/StopFailure hook + Codex notify,O_EXCL marker)—— **runner 自己交代事实**,不再从提示符猜 |
| 「runner 进程死了要翻状态」 | HeartbeatService crash-reaper / zombie / reapOrphans(保留,§5.1) |
| 「丢消息要重发」 | FLY-1573 租约原地重投 + 死信闸(生产 48h `mailbox_dead_letter` 78 条,真在岗) |

### 2.4 删除半径

- 编译断点:仅 plugin.ts(:126-128 import、:9595-9657 构造/start、:10051 stop)。
- DB:`quiet_wake_notified` 表**存活**(FLY-1204 `fly1204_orphan_parked` 还写),只有 `source='idle'` 行与 `pruneQuietWakeNotifiedNotIn`(StateStore.ts:11842 唯一调用者)变死。
- 测试:4 个专属文件(651+257+243+141 行)删;flag registry 测试 `quiet_persist_dedup` readSite 断言改。
- **硬阻塞 = `/health` w1 契约**:`watchdogTrackers.liveness` 唯一驱动者是本文件(:132/:172)。裸删 ⇒ w1 行永久 `not_started` 却仍报 `wired:true` = 假健康面。见 §6 的契约重塑。
- `FLYWHEEL_WATCHDOG_LIVENESS` flag 有**第二个活消费者**:GatePoller `staleApprovedShipReconcilePass`(gate-poller.ts:126/:2920,发 `stale_approved_ship_dead`)—— flag 语义保留,名字随 §6 改。

## 3. Lead 侧:LeadWatchdog 是三个东西,不是一个

### 3.1 删的部分(面板监视本体)

- 交错定时器(10min/N per Lead,:219-248)、pane 抓屏(:327)、`classify()` 4 kind 发射(`rate_limit`/`usage_limit`/`login_expired`/`permission_blocked`,:139-155/:584-595)、pane-hash 变化检测 + stuckCycles(:366-386)、冷却签名(:389-398)、episode 状态机、`emitAlert`(:441-522)、`watchdogBlockedEnabled` 门(:347-352)。
- 删掉后这 4 个 kind **不消失**:runner 侧扫描(§4)与 `scripts/lead-alert.sh` 仍可产;死的只是「Lead 面板猜测」这条发射路径。
- Lead 自己的额度/登录事实由**外部 quota daemon** 覆盖:`quota-revive-scan.ts:459-550` 自带 `tmux list-panes` 枚举,窗口正则显式含 `…-lead`,分类 `quota_stuck`/`login_expired` —— 且它有 usage API 直读(`quota-usage-api.ts`),比抓屏猜强一档。

### 3.2 必须先搬出去的三样地基(不搬 = 编译断/跨语言契约断)

1. **全 kind 文案注册表**:`titleFor`/`bodyFor`/`severityFor`(:764-1229)覆盖整个 `AlertEventType` union(~110 kind),LeadWatchdog 自己只发 4 个。历史行渲染 + LeadAlertNotifier 队列渲染都用 → 搬新家(alert 文案模块)。
2. **`computeEventId`**(:573-582):与 `scripts/lead-alert.sh:418` **跨语言字节对齐契约**(sha1(project|lead|kind|signature))→ 搬家 + 更新脚本注释指向。
3. **三个纯识别函数**(有 watchdog 之外的活消费者):
   - `isTransientThrottlePane`(FLY-1218 529 识别,:664-762)→ `runner-quota-detector.ts:9,23` 定为硬边界、plugin.ts:9621 注入 runner 扫描
   - `classifyLeadAlertPane`(:603-605)→ AlertChannelHub.ts:26/:955 恢复判定用
   - `isSafeResumeMenuForEnter`(:607-639)→ rescue runtime(plugin.ts:8852,rescue.ts:126)
   - 另有 `CaptureFn` 类型被 lead-alert-helpers.ts:24 引用;`ALERT_ECHO_START` 真身已在 pane-live-region.ts:85(re-export 而已)

### 3.3 tick 载体上的 6 个 rider(全部在 plugin.ts:9854-9931,各自独立 try/catch)

| rider | 分类 | 去向 |
| -- | -- | -- |
| `reconcileLeaseEpisodeQueue()`(:9856) | 状态收敛 | 搬 GatePoller |
| `leadIdentityMonitor.tick()`(:9863) | 外部事实(进程证据) | 搬 GatePoller |
| `leaseAuditOutbox.materialize()`(:9870) | 状态收敛 | 搬 GatePoller |
| `fleetSensorsHolder.current?.tick()`(:9881) | 外部事实(swap 压力/infra-bot 探针/**zombie-scan**) | 搬 GatePoller,**必须保持在 hub reconcile 之前**(plugin.ts:9876-9879 写明依赖) |
| `alertHub.reconcile()`(:9889) | 状态收敛(FLY-927 票据生命周期) | 搬 GatePoller,fleet sensors 之后 |
| `accountSwitchWatchdogTick()`(:9902) | **死代码** | 随 #4 删(FLY-1456 硬 false 门) |

> **最大的隐藏依赖**:`zombie_session_backlog`(生产 48h 42 条)/ `swap_pressure_high` / `infra_bot_down` 三个 fleet 传感器的 tick 宿主就是 LeadWatchdog `onPollComplete`(fleet-sensors.ts:3 写明「piggybacked on the LeadWatchdog onPollComplete tick,零新 timer,FLY-169 规范」)。**裸删载体 = 静默弄死 FLY-1082 堵 OOM 盲区的那套传感器。** 搬家是本单成败线。
> 另:`onRecovery` 实时钩子(plugin.ts:9841-9845 → alertHub.onLeadRecovery)随载体死;`AlertChannelHub.ts:757-758` 写明 reconcile 才是真相源,损失仅为线程 resolve 延迟到下一次 reconcile。

### 3.4 GatePoller 是现成的搬家目的地

GatePoller(3 秒基 tick,`everyNTicks` 机制现成)已经承载 10+ 个 rider:QA 孤儿清扫(plugin.ts:7511)、external merge 对账(:7528)、gate supersede(:7447)、patrol tick(:7450)…… 新增一个 `onLeadReconcileTick`(everyNTicks≈200 ≈ 10 分钟,保持今天节奏)挂上表中 5 个 rider,顺序保持:lease → identity → outbox → fleet sensors → hub reconcile。

## 4. 额度/登录扫描:车死,人不能死

- `runner-quota-scan.ts`(104 行,FLY-169「不加新 timer」的搭车件)+ `runner-auth-scan.ts`(FLY-871 登录失效巷)在 plugin.ts:9616-9650 合成一个闭包,唯一调用点 = RunnerIdleWatchdog.checkSession :201。
- 消费链是活的:quota → `usage_limit` alert + `shouldWakeQuotaDaemon` 发 SIGnal 给外部 daemon(quota-daemon-wake.ts:29-37);auth → `runner_login_expired`(AlertChannelHub.ts:772-773 用 **runner** pane 重抓判恢复)+ `recordAuthHealth` 账本。
- quota 巷与外部 daemon 部分冗余(daemon 有 usage API + 自己的 pane 枚举),**auth 巷是不冗余的那条**。
- `resolveQuotaDaemonBridgeMode().runRunnerQuotaScan: true` 硬编码 —— Bridge 侧扫描仍是正编制。
- **去向**:GatePoller rider(everyNTicks=20 ≈ 60 秒扫一轮 running sessions,沿用现成的 1h/session claim 门),自带 capture-pane(成本 = 1 次/时/session,与今天相同;死掉的只是 3 秒一次的 idle 抓屏)。

## 5. 出界保留区(逐个说清为什么不是看门狗)

### 5.1 HeartbeatService(2736 行)= Bridge 的收尸/对账调度器

单一 `setInterval`(5 分钟)上的 `check()` 依序跑:zombie 告警补账 → 监控丢失对账/重收养(FLY-172)→ 舰队 tmux server-loss(FLY-1082/1285)→ crash-reaper(pane_dead 收尸)→ reapOrphans(60 分钟无心跳强制 failed)→ 陈旧 terminal 关闭(FLY-867)→ parked-phase 回收(FLY-1204,OOM 修复)→ maintenance tick(残渣收割 FLY-1066/pane-loss FLY-1628/MCP 孤儿 FLY-1185/launch-claim GC/project sweep —— **没有第二个调度者**)。
每一项都真改状态、真收资源,没有一项是「猜你卡没卡然后催」。裸删 = 孤儿永不终态、尸体堆积、OOM 事故回归、重启后活 runner 全部搁浅。**FLY-1570 已把它的 stuck 部分(checkStuck/onSessionStuck)删干净**(fly1570-watchdog-teardown.test.ts:49 钉着)。
本单对它:行为零改动;仅 4 处注释提词(:287/:289/:1362/:1484)改写。founder 快照点它的名 —— 用上面这段证据回答:**它挂着旧时代的名声,干的是新时代设计里也必须有人干的活**。

### 5.2 通用告警传输(1764 地盘,边界铁律)

`LeadAlertNotifier.ts`(57 个生产文件 import)、`AlertChannelHub.ts`(FLY-927 票据生命周期,仅 2 处 watchdog 耦合:classifyLeadAlertPane import 与 capturePane 腿,前者随 §3.2 搬家解耦,后者另有 rescue/hub 消费者)、alert-bot-chain / alert-rate-limiter / infra-alert-wiring / drained-alert-routing、`scripts/lead-alert.sh`(Bridge 独立的第二写路径,16+ 个非-watchdog kind)。
`routedAlertSink`(plugin.ts:9208-9224)有 ~15 个非-watchdog 调用点。**删发射器,不删邮路** —— 邮路怎么改是 FLY-1764 的设计讨论。

### 5.3 例外:LeadHealthProbe 虽在 lead-backends,但判「删」

它做的是「in-flight turn 双源静默 >30 分钟 ⇒ unhealthy」—— 正是 issue 点名的 timeout 推断形态;且 `healthProbe()` verdict **无任何生产消费者行动**(无告警、无重启,codex-lead-runtime.ts:59/1552/1789 与 TUI runtime 只是暴露 API)。删 = 零行为变化的死代码清理 + 少一个披着健康外衣的 stuck-detector。Codex Lead 崩溃发现依然有:launchd KeepAlive(进程死自动拉)+ FLY-1687 巡检 + 死信闸。实施时先复核「verdict 确无行动方」再动刀。

### 5.4 三个「还在响」的事件,查明后两个不在拆除范围

| 事件(48h 实测) | 发射器(今天) | 判定 |
| -- | -- | -- |
| `runner_idle_detected` 62 条 | RunnerIdleWatchdog(唯一) | **随本单死** |
| `inbox_loop_stalled` 109 条 | 三个 post-1570 生产者:patrol 失灵 sink(plugin.ts:7423)/ Codex 传输 stall(:7772)/ Discord mailbox stall(:7827)—— 全是**真投递失败证据**,kind-contract 定为 `founder_direct` | **不拆**(它是新机制的故障告警;吵不吵是 1764/1687 调参问题)。文案在 LeadWatchdog.ts 里 → 随 §3.2 搬家 |
| `zombie_session_backlog` 42 条 | fleet-sensors `zombieTick`(FLY-1066 三态实证,「indeterminate 永不算 zombie」) | **不拆**,tick 宿主搬家(§3.3) |

## 6. `/health` 健康面契约重塑(跨包,一刀内闭合)

现状:`watchdog-health.ts` 产 `watchdogs` manifest(w1_process_liveness / w2_delivery_loop / w3_external_drift / w4_lead_blocked,schema_version 1);消费方 = `truth.ts:414-495`(REQUIRED_WATCHDOG_ROWS + validateWatchdogManifest,config 包公开导出)、`scripts/check-flag-truth.ts`(CI 门)、`scripts/bridge-liveness-probe.sh:116-212`(外部 ops 探针,断言 4 行俱在,缺了 page Discord)。

重塑方案:
- 顶层 key `watchdogs` → `liveness`,schema_version 1 → 2;行名不含 watchdog,保持不变
- **w4_lead_blocked 随 LeadWatchdog 删除而移除**(驱动者死了,行留着就是假健康面 —— FLY-1570 §3.10 W-2 同款教训)
- **w1_process_liveness 换真实驱动**:tracker started/completed 改由 HeartbeatService.check() 打点(它才是真的 process-liveness 机器)—— 行语义从「idle 巡逻新鲜度」变为「收尸对账新鲜度」,manifest 行注记同步改
- w2(delivery loop,leads[] durable heartbeat 驱动)、w3(external drift)不动
- `bridge-liveness-probe.sh` 同 PR 更新:`(.liveness // .watchdogs)` 双读兜底,消灭部署窗口(git pull 后、Bridge 重启前)的假 page;probe 契约测试两态覆盖
- `REQUIRED_WATCHDOG_ROWS`/`validateWatchdogManifest` 更名重导出(config 包公开 API,检查外部消费者后一次性切,不留旧别名 —— repo 内消费者全量改)

## 7. env / flag 处置(FLY-1570 §3.13 同款纪律:不许无痕消失)

| env/flag | 现状 | 处置 |
| -- | -- | -- |
| `FLYWHEEL_WATCHDOG_BLOCKED`(watchdog_blocked) | LeadWatchdog 唯一门 | 随刀死 → RETIRED_FLAGS(retiredBy: FLY-1560) |
| `FLYWHEEL_WATCHDOG_LIVENESS`(watchdog_liveness) | 双消费者:W-1 tracker + GatePoller stale-approved-ship | 语义保留、改名(如 `FLYWHEEL_LIVENESS_ALERTS`);旧名 → RETIRED_FLAGS;生产 .env 未设(实测) |
| `FLYWHEEL_FOUNDER_REPLY_WATCHDOG` | 活开关 default-on | 随模块改名换新名;旧名 → RETIRED_FLAGS;生产 .env 未设 |
| `FLYWHEEL_BRIDGE_WATCHDOG` + `_STALL_MS`/`_HEARTBEAT_MS`/`_LOG` | 活开关 default-on | 随模块改名换新名;旧名 → RETIRED_FLAGS;生产 .env 未设 |
| `FLYWHEEL_WATCHDOG_MANIFEST_*` 4 个(probe 侧) | bridge-liveness-probe.sh 读 | 脚本内改名(scripts/ 不在验收 grep 范围,但同 PR 保持一致) |
| `FLYWHEEL_IDLE_POLL_MS` | idle 巡逻节奏 | 随刀死 → RETIRED_FLAGS |
| 生产 .env `FLYWHEEL_WATCHDOG_JUDGE=0`(:131) | judge 已被 FLY-1570 删除,纯残留 | ship 窗从 .env 清除(运维步,不阻塞) |

## 8. 验收「grep 零命中」的可达性核算

91 文件命中分层(残留审计定稿):
- (i)家族模块本体 8 个 → 删 6 / 改名 2(BridgeEventLoopWatchdog、founder-reply-watchdog)+ 契约重塑 2(watchdog-health、watchdog-minimum-set 并入新家)
- (ii)接线 4 个(plugin.ts 93 处、gate-poller.ts 19 处、run-infra.ts 1 注释、commdb-probes.ts 1 函数)→ 随刀清
- (iii)顺带提及 39 个文件 → 注释/字符串提词改写(其中 2 处是**用户可见 Lead 提示词**:hook-payload.ts:508 `[ESCALATION] Watchdog detected:`、:526 `[SUSPICIOUS] Watchdog quiet FYI` —— 历史行渲染文案,改词安全);真代码标识符另清:lead-backend.ts `partitionLeadsForPaneWatchdog`、codexLeadBridgeWiring.ts `paneWatchdogProjects`(随 LeadWatchdog 死)、bridge-exit-marker.ts 一族(随改名)、fleet-data.ts watchdog membership 段(消费者核后随刀清)
- (iv)家族测试 12 文件 → 删/随改名迁移;(v)顺带提及测试 23 文件 → 提词改写
- (vi)fixture 1 个(`lead-panes/idle-product-lead.txt`,里面存着 founder 对 runner_idle_detected 不可靠的原话抱怨)→ 验收明文豁免

**申报的唯一非-fixture 例外**:拆除守卫测试(扩展 `fly1570-watchdog-teardown.test.ts` 的形态)必须以字符串点名已删文件/符号才能断言「不存在」—— FLY-1570 QA 已有先例判「执法机制本身,非残留」。做法:守卫测试改名为不含 watchdog 的文件名(如 `fly1560-teardown-guard.test.ts`),**内部的被删名字符串按 fixture 同等地位在 PR body 申报豁免**;不搞字符串拼接混淆(那是作弊)。

跨包(验收 grep 范围外,但不许留死引用/假话):
- edge-worker `Blueprint.ts:2313` 提示词「the watchdog uses that exact id as the consumption receipt」→ 改词(收据消费者早已是 GatePoller 黑洞巡检,FLY-208)+ 快照更新(fly1188 snap :37);:2702 注释改
- flywheel-comm `declare-state` 4 处注释(park 抑制 stall-watchdog 唤醒的历史动机)→ 改词,命令本体照留(quiet-classifier 还在消费)
- `scripts/lead-alert.sh:13,418` 注释指向 LeadWatchdog.ts → 指向 computeEventId 新家
- lead-rules-base 运营规则里的 `runner_idle_detected`/watchdog 提法(runner-patrol-rules.md:45 等)→ 改写,Lead 规则不许引用已死事件

## 9. 拆完后的世界(诚实边界,写给验收和 founder)

**没了的**:① 3 秒/次的 runner 面板 idle 巡逻与它每天几十条的 FYI;② Lead 面板 blocked 猜测(usage/rate/login/permission 四 kind 的 pane 路径)及其全部误报史(FLY-1218 529 误判、FLY-1220 回声风暴那一族);③ Codex Lead 的 30 分钟静默推断;④ runner 状态里的 45 秒 stall 降级;⑤ 账号切换的 Bridge 侧尾巴。

**换成的**:runner 停了自己说(1571)/ 信没送到队列自己重投、投不动进死信打包给 Lead(1573,**ship 前置:生产开关翻 1**)/ Lead 到点巡检名册自己看(1687)/ 进程死了 HeartbeatService 收尸(不变)/ 额度登录事实归 quota daemon + 搬家后的 runner 扫描。

**残余盲区(如实)**:进程活着但癔症式卡死(不退 shell、不撞额度、hook 没触发)在巡检间隔(默认 60 分钟)内无人主动发现;Lead 卡在权限弹窗这类非额度非登录的 blocked 状态无自动检测。这两条是 FLY-1569 §7/§8「出口把门替代看门狗」方向下 founder 已拍板接受的形态;F(Action List)/ G(Stop hook)落地后进一步收窄。
