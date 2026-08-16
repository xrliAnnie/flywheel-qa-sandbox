# Design Review — plan.md (FLY-1772) (Round 3)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已实质关闭 Round 2 的六个主体问题：supersede fencing、void 原子告警、projector TDZ/single-flight、旧卡 REPLY 优先处置、stall 活性复核和 alert union 都已达到现有架构可实现的形态。仍有三个重启/漂移边界会破坏“告警先 durable、旧输入才可处置”的保证，主要是 direct alert claim 不等于 delivery receipt、48h watch 没有固定截止锚点，以及 D4 text leg 在 identity 漂移后会被同 UID payload conflict 永久 pin，因此本轮仍需小幅修订。

## What's Good (Keep)

- D3 现在先做 read-only payload/run 分类；可绑定分支的 `deadletter + workflow outbox + run event` 单事务合同清晰，`workflow source run unavailable` 保持 retryable 也与现有分类一致。
- early sink holder 明确移到 boot drain 之前，callback 不再闭包引用后声明的 notifier；async drain 的 single-flight 与顶层 rejection containment 正确关闭了 TDZ 和重入窗口。
- `card_watch_next_at`、10 分钟固定 cadence、earliest-due `LIMIT 10` 和 11+ 卡公平性测试，解决了 Round 2 指出的 3 秒 tick 放大与固定前十饥饿。
- old-card REPLY 在 `cardGate ?? sole shipGate` 前被识别并处置；enqueue 成功前不放行、成功后绝不调用 `tryFounderShipApproval`，准确落实“旧卡永不接受操作”。
- stall alert 会在 async materialization 失败后重读 holder/run，并排除 superseded/completed race；reason 移出 durable payload，测试也覆盖 identity/reason 漂移。
- alert disposition union、共享 D4 payload builder，以及 founder_feedback helper 的 exact question/from-state `updated===1` fence 均已写进文件清单和测试矩阵。

## Issues & Recommendations

1. **D3 unresolvable fallback 仍未真正关闭 crash window：claim/duplicate 不能证明 durable delivery。** 计划 §4.1 以 `alertFallback(... durable-accept + claims 去重)` 的返回值决定是否写 deadletter，但当前 `LeadAlertNotifier` 明确说明 `alert_claims` 与 `lead_events` 只证明“尝试过”，不证明投递（`LeadAlertNotifier.ts:542-554`）；claim 已写后进程若在 send/queue/`alert_delivery_receipts` 之前崩溃，重试会在 `claimsReader/claimsClaimer` 处直接返回 `{skipped:'duplicate'}`（`:879-933`）。若 duplicate 映射为 `accepted:true`，projector 会在没有 durable alert 的情况下 deadletter+advance；若映射为 false，该 row 会永久卡住。建议让 fallback 的 acceptance 依赖一个可重读的 durable receipt，而不是 claim：最简单可直接使用现有 idempotent `LeadInboxRuntime.enqueueInfraAlert` durable queue（delivery id 已由 eventId 确定，`lead-inbox-runtime.ts:401-449`）并只在 enqueue receipt 后返回 accepted；若必须走 notifier/routing，则需要 durable fallback intent + ambiguous-attempt fence，并复用 `getAlertDeliveryReceipt`/`replayAfterAmbiguousAttempt`，其模式已经存在于 dead-letter alert drain（`StateStore.ts:10884-10909`, `lead-inbox-runtime.ts:578-624`）。增加 crash 注入测试：claim/lead_event 已写、delivery receipt 尚未写时崩溃，重启后必须重新完成 durable delivery，不能把 duplicate 当成功。另请明确 fallback `accepted:false`/throw 时立即 `break` 当前 project drain；否则后续 row 若被处理并推进 rowid cursor，会跨过这条未处置事件。测试用 row N fallback 拒绝 + row N+1 合法事件，断言 N+1 不处理且 cursor 停在 N 之前。

2. **D4 的“48h 生命周期”没有不可滑动的持久化锚点，当前四列无法可靠实现硬上界。** §5.1 要求“supersede 距今 ≤48h”，但 holder 没有 `superseded_at/watch_started_at/watch_expires_at`；`created_at` 可能早于 supersede 很久，而 `updated_at` 会在 supersede、void done 及通常的 ledger 推进中变化。仅有会反复更新的 `card_watch_next_at` 无法判断固定 48h 截止，因此实现若用 `updated_at` 会让窗口滑动、破坏 ≤288 GET 的承诺；若用 `created_at`，长期等待后才被打回的卡会过早失去观察。建议增加固定 `card_watch_expires_at`（有卡 supersede 或 void done 时一次性写 `now+48h`，二选一但需明确语义），候选只取 `next_at <= now AND now < expires_at`。每次实际 fetch 后设置 `card_watch_next_at = now + 10min`，不要从过期的旧值做 `+=10min`，否则 Bridge 停机 24h 后会每 3 秒追赶 144 个历史 slot，形成启动突刺。补测“卡创建很久后才 supersede”、watch 更新不延长 deadline、以及长时间停机后的首次 tick 不 catch-up burst。

3. **D4 两个入口共享 UID，但 text leg 没有定义 existing-outbox 快路，Lead identity 漂移会永久 pin founder cursor。** Reaction leg 会先查 `voided_card_input:${question_id}`，text leg 则直接要求 enqueue 成功；共享 builder 的参数仍含动态 `identity`。若 reaction 已按 Lead A 的 identity 入 outbox，随后 Lead 归属变化，旧卡 REPLY 会用 Lead B 构造同 UID 不同 payload，触发 `workflow_alert_uid_conflict`，并按照 §5.2 的“enqueue 失败 → pin”在每次重试重复失败，尽管该卡的 durable alert 已经存在。建议 text leg 同样先读 outbox：存在且 `run_id` 与 holder 一致时视为 alert 已 durable，直接完成 old-card misuse disposition；异 run 才 fail-closed。enqueue race 遇 conflict 时也重读并执行同一验证。增加“reaction 先告警 → Lead identity 改变 → old-card REPLY”的测试，断言无第二条 alert、无 gate write、cursor 正常推进。

4. **清理三处仍会给实现者相反指令的残留文字。** §1 仍写 holder “加三列”，而 §2/§6 已是四列；§3.1 规定 uid conflict 要重读并区分 run，§9 却仍写“一律吞并为已入队”；§8 把整个 D3 概括为“同事务 durable”，但不可绑定分支实际是 external durable-accept 后再写 legacy deadletter。建议统一为新版精确合同，并把新增的 watch expiry 列同步到架构总览/文件清单。

## Verdict

CHANGES REQUESTED — address items above
