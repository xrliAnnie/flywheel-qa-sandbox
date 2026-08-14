# FLY-1560 拆掉 v1 看门狗全家 — 实施计划

Issue: FLY-1560 (https://linear.app/geoforge3d/issue/FLY-1560/b方案阶段1-拆掉-v1-看门狗全家-逐个拆线回归1-2-天)
日期: 2026-08-14(R1 修订同日 —— Codex Round 1 五项全采纳)
基于: research.md

## 1. 目标与非目标

**目标**:物理删除 FLY-1570 之后仍存活的看门狗家族(RunnerIdleWatchdog、LeadWatchdog、stall 降级引擎、account-switch-watchdog 死尾、LeadHealthProbe、ack-policy 死脚手架),把搭在它们身上的**非看门狗职能**(对账 rider、额度/登录扫描、告警文案注册表、纯识别函数、健康面契约)逐一搬到诚实的新家;对两个「行为必须留、名字必须死」的模块(Bridge 主循环自杀器、unreachable-runner 对账器)做行为零变化改名。终态:`grep -ri watchdog packages/teamlead/src` 零命中(fixture 与守卫测试点名字符串按 §5.1 申报豁免)。

**非目标(红线)**:
- ❌ 不加任何 feature flag(FLY-1570 同款纪律;回滚 = revert PR)
- ❌ 不动 mailbox / 投递循环 / 死信闸的任何投递逻辑(FLY-1572/1573/1574 资产)
- ❌ 不动通用告警传输(LeadAlertNotifier / AlertChannelHub / FLY-927 票据机 / lead-alert.sh / infra-alert-wiring)—— FLY-1764 地盘;本单只删发射器、只做解耦性搬迁
- ❌ 不碰 HeartbeatService 的任何行为(收尸/对账调度器,出界;仅注释提词 + R1 新增的 W-1 打点回调注入)
- ❌ 不做 F(task 表)/ G(stop hook)/ legacy push 旁门
- ❌ 不动 schema、不删数据、不跑迁移

## 2. 关键裁定(R1 修订后)

1. **删除对象六件**:RunnerIdleWatchdog.ts(idle 巷零自动消费者)、LeadWatchdog.ts 本体(拆三份后)、runner-status.ts stall 推断引擎(§3 刀 4 全符号清单)、account-switch-watchdog.ts(FLY-1456 硬 false 门后死代码)、LeadHealthProbe.ts(30min 静默推断 + verdict 死端)、lead-event-ack-policy.ts 死脚手架(冻结常量内联)。
2. **改名保留两件**:BridgeEventLoopWatchdog(自我存活,launchd KeepAlive 依赖它把挂死转成可重启的崩溃)、founder-reply-watchdog(unreachable-runner 真实数据不一致对账)。改名是行为零变化的符号手术,每一项在 PR body「保留行为清单」逐条申报。
3. **rider 搬家的运行时契约(R1 修订 #3)**:新建 `runLeadReconcilePass()`,GatePoller `onLeadReconcileTick`(everyNTicks≈200)调用:
   - **pass 级 single-flight**(参照 patrol 的 `reconcilePatrolPass` 防重叠形态,gate-poller.ts:532-551/1039-1050):慢 pass 未结束时后续 tick 直接跳过,不重入
   - **五段各自 try/catch 错误隔离**(保持 plugin.ts:9846-9895 现状语义):任一段抛错不饿死后续段
   - **固定顺序**:lease episode → identity monitor → lease audit outbox → fleet sensors → hub reconcile(sensors 必须在 hub 前,plugin.ts:9876-9879 明文依赖)
   - **首 tick 语义显式声明**:GatePoller `(tickCount-1)%N` 会在首 tick 触发(旧宿主是完整 fleet cycle 后首跑)—— 接受「启动即跑一轮对账」,PR body 申报为已知行为变化(对账类幂等,提前跑无害)
4. **额度/登录扫描搬家**:GatePoller rider(everyNTicks=20),自带 capture,1h/session `claimRunnerQuotaScan` 门不变。
5. **文案/契约搬迁**:titleFor/bodyFor/severityFor → 新 `bridge/alert-kind-copy.ts`;`computeEventId` → 同新家(与 lead-alert.sh:416-430 四字段 `project|lead|kind|signature` 字节对齐);纯识别函数(isTransientThrottlePane / classifyLeadAlertPane+BLOCKED_KEYWORDS → `bridge/pane-blocked-classifier.ts`;isSafeResumeMenuForEnter → rescue.ts);CaptureFn → lead-alert-helpers.ts。
6. **`/health` 契约重塑**:key `watchdogs`→`liveness`、schema_version 1→2、w4_lead_blocked 随驱动者删除、w1_process_liveness 换真实驱动(见裁定 7);probe 与所有 evidence 消费者统一 `(.liveness // .watchdogs)` 双读。
7. **W-1 打点契约(R1 修订 #2,R2 修订 #3 补消费端)**:打点包在**真正拥有 liveness 职能的 span** 上 —— `reconcileMonitorLoss → reapOrphans` 段,而非 `check()` 首尾(check() 在 liveness chain 被 single-flight 卡住时会跳过该段仍正常返回,HeartbeatService.ts:529-575/623-655 —— 首尾打点会假 fresh)。tracker 升级为 **pass token/generation 语义**:被跳过的 tick 不得刷新 completed,旧/并发 pass 不能替仍挂起的 owner 清 in-flight;新增负测「owner 挂住 + 后续 tick 跳过 ⇒ 仍 in_flight/stale」。W-1 行报 `effective_enabled: true`、`switch: "required"`;`FLYWHEEL_WATCHDOG_LIVENESS`→`FLYWHEEL_LIVENESS_ALERTS` 后**只描述 stale-approved-ship 告警 lane**(gate-poller.ts:2919-2921),registry 描述同步改写。
   **消费端契约(R2 #3:诚实的 hung 状态必须有人消费,否则外部 probe 永远 GREEN)**:tracker cadence 显式取 Heartbeat 真实 `config.stuckCheckIntervalMs`(plugin.ts:6382-6387 构造位点),不再沿用被删的 `idleWatchdogPollMs()`;schema v2(刀 6)把 W-1 的 operational contract 写进验证与探针 —— `fresh` 才是健康,`not_started` 只允许 Bridge boot grace 期,`stale` 或超阈值 `in_flight_age_ms` 必须让**现有** liveness probe 进入 degraded(不建新路由);`validateLivenessManifest` 字段完整性检查、probe 健康判定、两 schema 兼容测试同步;新增**接收端测试**:hung owner ⇒ probe degraded/page,新 generation 完成 ⇒ 恢复(不只断言 manifest 快照)。
8. **W-1/W-4 四个 blocked kind 不从 union 删**(runner 扫描与 lead-alert.sh 仍产);KIND_CONTRACTS 穷尽 Record 姿态照 FLY-1570 §3.11 不变。7 个已无发射器的死 kind 渲染面按 1570 姿态保留 legacy 注释。
9. **onLeadRecovery 实时钩子随载体死**:AlertChannelHub.ts:757-758 明文 reconcile 是真相源,损失 = 线程 resolve 延迟 ≤ 一个 reconcile 周期,PR body 申报。
10. **env/flag 纪律**:被删/改名 env 一律 truth.ts RETIRED_FLAGS(retiredBy: FLY-1560);生产 .env 实测未设任何将改名 env;`FLYWHEEL_WATCHDOG_JUDGE=0` 残留列 ship 清单。
11. **实施前置复核只剩一条**(R1 修订 #4 收窄):LeadHealthProbe verdict 确无行动方(发现有 → 停,改「保留+改名」并报 Lead)。createStatusQuery/applyStallWatchdog 的消费面已在本轮评审中闭合(见刀 4),不再留给开工时发现。

## 3. 实施步骤(7 刀,每刀独立编译 + 独立 commit + 定向回归)

删除型 TDD 形态(FLY-1570 §4 同款):每刀 = ①先跑该刀涉及**保留项**的既有测试(GREEN 基线)→ ②动刀 + 按符号处置测试 → ③保留项测试仍 GREEN + `pnpm -r build` → ④commit。保留项测试变红即停,不许靠删保留测试过关。

### 刀 1 · 搬迁(纯移动,零行为变化;R1 修订 #1:测试按符号拆迁,不整文件判死)
- 代码搬迁:同原案 —— titleFor/bodyFor/severityFor + computeEventId → `bridge/alert-kind-copy.ts`;classify/BLOCKED_KEYWORDS/classifyLeadAlertPane + isTransientThrottlePane 及 4 张 marker 表 → `bridge/pane-blocked-classifier.ts`;isSafeResumeMenuForEnter → rescue.ts;CaptureFn → lead-alert-helpers.ts;ALERT_ECHO_START re-export 消灭(直接 import pane-live-region.ts:85)。改 import:AlertChannelHub.ts:26、lead-alert-helpers.ts:24、plugin.ts:100-104。lead-alert.sh:13,418 注释指向新家。
- **测试按符号拆迁(keep-list,刀 3 禁删)**:
  - `LeadWatchdog.test.ts` 中:文案函数 case(:77-92)→ alert-kind-copy 测试;生产 computeEventId 的 signature/project 绑定 case(:341-350)→ 同上;529 classifier 完整夹具(:469-595)→ pane-blocked-classifier 测试
  - `LeadWatchdog-fly368.test.ts:42-74`(classifyLeadAlertPane / isSafeResumeMenuForEnter)→ 迁至各自新家测试
  - `LeadWatchdog-fly927-acceptance.test.ts`(整文件 = isTransientThrottlePane PRD 验收)→ 整体迁 pane-blocked-classifier
  - `LeadWatchdog-fly927-echo.test.ts`(回声免疫↔kind 表 parity)→ 迁 pane-live-region/alert-kind-copy 名下
  - **(R2 #4 补)`quota-ignition-red-lines.test.ts:35`**(直接 import `isTransientThrottlePane`)→ 改 import pane-blocked-classifier,列 keep-list;**`bridge/__tests__/alert-rate-limiter.test.ts:5`**(直接 import `ALERT_ECHO_START`)→ 改直接 import `pane-live-region.ts` —— 两者纳入刀 1 GREEN 清单,避免中途红
- **重写 `eventIdParity.test.ts`(R1:现版是空心证明)**:直接 import 搬家后的生产 `computeEventId`,按四字段 `projectName|leadId|kind|signature` 与 shell 公式(lead-alert.sh:416-430)对照,含特殊字符往返与字段差异负例(任一字段不同 ⇒ id 不同)。
- 验证:重写后 parity 测试 GREEN + 全部迁移测试 GREEN + `rg "from ['\"].*LeadWatchdog"` 只剩 plugin/生命周期测试(刀 3 删)。

### 刀 2 · rider 搬家 + 死尾清除(原子 commit)
- 实现 §2.3 的 `runLeadReconcilePass()` + GatePoller `onLeadReconcileTick`(everyNTicks≈200);同 commit 摘除 plugin.ts:9854-9931 onPollComplete 注册。
- 删 `accountSwitchWatchdogTick` rider + `account-heal/account-switch-watchdog.ts` + 测试 + `quota-daemon-cutover.ts` `runAccountSwitchWatchdog` 字段(含 quota-daemon-cutover.test.ts:9);**同步更新 `scripts/qa-fly-1252-quota-state-e2e.sh:346-354`**(它精确断言该字段为 false —— 断言对象消失,脚本改断言字段不存在/模式收缩,R1 #4)。
- 删 `onRecovery` 钩子(plugin.ts:9841-9845);AlertChannelHub.onLeadRecovery 无其它调用者则删。
- 新增测试(R1 #3):①注册唯一性(GatePoller 恰一次,onPollComplete 零);②顺序断言(sensors 在 hub 前);③cadence 等价(N≈200×3s≈10min)+ 首 tick 触发申报;④**逐段失败隔离**:前四段各自注入抛错,断言后续段仍执行;⑤**重叠防护**:deferred promise 卡住慢 pass,断言下一 tick 跳过不重入。
- 验证:fleet-sensors / lease episode / identity monitor / hub reconcile 既有测试 GREEN。

### 刀 3 · LeadWatchdog 本体 + W-4 契约(同刀闭合)
- 删 `LeadWatchdog.ts` + **仅生命周期/发射路径专属测试 case**(交错定时器、pane-hash episode、emitAlert、cooldown 等;刀 1 keep-list 一条不许动)+ plugin 接线(:9802-9936、blockedLead flags/trackers、:4111、:9933)。
- 删 pane-membership 链:`partitionLeadsForPaneWatchdog`(lead-backend.ts:68)、`paneWatchdogProjects`(codexLeadBridgeWiring.ts:83)及测试;**`loadProjectLeadRoles`/`resolveLeadBackendFromRoles`/`isPaneBasedLeadBackend` 逐个核消费者 —— 仅当确认只服务 pane membership 链时随删**(R1 #4 点名,实施时以 rg 全量消费者清单为准,核查结果记 PR body);fleet-data.ts「Watchdog membership」段(:869-912)核 Fleet console 消费面后删/收缩。
- `watchdog-minimum-set.ts` 摘 `watchdogBlockedEnabled`;registry `watchdog_blocked` → RETIRED_FLAGS。
- 同刀契约收口:manifest 摘 w4_lead_blocked(watchdog-health.ts + truth.ts REQUIRED_WATCHDOG_ROWS + check-flag-truth.ts + bridge-liveness-probe.sh w4 断言 + probe 契约测试)—— schema 仍 v1、key 仍 watchdogs(改名归刀 6)。
- 验证:AlertChannelHub 全测试 GREEN、刀 1 迁移测试 GREEN、probe 契约测试 GREEN、`pnpm -r build`。

### 刀 4 · RunnerIdleWatchdog + stall 引擎 + W-1 换驱动(同刀闭合;R1 #2/#4 展开)
- 扫描搬家先行:GatePoller rider(everyNTicks=20)遍历 running sessions、自带 capture-pane、沿用 1h claim 门;`DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS` 迁 runner-quota-scan.ts;plugin.ts:9616-9651 闭包改挂新宿主。
- 删 `RunnerIdleWatchdog.ts` + 4 个专属测试 + plugin 接线(:126-128、:9595-9657、:10051)+ `idleWatchdogPollMs`(commdb-probes.ts:30-36)+ `FLYWHEEL_IDLE_POLL_MS` → RETIRED_FLAGS + flag registry 测试 `quiet_persist_dedup` readSite 断言改。
- **runner-status.ts 全符号手术(R1 #4 闭合,不留 compile orphan)**:删 `applyStallWatchdog`/`STALL_THRESHOLD_MS`/`StallEntry`/`EVICTION_MS`/`stallCache`/`fingerprint`(stall 用途)/`evictStaleEntries`/`clearStallCache`/`stallCacheSize`/10 分钟 eviction timer 与 `stopEviction` API;`createStatusQuery()` 保留但变为**纯 capture + heuristic、零 timer**(第二消费者 = Bridge 状态 API,plugin.ts:2337-2346,只读展示 —— 状态不再有 45s 降级,更诚实);runner-status.test.ts 对应 case 删/改;**跨包契约同步**:`packages/gemini-agent/src/tools/schemas.ts:105-108` 的 `query_status`「45s stall watchdog」说明改写、`doc/architecture/capability-matrix.md:136` 同步。
- `GUARDRAIL_EVENT_TYPES` 摘 `runner_idle_detected`;`pruneQuietWakeNotifiedNotIn` 唯一调用者随删(accessor 留,注释标注 FLY-1204 仍写此表)。
- **W-1 换驱动(§2.7 契约)**:tracker 打点包在 HeartbeatService 的 `reconcileMonitorLoss → reapOrphans` span(经注入回调,HeartbeatService 不 import manifest 类型);tracker 升级 pass token/generation 语义(watchdog-health.ts:29-77 的布尔 inFlight 重写);**tracker cadence 显式改取 Heartbeat `config.stuckCheckIntervalMs`**(不再用被删的 `idleWatchdogPollMs()`);负测:owner 挂住 + 后续 tick 被 single-flight 跳过 ⇒ manifest 仍 in_flight/stale,不得假 fresh;w1 行 `effective_enabled: true`、`switch: "required"`。(freshness 的消费端升级归刀 6 schema v2,本刀 validator/probe 行为不变 —— 保证刀间全绿。)
- 验证:HeartbeatService 7 测试文件 GREEN(行为零变化,只加打点)+ 新负测 GREEN、扫描测试改挂新宿主 GREEN、w1 fresh/stale 两态测试、Bridge 状态 API 测试(无 timer、无降级)。

### 刀 5 · LeadHealthProbe + ack-policy 死脚手架 + 死 kind 清账
- §2.11 前置复核通过后:删 `lead-backends/codex/LeadHealthProbe.ts` + 测试 + `CodexLeadRuntime.healthProbe()` API 面(codex-lead-runtime.ts:59,1552,1789、codex-lead-tui-runtime.ts:69,515,810、CodexLeadRuntime.ts:110-111)。
- `lead-event-ack-policy.ts` 冻结常量内联到 StateStore.ts:28-30,9866-9869,11928-11931 与 lead-event-delivery.ts:9,77,文件删除;ack-token 语义逐字节不变。
- 7 个死 kind:lead-runtime.ts 死注释成员核对清理;渲染面 legacy 注释补齐。
- 验证:codex lead 全家测试 GREEN、lead-event-delivery/StateStore 定向测试 GREEN。

### 刀 6 · 改名批(行为零变化的符号手术)
- `BridgeEventLoopWatchdog.ts` → `BridgeEventLoopGuard.ts`;bridge-exit-marker.ts 符号族(`BridgeWatchdogStallRecord`→`BridgeLoopStallRecord` 等)与日志路径 `bridge-watchdog.log`→`bridge-loop-guard.log`(exit-marker 读取双路径兜底,老文件只读);env `FLYWHEEL_BRIDGE_WATCHDOG*` → `FLYWHEEL_BRIDGE_LOOP_GUARD*`,旧名 RETIRED_FLAGS;`bridge_event_loop_stall` JSON key 不含 watchdog,保留。
- `founder-reply-watchdog.ts` → `founder-reply-unreachable.ts`(类改 `FounderReplyUnreachableReconcile`);gate-poller.ts 5 处接线随改;env → `FLYWHEEL_FOUNDER_REPLY_UNREACHABLE`,旧名 RETIRED;事件 kind `founder_reply_unreachable_runner` 不改。
- `watchdog-health.ts`+`watchdog-minimum-set.ts` 残余 → `bridge/liveness-manifest.ts`(`LivenessCheckTracker`/`buildLivenessManifest`/`qaStallInboxLoopLead` 照搬);`/health` key `watchdogs`→`liveness`、schema_version→2;truth.ts `REQUIRED_LIVENESS_ROWS`/`validateLivenessManifest`(config 公开导出同步 index.ts:26/49);`FLYWHEEL_WATCHDOG_LIVENESS`→`FLYWHEEL_LIVENESS_ALERTS`(registry 描述改为「stale-approved-ship 告警 lane」,gate-poller.ts:126,2920 随改);check-flag-truth.ts、bridge-liveness-probe.sh(双读 + `FLYWHEEL_WATCHDOG_MANIFEST_*` 4 env 改名)、**`scripts/fly-1586-capture-evidence.sh:256,290` 同步双读**(R1 #4)、probe 契约测试两 schema 态。
- **schema v2 的 W-1 operational contract(R2 #3,消费端落地)**:`validateLivenessManifest` 补字段完整性并**消费 freshness**;probe 健康判定升级 —— `fresh` 健康、`not_started` 仅 boot grace、`stale`/超阈 `in_flight_age_ms` 走现有 probe degraded 路径(不建新路由);接收端测试:hung owner ⇒ probe degraded/page,新 generation 完成 ⇒ 恢复。
- 验证:probe 契约、flag-truth、feature-flags-registry、bridge-event-loop-guard(沙箱 SIGKILL 保持)、zombie-gate 守卫(unreachable 注入保持)各测试 GREEN。

### 刀 7 · 提词清扫 + 守卫 + 分层残留扫描(R1 #4:谓词落到可执行)
- 39 个顺带提及文件注释/字符串改词(含 hook-payload.ts:508/:526 历史行渲染文案);lead-rules-base 去死事件引用;测试内提词 23 文件;跨包:edge-worker Blueprint.ts:2313 提示词改「Bridge 巡检以该 id 为消费回执」+ fly1188 快照更新、:2702 注释;flywheel-comm declare-state 4 处注释;scripts 残留指向。
- 守卫测试:`fly1570-watchdog-teardown.test.ts` 更名 `fly1560-teardown-guard.test.ts` 并扩展(被删文件/符号断言 + plugin 负向断言:`LeadWatchdog`/`RunnerIdleWatchdog`/`onPollComplete`/`applyStallWatchdog`)。
- **三层残留扫描(可执行谓词,验收 1 的机器形态)**,范围 = `packages/*/src`、`packages/*/scripts`、根 `scripts/`、`packages/teamlead/lead-rules-base/`、`CLAUDE.md`、`doc/messaging-rework/`、`doc/architecture/capability-matrix.md`;排除 `doc/engineer/**`、`engineering/doc/**`(本单文件夹除外)、`**/archive/**`、`**/__tests__/fixtures/**`:
  - a)模块/符号层零命中:`rg -i "RunnerIdleWatchdog|LeadWatchdog|applyStallWatchdog|STALL_THRESHOLD_MS|accountSwitchWatchdogTick|LeadHealthProbe|watchdogBlockedEnabled|watchdogLivenessEnabled|buildWatchdogManifest|WatchdogCheckTracker|BridgeEventLoopWatchdog|BridgeWatchdogStallRecord|FounderReplyWatchdog|partitionLeadsForPaneWatchdog|paneWatchdogProjects|idleWatchdogPollMs|legacyLeadWatchdogEnabled|pruneQuietWakeNotifiedNotIn"` —— 唯一例外:truth.ts RETIRED_FLAGS 字符串、CLAUDE.md 里程碑叙述行、守卫测试点名字符串
  - b)事件/env 层:`runner_idle_detected` 仅允许出现在守卫测试与 fixture;被删/改名 env 名(`FLYWHEEL_WATCHDOG_BLOCKED|FLYWHEEL_WATCHDOG_LIVENESS|FLYWHEEL_BRIDGE_WATCHDOG|FLYWHEEL_FOUNDER_REPLY_WATCHDOG|FLYWHEEL_IDLE_POLL_MS`)零命中或仅 RETIRED_FLAGS
  - c)字面层(验收原文):`grep -ri watchdog packages/teamlead/src` 零命中,豁免仅 §5.1 两类;全仓 `rg -il watchdog` 输出逐文件标注 `keep-rationale`(voice-core/voice-bridge 等无关包如实标注「非本家族」)
- CLAUDE.md 里程碑行 + 本 doc 文件夹随 PR。

## 4. Ship 顺序与前置(R1 #5:证据绑定)

1. **硬前置(merge 门),四件证据缺一不可(R2 #1 重写:适配「能力已部署、生产显式 0 = operator ownership」的现阶段 —— barrier 只在首次 capability rollout 或恢复未完成 marker 时运行,mailbox-queue-deploy-barrier.sh:25-35 / .ts:361-369,不能要求一个按状态机不会再生成的 released marker)**:
   a. FLY-1573 侧产出的 **canonical direct-toggle `0 → ON` 切换回执**,绑定精确 deployed SHA(FLY-1573 若已定义自己的 durable activation receipt,直接引用其权威对象);并在该 SHA 上**重新执行且留证**:全 Lead wave 零 failed/skipped + Claude/Codex 实 MCP ACK probe 通过(restart-services.sh:2572-2615 形态)
   b. 持久 env(`~/.flywheel/.env`)与活 Bridge 进程 **raw 值一致,且 `mailboxQueueEnabled(...) === true`**(该 flag default-on,unset 与 `1` 均为 ON,只有字面 `0` 关闭 —— mailbox-queue.ts:1-5;不要求字面 `1`);且**经过一次真实 Bridge restart 后仍为 ON**
   c. ≥24h 观察窗内,ACK/lease settlement **按 Claude/Codex × Lead/Runner 四桶分别有成功样本**;无长期滞留 LEASED batch、retry/dead-letter 无持续增长斜率
   d. 上述证据绑定同一 deployed SHA 与时间窗,记录在 ship 卡
   (翻开动作归 FLY-1573 部署链;本单 PR 在 a-d 齐备前不合入。)
2. 部署 = 标准 restart-services 波次;probe/evidence 脚本与 Bridge 同 git pull 落地,双读兜底消灭窗口假 page。
3. ship 窗运维清单:`~/.flywheel/.env:131` `FLYWHEEL_WATCHDOG_JUDGE=0` 残留行删除;`bridge-watchdog.log` 留存只读。
4. 部署后过夜观察窗:见 §5 QA 合同(R1 #5 谓词)。

## 5. 验收标准映射 + QA 合同

1. **grep 零命中**:§3 刀 7 三层谓词;唯二豁免 = ①`__tests__/fixtures/**`(issue 明文);②守卫测试内点名被删文件/符号的字符串常量(FLY-1570 QA 先例「执法机制本身」,守卫测试文件名不含 watchdog)。豁免清单逐条列 PR body。
2. **build + 全量测试 + 起得来 + 跑一晚(R1 #5:denylist + 阳性对照,不搞粗暴归零)**:
   - 每刀 `pnpm -r build`;终态 `pnpm lint` + `pnpm test:packages:run`(宿主既有 flake 按 memory 清单甄别,保留项新红不得当 flake);Bridge 真机重启 + fleet 全员在线
   - 过夜窗谓词(R2 #2 重写:共享 kind 的 eventId 是无前缀 40 位 SHA-1、`alert_claims`/`AlertPayload`/`lead_events` 均无 producer 字段 —— 逐行来源识别在现有数据模型不可执行,本单也**不**为此发明 provenance 字段,那越界到 FLY-1764):
     - **可机器验证的运行时 denylist 收缩为**:`runner_idle_detected` 全局零新行;零 auto-page/追讨形态
     - **Lead-pane 四共享 kind(`rate_limit|usage_limit|login_expired|permission_blocked`)改用结构性部署证明**:精确 head 的源码守卫测试证明发射器不存在 + 活 Bridge PID 在该 head 部署后启动、旧 PID 已消失 + 启动接线/日志零 LeadWatchdog;观察窗内该四 kind 的新行一律归属保留路径(runner 扫描 `runner-quota:` 前缀可识别;lead-alert.sh 合法),**不声称能逐行识别已删 producer**
     - 若 founder 要求逐事件 provenance,前置 = FLY-1764 先落 durable producer identity,本单不承诺该谓词
   - **保留生产者阳性对照**:三个 `inbox_loop_stalled` 真实来源、`zombie_session_backlog` 等 fleet 传感器、mailbox 死信通知 —— 允许出现且须验证仍能真实发出(注入或观察)
   - claims.db + lead_events + Discord 三处证据绑定同一 deployed head 与观察窗;修前/修后对照数字进 QA 报告(部署前同库旧代码仍在产出 = 阳性对照)
3. **删除清单 PR body**:删除/搬家/改名三张表;与 FLY-1503(Canceled,注明)原文枚举逐条标注 `已删(FLY-1570)/本单删/本单搬家/不存在`;与 FLY-1570 PR #771 清单互核。
4. **保留项逐项点名**(QA 硬性):BridgeEventLoopGuard 沙箱 SIGKILL、HeartbeatService 全家测试 GREEN + 真机 reap 一例、5 rider 在 GatePoller 真跑(tick 日志 + lease episode / hub reconcile 注入)+ 逐段失败隔离/重叠防护两测试、fleet 传感器搬家后真发、额度/登录扫描新宿主真发(529 房注入 login-expired pane → `runner_login_expired`)、unreachable-runner 正面注入、w1/w2/w3 manifest fresh + **w1 假-fresh 负测**(owner 挂住不得刷 fresh)+ probe 双读两态、patrol-tick 照常。
5. **QA 节点硬性要求**(founder 直令 2026-08-04 974746ff 常设):529 真机 E2E(真 Bridge + 真 Lead + 真 Runner,禁 stub)、真 Discord 腿(真发真读回,生产频道零污染)、结论绑定精确 head、涉重启真重启;不适用项书面说明。

## 6. 风险与回滚

| 风险 | 缓解 |
| -- | -- |
| rider 搬家窗口双跑/零跑/饿死 | 刀 2 单 commit 原子换轨 + 唯一性/顺序/cadence/逐段失败隔离/重叠防护五组测试 |
| fleet 传感器静默死(最大隐藏依赖) | 刀 2 与刀 3 分刀;每刀后 fleet-sensors 测试 + QA 真机注入 |
| W-1 假 fresh(single-flight 跳过被记成完成) | §2.7 span 打点 + generation 语义 + 专项负测 |
| w1/w4 中间态假健康面 | 契约收口与驱动者删除同刀(刀 3/4);probe 双读 |
| probe/evidence 部署窗口假 page | `(.liveness // .watchdogs)` 双读(probe + fly-1586 脚本)+ 同波次部署 |
| LeadHealthProbe 有未发现的 verdict 行动方 | §2.11 前置复核;发现即改「保留+改名」并报 Lead |
| parity 空心证明 | 刀 1 重写为 import 生产 computeEventId 的四字段对照 + 负例 |
| 信箱开关未翻先撕保护 | §4.1 四件证据 merge 门 |
| 改名破坏跨语言/跨文件契约 | parity 测试 + probe 契约两态 + exit-marker 双路径读 |
| 回滚 | 纯代码 PR,revert 即整体回滚;无迁移、无 schema、无数据变更 |

## 7. 交付物

- 分支 `flywheel-FLY-1560` 单 PR(base main),7 刀独立 commit + 文档 commit(CLAUDE.md 里程碑 + 本 doc 文件夹)
- PR body:删除/搬家/改名三张清单 + FLY-1503/FLY-1570 互核表 + 已知行为变更申报(onLeadRecovery 延迟化、W-1 语义换驱动 + switch:"required"、首 tick 对账提前、idle FYI 消失、stall 降级消失、Lead pane blocked 四 kind 发射路径消失、pane-membership helper 核查结果)+ grep 豁免清单
- Codex code review 循环至 APPROVED;QA/ship 按 §5 合同执行
