# FLY-2332 重放凭据轮换 — 调研
Issue: FLY-2332 (https://linear.app/geoforge3d/issue/FLY-2332/引擎urgent-rework-coordinator-重试-admit-走-idempotent-replay-时不-rotate)
日期: 2026-09-04
基于: exploration.md

## 调研结论

故障不是 admission 未铸造 credential，而是明文 capability 的传递窗口断裂：StateStore 已持久化哈希，coordinator 在首次 grant 失败后丢失明文；第二次 admission replay 正确地不返回明文，但 coordinator 没有像 dispatcher 一样在交付前轮换。

最小可靠修复需要同时满足两个条件：

1. coordinator 在同一 rework activation 的 admission replay 上显式 rotation；
2. StateStore rotation 以 exact activation 定位 re-entry binding，并以当前 rework delivery claim 作为 writer fence。

## 代码证据

### Coordinator 缺口

`packages/teamlead/src/bridge/workflow-rework-coordinator.ts` 当前流程：

1. `claimWorkflowReworkDelivery` 取得 `ownerId + generation`；
2. `admitGeneralizedWorkflowExecution`；
3. `markWorkflowReworkGrantStarted`；
4. 直接把 `admission.outputCredential` / `admission.submissionCredential` 条件展开进 `grantTurn`。

`admitGeneralizedWorkflowExecution` 对 existing binding 返回：

```ts
{
  ok: true,
  idempotentReplay: true,
  activationId,
  outputCredential: undefined,
  snapshotDigest,
}
```

submission credential 同样不返回。因此首次 grant 失败后的下一次 reconcile 会构造缺 credential 的 TURN activation。

### Dispatcher 的工作模式

`packages/teamlead/src/bridge/workflow-engine-dispatcher.ts` 在 admission replay 且取得新 launch claim 后：

```ts
if (node.capabilities.produces_output) {
  outputCredential = store.rotateGeneralizedWorkflowOutputCredential(...);
}
if (decisionContract) {
  submissionCredential = store.rotateGeneralizedWorkflowSubmissionCredential(...);
}
```

rotation 失败分别抛 `engine_output_rotation_<reason>` 和 `engine_submission_rotation_<reason>`。

### StateStore 现有限制

`packages/teamlead/src/StateStore.ts` 的两个 rotation API 有两项与 rework 不兼容的前提：

- 使用 `getWorkflowExecutionBinding(executionId)`；该 legacy getter 仅在 execution 恰好一个 activation 时返回值，re-entry actor有多个 activation；
- 只验证 `workflow_launch_owner` 尚未 committed；rework wake 的原 actor launch 已完成，当前写权限实际由 `workflow_rework_delivery` claim 持有。

因此 coordinator 必须传 exact `activationId`，StateStore 必须在 binding 为 `mode: wake` 且带 `rework_request_id` 时验证：

- delivery `owner_id` 与调用 owner 一致；
- delivery `generation` 一致且 lease 未过期；
- delivery state 仍为 `pending` 或 `turn_granted`；
- 最新 route 的 target node/attempt/execution 与 activation binding 一致。

其他 binding 继续使用原 launch-owner fence，保持 dispatcher、actions、runs-route 行为不变。

## 失败路径

rotation 的任何失败都必须发生在 `markWorkflowReworkGrantStarted` 和 `grantTurn` 之前，并通过 `releaseRetryable` 进入既有 retry accounting：

- output: `engine_output_rotation_<reason>`；
- submission: `engine_submission_rotation_<reason>`。

credential row 的 revoke + insert 保持单个 StateStore transaction；不会出现先撤销旧 row、后插入失败的半状态。

## 测试策略

### RED 1: submission credential

用真实 StateStore + CommDB 构造 QA rework activation。第一次 coordinator reconcile 让 `grantTurn` 抛出 `execution mutation lease refused: lease_held`；推进时间越过 retry backoff 后再次 reconcile。当前 main 会把 `submission_credential = NULL` 写入 CommDB，断言必红。

修复后断言：

- 第二次 reconcile 到 `awaiting_receipt`；
- CommDB 当前 activation 有 submission credential；
- 用该明文查询 StateStore 能命中最新未撤销 row；
- 原 row 已 revoked，新 row 未 revoked。

### RED 2: output credential

用同形流程针对 produces-output 的 implement rework activation，断言 CommDB output credential 与 StateStore 最新未撤销 row 一致。

### 负向守卫

覆盖错 activation、错 owner/generation、过期 claim 或 route identity 漂移时 rotation fail closed，且 coordinator 不调用 `grantTurn`。

## 明确不做

- 不改变 admission replay 的无明文合同；
- 不改变 delivery claim schema、generation 规则、route authority；
- 不回填已经 `wake_delivered` 的 activation；
- 不改变 qa-result 或 workflow-output 的消费语义；
- 不触碰 `CLAUDE.md`。
