# Design Review — FLY-1499 plan.md (Round 10)

Date: 2026-07-27
Author: Codex
Status: APPROVED

## Summary

Round 10 的小范围变更完整关闭了 Round 9 的四项问题：C4 现在是可执行的硬前置，且 ownerLeadId 已进入所有精确身份比较与跨包验收；C5 同时明确了连接清理责任和“允许重复 vendor turn”的真实语义。该 delta 未回退 Round 8 已批准的消费协议，计划可以进入实施。

## What's Good (Keep)

- 审查对象被准确固定到 `d785d0be`；相对 Round 9 仅修改本计划文件，且工作区中的计划内容与该提交 blob 一致，diff 无空白错误。
- C4 不再依赖软性的合并顺序说明：§12 step 0 明确要求 1501 的 kernel 工件先落地并 rebase，覆盖导出的可选 `ownerLeadId`、严格 5/6-key 双形态解析、额外 key 拒绝、`writeRegistry` 往返，以及包含 owner present/absent 差异的 `identitiesEqual`。
- owner 参与 DeathEvidence、attach 和 coordinator-map arbitration 的精确身份判断，堵住了“核心三元组相同但 owner 不同仍被视作同一身份”的授权缝隙。当前 kernel 的旧解析器会在执行 SQL 前拒绝新形态；计划正确地把这只作为无污染保障，而不是绕过前置依赖的理由。
- T1 的 C4 矩阵覆盖 legacy shape 保持、owner 原样往返、空字符串整事务零变更，以及 owner 不同或缺失时在 crash attribution、attach、map 三条路径上的拒绝；T9 又用跨包类型 fixture 验证 1499/1501 的类型闭合。
- C5 将 engine 的 `Promise.race` 与 vendor 资源生命周期清楚分层：adapter 自己必须设置不长于 engine 等待窗口的 connect/RPC timeout，并在 success/error/timeout 的 `finally` 中关闭临时连接；1501 负责零泄漏计数验收。
- 重试语义现在诚实地允许同一 AttemptHandle 产生多个 vendor turn，收敛依赖消费协议幂等，而不是声称未经机制保证的 exactly-once vendor side effect。
- §9 把 1501 当前仍需同步的 option (a)、删除 option (b)、A14 对齐和连接清理验收列为 W4 的明确 unblock condition，跨批次状态与实际 sibling 计划差异相符。
- T10 冻结了 vendor-opaque `session_ref` 的逐次重试原样透传、no-op `hint` 不影响持久进度，以及 InjectionShim 恰含 `hint`/`deliver`、无 `ack` 的结构契约。

## Issues & Recommendations

1. 未发现需要修改计划的设计问题。实施时应把 §12 step 0 做成会阻止 1499 测试转绿或合并的真实检查，而不是人工约定；同时，T10 中“恰一 turn 归 1501”应按 §4.0/§9 的限定理解为：只有 1501 自带 vendor-level idempotency 机制时才能断言恰一 turn，否则允许重复 turn。这两点均已由正文的规范性条款约束，不构成本轮变更请求。

## Verdict

APPROVED — ready to implement
