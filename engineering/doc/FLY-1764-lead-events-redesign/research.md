# FLY-1764 大喇叭(lead_events 推送通道)整体重设计 — 调研

Issue: FLY-1764 (https://linear.app/geoforge3d/issue/FLY-1764/机制-大喇叭lead-events-推送通道整体重设计-先聊清设计再动手告警该投给谁要不要专用通道与邮局的关系)
日期: 2026-08-14
基于: exploration.md

> 方法:代码级全链路扫描(独立 Explore 子代理 very thorough 扫描 + 主 session 逐点复核)+ 生产库只读取证(teamlead.db / comm.db,2026-08-14 查)。每条论断带 file:line。

## 1. 颠覆性事实一:lead_events 今天不是投递通道

- 建表 `packages/teamlead/src/StateStore.ts:2977-3017`,27 列。唯一主写入口 `appendLeadEvent`(`StateStore.ts:10450`),UNIQUE `(lead_id, event_id)` 去重(`idx_lead_events_dedup`)。
- **ACK 状态机(16 个 ack_* 列)已全局关闭**:`bridge/lead-event-ack-policy.ts:8-12` `deliveryAckEnabled()` 硬返回 `false`;`ackPolicyForLeadEvent()` 无条件 return null。
- **启动 cutover / 投递失败 reconcile 均未接线**:`listUndeliveredLeadEvents` 的消费者 `runLegacyCutover` 在 `plugin.ts:4826-4883` 构造时未传;`getUndeliveredLeadEventsForReconcile`(`StateStore.ts:14011`)零非测试调用方。
- 真实角色 ≈ **审计账本 + `(lead_id,event_id)` 去重锁**。真正的投递队列是各项目 comm.db 的 `mailbox` 表。

⇒ issue 标题里的「lead_events 推送通道」这个名字已名不副实 —— 重设计对象其实是**三条并行的通知路**(§3),lead_events 只是其中一条的账本、另一条的去重锁。

## 2. 颠覆性事实二:「大喇叭」物理位置只有一处,且它绕开 lead_events

`packages/teamlead/src/bridge/fleet-sensors.ts:366-386` `broadcastLoadShed()`:

```ts
const leadIds = this.deps.listLeadIds?.() ?? [];
for (const leadId of leadIds) {
  await this.deps.notifyLead?.(leadId, this.loadShedText(hold),
                               `swap-broadcast:${episodeId}:${leadId}`);
}
```

- 受众 = `plugin.ts:9428` `listLeadIds: () => [...leadProjectByAgentId.keys()]`,由 `plugin.ts:9341-9344` 遍历**所有 project × 所有 lead** 构建 ⇒ 字面「见者有份」。
- 落地 = `plugin.ts:9345-9366` `notifyLeadInstruction` → 各项目 comm.db `insertInstruction`(`type='instruction'`,**72h TTL 硬编码**,`flywheel-comm/src/db.ts:2178`)。
- **完全不经过 lead_events**。lead_events 里的 `swap_pressure_high` 行(leadId="swap"、project="machine")是**告警腿的去重副产物**,不是广播源。

数据实证(生产库,2026-08-14 查):一个 swap-pressure episode → lead_events 1 条 → mailbox **16 行**(flywheel 5 + geoforge3d 3 + growth 3 + tidal-echo 3 + joycon 1 + personal-assistant 1)。

## 3. 系统全景:通知其实走三条并行路

| 路 | 链路 | 语义 | 去重 |
|---|---|---|---|
| **(a) 告警腿** | `ALERT_EVENT_TYPES` 全集 → `LeadAlertNotifier.alert()`(`LeadAlertNotifier.ts:837`)→ Discord POST | 频道消息,人/owner 认领 | claims.db 跨进程 + lead_events UNIQUE 两层(`LeadWatchdog.ts:8-18`) |
| **(b) 广播腿(大喇叭)** | `broadcastLoadShed` → 全 Lead mailbox `instruction` 行 | 名义必达 at-least-once,实为无限重投(§5) | dedupeId=`swap-broadcast:<episode>:<lead>` |
| **(c) shell 腿** | `scripts/lead-alert.sh` → claims.db → Discord(重启/部署/巡检脚本用) | 频道消息 | claims.db(同 (a) 一张表) |

**(a) 腿的频道已统一**:`LeadAlertNotifier.ts:1484-1493` `resolveChannel` 里 `unifiedAlert.channelId` 优先(FLY-368);machine 级 fleet 告警在 unified 模式下必然落 unified 告警频道(FLY-1082,`:1490-1492` 注释)。**即:专用告警频道今天已经存在**(#flywheel-alerts),且已有告警 owner 制度(claude-infra-bot / claw 是该频道工单默认主力 owner)。

**同一个内存 episode 是双发的**:告警腿发 1 条进告警频道(给能修的人)+ 广播腿发 N 条进全 Lead 邮箱(FYI)。

## 4. 决定性事实三:load-shed 动作已经机制化,广播只是 FYI

`fleet-sensors.ts:10`:「ARC = reversible dispatch **pressure-hold** + per-Lead load-shed notify」。压力确认时 Bridge **自动置 pressure-hold(新 runner 派发已暂停)**,free 回阈值 + swapout 回噪声线后**自动解除**(`holdClause`,`fleet-sensors.ts:515-522`)。

广播文案本身(`loadShedText`,`fleet-sensors.ts:533-544`)印证:「请降载:暂缓新任务、考虑收掉可暂停的 runner。pressure-hold 已于压力确认时刻置位(新 runner 派发已暂停)…自动解除」。

⇒ 15 个 Lead 收到广播后**唯一系统没代劳的动作**是「主动收掉可暂停的 runner」—— 而这是 infra owner 的活,不是每个 Lead 的活。「暂缓新任务」系统已经硬性执行(hold 挡住派发)。

## 5. mailbox(邮局)的结构性问题:两个互不知情的消费者

mailbox schema:`packages/flywheel-comm/src/mailbox-schema.ts:42-113`,状态机 `QUEUED→LEASED→ACKED/DEAD`;`expires_at`/`collapse_key`/`kind` 列已存在但休眠。

| 腿 | 读什么 | 位置 | 语义 |
|---|---|---|---|
| **A. Bridge 腿** `LeadInboxLoop` | `state='QUEUED' AND msg_class='model'` | `mailbox-queue.ts:908-1010` | 冻结 batch + 30min 租约 + 批 ACK + 有界重试(3)→ 死信 |
| **B. Lead 进程内 `inbox-mcp` 腿(legacy push)** | `type='instruction' AND read_at IS NULL AND (delivered_at IS NULL OR < now-30s) AND 未过期` | `db.ts:3335-3349` | **1s poll**(`inbox-mcp/src/index.ts:193`),无 cap 无计数器,直到单条 ack 或 72h 过期 |

一条 `insertInstruction` 行**同时是两条腿的候选**(msg_class 默认 'model',recipient_kind 按 `-lead` 后缀判 'lead')。刷屏穿透「死信闸」的结构性原因:

1. **腿 B 的 delivered_at 冻结**:`markInstructionDelivered` 只从 QUEUED 迁移(`db.ts:3355-3358`)→ 首投后 `delivered_at < now-30s` 恒真 → 退化为逐 poll 重投。**重投不增 retry_count(那是腿 A 的计数器)** —— 这就是 FLY-1749 记录的「retry_count=0 但 pane ~500 份」的机制解释(渲染 N 份的主嫌疑,但「ack 后仍重放」一环仍未完全闭环,无单认领)。
2. **DEAD 行不被排除**(FLY-1748 根因):腿 A 判死(`lease_expired_unacked`)的行,被腿 B 无限复活重推 —— 两条腿死信策略互相不可见。
3. **TTL=72h 硬编码**:瞬时告警 ≈ 永久有效。

注:腿 B(legacy push)的整体退役已另有议程(2026-08-14 10:00 PDT 讨论),不属于本单,但本单设计须与之兼容。

## 6. lead_events 48h 流量普查(哪些流量真的是广播)

teamlead.db 实测(2026-08-14,总行数 81306):

| event_type | 条数 | 收件 Lead 数 | 定性 |
|---|---|---|---|
| workflow_engine_escalation | 1558 | 2 | 定向 |
| runner_question | 632 | 2 | 定向 |
| stage_changed | 414 | 1 | 定向 |
| founder_reply | 161 | 2 | 定向、高价值 |
| inbox_loop_stalled | 109 | 2 | 系统告警(定向给出事的 Lead —— 且有循环依赖问题:告警走的就是它报告堵塞的路) |
| mailbox_dead_letter | 78 | 16 | 死信通知,**各收各的**(定向,量不均因队深不同) |
| runner_idle_detected | 62 | 1 | 定向 |
| patrol_tick | 7 | 1 | 巡检闹钟,已是「单飞/最新值」雏形(上一条未结算就不发新条,`patrol-tick.ts:196-223`) |
| swap_pressure_high | 3 | 1(假 lead "swap") | **机器级告警 —— 大喇叭唯一源头** |

⇒ **「见者有份」广播只有 fleet broadcast 一族**;其余流量本来就是定向的。重设计不需要动定向流量。

## 7. FLY-1748 / FLY-1749 已写代码盘点

- **FLY-1748(PR #829,OPEN)**:只改 `flywheel-comm/src/db.ts`(42 行)+ 测试。把腿 B 两条读查询从投影视图改为 JOIN 物理表并显式 `state IN ('QUEUED','LEASED')` —— 终态行(DEAD/ACKED)不再重推。**防御性修复,与任何新设计兼容。**
- **FLY-1749(PR #834,OPEN)**:40 文件 / +2837。在 mailbox **内部**造 last-value 语义:产生端带 `ttlMs=10min + collapseKey + kind='fleet_broadcast'`;enqueue 时同 collapse_key 旧行 `DEAD('collapsed')`;每 tick 退休过期行 `DEAD('expired')`;压力解除主动 `DEAD('cleared')`;广播批 at-most-once(claim 事务内直接 ACKED);`DISPOSED_DEAD_REASONS` 不当失败页。**落点取决于设计:广播若不再进 mailbox,此 PR 大部分作废。**

## 8. 给设计的约束与输入(浓缩)

1. 专用告警通道**已存在**(unified 告警频道 + claims.db 去重 + owner 制度),不需要发明,只需要收编。
2. load-shed 的「暂缓新任务」**已机制化**(pressure-hold 挡派发),广播的 actionable 内容只剩「owner 去收 runner」——owner 路由即可覆盖。
3. mailbox 双消费者(腿 A/腿 B)策略互不可见是刷屏穿透的结构性原因;腿 B 退役另有议程,本单不动它,但设计不能新增依赖腿 B 的东西。
4. 定向流量(runner→Lead、engine→Lead、死信通知)不在「大喇叭」问题域内,不动。
5. FLY-1751 二次定稿(攒批 10/30s + /clear 腿)在邮局内部层,与本单正交,已派工,不受影响。
