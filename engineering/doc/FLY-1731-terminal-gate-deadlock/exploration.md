# FLY-1731 活着的 runner 被判终态·gate 永不投递 — 探索

Issue: FLY-1731 (https://linear.app/geoforge3d/issue/FLY-1731/session-被提前判-terminal活着的-runner-双向失联-ship-gate-无限重试永不投递)
日期: 2026-08-12
基于: 无(本单第一份文档;输入 = issue 正文 + Cass/Tadashi 现场取证 + 两条 lead-instruction 更正)

## 1. 问题重述(以现场 FLY-1704 为锚)

一个 land 模式(FLY-1655 语义:PR 由 engine-owned `land` 节点收尾,runner 只产 PR 不 ship)的 generalized workflow run,其 `produce` 节点 runner 跑完文档正路 `complete --route needs_review --pr 813`(exit=0)之后:

- session `d71d5740` 被投影为 `completed`(14:33:29Z,`terminal_at` 同刻,从未进过 `awaiting_review`);
- 17 秒后铸出的 `approve_to_ship` gate(mailbox seq 71271)被 admission 以 `revoked_terminal_session` 拒绝,且被标为**可重试** → 每 ~30s 空转,3 天后(2026-08-15T14:33:46Z)将**静默过期**;
- PM Lead 发给 runner 的 3 条消息(含正式回答)全部 `DEAD recipient_terminal`,发信方拿到成功;
- runner 本人仍活在 tmux `@180`,idle、工作区干净、老实等一个永远不会到的回答。

## 2. 本地代码+生产库审计结论(设计前置事实,全部一手核过)

### 2.1 session=completed 是 FLY-1655 land 语义下的**有意投影**,不是 bug

`StateStore.projectGeneralizedCompletionTx`(StateStore.ts:24944-24953):投影状态按 gate authority mode 分派 ——
`runner_ship` 且完成节点=carrier → `ship_parked`;**其余(land / engine_terminal)→ `completed`**。
land 模式下 runner 的节点就是它工作的终点(它不 ship、不 merge,land 节点接管),节点 done = session 终态,语义自洽。
生产库核实:run `4b59f9d6` = `engine_owned=1`、`gate_carrier_epoch=1`、`status=active`、`current_node_id=founder_gate`;gate holder `authority_mode=land`。

⇒ **候选修法 1(needs_review 落 awaiting_review)对 land 模式是错误方向**:`awaiting_review` 的系统语义是「runner 等 review 后自己 ship」,land 模式恰恰没有这个环节;强改投影会复活 runner-ship 环、违反 FLY-1655 不变量,还会撞 FLY-1427 terminal-immune / FLY-1328 terminal_at 一族机制。

### 2.2 真正的根因:admission 是 holder-authority 语义的**唯一掉队消费者**

gate 开门后的一切都走通了(生产库核实,gate holder 行):

| 环节 | 状态 |
|---|---|
| gate holder 铸出 | ✓ `state=awaiting_review`,`carrier_binding_state=bound` |
| CommDB question 写入 | ✓(seq 71271 存在) |
| Discord founder 卡片 | ✓ **已发出**,`card_message_id=1537106832127168552` |
| gate-message-binding | ✓(`materialization_stage=completed` 要求 card_bound 校验通过) |
| **Lead model-lane 投递(mailbox)** | ✗ **永卡** — 本案唯一断点 |

断点机制:`QuestionAdmission.eligibility()`(question-admission.ts:171-212)先调 `workflowGatePresentationDisposition` 并拿到 **`holder_authoritative`(allow)**,却在其后**继续**执行 legacy 检查 `ACTIVE_GATE_SESSION_STATUSES.has(session.status)`(:193-196)→ `completed` 不在 `{running, awaiting_review, approved_to_ship}` → 拒。

对照:founder ✅ reaction 扫描通路(gate-poller `founderReactionApprovalPass`:2768-2891)调用**同一个** `workflowGatePresentationDisposition`,拿到 `holder_authoritative` 后**没有**任何 session 活性叠加检查;写入侧 `writeGateResponseAndRunPostWrite`(write-gate-response.ts:346-352)对 engine gate 检查的是 **holder state**,不是 session status。gate-materializer 的注释更直说:"The holder itself is the durable binding; source_execution_id is only provenance and may already be physically torn down."

⇒ 系统各消费者对 engine gate 的共识早已是「holder 是 authority,session 只是 provenance」——**admission 一个人还在拿 session 活性当门票**。

### 2.3 放大器:永久性拒绝被当成瞬时错误

`question-admission.ts:100`:`retry: row.source_ref === null`。`revoked_terminal_session` 对一个 no-out-edge 终态 session(FLY-1427)是**永久性**的——重试永远不可能成功——却被标 retry → 行留 QUEUED 空转到 `expires_at` 后静默消失:无死信、无告警、无人知道。同库 61 行同类 disposition 里 60 行靠「问题后来被答掉/superseded」换了出口,只有这行没有任何人能替它给出口。

### 2.4 症状 2 的静默机制:有主 runner 的死信被明确跳过

mailbox sweep 把发给 terminal recipient 的行判 `DEAD recipient_terminal`(mailbox-queue.ts:1348/1425)。死信告警扫描 `listUncoveredLeadDeadLetters`(:1749-1754)对 runner 收件人有一条明确 continue:**能解析到 owning lead 的 runner 的 DEAD 行直接跳过**(告警只覆盖 `lead_unacked` 和 `runner_unroutable`)。d71d5740 有主(flywheel-product-lead)→ 3 条 DEAD 零通知,发信 Lead 侧 `send` 返回成功。

### 2.5 症状 3(review_question_id=NULL)对 land 模式是**预期状态**,不是缺陷

land gate 的绑定在 `workflow_gate_holder` + `gate_message_binding`,从不写 `sessions.review_question_id`(那是 runner-ship/legacy 的绑定位)。runner 跑 `verify-approval` 得到 `review_question_unbound` 字面属实——但 land 模式下 runner 根本**不该跑** verify-approval(它不 ship)。真正的缺口是:**runner 不知道自己已经收工**——`complete` 成功响应没有告诉它「run 已进入 engine-owned gate,不会有 approve/ship 环节找你」。它按 needs_review 正路提示词继续等,才有了后续 ask、等回答、回答被丢的整条症状 2 链。

### 2.6 founder ✅ 通路的诚实定性(重要边界)

代码读表明 ✅ reaction 通路对 engine gate 端到端不依赖 session 活性(枚举=CommDB pending questions;守门=holder_authoritative;写入=holder state;post-write=durable projector 推进 holder + 激活 land)。**这是代码推断,未经现场验证**——QA 必须真机重放(land gate + terminal source session + founder ✅ → land 推进)才能定案。但无论 ✅ 活不活,系统性净效果不变:**没人通知 founder 有这张卡**(Lead model-lane 断了;PM Lead 是巡检偶然看到,且已撤回指引),门实质不可达。

## 3. 四个症状 → 四个修理面(与 issue 候选修法的对映)

| # | 症状 | 根源 | 修理面 | issue 候选修法对映 |
|---|---|---|---|---|
| A | gate 永不投递 | admission 对 holder_authoritative gate 叠加 legacy session 活性检查 | admission 尊重 holder authority(第一交付,解堵现场) | 替代候选 1(候选 1 方向错误,见 2.1) |
| B | 空转+静默过期 | 永久性拒绝标记为可重试 | 永久 disposition → DEAD + 死信告警 | = 候选 2 |
| C | 活 runner 干等 | runner 不知道 land 模式下自己已收工 | complete 响应带 gate authority mode,runner 按指引收工 | 替代候选 3(不加对账 patrol,消灭不一致源头) |
| D | 死信静默 | 有主 runner 的 DEAD 行被告警扫描跳过 | 纳入死信告警,通知 owning lead | = 候选 4(告警形态,非同步失败信号) |

## 4. 明确排除的方向(带理由)

1. **needs_review → awaiting_review 投影改动**(候选 1):违反 FLY-1655 land 不变量,复活 runner-ship 语义;见 2.1。
2. **外部 DB 直写解堵**:Lead 指令排除——绕过 lifecycle_revision CAS、裸改后无人重新 admit 那行 gate、与 Bridge better-sqlite3 单写者锁竞争。
3. **扩大 ACTIVE_GATE_SESSION_STATUSES 集合**(加 completed / ship_parked):把错误门票发得更宽,legacy 真终态 gate 会被错误放行;正确边界是 authority 归属,不是状态集合大小。
4. **补发/重铸第二道门**:issue 明确警告过;行还在每 30s 敲门,gate holder/卡片/绑定全部健在,修 admission 即可,重铸反而制造双门歧义。
5. **加终态-存活对账 patrol**(候选 3 原形):逆 FLY-1570(刚拆掉一族追人型 watchdog)方向,违反「修结构别加报警器」;Fix A+C 消灭不一致的制造源头后,对账没有剩余职责。

## 5. 解堵现场的时间约束

Fix A 部署后,seq 71271 的下一次 30s 重试自然通过 admission → materialize → 投递 PM Lead,**零手工手术**。硬 deadline:该行 `expires_at = 2026-08-15T14:33:46Z`,过期即静默消失,修复须在此之前上线。

## 6. 开放问题(带到 research/plan)

1. permanence 分类的完整清单:哪些 disposition 是永久、哪些瞬时(`revoked_qa_hold` 瞬时、`before_gate` 瞬时、`activation_ambiguous`?)。
2. Fix D 的告警形态:新 sourceKind 还是复用;聚合窗口沿用 FLY-1573 的 30 分钟。
3. Fix C 的响应字段:Bridge event-route 对 generalized completion 的 res.json 加什么字段,complete.ts 如何字节兼容旧 Bridge。
4. founder ✅ 通路真机验证的 QA 剧本(隔离房,不碰现场)。
