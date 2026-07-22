# Design Review — FLY-1392 design-v2.md (Round 1)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 的方向已经与 Founder 裁决对齐：Bridge 是纯传送带、外部只暴露“Lead 是否处理”、未知消息类型默认进入同一 receipt 机制、auto-settle 只是减负优化而不是覆盖前提。这些原则应保留。

但当前设计还不能进入实现。阻断点不是重新讨论产品方向，而是 v2 尚未把这些原则落成一个端到端、可迁移、可证明的系统契约：现有代码在 selector 之外仍有多处按类型白名单；Founder 的真实生产路径会为同一消息生成两条 `lead_inbox` 记录；放宽 `deriveProcessedReceipts` 的 sender 限制会移除当前唯一的收件 Lead 身份约束；跨部门 tracker 的 cutover、因果 settle、游标所有权和限流模型也未闭合。若按当前 S1→S5 顺序实现，可能先制造重复催办、历史告警风暴或错误 settle，再补处理工具。

## What's Good (Keep)

- 明确废除旧版 per-type coverage/defaults/windows；不应再引入按 `type` 决定是否记账的机制。
- 将 `deriveProcessedReceipts` 定位为可选 auto-settle，并明确即便 matcher 漏掉，新类型仍由显式 handle 路径兜底。这个 recast 是正确的。
- 保留并复用现有 hub-root、unprocessed 轴、T1/T2/T3、durable outbox、wake ledger、严重降级告警和 feature flag，而不是另造一套 receipt 状态机。
- 跨部门方案坚持 track-not-transport；Bridge 不读取、回答或代替 Lead 处理业务消息。
- exemption 被描述成显式、可审计的例外，并禁止普通运行时路径静默设置；这符合 default-to-covered 的边界思路。
- 验收提出 unknown-type mutation test、真实跨部门入口和 escape-valve 验证，方向上具备可测试性。

## Issues & Recommendations

1. **“默认覆盖”目前只在目标 selector 上成立，真实端到端路径仍由消息类型白名单控制。**

   **Issue:** 当前 `markConsumed` 只为固定 question/founder 类型初始化 follow-up（`packages/flywheel-comm/src/lead-inbox-queue.ts:795-839,860-870`）；bootstrap、due advance 和 alert revalidation 也各自重复固定类型集合（`packages/flywheel-comm/src/db.ts:3294-3315,3354-3375,3923-3944`）。Team Lead patrol 的事件识别和告警发送只接受四个精确 `receipt_unprocessed:<type>` kind（`packages/teamlead/src/bridge/plugin.ts:6871-6878,7284-7297`）。此外未知 Lead event 当前默认 priority 3（`packages/teamlead/src/bridge/lead-event-queue.ts:17-43`），而 v2 只定义 P0/P1/P2 window。

   **Why it matters:** 仅移除 due selector 的 `type IN (...)` 不会让新类型得到 deadline、重发、outbox escalation 或 alert revalidation；mutation test 很可能只证明“写入了一行”，而不是“永不漏掉”。P3 会出现没有窗口或不一致 fallback。这直接违反 brand-new type 零代码变更覆盖。

   **Suggested fix:** 在设计中列出并统一所有 eligibility/read/write 点：enqueue、consume/deadline 初始化、bootstrap、due advance、revalidation、outbox kind、patrol dispatch 和告警 payload。它们只能依据 receipt 状态、priority 和显式 exemption，不得依据业务 `type`。使用固定的通用 escalation kind（业务 type 仅作 metadata），为包括 P3 在内的全部合法 priority 定义窗口或规范化规则，并在 ingress 时写入通用、可告警的 project/issue/thread context，避免未知类型退化成 `unknown`。unknown-type 验收必须从真实 `enqueueLeadEvent` 走到 visible T3 escalation，而非只查 selector/ledger。

2. **“一条发给 Lead 的消息只有一条 canonical ledger row”与当前 Founder 生产路径不符，现有 18/18 harness 没有覆盖这个事实。**

   **Issue:** flag 开启时，`founder-reply-deliverer.ts:581-629` 先写 hub-root，再调用 `deliverAmbiguousToLead`。真实 `makeAmbiguousHandoff` 会 dispatch 一个 `founder_reply` Lead event（`gate-poller.ts:4054-4129`）；生产 RuntimeRegistry 已配置 queue enqueuer，因此它又写入一条 `lead_event:*` 的 `lead_inbox` row。前者是 receipt root，后者是实际模型投递行；两者 type 都可进入现有 follow-up，而 `routeFounderReply` 只 settle root。18/18 harness 把 `deliverAmbiguousToLead` stub 成 `true`，没有走生产 queue 路径，所以无法证明 one-message-one-row。

   **Why it matters:** 翻转默认后，同一 Founder 消息可能被重复催办；Lead 看到并处理的是 transport row，却可能只 settle 另一条 root，或相反。设计 §2.1 的单表单查询并未解决双写 identity。

   **Suggested fix:** 明确定义 canonical receipt identity 与 transport delivery identity。优先让 delivery 复用同一 canonical row；若架构上必须保留 mirror，则增加稳定 link，并且只有在 canonical row 已存在且唯一时，才将纯内部 mirror 以专门、可审计 reason 排除，绝不能按 `founder_reply` 类别豁免。补一个使用真实 RuntimeRegistry/queue enqueuer 的 Founder E2E：断言一条外部消息只产生一个需要 follow-up 的 receipt、处理后没有 sibling overdue row。现有 18/18 不能作为该断言的证据。

3. **默认值翻转缺少版本化 migration/bootstrap、flag 关闭期和重新开启的契约，S1 顺序会产生漏覆盖或告警风暴。**

   **Issue:** 现有 bootstrap 使用一次性 `receipt_activation:v1` marker（`db.ts:3267-3282`），且只初始化旧类型集合。v2 没说明新增 eligible cohort 如何处理：若只给未来 consume 初始化，历史未覆盖行会永久保持 `next_unprocessed_at = NULL`；若按旧 `delivered_at` 回填，存量 P2/未知类型可能立即集中逾期。flag 关闭期间写入/投递的行以及重新开启后的 catch-up 也未定义。当前 S1 先翻默认、S2 才提供 generic/batch handle，会先扩大 ack 和 alert 负担。

   **Why it matters:** migration 不是实现细节，而是 default-to-covered 是否在 cutover 时成立的核心。一次错误回填可能造成 T1/T2/T3 storm、outbox 堆积和 Lead 收件箱拥塞；不回填则静默漏消息。escape valve 若无法安全 re-enable，就不是真正可用的回退机制。

   **Suggested fix:** 写出 `receipt_activation:v2`（或等价 cohort migration）的幂等算法：在同一受控 cutover 中先跑安全 auto-settle/已处理证据归并，再对仍未处理且未豁免的存量行以 `activation_at + priority_window` 初始化，`resend_round=0`，而不是用历史 delivery time；记录 migration 版本、计数和 exemption audit。明确 flag-off 时哪些 ledger 事实仍记录、重新开启如何纳入关闭期 cohort、重复启动如何无副作用。先以 flag-off/dormant 方式落 schema + 通用全链路 + generic/batch handle，再执行版本化 activation/default flip；不要按当前 S1→S2 顺序先翻默认。

4. **放宽 `deriveProcessedReceipts` 的 `from_agent = to_lead` 约束不安全；“任何 response 都能证明 Lead 处理”混淆了业务终止与 Lead 身份证据。**

   **Issue:** 当前 matcher 明确要求 responder 是目标 Lead（`db.ts:3206`）。底层 `insertResponse` 接受调用方给定的 `fromAgent`，自身并不把它绑定到 question 的 `to_agent`（`db.ts:1294-1362`）。删除该条件后，其他 Lead、Bridge/legacy actor、错误 route 或缺失 generation fencing 的 response 都可能把收件 Lead 的 receipt 标成 processed。Founder path 的显式 `routeFounderReply` 不能证明任意 question response 都具备同样 authority。

   **Why it matters:** ledger 的外部语义是“目标 Lead 已处理”，不是“系统中有人写过相关 response”。错误 auto-settle 会静默停止 resend/escalation，比多一次提醒更危险，也违反 Bridge 纯传送带与 Lead authority boundary。

   **Suggested fix:** 保留并泛化“授权处理者”关系，而不是删除身份约束：从 canonical receipt 的 `to_lead`、相关 question 的 recipient、有效 lease/generation 和明确 route provenance 推导 authorized actor。只有有权代表该目标 Lead 的证据才能设置 `processed_at`；其他 response 至多可令业务对象进入 terminal/disposed 状态，不能伪造“Lead handled”。为 other-lead、Bridge/legacy actor、stale generation、duplicate response 和合法目标 Lead 分别增加负向/正向测试。

5. **`handleReceipt(id, action, ...)` 与 batch ack 还不是可实现的授权、状态和事务契约。**

   **Issue:** 设计列出 `relay/respond/no-route/ack`，但没有规定调用者如何证明自己就是 row 的 `to_lead`，action 与 underlying source 的兼容性、pending/ref 校验、回复写入与 receipt settle 的原子性、wake 写入、重复调用/冲突调用语义，以及 batch 中部分失败如何处理。`routeFounderReply` 现有逻辑含 root/source/type/ref、pending question、no-route、response/processed/wake 等强约束，不能被简单重命名为一个宽松 generic helper。

   **Why it matters:** 这是唯一承诺覆盖全部未知类型的兜底路径。若 ID 不可见、权限不闭合或事务不原子，Lead 会无法 ack、ack 错 row，或产生“回复成功但 receipt 未 settle / receipt settled 但回复未写入”的 crash window；batch ack 还可能掩盖部分失败。

   **Suggested fix:** 在设计中给出状态机和函数契约：稳定 receipt ID 如何随投递展示给 Lead；`authenticatedLead === to_lead` 与 generation/lease 校验；每个 action 所需参数和允许的 source state；response + processed + wake 的单事务边界；ack/no-route 的审计字段；幂等 key；已处理、已取消和冲突 action 的确定返回值。batch ack 应逐 ID 授权并定义原子或可重试的逐项结果。可以让旧 `routeFounderReply` 成为经过验证的兼容 wrapper，但不能丢掉它的约束。

6. **跨部门 REST-poll ingestion 的 coverage set、cutover watermark、cursor ownership 和成本模型未闭合。**

   **Issue:** 当前真实 transport 接受集合不只是“configured channel + mention gate”：还包含动态 roundtable topic thread 发现、static/dynamic channel eligibility、echo immunity、reply-to-self、mention/reply/autoContinue/budget 等规则（`RestPollDiscordInboundSource.ts:267-315`、`CodexDiscordGateway.ts:171-230`、`mention-gate.ts` 及 headless/TUI runtime wiring）。现有 REST source 初次成功 poll 才把 latest message 设为 baseline；如果首次 baseline 请求失败，故障期间到达的消息会在后续成功 baseline 时被跳过（`RestPollDiscordInboundSource.ts:128-185`）。设计也没有说明 tracker 是否与 transport 共用 cursor、一个还是每 Lead 一组 poller、Discord 429/backoff/jitter 和动态 thread 生命周期。

   **Why it matters:** tracker 与 transport acceptance set 漂移会出现“Lead 收到了但没记账”或记录了 Lead 不会收到的消息；共享 transport cursor 会互相吞消息，独立 per-Lead×channel 3 秒 poll 又会放大请求量。first-success baseline race 直接违反 activation 后 never miss。

   **Suggested fix:** 把“durable transport acceptance”定义成共享、可测试的 predicate/registry，或在 transport durable-accept boundary 旁路写 canonical receipt；若必须独立 poll，必须复用完全相同的 channel/thread discovery 和 mention semantics，并拥有独立命名空间 cursor。activation 时先持久化独立于 fetch 成功的 cutover watermark（例如由 activation time 推导 Discord snowflake，或明确 bounded backfill），再启动 poll；规定 insert 成功后才 advance cursor、崩溃重放依靠 `xdept:<discord_message_id>` 幂等。补充共享 poll/fan-out 或有界 per-Lead 模型、token owner、429 指数退避+jitter、健康告警和动态 thread 收敛策略，并以 fault-injection 测试 baseline 失败与重启。

7. **跨部门 auto-settle 缺少可靠因果关联，且 settle/handle/resend/outbox 的竞态没有定义。**

   **Issue:** “Lead posted a reply in the source channel/thread”不足以证明回复对应某一 inbound message：同一 channel 可同时有多条 pending root，普通发言会误 settle 多条；roundtable 的实际回复还可能被投递到另一个 topic thread。设计也未定义 reply 先于 tracker 入账、explicit handle 与 auto-settle 并发、patrol 已领取 resend 后发生 settle、T3 outbox 已入队后 settle 的结果。

   **Why it matters:** 错误相关会静默停止真正未处理消息的 follow-up；竞态则会在已经处理后继续重发或发送严重告警。两者都会破坏 receipt 的可信度。

   **Suggested fix:** auto-settle 只接受可证明的一对一因果证据：Discord explicit reply reference，或 durable journal 中的 inbound message → Lead turn → outbound message 映射；仅“同 channel/thread + 时间接近”不得 settle，无法证明时继续依赖显式 handle。为 reply-before-ingest 保存可重放 outbound evidence。统一使用现有 processed-family closure/CAS 语义：handle 和 matcher 对同一 row 幂等竞争；settle 必须使尚未发送的 resend/outbox 失效；发送者在实际发送前再次 revalidate。加入多 pending roots、跨 thread reply、settle-vs-T1/T2、settle-vs-T3 和 crash/restart 测试。

8. **exemption 的“可追踪”与 Lead 负载/告警风险还缺少持久化和运营验收。**

   **Issue:** 单一 nullable `followup_exempt_reason` 只能看到当前字符串，不能证明谁、何时、通过哪次 migration/admin action 设置或撤销；“internal telemetry-only”也没有被严格定义成“不属于发给 Lead 的消息”。同时 v2 没有量化默认翻转后的 pending 数、P2/P3 ack 量、T1/T2/T3/outbox 峰值，也没有说明批量提醒如何避免逐行刷屏而仍保留逐行 ledger。

   **Why it matters:** 无审计生命周期的 exemption 会演化成新的隐式按类别绕过；缺少容量门槛会把正确性改造变成 Lead UX 和告警系统事故。

   **Suggested fix:** 增加 append-only exemption audit（receipt id、reason code、actor、timestamp、change source、前后值），reason 使用小型稳定枚举/注册表；仅不代表真实投递的内部 mirror/telemetry 可以豁免，任何实际送达 Lead 的业务消息不得按 category 豁免。上线前输出 v2 bootstrap dry-run 计数（eligible/auto-settled/exempt/pending，按 priority 而非 type 控制行为）、预计 T1/T2/T3 速率和 outbox 峰值；提醒可按 Lead/priority 聚合展示并提供稳定 ID 的 batch ack，但 ledger/settle 仍逐 row。为 resend/escalation 设有界发送与去重，并验证 flag-off 严重告警和安全 re-enable。

## Verdict

CHANGES REQUESTED
