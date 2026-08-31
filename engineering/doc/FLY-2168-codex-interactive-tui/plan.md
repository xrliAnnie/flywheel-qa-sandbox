# FLY-2168 恢复 Codex 交互界面 — 实施计划
Issue: FLY-2168 (https://linear.app/geoforge3d/issue/FLY-2168/派工-fly-2152-的-codex-implement-继任连续出生即死22同窗兄弟全健康-出生失败根因待查)
日期: 2026-08-30
基于: research.md

## 1. 目标

把 Codex runner 的 cmux pane 从 `tail -F transcript.log` 恢复为连接同一 App Server、同一 thread 的原生 `codex resume --remote` 交互 TUI，同时保持 machine client 对 `/goal` 的唯一自动化驱动、tmux 可见性、单窗约束和 fail-open。

## 2. 验收标准

1. 运行中的 Codex runner 在 cmux 有 canonical 窗口，pane process 是原生 Codex TUI，不是 `tail`；
2. pane 呈现完整 Codex TUI chrome、历史、状态和输入能力；
3. TUI resume response 的 thread id 等于 machine adapter 的 `result.sessionId`，runner home 不产生额外 fork root thread；
4. machine goal 继续独立完成，TUI 开窗失败不改变 adapter 成败；
5. fresh、parked、adopted 与 resume thread 都在 `onThreadReady` 后非阻塞开窗，不依赖 `onGoalActive`；rollout race 最多执行 3 次真正 resume，attempt 1 立即开始，后续等待 5s/15s；
6. daemon resume/restart 能重新得到一个 TUI，同名窗始终 ≤1；
7. terminal/controlled shutdown 收割 TUI、daemon 与 socket；
8. transcript audit 文件继续产生，但不再驱动 cmux UI；
9. 不回退 FLY-2169 的 home policy、credential 或 CommDB 可见性接线；orphan reaper 能区分 App Server 与 TUI client socket holder。

## 3. 非目标

- 不修 FLY-2182 承接的 replacement `leadId`；
- 不新增 pane watchdog；
- 不在 TUI 失败后切换到 tail viewer；
- 不改 Codex App Server protocol、workflow engine 或数据库 schema；
- 不保留 terminal 后的可交互 TUI（socket 已关闭时它没有有效交互语义）。

## 4. TDD 顺序

### 4.1 RED — pane command

先修改 `packages/claude-runner/test/codex-runner-tui-window.test.ts`：

- fixture 恢复 `codexHome/socketPath/cwd/threadId/codexBin`；
- 断言 command 使用 clean pane env + `CODEX_HOME` + raw `codex resume --remote unix://...`；
- 断言 workspace-write、never approval、cwd、thread id 与 optional execution/state coordinates；
- 断言没有 `tail -F`；
- 断言 unsafe id/path 被拒绝；
- tmux new-window fake 断言实际 command 含 `resume --remote`。

实现前这些用例必须因当前 tail spec/command 失败。

### 4.2 GREEN — native command

最小修改 `packages/claude-runner/src/codex-runner-tui-window.ts`：

```ts
RunnerTuiWindowSpec {
  tmuxSession; windowName;
  codexHome; socketPath; cwd; threadId;
  executionId?; stateDbPath?; codexBin?;
}
```

`buildRunnerTuiCommand()` 使用历史已验证表达式；`ensureRunnerTuiWindow()` 只把 `buildRunnerTailCommand(spec)` 换成新 builder。其余 tmux 代码不动。

### 4.3 RED — adapter 时序与生命周期

修改 `packages/claude-runner/test/CodexTmuxAdapter.test.ts`：

- fresh：execute 启动后窗口调用数为 0；`onThreadReady` 后异步安排 1 条 chain；`onGoalActive` 不再开第二条；
- exact spec：同 home/socket/cwd/thread、raw binary、execution/state coordinates；
- resume、parked/adopted：即使不调用 `onGoalActive`，`onThreadReady` 也直接安排开窗；
- restart：第二次 `onThreadReady(..., 1)` 清 latch，并只安排一个 replacement chain；
- transcript notification/close assertions保留；
- teardown 无条件调用 TUI kill，不依赖 transcript-window pin/retention 条件；
- 窗口成功仍调用 execution identity publish、CommDB pin 与 session window persist；
- retry 最多 3 次真正 resume，delay 数组仅为 `[5s, 15s]`；发生在 `tmux new-window` 前的 `hold_lock_unavailable` 与 `stale_window_unproven` 都重试同一 attempt number，不消耗 resume quota；`new_window_failed/window_id_unproven/window_died/ipc_exception` 保守计入；
- window 模块导出 `tmuxEnsureDeadlineMs()` 作为唯一 env parser，session ensure 与 adapter 共用；adapter 在每次 `execute()` 开始求值 outer deadline `2 * tmuxEnsureDeadlineMs() + 60_000`（默认 8 分钟），测试默认与运行中 env override，保证不短于一次开窗中的两次 tmux ensure 加 retry/settle 余量；
- daemon 在 `onThreadReady` 前失败时不启动 visibility episode、不发重复 visibility-lost，由 run failure 负责；
- visibility failure 仍不能覆盖成功 goal。

### 4.4 GREEN — adapter 接线

修改 `packages/claude-runner/src/CodexTmuxAdapter.ts`：

1. import `rawCodexBin`、`RunnerTuiWindowSpec`；
2. 记录 `tuiThreadId`；`buildSpec()` 由它构造 native TUI spec；
3. 删除 daemon spawn 前的 `startOpenChain()`；
4. `onThreadReady`：持久化 thread id，每次都调用 non-blocking `startOpenChain()`；restart 先清 `tuiOpened/tuiTerminalReported` latch；
5. `onGoalActive` 只保持 launch commit 逻辑，不参与 visibility；
6. late cleanup 与 window pin 回调原样复用；retry 以 3 次真正 resume 为上限，delay 为 5s/15s；`hold_lock_unavailable`/`stale_window_unproven` 不递增 attempt；window 模块导出共享 `tmuxEnsureDeadlineMs()`，adapter 每次 execute 求值其两倍加 60s（默认 8 分钟）；
7. transcript sink/notification 原样保留；
8. 两条 closeout 分支都主动 kill TUI；删除只为 tail terminal-retention 条件存在的 `commWindowPinned/commCloseoutSucceeded` 状态，但保留并验证 `publishWindowExecutionIdentity`、`pinCommDbSessionWindow`、`persistSessionWindowState` 三项 side effect。

修改 `packages/claude-runner/src/index.ts` 只更新 TUI spec/command 导出名，不公开 deadline accessor；`CodexTmuxAdapter.ts` 从同包 window 模块直接导入 `tmuxEnsureDeadlineMs()`。

### 4.5 RED/GREEN — orphan reaper socket holder

扩展 `packages/teamlead/src/bridge/__tests__/codex-runner-orphan-reaper.test.ts`：

- exact App Server process group 已在 signal 后退出，但 `lsof` 仍返回一个 `codex resume --remote` client PID；当前实现应先 RED 为 survivor/mismatch，修复后经 readopt 复查删除 socket 并报告 reaped；
- remove 前 execution 已 readopt 时不 unlink；`isExecutionActive` probe 抛错时同样 fail-closed、不 unlink，并记 probe unknown。

最小修改 `packages/teamlead/src/bridge/codex-runner-orphan-reaper.ts`：保留 pre-signal exact candidate 校验；post-signal holder 检查只保留仍与 exact `codex app-server` process row 相交的 PID。client-only holder 不阻止 stale socket 清理；但进入 `removeSocket` 前再执行一次 `isExecutionActive(executionId)`，active/unknown 都 fail-closed，防止 unlink 两次 probe 间由新 App Server rebind 的同路径 socket。

## 5. 开窗状态机

```text
fresh/resume/parked/adopted:
  onThreadReady(id, restarts)
    -> remember id
    -> if restarts > 0: clear prior pane latch
    -> schedule attempt 1 (0ms, not awaited)
  goal setup / startInitialTurn -> machine client continues independently

attempt:
  purge exact same-name windows by @id
  create codex resume --remote pane
  settle + prove alive
  success -> pin immutable window id in CommDB
  hold_lock_unavailable / stale_window_unproven
    -> retry same resume number (new-window 尚未执行)
  resume-side transient -> bounded retry (max 3 creates; waits 5s/15s)
  permanent/deadline -> visibility-lost report, goal continues
```

`startOpenChain` 仍 single-flight；重复 callback 不会开第二条 chain。outer deadline 是 `2 * tmuxEnsureDeadline + 60s`（默认 8 分钟），足以容纳一次开窗内最坏的两次 210s ensure，并受总时限约束。`onGoalActive` 不属于这条状态机，避免缺席/异常造成静默无窗。daemon 若从未到 `onThreadReady`，不启动 visibility episode，由 run failure 告警。

## 6. Teardown

保留当前先取消 retry/deadline、abort/join active attempt、late cleanup 的顺序。之后：

- controlled phase shutdown：停止/排空 daemon、关闭 transcript 与 registry、scrub credential、按 session/name 或 immutable id 杀 TUI，再 ack；
- ordinary closeout：同样主动杀 TUI；
- 即使 pane 从未成功 pin，也清同名残窗；
- cleanup 失败记录但不让 visibility-only 错误覆盖 goal 结果；daemon 未确认退出仍按现有规则使 run 失败；
- window retention 条件删除后仍无条件执行原有 CommDB pin side effects，RED test 防止误删。

## 7. 真机 QA

最小扩展现有 `scripts/qa-fly-1239-e2e.mjs`，使 evidence 目录可通过环境变量指向本单 QA 文件夹，并增加：

1. `tmux capture-pane` 命中 TUI chrome/work markers，且 pane command 含 `codex ... resume --remote`、不含 `tail -F`；
2. machine task 提交 fixture，adapter `success=true`；
3. 采样同名窗最大值 ≤1；
4. 从隔离 runner home 的 session metadata 分类：intended root 必须等于 `result.sessionId`；`thread_source=subagent` 且 parent/fork 指向 intended root 的 native subagent 合法；额外非 subagent root、非 subagent fork/parent 一律失败；先用同时含 root、合法 subagent、synthetic resume fork 的 fixture 自检 classifier；
5. 读取本次生成的 `config.toml`，断言 `sandbox_mode = "workspace-write"`、`approval_policy = "never"`；若启动失败保存 pane output 与真实退出证据；
6. `adapter.execute()` 返回后、任何 harness fallback cleanup 前，断言无窗口、socket holder、daemon 或 resume process；然后才执行兜底清理，避免 teardown assertion 自证；
7. orphan reaper real/unit evidence 证明 TUI client-only holder 不被当成 App Server survivor。

若现有 harness 无需逻辑改动即可提供上述证据，则不新建脚本；遵循 YAGNI。

## 8. 验证命令

Targeted：

```bash
pnpm --filter flywheel-claude-runner exec vitest run test/codex-runner-tui-window.test.ts test/CodexTmuxAdapter.test.ts
pnpm --filter flywheel-claude-runner build
pnpm --filter flywheel-teamlead exec vitest run src/bridge/__tests__/codex-runner-orphan-reaper.test.ts
TMPDIR=/tmp FLYWHEEL_QA_EVID_DIR=<本单qa目录> node scripts/qa-fly-1239-e2e.mjs
```

全仓：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

## 9. 回滚与风险

- 单 PR，无 schema/data migration；代码回滚即可恢复 tail viewer；
- 最大风险是当前 real Codex 环境仍拒绝 running-thread rejoin；真机“同 thread/no fork”是合并前硬门，失败则不以 unit green 代替；
- `pinRunnerPolicy()` 已覆盖新 runner home；真机必须验证本次实际配置，若失败以捕获到的 pane/exit 证据继续诊断；
- TUI 输入与 machine client 同时发 turn 属于 Codex 0.151 multi-connection 的原生行为；本仓库不另加锁。founder 交互是明确需求，不做只读限制；
- proofshot skill 不可用，终端视觉证据由 real tmux capture + pane process identity 提供并在交付中明示。
