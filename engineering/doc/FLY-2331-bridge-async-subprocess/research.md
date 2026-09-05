# FLY-2331 Bridge 异步子进程稳态化 — 调研
Issue: FLY-2331 (https://linear.app/geoforge3d/issue/FLY-2331/引擎稳定性urgent-bridge-主线程用-execfilesync无超时跑-adapter-shell-证据收集-approve-的)
日期: 2026-09-04
基于: exploration.md

## 1. 本仓可复用的 async child-process 形状

仓库已有多条 Bridge 生产路径使用 `node:util.promisify(execFile)` 或 callback Promise：

- `continuity-preflight.ts`：git/gh 均为 async `execFile`，20 秒 timeout，异常 reject；
- `repository-authority.ts`、`head-authority.ts`、`runs-route.ts`：promise 形状并显式 timeout；
- `worktree-reconciler.ts`：需要 fail-closed 三态时，把 callback error 映射为 code；
- `WorktreeManager.ts`：已有 `WorktreeExecFn => Promise<{stdout}>` seam，但默认实现没 timeout；
- `TmuxAdapter.ts`：已有对外导出的 `defaultAsyncExecFile` / `AsyncExecFileFn`，是应当
  加固和复用的共享入口，而不是再建 teamlead-local helper。

这说明不需要引入 worker-pool 或第三方库。对 `run-infra` / approve 采用同一类
`execFile` Promise 漏斗即可让 libuv 监视子进程，主线程在 await 期间继续处理
heartbeat、HTTP 与 mailbox tick。

### 1.1 为什么不用 `setTimeout(() => execFileSync(...))`

它只延迟同步阻塞的开始；一旦 callback 进入 `execFileSync`，event loop 仍被冻结。
同理，给 `execFileSync` 加 `timeout` 只限制理想情况下的阻塞长度，不能让 heartbeat
在等待期间推进；连续多个同步步骤仍可累积越过 60 秒。

### 1.2 为什么不为这些调用新建 worker

worker 能隔离同步 API，但需要定义跨线程 error/stdout 协议、生命周期与 worker
崩溃处理。这里上层接口本来就是 Promise，原生 async `execFile` 直接满足需求，
改动面更小，且不会出现 worker 本身成为新的常驻资源。

## 2. timeout 与错误合同

### 2.1 timeout 分层

| 类别 | 上限 | 理由 |
|---|---:|---|
| WorktreeManager 默认本地 git | 120,000ms | 覆盖 worktree/branch/config/rev-parse；fetch 在 run-infra materialize 路径 |
| run-infra Blueprint exec/evidence | 120,000ms | 覆盖 git/find/cleanup；不会阻塞 loop，给高负载主机足够余量 |
| approve `gh pr list/merge` | 120,000ms | 网络步骤；超时必须返回明确失败，不能无限等待 |
| phase retry branch-tip probe | 20,000ms | 保留当前安全上限与现有故障语义 |
| restart-resume 本地 git snapshot | 20,000ms/步 | 与 continuity probe 同级；失败退到现有 fail-safe 分支 |
| objective 点名的短 rev-parse marker 入口 | 10–20,000ms | 仍同步但有界，并可由 guard 指名 |

所有新生产 async 调用显式传 UTF-8、命名 deadline 与输出上限。单靠 callback
`execFile({timeout, killSignal:"SIGKILL"})` 仍不构成 Promise 硬上限：child 退出后，
继承其 pipe 的 grandchild 可阻止 `close`。因此加固现有 `defaultAsyncExecFile`，用
独立 process group、显式硬 timer 与有界 drain；到点杀整组并立即 settle，后续
stdio 事件只清理而不能二次完成。异步等待期间主 loop 不阻塞，所以 120 秒 deadline
不等于 120 秒 event-loop stall。

### 2.2 三种上层错误语义必须分别保留

1. Evidence / `GitResultChecker`：非零、spawn error、timeout 均 reject，由已有调用方
   的 required/best-effort 分支处理。
2. Blueprint `ShellRunner`：捕获 error，返回 stdout 与非零 exitCode；timeout/spawn
   error 映射为 1，不能映射为 0。
3. `probePhaseRetryBranchTip`：成功且 SHA 非空为 found；只有 exit code 1 是 missing；
   timeout、signal、ENOENT、其他非零均为 indeterminate，并保留可诊断 detail。

Node callback error 的 exit code 可能位于 numeric `code`，现有同步错误则常见
numeric `status`。归一化 helper 应同时识别两者，string `ETIMEDOUT` / `ENOENT`
不得被误当 confirmed missing。

## 3. phase retry 的异步安全改造

`RunDispatcher.dispatch()` 当前在 TURN 转移前后调用同一个 synchronous
`computeRetryStartPoint()`：

1. 第一次探测失败时不移动 TURN；
2. 成功后原子转移 TURN；
3. 第二次在新 holder fence 下复探，防止 branch tip 在转移窗口变化；
4. 第二次失败时不启动 runner，TURN 留给 successor，由 dead-holder reconciler 处理。

异步化必须完整保留这四步。实现形状是：

- `PhaseRetryStartPointComputer` 返回 `PhaseRetryStartPoint | Promise<...>`；
- 内部 `computeRetryStartPoint` 变成 async 并 await seam；
- 两个调用点分别 await；
- 测试让 Promise 在受控 gate 后 resolve，断言 Blueprint 在 resolve 前未启动，
  并保留已有 found/missing/indeterminate 与两次调用断言。

restart resume 的 `computeProgressResumeAcrossRefs` 同理改成 async。每个 ref 内仍按
tip → tree listing → progress reads 顺序 await，同一 ref 失败后才尝试下一 ref，
不使用 `Promise.all` 混合引用历史。

## 4. marker 语义与覆盖边界

`withSyncOpMarker(label, fn)` 只应包同步入口。把 marker 留在 async `execFile`
等待全程反而可能把同时发生的另一种 JS stall 错归因到一个不阻塞 loop 的 child，
所以本单异步化的路径不写 sync marker。

对仍保留的同步入口，label 只含固定组件名与白名单子命令，不含仓库路径、remote
URL、token 或用户参数。例如：

- `design-review-manifest:rev-parse`
- `workflow-menu-routes:rev-parse`
- `workkind-cutover:rev-parse`
- `gateway-git-push:<git-subcommand>`

`workflow-resume-checkpoint`、tmux scrub 与 Codex TUI 已在 FLY-2058 覆盖，不重复
造 marker。Lead governance ruling 明确要求 `workflow-docs-git` 全链 async 化后仍
保留既有 marker（FLY-2058 coverage 依赖它）；这是唯一显式兼容例外。Guard worker
自己的 `ps` 取证不写 marker，因为它不在主 event loop 上。

### 4.1 Codex binary 的直接调用结论

生产 TypeScript 的 command/argv sweep 找到 Bridge 主线程两类同步 Codex binary
调用：`CodexTmuxAdapter` health 与 preflight 的 `codex --version`。但同一 adapter
漏斗还同步运行 tmux、gh 与 git；只替换 Codex 两处仍会保留连续同步预算。因此
`checkEnvironment` / `executeOwned` 内所有默认 child call 都切成可 await。构造器仍
只有现有 `execFileFn` 一个 positional seam；把其返回类型扩成 result-or-Promise，
production default 改为共享 async runner，约 40 个现有同步 fake 原位继续工作。
不得增加第二个 constructor/deps seam，也不能绕过注入启动真实 binary。

其余相关路径的性质不同：

- app-server daemon：`spawn()`，主 loop 不等待；
- global Codex health：只做 filesystem PATH/realpath 检查；
- codex-author review：Bridge 启动 Claude reviewer；
- legacy Codex review：runner/plugin 侧进程，不是 Bridge 同步 child；
- login failure：daemon protocol/pane 分类，源码无 `codex login status` child。

测试应加入源码 census，若将来 Bridge 新增 `execFileSync/spawnSync("codex", ...)`
或通过 `binaryName` 走同步漏斗而没有批准的 marker/timeout，立即失败。

### 4.2 repo-wide 可达同步调用的处置

除上述 adapter 外，sweep 还找到 `Blueprint` plugin readiness、management cron
source/writer、fleet recovery、runner admission、terminal reaper、design/menu/workkind
与 `TmuxAdapter.defaultExecFile`。处置原则如下：

- 外层已是 Promise 且风险高的 Blueprint readiness、fleet recovery、workflow docs
  直接 async 化；
- management cron 的 provider/writer 同步合同本单不重写，但每个 launchctl/plutil
  入口补固定 marker、10 秒 timeout 与 SIGKILL，并把“多 plist 累计同步预算”记录为
  明确残余/follow-up；
- 短本地 probe/reaper 各在唯一漏斗补固定 marker 与 2–20 秒上限；
- gateway、一次性 CLI、测试 fixture、guard worker 明确 allowlist，因为不在 Bridge
  main PID 或属于 guard 取证，而不是默认为安全。

非 child 同步热点 `baselineWorkflowDeliveryContracts`、divergence scan 与
`getReadoptCandidateSessions` 只补 marker。FLY-2324 拥有前两者的业务修法；本单
不改 query/循环/episode/uid 逻辑。

### 4.3 zombie 证据与 wait/reap 合同

`BridgeEventLoopGuard` 的 worker 用 `ps -axo pid=,ppid=,etime=,comm=` 只收 Bridge
direct children。本机 `ps(1)` 将 `etime` 定义为 elapsed running time，而不是“退出后
等待回收多久”；因此 11 分钟 `etime` 无法证明 11 分钟未 wait。可确定的只有：快照
当刻该 direct child 已退出、Bridge 尚未完成回收。

同步调用可能间接造成这一形状：`execFileSync` 在自己的 child 返回前会 wait，但主
线程被它占用时，libuv 不能处理别的 async child 的 exit callback。异步修法也必须
避免新的“Promise 已失败、底层 terminal listener 被撤掉”问题。共享 runner 到点可
立即 reject，但仍保留 child `exit`/`close` 观察与幂等清理，直到 OS child handle
终结；hard deadline 与 wait/reap 是两个同时成立的合同。

raw spawn sweep 目前发现两个需要加明确观察的 fire-and-forget 路径：
`fleet-console.spawnEngine()` 与 `WorktreeManager.defaultBgDelete()`。两者均 detached +
unref；后者只有 error listener，前者没有异步 error listener。为二者加一次性
error/exit 观察与行为测试，既能防未处理 spawn error，也能让 lifecycle ownership
可审计。其他主要 runtime spawn 已有 callback/close/exit 或 long-lived transport
`onExit` 接口，仍由静态 census 锁住。

census 的可重复输入固定为两组 production sweep：所有
`execFileSync|spawnSync|execSync` 命中，以及所有 `withSyncOpMarker` call site；随后
从 Bridge composition root 做跨包 reachability 分类。输出 checked-in manifest，
每项必须有 `async+deadline`、`sync+bounded+marker` 或 `non-Bridge/CLI` disposition。
这会捕获 Blueprint 经 `captureRepositoryBaselineSet` 间接触达的 config Git helper，
而不是把 grep 限在 teamlead 包。

## 5. 70 秒回归设计

### 5.1 正向 arm

进程级 harness 启动一个测试 child：

1. 临时目录放置名为 `git` 的 executable 并前置 PATH；fake git 记录 argv，sleep
   70 秒后输出合法 SHA/成功码。
2. child 启动真 `BridgeEventLoopGuard`，将测试 stall threshold 压到远低于 70 秒，
   使用独立临时 forensic log，绝不触碰生产 state。
3. 调用与 run-infra 生产共用的 async exec 漏斗执行
   `git worktree add ...` 形状。
4. 独立 interval 记录 heartbeat/tick 次数；70 秒后断言调用成功、tick 明显推进、
   进程未被 SIGKILL、forensic log 无 terminal stall。

### 5.2 阴性 mutant arm

同一 fake git、同一 guard 配置，仅将执行漏斗替换为 `execFileSync`。预期 child
被真 guard 以 SIGKILL 终止，forensic 行存在。测试必须先确认 fake git 真被调用，
避免 PATH 桩没装上却产生假绿。

为了开发期快速 red-green，Vitest 另用 300–800ms 的缩放 fixture；checked-in
进程 harness 保留 70 秒参数并实际运行一次，提供需求原量级证据。

## 6. TDD 切片

1. RED：现有 shared async exec 的 process-group/deadline/error contract 与遗留 pipe；
   GREEN：加固 `defaultAsyncExecFile`。
2. RED：run-infra evidence/shell 不阻塞 + timeout；GREEN：替换全部四个默认同步漏斗。
3. RED：async phase retry probe 在 Promise resolve 前不 launch；GREEN：类型与两次 await。
4. RED：async restart-resume 单-ref 一致性；GREEN：异步 callback 链。
5. RED：approve 默认执行器 timeout/nonblocking；GREEN：async execFile。
6. RED：WorktreeManager 默认 timeout 断言；GREEN：120 秒配置。
7. RED：workflow docs、Blueprint、Codex adapter、fleet 的 async 行为；GREEN：逐链 await。
8. RED：repo-wide 可达同步入口 census/marker/timeout；GREEN：唯一漏斗包装和明确 allowlist。
9. RED：70 秒正向/同步 mutant 与缩放 grandchild-pipe arm；GREEN：进程级验收。
10. RED：detached/unref 短寿命 child 的已知退出→回收 fixture 与 raw spawn lifecycle
    census；GREEN：fire-and-forget error/exit observation。

每片先运行对应单包 Vitest，线程固定
`VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`。最终只跑受影响包的 build/test 与新增
shell harness；遵守任务指令，不运行 `pnpm -r` / `test:packages:run`，并排除真实
macOS Terminal 测试。
