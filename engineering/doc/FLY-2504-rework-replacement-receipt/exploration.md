# FLY-2504 返工换体后替身未收返工内容即完成 — 探索

Issue: FLY-2504 (https://linear.app/geoforge3d/issue/FLY-2504/病根-返工换体后替身未收到返工内容即在同头-complete引擎照单接受-node-completed-空转一轮-qarework)
日期: 2026-09-10
基于: 无

## 1. 一句话

替身(replacement execution,引擎为已死的返工执行体铸的新执行体)launch 时,引擎把这次返工的送达记录直接标成「已送达且已收到」,但 launch 信封里只有 issue 正文、没有返工上下文;替身 76 秒后在同一个 head 上 `complete`,引擎照单接受 → QA 白跑一轮。

## 2. 生产证据(第一手,只读 `~/.flywheel/teamlead.db`)

run `b3353227-9670-4322-9ac1-182de1562dec`(FLY-2456),返工请求 `rework:5e147fa8…`。

| seq | 时间(Z) | kind | 含义 |
|---|---|---|---|
| 334–335 | 19:11:53 | claim_written(1022) / node_completed(qa_fail) | QA attempt 5 判 fail |
| 337–340 | 19:11:53 | rework_requested → rework_route_interpreted(rev 1) → edge_traversed → rework_target_reserved | 返工#6 派给停驻 Codex 体 `31f0b13d` |
| 345–346 | 19:11:53 | rework_delivery_turn_granted → rework_delivery_awaiting_receipt | 送达状态机走到「等回执」 |
| 348/350/351/352/354 | 每 3 分钟 | rework_delivery_claimed(gen 2…6) | 送达协调器反复探回执,一直没等到 |
| 353 | 19:26:51 | workflow_node_session_divergence(sessionStatus=failed) | 停驻体被判死(FLY-2352 类 reown 失败) |
| 355 | 19:26:56 | rework_delivery_replacement_pending(from awaiting_receipt) | 送达行切到「等替身」 |
| 357–359 | 19:26:56 | execution_dead_rolled_back → rework_replacement_materialized → rework_replacement | 引擎铸替身 `32e42494`,route revision 2 指向它 |
| 361–364 | 19:26:56–19:27:01 | execution_admitted(mode=replacement) → activation_turn_granted → issue_delivery_prepared → turn_granted | 替身拿到 TURN,信封在准备 |
| 365 | 19:28:01 | issue_delivery(sourceKind=authoritative) | **信封正文 = issue 正文**(`## 为什么 FLY-2352…`),没有 QA 判决、没有返工请求 id |
| 366 | 19:28:01 | resume_attachment_invalidated(envelope_changed:issue_body) | 恢复附件因信封变化被作废 |
| 367 | 19:28:01 | rework_replacement_launched | **同一事务里送达行 replacement_pending → wake_delivered**,且 sent_at / received_at 两个时钟都被打上 |
| 368 | 19:29:17 | node_completed(implement_done) | 替身 `complete --route needs_review --pr 1150`,零 diff,同头 `8bb5835c6` |
| 371–374 | 19:29:17 | edge_traversed → rework_verification_chained → completion_disposition(loop_park) | 送达行 wake_delivered → completed;派 QA attempt 6 |
| 385–386 | 19:31:57 | claim_written(1023) / node_completed(qa_fail) | QA6 在同头快速判 fail(Lead 手动指令) |
| 388–399 | 19:31:57–19:32:47 | 返工#7 走正常 wake 路:turn_granted → awaiting_receipt → **rework_delivery_wake_delivered(真回执)** | 循环恢复 |

关键对照:返工#7 的 `wake_delivered`(seq 399)是替身跑 `flywheel-comm turn` 回执后才写的;返工#6 的 `wake_delivered` 是 launch 时代写的,**没有 `rework_delivery_wake_delivered` 事件**,只有 `rework_replacement_launched`。

送达行现状:`state=completed, route_revision=2, generation=6, updated_at=19:29:17.319Z`。`workflow_rework_request.authority_context_json` 只有 448 字节的指针元数据(outcome / sourceNode / edge / baseRevision),不含 QA 判决正文——这一点在正常 wake 路也一样,runner 拿到的是「返工上下文」而非 QA 报告全文。

## 3. 病根(代码级)

四条链路各自都「合理」,拼起来就是静默空转:

1. **替身 launch 信封没有返工上下文**(`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:2335-2421, 2545-2549`)。`consume()` 对 `rework_replacement:` 意图只在 `authority === "lead"` / `"founder"` 时把 Lead 归属 / founder 反馈拼进 `contextualAgentContent`;`authority === "qa"`(本例)和 `"engine"` 只带 `requestId` + `startPoint`,agent 内容就是裸 role 文件。信封正文由 `Blueprint.ts:1647-1666` → `prepareWorkflowIssueDelivery`(`StateStore.ts:31301`)组装,只认 issue 描述。

2. **launch 标记把「已 launch」当成「已送达且已收到」**(`StateStore.ts:35428-35554` `markWorkflowReworkReplacementLaunched`)。`markStarted`(dispatcher `:2070-2122`)在 runner 已启动后调用它;它无条件把送达行 `replacement_pending → wake_delivered`(`:35484-35497`),同时投影 `sent_at` 与 `received_at`(`:35502-35517`),并把验证路径 `pending → active`(`:35518-35523`)。没有任何字段证明信封里带了返工内容。

3. **complete 接受路径不读送达状态**。从 `POST /events`(`event-route.ts:649-1355`)→ `commitEnrolledCompletion`(`StateStore.ts:52181`)→ `commitWorkflowTransitionTx`(`:55265`),没有一处读 `workflow_rework_delivery`;它唯一的返工感知是查 `workflow_rework_verification_path.state='active'`(`:55551-55561`),而 active 恰恰是第 2 条假标记翻上去的。于是 `:56452` 的 CAS(`WHERE state='wake_delivered'`)顺利通过,`rework_verification_chained` 落盘,QA attempt 6 被派。

4. **正常 wake 路的回执是真的,替身路没有回执概念**。正常路:协调器 `grantTurn` → `wakeActor`(`workflow-rework-wake-copy.ts:106-121` 渲染 `[phase-wake …] Rework context: {…}`)→ runner 跑 `flywheel-comm turn` 回执 → `recordWorkflowReworkWakeReceipt`(`StateStore.ts:34368-34516`)才写 `wake_delivered`。替身路绕开了整段:协调器对 `replacement_pending` 拒绝 claim(`:35599-35612` `delivery_settled`),dispatcher 扫描列表也刻意不含 `replacement_pending`(`:861-870`)。所以「等下一轮 claim 就会送到」并不成立——**没有任何组件会给已 launch 的替身送返工内容**。

### 第二张面孔(同类,测试审计时发现)

若 launch 标记因任何原因没打上(进程在 `start` 与 `markStarted` 之间崩溃;或走通用死体回滚 `rollbackDeadWorkflowNodeExecution` 先 launch、协调器事后 `convergeWorkflowReworkWriterReplacement` 收敛,`StateStore.ts:34652-34900`),送达行停在 `replacement_pending`、验证路径停在 `pending`。此时替身 complete,`commitWorkflowTransitionTx` 查不到 active path,**跳过全部返工记账**、当普通完成放行(`:56360/:56452` 的 CAS 根本不执行)。这一面孔今天也是静默的。

### 不在本类的旁支

- Lead 补救令在 launch 前 14 秒发出、被 `recipient_terminal` 处置:`mailbox-queue.ts:1946-1977` 对收件人无 session 行的 QUEUED 信判死;替身 id 是新 UUID,信箱不继承。issue 已判定为 Lead 侧 8 位短 id 错误,不计入本类。信箱继承是另一张单。

## 4. 候选方案

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 替身 launch 信封内联返工上下文 | dispatcher 对所有 authority 都把与 wake 同源的 `Rework context` 段拼进 agent 内容;launch 标记带「内容摘要」证据 | 修在源头,替身一启动就有内容;与正常 wake 同一份真源 | 单独做不防第二张面孔 |
| B. complete 接受前校验本 attempt 送达已回执 | `commitWorkflowTransitionTx` 对 replacement 绑定检查 `workflow_rework_delivery.state ∈ {wake_delivered, completed}`,否则 409 拒绝 + 事件 + Lead 告警 | 关死整个类:任何未消费返工的完成都过不去 | 单独做会死锁——拒绝了 complete,却没人给替身送内容 |
| C. 替身 launch 后再走一遍正常 wake(grantTurn/wakeActor/turn 回执) | 送达行不翻 wake_delivered,让协调器像对停驻体一样唤醒替身 | 回执语义完全统一 | 协调器要求 pending 送达 ↔ 节点 pending/admitted,替身节点已 running;要改 reservation 检查、admission 模式与 claim 白名单,面大;且 3 分钟探回执 vs 76 秒 complete 的竞态仍需 B |
| D. 零 diff 完成即拒绝 | 返工绑定的执行体在 base_revision 同头零 diff 完成 → 拒绝 | 直击症状 | 语义误伤:返工可以合法地「无需改动」走 blocked / needs_review 说明;且没解决内容未送达 |

**选 A + B(带 launch 标记的内容证据)**:A 让 launch 信封真的携带内容,launch 标记翻 `wake_delivered` 从「假设」变成「有摘要证据」;B 把「未消费返工的完成」从静默放行变成响亮拒绝,顺带把第二张面孔变成可见故障。C 与 D 否决,理由如上。

## 5. 不做什么

- 不改 schema、不加列、不加 flag(FLY-2278/FLY-2096 的「0 新表 0 新列 0 新旋钮」合同延续)。
- 不让替身自动重走 wake(方案 C)。第二张面孔在本单只做到「拒绝 + 事件 + Lead 告警」,自动恢复另开单。
- 不做零 diff 门(方案 D)。
- 不动信箱继承 / `recipient_terminal` 处置。
- 不改 wake 模式(非替身)的回执节奏:其回执经 patrol tick 约 60 秒才投影到 StateStore,若把 B 扩到 wake 模式会误拒「已回执但尚未投影」的完成;本单 B 只覆盖 `mode = replacement` 绑定,扩展路径写进 plan 的已知限制。
