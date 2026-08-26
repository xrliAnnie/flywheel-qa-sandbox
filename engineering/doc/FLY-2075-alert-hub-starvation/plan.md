# FLY-2075 告警主管道断流 — 实施计划
Issue: FLY-2075 (https://linear.app/geoforge3d/issue/FLY-2075/2073账管-告警主管道断流hub-饿死诊断-修复alert-threads-08-21-后零新行)
日期: 2026-08-26
基于: research.md

> **v10（code review hardening，2026-08-26）— 补充 v9。** 方案②下，原先走 Discord root-only 的九种 `INFORMATIONAL_KINDS`（`account_switched`、`model_cap_switched`、`model_cap_unknown`、`quota_switch_confirmation`、`quota_blocked_recovered`、`workflow_route_input_rejected`、`flag_scan_failed`、`flag_scan_no_clock`、`flag_scan_handoff`）也属于「普通告警」，因此改为 durable Claw mailbox；它们不进 Hub、不建 thread、不写 `alert_threads`。这不是静默丢弃，但会把 FLY-2076 的读取合同扩大为消费全部 `source_kind='infra_alert'` 行，不能只读原 ticket 子集或 `alert_threads`。升级边界同时收紧：只有合法的 17–20 位 Discord snowflake `mentionUserId` 才算显式升级；`workflow_engine_escalation` 优先用合法显式 mention，否则注入合法 canonical founder id；两者都不合法时 fail-safe 留在 Claw mailbox。Hub 已启用但 founder id 非法时，boot 打红灯并复用既有 `alert_unreachable_config` meta-alert；横幅明确显示 founder id 是否 resolved。
>
> **v9（founder rework，2026-08-26）— 本节取代下方 v3–v8 的车道裁定。** Annie 选择方案②：普通告警继续进入 Claw mailbox，founder 默认不可见；只有既有显式升级信号（`workflow_engine_escalation` 或 payload 已带 `mentionUserId`）进入 `AlertChannelHub`，且 workflow escalation 注入 canonical founder id。实现复用 `LeadInboxRuntime.enqueueInfraAlert`，不新增决策层；issue-progress 仍优先进入已绑定 issue thread，失败时退回 Claw mailbox。保留本 PR 已完成的四组删除、Hub 饥饿修复、`repair_status IS NULL` retention 修复与独立 `alert_unreachable_config`；删除因方案②重新失去意义的 `ticket-route-health` helper / `ticket_route_unreachable` reason。验收改为：普通事件写 `infra_alert` mailbox 且不建 Discord/`alert_threads`；一条可辨识 `workflow_engine_escalation` 完成 Discord 根消息 → thread → `alert_threads`，根消息带 founder mention。**FLY-2076 接缝**：T1 必须读取 Claw mailbox 的 durable `source_kind='infra_alert'` 行；若只读 `alert_threads`，普通告警会全部漏掉。当前仓库没有 FLY-2076 实现或计划文件可核，故该消费者接缝明确交给 Lead/后续单。
>
> **v8**(Codex R7 之后,Lead 于 2026-08-26 08:43Z 指令 `cc61a7af` 收口):R7 仅剩 1 条 fixture 类意见(T7e-③ 的渲染器用例在今日代码上已绿、不是 RED),按 Lead 指令归入 §10「implementation-time checks」并视为 Lead 层接受;设计层不再迭代(无 Lead 明示不跑 R8)。
>
> **v7**(Codex R6 之后):R9 的 residue gate 改为有作用域的调用点检查(`alert_unreachable_config` 在 plugin.ts 有三处各有用途的合法发送点,只替换 route-health 那一处);T7f 写明 `notify` / `log` 的绑定合同(不传裸方法,`MetaAlertNotifier.notify` 依赖 `this`);删 `AlertTicketContext.status` 的影响传播到全部测试 fixtures(tsconfig 不检查 `*.test.ts`)并加作用域 residue check。
>
> **v6**(Codex R5 之后):`AlertTicketContext.status` 字段整个删除(首发状态由渲染层与 Hub 各自写死 NEW,不再有被忽略的假输入);T7f 明确「替换并删除」`plugin.ts:9903-9912` 旧 effect 分支并用 effect seam + spy 锁「每 boot 恰一次」;R1 去掉 stub 捕获根正文的自测自身断言,改为把现有 `LeadAlertNotifier.test.ts:1069-1077`(ticket.status=ACK → 期望 ACK)列为 RED 改期望 NEW;R2/R3 撤回类型 RED 宣称;T11 补 `AlertChannelHub.ts:104-112` 的 needs_human→founder ping 注释。
>
> **v5**(Codex R4 之后):根消息渲染层同样不信任 payload 状态(`formatContent` 首发恒 NEW,`LeadAlertNotifier.ts` 进改动清单,加真实队列回放测试);G0 改为接受 C1–C8;无 Hub 红灯/一次性 meta-alert 抽成纯函数并加 RED;撤回「类型 RED」宣称;验收 E 加 `ticket_status IS NOT NULL`;R8 真 Discord 负向证据改为逐 thread 拉取;修正 enqueue-time / reconcile-time `needs_human` 的表述矛盾并列注释级清理清单;cap-owner 定案。
>
> **v4**(Codex R3 之后):补上两处会让「NEW / repair_status=NULL」合同失效的生产状态种子(`enrich()` 的 ESCALATED 预置、Hub 的 `pending` 初值)、无 Hub 时唯一车道的 fail-loud 合同、QA harness / 测试的完整删除清单、cap-owner 分支的定案、retry 单调进展、真 RED、可机械选取的验收 E、以及 2076 上线证据作为 ship 门。
>
> **v3(方向变更)**。

## 0. 一句话

ticket 类告警回到**唯一**一条路:D1 Router → AlertChannelHub → `#flywheel-alerts` 根消息(🎫 owner @)→ thread → `alert_threads`;mailbox ticket 车道与 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` 旋钮一并删除;Hub 不再自动 @founder、不再自动置 `ESCALATED`——工单开出来就是 `NEW`,等值守初审;真有自动修复(ARC)的少数 kind 照旧 `REPAIRING` → 自愈 `RESOLVED`。

## 0.1 拆掉什么、留下什么(按代码逐条)

### 拆掉的路径(paths removed)

| # | 路径 | 代码落点 | 拆掉后 |
|---|---|---|---|
| P1 | Router ticket 分支 → claw mailbox(FLY-1764 Flow 2 最后一公里) | `plugin.ts:10351-10360` 的 `ticketSink` + `copyTicketToChannel` 接线;`infra-event-router.ts:139-141,167-178` 的 `ticketSink`/`copyTicketToChannel`/`deliverTicket`;`infra-alert-wiring.ts:48-50,127,153,168-169` | ticket 分支 = `rawSink.alert(payload)`(= Hub);issue-thread 投递失败的 fail-safe 也回到 rawSink(FLY-927 原样) |
| P2 | 旋钮 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` | `infra-alert-mailbox.ts:9-19`(`INFRA_ALERT_LAST_MILE_ROUTE`、`shouldCopyInfraAlertToChannel`);`truth.ts:596` | 常量与函数删除;`truth.ts` 从 `NON_FLAG_ALLOWLIST` 移除,加入 `RETIRED_FLAGS`:`{ envVar: "FLYWHEEL_ALERT_COPY_TO_CHANNEL", retiredBy: "FLY-2075" }`(生产 `.env` 无此项,已核) |
| P3 | 开 thread 时 by-design 自动升级 | `AlertChannelHub.ts:468-489`(`escalatesAtEnqueue` → `postByDesignEscalation` @founder + `ESCALATED` + `onTicketEscalated`);**以及 Router 侧的状态预置** `infra-alert-wiring.ts:213-215`(`enrich()` 对 `escalatesAtEnqueue` 的 kind 把 `ticket.status` 种成 `ESCALATED`);经 Router 会命中的 kind:`zombie_session_backlog`、`inbox_loop_stalled`、`stale_approved_ship_dead`、**未绑定 issue thread 时兜底成 ticket 的** `runner_lead_pending_unhandled` | Hub 段整段删除;`enrich()` 不再写状态(字段删除,首发 NEW 由渲染层与 Hub 各自写死);`escalatesAtEnqueue()` 函数及其测试删除(`KindContract.arc` 字段保留为文档,注释改为「FLY-2075 起不再驱动任何自动升级」) |
| P4 | 开 thread 时 `needs_human` 自动升级 + `pending` 初值 | `AlertChannelHub.ts:516-582` `case "needs_human"`(cap-owner 分支除外,见下);`AlertChannelHub.ts:431` `repairStatus: this.deps.autoRepairBot ? "pending" : null` | 不发 mention 帖、不写 `repair_status`(`needs_human` / `pending` 都不写)、不置 `ESCALATED`、不调 `onTicketEscalated`;`openAlertThread` 的 `repairStatus` 初值恒 `null`,只在真实 `attempted` / `no_action` 后写;`ticketStatus` 初值 = `payload.ticket ? "NEW" : null`(payload 里**没有**状态可信:`AlertTicketContext.status` 字段删除,T7e);**根消息同样**:`LeadAlertNotifier.formatContent()`(`:1941`)的 🎫 header 首发写死 `状态 NEW`,后续状态只由 Hub `updateRootTicketStatus(channelId, messageId, status)` 编辑——否则旧队列 payload 回放时(drain 先发根消息、再 `attachDeliveredAlertLifecycles` 回接 Hub,`LeadAlertNotifier.ts:1348-1366`)根消息会先显示 ESCALATED |
| P5 | reconcile 的 T2 升级 | `AlertChannelHub.ts:819-906`:`decideTicketEscalation` 的 `"escalate"` 决策 → `escalateTicket()`;retry 分支 `needs_human` → `escalateTicket()` | `escalateTicket()` 整函数删除;`decideTicketEscalation` 不再有 `"escalate"` 返回值(超时 / 重试耗尽 / 无人认领 → `"none"`,ticket 停在当前状态,可见不静默);**单调进展**:retry 分支的 `needs_human`(安全闸拒绝)也 `bumpTicketAttempt` 计一次尝试 → 受 `maxAttempts`(2)封顶,最多两条无 mention 的「🔁 自动修复安全闸拒绝」帖,不写状态;`first_seen_at` 缺失 / 非法 → `decideTicketEscalation` **fail-closed 返回 `"none"`**(不再当 age=0 无限 retry) |
| P6 | issue 绑定 ticket 的 founder page | `AlertChannelHubDeps.escalateToIssueThread`(`AlertChannelHub.ts:266`)+ `plugin.ts:10271-10321`(`emitFounderStuckNotification` + `recordFounderPaged`) | dep 与接线删除(`emitFounderStuckNotification` 的其他消费者不动) |

`fleetEscalationLine` / `postByDesignEscalation` / `founderId()` 随 P3–P5 一起删除(Hub 内无其他调用点,`founderId()` 只在这三处用)。**`case "needs_human"` 里的账号 cap owner 分支**(`formatAccountCapOwnerAssignment` + `mentionUserId: capOwnerId`,@ 的是 cap owner bot 不是 founder)——**定案:保留为纯认领通知**(owner handoff,不是 ACK、不是升级):`infra-notify.ts:76-81` 文案改为 `<@owner> 请认领:${reason}`(删掉「修不掉判定 = 重试 2 次或 5 分钟,T2」的承诺,T2 已不存在);ticket 留 `NEW`、`repair_status` 留 `null`、零 founder mention;其测试同步。(**已定案**,不再留给 G0 或实现期改判。)

### 拆掉的状态(states removed)

- `repair_status = "needs_human"`:Hub 不再写(P4/P5)。`AutoRepairBot.attempt()` 仍会返回 `needs_human`(它是 bot 的合同),Hub 只是不再据此改状态。
- `ticket_status = "ESCALATED"` 的**自动**写入:全部删除。状态值本身保留(schema、根消息渲染、`decideTicketEscalation` 的终态判断都认它),只允许人 / 值守 bot 显式置(FLY-2076 的事,不在本单)。
- **真实 Discord E2E harness 与固定旧语义的测试(Codex R3 抓出,本 PR 必改否则运行时断裂)**:`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`(`:95` 动态 import `runbook-gap.js`、`:209` 传 `onTicketEscalated`、`:657-697` 断言 zombie 直接 `ESCALATED`)改成 channel-only、零自动 page、zombie `NEW` 的真实链路(`qa-fly-1193-debounce-e2e.mjs:13-15` 只是注释引用,不改);`bridge/__tests__/fleet-ticket-enrich.test.ts:119-125`(zombie seeds ESCALATED → 改 NEW)、`bridge/__tests__/kind-contract.test.ts:275-292`(`escalatesAtEnqueue` 用例删)、`bridge/__tests__/escalation-chain.test.ts`、`alert-ticket-lifecycle.test.ts`、`src/__tests__/AlertChannelHub.contract-escalate.test.ts`(逐条改期望)。
- 随之**变成死代码、本 PR 一并删除(Lead 已授权「配套删除」;下列若 Lead 要保留请在 G0 前说)**:`AlertChannelHubDeps.onTicketEscalated` + `plugin.ts:10322-10328` 接线 + `runbook-gap.ts` 的 `noteTicketEscalated`(runbook-gap 自动建 eng issue:没有自动 ESCALATED 就永远不触发)+ 其测试;`kind-contract.ts:344` `FLEET_ESCALATION_COPY`(仅 runbook-gap 与 `fleetEscalationLine` 用);`ticket-escalation.ts` 的 `unclaimedMs`(只服务 `escalate`);Hub 对 `HUMAN_ONLY_REASON` 的 import(`AutoRepairBot` 自己仍用)。**读侧消费者 sweep(Lead 要求,2026-08-26 07:5x Z)**:对 `infra_alert`(source_kind / `[infra_alert]` 内容前缀 / collapse_key)在 `packages/`、`scripts/`、`.claude/`、`~/.claude/agents`、`~/.claude/skills`、`~/.claude/plugins/cache/*`、`flywheel-comm` mailbox CLI 的过滤条件里 grep:**只有写入方**(`lead-inbox-runtime.ts:485-526`、`infra-alert-mailbox.ts:29`),没有任何读取/匹配这些行的代码;`login_expired` 的命中(`scripts/lead-alert.sh`、`qa-fly-529-alert-smoke.sh`、`fly-2006-retention-*.mjs`)都是发射或保留策略,不读 mailbox。未检查的 root:插件 fork 源 `xrliAnnie/claude-plugins-official`(未 clone 到本机)。⇒ Router ticket 车道的 mailbox 行没有机器读者;claw 是 LLM 读者,它改读频道是 2076 的事。`ticket_escalations` 表不删、不再写;`StateStore` 的 `recordTicketEscalation` / `countTicketEscalations` / `getFounderPaged` / `recordFounderPaged` 等方法**保留**(schema 与 store 不动,只是没有调用者;列入「未来可删」不在本 PR 删)。

### 留下的(不动)

- ARC(有条件的自动修复,`AutoRepairBot.attempt()` 的合同不变):`bridge_abnormal_exit`(launchd 已重启即 `attempted`)、`swap_pressure_high`(`attempted` / `no_action` / `needs_human` 三态,`fleet-sensors.ts:358-465`)、`infra_bot_down`(有 job label 才 `attempted`)、`tmux_server_lost`(有 metadata 且 `migrated ≥ casualties` 且 `leadsFailed = 0` 才 `attempted`,`AutoRepairBot.ts:162-189`);`usage_limit` 的账号切换已在 FLY-1456 永久拆除(`quota-daemon-cutover.ts:17` `attachAccountSwitch: false` ⇒ `plugin.ts:9942` 的 `accountSwitchRepair` 为 undefined),生产上恒 `needs_human`。`attempted` → `REPAIRING` → reconcile 重试(`maxAttempts`/`timeoutMs` 限次数与窗口,耗尽后停在 `REPAIRING`)→ recovery probe 自愈 `RESOLVED`;`no_action` → `MONITORING`;`needs_human` 分两个时刻:**开 thread 时**(enqueue-time)= 不写状态、不发帖、不 @、ticket 留 `NEW`(cap-owner 认领通知除外,见 P4);**reconcile 重试时**的安全闸拒绝 = 见 P5(计一次 attempt、一条无 mention 帖、ticket 留 `REPAIRING`,封顶后停)。
- 根消息 🎫 header + owner @(`enrich()` → `ticket.ownerUserId` → `allowed_mentions`,`LeadAlertNotifier.ts:1720-1730`):**这是频道单车道下 claw 被叫到的唯一机械**。
- `resolve()` / `reconcile()` 的恢复探针、`attachDeliveredAlertLifecycles`(队列回放)、限速 20/min、队列 cap 500 / 3 天。
- `enqueueInfraAlert`(`lead-inbox-runtime.ts:485`)与 `formatInfraAlertMailboxContent`:另有三处**定向** mailbox 消费者(`plugin.ts:5150` workflow source fallback、`:7419` / `:7491` flag-scan 告警),不属于 ticket 车道,**不动**;`infra-alert-mailbox.ts` 只保留 `formatInfraAlertMailboxContent`(或迁入 lead-inbox-runtime.ts 后删文件,二选一,实现时定)。
- `mailbox_dead_letter` 等直连 raw notifier 的告警(`plugin.ts:9137`)、shell 路径死信(FLY-2062)。

### 无 Hub 时唯一车道怎么办(Codex R3 #2,必须定义)

`plugin.ts:10210` 只在 `unifiedAlert && repairChainResolves` 时构造 Hub;否则 `rawSink = leadAlertNotifier`。单车道下 ticket 分支直接落到它:Lead 归属的 kind 走 legacy 单 Lead 频道路径(可投);fleet 身份(`leadId` = bridge / swap / zombie / machine)在无 unified 时被 `LeadAlertNotifier.ts:905-924` 逐条 `unknown-lead` dead-letter 并逐条 `alert_dead_lettered` meta-alert(osascript)——这是 **FLY-927 → FLY-1764 之前的既有合同**,由 `LeadAlertNotifier.fleet-identity.test.ts:129-134` 锁定。**定案:不新增静默丢弃,沿用该 fail-loud 合同**;配套:① boot 时若 `unifiedAlertChannelId` 缺失或 repair chain 不可解析,打红灯行 `[Bridge] ticket route: channel — NO HUB (unified channel / repair chain unresolved); fleet tickets will dead-letter` 并复用 `plugin.ts:9898-9912` 既有的 `alert_unreachable_config` meta-alert(**每次 Bridge boot 一次**,非逐事件;`MetaAlertNotifier` 的 debounce 是进程内的,重启会再报一次);红灯文案与 meta-alert 载荷由纯函数 `resolveTicketRouteHealth({ unifiedChannelId, repairChainResolves })` → `{ redLight: string \| null; metaAlert: {...} \| null }` 产出(T7f),plugin 只负责打印/发送一次;② 生产前置已核:`.env` 有 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`,`CASS_BOT_TOKEN` / `FLYWHEEL_ALERT_SENDER_TOKEN_ENV` 可解析,当前 Bridge 每次 boot 都打 `AlertChannelHub ON`;③ QA 隔离房若不配 unified channel,就会看到这条红灯 + fleet ticket 死信——那是配置错误的可见信号,不是本单要修的路径。blast radius 写进 §0.2 C8。

## 0.2 拆掉之后立刻发生什么(founder 据此拍板)

| 后果 | 说明 |
|---|---|
| C1 claw 的 mailbox 工单账**停止增长** | 今天 claw 对 ticket 类告警 0.5 分钟 ACK 的那本账(comm.db `infra_alert`,08-15 起 1,441 行)不再有 Router 来的新行;claw 改为在频道被 🎫 @(Discord mention)。claw 的运行时**是否会因频道 @ 醒来、去看整条队列**,是 FLY-2076 的范围 |
| C2 **没有自动读者的窗口** | 在 2076 上线前:频道里的 ticket 既没有 mailbox nudge、也没有 @founder,只有根消息里对 claw 的 @。Lead 明示可与 2076 分开上线;founder 需明确接受这个窗口,或要求 2076 先行 |
| C3 founder 不再被 Hub 自动 @ | 改道前 08-05~14 每天 19~34 次(几乎全部 `needs_human`)的 thread 内 @Annie **不会回来**;她只会被值守/人显式 @ |
| C4 `ESCALATED` 不再自动出现 | PRD §1.3 的「425 ESCALATED」模式终止;超时 / 重试耗尽的工单停在 `NEW` / `REPAIRING` / `MONITORING`,**挂着可见**(R6),没人推它 |
| C5 runbook-gap 自动建单停止 | 同 kind 7 天 ≥3 次 ESCALATED 自动建 eng issue 的机制随 ESCALATED 消失而死,删除 |
| C6 频道日量 | ≈ 改道前水平 + 新 kind(`cmux_watcher_stalled` 08-24/25 各 101/171 行):每天几十到三百条根消息(限速 20/min,溢出走队列回放) |
| C7 | issue 绑定的 ticket 不再在 issue thread 里 page founder(P6) | 该 page 是 T2 的一种形态,随 T2 一起删 |
| C8 | 配置错误时的失败形状(仅当 unified channel / repair chain 缺失) | 频道是唯一车道:fleet ticket 逐条 `unknown-lead` dead-letter + meta-alert(既有 fail-loud 合同),不会静默丢;boot 红灯行可见。生产配置完整,此路径只在误配时出现 |

## 0.3 前提与 G0 门(founder 裁定点)

1. **确认裁定原文**「不双发,只发 Discord」(07:12Z 暂定,待 Tadashi 复述确认)——即 mailbox ticket 车道**拆除**而非保留;
2. 接受 **C1–C8**,尤其 C2(2076 上线前的无自动读者窗口)与 C8(无 Hub 误配时 fleet ticket 逐条 dead-letter + 每 boot 一次桌面 meta-alert 的失败形状,含 QA 房行为变化)。**默认建议(Lead 2026-08-26 定)**:本单的切换**不早于 FLY-2076 值守上线**那一班部署——除非 founder 明确接受这个窗口;
3. 接受「Hub 永不自动 @founder / 永不自动 ESCALATED」为长期合同(不是过渡);
4. 死代码清单(§0.1「随之变成死代码」)一并删除。

**G0(merge 门,affirmative)**:founder 对 1–4 给出**可引用的明确接受**(HTML 批注 / Discord 原话 / issue comment,Tadashi 转达并在 `approve_to_ship` 引用)。**未回复 / 含糊 = BLOCKED at ship**:PR 保持 draft 不合。Codex design approval 是工程门,不替代产品裁定。任一条否决 → 不 merge,Tadashi 重新立项。实现可以先做(节点合同),PR 在 G0 满足前 draft。

**时序约束(Lead 明示)**:频道车道只能与自动 @founder 删除**同一个 PR、同一次部署**上线,永不单独;本计划以单 PR 满足。

**部署门(merge 之后、班车之前,二选一证据缺任一即不部署)**:(a) FLY-2076 值守已部署的证据 —— 其 build / health 记录 + **一次真实的频道 @claw → claw 醒来 / ACK 的回执**(截图或账本行);或 (b) founder 对**本次部署**的无自动读者窗口的逐字明确接受。G0 里早先的接受不能替代部署时的复核(merge 与班车之间 2076 状态可能漂移)。`approve_to_ship` 必须引用其一。

## 1. 改动清单(文件级)

| # | 文件 | 改什么 |
|---|---|---|
| T1 | `packages/teamlead/src/bridge/infra-event-router.ts` | 删 `ticketSink` / `copyTicketToChannel` deps 与 `deliverTicket()`;ticket 路由 = `deps.rawSink.alert(payload)`;更新文件头注释(`"ticket"` 的落点 = unified channel Hub);`:140` 注释删 |
| T2 | `packages/teamlead/src/bridge/infra-alert-wiring.ts` | 删 `ticketSink` / `copyTicketToChannel`(`:48-50,168-169`);`:127` / `:153` fallback 改 `deps.rawSink.alert(payload)`;`enrich()` 不再产出 `status`(`:213-215` 删,`AlertTicketContext.status` 字段随 T7e 删除),删 `escalatesAtEnqueue` import;注释同步 |
| T3 | `packages/teamlead/src/bridge/plugin.ts` | ① 删 `INFRA_ALERT_LAST_MILE_ROUTE` / `shouldCopyInfraAlertToChannel` import 与 `:10351-10360` 接线;② 删 `escalateToIssueThread`(`:10271-10321`)与 `onTicketEscalated`(`:10322-10328`)接线及 `noteTicketEscalated` import;③ boot 横幅改为 `[Bridge] FLY-368 AlertChannelHub ON (unified channel=…, auto-repair=ON, ticket-route=channel, founder-auto-escalation=OFF)`(静态文案,无旋钮) |
| T4 | `packages/teamlead/src/bridge/infra-alert-mailbox.ts` | 只留 `formatInfraAlertMailboxContent`(或迁入 `lead-inbox-runtime.ts` 后删文件);`INFRA_ALERT_LAST_MILE_ROUTE` / `shouldCopyInfraAlertToChannel` 删 |
| T5 | `packages/teamlead/src/bridge/AlertChannelHub.ts` | ① 删 `:468-489` by-design 段;② `case "needs_human"`:保留 cap-owner 认领通知子分支(状态留 NEW、不写 repair_status),其余删(不发帖、不写状态、不 ESCALATED);③ `:431` `repairStatus` 初值恒 `null`;`ticketStatus` 初值 = `payload.ticket ? "NEW" : null`;④ `reconcileTicket`:`decision === "escalate"` 分支删,retry 的 `needs_human` 子分支 = `bumpTicketAttempt` + 一条无 mention 帖;⑤ 删 `escalateTicket` / `fleetEscalationLine` / `postByDesignEscalation` / `founderId`、deps `escalateToIssueThread` / `onTicketEscalated`、`FLEET_ESCALATION_COPY` / `HUMAN_ONLY_REASON` / `escalatesAtEnqueue` import;⑥ 类头注释更新:Hub 不 @founder、不自动 ESCALATED、不信任 payload 状态 |
| T6 | `packages/teamlead/src/bridge/ticket-escalation.ts` | `TicketEscalationDecision = "none" \| "retry"`;删 `unclaimedMs` 与所有 `"escalate"` 返回(超时 / 耗尽 → `"none"`);`first_seen_at` 为 null / 非法 → `"none"`(fail-closed,不再 age=0);`policyForKind` 保留 `maxAttempts` / `timeoutMs` / `retryOnReconcile` |
| T7 | `packages/teamlead/src/bridge/runbook-gap.ts` + `kind-contract.ts` | 删 `noteTicketEscalated` 及文件(若文件只含它)、删 `FLEET_ESCALATION_COPY`(`:344`)与 `escalatesAtEnqueue()`(`:333`);`KindContract.arc` 字段保留,文件头注释改写为「arc 只描述 ARC 姿态,FLY-2075 起不驱动任何自动升级」;`validateKindContracts` 若引用需同步 |
| T7b | `scripts/qa-fly-1082-fleet-alerts-e2e.mjs` | 去掉 `runbook-gap` import 与 `onTicketEscalated`;场景 ⑤ 改断言 zombie `NEW`、零 founder mention;其余场景按 channel-only 语义校正 |
| T7c | `packages/teamlead/src/bridge/infra-notify.ts:76-81` | `formatAccountCapOwnerAssignment` 文案改为纯认领通知(删 T2 承诺) |
| T7d | `packages/teamlead/src/bridge/plugin.ts` boot | 无 Hub 时红灯行(§0.1「无 Hub 时」) |
| T7e | `packages/teamlead/src/LeadAlertNotifier.ts:1941` + `:545-553` | ① `formatContent()` 🎫 header 的状态首发写死 `状态 NEW`(不读 payload);② **删除** `AlertTicketContext.status` 字段(实施后无任何运行时读者:`formatContent` 与 `openAlertThread` 都不再读它,`updateRootTicketStatus` 用独立参数);`enrich()` 不再写 status(T2);旧 queue JSON 里多出的 `status` 键在运行时被忽略;③ `LeadAlertNotifier.test.ts:1069-1077` 现有用例改为 **legacy-input 兼容 RED**:**保留** `status: "ACK"`(ticket 对象 `as any`,即旧 JSON 形状),断言根 POST 为 `状态 NEW`——今日代码渲染 ACK 而红,T7e 后绿(Codex R7:若删掉 `status` 再期望 NEW,旧 renderer 的 `|| "NEW"` 兜底会让它直接绿,不是 RED);该用例与 R1-⑤ / R10 一样列入 ④ residue check 的允许例外;④ **fixture 传播**(tsconfig 排除 `*.test.ts`,`tsc` 不会替你发现):删除下列 typed fixture / helper 里的 `status` 键——`LeadAlertNotifier.test.ts:1044-1048, 1740-1744, 1771-1775`、`bridge/__tests__/alert-ticket-lifecycle.test.ts:28-33`、`bridge/__tests__/escalation-chain.test.ts:71-76, 131-136`、`bridge/__tests__/fleet-ticket-enrich.test.ts:135`、`src/__tests__/AlertChannelHub.contract-escalate.test.ts:64-71` 的 `ticket(status)` helper(改为无参 `ticket()`)、`bridge/__tests__/infra-alert-wiring.test.ts:292-299`(不再期待 `status: "NEW"`);**作用域 residue check**:除 R1-⑤ / R10 明确标注的 legacy JSON(`as any`)兼容用例外,`packages/teamlead/src` 下新 payload fixture 不得再含 ticket `status`(review 时 grep `status: "NEW"\|status: "ACK"` 于 `ticket:` 上下文应为 0,`ticket_status` / `ticketStatus` 与 StateStore detection 测试的同名字段不在范围) |
| T7f | `packages/teamlead/src/bridge/ticket-route-health.ts`(新) + `plugin.ts:9903-9912` | 纯函数 `resolveTicketRouteHealth({ unifiedChannelId, repairChainResolves })` → `{ redLight, metaAlert }`;effect seam `emitTicketRouteHealth(health, { log, notify })`:健康 → 0 次调用,缺任一 → `log` 恰 1 次 + `notify` 恰 1 次;**plugin.ts:9903-9912 的旧 `console.error` + `metaAlertNotifier.notify()` 分支替换并删除,不得与新 helper 并存**;**绑定合同**:plugin 传 `log: (line) => console.error(line)`、`notify: (input) => { void metaAlertNotifier.notify(input); }`(**不传裸方法引用**——`MetaAlertNotifier.notify()` 入口即读 `this.now()` / `this.lastSent`,裸引用会丢 `this` 而 spy 测试抓不到;保持 boot 不等待通知完成的既有语义,deps 类型接受 best-effort async);plugin boot 恰调用 `emitTicketRouteHealth` 一次。**保留不动**:`plugin.ts:9891`(repair-bot degraded)与 `:10725`(Lead alert channel unreachable)两处同 reason 的既有 fail-loud 通知,不在本单范围 |
| T11 | 注释级合同清理(不改行为、不改返回值、不改 schema) | `AutoRepairBot.ts:36-41, 72-75, 97-102, 224-227`(删「Hub 加 🙋 @Annie / escalated to Annie」陈述)、`LeadAlertNotifier.ts:286-294`(zombie「lands directly ESCALATED」)、`ticket-owner-map.ts:12-16, 71-75`(T2 unclaimed fallback / 「set the ticket status straight to ESCALATED」)、`AlertChannelHub.ts:104-112`(`postToThread` 的「only a needs_human escalation opts in to a single REAL founder @-ping」→ 改为「只有 cap-owner / 显式 owner handoff 会带 mention」)、`StateStore.ts` alert_threads 方法附近的 T2 注释;统一改为「enqueue-time needs_human = NEW 无帖(cap-owner 例外);reconcile-time 拒绝 = REPAIRING 计数无 mention 帖;Hub 永不自动 @founder / ESCALATED」 |
| T8 | `packages/config/src/feature-flags/truth.ts` | `NON_FLAG_ALLOWLIST` 删 `FLYWHEEL_ALERT_COPY_TO_CHANNEL`;`RETIRED_FLAGS` 加 `{ envVar: "FLYWHEEL_ALERT_COPY_TO_CHANNEL", retiredBy: "FLY-2075" }`;`scripts/check-flag-truth.ts` 必须 `flag truth OK` |
| T9 | `engineering/doc/FLY-1764-lead-events-redesign/plan.md` | 文首追加守卫段:「2026-08-26 FLY-2075:founder 改裁『不双发,只发 Discord』,Flow 2 的 mailbox 最后一公里与 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` 已拆除,下文为历史」。只追加不改写 |
| T10 | `engineering/doc/milestones/FLY-2075.md` | PR 最后一个 commit 新建;不碰 `CLAUDE.md` |

**不改**:`AutoRepairBot.ts` 的返回值与 `canAttempt` 逻辑(T11 只动注释)、`lead-inbox-runtime.ts` 的 `enqueueInfraAlert`、`fleet-sensors.ts`、StateStore schema、Discord 发送 / 限速 / 队列代码(T7e 只动 header 文案)、`~/.flywheel/.env`。

## 2. TDD 顺序

### RED(先写,先看红)

| # | 测试文件 | 用例 | 现状 |
|---|---|---|---|
| R1 | `bridge/__tests__/infra-alert-wiring.test.ts` | ① FULL-UNION SWEEP(routing ON):ticket kinds → `rawSink` 恰一次、返回值 = rawSink 的返回;issue_thread / notify 分支不变;**真 RED**:注入一个与 raw 不同的 legacy `ticketSink`(测试内 cast)并断言它被忽略、raw 恰一次(今天会被调用 → 红);②(撤回「类型 RED」:`packages/teamlead/tsconfig.json:10` 排除 `**/*.test.ts`,vitest 不做类型检查,`@ts-expect-error` 没有 runner 会执行——只保留 ① 的运行时哨兵);③ 删 `:142` copy 用例;④ issue-thread 投递失败 → 原 payload 进 `rawSink`(替代 `:223` 的 owner-mailbox 断言);④b `fleet-ticket-enrich.test.ts:119-125` 改为断言 enriched ticket **没有** `status` 键、owner 仍为 `infra_bot:claude`;⑤ **端到端**:`rawSink = { alert: (p) => hub.handle(p) }`,真 in-memory `StateStore` + fake discord(记录全部 thread 帖与 `mentionUserId`)+ 生产形状 `new AutoRepairBot({})`:投 `review_advisory_pass`(tickets ON、owner 已配置)→ `alert_threads` 有行、`ticket_status === "NEW"`、`repair_status === null`(今天 = `"pending"` → 红)、fake discord **零** founder mention(`mentionUserId` 与正文均无 `<@founder>`);投 `zombie_session_backlog` → 同上(by-design 段已删,Hub 种 NEW);投 `bridge_abnormal_exit` → `attempted` / `REPAIRING`(ARC 保留);投带多余 `status:"ESCALATED"` 键的旧 payload(as any)→ 账本行 `NEW`(根消息正文由 R10 的真实渲染路径验证,R1 的 notifier stub 看不到 `formatContent`,不在此处自测自身);阴性对照:同一 fixture 在今天代码上出现 founder mention / ESCALATED / pending(改 Hub 前先跑一次记录红) | 全部红 |
| R2 | `src/__tests__/AlertChannelHub.test.ts`、`AlertChannelHub.contract-escalate.test.ts`、`bridge/__tests__/alert-ticket-lifecycle.test.ts` | 逐条改写 `needs_human` / `ESCALATED` / founder-mention 断言(现有 30+ 处):开 thread → `NEW` 无 mention;reconcile 超时(`REPAIRING` 超 `timeoutMs`、`MONITORING` 超时、`NEW` 超 5 分钟)→ 状态不变、零帖、零 mention;retry 耗尽 → 停在 `REPAIRING`;(不宣称类型 RED;`escalateToIssueThread` / `onTicketEscalated` 的删除由 `pnpm -r build` 对 plugin.ts 旧接线的真实编译失败把关);cap-owner 指派分支仍 @ cap owner 且状态 `NEW` | 全部红 |
| R3 | `bridge/__tests__/ticket-escalation.test.ts` + Hub reconcile 用例 | `decideTicketEscalation` 对 `NEW`+owner+超 5 分钟 / `REPAIRING` 超时 / `MONITORING` 超时 / 耗尽 → `"none"`;`first_seen_at` 为 null / `"garbage"` → `"none"`(今天 = age 0 → `retry` → 红);(不宣称类型 RED);Hub:连续两次 reconcile 的安全闸拒绝 → `attempt_count` 1→2、两条帖,第三次 → 无帖(封顶) | 红 |
| R4 | `packages/config/src/__tests__/flag-truth.test.ts` | `RETIRED_FLAGS` 含 `FLYWHEEL_ALERT_COPY_TO_CHANNEL`(retiredBy `FLY-2075`);`NON_FLAG_ALLOWLIST` 不含 | 红 |
| R5 | `bridge/__tests__/lead-inbox-runtime.test.ts` | `enqueueInfraAlert` 既有用例**不改**,必须保持绿(证明定向消费者未被误伤) | 绿(对照) |
| R6 | `bridge/__tests__/infra-alert-mailbox.test.ts`、`bridge/__tests__/escalation-chain.test.ts`(runbook-gap 链)、`kind-contract.test.ts:275-292`、infra-notify 的 cap-owner 文案用例 | 前者删除;escalation-chain 删 runbook-gap 段;kind-contract 删 `escalatesAtEnqueue` 用例;cap-owner 文案用例改为纯认领(无 T2 字样、零 founder) | 红/删 |
| R7 | `bridge/__tests__/infra-alert-wiring.test.ts`(无 Hub) | `rawSink` = 真 `LeadAlertNotifier`(unified 未配置)时,fleet 身份 ticket → `{skipped:"unknown-lead", deadLettered:true}`(fail-loud,不静默丢;与 `fleet-identity.test.ts` 同合同)、Lead 归属 ticket 走 legacy 路径 | 现行为(对照,证明 Router 不吞) |
| R8 | `scripts/qa-fly-1082-fleet-alerts-e2e.mjs` | 真 Discord E2E:包住 `discordOps.postToThread` 记录 content/options;用 StateStore 的 `thread_id` 逐个 re-fetch `/channels/<thread_id>/messages`;founder id 固定为隔离假 snowflake(env);断言 zombie `NEW`、所有 thread 帖正文无 `<@founder>`、Discord 返回的 `mentions` 不含该 id、根消息 header `状态 NEW`;implement runner 至少跑一次并把结果贴 PR | 今天断言 ESCALATED、且看不到 thread 内容 → 红 |
| R9 | `bridge/__tests__/ticket-route-health.test.ts`(新) | `resolveTicketRouteHealth`:齐 → 双 null;缺 unified / 缺 repair chain → 恰一条红灯串(逐字、不含换行)+ 一份 meta-alert 载荷;`emitTicketRouteHealth` 用 spy:健康 → `log` / `notify` 各 0 次;缺任一 → 各恰 1 次。**有作用域的 residue check(review 时 grep)**:plugin.ts 中旧文案 `FLY-368 alert threading misconfigured` / `per-error threads will NOT be created` 为 0 处;`emitTicketRouteHealth(` 在 plugin.ts 恰 1 处;route-health 使用独立 reason `ticket_route_unreachable`,`alert_unreachable_config` 保留 2 处(degraded / Lead-unreachable)——**不用全仓 reason 计数当门** | 函数不存在 → 红 |
| R10 | `src/__tests__/LeadAlertNotifier.queue-replay.test.ts`(新) | 真实回放路径:临时 queueDir 写入一份带 `ticket.status="ESCALATED"` 的旧 payload JSON → 真 `LeadAlertNotifier.drainQueue()`(fetch stub 捕获根 POST body)→ `attachDeliveredAlertLifecycles(hub)`(真 in-memory store + fake discord):根 POST 正文含 `状态 NEW`、账本 `NEW`、thread 帖全程无 `ESCALATED` / founder mention;**不许**手填 payload 直接调 Hub 冒充回放 | 今天根 POST 含 ESCALATED → 红 |
| G | `scripts/__tests__/check-flag-truth.test.sh` | 回归门,T8 后必须 PASSED | 绿 |

### GREEN

T1 → T2 → T6 → T5 → T7e → T7 → T7b/T7c → T7f/T7d → T3 → T4 → T8 → T11 → T9 顺序,最小实现。每删一段先让对应 RED 变绿,不顺手重构。

### REFACTOR

无计划内重构;dead-code 清单以 §0.1 为准,超出的不删(列出来问)。

## 3. 全仓自验

`pnpm lint` → `pnpm -r build` → `pnpm test:packages:run` → `bash scripts/__tests__/check-flag-truth.test.sh`。生产 host 上只跑触达文件,全量以 CI 为准(PR 写明)。

## 4. Codex code review

`codex:rescue` 循环到 APPROVED。评审重点:Hub 内是否还残留任何 founder mention 路径(grep `founderId\|<@` 应为零);`decideTicketEscalation` 无 `escalate`;`enqueueInfraAlert` 的三处定向消费者未被误伤;`RETIRED_FLAGS` 墓碑生效。

## 5. 验收(issue 原文两条)

**(a) 因果链落 issue comment**:exploration.md §3(含查询),PR 前贴。

**(b) 一条真实告警走完 Hub 全链**(部署后采,不注入):

| 步 | 动作 / 证据 | 判定 |
|---|---|---|
| 1 | 部署 = PR 合入后下一班 00:00 / 12:00 班车;`T0` = 新 Bridge boot;`/health` `buildSha` = merge sha | 前置 |
| 2 | bridge log 横幅含 `ticket-route=channel, founder-auto-escalation=OFF` | 必须 |
| 3 | 触发点 = `T0` 后账本里**第一条带 ticket 生命周期的新行**(未绑定 issue thread 的 issue-progress 事件也会经 raw sink 开行,但其 `ticket_status` 为 NULL,须排除):`sqlite3 ~/.flywheel/teamlead.db "select event_id, event_type, opened_at, thread_id, repair_status, ticket_status from alert_threads where opened_at > '<T0 as YYYY-MM-DD HH:MM:SS UTC>' and ticket_status is not null order by opened_at limit 1"` → `E` | 无行则等,见 7 |
| 4 | 该行:`thread_id` 非空、`ticket_status ∈ {NEW, REPAIRING, MONITORING}`(**不是** `ESCALATED`)、非 ARC kind 的 `repair_status` 为 NULL;再 join 回执:`select outcome, recorded_at from alert_delivery_receipts where event_id='<E>'` → `sent`(或 `queued_durable`:回执不会在 drain 后改写,以账本行存在为准) | 必须 |
| 5 | `sqlite3 ~/.flywheel/comm/flywheel/comm.db "select count(*) from mailbox where source_kind='infra_alert' and source_ref='<E>'"` → **0**(车道已拆);同时 `select type, count(*) from mailbox where source_kind='infra_alert' and created_at > '<T0>' group by type` 只剩 `flag_scan_*` / workflow-source 类(定向消费者仍活) | 必须 |
| 6 | Claude-in-Chrome 截 `#flywheel-alerts` 该根消息(🎫 owner @)+ thread:**无** `<@founder>` 帖 | 必须 |
| 7 | `T0` 后 6 小时账本无新行 → `INCONCLUSIVE`,继续等自然事件,不注入 | 处置 |
| 0 | 部署前:`ls ~/.flywheel/alert-queue/ \| wc -l` 记录队列状态(2026-08-26 为 0);Hub 不信任 payload 状态(T5 ③),旧回放不会种回 ESCALATED | 记录 |

## 6. 回滚

无旋钮(by design)。回滚 = revert PR + 下一班重启 → 逐字回到 FLY-1764 Flow 2(mailbox 车道 **+ 自动 @founder 一起回来**)。⛔ **回滚会恢复每天几十次自动 @founder,属于显著产品副作用,需要与本次 ship 同等级的授权(founder 或 Tadashi 转达),不得由 runner 自行 revert。** 不存在「只回滚一半」的路径——这正是时序约束要的。

## 7. 边界(本单不做)

| 不做 | 为什么 | 去处 |
|---|---|---|
| 值守初审 / ACK / claw 醒来读频道 | PRD R1/R2 | FLY-2076 |
| 人 / bot 显式置 `ESCALATED`、@founder 的规则 | 值守流程的一部分 | FLY-2076 / Epic |
| `mailbox_dead_letter` 直连路径 | 1764「现状即可」;它不经 Router | Epic 已知缺口 |
| shell no-token 死信 | 不在 Bridge 进程内 | FLY-2062 |
| 噪音判定 / 频道日量 / 限速调参 | PRD §5;既有机制 | 观察后再说 |
| `enqueueInfraAlert` 三处定向消费者 | 不是 ticket 车道 | 不动 |

## 8. 风险

| 风险 | 概率 | 处置 |
|---|---|---|
| founder 复述与暂定裁定不一致 | 中 | G0 前 Tadashi 确认;不一致则本计划作废 |
| 2076 未上线的无读者窗口 | 确定(若分开上线) | C2 明示;founder 可裁 2076 先行 |
| 删自动升级后工单永远 `NEW` 无人推 | 确定 | 这是裁定的含义(R6 挂着可见);2076 负责 |
| Hub 测试改动面大(30+ 断言) | 高 | R2 逐条改写,不删用例只改期望 |
| `enqueueInfraAlert` 定向消费者被误伤 | 低 | R5 对照 |
| 队列里 1764 世界的旧文件 | 无 | 队列现为空(0 文件);且回放本就走 Hub |

## 9. 文档与里程碑

同 v2 §10。

## 10. implementation-time checks(Codex R7 残留 · Lead 层接受,2026-08-26)

Codex 设计评审 R3→R7 逐轮收敛(8 → 6 → 4 → 3 → 1 条),R7 唯一剩余项属测试 fixture 类,按 Lead 指令 `cc61a7af` 不再开 R8,记在这里由 implement runner 在 RED 阶段执行并在 PR 里逐条打勾:

| # | 检查 | 来源 |
|---|---|---|
| IC-1 | `LeadAlertNotifier.test.ts:1069-1077` 的渲染器用例必须**保留** `status: "ACK"` 作为 `as any` legacy 输入并期望 `状态 NEW`(改 T7e 前先跑一次确认它是红的);不得通过删 `status` 让它假绿 | Codex R7 #1 |
| IC-2 | T7e-④ 的 fixture residue check 允许例外只有三处:IC-1、R1-⑤ 的旧 payload、R10 的磁盘旧 JSON;其余 `packages/teamlead/src` 新 fixture 不得含 ticket `status` 键 | Codex R6 #3 / R7 #1 |
| IC-3 | R9 的作用域 residue check:plugin.ts 旧文案 0 处、`emitTicketRouteHealth(` 1 处、route-health reason `ticket_route_unreachable` 1 处、`alert_unreachable_config` 2 处 | Codex R6 #1 / QA@2 |
| IC-4 | `notify` / `log` 以闭包传入 effect seam,不传裸方法 | Codex R6 #2 |
| IC-5 | Codex code review(`codex:rescue`)时把 R3–R7 五份反馈文件(`/tmp/codex-rescue-design-feedback-flywheel-FLY-2075-plan-round{3..7}.md`,已拷贝至本文件夹 `codex-design-review/`)作为上下文交给评审者,逐条核实现状 | 本节 |
