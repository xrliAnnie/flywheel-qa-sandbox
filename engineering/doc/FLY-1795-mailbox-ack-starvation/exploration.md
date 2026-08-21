# FLY-1795 runner lane ACK 饿死 — 探索

Issue: FLY-1795 (https://linear.app/geoforge3d/issue/FLY-1795/消息层bug-某个-runner-lane-的收件永不-ack-3-个-in-flight-槽被占死后续指令按租约每-10)
日期: 2026-08-19
基于: 无

## 1. 问题一句话

Lead→Runner 的 mailbox 指令被 runner **收到并执行了,但 ACK 永不落地**,3 个 in-flight 槽被占死,后续指令只能按租约过期每 ~10 分钟漏一条;全程零错误日志,只能人肉数 QUEUED 才发现。

## 2. 代码审计核心发现(本探索的主要增量)

issue 里 8-19 晚的「机制候选锁定」把 `ackBatchByRecipient` 的 `ack_late_noop` 当作统一病因。**逐行审计后发现:两条 lane 是两套完全不同的 ACK 机制,病因要分开说。**

### 2.1 两条 lane、两套 ACK 机制(实核,均有行号)

| | Lead lane(bridge→lead) | Runner lane(lead→runner) |
|---|---|---|
| 投递 | `LeadInboxLoop` 攒批→Discord/MCP 通知 | `RunnerMailboxLane.tick()` 攒批→`runnerAdapter.deliver()`(Claude=Agent Team 邮箱注入;Codex=doorbell) |
| ACK 动作 | Lead 模型调 MCP 工具 `flywheel_inbox_ack_batch` / `lead_actions.ack_batch` | **runner 模型自愿跑 CLI** `flywheel-comm inbox --exec-id`(batch envelope 文本里的一句指令,`runner-mailbox-lane.ts:176-184`) |
| ACK 落地路径 | `insertBatchAckReceipt`(`db.ts:1671`)→ mailbox 里再入一行 `to_agent='bridge', type='ack_batch'` → 该 Lead 自己的 inbox loop 每 tick 经 `claimBridgeProtocol` 排干 → `ProtocolIngress.handle`(`protocol-ingress.ts:57`)→ `ackBatchByRecipient`(`mailbox-queue.ts:1453`)**异步** | `inbox` 命令(`commands/inbox.ts:26-28`)对每条 `getUnreadInstructions` 结果逐条调 `MailboxQueue.ack()`(`mailbox-queue.ts:2306`)**同步** |
| 已知缺陷 | `ackBatchByRecipient` 只对 `state='LEASED'` 行 UPDATE;行已过期回 QUEUED → `ack_late_noop` 静默作废(1466/1474/1484 行三个出口)。且 requeue 会把 `batch_id` 置 NULL(1725 行),晚到的 ack 连行都找不到(`rows.length===0`) | `ack()` 无任何投递护栏:`WHERE (id=? OR delivery_id=?) AND state IN ('QUEUED','LEASED')` — **从未投递的 QUEUED 行也能被 ACK = 静默丢弃** |

### 2.2 runner lane 的真病因:ACK 是「模型自愿动作」,消费与 ACK 结构性脱钩

现代 Claude runner(FLY-142 之后 mailbox sentinel 默认 active):

1. 投递 = Bridge 把 batch envelope 塞进 claude-code 自己的 Agent Team 邮箱,`useInboxPoller` 在 turn 边界注入 session。**内容到手,不需要 runner 做任何事。**
2. ACK = envelope 文本里写着 "You must ack this batch (run 'flywheel-comm inbox --exec-id …')" — **靠 LLM 自觉照做**。
3. PostToolUse hook `inbox-check.sh` 在 sentinel active 时**直接 no-op 退出**(`scripts/hooks/inbox-check.sh:48-56`),不会替 runner ack。
4. 除此之外**没有任何代码路径**会 ack runner 的 instruction 行(全仓 grep:runner 行的 acker 只有 `inbox` CLI、`check` CLI、legacy hook 回退路径三个,全是拉取式)。

于是:runner 读了 envelope→照内容干活→用 `flywheel-comm ask` 交报告(ask 不 ack 任何行)→**永远没跑 `inbox` → 行永远 LEASED**。这精确解释全部证据:

* 「投递成功、执行成功,只有 ACK 不落地」— 消费走注入,ACK 走另一条自愿 CLI,天然可分离。
* 「同体命中率 1/4、2/4」— 模型这一轮想没想起来跑 `inbox` 的随机性,不是体病。
* 「runner 逐字引全 id 报 DONE 而行仍 LEASED」(78314b0b/2c86cf09)— 内容确实消费了(id 都在 envelope 里),CLI 从未跑。issue 里「待 runner 自证从未发起还是发起了没落地」的答案:**从未发起**。
* 「redelivery 后 runner 幂等跳过、不重复 ack」— 重投的 envelope 内容一样,模型判「处理过了」,更不会去跑 CLI。
* 「lease_retry_count 递增、约每 10 分钟漏一条」— 唯一在动的是租约过期轮换。
* 8-15 手工放槽后「后续三行立刻正常 ACK(claimed_by 空)」— 那几条被 runner 某次真的跑了 `inbox`(或在 QUEUED 期就被 CLI 拉走),CLI 拉取对 QUEUED 行直接 ack,claimed_by 本来就是空。

### 2.3 tpl_prd / activation 线索的裁定

issue 标注的未验证线索(唯一 tpl_prd runner、FLY-1788 activation 缺失→ ack 可能整段跳过):**审计不支持「workflow-aware ACK 收尾路径」假说** — `inbox`/`ack()`/`check` 全链无一处引用 `runner_workflow_activation`(grep 零命中)。更可信的解释是行为相关性:prd 类节点长写作 turn、少 task boundary,模型更少想起跑 `inbox`。该线索降级为「行为诱因」,不进机制修法。

### 2.3b 「非人工亚秒级 ACK」判别(2026-08-19 晚,Tadashi 追加设计输入,生产库只读取证闭环)

Cass 取证到 runner lane 存在非人工 ACK(23:30:03.956,早于一切人工介入),看似与「runner 无 ack 面」矛盾。用两条可证伪判别在生产 `~/.flywheel/comm/flywheel/comm.db` 只读查证:

1. **排他判别(单行 vs 批量)**:23:30:03.956Z 那次 ack 只动了 `97315ec8`(`type='response'`)一行;同 lane 的 5 条 instruction 行(63dd0dc0/3bf05655/1cb3695f/044c3532/d2ea6a05)当时原地未动,直到 23:45 才被别的事件 ack。⇒ 批量 acker(hook 单条 UPDATE、`inbox` CLI 全量循环)排除。
2. **归属判别(phase-wake vs gate-poll)**:`runner_phase_wakes` 里没有 `source_instruction_id=97315ec8` 的行 ⇒ codex phase-hold 的 durable-accept 自动 ack(`db.ts:2897`,只作用于 instruction 且仅 codex phase-hold 生效)排除。而 `97315ec8` 的父 question `6ab81824` 是该 runner 自己发的 **blocking `founder_review` gate** ⇒ 命中 `check`/gate 轮询 → `consumeGateResponse`(`db.ts:4193`)→ 同一个无护栏 `ack()` 的消费路径。

**裁定**:自动发起方 = **runner 自己的 blocking-gate 轮询消费**(拉取即消费,合法),但它:(a) 只作用于「有本 exec 开口 question 配对的 response 行」,**对 instruction 行不存在任何自动 ack 面** — Cass 的两句话同时为真,不矛盾;(b) 不 stamp `delivered_at`、不留渠道 ⇒ 在 DB 里与静默丢弃同形,这正是取证反复被误导的仪器根源。修法归位:**不是修它,也不是它能替 instruction 行兜底** — instruction 行仍需新建机械 ack 能力(方向 A);`consumeGateResponse` 作为拉取式消费面纳入方向 C 契约(`deliveredNow=true` + `acked_via='gate_poll'`,行为不变、只补证据)。

附带副产物:23:45:21 的「5 行 7ms」批量 ack,5 个 `acked_at` 为 .279/.283/.284/.285/.286 **逐行递增** = `inbox` CLI 逐行 `markInstructionRead` 循环的签名(hook 是单条 `id IN (...)` UPDATE,时间戳必全同)⇒ 调用方是某次 `flywheel-comm inbox --exec-id` 执行(内容有随 stdout 返给调用者,是否被读走 DB 层无法证明)。「调用方待查」在 acked_via 落地后此类问题一条查询出答案。

### 2.3c 三 Lead 分岔与最终判定语(2026-08-19 深夜,输入已闭合)

围绕「5 条 QUEUED 行被 ack、内容是否丢失」三个 Lead 产生分岔,最终由 runner 证词(先于建议,非事后配合:它在 `inbox` 输出里第一次看见 75734239 的 id)与代码实读收敛,**判定语定稿**:

1. **pull 是真实投递通道**:`inbox` CLI 把内容真实返回给调用方上下文;`delivered_at` 是 push-only 字段,**系统性漏记 pull 投递** — 「5 条从未送出」是仪器缺口造成的误读,真相是「三条走了 push+pull 双路,一条只走了 pull」:差别是投递路径,不是有无投递。
2. **拦-QUEUED 方案作废**(HL 撤回):拒绝 QUEUED 行的 ack 会砍掉 pull 侧合法签收。正确修法 = **pull 路径盖投递章**,且章义明写为**「送出那一刻」非「被接住」**(否则新字段又会比它记录的东西更强 — 这正是本案的病根句式)。
3. **id 到达 ≠ 正文到达**:正文是否进上下文取决于调用方处理。这一层的确定缺陷(方向无关,直接进方案):`inbox` 一次返回多条且**破坏性读**(ack 落库在 stdout 打印之前,`commands/inbox.ts:26-28` → `index.ts:808`)— 调用方中途丢正文即永久失去再取途径。修法任选「读不销毁 / 两阶段确认 / 输出可召回」,与 ack 语义之争无关。
4. 回归用例基准:HL 重发的合并指令对 runner 是**首次拿到内容**,非重复投递。
5. 时刻表证据包使用警示(进测试设计):runner 侧只有「首个可观测动作时刻」= 到达时刻**下界**,不可当投递时间;时区已校准(21d17ffd/54ecbcda 为 PDT 转 Z,其余 UTC);8f8b60ef 无可用时刻不许拿估计值填。方法论:**双边界校验** — 到达必须晚于建行**且早于现在**;只查下界的检查对未来值恒真,「一个不可能得出否定结论的检查不是检查」。

对本设计的落点:方向 C 的「无证据 ack 拒绝」重述为**回归绊线**而非策略 — 所有合法 ack 面迁移后都自带投递章(pull 在同事务盖章、push 行本就有章、phase-wake durable-accept 即章),裸 ack 只可能来自未迁移调用方 = bug,拒绝并审计;不存在「拦 QUEUED」这回事。新增方向 H:`inbox` 的破坏性读补**召回能力**(行本体在 mailbox 存活 72h、归档后正文仍在 `mailbox_log` archived row_json 里 — 缺的不是持久化,是再取通道)。

### 2.4 Lead lane 的病因(Cass 样本,~3min 延迟结算/偶发不结算)

Lead 是真调了 ack 工具的(ack_batch 行入了库),但应用是**异步二跳**:ack 行要等该 Lead 自己的 inbox loop 下一 tick 才被排干应用。窗口内若目标行租约先过期回 QUEUED(且 `batch_id` 被 requeue 置 NULL)→ `ack_late_noop` 静默作废。Lead 每次收到重投会再 ack → 终有一次命中 LEASED 窗口 → 表现为「延迟结算、能自愈」;runner 永不重 ack → 永不自愈。**同一张表、两种命运,自变量是谁会重发 ack。**

### 2.5 观测断层的根因(issue 追加事实 #6)

`mailbox_log` 8-12T17:10 后零写入:状态迁移写入器(settlement recorder,`mailbox-queue.ts` pre-#808 的 2199 行)随 **FLY-1645 receipt ledger teardown(PR #808,8-11 merge,8-12 部署)** 整体拆除 — 观测功能是那次「机器整体拆除」的陪葬品,不是回归 bug。修复方向必须**新建轻量迁移日志**,不能复活已被 founder 判死的 receipt ledger。

### 2.6 其余实锤缺陷(与 issue 追加事实逐条对上)

* **requeue 抹 `delivered_at`**:5 处(`mailbox-queue.ts:350/1192/1607/1727/2249`)。这是唯一能判「投没投过」的字段,被重投擦除 → 事后取证不可能(d2ea6a05 实锤)。且 CLI 拉取路径 ack 时**根本不写 delivered_at**(`ack()` 不碰该列)→ HL 的「5 条 QUEUED 被 ACK、内容从未送出」结论,部分是仪器缺口造成的不可判:CLI 拉取的合法 deliver+ack 与静默丢弃在 DB 里同形。
* **legacy hook 回退路径裸 SQL ack**(`inbox-check.sh:86`):sentinel 不在时直接 `UPDATE mailbox SET state='ACKED' … state IN ('QUEUED','LEASED')`,同样无护栏、同样不写 delivered_at。
* **安全禁令可静默 DEAD**(b7274495):`lease_expired_unacked` → DEAD → 只进 30 分钟聚合死信通知;「别做 X」类指令静默失效的代价是动作照做。
* **in-flight 饱和零告警**:runner 3 槽占死只能人肉数 QUEUED;唯一的「告警」是 envelope 里给模型看的一句话。

## 3. 修法方向(brainstorm 选项)

### 方向 A:runner ACK 机械化(根治 runner lane)

ACK 不能依赖模型自觉。候选:

* **A1(推荐)turn-end 机械 ack**:Claude runner 已有 Stop hook `runner-stop-notify.sh`(FLY-1571)。加一条腿:turn 结束时 `flywheel-comm ack-delivered --exec-id X`,把该 exec 名下 `delivered_at IS NOT NULL AND state='LEASED'` 的行机械 ACK。逻辑依据:envelope 经 Agent Team 邮箱注入发生在 turn 边界,一个 turn 结束 ⇒ 注入内容已被 session 消费(或已 durable 落在 session mailbox 必然于下一 turn 渲染)。模型不用记得任何事。
* **A2 transport-confirm 即 ack**:`runnerAdapter.deliver()` 成功即 ACK。否决:抹掉「投了但 session 死了没消费」的重投保护,delivered≠consumed 的区分是 FLY-1773 刚建立的。
* **A3 加强提示词**:让模型更听话。否决:治标,1/4 命中率就是提示词路线的实测上限。

Codex runner 天然免疫此病(resident、唯一投递路径就是自己 poll `inbox`,pull=deliver+ack 原子),它的风险(从不 poll)由方向 D 的 dwell 告警兜底。

### 方向 B:late-ack 承认(修 lead lane `ack_late_noop`)

issue 修法①。消费者已确认的 ack 在重投窗口内仍是有效同意:

* 加 `last_batch_id` 列,lease 成批时写入、requeue **不清**;`ackBatchByRecipient` 按 `batch_id=? OR last_batch_id=?` 找行,对 QUEUED+LEASED 都应用(ACKED 幂等、DEAD 不动)。
* issue 修法②(缩短 bridge lane 应用延迟)降为次要:①做对之后延迟只影响时效不影响正确性;②本身治不了 requeue 后 `batch_id=NULL` 找不到行的问题。
* issue 修法③(消费端重投重 ack)对 runner lane 由 A1 自动获得(每个 turn 结束都 ack),对 lead lane 现状已如此(Lead 每次重投都会再 ack)。

### 方向 C:ack 护栏 + 投递证据(修静默丢弃)

* `ack()` 要求投递证据:行 `delivered_at IS NOT NULL`(或调用方即为拉取式投递方,在同一事务里先 stamp `delivered_at` + 渠道再 ack)。无证据的 ack → 拒绝 + 记审计事件,不再静默吞行。
* 所有 ack 面记 `acked_via`(cli_pull / stop_hook / ack_batch / legacy_push)— 8-19「调用方待查」这种取证以后一条 SQL 出答案。
* 新增 `first_delivered_at`,一次写入永不清;requeue 继续清 `delivered_at`(它是重投机制的载重字段,不动语义)。
* legacy hook 裸 SQL 与新契约对齐(它注入内容 = 它就是投递,UPDATE 里同时 stamp)。

### 方向 D:观测重建(优先级高于告警,issue 追加事实 #6)

* 新 `mailbox_transitions` 追加表(独立于 append-only 的 `mailbox_log`,自带保留期清理),在 lease / delivered / requeue / ack / dead / late-ack-applied / ack-refused 迁移点同事务写入,带 actor + channel + reason。
* **LEASED dwell 告警**(issue 追加事实 #4:判据用停留时长非有无):同一行 LEASED 停留 > 阈值(默认 10min)→ 给 owning Lead 一条聚合告警,episode-latch 报一次、恢复即清(FLY-1220 风暴教训);搭现有 `runnerLane.tick`/lead loop admit rider,零新 timer。

### 方向 E:安全禁令 fail-loud

发送端显式分类(`flywheel-comm send --inhibition` → 新列),该类行进 DEAD 时立即走 severe 告警(founder 可见),不进 30 分钟聚合。内容启发式分类否决(不可靠)。

## 4. 边界(本设计不做什么)

* **不动 FLY-1792 的「关系与新鲜度」重设计**(Annie 已判需先重设计):过期指令重放的毒性问题另单;本单只保证「放槽前先杀毒」的运维顺序在 runbook 里保留。
* **不复活 receipt ledger**(FLY-1645 founder 判死):`mailbox_transitions` 是窄目的迁移取证,无 settlement/handle/lineage 机器。
* **不改 in-flight cap=3、租约时长等吞吐参数**(FLY-1751 刚定过):修的是槽还不回来,不是槽不够。
* **不做 manual-ack 工具化**(issue 追加事实 #8:手工放槽禁用为常规手段)。
* Codex runner 的 ack 机械化不在 v1(无 Stop hook 基建;pull 原子性已覆盖主险,dwell 告警兜底)。

## 5. 结论

推荐组合:**A1 + B + C + D + E**,优先级 D(观测)≥ A1/B(断环)> C(护栏)> E(分类)。下一步 research 落实各触点的精确改法与回归矩阵。
