# Design Review — FLY-1426 plan.md (Round 4)

Date: 2026-07-22
Author: Codex
Status: APPROVED

## Summary

Round 4 已闭合上一轮全部剩余问题：receipt window 配置跨 tmux/Bridge 保持一致，patrol 只扫描 SQL 级候选并以 per-Lead 公平份额跨 pass 收敛，统一 recovery worker 也消除了健康路径 `complete` 与 pending reconcile 的竞态。计划现在可由当前架构实现，失败路径保持 founder chat fail-open，同时满足 FLY-1392 的 external-carrier、证据、非终态 quarantine 和 type-agnostic chase 合同。

## What's Good (Keep)

- accept 边界、`carrier=external`、caller-supplied `chat:` id、`refMessageId=NULL` 与 `msgClass:"model"` 的组合正确；所有 inbox claim 面继续不会承运 external 行。
- blind TTL abort 已彻底移除；pending selector 排除 processed/disposed，超龄只 quarantine 并继续 redeliver，符合 R3#3。
- begin failure 的 durable spool、`attempts/advisedAt`、0700/0600、原子替换与可见 advisory 共同关闭了零收据静默退化，同时不阻断 founder chat。
- spool drain 只补 begin；只有本进程 awaited notification 成功后才 complete。两处 crash seam、in-flight 排除和 complete-failure redelivery 测试共同守住 accept/deliver 边界与健康态恰一次注入。
- launcher 现在同时传播 kill switch 与 P0–P3 四个 window override；插件 complete 和 Bridge patrol 读取同一配置，2 分钟验收断言能真实验证 deadline。
- patrol 将 age/quarantine 条件下沉 SQL，并采用 per-Lead cap 与跨 pass cursor/wrap-around；非候选不消耗 scan budget，多 Lead 之间也不会互相饿死。
- settle 只接受实际成功发送 payload 上的 Discord reference；roundtable strip、`replyToMode=off`、发送失败与无 `reply_to` 均不会写假 processed evidence。
- owner fallback、严格 `receipt_unprocessed + chat:` founder venue、失败回现有 ticket lane及非 chat 反向测试控制了 S2 blast radius。
- 完整 `handle-receipt --lead ... --request-id ...` 规则、真实命令集成测试、覆盖矩阵、capability preflight、PR-1 先于 PR-2 和逐 Lead rollout 顺序均完整。

## Issues & Recommendations

1. **NON-BLOCKING — 同步总览时序图的旧文字。** `plan.md:58` 仍把 `complete` 标为 `fire-and-forget`，而权威的 S3#4（`:133`）已改为 bounded await。实施 handoff 前将图中该标签改为 `await ≤5s`，避免读者按旧摘要实现；详细合同和测试已经无歧义，因此不阻塞批准。

## Verdict

APPROVED — ready to implement
