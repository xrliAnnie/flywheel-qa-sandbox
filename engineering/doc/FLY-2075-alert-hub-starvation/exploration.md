# FLY-2075 告警主管道断流 — 探索
Issue: FLY-2075 (https://linear.app/geoforge3d/issue/FLY-2075/2073账管-告警主管道断流hub-饿死诊断-修复alert-threads-08-21-后零新行)
日期: 2026-08-26
基于: 无

> ⚠️ **2026-08-26 07:12Z 之后读者先看这条**:§5 的「推荐 A(打开频道副本开关)」已被 founder 的暂定裁定取代——「**不双发,只发 Discord**」⇒ 频道**单车道**、拆 mailbox ticket 车道、配套删除 Hub 的自动 @founder 升级(Tadashi 转述,待复述确认)。§1–§4 的诊断与证据不变;§5 保留为审计上下文,实施以 `plan.md` v3 为准。

> **世界标注**:本文全部数据为 **[生产现状]**(本机 `~/.flywheel/`,测于 2026-08-26 06:xx Z,生产 Bridge pid 71549 / buildSha `fe795ecbe`)。代码引用为本分支 `flywheel-FLY-2075`(= `main@c28cfd083`)。

## 0. 一句话结论(动机反转)

`alert_threads` 断流**不是故障,是设计改道**:2026-08-14 22:19Z 合入的 FLY-1764 (#836) 按 founder 终裁 **Flow 2** 把全部 ticket 类告警从「统一告警频道 → AlertChannelHub → thread → `alert_threads`」改投为「claw(`claude-infra-bot-lead`)的 mailbox 一行,Discord 副本默认关」。改道那一腿**是活的**(comm.db 里 1,441 行 `infra_alert`,claw 平均 0.5 分钟 ACK);被断掉的只是频道/Hub/账本这一腿。issue 标题里的「Hub 饿死」是症状词——Hub 没坏、门控没关、env 没丢,它只是**再也没人给它送事件**。

⇒ 「修复」的含义从「找 bug」变成「**是否把频道那一腿重新打开**」。这是 founder 的产品决定(它与 FLY-1764 终裁 ②「不要双发;宁愿不发 Discord」逐字冲突,却是 PRD FLY-2060 §3.1「alert 照常发」这一格成立的前提)。本文把证据与三条路摆出来,推荐一条,不替她决定。

## 1. 症状与口径

issue 给的症状:`~/.flywheel/teamlead.db` 的 `alert_threads`(AlertChannelHub 写账 + 开 thread 的那本)2026-08-21 06:42Z 后零新行;`dead_letter_alerts` 每天有新行直到 08-26。

**口径先立住**(不立住会把不同的东西当同一件事数,这正是 FLY-2060 Q2 曾经踩的坑):

| 账 | 库/位置 | 写入方 | 记录的是什么 |
|---|---|---|---|
| `alert_threads` | `teamlead.db` | `AlertChannelHub.openOrReplaceThread` → `StateStore.openAlertThread`(全仓**唯一**调用点 `AlertChannelHub.ts:419`) | 频道根消息 + thread 成功后的**工单行**(主键 = correlation key,一 episode 一行) |
| `alert_delivery_receipts` | `teamlead.db` | `LeadAlertNotifier.withDeliveryReceipt` | Bridge 进程内 `LeadAlertNotifier.alert()` 的每次结果(sent / queued / deadlettered) |
| `dead_letter_alerts` | `teamlead.db` | Lead inbox runtime | **mailbox 投递死信**(`lead_unacked` / `runner_unroutable`)——它是 `mailbox_dead_letter` 告警的**源**,不是告警死信 |
| `mailbox` (`source_kind='infra_alert'`) | `~/.flywheel/comm/flywheel/comm.db` | `LeadInboxRuntime.enqueueInfraAlert` | Flow 2 之后 ticket 类告警的**主落点**(一行 = 一条投给 claw 的告警) |
| `~/.flywheel/alert-deadletter/*.json` | 文件 | 两类写入方:`2026-…` 前缀 = Bridge `deadLetter()`(带 `reason`);`20260826T…` 前缀 = shell `lead-alert.sh`(带 `queueReason`) | 永久放弃的告警(两条发送路径各一本,互不相交) |

`dead_letter_alerts` 活着只证明「mailbox 死信事件在铸」——而 `mailbox_dead_letter` 告警走的是 `plugin.ts:9137` **直连 raw notifier** 的路(08-14 之前就这样),本来就不经 Hub、不开 thread。所以 issue 的前提「铸造侧活着 ⇒ 事到不了 Hub」成立,但选错了参照物;真正的参照物是下面这张对账表。

## 2. 对账:频道腿在 08-14 22:19Z 之后归零

`alert_delivery_receipts`(Bridge 通知器回执)与 `alert_threads` 按 `event_id` 对账:

| 日期 | 回执 `sent` 总数 | 其中**开了 thread** | 其中没开 thread 的前缀 |
|---|---|---|---|
| 08-11 | 1,630 | 23 | rework_stalled_alert 1,543(FLY-1612 风暴)、dead_letter_alert 21、… |
| 08-12 | 1,832 | 20 | rework_stalled_alert 1,688、dead_letter_alert 34、… |
| 08-13 | 227 | 26 | codex_model_transport_unavailable 75、dead_letter_alert 49、… |
| 08-14 | 104 | 25 | codex_model_transport_unavailable 45、zombie-backlog 21、… |
| **08-15** | 13 | **0** | dead_letter_alert 13 |
| 08-16 ~ 08-26 | 4 ~ 39/天 | **0** | **只剩 `dead_letter_alert:*`**(+ 08-17 一条 flag-scan) |

- 最后一条「sent 且开 thread」的回执:**2026-08-14T21:58:56Z**(`workflow_engine_escalation`)。
- 08-15 起 Bridge 通知器**只发** `mailbox_dead_letter`(它本来就不开 thread);其余所有产源(review_advisory / workflow_engine_escalation / external_merge / zombie_backlog / codex_model_transport / bridge_abnormal_exit …)在这本账上**同时归零**——它们没有停止发生,而是**换了账本**(§3)。

`alert_threads` 日行数(`opened_at`):08-11 35 → 08-12 21 → 08-13 27 → 08-14 27 → **08-15 1 → 08-16 1 → 08-19 3 → 08-20 1 → 08-21 1 → 之后 0**。

## 3. 因果链(带证据锚)

```mermaid
timeline
    title alert_threads 断流时间线(UTC)
    2026-08-14 09:07 : v1 watchdog 最后一条 stall 事件(FLY-1560 #838 当天有意拆除,与本案无关)
    2026-08-14 21:58 : 最后一条经 Hub 开 thread 的 ticket 告警(workflow_engine_escalation)
    2026-08-14 22:19 : #836 FLY-1764 合入 main(当时 merge 即自部署,FLY-1959 解耦是 08-21 的事)
    2026-08-14 22:28 : 新 Bridge 起来,comm.db 出现第一行 infra_alert(bridge_abnormal_exit → claw,8 分钟后 ACKED)
    2026-08-15 ~ 08-21 : 频道腿只剩 drain 回放的零星 thread(08-20 14:12、08-21 06:40 两次 drain sent)
    2026-08-21 06:42 : 最后一行 alert_threads;此后 alert-queue 目录清空(现 0 文件),再无回放
    2026-08-25 : PRD FLY-2060 以「alert 照常发」为前提立项;§1.3 记下账本停了(Q7)
```

### 3.1 刀口:FLY-1764 Flow 2(founder 终裁,2026-08-14)

`engineering/doc/FLY-1764-lead-events-redesign/plan.md` 顶部「Attempt 2 终裁增补」原文:

> founder 随后把告警最后一公里改为 **Flow 2** —— actionable 告警作为**一行 mailbox 信**只投 `claude-infra-bot-lead`(claw)…**默认不发 Discord 副本**。路由表保留 `FLYWHEEL_ALERT_COPY_TO_CHANNEL=1` 观察性抄送开关,默认 OFF。

裁定表 ②:「**不要双发;宁愿不发 Discord**」→「mailbox 是 primary/唯一默认落点」。

代码落点(全部在 main 现版):

- `infra-alert-mailbox.ts:9-19` — `INFRA_ALERT_LAST_MILE_ROUTE = { ownerLeadId: "claude-infra-bot-lead", copyToChannelEnv: "FLYWHEEL_ALERT_COPY_TO_CHANNEL", copyToChannelDefault: false }`;`shouldCopyInfraAlertToChannel()` **只在 env 严格等于 `"1"` 时为真**(`copyToChannelDefault` 字段实际未被读取)。
- `plugin.ts:10346-10360` — `buildInfraAlertRouting({ rawSink: alertSink /* = Hub.handle */, ticketSink: enqueueInfraAlert → {queued:true}, copyTicketToChannel: shouldCopyInfraAlertToChannel })`。
- `infra-event-router.ts:163-215` — `createInfraAlertSink`:非 informational、非 issue-progress 的 kind 一律 `classifyInfraEvent → "ticket"` → `deliverTicket()`:**先** `ticketSink.alert()`(mailbox),**仅当** `copyTicketToChannel()` 为真才 `rawSink.alert()`(Hub)。`TICKET_KINDS` 覆盖全部 process-health / fleet / quota / workflow 类,兜底也是 ticket。
- `~/.flywheel/.env` **没有** `FLYWHEEL_ALERT_COPY_TO_CHANNEL`;生产 Bridge 进程 env 里也没有(`ps -E` 实测)。

⇒ 生产上 `AlertChannelHub.handle()` 对 ticket 类 kind **一次都不会被调用**。Hub 每次 boot 都打 `[Bridge] FLY-368 AlertChannelHub ON (unified channel=1518793447165661254, auto-repair=ON)`(当前日志 20 次 boot 20 次 ON)——这行横幅**只说明 Hub 构造成功,不说明有事件路由给它**。issue 快诊把「Hub 零活动」读成「Hub 饿死」,机制其实是「上游改道」。

### 3.2 改道那一腿活着(反证「告警丢了」)

`comm.db` `mailbox WHERE source_kind='infra_alert'`(08-14 22:28Z 起):

| 日期 | ACKED | DEAD(`lease_expired_unacked`) |
|---|---|---|
| 08-15 | 170 | 2 |
| 08-16 ~ 08-18 | 70 / 77 / 99 | 0 |
| 08-19 | 74 | 22 |
| 08-20 | 39 | 49 |
| 08-21 ~ 08-23 | 76 / 97 / 94 | 7 / 1 / 0 |
| 08-24 | 157 | 48 |
| 08-25 | 300 | 7 |
| 08-26(至 06:37Z) | 53 | 0 |

- 收件人 `claude-infra-bot-lead` 1,441 行(另 1 行 `flywheel-eng-lead`);近日 ACK 延迟样本 0.2 ~ 0.7 分钟。
- kind 构成(08-15 起):`zombie_session_backlog` 403、`workflow_engine_escalation` 322、`cmux_watcher_stalled` 288、`review_advisory_pass` 274、`external_merge_suspect` 84、`bridge_abnormal_exit` 33、`inbox_loop_stalled` 11、`tui_window_lost` 10、`runner_login_expired` 10、`bridge_boot_stale_checkout` 5、…
- 每日 **distinct `collapse_key`**(≈ 若走频道会形成的 episode 数):08-19 ~ 08-23 为 83 ~ 98,08-24 205,08-25 307(`cmux_watcher_stalled` 08-24/25 各 101 / 171 行,自身在涨)。

DEAD 136 行是 mailbox 侧 lease 过期未 ACK(claw 不在线的窗口),**不属于本单**,但值得 Epic 知道:改道后 claw 没 ACK 的那部分,频道里也没有影子。

### 3.3 08-15 ~ 08-21 的残余涓流是什么

那 7 行(`lead_lease_would_block` ×3、`lead_backend_drift` ×2、`bridge_abnormal_exit` ×1、`mailbox_dead_letter` ×1)在回执账上**没有 `sent` 回执**(`mailbox_dead_letter` 那行是 `queued_durable`)。当前 bridge log(08-20 14:11 起)里仅有的两条 `[Bridge] LeadAlert drain sent=N` 落在 08-20 14:11(boot,`sent=1`)与 **08-21T06:40:51Z**(`sent=2`),分别对上 08-20 14:12 与 08-21 06:42 那两行 thread ——它们是 **alert-queue 回放**(`attachDeliveredAlertLifecycles` → `Hub.attachThreadForDelivered`)开的,不是一条新路。08-15 ~ 08-19 的 5 行早于现存日志,**未直接验证**,按同一形状(无 `sent` 回执 + lease 类)推定为同类回放。此后 `~/.flywheel/alert-queue/` 为空(现 0 文件)。
⇒ 08-21 06:42Z 之后的「绝对零」不是第二次断流,是回放源枯竭(【推定,未逐行验证 08-15~19】)。

### 3.4 已排除的假设(每条一个可证伪判据)

| 假设 | 判据 | 结果 |
|---|---|---|
| Hub 门控被 flag 退役翻掉 | `git log -S FLYWHEEL_ALERT_COPY_TO_CHANNEL --since 08-13` / `-S 'AlertChannelHub ON'` | 只命中 #836;#859 / #871 / #929 / #930 未触碰;`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` 与 sender/repair token 在进程 env 里都在 |
| thread 创建失败静默 | bridge log `thread create failed` / `thread handling failed` | 0 / 0 |
| Discord 发不出去 | 回执 `sent` 每天仍有(`mailbox_dead_letter`);`[LeadAlertNotifier] Discord POST 400` 仅 4 条且都是 2000 字上限的 `mailbox_dead_letter` | 频道能发 |
| watchdog 08-14 死亡是因 | FLY-1560 #838 当天有意拆除 v1 watchdog;它不在 ticket 路由链上 | 时间巧合,非因 |
| 08-20/21 部署波再断一层 | §3.3 | 那两天的行反而是回放**开出来**的 |
| shell 侧 no-token 死信 | `alert-deadletter/20260826T*`(`cmux_cleanup`,`queueReason: no-token`)全部来自 shell 路径 | = FLY-2062,不在 Bridge 进程内,与本案无关 |

## 4. 动机作废声明

issue 的任务是「Hub 饿死诊断 + 修复」。诊断结论把这个任务的动机换掉了:

- **没有可修的缺陷**:代码按 FLY-1764 终裁在正常工作;
- **有一个待做的产品决定**:PRD FLY-2060(08-25,founder 定)§3.1 第一格「alert 照常发(Dispatcher 只转发,不改)」、R6 的「thread archive / 挂着可见」、Epic FLY-2073 落在 `alert_threads` ——**全部以「告警在 `#flywheel-alerts` 频道里、每条有 thread」为前提**;而 FLY-1764 ② 在 11 天前把这个前提拿掉了。两条 founder 裁定互相矛盾,**不是我能裁的**。

「修到一条真实告警重新走完 Hub」这个验收本身是可达的(下面任一选项 A/B 都能达到),但达到它 = 推翻 ②。

## 5. 三条路(founder 决定;我推荐 A)

| 选项 | 做什么 | 代价 / 反面 | 与裁定的关系 |
|---|---|---|---|
| **A(推荐)** 打开 1764 预留的频道抄送腿 | ticket 类告警:mailbox 主腿**不动** + 频道副本经 Hub → thread → `alert_threads`。实现形态见 research.md(env 开关 vs 代码默认值) | ① claw 同一告警收两次(mailbox 行 + 频道 @);② Hub 开 thread 时**当场**跑 AutoRepairBot,绝大多数 kind 落 `needs_human` → **即时** thread 内 @founder + `ESCALATED`(改道前 08-05~14 的 151 行里 136 行如此;详见 research.md §3.2 v2 更正),有 ARC 的少数 kind 走 REPAIRING;③ 频道日量 ≈ 83~307 episode/天 ⇒ 每天几十到三百次即时 @Annie,直到值守席位就位(限速 20/min,溢出走队列回放) | 用的是 1764 自己写下的出口(「a later channel opt-in a config change rather than another transport rewrite」),但**逐字违反 ②「不要双发」** |
| B 频道改回主腿,mailbox 变副本 | 改 Router:ticket → Hub 为主,mailbox 抄送可选 | 传输层重写;claw 的即时唤醒(nudge)变成可选;推翻 ② 与 ① | 完全推翻 1764 |
| C 管道不动,Epic 换账本 | FLY-2073 落在 comm.db mailbox 而非 `alert_threads` | mailbox 的 ACK = 「已读」不是「认领/处置」;R2 三去向、R6 终态、thread archive 都没处写 ⇒ 要新造一层处置账本 | 不碰 1764,但踩「⛔ 不新增告警层」红线,且 PRD 主线整段失效 |

**推荐 A 的理由**:最小、可逆(关掉即回到 Flow 2)、用现成管道、让 PRD §3.1 第一格从假变真。**反面我不藏**:它让 claw 双收、让 @founder 升级回来;这两条正是 ② 当初要避免的。founder 如果仍要「宁愿不发 Discord」,那 FLY-2073 得换地基(选项 C)重新立项,本单不做实现。

## 6. 会过期的结论(as-of 2026-08-26 06:50Z)

| 结论 | 重核命令 | 什么情况下作废 |
|---|---|---|
| `alert_threads` 最后一行 08-21 06:42:09 | `sqlite3 ~/.flywheel/teamlead.db "select max(opened_at) from alert_threads"` | 任何一次 drain 回放或 lease 类事件都会加一行 |
| Bridge env 无 `FLYWHEEL_ALERT_COPY_TO_CHANNEL` | `ps -wwE -p $(lsof -tiTCP:9876 -sTCP:LISTEN) \| tr ' ' '\n' \| grep COPY_TO` | 有人改了 `.env` 并重启 |
| 频道腿 `sent+thread` 08-15 起为 0 | 见 §2 的 JOIN 查询 | 开关打开并重启后应立即非零 |
| mailbox 主腿 ACK 延迟 ~0.5 min | `select round((julianday(acked_at)-julianday(created_at))*1440,1) from mailbox where source_kind='infra_alert' order by created_at desc limit 20` | claw 离线时段会变成 DEAD |
| `alert-queue` 为空 | `ls ~/.flywheel/alert-queue \| wc -l` | 限速溢出或 Discord 抖动会重新入队 |
