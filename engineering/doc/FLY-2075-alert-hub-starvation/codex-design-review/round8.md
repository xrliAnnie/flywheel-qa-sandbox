# Design Review — plan.md (Round 8)

Date: 2026-08-26
Author: Codex
Status: APPROVED

## Summary

本轮修订关闭了 Round 7 唯一剩余问题：legacy `status: "ACK"` 输入现在构成真实 RED，现有 renderer 会输出 ACK，而 T7e 后必须输出 NEW；独立的磁盘队列回放 R10 仍覆盖完整生产链。计划在当前架构下可实施，删除边界、无 Hub 的 fail-loud 行为、状态机收敛、route-health 单次副作用、flag 墓碑、上线门与授权回滚均有明确合同和可执行验证；在 G0 与 deploy gate 满足的前提下，可以进入实现。

## What's Good (Keep)

- 已锁定并核对目标 plan blob `630e7c640bacf07e310ddcb9f35aa25cd7ee1539`；工作树干净，评审对象明确。
- T7e-③ 保留旧 JSON 形状的 `status: "ACK"`，并用 `as any` 明示兼容性边界；该断言在当前 `t?.status?.trim() || "NEW"` 实现上确实变红，不再是自证式测试。
- R10 继续从真实 queue 文件、`drainQueue()`、delivery lifecycle 到 Hub/StateStore 验证旧载荷不能恢复 `ESCALATED`，与 renderer 单测形成独立的链路级证据。
- IC-1..IC-5 把本轮和 Round 6 的 scoped residue checks、三处合法 `alert_unreachable_config` 路径、回调绑定及构建/QA 门固化为实现期清单，能防止删除工作遗漏或误伤相邻路径。
- `emitTicketRouteHealth` 的唯一接线和 best-effort async 绑定合同清楚；旧 misconfigured 分支必须删除，同时保留 repair-bot degraded 与 Lead-unreachable 两条合法路径。
- 七份既往设计反馈均已归档并受版本控制；Round 5–7 归档与原始交付逐字一致，便于 code review 对照实现。
- Founder affirmative G0、FLY-2076/无读者窗口 deploy gate，以及禁止 runner 自行回滚的授权边界仍然明确；这与本次 founder-decided 默认反转的风险相称。

## Issues & Recommendations

1. **LOW（非阻塞）：T7e-④ 的例外枚举少写了 IC-1。** T7e-③ 与 §10 IC-2 都明确允许三处 legacy `status` 输入（IC-1、R1-⑤、R10），但紧邻的 T7e-④ 只写了 R1-⑤ / R10。实现时应把 T7e-④ 同步为三处，避免执行 residue check 的人误删刚加入的 ACK RED；现有两处明确合同已消除实现歧义，因此不阻塞批准。

## Verdict

APPROVED — ready to implement
