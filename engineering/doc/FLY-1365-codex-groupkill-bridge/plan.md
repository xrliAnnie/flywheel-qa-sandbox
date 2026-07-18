# FLY-1365 Bridge 自伤 blink 根治 — 实施计划

Issue: FLY-1365 (URL 不可得,只写 issue 号)
日期: 2026-07-18
基于: research.md

**Status**: codex-approved（design review 3 轮，R1: 2 BLOCKER+2 HIGH+1 HIGH 全采纳；
R2: 2 BLOCKER+1 HIGH 全采纳；R3 APPROVED。thread `019f7651-0e58-7a23-b918-91fdb1489e0b`）
**Brainstorm gate**: Tadashi 已确认根因重定向 + 全量批 A+B+C+D+E，附三个硬要求（见 §0.3）
**Codex R3 非阻断注意项（implement/code-review 检查点）**：
① late-cleanup continuation 不得裸用 `activePromise.finally(...)`（源 promise 的
rejection 会传给返回值）—— 用同时消费 resolve/reject 的 no-throw 链并吞掉 cleanup
自身错误（plan 的「零 unhandled rejection」验收已覆盖，code review 时核对实现形状）；
② PR ready 前完成 §2 范围内盘点表 + 每行落 AST gate/allowlist + 建 Bridge-wide P1
follow-up 并把编号回填 PR 描述。

## 0. 背景与边界

### 0.1 修什么（根因重定向后）

Bridge 反复 exit 137 的真凶是 **Bridge 自己的 `BridgeEventLoopWatchdog`（FLY-307，按设计
把 >60s 的 main-loop 卡死转成 SIGKILL 自杀 + launchd 重启）**；卡死 main loop 的是
**FLY-1336（#633）的 runner-TUI-window guarded session ensure 同步重试链**
（spawnSync，deadline 210s / attempt cap 90s，跑在 main loop 上）。
issue 原述的「codex daemon 组 SIGKILL 误伤 Bridge」经证据排除（见 research.md §2.3/§2.4）。

### 0.2 五个工作项（gate 批准的 A–E）

| 项 | 内容 | 治什么 |
|---|---|---|
| A | TUI-window ensure 路径异步化 | P0 死因（这一条同步链） |
| B | 残余同步预算钳制 + 盘点 | 下一条还没写出来的同步链 |
| C | watchdog breadcrumb + 重启归因告警 | 自伤不可见/误诊（Annie north-star） |
| D | defaultKillGroup 补「绝不杀自己真实所在组」 | 潜在 kill 缺口（纵深防御） |
| E | ensureDead settle 2s→10s（env 可调） | escalation churn |

### 0.3 Lead 硬要求（gate 回复原文要点）

1. **A 必须保 FLY-1336/1239 语义逐字不变**，测试钉死（重试预算、attempt cap、
   status=5 held 判定、died→有界重试/其余一次即停、单飞 latch、fail-open 边界）。
2. **与 FLY-1364 的边界写进 plan**（见 §6）：本单不碰 rescue 锁争用根因（1364 的
   lease 域）；残余行为 = 修完后锁争用**仍会拖慢 ensure**（最长仍是 210s 预算内的
   等待与重试），但**不再杀 Bridge**。1364 侧不得把「Bridge 活着」当成「锁健康」。
3. **C 的归因告警走既有 lead-alert 通道**（Bridge 侧 routed sink →
   `LeadAlertNotifier.alert(AlertPayload)`（既有公开发送面）→
   `~/.flywheel/alert-queue` → #flywheel-alerts，FLY-368 统一通道），不新开发送面。

### 0.4 不做（scope 边界）

- 不动 watchdog 阈值/检查节奏（FLY-307 语义保留）。
- 不修 tmux-server-rescue 锁争用为何发生（FLY-1364 域）。
- 不修 blink 下游的 stranded handoff / boot-reconcile（FLY-1339/1293）。
- 不动 daemon 强杀的组语义（detached + killTree + 两事实 reap 均保留原样）。

## 1. 工作项 A — TUI-window ensure 路径异步化（主修）

**文件**: `packages/claude-runner/src/codex-runner-tui-window.ts`、
`packages/claude-runner/src/CodexTmuxAdapter.ts`

**API 形状（双 seam，Codex R1 #2）**——sync 与 async 各自独立成套，不原地改签名：

1. 新增 **async seam 全套**，仅供新的
   `ensureRunnerTuiWindow(): Promise<RunnerTuiWindowOutcome>` 使用：
   async `exec` / `execOut` / `ensureSessionWithRetry` / `sleep` / purge / settle-liveness。
   - async ensure 变体：同 argv、同 status 判定（**非零 status 继续重试**，覆盖测试的
     status=4 与生产的 status=5）、同 log 文案；
     **deadline 210s / attempt cap 90s 的默认值与 env 名一字不动**
     （`FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` / `FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS`）。
   - async spawn wrapper 钉死语义：`error`/`close` 单次结算（settled latch）、
     timeout 到点默认 SIGTERM、被信号杀时 `status: null`、stdout 只保留 500 字尾部、
     每次 attempt 的 timeout = `min(attemptCapMs, remaining-deadline)`（clipping 保留）。
   - outcome 语义（`created` / `died` / `tmux-absent` / `create-failed`）逐字保留。
2. **有界 sync helper 保留**（`defaultExec` 10s / `defaultExecOut` 5s / 同步
   liveness probe），只供显式登记的同步路径：`isRunnerTuiWindowAlive`、
   `killRunnerTuiWindow`（teardown，频次低、单次有界 —— 全 async 化会扩大
   FLY-1239 边界改动面，本单不做）。这些登记进 B 的残余清单 + 打 breadcrumb（C）。
   同步版 `ensureSessionWithRetry` 保留导出（测试兼容），JSDoc 标注
   「生产路径已 async 化，不得在 Bridge 进程内新增同步调用」。
3. `CodexTmuxAdapter` 两个调用点改 await：
   - `attemptOpen`（`:537`，FLY-1239 reopen 链）：回调转 async，**保住**：
     单飞 latch（`tuiOpening`/`tuiOpened`）、`runEnded` 早退、`cancelReopen` 边界、
     died→`TUI_OPEN_MAX_ATTEMPTS` 有界重试、其余 reason 一次即停、no-throw 边界
     （async 回调的 rejection 必须落在自身 catch 内，绝不成为 unhandled rejection）。
   - fallback open（`:752`）：直接 await。
4. **active-attempt 生命周期（Codex R1 #1 BLOCKER —— 晚创建竞态的封口）**：
   仅复查 `runEnded` 不够——ensure 返回 `created` 前 `new-window` 已经执行，
   teardown 的 finally 只能取消**尚未触发**的 scheduler，管不到 in-flight ensure，
   会出现「teardown 先 kill 了还不存在的窗口 → in-flight ensure 随后创建指向已停
   daemon 的孤儿窗口」。协议：
   - adapter 持有 **in-flight ensure 的 promise + AbortController**；async seam 的
     spawn、retry sleep、后续每步都响应 abort（abort → 立即停止推进、不再发起
     `new-window`；已发出的子进程按 wrapper 的 kill 语义终止）。
   - finally 顺序固定：置 `runEnded` → 取消 scheduled callback（`cancelReopen`）→
     **abort + 有界 join** in-flight attempt（有界 = join 超时也继续 teardown，
     fail-open）→ 之后执行 terminal `killWindow`。
   - **late-created 必杀协议（Codex R2 #1：一次 re-scan 没有 happens-after，
     tmux server 可能在 join 超时 + terminal kill + 扫描都完成后才提交窗口）**：
     - 从既有 `purgeSameNameWindows` 中**抽出纯 teardown 原语**
       `scanAndKillSameNameWindows`（只 enumerate + 按不可变 id kill；
       **不 re-ensure session、不 create scaffold** —— 现有 purge 会重建 session
       （`codex-runner-tui-window.ts:307-360`），不能原样用于 terminal cleanup）；
     - join 超时（active promise 未确认 settle）时，给 active promise 挂一个
       **no-throw late-cleanup continuation**：promise 真正 settle 后（无论
       resolve/reject）再执行最后一次纯 `scanAndKillSameNameWindows` —— 与晚提交
       的 `new-window` 建立 happens-after；continuation 自身 fail-open、绝不产生
       unhandled rejection。
     - 等价替代（implement 可选其一）：abort 后的 async ensure 在**自己的 finally**
       里完成同样的自清理（检测到 abort → 若已发出 create 则自杀该窗口）。

**验收（A）**：`codex-runner-tui-window.test.ts` 全量迁移到 async 后原断言逐条等价
通过（含 status=4 held→重试用例）；新增：
- 「ensure 在飞行中不阻塞 event loop」（fake 慢 spawn + 同 tick 定时器仍触发）；
- **deferred-ensure 跨越 finally** 测试（Codex R1 #1 + R2 #1）：fake `new-window`
  被强制推迟到 **terminal kill 与第一轮扫描都完成之后**才提交 → 必须证明
  (a) late-cleanup continuation 最终收掉它（eventual cleanup）(b) 结束态零存活
  同名窗口 (c) 零 unhandled rejection —— 覆盖 ordinary 与 controlled-shutdown
  （phaseLifecycle）两条 teardown 顺序；另证 `scanAndKillSameNameWindows`
  纯度（不 re-ensure、不 create —— mutation：换回旧 purge 后纯度测试转红）；
- async wrapper 语义钉死测试（单次结算 / SIGTERM on timeout / status null /
  500 字尾部 / deadline clipping）。

## 2. 工作项 B — 残余同步预算钳制 + 盘点

**保证范围（Codex R2 #2 收窄）**：B 的 ≤10s/≤30s 预算不变量**只对本次事故路径
生效** —— `packages/claude-runner` 的 codex TUI/daemon 路径
（`codex-runner-tui-window.ts` + `CodexTmuxAdapter.ts` + `codex-daemon-runtime.ts`）。
**不承诺全 Bridge**：审查已发现 teamlead 侧存在超出本单范围的同步调用
（`run-infra.ts:96-110` 20s execFileSync 及 `:258`/`:458-461`/`:976-980` 无 timeout、
`workflow-docs-git.ts:377-380` 30s spawnSync（由 `plugin.ts:580,4490` 实例化）、
management cron source/writer 与 `ActionExecutor` 的无 timeout execFileSync）——
这些**开独立 follow-up issue**（Bridge-wide 同步调用盘点与钳制，P1，
implement 段建单并在 PR 描述引用），不塞进本单。

**产出**: 本文件夹 `plan.md` 附录的**范围内完整盘点表**（implement 第一步落表）
+ 代码内注释 + 静态门测试 + follow-up issue

1. **盘点表**（Codex R1 #5：字面 grep 抓不全）每行：
   `生产可达调用点 → 当前 timeout → 修后 timeout → 同步段共享预算/最大迭代数 →
   处置(async 化/保留豁免+理由) → breadcrumb label`。范围内已知必须入表的：
   - `codex-runner-tui-window.ts` 残余 sync helper（`defaultExec` 10s /
     `defaultExecOut` 5s / `killRunnerTuiWindow` / `isRunnerTuiWindowAlive` /
     新抽的 `scanAndKillSameNameWindows`）；
   - **`CodexTmuxAdapter` 经注入 `defaultExecFile` 的全部同步 tmux/codex/gh/git
     调用** —— 多处当前未传 timeout（`:267-268`、`:304`、`:323-330`、`:347-348`、
     `:1395-1404`、`:1427-1434`），而 `TmuxAdapter.ts:1587-1603` 的 `defaultExecFile`
     在 opts 缺省时是**无上限** timeout → 逐处补上界；
   - daemon runtime 的 `ps`/`lsof` seam（单次 2s）：**holder 循环对多个 pid 连续
     执行时改用共享 deadline / 最大迭代数**（单次有界 ≠ 整段有界）。
2. 硬指标（范围内）：任意单次同步调用 ≤10s；同一无 await 间隔的连续同步段
   （含循环整段）总和 ≤30s（< watchdog 60s 的一半）。超出者 async 化，或
   breadcrumb 覆盖 + 书面豁免理由入表。
3. **静态门**（AST 级，不是裸 grep，范围 = 上述三文件）：覆盖 (a) 字面
   `spawnSync`/`execFileSync` 必须带 `timeout` (b) **`this.execFileFn(...)` /
   imported exec seam 的每个调用点**必须传 timeout 参数。表中每行必须被静态门
   或显式 allowlist 测试覆盖。
4. 不改 watchdog 阈值；不给 sync ensure 变体加新预算（生产已不走它）。

**验收（B）**：盘点表落地 + 静态门测试绿 + **mutation 验证**：把
`resolveWindowId` 或 preflight 调用点的 timeout 删掉后静态门必须转红 +
follow-up issue 已建（编号回填 PR 描述）。

## 3. 工作项 C — watchdog breadcrumb + 重启归因告警

**文件**: `packages/teamlead/src/bridge/BridgeEventLoopWatchdog.ts`、
`packages/teamlead/src/bridge/bridge-exit-marker.ts`、
`packages/teamlead/src/bridge/plugin.ts`（`bridge_abnormal_exit` emission 位点
`:9187-9207`）、新增小模块 `packages/claude-runner/src/sync-op-marker.ts`
（或 teamlead 内共享 util，implement 定，跨包经文件契约解耦）

**总原则（Codex R1 #3 BLOCKER 的修正）**：仓内**已有** boot abnormal-exit 归因层
—— `bridge-exit-marker.ts` 在启动最前面 latch 上一代 dirty marker（PID+bootTs 构造
durable episode/eventId），alert sink ready 后经 routed sink → `LeadAlertNotifier.alert`
（公开面是 `alert(AlertPayload)`，**没有** notify()）→ queue → #flywheel-alerts 发
`bridge_abnormal_exit`，幂等由 claims/StateStore/queue 既有三层管。
**C 不新建第二条 boot sender、不新建独立 ack 文件、不在 `:7095` watchdog wiring 处
发任何告警** —— 只做两件事：让 stall 证据可精确归因（1/2），并在**既有 emission
位点**把它并进既有 ticket（3）。

1. **breadcrumb**：`markSyncOp(label)` → `{label, startedAt, pid, token}` 原子替换写
   **per-PID 文件** `~/.flywheel/bridge-syncop.<pid>.json`（目录 env 可调
   `FLYWHEEL_BRIDGE_SYNCOP_DIR`）—— per-PID 命名从结构上消灭多 Bridge 并存时的
   互覆（Codex R2 #3：单文件 atomic replace 仍会互覆，token-aware 只能防误删）；
   `clearSyncOp()` 只清除 pid+token 都匹配自己的 marker。boot 时 best-effort 清扫
   pid 已死的陈旧 syncop 文件。插桩点 = B 盘点表中保留豁免的同步点。
   写失败静默（marker 绝不破坏业务路径）。
2. **watchdog forensic 增强**：stall 行在现有字段外**持久化 `pid` + 本代
   `bootTs`（generation）**。`bootTs` **启动时单点捕获一次**
   （`const bridgeBootTs = Date.now()`），同一个值传给 running marker
   （现 `plugin.ts:3682-3685` 的 `writeRunningMarker`）**和** watchdog worker
   （Codex R2 #3：两处各自取 `Date.now()` 会造成 generation 永不匹配）；
   「上一代 boot 区间」定义为 `[prev.bootTs, bridgeBootTs)`。worker 读**自己 pid**
   的 syncop 文件，`pid` 匹配 + `startedAt` 落在 stall 窗口内时并入
   `last_sync_op`。所有 marker/log 读取复用本仓 `readLockHolderPid`
   的防御形状：O_NOFOLLOW|O_NONBLOCK、必须 regular file、大小上限、JSON schema +
   有限数值校验，异常一律降级为「无该证据」。
3. **归因并入既有 `bridge_abnormal_exit`**：在 plugin.ts `:9187` 现有
   `prevExitMarker?.state === "running"` 分支里读 `bridge-watchdog.log` 尾部 stall
   记录，**仅当三条件同时成立**才把 ticket 的 title/body 升级为 watchdog 归因文案
   （「上一代 Bridge 被自身 watchdog SIGKILL（main loop 卡死 Xs，最后卡点:
   <label|无标记>）」）：
   (a) previous exit marker state 为 running；
   (b) stall 行的 `pid`+`bootTs` 与上一代 marker **精确匹配**；
   (c) stall 的 `at` 落在上一代 boot 区间内。
   任一不满足 → 保留现有 generic abnormal-exit 文案（**宁可少归因，绝不误归因**
   —— Codex R1 #4：共享日志/QA Bridge/pid 复用都可能污染尾条）。事件仍走既有
   `bridge_abnormal_exit` 通道与幂等（不新增 AlertEventType、不新增 ack 层）。

**验收（C）**：单测覆盖 marker 写读 / pid+token 不匹配不清除 / 防御读降级
（symlink、FIFO、超大文件、坏 JSON、旧尾行）；watchdog 专测（testMode）验证
forensic 行含 pid+bootTs+`last_sync_op`；emission 位点集成测：三条件全满足 →
watchdog 文案恰一次；pid/generation mismatch、QA-Bridge 同路径污染、stall 早于
上一代 boot 区间 → 回退 generic 文案（**mutation 验证**：把三条件之一的判定删掉后
对应测试必须转红）。

## 4. 工作项 D — defaultKillGroup 自组保护补洞

**文件**: `packages/claude-runner/src/codex-daemon-runtime.ts`（`defaultKillGroup`）

1. 首次调用时经既有 `ps -o pgid=` seam 取 **自身真实 pgid**（`processGroupOf(process.pid)`）
   并缓存；`pgid === 自身真实 pgid` → 拒绝并打日志（现有 pid/ppid guard 保留）。
2. 取不到自身 pgid（ps 失败）→ 仅维持现有 guard（best-effort，绝不因此挡住对
   daemon 组的正当 kill —— kill 目标本就经结构性证明）。
3. 每次真实 `kill(-pgid)` 前打一行日志（pgid + signal），可见性。

**验收（D）**：单测注入 fake processGroupOf：命中自组 → 拒绝；lookup 失败 →
现行为不变；正常 daemon 组 → 放行。mutation 验证：去掉新 guard 后「自组拒绝」测试转红。

## 5. 工作项 E — ensureDead settle 放宽

**文件**: `packages/claude-runner/src/codex-daemon-runtime.ts`

1. `childExitWaitMs` 默认 2_000 → 10_000，新增 env `FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS`
   （沿用 numEnv 风格校验）。影响面：ensureDead 两段 settle + cleanupAndThrow 的
   exit/socket 等待（全 async await，不碰 main loop）。
2. 书面记录副作用：teardown 最坏路径变慢（~2×10s settle），`drained()` 调用方
   均为 async 等待，可接受。escalation 日志预期显著减少（原 16 次全属 2s 太紧）。

**验收（E）**：现有 daemon runtime 测试注入 childExitWaitMs 的用例不变；新增默认值
+ env 覆盖测试。

## 6. 与 FLY-1364 的边界（Lead 硬要求 ②）

- FLY-1364（runner 60c3a873）拥有 tmux-server-rescue 锁/lease 争用的根因域。
- 本单落地后的**残余行为**（1364 侧请以此为基线）：
  - 锁争用（status=5 acquire_timeout）仍会发生、仍会拖慢 founder TUI 窗口出现
    （最长 210s 预算内重试，之后 fail-open 放弃开窗、run 继续）；
  - 但 ensure 全程不再占 main loop → **不再触发 watchdog 自杀、Bridge 不再 blink**；
  - 争用期间的证据面：`guarded session ensure attempt N held` 日志照旧 +（C 上线后）
    breadcrumb/告警不再把锁争用误报成 Bridge 死因。
  - **「Bridge 活着」不能当「锁健康」的证据**——判锁健康请看 held 日志与 1364 自己的
    lease 观测。
- **同文件/同函数协同（Lead 补充指令 80b54c57）**：1364 正在改
  `codex-daemon-runtime.ts` 的 `ensureDead` SURVIVED 分支（`:553-555`「SURVIVED →
  return false 永久持锁」= 它的卡锁根）。本单 D/E 也落在同一文件：
  - D 只动 `defaultKillGroup`（文件尾部独立函数）、E 只动 `childExitWaitMs` 默认值
    与 env 读取（`:341` 一行 + options 注释），**均不触碰 ensureDead 的 SURVIVED
    分支与锁语义** —— diff 保持外科手术式，结构上与 1364 的改动不重叠。
  - E 的副作用对 1364 有利（settle 放宽 → 走到 SURVIVED 的概率下降），但 1364
    不得依赖 E 作为修复（它要治的是 SURVIVED 之后的持锁行为本身）。
  - 落地顺序：先 merge 者不管；后 merge 者 rebase 并复核 ensureDead 语义未被对方
    改变（两边 PR 描述互相引用本节）。

## 7. 交付与测试策略

- **单 PR** 交付 A–E + 本文件夹三件套（docs travel with branch）。
- TDD：先写 async-parity / guard / attribution 的失败测试再动实现（RED→GREEN→REFACTOR）。
- 全仓 `pnpm lint` + 相关包测试套件；CI 绿后 Codex code review（xhigh）。
- **独立 QA（FLY-1211 硬门，implement 段完成后由独立 session 执行）**建议脚本：
  1. 隔离环境（529 Room `--alerts` 镜像，FLY-529 已交付的隔离 alerts 通道）起 Bridge；
  2. 注入锁争用（占住 tmux-server-rescue 守护锁）→ 触发 ensure → 断言:
     心跳不断流、watchdog 不杀、TUI 开窗按预算重试、held 日志照旧（A/B）；
  3. 人工注入 main-loop 卡死（testMode 或真 spin）→ 断言 forensic 行含
     pid+bootTs+last_sync_op、重启后 #test-flywheel-alerts 收到的
     bridge_abnormal_exit 恰一条且带 watchdog 归因文案（C，幂等复启验证 +
     三条件不满足时回退 generic 文案）；
  4. 单测层已覆盖 D/E 的 mutation 验证。
- 风险回滚：A 是行为等价迁移（预算/语义不变），异常时可整 PR revert；C 的告警若
  误报可先按 FLYWHEEL 既有 alert 通道治理，无独立 kill-switch 需求（不新增旗标面）。

## 8. 里程碑

| # | 内容 | 验收 |
|---|---|---|
| M1 | A：ensure 路径 async 化 + 调用点迁移 + parity 测试 | 测试全绿，语义钉死 |
| M2 | B：同步预算盘点/钳制 + 静态断言测试 | 清单 + 断言绿 |
| M3 | C：breadcrumb + forensic 增强 + boot 归因告警 | 单测 + mutation 绿 |
| M4 | D+E：killGroup 补洞 + settle 放宽 | 单测 + mutation 绿 |
| M5 | 全仓 lint/test + Codex code review + 独立 QA | CI 绿 + review APPROVED + QA PASS |

## Appendix A — 范围内同步调用完整盘点（implement 实测）

盘点范围严格按 §2：codex TUI / adapter / daemon 的外部进程调用。`AST timeout
contract` 对三个文件中的全部字面 `spawnSync` / `execFileSync` 及全部
`this.execFileFn` 调用逐点检查；删除任一 timeout 会让测试转红。小型本地状态文件的
同步读写不在本事故的外部命令等待模型内，仍由既有原子写、大小限制和 fail-open
边界约束。

| 生产可达调用点 | 修前 timeout | 修后 timeout | 同步段共享预算 / 最大迭代 | 处置与理由 | breadcrumb | 门禁 |
|---|---:|---:|---|---|---|---|
| TUI guarded session ensure（原 `spawnSync` 重试） | attempt 90s；总 210s | async attempt 90s；总 210s | **无同步段**；异步 deadline 不变 | 全量 async 化，保留 FLY-1336/1239 重试语义 | 不需要（不会卡 main loop） | async parity / timer / clipping tests |
| `killRunnerTuiWindow` → `defaultExec` | 10s | 10s | 单次 10s | teardown 低频调用，保留有界 sync | `codex-tui:tmux-exec` | AST `spawnSync` gate |
| `isRunnerTuiWindowAlive` → `defaultExecOut` | 5s | 5s | 单次 5s | 快速 liveness probe，保留有界 sync | `codex-tui:tmux-read` | AST `spawnSync` gate |
| `scanAndKillSameNameWindows` | N/A | async：list 5s / kill 10s | **无同步段**；逐窗口 await | terminal-only 纯清理，不 ensure / 不 create | 不需要 | purity + late-cleanup tests |
| `checkEnvironment`: `tmux -V` | 无上限 | 10s | 与下一行合计 ≤20s | 保留有界 sync；启动前健康检查 | `codex-adapter:health-tmux` | AST exec seam gate |
| `checkEnvironment`: `codex --version` | 无上限 | 10s | 与上一行合计 ≤20s | 保留有界 sync；启动前健康检查 | `codex-adapter:health-codex` | AST exec seam gate |
| `provisionGitHubCredential`: `gh auth token` | 无上限 | 10s | 与下两行合计 ≤30s | 保留有界 sync；单次启动凭证布置 | `codex-adapter:gh-token` | AST exec seam gate |
| `provisionGitHubCredential`: git credential config | 无上限 | 10s | 三调用共享段 ≤30s | 保留有界 sync；best-effort | `codex-adapter:git-credential` | AST exec seam gate |
| `provisionGitHubCredential`: git URL rewrite | 无上限 | 10s | 三调用共享段 ≤30s | 保留有界 sync；best-effort | `codex-adapter:git-url-rewrite` | AST exec seam gate |
| `execute` preflight: `tmux -V` | 无上限 | 10s | 与下一行合计 ≤20s | 保留有界 sync；每 adapter 一次 | `codex-adapter:preflight-tmux` | AST exec seam gate |
| `execute` preflight: `codex --version` | 无上限 | 10s | 与上一行合计 ≤20s | 保留有界 sync；每 adapter 一次 | `codex-adapter:preflight-codex` | AST exec seam gate |
| `resolveWindowId`: tmux display-message | 无上限 | 5s | 单次 5s | founder visibility best-effort | `codex-adapter:resolve-window-id` | AST exec seam gate + mutation RED |
| `resolveGitWritableDirs`: git rev-parse | 无上限 | 10s | 单次 10s | runner 可提交性的 fail-loud 前置条件 | `codex-adapter:resolve-git-dirs` | AST exec seam gate |
| daemon `processGroupOf`: `ps` | 2s | 2s | orphan proof 最多 10 PID，且共享 deadline 20s | 两事实破坏性操作证明；超时即拒绝 kill | `codex-daemon:ps-pgid` | AST `execFileSync` gate + loop-bound test |
| daemon `socketHolderPids`: `lsof` | 2s | 2s | 单次 2s | socket holder 证明；失败即无证明 | `codex-daemon:lsof-socket` | AST `execFileSync` gate |

Bridge-wide 残余同步调用已建 P1 follow-up **FLY-1368**；PR 描述同步引用，避免把
teamlead 全面治理偷渡进本 P1 修复。
