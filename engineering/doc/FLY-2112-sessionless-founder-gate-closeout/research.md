# FLY-2112 无会话 founder gate 收口 — 调研
Issue: FLY-2112 (https://linear.app/geoforge3d/issue/FLY-2112/病根-卡绑定的产物已落地run-仍-active-卡在-founder-gate陈年-ship-卡从未作废yes误批风险常驻-18)
日期: 2026-09-06
基于: exploration.md

## 1. 结论

最小完整修复是一个 StateStore-authoritative 的周期对账器：先用有界查询找出
“engine-owned active run + current review gate + awaiting holder + 零非终态归属 session”候选，
再在单事务内重新验证并同时终结 node/holder/ship binding/run；事务外通过可重放的
CommDB retirement 清掉 answerable question，并复用现成 card-void worker 改 Discord 卡。

只接 Linear Done、PR merged、terminal session 或 Discord 卡编辑中的任一个入口都无法覆盖
FLY-1699 这类“issue 未完成但整个 run 已无 runner”的实例。

## 2. 数据模型与现行原语

### 2.1 Run 与归属 session

- `workflow_run` 的活跃主键约束是 `(project_name, issue_id) WHERE status='active'`。
- `workflow_run_node` 保存 `(run_id,node_id,attempt,state,execution_id,ended_at)`。
- `StateStore.listRunAttributedExecutions(runId)` 合并三个来源：`workflow_run_node`、
  `workflow_side_effect_ledger`、`workflow_execution_binding`，可避免只看最新 node 漏掉
  parked design/implement/QA holder。
- `OPERATIONAL_TERMINAL_STATUSES` 是 StateStore 现行“session 不再存活”的统一词表；
  `liveRunAttributedExecutionsTx()` 已在 operator close/run collection 使用同一判据。

因此 candidate 与 commit guard 应复用这套归属与终态词义，不再发明 issue-level
`sessions.issue_id` 近似查询。

### 2.2 Gate holder 与 Discord 卡

`supersedeWorkflowGateHoldersTx()` 已封装正确的 holder 状态转换：

- 保存 `superseded_from_state`；
- `state → superseded` 并写 `superseded_reason`；
- 已有 `card_message_id` 时 `card_void_state → pending`；
- 清零 normal/transient retry 并清 `card_void_next_at`。

`voidSupersededWorkflowGateCards()` 每个 GatePoller tick 处理 pending：

- 成功或 Discord 404 → `done`；
- timeout/429/5xx → 60 秒后重试；
- 永久错误/预算耗尽 → `failed` + Lead alert；
- 成功 void 后短期 watch canonical founder 的 ✅，发现陈年输入会告警。

新增收口不得复制这些机制，只需要产生 durable pending，并给
`voidedWorkflowGateCardText()` 增加“run 已无活 runner、不会自动出新卡”的准确文案。

### 2.3 CommDB gate

`CommDB.retireGateForTerminalAuthority()` 是现成的 answerability CAS，支持
`approve_to_ship` 与 `founder_review`：

- 无 response 时置 `relay_state='terminal_disposed'`；
- response 并发获胜时返回 `response_won`，不抹历史；
- 重放同 reason 返回 `already_retired`。

现有 `TerminalGateRetirement.pass()` 对 authoritative workflow holder 明确保留，避免
“producer session 结束”误杀合法 gate；只有带新鲜 Linear/merge authority 的专用方法才
处理 founder review。因此 FLY-2112 不能指望现有 terminal-session sweep 自动清 question。

新增 reason 应是 `superseded_run_sessionless`，不要借用
`superseded_session_terminal` 掩盖 run 级事实。

## 3. 安全谓词

### 3.1 Candidate 预筛

稳定 `(run.created_at, run_id, question_id)` 顺序、默认最多 20 条：

1. `run.engine_owned=1 AND run.status='active'`；
2. `run.current_node_id=holder.gate_node_id=node.node_id`；
3. `node.attempt=holder.attempt AND node.state='review' AND node.ended_at IS NULL`；
4. `holder.state='awaiting_review'`；
5. 对 run 的归属 execution 不存在 status 非 operational-terminal 的 session；
6. 不存在 `dispatch` side effect 仍是 `intent_recorded|launch_committed`；
7. 不存在该 run 的 rework delivery 仍是
   `pending|turn_granted|awaiting_receipt|wake_delivered|replacement_pending`。

不要求 Linear Done，不要求 PR merged，也不要求 card 已成功 post；这些都不是“run 是否还有
执行载体”的真相。

### 3.2 Transaction 内 commit guard

public mutation 接收精确 `(runId,questionId,now)`，事务内重读上述全部条件。任何一项漂移
都返回明确 refusal，不做部分写。通过后同事务：

1. 当前 node `review → superseded`，`ended_at=now`；
2. 当前 ship-target binding `superseded_at=now`；
3. holder 用既有 helper 置 `superseded_reason='run_sessionless'`；
4. open carrier delivery 用既有 cancel helper 收口；
5. run `active → terminated`；
6. settle engine park ledger；
7. 追加唯一 `run_terminated_sessionless_gate:<runId>:<questionId>` 审计事件。

重复调用若发现同一审计事件且 run/node/holder 已处目标终态，返回 idempotent replay；
同 event id 但状态不一致则 fail closed。

## 4. 跨库恢复协议

StateStore 是 authority commit，CommDB/Discord 是派生表现层，顺序必须是：

1. StateStore 原子收口；
2. retirement worker 读取 `superseded_reason='run_sessionless'` 且没有 mailbox-outcome
   事件的 holder；
3. 调 `retireGateForTerminalAuthority(reason='superseded_run_sessionless')`；
4. 对 `retired|already_retired|response_won|missing` 都把明确 outcome 追加为 run event；仅
   throw/数据库不可用时不写 outcome，下一 tick 重试。

这样 Bridge 可在 StateStore commit 后任意位置崩溃：重启后 pending-retirement 查询仍能
重建剩余动作。`response_won` 保留 founder 输入历史，但 terminal run + superseded holder
不会再把它变成 ship authority；outcome 让巡检可见该竞态。

Card void 的恢复已经由 `card_void_state='pending'` 提供，不再新增 ledger。

## 5. 周期接线

把 `reconcileSessionlessWorkflowFounderGates()` 放进现有
`workflowGateMaterializeTick` single-flight，顺序为：

1. sessionless StateStore closeout + CommDB retirement；
2. `voidSupersededWorkflowGateCards()`；
3. 新 holder materialization；
4. voided-card watch。

该顺序允许同 tick 把新 superseded 卡直接交给 void worker，并保证旧 zombie 先失去 authority，
不会与同 tick materialization 竞争。对账器每项独立捕获错误，坏一条不阻塞同批其他项。

## 6. TDD 覆盖矩阵

### 6.1 StateStore

- 正例：无 session 行；全部归属 session 已 terminal；Linear 状态不参与；
- 写后：run terminated、node superseded+ended_at、holder superseded+pending void、ship
  binding superseded、carrier/park 收口、唯一 event；
- 重放：同输入幂等，无重复 event；
- 负例：任一 running/design_done/awaiting_review/ship_parked/approved_to_ship/pending
  session；非 current gate；node 已 ended；holder materializing/approved/superseded；
  pending launch；in-flight rework；非 engine-owned；held/completed run；
- 竞态：scan 后新增 live session或 rework，commit refusal 且所有状态不变；
- batch limit 与稳定排序。

### 6.2 Reconciler / CommDB

- 首次 pass 收口并退休 question，写 outcome；
- StateStore 已收口但 outcome 缺失（模拟 commit 后 crash）可续跑；
- CommDB throw 时不写 outcome，下一 pass 成功；
- `response_won` 留 response 且记录竞态 outcome；
- 一个 candidate 失败不饿死后续 candidate；
- 没有 candidate 时零写。

### 6.3 Presentation / wiring

- `run_sessionless` void 文案明确“无活 runner / 本卡不能批准 / 不承诺新卡”；
- 结构测试锁死 sessionless reconcile 在 card void 与 materialization 之前；
- 原有 founder feedback、land rework、equivalent head 文案逐字行为不变。

## 7. 验证与回滚

- 聚焦：新增 StateStore/reconciler/card lifecycle/wiring tests；
- package：teamlead 与 flywheel-comm tests + typecheck/build；
- 全仓：`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`；
- 迁移：无新表/列，只扩展字符串 reason 与 append-only event，不需要 schema rollback；
- 行为回滚：移除 tick 接线即可停止新 mutation；已 terminated/superseded/void 的事实不可也不应
  自动复活，需 operator 明确重开新 run。
