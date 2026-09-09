# FLY-2452 死号切号 — 调研
Issue: FLY-2452 (https://linear.app/geoforge3d/issue/FLY-2452/账号切号-claude-号被-disable订阅到期时切号器不切quota-poll-只当-backoffreviewer-job)
日期: 2026-09-09
基于: exploration.md

## 0. Lead 裁定(2026-09-09,非阻塞问题 76c15f4e)

探活用两个只读端点(usage 403 `permission_error` / profile `subscription_status`);任一命中即 `account_dead`:立刻切、把该 profile 拉黑直到人工解除、告警带 `account_dead:<profile>`;探活本身不得 refresh token;`claude -p` 记为被拒方案。

## 1. 端点合同(2026-09-09 03:32Z 实测)

### 1.1 `GET /api/oauth/usage`(`quota-usage-api.ts:143-190`)

| 号 | HTTP | body |
|---|---|---|
| 死号 personal1 | 403 | `{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_visibility":"user_facing","error_code":"oauth_not_allowed_for_organization"}}}` |
| 健康号 business | 200 | `five_hour.utilization=91`,`resets_at=…` |

当前代码 `:160-167` 把 403 塌成 `error:"network"`。新增分支:`status===403` 且 body 通过校验(`type==="error"`、`error.type` 为 ≤64 字节小写标识、`error.details.error_code` 同样受限、其余字段丢弃)→ `{error:"forbidden", errorCode}`;body 不可解析 → `{error:"forbidden", errorCode:null}`。**不**把 message 文本带出函数(注释「never returning credential or response details」)。

### 1.2 `GET /api/oauth/profile`(`account-identity.ts:52-85`)

死号 200:`organization.subscription_status="canceled"`,`organization_type="claude_free"`,`billing_type="none"`,`account.has_claude_max=false`。健康号:`subscription_status="active"`,`organization_type="claude_max"`。

`parseProfile()`(`:40-50`)只保留 `account.email/uuid`。新增可选返回字段 `subscription: { status, organizationType } | undefined`(两者都是 ≤32 字节 `[a-z_]+` 字符串才收,否则 undefined),`ProfileIdentity` 消费者(`compareAccountIdentity`、`identityDigest`、`resolvePoolProfileIdentity`)不读它,保持不变。

### 1.3 死号判据(纯函数 `classifyAccountLiveness`,新文件 `account-liveness.ts`)

真值表(常量,单测逐行钉住;Codex R1 #8 要求把 `past_due` 从「按 Stripe 惯例当 alive」改为 fail-closed):

| usage | profile.subscription.status | organizationType | verdict | reason |
|---|---|---|---|---|
| `forbidden` + code `oauth_not_allowed_for_organization` | 任意 / 读不到 | 任意 | **dead** | `usage_forbidden:oauth_not_allowed_for_organization` |
| `forbidden` + 未知 code | `canceled` | 任意 | **dead** | `profile_canceled` |
| `forbidden` + 未知 code | 其它 / 读不到 | 任意 | unknown | `forbidden_unconfirmed` |
| `rate_limited`/`network`/`unauthorized`(streak 或见证触发) | `canceled` | 任意 | **dead** | `profile_canceled` |
| 任意非 ok | `active` / `trialing` | 非 `claude_free` | alive | — |
| 任意非 ok | `active` / `trialing` | `claude_free` | unknown | `free_org_unconfirmed`(只记日志) |
| 任意非 ok | `past_due` / `unpaid` / `incomplete` / 未知值 / 缺失 | 任意 | unknown | `profile_<status or missing>` |
| ok(200) | 任意 | 任意 | alive | — |

`unknown` 永远不切号(fail-closed),但写进 `quota_poll` 日志行的 `liveness` 字段供事后改表;只有 `dead` 才切。`past_due` 等状态没有 Anthropic 实测证据,不借用 Stripe 语义,先 `unknown` 并观测。

## 2. quota monitor 缝口

### 2.1 poll 主路径 `quota-monitor.ts:1494-1527`

现有分支顺序:`rate_limited→backoff`、`unauthorized→blind`、其它→`errorStreak`。改法:

1. 在 `fetchUsage` 失败后统一进入 `probeActiveLiveness()`:
   * `forbidden` → 立刻探 profile(只读 GET,不动 token)→ `classifyAccountLiveness`;
   * `rate_limited`/`network`/`unauthorized` → `state.activeUnreadableStreak += 1`;`>= config.deadProbeStreak`(默认 2)时同样跑 profile 探活;否则维持原分支。
2. 探活结果 `dead` → `handleAccountDead()`(§2.3);`alive/unknown` → 原分支不变,并把结果写进 `quota_poll` 日志行(`liveness` 字段)。
3. 成功读到用量时 `activeUnreadableStreak = 0`(`commitSuccessfulObservation`,`:294-305`)。

`backoff` 提前返回(`:1476-1479`)与 `nextUsageDueAt` 门(`:1414-1421`)前面插入见证消费(§2.5):有未消费见证时跳过这两个门。

### 2.2 monitor state(`quota-monitor-state.ts`)

新增 v2 字段(**必须**同时加进 `V2_STATE_KEYS` `:203` 和 `emptyQuotaMonitorState()` `:329`,否则 `parseState` 拒收整份 state):

| 字段 | 类型 | 语义 |
|---|---|---|
| `activeUnreadableStreak` | number | 连续读不到活跃号用量的次数 |
| `deadAccountEpisode` | `{profile, reason, detectedAt, generation, switchOutcome, alertCount, lastAlertAt} \| null` | 死号事件账,复用 `PendingSwitchFailure` 形状 |
| `witnessCursor` | `{consumedAt, digest} \| null` | 最后消费的见证 |

`loadQuotaMonitorState` 在 generation 前进时会清 `reviveEpoch/blockedEpisode/pendingSwitchFailure/...`(`:1006-1070`);`deadAccountEpisode` **不**在清单里(它跨 generation 存活,用于去重告警),`witnessCursor` 也不清。

### 2.3 `handleAccountDead()`:标记 + 切号 + 告警

顺序(事务边界按 Codex R1 #5 收口:标记随 `SwitchInput.markUnavailable` 进 executor,在它现有的账号锁内合入 `working` store;成功切号与 `no_account` 都把标记写盘,apply 失败不写):

1. 构造 `markUnavailable: {name, mark:{reason, markedAt, evidence, markedBy:"quota-monitor"}}`(纯函数 `markAccountUnavailable` 幂等)。
2. 候选:`verifyAndRankCandidates(deps, snapshot, [])`(`account-candidate-selector.ts:155`),它已排除 `isAuthUnusable`(§3.1 让 `unavailable` 进入该判断)。
3. `switchAccount({trigger:{kind:"account_dead", profile, reason}, quotaPreverified:true, …})`。
4. 无候选 → `openBlockedEpisode`(现有,`quota_no_target` severe),body 前缀 `account_dead:<profile>`。
5. 切成功 → `reviveEpoch = null`(死号 pane 不由 daemon 敲键,见 §5),`deadAccountEpisode.switchOutcome="switched"`,`lastSwitchAt = now`。
6. 切失败 → `openSwitchFailureEpisode`(现有)。

**cooldown 豁免**:`minSwitchIntervalMinutes`(`:1615-1620`)对 `account_dead` 不适用——死号不是抖动;防抖改为只对**已成功切号**去重(`deadAccountEpisode.switchedGeneration`);`no_account` / 暂态 apply 失败每个 tick 重新选号,告警去重交给现有 `blockedEpisode` / `pendingSwitchFailure`(Codex R1 #6)。

### 2.4 `SwitchTrigger` 与 commitSwitch(`switch-executor.ts:75-82`, `:559-640`)

新增 `{ kind: "account_dead"; profile: string; reason: string }`。`commitSwitch` 对该 kind:被切走的号**不写** `quotaExhaustedUntil/switchCooldownUntil`(它们是时间性的,死号是终态),只保证 `unavailable` 已在;`SwitchNotificationTrigger` 加同名 arm,`triggerLabel()`(`account-switch-notification.ts:142-151`)输出 `account_dead:<profile>`;`SwitchInput.trigger` 的 `normalizedTrigger` 不变。

`account-switch-repair.ts:212-216`(AutoRepairBot 的 `repair` trigger)不动;顺手改 `:222-226` 的错误文案(见 exploration §3.4)。

新增 store 顶层可选字段 `lastSwitch: { generation, triggerKind, from, to, at }`,`commitSwitch` 每次写;`readStoreStrict` 对顶层未知键本来就宽容(`:590-619` 只校验列出的字段并 `{...parsed}`),新字段仍加类型校验。Bridge 靠它区分「为何切」(§4.3)。

### 2.5 见证文件 `~/.flywheel/quota-monitor-witness.json`

写方 Bridge(`quota-daemon-wake.ts` 新增 `writeQuotaWitness()`),读方 daemon。

* 形状:`{version:1, kind:"account_disabled", observedAt, source:"review_job"|"runner_pane", executionId?, evidenceDigest}`;0600、同目录 temp+fsync+rename;单文件覆盖写(最新一次即可)。
* daemon 每 tick 开头(`pollOnce` 进入处)读:校验 owner uid / 非 symlink / `version===1` / `observedAt` 在 `[now-6h, now+5min]` / `digest !== witnessCursor.digest`;通过则本 tick 视为 `witnessDue`,跳过 backoff/nextUsageDueAt 门直接探活;处理完写 `witnessCursor`。不通过一律忽略并记 `witness_rejected:<why>`。
* 见证只触发「看一眼」,切号决定仍来自 §2.1 的探活;所以伪造见证最坏结果是多做一次只读 GET。
* Bridge 写完见证再调现有 `wakeQuotaDaemon()`(SIGUSR1,60s 节流);节流住也没关系,下个 tick 会读到。

### 2.6 候选 sweep 与 `refreshNewActive`

`sweepCandidates`(`:349-395`)对每个候选 `readCandidateCredential(refresh=true)` 会做 freshness probe(refresh grant)。加一行:`entry.unavailable !== undefined → continue`,保证死号**不再被探**(也就不再消耗它的 refresh 家族)。

## 3. 账号池

### 3.1 `AccountEntry.unavailable`(`account-store.ts:37-65`)

```ts
unavailable?: { reason: string; markedAt: string; evidence: string; markedBy: "quota-monitor" | "operator" };
```

* `isAuthUnusable()`(`:159-166`)加 `|| a.unavailable !== undefined` → `selectNextAccount`(`:386-467`)与 `verifyAndRankCandidates`(`:199-202`,status 改为 `unavailable:<reason>`,excludedBy `"auth"`)同时生效;通知里的 `skipped=` 行自动出现。
* `readStoreStrict`(`:590-619`)加字段类型校验(四个字段都是 ≤200 字节字符串,`markedBy` 枚举)。
* `freshenVerifiedAccount`(`switch-executor.ts:360-393`)与 `syncFreshenedActiveAccountInStore`(`account-store.ts:698-741`)**不**自动删 `unavailable`——Lead 裁定「直到人工解除」。
* `quota-pool-rebuild.ts:1035-1050` 重建池时保留 `unavailable`(它重写 `authExpired/...=false`,新字段用 `...entry` 带过去)。

### 3.2 解除入口

`flywheel-claude-quota-guard`(`quota-guard-cli.ts`,已有 `identity-audit`、`active-sync-strict` 等子命令,flag 风格 `--name`)新增 `unavailable-clear --name <profile> [--reason <text>]`:锁内读 strict store、删字段、generation 不变、审计行进 `claude-profile-audit.log`(`cmd:"unavailable-clear"`)。同时新增 `unavailable-list` 只读。不加自动解除。

### 3.3 `capacity-snapshot.ts:291-317`

它用 `readStoreStrict` 读池并算 `claudeUnavailable`;`unavailable` 的号要计入「不可用」而不是「可用池」,补一行过滤 + 一条 `structural: account_unavailable:<name>` 说明。

## 4. Bridge 侧

### 4.1 review job 分类(`review-quota-retry.ts` + `review-request-coordinator.ts:1706-1745`)

新纯函数 `classifyReviewFailure(raw, nowMs)`:

```
{ kind:"quota_reset", resetAt }      ← 现有 parseReviewQuotaResetAt 不变
{ kind:"account_switch" }            ← ACCOUNT_DEAD_RE:`"api_error_status":403` 且 `"result"` 内含
                                        "disabled Claude subscription access" | "oauth_not_allowed_for_organization"
                                        | "subscription access for Claude Code"(≤4000 字节尾窗,大小写不敏感)
null                                 ← 其它
```

coordinator 在 `failReviewerOutcome` 中:`account_switch` → `recordCodexReviewJobFailure(..., {retryTrigger:"account_switch", parkedAtMs: this.now()})`,**不写 `retry_at`、不消耗 `auto_retry_count`**(切号不是有限次重试,预算留给 reset 路径);仍 emit `review_job_failed`,recovery 文案改为 `automatic same-request retry is armed for the next Claude account switch; the gate remains closed.`。

### 4.2 StateStore

* `codex_review_job` 加列 `retry_trigger TEXT`(值 `'reset_at' | 'account_switch' | NULL`)与 `retry_parked_at_ms INTEGER`(停靠时刻,coordinator 时钟毫秒;`updated_at` 是 SQLite `datetime('now')` 秒级无时区文本,不能与 ISO 毫秒串比较——Codex R2 #2),additive ALTER 循环 `StateStore.ts:5123-5148`;现有 reset 路径写 `'reset_at'`,`claimCodexReviewJobRunning`(`:13341`)清空两列(与 `retry_at` 同一条 UPDATE)。
* 新查询 `listAccountSwitchParkedCodexReviewJobs({beforeMs, limit, after?})`:`status='failed' AND retry_trigger='account_switch' AND retry_parked_at_ms < ?`,复合 keyset 游标 `(retry_parked_at_ms > ? OR (retry_parked_at_ms = ? AND request_id > ?))`,`ORDER BY retry_parked_at_ms, request_id`,无回看窗口。
* 新表 `account_switch_action_receipt(switch_generation INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('review_redrive','wake_sweep')), status TEXT NOT NULL CHECK(status IN ('pending','completed')), switch_json TEXT NOT NULL, started_at_ms INTEGER NOT NULL, completed_at_ms INTEGER, outcome_json TEXT, PRIMARY KEY(switch_generation, action))`——每个切号事件的两项动作各自回执;`begin` 时存校验后的切号快照 `switch_json`(generation / triggerKind / from / to / atMs),`already_pending` 返回已存快照;只有动作完成后才 `completed`,崩溃后 `pending` 的按快照重放(Codex R1 #3 / R2 #3)。以 plan §5 C4 为权威。按 retention registry 规则,新表要在 registry group + fixture + hard counts 三处登记(见 runner memory)。

### 4.3 generation watcher(`gate-poller.ts` 新 hook `onAccountSwitchTick`)

FLY-169「不新增 timer」:挂在 GatePoller 现有 tick 上,内部 60s 门(与 `onFlagScanTick` 的 `scanIfDue` 同形)。每次到期:

1. `readStoreStrict(defaultStorePath())`;null → 记 warn 返回;`lastSwitch` 缺失或校验失败 → 返回(旧 store / 非切号的 generation 变化都不触发,Codex R1 #4)。
2. 事件键 = `lastSwitch.generation`;校验 `lastSwitch` 后两项动作各 `beginAccountSwitchAction(gen, action, snapshot)`,`already_completed` 则跳过,`already_pending` 用返回的已存快照。
3. (回执见 §4.2)
4. **review 重入队**(任何 trigger kind,完成后 `completeAccountSwitchAction`;kill switch off 则保持 pending):对 `listAccountSwitchParkedCodexReviewJobs({beforeMs: 快照.atMs})` **分页扫全部**停靠行(无回看窗口,Codex R2 #5)逐行调用现有 `handleScheduledRetry` 的守卫链(kill switch → gate `inspectGate` → head 重验 → `enqueue`);gate 非 open 走现有 `failReviewJob(runtimeGateFailureReason)`。复用而不是复制:把 `handleScheduledRetry` 的守卫部分抽成 `retryIfStillEligible(requestId, origin)`。
5. **活体复工**(仅当回执快照 `triggerKind === "account_dead"`;`witness`/`manual`/`quota` 一律 skipped,`from` 号是否 `unavailable` 不参与判断——Codex R2 #6):§4.4。
6. 把 actions 摘要写回 `actions_json`。

Bridge 启动时 `redriveOnBoot()` 之后跑一次同样的 tick,补上停机期间的切号。

### 4.4 复工 sweep

目标集 = StateStore `sessions` 中 `status='running'` 且 `parseSqliteUtcMs(started_at) < snapshot.atMs`(解析失败或相等 → 不发)的 session,再按 CommDB `sessions.vendor === 'claude-code'` 过滤(生产 Claude adapter 登记的字面值是 `"claude-code"`,`packages/claude-runner/src/TmuxAdapter.ts:362-368`;StateStore 的 `sessions` 表没有 vendor 列,其 workflow 层的 `"claude" | "codex"` 是另一套词汇,不能混用;`codex` / `none` / NULL 都不发)。**为什么是全部而不是「403 过的」**:死号下每个活着的 Claude 体下一次 API 调用都会 403,「已经 403 过」只是「还没轮到」的子集;而 usage-limit 切号不进这个 sweep(FLY-2109 范围),所以不会有「无关的体被打扰」。

每个目标:`CommDB.insertInstruction("bridge", executionId, text, {dedupeId: "account-switch-wake:g<gen>:<execId>"})`(`db.ts:4012-4053` 的确定性去重,崩溃重放落同一主键)+ `clearDeclaredState`;文案固定常量:

> 【账号切换】Claude 凭据已从 `<from>` 切到 `<to>`(原因 account_dead)。若你上一轮因 403 / 凭据故障中断,请按开局指令重跑那一轮;若你正常在跑,忽略本条继续。

审计:`store.insertEvent({event_id:"account-switch-wake:g<gen>:<execId>", event_type:"account_switch_wake", severity:"info", payload:{generation, from, to}})`(`StateStore.ts:7884`),event_id 唯一保证同 generation 不重发。任何副作用抛错(CommDB 打不开、`insertInstruction`、`clearDeclaredState`、`insertEvent`)都让 `wake_sweep` 回执保持 `pending`,下个 tick / boot 重放(每步幂等);只有永久排除(vendor、started_at、非 running、flag off)计入 outcome(Codex R2 #4)。

验证手段(acceptance ②):QA 台架复捕 pane,要求 `👤<新 email>` 身份行翻转 + 出现活动行——Lead memory 里的反模式「不许只报我发了 send」。

### 4.5 `runner-auth-scan.ts` 加 `account_disabled` 类

`detection-classifier.ts:64-84` `PATTERN_TABLE` 加 `{category:"account_disabled", tokens:[/disabled claude subscription access/i, /oauth_not_allowed_for_organization/i]}`;`DetectionCategory` 加同名。`makeRunnerAuthScan`(`runner-auth-scan.ts:82-160`)命中 → `writeQuotaWitness({source:"runner_pane", executionId})` + `wakeQuotaDaemon()`,**不**发新的 Bridge 告警 kind(Codex R1 #1:每个新 kind 要贯通 8 处合同,人可见的告警由 daemon 的 `account_dead` 承担)。该扫描每 60 分钟一轮(`DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS`,`runner-quota-scan.ts:28`),所以它是慢路径;快路径是 §4.1 review job 的 403(秒级)。

同样在 `failReviewerOutcome` 的 `account_switch` 分支写见证 + wake:这是 9-8 时间线里最早的信号(21:49)。

## 5. daemon revive scan 不改

`quota-revive-scan.ts` 的 `classifyQuotaPane`/`reviveEpoch` 保持只服务 usage-limit;`account_dead` 切号后 `reviveEpoch=null`。理由:敲键 `continue` 与 8-29 配方不同、epoch 到期时间绑 `resetAt`、且 daemon 没有 execution id。FLY-2109(usage-limit 后活体复工)另行处理,可直接复用 §4.4 的 sweep 只需放开 trigger 过滤。

## 6. 告警路由

| 事件 | kind | 路由 |
|---|---|---|
| 切号通知(现有) | `account_switched` | `#flywheel-notify`(`quota-monitor-alert.ts:54-59`),body 首行 `Claude 已切号:from → to(account_dead:<profile>)` |
| 死号被拉黑 | 新 `account_dead`:manual-ticket 姿态,逐处镜像 `quota_no_target`(allowlist、`ALERT_EVENT_TYPES`、`kind-contract`、`alert-kind-copy`、`infra-event-router` actionable 列表、`AlertChannelHub` manual-ticket 集、daemon `ROUTING`;不进 informational、不进 ticket-owner-map);成功切号时 intent 与切号结果同写出箱(kind 联合扩展),drain 投递 | `lead-alert.sh --lead quota-monitor`(unified 模式)+ 每次调用注入 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=1516209714097291335`(eng-lead alertChannel = `#flywheel-engineer`,由 `loadProjects()` 解析),`severe`,mention founder;eventId/signature `account-dead-g<generation>`;transient 行带 `deliveryChannelId` |
| Bridge 复工 sweep 摘要 | 复用 `review_job_failed` 的 Lead-inbox 通道?否——用 log + `session_events`,不加新 Discord 噪音 |

`quota-monitor-alert.ts` 的 `sendQuotaMonitorAlert` 固定 `--lead quota-monitor` 且以 unified 模式运行(shell 在 unified 模式才渲染 🎫 header,`lead-alert.sh:609-615`)。`account_dead` 不改 `--lead`、不剥 env,而是像 `notify` 那样每次调用注入 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=<eng-lead alertChannel>`(daemon 用 `ProjectConfig.loadProjects()` 解析);同时 shell 新增独立谓词 `carries_delivery_channel`(现有三个 switch kind + `account_dead`)只用于 `write_record` 的 `deliveryChannelId` 分支,transient 队列行才带 `deliveryChannelId`,Bridge drain 重放不回退到 unified 频道(Codex R3 #3);`is_quota_switch_kind` 同时是 `--plain-message` 的授权白名单(`lead-alert.sh:217-223`),**不**加 `account_dead`,否则 plain 分支会跳过 🎫 header(Codex R4 #1)。

## 7. 台架(acceptance ①②③)

### 7.1 FLY-2271 mock server(`qa-fly-2271-switch-evidence-e2e.sh:148-196`)

加 per-profile 覆盖文件 `$ROOT/usage-override.json`(server 每请求重读):`{"personal": {"status":403, "body":{...permission_error...}}, "profile_personal": {"subscription_status":"canceled","organization_type":"claude_free"}}`。新场景 `dead-account`:

1. 起 daemon,activeAccount=personal,basePollMinutes=1;首个 poll 正常。
2. 写 override 让 personal 的 usage 变 403;同时用假 review job 403 触发 Bridge 见证写入(或直接手写见证文件 + SIGUSR1)。
3. 断言:下一条 `quota_poll` 日志 `liveness=dead`,随后 `quota_switch_decision trigger={kind:"account_dead",profile:"personal"}`、`.active==school`、store `personal.unavailable.reason==usage_forbidden:oauth_not_allowed_for_organization`、`lastSwitch.triggerKind=="account_dead"`;告警日志里有 `account_dead:personal`;整个过程 `claude.log` 为空(daemon 未调 claude)。
4. 再跑 60 分钟等价的 sweep(把 override 撤掉也不行:personal 仍 unavailable → 候选 panorama 里 `unavailable:*`)。

### 7.2 FLY-1182 drill(`qa-fly-1182-isolated-switch-drill.sh`)

加 S8:store 里把 bravo 标 `unavailable`,`flywheel-claude-profile use bravo` 必须被候选校验拒绝(exit 非 0,keychain 未动);S9:`quota-guard unavailable-clear --name bravo` 后同命令通过。

### 7.3 Bridge 单测

* `review-quota-retry.test.ts`:403 fixture(取自 `codex_review_job.failure_raw` 原文)→ `account_switch`;429 fixture 不变;403 + 无关文本 → null。
* coordinator 测试:403 失败 → `retry_trigger='account_switch'`、`retry_at NULL`、`auto_retry_count 0`;`redriveAfterAccountSwitch` → 同 requestId 重入队;gate expired → `gate_expired` 终态;二次调用 0 动作(行已 claim);回执 `pending` 的在 Bridge 重启后重放且幂等。
* sweep 测试:两个 running claude-code + 一个 codex + 一个 parked → 只有前两个收到指令;同 generation 第二次不发;`triggerKind` 为 quota 时不发。

## 8. 回滚边界

* daemon 改动全部在 `packages/teamlead/src/account-heal/`,由 launchd `com.flywheel.quota-monitor` 承载;回滚 = revert + `scripts/lib/restart-quota-monitor.sh`(独立 updater 窗口,本节点不重启)。
* Bridge 改动只加列/加表/加 hook,不改 HTTP 合同;kill switch:复用 `review_quota_auto_retry` 管 review 重入队;新增 store-managed flag `account_switch_wake_sweep`(默认 on)管复工 sweep,按 flag authoring runbook 登记。
* `unavailable` 字段是可选的:旧版 daemon/Bridge 读到它会原样带过(`...entry`),只是不排除该号——退化为今天的行为,不会更糟。
* 见证文件被旧 daemon 忽略(它不读)。

## 9. 未决 / 假设

* A1:profile 端点 `subscription_status` 的取值集合只见过 `active`/`canceled`;其余值一律 `unknown`(见 §1.3 真值表),不借 Stripe 语义。
* A2(已落定):StateStore `sessions` 无 vendor 列;vendor 从 CommDB 读,字面值 `claude-code`。
* A3:Bridge 写 `~/.flywheel/quota-monitor-witness.json` 与 daemon 同 uid,无跨用户问题;529 房里各自的 `FLYWHEEL_QUOTA_*` 前缀 env 要加 `FLYWHEEL_QUOTA_WITNESS_PATH`——这与 exploration「零新 env」有冲突,取舍:用 `FLYWHEEL_QUOTA_STATE_PATH` 同目录派生(`quota-monitor-witness.json` 与 state 同目录),不加新 env。
