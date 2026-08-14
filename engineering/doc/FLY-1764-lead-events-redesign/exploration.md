# FLY-1764 大喇叭(lead_events 推送通道)整体重设计 — 探索

Issue: FLY-1764 (https://linear.app/geoforge3d/issue/FLY-1764/机制-大喇叭lead-events-推送通道整体重设计-先聊清设计再动手告警该投给谁要不要专用通道与邮局的关系)
日期: 2026-08-14
基于: 无(本单起点;背景材料 = FLY-1748/1749/1751 三单 + /tmp/dr-final-1751.md DR 报告)

## 0. 本单性质

**Generic 讨论单:先聊设计,聊透之前不写代码。** 产出 = 互动图解 HTML,Annie 逐节批注收敛后再决定实现拆单。founder 红线(recite):

> 「代码虽然已经写好了,但如果它是在不正确的设计上写的代码,它并没有意义啊。……我更建议我们想清楚这个设计要怎么样去做,然后再去做好就行了。」

## 1. 「大喇叭」是什么(用一个真实事故串起来)

2026-08-13 晚,机器内存压力(swap 打满)触发一条系统告警。这条告警的旅程:

1. **产生**:FleetSensors(Bridge 里的机器传感器)检测到 swap 压力,写 1 条事件进 `lead_events` 账本(`leadId="swap"`, `projectName="machine"`,event_id=`swap-pressure:2026-08-13 21:12:04`)。**这一层去重是好的 —— 一个 episode 只有 1 条**(FLY-1748 已核实)。
2. **扇出(= 大喇叭)**:这 1 条事件被复制成 **16 份 mailbox 行**,投进 6 个项目的 comm.db,每个 Lead 一份(flywheel 5 + geoforge3d 3 + growth 3 + tidal-echo 3 + joycon 1 + personal-assistant 1)。数据实证:`mailbox` 表里 `swap-broadcast:2026-08-13 21:12:04:<每个-lead-id>` 各一行,`expires_at` = 创建 + 3 天。
3. **投递之后的灾难**(三个独立缺陷叠加):
   - claude 腿:legacy push 查询不排除终态行(FLY-1748)→ 30 秒一条重推进 pane,刷一夜;
   - codex 腿:ack 路径没打通 + 租约重投无 cap(FLY-1750)→ retry_count 飙到 60;
   - 还有「无主的一半」:`retry_count=0` 的 Lead pane 也满屏同一条(~500 份)→ 一行被渲染成 N 份 envelope,至今无单在修。
4. **代价**:一条「资源不够」的消息,自己大量消耗资源 —— 多个 Lead 的上下文窗口被灌满(实测一个 Lead ctx 被吃到 13%),founder pane 刷屏一夜。

## 2. Founder 的三条批注(本单要回答的核心问题)

> 「它一个大喇叭推送给每一个 lead 都说有意义吗?就要修的话,也不是每个人都去修啊。」

> 「它的告警频道如果有一个特别的通道是 OK 的,就是它不一定需要一定跟 Mailbox 放在一起。」

> 「现在给每个 lead 都说一次,好像并没有意义。」

拆开是三个设计问题:

- **Q1 路由**:告警该投给谁?现状 = 见者有份(所有项目所有 Lead 人手一份)。但内存告警只有「能动手的那一个」需要收到 —— 其他 14 个 Lead 收到了也只能围观。
- **Q2 通道**:要不要专用告警通道(独立频道/面板),而不是塞进每个 Lead 的对话收件箱?
- **Q3 语义**:告警和会话消息本就不该同一种投递语义 —— DR 报告(21 源)的结论:告警类 = **最新值语义**(last-value + collapse,过期即弃),会话类 = **必达语义**(at-least-once + ack)。现状把两者都塞进同一个 at-least-once mailbox。

## 3. 现状流量普查(要分流的东西到底有哪些)

lead_events 48 小时实测分布(teamlead.db,2026-08-14 查):

| event_type | 条数 | 收件 Lead 数 | 性质 |
|---|---|---|---|
| workflow_engine_escalation | 1558 | 2 | 定向(engine → 归属 Lead) |
| runner_question | 632 | 2 | 定向(runner → 自己的 Lead) |
| stage_changed | 414 | 1 | 定向 |
| founder_reply | 161 | 2 | 定向、**高价值** |
| inbox_loop_stalled | 109 | 2 | 系统告警 |
| mailbox_dead_letter | 78 | **16** | 死信通知(逐 Lead) |
| runner_idle_detected | 62 | 1 | 定向 |
| patrol_tick | 7 | 1 | 巡检闹钟(FLY-1687,定向) |
| swap_pressure_high | 3 | 1(假 lead "swap") | **机器级系统告警 → 大喇叭源头** |
| bridge_abnormal_exit / bridge_boot_stale_checkout | 7 | 1 | 系统事件 |

观察:**绝大多数流量本来就是定向的**(runner→Lead、engine→Lead)。真正走「大喇叭见者有份」的是机器级系统告警(swap-broadcast)这一小撮 —— 但它的爆炸半径最大(1 事件 × 16 收件人 × N 次重投/重渲染)。

## 4. 设计空间(每个问题的选项,倾向性待 Annie 批注)

### Q1 告警投给谁 — 三个候选

- **A. owner 路由**:每类系统告警配一个 owner(如内存告警 → infra-bot Lead),只投他一份。其他 Lead 需要「载荷调度」类信息时按需查询,不推送。
- **B. 专用频道**:系统告警不进任何 Lead 的 mailbox,进一个独立的告警面板/Discord 告警频道(#flywheel-alerts 已存在),要处理的 Lead 从频道认领。
- **C. 现状+过滤**:保留广播,但按「该 Lead 能不能对此做什么」过滤收件人。(基本被 founder 批注否掉 —— 「不是每个人都去修啊」)

### Q2 专用通道与邮局的关系 — 两个候选

- **A. 通道分离**:告警走独立通道(lead_events → 告警频道/owner),mailbox 只装会话/指令类消息。语义天然分开,mailbox 的 at-least-once 机器不用为告警改。
- **B. 单一收件箱 + 按类型分语义**:全走 mailbox,但消息带 class(alert/conversation),alert 类用 collapse_key + 短 expires_at(过期即弃、新盖旧),conversation 类保持必达。schema 已有对应列(FLY-1749 已确认 expires_at/collapse 思路可落)。

### Q3 现存流量分流(草案,待逐条确认)

| 流量 | 建议归宿 |
|---|---|
| 机器级系统告警(swap/OOM/负载) | owner Lead 或告警频道,last-value 语义 |
| Bridge 系统事件(abnormal_exit/stale_checkout) | 告警频道(founder/infra 可见),last-value |
| mailbox_dead_letter 死信通知 | 归属 Lead 定向,有界聚合(已有 30min 聚合) |
| 巡检闹钟 patrol_tick | 定向,现状即可(FLY-1687 刚落) |
| runner_question / founder_reply / engine escalation | mailbox 会话类,必达,不动 |

### Q4 1748/1749 已写代码的取舍(两单已 Canceled,PR 留着)

- PR #829(1748:legacy push 查询排除终态行):**防御性修复,与任何新设计都兼容** —— 终态行不该重投在哪个设计里都成立。候选:作为独立小修保留。
- PR #834(1749:广播 expires_at/collapse_key 过期即弃):落点取决于 Q2 —— 若通道分离(A),广播根本不再进 mailbox,此 PR 作废;若单一收件箱(B),此 PR 是 B 的一块砖。
- 「一行渲染 N 份 envelope」的无主缺陷:不管 Q1/Q2 选哪个,只要还有任何消息走 push 投递就必须修 —— 需要在设计定稿时决定归入哪单。

## 5. 相邻单边界

- **FLY-1751**(已按二次定稿派工:攒批 10 条/30s + /clear 换代腿):邮局**内部**投递语义,与本单(广播**该不该进**邮局)不同层。本单结论不改 1751 的 scope。
- **FLY-1750**(Codex 腿 ack 无 cap):投递腿缺陷,与通道设计正交。
- **FLYWHEEL_MAILBOX_QUEUE=1 翻开关**:独立进行,不依赖本单。

## 6. 下一步

→ research.md:精确摸清代码路径(FleetSensors → fan-out → mailbox → push 的每一跳),确认每个选项的改动半径。
→ plan.md:设计提案定稿(供 codex design review)。
→ 互动图解 HTML:供 Annie 逐节批注。
