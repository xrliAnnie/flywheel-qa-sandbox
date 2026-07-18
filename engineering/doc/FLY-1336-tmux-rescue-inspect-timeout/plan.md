# FLY-1336 满载机 tmux-rescue 超时 — 实施计划

Issue: FLY-1336 (https://linear.app/geoforge3d/issue/FLY-1336/infra-满载机上-tmux-server-rescue-3s-inspect-超时-runner-spawnturn-start-随机)
日期: 2026-07-17
基于: research.md(Codex design review R1 反馈已折入:内层总预算、202 端到端合同、guarded catch、bash 3.2 定点、timedOut 传播、TUI seam、提交顺序)

## 0. 批准边界(brainstorm gate,Tadashi)

三层超时预算不咬合根因成立。修法 = ①预算组合(外层 cap ≥ 内层合法最坏和)②案4 语义修复(ghost guard 不得报假失败,launch committed 如实返回)③案1 RunDispatcher inflight 残留收口。**窄而对,别扩面**。

Non-goals(明示):案2 turn/start 30s(codex-daemon 子系统,复发另开单);rescue fail-closed 决策模型不动(unknown 不 create、真 hold 不放松);不做连续自适应;不改锁机制;不碰 FLY-1329 scope;**sentinel-matrix「禁 ps」记载更正移出本 PR**(Codex R1 #8:不在 Lead 批准的三项内——只在 issue 收尾评论记录事实,需要改文档另开 follow-up)。

## 1. 总体图

```mermaid
graph TD
    subgraph C1["Commit-1 预算链(原子:rescue+两 TS caller 同落)"]
        B[rescue 内层总预算 TOTAL_BUDGET 60s<br/>耗尽→结构化 hold] --> T[per-command = min(base×F, remaining)<br/>inspect 3→6s base,F=clamp 1..4]
        T --> P[timedOut 显式传播(专用 rc)]
        B --> A1[TmuxAdapter attempt cap 10s→90s env 化<br/>deadline 90s→210s]
        B --> A2[TUI 窗口 ensure 补同款 deadline 重试<br/>可注入 seam]
    end
    subgraph C2["Commit-2 案4 语义(Bridge)"]
        E1[ghost guard 30s→env 90s]
        E2[generalized delivery 超时→终查→202 accepted-pending<br/>(success:true+pending:true 端到端合同)]
        E3[actions 先落 lineage/WAL 再返回 pending]
    end
    subgraph C3["Commit-3 案1 inflight(Bridge)"]
        D1[dispatch 中段 guarded catch → abortPreLaunch<br/>(inflight.get(key)===entry 才清;Parked 不重复 notify)]
    end
    C1 --> C2 --> C3
```

拆分:**1 个 PR、3 个提交单元**。Commit-1 必须原子(Codex R1 #8:先放大内层而外层仍 10s 的中间态会更糟——rescue 更容易被外层杀);Commit-2/3 相互独立、依赖 Commit-1 无。

## 2. Commit-1a:rescue 脚本预算(scripts/lib/tmux-server-rescue.sh)

### 2.1 内层总预算(新,R1 #1 的根修)

N(候选 server 数)与 orphan-recovery 轮询在源码上**无上界**,任何静态外层 cap 都无法「≥ 内层最坏和」——所以内层必须自己有界:

- 新 env `FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC`,默认 **60**(**静态,不随 load 缩放**——它就是外层合同的锚)。**解析合同(R3 #2)**:仅接受正整数秒(`^[0-9]+$` 且 ≥1;整数最贴 SECONDS 粒度);0/负/空/非数字 → 回退 60,绝不让畸形输入借 awk 隐式转换获得意外语义。hermetic 用例:0/负/空/非数字/合法非默认值。
- **单一预算锚,全调用树共享(R2 #1)**:普通 shell 变量 `_TMUX_RESCUE_BUDGET_ANCHOR`,由**顶层 locked dispatch 仅在缺席时初始化**(`[ -n "${…:-}" ] || _TMUX_RESCUE_BUDGET_ANCHOR=$SECONDS`);嵌套的 `_tmux_socket_recover_locked`(ensure 在 :364-366 经命令替换调它)、`tmux_socket_inspect` 及所有 helper 子 shell **继承**该锚(`$(…)` 子 shell 继承未导出变量与 SECONDS 进程内进度,已 /bin/bash 3.2 实探证实),绝不各自重开钟——否则 ensure 前段花掉近 60s 后嵌套 recovery 又拿一个 60s,90s attempt 证明作废。直连 `recover` 入口无锚存在,初始化即顶层。`remaining = TOTAL_BUDGET − (SECONDS − anchor)`。
- 之后**每次** `_tmux_rescue_bounded_exec` 的实际 timeout = `min(effective_per_command, remaining)`(min 用 awk 算,保小数);`remaining ≤ 0` → 不再发命令,当作该命令超时处理(timedOut 路径)→ 快速走 hold_unknown 兜底。
- orphan-recovery 的 20 轮轮询(:472-483)每轮先查 remaining,耗尽 → `hold_unknown` reason=`rescue_failed`(现有 reason,不新增)。
- **load 因子同理在顶层 dispatch 先算好并缓存**(命令替换子 shell 里的缓存写不回父进程,不提前算会导致每个子 shell 重复采样,R2 #1)。
- 效果:**rescue 进程自身在 ~TOTAL_BUDGET 内必然自行返回结构化 hold**,不再依赖外层 SIGKILL 才有界。**外层 SIGKILL 保持为既有的最后兜底,并如实承认其进程树风险(R2 #3)**:Node execFile 的 SIGKILL 只打直接子进程;锁 fd 被刻意设为可继承、bounded 子命令持有它直到自身完成(:568-574 的既有设计,保证 SIGKILL 不会提前放锁)。本单不扩面设计进程组终结;内层预算把该兜底变得罕见,并加回归:外层 kill 后,关键子命令仍被其**自身** bounded timeout 有界收割、锁不被提前释放(即现状语义钉死)。

### 2.2 load 因子

新函数 `_tmux_rescue_load_factor`(进程内算一次、缓存):

- 优先 env `FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR`:仅接受 `^[0-9]+$` 且 ≥1,clamp 到 [1, MAX];**invalid(0/负/非数字)→ 忽略该 override、落回正常采样**(单一合同,R2 #6;「采样本身失败 → factor=1」是另一条独立规则)。
- `FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX`:仅接受正整数,invalid → 4(先验证再 clamp,R1 #2)。
- 采样:macOS `sysctl -n vm.loadavg`(格式 `{ 30.77 31.93 35.00 }`,取第 2 个 token)/ Linux `/proc/loadavg` 第 1 字段;核数 `sysctl -n hw.ncpu` / `nproc`。
- **全部数值解析与算术用一次 awk 完成**(输出单个整数 factor):`factor = clamp(1, ceil(load1/ncpu), MAX)`。awk 原生浮点,**彻底绕开 bash 3.2 的八进制(08/09)与无浮点问题**(R1 #2);awk 不可用/输出非正整数 → factor=1。
- 任何读取/解析失败 → factor=1(纯静态回退,绝不因采样失败而 fail)。

### 2.3 生效超时(保留小数 env 合同,R1 #2)

三处 `${FLYWHEEL_TMUX_RESCUE_*_TIMEOUT_SEC:-N}` 改经 `_tmux_rescue_effective_timeout <kind>`:

- `effective = base × factor`,乘法用 awk(**base 允许正小数**——现有 hermetic 测试真实使用 `COMMAND_TIMEOUT_SEC=0.2`,合同必须保留;消费端本就是 python float)。base 非法(非正数/非数字)→ 用内建默认。
- 基值变化:**INSPECT 3→6**;COMMAND 5、LOCK 5 不变(×F 已覆盖)。
- env 覆盖语义:设了 env 即作 base,仍 ×F;要完全钉死 = 再设 `LOAD_FACTOR=1`(QA 配方迁移点,写进 PR 描述)。
- LOCK 的 effective 在 `_tmux_rescue_run_with_lock` 计算(锁等待在总预算**之外**,外层 cap 数学覆盖它,见 §3.2)。

### 2.4 timedOut 显式传播(R1 #3)

现有 helper 把超时折叠进普通失败,无法按「任一命令 rc=124/125 → timedOut」实现,改 helper 合同:

- `_tmux_rescue_pid_has_socket`:超时(bounded-exec rc=124/125)→ **rc=3**(新);其余不完整证据仍 rc=2。
- `_tmux_rescue_server_pids`:ps 超时 → **rc=3**;其余失败仍 rc=1。stdout(pid 列表)不变;caller 用 `$?` 区分(命令替换保留 rc,现有代码已依赖此模式)。
- `tmux_socket_inspect`:tmux display rc=124/125、server_pids rc=3、任一 lsof rc=3、以及 §2.1 的 budget-耗尽路径 → `timed_out=true`;这些同时保持 `scan_complete=false` 不变。JSON 增字段 `"timedOut":true|false`(加字段,TS parseHold 只读 action/evidence,向后兼容)。
- `_tmux_socket_ensure_locked` unknown 兜底(:421/:488):inspect JSON 的 timedOut=true → reason=`inspect_timeout`;否则维持 `unknown`。verify/create 已有 `command_timeout` ✓。
- **verdict 集合、exit code、fail-closed 决策全部不变**;saturated/split_brain/ambiguous 的 action/reason 逐字不变(突变测试锁死)。

## 3. Commit-1b:TS 调用层咬合(与 2 同一提交,原子)

### 3.1 TmuxAdapter.ensureRunnerSession(packages/claude-runner/src/TmuxAdapter.ts)

- per-attempt cap:`Math.min(10_000, remaining)` → `Math.min(attemptCapMs, remaining)`;`attemptCapMs = options.attemptCapMs ?? positiveInt(env FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS, 90_000)`(`EnsureRunnerSessionOptions` 增可注入字段,测试不靠改全局 env,R1 #7)。
- deadline 默认:90_000 → **210_000**(env `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 语义不变)。
- 其余(1s delay、parseHold、rename cosmetic cap)不动。

### 3.2 预算咬合数学(重推,R1 #1)

内层现在自有界,外层合同是**运维不变量**(R2 #5:各值独立可配,不自动自洽——必须显式写出公式,90/210 只是**默认配置下**的证明):

```
不变量:attempt_cap ≥ lock_base × factor_max + TOTAL_BUDGET + 启动余量
        deadline    ≥ 2 × attempt_cap + retry_delay 与余量
默认代入:90s ≥ 5×4 + 60 + 5 = 85 ✓(与 N、orphan-recovery 轮数无关)
         210s ≥ 2×90 + 余量 ✓(保证至少 2 个完整 attempt)
```

改任何一个 env(如 LOAD_FACTOR_MAX=8、放大 TOTAL_BUDGET、放大 LOCK base)时必须**成对**重算 attempt/deadline——写进 env 清单注记与回退指引;测试覆盖一组自洽的非默认 tuple。

行为分档:慢而成 → 在预算内完整成功;单点挂 → 预算内返回结构化 hold(不再是 SIGKILL 裸 unknown);病态(预算耗尽)→ 结构化 hold + 外层重试,deadline 后 fail-closed。

### 3.3 TUI 窗口 ensure(packages/claude-runner/src/codex-runner-tui-window.ts)

- 抽出**可注入、导出的**重试 helper(R1 #7):`ensureSessionWithRetry({ spawn, sleep, now, log, deadlineMs, attemptCapMs, cliPath, socket, session })` — 纯循环:spawnSync(timeout=min(attemptCap, remaining))→ status===0 → true;超 deadline → false;否则 sleep(1s) 重试。默认值走与 TmuxAdapter 相同的两个 env + 相同 positive-int 规则。
- `defaultEnsureSession` 改为组装默认依赖调用该 helper;`deps.ensureSession` 整体替换 seam 保持不变(既有测试不破)。
- 日志:helper 接受 `log`,`ensureRunnerTuiWindow` 把 `deps.log` 穿进默认 ensure(现 defaultEnsureSession 拿不到 log 的缺口一并补上);每次失败 attempt 记一行(spawnSync 改 `stdio:["ignore","pipe","ignore"]` 取 stdout 尾部入日志;**判定仍只看 status**)。

## 4. Commit-2:案4 语义修复(Bridge)

### 4.1 ghost guard 窗口 env 化(runs-route.ts)

`GHOST_GUARD_SESSION_WAIT_MS = 30_000` → `positiveInt(env FLYWHEEL_GHOST_GUARD_WAIT_MS, 90_000)`(模块级一次解析)。**三处 waitForSession/delivery 等待全部受益**(实测 delivery 20.5s@load37,×4 余量)。

### 4.2 范围收缩(R1 #5):只有「有 durable launch 证据」的路径改 pending

- **改**:generalized 流程里 `waitForGeneralizedLaunchDelivery` 超时(runs-route :971)——这是案4 的已证事实面(有 workflow_launch_owner fence,超时 ≠ 未发生)。
- **不改语义,只吃 4.1 的窗口放大**:`waitForSession` 两处超时(:959 GENERALIZED_START_NOT_LIVE、:1306 经典路径)。无 durable fence 时「pending 且最终必收敛」承诺不成立(Blueprint 在 emitStarted 前真失败则永远无 session 事件)——保持失败语义是诚实的。plan v1 的「全部 waitForSession 改 202」撤回。
- **workflow-engine-dispatcher(:484)**:现状 `return false` 并非立即重派(下一轮 reconcile 有 fence/hold 保护,只有 positive-dead 证据才 repair)——**语义不改**,只加超时后终查(委托下述共享 helper)+ 回归测试把现有 fence 行为钉死(R1 #5:别把安全的 false 描述成待修)。

### 4.3 accepted-pending 端到端合同(R1 #4)

**Schema 定死:HTTP 202 + `{ success: true, pending: true, code: "GENERALIZED_LAUNCH_PENDING", executionId, issueId, workflowRunId, workflowNodeId, message }`。** `success:true` 是关键——审计到的结构性消费者全部按「2xx+success」向:

| 消费者 | 现行为 | pending 下行为(本单保证) |
|---|---|---|
| Codex gateway `mapHttpDispatchOutcome`(gateway-main.ts :230-250/:460-482) | 2xx+success:false → not_dispatched → 允许 re-drive | 2xx+success:true → dispatched,**不 re-drive** ✓(实施时以该函数真代码核对+测试穿过它) |
| actions route 出口(actions.ts :1735-1760) | success:false → 400 | pending → **202 保真透传**(route 增 pending 分支) |
| Gemini BridgeClient(bridge-client.ts :80-100)/ xiaohongshu-scheduler(:226-244) | 只看 res.ok | 202=ok+success:true → 当已受理 ✓(与真实语义一致:launch 已受理) |

流程(runs-route :971 段):超时 → **终查** `getWorkflowLaunchOwner`:
- committed+delivered(等待期间落地)→ 走原成功响应(修 30s 边界竞态);
- 仍未 → 202 accepted-pending(上表 schema)。409 GENERALIZED_LAUNCH_NOT_COMMITTED 分支删除。
- **pending 响应绝不写 `recordWorkflowStartResponse`(R2 #2)**:该方法按现合同要求 reservation 已 `launch_committed/responded` 且 owner delivered(StateStore.ts:13193-13220)——202 分支恰恰缺这组证据,硬写会 throw 把语义修复打回 5xx;且响应表 append-only、replay 裸 `res.json(cached)`(runs-route :721-727),缓存了 pending 就永远升不了级。**只缓存 delivered 的 200 成功响应**;pending 每次现算。同 idempotency-key 路由测试:首呼返回未缓存的 202 → delivery 落地 → 重放返回并记录正常 200,且不第二次派 runner。不建可变 pending 存储(扩面)。

**actions.ts(:1165-1188)pending 前先落账,且落账必须留在 post-dispatch 异常盾内(R1 #4 + R2 #4 + R3 #3)**:现状 delivery-wait 在 post-dispatch try 之外、两笔账在 try 之内;合同明说 dispatch() 返回后的任何错误都不得翻成失败响应(:1069-1077, :1251-1257)。控制流定形:dispatch() 返回后,**各自独立的 best-effort guard** 依次尝试 `setRetrySuccessor` 与 `markRetryDispatchDispatched`(两笔账**不共用一个 try**——第一笔抛错第二笔仍必须被尝试;异常吞掉记日志,绝不翻失败)→ 再做 delivery-wait → 超时 → 终查 → 仍未 → 返回 `{ success: true, pending: true, message: … }`(200/202 按终查结果,与落账是否抛错无关)。**落账完整性的两档表述(R3 #3)**:store 健康时 pending 返回前两笔账必已持久;store 抛错时 API 仍保持 accepted/pending,账目不完整由 reconciliation 兜底——不做无条件「已落地」声称。注入 StateStore throw 的测试 × 两方法:无干净失败、无重派;**注入 setRetrySuccessor 抛错的用例必须断言 markRetryDispatchDispatched 仍被尝试**。pending 不触发 predecessor 终态化、不触发重派。

`ActionResult` 类型增可选 `pending?: true`;route 层 pending → 202。

### 4.4 测试要求(R1 #4/#5)

必须**穿过真实 HTTP route** 与 `mapHttpDispatchOutcome`:pending 后 gateway 判 dispatched(不 re-drive)、**store 健康路径下** lineage/WAL 已落地(注入 store 抛错时 = accepted/pending 不变、reconciliation 兜底,R3 #3)、等待期间落地→200、真未 committed→202、经典路径 500 行为不变、engine fence 行为不变。

## 5. Commit-3:案1 inflight 收口(run-dispatcher.ts,R1 #6 修正版)

无条件外层 catch 会破坏两条 commit-refusal 分支的既有语义(它们故意 `abortPreLaunch(...,false)` 后抛 LifecycleParkedError——park 已把 claim 置 cancelled,再默认 notify 会把 claim 改写成 closed;既有回归 run-dispatcher-fly887-turn-seam.test.ts:347-372 逐字断言 parked 时 onSpawnFailed 不得调用)。改用 **guarded catch**:

```ts
} catch (err) {
    if (this.inflight.get(key) === entry) {
        this.abortPreLaunch(key, executionId, req.projectName,
            !(err instanceof LifecycleParkedError));
    }
    throw err;
}
```

- 局部分支已清理过 → `inflight.get(key) !== entry` → outer 不重复清、不重复 notify;同 key 的**新** entry(理论并发)也不会被误删。
- 真正漏网的中段异常 → entry 仍在 → 清槽 + notify(Parked 例外不 notify)。
- start() 与 dispatchRetry() 各包一段(inflight.set 之后 → entry.promise 赋值完成)。
- 测试三件套(两路径各跑):①中段注入抛错(resumeComputer throw / computeRetryStartPoint throw)→ inflight 清、同 (issue,role) 立即可重派;②局部 cleanup 分支 → onSpawnFailed 恰好一次、outer 不二次触发;③parked refusal → claim 保持 cancelled、onSpawnFailed=0(既有测试继续绿)。

## 6. env 清单

| env | 层 | 默认 | 变化 |
|---|---|---|---|
| FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC | rescue | 60(静态) | **新增** |
| FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC | rescue | 3→**6**(base,允许小数,×F) | 默认变 |
| FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC | rescue | 5(base,允许小数,×F) | 语义变(×F) |
| FLYWHEEL_TMUX_RESCUE_LOCK_TIMEOUT_SEC | rescue | 5(base,允许小数,×F) | 语义变(×F) |
| FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR | rescue | (未设=采样;仅正整数) | 新增 |
| FLYWHEEL_TMUX_RESCUE_LOAD_FACTOR_MAX | rescue | 4(仅正整数,invalid→4) | 新增 |
| FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS | TS | 90_000 | 新增(原硬编码 10_000) |
| FLYWHEEL_TMUX_ENSURE_DEADLINE_MS | TS | 90_000→**210_000** | 默认变 |
| FLYWHEEL_GHOST_GUARD_WAIT_MS | Bridge | 90_000 | 新增(原硬编码 30_000) |

## 7. 测试矩阵(TDD:每单元先红后绿)

| # | 套件 | 用例 | 突变验证 |
|---|---|---|---|
| 1 | tmux-server-rescue.test.sh(hermetic) | load 因子:mac/Linux 真抓 fixture 解析、clamp 上下界、env 显式覆盖、采样失败回退 1;**输入畸形矩阵:08、09、0.2、空、负、超大、invalid MAX**(R1 #2);**invalid override(0/负/非数字)→ 忽略、用采样值**(与恶劣采样→1 分开断言,R2 #6) | 桩 sysctl 吐垃圾 → factor=1;invalid override + 桩采样=3 → factor 必为 3 非 1 |
| 2 | 同上 | 新默认:FAKE sleep 4s → inspect 不 124;LOAD_FACTOR=1+sleep 7s → 仍 124(ceiling 真实);**小数 env 合同:COMMAND=0.2 现有用例继续绿** | 改回 base 3 → 4s sleep 必 124 |
| 3 | 同上 | **总预算**:F=4 下 N=0 / N=2 / 单点 timeout / orphan-recovery 四形态的**总墙钟 ≤ TOTAL_BUDGET+余量**且输出结构化 hold(R1 #1);**组合形态:ensure 前段烧掉部分预算后进入嵌套 recovery(:364-366),两侧合计仍 ≤ 单个 TOTAL_BUDGET+余量**(R2 #1——单独 N/recovery 测试证不了组合);budget 耗尽 → reason=rescue_failed(recovery)/ inspect_timeout(inspect 路径);**非默认 tuple 的内层半边**:MAX=8 + 放大 TOTAL_BUDGET 下总墙钟仍 ≤ 预算+余量(R2 #5;外层半边在 TS 侧,见 #5——shell 套件跑不到 TmuxAdapter,tuple 证明必须拆两层,R3 #1) | 拆掉 remaining-min → 墙钟测试必红;嵌套侧改私锚 → 组合测试必红 |
| 4 | 同上 | timedOut 传播:tmux/ps/lsof **各自**注入超时 → timedOut=true+reason=inspect_timeout;真 hold 桩(saturated/split_brain/ambiguous)→ action/reason 逐字不变(R1 #3) | 三命令逐个突变;旧 unknown reason 不再出现在超时路径 |
| 5 | TmuxAdapter.test.ts | attemptCapMs 注入与 env 默认;deadline 210s;既有 ~110 it 全绿;**非默认 tuple 的外层半边**:给定 MAX=8+放大 TOTAL_BUDGET 的场景,断言配套 attempt/deadline 满足 §3.2 不变量公式(改小 cap → 必红,R3 #1) | 改小 attempt cap → tuple 断言必红 |
| 6 | codex-runner-tui-window 测试 | **经导出 helper 注入 spawn/sleep/now**(不桩 deps.ensureSession,R1 #7):前 2 败第 3 成 → true;全败超 deadline → false;log 收到失败行 | 删重试改单发 → 必红 |
| 7 | runs-route vitest(**真 HTTP route**) | delivery 超时→终查:(a)期间落地→200 (b)仍未→**202+success:true+pending:true 且不写响应缓存**;**同 idempotency-key:首呼 202 → delivery 落地 → 重放返回并记录 200、零二次派**(R2 #2);409 分支不可达;经典 :1306 路径 500 行为不变;:959 行为不变(只窗口变大) | 终查桩 undefined → 必 202 非 409;强制在 202 分支写缓存 → 重放升级测试必红 |
| 8 | gateway/actions vitest | `mapHttpDispatchOutcome`(真函数)对 202+success:true → dispatched 不 re-drive;actions:落账在 post-dispatch 盾内、pending 前尝试 setRetrySuccessor+markRetryDispatchDispatched;**注入两方法各自 throw → 仍无干净失败、无重派**(R2 #4);pending 不终态化 predecessor(R1 #4) | 把 pending 改 success:false → gateway 判 not_dispatched(证明 schema 选择是承重的) |
| 9 | workflow-engine-dispatcher vitest | 超时终查;**现有 fence/hold 行为钉死**(busy hold 继续 hold、无 positive-dead 不 repair)(R1 #5) | — |
| 10 | run-dispatcher vitest | §5 三件套 × start/retry 两路径;fly887 parked 回归继续绿(R1 #6) | 注释掉 guarded catch → ①必红 |
| 11 | real-tmux / lock 套件 | 真 tmux + FAKE sleep 下 ensure 收敛;mac 本机真跑(CI=Linux 只验 Linux 谓词——FLY-1285 盲区教训);**外层 kill 回归:SIGKILL rescue 主进程后,in-flight bounded 子命令仍被自身 timeout 收割、锁不提前释放**(现状语义钉死,R2 #3) | — |

独立 QA(implement 后,FLY-1211 硬门):真机满载(自然负载或压载)重放案3(claude spawn)+案4(generalized start),DB 对照:spawn 收敛不 fail-closed;「已 committed 却报失败」归零;旧 dist 同负载对照组可复现失败。

## 8. 部署与风险

- **生效面**:Commit-2/3(Bridge)需 Bridge 重启;Commit-1 TS 侧(claude-runner dist)随 Bridge 重启;Commit-1 rescue 脚本经 `~/.flywheel/bin/tmux-server-rescue` symlink 生效。**部署前置步骤(非扩面)**:该 symlink 当前指向 FLY-1329 worktree(2026-07-17 03:23 实测)——ship 时重指主仓 `/Users/xiaorongli/Dev/flywheel/scripts/lib/tmux-server-rescue.sh`,否则本修复不生效且 worktree 删除即全机断链。
- **合并窗口**:FLY-1329 PR-A(#632)在动 run-dispatcher 邻域 → 后合者 rebase,冲突预期加性。
- **行为变化(设计目标,非字节兼容)**:三个默认值变更 + 409→202。回退指引(R2 #5 + R3 #1:任何 override 组合都必须满足 §3.2 不变量):**安全回退档** = INSPECT=3、LOAD_FACTOR=1、TOTAL_BUDGET=8、**ATTEMPT=20000**(5×1+8+5=18 ≤ 20 ✓)、DEADLINE=90000、GHOST=30000;**ATTEMPT=10000 是不满足不变量的逐字复旧档**(重新引入外层 SIGKILL 失败模式,只用于对照实验,明确标注不安全)。**单独放大 TOTAL_BUDGET / MAX 时必须同步放大 ATTEMPT 与 DEADLINE**。202 改动集中在 2 个函数,revert 即回。
- **QA 配方迁移点**(PR 描述列明):要钉死超时的测试须加 `LOAD_FACTOR=1`;小数 env 继续支持。

## 9. 验收标准

1. 满载(load ≥ 2×ncpu)真机:连续 ≥5 次 spawn 无一因 inspect_timeout/command_timeout fail-closed(旧 dist 同负载对照组有失败)。
2. 「launch 已 committed 但 API 报失败」= 0(DB 对照);202 pending 时 gateway 判 dispatched、无重派撞墙;store 健康时 lineage/WAL 持久,store 抛错时 accepted/pending 不变、reconciliation 收敛(R3 #3)。
3. dispatch 中段任一抛错后 (issue,role) 槽位立即可重派;parked refusal 语义与今日逐字一致(fly887 回归绿)。
4. 真 hold(split_brain/saturated/ambiguous)action/reason/exit code 与今日逐字一致(fail-closed 未放松)。
5. rescue 在 F=4、任意 N 与 recovery 形态下总墙钟有界(≤TOTAL_BUDGET+余量)且总能输出结构化 hold。
6. 全测试矩阵绿 + 全仓 lint 绿 + CI 绿;既有 rescue/TmuxAdapter/runs-route/fly887 套件零回归。
