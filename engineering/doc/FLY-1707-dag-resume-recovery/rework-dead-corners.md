# FLY-1707 DAG 断点恢复 — 返工救援死角
Issue: FLY-1707 (https://linear.app/geoforge3d/issue/FLY-1707/epic-重跑与恢复dag-断点继续fly-1699-prd-已定稿-建设)
日期: 2026-08-15
基于: plan.md

## 定案

三种「接着做」必须分开，不能共用一条万能唤醒路径：

- crash / Bridge 重启且 run 仍为 `active`：走 resume admission，验证附件后恢复当前节点。
- QA fail / founder kickback：走 fresh replacement 重派认领；旧 actor 只作为被替换的历史 holder。
- operator rework：改变权威前沿；不是 crash 恢复，也不能绕过 loop-limit 的人工确认。

`completed → running` 仍是禁止边。`activateHolderForWake` 的可唤醒白名单不扩大，避免破坏终态免疫。

## 三个历史死角

| 死角 | 当前结论 | 残余边界 |
|---|---|---|
| #1 decision claim 与 DAG 推进曾分离 | schema-v2 engine run 由 completion / transition 事务推进；#795 后现役有 PR 模板走 terminal `land` | legacy 三阶段编排不在 E5 重建范围 |
| #2 PASS 后缺少交棒 | #795 把现役 schema-v2 路径收敛到 `land` dispatch，避免旧 `runner_ship` 无消费者形态 | frozen/custom `runner_ship` 与 legacy PASS no-op 只保留兼容，不在本 epic 改模板或 gate 语义 |
| #3 completed holder 无法 wake | 保留终态免疫：coordinator 在 claim fence 内关旧 actor，下一轮以真实 dead 证据进入 `materializeWorkflowReworkReplacement` | 收体失败按 1/2/4/8 分钟退避；第五次进入 `needs_lead`，不忙等、不伪造死亡 |

## 本次验证

`workflow-rework.e2e.test.ts` 构造 completed implement holder：第一次 reconcile 受控收体并释放 claim；同一分钟再调用 20 次不新增 claim 或收体；退避到期后第二次 claim 进入 `replacement_pending`，同一 dispatcher tick 用 rework `base_revision` 铸 fresh execution、改绑 route 并落到 `wake_delivered`。因此旧 `preferred_actor_execution_id` 会被 replacement 流程接管，不会卡在 `rework_target_not_reserved` 热循环。

loop-limit 的 held run 新增唯一继续把手：调用 `POST /api/runs/:runId/rework` 时必须带：

```json
{
  "escalationAck": {
    "holdEventUid": "<当前 loop_limit_escalated event_uid>",
    "holdReceiptDigest": "<该 event payload 的 canonical SHA-256>",
    "decision": "continue"
  }
}
```

`decision` 也可为 `reclassify`。服务端只接受该 run 当前最新的 loop-limit hold；缺 ack、旧 event、错 digest、同 key 改 decision 均拒绝。ack 同事务写入 `operator_rework_requested` 与 rework authority context，响应丢失后可精确重放。

循环次数由同一条投影计算：同 edge 的 `loop_iteration` 与 `loop_limit_escalated` 收据之和。实测序列为 `1,2,3 → escalate(4) → ack → escalate(5) → ack → escalate(6)`，run id 不变、节点 attempt 单调，人工继续不会清零护栏历史。

## 明确不做

- 不把 `completed` 直接当成可复活状态。
- 不把 operator rework 当 crash resume。
- 不重命名兼容字段 `subjectDigest`；代码注释明确它在 rework 路径代表权威 Git base head。
- 不为 legacy 编排器、frozen `runner_ship` 或模板/gate 语义扩 scope。
