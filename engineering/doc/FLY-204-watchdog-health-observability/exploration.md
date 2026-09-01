# FLY-204 看门狗健康可观测性 — 探索
Issue: FLY-204 (https://linear.app/geoforge3d/issue/FLY-204/bridge-watchdog-observability-idle-heartbeat-health-exposure-fly-195)
日期: 2026-08-30
基于: 无

## 问题重述

`RunnerIdleWatchdog` 只对 `status === "running"` 的 session 做逐个检查。唯一 Runner 进入 `awaiting_review` 等非 running 状态后，poll 仍按时执行，但 running 集合为空：没有 capture、没有 `StuckDetector` 日志，也没有 idle event。当前 `/health` 只返回 Bridge 进程级字段（`ok`、`shuttingDown`、`uptime`、`sessions_count`），因此运维无法从 Bridge 的公开健康面区分：

- timer 已 armed、最近一次 poll 成功且 running 数为 0；
- poll 正在执行；
- poll 连续失败；
- poll loop 不再推进。

当前主干已把默认 poll cadence 从历史的 30 秒拉长到 1 小时（`FLYWHEEL_IDLE_POLL_MS` 可覆盖），所以只有时间戳、没有 cadence/状态也不足以判断新鲜度。

## 已核事实

1. `RunnerIdleWatchdog.start()` 只创建一个现有 `setInterval`，不立即 poll。
2. `poll()` 在读取 running 集合后会正常遍历空数组，并在 `finally` 清除 `polling`；这个健康空闲路径零日志、零持久状态。
3. 重叠 tick 通过 `polling` 直接跳过；若前一轮卡住，最近完成时间必须保持陈旧，不能被跳过的 tick 冒充为健康进展。
4. 顶层 `getActiveSessions()` 异常被 containment 捕获并自愈；健康面必须标记该轮 error，不能只刷新时间戳后宣称成功。
5. `createBridgeApp()` 先挂载 `/health`，`RunnerIdleWatchdog` 在 `startBridge()` 后段才实例化；现有代码已用 late-bound holder 解决 shutdown、stuck detector、reconnect 等同类接线问题。
6. `/health` 是无鉴权、loopback-only 的运维面；新字段不得暴露 pane、issue、runner identity 或错误文本。

## 范围与假设

- 本 issue 只补 watchdog 自身 liveness/idle observability，不改变 stuck/idle 判定、告警、cadence、session eligibility 或自愈策略。
- 不新增 timer，不持久化指标，不引入 metrics 依赖。
- 不把 watchdog stale 自动并入顶层 `ok`；阈值策略属于监控消费者，且当前 cadence 可配置。`/health` 只提供可靠事实。
- 不暴露 StuckDetector episode 明细或 pane 内容；active-running 只给总数。
- 不添加周期日志心跳：结构化健康面可按需拉取，避免默认 1 小时 cadence 之外再引入日志策略与 spam 配置。

## 方案比较

### 方案 A：低频 debug 日志心跳

每 N 轮输出一行 `[IdleWatchdog] heartbeat`。改动小，但日志轮转、采集延迟、级别过滤都会重新制造“没看到日志不等于没运行”的歧义；也无法可靠表达 poll 正在运行或上一轮失败。

### 方案 B：只加 `watchdogLastPollAt`

满足最窄字面方向，但 boot 前一轮、上一轮 error、重叠 poll、1 小时默认 cadence 都仍需猜测。它把两种以上状态压成同一个痕迹，不足以作为运维判据。

### 方案 C：结构化 `/health.watchdog` 快照（推荐）

由 `RunnerIdleWatchdog` 暴露只读快照，`startBridge()` 通过 late-bound holder 接到现有 `/health`：

```json
{
  "watchdog": {
    "timerRunning": true,
    "pollIntervalMs": 3600000,
    "pollInProgress": false,
    "lastPollAt": "2026-08-30T10:00:00.000Z",
    "lastPollResult": "ok",
    "activeRunningSessions": 0
  }
}
```

首轮前 `lastPollAt`、`lastPollResult`、`activeRunningSessions` 为 `null`；timer 未启动或已 stop 时 `timerRunning=false`。成功空轮必须写 `activeRunningSessions=0`。顶层 store 失败的轮次写 `lastPollResult="error"`、`activeRunningSessions=null`，但仍刷新 `lastPollAt` 以证明 callback 活着。重叠 tick 不刷新完成时间。

该方案使用现有 timer、现有 `/health` 和现有 holder 模式，既能证明“活着且闲”，又不把健康判断阈值写死在 Bridge 中。

## 验收边界

- 空 running 集合执行一轮后，快照出现新鲜 `lastPollAt`、`ok` 和计数 0。
- store poll 异常被标为 `error`，无敏感错误详情。
- poll 尚未完成时 `pollInProgress=true`，完成前不伪造新 `lastPollAt`。
- `/health` 无 provider 的 standalone 测试形态返回稳定的未接线快照，不抛异常。
- `startBridge()` 将 live watchdog provider 绑定到 holder；关闭时沿用现有 `stop()` 和 `shuttingDown` 语义。
- 现有 idle/stuck 事件行为与字段保持不变。
