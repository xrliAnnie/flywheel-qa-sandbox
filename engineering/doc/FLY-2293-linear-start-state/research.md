# FLY-2293 派发同步 Linear 开工态 — 调研
Issue: FLY-2293 (https://linear.app/geoforge3d/issue/FLY-2293/状态可信度-派发不可靠地置-in-progress11-个在跑-runner-里-6-张单仍是-backlogstartedatnull-按)
日期: 2026-09-04
基于: exploration.md

## 结论

故障不是 adapter 特例，而是两代入口不对称：Linear webhook 创建 session 时有 `moveIssueToStartedState()`，Bridge `RunDispatcher → Blueprint → DirectEventSink` 创建 session 时没有等价写入。今晚成功的 2 张单来自另一条可达路径或既有状态，不能证明 generalized dispatch 正常。

最小正确修复是在 `DirectEventSink.emitStarted()` 已写入 running session 后调用一个幂等 Linear transition。这个位置同时覆盖 `main/claude`、`design/claude`、`implement/codex` 与 retry，不需要按 role/backend 加分支。

## 生产时序

```text
RunDispatcher.start/dispatch
  → Blueprint.run
    → DirectEventSink.emitStarted (fire-and-forget Promise)
      → StateStore session_started event
      → StateStore upsert status=running   ← 权威开工事实
      → [缺失] Linear issue → type=started
    → worktree / adapter launch
```

旧入口则是：

```text
EdgeWorker.createLinearAgentSession
  → fetchFullIssueDetails
  → moveIssueToStartedState               ← 仅旧入口存在
  → create workspace / runner
```

`git blame` 显示旧入口的 transition 自 v0.1.0 起即存在；`RunDispatcher` 是后续 Bridge 内部派发体系，未复用它。

## 现有能力可复用

- `@linear/sdk` 已是 `flywheel-teamlead` 依赖，无需新增依赖。
- `BridgeConfig.linearApiKey` 已提供 API key。
- `linear-issue-finalizer.ts` 已定义最小 SDK client interface、动态创建 `LinearClient`、按 workflow state type 写 `stateId`、并把外部失败转为显式 result/log。started transition 可沿用这一形状，避免新服务或缓存。
- Linear 的 started state 不应按名字硬编码：同一 team 可有多个 `type=started`（例如 In Progress / In Review）；现有 EdgeWorker 以最小 `position` 选择开工态。

## 位置比较

| 位置 | 结论 | 原因 |
|---|---|---|
| `runs-route.ts` | 排除 | 只覆盖 HTTP start，DAG successor/retry 可绕过 |
| `RunDispatcher` | 排除 | 该层没有 Linear client；把 tracker 依赖塞进 dispatcher 扩大构造面 |
| `Blueprint.run()` | 排除 | edge-worker 是 tracker-neutral；不应把 Linear 写入引入通用执行器 |
| `DirectEventSink.emitStarted()` | 采用 | 所有生产 role/adapter 共用；running row 已先落盘；已有 `BridgeConfig` |
| triage 查询排除 running | 排除 | 只遮住一个消费者，Linear 事实仍错误 |

## 状态算法

1. 读取 issue 当前 state。
2. 若 `type=started` 且 `startedAt` 非空，返回 already-started，零写入。
3. 读取 issue team 的 states，按 `position` 从小到大找到首个 `type=started`。
4. `updateIssue(issueId, { stateId })`。
5. 重新读取 issue，要求 `state.type=started` 且 `startedAt` 非空；否则返回可观测失败。

这里保留旧入口语义：只要真实 runner 已开工，非-started issue 都转到开工态；不额外发明 backlog-only 白名单。测试必须以 backlog/null 为前置，防止 already-started 快路把回归测成假绿。

## 失败与幂等

- 缺少 API key：不创建 updater，保持现有嵌入/测试配置兼容；生产 `/api/runs` 已把 key 作为 preflight 必需项。
- issue/team/state 读取失败、找不到 started state、写失败或写后确认失败：返回 `started=false` 并打印包含 issue 的 warning；不吞成成功。
- 外部 Linear 写失败不反向删除已持久化 session，也不增加新队列/迁移。本单修的是缺失调用；持久化重试/对账如需产品保证，应另立范围。
- session_started 重放或多 role 并发调用时，already-started 快路使写入幂等。

## 测试尺子

1. helper 单测：Backlog + `startedAt=null` → 选最低 position started state → 写后确认 started + non-null startedAt。
2. helper 负例：already-started 零写；找不到 started state；写后仍 backlog/null；SDK throw 均返回失败。
3. sink 路径单测：`implement/codex-tmux` 与 `design/claude-tmux` 均调用同一 updater，并在 callback 内观察到 StateStore row 已是 running。
4. 聚焦测试使用 teamlead package、单线程；不运行 `tmux-viewer.macos.test.ts`。
