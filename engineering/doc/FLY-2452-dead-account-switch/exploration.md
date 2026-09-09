# FLY-2452 死号切号 — 探索
Issue: FLY-2452 (https://linear.app/geoforge3d/issue/FLY-2452/账号切号-claude-号被-disable订阅到期时切号器不切quota-poll-只当-backoffreviewer-job)
日期: 2026-09-09
基于: 无

## 1. 问题一句话

Claude 账号池的切号器只认「额度用完」一种死法。当活跃号因订阅取消 / 到期 / 被 org 禁用而**整个不可用**时,三层都把它当成暂时故障:quota monitor 无限 backoff,review job 判成终态 failed,活着的 Claude 体停在 prompt 上没人推。9-8 事故 3h38m 全靠 founder 手动 `/login` 才结束。

## 2. 事故复盘(用本机原始证据核对)

| 时间(UTC) | 证据来源 | 事实 |
|---|---|---|
| 21:33 | `~/.flywheel/logs/quota-monitor.log` | 最后一次成功读 personal1 用量:`five_h=24 seven_d=70` |
| 21:49 | `teamlead.db` `codex_review_job` | FLY-2359 R1 reviewer job `failed nonzero_exit`,`failure_raw` 含 `"api_error_status":403`、`"terminal_reason":"api_error"`、`"duration_api_ms":0`、`"result":"Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access"` |
| 21:53 → 01:04 | quota-monitor.log | 8 次 `quota_poll outcome=backoff` + 1 次 `outcome=error`,`panorama=[]`,从未出现 `quota_switch_decision` |
| 21:49 → 00:09 | `codex_review_job` | 至少 10 行同形 403 失败(2359×4 / 2398×5 / 2445×1),全部 `retry_at NULL`、`auto_retry_count 0`、`failure_attempt_count 1` |
| 21:49 → 01:27 | `/tmp/flywheel-bridge.log` | 窗口内**零条** runner 认证扫描 / login_expired 告警;Bridge 没看见 QA 体的 403 |
| 01:27 | quota-monitor.log + `claude-profile-audit.log` | founder 手动 `/login` 后 monitor 记 `account_switch_reconcile trigger=witness outcome=repaired from=personal1 to=business`(它只是**承认**了外部切号,不是自己切的) |

### 2.1 今天再探 personal1(2026-09-09 03:32Z,只读 GET)

| 端点 | HTTP | 关键字段 |
|---|---|---|
| `GET /api/oauth/usage` | **403** | `error.type=permission_error`,`error.details.error_code=oauth_not_allowed_for_organization`,message「OAuth authentication is currently not allowed for this organization.」 |
| `GET /api/oauth/profile` | **200** | `organization.subscription_status="canceled"`,`organization_type="claude_free"`,`billing_type="none"`,`has_claude_max=false` |

对照健康号 business:usage 200(`five_hour.utilization=91`),profile `subscription_status="active"`、`organization_type="claude_max"`。

**结论**:死号有两个可机读的终态信号——usage 端点的 403 `permission_error`,以及 profile 端点里的订阅状态。两者都是只读 GET,不触发 token refresh,不违反「永不 probe-refresh 活跃号」红线(`freshness.ts:13-23`)。

事故当晚 monitor 记的是 `backoff`(即 429 rate_limited)而不是 `error`(403→network),说明**订阅刚取消的头几小时 API 可能回 429**,今天才稳定回 403。设计不能只认 403,必须把「活跃号连续读不到用量」也当成升级探活的触发。

## 3. 三处根因的代码事实

### 3.1 quota monitor 没有「号死了」这个分类

`packages/teamlead/src/account-heal/quota-usage-api.ts:160-167`:

```ts
if (response.status === 401) return { error: "unauthorized" };
if (response.status === 429) return { error: "rate_limited", retryAfterMs };
if (!response.ok) return { error: "network" };   // 403 和 5xx 一起塌进这里
```

`packages/teamlead/src/account-heal/quota-monitor.ts:1494-1527` 对活跃号读用量失败的处理:

| 错误类 | 处理 | 会切号吗 |
|---|---|---|
| `rate_limited` | `backoffUntilMs = now + retryAfter(1~30min)`,outcome `backoff` | 否 |
| `unauthorized` | `quota_read_blind` warning 告警,outcome `blind` | 否 |
| `network` / `malformed` | `errorStreak++`,≥6 次发 `quota_monitor_down` severe 告警 | 否 |

切号只由 `triggerScope()`(5h ≥ trigger5hPct 或 7d ≥ 100)或 pane 里的 model-cap 检测触发(`:1560-1700`)。这些都要**先成功读到用量**。号死了永远读不到,于是永远不切。

而且 `backoff` 分支在 `nextUsageDueAt` 之前直接返回(`:1414-1421`、`:1476-1479`),Bridge 用 SIGUSR1 唤醒 daemon(`quota-daemon-wake.ts`)也只是提前进入 tick,tick 看到 backoff 未到期照样什么都不做。

### 3.2 账号池没有「不可用」持久状态

`account-store.ts:37-65` `AccountEntry` 里能让号退出候选的只有 `authExpired / refreshTokenInvalid / profileVerifyFailed / identityMismatch`(`isAuthUnusable`,`:159-166`)。其中 `refreshTokenInvalid` 和 `profileVerifyFailed` **有类型、进了资格判断、但生产里没有任何写入方**。

候选校验 `account-candidate-selector.ts:253-260` 对读用量失败的候选只给 `status: usage_<error>, excludedBy: "unverifiable"`——一个每次 sweep 都会重新探一遍的软桶,不落盘、不告警。所以死号会被反复轮到。

自动清标记只有一条路:**成功切到该号**时 `freshenVerifiedAccount` 删标记(`switch-executor.ts:360-393`)。死号永远切不过去,所以一旦标死必须给显式的解除入口,否则是单向门。

### 3.3 review job 的 403 是终态,切号后没人重入队

`packages/teamlead/src/bridge/review-quota-retry.ts:4`:

```ts
const API_RATE_LIMIT_RE = /"api_error_status"\s*:\s*429(?:\D|$)/;
```

`review-request-coordinator.ts:1712` 只有 parser 返回 reset 时刻才写 `retry_at`;403 在第一行就返回 null。之后:

* `listScheduledCodexReviewJobs()` 只在 `redriveOnBoot()` 被调一次(`:1125`),且只看 `retry_at IS NOT NULL`;
* 没有任何定时扫描会再读 `codex_review_job`;
* 切号事件不进 Bridge:daemon 切号写的是 keychain、`claude-profiles/.active`、`claude-accounts.json`(generation++)、`pendingSwitchNotifications` 出箱、`account_switch_reconcile` 日志行和 Discord 消息——**没有一条通到 Bridge 的回调**。

唯一恢复路径是 runner 同 request-id 重 POST `/review-requests`:`accept()` 对 `failed` 行在 gate 仍 open 时 `enqueue`(`:710-745`),返回 `duplicate: true`。这就是 9-8 Lead 手工令 7 个实现体重跑的原理。

reviewer 子进程的凭据来自 `claude` CLI 自己读主机 keychain(`claude-review-runner.ts:466-486`,`CLAUDE_CONFIG_DIR` 保留),**切号后下一次 spawn 即生效,不用重启 Bridge**——所以问题只在「谁来触发重入队」。

### 3.4 活体不唤醒

**8-29 配方到底是什么**(eng-lead agent memory `reference_account_switch_does_not_wake_live_runners.md`、`reference_disabled_claude_account_403_blast_radius.md`):`flywheel-comm send --to <完整 execution-id>` 一条 **mailbox 指令**,不是 tmux 敲键。原理:切号只换 keychain;活着的 Claude 进程**下一个 turn** 才重读 keychain;Claude Code 内置 inbox poller,mailbox 一有新行它就开新 turn(`ClaudeCodeAdapter.ts:253-256` `createReceiver()` 返回 null 就是这个原因)。8-27 实测 5 个体 60s 全部复工;正确时机是「切号成功那一刻」,不是等谁撞墙。已有追踪单 FLY-2109,被 FLY-2229 明确推迟。

**今天为什么没人推**:

* daemon 侧的 `quota-revive-scan.ts` 确实会在 `reviveEpoch` 打开时给 pane 敲 `continue`,但 `classifyQuotaPane()`(`:44`)要求同时命中「Claude usage limit reached」文本 + 空输入框 + 100% 仪表,403 pane 一条都不命中;而且 witness reconcile 路径(founder 手动 `/login`)在 `quota-monitor.ts:1383-1394` 直接 `state.reviveEpoch = null`,**从不打开** revive epoch——只有 daemon 自己 `switchAccount` 成功才开(`:1917`)。
* Bridge 侧的 `runner-auth-scan.ts` 每个 session 抓最近 20 行 pane 文本喂 `classifyDetection`,但 `PATTERN_TABLE` 只有 login_expired / usage_limit / rate_limit / permission_blocked 四类,「disabled Claude subscription access」一个都不命中;9-8 窗口 Bridge 日志零告警印证了这一点。
* `rescue.ts:433 postSwitchRescueSweep()` 是写好的「切号后扫 pending login_expired 并救活」钩子,`rescue-runtime.ts:375-386` 只导出 `rescueLead/rescueRunner`,生产没有调用方。
* daemon 只认识 pane id,不认识 execution id(`QuotaPaneRef` 没有 execution 字段);而 mailbox send 的键是 execution id。Bridge 才同时拥有「session ↔ vendor ↔ tmux_window」三元关系(CommDB `sessions.tmux_window` 是权威,`tmux-lookup.ts:8`)。

另一个要顺手改的错话:`account-switch-repair.ts:222-226` 的成功文案说「当前 session 等 reset 或需 founder 重启自愈」,与实测相反。

## 4. 设计目标与边界

### 4.1 要做到

1. **识别**:活跃号出现终态信号(usage 403 permission_error,或 profile 订阅状态非 active)→ 分类 `account_dead`,同一个 poll 内切号。
2. **不回头**:死号在账号池落 `unavailable` 持久标记;两条候选路径(纯选择器 + 实时校验)都排除它;monitor 的候选 sweep 不再探它;给显式解除命令。
3. **升级探活**:活跃号连续 N 次读不到用量(backoff/error/blind 混算)→ 不再等 retry-after,直接跑只读探活;探活给出死号结论就切。
4. **review job 自愈**:403/auth 终态类失败落 `retry_after_account_switch` 标记;Bridge 观察到账号 generation 前进后,对仍 gate open 的这类行同 request-id 重入队。
5. **活体复工**:切号成功后,把本轮 403 过的 Claude 体各推一条 mailbox 复工 send(8-29 配方),并留审计行。
6. **告警可区分**:切号原因带 `account_dead:<profile>`,进 `#flywheel-engineer`(eng-lead 的 alertChannel `1516209714097291335`),与 usage-limit 切号(`#flywheel-notify`)分开。
7. **台架**:复用 FLY-2271 mock server(加 per-profile 状态旋钮)做「活跃号变 403」演练;复用 FLY-1182 fake quota guard 做候选排除演练。

### 4.2 不做

* 不改 founder-only 边界(merge / ship / restart),不重启 Bridge 或 daemon 作为修复手段。
* 不让 daemon 调 `claude -p` 做探活(见 §5 取舍)。
* 不把 401(token 过期)当死号——那是 refresh 路径的事,仍走 blind。
* 不引入新的常驻进程或新 env;新旋钮走 `quota-monitor.json` 可缺省字段。
* 不改 `/review-requests` HTTP 合同、不改 runner 合同。

## 5. 关键取舍

### 5.1 探活用什么

| 方案 | 成本 / 副作用 | 结论 |
|---|---|---|
| `claude -p "ok"`(issue 原文提议) | 消耗 token;CLI 可能顺手 refresh 活跃号 token 写 keychain;FLY-2271 演练明确断言 daemon 从不调 `claude`(`qa-fly-2271:141-145,381`);需要 30s 级超时管理 | **不采用**,作为被拒方案记录 |
| `GET /api/oauth/usage` 403 body + `GET /api/oauth/profile` 订阅字段 | 两个只读 GET,10s 超时,已有 fetch 函数,不动 token | **采用**。usage 403 permission_error 是直接证据;profile `subscription_status`/`organization_type` 是确认证据,二者任一命中即 `account_dead` |

### 5.2 死号标记放哪

放 `AccountEntry` 新增可选字段 `unavailable: { reason, markedAt, evidence }`,并入 `isAuthUnusable()`,这样 `selectNextAccount` 和 `verifyAndRankCandidates` 一处改动同时生效;`readStoreStrict` 加字段校验。不用 monitor state 承载资格(monitor state 在 generation 前进时会被整体重置,`quota-monitor-state.ts:1006-1070`)。

### 5.3 review job 用什么标记「等切号」

`retry_at` 被 `recordCodexReviewJobFailure` 严格校验为 ISO 时间(`StateStore.ts:13413-13419`),塞哨兵值会污染 FLY-2177 的定时语义。选择新增列 `retry_trigger TEXT NULL`(`'reset_at' | 'account_switch'`),沿用现有 additive `ALTER TABLE` 循环(`:5123-5148`)。

### 5.4 Bridge 怎么知道切号了

三个候选:daemon 调新 Bridge 端点(新增 token/路由,跨进程契约);Bridge 订阅 Discord 消息(荒谬);Bridge 轮询 `claude-accounts.json` 的 `generation`(`capacity-snapshot.ts:291-317` 已经这么读)。选第三个:一个 60s 的 generation watcher,前进即触发 `rearmAfterAccountSwitch()`。切号和重入队之间最多晚 60s,远小于 poll 周期。

### 5.5 谁来推活体,推谁

| 方案 | 说明 | 结论 |
|---|---|---|
| daemon revive scan 加 `account_disabled` pane 类,敲 `continue` | 复用现有 3 次上限 / fleet 覆盖;但 witness 路径要改成开 epoch,且 epoch 到期时间绑 `resetAt`(死号没有 reset);敲键是「假装是人在打字」,与 8-29 实证配方不同 | 不采用 |
| Bridge 侧 mailbox `send`,键 = execution id | 与 8-29 配方逐字一致(3/3、5/5 实证);Bridge 已知 vendor(只发 claude-code)、status(只发 running);同一个 generation watcher 同时驱动 review 重入队;每次 send 落 `session_events` 审计行 | **采用** |

推谁:issue 要求「本轮 403 过的体」。Bridge 的 `runner-auth-scan` 已每 tick 抓每个 session 的 pane 尾部,加一个 `account_disabled` 检测类,命中即写 `session_events` 一行(execution_id + 证据摘要 + 观察时刻)。切号后的 sweep 目标 = 「自死号首次被观察以来有该事件、vendor=claude-code、status=running」的 session;**不**对全部 running 体广播,避免打断正在干活的体。runner-auth-scan 命中还兼作 fix 1 的见证提示(见 §5.6)。

### 5.6 见证提示:让 daemon 不等下一个 poll

acceptance 要求「reviewer 首个 403 到切号完成 ≤ 1 个 poll 周期」。事故当晚 usage API 回的是 429,daemon 光靠自己的 poll 可能要到第二个周期才升级探活。Bridge 已有 `wakeQuotaDaemon()`(SIGUSR1,60s 节流),但 tick 在 backoff 未到期时什么都不做。所以要加一个**见证文件**:Bridge 在 review job 403 / pane 403 命中时写 `~/.flywheel/quota-monitor-witness.json`(`{kind:"account_disabled", observedAt, source, evidenceDigest}`,0600,原子写)再 SIGUSR1;daemon tick 开头读到未消费的见证 → 跳过 `nextUsageDueAt`/`backoff` 门 → 立刻跑只读探活 → 探活证实死号才切,证伪则记 `witness_rejected` 并消费掉。见证只是「请你现在看一眼」,不是切号授权;切号仍以 daemon 自己的探活为准。

## 6. 待 Lead 裁定 / 已提非阻塞问题

* Q1:是否接受「探活不用 `claude -p`,改用 usage/profile 只读 GET」——理由见 §5.1。已通过 `flywheel-comm ask` 非阻塞提出;若无回复按本文方案推进。

## 7. 下一步

research.md:把 §3 的每处缝钉到行号级、列出全部消费者与测试,给出 mock server 旋钮改法与回滚边界;然后 plan.md 分切片。
