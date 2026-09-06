# FLY-2112 无会话 founder gate 收口 — 实施计划
Issue: FLY-2112 (https://linear.app/geoforge3d/issue/FLY-2112/病根-卡绑定的产物已落地run-仍-active-卡在-founder-gate陈年-ship-卡从未作废yes误批风险常驻-18)
日期: 2026-09-06
基于: research.md

## 1. 锁定范围与完成定义

实现一个默认启用、周期重放、StateStore-authoritative 的 sessionless founder-gate
closeout。只处理 engine-owned active run 的精确当前 gate；Linear issue 状态不参与判定。

完成时必须有可执行证据证明：

- 零非终态归属 session 的当前 awaiting-review gate 会原子收口为
  `node=superseded+ended_at`、`holder=superseded`、`run=terminated`；
- 已发卡进入现有 `card_void_state=pending → done|failed` worker；
- CommDB question 最终退出 answerable 集，或把已经存在的 response 竞态明确记账；
- 任一 live session、pending dispatch、in-flight rework、非当前 gate 或非 active/engine-owned
  run 都绝不被收口；
- 重启/重放不会重复 mutation，也不会因单条坏数据饿死其他候选；
- 全仓必跑 gates 通过并完成独立 code review。

## 2. TDD 切片

### Slice A — StateStore candidate 与原子 closeout

**先写失败测试**：新增
`packages/teamlead/src/__tests__/StateStore.sessionless-founder-gate-closeout.test.ts`。

测试 fixture 直接构造 production-shaped `workflow_run`、current review node、awaiting holder、
posted card、ship target binding、可选 session/dispatch/rework 行。RED 必须至少证明：

1. no-session 正例当前没有任何 closeout API；
2. terminal-only sessions 也算 sessionless；
3. 每个 live status 都 veto；
4. scan 后新增 live session / rework 会让 commit CAS 拒绝；
5. pending dispatch、非 current gate、ended node、wrong holder state、legacy/non-engine run 都
   veto；
6. batch limit 和稳定顺序；
7. 同一 `(runId,questionId)` 重放只保留一个审计事件。

**最小实现**：在 `packages/teamlead/src/StateStore.ts` 增加：

- `WorkflowSessionlessGateCandidate` 类型；
- `listSessionlessWorkflowGateCandidates(limit=20)`；
- `terminateSessionlessWorkflowGate({runId,questionId,now})`；
- `listPendingSessionlessGateMailboxRetirements(limit=20)`。

候选与 commit 共用同一个私有 exact-shape 查询/判定 helper，防止预筛和 mutation 语义漂移。
commit 在一个 StateStore transaction 内按顺序：

1. 重验 run/node/holder/session/dispatch/rework；
2. `workflow_run_node.state='superseded', ended_at=now`；
3. `workflow_ship_target_binding.superseded_at=now`；
4. 调 `supersedeWorkflowGateHoldersTx(reason='run_sessionless')`；
5. 调 `cancelOpenWorkflowCarrierDeliveriesTx(...operator_terminate)`；
6. `workflow_run.status='terminated'`；
7. settle terminal parks；
8. append checked event
   `run_terminated_sessionless_gate:<runId>:<questionId>`，kind 同名，payload 只含稳定身份和
   reason，不含每次变化的 wall clock。

拒绝返回结构化 reason；不 throw 普通竞态。成功后 `save()` 一次。event 已存在时必须逐项核
终态形状才返回 `idempotentReplay=true`，不一致 fail closed。

### Slice B — 跨库 retirement reconciler

**先写失败测试**：新增
`packages/teamlead/src/bridge/__tests__/sessionless-founder-gate-reconciler.test.ts`。

RED 场景：首次收口、StateStore-commit 后 crash/restart、CommDB throw 后重试、
`response_won`、`missing`、一条失败不阻塞后一条、空 pass。

**最小实现**：新增
`packages/teamlead/src/bridge/sessionless-founder-gate-reconciler.ts`，导出
`reconcileSessionlessWorkflowGates(deps)`：

1. 扫 `listSessionlessWorkflowGateCandidates()` 并逐条调原子 closeout；
2. 再扫 `listPendingSessionlessGateMailboxRetirements()`；
3. 按 project 打开/复用 CommDB，调用
   `retireGateForTerminalAuthority(reason='superseded_run_sessionless')`；
4. 对所有非 throw 的 terminal outcome，通过
   `appendWorkflowRunEventChecked()` 写
   `sessionless_gate_mailbox_retired:<runId>:<questionId>`，payload
   `{questionId,outcome}`；
5. open/retire/event 任一步 throw 只 log 并留 pending，下 tick 重试；继续同批后续项。

StateStore mutation 是 revocation cutoff。若 CommDB 已有 response，保留历史并记录
`response_won`，但不得复活 terminated run 或 superseded holder；这个选择优先消除陈年
“yes”变成 ship authority 的风险。

在 `packages/flywheel-comm/src/db.ts` 给 retirement reason union 加
`superseded_run_sessionless`，并在现有
`packages/flywheel-comm/src/__tests__/terminal-gate-retirement.test.ts` 加幂等覆盖。该变更只扩展
输入枚举，不删除/改名 CLI 或外部命令。

### Slice C — Card 文案与生产接线

**先写失败测试**：

- 在 `StateStore.workflow-gate-card-lifecycle.test.ts` 增加 `run_sessionless` 文案快照；
- 扩展 `workflow-gate-card-lifecycle-wiring.test.ts`，锁死
  `reconcileSessionlessWorkflowGates → voidSupersededWorkflowGateCards → materialization → watch`
  顺序。

**最小实现**：

- `workflow-gate-card-lifecycle.ts` 新 case：明确 run 已无活 runner、本卡已作废、任何批准不会
  ship；不承诺自动出现新卡；
- `plugin.ts` import reconciler，并在现有 `workflowGateMaterializeTick` single-flight 的最前
  面调用；用现有 `commDbPathForProject`、同一 `store` 和现成 logger；
- 不新增 timer、不新增 feature flag、不修改 card void 重试策略。

## 3. 并发与故障不变式

1. **Live wins before commit**：StateStore transaction 内看见任何非终态归属 session 或
   in-flight launch/rework 就拒绝，零部分写。
2. **Revocation wins after commit**：commit 后迟到的 CommDB response 只留审计，不能重开
   holder/run。
3. **StateStore before external writes**：先落 authority 终态，再 retire CommDB、void
   Discord；绝不靠 Discord 成功决定数据库真假。
4. **Crash replay**：没有 mailbox outcome event 的 `run_sessionless` holder 永远重新入列；
   `card_void_state=pending` 由既有 worker 永远重新入列。
5. **Bounded and non-starving**：两个 scan 各 limit 20、稳定顺序；per-item catch，坏项不阻塞
   同批后续；下 tick 从仍 pending 的 durable state 重建。
6. **No false completion**：run 只进 `terminated`，不写 Linear Done、不造 merge/ship claim。

## 4. 现有路径影响表

| 路径 | 是否改动 | 结果 |
|---|---:|---|
| 正常 founder 批准 + live parked carrier | 否 | live-session veto，字节行为不变 |
| Founder feedback / land rework / equivalent-head | 否 | 继续用原 supersede reason 和原文案 |
| Linear Done / external PR merged gate retirement | 否 | 继续由 TerminalGateRetirement + fresh authority 处理 |
| 普通 terminal source session | 否 | 现有 approve-to-ship retirement 保持；本单只看 run 级 exact gate |
| Engine run 的全部归属 session 终态/缺失 | 是 | current gate/run 收口，question/card 失效 |
| Held/completed/terminated run | 否 | candidate 排除；pending mailbox/card 派生动作仍可续跑 |

## 5. 验证顺序

每个 slice 严格走 RED → GREEN → refactor，并分别提交：

1. 聚焦 Vitest：新增两个 test 文件 + flywheel-comm retirement + card lifecycle/wiring；
2. `pnpm --filter flywheel-teamlead typecheck`；
3. `pnpm --filter flywheel-comm test:run` 与 `pnpm --filter flywheel-teamlead test:run`；
4. 精确全仓 gates：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；
5. 本 PR 不新增 `scripts/__tests__/*.test.sh`，因此无新增 shell gate；
6. 检查 inbox，更新 progress；
7. 通过 `codex:rescue` 运行 code review，注册 `review_code` gate；blocking finding 修复后必须
   新开一轮；
8. 创建 `engineering/doc/milestones/FLY-2112.md` 作为 literal last commit；push 并开 PR；
9. `complete --route needs_review --pr <NUMBER>`，不 dispatch QA、不 merge、不请求 ship。

## 6. 回滚与遗留

- 回滚新 tick 接线可立即停止未来自动收口；
- 已产生的 terminated/superseded/void 是真实 revocation，不自动逆转；如 operator 判断错误，
  应显式新建/重开 run 与新 gate，不能复活旧批准卡；
- 存量 9 条无需单独数据脚本：部署后的周期 scan 自动分批收掉；
- 本单不删除 terminal rows、不改 retention、不改 Linear status。
