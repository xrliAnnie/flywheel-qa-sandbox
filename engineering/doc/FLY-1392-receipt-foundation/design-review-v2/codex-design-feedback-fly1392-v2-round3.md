# Design Review — FLY-1392 design-v2.md (Round 3)

Date: 2026-07-21
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2.2 已实质关闭 Round 2 的八个原始问题：真实 telemetry delivery 不再豁免；inbox/external carrier 分离；Founder 单行有唯一 writer；disposed 被持久化；activation 改成多 episode；priority 不再从 type 字符串推断；handle 幂等绑定 request/digest；默认翻转被移到完整 harness 之后。Founder 五条裁决现在都能在正文找到正向、可测的落点，整体设计已经接近可实现。

本轮仍发现四个存储/切换级缺口。最重要的是：`processed XOR disposed` 按字面会禁止合法的 pending 行；flag off/on 只重锚 root，却没有围住已经排队的 resend child 和 pending outbox，它们会绕过 re-enable 宽限窗；`delivery_pending` 也不能未经 `journal.db` 反查就做 TTL cleanup，因为它可能已对应一个真实启动的 Lead turn。最后，external carrier 只修改“claim predicate”仍不足以覆盖当前 `countPending`、通用 claim 和 consume bookkeeping。它们都可以局部修正，不需要推翻 v2.2 架构。

## What's Good (Keep)

- telemetry/progress 只要真实展示给 Lead 就进入 P3=24h + batch ack；豁免仅保留给 linked `internal_mirror`。这次真正满足了 category-agnostic 裁决。
- Founder path 的唯一 writer、caller-supplied canonical id、旧 hub writer 退役及真实 RuntimeRegistry crash/retry E2E，已把双行问题改成可执行方案。
- external transport 使用 `delivery_pending → journal accept/duplicate → delivered` 的 fail-closed saga，且明确 `router.submit` 会立即 pump，因此 receipt 必须先写；顺序判断正确。
- disposed 不再复用 transport `disposition`，并与 processed 共用 family closure；authorized disposal 与 Lead-handled 语义已经分开。
- P0–P3 窗口、producer-supplied priority、unknown=P2 和 `priorityForLeadEvent` 退役，关闭了 type 通过 priority 间接控制行为的缺口。
- activation episode 支持多次 off/on，并将 Bridge pure-conveyor 提升为不受 flag 影响的宪法级不变式。
- S1–S5 已做到 capability harness 先于默认翻转，且每片包含相应测试。

## Issues & Recommendations

1. **终态 DB 不变式应是“至多一个”，不是 `processed XOR disposed`。**

   **Issue:** §2.2c 明写 DB 级不变式 `processed XOR disposed`（`design-v2.md:83`），验收 4 也沿用该表述。严格 XOR 要求恰好一边为真，但一条刚入账、尚未处理也未废止的合法 pending receipt 两边都为空；若实现成 SQLite CHECK，所有正常新行都会失败。设计还没有把 timestamp 与 evidence 的成对空值关系写进约束。

   **Why it matters:** 这是 schema authority，不是措辞 nit。实现者可能照字面创建错误 CHECK，或只靠应用 CAS 而留下 `processed_at` 有值但 evidence 为空、disposed 两列半写等不可审计状态。

   **Suggested fix:** 改成 terminal **mutual exclusion / at-most-one**：pending 允许两者都空，禁止两者同时非空；同时约束 `(processed_at IS NULL) = (processed_evidence IS NULL)`、`(disposed_at IS NULL) = (disposed_evidence IS NULL)`。明确 SQLite 落地方式（建表 CHECK/重建迁移或等价 trigger + CAS），migration 先验证旧数据。验收覆盖 pending、processed-only、disposed-only 三个合法状态及 both/half-written 非法状态。

2. **flag episode 没有处理已经物化的 resend/outbox effect，re-enable 宽限窗可被绕过。**

   **Issue:** §4 只把 root 的 `next_unprocessed_at` 重锚到 `enabled_at + priorityWindow`（`design-v2.md:172-176`）。但当前 advance 会先插入可被 LeadInboxLoop claim 的 resend child；flag=0 时 LeadInboxLoop 仍运行，现有 claim SQL不因 receipt flag 排除这些 child。T3 outbox 也可能在 flag 关闭前已写入但尚未 drain；patrol 关闭期间不发送，re-enable 后当前 `revalidateReceiptAlert` 只查 root 尚未 processed/escalated，不检查新 deadline，因此会立即发送旧告警。若简单 cancel，固定 `unprocessed:<rootId>` 唯一 id 又会让后续到期的 `INSERT OR IGNORE` 永远无法重新建 alert。

   **Why it matters:** escape valve 声称“暂停 chase”，但已排队提醒仍可能在关闭期投递；re-enable 也可能在承诺的新完整窗口之前立刻严重升级。相反，错误 cancel 会永久吞掉以后应有的 T3。

   **Suggested fix:** 把 activation episode/generation 绑定到所有 chase artifacts。flag-off 必须阻止未投递 resend child 被 claim/发送；episode commit 应 supersede 旧 episode 的未投递 resend，并对 pending outbox 采取可重放的 suspend/rearm，而不是不可逆地撞死固定 id。sender 在实际 effect 前重验 root terminal state、当前 episode 和 `next_unprocessed_at <= now`。可给 resend/outbox 加 episode generation 并把 generation 纳入幂等 id，或保留同一 outbox但持久化 `not_before` 并安全 rearm。新增两条关键测试：flag-off 发生在 r1 已入队但未投递；flag-off 发生在 T3 已入 outbox但未 drain。两者在 off 期间零 effect，re-enable 后完整新窗结束才恰一次继续。

3. **`delivery_pending` 的 TTL cleanup 不能在未知 journal 状态下删除/废止 canonical receipt。**

   **Issue:** 两库 saga 的第二个 crash seam是 `router.submit` 已在 `journal.db` durable accept 并立即启动 pump，但 `comm.db` 尚未把 receipt 标 delivered。此时 row 与“submit 前 crash”的安全孤儿外观相同，§2.4a 却笼统允许 delivery_pending TTL cleanup（`design-v2.md:133-139`）。如果 Discord cursor 因消息过期、动态 thread 退订或长期故障没有再次重放，Lead 可能已经处理了该 turn，而 cleanup 会移除/废止唯一 receipt；仅写 audit 不能恢复“每次真实 delivery 恰一 canonical row”。

   **Why it matters:** 这正是两 authority 之间最危险的 crash window：把已接受消息误判为未投递会静默失去追办和意图级 SQL；把真正未接受的 orphan 标 delivered 又会产生虚假追办。

   **Suggested fix:** 增加 durable saga reconciler，以 Discord msg id/idempotency key 查询 Lead journal。journal 已 accepted/更后状态 → 幂等完成 receipt delivered transition；journal 明确不存在且已越过安全 retention/watermark → 可标 `delivery_aborted`（保留 tombstone/audit，不算真实 delivery）；journal 不可读/结论未知 → quarantine + visible alert，绝不删除。TTL 只能触发 reconciliation，不能自身作为 disposal authority。测试必须覆盖 submit 已提交后失去 Discord 重放、journal 不可用、journal absent 三种分支。

4. **external carrier 的 queue lifecycle 需要覆盖所有 pending/claim bookkeeping，而不只是主 claim predicate。**

   **Issue:** §2.1 只说 claim 增加 `carrier='inbox'`，§2.4 在 external accept 后只写 delivered_at + window。当前 queue 至少还有 `countPending`（只看 `consumed_at IS NULL`，`lead-inbox-queue.ts:482-496`）、`claimPending`（`:561-618`）、`claimProtocol`/`claimByClass`、`claimModelBatch` 多条独立 SQL；若 external row 保持 `consumed_at=NULL`，它会让 loop 永久处于 active cadence，并可能从遗漏 carrier 条件的兼容 claim 面被再次承运。`carrier` 的 NOT NULL/default/backfill 和 external row 的 `msg_class/consumed_at/disposition` 也未写明。

   **Why it matters:** 一处漏 filter 就会重现 Round 2 的重复投递；即便没有重复，永久 pending count 也会造成每个 Lead 的空转和错误健康信号。既有行 migration 若 carrier 为 NULL，还可能全部退出承运。

   **Suggested fix:** 在 schema 合同中固定 `carrier TEXT NOT NULL DEFAULT 'inbox' CHECK(carrier IN ('inbox','external'))` 并回填旧行。external accept 的 delivered transition 应同时写清其 transport-consumed 状态（例如 `consumed_at=delivered_at`、delivery disposition），同时 deadline 仍按 delivered_at 初始化。枚举并修改所有 queue selection/claim/retry/dead-letter/count/index surface，而不是只改 LeadInboxLoop 主查询。验收直接调用每个公开 claim API并断言 external row 永不返回，`countPending` 不计已接受 external row，而 receipt patrol 仍能按 deadline 选中它。

## Verdict

CHANGES REQUESTED
