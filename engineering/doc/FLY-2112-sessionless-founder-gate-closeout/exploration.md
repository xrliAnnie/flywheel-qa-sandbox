# FLY-2112 无会话 founder gate 收口 — 探索
Issue: FLY-2112 (https://linear.app/geoforge3d/issue/FLY-2112/病根-卡绑定的产物已落地run-仍-active-卡在-founder-gate陈年-ship-卡从未作废yes误批风险常驻-18)
日期: 2026-09-06
基于: 无

## 1. 问题与目标

当前存在一类 durable zombie：`workflow_run.status='active'`，当前节点是尚未结束的
gate，`workflow_gate_holder.state='awaiting_review'`，已经发出的 founder 卡还没有进入
void 生命周期；与此同时，这个 run 已经没有任何非终态的归属 session。Linear issue
是否 Done 不是可靠触发条件：FLY-1699 的 issue 仍是 In Progress，但 run 已经没有 runner。

本单目标是让引擎从自己的 run/session 真相层收敛这类状态：

1. 当前 gate node 进入 `superseded` 并补 `ended_at`；
2. 当前 holder 进入 `superseded`，已发卡进入既有 `card_void_state='pending'`；
3. 相关 ship-target binding 和未决 carrier delivery 失效；
4. run 进入诚实的 `terminated` 终态，而不是伪称工作已 `completed`；
5. 既有 card-void worker 最终把 Discord 卡改成 void；
6. 周期对账同时覆盖存量和未来复发，且并发重启/重放幂等。

## 2. 当前代码事实

### 2.1 已有能力

- `StateStore.supersedeWorkflowGateHoldersTx()` 已经实现 holder supersede：记录
  `superseded_from_state`，若 `card_message_id` 存在就把 `card_void_state` 置为
  `pending`，并重置重试账。
- `voidSupersededWorkflowGateCards()` 已经按 pending 行编辑 Discord 卡，404 也视为
  已收敛，并有暂态重试、第五次失败 fail-loud 和 void 后 founder 输入告警。
- `workflowGateMaterializeTick` 每个 GatePoller tick 都先跑 card void，再做新卡
  materialization，因此新产生的 pending void 不需要第二套 worker。
- `listRunAttributedExecutions()` 已统一枚举 run node、side-effect ledger 和 execution
  binding 的 execution id；`isOperationalTerminalStatus()` 是现行 session 终态定义。
- `TerminalGateRetirement` 只处理 CommDB gate：普通 approve-to-ship 可因 source
  session 终态退休，但 authoritative workflow holder 被明确保留；外部 Done/merged 路径
  依赖新鲜外部授权。它不会改变 StateStore 的 run/node/holder。

### 2.2 缺口

- `workflow_run` 没有“当前 gate 已无人承载”的周期 candidate scan。
- operator/cascade 终止路径虽可把 run 置 `terminated`，但它们不是本形状的触发面，且
  当前终止逻辑没有统一 supersede 当前 holder/card。
- 只按 Linear Done 或 PR merged 收口会漏掉 issue 仍 In Progress 但 runner 已全部消失的
  FLY-1699 类实例。
- 只退休 CommDB question 也不够：StateStore holder 仍 authoritative、card 不进入 void、
  run 仍污染 active 投影。

## 3. 候选形状

对账候选必须同时满足：

- run 是 engine-owned 且 `status='active'`；
- run 的 `current_node_id` 精确等于 holder/gate node；
- 当前 node 是 `state='review' AND ended_at IS NULL`；
- 当前 holder 是 `state='awaiting_review'`；
- run 的所有归属 execution 都不存在非终态 session；
- 没有 pending/active rework delivery 或仍可启动的 dispatch side effect。

候选查询只是预筛。真正 mutation 必须在同一个 StateStore transaction 内重读并重验全部
条件，防止 scan 与 commit 之间有 session/admission/rework 复活。

## 4. 语义选择

### 4.1 为什么是 terminated

无存活 session 只能证明 run 已失去执行载体，不能证明工作、merge 或 Linear 状态已完成。
因此 run 终态使用 `terminated`。这同时适用于 Linear Done 的外部收尾和 Linear In
Progress 的 runner 消失，不会伪造产品完成事实。

### 4.2 为什么复用 card void

Discord 写是跨系统 side effect，不能塞进 StateStore transaction。StateStore 只负责把
holder 原子 supersede 并铸出 `card_void_state='pending'`；现有 worker 从 durable pending
账继续执行、重试和告警。Bridge 重启后仍会重放，所以不需要新的 outbox。

### 4.3 CommDB question

StateStore 提交后，应 best-effort 调用现有 `retireGateForTerminalAuthority()` 退休同一
question，阻止它继续参与自由文本 gate 匹配。若 response 已经赢得 CommDB CAS，则记录
`response_won` 并留给 holder/run 的终态 authority guard 拒绝陈年批准；不得回滚已经完成的
StateStore 收口。下一轮可由 run event/holder 状态重试 CommDB retirement，保证跨库崩溃
可恢复。

## 5. 非目标

- 不把 Linear issue 自动改成 Done；
- 不把无会话等同于成功完成或自动 merge；
- 不重写现有 card void 重试与 founder-input watch；
- 不清理历史数据库行，不删除审计证据；
- 不处理仍有非终态归属 session、rework delivery 或 launch intent 的 run。

## 6. 主要风险

- **相间阶段误收口**：candidate 只允许当前 gate review 形状，并在 transaction 内重验
  nonterminal sessions、rework 和 dispatch；任何不确定都 fail-safe 跳过。
- **跨库半完成**：StateStore 是 authority commit；CommDB retirement 是可重放的派生动作，
  不能反过来先退休 question。
- **旧卡误批**：holder、ship binding、run 同事务失效；card void 与 CommDB retirement
  独立重放，缩短表现层风险窗口。
- **存量饿死**：scan 使用稳定顺序和有界 batch；每轮处理完整 batch，单项失败不阻塞同批
  后续候选。
