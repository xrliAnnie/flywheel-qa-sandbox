# FLY-2168 恢复 Codex 交互界面 — 调研
Issue: FLY-2168 (https://linear.app/geoforge3d/issue/FLY-2168/派工-fly-2152-的-codex-implement-继任连续出生即死22同窗兄弟全健康-出生失败根因待查)
日期: 2026-08-30
基于: exploration.md

## 1. Codex 0.151 remote TUI 契约

本机运行版本为 `codex-cli 0.151.0`。CLI 自带帮助确认：

```text
codex resume [OPTIONS] [SESSION_ID]
  --remote <ADDR>  Connect the TUI to a remote app server endpoint
```

支持 `unix://PATH`，所以 Flywheel 已有的短 Unix socket 无需 proxy、WebSocket 转换或新依赖。

### 1.1 running thread 不再冷 resume

核对官方 `openai/codex` tag `rust-v0.151.0`：

- `codex-rs/tui/src/app_server_session/rollout_history.rs` 的 remote TUI 发送 `thread/resume`；
- `codex-rs/app-server/src/request_processors/thread_processor.rs` 的 `thread_resume_inner()` 首先调用 `resume_running_thread()`；
- thread 已被当前 App Server 加载时，server 复用现有 `CodexThread`，把新的 connection 加到 listener，再返回 running thread 的 resume response；
- override 不一致时源码明确保留 rejoin semantics，并忽略 loaded thread 上的 override；
- 只有 thread 未运行时才进入 rollout/history 冷恢复路径。

因此 Flywheel machine client 与 TUI client 连接**同一个 App Server socket**时，TUI 是第二个 connection，不是第二个 thread writer。FLY-2169 记录的旧 fork 风险不能继续当成 0.151 的既定行为；真机 QA 仍必须做反证检查。

### 1.2 配置一致性

官方当前实现会忽略 running thread 上不匹配的 resume override；但为了减少 bootstrap 面，本仓库仍应沿用历史命令：

- `CODEX_HOME=<runner isolated home>`；
- raw TTY-capable Codex binary，不走捕获 stdout 的 launcher；
- `--remote unix://<same socket>`；
- `-C <same worktree>`；
- `-s workspace-write` 与 `approval_policy="never"`，和 daemon policy 一致；
- 不额外注入 MCP override。

`rawCodexBin()` 及其 TTY 边界单测在当前 main 仍保留，说明恢复不需要新增 binary resolver。

当前 `CodexTmuxAdapter.pinRunnerPolicy()` 已在复制全局配置后强制写入 `sandbox_mode = "workspace-write"` 与 `approval_policy = "never"`。评审举出的旧 runner home 是该修复部署前的历史样本，不能代表新生 home；本单不再重复实现 policy pin，但真机 QA 必须读取**本次生成**的 `config.toml` 断言上述值。若仍出现出生即死，则保存真实 pane 输出与进程退出证据，不能把配置假设当结论。

## 2. Adapter 时序

当前链路顺序：

1. `CodexDaemonGoalRuntime.ensureThread()` 得到 owned thread；
2. 同步 `onThreadReady(threadId, restarts)`；
3. 进入 `runGoalToTerminal()`；
4. fresh goal 的 `goal/set(active)` 成功后同步 `onGoalActive()`；
5. `startInitialTurn()`；
6. goal 由 machine client 持续驱动。

`onGoalActive` 不是可靠的唯一可见性触发点：parked/adopted goal 可以跳过它，且 `fireGoalActive()` 会吞掉 callback 异常。最小可靠时机是步骤 2：每次 `onThreadReady` 都启动 single-flight 开窗链。首个 attempt 以 0ms timer 异步安排，不 await，因此 goal setup 与 `startInitialTurn()` 不被 TUI bootstrap 阻塞；如果 rollout 尚未 landing，短 bounded retry 收敛。

- fresh thread：`onThreadReady(threadId, 0)` 立即异步安排开窗；
- `resumeThreadId` 已存在：同一路径开窗；
- 同一 execute 内 daemon restart (`restarts > 0`)：先清旧 pane latch，再启动 replacement chain；purge-before-create 保证同名窗最多一个。

`onGoalActive` 只保留 launch commit 职责，不再承担 founder visibility。这样 fresh、parked、adopted 与 phase resume 都不会因为 goal callback 缺席或失败而静默无窗。

## 3. 最小代码面

### 3.1 `codex-runner-tui-window.ts`

只替换 pane spec 和命令：

- `RunnerTailWindowSpec` → `RunnerTuiWindowSpec`；
- `transcriptPath` → `codexHome/socketPath/cwd/threadId/executionId?/stateDbPath?/codexBin?`；
- `buildRunnerTailCommand()` → `buildRunnerTuiCommand()`，复用 FLY-2169 之前已经验证的命令；
- 恢复 `buildRunnerPaneEnvironmentPrefix()`，保证 pane 是干净且有 TTY 的环境；
- tmux ensure、async rescue、同名窗 purge、settle、immutable id 和 retry 分类零改动。

### 3.2 `CodexTmuxAdapter.ts`

- 恢复 `rawCodexBin()`；
- `buildSpec(threadId)` 传递同一 home/socket/cwd/thread；
- 所有 fresh/resume/restart 路径都从 `onThreadReady` 非阻塞启动 single-flight 开窗链；
- daemon restart 把旧窗口 latch 清掉，新 attempt 仍通过 purge-before-create 保证单窗；
- native resume 有潜在 protocol side effect，不沿用 tail viewer 的 10 次/30 分钟重试：最多 3 次真正的 resume create，attempt 1 立即开始，失败后分别等 5s/15s；发生在 `tmux new-window` 前的 `hold_lock_unavailable` 与 `stale_window_unproven` 都不消耗这 3 次 quota；
- outer deadline 与 tmux rescue 解耦并由其配置推导：window 模块导出唯一的 `tmuxEnsureDeadlineMs()` accessor，session ensure 与 adapter 每次 `execute()` 都从它读取当前 env；adapter 使用 `2 * tmuxEnsureDeadlineMs() + 60_000`（默认 8 分钟）。一次开窗内最多两次 session ensure，因此 deadline 不会早于单次 attempt 的最坏 tmux rescue 预算；额外 60s 覆盖 5s+15s ladder、tmux command 与 settle/probe；
- teardown 恢复主动杀 TUI，因为 TUI 依赖即将关闭的 socket，不能套用 tail 的终态留窗规则。

### 3.3 保留 transcript sink

FLY-2169 的 `CodexTranscriptSink` 已经是落盘诊断能力，不必因为 cmux 改回 TUI 而删除。它继续接收 machine client notification，但**不再是 founder 窗口的数据源**。这是对现有可观测性的保留，不新增 fallback 界面或切换状态机。

不改：

- App Server/runtime/client protocol；
- CommDB schema、window pin、liveness callback；删除 tail retention 状态时仍必须执行 `publishWindowExecutionIdentity`、`pinCommDbSessionWindow`、`persistSessionWindowState`；
- Codex home policy 与 credential lifecycle；
- workflow/phase 控制面。

### 3.4 orphan reaper 兼容性

原生 TUI 会成为同一 Unix socket 的第二个 `lsof` holder。`codex-runner-orphan-reaper.ts` 的 pre-signal 候选检查仍应要求 exact `codex app-server` identity，不能弱化；但 SIGTERM/SIGKILL 后的 survivor 检查不能把仍存活的 `codex resume --remote` client 当作 App Server survivor。

最小修改是让 post-signal holder 集合与当前 exact App Server process rows 相交，只用仍满足 `isCodexAppServerCommand`/exact identity 的 PID 决定 survivor。client-only holder 不阻止 stale socket 清理，也不产生假 survivor audit。由于这会让“仍有 TUI client holder 时 unlink”首次可达，`removeSocket` 前必须再次调用 `isExecutionActive(executionId)`：active 或 probe 抛错都 fail-closed，不得 unlink 可能已被新 App Server rebind 的同路径 socket。

## 4. 失败与恢复契约

| 场景 | 预期 |
|---|---|
| fresh rollout 尚未可 resume | pane attempt 判 `window_died`，最多 3 次真正 resume；attempt 1 立即开始，后续等 5s/15s；goal 不受影响 |
| tmux rescue 饱和/持锁 | outer deadline 默认 8 分钟且随 ensure deadline 推导；`hold_lock_unavailable`/`stale_window_unproven` 不消耗 resume quota |
| daemon 未到 thread ready 就失败 | 不启动 TUI episode，也不发 visibility-lost；run 自身失败路径负责告警，避免重复噪音 |
| tmux 不存在/配置非法 | visibility lost 告警；machine goal 继续 |
| daemon restart | 清旧 latch；按同名窗 purge 后连接新 socket 代际 |
| TUI 手工退出 | 当前 adapter 没有常驻 pane watchdog；后续 daemon restart 会恢复，启动期 retry 不回归 |
| phase keep-alive | 同一 daemon/thread/TUI 跨 phase park/wake 保持 |
| terminal/controlled shutdown | 主动杀 TUI，再关闭 socket；CommDB session 正常终态 |
| late async window commit | 现有 teardown join + late cleanup 收割，不留幽灵窗 |

“运行中被人手工退出后立即补窗”不是本单新增目标；为它加 watchdog 会越过恢复原界面的最小范围。

## 5. TDD 接缝

### Unit RED

1. command builder 断言 pane 是 `codex resume --remote`，不是 `tail -F`；
2. spec 断言 exact isolated home、short socket、cwd、thread id、raw binary 与 state coordinates；
3. shell-unsafe path/id fail-loud；
4. adapter fresh/resume：每次 `onThreadReady` 都非阻塞启动一次 single-flight chain，不依赖 `onGoalActive`；
5. adapter parked/adopted 路径即使没有 `onGoalActive` 仍开窗；restart 清 latch 且只产生一个 replacement chain；
6. transcript notification 仍落 sink，证明 audit 可观测性未回退；
7. 成功后仍执行全部 CommDB window pin side effects；teardown 主动 retire TUI；
8. retry 精确限制为 3 次真正 resume，delay 只有 5s/15s；`hold_lock_unavailable`/`stale_window_unproven` 不消耗 quota；共享 accessor 默认与 env override 均按每次 execute 求值，outer deadline 等于两倍 tmux ensure deadline 加 60s，terminal visibility report 仍只发一次；
9. daemon 未到 thread ready 就失败时不产生重复 visibility-lost；
10. orphan reaper：App Server 已退出但 `codex resume --remote` client 仍在 `lsof` 时，经 remove 前 readopt fail-closed 复查后清理 socket；active/unknown 时不 unlink。

### 真机 QA

复用现有 `scripts/qa-fly-1239-e2e.mjs` 的 production adapter + real Codex + real tmux 形状，补本单断言：

- pane 有 Codex TUI chrome/输入区，而不是 transcript 文本；
- machine goal 正常完成并提交 fixture；
- 同名窗口采样最大值 ≤1（确定性证明仍来自 unit multiset test）；
- runner home 的 intended root 等于 result `sessionId`；允许 `thread_source=subagent` 且 parent/fork 指向该 root 的原生子代理，拒绝额外非 subagent root 或非 subagent fork；classifier 自检 fixture 同时包含 intended root、合法 subagent 与 synthetic resume fork，证明检查能抓到后者；
- 本次生成的 `config.toml` 是 workspace-write/never；若 pane 退出则留存真实输出；
- `adapter.execute()` 返回后、harness fallback cleanup **之前**，断言 daemon、TUI、socket holder 和窗口均消失；断言后才做兜底清理。

`proofshot` skill 当前 runtime 未安装，终端视觉验收使用真实 tmux `capture-pane` 及 pane process command，不能假装浏览器截图。

## 6. 结论

当前 Codex 已把 remote resume of running thread 实现成 multi-connection rejoin。最小正确方案是恢复历史原生 TUI command，在每次 thread ready 后非阻塞开窗，并保留 tmux 韧性、machine control、CommDB pin 与 transcript audit；同时让 orphan reaper 区分 App Server 与 TUI socket holder。无需新依赖、viewer 或协议层。
