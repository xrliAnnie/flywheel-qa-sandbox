# FLY-1239 — 调研

Issue: FLY-1239 (https://linear.app/geoforge3d/issue/FLY-1239/bug-codex-founder-tui-开窗撞-rollout-落盘-race-threadresume-no-rollout)
日期: 2026-07-13
基于: engineering/doc/FLY-1239-tui-rollout-race/exploration.md

## 1. 当前代码路径（已核 codebase）

### 开窗时机链
- `codex-daemon-goal-runtime.ts:466` `threadId = await ensureThread(session, threadId)` → `:471` 同步调用 `input.onThreadReady(threadId, restarts)` → `:480` `await runGoalFn(...)`（内部发 `thread/goal/set` 首轮）。
- `CodexTmuxAdapter.ts:442` `onThreadReady` → `:447` `openWindow(threadId)` → `:373` `this.ensureWindow(...)`（= `ensureRunnerTuiWindow`）。
- `CodexTmuxAdapter.ts:516` fallback：`if (!tuiOpened && outcome?.threadId) openWindow(outcome.threadId)`。

### `ensureRunnerTuiWindow`（codex-runner-tui-window.ts:159）现状
步骤（每步 fail-open）：
1. `tmux -V` probe，缺失 → return false（headless）。
2. `new-session -Ad`（幂等 attach-or-create）。
3. **`kill-window -t =sess:=name`（无条件 stale-kill）** ← 关键：同名死 pane 每次先清。
4. `new-window -d ... -n <windowName> <buildRunnerTuiCommand>`。
5. settle（默认 800ms，`Atomics.wait` 同步）后 `isRunnerTuiWindowAlive` 探针。死 → return false（记 fail-open 日志「founder TUI DIED immediately」）。活 → return true。

⇒ **死亡已被检测**，但只记日志不重试。**同名 stale-kill + 固定 windowName = 结构上不会堆尸**（Lead 硬要求已被现有步骤 3 满足；重试复用同 windowName 即继承此保证）。

## 2. rollout race 的本质（为何非阻塞是硬约束）

- `codex resume --remote <id>` bootstrap 发 `thread/resume`；daemon 若未落盘该 thread 的 rollout → `-32600 no rollout found` → TUI 进程退出 → pane 死（1236 A3 原文）。
- daemon 是**独立进程**写 rollout；但「rollout 何时变得可 resume」是 codex 内部时序（可能 thread/start 异步后 ~亚秒，也可能依赖首轮）——**不可靠假设**。
- 1236 A1（goal-set + 168s 跑完 succeeded）成功、A3 仍死 ⇒ goal 循环推进与 TUR 正交、且 goal 循环**必须**能跑（`onThreadReady` 同步返回后才 `await runGoalFn` → 发 setGoal）。
- **结论**：同步阻塞 `onThreadReady`（poll 文件 or 阻塞 retry）→ 若可 resume 依赖 setGoal 则死锁。**必须非阻塞**：让 goal 循环并发推进，retry 在事件循环空隙跑，直到 attach 成功。

## 3. 选定：bounded retry-on-death（非阻塞）

用「`codex resume --remote` 真能 attach 不死」当就绪信号（零耦合 codex 磁盘布局）。复用现有 settle+liveness 检测。

### 3.1 参数（bounded + fail-loud）
- `TUI_OPEN_MAX_ATTEMPTS = 8`（含首击）。
- `TUI_OPEN_RETRY_GAP_MS = 900`。
- 典型 rollout race 窗口亚秒~~2s → 2-3 次即成；上限 ~8×(0.8 settle + 0.9 gap) ≈ 13s 天花板，仅作 fail-loud 边界。
- 用尽仍 `died` → 一条响亮日志（run 继续、machine client 照常驱动 goal，只是 founder 看不到 pane）。不静默、不无限。

### 3.2 就绪分类（细化返回值）
`ensureRunnerTuiWindow` 返回 `RunnerTuiWindowOutcome`：
- `{ created: true }` — 窗口活。
- `{ created: false, reason: "tmux-absent" }` — headless，**不重试**。
- `{ created: false, reason: "create-failed" }` — `new-window` 非 0 或未预期 throw，**不重试**（tmux 层错误，非 rollout race）。
- `{ created: false, reason: "died" }` — 创建成功但 settle 后 pane 死，**可重试**（rollout race 或真启动失败——bounded+fail-loud 兜底）。

### 3.3 重试宿主 = CodexTmuxAdapter（握 goal-loop 生命周期 + 能 cancel）
- 注入 `scheduleReopen(fn, ms) => cancelFn`，默认 unref'd `setTimeout`（可测：单测注入同步 scheduler 使 retry 链确定性跑）。
- `onThreadReady` → `openWindow(threadId)`（非阻塞启动 retry 链）；单飞标志 `tuiOpening` 防并发双链；成功 latch `tuiOpened`（仅成功，续 MEDIUM-1）。
- **复用同一 windowName** 每次 attempt → 继承步骤 3 的同名 stale-kill → 任意时刻 ≤1 窗口（Lead 硬要求）。
- restart（restarts>0 且 pane 死）重开；outcome-fallback 保留（onThreadReady 从未触发的快跑）。

### 3.4 cancel（防 teardown 后重开死 socket 窗口）
- `execute()` scope 加 `runEnded`；finally **最前面**（先于 killWindow / `await runtime.drained()`）：`runEnded=true` + cancel 挂起 reopen。attempt 每次跑前查 `runEnded`。

## 4. 不采纳

- **poll 磁盘 rollout 文件**：耦合 `rollout-<ts>-<uuid>.jsonl` 命名/布局，codex 升级即静默失效（issue 点名）。
- **延到首轮后开窗**：需另加 hook；首轮可能很久，founder 看不到早期过程；改动更大。
- **同步 bounded wait**（issue 原朴素写法）：死锁风险（§2），Lead 已认可否掉。

## 5. 测试策略
- 单测（module）：连败 N 次 `died` → 有状态 fake-tmux registry 断言窗口数 **≤1**（no pile-up）+ 每次 kill-before-create 同名。
- 单测（adapter）：注入 `ensureWindow` 序列（died×k → created）→ 断言 bounded 重试、成功即 latch、`tmux-absent`/`create-failed` 不重试、用尽 fail-loud 日志、每 attempt 同 windowName、finally cancel。
- 真机 harness `scripts/qa-fly-1239-e2e.mjs`：真 `codex app-server` + 真 tmux → onThreadReady 早开→（首击可能 died）→ retry → **pane 活着且显示 thread 内容**（复用 1236 A3 形态）。
