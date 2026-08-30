# FLY-2169 socket 直连 Codex runner 在 cmux 零可见 — 调研

Issue: FLY-2169 (https://linear.app/geoforge3d/issue/FLY-2169/可见性-socket-直连-codex-runner-在-cmux-零可见-founder-主观察窗照不到-implement-段一晚四问)
日期: 2026-08-29
基于: exploration.md

本文回答 exploration 选定方向(Option B:Bridge 事件落盘 + `tail -F` 只读窗口)落地前的
全部技术未知点,含实测证据。

## 1. 事件源:onNotification 钩子链现状

数据流(现状,全部已存在):

```
codex app-server (--remote-control, detached 子进程组)
  → unix socket → CodexDaemonClient.handleMessage
    → events.onNotification(method, params)     // 每一条 raw notification
    → events.onGoalUpdate(GoalNotification)     // goal 状态
  → runGoalToTerminal 内 observeTurnNotification  // turn/started|completed 归属判定
```

- `CodexDaemonEvents.onNotification`(codex-daemon-client.ts:168-170)注释原文
  "for pane rendering / diagnostics" — 钩子就是为本用途预留的;
- CodexTmuxAdapter 当前只 `{ onNotification: () => heartbeat() }`(:981),params 丢弃;
- `runCodexGoalDaemon`(codex-daemon-goal-runtime.ts:422 `events?: CodexDaemonEvents`)已
  把 events 参数透传到 client — **sink 不需要改 client/runtime,只在 adapter 层换 events**;
- daemon 重启(同账号 restart+resume)时 client 重建,events 重新挂 — sink 必须可重复挂载
  (幂等,append 同一文件)。

已知 method 集(client 代码 + 测试 fixture):`turn/started`、`turn/completed`、
`item/started`(test:1005)、goal 通知。**完整 method 集需在实施期用真 daemon 采样**
(memory: reference_real_codex_daemon_qa_harness — dist 拼真 app-server,不开 529 房)。
渲染必须做成「白名单美化 + 未知 method 紧凑单行降级」,保底任何协议演进下窗口仍有内容。

参考渲染素材 — 真 rollout(b03845bf,11.2MB)事件类型分布(前 200 行):

| type | payload.type | count |
|---|---|---|
| event_msg | item_completed | 61 |
| event_msg | token_count | 30 |
| response_item | reasoning | 29 |
| response_item | custom_tool_call / output | 27+27 |
| response_item | message | 11 |
| event_msg | task_started / thread_goal_updated | 各 1 |

⇒ 高频事件是 item_completed / token_count / reasoning。app-server notification 面预计同构。
渲染白名单建议:turn 边界、item 完成(agent message 全文、tool call 一行摘要)、goal 状态;
丢弃/聚合:token_count、delta 类。

## 2. 实测:macOS BSD `tail -F`

本机(Darwin 25.6.0)实测:

- 启动时文件**不存在** → tail 等待,文件出现后正常输出(不退出);
- 文件被 rename(轮转)后新建同名文件 → tail 自动跟随新文件,无丢行为(实测 rotate 前后
  两行都到);
- ⇒ 窗口命令 `exec tail -F <path>` 可在 transcript 文件出生前无条件创建,永不 died。
  仍建议 Bridge 先写 header 再开窗(founder 点开即有上下文,而非空屏)。

## 3. 窗口创建骨架:ensureRunnerTuiWindow 复用面

`codex-runner-tui-window.ts` 的 tmux 层骨架与 resume-TUI 无关,直接复用:

- `ensureSessionWithRetryAsync`(guarded tmux-server-rescue,210s deadline);
- FLY-1239 provable purge(同名窗按 immutable @id 杀净 + 复验);
- `new-window -d -P -F '#{window_id}'` + settle + `display-message` 验活;
- `scanAndKillSameNameWindows` / `killRunnerTuiWindow` / `isRunnerTuiWindowAlive`。

需要改的只有:**窗口内命令**(`buildRunnerTuiCommand` → 新的 tail 命令构造)和**调用时机**
(CodexTmuxAdapter 从 `onThreadReady` 后提前到 daemon spawn 前后)。settle 验活对 tail
命令几乎恒过(tail 不依赖任何外部状态),died-immediately 类别从机理上消失。

`RunnerTuiWindowSpec` 中 resume 专属字段(threadId/codexHome/socketPath)在 tail 形态下
不再需要 — spec 收窄为 {tmuxSession, windowName, transcriptPath, executionId?, stateDbPath?}。

## 4. comm.db / cleanup / issue-display 交互

- 注册:`registerSession(execId, 'runner-flywheel:pending', …)`(CodexTmuxAdapter:1819);
- 更新:`updateSessionTmuxWindow(execId, tmuxWindow)`(db.ts:5955)— claude 体
  (TmuxAdapter)同款;`%:pending` 的 LIKE 语义(db.ts:5923/5966)不动;
- cleanup.ts:ended_at + 超时后 `list-panes` 验存在 → `kill-window` — **注册真名后 codex
  窗口自动进入这套「终态留痕 + 超时清理」**,与 claude 体一致;
- issue-display attach cross-wire(FLY-923):按 `FLY-XX-` 前缀校验 window_name,现状
  pending-target 全部 withholding;写真名后自动恢复。

## 5. 探活轴分析(与 FLY-2155 的接缝,本单最重要的风险点)

生产 wiring(plugin.ts:9700-9711):

- `probeRegistered` = comm.db 取 tmuxWindow → `probeRunnerProcessLiveness(tmuxWindow)`;
- `probeRunnerProcessLiveness`(tmux-lookup.ts:685-745)= `list-panes #{pane_dead}` —
  **pane 活 = 判体活**;
- `:pending` 目标走 `probeTmuxTarget` 的 discover → pgrep 兜底链(patrol-process-liveness.ts:42-56)。

写真名后的影响矩阵:

| 场景 | 现状(pending) | 写真名 + tail 窗口 |
|---|---|---|
| daemon 活,干活中 | discover→pgrep 兜底,常假失联(FLY-2155 现象) | pane 活 → alive ✅(修复假失联) |
| 体正常终态(closeout 已标) | — | 窗口留痕;session 账面终态,reentry 不会选它 wake ✅ |
| **daemon 意外死,session 仍 running** | pgrep 可能判 dead | **pane(tail)仍活 → 误判 alive ⚠️** |

第三行是本设计引入的新风险。对策(设计规则,进 plan):

1. **异常死亡路径必须同步杀窗**:CodexTmuxAdapter.execute() 的 finally 已是所有 daemon
   终局(正常返回 / transport_closed 不可恢复 / caughtError)的汇合点 — 在 finally 里按
   `controlledShutdownSucceeded()` 分流:正常退休 → 留痕(不杀窗,交 cleanup.ts);异常
   终局 → 杀窗(维持现有 killWindow 行为)。杀窗后 pane 消失,probe 回落 discover/pgrep
   链,不比现状差;
2. Bridge 进程自身崩溃(finally 没跑到)→ tail 窗口残留 + daemon 可能死:此场景 claude 体
   同样有残窗问题,由既有 crash-reaper / patrol 收割(按 comm.db session 轴),不为本单
   新增机制;写进诚实边界;
3. **契约声明**:codex 体的窗口 pane 从此是 observer(tail),`pane_dead` 轴对 codex 只在
   「杀窗规则被正确执行」前提下近似成立;FLY-2155 若要更强的探活,必须走
   session.json 的 `daemonPgid`(codex-daemon-runtime 已持久化)/ socket 轴。本单在
   session.json 与窗口 header 中都留有 daemonPgid/execId,供 2155 消费。

## 6. transcript 文件

- 路径:`codexSessionStateDir(executionId)/transcript.log`
  (= `~/.flywheel/state/codex-sessions/<execId>/transcript.log`,与 session.json 同目录,
  生命周期与体绑定,env override `FLYWHEEL_CODEX_SESSION_DIR` 同步生效);
- Header(开窗前写入):execId / issue / role / label / cwd / goal objective 摘要 /
  daemonPgid(spawn 后追加)/ threadId(threadReady 后追加)/ 手动干预命令
  (等价于现 died 日志里的 inspect-by-hand `codex resume --remote` 命令行);
- 防膨胀:sink 只落白名单事件(不落 delta/token_count);单文件上限(如 5MB)到达后
  rename 为 `.1` 并重开(实测 tail -F 跟随轮转无缝);渲染文本量级远小于 rollout
  (11MB rollout ≈ 61 个 item,渲染后预计 <200KB);
- 写入方式:append-only,fs.appendFile 串行队列;写失败只 log 不断 run(可见性 fail-open
  契约沿用)。

## 7. onTuiWindowLost / Restored 告警通道

plugin.ts:6008-6010 → `tuiWindowAlertHolder` → founder 告警。保留通道不动;tail 形态下
触发面收窄为真正的 tmux 层失败(tmux absent / session ensure held / create failed),
47-died 类噪音消失。`RunnerTuiWindowFailureEvidence` 的 reason 枚举保留,
`window_died` 理论上仍可能(极端:tail binary 缺失)但不再是常态。

## 8. 结论

Option B 全部技术前提成立,无阻塞未知:

1. 事件钩子已预留,sink 只动 adapter 层;
2. tail -F 平台行为实测满足(等待出生 + 跟随轮转);
3. tmux 骨架(ensure/purge/settle/kill)全部复用,只换窗口内命令与时机;
4. comm.db / cleanup / issue-display 零改动自动受益;
5. 探活轴新风险已识别,规则化解(异常终局杀窗 + 正常终态留痕 + 2155 契约声明);
6. 渲染白名单待实施期真 daemon 采样,降级路径保证未知事件不黑屏。
