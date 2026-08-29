# FLY-1239 Codex founder TUI 撞 rollout 落盘 race — 探索

Issue: FLY-1239 (https://linear.app/geoforge3d/issue/FLY-1239/bug-codex-founder-tui-开窗撞-rollout-落盘-race-threadresume-no-rollout)
日期: 2026-07-13
基于: 无（FLY-1236 真机 QA 证据 engineering/doc/FLY-1236-codex-goal-objective-limit/qa/，在 flywheel-FLY-1236 分支）

## 1. 症状 & 真因（非猜测，1236 A3 pane 尸体原文）

Codex runner 的 founder cmux/tmux 窗口 spawn 后**秒死**。1236 真机 A3（probe + remain-on-exit）抓到：

```
thread/resume failed during TUI bootstrap: no rollout found for thread id 019f5edf-… (code -32600)
Pane is dead (status 1)
```

**机理**：founder TUI 在 `onThreadReady` 开窗 —— 该 hook 在 `thread/start` 之后、**第一个 turn（setGoal）之前**触发（`codex-daemon-goal-runtime.ts:471`，`ensureThread` 之后立即同步调用）。此刻 daemon 尚未把该 thread 的 rollout 文件（`$CODEX_HOME/sessions/**/rollout-*.jsonl`）落盘/注册。`codex resume --remote <threadId>` bootstrap 时发 `thread/resume`，daemon 回 `-32600 no rollout found` → TUI 立即退出 → pane 死。

现有 `ensureRunnerTuiWindow`（`codex-runner-tui-window.ts`）**已有** settle(800ms)+liveness 探针，能**检测**到死亡并 fail-open 记日志 —— 但**不重试**，所以窗口死了就一直死。

## 2. 关键约束（决定修法方向）

1236 的 **A1（goal-set + 完整跑完 168s，succeeded=true）成功，而 A3（TUI）仍死** → 证明：
- 该 race 与 setGoal / objective-4000 修复**正交**（1236 diff 未碰 TUI 路径，已证伪「同因连带」假设）。
- **goal 控制循环必须能继续推进**（`onThreadReady` 同步返回后才 `await runGoalFn` → 发 setGoal → daemon 跑 turn → rollout 才有内容）。

⇒ **在 `onThreadReady` 里同步阻塞等待 rollout 有死锁风险**：阻塞 `onThreadReady` 就阻塞了 goal 循环；若 rollout 的可 resume 依赖 setGoal/首轮，则 setGoal 永不发、rollout 永不落 → 死等到超时。故修法必须**非阻塞**。

（注：daemon 是独立进程，rollout 由它写；但「何时可 resume」是 codex 内部细节，不可靠假设。用真操作当就绪信号最稳。）

## 3. 候选修法

| 方案 | 就绪信号 | 优点 | 缺点 |
|------|----------|------|------|
| A. 开窗前 poll rollout 文件存在 | `$CODEX_HOME/sessions/**/*<threadId>*.jsonl` 存在 | 便宜，单次 spawn | **耦合 codex 磁盘布局/文件名格式**（issue 明确点名此风险）；布局变即静默失效 |
| **B. bounded retry-on-death（选）** | `codex resume --remote` 真的能 attach 不死 | 用**真操作**当就绪信号，零耦合 codex 内部；复用现有 settle+liveness 探针 | 每次重试有一次 spawn+settle 成本（少量、仅启动期） |
| C. 延到「首轮后」才开窗 | 首轮完成 | 直觉简单 | 现架构 onThreadReady 在 setGoal 前触发，需另加 hook；且首轮可能很久，founder 看不到早期过程 |

**选 B**，理由：
- 稳健于 codex 外部依赖演进（不赌磁盘文件名/落盘时机）。
- 复用 `ensureRunnerTuiWindow` 已有的「settle 后 pane 是否活」检测。
- 对齐 1236 根因文档第二建议：「bounded retry on 'no rollout found'」。

## 4. 设计要点（fail-loud 保留，非阻塞）

1. **`ensureRunnerTuiWindow` 返回值细化**：`boolean` → `{created:true} | {created:false, reason:"tmux-absent"|"create-failed"|"died"}`。只有 `died`（创建成功但 settle 后 pane 死 = rollout race 或真失败）才**可重试**；`tmux-absent`（headless）/`create-failed`（tmux 层错误）**不重试**。
2. **重试放在 `CodexTmuxAdapter`**（它握 goal-loop 生命周期 + 能 cancel）：`onThreadReady` → 非阻塞 bounded retry（注入的 scheduler = 默认 unref'd `setTimeout`；重试间隙让出事件循环 → goal 循环发 setGoal → rollout 落盘 → 后续 attempt attach 成功）。
3. **bounded + fail-loud**：上限 N 次（~8）× 间隔（~900ms）。用尽仍 `died` → 记一条**响亮**日志（run 继续、machine client 照常驱动 goal，只是 founder 看不到 pane），**不静默、不无限**。
4. **cancel**：`execute()` finally 里 `runEnded=true` + cancel 挂起的 reopen，**先于** `runtime.drained()` 的 await —— 防止 teardown 期间/之后再 spawn 一个指向死 socket 的窗口。
5. 保留现有不变量：`tuiOpened` 单次 latch（`MEDIUM-1`：仅成功才 latch）；restart（restarts>0 且 pane 死）重开；outcome-fallback（onThreadReady 从未触发时）。
6. 保留 fail-open 总纲：窗口失败**永不**中断 run。

## 5. 影响面（返回类型改动）

- `packages/claude-runner/src/codex-runner-tui-window.ts`（改返回类型 + reason）
- `packages/claude-runner/src/CodexTmuxAdapter.ts`（retry 逻辑 + scheduler dep + cancel）
- `packages/claude-runner/test/codex-runner-tui-window.test.ts` + `CodexTmuxAdapter.test.ts`（更新断言）
- `scripts/qa-fly-1188-e2e.mjs`（一行 `.created`）
- 新 QA 真机 harness `scripts/qa-fly-1239-e2e.mjs`（复用 1236 A3 形态：真 daemon + 真 tmux → TUI 活着显示 thread 内容）

## 6. 验收

真机：真 `codex app-server` + 真 tmux spawn → onThreadReady 早开→（首击可能 died）→ bounded retry → **TUI pane 活着且显示 thread 内容**。连同 #582 部署后重派 FLY-1225 implement → cmux 窗口可看 = 冒烟检查点 2 通过。
