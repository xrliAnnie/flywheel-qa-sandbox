# Design Review — plan.md (FLY-1609, Round 3)

Date: 2026-08-03
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已经真实关闭 Round 2 关于 label refresh honesty、分析 epoch、CI 注册和持久化边界证据的要求，方案整体仍可行且范围合适。但 retry 设计还缺一个能同时携带 frozen arm 与可信 fallback signal 的运行时 carrier：最终 mode 只能在 Blueprint 内确定，而当前互斥的 `PonytailInput` 无法支持届时丢弃 frozen arm 后再重解；这使核心 kill 修复尚不可按计划实现。

## What's Good (Keep)

- reresolve 现在明确以本次 fresh Linear fetch 的真实结果决定 `labelStatus`；无 key/请求失败为 unreadable，stored labels 不冒充成功读取，正确关闭了 Round 2 #1。
- frozen `source:"arm"` 的生命周期被明确绑定到最终 D mode；这是修复 kill 后 arm 注入残留的正确语义方向。
- `--since` 已改为比较模式必填，并提供显式 `--allow-pre-rollout` smoke 逃生；self-test 同时钉住拒绝和逃生路径，分析默认值现在 fail-closed。
- `.github/workflows/ci.yml` 的具名 step 已明确进入改动面，符合本仓 shell tests 逐项枚举、无自动发现的真实 CI 结构。
- StateStore、event-route、DirectEventSink 三个 D round-trip 已具名并给出精确列值；Round 1 #6 的边界证据现在真正进入任务清单。
- 纯 ladder、四值 bucket、assembly base-arm、C-arm sentinel、归因 eligibility 与 Claude/Codex 运维边界继续保持清晰且克制。

## Issues & Recommendations

1. **HIGH — Task 3b 没有定义可把 frozen arm 与 kill fallback signal 同时送到最终 mode 决策点的数据合同。** 当前 `PonytailInput` 是互斥 union：只能是 `start_signal` 或 `frozen_requested`（`ponytail.ts:59-62`）；`BlueprintContext` 也只有一个 `ponytailInput`（`Blueprint.ts:337-348`）。但最终 mode 是 Blueprint 在 hydrate 后调用 `resolveSkillFrameworkForRun` 才得到的（当前 `Blueprint.ts:879-895`，计划只会把两次解析顺序对调），`actions.ts` 无法提前知道本次最终是 D、forced A、project opt-out 还是 fallback。照 plan.md:86-90 的 GREEN 写法，actions 若发送 frozen arm，Blueprint 在发现 mode≠D 时没有同时收到那份“本次可信 start signal”可供重解；若 actions 提前发送 start signal，又无法在最终仍为 D 时保留 frozen arm。另一个具体遗漏是 `retry-dispatcher.ts:41-142` 的 `RetryRequest` 目前根本没有 ponytail 字段；文件中现有 `ponytailInput`（:286-290）属于 `StartRequest`，不是可复用的 retry carrier。

   建议把 ownership 和形状写死：actions 始终产出 `{ retryPlan, freshSignal }`（或等价的 `frozen_requested + fallbackSignal`），其中 freshSignal 带真实 `labelStatus`；在 `RetryRequest`、RunDispatcher 和 `BlueprintContext` 明确传递两者；Blueprint 先得到最终 mode，再选择“D→honor frozen arm”或“非 D→以 freshSignal、armInject=false 重解”。非-arm frozen request 仍可直接使用。测试必须落在最终 envelope/adapter 行为，而不只断言 ctx 收到 frozen；并把本轮用户声明但 plan RED 列表未明确写出的“reresolve + refresh 成功且无 labels → `on:arm`”补入。

2. **kill 合同的绝对表述与普通 FLY-615 ladder 自相矛盾。** plan.md:27 写“全局 kill 之后不存在 A + ponytail”，但同段要求丢弃 arm 后以 `armInject=false` 重解，plan.md:83 又明确真实 label/project signal 继续生效；因此 forced A + `ponytail` label 或 project-on 合法地仍会产生 `on:label` / `on:project`。全局 kill 能保证的是“不再有 arm-derived ponytail / `on:arm`”，不是禁掉独立的 FLY-615。建议把 §0、§3 和测试名称统一改成这一精确合同：无信号的 D predecessor 在 kill 后为 A + `off:default`；当前 label/project on 可保持 A + ponytail，但 condition source 必须是 label/project，绝不能是 arm。这样既不误伤 FLY-615，也能真实证明 FLY-1609 实验注入已停止。

## Verdict

CHANGES REQUESTED — address items above
