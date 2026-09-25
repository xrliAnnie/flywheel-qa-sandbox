# FLY-2877 Codex lease 生命周期 — 调研
Issue: FLY-2877 (https://linear.app/geoforge3d/issue/FLY-2877/病根codex-lease-codextmuxadapter-在-runner-的-codex-进程仍活着时就释放了-flywheel)
日期: 2026-09-25
基于: exploration.md

## 0. 结论先行

把「lease 与 codex 进程同生同灭」落成**一个**守卫函数，所有删 lease 的站点都必须经过它；adapter 收尾改成「先杀 TUI、确认 daemon 退出、再释放」；运行期由持有 token 的 adapter 自己定期复核并放回丢失的 lease；进程已退出却残留的 lease 由既有维护 tick 收掉。不新增调度器、不新增状态表、不改 `host-readiness.ts`。

## 1. 现状拓扑（谁读、谁写 `.flywheel-leases/<exec>`）

```
admitCodexAgentHome            ── 创建（Blueprint 派发前 / session-reown 重认领）
provisionCodexAgentHome        ── 只断言存在且 token 一致
releaseCodexAgentHomeLease     ── 删除（adapter ×4、Blueprint 未交接、reown 回滚）
retireCodexExecutionHome       ── 删除（adapter 正常收尾）
scrubOrphanedCodexAgentHomes   ── 删除（每个 Bridge 进程启动一次，只对照调用方 StateStore）
host-readiness collector       ── 只读（FLY-2523/2869 证据规则）
codex-runner-orphan-reaper     ── 只读（census）
credential sweep / cutover     ── 只读（判 busy）
```

三处删除的共同缺口：都不看进程；删到 0 时无日志且顺带擦 GH_TOKEN。

## 2. 候选方案

### 2.1 「进程存活」的判定（守卫的核心）

| 方案 | 做法 | 优点 | 缺点 | 取舍 |
|---|---|---|---|---|
| P1 环境标记扫描 | `ps eww -axo pid=,command=`，找同时带 `CODEX_HOME=<home>` 与 `FLYWHEEL_EXEC_ID=<id>` 的 **codex 可执行文件** | 与 FLY-2523/2869 collector 看到的是**同一个事实源**（它们就是这么数进程的）；仓库里已有三处同型用法（`generalized-launch-recovery.ts`、`host-readiness.ts`、`lead-lease.ts`） | 需要在 claude-runner 包里再写一次匹配规则（teamlead 依赖 claude-runner，不能反向 import）| **选它**。匹配规则放 claude-runner，用与 collector 相同的向量做单测钉住（见 §4 T0）|
| P2 lease 文件里记 daemon pid + 启动时间 | 释放前 `ps -p pid -o lstart` 比对 | 不用全表扫描 | pid 在 spawn 之后才有，admit 时还没有；TUI client 是第二个进程，pid 不止一个；reown 重认领后 pid 对不上 | 否 |
| P3 socket 持有者（reaper 的 `defaultSocketHolderPids`）| `lsof` 看谁持有 daemon socket | 精确到 daemon | 只覆盖 daemon，不覆盖 TUI client；lsof 慢 | 否 |

P1 实测本机：`ps eww -axo pid=,command=` 输出 2.4 MB，耗时 0.08 s；输出中带 `FLYWHEEL_EXEC_ID=` 的进程 57 个。一次释放调一次、维护 tick 每轮调一次，成本可忽略。

**计入哪些进程**：与 collector 的正则对齐——命令第一个词的 basename 恰为 `codex`（`codex app-server`、`/x/.local/bin/codex resume …`），`codex-code-mode-host` 不计（collector 也不计）。这样「守卫说活着」⇔「collector 也数到它」，不会出现守卫保着 lease、collector 却说 `lease_without_process` 的错位。

**探测失败怎么办**（ps 报错 / 输出为空 / 超时）：**保留 lease**（fail-closed 到「不删」）。理由：collector 在同样情况下也报 `process_authority_invalid`、就绪本来就是 unknown；此时多留一个 lease 不会让结果更坏，删错一个却会让活 runner 的 home 在整个生命周期内不可判。

### 2.2 守卫放在哪一层

| 方案 | 取舍 |
|---|---|
| G1 在每个调用方各自判断 | 四个 adapter 站点 + Blueprint + reown + janitor，七处各写一遍；漏一处就是下一张单 | 否 |
| G2 在 `codex-home.ts` 的三个删除函数内部统一判断，返回结构化结果 | 单一事实源；任何新调用方自动受保护；现有测试（如 CodexTmuxAdapter 558 行「快照失败释放 lease」）在「没有活进程」时行为不变 | **选它** |

返回值：`{ released: true }` 或 `{ released: false, reason: "live_process" | "probe_failed", holders: number[] }`。**不抛异常**——调用方的 `cleanup_unconfirmed` 语义留给真正的 I/O 失败；「因为进程还活着所以没删」是正常结果，不是失败。日志一行 `[codex-home] keyed_home_lease_retained exec=… home=… reason=… holders=…`；真的删除时也加一行 `keyed_home_lease_released exec=… remaining=N`（今天删到 0 时是静默的）。

锁的顺序：探测（ps，≤0.1 s）在 home 锁**外**做，然后进锁、`assertCodexAgentHomeLease`、unlink。TOCTOU 只会朝保守方向错（探测后进程退出 → 这次保留，下次 tick 收掉）。

### 2.3 adapter 收尾顺序

现状两条收尾分支都是 `drained()` → `retireOnce()` → `killWindow()`。改为 `killWindow()` → `drained()` → 有界等待持有者归零（每 500 ms 探测一次，最多 5 s）→ `retireOnce()`。

* `drained()` 抛（SIGKILL 未确认）时：`retireOnce` 照常调用，但守卫会因 daemon 还活着而保留 lease；run 结果已经因 `teardownError` 判失败，不需要额外分支。
* `killWindow` 失败（现在是 `ignored`）：TUI 还活着 → 守卫保留 lease → 维护 tick 稍后收掉。比今天「TUI 永远活在无 lease 的 home」好。
* 有界等待的上限 5 s 取自 `tuiJoinTimeoutMs` 同量级；超时不算失败，只 warn 一行。

### 2.4 运行期自愈（防外来删除）

| 方案 | 取舍 |
|---|---|
| H0 不做，只靠 §2.2 守卫 | 守卫只保护**新代码**的删除者。本机随时有 5–10 个 runner 在**旧 base 的 worktree** 上跑 `vitest`，它们的 janitor 是旧代码，照样会删。exploration §2.3 已证明同一晚发生两次。| 否 |
| H1 adapter 在既有 heartbeat 上复核 | heartbeat 每 5 s 一拍（`pollIntervalMs=5000`），每 12 拍（60 s）`lstat` 一次自己的 lease；缺失 → 进 home 锁用**同一个 token** 重写，日志 `keyed_home_lease_restored`；存在但 token 不同 → 日志 `keyed_home_lease_conflict`、不覆盖。零新定时器。| **选它** |
| H2 Bridge 侧巡检替 runner 补 lease | Bridge 不知道 token；补进去的 lease 会让 adapter 自己的释放因 token 不一致而失败 | 否 |

H1 的边界：自愈只放回 lease 文件，**不**恢复被一起擦掉的 GH_TOKEN 块（exploration §2.4），这条作为 follow-up 单独立单。

### 2.5 残留 lease 的收尾（「同灭」的另一半）

触发场景：守卫在收尾时因持有者未退清而保留了 lease，之后进程退了；或 daemon 崩溃而 session 已终态。今天只有 Bridge 重启时的 janitor 会收，FLY-2869 会把这种 lease 判成 `lease_without_process → unknown`，自动切号又被卡住。

| 方案 | 取舍 |
|---|---|
| S0 不做，等下次 Bridge 重启 | 与「自动切号在 runner 在跑时也能触发」的目标冲突 | 否 |
| S1 挂在 reaper 已有的维护 tick 上（`sweepCodexRunnerOrphans` 之后），条件：① 守卫探测为「无持有者」（探测失败不删）；② 该 exec 不在本 Bridge 的 readopt 候选（`running/ship_parked/awaiting_review/design_done/approved_to_ship`）里；③ lease mtime 早于 10 分钟（避免撞上 admit 之后、daemon 起来之前的窗口）。同一总开关 `worktreeAutocleanEnabled()`。| **选它** |
| S2 新独立定时器 | 违反「零新调度器」 | 否 |

S1 与启动 janitor 的关系：启动 janitor 保留原语义（对照 StateStore 状态），只是**也过守卫**（活进程一律不删）并逐条打日志。

### 2.6 测试隔离

`packages/teamlead/vitest.setup.ts` 的 `beforeEach` 已经为每个测试造隔离根，只需再加 `FLYWHEEL_CODEX_HOMES_ROOT=<root>/codex-homes` 和 `FLYWHEEL_CODEX_SESSION_DIR=<root>/codex-sessions`。这是**卫生**，不是防线（旧 worktree 的测试仍是旧 setup）；防线是 §2.2 + §2.4。

## 3. 与在飞单的关系

| 单 | 关系 |
|---|---|
| FLY-2869（`origin/flywheel-FLY-2869`，未合）| 它的 census 把 daemon+client 按 exec 去重，并把 `lease_without_process` 列为 unknown 原因。本单不改 `host-readiness.ts`；QA 判据 2 需在含 2869 census 的 head 上验（或 2869 合入 main 之后）。两单改动文件不相交（本单不碰 `codex-quota/`）。|
| FLY-2523 | 证据规则原样保留；相关测试文件 `host-readiness.test.ts` 本单零 diff。|
| FLY-2358（keyed home + lease 的原始设计）| 本单是它的生命周期补丁；`admit` / `provision` 合同不变。|
| FLY-2211（rescue / reown）| 748/791 两条 rescue 释放路径在守卫下自动变为「daemon 活着就保留」；reown 365 行同理。不改 reown 的两轮不健康策略。|

## 4. 测试证据设计（每条释放路径一条「进程活着 → lease 还在」）

| 编号 | 位置 | 断言 |
|---|---|---|
| T0 | claude-runner `codex-process-match.test.ts`（新）| 匹配规则向量：`codex app-server …`、`/x/.local/bin/codex resume …` 计入；`codex-code-mode-host`、`node …flywheel-comm`、`claude …`（即便带两个环境标记）不计；只带一个标记不计；`CODEX_HOME` 不同 home 不计 |
| T1 | `codex-home.test.ts` | 注入探测：有持有者 → `release/retire/janitor` 三者都保留 lease、不擦凭据、返回 `live_process`；探测抛错 → 保留、`probe_failed`；无持有者 → 删除且日志 `keyed_home_lease_released` |
| T2a | `CodexTmuxAdapter.test.ts` | 748 路径：持有者活着 → lease 仍在（与现有 558 行「无持有者 → 删」并存）|
| T2b | 同上 | 791 路径（owner admission 失败）同上 |
| T2c | 同上 | 875 / 879 路径同上 |
| T2d | 同上 | `drained()` 抛 → run 失败且 lease 仍在 |
| T2e | 同上 | 正常收尾：调用序列 `killWindow` < `drained` < `release`；释放后 lease 不在 |
| T2f | 同上 | 有界等待：持有者在第 3 次探测后消失 → 释放；5 s 内不消失 → 保留 + warn，run 不失败 |
| T3 | `codex-session-reown.test.ts` | admit 后 arm mismatch 且持有者活着 → lease 仍在 |
| T4 | `CodexTmuxAdapter.test.ts` | 自愈：假时钟推进 12 拍，期间删掉 lease → 用同 token 重建、日志 restored；写入异 token → 不覆盖、日志 conflict |
| T5 | `codex-runner-orphan-reaper.test.ts`（或新 sibling）| 清扫：无持有者+终态+mtime>10 min → 删；有持有者 → 留；mtime 新 → 留；readopt 状态 → 留；探测失败 → 留 |
| T6 | teamlead `vitest.setup` 断言测试（新）| 任一测试内 `FLYWHEEL_CODEX_HOMES_ROOT` 已设且在 tmp 下；`startBridge` 的 janitor 只扫该根 |
| T7 | PR 检查 | `git diff --stat main -- packages/teamlead/src/codex-quota/` 为空 |

QA（真机，由 QA 节点执行）：在含 FLY-2869 census 的 head 上起两个 Codex runner 到同一 role home；运行中 `.flywheel-leases` 恒有两个；在另一个 worktree 跑一次 `alert-drain-switch.integration.test.ts`（旧 base 或新 base 各一次）→ 60 s 内 lease 回来；结束一个 runner → 其 lease 消失、另一个仍在；collector 对该 home 判 `ready`。

## 5. 待 Lead 决定（非阻塞，已按倾向写进 plan）

* Q1 自愈 cadence：60 s（12 拍）。若 Lead 认为要更快，改常数即可。
* Q2 清扫 mtime 阈值：10 分钟。admit 到 daemon 起来实测 11 s（37624e3d：06:25:27 → 06:25:38），10 分钟留了 50 倍余量。
