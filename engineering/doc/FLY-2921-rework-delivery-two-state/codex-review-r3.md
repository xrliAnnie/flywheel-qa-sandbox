# Design Review — plan.md (Round 3)

Date: 2026-09-26 / Author: Codex / Status: CHANGES REQUESTED

## Summary

本轮仅核对 R2 四项及修法直接引入的问题。死亡证明、受控收尾、准入前身份和动作优先级已在设计层闭合；复位原语的跨 sent 幂等性也已修正。剩余 **1 MAJOR、0 BLOCKER**：新增 `busy` 返回值没有落实到既有恢复调用方，可能在实际未复位时关闭恢复门。

Reviewed head: `0fc30e15e36b75a5efc30b5cfb5137925ace4edb`。Plan blob: `b743cf10cf4d82d5c52a8e6095c470535445cfe8`，与工作区 plan 一致。源码仍为基线 `d52df7841`。工作区已有 founder-report.html 修改，本轮未触碰。

| R2 项 | 本轮结论 | 核验依据 |
|---|---|---|
| #1 旧 classifier.replace 不足以证明死亡 | 已解决（设计层） | plan.md:123–134 明确依赖 2919 的当前执行体/代次证据；能力未就绪时关闭活性换体，不再认可窗格型 replace；真实接线负控已补充 |
| #2 running / wake_delivered 无法请求退出 | 已解决（设计层） | plan.md:127–129 按状态分流至既有窄授权或 2919 受控收尾，并要求请求实际发出、迟到 owner 拒绝、证死前零后继；§6.2 明确两个依赖接口 |
| #3 缺准入前身份及重投分支被遮住 | 已解决（设计层） | plan.md:101–118 区分准入前精确 dispatch 身份与准入后 binding，并把 Lead 重投处置放在通用等待之前，补齐对应场景 |
| #4 复位不跨 sent 幂等 | 原问题已解决，新增适配缺口 | plan.md:155 扩展同 receipt 重放条件，:156 保护未过期 claim；新增 busy 必须由旧调用方消费，见下 |

本轮未运行测试套件、未修改源码。执行了一个内存控制流验证：直接提取基线 delivery-operations.ts 的恢复调用片段，注入计划新增的 busy 结果，实际轨迹为 `busy → applied → projected`，进程退出码 0。它证明现有调用方忽略返回值，不代表新实现已完成或通过测试。

下文 plan.md 指 `engineering/doc/FLY-2921-rework-delivery-two-state/plan.md`。

## What's Good (Keep)

- 2919 的实现顺序与能力依赖已经明确，避免在本单重新实现进程探针，也避免把旧 classifier 的返回名当成受信证明。
- running / wake_delivered 使用受控收尾，保留旧 supersession 授权的窄范围；与兄弟设计的 close_requested、stop/drained 和独立死亡证明合同一致。
- 准入前以已有 dispatch 意图识别替身，准入后追加 binding 校验，符合当前记录的实际创建顺序。
- 保留同一 wake 身份，并在原语中修复重放与 claim 保护，是合适的局部修正。无需恢复 per-revision wakeId 或改 TURN。

## Issues & Recommendations

### 1. MAJOR — 新增 busy 后，既有调用方仍会把未执行的复位记为 applied

**问题：** plan.md:156 新增“有未过期 claim 时返回 busy、不复位”，但 :157 对 delivery-operations.ts 只要求补回归，并称改动“只会更安全”，没有规定该调用方收到 busy 时必须停止成功结算。当前调用方并不检查原语返回值。

**证据：** `packages/teamlead/src/bridge/delivery-operations.ts:611` 调用 resumeTurnWakeHold 后直接 break；`:619` 无条件调用 markWorkflowHoldResumeApplied，随后 `:625` 调用 projectWorkflowHoldResume。因此无论新结果的具体类型如何，只要 busy 是正常返回，现有控制流都会继续提交成功回执。注入 busy 的内存执行已复现这一轨迹。

**触发与影响：** 一个 staged 的 three_stage_turn_stuck 恢复操作与 outbox patrol 的有效 claim 并发。原语按新规则返回 busy，wake 的计数和失败结果没有被复位，但操作却被标为 applied 并投影；下次 pass 不再执行 staged 分支，Lead 看到门已处理，实际恢复动作被丢失。这是 R2 #4 修法新增的调用合同问题。

**建议：** 在计划中明确所有调用方的结果分支：busy 是可重试的未执行结果；delivery-operations 必须保留 staged 并等待后续 pass，不得调用 markWorkflowHoldResumeApplied 或 projectWorkflowHoldResume。只有复位成功、同 receipt 幂等重放或已定义的终态 noop 才可继续成功结算。新协调器也应在 busy 时释放/延后认领，不把它当作已完成重臂或实际投递失败。

**验收：** 使用真实 delivery-operations pass 覆盖“有效 claim → busy → operation 仍 staged、零 applied/projected → claim 释放或过期 → 下一 pass 实际复位一次并 applied/projected”。同时保留本轮列出的 sent 重放和成功推送后崩溃回归。此修正只需补全新增返回值的调用方处理，不扩大架构范围。

## Verdict

**CHANGES REQUESTED**

仅本轮第 1 项阻止批准。R2 #1–#3 及 #4 的原幂等性问题保持关闭；此前已关闭的 R1 项不重开。
