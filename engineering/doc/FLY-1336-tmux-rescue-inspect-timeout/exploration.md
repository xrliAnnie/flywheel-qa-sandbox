# FLY-1336 满载机 tmux-rescue 超时 — 探索

Issue: FLY-1336 (https://linear.app/geoforge3d/issue/FLY-1336/infra-满载机上-tmux-server-rescue-3s-inspect-超时-runner-spawnturn-start-随机)
日期: 2026-07-17
基于: 无

## 1. 问题定义

机器满载(load 35+,一晚实测最高 56)时,runner spawn / turn-start 随机 fail-closed。
一晚四案,全部生产语义:

| 案 | exec | 报错文本 | 时间 |
|---|---|---|---|
| 1 | 7c568e73 (FLY-1319 QA spawn) | "Command failed: tmux-server-rescue ensure";次生伤害:RunDispatcher inflight 未清,(issue, role) 槽卡死到 Bridge 重启 | 06:14Z |
| 2 | cd519dc4 (FLY-1328 implement) | "goal run setup_failed: request turn/start timed out" | 08:27Z |
| 3 | a07a52ff (529 房 1307 E2E qa spawn) | "tmux session ensure held: unknown" | 08:1xZ |
| 4 | adea4e32 阳性对照 | LAUNCH_NOT_COMMITTED 假失败(launch 实际已 committed) | 09:09Z |

adea4e32 实测(load 37.76):tmux inspect 单命令耗时 2731ms / 1380ms / 564ms —— 距 3s 线仅 269ms。
launch delivery 实测 20.5s vs `GHOST_GUARD_SESSION_WAIT_MS` 30s,余量 ~9.5s。

**机器目标是 100+ 并发 runner,满载是常态不是异常。静态超时在设计上撑不住。**

## 2. 代码定位(本 worktree 实读,非推测)

### 2.1 rescue 脚本内部预算(`scripts/lib/tmux-server-rescue.sh`)

三个超时 env:

| env | 默认 | 用途 |
|---|---|---|
| `FLYWHEEL_TMUX_RESCUE_INSPECT_TIMEOUT_SEC` | **3** | inspect 内**每条**命令:`tmux display-message`(:156)、`ps axww`(:126)、每个候选 pid 一次 `lsof`(:98) |
| `FLYWHEEL_TMUX_RESCUE_COMMAND_TIMEOUT_SEC` | 5 | verify / create 命令(:290, :311, :347, …) |
| `FLYWHEEL_TMUX_RESCUE_LOCK_TIMEOUT_SEC` | 5 | flock/lockf 抢锁(:595) |

超时语义(全部 fail-closed,这个保守方向本身是对的——unknown 时绝不 create,防 split-brain):

- inspect 内任一命令 rc=124/125 → `scan_complete=false` → verdict `unknown` → `hold_unknown` exit 4(:159-161, :183)
- verify/create 超时 → `hold_unknown` reason=`command_timeout` exit 4(:294 等 6 处)
- **一次 `ensure` 至少跑 2 次完整 inspect**(before :286 + after :298/:319/:330…);`missing_single_orphan` 恢复路径更多(signal 前重验 :457 + 恢复轮询至多 20 次 inspect :472-483)
- 每次 inspect = 1×tmux + 1×ps + **N×lsof**(N = 同 uid、ppid=1 的 tmux server 候选数;FLY-1285 事故夜机器上列得出 61 个 tmux 进程)

### 2.2 调用面 1:TmuxAdapter.ensureRunnerSession(claude/agy/kimi spawn)

`packages/claude-runner/src/TmuxAdapter.ts:1387+`。已有重试循环:

- `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 默认 90s,retryDelay 1s
- **每 attempt 外层 `timeoutMs: min(10_000, remaining)`,SIGKILL**(:1437-1441)
- 失败 → `parseHold(error)`(stdout 里的 hold JSON 能解析就取 kind,否则 unknown):1276
- deadline 耗尽 → `TmuxSessionHoldError("unknown")` → message = **"tmux session ensure held: unknown"** = 案 3 文本(:74)

**结构性缺陷(比 3s 本身更根本):外层 10s per-attempt cap 与 rescue 内部最坏预算不咬合。**
rescue 内部合法预算 = 锁 5s + inspect(2+ 次 × 每次多条 × 3s/条) + command 5s,满载 + 多候选时轻松超 10s。此时外层 SIGKILL 把 rescue 整个杀掉(连 hold JSON 都吐不出来 → parseHold 只能给 unknown),每个 attempt 都死于同样的外层斩杀,90 秒内全部 attempt 同构失败 → held: unknown。**重试存在但每次都被同一把刀砍死,等于没有重试。**

### 2.3 调用面 2:codex-runner-tui-window.defaultEnsureSession(codex runner)

`packages/claude-runner/src/codex-runner-tui-window.ts:130-158`。sync `spawnSync`,外层 90s timeout,**单次调用、无重试**。rescue 内部 3s inspect 超时一次 → exit 4 → 返回 false → "guarded tmux session ensure held — skipping" → spawn 失败。这是最脆的一条:一次 transient 抖动即死。

### 2.4 调用面 3:Bridge runs-route ghost guard(案 4)

`packages/teamlead/src/bridge/runs-route.ts:81`:`GHOST_GUARD_SESSION_WAIT_MS = 30_000` **硬编码常量**,无 env。
用于 `waitForSession`(:959, :1306)与 `waitForGeneralizedLaunchDelivery`(:974)。

案 4 的正确性缺陷:`waitForGeneralizedLaunchDelivery` 超时 → 直接 409 `GENERALIZED_LAUNCH_NOT_COMMITTED`(:977-985),**但此时 launch 可能已经 committed 且 runner 已活**(adea4e32 DB 铁证:committed_generation=1 + delivered + session running)。API 报假失败 → 调用方按失败重试 → 撞 active-phase 保护。**这不是调参问题,是超时路径的语义错误:超时 ≠ 未发生。**

### 2.5 案 2:codex-daemon-client turn/start 30s

`packages/claude-runner/src/codex-daemon-client.ts:205`:`requestTimeoutMs ?? 30_000`。满载时 codex app-server 响应慢 → "request turn/start timed out" → goal run setup_failed。同一根因(静态超时 vs 满载),不同子系统。

### 2.6 案 1 次生伤害:RunDispatcher inflight 泄漏(候选 D)

`packages/teamlead/src/bridge/run-dispatcher.ts`。`entry.promise` 链**有** `.finally(() => inflight.delete(key))`(:1445, :850)——但 `inflight.set(key)`(:1119 / :583)之后、`entry.promise` 赋值(:1377 / :807)之前的中段存在多个可抛点**没有**收口到 `abortPreLaunch`:

- start() 路径:`buildRunnerSpawnFields`(:1130)、`resumeComputer?.()`(:1272)等——同步/await 抛出 → inflight 卡死
- retry 路径:`computeRetryStartPoint`(:660,显式 throw)等同样裸露
- 已有局部收口的点:TURN grant(:1251 ✓)、commitLaunch(:1370 ✓)、workflowClaimsAdmission(:1185 ✓)——说明这个模式已被认可,只是没铺满全段

**FLY-1329 不覆盖此项**(其 scope = park-alive 不被重启杀 + executor-merge finalize + FSM-side finalize + QA-first 硬序,PR #632;与 spawn 失败路径的 inflight 清理正交)→ 候选 D 归本单。

### 2.7 附带修正:sentinel-matrix「runner sandbox 禁 ps」记载

issue 要求更正的记载,adea4e32 sandbox 实测不成立(ps rc=0,列得出 61 个 tmux 进程)——彼案真机制是 3s 超时。本 worktree 内 grep 未找到名为 sentinel-matrix 的文件(`disallowed\|禁 ps` 均无命中);该记载可能在 QA 报告或 runner 侧共享记忆里。implement 阶段需先定位其真实载体再更正;若确认已不存在,记录结论即可。

## 3. 候选方案分析

### A. 提高默认值(如 15s)

最简。但**单独做 A 无效甚至更糟**:rescue 内部单条命令 15s × 多条,必超外层 TmuxAdapter 10s per-attempt cap → rescue 被外层 SIGKILL 的概率反而更高,连 hold JSON 都吐不出。A 必须与预算链咬合一起做。且静态值仍会被更高负载击穿(本机 load 见过 78)。

### B. load-aware 自适应超时

按 loadavg 缩放。概念正确——超时的目的是区分「卡死」与「慢」,load 高时慢是正常信号不是故障信号。风险:复杂度与可测性。可控做法 = **B-lite**:`effective = base × clamp(1 + load/cores 系数, 1, 上限)`,loadavg 读取本身 bounded、失败回退 1×,上限 clamp(病态 load 下超时不能无限大,否则真卡死不检测)。

### C. 超时有界重试 + 语义区分

两个独立子项:
- **C1 语义区分**:`command_timeout` / inspect 超时应与真 hold(saturated/split_brain)区分开。真 hold = 有证据的危险状态,重试无意义;timeout = 证据不足,重试有意义。现在两者都折进 `hold_unknown`,外层无法区分「该快速放弃」与「该再试」。
- **C2 重试位置**:TmuxAdapter 外层已有 90s 重试;rescue 内部再叠一层通用重试会复杂化。收敛做法:重试职责留外层(修好 per-attempt cap 后它就真正起效),rescue 内部只对**单条超时命令做一次立即重跑**(吸收瞬时抖动,成本低);codex-runner-tui-window 的单发路径补上与 TmuxAdapter 同款的 deadline 重试。

### D. spawn 失败清 inflight(正确性)

§2.6。结构性收口:两条 dispatch 路径中段(inflight.set 之后 → entry.promise 赋值之前)整段 try/catch → `abortPreLaunch`(该 helper 已存在且幂等,:920-940)。

### E. launch 已 committed 时 API 禁止报失败(正确性)

§2.4。`waitForGeneralizedLaunchDelivery` / `waitForSession` 超时后**再做一次终查**:committed/registered → 返回明确的 pending/async 语义(如 202 + `code: "LAUNCH_PENDING_CONFIRM"`),绝不 409;真未 committed 才报失败。调用方(orchestrator/Lead)对 pending 语义的处理 = 不重试、等 session 事件。

## 4. 推荐方案(组合)

**核心论点:单点调参治不了,要按「预算链」整体理顺 + 两个正确性修复。**

1. **预算链咬合**(A+B-lite+C 融合):
   - rescue 内部:inspect 超时基值 3s → 10s;单条超时命令立即重跑一次(C2);超时 reason 独立化(C1:`inspect_timeout` / `command_timeout` 进 evidence,与真 hold 分流)
   - 全部超时(inspect/command/lock)乘统一 load 因子,clamp 上限(B-lite)
   - TmuxAdapter per-attempt cap:10s 硬编码 → 按 rescue 内部最坏预算推导(或 env 化 + 放大默认),保证 rescue 至少能完整跑完一轮吐出结构化 hold
   - codex-runner-tui-window:单发 → 复用/镜像 TmuxAdapter 的 deadline 重试
   - `GHOST_GUARD_SESSION_WAIT_MS`:硬编码 30s → env 化 + 默认放大(与 launch delivery 实测 20.5s@满载拉开安全余量)
   - 案 2:codex-daemon-client `requestTimeoutMs` 默认 30s → env 化 + 放大(scope 待 Lead 拍,见 §5)
2. **D**:RunDispatcher 中段抛错结构性收口 abortPreLaunch
3. **E**:ghost guard 超时终查 + pending 语义,消灭「已成功却报失败」
4. **附带**:sentinel-matrix 记载定位 + 更正

## 5. 开放问题(brainstorm gate 向 Lead 确认)

1. **scope:案 2(turn/start 30s)本单一起修吗?** 同根因、改动小(默认值 + env 化);但属 codex-daemon 子系统,不在 rescue 链上。我倾向:本单一起(最小改法),若 Lead 认为该子系统需要更深的 load-aware 处理则另拆单。
2. **B(load-aware)做到什么深度?** 我倾向 B-lite(统一 load 因子 + clamp,一个共享 helper),不做连续自适应/反馈控制。
3. **E 的 pending 语义形态**:202 新响应码(调用方要跟着改)vs 200 + `pending: true` 字段(兼容旧调用方但语义弱)。倾向前者,但需确认调用方(orchestrator handoff / Lead actions)改动面可接受。
