# Design Review — plan.md (Round 7)

Date: 2026-08-26
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 已正确关闭 Round 6 的三个问题：route-health residue gate 现已限定调用点并保留另外两条合法告警，plugin adapter 明确保持 `MetaAlertNotifier` 的 receiver，`AlertTicketContext.status` 的 fixture sweep 也覆盖了当前全部残留。唯一剩余 blocker 是 T7e-③ 所称的 renderer RED 实际会在今天代码上直接变绿；R10 仍是真实全链 RED，但该 live renderer 用例必须保留一个显式 legacy status 输入才能证明新 renderer 忽略 payload 状态。

## What's Good (Keep)

- 已核 plan blob 精确为 `a904b3ad60121b3b0f2b7e1ddf80f913f6322566`，HEAD `dee422deea6442c460f044ef7fc06bef41986ef3`，提交只修改 plan，worktree 干净。
- T7f/R9 不再用全仓 reason 数量代替调用点检查：旧 route-health copy 必须消失、`emitTicketRouteHealth(` 在 plugin boot 恰一处，同时 `plugin.ts:9891` 的 repair-bot degraded 与 `:10725` 的 Lead-unreachable fail-loud 路径明确保留。
- production callback 已写成 `notify: (input) => { void metaAlertNotifier.notify(input); }`，不会把依赖 `this.now()` / `this.lastSent` 的方法裸传；boot 不等待 best-effort 通知完成的既有语义也保持不变。
- T7e-④ 已覆盖当前所有 typed/new-world ticket status fixture 与 helper，并解释了为何 `tsconfig` 不会替实现者发现残留；R1-⑤ 的状态来源也已准确改成 Hub seed。
- R1 的 Router→Hub 账本断言和 R10 的磁盘 JSON → drain → lifecycle attach 仍然是真 RED，能够机械证明旧 `ESCALATED` payload 不再污染账本、根消息或 thread。
- founder G0、FLY-2076 deploy gate、channel 与 founder-page 删除同部署、真实 Discord 负向证据和高副作用 rollback 授权均保持完整，方案总体可实施。

## Issues & Recommendations

1. **MEDIUM — T7e-③ 的 live renderer 用例不是 RED。** 当前 `LeadAlertNotifier.formatContent()` 使用 `const status = t?.status?.trim() || "NEW"`。计划要求先从 `LeadAlertNotifier.test.ts:1069` fixture 删除 `status: "ACK"`，再期望 `状态 NEW`；在任何生产改动之前，旧 renderer 已会因 status 缺失走 fallback `NEW`，所以该测试直接为绿，无法证明 T7e 把 renderer 改成 literal NEW。**修复：**把该用例明确改成 legacy-input compatibility RED：保留 `status: "ACK"`，将 ticket object 标为 `as any`（或直接构造 untyped legacy payload），断言根 POST 为 `状态 NEW`。今天代码会渲染 ACK 而红，T7e 后才会绿；同时把它加入 T7e-④ residue check 的允许例外，与 R1-⑤/R10 一样标注为故意保留的旧 JSON 形状。若决定删除该输入，则必须把此用例降级为 GREEN cleanup，不再宣称 RED，并明确由 R10 独自承担 renderer 的 RED 证据。

## Verdict

CHANGES REQUESTED — address items above
