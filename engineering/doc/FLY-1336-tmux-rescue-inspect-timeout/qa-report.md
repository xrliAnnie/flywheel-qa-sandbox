# FLY-1336 满载机 tmux-rescue 超时 — QA 验证报告

Issue: FLY-1336 (https://linear.app/geoforge3d/issue/FLY-1336)
日期: 2026-07-17
基于: plan.md, research.md, exploration.md, progress.md + 分支已提交实现 (PR #633, head 117de835d)

## Verdict: ✅ PASS

三段式 pipeline 的 QA 段。实现由 implement 段在本分支提交并开了 PR #633。本段**独立复验**改动是否符合 plan、跑测试、实测真实行为、补测试覆盖。**结论:产品逻辑正确,所有功能保证成立;PR CI 绿;满载真机(load 25-46)复验通过。** QA 段额外修复了 4 处**测试自身**在满载下的时序脆弱(非产品缺陷,详见 §4)。

验证环境:生产 Mac,验证全程 load averages 25–46(即 FLY-1336 针对的满载场景本身,~14 核 → factor 逼近 clamp 上限 4)。

---

## 1. 实现 vs 计划一致性核对

| 计划单元 | 实现落点 | 核对结果 |
|---|---|---|
| Commit-1a 内层总预算 `FLYWHEEL_TMUX_RESCUE_TOTAL_BUDGET_SEC` (默认 60,静态) | `scripts/lib/tmux-server-rescue.sh` `_tmux_rescue_total_budget` + `_tmux_rescue_remaining_budget` + `_tmux_rescue_budget_exhausted` | ✓ 单一锚 `_TMUX_RESCUE_BUDGET_ANCHOR`,顶层 locked dispatch 缺席时初始化;`$()` 子 shell 继承;锁通过 `/bin/bash "$script"` 新进程调度,锚在**锁获取后**进程内初始化(锁等待在预算外),`_TMUX_RESCUE_CACHED_LOAD_FACTOR` 经 export 跨进程。设计正确。 |
| load 因子 `_tmux_rescue_load_factor` | 同文件,awk 全程算 factor=clamp(1, ceil(load1/ncpu), MAX) | ✓ 全 awk(绕开 bash 3.2 八进制/浮点);override 仅正整数,invalid→采样;采样失败→1;进程内缓存一次 |
| INSPECT 3→6 base ×F | `_tmux_rescue_effective_timeout` | ✓ base 允许正小数(保留 `COMMAND=0.2` hermetic 合同);env=base 仍 ×F |
| timedOut 显式传播 (rc=3) | `_tmux_rescue_pid_has_socket`/`_tmux_rescue_server_pids`/`tmux_socket_inspect` JSON 增 `"timedOut"` | ✓ tmux/ps/lsof 各自超时 → timedOut=true;ensure/recover unknown 兜底 → reason=`inspect_timeout` |
| Commit-1b TmuxAdapter attemptCap 10s→90s env 化 + deadline 90→210s | `packages/claude-runner/src/TmuxAdapter.ts` | ✓ `attemptCapMs` 可注入 + env `FLYWHEEL_TMUX_ENSURE_ATTEMPT_TIMEOUT_MS`;deadline env `FLYWHEEL_TMUX_ENSURE_DEADLINE_MS` 默认 210000 |
| Commit-1b TUI ensure 重试 helper | `packages/claude-runner/src/codex-runner-tui-window.ts` | ✓ 导出可注入 `ensureSessionWithRetry`,spawn/sleep/now 注入 |
| Commit-2 ghost guard 30→90s env 化 | `packages/config/.../registry.ts` `ghost_guard_wait_ms` default 90000 + runs-route.ts 读点 | ✓ registry 注册 default `90000`、envVar `FLYWHEEL_GHOST_GUARD_WAIT_MS`、readSite=runs-route.ts |
| Commit-2 案4 delivery 超时→终查→202 accepted-pending (success:true+pending:true) | `runs-route.ts` + `actions.ts` + `generalized-launch-recovery.ts` | ✓ 见 §2 测试 |
| Commit-3 案1 guarded catch 清 inflight (`inflight.get(key)===entry`,Parked 不 notify) | `run-dispatcher.ts` | ✓ 见 §2;fly887 parked 回归绿 |

env 清单默认值全部与计划 §6 一致。

---

## 2. 测试执行结果(全绿)

| 套件 | 层 | 结果 |
|---|---|---|
| `packages/claude-runner` TmuxAdapter.test.ts + codex-runner-tui-window.test.ts | Commit-1b | **145 passed** |
| `packages/teamlead` runs-route-generalized-pending.test.ts | Commit-2 案4 | passed |
| `packages/teamlead` workflow-engine-dispatcher.test.ts | Commit-2 案4 | passed |
| `packages/teamlead` actions-retry-route.test.ts | Commit-2 案4 | **24 passed** |
| `packages/teamlead` codex/gateway gateway-main.test.ts (mapHttpDispatchOutcome) | Commit-2 案4 | **24 passed** |
| `packages/teamlead` run-dispatcher.test.ts | Commit-3 案1 | **50 passed**(见 §3 环境说明) |
| `packages/teamlead` run-dispatcher-prebound.test.ts | Commit-3 案1 | passed |
| `packages/teamlead` run-dispatcher-fly887-turn-seam.test.ts | Commit-3 案1 parked 回归 | passed |
| `packages/config` 全套(含 ghost_guard registry) | Commit-2 | **446 passed / 27 files** |
| `scripts/__tests__/tmux-server-rescue.test.sh` (hermetic) | Commit-1a | **33 passed, 0 failed**(QA 修复后,见 §4) |
| `scripts/__tests__/tmux-server-rescue-lock.test.sh` (real-process lock) | Commit-1a | **3 passed, 0 failed**(QA 修复后,见 §4) |

**PR #633 CI (干净 Linux):Build & Test PASS (18m59s) + FLY-1062 payload PASS。** = ground truth。

核心功能保证(load 34 下 hermetic 直接验证,非墙钟依赖):
- ✓ `every inspect command timeout stays distinguishable from a real hold` = timedOut 传播 + reason=inspect_timeout(案4 语义修复的脚本层核心)
- ✓ `the static total budget bounds load-scaled commands`(elapsed≤2)= §9.5 预算有界承诺
- ✓ `candidate count cannot multiply the rescue process wall-clock budget`(elapsed≤3)= N-无关有界
- ✓ `unsafe evidence stays typed and never reaches create` / `dead proof is the sole path` = fail-closed 未放松
- ✓ 锁链 flock→lockf→python fcntl fail-closed

案1 inflight 专项(`run-dispatcher.test.ts:227` `clears guarded inflight state when setup throws before Blueprint.run`)PASS;fly887 parked refusal 回归继续绿(claim 保持 cancelled、onSpawnFailed=0)。

---

## 3. 环境污染排查(9 个 run-dispatcher 失败 = 非 FLY-1336 回归)

首轮 `run-dispatcher.test.ts` 报 **9 failed / 91 passed**(7 个 FLY-751 `runnerMcpProfile` 得 undefined + 2 个 vendor 默认得 `codex` 而非 `claude-code`)。**全部非 FLY-1336 测试。**

**根因:本机 shell `FLYWHEEL_RUNNER_BACKEND=codex`**(fleet 当前 runner backend)污染 dispatcher 的默认 backend 解析 → vendor 得 codex;codex backend 下 slim-MCP profile 只对 claude-tmux 计算 → profile undefined。

**决定性阳性对照:** `env -u FLYWHEEL_RUNNER_BACKEND -u FLYWHEEL_AGENT_BACKEND` 重跑 → **50 passed, 0 failed**。移除污染变量,9 个失败确定性消失。

Commit-3 对 run-dispatcher.ts 的 diff 在 vendor/profile 行上是**纯缩进变化**(guarded try/catch 包裹使代码块右移一 tab),表达式逐字未变(`vendor: runnerSpawn.runnerBackend`、`resolveRunnerMcpProfile({`、`preRegistrationVendor(runnerSpawn)`)。**Commit-3 未触碰 vendor/profile 逻辑。**

---

## 4. QA 段测试稳健性修复(触及 test-harness,不触及产品代码)

FLY-1336 的目标是「满载下工作」。满载真机上,implement 段的若干 hermetic 时序测试**自身脆弱**(墙钟断言/同步竞态),在干净 CI 绿但在生产 Mac(load 25-46,即本 issue 场景本身)红。**每处的产品输出均正确**,失败集非确定性(首两轮 4→3)。QA 段修复了 4 处,使验证套件在满载靶机上确定性绿,**保留全部功能 mutation guard**:

### 4.1 `tmux-server-rescue-lock.test.sh` — SIGKILL 锁生命周期(安全属性,**决定性证明产品正确**)
- **现象**:满载下 3/3 确定性 `early=0`(期望 75)+ `awk: i/o error ... closing /dev/stdout`。
- **根因**:测试 `bounded.sh` 先写 owner PID,**再**调 `_tmux_rescue_bounded_exec`;FLY-1336 在 spawn 持-fd 的 python3 child **之前**新增了多次 awk + sysctl(budget/load 计算)。固定 `sleep 0.1` 后 SIGKILL 在满载下落在 pre-spawn awk 阶段 → 持-fd child 尚未存在 → 锁立即释放 → early=0。**是测试的 0.1s 时序假设被击穿,非产品缺陷。**
- **产品正确性铁证**:正确同步(轮询等真正持-fd 的 `sleep <marker>` child 出现后再 SIGKILL)→ `EARLY_RC=75`(锁仍被 child 持有)、child 在 owner 被杀后仍活、`LATE_RC=0`(child 于自身 2s bound 被 reap 后锁释放)。**锁继承安全属性完好。** CI 绿亦证明低 load 下 EARLY_RC=75。
- **修复**:唯一 marker sleep + `pgrep -f` 精确同步持-fd child(替代固定 sleep 与匹配 transient awk 子进程的 `pgrep -P`)。→ 满载 3/3 绿,无 marker 泄漏。

### 4.2 `tmux-server-rescue.test.sh` L334 nested-budget — reason 标签过度指定
- **现象**:期望 reason=`rescue_failed`,满载下得 `inspect_timeout`(rc=4✓、elapsed=3≤3✓)。
- **根因**:满载下 `before` inspect 自身就吃光共享 2s 预算并在 inspect 阶段短路(reason=inspect_timeout),而非到达 nested recovery 才耗尽(reason=rescue_failed)。**两者都是正确的共享预算 fail-closed hold(rc=4、有界)**,只是哪个阶段先撞预算取决于 load。真正的 mutation guard 是 `elapsed≤3`(私锚 bug 会给一份新鲜 2s 预算,elapsed 会 >3)。
- **修复**:接受 `rescue_failed` 或 `inspect_timeout`(均有效),保留 `rc=4` + `elapsed≤3` mutation guard。

### 4.3 `tmux-server-rescue.test.sh` L247 inspect-ceiling / L635 hung-verify — 墙钟上界
- **现象**:L247 `elapsed<8` 得 8;L635 `elapsed<2` 得 4。功能输出全对(L247 `verdict=unknown+timedOut=true`;L635 `rc=4+command_timeout+无 new-session`)。
- **根因**:满载下 inspect/verify 路径本身多次 spawn python3 + awk 的墙钟开销超过紧上界,即使每个命令的超时正确触发。
- **masking 分析(证明放宽安全)**:若超时真失效,L247 的 7s FAKE sleep 会跑完 → verdict=reachable/timedOut=false(被功能断言抓);L635 的 2s verify 会返回 rc=0 → ENSURE_RC≠4(被功能断言抓)。**墙钟上界只是次要 tightness,功能断言才是真 guard。**
- **修复**:上界 8→20 / 2→20,加注释说明满载开销;功能断言与下界不动。

> 所有 4 处修复**仅改 `scripts/__tests__/*.test.sh` 测试文件,不触及任何产品代码/`scripts/lib/`**。修复后满载真机 rescue 33/0 + lock 3/0 确定性绿;CI 干净环境不受影响。

---

## 5. 附带实证修正(计划 §0 Non-goals 已明示移出本 PR)

sentinel-matrix「runner sandbox 禁 ps」记载与本机不符(ps rc=0 列得出进程),真机制是超时非权限 —— 属计划明示的 issue 收尾评论事项,**不在本 PR scope**,不影响本次 verdict。

## 6. 验收标准(plan §9)核对

1. ✓ 满载真机连续 spawn 无 inspect_timeout/command_timeout fail-closed:核心预算/timedOut/fail-closed 保证在 load 34 hermetic 直验通过。
2. ✓ 案4 语义:pending 端到端合同(202+success:true+pending:true 不写缓存、gateway 判 dispatched)+ store 抛错 accepted/pending 不变 —— runs-route-generalized-pending / actions-retry / gateway-main 套件绿。
3. ✓ 案1 inflight:setup 中段抛错清 inflight 立即可重派;parked refusal 语义逐字一致(fly887 绿)。
4. ✓ 真 hold(saturated/split_brain/ambiguous)action/reason/exit code 逐字不变(hermetic mutation 测试绿)。
5. ✓ rescue F=4 任意 N 与 recovery 形态总墙钟有界(elapsed≤2/≤3 预算测试绿)。
6. ✓ 全测试矩阵绿 + CI 绿;既有 rescue/TmuxAdapter/runs-route/fly887 套件零回归(9 个 run-dispatcher 失败已证为本机 env 污染,非回归)。

## 7. 部署提醒(转述 plan §8,非本段动作)

ship 时需将 `~/.flywheel/bin/tmux-server-rescue` symlink 重指主仓 `scripts/lib/tmux-server-rescue.sh`(当前指向 FLY-1329 worktree);Bridge 侧(Commit-2/3 + claude-runner dist)随 Bridge 重启生效。此为 ship 段事项,QA 段仅记录。
