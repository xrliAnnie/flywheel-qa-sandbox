# FLY-1645 收据账本机器拆除 — 探索

Issue: FLY-1645 (https://linear.app/geoforge3d/issue/FLY-1645/消息层重裁-b-拆除收据账本机器relay-statesettle-通路-义务账归-1575-task-表排-1575-之后)
日期: 2026-08-11
基于: 无

---

## 1. Founder 裁决与 scope 重裁

Founder 原话(2026-08-06,thread 1534779942242484256):

> 「我印象中我们根本没有设计在 message 这一层有账本啊。我们是不是就不应该有这个东西啊?」→ 裁决 **B:直接砍**。

裁决依据 = FLY-1569 总纲两条铁律:

1. **队列只答「送到没送到」,永不 track「办没办」**;
2. **永远不替 agent 建一张它看不见、也没法关闭的账**。

收据账本(relay_state / mailbox_log settlement / 重投直到 settle)恰好两条全违反:它替 Lead 记「这封信办了没」,而 Lead 既看不见这本账,也(实测)没有任何一条能走通的关闭通路。

**本单 scope:不修复,整体拆除。** 义务账由 FLY-1575 task 表接班(ack 同事务自动建,agent 用 `done`/`no_action` 关)。排期:排在 1575 之后或同批。

## 2. 病理档案 — 为什么是「砍」而不是「修」

### 2.1 原三缺陷(2026-08-06,Cass + Honey Lemon 实测)

三个缺陷同一器官(「双账本只写一半」):

- **缺陷①**:`reply_to` 回复只写 settlement 账(`mailbox_log` event=processed),不关行本体(`relay_state` 仍 open)——每一轮正常回复都铸一条永久 open 的收据;
- **缺陷②**:`handle-receipt --action ack` 被 ① 写下的 settlement 挡死(`already_processed`)——Lead 没有任何 CLI 出口;
- **缺陷③**:`handle-receipt --action no-route` 假成功 + 毒化正解(basis-less evidence 永久锁死 `route-founder-reply`)。

### 2.2 缺陷④与 2026-08-10 实弹(修复路线被推翻的决定性证据)

FLY-1677 并入本单的实弹证据:

- **无限重投风暴**:13 条 FLY-1354 `founder_msg:` 收据无限重投(打 HL 两轮+);eng-lead 重生时被 boot 重播灌 **837 条**,context 烧到 96% 停机;Bridge 被 18,250 条欠账行灌到启动 11.5 分钟。
- **缺陷④(HL 对照组)**:`route-founder-reply --no-route` ×13 全部正确写入 mailbox_log(basis 齐全)→ **重投照旧**;对照 = 被 settler 直接改过 mailbox 行的 301 条 → 停。⇒ 重投驱动只认 mailbox 行的 `relay_state`,settlement 账写得再对也无效——**用对命令、写对账、照样不生效**。
- **缺陷⑤(Cass 机制)**:`handle-receipt --action ack` 要求 lease provenance(`FLYWHEEL_LEAD_CARRIER_INSTANCE_ID`),该 env 只有 Codex 载体设置 ⇒ **所有 Claude 载体 Lead 的 ack 结构性不可用**。

### 2.3 全库零条系统自动结清(定性收口,2026-08-11)

两条 lane 溯源(`resolved_via` 来源核查——「核健康行怎么变健康的」方法论):

```
chat lane   全部 terminal_disposed:2,477 条,resolved_via 全是 operator sweep 标签
founder_msg lane 全部 terminal_disposed:137 条,同上
系统自动结清样本:全库 0 条
全舰静止 15 分钟(10 runner 全 parked):open 积压 77 → 77,一条未降
```

⇒ **结清通路从来没有生效过一次**。目前唯一压住积压的是人工 sweep(无排期、无人知其为承重墙)。这不是「修 bug」量级的问题——是整个器官从未工作过、也不该存在。

### 2.4 产线现状(2026-08-11 本节点实测,`~/.flywheel/comm/flywheel/comm.db` 只读)

```
external 收据行:2,760(2,748 ACKED + 12 QUEUED 未投递)
relay_state='open':201 行(8-08 以来新增 29 条,持续累积中)
settlement 账:processed 43,921 + disposed 10,351
死信残留:founder_reply_dead_letter ×2 + delivery_dead_letter ×1(跨两 lane,type 各异)
1574 新 lane 已活跃:inbox-carrier chat 行 10 条(8 ACKED + 2 LEASED)
flag 姿态:FLYWHEEL_MAILBOX_DISCORD=1(1574 ON);FLYWHEEL_MAILBOX_QUEUE 未设(1573 default-ON,deploy barrier 已 released)
```

## 3. 机器解剖(初勘——精确 inventory 见 research.md)

收据账本机器 = 五个器官 × 三条 lane:

**三条 lane**(id 前缀):
- `chat:` — Discord 入站消息收据(铸造:Discord plugin → `chat-receipt begin`,legacy external carrier;1574 ON 后 inbox carrier 但仍带 receipt_id 义务契约)
- `founder_msg:` — founder 消息路由义务收据(铸造:`founder-reply-routing.ts:20`)
- `lead_event:` — Bridge→Lead 事件收据(铸造:`bridge/lead-event-queue.ts:12`;实测同样在 open 里积压)

**五个器官**:
1. **铸造**:收据行的创建(plugin begin / founder root / lead event mirror)+ `<channel receipt_id=...>` 回复契约
2. **义务列**:mailbox 行的 `relay_state`(NOT NULL DEFAULT 'open')+ `resolved_at` + `resolved_via`
3. **settlement 账**:`mailbox_log` event ∈ {processed, disposed} + `settlement_slot` 唯一索引 + `settle()`/`getSettlement()`
4. **重投发射器**:plugin `ChatReceiptRuntime.reconcilePendingPass()`(`[redelivery]` 前缀整批重播)+ Bridge 侧 boot 重播 / 周期扫描(精确定位见 research.md)
5. **关闭动词**:`handle-receipt`(ack/no-route/relay/respond)、`route-founder-reply`、`chat-receipt settle` 及其 db.ts 后端(`handleReceipt`/`routeFounderReply`/`settleChatReceipt`/`quarantineChatReceipt`)

## 4. 边界 — 什么必须幸存(本单最大的风险面)

同名不同物。以下系统与「收据账本」共享词汇甚至共享列,但**不是**本单的拆除对象:

| 幸存系统 | 为什么不拆 | 与拆除对象的纠缠点 |
|---|---|---|
| **question/gate 生命周期** | `relay_state` 三列同时是 question 行(type='question')的引擎状态机(`retireQuestionGuarded` db.ts:1350、`markQuestionTerminalDisposed`、'protected' 态)。这是 request/response 生命周期,引擎自己写自己读,不是「agent 看不见的义务账」 | **同一物理列**。拆除 = 移除收据侧消费者,列本身留给 question |
| **FLY-1448 founder-approval 电路** | durable founder receipt / ship-gate writer / engine-park,#696 起无条件生效——这是**授权证据链**(founder 批没批),不是义务账(agent 办没办) | `supersedeShipGateAndReceiptFamily`(db.ts:1131)等引擎路径调 `settle()` 处置 receipt family;gate-poller founder-reply 路由链与 founder_msg 收据同源 |
| **投递层(1573/1574)** | mailbox QUEUED/LEASED/ACKED/DEAD + 租约重投 + 合批 + 死信闸 + chat-ingest——这正是铁律①允许的「送到没送到」 | 同一张 mailbox 表;1573 的租约重投(delivery retry)与收据重投(obligation replay)是两台不同的机器 |
| **alert_delivery_receipts / started receipts / codex_review_record** | 各自域的凭据(alert 投递证据 / runner ship run 追踪),与消息义务无关 | 仅词汇撞名 |
| **mailbox_log 的 archived/migrated_history/migration_snapshot 事件** | 归档与迁移审计(append-only,有 no_update/no_delete 触发器保护) | 同一张 mailbox_log 表;只拆 processed/disposed 两类事件的**写入方**,历史行按 append-only 保留 |

## 5. 接班:FLY-1575 task 表

接缝形态(1575 已设计定稿,Backlog):founder/其他 agent 的消息经 1574 ingest → mailbox inbox 行 → 1573 lease batch 投递 → Lead `ack_batch` → **同一事务**自动建 task(status=OPEN, owner=agent)→ Lead 用 `done`(附证据)/`no_action`(必填原因)关闭。义务在 task 层**可见**(门铃欠账数)且**可关**(合法出口)。

排期依赖的诚实评估:

- **「拆早了义务无人跟踪」**的前提是收据账本目前在跟踪义务——实测它**从未生效过一次**(§2.3),义务实际上一直只靠人工 sweep 与 Lead 自觉。拆除后到 1575 上线前的间隙,真实损失 = 「acked 但没办」继续无跟踪(与今天等价),而「没送到」由 1573 租约重投 + 死信闸覆盖(比今天更好)。
- 因此「之后或同批」两个形态都成立;同批更优(义务账无缝交接),紧后亦可接受(间隙姿态与今天等价)。本 design 按「1575 先行或同批」为基线,把接缝写成显式前置。

## 6. 关键决策点(design 阶段要定的)

- **D1 — external legacy lane 的归宿**:收据机器的 external carrier lane(legacy 直推影子行 + 重投)整条拆,还是只拆义务半边留投递半边?牵连:1574 的 `FLYWHEEL_MAILBOX_DISCORD=0` 回切通路、founder 的 flag 家族清理单(「先真跑几天,确认 OK 后全家族 flag 统一删」)。
- **D2 — schema 姿态**:`relay_state` 三列物理保留(question 生命周期继续用),收据侧只拆消费者;是否补一条「`relay_state='open'` ⇔ 活 question」的出生不变式,让欠账类审计陷阱(把标签当实体)结构性绝迹。
- **D3 — 存量清账**:cutover 时 201 条 open 行 + 12 条未投递 external 行 + 3 条死信残留的一次性 sweep 谓词与 tombstone provenance;要不要把未处理的 founder 消息转成 1575 task(量级 individual review vs 自动转换)。
- **D4 — flag**:拆除本身加不加 flag。founder 对 1573/1574/1575 有 flag 硬要求,但拆除是「删除不该存在的东西」——留 flag = 把旧机器藏在开关后面,与「拆除」自相矛盾;且 FLY-1466 有「不加新 flag」铁律先例。倾向:不加 flag,回滚 = git revert。
- **D5 — 验收口径**:必须是**观测不是推断**(issue 评论定稿):真实对话一轮零收据行铸出;Lead 冷启动零历史重播洪水;全舰静止窗口零欠账概念(表中无 open 非 question 行);grep 无收据侧 relay_state 消费者、无 settle CLI、无重投扫描。

## 7. 倾向(供 research/plan 收敛)

1. **整机拆除,含 external legacy lane**(D1 取整拆):重投发射器是收据机器的心脏,「无重投扫描」是 issue 验收原文;只拆半边会留下一台没有心脏但还在铸行的机器。与 flag 家族清理的关系在 plan 里写成显式时序约束。
2. **列留人走**(D2):`relay_state` 三列物理保留给 question 生命周期,收据侧消费者清零;出生不变式作为低成本的结构性防审计陷阱手段纳入。
3. **不加 flag**(D4):拆除即拆除。
4. **存量走一次性 operator sweep 程式**(D3):谓词覆盖三条 lane + 死信,tombstone provenance `fly1645_teardown_final_sweep`;未处理 founder 消息量级小(individual review),不做自动 task 转换。
5. **验收全部落在可观测行为上**(D5),并继承 issue 评论的方法论:核「健康行怎么变健康的」,不把标签当实体。
