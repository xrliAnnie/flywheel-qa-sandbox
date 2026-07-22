# Design Review — FLY-1426 plan.md (Round 3)

Date: 2026-07-22
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已正确闭合 Round 2 的七项反馈：角色判定、spool accept/deliver 状态机、完整 ack 命令、durable advisory、wire-level settle、patrol Lead seam 与 quarantine 幂等语义现在都可实现且符合 FLY-1392。仍有一个会让生产自定义 SLA 与真机验收失真的 env 传播阻塞项，以及两处有界 recovery 调度需要明确非饥饿/无健康态重复投递合同，因此本轮继续请求小幅修改。

## What's Good (Keep)

- companion/external 现在先按现成 role marker 进入 legal-disabled，真实的“Lead ID 在、COMM pair 空”形状不会再误报；stock、enabled、broken-managed 三类也已分开测试。
- spool drain 已改成只补 `begin`，由 pending reconciler 在 awaited notification 成功后才 `complete`；rename/notify 两个 crash seam 与 `delivered_at` 负断言正确守住 external accept/deliver 边界。
- `{attempts, advisedAt}`、0700/0600、串行 drain 和 spool-write-failure advisory 使失败恢复既 durable 又不泄漏 founder 原文，方向应保留。
- `handle-receipt` 规则现在包含 `--lead "$FLYWHEEL_LEAD_ID"`，并要求实际执行 temp-DB integration，而不只做文本 truth test。
- settle 直接观察成功发送的 payload，且覆盖 roundtable strip、`replyToMode=off`、无 `reply_to` 与发送失败，消除了假 `discord_reply_reference` evidence。
- patrol 已获得 registry 中的 per-project Lead ids，quarantine 使用 stable reason 且明确不替代重投；48h 行仍 redeliver + complete，符合 R3#3。
- lane-scoped pager、versioned envelope、processed exclusion、PR-1/dist/preflight/PR-2 顺序以及 companion/external 诚实边界均保持正确。

## Issues & Recommendations

1. **HIGH — `complete` 与 Bridge patrol 可能读取不同的 receipt window 配置，且 §6 的 2 分钟真机验收按当前 launcher 不会生效。** `plan.md:97` 让插件子进程从 `FLYWHEEL_RECEIPT_WINDOW_P<n>_MIN` 计算 `markExternalDelivered` 的 deadline，`plan.md:192` 又依赖 `P0=2`；但 S5 只新增 `FLYWHEEL_CHAT_RECEIPTS`（`plan.md:148`）。真实 launcher 明确说明 `tmux new-window -e` 不继承未列入的 launcher env（`packages/teamlead/scripts/claude-lead.sh:1432-1474,1528-1547`），当前 allowlist 也没有四个 window 变量。于是插件 `complete` 会用默认值，而 Bridge 的 `LeadReceiptPatrol` 会从自己的进程 env 读 override；active episode adoption 对已有 `next_unprocessed_at` 使用 `COALESCE`，不会纠正这个漂移。S5 应显式传播 P0–P3 四个变量（可直接复用现有 `receiptPriorityWindowsMs`, `lead-inbox-queue.ts:14-32`），并增加 launcher launch-plan test 与真实 `P0=2` 断言：同一行的 `next_unprocessed_at - delivered_at` 为 2 分钟，plugin 与 patrol 读到同一组值。

2. **MEDIUM — patrol 的 project-wide 50-row cap 仍可能让后页或后序 Lead 跨 pass 永久饥饿。** 新 selector 的 SQL（`plan.md:104`）仍会返回 fresh 和已 quarantine 行，而 patrol 在 JS 中才筛选；`plan.md:116` 又给整个 project 一个固定 cap。若每次 pass 都从 cursor 0 和固定 Lead 顺序开始，前 50 个非候选行会在每轮重复消耗 scan budget，或第一个 Lead 的持续 backlog 会让后续 Lead 永远得不到额度；“当前 pass 内 cursor 能到下一页”的测试不足以证明跨 pass 收敛。把 `createdBefore`/未 quarantine 条件下沉为 selector 的可选 SQL 谓词，或持久化每 Lead cursor 并 wrap-around；cap 至少要保证每 Lead 一页的公平份额。补一个跨两次以上 pass、候选位于 cap 之后以及首 Lead 持续有 backlog 的测试。

3. **MEDIUM — healthy-path `complete` 与 tail piggyback pending reconcile 的顺序尚未冻结，可能把每条正常消息都立即重投一次。** `plan.md:132` 仍把 `complete` 定义为 fire-and-forget，而 `plan.md:130,135` 让 piggyback recovery 在消息尾部处理 pending；如果 pending 查询先于该 child commit，同一条刚刚成功 notify 的健康消息会被 `[redelivery]` 再注入。把 ready、spool、pending 统一为一个 serialized recovery worker，并明确 tail trigger 的顺序：先等待/观察本条 bounded complete 结果，成功则不得被本轮 pending snapshot 选中，失败才进入重投；或者显式排除本轮刚 notify 的 receipt，待 complete 结果后再决定。增加健康路径“恰一次 notification”与 complete 失败“随后 redelivery 并最终 delivered”两个并发测试。

## Verdict

CHANGES REQUESTED — address items above
