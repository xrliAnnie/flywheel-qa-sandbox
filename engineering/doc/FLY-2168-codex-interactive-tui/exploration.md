# FLY-2168 恢复 Codex 交互界面 — 探索
Issue: FLY-2168 (https://linear.app/geoforge3d/issue/FLY-2168/派工-fly-2152-的-codex-implement-继任连续出生即死22同窗兄弟全健康-出生失败根因待查)
日期: 2026-08-30
基于: 无

## 0. 范围更正

Lead 指令 `[lead-instruction 70d7a719-7abf-4207-a5a2-47c68fab9958]` 明确旧 issue 描述已经过时：

- Codex replacement 缺 `leadId` 的出生失败由 FLY-2182 修复；
- 本单不再调查 FLY-2152 replacement；
- 本单唯一目标是把 Codex runner 从当前只读事件流水窗恢复为原生、完整、可交互的 Codex TUI；
- cmux 中仍必须有真实窗口，且机器 client 经 App Server remote-control 驱动 `/goal` 的控制链不能回退。

以下探索以更正后的范围为准。

## 1. 现状与历史

### 1.1 当前界面

FLY-2169 把 founder 窗口改成 `tail -F <transcript.log>`：

1. `CodexTmuxAdapter` 启动 App Server 前创建 transcript sink；
2. tmux 窗口只运行 `tail -F`；
3. machine client 继续通过 Unix socket 驱动 goal；
4. founder 能看简化后的事件文本，但没有 Codex TUI 的布局、状态栏、输入框或交互能力。

因此“有窗”已经满足，缺的是 founder 直令中的“原界面”。

### 1.2 可复用的旧路径

FLY-2169 的父提交保留了完整实现形状：

- pane command：`codex resume --remote unix://<socket> -C <cwd> ... <threadId>`；
- `CODEX_HOME` 使用该 runner 的隔离 home，binary 使用真实 raw Codex binary，保证 stdout 是 TTY；
- `onThreadReady(threadId)` 后异步开窗；
- tmux session ensure、同名窗按 immutable `@id` 清净、settle 验活、bounded retry、CommDB 真窗口 pin 均已存在；
- TUI 失败始终 fail-open，machine client 继续跑 goal。

这条路径不需要新依赖，也不需要重写 TUI；它直接使用 Codex CLI 的原生平台能力。

## 2. 不能直接机械回滚的原因

FLY-2169 的生产证据记录了旧路径的两个故障：

1. `onThreadReady` 发生在 goal 激活和首 turn 之前，rollout 尚未落盘时 `thread/resume` 会报 `no rollout found`，pane 秒退；
2. 当时观察到 resume 尝试产生额外 rollout，曾被判断为 active-writer fork。

所以只把 `tail` 字符串换回 `resume` 不完整。恢复必须同时证明：

- 开窗不会阻塞或接管 machine client；
- pane 最终稳定存活并显示同一个 thread；
- 不产生额外 fork thread；
- daemon 重启后窗口能恢复；
- 失败时仍只有一个 runner 窗口，且不影响 goal。

## 3. 当前 Codex 0.151 的关键变化

本机 `codex-cli 0.151.0` 仍原生支持：

```text
codex resume --remote <unix-or-websocket-address> <session-id>
```

对官方 `openai/codex` 的 `rust-v0.151.0` 源码核对显示，App Server 的 `thread/resume` 会先走 `resume_running_thread`：

- 若 thread 已在同一个 App Server 中运行，它不从 rollout 冷 resume，也不 fork；
- 它把新 connection 挂到现有 thread listener，并返回该 running thread 的 resume response；
- 源码注释把此路径称为 rejoin semantics；
- resume overrides 在 loaded thread 上不匹配时会被忽略，不会重建活 thread。

这消除了旧设计所担心的“第二 client 必然 fork”前提。仍需真机验收，因为本仓库还叠加了隔离 `CODEX_HOME`、tmux、goal 和 restart 生命周期。

## 4. 决策梯子

1. **Skip**：不能跳过，founder 明确要求恢复交互 TUI。
2. **标准库**：不能自行渲染 Codex TUI。
3. **原生平台能力（命中）**：使用现成的 `codex resume --remote` 连接当前 App Server。
4. 不新增依赖。
5. 不另造 viewer、proxy 或双界面 fallback。
6. 只恢复 pane spec、开窗时机与 teardown 语义；保留现有 tmux 安全骨架。

## 5. 方案比较

### A. 恢复原生 remote TUI（选择）

- 优点：完整原界面；能观察也能交互；复用历史生产代码与现有 App Server；净删除 transcript viewer 机制。
- 风险：rollout race、TUI 与 machine client 的并发行为、daemon restart 后重连。
- 控制：goal 激活后才开窗；保留长窗口 bounded retry；真机断言同 thread、无 fork、cmux 活窗、machine goal 不受影响。

### B. 在 tail 上叠加输入代理

- 缺点：需要自造输入协议、状态同步和渲染层，仍不是 Codex 原界面；代码和故障面最大。
- 结论：拒绝。

### C. TUI 失败后 fallback 到 tail

- 缺点：两套 viewer、两套终态语义与切换状态机同时存在；会掩盖 TUI 验收失败。
- 结论：拒绝。可见性失败沿用现有告警与 retry，不引入第二界面。

## 6. 初步边界

保留：

- App Server Unix socket 和 machine client `/goal` 控制链；
- cmux/tmux session ensure、同名窗清理、immutable window id、CommDB pin；
- fail-open、visibility-lost/restored 回调、30 分钟 bounded retry；
- FLY-2169 的 Codex home policy 与 orphan reaper（不属于 viewer，绝不回退）。

删除或恢复：

- `tail -F` pane command → 原生 `codex resume --remote`；
- pane 开窗从 daemon spawn 前恢复到 owned thread ready callback；首个 attempt 异步安排，不阻塞 goal/turn；
- TUI 连接 socket，daemon 终态时必须杀窗；
- **下游调研更正**：transcript sink 已是独立落盘审计能力，research.md / plan.md 决定保留；只让它退出 cmux UI 数据源，不删除 sink 与测试；
- daemon restart 时若旧 pane 已死，重新打开同 thread TUI。

## 7. 下一步

调研需要进一步固化：

1. 当前 adapter 的最窄恢复 diff，避免回退 FLY-2169 的 orphan/policy 和后续 tmux 韧性改动；
2. `onThreadReady`、`onGoalActive`、首 turn 的精确顺序；
3. 单测 RED 接缝与真机 QA 断言；
4. terminal/phase keep-alive 下的窗口关闭契约。
