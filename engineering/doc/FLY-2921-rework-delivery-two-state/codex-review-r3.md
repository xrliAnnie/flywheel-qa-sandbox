# Design Review — plan.md (Round 3)

Date: 2026-09-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

已复核计划提交 `967c1924b7a4010722257c8f927d22776a2fb9fd`，对照源码基线 `d52df7841cb7f7844ee83e37159987840a4c50ac`。同一事务完成放弃与换体、持久取消围栏、双向竞争及崩溃测试已关闭 R2 #1；但本轮新增的通用准入拒绝条件过宽，会覆盖正常返工 wake，需收窄一处合同。此次为修订及直接影响的静态设计复审，未修改主仓、未运行测试，也未审查 §10 提到的后续实现头。

## What's Good (Keep)

- 将旧意图结算、凭据撤销、节点预留切换、路由及新意图创建置于同一事务，并要求任一步 CAS 失败整笔回滚，消除了 R2 的可提交中间状态。
- 复用 `workflow_launch_cancellation`：基线 `StateStore.ts:41724-41732` 和 `42807-42809` 确实在 launch acquire / commit 时拒绝取消身份；无需新增启动围栏体系。
- §8.2 同时覆盖准入先胜、换体先胜后的旧请求重放，以及放弃与预留切换之间的崩溃，验证范围与原缺口对应。R1 的 C4.7 冻结入口守卫继续保留。

## Issues & Recommendations

1. **MAJOR — 新增 `dispatch_intent_abandoned` 守卫不能把“意图不是 `intent_recorded`”作为所有准入的拒绝条件。**

   **位置与影响：** C2 第 3 步 b 的“为什么这样就没有窗口”新增了准入事务在创建 binding / 凭据前拒绝“存在取消围栏，或其 dispatch 意图不是 `intent_recorded`”的要求，但未限定为准入前 replacement 的新启动。正常返工复用活体时，同样调用 `admitGeneralizedWorkflowExecution`，只是 `activationMode='wake'`：该执行体的启动历史已经是 `started`，新返工 attempt 也可以只有节点预留、没有新的 dispatch intent。这是合法唤醒，并不是 abandoned。若按当前条件给公共准入函数加守卫，正常活体返工会在授 TURN 前被拒，重试后交还 Lead；即使未冻结 run，也阻断了本单的正常投递链。此项是本轮新增守卫的影响，不是重新打开 R2 的原子性问题。

   **基线证据：** `packages/teamlead/src/bridge/workflow-rework-coordinator.ts:861-862,895-913` 为返工生成新的 activation，并以 `activationMode: "wake"` 调用公共准入函数，失败进入投递重试。`packages/teamlead/src/StateStore.ts:52677-52681,52780-52786` 的 land 返工在新 attempt 上预留已有 preferred actor；准入在 `47177-47182` 按 execution/run/node/attempt 查绑定，因此这个新 attempt 的首次 wake 仍要创建 binding，不能靠已有绑定的幂等返回绕过新守卫。`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts:2570-2583` 将成功启动的 dispatch 记为 `started`；`packages/teamlead/src/StateStore.ts:86978-86987` 明确说明 ledger 记录启动历史，启动后退出也保持 `started`。

   **建议：** 保留精确执行体的 cancellation 拒绝；将严格的 `intent_recorded` 前置明确限定为“新 replacement launch 准入”，并按 run/node/attempt/execution 定位对应 intent，正常 `wake` 继续走原有激活与预留检查。更简单的方案是仅拒绝精确匹配的 cancellation / 明确 `abandoned`，不把其他状态或没有新 dispatch intent 一概视为放弃。保留合法准入的幂等重放。§8.2 增加真实 StateStore 的正向对照：已启动且仍存活的执行体，在新的返工 attempt 上首次 wake 准入成功并到达 `wake_sent`；同时保留旧替身取消后 admission/acquire/commit 全部拒绝的负控。

## Verdict

CHANGES REQUESTED — address items above
