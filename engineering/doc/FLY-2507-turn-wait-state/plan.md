# FLY-2507 TURN 等待状态 — 实施计划
Issue: FLY-2507 (https://linear.app/geoforge3d/issue/FLY-2507)
日期: 2026-09-10
基于: research.md

## 锁定行为

仅当实时 StateStore 证明等待体的 execution binding 属于当前 TURN 的 run，且 run.current_node_id 为 founder_gate / land，或 run.status 为 completed 时，停止生成新的 TURN handoff overdue 问题。使用当前 binding（唯一且对应 node/attempt），避免同 issue 的旧 run 或陈旧 activation 误抑制。既有问题不撤回、不回答。

implement / qa 等实际交接阶段继续保留阈值和每 waiter/holder/epoch 一次的告警。缺少 workflow 元数据、旧 schema、run 不匹配或读取失败时保留既有逻辑；错误输出 stderr，不能伪造正常停驻或改变 TURN stdout/退出码。debug override 不读取/修改等待状态。

## 最小实现

1. 复用已安装 better-sqlite3 和 resolveStateDbPath，在 TURN 命令调用链注入一次按需的只读状态判断；连接须 finally close，fileMustExist，参数化查询。无需新表/迁移、网络 API、依赖、后台同步或 schema 镜像。
2. 在 observeTurnWait 的超阈值未发问路径、insertQuestion 之前调用判断；抑制时不产生 question、不写 asked_at。保持原有事务与确定性 ID。既有 ledger、去重、grant/no-turn 清理合同保持不变；回退到 implement/qa 后可恢复告警，新 epoch 仍有独立计时。
3. 仅生产 runTurn 注入该实时读取，库调用者可注入 fixture reader；reader 本身用真实临时 SQLite 表验证。冻结 activation、session 自报 parked、持有者是 QA 均不能独自触发抑制。

## 验证与交付

严格 TDD：先以 founder_gate 等待超过阈值仍生成问题证明 RED，再最小修改 GREEN。

覆盖 founder_gate / land / completed 无新问题；implement / qa 正常一次告警；reopen/replay；等待中进入 gate；gate 回退 implement 与换 epoch 恢复；同 issue 不同 run、缺失 binding/run/节点、重复绑定、旧 schema/不可读库不误抑制；已 asked 不改写、debug override 零副作用。

运行 pnpm lint、pnpm -r build、pnpm test:packages:run，以及新增 shell 测试（若有）。记录失败真实范围，不能用聚焦绿代替全仓绿。无需生产迁移；临时 SQLite reopen 和撤回状态转换覆盖持久化/回退。无渲染界面，无视觉证明要求。

完成后注册 cross-family code review，修 blocking finding 后新轮审查；以 milestones/FLY-2507.md 为开 PR 前最后 commit。仅 feature branch push，报告后 complete --route needs_review --pr NUMBER 并按 keepalive 合同 park。QA、merge、deploy 由后续节点负责。
