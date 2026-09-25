# FLY-2877 Codex lease 生命周期 — 探索
Issue: FLY-2877 (https://linear.app/geoforge3d/issue/FLY-2877/病根codex-lease-codextmuxadapter-在-runner-的-codex-进程仍活着时就释放了-flywheel)
日期: 2026-09-25
基于: 无

## 1. 问题陈述（issue 原话的精确化）

共享 agent home `~/.flywheel/codex-homes/agents/flywheel/implement` 上同时有两个在跑的 Codex runner（FLY-2873 = exec `37624e3d`，FLY-2874 = exec `b6c738ca`），但 `.flywheel-leases/` 里只剩 `b6c738ca` 一个 lease。FLY-2523 的证据规则要求「每个 codex 进程都对应一个在 CommDB 里 running 的 lease」，于是 FLY-2869 的就绪判定把这个 home 判成 `unknown`（外加 `comm_orphan`），自动切号永远等不到 `ready`。

issue 把病根指向 `CodexTmuxAdapter` 的四条释放路径（约 750 / 791 / 875 / 879 行）。本探索的第一件事是**验证这个指向**：37624e3d 的 lease 到底是被谁、在什么时候删掉的。

## 2. 生产只读回放（2026-09-25 00:0x–00:5x PDT，全部只读）

| 事实 | 来源 |
|---|---|
| exec 37624e3d：StateStore `started_at=06:25:27.861Z`；daemon pid 86434 起于 23:25:38；TUI client（`~/.local/bin/codex resume --remote`）pid 44535 起于 23:27:19；code-mode-host pid 27128 起于 23:26:49。三者至今存活，环境都带 `CODEX_HOME=…/implement` + `FLYWHEEL_EXEC_ID=37624e3d…` | `ps -Eo`、StateStore 只读查询 |
| exec b6c738ca：StateStore `started_at=06:36:27.030Z`；lease 文件 mtime `23:36:27`；daemon 60140 起于 23:36:38 | `stat -f %Sm`、StateStore |
| `.flywheel-leases/` 目录 mtime = `23:36:27`，与 b6c738ca 的 lease 文件同秒 | `stat` |
| 两个 exec 在 CommDB 都是 `status=running, vendor=codex, phase_keep_alive=1` | CommDB 只读查询 |
| 生产 Bridge（pid 3120）起于 **00:01:21**；`bridge-wrapper-starts` 只记录 07:00:50Z / 07:01:21Z 两次 | `ps`、`~/.flywheel/state/bridge-wrapper-starts` |
| 生产 Bridge 日志（23:08 轮转后的 `/tmp/flywheel-bridge.log`）中 37624e3d 共 12 行，**没有任何** `keyed_home_*` / `RunDispatcher … resolved` 行 | `grep` |

### 2.1 推论：lease 在 23:25:27–23:36:27 之间被删，且不是 adapter 自己删的

目录 mtime 是目录里最后一次增删的时间。b6c738ca 的 lease 在 23:36:27 创建之后目录没再变过，所以 37624e3d 的 lease 必然在 **23:36:27 或之前** 被 `unlink`。这个窗口内：

* 生产 Bridge 没有重启（唯一一次重启在 00:01:21），所以**启动 janitor**（`scrubOrphanedCodexAgentHomes`）没在生产 Bridge 里跑。
* adapter 的四条释放路径分别落在 `resumeExistingExecution` 快照读取失败（748 行）、owner admission 失败（791 行）、`retireExecutionCredential`（875/879 行）以及 `runWithOwnership` 的 `finally`（825 行，任何 `executeOwned` 结束）。这些路径要么发生在 daemon 起来之前，要么发生在 `executeOwned` 返回之后。37624e3d 的 daemon 于 23:25:38 起来并一直活着，日志里也没有 `RunDispatcher … resolved` —— 它的 `executeOwned` 至今没有返回。**四条路径没有一条对 37624e3d 触发过。**

### 2.2 谁能静默删 lease

全仓 `git grep` 所有会 `unlink` lease 文件的代码（不含测试）：

| 调用方 | 什么时候跑 | 会不会查进程 | 删除时有无日志 |
|---|---|---|---|
| `releaseCodexAgentHomeLease`（codex-home.ts 2177）| adapter 4 条路径、Blueprint 未交接释放、session-reown 失败回滚 | 否 | 只有「还剩 N 个 lease」时才 warn；删到 0 个时**无日志** |
| `retireCodexExecutionHome`（2449）| adapter 正常收尾 | 否 | 同上 |
| `scrubOrphanedCodexAgentHomes`（2227）| **每个 Bridge 进程启动时**（run-infra.ts 1415）| 否，只看**调用方自己的 StateStore** 里 session 状态是否在 `running/ship_parked/awaiting_review/design_done/approved_to_ship` | 每条删除**无日志**，只由 run-infra 打一行总数 |
| `codex-runner-orphan-reaper` | 维护 tick | 只读 lease 名做 census，不删 lease | — |
| `codex-home-credential-sweep.mjs` / `codex-credential-cutover.sh` | 人工 | 只读 lease 判 busy，不删 | — |

唯一在 23:25–23:36 窗口里**可能**跑、又**不看进程**、又**删除无日志**的，是第三行：某个**非生产 Bridge 进程**的启动 janitor。

### 2.3 找到同类事件的直接证据（同一晚，两次）

`packages/teamlead/vitest.setup.ts` 给每个测试隔离了 `FLYWHEEL_COMM_DIR` / `FLYWHEEL_STATE_DIR` / lead-lease，但**没有隔离 `FLYWHEEL_CODEX_HOMES_ROOT`**。任何调用 `startBridge()` 的集成测试都会用真实 `HOME` 跑 run-infra 的启动 janitor：它扫的是**生产** `~/.flywheel/codex-homes/agents/*/*/.flywheel-leases`，拿来对照的却是**测试自己的空 StateStore**，于是生产上每一个 lease 都是「孤儿」。

在本机找到了两份持久化的 vitest 输出：

| 文件 | 时间 | 测试 | 日志行 | 当时刚起的生产 Codex runner |
|---|---|---|---|---|
| `/tmp/qa2761-direct.log` | 21:08:42 | `epic-residual-plugin-wiring.test.ts` | `[RunInfra] FLY-2358: scrubbed 1 orphaned keyed codex home lease(s) at startup` | exec a918d47e（CommDB `started_at 04:06:25Z` = 21:06:25）|
| `/tmp/qa2761-related.log` | 21:22:04 | `alert-drain-switch.integration.test.ts` | `… scrubbed 2 orphaned keyed codex home lease(s) at startup` | exec 00c725fa（`04:21:25Z` = 21:21:25，刚 admit 37 秒）|

两份日志都印着 `FLYWHEEL_REPO_ROOT resolved to "/Users/xiaorongli/Dev/flywheel-FLY-2761"` —— 是 FLY-2761 的 runner 在**另一个 worktree** 里跑 `vitest related`，顺手把生产 runner 的 lease 删了。

23:25–23:36 那一次的输出没有落盘（vitest 输出通常只留在 runner 的 tmux pane；我搜了 `/tmp`、所有 scratchpad、所有活着的 tmux pane，都没有再命中）。**诚实边界：那一次的具体进程没有钉死；但同一机制在同一晚已被两份日志证明，且它是窗口内唯一满足「跑过 / 不看进程 / 删除无日志」三个条件的删除者。**

### 2.4 副作用：删到 0 个 lease 时顺手把 GH_TOKEN 也擦了

`releaseCodexAgentHomeLease` / `scrubOrphanedCodexAgentHomes` 在 lease 归零时调用 `scrubCodexHomeCredentialAt(home, true)`，把 `config.toml` 里的 GH_TOKEN 块删掉。生产 `implement/config.toml` mtime 是 23:38:05，正是 b6c738ca 重新 provision 时写回的。也就是说 37624e3d 在被误删 lease 的同时，家目录里的 push 凭据也被擦过一轮，直到下一个 runner 进来才恢复。本单不修这个（见 §6），但要记在案。

## 3. 第二个缺陷：就算 lease 都在，main 上的 collector 也判 unknown

main 的 `host-readiness.ts` 第 494–496 行用 `processes.length !== leases.length` 比对。每个 Codex runner 有**两个**被计入的进程（`codex app-server` daemon + `codex resume --remote` TUI client，都带 `CODEX_HOME` 和 `FLYWHEEL_EXEC_ID`；`codex-code-mode-host` 因为正则要求 `codex` 后面是空白而**不**计入）。两个 runner 并行 = 4 个进程 vs 2 个 lease → 恒 `unknown`。

`origin/flywheel-FLY-2869` 的提交 `2d5d24efc` 「a Codex daemon and its client are one execution in the readiness census」已把比对改成 `processExecutions.size !== new Set(leases).size`（按 exec 去重）。**issue 的 QA 判据第 2 条（两个 runner 同 home 并行判 ready）只能在含 FLY-2869 census 的 head 上成立**；本单不改 `host-readiness.ts`（⛔ 条款）。

## 4. 第三个缺陷：lease 一旦丢了，没有任何东西会把它放回去

* lease 的 token 只存在于 adapter 内存里的 `ctx.codexAgentHome.token`；`session.json` 只存 project/role/home。
* Bridge 重启后的 `codex-session-reown` 会重新 `admit`（缺 lease 时会创建），但 00:01 那次对 37624e3d 的结论是「Codex daemon ownership or rollout progress stayed unhealthy for two recovery passes; no mutation was attempted」——它没有重 admit。
* adapter 在运行期间从不复核自己的 lease。

于是一次误删 = 该 home 在这个 runner 活着的整个生命周期内（可能十几个小时）都判 `unknown`。

## 5. adapter 自身确有的四处「进程活着也释放」（issue 指向的那一半，代码审计结论）

虽然生产这次不是 adapter 触发的，issue 要求「回归测试覆盖每一条释放路径」，审计发现以下路径在特定条件下**确实**会在进程活着时释放 lease，都要一并修：

| # | 路径 | 触发条件 | 进程为什么还活着 |
|---|---|---|---|
| A1 | `runWithOwnership` finally → `retireOnce()`（825）| `runtime.drained()` 抛 SIGKILL-unconfirmed（`teardownError`）| daemon 没杀死却照样 `retireOnce` |
| A2 | 两条收尾分支（1922 / 2019）：`retireOnce()` 在 `killWindow()` **之前** | 每次正常收尾 | TUI client `codex resume --remote` 在释放那一刻仍活着；`killWindow` 失败只 log「ignored」，此时 TUI 会**永远**活在没有 lease 的家目录里（FLY-2869 census：有进程无 lease → unknown）|
| A3 | `resumeExistingExecution` 快照读取失败（748）/ owner admission 失败（791）| Bridge 重启后 rescue，reown 刚为它重建了 lease（`createdLease=true`）| 上一个 Bridge 起的 daemon 还在跑 |
| A4 | `retireExecutionCredential` resolution=`unknown` 且 `createdLease`（879）| session.json 缺失/损坏 | 同上 |
| A5 | `codex-session-reown.ts` 365：admit 成功后任何校验失败就 `release` | arm/path mismatch | daemon 活着 |

共同点：**所有释放点都只看「我是不是创建者」，从不问「进程还在不在」。**

## 6. 范围：本单做什么、不做什么

做：
1. lease 与 codex 进程「同生同灭」的不变量，落在**唯一**的删除守卫上（所有 unlink 站点共用）。
2. adapter 收尾顺序改为「先杀 TUI → 确认 daemon 退出 → 再释放」。
3. 运行期 lease 自愈（防旧 worktree 里的旧 janitor 和任何外来删除）。
4. 进程退出后仍残留的 lease 由既有维护 tick 收掉（「同灭」的另一半）。
5. teamlead 测试隔离 `FLYWHEEL_CODEX_HOMES_ROOT`。
6. 每条释放路径的回归测试：进程活着 → lease 必须还在。

不做：
* 不改 `host-readiness.ts`、不删不改其测试断言（⛔）。
* 不修 §2.4 的 GH_TOKEN 被擦问题（另开单，plan 里列 follow-up）。
* 不处理生产上正在跑的 37624e3d（它的 lease 已丢、token 只在旧代码的内存里；它自然结束后该 home 恢复可判；见 plan「诚实边界」）。
* 不改 reown 的「两轮不健康就不动」策略。

## 7. 待 Lead 决定的问题（非阻塞，见 research.md §5）

* Q1 自愈的 cadence：跟随既有 heartbeat（FLY-1269，默认约 30–60 s）还是独立定时器。倾向前者（零新调度器）。
* Q2 「残留 lease 清扫」是否必须在本单：它决定「进程退出后 lease 释放」这条硬红在 adapter 释放被守卫挡下时是否仍成立。倾向做，但只挂在既有 reaper 的维护 tick 与总开关下。
