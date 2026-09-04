# FLY-2331 Bridge 异步子进程稳态化 — 探索
Issue: FLY-2331 (https://linear.app/geoforge3d/issue/FLY-2331/引擎稳定性urgent-bridge-主线程用-execfilesync无超时跑-adapter-shell-证据收集-approve-的)
日期: 2026-09-04
基于: 无

## 1. 目标与已知现场

2026-09-04 07:24Z 至 10:24Z，Bridge 的 `EventLoopGuard` 连续记录 12 次
`SIGKILL`。每次 `stall_age` 都落在 61–62 秒的阈值截断组，且 worker 取证的
`attribution=child`、子进程快照里均有 `<defunct>` 子进程。`ps etime` 的定义是
“elapsed running time”，从进程启动计时，不是 zombie residence age；因此最初
`etime≈61s` 的聚类是线索，不能单独证明 child 正好在 stall 开始时退出。同步
child-process API 等待 `git` / `gh` / adapter shell 仍能直接解释主事件循环冻结：
worker 准时醒来，达到 60 秒后 guard 按既有语义杀死 Bridge；Bridge 拉起的 Codex
app-server daemon 也随父进程消失。

本单不是放宽 `FLYWHEEL_BRIDGE_LOOP_GUARD_STALL_MS`，而是消除已知主线程阻塞源，
并让仍保留的同步入口在下一次异常时留下明确的 `last_sync_op`。

## 2. 当前代码事实

### 2.1 `run-infra.ts` 有四个生产同步漏斗

当前头 `80a24e3e8` 上，`packages/teamlead/src/bridge/run-infra.ts` 直接 import
`execFileSync`，生产路径共有四处：

1. `probePhaseRetryBranchTip`：`git rev-parse --verify --quiet`，已有 20 秒 timeout，
   但等待期间仍冻结事件循环。
2. `createRunBlueprint` 的 evidence / `GitResultChecker` execFn：无 timeout。
3. Blueprint `ShellRunner` 默认实现：无 timeout；错误通过 `{stdout, exitCode}` 返回。
4. restart-resume 分支 blob 探测：多次 `git rev-parse/show/ls-tree`，无 timeout，
   且被同步 callback 形状锁住。

第 1 项还穿过 `PhaseRetryStartPointComputer`。该类型目前只允许同步结果，
`RunDispatcher.dispatch()` 在 TURN 转移前后各探测一次；要保持已有“两次探测、
后一次在 TURN fence 内为权威”的安全语义，必须把该 seam 改成可 await，而不能
只在最外层包一个未等待的 Promise。

### 2.2 approve 默认执行器同步且无上限

`packages/teamlead/src/ActionExecutor.ts` 的默认 `ExecFn` 动态 import
`execFileSync`。`ApproveHandler` 会顺序执行 `gh pr list` 与 `gh pr merge`；任一网络
调用在高负载或网络异常时均可越过 guard 阈值。注入测试 seam 已经是 Promise
接口，因此默认实现可以局部替换成 async `execFile`，无需改变上层协议。

### 2.3 worktree 已异步，但缺少 timeout

`packages/edge-worker/src/WorktreeManager.ts` 的 `defaultExec` 已使用 callback
`execFile`，所以不会冻结 Bridge loop；但它没有 timeout。本类直接执行本地
`worktree add/prune/remove/list`、branch/config/rev-parse，故障时会永久占住一次
dispatch。这里应保留异步形状并加不超过 120 秒的明确上限。远端 branch
materialize/fetch 在 `run-infra`，不属于 WorktreeManager。

### 2.4 guard marker 已端到端可用

FLY-2058 已完成以下基础设施：

- `withSyncOpMarker()` 原子写入 `bridge-syncop.<pid>.json` 并在 finally 清理；
- guard worker 在 stall 判定瞬间读取 marker；
- forensic 记录按 `marker > child > unknown` 生成 `attribution`，并写
  `last_sync_op`；
- `workflow-docs-git`、`workflow-resume-checkpoint`、tmux scrub、Codex TUI
  等已使用 marker。

Lead governance ruling 要求 `workflow-docs-git` 即使全链 async 化也保留 FLY-2058
marker 与既有测试。本单按 ruling 执行，把它作为“async 但保留兼容 marker”的唯一
显式例外，不借此把其他 async child 默认标成同步根因。

因此本单不应修改 guard 判定或新建第二套观测系统。repo-wide production sweep
发现缺口不止最初点名的三处：`Blueprint.ts` 的 `claude plugin details` readiness、
`management-cron-source/writer` 的 `launchctl/plutil`、fleet recovery、runner admission、
terminal reaper 与 `TmuxAdapter.defaultExecFile` 均仍有 Bridge 可达同步调用。
`workkind-cutover.ts`、`design-review-manifest.ts`、`workflow-menu-routes.ts` 也没有
marker。gateway 的 bounded git runner 位于独立进程，应在 census 中明确 allowlist，
不能误算成 Bridge 修复。每个可达入口必须被分到 async、sync+marker+timeout 或
明确非 Bridge PID 三类，不能只维护六文件 grep。

### 2.5 10:31Z 第 13 次死亡与 Codex 子进程审计

Lead 在设计提交前补充了新现场：10:31:25Z 的第 13 次 SIGKILL 发生时 load 只有
31，children snapshot 同时有两个 `<defunct>`（etime 70s / 63s）、一个 etime
2m29s 的 Codex CLI child、两个 6m Codex daemon 与两个 6m Claude reviewer；
`attribution` 仍为 `child`，没有 `last_sync_op`。

针对「Bridge 是否同步启动 Codex health/login/review CLI」做了源码直查：

- `CodexTmuxAdapter.checkEnvironment()` 与 `executeOwned()` preflight 各同步执行一次
  `codex --version`，均有 10 秒 timeout 且外包 `withSyncOpMarker`
  (`codex-adapter:health-codex` / `preflight-codex`)；它们仍会短时阻塞主 loop，
  应直接 async 化。
- `codex-global-health.ts` 明确只做 PATH/realpath/stat，不 spawn Codex。
- 未发现 Bridge 生产 TypeScript 执行 `codex login status`；账号失效从 daemon
  protocol / pane failure 分类，不是主线程同步 login CLI。
- codex-author 的 review-request lane 启动的是独立 Claude reviewer；历史
  claude-author→Codex review 由 runner/plugin 侧执行，不是 Bridge 主线程同步调用。
- `codex-daemon-runtime.ts` 的 `codex app-server` 用 `spawn` 异步启动，2m29s Codex
  child 本身不等价于 event-loop blocker；但它强化了「每个同步入口必须有 marker，
  不能再靠 child 名称猜因果」的要求。

`CodexTmuxAdapter` 的同步漏斗还覆盖 tmux health/preflight、gh token、git config、
window-id 与 git-dir resolve。若只改两处 `codex --version`，一次 preflight 仍可能
累计多段主线程阻塞。因此本单把 adapter 的全部默认同步 child call 纳入 async
改造，同时保留旧 `ExecFileFn` 测试 fake 的兼容桥；对不存在的 login/review 同步
调用不虚构修复。

### 2.6 11:05Z zombie / child reaping 审计补充

Lead 补充的第 16 次现场有两个 `etime=11m04s` 的 `<defunct>`。本机 `ps(1)` 明确把
`etime` 定义为进程的 elapsed running time；它不携带 child 的退出时刻，所以不能据此
推出“已经 11 分钟未回收”。但 zombie 本身说明现场取证瞬间 parent 尚未完成 wait，
必须把 child lifecycle 与同步调用一起审计。

源码 sweep 的初步分类：

- `execFile` callback、`claude-review-runner`、cmux recovery、Codex daemon/Lead
  transport 与 process-lifetime lock 都保留 `exit`/`close`/callback 监听；
- `fleet-console.spawnEngine()` 与 `WorktreeManager.defaultBgDelete()` 是 detached +
  `unref()` fire-and-forget，当前没有显式 success-exit listener；fleet 的 try/catch 也
  不能代替异步 `error` 监听；
- `execFileSync` 自身在返回前 wait，但其长时间占用主线程会阻止 libuv 处理同时退出的
  其他 async child，因而 zombie 可能是 stall 的伴生证据，不必是造成 stall 的那个
  child。

实施应把 raw `spawn` 纳入 repo-wide lifecycle census：每个 Bridge 可达 child 必须是
awaited close/exit、显式 long-lived owner，或 detached fire-and-forget 且保留 error/exit
观察；Promise 已因 deadline settle 后也不能撤掉底层 terminal listener。增加一个
短寿命 detached/unref fixture，在 parent 保持活跃时轮询 `ps`，证明退出 child 会被
及时回收；该测试验证 wait/reap 行为，不再把 `etime` 当退出年龄。

同一 census 还必须追踪跨包同步漏斗，而不只扫 teamlead 直接 import。例如 Bridge
构造的 `Blueprint` 会同步调用 `flywheel-config` 的 `captureRepositoryBaselineSet()`，
其内部多次 `execFileSync("git", ...)`；该入口必须在 Blueprint 外层标记并在 config
Git helper 加硬 timeout。旧 `EdgeWorker → GitService` monolith 当前不由 Bridge
`run-infra` 构造，作为独立/legacy runtime 分类，不冒充 Bridge 已修路径。

## 3. 行为约束

### 3.1 必须保持

- child process 仍使用 executable + argv 数组，不引入 shell 字符串拼接。
- phase retry 的三态保持 `found | missing | indeterminate`；只有 exit 1 是
  confirmed missing，timeout / spawn error 一律 indeterminate。
- restart resume 仍按单一 ref 读取 tip、doc 目录与 progress blob，不允许不同
  ref 的结果拼成一个 snapshot。
- approve 的错误继续由 `ApproveHandler` 捕获并反馈；不能把 timeout 吞成成功。
- Blueprint shell 继续用 exitCode 返回非零退出，evidence/GitResultChecker 继续
  以 reject 表达失败。
- guard 60 秒阈值、worker 取证顺序和 kill 语义全部不变。

### 3.2 明确边界

- `account-heal/*-cli.ts`、build script 与测试 fixture 是一次性进程，不受 Bridge
  EventLoopGuard 约束，允许继续使用 `execFileSync`。
- guard worker 自己在 main loop 已卡死时同步跑 `ps` 是取证设计的一部分，不改。
- FLY-2058 已有且受 5–30 秒上限约束的同步漏斗，本单不重写其业务状态机；
  对尚未覆盖的入口补 marker，并用静态 census 防止本单点名范围回退为无标记。
- 不重启 Bridge / Lead，不触碰生产 state，不调整运维 env。

## 4. 假设与待验证点

1. Node callback `execFile` 的 timeout 不足以证明 Promise 有硬截止：parent 退出后，
   继承 stdout/stderr 的 grandchild 仍可能让 `close` 永不来到。共享 runner 必须使用
   独立 process group、硬 timer 当刻 settle，并有界处理 stdio drain；测试需覆盖
   stdout/stderr/code/signal/timedOut 与遗留 pipe，不能靠文档假设。
2. 120 秒是 worktree/fetch/approve 网络步骤的单次硬上限；本地证据与 branch probe
   可用更短上限。具体常量应集中命名，避免调用点各自漂移。
3. 70 秒假 Git 回归必须同时证明两件事：async 生产漏斗运行期间 heartbeat
   持续推进且 guard 不触发；把同一调用替换为同步 mutant 时 guard 必触发。
   对照必须使用同一个 fake `git` 与同一 guard，只改变执行漏斗。
4. 当前分支没有既有 `FLY-2331-*` 文档或批准 plan；本节点按注入的 full DOC-FLOW
   生成本组文档并在写代码前请求设计评审。
5. 第 13 次现场中的长寿命 Codex child 是嫌疑线索而非同步阻塞实锤；只有 direct
   call-site + marker/guard 行为才能定因。本计划会消除查到的同步 codex health
   调用，并用回归确保后续新增同步 Codex 调用无法无标记落地。
6. zombie `etime` 只表示从启动到取证的 elapsed time。回收审计必须用受控 child 的
   已知退出时刻 + `ps` 存在性验证，不能从生产快照的 `etime` 反推退出时刻。

## 5. 验收证据形状

- 源码 census：目标 runtime 文件不再含未批准的无 timeout `execFileSync`；保留的
  同步调用在唯一漏斗处包 `withSyncOpMarker`。
- 定向 Vitest：async 执行器成功、非零退出、spawn error、timeout；phase retry
  TURN 前后 await 与三态；approve 默认 executor timeout；WorktreeManager 120 秒配置。
- 进程级回归：PATH 前置 fake `git` 慢 70 秒，真 guard 在线，async arm 存活且
  heartbeat 推进；sync mutant arm 被 guard 终止并留下预期 attribution。
- lifecycle 回归：短寿命 detached/unref child 在 parent 继续跑事件循环时被回收；
  repo-wide raw spawn census 明确每个 terminal listener / long-lived ownership 合同。
- 单包 build/lint/test 按本任务测试纪律运行，显式排除
  `packages/core/test/tmux-viewer.macos.test.ts`，不运行 `pnpm -r` 或
  `test:packages:run`。
