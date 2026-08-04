# FLY-1570 拆 watchdog 全家 — 实施计划

Issue: FLY-1570 (https://linear.app/geoforge3d/issue/FLY-1570/消息层重构-a-批次1-拆-watchdog-全家)
日期: 2026-08-03(R1 修订 2026-08-04)
基于: research.md

## 1. 目标与非目标

**目标**:物理删除全部「追人型」watchdog(靠「多久没动/面板变没变」推断状态然后催促、重发、升级的机制)及 FLY-1393 墓碑,同时保证保留清单(收尸型/外部事实型/状态收敛型)逐项完好。纯删代码 + 必要的符号搬迁,零新功能。

**非目标(红线)**:
- ❌ 不加任何 feature flag(founder 2026-07-24 直令;墓碑正是反面教材)
- ❌ 不动 `lead_inbox` / `messages` 的 schema(C 单 FLY-1572);不跑任何 DB 迁移 —— 孤儿表「删代码不删数据」
- ❌ 不动投递循环的投递逻辑(D 单 FLY-1573):`runner_phase_wakes` 的生产者、`wakeRunnerMailbox`、lead-inbox-loop 投递路径、**founder reply 投递(`FLYWHEEL_FOUNDER_REPLY_DELIVER` 及其分支)**一行不碰
- ❌ 不做顺手重构/改名(仅两处必要例外,见 §3 裁定 6)

## 2. 关键背景(详见 research.md)

生产现状决定了本单的真实风险画像:**大半「要删」的检测器已被 FLY-1393 墓碑硬关**(`retiredWatchdogLaneEnabled()` 硬 return false → `legacyDeliveryWatchdogsOn = false`),删它们是零行为变化;真正活着、删了会改变行为的只有:receipt 双巡逻、codex-hold 双 reconcile、notify-digest-expect、workflow-route-reminder、inbox-loop-health、mailbox 溢出扫描,以及 LeadWatchdog / RunnerIdleWatchdog 里的死支路清理。全部行号与 import 图谱见 research.md §2。

**刀序的第一原则(R1 修订)**:被墓碑门守着的死代码,必须**先物理删除、后拆门** —— 顺序反了,中间 commit 会短暂复活旧检测器(pane-hash 告警、pass-dead 追命等)。因此 LeadWatchdog / founder-reply 手术(刀 5)排在墓碑铲除(刀 6)之前。

## 3. 边界裁定与实施核验更正

1. **实施残留扫描纠正初版边界**:`HeartbeatService.checkStuck()` / `onSessionStuck`、`stuck-pane-confirm.ts`、`watchdog-judge*.ts` 是一条完整追人告警链,按 issue 明示范围整链删除;不能以「确认层」名义留下。
2. **detection 升级全家整删**:`detection-config-source` / `detection-escalation-sinks` / `detection-escalation` / `detection-gap-scan` / `detection-suspicious` / orphan reconcile 及 wiring/flags/tests 全删。保留的 founder decision 收敛点直接复用 routed alert sink;schema、历史 ACK/receipt 兼容面不动。下文刀序中与这两条冲突的预实施拆分描述均由本条取代。
3. **unreachable-runner 检测器复活**:删掉墓碑门后它的门只剩 `FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0"`(默认开)。本单唯一「0 → 1」行为变化,符合 issue 保留意图;复活与两检测器删除在**同一个原子 commit**(刀 5)
4. **FN4 投递对账代码消失**(本来就没跑),PR 描述点名让 D 单知道要重建
5. **`runner_phase_wakes` pending 行批 1 后无人推进**:生产者是 D 单红线不动,接受积压至 C/D 接管,PR 点名
6. **仅有的两处改名**:①`onReceiptWakePatrolTick` → `onReconcilePatrolTick`(删 patrol 后名不副实且只剩保留对账);②其余文件一律不改名 —— 控制 diff 半径
7. **`FLYWHEEL_FOUNDER_REPLY_DELIVER` 保留**(R1):它是 `founder_reply_deliver` flag(registry.ts:1406-1425),控制 founder gate 回复回投 runner 的**真实投递**(gate-poller.ts:2992-2996、1143-1183)+ deferred approval rebind,有 cadence pin 测试。属投递红线,只有 checkHang 内部的那次读取随 checkHang 消失
8. **`lead-event-ack-policy.ts` 保留**(R1,修正 research 孤儿猜测):`ackPolicyForLeadEvent`/`routingSnapshotForLeadEvent` 被 StateStore.ts:28-30,9866-9869,11928-11931 用,`deliveryAckEnabled` 被 lead-event-delivery.ts:9,77 用。墓碑展开时把这些函数**冻结为当前常量行为**(它们在 policy=false 下的返回值),ack-token 语义逐字节不变
9. **`alertCodexGateBlocked` 保留**(R1,修正 research 疑孤儿):保留的 `reconcileCodexHolds()`(auto-qa-coordinator.ts:2042-2072)missing-head 路径仍调用;auto-qa-effects.ts:551-589 过期注释修正
10. **W-2 健康契约定稿**(R1,R2 收紧):`w2_delivery_loop` manifest 行是**保留的被动健康观测面**(REQUIRED_WATCHDOG_ROWS + bridge-liveness-probe.sh:116-134,211-230 外部契约),删的只是告警发射器(inbox-loop-health-checker 的 `inbox_loop_stalled`)。**W2 彻底退出 generic tracker 机制**(checker 是 `watchdogTrackers.loopHeartbeat` 唯一的 started/completed 驱动者,只搬 wiring bit 会留下永远 `not_started` 的假健康面):`loopHeartbeat` 从 `watchdogFlags`/`watchdogTrackers`/`watchdogWiring` 类型、plugin 构造与测试 fixtures 中整体移除;W2 行的最终对象契约 = `wired: true` 在 `leadInboxRuntime.start()` 成功绑定后置位、`effective_enabled: true`、`switch` 字段改为无开关事实(`"required"`)、freshness **只由 `leads[]` 的 durable heartbeat 决定**(getHeartbeat 读取方不动),顶层不再有 not_started 态。`FLYWHEEL_WATCHDOG_LOOP_HEARTBEAT`/`watchdogLoopHeartbeatEnabled` → RETIRED_FLAGS。测试断言:顶层无已退休 env、per-lead fresh/stale、W2 永不呈现 not_started;bridge-liveness-probe 契约测试保持通过
11. **退休 kind 的统一姿态:「真实化契约 + 声明式重放」**(R1→R2→R3 收敛定稿):已删发射器的事件 kind(`pane_hash_stuck`/`pane_error_stalled`/`runner_lead_pending_*`/`workflow_route_input_rejected`/`inbox_loop_stalled`/`receipt_unprocessed`/`wake_failed`/`runner_stuck_escalation`)的处置原则 —— **发射器与自动修复 handler 物理删除;声明式表保持穷尽闭合但改写成真实姿态;残留重放行为显式声明而非假设**:
    - **保留且改写真实**:`AlertEventType` union 成员保留(`KIND_CONTRACTS` 是 `Record<AlertEventType, KindContract>` 穷尽 Record,kind-contract.ts:64-70;删成员即编译错,删 entry 即 `validateKindContracts()` 启动错,:383-415 + plugin.ts:3973-3977);对应 contract entry 保留但**改写成真实 no-auto 姿态**:`arc` 从 `"auto"` 改为 needs-human 姿态、删除指向已删 handler 的 `remediationRef` —— 绝不留「声明 auto 但 handler 已删」的假契约。`titleFor`/`bodyFor`、历史 `lead_events` parser/渲染(hook-payload、mailbox-lead-runtime)照留,加 legacy 注释
    - **物理删除**:AutoRepairBot 的自动修复 handlers **精确 = 三个真实 auto kind**(`pane_hash_stuck`/`runner_stuck_unhandled`/`runner_throttle_stalled` 的注册 :99-105 + dispatch :176-184;R7 修正 —— `runner_lead_pending_unhandled` 不在其中)及其测试;auto-repair 注册点;**`LEAD_KINDS` 里的退休 pane kind 条目 + 对应 `shouldResolveLead` 分支**(R4:`LEAD_KINDS` 是**主动 lifecycle gate** —— reconcile 先命中它就 capture pane 并跑 resolve 判定,AlertChannelHub.ts:779-843,不是 fallback 等价的声明表;留条目删分支会让 `pane_error_stalled` 落进普通 classifier 被当场误 resolve,:995-1005)—— 删条目后退休线程直落 `reconcileTicket()` 通用路径,与刀 5 目标一致
    - **fallback 等价的声明式表(TICKET_KINDS / ticket-owner-map)保留条目加 legacy 注释**:实测 fallback 语义(classifyInfraEvent 默认 `return "ticket"` infra-event-router.ts:124-133;owner 默认 Claude bot ticket-owner-map.ts:98-113)意味着删条目**不改变行为**,反而制造「看似删了实际还路由」的误导
    - **重放行为按持久化状态逐路径声明**(R4 写准,不合并成一句「都会 founder escalation」):`alert_threads` 中 `ticket_status IS NULL` 的 legacy 行 → `reconcileTicket()` 首行直接 return,**重启后 no-op**(AlertChannelHub.ts:857-859;若产品要求收敛,必须上线前人工处置);ticketed 行 → 经 `decideTicketEscalation` 走 none/retry/escalate 三分支,retry 才到 `bot.attempt()` 默认 `needs_human`(AutoRepairBot.ts:268-275),escalate 分支直接 T2 page founder(:859-904)。注意退休 kind 里 receipt/lead-pending/inbox-health 的发射器**在 ship 前仍活着**,存量会持续增长 —— 盘点是必做项,不得假设 ≈0
    - **逐 kind 矩阵**(R5 定稿 —— 存储域/发射器/handler/contract delta/表姿态/盘点,实施与验收都以此为准):

      | kind | 存储域 | 发射器(删) | AutoRepair handler | contract delta | exact runtime 位点处置(R6 展开) |
      | -- | -- | -- | -- | -- | -- |
      | `pane_hash_stuck` | alert_threads.event_type | LeadWatchdog 3 轮告警 | **删**(注册 AutoRepairBot.ts:105、dispatch :183-184) | `arc:"auto"` → `human_by_design`,删 remediationRef | **LEAD_KINDS 条目 + shouldResolveLead 分支成对删**;TICKET_KINDS/owner 留 legacy |
      | `pane_error_stalled` | alert_threads.event_type | LeadWatchdog veto1 | 无 | **已是 `human_by_design`,不动**,加 legacy 注释 | 同上(LEAD_KINDS 成对删) |
      | `runner_stuck_unhandled` | alert_threads.event_type | createStuckUnhandledAlerter(刀 3 删) | **删**(:99-104 注册 + dispatch 对应段) | `arc:"auto"` → `human_by_design`,删 remediationRef | **runner reconcile 特例谓词删本 kind**(AlertChannelHub.reconcile :791-805 的 shouldResolveRunner 捕获集,**`runner_login_expired` 保留在谓词里**);TICKET_KINDS/owner 留 legacy |
      | `runner_throttle_stalled` | alert_threads.event_type | detectThrottleStall 链(刀 3 删) | **删** | `arc:"auto"` → `human_by_design`,删 remediationRef | 同上(runner reconcile 谓词删本 kind) |
      | `runner_lead_pending_unhandled` | alert_threads.event_type | lead-pending(刀 4 删) | **无**(R7 修正:它只在 `HUMAN_ONLY_REASON` 提供 contract-driven founder 文案,AutoRepairBot.ts:108-128,由 AlertChannelHub.ts:650-664 动态读取 —— **legacy copy 保留**,不是 handler) | **已是 `none_escalate`,不动**,加 legacy 注释 | **ISSUE_PROGRESS_KINDS(infra-event-router:100-107)+ NO_OWNER_KINDS(ticket-owner-map:66-80)条目保留 legacy**(删则 issue-thread→ticket 未声明变化);AlertChannelHub.contract-escalate 的 legacy-copy pin 测试保留 |
      | `workflow_route_input_rejected` | **root-only notification**(INFORMATIONAL_KINDS → handle() root-only return,不建 alert thread,LeadAlertNotifier:357-367 + AlertChannelHub:353-359) | route-reminder(刀 1 删) | 无 | **已是 `human_by_design`,不动** | **INFORMATIONAL_KINDS 条目保留 legacy**(删则 notify→ticket 未声明变化);alert_threads SQL 中仅作防御性历史盘点 |
      | `inbox_loop_stalled` | alert_threads.event_type(**ticket fallback,非显式 TICKET_KINDS 条目**) | inbox-health(刀 4 删) | 无 | **已是 `none_escalate`,不动** | **NO_OWNER_KINDS 条目保留 legacy**;无显式 TICKET_KINDS 条目可删 |
      | `receipt_unprocessed` / `wake_failed` | **detection_escalations.kind**(不是 alert_threads!) | 两 patrol(刀 4 删) | — | —(detection 域,sinks describeKind 留 legacy) | 独立盘点(下) |
      | `runner_stuck_escalation` | lead-event/规则文本名 | stuck 升级(刀 3 删) | — | — | rules/scripts 文本清理(刀 3) |

      重放声明的适用性以本矩阵为准:pane 两 kind 删 LEAD_KINDS 分支、runner 两 kind 删 reconcile 特例谓词之后,退休 alert_threads 行才统一落 `reconcileTicket()` 通用路径(NULL no-op / ticketed 三分支);seeded 重启测试相应加 runner kind 的 NULL no-op + ticketed NEW→T2 两条,并断言 `runner_login_expired` 特例照旧工作
    - **ship checklist 精确盘点**(停旧 Bridge 后同库复查,输出留证,非零先人工 resolve 再起新版本):
      - alert 域:`SELECT event_type, COALESCE(ticket_status,'<null>') AS st, count(*) FROM alert_threads WHERE resolved_at IS NULL AND event_type IN ('pane_hash_stuck','pane_error_stalled','runner_stuck_unhandled','runner_throttle_stalled','runner_lead_pending_unhandled','workflow_route_input_rejected','inbox_loop_stalled') GROUP BY event_type, st`
      - detection 域基线:`SELECT kind, status, count(*) FROM detection_escalations WHERE status NOT IN ('RESOLVED') AND kind IN ('receipt_unprocessed','wake_failed') GROUP BY kind, status`
      - receipt writer 三指标(停旧 Bridge 后记 `t0`,新 Bridge 观察窗跨至少两个历史回放周期,生产实测每周期 3–12h):① `SELECT max(first_detected_at_ms) ...` 判新 episode;②两次无界 `SELECT count(*) ...` 的斜率必须为 0;③记下 `t0` 的 `max(rowid)`,窗口末断言 `SELECT count(*) ... WHERE rowid > :t0_max_rowid` 为 0。**禁止用消息送达时间推断发生时间**,因为存量送达可滞后 3–12h;`rowid↑/first_detected↑` 也不能单独排除按序回放
    - **contract delta 逐 entry pin**(R5 收窄,只降级真失去 handler 的 auto 契约,不动本来就 truthful 的值):仅 `pane_hash_stuck`/`runner_stuck_unhandled`/`runner_throttle_stalled` 三条 `arc:"auto"` → `human_by_design` + 删 remediationRef;`pane_error_stalled`/`workflow_route_input_rejected`(已 `human_by_design`)与 `runner_lead_pending_unhandled`/`inbox_loop_stalled`(已 `none_escalate`)**保持原值**加 legacy 注释 —— 统一改值会改变 residual replay 的文案/调用链/ticket lifecycle,超出必要范围
    - **三项新增验证**:①`pnpm -r build` 证明穷尽 Record 闭合;②`validateKindContracts()` 启动校验通过(真实化后的 entry);③seeded 重启测试**分路径 pin**:一条 `ticket_status=NULL` legacy 行断言 no-op、一条 ticketed `NEW` 行断言 decideTicketEscalation→T2 路径,断言不得合并三种路径
12. **receipt 升级链覆盖核对(Lead 硬性核对项 2026-08-04,lead-instruction 92a148f8 + 修正版 0e76355c,以修正版框架为准)—— 裁定:这类检测不该以 watchdog 形式存在,明确删除,不留死着装样子的 watchdog**。背景(CoS 阳性对照实测):receipt_unprocessed 升级链自嵌套(升级事件本身是消息→也要收据→再升级时把上一代 fingerprint 整段拼进来→每代变长→第三代突破 detection-ack 端点 200 字符上限 stuck-remanage-routes.ts:171),且 **fingerprint>200 的 1649 行 0 次 page(≤200 的行 3759 次 page,pager 活着)、>7 天未结的 170 条同样 0 page ⇒ ack 与 page 双路全死 = 假阴性静默失效**:watchdog 自以为在盯这一类,类内任何真实故障永远到不了人眼前。这**加强**了拆除裁定 —— 本单删的不是一个工作中的保障,而是一个只剩形骸的假保障;生产已清 293 行结构死类。「值得检测的那部分职能」不由新 watchdog 承接,由 D 单的**结构性队列语义**取代(FLY-1569 §4/§6:租约到期同一条消息原地重新可见、不新建行;重投 3 次 → 死信闸打包给 Lead 决策)—— 送没送到从此是队列属性,不是巡逻检测,自嵌套与长度上限问题在结构上不存在。
    - **包含(自嵌套与迟到回放 writer 整体死亡)**:resend 引擎、receipt 域首次升级生成器(`notifyUnprocessed` / `notifyWakeFailure`)、`listPendingReceiptAlerts`→`detection_escalations` 的迟到回放/铸行链、detection reconcile/aggregation 侧与其 sinks 全删。结构测试同时禁止 plugin 重新出现 `listPendingReceiptAlerts|notifyUnprocessed|notifyWakeFailure|upsertDetectionEscalation`。当前生产树对 `StateStore.upsertDetectionEscalation()` 的调用为零;只保留表、历史行 settlement/ACK 兼容接口,因此旧 episode 无论有序或乱序都没有 runtime writer。**「升级的升级」从此结构性不可能:不是靠更好的上限,而是生成器与回放器物理不存在了**。替代物(租约到期原地重投不新建行 + 死信闸)= D 单按 FLY-1569 §4/§6 重建
    - **保留边界**:`detection_escalations` schema 不动(C 单边界),历史 receipt 行的 terminal settlement / detection-ack 读取与审计更新保留;它们不创建行。detection-ack 的超长 reference 已在独立第 9 刀改成 exact source receipt lookup + bounded SHA-256 audit fingerprint。存量行先人工收敛,再按 §3.11 三指标跨窗确认无新 rowid/无 COUNT 增长
    - **第 9 刀:Lead 已裁定【执行】**(2026-08-04 回复 43c71d71,founder 过夜预批范围内):detection-ack 端点作为统一检测接口保留,就不允许它带着已知的「关不掉也叫不响」失败方向活着。独立 commit,不混入任何纯删 commit,带端点行为测试,三项修复:①too-long 的 fail-closed 方向纠正 —— 超长 fingerprint 可截断/哈希后**仍可关闭**,而不是永远关不掉;②错误文案区分 missing 与 too-long(现在把 too-long 说成 required,把运维引去猜字段名);③fingerprint 改用 parent id 引用而非整段拼接
13. **flag 处置策略**(R1):所有被本单移除的 **active** flag 一律迁入 truth.ts `RETIRED_FLAGS`,不许无痕消失:`pane_idle_suppress`(registry.ts:1865-1882,active——修正 research「影子开关」说法)、`codex_hold_nudge`、`codex_hold_nudge_ms`、`receipt_activation_dry_run`、`watchdog_loop_heartbeat`,及 truth allowlist 里的 gap/frame/receipt-patrol env。已带 `retiring: FLY-1393` 的 5 条照移;`founder_reply_watchdog` 保留为活开关、去 retiring 标记修 note

## 4. 实施步骤(8 刀,每刀独立编译 + 独立 commit)

删除型工作的 TDD 形态:每刀 = ①先跑该刀涉及的**保留项**既有测试(GREEN 基线)→ ②删代码 + 删对应测试 → ③保留项测试仍 GREEN + `pnpm -r build` 通过 → ④commit。任何一刀出现保留项测试变红即停下修复,不得靠删保留测试过关。

每刀的「新增/删除/改 import/预期行为」依赖表如下;行级切割线见 research.md §2。

### 刀 1:零风险孤立件(预期行为变化:四个活的追人告警停发)
| 删 | 同步清理 |
| -- | -- |
| `StuckWatcher.ts` + `StuckWatcher.test.ts` | — |
| `bridge/notify-digest-expect.ts` + 2 测试 | plugin.ts import(:451-452 含孤儿 defaultReceiptsPath)、:11310-11328;**不动** bash 独立链路(token-usage-daily.sh / lead-alert.sh / kind-contract:178) |
| `bridge/workflow-route-reminder-drain.ts` + 测试 **及其生产者**(runs-route.ts:3336、StateStore.ts:17582 内联 INSERT) | plugin.ts:658/8602-8612/11422-11433;StateStore accessors + DDL(已建表原地留);`workflow_route_input_rejected` kind 全枚举清理:LeadAlertNotifier、LeadWatchdog titleFor/bodyFor、kind-contract.ts:114、ticket-owner-map、lead-alert.sh allowlist、相关测试断言 —— 按 §3.11 分层(渲染面留 legacy,发射面删) |
| plugin.ts mailbox 溢出扫描(:11361-11398,:11476-11477)**及生产侧** updateOverflowMarker(agent-team-transport/mailbox-prune.ts:255-345) | ClaudeMailboxCodec.ts:346,938,997 三调用点、FLYWHEEL_MAILBOX_UNREAD_WARN、mailbox-prune.test.ts:359-460、MetaAlertReason 联合去 mailbox_overflow + **meta-alert-notifier.test.ts:113 断言改用其它 reason** |

### 刀 2:搬迁(纯移动,零行为变更;R1:import 更新必须覆盖**全部**存活消费者)
- `stuck-escalation.ts` 8 个保留符号 → 新 `bridge/commdb-probes.ts`;改 import:plugin.ts、gate-poller.ts、stuck-remanage-routes.ts
- `stuck-candidate.ts` 4 个保留符号 → 新 `bridge/pane-fingerprint.ts`;改 import:AlertChannelHub、autocontinue-arming、runner-recovery-nudge、quiet-classifier、plugin.ts、**`detection-detector-wiring.ts:24` 及其测试**(它活到刀 6,漏改则刀 3 编译红)、**`scripts/qa-fly-1048-real-discord-e2e.mjs:65-70`**(.mjs 不在 tsc 视野,单独核)
- `InboxLoopHealthTarget` + `inboxLoopStallMs` → `watchdog-health.ts`;改 plugin.ts:340 import
- 验证:全量测试 GREEN;`rg "from ['\"].*stuck-candidate|from ['\"].*stuck-escalation"` 全仓(不限 --type ts)确认只剩即将删除的模块自身与测试

### 刀 3:stuck 集群主刀
- 删 `stuck-runner-detector.ts` / `stuck-candidate.ts` 残余 / `stuck-escalation.ts` 残余 + 4 测试文件 + throttle-stall.test.ts
- RunnerIdleWatchdog 摘巷:stuckDetector 注入(:54/:162-164/:214-233)+ waiting/unknown 死巷(289-325)+ `legacyDeliveryWatchdogsEnabled` 字段本地简化(门本体刀 6 才拆);plugin.ts:10923-10945 构造删
- `stuck-remanage-routes.ts`:删路由 2(stuck-disposition)+ 路由 3 的 CASE_C 镜像写(:664-670);路由 1/3/4 保留;`STUCK_LATCH_TTL_MS` 随路由 2 删
- runner-recovery-nudge 对 stuck_dispositions 的两处写(:359/:390):保留(受体表还在,行为不变),注释标注 C 单收
- auto-qa-coordinator:删 reconcileStuckCodexHolds/reconcileCodexHoldNudges/queueCodexNudgeIntents + plugin 四处挂载 + StateStore claimCodexHoldStuckNotify + codex-gate 两符号 + founder-action-drain 两 kind 分支 + StateStore.ts:390-391;**保留** reconcileCodexHolds(:2042)/codexHold(:716,改 :711-714 注释)/**alertCodexGateBlocked(§3.9)**;auto-qa-effects.ts:551-589 注释修正
- **codex_nudge_* 存量处置**(R1,R2 修正 schema 与竞态):正确盘点 SQL = `SELECT count(*) FROM founder_action_ledger WHERE kind IN ('codex_nudge_queue','codex_nudge_wake') AND status = 'pending'`(表是 `founder_action_ledger`,pending 由 `status` 表示,StateStore.ts:3132-3148/12860-12863;无 consumed_at 字段)。**无竞态 ship 顺序**:①旧 Bridge 的 drain 自然清零 → ②停旧 Bridge(producer 同时停)→ ③在同一 StateStore DB 上复查计数为 0(输出留证)→ ④起新版本;非零则不部署。`founder-action-drain.test.ts` 中 codex_nudge_* 相关 case 本刀一并清理
- Lead rules / 文档:lead-rules-base/stuck-runner-remanage.md 改写、runner-patrol-rules.md:34,55、lead-rules-bundle.test.ts:117、stuck-escalation.test.ts:610-654 pin 迁移、**department-lead-rules.md:410 + scripts/claude-lead.sh:2693 + fly369-patrol-rule.test.ts:46 的 `runner_stuck_escalation` 声明**(R1 补)

### 刀 4:patrol 双巡逻 + lead-pending + inbox-health(预期行为变化:重发/升级/追命告警全停)
- 删 `runner-receipt-patrol.ts` / `lead-receipt-patrol.ts` + 测试 + qa-fly-1392 e2e 脚本;plugin.ts 构造闭包(:7887-8108,:8110-8299);**:8301-8310 回调只删两行 patrol.pass(),保留 park outbox 投影 + terminal 收据结算,回调改名 onReconcilePatrolTick**(gate-poller 5 处 + 契约测试)
- 删 `lead-pending-escalation.ts` + 3 测试 + qa-fly-695 e2e;gate-poller 手术(import 块、:1037-1040、prune 块、三个 emit 函数、seenLeadPendingQids/leadPendingPollComplete 逐处确认后清);StateStore 表 4 方法 + DDL;watchdog-health RETIRING_WATCHDOGS 摘条目
- 删 `inbox-loop-health-checker.ts` + 测试;plugin.ts:6153-6164/:6299;**按 §3.10 契约**:`loopHeartbeat` 从 `watchdogFlags`/`watchdogTrackers`/`watchdogWiring` 类型、plugin 构造(:3932/:3953/:3967)与测试 fixtures 整体移除;W2 行改为 `wired=true`(leadInboxRuntime.start() 置位)+ `switch:"required"` + freshness 只由 `leads[]` durable heartbeat 决定;manifest 两态测试(无 not_started 假状态断言),bridge-liveness-probe 契约测试保持 GREEN
- kind/flag 收尾按 §3.11/§3.13:`runner_lead_pending_*`/`receipt_unprocessed`/`wake_failed`/`inbox_loop_stalled` 渲染面 legacy 保留、行为面删;registry:receipt_activation_dry_run、lead_pending_escalation、watchdog_loop_heartbeat 处置
- 已知间隙(PR 点名):external_saga_unknown 告警无人 drain;lead_inbox 重发记账字段 **lead 侧仍在写、读者消失(写了没人读)**(R1 措辞修正),C 单收

### 刀 5:LeadWatchdog + founder-reply-watchdog 原子手术(墓碑门此刻仍在 → 删除的全是死支路,零行为变化;唯一例外 = unreachable 复活,同 commit 内显式接活)
- LeadWatchdog 按 research.md §2.2 行级表:删面板哈希链(tickLead 五段、fireSuspicious、isIdleHealthyPane、两个 pane kind 的**发射链**、8 个 config 字段、2 个 LeadState 字段)+ AlertChannelHub 的 **`LEAD_KINDS` 退休 pane kind 条目 + `shouldResolveLead` 两分支成对删除**(§3.11 R4:留条目删分支会误 resolve)+ **runner reconcile 特例谓词删 `runner_stuck_unhandled`/`runner_throttle_stalled` 两 kind、保留 `runner_login_expired`**(:791-805,§3.11 R6)+ **AlertChannelHub 孤儿清理**(R7:删三个专属 import `isIdleHealthyPane`/`leadPaneHasErrorSignature`/`leadPaneLiveHash`(:26-31);`shouldResolveLead` 签名去掉不再使用的 `correlationKey` 参数并同步调用点 —— repo 开着 `noUnusedParameters`,漏改即编译红;删 `reconcileHashes` 字段与 `resolve()` 的 `.delete()`(:345-346,745);保留 `classifyLeadAlertPane` 与普通 blocked-kind recovery 分支,并 pin 一条非退休 Lead kind 的 reconcile 测试防误删)+ plugin 注入(:11163-11164,11189,11330-11344);`legacyDeliveryWatchdogsEnabled` config 字段与 :599/:641-647 死门一并删(等价于门恒 false 的现行为);contract delta 与 AutoRepairBot handler 删除**以 §3.11 逐 kind 矩阵为准**(AutoRepair 覆盖 :99-105 注册 + :176-184 dispatch,含 :105 pane 注册与 :183-184 pane dispatch —— R5 修正行号漏删);titleFor/bodyFor/AlertEventType **渲染条目保留加 legacy 注释**
- **留**:10min tick、onPollComplete、W-4 blocked 全链、导出纯函数(isSafeResumeMenuForEnter/isTransientThrottlePane/classifyLeadAlertPane/computeEventId/ALERT_ECHO_START)、IDLE_READY_MARKERS
- founder-reply-watchdog:删 pass-dead + cursor-pin(含 gate-poller.ts:637-644、:1149-1154、:543-556、:3100,3152);**同 commit 接活 unreachable-runner**(tick 调用与 :3604-3605 watchdogOn 均改为仅 `FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0"` 门;验证 runZombieGateHygiene :3662-3663 注入链完整)
- **保留 `FLYWHEEL_FOUNDER_REPLY_DELIVER` 及其全部投递分支与 cadence 测试(§3.7)**;registry founder_reply_watchdog 去 retiring 标记
- env `FLYWHEEL_PANE_IDLE_SUPPRESS` 删,flag `pane_idle_suppress` → RETIRED_FLAGS
- 测试按 case 精删(research.md §2.2),fixtures 分拣

### 刀 6:墓碑铲除(此刻门后已无活体 → 展开 = 纯简化)
- misroute:gate-poller 内嵌全段 + plugin.ts:6728-6746/8366-8369;hook-payload/mailbox-lead-runtime 的 misroute 渲染字段保留(历史 lead_events)
- park-watch.ts 整删 + StateStore listParkWatch* 两方法
- gap-scan:删 evaluateGapSuspicion/createSuspicionRegistry/defaultGapThresholds/**SuspicionRecord**(其存活消费者 detection-detector-wiring 本刀一并删);**保 openGapReader + OutboundSignal/GapCommEvidence**
- **detection-detector-wiring.ts + focused-frame-scheduler.ts + pane-frames.ts + 三者测试本刀一并删**(R1:它们与 gapScan 星座互指,拆开会跨刀断裂);plugin.ts gapScanTick(:7369-7500)+ gapSuspicionRegistry(:7284)+ focusedFrames(:7286-7368)删;FLYWHEEL_FRAME_* env 清理
- detection-reconcile-tick.ts 整删:cohorts 壳内联进 plugin(去 legacy 参数);detectionReconcileTick(:7591-7665)删;receipt cohort(:7666-7698)与 sinks(:7523-7590)保留;cohorts 测试用例迁移;sinks describeKind 的退休-kind 条目按 §3.11 处置(历史 `detection_escalations` 行仍需渲染 → 保留加 legacy 注释);plugin.ts:7517 receiptDetectionKinds 收缩、:7631 CASE_C 引用清理
- detection-escalation.ts:删 unifiedFlowOwnsTarget + resolveRecoveredDetectionTargets;其余保留
- delivery 对账:lead-event-delivery.ts 删 reconcile() + plugin.ts:6377/8314-8316 + gate-poller.ts:261,851-855;deliver()/ack token 保留
- 墓碑机制本体:legacy-delivery-watchdog-policy.ts 整删 + `legacyDeliveryWatchdogsOn` 全部分支展开(research.md §2.3 行号清单;此刻各处死支路已在刀 3/4/5 物理删除,展开不改行为);**lead-event-ack-policy.ts 按 §3.8 冻结常量保留**;zombie-gate 墓碑段(gate-poller.ts:3596-3605)+ RETIRED_WATCHDOG_ENV_VARS + retiredWatchdogLaneEnabled;legacy-ack-drain.ts 不动

### 刀 7:孤儿收尾 + 分层残留扫描
- deliverSuspicious(plugin.ts:7191)孤儿再判(focused-frame 已删,若 judge 路由仍用则留)
- notify-receipts.ts readNotifyReceipts 等测试-only 残余处置
- 按 §6 分层谓词全仓扫残留(不限 --type ts,覆盖 .mjs/.sh/.md/lead-rules)

### 刀 8:flag 真相层 + scripts + 文档收尾
- registry/truth 按 §3.13 策略收尾 + flag-truth.test.ts + feature-flags-registry.test.ts
- watchdog-health.ts 摘 RETIRING_WATCHDOGS/buildRetiringWatchdogRows/retiring 字段 + plugin.ts:3935-3949/:4630
- scripts 残留 env 引用(qa-fly-1189/qa-multilead/test-deploy-multilead/qa-fly-1282 文档)
- CLAUDE.md 里程碑行 + doc 随 PR(本项目 doc-flow:不挪 archive)

### 刀 9(Lead 裁定执行,唯一的非删除刀):detection-ack 端点 fail-safe 修复
- 按 §3.12 三项:too-long 可截断/哈希后仍可关闭、错误文案区分 missing/too-long、fingerprint 用 parent id 引用;独立 commit + 端点行为测试(too-long 关闭路径、文案断言、parent-id 往返);顺序放在刀 8 之后(它改保留代码的行为,与删除刀完全隔离)

## 5. 验收标准映射(issue 5 条 → 机器可验)

1. **分层残留扫描**(R1 修订,R2 限定到可执行/活跃运营面 —— 历史 plan/research/QA 文档是按 repo 约定保留的证据,不为验收改写,也不算残留):
   - 扫描范围(三层通用):`packages/*/src`、`packages/*/scripts`、根 `scripts/`、`packages/teamlead/lead-rules-base/`、根 `CLAUDE.md`、`doc/messaging-rework/`;显式包含 `.ts/.tsx/.mjs/.cjs/.sh/.md`;排除 `doc/engineer/**`、`engineering/doc/**`(本单文件夹除外的历史单据)、`product/**`、`**/archive/**`、`**/__tests__/fixtures/**`
   - a)模块/符号层(上述范围内**零命中**):
     `rg -g 'packages/*/src/**' -g 'packages/*/scripts/**' -g 'scripts/**' -g 'packages/teamlead/lead-rules-base/**' -g 'CLAUDE.md' -g 'doc/messaging-rework/**' "runner-receipt-patrol|lead-receipt-patrol|lead-pending-escalation|notify-digest-expect|workflow-route-reminder-drain|inbox-loop-health-checker|stuck-runner-detector|StuckWatcher|stuck-pane-confirm|watchdog-judge|detection-config-source|detection-escalation-sinks|detection-gap-scan|detection-suspicious|evaluateStuckCandidate|buildStuckRunnerDetector|reconcileStuckCodexHolds|reconcileCodexHoldNudges|checkMailboxOverflowMarkers|updateOverflowMarker|fireSuspicious|isIdleHealthyPane|misroutePatrol|runParkWatch|evaluateGapSuspicion|runDetectionReconcileTick|resolveRecoveredDetectionTargets|legacyDeliveryWatchdogsOn|retiredWatchdogLaneEnabled|RETIRED_WATCHDOG_ENV_VARS|notePassSuccess|FLYWHEEL_PANE_IDLE_SUPPRESS"` —— 允许的唯一例外:truth.ts `RETIRED_FLAGS` 字符串、CLAUDE.md 里程碑行(叙述性)
   - b)事件 kind 层(同范围,**双类 allowlist 命中**,R4/R5/R6):`pane_hash_stuck|pane_error_stalled|runner_stuck_unhandled|runner_throttle_stalled|runner_lead_pending|workflow_route_input_rejected|inbox_loop_stalled|receipt_unprocessed|wake_failed|runner_stuck_escalation` —— 允许两类位点:①**display**(titleFor/bodyFor/历史行 parser/describeKind);②**runtime-compat**(穷尽 KIND_CONTRACTS 的真实化 entry、TICKET_KINDS/ticket-owner-map fallback 等价条目、**INFORMATIONAL_KINDS/ISSUE_PROGRESS_KINDS/NO_OWNER_KINDS 的保留条目** —— 按 §3.11 矩阵)。PR 位点表对每个命中标注 `display` 或 `runtime-compat`,此外的命中才算失败
   - c)env 层(同范围):被删 env 名零命中或仅 RETIRED_FLAGS
   - 历史文档树(`doc/engineer/**` 等)另做一条**反向断言**:其中命中的符号不得被任何运行时代码 import(即 a 层已保证,无需改写文档)
2. **build + 全量测试**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(全仓;宿主机既有 flake 按 memory 清单甄别,保留项新红不得当 flake);**每刀 commit 前逐刀 `pnpm -r build`**
3. **Bridge 起得来 + fleet 12/12**:QA 阶段真机重启 Bridge(self-hosting ship 纪律,ship 窗执行),`/health` watchdog manifest 校验通过(w1/w2/w4 行在,w2 wired=true 且心跳 fresh)+ `scripts/bridge-liveness-probe.sh` 契约不降级
4. **真机一轮无追命告警**:起 1 个 runner 跑完整轮,断言零 `wake_failed`/`receipt_unprocessed`/`runner_lead_pending_*`/`stuck_*`/`pane_hash_stuck` 新告警(claims.db + lead_events + Discord 三处取证)
   - 另做 receipt writer 长窗验证:观察至少 24h(覆盖两个 3–12h 历史回放周期),三指标同时满足:first_detected 无新增、未结无界 COUNT 斜率为 0、基线后无新 rowid;送达时间不作为因果证据
5. **保留清单逐项点名**(research.md §3 表为底稿):BridgeEventLoopWatchdog(SIGKILL 沙箱验证或 /health 心跳 fresh)、RunnerIdleWatchdog W-1(kill 进程留裸 shell → runner_idle_detected)、quota/auth 扫描(1h 窗口证据)、五 reaper 抽查、GatePoller 搭车对账单测 GREEN + tick 日志、onPollComplete 保留 rider 照跑、**unreachable-runner 正面注入验证**(复活项)、**founder reply 投递 + deferred rebind 照常**(§3.7 红线回归)、account-switch(daemon 侧证据)、W-2 manifest fresh/stale 两态 + 外部探针
6. **QA 节点硬性要求(founder 直令 2026-08-04 06:01,lead-instruction 974746ff;QA 节点按此验收,不许 stub 替代)**:
   - **529 测试房真机 E2E**:真组件搭台(真数据库/真进程/真链路),参照 FLY-1624 标准 —— stub 测不到真调用,bug 会躲过评审
   - **真 Discord 腿**:凡本单涉及「通知/消息送达」的行为(保留告警链 W-4/unreachable-runner 复活/退休 kind 残留线程重放路径),把真实产物经真实发送链路发进 529 隔离频道,真送达 + 读取确认;生产频道零污染
   - **结论绑定精确 head**;修前/修后对照数字(追命告警计数、claims.db/lead_events 证据)进 QA 报告
   - **涉及重启行为的验收必须真实重启**(Bridge 重启 + fleet 12/12、seeded 退休-kind 行重启重放测试);不适用项在 QA 报告里说明为何不适用,不许沉默跳过

## 6. 风险与回滚

| 风险 | 缓解 |
| -- | -- |
| 中间 commit 复活死检测器 | 刀序第一原则:先删死代码(刀 3/4/5)后拆门(刀 6);unreachable 复活收敛在刀 5 单一 commit 内显式声明 |
| 误删保留项启动点(编译不红) | 验收 5 逐项点名 + 每刀只动 research.md 列明的行 + 逐刀 build |
| unreachable-runner 复活产生新告警 | 只在真实数据不一致时触发;QA 正面注入验证;`FLYWHEEL_FOUNDER_REPLY_WATCHDOG=0` 是既有活开关(非新增) |
| founder reply 投递被误伤 | §3.7 红线:flag/分支/测试全保留;验收 5 含投递回归 |
| codex_nudge_* 残行落 unknown_kind 死信 | 刀 3 ship checklist 盘点 SQL,非零等 drain 排空再部署 |
| W-2 契约降级(/health、外部探针) | §3.10 契约定稿:wired 置位迁移 + 两态测试 + probe 契约测试 |
| 批 1→批 2 空窗:runner 活着但卡死无自动发现 | founder 已接受;B 单同批;实际空窗比 issue 预估小(stuck/pane-hash 早已墓碑关死) |
| 两个 patrol 是「活着的」删除,receipt 闭环告警消失 | 实测数据支持(67% 重发噪音、真漏投 0.07%);C/D 重建;PR 点名全部已知间隙 |
| 回滚 | 纯删代码,单 PR revert 即整体回滚;无迁移、无 schema 变更 |

## 7. 交付物

- 分支 `flywheel-FLY-1570` 单 PR(base main),8 刀独立 commit + 文档 commit(CLAUDE.md 里程碑 + 本 doc 文件夹)
- PR 描述:已知行为变更清单(unreachable 复活/FN4 消失/三处积压间隙/kind legacy allowlist 位点表)+ 保留清单验证证据 + codex_nudge_* 盘点结果
- Codex code review 循环至 APPROVED;真机验收(验收 3/4/5)在 QA/ship 阶段完成
