# FLY-1392 收据地基 — 调研

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: exploration.md(brainstorm gate 已过:D-1/D-6/D-7 获批,附加约束=歧义判据枚举式、no_route_needed 白名单+对抗 fixture、1339 吸收标 provenance 且本单 Codex 全量重审)

> 本文把蓝图(FLY-1391 architecture-target.md)落到**逐 file:line 的机械设计**。所有锚点本次实读核对。

> **最终裁定:** 本文保留为改型前研究记录。当前唯一产品概念与实现 authority
> 是 `design-correction.md`:founder 原文只到 Lead,只追踪“Lead 办了没有”。
> 下文的协议归因、模型巷与分层凭据叙事均已废除。

## 0. 蓝图勘误(本次查实,写入设计记录)

| # | 蓝图原文 | 查实结果 |
|---|---|---|
| E-1 | §2.2「第②档原语还在…不必从零造」+「装回去就能用是 unverified」 | **证伪一半**:工具仍注册(`inbox-mcp/src/index.ts:132`)且 Lead launcher 接线(`claude-lead.sh:1774,1860`);**但** FLY-1373 cutover 已关新事件 token enrichment(其 plan §4.1 步 1)——新事件零 `ack_required`/token,ACK 工具对新事件**无弹药**。重建「已读」= 重新设计 batch adapter 的 token/attempt/finalize 接线(FLY-1373 R4#2 明确 defer)。⇒ D-6 裁定 v1 不重建,`read_at` 预留列 |
| E-2 | §4.2 复用 detection-escalation「生产上关着」 | 状态机代码在且完整(`detection-escalation.ts:135-255` notifyLeadFirst + `:288+` reconcile);关着的是其**触发源**(FLY-1048 检测簇,legacy flag 圈内)。本单以收据超时为新触发源调它,不开旧检测簇 —— 无 flag 冲突 |

**FLY-1339 provenance(Tadashi 裁定)**:以下 §6 吸收的 wake-ledger / 升级梯设计源自死分支 commit `06c6dfa07`(PR #648,**CLOSED 未合并**)的 design docs。其 15 轮 Codex 批准**只作参考输入**;吸收内容随本单 plan 走**全量** Codex design review,不携带免审豁免。

## 1. founder 入站 — 现状逐分支解剖(改线的手术台)

`GatePoller.founderReplyDeliverPass`(`gate-poller.ts:3059-3220`,每 20 tick ≈60s)→ 按 thread 分组(**只有携带 pending question 的 thread 才进扫描**,`:3097-3160`)→ `emitFounderReplyDeliveryForThread`(`founder-reply-deliverer.ts:254-475`,游标/grace/dead-letter = FLY-1099 语义)→ `processFounderMessage`(`:482-787`):

| # | 分支 | 现状去向 | Lead 可见? | 收据? |
|---|---|---|---|---|
| F-1 | matching=0(闲聊/已答) | 游标前进,**丢弃**(`:356-360`) | ❌ | ❌ |
| F-2 | reply-to-card 绑定(`:518-544`)→ `tryFounderShipApproval`(接线于 `plugin.ts:7099`,FLY-799)bound | 同步 trusted-writer 写 gate response → runner | ❌ | 有 ✅ reaction,无台账行 |
| F-3 | ship classifier bound/deferred(`:556-606`) | 同上 / durable defer | ❌ | 同上(🕒) |
| F-4 | ship 未绑定(❓ unbound) | **WAKE-only 直达 runner**(`:609-666`,hint 文本) | ❌ | ❓ reaction;wake=裸 mailbox 写 |
| F-5 | 非 ship 恰 1 条 matching | `respondImpl`(fromAgent=founder)→ runner(`:752-783`) | ❌ | ❌ |
| F-6 | matching ≥2(ambiguous,`:734`) | `makeAmbiguousHandoff`(`gate-poller.ts:3877-3946`):appendLeadEvent + dispatchLeadEvent → Lead,**文案=请人工 relay**(`:3901-3904`) | ✅ | lead_events 行;无 processed 概念,relay 与否无人知 |

改线原则(D-1 获批):**六个分支全部保留其归因/授权逻辑**(reply-to-card、classifier、10min grace、游标、dead-letter、verify-approval 一概不动),改的是:每条被处理的 founder 消息**先落 hub 台账行**,每个分支的终局**写 processed evidence 或留 pending**。

## 2. 目标态机械设计:hub 台账生命周期(comm.db 单库 outbox 模式)

### 2.1 核心发现:关键三张表同库,天然可原子

`lead_inbox`、`messages`(response 行)、`runner_phase_wakes` **都在 comm.db(better-sqlite3, WAL)** ⇒ 「归因绑定 + response 写入 + wake intent 入队 + processed evidence」可在**同一事务**提交 —— 蓝图 §2.4 条 2 的 outbox 路径在本库是**免费的**;真正跨库的只有 push 副作用(mailbox 文件写 / Discord),它们全部降级为「intent 行的执行」,失败重推,幂等键在台账上。

### 2.2 founder 消息的台账行

```
enqueue lead_inbox:
  id        = founder_msg:<leadId>:<discordMsgId>     (UNIQUE 幂等,重扫安全)
  msg_class = protocol(默认;升模型巷时另 enqueue model 行,见 §4)
  priority  = 0
  type      = founder_reply
  content   = 原文截断 + threadId/issueId 元数据
  delivered_at = 入账即置(内部语义:已持久落到 Lead 域收件账本)
```

各分支终局(同事务):

| 分支 | disposition | processed_at | processed_evidence(JSON) |
|---|---|---|---|
| F-2/F-3 bound | routed_ship | ✅ | {kind:"ship_bound", questionId, responseId, actor:"bridge-protocol", epoch} |
| F-3 deferred | 留 pending(defer 是暂态) | — | —(rebind 升级为 bound 时补) |
| F-4 ❓ | 留 pending → 超时升模型巷(§4) | — | Lead 处置后:{kind:"lead_routed"...} |
| F-5 恰一 | routed_question | ✅ | {kind:"question_bound", questionId, responseId, actor:"bridge-protocol", epoch} |
| F-6 歧义 | 转模型巷(§4) | — | Lead 处置后补 |
| F-1 白名单命中 | no_route_needed | ✅ | {kind:"no_route_needed", basis:[命中规则], actor:"bridge-protocol", epoch} |
| F-1 白名单不命中 | 转模型巷(§4) | — | Lead 处置后补 |

验收 #6 的查询即:`SELECT delivered_at, processed_at, processed_evidence FROM lead_inbox WHERE id='founder_msg:<lead>:<msgId>'`。

### 2.3 lead_inbox 加列(additive migration,comm.db)

```sql
ALTER TABLE lead_inbox ADD COLUMN processed_at TEXT;
ALTER TABLE lead_inbox ADD COLUMN processed_evidence TEXT;  -- JSON;无 evidence 的 processed 无效(写入侧断言)
ALTER TABLE lead_inbox ADD COLUMN read_at TEXT;             -- 预留,v1 不接线(D-6)
ALTER TABLE lead_inbox ADD COLUMN escalated_at TEXT;        -- 升级 founder 时刻(只升一次)
ALTER TABLE lead_inbox ADD COLUMN next_retry_at TEXT;       -- 未送达轴持久退避(修蓝图 §3.1 缺口2)
ALTER TABLE lead_inbox ADD COLUMN resend_of TEXT;           -- 未处理轴重发行 → 原行 id
ALTER TABLE lead_inbox ADD COLUMN resend_round INTEGER;     -- 「这是第 N 次」标记
```

## 3. 内部办结写入表(历史设计;最终 founder 规则见 design-correction.md)

| 消息类型(lead_inbox type) | processed 判据记录 | 写入者 | 排除他人(actor/epoch 绑定) | 原子化路径 |
|---|---|---|---|---|
| gate_question / runner_question | comm.db `messages` 该 questionId 的 response 行(UNIQUE parent_id) | Lead(respond CLI,经 lease 授权)或 founder(trusted writer) | response 行自带 from_agent + provenance;只有 actor+epoch 合同成立才推导 processed;但凡 response 已存在或 question 已终态,都独立退出催办 eligibility(答了就是答了,谁答的都解除催办,且不伪造弱 evidence)| 同库:巡检复制合法 response provenance;无合法 provenance 时不铸造 processed,由 pending-state 守卫确保已答门零催办 |
| founder_reply(§2.2) | 绑定 response 行 / no_route_needed 标记 / Lead 路由动作行 | bridge-protocol(F-2/3/5/白名单)或 Lead(模型巷,§4) | evidence 记 actor+owner_epoch;Lead 路由走新 CLI 子命令(§4),同事务写 | **同 comm.db 事务**(outbox) |
| session_completed / qa_result / codex_review_result / DONE 报告 / ask --report | Lead 引用该 message id 的出站动作:route-founder-reply 不适用 → 此类 v1 **不要求 processed**,降级为 delivered 即终态(P2) | — | — | —(蓝图 §2.2:「找不到 evidence 的正确处理是降级,不是拿弱信号顶上」;Lead 对报告的处置面太宽——回 Discord、建单、口头——v1 无可靠可观察判据,**诚实降级**,写入 Known Limitations) |
| founder_reply_ambiguous(模型巷行,§4) | Lead 显式路由动作(route CLI)写回原 founder_msg 行 | Lead(lease 授权) | CLI 校验 lease + 记 actor/epoch | 同 comm.db 事务 |
| runner wake(§6 台账) | `runner_phase_wakes.state='started'` —— runner 醒后第一个 CLI 动作 | runner 自身进程(inbox/turn 命令顺手标) | UNIQUE(execution_id, message_id);started 只能由持有该 execId CommDB 会话的进程写 —— actor=execId 本身 | 同 comm.db;push 失败→行留 pending→梯(§6) |
| 纯遥测 P3(progress 等) | **不要求 processed** | — | — | delivered 即终态,永不催永不升级 |

**内部不变式**(写进实现与测试):① `processed_at` 非空 ⇒ 有可审计 actor+epoch;
② 新类型默认不进入办结巡检;③ 催办/升级只对已列入内部白名单且超窗仍
未办的行。它们是防误写与查询安全措施,不是对外凭据合同。

## 4. 歧义判据 — 枚举表(D-1 附加约束:窄且枚举式,非开放分类)

**进 Lead 模型巷当且仅当命中下列之一**(协议层判定,零模型参与):

| # | 判据 | 对应现状分支 |
|---|---|---|
| A-1 | 非 ship matching ≥ 2(同一 founder 消息可答多个 pending question) | F-6(`:734`) |
| A-2 | ship classifier 判 unclear / narrow-multi / auto-approve off,且非 reply-to-card(❓ 形态)**超 rebind 窗口仍 unbound**(窗口=复用 FLY-1099 deferred-rebind 节奏,plan 定参) | F-4 |
| A-3 | matching = 0 且 no_route_needed 白名单(§5)不命中 | F-1 残余 |
| A-4 | 白名单/归因判定本身抛错(fail-closed:判不了=不许静默,升人判) | 新 |

模型巷行形态:`enqueue lead_inbox { id: founder_route:<leadId>:<msgId>, msg_class:"model", priority:0, type:"founder_reply_ambiguous" }`,内容含原文 + 候选 questionId 列表 + **处置指令**:Lead 跑新 CLI `flywheel-comm route-founder-reply --msg <msgId> (--to-question <qid> | --no-route --reason <r>)` —— 该命令同 comm.db 事务:写 response(如 --to-question)+ 回填原 founder_msg 行 processed(evidence 记 actor=leadId+epoch+依据)+ 消费模型巷行。F-6 现状「请人工 relay」文案废除 —— relay 变成有收据的显式动作(蓝图:歧义不再静默转人工)。

## 5. no_route_needed 白名单(D-7 附加约束:保守、高置信、可对抗验证)

**仅当全部满足**:① 该 thread 当时 matching=0 **且** thread 内零 pending question;② 消息命中**封闭 allowlist**:纯 emoji/表情符号,或去空白后 ≤6 字符且属短 ACK 语集(好/好的/嗯/ok/okk/谢谢/辛苦了/收到/👍 等,实现为**枚举常量表**,不是正则模糊匹配);③ 非 Discord reply(不引用任何消息)。其余一律 A-3 升模型巷。

evidence.basis 记录命中的具体规则(如 `["zero_pending","ack_lexicon:好的","not_a_reply"]`)。

**对抗 fixture(验收新增,Tadashi 要求)**:构造边界性可执行消息 —— 零 pending thread 里的「帮我把这个也改了」「等下先别 ship」(短、无问号、口语)—— 断言**不被**标 no_route_needed,走 A-3 升模型巷。

## 6. Runner 方向:wake 台账 + 升级梯(吸收 FLY-1339 核心;provenance=06c6dfa07/PR#648 CLOSED)

### 6.1 现状 wake 面(全部裸写,零回执 —— 本次实读)

| 路径 | file:line | 现状 |
|---|---|---|
| `flywheel-comm send` | `send.ts:102-134` | wake ok ⇒ `markInstructionDelivered`(= 文件写 ok);vendor 路由;vendor=none loud skip |
| `respond` 三形态 wake | `respond.ts:134-153`(bypass)`:201-254`(no-block marker)`:273-330`(ask) | 全 best-effort,失败仅 stderr |
| founder ship WAKE-only | `founder-reply-deliverer.ts:609-666` | wake 失败会 fail 该消息(游标不前进,FLY-605)—— 唯一有失败反压的,但无台账 |
| choke point | `wake.ts:57-116` `wakeRunnerMailbox` | 单收口点已存在 ✅ |

### 6.2 台账推广(现成件,接线为主)

- **表已在**:`runner_phase_wakes`(`db.ts:91-103`):pending/started/finished + `UNIQUE(execution_id, message_id)` + `idx_..._source(execution_id, source_instruction_id)`;API 已有:insert(`:1735`)/list(`:1771`)/markStarted(`:1788`)/markFinished(`:1803`)。现消费者仅 Codex daemon(`codex-phase-lifecycle.ts`)。
- **enqueue 点** = `wakeRunnerMailbox` choke point:ledger 开启时 caller 显式传 causal intentId(1339 合同,防风暴的关键 —— 同因果事件跨入口同 key):`gate-answer:<questionId>` / `founder-route:<msgId>` / `instruction:<commDbMsgId>` / `phase:<kind>:<exec>:<head>`。**同事务**:intent 行 + 业务写(response/instruction)一起提交,然后 push。
- **started ack 点** = runner 醒后第一个 CLI 动作:`inbox`(`inbox.ts:14-28`,已开 CommDB 标 read —— 顺手 markStarted 该 exec 全部 pending)与 `turn`(`turn.ts:36`,同库)。零新进程,零 runner 协议面新增。
- **vendor=none**(agy/kimi):不入 wake 环(`send.ts:92-101` 语义保留);intent 行标 skipped_no_transport,不进梯。

### 6.3 升级梯(patrol piggyback GatePoller tick,零新 timer)

pending 超时(自 queued_at):
- **T1(~90s)**:verified 重推 —— 接活 `MailboxTransport.writeVerified`(`MailboxTransport.ts:77`,**已实现零调用方**,本次核实)。
- **T2(~5min)**:terminal 拍醒 —— 前置 fail-closed 健康门:pane 探测 = waiting 且 session ∈ {parked, awaiting_review, idle 预期态};绝不对 executing pane 注键(FLY-92 红线);注入文本 = 短指针「你有 pending wake,跑 flywheel-comm inbox」。**终身一次 per intent**(crash 后不重打)。杀 pane 场景:健康探测失败 → 记 `wake_failed` → 直升 T3(验收 #3)。
- **T3(~10-15min)**:唤醒失败进入**无收据升级链**(§7)—— kind=`wake_failed`,detection-escalation 状态机承接。
- 防风暴(1339 QA 实证过 wedge,commit `b557d7541`):admission 与业务写同事务裁决;push budget 上限;episode 一次性;DB 故障 fail-closed 不绕闸。

## 7. 未处理轴:标记 → 重发 → 升级(→Lead 与 →Runner 统一语义)

### 7.1 巡检(piggyback GatePoller,读 comm.db)

对「要求 processed」(§3 合同表)且 `processed_at IS NULL` 且已 delivered 的行,按类别窗口:

| 类别 | 窗口 | 到期动作 |
|---|---|---|
| founder 决策类(approve_to_ship 的 gate_question 等) | **零缓冲** —— 不进 N 次循环;本类的「催」的对象是 founder 本人,沿用现有 founder-page 机制,不在本闭环重造 | — |
| Lead 可动手(gate_question 非 ship 答复、founder root) | 30min(内部按类型可调) | 重发行(§7.2)→ 仍无 → 升级(§7.3) |
| 报告类 P2 / 遥测 P3 | 不要求 processed | 永不 |

**「催已过的门」结构性消灭**(验收 #4):催办同时要求 `processed_at NULL`
且 question 仍 pending;gate 已答 ⇒ response 存在或 question 进入
resolved/superseded/terminal-disposed ⇒ bootstrap、到期选取、consumer
revalidation、delivery 初始化四处一致排除。内部 provenance 缺失时也绝不
继续催已关门。

### 7.2 重发行

`enqueue { id: <原id>#r<N>, resend_of: 原id, resend_round: N, content: 原文 + 「⚠️ 第 N 次重发,首投 <时间>,仍无处理收据」 }` —— 幂等键 =(原 id, N),内容哈希不参与(FLY-218/220 根因规避);对 runner 目标同时走 §6 wake 环。上限 N(plan 定,建议 2)后进升级。

### 7.3 升级(复用 detection-escalation,新触发源)

`notifyLeadFirst`(`detection-escalation.ts:135`)+ reconcile(`:288+`):kind = `receipt_unprocessed:<type>` / `wake_failed`;episodeFingerprint = 行 id(N 不进 fingerprint —— 同一消息一个 episode);targetKey = `<project>:<leadId>` 或 execId。once-per-episode / 30min grace / CLEARING 静音 / fleet 聚合全部继承。`escalated_at` 回填台账行(只升一次)。升级文案带**消息原文摘要 + 已重发 N 次 + 首投时间**。

### 7.4 未送达轴补洞(蓝图 §3.1 三缺口,全在 →Lead 方向)

| 缺口 | 修法 |
|---|---|
| model 通道无重试上限(`lead-inbox-loop.ts` 仅 protocol 有 maxAttempts=3) | model 巷加 maxAttempts(建议 5)+ 超限 quarantine(机制已有:`recordProtocolFailure` 的 quarantine 形态推广到 model) |
| 无持久退避(attempts 纯计数) | `next_retry_at` 列(§2.3);claim 查询加 `next_retry_at <= now` 条件 |
| 超限静默(lead_events `delivery_attempts < max` 过滤后消失) | 超限 = disposition=dead_letter 终态 + **恰一条告警**经 Bridge LeadAlertNotifier 统一频道(不碰 lead-alert.sh 分叉 —— 那是 FLY-1393/W-2 域) |

## 8. 顺序合同(蓝图 §5.1 要求明写 —— 本单如实声明,不改排序)

v1 保持 FLY-1373 现状:`ORDER BY priority, seq`(优先级赢,同级 FIFO)。理由:model 巷单 turn 批量交付,一次 poll 的 unread 快照合为一 turn,批内呈现顺序影响有限;P0 跨批插队正是 founder 优先的期望语义。蓝图建议的「流内 FIFO 优先、优先级只调度流间」记为后续优化项(需 stream-key 调度器,超本单)。**合同写死进 plan**,design review 盯这条的取舍陈述。

## 9. 扫描面扩展(D-7 全量入账的边界)

现状只扫「携带 mature pending question 的 thread」(`gate-poller.ts:3097-3175`)⇒ 零 pending thread 的 founder 消息**不可见**。D-7 要求每条消息有收据 ⇒ 扫描面扩为「绑定**非终态 session** 的 issue thread」(byThread 构建从 sessions 出发,pending questions 作 matching 集合可为空)。成本:活跃 issue 数 × Discord REST GET/60s(游标增量,空结果廉价),生产 ~10-20 活跃 issue,可控。**终态/归档 thread 不扫**(Known Limitation:关单后的 thread 发言无收据 —— 那类消息现状也不可见,不回退)。

## 10. Known Limitations(设计期认账)

1. **报告类无 processed 合同**(§3):Lead 对 runner 报告的处置 v1 无可观察判据,降级 delivered 即终态 —— 诚实降级优于弱信号(蓝图 §2.2 明文)。后果:Lead 吞报告不动,本闭环不报;缓解靠 runner 侧 DONE-report 协议自身的重报纪律。
2. **无「已读」层**(D-6):区分不了「读了没动/没读」,升级链统一超时升级。
3. **归档/终态 thread 消息无收据**(§9)。
4. **Bridge 死 = 闭环失明**:巡检/loop 全在 Bridge;属 W-2(FLY-1393),本单不解。
5. **Lead 单点**(蓝图 §1.3):本单写明不缓解;supervisor/break-glass 后续单。
6. **ship 多一跳延迟未测量**:入账+归因为同 pass 内协议层动作,预期毫秒级,**不给量级承诺**,实施时实测。

### 10.1 实施后 cross-family review 接受的限制(2026-07-21)

R4 在当前实现上给出 10 条仍成立的 non-blocking advisory。Lead 裁定全部接受:它们都没有击穿本单的灵魂不变式——业务事实仍先持久化,缺收据/失败不会被当作成功吞掉;其中的提前退休、卡滞与投递重复风险要么保留可重放事实,要么进入既有 retry/dead-letter/升级可见链。这里逐条认账,不把 advisory 隐藏成“已修复”。

| findingKey | 已知限制 | 本单为何可接受 / 当前护栏 | 后续处置 |
|---|---|---|---|
| `resend-ignores-question-disposal` | **QA round 1 已修复**:原 eligible-root 对 question 只查类型/ship 排除,founder 回答导致 question `terminal_disposed` 后仍会 r1/r2/升级。 | bootstrap、到期选取、consumer revalidation、delivery 初始化统一要求 question 未 resolved/superseded/terminal-disposed 且无 response;这与内部 actor+epoch 审计分离,因此关闭 gate 会停催,也不会伪造办结。 | 独立 QA 回归覆盖 founder-answered 阴性 + Lead-answered 阳性;receipt hygiene 后续批只需处理其他孤儿清理,不得回退该守卫。 |
| `pending-wakes-never-terminalized` | 任一次 transient T2 refusal(例如 capture 瞬时失败或 Gate-3 有其它 pending question)也会写 `escalation_outbox_id`,使 intent 提前退出剩余 T1/T3 梯。 | 提前退出重试不等于静默成功:`wake_failed:<intentKey>` 已持久化并进入升级可见链;本单验收以失败可见为准,不承诺 transient refusal 后继续尝试。 | **独立 QA 重点故障注入 A**(§10.2)。 |
| `receipt-patrol-every-tick-unguarded` | 60s patrol 内的 `deriveProcessedReceipts` 仍在 IMMEDIATE 事务中做随 `lead_inbox` 增长的全扫描/全 Map,长期可能竞争 5s busy timeout。 | 调度已是 20 tick cadence + single-flight;activation UPDATE 只做一次。当前数据规模可接受,但没有长期性能上界承诺。 | 与 fanout/谓词去重合并为性能维护候选,不单开。 |
| `eligible-root-predicate-duplicated` | owner eligibility SQL 在三处 + `markConsumed` JS 一处复制,未来可能再次漂移。 | 当前四处一致;single-owner、`model_promoted`/`model_pending` 与 revalidation 已有回归测试。风险是维护性,不是当前行为错误。 | 与两项性能维护一起合并候选(shared SQL/view),不单开。 |
| `instruction-read-at-not-claimed-for-codex` | `instructionAndIntent` 先建 wake 后,vendor callback 按 `source_instruction_id` 命中 duplicate 并在 claim `read_at` 前返回;之后 `inbox` 会再看到该 instruction。 | 通道合同本就是 at-least-once;instruction UUID 与 `[lead-instruction <id>]` 是幂等键/消费凭据,callback 只保留一条 wake,`inbox` 对 durable instruction 恰一次置 `read_at`。新增回归测试验证 duplicate → 单 wake → 单次 inbox consumption。 | 保留 rollout 注意项;不要把 `read_at` 当 processed 收据。 |
| `respond-now-throws-on-second-answer` | receipt-on 路径对同一普通 question 的第二次/晚到 `respond` fail-loud,不再像 legacy unguarded insert 那样成功。 | 这是可见的 CAS 失败,不会覆盖赢家 response 或伪造 processed evidence;调用方必须显式处理/重开问题,不发生静默语义漂移。 | rollout 文档保留这项行为变化。 |
| `founder-thread-scan-fanout` | receipt mode 每 pass 扫所有 non-terminal session thread,无 pending question 也扫;REST fanout 随活跃 session 数增长。 | 这是“所有 founder 回复先入 Lead hub”的正确性代价;读取失败进入既有 `read_failed`/retry/dead-letter 可见路径,不会把失败游标当成功推进。 | 529 房 QA 量 REST/429;与 scan/谓词去重合并性能候选。 |
| `hub-root-strict-content-equality` | 首次 UOW 瞬时失败后 founder 编辑同一 Discord message,按 mutable content 复用 root 会抛错并卡住该 thread 后续消息直到 FLY-1099 dead-letter。 | stable `msgId` 仍保留原 root 与 retry ledger;卡滞最终由 dead-letter/升级变响,不是静默跳过或错误 processed。接受的是“发生时可见”,不是“不会发生”。 | **独立 QA 重点故障注入 B**(§10.2)。 |
| `inbox-ack-can-consume-intent-before-push` | `queued_at <= observedAtMs` 的毫秒边界上,并发 inbox/turn 可先把新 intent 标 started,随后 first push claim 返回空,该 intent 不再走 T1/T2/T3。 | business payload(response/instruction)先在同一 UOW 持久化;transport intent 提前退休不会删 payload,后续 `check`/`inbox` 仍按稳定 question/instruction id 读取。新增回归测试钉住“push skip + durable instruction 单次消费”的 at-least-once 降级语义;只接受额外唤醒延迟,不把 started 解释成 processed。 | rollout 注意项;与 `read_at` 重复一起按幂等键验证。 |
| `founder-approval-source-event-id-changed` | trusted receipt 路径的 source event id 为 `founder-approval:<qid>:<msgId>`(legacy 是 `founder-approval:<qid>`),并省略 legacy provenance 参数;reject 由 false 变 throw。 | 现有消费者无一按旧精确 id lookup;权威 source event/approval 仍同事务持久化,throw 会进入 deliverer retry ledger,不会假报 ship authority。 | 审计查询/rollout 记录新 key shape;不在本单兼容双 key。 |

R4 另有 4 条 LOW advisory 已在被审 HEAD 上标记 **FIXED and verified**,因此不列为 Known Limitation:`stale-root-routing-state-assertion`、`model-lane-owner-excluded-from-resend`、`bootstrap-rearms-disarmed-roots`、`hub-root-resend-lands-in-protocol-lane`。

### 10.2 独立 QA 指定故障注入(接受标准 = 失败变响)

1. **Transient T2 refusal 提前退休 wake**:让 parked/idle runner 的 T2 遇到一次可恢复拒绝(capture 瞬时失败或 Gate-3 冲突);允许它不再继续梯级,但必须查到同一 intent 的 `wake_failed:<intentKey>` outbox/升级事实,且不可伪造 started/processed。验收不是“拒绝不发生”,而是“发生时升级链让它可见”。
2. **Edited founder content 卡滞 retry**:让 founder hub-root 首次终局 UOW 瞬时失败,随后编辑同一个 Discord msg 再重试;允许 strict-equality 抛错及 thread 暂停,但 FLY-1099 retry/dead-letter/升级链必须留下可查询事实,不得推进 cursor 后静默丢消息。验收不是“编辑不触发卡滞”,而是“卡滞最终变响”。

`instruction-read-at-not-claimed-for-codex` 与 `inbox-ack-can-consume-intent-before-push` 不要求真机制造窄 race;实现回归测试以 stable instruction id 证明 vendor duplicate 只留一条 wake、CommDB payload 仍可由 `inbox` 单次消费,满足 at-least-once + 幂等键合同。

## 11. 留给 plan 的决策点

1. 切片顺序与规模(建议:S1 schema+evidence 推导 → S2 founder 入账+路由 CLI → S3 wake 台账+梯 → S4 未处理轴巡检+升级 → S5 验收 fixture+529 真机);implement 端 = Codex(临时安排)。
2. 各窗口/上限参数默认值(T1/T2/T3、30min、resend cap、model maxAttempts)+ env 覆盖面。
3. F-3 deferred 与 A-2 rebind 窗口的衔接参数。
4. flag 形态:本单新闭环的 kill-switch(建议单一 `FLYWHEEL_RECEIPTS`,default ON?—— 与「重启①后第一单」的部署节奏相关,plan 里与 reverse-compat sentinel 一起定)。
5. `route-founder-reply` CLI 的授权面(lease + 拒 founder 保留名,对齐 respond.ts:76-87 形态)。
