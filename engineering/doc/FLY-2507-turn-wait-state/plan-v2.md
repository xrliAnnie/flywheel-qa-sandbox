# FLY-2507 TURN 等待状态 — 实施计划
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: research.md、plan.md 第一轮审查

## 范围与判据

只修 turn-wait 的新问题生成；不改 patrol、wake、ship、runner 生命周期或生产数据。第一轮 HIGH gate-window-silences-post-approval-runner-handoff 成立：founder_gate 节点名不是正常停驻证明，runner_ship 批准后仍可能保持同名节点并等待 carrier TURN。

按当前 TURN.target_run_id 限定 run，并从 workflow_execution_binding / workflow_run_node 读取等待 execution 的当前绑定（该 run、node 的 MAX(attempt)，节点 execution_id 必须匹配）。多次返工绑定是正常正向用例；跨 run、缺失当前节点、旧 attempt 不作为停驻证据。

抑制须同时满足：等待体当前节点已完成；run 无任何未 completed 的 workflow_carrier_delivery 或 workflow_rework_delivery；且满足以下其一：
- run.status=active，当前 gate 的最新 attempt 对应 workflow_gate_holder.state=awaiting_review。这是等待 founder 的状态证据，不凭节点名称或自报 park。
- run.status=active，当前节点为 land，且已 approved 的 gate holder.authority_mode=land，证明合入由引擎接手，不存在 runner_ship 的 TURN 交接。未完成 land_operation 属于引擎工作，继续由既有 land/patrol 观察；不改变该告警族。
- run.status=completed。

held、terminated、未知状态以及 approved 的 runner_ship（含 pending/held carrier）均保留原告警。遗留 gate_carrier_epoch=0 缺失 holder 证据时保留原告警。待 founder 不设人为时限：用户未批准不是交接逾期。gate 回退实现、产生 rework/carrier 后立即退出抑制；新 epoch 保持原独立时钟。已发问题不撤回、不自动回答。

## 实现

复用 better-sqlite3 与 resolveStateDbPath。runTurn 增加 --state-db，隔离环境必须显式提供 StateStore 路径（--state-db 或两个既有环境变量）；自定义 CommDB 路径/根目录却没有 StateStore 覆盖时不读取默认生产库，保留原逻辑并 stderr 诊断。默认生产组合仍使用既有默认路径；run/issue 身份核对防止错配。

只在 not-yours 正式自查路径判读，debug override 零读取/写入。StateStore 连接 readonly + fileMustExist，参数化查询，单次只读事务保证多表一致，try/catch/finally 关闭，失败诊断且保留原告警。必须在 CommDB immediate 写事务前完成读取，将布尔抑制结果传给 observeTurnWait。无新表/列/依赖/API；抑制不写 asked_at，保留既有 wait ledger 与 question 原子去重。诊断 stderr 带 run/等待 execution/抑制原因，作为实际判读证据，不把正常抑制写成 last_error。

## 与既有 patrol 的关系

patrol-loop-ledger.ts judgeLoopLight 用 awaiting_review、carrier/rework、land 等事实判断「整个循环还有进展来源」；本修复判断「这个等待体是否还应获得 TURN」，两者职责不同。复用相同源表状态词，但不把 patrol 整包引入 comm（依赖方向相反），也不改 patrol 行为。特别是 carrier 存在时 patrol 可显示 not_triggered，而 runner 逾期仍应保留，二者不要求全局等价。测试钉住本次 awaiting_review 正常停驻的两侧均不报红/问询；carrier 交接负向必须仍可问 Lead。

## TDD 与交付

先写 founder awaiting_review 且实现节点完成、超时仍生成问题的 RED，再最小实现 GREEN。真实临时 SQLite 夹具覆盖：awaiting_review/engine land/completed；节点未完成；多 attempt 绑定；carrier pending/held 与 approved runner_ship；legacy epoch=0；held/terminated；rework；同 issue 跨 run；缺失 binding/run/node、旧 schema/不可读库；路径隔离；debug override。覆盖 reopen/replay、等待中入 gate、gate 回退、新 epoch、已 asked 不改写；通过 stderr 断言证明抑制分支被执行。

运行 pnpm lint、pnpm -r build、pnpm test:packages:run 及新增 shell 测试（若有）。不以聚焦绿替代全仓绿。无需迁移；数据库 reopen / 状态回退为持久化与回退验证。无渲染界面。

注册 cross-family code review；阻断项修复后新轮。开 PR 前 literal 最后一 commit 为 engineering/doc/milestones/FLY-2507.md。feature branch push、报告、complete --route needs_review --pr NUMBER，再按 keepalive 合同 park。QA/merge/deploy 由后续节点负责。
