# FLY-2293 派发同步 Linear 开工态 — 探索
Issue: FLY-2293 (https://linear.app/geoforge3d/issue/FLY-2293/状态可信度-派发不可靠地置-in-progress11-个在跑-runner-里-6-张单仍是-backlogstartedatnull-按)
日期: 2026-09-04
基于: 无

## 问题边界

Runner 已经进入 Flywheel 非终态、并持续上报阶段时，Linear issue 仍可能停在 `backlog`，`startedAt` 仍为 null。CoS triage 以 Linear state 选取待派工作，因此这不是展示偏差，而会把活体工作重新派发。

本单只修“开工时同步到 Linear started 状态”。不处理僵尸 session、完成态收尾、triage 去重或新的调度子系统。

## 代码现场

- 旧 Linear webhook 路径在 `EdgeWorker.createLinearAgentSession()` 内显式调用 `moveIssueToStartedState()`；它会读取 issue/team workflow states，选择 position 最小的 `type=started` 状态并写 `stateId`。
- Bridge `/api/runs`、DAG design/implement/qa 与 retry 统一进入 `RunDispatcher → Blueprint.run()`，而这条路径没有调用上述逻辑。
- `Blueprint.run()` 的 `emitStarted()` 进入生产 `DirectEventSink.emitStarted()`；该 sink 先持久化 `status=running` session，再处理线程和通知。这里是所有 adapter/role 共用、且不会把尚未入册的 spawn 误标为开工的最窄落点。
- HTTP `/events session_started` 是双写/恢复入口；生产主路径是 `DirectEventSink`。本次先修生产共用 chokepoint，避免扩张为新的对账系统。

## 假设与约束

1. “开工”以 Bridge 已持久化 running session 为准；admission、preflight 或 worktree 尚未成功时不提前改 Linear。
2. 已经是 `type=started` 的 issue 幂等跳过，避免刷新历史 `startedAt`；这也保护题述“旧一轮遗留 In Progress”的掩盖情形不被误当成新写入成功。
3. 目标状态按 Linear workflow state type 解析，并在多个 started 状态中取 position 最小者，沿用现有 EdgeWorker 语义，不硬编码状态名或 ID。
4. Linear 外部失败不能回滚一个已入册 session；失败必须显式记录，后续可由现有事件重放或单独的可靠性工作处理。本单不新增队列、迁移或 daemon。

## 最小方案候选

- **选择**：抽出一个小型、可注入测试的 Linear started transition，并从 `DirectEventSink.emitStarted()` 在 running row 落盘后调用。
- 不选择 runs-route：DAG successor/retry 会绕过它。
- 不选择按 adapter/role 分支：`implement/codex` 与 `design/claude` 的共同缺口正是共用 sink 没有状态同步。
- 不选择在 triage 层排除：那会掩盖 Linear 事实错误，并让其他按 state 的消费者继续误判。

## 验收映射

- Backlog 前置：fake Linear issue 初始 `state.type=backlog`、`startedAt=null`。
- 写后：选择最低 position 的 `started` state，更新 issue，并确认状态为 started、`startedAt` 非 null。
- 路径：参数化覆盖 `sessionRole=implement + runnerBackend=codex-tmux` 与 `sessionRole=design + runnerBackend=claude-tmux`，并断言同步发生时 session row 已为 running。
- 幂等：原本 started 的 issue 不写，避免“拿已 In Progress 的单测试”产生假阳性。
