# FLY-2080 巡检推进与病根记账 — 调研
Issue: FLY-2080 (https://linear.app/geoforge3d/issue/FLY-2080/巡检升级-发现即补账推进-病根记录进-epic所有-lead-巡检强制两步founder-8-26-直令)
日期: 2026-08-26
基于: exploration.md

## 1. 现有巡检合同

`packages/teamlead/lead-rules-base/runner-patrol-rules.md` §0 已经固定：

- 检测范围是整机 canonical Runner panes，处置范围仅限 Lead 名下 Runner；
- `patrol_tick` 只是闹钟，巡检依赖 tmux、CommDB、StateStore、GitHub 与 Discord 独立信源；
- 每 tick 一份六步报告，六个 STEP 只能定稿为 `OK | FINDING | UNAVAILABLE(...)`；
- STEP 2 的 `PANE_EVIDENCE` finding 从 `action=REQUIRED result=UNSET` 起步；
- STEP 6 负责有界修复、跨界上报、UNAVAILABLE 建单与最终 gate。

缺口只在“发现之后”：没有要求读源码守卫、没有真实性/漏账分流、没有统一 finding 结果值域、没有 FLY-2072 病根记录。无需改快照脚本、检测 SQL、频率或六步结构。

2026-08-26 19:42/19:43 founder 在 FLY-2080 thread 追加总 goal：每个 Lead 要把 orchestrator 一直推到每个 issue 到达 Ship card，只有真正必须由 founder 回答的问题才可停；founder 派事后应能休息，回来时工作已经推进到可 review。A/B 不是额外文书，而是达成这个 goal 的推进与学习闭环；规则开头必须逐字引用两段原话。

## 2. FLY-2072 活样本

2026-08-26 的病根③ comments 给出三层事实：

1. `awaiting_receipt` 的返工可能由 Lead `send` 旁路完成；引擎只认 wake→receipt 剧本，receipt 永不到，最终把 delivery 与 run 一起置 `held`，活体 `complete` 被 `409 transition_refused`。
2. 死体替换时，引擎可能已经 reserve 新 execution，但新 dispatch 缺少 replacement identity；dispatcher 退回普通 predecessor 分支，报 `engine_predecessor_unavailable`。
3. 手动只拨一笔会撞下一道 CAS 或 `rework_pause_context_changed`；8-26 实测止血必须把同一事实的多本账一起补齐，并在补后观察 Bridge 接力。

这不是“通用解锁 held”的授权。评论同时证明，有些门是防篡改守卫；例如 digest/authority/context 变化时必须停手，不可把“缺一行”当作漏账。

## 3. 源码守卫与账本

### 3.1 receipt 死结

`StateStore.ts`：

- `workflow_rework_request(request_id, run_id, authority_context_digest, ...)` 绑定请求与 run；
- `workflow_rework_route_revision` 是 immutable，`workflow_rework_delivery.route_revision` 必须指向同请求的一版 route；
- `workflow_rework_delivery.state` 包含 `awaiting_receipt | wake_delivered | held`；
- `escalateWorkflowReworkStall()` 在 60m hold 时同一事务执行 `workflow_run active→held` 与 delivery 活跃态→`held`，并写 `last_error`；当原错误没有更具体值时，dispatcher 使用 `delivery_<state>`，本样本是 `delivery_awaiting_receipt`；
- 正常 `recordWorkflowReworkWakeReceipt()` 要求 activation、TURN epoch、route、execution 全部一致，随后 delivery `awaiting_receipt→wake_delivered`，并把 admitted node/path 激活。

8-26 样本已经绕过正常 receipt 入口：真实工作由同一活体完成，但 receipt 剧本没有发生。因此止血条件必须至少同时证明：

- exact request 的 latest route、delivery 与 run 仍一一相连；
- `run.engine_owned=1 AND run.status='held'`；
- `delivery.state='held' AND last_error='delivery_awaiting_receipt'`；
- pane/commit/执行体证据证明 target actor 确已收到并完成返工，而不是伪造 receipt；
- 联合事务恰好更新 delivery 一行和 run 一行，否则 rollback。

### 3.2 replacement 铸造漏账

`workflow-engine-dispatcher.ts` 的 exact guard：

- 只有 `workflow_side_effect_ledger.reason` 以 `rework_replacement:<requestId>` 开头，才进入 replacement context；
- replacement context 逐项要求 request/run、route node/attempt/execution、delivery route revision、`delivery.state='replacement_pending'`、40-char base revision 全一致；
- 缺 replacement context 时，非首 attempt 回到 predecessor 解析；找不到 predecessor session 就抛 `engine_predecessor_unavailable`；
- predecessor 链只从 `edge_traversed.payload.successorExecutionId` 或 `execution_dead_rolled_back.payload.newExecutionId` 回溯。

`StateStore.materializeWorkflowReworkReplacement()` 正常路径在同一事务完成：

1. dispatch ledger 的 `reason='rework_replacement:<requestId>'`；
2. target `workflow_run_node` 指向新 execution；
3. append immutable `workflow_rework_route_revision`，`preferred_actor_execution_id` 指向新 execution；
4. delivery 与可选 verification path 的 `route_revision` 切到新 revision，delivery 保持 `replacement_pending`；
5. 写 `execution_dead_rolled_back`、`rework_replacement_materialized` 与 resume evidence。

人工补账不能重造 actor 身份或授权。可执行配方应要求新 execution 已由引擎 reserve，且 `workflow_actor`、`workflow_run_node`、dispatch ledger 已存在并完全同一 node/attempt；正常 materializer 还会写 dead-watch、route、delivery/path、`execution_dead_rolled_back`、`rework_replacement_materialized`、resume evidence/attachment 等联动账。配方只能补已经发生、而引擎漏记的事实；任何 guard 不一致都停手。

dispatcher 在完整 `rework_replacement:<requestId>` context 存在时直接以该 context 解本次 replacement 的 start point。但后续 generic writer replacement 的 dispatch reason 为空，会沿 `execution_dead_rolled_back.payload.newExecutionId` 逐级回溯，最后仍需要最初 QA fail 的 `edge_traversed.payload.successorExecutionId` 才能找到 predecessor。8-26 活账正是 `new execution → dead rollback 链 → 初始 target execution`，而初始 edge 缺失；因此 event 分支有用，但只允许在 source QA fail、target attempt、edge id 与 successor execution 均有唯一既存证据时补一条 deterministic event，禁止猜 edge 或 clone 任意相似 row。

## 4. 权限边界冲突（design R1）

`founder-only-authority.md` R5 的 authorized registry 当前明确为 `None`。design R1 因此把原计划判为 governance conflict；Tadashi 随后在 question `3383d52a-b267-4f9a-a6fd-0826f6bc6dbb` 裁定，本单不扩 R5、不把每次巡检重新变成请示，而以三次记录在案的 founder 直令作为这类 missing-ledger repair 的权威来源：

- 2026-08-19，FLY-1894 所录 FLY-1877 ship 后清理现场：「这个东西你为什么要等我 你自己做决定就可以」；
- 2026-08-23，FLY-2072 病根记录所引现场：「拨 这个你可以自己决定 不需要问我」；
- 2026-08-26 19:13，FLY-2029 thread：「自己去 identify 发现了什么问题，把漏的账补上，让 Bridge 继续操作……让所有的巡检都带上这两个步骤」。

同一裁定写死四个边界：只补“引擎漏写、补上即真”的 ledger/route/delivery/event；真实性 guard 停手；永不写 authority/gate/approval/claim、永不终结 Runner 或丢工作；每次 before/after + FLY-2072。R5 registry 的正式合同 entry 另单处理，`runner-patrol-rules.md` 只注记这个 follow-up，不修改 universal contract。

另外，receipt 正常事务不仅写 delivery 与 run：它还把 `workflow_run_node admitted→running`、`workflow_rework_verification_path pending→active`，追加 `rework_delivery_wake_delivered` event 并清 recovered alert。held run 恢复路径还会 revive `workflow_carrier_delivery state='held' AND last_error LIKE 'run_inactive:%'`；只拨 delivery/run 会把 carrier 留死。replacement 正常事务同样有十余笔联动账，不能安全缩成三笔 raw write。

receipt 配方不是只拨 delivery/run：`workflow-rework-coordinator.ts` 要求 `delivery='wake_delivered'` 与 target node `state='running'` 成对，completion lookup 又只接受 verification path `state='active'`。8-26 exact shape 同一事务必须修 delivery/run/node/path/event，并 append 同 actor 的 next route revision、清 `hold_count`，避免旧 `rework_stalled_*:revN` receipt 永久屏蔽新 watchdog。event 真实写 `from='held'` 与 `fromReason='delivery_awaiting_receipt'`。carrier held row 仍是 fail-closed precondition。

replacement event 必须与引擎真实 `edge_traversed` schema 一样，并同事务补配套 `loop_iteration`。iteration 取 `COUNT(kind IN ('loop_iteration','loop_limit_escalated') AND edge_id=...) + 1`，不是 edge row 数。追加前还必须证明 predecessor session 存在且 `resolveWorkflowHeadAuthority` 返回 40-hex head。

## 5. “所有 Lead”的实际装载边界

多数 production CoS/infra id 实际走 dept 分支，已经装 patrol rule；geoforge3d literal `cos-lead` 走 Claude `IS_COS_ROLE` 分支而漏装。`claude-lead.sh` 与 full-access `lead-rules-bundle.sh` 是两套独立 map，本单须同时加 rule 并各自 pin test；这不改变 tick detection/cadence。

## 6. 病根 Epic 写入路径

Bridge 已有受 token 保护的接口：

- `GET /api/linear/comments?issueId=FLY-2072&limit=100[&after=...]`：分页读取完整 comment body、id、createdAt；
- `POST /api/linear/comment`：body 为 `{issueId:"FLY-2072", body}`，返回 `{ok, comment:{id,url}}`。

这里必须省略 `projectName`：live `projects.json` 的 Flywheel project 没有 Linear override；显式传 `projectName=flywheel` 会让 resolver 走不存在的 project-scoped client 并返回 404。精确 identifier `FLY-2072` 的 unscoped path 才是当前可执行地址。

因此步骤 B 无需加新 API。Lead 在写入前分页读 FLY-2072，按错误码、漏账表/字段与断裂剧本查先例；comment 固定四段：形状 / 根因 / 处置+接力证据 / 是否重复（有则引用 comment id/url，无则明确“未找到先例”）。报告保存返回的 comment id，才能证明记账已完成。

## 7. 报告完成门设计

现有 STEP 状态行没有 per-finding 结果字段。保持快照输出不变，由 Lead 在定稿时为每个 distinct finding 追加：

```text
FINDING step=<1-6> bridge_problem=<yes|no> result=<fixed|advanced|escalated-with-plan> evidence=<stable-token> owner=<agent:agent-id|founder|n/a> next=<bounded-verb:stable-token|n/a> epic=<FLY-2072#comment-uuid|n/a|unavailable> epic_marker=<64hex|n/a>
```

Gate 应同时证明：

- 每个 `STEP n: FINDING` 至少有一条同 step 的 `FINDING` 行；
- 只解析以 `FINDING ` 开头的 detail 行，不能误吃 `PANE_EVIDENCE ... result=` 或 `STEP n: FINDING`；
- 每条 `FINDING` 的 result 恰在三值域内；
- `bridge_problem=yes` 必须带真实 comment UUID 与复读后的 body SHA-256 receipt，`bridge_problem=no` 才允许 `epic=n/a`；
- Linear read/write/复读失败写 `UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable`，不能填一个任意非空 token 冒充 receipt；STEP 6 多 cause 用 `multiple_unavailable` 汇总状态行，detail 保留全部 cause；
- `known-waiting`、`known_waiting`、`waiting` 等结果因为不在 allowlist 自然失败。

`advanced` 表示 finding 已推进到下一可执行状态但尚未最终消失；`escalated-with-plan` 只用于防篡改/越权/跨界等不可当场修改的形状，必须写 owner、下一动作与证据。单写“已知，等着”三值都不成立。

## 8. 测试面

扩展 `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`，先写失败内容契约，随后改规则：

- founder 原话与步骤 A/B anchors；
- guard 分类、补后 pane/event 证据、禁止 known-waiting；
- FINDING 三值域与 FLY-2072 receipt gate；
- 两个 recipe 的表、字段、exact error/CAS anchors；
- `lead-rules-bundle.test.ts` 断言 `cos` 与 `dept` 都装同一 patrol rule；
- 既有 FLY-1855 检测面、六步、cadence 断言继续通过。
