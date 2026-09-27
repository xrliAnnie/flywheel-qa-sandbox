# Design Review — plan.md (Round 4)

Date: 2026-09-26 / Author: Codex / Status: APPROVED

## Summary

仅验证 R3 #1：resumeTurnWakeHold 的新增 `busy` 结果必须由所有调用方处理，不能结算为 applied/projected。该项已在设计层解决，无剩余 BLOCKER/MAJOR。R1/R2 已关闭事项未重开。

Reviewed change: `ef48a529c`。Plan blob: `63bf95a6b1903be9b32653e9a518315b0eccca20`，与当前 HEAD `84b3a66e7a911b84442476aceff5133cf547f78f` 的 plan 一致。源码仍与基线 `d52df7841` 一致。本轮只读核查计划、调用方和代码引用，未运行测试套件、未修改源码。

## What's Good (Keep)

- 成功结算限定为实际复位、同 receipt 幂等重放、acked/cancelled 终态 noop；`busy` 明确是可重试的未执行结果。
- 既有恢复操作保持 staged，协调器延后重试且不计失败，两条路径均不会将 busy 误记为成功。
- 验收覆盖完整的两次 pass：首次 busy 不结算，认领释放或过期后实际复位一次并结算。

## Issues & Recommendations

1. **R3 #1（原 MAJOR）：已解决。**

   **证据：** `engineering/doc/FLY-2921-rework-delivery-two-state/plan.md:157` 规定所有调用方按结果分支；`:158` 明确 delivery-operations 收到 busy 后保留 staged，并跳过本 pass 的 applied/projected；`:159` 明确协调器 defer、不计失败、不视为已重臂；`:160` 指定真实 delivery-operations pass 的完整验收序列。

   全仓代码引用搜索确认，基线唯一的非测试调用方是 `packages/teamlead/src/bridge/delivery-operations.ts:611`；其后续成功写点确为 `:619` 的 markWorkflowHoldResumeApplied 和 `:625` 的 projectWorkflowHoldResume。计划已逐一约束这两个写点，并覆盖拟新增的 rearmReworkWake 调用方，未发现本项范围内遗漏的生产调用方。

   **结论：** R3 所述“未复位却关闭恢复门”的设计缺口已闭合，无进一步修改要求。真实 pass 回归仍是实施阶段验收，本次不宣称实现或测试已完成。

## Verdict

**APPROVED**

限定于 Lead 指定的 R3 #1 结案核验；不扩展审查范围。
