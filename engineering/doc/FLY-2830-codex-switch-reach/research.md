# FLY-2830 Codex 切号器够不到实现节点 — 调研
Issue: FLY-2830 (https://linear.app/geoforge3d/issue/FLY-2830/codex-切号器-号打满了活却没切到有额度的号上读数-25-小时没刷新认错当前号切号到不了-implement)
日期: 2026-09-25
基于: exploration.md

## 1. 范围裁定（Lead，2026-09-25 ask feecb034）

- **包含** readiness 修复，但只修今日实测的两类卡点：共享 agent home 上活执行体的证据链误判；已终态执行体残留不再挡全舰队。不碰 desktop Codex / FLY-2729。
- Linear QA 判据新增第 6 条：生产只读回放两轮 `ready=true`，或每个阻塞都证明不是误判。
- 充值卡：写清「真数据」的证据，页面显示到期**时分**。
- 占用盘点竞态的修复必须覆盖**在用号**。

## 2. 读数链路（Codex）

| 关注点 | 位置 | 现状 | 本单改动 |
|---|---|---|---|
| 每号读数 | `codex-quota/codex-accounts-observer.ts:326-468` | 每个号先 `refreshInUse()` 盘点占用：`unknown` → 记 `inventory_unavailable` 沿用旧读数；`true` → WHAM 只读 GET；`false` → 隔离 CODEX_HOME 起 app-server 读 | 不改分支结构；`unknown` 时 note 带上盘点失败的原因码 |
| 占用盘点 | `codex-quota/occupancy.ts` `CodexAccountOccupancy` | `collect()` 开始时把共享快照清成 unknown，只有最后开始的那次能写回；`guard()` 调完 `collect()` 后读的是**共享快照**，不是自己那次的结果 | 抽纯函数 `occupancyVerdict(inventory, accountKey, canonicalAccountKey)`；`guard()` 用自己那次 `collect()` 的返回值作答；共享快照的发布规则（给切号 runtime 用的围栏）不变 |
| 在用号只读路径 | `codex-quota/readonly-usage-reader.ts`（`https://chatgpt.com/backend-api/wham/usage`）| 9-25 19:23Z 实测 school：成功，weekly 28%、重置 10-02 03:35Z；未被 Cloudflare 拦 | 不改 |
| 调度 | `codex-quota/reading-scheduler.ts`（15 分钟 + 已知重置后 60 秒），挂在 GatePoller `onLandOperationTick`（`plugin.ts:12781`）| 只刷 Codex | 调度一轮也带上 Claude 卡/订阅（不带 Vercel，保持 FLY-2875 的决定）|

**实验 — school 只读读数**（`scratchpad/wham.mjs`，生产 dist 原样，读 canonical auth，未写任何文件）：

```
OK school {"observedAt":"2026-09-25T19:23:29.649Z","planType":"pro","fiveH":null,
           "weekly":{"usedPercent":28,"windowMinutes":10080,"resetAt":"2026-10-02T03:35:25.000Z"}}
```

**竞态为什么常发生**：维护 tick 每 3 秒跑一次（`plugin.ts:12764`），其中 `refreshAvailability()` → readiness → `occupancy.collect()`；切号 runtime 的 `observe()`/`requireReadiness()` 也走同一个 `collect`。一次盘点要跑 `ps -E`、逐 home 读 lease、逐进程 lsof，耗时秒级。读数一轮要盘点 6 次（每号一次），每次都有较大概率被一次新开始的盘点把快照清掉。9-25 19:13 那一轮 6 个号里 3 个中招（business、school、shopping），与竞态形状一致。

## 3. readiness 证据链

### 3.1 socket 软链（R1）

| 关注点 | 位置 | 现状 |
|---|---|---|
| socket 路径 | `claude-runner/src/codex-daemon-runtime.ts:78` `resolveDaemonSocketPath` = `~/.flywheel/cdx-sock/<sha1(exec)[0:16]>.sock` | 我们传给 `codex app-server --listen unix://<path>` |
| Codex 0.157 行为 | — | `<path>` 被做成软链 → `/private/tmp/codex-daemon-<uid>/<sha256>`（真 socket）。9-22 17:07 PDT 之后的 3 个 socket 全是软链，之前 206 个全是普通 socket |
| 持有者探针 ① | `codex-daemon-runtime.ts:1401` `defaultSocketHolderPids`（同步 `lsof -t -- p`）| 被 `inspectCodexDaemonOwnership`（liveness / `probeCodexDaemonProcessBinding` / `reapCodexDaemonForExecution`）与 `spawnCodexDaemon` 的陈旧 socket 接管共用 |
| 持有者探针 ② | `teamlead/src/bridge/codex-runner-orphan-reaper.ts:342` `defaultSocketHolderPids`（异步）| 孤儿收割器：pre-signal / after-term / after-kill 三处都用 |

实测（`evidence/socket-holder-symlink-2026-09-25.txt`）：`lsof -t -- <软链>` 无输出 exit 1；`lsof -t -- <真路径>` 返回 60140。`net.connect`（`isSocketLive`）跟软链，所以「socket 活着」判得出，「谁持有」判不出，liveness 落到 `unknown`。

**修法选择**：探针内先 `lstat`；是软链就 `realpath`，要求目标 `stat().isSocket()` 且 `uid === process.getuid()`，然后对**真路径**跑 lsof；不是软链照旧。身份权威不变：持有者 pid 仍要落在我们 ledger 记的 pgid 里、start identity 仍要比对，所以解析软链不会扩大「可以杀谁」。收割器 unlink 时只删我们的软链路径（真 socket 在 Codex 自管的 `/private/tmp/codex-daemon-<uid>/` 里，进程死后是惰性文件，不碰）。

**回放验证**（`scratchpad/replay-patched.mjs`，只把探针换成先解析软链）：`daemon_not_alive` 消失；FLY-2874 app-server 60140 的 resident 证据变 `verified`。剩余阻塞 = §3.2 + §3.3。

### 3.2 resident 执行体的 TUI 客户端（R3）

`host-readiness.ts:605-689`：home 上没有 lease 且有 `residentEvidence` 时，对盘点到的每个 Codex 进程（只认 `ucomm=codex`，`host-process-snapshot.ts:114`）调 `probeDaemonProcessBinding`，要求它是 socket 持有者且在 daemon 进程组。FLY-2874 的进程：

| pid | ppid | pgid | ucomm | 角色 | 现行判定 |
|---|---|---|---|---|---|
| 60140 | 1 | 60140 | codex | app-server daemon | 修 R1 后 `verified` |
| 18081 | 32334 (tmux) | 18081 | codex | `codex resume --remote unix://<本执行体 socket 路径> -C <worktree>` | `socket_holder_mismatch` |
| 65356 | 60140 | 65356 | codex-code-mode- | daemon 子进程 | 不进盘点 |

**修法选择**：先对每个执行体找出并证实 daemon（现规则不变）；daemon 已证实后，其余进程只接受一种形状 —— **TUI 客户端**：argv 精确为 `<codex 可执行> resume --remote unix://<resolveDaemonSocketPath(exec)> …`、`FLYWHEEL_EXEC_ID` = 该执行体、`CODEX_HOME` = 该 home、start identity 可读。其它任何形状照旧 `resident_evidence_incomplete`（仍 fail-closed）。盘点快照要多带 `ppid` 与完整 argv（`host-process-snapshot.ts` 的 `ps` 列已经有 `command=`，解析时保留 argv 数组即可）。

为什么客户端可以放行：readiness 要回答的是「每个碰 canonical 凭据链的活 Codex 进程，是否都能归到一个已知执行体」。客户端用同一个 `CODEX_HOME`、连的是已证实属于该执行体的 daemon socket、环境里是同一个执行体 id —— 它能被归属，归属后的处置（该执行体活着 → home active）与 daemon 完全相同。lease 路径（FLY-2877 之后启动的执行体）本来就按 `FLYWHEEL_EXEC_ID` 认客户端，这里只是让 lease 之前的 resident 执行体用同一个认法；认不出的任何其它形状仍然 fail-closed。

### 3.3 已终态执行体的 app-server（R1 的连锁 + 收割门槛）

FLY-2873（exec 37624e3d）：StateStore `completed`（9-25 07:57Z），CommDB 已无行，app-server 86434 自 9-24 23:25 PDT 常驻。收尾 reap（`reapCodexDaemonForExecution`）与孤儿收割器（Bridge 日志 `codex_app_server_orphan_socket_holder_mismatch pid 86434`）都因 R1 判「证不出」。修 R1 后两条路都能收它。

孤儿收割器的年龄门槛 `CODEX_APP_SERVER_ORPHAN_MIN_ELAPSED_SECONDS = 2h`（按进程年龄）。初稿曾提议「StateStore 已终态 ≥10 分钟即可收」；design review R1 指出终态集合的权威与收割器并无 start-identity 门，**已删除该改动**（plan §4）：修 R1 后正常收尾当场可收，2h 收割器只作兜底。

### 3.4 回放结论

| 回放 | 结果 |
|---|---|
| 生产原样（`evidence/readiness-production-replay-2026-09-25.txt`）| `daemon_not_alive`(b6c738ca) + `resident_evidence_incomplete`(implement) + `comm_orphan`(b6c738ca) |
| 只修 R1 | `resident_evidence_incomplete`(implement) + `comm_orphan`(b6c738ca)：37624e3d 孤儿在（CommDB 无行）、18081 客户端不认 |
| R1 + R3 + 收掉 86434 | 预期 `ready=true`；实现节点须用同一脚本对生产 dist 复跑两轮并附原文（QA 判据 6）|

## 4. 切号后重读

### 4.1 四条切号路径与 Bridge 能看到的信号

| 路径 | 完成点 | Bridge 看到的信号 | 现延迟 |
|---|---|---|---|
| Codex 自动 | `codex-quota-store.ts:686` `commitGeneration` | codex quota root `generation` +1 | 同进程 |
| Codex 手动 `codex-profile use` | 写 `~/.codex/auth.json` | 维护 tick `reconcileCodexCanonicalRoot` → `reconcileExternalRoot` 把 root `generation` +1（`codex-quota-store.ts:341`）| ≤3 s |
| Claude 自动（quota-monitor）| `switch-executor.ts:565` `commitSwitch` → `accounts.json.lastSwitch.generation` | `account-switch-consumer.ts` 每 60 s 读 `lastSwitch` | ≤60 s |
| Claude 手动 `flywheel-claude-profile use` | 同上（经 `account-switch-cli`）| 同上 | ≤60 s |

两个 vendor 的切号在 Bridge 里各有一个单调递增的 generation。**挂点**：一个 Bridge 内的 `SwitchRefreshTrigger`，每个 GatePoller tick 读这两个 generation（Codex 从 StateStore，Claude 复用 consumer 已读的 `lastSwitch`，节流 10 s），任一比上次大就调 `refreshAfterSwitch()`。启动时以当前值为基线（不在启动时补刷；启动后调度器第一轮本来就会读）。

**否决**：给 `account_switch_action_receipt` 加第三种 action。表上有 `CHECK(action IN ('review_redrive','wake_sweep'))`，要重建表迁移；而重读是幂等的，丢一次（例如切号后 Bridge 恰好重启）由调度器兜底，不值得一张耐久回执。

### 4.2 `refreshAfterSwitch()` 读什么

- Bridge 一侧：复用 `createAccountQuotaRefresh`（Codex 读数 + Codex 订阅 + Claude 卡/订阅，**不含 Vercel**），单飞合并：连续两次切号只会并出一轮，正在跑的一轮结束后若又有新切号再补一轮（「尾随一次」）。
- Claude 5h/周：这些数只有 quota-monitor 读（它是 Claude 切号器的决策依据），Bridge 不另起第二个来源。做法是**请 quota-monitor 立刻做一次全量 sweep**：
  - Bridge 写 `~/.flywheel/claude-quota/sweep-request.json` `{requestId, requestedAt, reason}`（原子写），再用现成的 `bridge/quota-daemon-wake.ts` 发 SIGUSR1（它自带 pidfile 身份核对与 60 s 限流）。
  - quota-monitor 每一轮开头读这个文件；`requestId` 与 state 里的 `lastSweepRequestId` 不同 → 本轮 `nextUsageDueAt = now`（先读在用号）并跑 `sweepCandidates`（不看 60 分钟计时），完成后把 `lastSweepRequestId` 写进 state。仍尊重既有的 monitor-only、model-limit 闸门；被闸门挡下时在 state 记原因，页面据此显示。
  - SIGUSR1 只让守护进程跳过当前等待；即使限流没发出去，守护进程最迟 60 s 后（pane scan 周期）也会自己跑一轮看到请求。
- 代价：`sweepCandidates` 对每个非在用号先 `verifyPoolCredential`（强制刷新池里的 OAuth token 并写回）。这是它每小时本来就做的事；切号一天几次，多出的刷新可以接受。**不**在本单里改 sweep 的刷新策略。

### 4.3 延迟预算（QA 判据 3：≤2 分钟）

| 段 | Codex 切号 | Claude 切号 |
|---|---|---|
| Bridge 看到 generation 变化 | ≤3 s | ≤60 s（consumer 读 `accounts.json`）→ 本单把 trigger 自己的读放到 10 s 节流，≤10 s |
| Bridge 全量刷新 | Codex 6 号 + Claude 4 号，上限 90 s（现有 ceiling）| 同左 |
| quota-monitor sweep | 收到 SIGUSR1 立刻；最坏 60 s | 同左 |
| sweep 本身 | 5 个 Claude 号，每号 1 次 usage GET + 1 次 token 校验 | 同左 |

## 5. Claude 下次扣费日（第二轮调研）

| 来源 | 需要的凭据 | 有没有下次扣费日 | 结论 |
|---|---|---|---|
| `api.anthropic.com/api/oauth/profile` | OAuth token（已在用）| 没有；有 `subscription_created_at`、`billing_type`、`subscription_status` | 已在调 |
| `/api/oauth/usage` cedar_ember | OAuth token | 没有；`billing_period` 只给 monthly/annual/unknown，FLY-2864 实测为 `unknown` | 已在调 |
| OAuth 组织接口 `prepaid/*`、`payment_method`、`overage_*` | OAuth token | 没有 | 无用 |
| Claude Code 2.1.282 程序内接口串 | — | 找不到 subscription/invoice/renewal 类接口，也没有 `renews_at`/`next_charge`/`current_period_end` 字段名 | — |
| 本机 `.credentials.json`、`oauthAccount`（字段名）| — | 只有 `subscriptionCreatedAt`，无续费日 | — |
| `claude.ai/api/organizations/{org}/subscription_details` | 浏览器登录 cookie；OAuth 调用 403 `oauth_token_not_accepted`（FLY-2864 实测）| **有** | 违反 Anthropic 条款（"may not collect, store, or intermediate Claude.ai credentials or session tokens"，https://code.claude.com/docs/en/legal-and-compliance）；founder 9-24 已否决 |
| Stripe 收据邮件 | Gmail 读权限 | 可能 | founder 9-24 已否决 |
| 开通日 + 月周期推算 | — | 推算值 | 有反例；founder 禁止 |
| 社区工具（agent-usage-bar、Claude-Usage-Tracker 等）| cookie | 只读用量 | 社区原话 "No billing-cycle date is available from Claude; do not infer one"（https://github.com/dougiefresh49/agent-usage-bar/issues/48）|

**结论**：继续读不到。页面该格改成具体原因：「读不到：Anthropic 只在 claude.ai 网页账单页给出（需浏览器登录，已决定不取）」；已取消的号仍显示「已取消」。不存开通日、不显示推算值。

## 6. 呈现层

| 项 | 位置 | 改动 |
|---|---|---|
| 卡到期 | `bridge/account-quota-view.ts:181` `formatCardExpiry` | PT 显示到分钟：`10/22 13:22`（Codex 6 张各不相同；Claude 4 张确实都是 09:00）|
| 每行读于几点 | `bridge/account-quota-page.ts:270-280` `renderPageRow` | Codex 行加「读于 HH:MM」；Claude 行分开写「用量读于 HH:MM · 卡读于 HH:MM」（两个来源、两个时间，不合并）|
| 读不到的原因 | `account-quota-view.ts:203` note → 文案 | `inventory_unavailable` 文案改为「占用盘点失败（<原因码>），本次未读，沿用 HH:MM 读数」；`readonly_forbidden` 写「被 chatgpt.com 拒绝（HTTP 403）」；`readonly_unauthorized` 写「只读凭据已过期（HTTP 401）」|
| 全部打满告警 | `codex-quota/outbox.ts:494` founder_alert 正文 | 中文；逐号列「号 · 窗口 · 用量 · 几点重置（PT）」，取自该 incident 最新 capacity 证据；末行写最早可恢复时刻 |

## 7. 其它已核实、本单不改的

- 缺陷 3 的凭据层：`provisionCodexHome` 对已存在的普通文件 auth 会写一份当下 canonical 并打 `.credential-copy-pending`（`codex-home.ts:1960-1983`），由 FLY-2523 home-migration 转软链；新 home 直接 `placeCredentialLink`。今天三个 agent home 都已是软链、没有 pending 标记。
- 自动切号本身的选号/安装/通知（FLY-2869 A–D 已交付）不改。
- Claude 切号器决策逻辑、sweep 刷 token 策略不改。
