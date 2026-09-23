# FLY-2808 节点生命周期源码审计 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-22
基于: exploration.md

## 结论与证据等级

当前 parked 表达活进程等待；它不证明阶段完成、会话可恢复或进程已释放。应保留自报入口，新增控制器确认的载体记录，由同一份记录驱动探活、消息、TURN 和显示。工作流节点结果仍由原完成事务决定。

源码基线 abce27a27；产品源固定于 25cf13506eb818c59ef2d8a66622cc65e927d399，见 exploration.md。以下是源码事实，不是生产验证。产品原型数据为上游观测，未在本单复跑。上游 Claude 冷恢复用了 --fork-session，不能直接证明生产“同会话身份”；Codex 用 exec 探针也不能直接证明可见 TUI 生产路径。

## 六个打断点（重新定位）

| # | 当前消费者与事实 | 设计必须修改的边界 |
|---|---|---|
| 1 | TmuxAdapter.ts:1110–1148 waitForCompletion finally 将 CommDB 写 completed/timeout；CodexTmuxAdapter.ts:1827 起 controlled shutdown 同样写终态 | 引入 standby 退出原因；先验证释放回执，禁止把正常退下写终态或当完成事件再推进 |
| 2 | bridge/phase-actor-reentry.ts:35 classifyPhaseActorReentry：dead_pin→replace，持久目标 absent→replace | 先查控制器载体记录；确认待命则按原会话恢复；物理探活仍保留四态，不把待命冒充 alive |
| 3 | bridge/turn-belt-reconcile.ts:143 reconcileOneTurn：终态或不活判 stale，转授/删除；engineOwned 另有路径 | 逻辑持有人与物理进程分开；只因退下不得回收；合法 DAG 交接仍可转授；泛化 dispatcher 的 holder/launch 修复同步覆盖 |
| 4 | flywheel-comm/src/recipient-resolve.ts:112、session-terminal.ts:14：终态拒投；db.ts:4812 新消息 clearDeclaredState | 保持非终态；park 自报被清不能抹控制器回执；先排队后按需恢复，保留过期/取消及精确收件人校验 |
| 5 | HeartbeatService.ts:1036 readoptParkedPhase：只 alive 才接管，否则告警 | 无需求的已确认待命无进程为正常；只在需求到达后启动；不发监控丢失/重连成功假信号 |
| 6 | StateStore.ts:46921、58314 与 workflow-engine-dispatcher.ts:2060 将 dispatch 数目当盲换预算 | launchOrdinal 只排序，所有预算消费者改按目的计数；正常拉起、显式兜底、故障换人分账 |

表中省略包前缀：Tmux/Codex 位于 packages/claude-runner/src；其余非 comm 路径位于 packages/teamlead/src。上游给的 StateStore 行号已漂移，不照搬。

## 额外的真实消费者

- StateStore.projectGeneralizedCompletionTx（58872）：只有特定 needs_review/land/creates_pr/keepalive_park 情形保留 ship_parked；其它节点 completed。这是所有节点一致性的入口，不可只改 adapter。
- StateStore.applyTerminalTimestamp（15315）：设置 terminal_at 并撤销未消费 submission credential。先终结后“改回 running”会破坏权限，不允许作为迁移方式。
- generalized-workflow-rework-coordinator 的终态前置判断直接进入 replacement_pending；需与 phase-actor-reentry 一起改。
- config/src/node-type-registry.ts 的 keepalive_park 及冻结的 workflow snapshot 是当前能力来源；只改默认 registry 不会改变已启动 run。新增版本能力需在启动时冻结并由 controller/adapter/消费者共同支持。
- CodexTmuxAdapter.resumeExistingExecution:735 使用 launch snapshot、executionOwners 和 recovery commit hooks；优先复用，但必须区别 standby 与 crash recovery 原因。
- CodexTmuxAdapter:1593/2111 的缺失 thread ID 可回落 fresh；codex-daemon-client.ts:487 resumeThread 在服务端不返回 ID 时用请求 ID 兜底。这不是身份确认，standby 路径必须拒绝缺失/不等的返回 ID。
- codex session.json 原子 merge 保存 threadId、cwd、daemon 身份、keyed home 等，不能再建第二套 Codex handle 真源。resume manifest 引用该文件与已验证内容摘要。
- TmuxAdapter:499 先生成 claudeSessionId；1316 明确忽略 previousSession。要在会话建立时保存并验证实际 session id，不能仅在进程退出的 AdapterExecutionResult 保存。
- CommDB session_identity_epoch（db.ts:1732 起）因 session/park 行变化递增，是投递身份新鲜度，不是进程互斥锁。不能将其当原子“只有一个身体”的证明。
- workflow_execution_runtime 是 append-only 配置绑定，有 no_update/no_delete 触发器；载体状态不能写进它，另设最小一行状态表并复用 workflow_run_event 留痕。
- 既有 workflow-resume-resolver.ts 是持久工作产物/故障替换 admission；不能因名称同为 resume 就把新会话重做算原对话恢复。
- 正常待命需保留工作目录、分支、transcript 与 Codex home 内容；终态 worktree/branch/窗口清理不能提前消费待命。释放 credential lease 和清理 transcript 是两件事。

## 复用与不复用

复用 SQLite 事务、现有事件/outbox、execution owner、按需求投递、同 execId 的 Codex 恢复、标准原子文件 rename。复用已有 writer replacement 来做有标识的兜底，不复制另一个调度器。新增仅限载体状态和恢复证据、Claude handle、预算目的与显示字段。

不能复用 terminal shutdown 的 completed 写入作为 standby ACK；不能用队列 ACK、窗口名字、环境变量 model、exit 0、模型说“我记得”单独证明身份/权限/消费。

## 测试落点与不足

已有测试：claude-runner/test/{TmuxAdapter,CodexTmuxAdapter}.test.ts；flywheel-comm/src/__tests__/{declare-state,recipient-resolve}.test.ts；teamlead/src/bridge/__tests__/turn-belt-reconcile.test.ts；teamlead/src/__tests__/HeartbeatService.fly1329-readopt-parked.test.ts、workflow-engine-dispatcher.test.ts。扩展这些最邻近测试，并新增载体事务测试与两 vendor 真载体隔离验收。

本单只验证设计/HTML；实现单必须先加失败用例再写最小实现。产品 11 秒/66 秒观测不是 SLA，Claude 大 transcript 上界未证。本设计定义 180 秒单次恢复超时、排队时间单列；N5 实测后可经配置调整，不能默默换模型绕过。
