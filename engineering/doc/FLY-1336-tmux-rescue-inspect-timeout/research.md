# FLY-1336 满载机 tmux-rescue 超时 — 调研

Issue: FLY-1336 (https://linear.app/geoforge3d/issue/FLY-1336/infra-满载机上-tmux-server-rescue-3s-inspect-超时-runner-spawnturn-start-随机)
日期: 2026-07-17
基于: exploration.md

Brainstorm gate 已批(Tadashi):三层超时预算不咬合根因成立;修法 = 预算组合(外层 cap ≥ 内层合法最坏和)+ 案4 语义修复(GHOST_GUARD 不得报假失败)+ 案1 inflight 收口。**窄而对,别扩面**。案2(codex-daemon turn/start 30s)未列入批准范围 → 本单显式 non-goal。

## 1. 预算链全量清单(实读代码)

### 1.1 rescue 脚本层(scripts/lib/tmux-server-rescue.sh,安装于 ~/.flywheel/bin/tmux-server-rescue)

| 位置 | 超时 | 默认 | 说明 |
|---|---|---|---|
| :98 lsof(每候选 pid 一次) | INSPECT_TIMEOUT_SEC | 3s | rc≠0 且非「rc=1+pid 存活」→ 返回 2 → scan_complete=false |
| :126 ps axww | INSPECT_TIMEOUT_SEC | 3s | rc≠0 → 整个 server 扫描失败 → scan_complete=false |
| :156 tmux display-message | INSPECT_TIMEOUT_SEC | 3s | rc=124/125 → scan_complete=false |
| :290/:311/:333/:347/:372/:393 verify/create | COMMAND_TIMEOUT_SEC | 5s | 124/125 → hold_unknown(command_timeout)exit 4 |
| :595 flock/lockf/python 锁 | LOCK_TIMEOUT_SEC | 5s | 抢不到 → hold_lock_unavailable exit 5 |

超时执行机制:`_tmux_rescue_bounded_exec`(:40)= /usr/bin/python3 子进程 + `proc.communicate(timeout=…)` + 超时 killpg SIGKILL + exit 124。python3 启动本身不计入 timeout(timeout 从 Popen 后起算),但 python3 冷启动在满载下也要几百 ms 的**墙钟**,会计入外层 TS cap。

一次 ensure(reachable 快乐路径)的命令序列:
lock(≤5s)→ inspect#1(tmux + ps + N×lsof)→ verify(≤5s)→ inspect#2(tmux + ps + N×lsof)。
**最坏合法预算 ≈ 5 + 2×(3+3+N×3) + 5 = 10 + 6(2+N)·s**。N=3 时 ≈ 40s;`missing_single_orphan` 恢复路径含 signal 前重验 + 至多 20 轮恢复轮询 inspect,更大。

N 的现实取值:`_tmux_rescue_server_pids`(:122)筛「同 uid、ppid=1、argv 是 tmux/『tmux: server』」的进程 = 本机 tmux server 数。生产常态 1-3(default + QA slot + 泄漏世代);FLY-1285 事故形态下更多。**注意 lsof 只对『非 reachable_pid 的候选』跑**(:170-171),正常单 server 时 N_lsof=0;有孤儿/多世代时才逐个 lsof。

### 1.2 TS 调用层

| 调面 | 文件:行 | 外层预算 | 重试 | 失败面 |
|---|---|---|---|---|
| claude/agy/kimi spawn | TmuxAdapter.ts ensureRunnerSession :1387 | per-attempt `min(10_000, remaining)` SIGKILL(:1437);deadline `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 默认 90s | 有(1s 间隔) | deadline 耗尽 → TmuxSessionHoldError("unknown") = 案3 文本 |
| codex runner TUI 窗口 | codex-runner-tui-window.ts defaultEnsureSession :130 | spawnSync timeout 90s | **无** | status≠0 → false → "ensure held — skipping" → spawn fail |
| Bridge ghost guard | runs-route.ts :81 `GHOST_GUARD_SESSION_WAIT_MS = 30_000` 硬编码 | waitForSession(:959,:1306)/ waitForGeneralizedLaunchDelivery(:971) | 轮询 50ms | 超时 → 500 START_NOT_LIVE / 409 LAUNCH_NOT_COMMITTED(假失败,案4) |

**不咬合的数学**:外层 10s < 内层最坏 40s+。满载下 rescue 每条命令逼近 3s(实测 2731ms),一次 inspect(串行 2+N 条)+锁+verify 合法耗时轻松 >10s → 外层 SIGKILL → 无 hold JSON → parseHold=unknown → 1s 后重试,重试命运相同 → 90s 全灭。**重试逻辑存在但结构上不可能成功**。

### 1.3 launch delivery 路径(案4)

`waitForGeneralizedLaunchDelivery`(generalized-launch-recovery.ts:61):轮询 StateStore `workflow_launch_owner`,等 `committed_generation === owner_generation && delivery_state === "delivered"`,超时返回 undefined。三个调用点:

1. runs-route.ts:971(HTTP /api/runs/start)→ undefined → **409 GENERALIZED_LAUNCH_NOT_COMMITTED**。文案是「not committed」,实际语义只是「30s 内没等到」。adea4e32 铁证:超时返回后 launch 照样 committed+delivered+session running。调用方(orchestrator/Lead)把 409 当失败重试 → 撞 active-phase 保护。
2. actions.ts:1166(retry dispatch)→ 同构:false + "not durably committed"。
3. workflow-engine-dispatcher.ts:484 → false → `markStarted` 不执行(engine 认为没起来,但 runner 可能已活)。

实测 launch delivery @load 37 = 20.5s,余量 9.5s;更高负载必穿。

### 1.4 案1 inflight 泄漏点(run-dispatcher.ts)

两条路径的 `entry.promise` 链均有 `.finally(() => inflight.delete(key))`(:850, :1445)✓。泄漏窗口 = `inflight.set` 之后、`entry.promise` 赋值之前的中段同步/await 抛错:

- start():inflight.set(:1119)→ buildRunnerSpawnFields(:1130)/ resumeComputer(:1272)等裸抛点 → entry.promise(:1377)
- dispatchRetry():inflight.set(:583)→ buildRunnerSpawnFields(:595)/ computeRetryStartPoint(:660,显式 throw)/ waitForSession 段等 → entry.promise(:807)
- 已收口的点(证明模式已确立,只是没铺满):TURN grant(:1251)、workflowClaimsAdmission(:1185)、commitLaunch(:797,:1370)→ `abortPreLaunch`(:920,幂等,删 inflight + 清 CommDB 预注册 + 通知 lifecycle guard)

案1 的「Command failed: tmux-server-rescue ensure」原始文本 = Node execFile 的错误 message 形态。ensureRunnerSession 内部会把它包装成 HoldError,但中段裸抛点抛出的**其它**错误(以及任何把原始 execFile 错误直接透传的路径)都会带着原始 message 逃逸。implement 时以「中段全段收口」为准,不依赖精确复现那一条 message(收口后无论哪个点抛,inflight 都清)。

## 2. 平台与工程事实

- **loadavg 读取**:macOS `sysctl -n vm.loadavg` → `{ 30.77 31.93 35.00 }`;Linux `/proc/loadavg`。核数:macOS `sysctl -n hw.ncpu`(本机 18),Linux `nproc`。生产=Mac / CI=Linux(FLY-1285 教训:平台谓词必须两态都真机验过,fixture 用真抓格式)。
- **bash 版本**:脚本声明 #!/bin/bash(macOS 3.2)。已有代码只用 POSIX 算术,load 计算需整数运算(bash 3.2 无浮点)——用 scaled-integer(load×100)做乘除。
- **现有测试资产**:`scripts/__tests__/tmux-server-rescue.test.sh`(hermetic,PATH 插桩 tmux/ps/lsof,FAKE_* env 控制行为/延迟)、`tmux-server-rescue-lock.test.sh`、`tmux-server-rescue-real-tmux.test.sh`(真 tmux);TmuxAdapter.test.ts(~110 it,含 ensure 套件);runs-route/generalized-launch-recovery 均有 vitest。
- **字节兼容基线**:三个 rescue env 已存在且被 QA/房测使用(FLY-1282/1285 配方显式设过);TmuxAdapter 的 `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 已存在。改默认值 = 行为变化,需在 plan 里明示(这单的目的就是改默认,不追求字节兼容;但 **env 覆盖语义必须保留**,QA 配方靠它)。
- **flywheel-comm CLI 本身也在超时**:本 design 会话中 `stage set` 多次「operation was aborted」,重试成功——同一负载根因的又一例(记录在案,不入本单 scope)。

## 3. 方案候选与取舍(研究结论)

### 3.1 load 因子(B-lite)的形态

结论:**单点采样、整数运算、clamp 上限、失败回退 1×**。

```
factor = clamp(1, ceil(load1 / ncpu), FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX 默认 4)
effective_timeout = base × factor
```

- load1(1 分钟)比 load5 响应快,匹配「spawn 此刻卡不卡」。
- 采样一次/每次 rescue 进程启动(不是每条命令),避免采样本身成为新开销。
- 读取失败(sysctl/proc 不存在、解析失败)→ factor=1,行为退化为纯静态,绝不因 load 探测失败而 fail。
- 不做连续反馈/EWMA——「窄而对」。

放置层:**只在 rescue 脚本内做 load 缩放**。TS 层不重复采样——TS 层的职责是「cap ≥ 内层最坏和」,直接把 cap 定成覆盖 max-factor 情况的静态值(env 可调),避免两层各自采样漂移。

### 3.2 内层基值与外层 cap 的推荐数值

内层(rescue):
- INSPECT_TIMEOUT_SEC 默认 3 → **6**(基值;×factor 上限 4 → 满载最坏 24s/条)。实测 2731ms@load37,基值 6s 在 factor≥2 时给出 12s+,余量充分。
- COMMAND_TIMEOUT_SEC 默认 5 → 保持 5(基值;×factor)。verify/create 是本地 socket 操作,实测未见接近 5s;load 缩放已覆盖。
- LOCK_TIMEOUT_SEC 默认 5 → 保持 5(×factor)。锁竞争者是并发 spawn,满载时等锁变长是正常的。
- 新增:**单条命令超时后立即重跑一次**(仅 inspect 命令;瞬时抖动吸收)。重跑同样计入总墙钟,被外层 cap 兜底。

外层:
- TmuxAdapter per-attempt cap:`min(10_000, remaining)` → **`min(FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS 默认 75_000, remaining)`**。75s 覆盖「factor=4、N=2、含单次重跑」的最坏合法内层预算(见 plan 预算表),同时仍小于 deadline,保证 deadline 内至少 2 个完整 attempt 的机会。
- `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 默认 90s → **180s**。满载下第一 attempt 可能吃满 75s,180s 给 2 次完整 attempt + 间隔。spawn 是后台流程,多等 90s 换随机失败归零,代价可接受(调用方 runs-route 对 spawn 的等待走 ghost-guard 自己的窗口,不叠加阻塞 HTTP——见 3.4)。
- codex-runner-tui-window.defaultEnsureSession:补重试循环(镜像 ensureRunnerSession 的 deadline/attempt 结构,sync 版本;同 env)。
- GHOST_GUARD_SESSION_WAIT_MS 30s 硬编码 → env `FLYWHEEL_GHOST_GUARD_WAIT_MS` 默认 **90_000**(launch delivery 实测 20.5s@load37,×4 安全系数)。

### 3.3 超时语义与真 hold 分流(C1)

rescue 输出侧:
- inspect 超时 → verdict 仍 unknown(fail-closed 不变),但 evidence.reason 新增区分:`inspect_timeout`(vs 现在统一的 verdict 文本)。
- verify/create 超时已有 reason=command_timeout ✓,保持。
- 真 hold(saturated/split_brain/ambiguous)reason 不变。

TS 消费侧(parseHold 已按 kind 分流):`unknown`+timeout reason = 可重试;`saturated/split_brain/ambiguous` = 有证据的危险状态。ensureRunnerSession 现在对**所有** hold 一律重试到 deadline——对真 hold 这是 90s 的无意义空转,但也无害(fail-closed 不变)。窄改法:仅把 timeout-类 reason 与真 hold 在**日志与 evidence 上**区分开(可观测性),重试策略不动(避免扩面改行为)。

### 3.4 案4 pending 语义(E)

结论:**超时后终查 + 「pending」响应,绝不把「还没等到」说成「没发生」**。

- runs-route(:971 段):`waitForGeneralizedLaunchDelivery` 超时返回 undefined 后,**再读一次** `store.getWorkflowLaunchOwner(executionId)`:
  - 已 committed+delivered(等待期间落地)→ 照常走成功响应(修复了 30s 边界竞态)。
  - 仍未 → 返回 **202** `{ success: false, pending: true, code: "GENERALIZED_LAUNCH_PENDING", executionId, … }`——语义 =「launch 已受理、正在收敛,勿重试,以 session 事件为准」。不再用 409 NOT_COMMITTED。
  - `waitForSession` 超时(:959/:1306)同构处理:终查 session;仍无 → 202 START_PENDING(而非 500 「failed to start」)。
- actions.ts / workflow-engine-dispatcher 两个调用点:同样把「超时」与「失败」分开——actions 返回 `{ success: false, pending: true, message: … }` 形态;engine dispatcher 超时时**不**回 false-即-重派,而是留待既有 reconcile(marker-reconciler / crash recovery)按 committed 证据收敛。具体每点的最小改法在 plan 定稿。
- 响应码选 202(HTTP 语义「已接受未完成」),明确新 code 字符串;消费方(Lead HTTP 调用、orchestrator)按 code 分支,旧 code 路径不复用避免误判。

### 3.5 案1 inflight 收口(D)

start() 与 dispatchRetry() 各自:`inflight.set` 之后到 `entry.promise` 赋值之前整段包 try/catch → catch 里 `abortPreLaunch(key, executionId, projectName)` + rethrow。已有局部收口点保持不动(重复调用 abortPreLaunch 幂等)。补一条回归:中段任一点抛错(注入 resumeComputer throw)→ 断言 inflight 槽已清 + 可立即重派同 (issue, role)。

## 4. Non-goals(gate 拍板的窄边界)

- **案2 turn/start 30s**(codex-daemon-client.ts:205):未列入批准范围。若复发另开 issue(同根因不同子系统;改动面 = requestTimeoutMs env 化 + 默认值)。
- rescue 的 fail-closed 决策模型(unknown 不 create、真 hold 不放松)**不动**——本单只修「合法慢被误判为死」。
- 不做连续自适应/反馈控制;不改锁机制;不动 FLY-1329 scope(park-alive/finalize)。
- flywheel-comm CLI 自身的 abort(本会话实测)不入本单。

## 5. 测试与验证思路(plan 细化)

1. **hermetic**(既有 FAKE_* 桩扩展):FAKE_*_SLEEP 注入慢命令 → 断言新默认下 inspect 不再 124;load 因子单元测试(桩 sysctl/proc 读取,断言 clamp 上下界与失败回退 1×);单条重跑逻辑(第一次超时第二次成功 → verdict 正常)。突变验证:把因子桩成 0/负数/垃圾 → 必须回退 1×。
2. **TmuxAdapter vitest**:per-attempt cap 新默认与 env 覆盖;真 hold vs timeout 的 evidence 透传;deadline 内多 attempt 收敛。
3. **runs-route/recovery vitest**:超时→终查→202 pending;等待期间 committed 落地→成功;真未 committed→pending 不 409;旧成功路径字节不变。
4. **run-dispatcher vitest**:中段注入抛错 → inflight 已清 + 重派成功(两条路径各一)。
5. **real-tmux 测试**(既有 real 套件扩展):真 tmux + 人工 CPU 压力(或 FAKE sleep 注入)下 ensure 收敛;macOS/Linux 双平台谓词(CI=Linux 只能验 Linux 侧,mac 侧靠本机真机跑——FLY-1285 教训写进 plan 的 QA 段)。
6. **真机 QA(独立)**:满载窗口(或人为造载)重放案3/案4 形态:spawn 收敛不 fail-closed;409 假失败归零(DB 对照)。
