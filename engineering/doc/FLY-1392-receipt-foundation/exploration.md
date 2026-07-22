# FLY-1392 收据地基 — 探索

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: FLY-1391 全套(architecture-target.md · architecture-current.md · watchdog-minimum-set.md)+ FLY-1373 plan.md + 本次代码核验

> 本单是**实施单**,不是从零设计单 —— 设计蓝图 = `engineering/doc/FLY-1391-message-architecture-audit/architecture-target.md`(已 Codex 审过)。
> 本探索的工作是:①把蓝图落到**这个代码库的真实落点**;②核验蓝图标注 unverified 的点;③把必须由 Lead/founder 拍的**实施级决策**摆出来。

> **最终裁定:** 本文是改型前的探索记录。当前唯一产品概念是
> “每条消息一个 Lead 办了没有标记”;founder 原文只到 Lead。以
> `design-correction.md` 为准,本文的协议层归因与收据分层方案已废除。

## 0. Scope 递归对照(issue 原文四条 → 本文哪节)

| Issue scope | 本文 |
|---|---|
| §A 主管唯一枢纽(founder 回复不再绕过 Lead) | §2 D-1 / D-7 |
| §B/§C 每条消息一个“Lead 办了没有”标记 | §1.2 / `design-correction.md` |
| §D 无收据→标记→重发→升级闭环,重发必含唤醒(吸收 FLY-1339) | §2 D-4 / D-5 |
| 不在本单:watchdog 收编(FLY-1393)、supervisor/break-glass、1386/1387/1388 re-scope | §4 |

## 1. 现状核验 —— 蓝图之外本次新查实的事实

蓝图(FLY-1391)的锚点本次抽查全部一致(`lead_inbox` schema、LeadInboxLoop 提交顺序、model 通道无重试上限、founder 入站三分支直达形态)。以下是**蓝图没有或标注 unverified、本次查实**的增量:

### 1.1 第②档「已读」原语:工具还在,弹药没了(蓝图 unverified 点,已核)

- `flywheel_inbox_ack_event` **仍注册**(`packages/inbox-mcp/src/index.ts:132`),且 Lead launcher 会把 inbox-mcp 写进 `.mcp.json`(`packages/teamlead/scripts/claude-lead.sh:1774,1860-1863`,条件 = dist 已 build)。
- **但**:FLY-1373 cutover 关掉了新事件的 token enrichment(plan §4.1 步 1 —— 新路径零 `ack_required`、零 token)。ACK 工具要求 per-event bearer token,而 token 来自消息体 ⇒ **新事件没有 token,Lead 模型无从 ACK**。
- ⇒ 蓝图里「第②档装回去就能用」**证伪**:工具在,但给新事件重建「已读」= 重新设计 batch adapter 的 token/attempt/finalize 接线,FLY-1373 R4#2 已明确 defer(「不在本单」)。**本单 v1 建议同样不做**(见 D-6)。

### 1.2 内部到达时间戳的真实现状(接线面)

FLY-1373 已建的投递账本按目标分两半,**本单「接线」的含义不同**:

| 方向 | 现状 | 内部投递事实 |
|---|---|---|
| →Lead | `lead_inbox`(comm.db)+ LeadInboxLoop,`consumed_at` = durable adapter receipt 后置位 | ✅ 已有持久投递事实;本单在同一 root 上记录 Lead 是否已办 |
| →Runner | `wakeRunnerMailbox` 裸写(`send.ts:102-125` `delivered_at` = write ok;`respond.ts` 四形态全 best-effort) | ❌ **没有账本** —— fire-and-forget,失败只有 stderr/事件;这半边要靠 wake 台账补(D-4) |

### 1.3 FLY-1339 遗产:设计已批、代码未合(吸收对象的精确形态)

- PR #648 **CLOSED 未合并**;其 design docs(exploration/research/plan,Codex 15 轮 APPROVED)在死分支 commit `06c6dfa07`,**不在 main**。
- 可直接吸收的机制(经其 15 轮评审锤过,不要重新发明):
  - **wake intent 台账**:现成表 `runner_phase_wakes`(`flywheel-comm/db.ts:91-103`)—— `pending/started/finished` 三态 + `UNIQUE(execution_id, message_id)` + `source_instruction_id` 偏索引,推广为全 vendor wake ledger;
  - **回执 = runner 的客观行为**:醒来后第一个 CLI 动作(turn/inbox)标 `started` —— 这正是本单「①档副作用推导」哲学应用在 wake 上;
  - **causal-event intent key**(按因果事件统一去重,如 `gate-answer:<questionId>`,防唤醒风暴);
  - **升级梯**:T1(~90s 无 started → verified 重推,接活零调用方的 `MailboxTransport.writeVerified`)→ T2(~5min → terminal 拍醒,pane 健康探测 fail-closed,绝不对 executing pane 注键)→ T3(→ 告警层);
  - 实录事故形态:2026-07-17 夜 75 分钟三级人肉唤醒(respond→send→terminal 每级都静默失败)。
- 1339 的 B3(handoff 周期 re-drive)**不属于**「有消息就要叫醒」核心,不吸收(留给 1339 落地后 re-scope 裁决)。

### 1.4 wake 环的边界

`vendor="none"`(antigravity/kimi)runner 无 mailbox(`send.ts:92-101` loud skip)——它们走 `pr_handoff` 终态,**不进 wake 环**;重发/升级链对它们的语义 = CommDB 记录 + Lead 通知,不伪造唤醒。

### 1.5 升级状态机(复用件,已核)

`detection-escalation.ts`:durable `detection_escalations` 行 = once-per-episode dedup + grace 锚;顺序合同 = upsert → resolveOwner → 队列 lead_event → 原子 CLAIM `NEW→LEAD_NOTIFIED`(30min grace 起点)→ C3 reconcile 到期 page founder;CLEARING 静音。蓝图 §4.2 指定复用,**本次确认其接口形态可行**:触发源从「巡检检测」换成「收据超时」,`kind` 换新枚举即可,状态机不动。

## 2. 实施级设计决策(D-1 ~ D-7,gate 确认项)

### D-1 「枢纽」的机械含义 —— 协议层枢纽,不是模型层枢纽(推荐)

蓝图 §1「归因是 Lead 的一次显式路由决策」与 §2.5「大部分枢纽工作走协议层」合起来读,有两种实现:

| 选项 | 含义 | 代价 |
|---|---|---|
| 1. 全部过 Lead 模型 | 每条 founder 回复都唤醒 Lead 模型路由 | 每条 ship 批准多一轮模型调用;token + 延迟;Lead 忙时排队 |
| **2. Lead-scoped 协议层枢纽(推荐)** | founder 回复一律先落 **Lead 的 hub 台账**(lead_inbox);归因判定分层:**确定性绑定**(reply-to-card / 恰一条匹配 / ship classifier)由协议层状态机完成并落 evidence,**不进模型**;**歧义**才升模型巷,Lead 模型做显式路由决策 | 忠实蓝图 §2.5;ship 延迟增量 = 一次协议层入账(毫秒级),不是模型调用 |

选项 2 与现状的本质区别(= §A 真正改的东西):
1. **台账全覆盖** —— 每条 founder 回复都有 Lead 域的 delivered/processed 两行收据(现状:直达分支零痕迹进 Lead);
2. **歧义分支不再「人工 relay 后不管」** —— 它变成 Lead 模型巷的一条 P0 待办,有 processed 判据(路由决策落库),超时进重发/升级链(现状:Annie 得不到任何信号);
3. **升级链的 N 有了锚点** —— Lead 在链路上,「N 次未处理→升级」才成立。

**授权语义不变**(蓝图 §1.1):ship 批准仍走既有同步 trusted-writer 路径(`insertFounderApprovalResponseWithSource`,FLY-1373 R2#5 定案不迁 queue),仍必须 `verify-approval`,Lead 仍不能代批(approval-intent 403 保留)。协议层枢纽**包住**这条路径(入账+收据),不改写它。

### D-2 「已处理」落地形状 —— lead_inbox 加列(蓝图 §2.3 建议形状,照采)

```
lead_inbox 加列(additive migration):
  processed_at        TEXT   -- ①档判据满足时刻
  processed_evidence  TEXT   -- JSON:{kind, ref(哪条 response/event/行), actor, owner_epoch}
  read_at             TEXT   -- 预留列,v1 不接线(D-6)
  escalated_at        TEXT   -- 升级到 founder 的时刻(只升级一次)
```

不变式(写进实现):**没有 evidence 的 processed 无效**;evidence 必须绑 actor + owner epoch(§2.4 条 1)。

### D-3 原子性三条(承重墙)在本库怎么满足 —— 按消息类型二选一

内部一致性要求业务动作与办结标记走“同事务或幂等 outbox”。本库现实:
comm.db(better-sqlite3)内可同事务;跨库(StateStore/sql.js、Discord、mailbox)
只能走幂等 intent/outbox。这里记录实现原则,不形成对外的逐类型凭据合同:

| 消息类型 | 「已处理」判据 | 原子化路径 |
|---|---|---|
| gate/question 答复 | comm.db 该 questionId 出现 response 行 | **同库同事务**:response 插入本身就是 evidence(UNIQUE 幂等);processed 标记可由 response 行**推导**,不需第二写 |
| founder 回复(路由) | 绑定到某 questionId,或显式标 `no_route_needed` | 绑定=comm.db 同事务;路由到 runner 的 wake 副作用=幂等键(wake 台账 UNIQUE)先做后记 |
| runner 报告 / `ask --report` | Lead 产生引用该 message id 的出站动作 | 出站动作带引用落 comm.db,幂等键=(报告id, 动作类型) |
| 卡住/失败通知 | session 状态转移 **且 actor 绑该 Lead + epoch** | 跨库:幂等 + evidence 显式记 actor(蓝图归属歧义条) |
| 纯遥测 P3 | **不要求 processed** | — |

### D-4 重发双轴 + 唤醒(吸收 FLY-1339 核心)

- **未送达轴**(传输,快):秒级退避,上限低,超限 → 死信 + 告警。修 1391 §3.1 三缺口:model 通道加上限;退避时间戳**持久化**(加列 `next_retry_at`);超限**进死信不静默**。
- **未处理轴**(人/模型,慢):分钟级,重发**必带「第 N 次」标记**(Lead 可见);幂等键 =(类型, 目标, 业务id),不用内容哈希(FLY-218/220 根因)。
- **重发到 runner = 必含唤醒**:每次对 parked/idle runner 的投递落 wake intent 行(推广 `runner_phase_wakes`)→ runner 第一个 CLI 动作标 `started`(= wake 的①档收据)→ 无 started 走 T1 verified 重推 → T2 terminal 拍醒(健康门控)→ T3 计入无收据升级链。**唤醒失败本身可观察**(intent 行 + 失败原因),杀 pane 场景 = T2 健康探测失败被记录 → 升级(验收 #3)。
- **R-1**:founder 回复路由到 runner 的那次投递**同样走 wake 台账**(respond 四形态收口到同一 intent 通道)——这正是 75 分钟事故的那条路。

### D-5 升级顺序 + 复用 detection-escalation

- 需 founder 决策(ship 批准、产品方向):**零缓冲**,Lead 只做投递与归因,不拦截;
- Lead 能动手:**30min 止损窗**,窗内无 `processed_at` → 升级(复用 `detection-escalation.ts` 状态机,触发源=收据超时,once-per-episode/grace/CLEARING 全保留);
- 纯遥测:永不升级。
- **「催已过的门」结构性消灭**:催办触发条件 = 无 processed 收据;gate 已答 ⇒ response 行存在 ⇒ processed 推导满足 ⇒ 不可能催。前提 = D-3 成立(design review blocking 项)。

### D-6 「已读」(②档)v1 不重建(gate 确认)

理由:§1.1 —— 重建 = 新设计 token 接线,FLY-1373 已 defer;且蓝图定稿②档**只能当已读不能当已处理**,对本单四条验收无一必需。`read_at` 列预留,后续单接线。**代价**:v1 无法区分「Lead 读了没动」和「Lead 没读」——升级链对两者同样处理(超时即升级),语义上可接受。

### D-7 founder 消息全量入账(验收 #6 的直接来源)

本段原“协议层按六分支自动处置”的方案已废除。最终方案是 issue thread 内
founder 消息全部原样入 Lead hub(P0),不带归因 hint;只有 Lead relay/respond/no-route
把 root 标成已办。Annie 任意一条真实回复都能查询“Lead 办了没有”。
dead-letter 游标语义(FLY-1099)保留不动。

## 3. 与关联单边界

| 关联 | 关系 |
|---|---|
| FLY-1373(已合) | 地基:lead_inbox/LeadInboxLoop/adapter 原样用,**加语义不重造**;approval 同步路径、ACK 退役定案不推翻 |
| FLY-1339(closed PR) | 吸收其 wake ledger + 升级梯核心;B3 re-drive 不吸收;落地后 1339 re-scope(默认剩不下就删) |
| FLY-1393(blocked by 本单) | watchdog 收编依赖本单收据语义;本单**不动**任何 watchdog flag,只保证新闭环不依赖被关的巡检 |
| FLY-1099 | founder 入站游标/重试账本/dead-letter 语义保留,枢纽改的是**分发目的地**不是读取纪律 |
| supervisor/break-glass | 蓝图 §1.3 诚实代价:Lead 单点**本单只写明,不缓解**(后续单) |

## 4. 风险(设计期就要认账的)

1. **内部原子性是承重墙**:真实 Lead 动作与 `processed_at` 必须同事务或通过
   幂等 outbox 收口;actor/epoch 仅用于防误写。
2. **ship 批准延迟**:未测过;协议层入账预期毫秒级但**不给量级承诺**,实施时实测(蓝图 §7)。
3. **唤醒风暴**:1339 QA 曾抓出 exhausted-episode wake wedge(commit `b557d7541`);admission 事务内裁决 + causal key + push budget 上限照吸收,fail-closed(DB 坏了不绕闸)。
4. **Lead 单点**:接受蓝图裁定 —— 用可靠性换归因正确 + 升级链完整;检测归 FLY-1393,缓解归 supervisor 后续单。

## 5. 开放问题(research 阶段解决)

1. 内部类型白名单与 actor/epoch 防误写检查(不对外暴露为逐类型凭据承诺)。
2. founder 入站改线的精确切点:`founderReplyDeliverPass` 哪些分支改为 hub 入账、ship 同步路径怎么被「包住」(入账时序 vs trusted-writer 事务)。
3. wake 台账推广的 CLI ack 挂点(turn?inbox?公共入口?)与 respond 四形态收口方式。
4. detection-escalation 复用的接口适配(kind 枚举、resolveOwner 对「Lead 自己是被催对象」的语义)。
5. 重试轴的持久化落点(`next_retry_at` 加列 vs 新表)与死信表形状 + 告警出口(单一出口,不走 lead-alert.sh 分叉)。
6. Lead 不处理(kill Lead)时升级链的完整路径:谁观察到 Lead 的 processed 超时?(LeadInboxLoop 在 Bridge 里,Lead 死了 loop 还活着 —— 判据可用;Bridge 死了归 W-2,FLY-1393。)
