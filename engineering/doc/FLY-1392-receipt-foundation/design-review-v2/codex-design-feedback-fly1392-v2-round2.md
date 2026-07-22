# Design Review — FLY-1392 design-v2.md (Round 2)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2.1 实质采纳了 Round 1 的大部分方向性反馈：T1–T7 把去类型化扩大到完整追办链路；Founder 双行、授权 settle、跨部门独立 poll、activation bootstrap、handle 授权/批量结果、因果 settle 与容量门都得到了正面修正。这不是对旧方案的换皮，整体架构已明显接近可实现状态。

但仍有阻断项。最直接的一项是 `telemetry` 仍作为消息类别被豁免，而 capture-facts §4 明确该类行会 delivered 给 Lead，Founder 裁决又明确“不管谁发、什么 category，每条传到 Lead 的 message 都要有收据并处理”；显式留痕不能把一个被禁止的类别例外变成合法例外。此外，跨部门 canonical row 同时被定义成 LeadInboxLoop 投递行和现有 Discord transport 的旁路账，按真实代码会重复投递；新增 `disposed` 没有持久字段和互斥 CAS；一次性 activation marker 也无法实现多次 flag off/on cohort。以下问题需要在设计中闭合后再进入实现。

## What's Good (Keep)

- §2.3 T1–T7 正确枚举了 Round 1 发现的所有类型条件触点，并把 escalation 收敛为单一 generic kind；unknown-type 验收升级到真实 enqueue→resend→visible T3，应该保留。
- §2.2b 撤回放宽 `from_agent = to_lead`，改成 authorized-actor relation，并把“别人答掉”与“Lead 办了”拆成 disposed/processed；语义方向正确。
- §2.2a 已覆盖身份、lease/generation、动作前置状态、事务边界、审计和 batch itemized result，比 v2.0 的 generic helper 可实施得多。
- §2.1 明确认出现有 Founder 生产路径双写与旧 18/18 harness 的盲点，并要求真实 RuntimeRegistry E2E；这个验收标准应保留。
- §2.4 放弃第二套 REST poll，选择复用真实 transport acceptance boundary，消除了 predicate 漂移和轮询成本的主要风险。
- §2.4b 禁止“同频道+时间接近”settle，改用 explicit reply 或 durable causal journal，并补齐主要竞态测试；这是正确的 fail-closed 边界。
- §4 的 activation-at 窗口、先 settle/dispose 后回填、dry-run 容量门，以及 §2.6 的 append-only audit 都是必要的上线保护。

## Issues & Recommendations

1. **`telemetry` 豁免仍是 Founder 明令禁止的 category-specific coverage 例外。**

   **Issue:** v2.1 §2.4 仍写“纯遥测入账永不追 → 显式豁免”，§2.6 将 `telemetry` 放进 reason enum，验收 5 还要求 telemetry 永不入 selector（`design-v2.md:98-99,125-128,173`）。但事实清单明确 `progress` 是 delivered 给 Lead 的账本消息（`capture-facts.md:79-80`），binding ruling 则是每条传到 Lead 的 message 都要处理、有 receipt，不得按 category 有无。审计只能让例外可见，不能使该类别例外符合裁决。§2.6 同时又说“任何真实业务消息不得按类别豁免”，正文自相矛盾。

   **Why it matters:** 这是 constraint fidelity，不是运营偏好。保留 `telemetry` reason 会为未来任何不想催的类别提供同构先例，也会让 unknown-type mutation test 与真实默认规则不一致。

   **Suggested fix:** 删除 `telemetry` exemption、lane 表中的“永不追”和对应验收；只要 `progress` 实际展示给 Lead，就按 priority window 追到 Lead ack。若某条所谓 telemetry 只是未展示给 Lead 的内部观测/审计副本，它就不是 Founder 裁决中的 message，应按 `internal_mirror` 且必须 link 到 canonical row，而不是按 telemetry category 豁免。审计表同时补稳定 event id、operation/new value，使撤销也可无歧义重放；但合法 exemption 不应包含任何真实 Lead delivery。

2. **跨部门行的 delivery identity 自相矛盾，且跨 `journal.db`/`comm.db` 的 durable-accept 顺序没有闭合。**

   **Issue:** §2.1 的全局不变式要求 canonical row “同时就是 `msg_class=model`、经 LeadInboxLoop 投递的投递行”（`design-v2.md:41`）；§2.4/§5/§6 又要求跨部门消息仍由现有 Discord transport 投递，只在 accept 边界旁路记账（`:103-110,155,162`）。真实 LeadInboxLoop 会 claim 所有未 consumed 的 model row 并再次交给 model adapter（`lead-inbox-loop.ts:223-256`），所以旁路行若保持未消费会重复投递；若预先标 delivered/consumed，则它并不是 §2.1 所说的 LeadInboxLoop 投递行。Codex path 还有两个 SQLite authority：`LeadInputRouter.submit` 先写 `journal.db`，accepted 后立即启动 pump（`LeadInputRouter.ts:186-197`），receipt 在 `comm.db`，不存在天然单事务。

   **Why it matters:** 当前文字无法指导实现选择：一种实现会把同一 @Lead 消息送两遍，另一种会在 Lead turn 已启动后仍无 receipt，第三种则可能产生永不投递却开始追办的孤儿账。它也使“acceptance set identical by construction”无法被严格证明。

   **Suggested fix:** 将 universal invariant 改成“每条实际 Lead delivery 恰一 canonical receipt”，并明确 delivery owner：LeadInbox lanes 的 row 同时承运；Discord/Codex lanes 的 row 是 external-transport receipt，绝不再被 LeadInboxLoop claim。给 external lane 明确状态/字段，而不是借用未 consumed model row。定义可恢复的两库 saga：filters 通过后先幂等写 receipt 为 `delivery_pending`；journal accept/duplicate 成功后再把 receipt 标 delivered、初始化窗口；任一步失败 gateway 返回 false、不推进 cursor，retry 可完成缺失步骤；未 delivered 的 orphan 永不进 chase。由于 `router.submit` 会立即 pump，不能把 receipt insert 放在它成功返回之后。验收需覆盖两处 crash seam，并断言 Lead 只收到一次。

3. **Founder “单行复用”尚缺唯一 producer/内容合同；照现有 API 仅传 canonical id 会碰撞失败。**

   **Issue:** 当前 `enqueueFounderHubRoot` 写的是 `msg_class=protocol`、raw JSON content、`source/type=founder_reply`、已 consumed 的 hub row（`lead-inbox-queue.ts:388-438`）；真实 `enqueueLeadEvent` 强制派生 `lead_event:<lead>:<eventId>` id，写 `msg_class=model`、rendered HookPayload content 和 `source=lead_event:<seq>`（`lead-event-queue.ts:10-67`）。`LeadInboxQueue.enqueue` 遇到相同 id 但任一字段不同会抛错（`lead-inbox-queue.ts:339-379`）。因此 §2.1 所说“makeAmbiguousHandoff 携带 canonical id、复用行”还不是可执行合同。

   **Why it matters:** 若 hub writer 先写，dispatch 不能以现有 enqueue 复用；若 dispatch 另写，双行病仍在。错误处理还决定 Founder cursor 何时可推进，以及 `routeFounderReply` 读取的 content/ref 是否仍是受验证的原文和 scope。

   **Suggested fix:** 指定唯一 writer 与完整 row shape。建议由 Founder handoff 构造一次 canonical model payload，并通过支持 caller-supplied `deliveryId=founder_msg:<lead>:<msg>` 的 queue API 原子入队；`enqueueFounderHubRoot` 退化为该 API 的兼容 wrapper或删除其独立 insert。StateStore `appendLeadEvent` 如保留，只是 audit，不得再物化第二个 `lead_inbox` receipt。只有 queue 返回该 canonical row 的 durable receipt 后 Founder cursor 才能推进；`routeFounderReply` wrapper 必须从同一 row 校验原始 msgId/project/issue/thread。把“先写 row 后 crash / row 已在但 StateStore marker 未落 / retry”加入真实 RuntimeRegistry E2E。

4. **`disposed` 只有概念，没有持久 schema、证据或与 processed 的终态互斥 CAS。**

   **Issue:** v2.1 新增 disposed 并要求 selector、activation、handle、revalidation 都识别它，但没有规定它存在哪个字段、谁写、证据形状或冲突结果。现表只有 `processed_at/evidence`；`disposition` 已被用作 transport/delivery 结果（delivered、quarantined、dead_letter、routed_question 等），不适合作为独立 receipt terminal state。当前 `markProcessed` 仅以 processed 两列 CAS（`lead-inbox-queue.ts:447-479`），不会拒绝一个另处已“disposed”的 row。

   **Why it matters:** dispose-vs-handle、dispose-vs-auto-settle 或 dispose-vs-T3 可以形成既 disposed 又 processed、已停催但 outbox 未取消，或重启后 disposal 事实丢失。R1 的授权修复只有在 disposed 是 durable authority 时才成立。

   **Suggested fix:** 明确 schema（例如 `disposed_at` + `disposed_evidence`，或单一 receipt terminal state + evidence），并定义 DB 级不变式 `processed XOR disposed`。`markProcessed` 必须 CAS `disposed_at IS NULL`，`markDisposed` 必须 CAS `processed_at IS NULL`；同证据重试幂等，异证据/异终态返回 conflict。两者都调用统一 family closure，清 `next_unprocessed_at`、使 resend 失效并取消/重验 outbox。定义 authorized disposal predicate 和证据来源，补 dispose-vs-handle、dispose-vs-settle、dispose-vs-resend/outbox 的竞态测试；不要仅依赖 `messages.relay_state` 的实时 join。

5. **一次性 `receipt_activation:v2` marker 不能实现重复 flag off/on，bootstrap cohort 也遗漏 delivered 条件。**

   **Issue:** §4 将 v2 描述为一次性 marker 形态，却又要求每次 re-enable 把关闭期 cohort 以 re-enable 时刻重新锚定。一个固定 `receipt_activation:v2` id 无法区分第二、第三次关闭 episode，也无法在重启时判断本次 re-enable 是否已回填。并且回填谓词只写“未 processed/disposed 且非豁免”，没有 `delivered_at IS NOT NULL`；排队未投递的 model row可能在 Lead 看见前就开始倒计时。关闭前已经 pending、其 deadline 在关闭期过期的行也未说明是否随 re-enable 一起 re-anchor。当前 flag-off Founder 路径还会回到 Bridge 旧处理分支（`founder-reply-deliverer.ts:581` 以下），与 v2 所称“只停 chase、事实照记”不同。

   **Why it matters:** 结果可能是 re-enable 告警风暴、关闭期消息永久无窗、或尚未投递的消息被重发/升级；更严重的是逃生阀可能恢复被 Founder 禁止的 Bridge 代处理拓扑。

   **Suggested fix:** 用持久 activation episode/epoch（disabled_at、enabled_at、activation_at、status、dry-run/commit counts、high-water mark）而不是单个永恒 marker。每次 enable 的幂等 cohort 应包含所有已 delivered、未 processed/disposed、非豁免的 pending rows，包括 flag-off 前已 pending 的行，并只在该 episode 首次 commit 时重锚到 enabled_at + priorityWindow；未 delivered 行由正常 delivery transaction 初始化。明确 flag-off 永远保持 Bridge pure conveyor，只暂停 deadline advance/resend/escalation，不能回到 legacy response writer。为连续两次 off/on、off 期间旧 deadline 到期、启动中断和重复启动加测试。

6. **priority contract 在 v2.1 中反而不完整，且现有 type→priority 推导仍会让 type 不只是 metadata。**

   **Issue:** v2.0 明确 P0/P1=30min、P2=240min；v2.1 删除了这组映射，只新增 P3=24h，因此 activation、consume 和后续 resend 无法从本文这一 authority 得到 P0–P2 的确定窗口。T1 同时说 priority 必填，T7 又说 unknown 默认 P2。真实 `priorityForLeadEvent(eventType)` 仍用 founder/gate/report 等 type 字符串决定 P0/P1/P2，unknown 才是 P3（`lead-event-queue.ts:17-43`）；设计没有说明如何让“type 仅 metadata”与该函数退役。

   **Why it matters:** 不同实现者会产生不同 deadline；若保留现 helper，业务 type 仍间接决定窗口，新增类型的行为仍依赖字符串命名。跨部门、报告和 generic unknown 的 priority 也无法从统一 ingress contract 推导。

   **Suggested fix:** 恢复完整 P0–P3 window 表及每轮 resend 是否沿用同窗、对应 env/config key与验证范围。给 `LeadEventEnvelope`/统一 enqueue contract 增加显式 receipt priority（缺省 P2），由 producer 基于业务紧急度显式传入；generic ingress 不解析 `event_type`。列出现有 producer 的迁移 mapping，但 coverage、selector 和默认值不读取 type。为 mixed-priority batch、缺省 P2、显式 P3 和非法 priority 加测试。

7. **`(receipt id, action)` 不是足够的幂等键，会吞掉 relay/respond 的不同 payload。**

   **Issue:** 同一个 receipt 可能先后收到 `relay(q1)` 与 `relay(q2)`，或 `respond(text A)` 与 `respond(text B)`；按 §2.2a 的 `(id, action)`，两者键相同。当前 `routeFounderReply` 会根据 target question/evidence basis 区分相同重试和冲突动作，v2 的键若不包含 request/payload identity，就无法做到“原约束一条不丢”。

   **Why it matters:** 网络重试与操作者改正参数无法区分；系统可能把不同请求当成成功 no-op，向调用方返回第一个结果却隐藏第二个冲突，甚至 relay 到错误 runner。

   **Suggested fix:** 使用 caller request id 并持久化 canonical payload digest/result：同 request id + 同 digest 返回原结果；同 request id + 不同 digest 返回 `idempotency_conflict`；不同 request 在 row 已终态时返回 `already_processed/disposed`。至少将 action-specific target/content digest 纳入冲突校验。batch ack 每项也需独立 request id/result，重试只能重放失败/未知项。

8. **默认翻转仍发生在完整能力级 harness 之前，实施顺序没有真正做到“flip last”。**

   **Issue:** §4/§8 把 S3 定义为 activation + dry-run + 默认翻转，S4 才扩四 lane harness、真实 RuntimeRegistry Founder 路径和跨部门真机腿（`design-v2.md:149,179-181`）。因此文档要求用来证明单行、unknown T3、跨部门 fail-closed 和 no-Bridge-processing 的关键验收，在默认值已经翻转后才运行。

   **Why it matters:** 若切片可独立落地/部署，S3 会把尚未通过能力级测试的机制暴露给真实 Lead；这与 foundation-first 和 dry-run gate 的目的相反。

   **Suggested fix:** 每个切片随代码带对应单元/竞态测试；S3 只落 activation machinery 并允许显式 opt-in 的 staging/真机验证，S4 完成四 lane harness、两库 crash fault injection、真实 Founder single-row 和容量 dry-run。新增最后的 S5 仅做默认翻转与 post-flip smoke/rollback drill。若这些切片必定同一原子 PR，正文也应明确“任何默认翻转提交不得在全部 S4 gate 通过前部署”。

## Verdict

CHANGES REQUESTED
