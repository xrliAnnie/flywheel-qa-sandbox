# FLY-2903 已结束的 Codex 体真正关掉 — 调研
Issue: FLY-2903 (https://linear.app/geoforge3d/issue/FLY-2903/codex收尸-已结束的-codex-runner-必须真正关掉daemon-app-server-关闭可验证goal-runtime)
日期: 2026-09-25
基于: exploration.md

## 1. 核心判断

「死后继续烧额度」有两个独立的洞，必须两个一起堵：

1. **复活洞**（FLY-2814）：Bridge 直接杀 daemon，进程内的 goal runtime 不知情，当崩溃处理自动重启。收尸收得越干净，它复活得越勤快 —— FLY-2830 把软链探针修好之后，这个洞只会**更**常被触发（以前 `unverifiable` 不发信号，daemon 活着但至少不复活；现在能杀了，杀完就复活）。所以本单是 FLY-2830 上线后的必要配套。
2. **没人收的洞**（FLY-2892/2555 形状）：收尸结果被丢弃；CommDB 行终结之后，没有任何兜底能看到这个执行体；正常完成路径完全依赖 adapter 进程内的一次拆除。

## 2. 方案比较

### 2.1 怎么让 runtime 知道「这是我们杀的」

| 方案 | 做法 | 评价 |
|------|------|------|
| **A 先停 owner 再杀（选）** | 所有权登记加一个「请停」通道：adapter claim 时登记停止回调；Bridge 终态路径先 `requestStop(execId)`，adapter 在已有的 settlement race 里多一路 `termination` → `runtime.stop()` → 等 drain；然后 Bridge 再 reap（兜底 + 验证） | 复用 adapter 已有的 `shutdown/retirement` race 模式；`stop()` 置 `stopped=true`，runtime 永远不会复活；同时修掉退役竞态。改动集中在一个 registry + 一处 race + 一个 Bridge wrapper |
| B runtime 重启前读 StateStore 状态 | 给 runtime 注入 `isTerminal()` 回调，重启前查会话是否终态 | 必要的**第二道闸**，但单独不够：Bridge 杀完 daemon 与写终态之间有时序（closeRunner override 路径、退役路径 body 是 `retiring` 而会话仍 running），且 runtime 在 claude-runner 包里拿不到 StateStore |
| C 杀之前写「墓碑文件」，runtime 重启前读 | 磁盘标记 | 多一个持久写点和清理问题；进程内有 registry 就够，Bridge 重启时 runtime 本身也没了 |
| D 关掉自动重启（maxRestarts=0） | 一刀切 | 真崩溃（上游断线、daemon OOM）也不救了，回到 FLY-1188 之前的脆弱性。拒绝 |

**选 A + 一道轻量的 B**：runtime 的重启条件多一个注入谓词 `mayRestart()`，adapter 用「registry 上是否已请求停止」+「进程退役是否已批准」回答。谓词抛错 → 不重启（宁可这次执行失败走引擎判死换体，也不在不确定时复活）。不在 runtime 里读 StateStore，保持单一事实来源（registry）；StateStore 终态但 registry 没收到停止请求的情况由 §2.3 巡检发现并补发 `requestStop`。

### 2.2 「关闭可验证」的判据

一个终态 Codex 执行体被判 **closed**，需要同时满足（全部只读探测）：

1. 进程内没有 owner（`registry.isExecutionOwned` 为假）；
2. ledger pgid 已不存在（`kill(-pgid,0)` = ESRCH），或 ledger 不存在；
3. socket 不再监听（`isSocketLive` 假：ENOENT / ECONNREFUSED；软链路径按 FLY-2830 解析）；
4. FLY-2877 进程快照里没有 `FLYWHEEL_EXEC_ID=<exec>` 的 codex 进程（`holdersFromSnapshot` 以 `status:"ok", holders:[]` 回答；`unknown` 不算通过）；
5. **两次采样**：第一次满足 1–4 时记下 rollout 的累计 token；下一个 tick 再测一次 1–4 且累计 token 没涨，才落 `closed`。

第 5 条防的是 exploration E2 的「假成功」：旧 pgid 死了但 runtime 在同一 socket 上换了身体。也符合「只读一次的计数器 = 没观察过」的纪律。

「socket 释放」的定义取第 3 条（不再监听），不要求文件不存在：reap 路径不 unlink，stale socket 文件无害（下次 spawn 会 `removeStaleSocket`）。本单在 `closed` 时对**我们自己的路径**（`resolveDaemonSocketPath` 的那个名字，软链或普通 socket）做一次 best-effort unlink，不跟随软链删目标（与 FLY-2830 收割器规则一致）。

### 2.3 周期巡检放哪里

| 方案 | 评价 |
|------|------|
| 扩 FLY-2555 终态收割 | 它挂在 CommDB `running` 行上，行一终结就看不到 —— 正是 FLY-2873 漏掉的原因。拒绝 |
| 放宽 FLY-2169 孤儿收割器门槛 | FLY-2830 已评审拒绝（终态集合权威 + start identity 不牢）。拒绝 |
| **新巡检，以 StateStore 终态为候选源（选）** | 挂在现有维护 tick（5 分钟，零新定时器）。候选 = 近 48h 终态的 `codex-tmux` 会话 ∪ 本 tick 进程快照里带 `FLYWHEEL_EXEC_ID` 且会话已终态的执行体（后者无年龄限制，专抓长命泄漏）。每 tick 上限 25 个，一个 tick 共享一次 `ps` 快照 |

候选状态集合：`completed / failed / terminated / blocked`。理由：这些状态下 adapter 的 `runGoal` 都已结束、finally 已 `stop()` runtime；任何仍活的 daemon 都是泄漏（A3）。`ship_parked`、`standby`、`retiring`、`resuming` 等「故意活着」的状态**不在**集合里。`terminal_at` 需早于 3 分钟（给 adapter 自己的 drain 留时间：SIGTERM + 5s + SIGKILL + 验证）。

### 2.4 巡检发现活体后怎么处置

| 观察 | 处置 |
|------|------|
| 终态 + **仍 owned**（FLY-2766 形状：goal 还在进程内跑） | 连续两个 tick 都看到才动手 → `registry.requestStop(exec, "terminal_sweep")`。不直接杀进程组 |
| 终态 + 无 owner + ownership **可证实**（ledger pgid 持有 socket） | `reapCodexDaemonForExecution`（默认 SIGTERM→SIGKILL 升级），`beforeSignal` 同步复查：仍终态、仍无 owner、无 resident hold |
| 终态 + 无 owner + ownership **证不出**（`unverifiable`） | **不发信号**，告警。本单不新增按 env 归属杀进程的路径 |
| 任何状态下 rollout 在 `terminal_at + 2min` 之后累计 token 增长 | 记入账本 `tokensAfterTerminal`，告警（即使随后收掉也告，带数字） |

为什么终态 + 无 owner 用默认升级而不是 FLY-2555 的 `gracefulOnly`：FLY-2555 的收割与 CommDB 删除绑在一起、且那时软链探针坏着，所以保守；本单的前提是**身份已证实 + 会话终态 + 无进程内 owner + 两道复查**，SIGTERM 不退就该 SIGKILL，否则「收不掉」的体继续烧额度。

### 2.5 token 用量怎么读

- 路径：`session.json.threadId` + 执行体 CODEX_HOME → `findCodexRolloutPath`。该函数会遍历整个 `sessions/` 树（共享 agent home 下文件很多），所以**只在首次**调用并把路径缓存进账本。
- 首次读：流式扫一遍 rollout，取 `timestamp ≤ terminal_at + 2min` 的最后一条 `token_count` 的 `total_tokens` 作为 `tokensAtTerminal`，并记下文件字节偏移 `rolloutOffset`（与 FLY-2893 `usage.py` 同口径，计数器回落按新段处理）。
- 之后每次：只从 `rolloutOffset` 读到 EOF（增量），累加终态后的增量，更新偏移。单次读取上限 8 MiB，超出记 `rollout_read_truncated` 并下个 tick 继续。
- 解析复用 `parseCodexUsageLine`（`total_tokens` 必须等于 input+output，否则忽略该行）。
- 找不到 rollout / threadId → `tokens=unknown`，不影响收尸判定，只是账本里这列为空。

### 2.6 存哪里：新表 vs 只写事件

选**新 StateStore 表 `codex_terminal_close`**（一执行体一行），理由：巡检每 tick 要知道「这个执行体已经 closed 了没」「上次 token 读到哪」「连续几次看到 owned」，从 `session_events` 反推太脆；额度页要一个便宜的读源。状态转移时另写一条 `session_events`（确定性 event_id，按 exec+状态去重）作审计。

新表必须补 `scripts/lib/fly-2006-retention-tables/teamlead/codex_terminal_close.json` 分类（否则 Quick Gate `schema_unclassified`）。

### 2.7 告警与可见性

- 新告警 kind `codex_terminal_body_alive`（severity `severe`，项目 `FLEET_ALERT_PROJECT`，照抄 `codex_lead_residency_stalled` 的哈希 episode）。一个执行体每个处置结果最多告一次。
- 额度页：顶部横幅「终态体仍在用额度」，列出账本里 `alive_*` 状态或 `tokensAfterTerminal>0` 且终态 ≤24h 的执行体：单号、执行体短 id、终态时间、终态后 token、处置结果。所有派生文本经现有 `escapeHtml`。
- 不改巡检快照 shell 脚本（范围取舍，见 exploration §7）。

## 3. 风险

| 风险 | 缓解 |
|------|------|
| `requestStop` 误停一个合法在跑的体 | 只由终态路径（FSM 已 terminated / 终态，或 Lead 明确 override close）与巡检（终态 + 连续两 tick）调用；登记表本身不读任何外部状态 |
| 巡检误杀 | 不新增杀进程路径，只复用 `reapCodexDaemonForExecution`（ledger pgid ↔ socket 持有者证实 + `beforeSignal` + 拒绝自身进程组）；证不出一律只告警 |
| 首次上线的积压 | 候选只取 48h 窗口 + 进程快照直接命中；每 tick 25 个；第一轮大多数执行体一次测完即进入待确认、下一轮 closed |
| 巡检耗时拖慢维护 tick | 一次 `ps` 快照共享；`lsof` 只对 socket 仍 live 的候选跑；rollout 增量读；整轮 30s 软预算，超了剩余候选留到下一 tick |
| 回滚 | 新 bridge_global flag `codex_terminal_reap_enabled`（默认开）：关 = 巡检只观测 + 记账 + 告警，不发 `requestStop`、不 reap。`requestStop` 与重启闸门不受 flag 控制（它们只让「我们自己要关的」真的关掉） |
