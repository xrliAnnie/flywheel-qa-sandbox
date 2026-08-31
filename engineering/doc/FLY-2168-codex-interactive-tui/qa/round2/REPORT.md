# FLY-2168 独立 QA 报告 · 第 2 轮(返工复验)

Issue: FLY-2168 · PR #998 · 复验头: bd24d2d7e5e5dc0064089606636a0433d6b4d7ce
日期: 2026-08-30
基于: qa/independent/REPORT.md(第 1 轮 FAIL)

## 结论

**PASS** —— D1 已修且实证复绿(委托脚本原样跑 4/4 × 10/10);D2 已按 Lead 裁示由本 QA 宿主采集完毕,
定位到真因、证伪了「放宽预算能解」的假设、并用生产数据证明该现象不落在真实 Codex 工作负载上。

## D1 —— 已修,实证复绿

修复:`scripts/qa-fly-1239-e2e.mjs:117` 增加 `pretrustWorkspace: true`(正是第 1 轮给出的一行)。

复验方式:**不改任何一行**,原样跑仓库里已提交的脚本,连跑 4 次:

| 跑次 | 起 | TUI 开窗 | 开窗耗时 | run 时长 | 结果 |
|---|---|---|---|---|---|
| A | 22:27:44Z | 22:28:30Z | 45s | 62s | 10/10 |
| B | 22:28:46Z | 22:29:31Z | 43s | 61s | 10/10 |
| C | 22:29:49Z | 22:30:34Z | 44s | 111s | 10/10 |
| D | 22:31:41Z | 22:32:28Z | 46s | 91s | 10/10 |

4/4 全部 `RESULT: 10/10 passed`。pane 进程为 `codex resume --remote …`,capture 呈现完整原生 chrome
与实时 agent 输出(`• Ran 3 commands · ctrl + t to view transcript`、页脚 `Goal achieved (51s)`)。
第 1 轮已验的其余不变量在这 4 次里同样全绿:同名窗 ≤1、thread 无 fork(root == machine sessionId)、
teardown 窗口 0 + socket 已删 + 无孤儿、`workspace-write`/`never` 策略、machine goal `success=true`。

## D2 —— 采集完毕,给出真因与证伪

### 结论先说:**放宽开窗预算无用,预算不是瓶颈**

第 1 轮两次零窗口的失败形态都是 `attempts=1 reason=unknown` —— 即 **attempt 1 尚未返回时 run 就结束了**;
第 2 轮 4 次成功也全部落在 attempt 1。3 次 / 8 分钟的预算在两种结局里都从未被触及过。
把 `TUI_OPEN_MAX_ATTEMPTS` 或 deadline 调大,不会让 attempt 1 更早返回,零窗口结局一字不变。

### 真因:`ensureRunnerTuiWindow` 单次开窗有 ~43.5s 的固有成本

隔离测量(无争用,连测两次,不花 codex token):

```
elapsedMs= 43863   outcome={"created":false,...,"reason":"window_died"}
elapsedMs= 43470   outcome={"created":false,...,"reason":"window_died"}
```

这两次日志里**没有** `hold_lock_unavailable`,说明 43.5s 是路径固有开销,不是锁等待。
成本来源:一次开窗要走**两次** guarded tmux session ensure(`codex-runner-tui-window.ts:866` 的前置 ensure,
以及 `purgeSameNameWindowsAsync` 内 `:785` 的再次 ensure),每次都经由
`scripts/lib/tmux-server-rescue.sh` 的 per-socket flock 外部 shell 路径。
争用只是**叠加**在这之上:第 1 轮机器 load ~9 时测到 65.3s,日志里带两条
`hold_lock_unavailable`(owner 分别持有 9.4s / 6.6s)。

这套 ensure/purge 基础设施是**既有的**,`tail -F` 时代同样要走 —— 不是本 PR 引入。

### 本 PR 真正的时序 delta ≈ 1–2s,且是结构性必需

本 PR 把开窗链从 daemon spawn 挪到 `onThreadReady`。实测 `codex daemon socket up` 与开窗完成相隔 43–46s,
而开窗本身固有 43.5s ⇒ daemon-up→thread-ready 只有约 1–2s。
这一挪**无法避免**:原生 TUI 命令必须带 threadId(`codex resume --remote … <threadId>`),
而 `tail -F` 只需要 transcript 路径 —— 这是「恢复原生 TUI」这个需求自带的代价,不是可选实现取舍。

### 生产影响:未观察到

查本机 CommDB 全部已结束的生产 Codex session(12 条):

```
最短 5516s(~92 分钟,FLY-2105);12 条全部 >= 92 分钟
```

43.5s 约为最短一条真实 Codex 跑的 **0.8%**。第 1 轮的零窗口出现在我合成的 ~50s 台架任务上
(建一个文件并 commit),生产 Codex 工作负载里不存在这个量级。

### 因此我不要求本单改代码

D2 的杠杆在 tmux ensure 那条既有链路(两次 ensure 能否合一、rescue shell 能否更轻),
与「恢复原生 TUI」是两件事。是否单开一张单请 Lead 裁;本单不因 D2 挡。

## 其它硬门

- 该头 CI:见 PR #998 在 `bd24d2d7`(及本证据提交后的继任头)上的 checks;`MERGEABLE / CLEAN`。
- 第 1 轮已跑的定向单测(140 + 19)对应文件本轮未再改动(返工 diff 仅 1 行脚本 + 文档)。

## 仍未测(honest boundary,与第 1 轮一致)

- 529 房内 Bridge/Blueprint 驱动的 **Codex** 出生:房生成器的沙箱 `config.yaml` 只声明 claude runner
  (第 1 轮已拷原件),要在房里逼出 codex 体须改房生成器,超出本节点授权;Lead 已记台账。
- founder 在 TUI 里真发一个 turn 与 machine client 并发的行为(plan §9 明列不加锁,已知取舍)。
- pane watchdog(founder 中途关窗不会重开)—— plan §3 明列非目标,与改前一致。
- 全仓 `pnpm test:packages:run` 未在本地重跑(该头 CI 的 Unit heavy/light + teamlead 1-3 已覆盖同等门)。

## 证据清单(本目录)

| 文件 | 内容 |
|---|---|
| `committed-script-4runs.log` | 委托脚本原样连跑 4 次的带时间戳全量日志,4/4 × 10/10 |
| `short-A/`…`short-D/` | 每次跑的 `e2e-result.json` / `rollout-classification.json` / pane capture / pane command |
| `prod-codex-session-durations.txt` | 生产 CommDB 里 12 条已结束 Codex session 的时长(最短 5516s) |
