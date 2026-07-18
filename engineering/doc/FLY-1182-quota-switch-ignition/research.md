# FLY-1182 Claude 账号 quota 自动切换点火 — 调研

Issue: FLY-1182 (https://linear.app/geoforge3d/issue/FLY-1182/enable-claude-账号-quota-自动切换点火-开关配置-fly-696-8-真机-qa-go-卡-常开)
日期: 2026-07-11（初版）· 2026-07-15（§R Re-ignition 追加）
基于: exploration.md（§R 基于其 §R 章节 + FLY-1256 代码/文档现场核实）

## R. Re-ignition 调研 2026-07-15 — FLY-1256 daemon 架构事实 + B 段移植设计依据

> 本节之后的 §1-§N 是前任 runner 对旧 Bridge 引擎的调研，保留作历史。旧引擎切换面已被
> FLY-1256 retire（CUTOVER 门控），本节是新架构下的调研，是 plan Rev 2 的直接依据。
> brainstorm gate 批复（Tadashi）：决策1=B 分段（A 段今晚点火 ✅ 已执行 / B 段同单模型级
> 移植，GO 卡 B 后才开）；附加 Annie 两条硬验收；决策2=关 #562 留档 + 分支重建后 push。

### R.1 FLY-1256 daemon 架构事实（代码级核实）

| 组件 | 位置 | 事实 |
|---|---|---|
| usage 直读 | account-heal/quota-usage-api.ts | OAuth usage endpoint，payload **只有** five_hour / seven_day（utilization + resets_at）。**无模型维度** |
| 触发判定 | quota-monitor.ts:131-137 triggerScope | five = 5h pct ≥ trigger5hPct（默认 90）；weekly = 7d pct **≥ 100**；both 兼有 → scope 5h/weekly/both |
| 候选验证 | quota-monitor.ts:293-305 | 切前逐候选查 usage：7d ≥100 排除 + 按 7d resetsAt 排序；order 榜单 = quota-monitor.json（现 shopping→school→business→personal→personal1） |
| 切换执行 | switch-executor.ts（FLY-1256 增量：preferredOrder + no_account/target_stale_exhausted/freshness_unavailable 分类） | 仍走 flywheel-claude-profile（FLY-696 C1 Keychain swap + verify-before-commit + 回滚 + flock/CAS 全保留） |
| revive 扫描 | quota-revive-scan.ts | 每 tick 扫全 tmux panes（listPanes -a + capture）；classifyQuotaPane **窄判**：账号级句 Claude usage limit reached + idle 输入框 + statusline 100% gauge 三条同真才 quota_stuck；send-keys「continue」+Enter；reviveEpoch 授权（仅切换后窗口内）+ 每 pane ≤3 次 + 卡死升级告警 |
| 告警 | quota-monitor-alert.ts → scripts/lead-alert.sh | Bridge-independent（Claude 全死也能发）；switched 告警 body 现含 from/to/scope/用量/revived/pending **计数**（无受影响清单 —— B 段要补，见 R.4） |
| cutover | bridge/quota-daemon-cutover.ts + plugin.ts | FLYWHEEL_QUOTA_DAEMON_CUTOVER=1 → Bridge 三个 legacy 切换面退役；runner quota detection 保留 |
| 部署 | scripts/setup-quota-monitor.sh + wrapper + plist（launchd KeepAlive，ThrottleInterval 30s） | fail-closed 前置（池/store/凭据 0600/oauth 字段/台账 auth-usable/plist lint）；健康探活（90s 内 pidfile 活 + lastPollAt 新鲜）不过则 bootout + die，CUTOVER 不落 |

**QA 既有覆盖**（不重跑）：FLY-1256 Opus QA PASS —— 单测 230 + config 405 + shell 契约
14 + hermetic 真机 e2e（真 daemon 进程 + mock usage server + scratch keychain + 真
flywheel-claude-profile + 隔离 tmux + 真捕获 cap pane；铁证 fake claude invocation
count=0 = Claude 全员假死独立切号）+ 真 Discord 投递补测（6 kind 落 #test-flywheel-alerts）。

### R.2 A 段点火实录（2026-07-15 23:07 PDT，Tadashi 窗内）

1. 主仓 dist 过期（Jul 15 01:22 < #603 merge）→ pnpm install + 定向 pnpm --filter
   flywheel-teamlead... build（**全量 -r build 在 voice-bridge 包失败**：找不到
   flywheel-edge-worker，#555 引入 —— 已报 Tadashi，unified restart deploy 需注意）。
2. 首跑 setup fail-closed 拒绝：池有 personal1 目录、台账无条目（07-13 后新 capture 未
   登记）→ 在 claude-accounts.lock（mkdir 锁协议）下 jq 原子补登记 personal1 → 重跑成功。
   （首跑失败按设计向 alerts 发了一条 quota_monitor_down severe —— 非事故。）
3. FLYWHEEL_QUOTA_RESTART_BIN=/usr/bin/true（脚本显式覆盖点）把自带 --bridge-only 重启
   延后到 Tadashi 的 unified restart（其批复原文「Bridge 侧随今晚 unified restart 生效」）。
4. 结果：daemon healthy（pid=10747，lastPollAt/lastSuccessfulUsageAt 新鲜，errorStreak=0，
   tier=base）；真实用量读到（log：quota account=personal1 five_h=37 seven_d=8）；
   CUTOVER=1 已写；无切换发生（37 << 90）。
5. **活体观察（重要）**：daemon 机器真值 active=**personal1**，而台账 activeAccount 与池
   .active 仍写 business —— founder 手切失真此刻真实存在。daemon **读数**用机器真值
   （行为正确）；**切换路径**（CAS 键/台账对账）对失真的容错 = B 段实现时必须以单测锁定
   的核实点（旧引擎的这个洞是 PR #562 R6/R8 抓出来的，daemon 侧不能想当然）。
6. 双引擎短窗说明：CUTOVER=1 已写但 Bridge 未重启 → 旧 Bridge 切换面在 unified restart
   前理论上仍活。风险≈0：旧引擎检测只认账号级 gauge 100%（两年实证从未触发）；且两引擎
   切换共用同一 flock/CAS/generation（FLY-696 S4 双触发幂等已验），不会互相写坏。

### R.3 Gap 分析 — 模型级配额在 daemon 世界仍是盲区（B 段的存在理由）

- 检测盲：usage API payload 无模型维度（R.1 行 1）；triggerScope 只看 5h/7d 窗口 →
  模型级封顶（You've reached your Fable 5 limit，5h/7d 才 10~88%）永不触发。
- revive 盲：classifyQuotaPane 只认账号级句 + 100% gauge → 模型级卡死 pane 与 weekly
  付费选择题 pane（「1 等 / 2 买 credits / 3 升 Team」，FLY-1038 实锤③）都判 other。
- 后果 = founder 实锤①场景在新架构下原样复现：模型级封顶 → daemon 静默 → runner 卡死
  → founder 手救。这正是「1182 从来没修好过」的真因，也是 GO 卡被挡的直接理由。

### R.4 PR #562 可移植资产盘点（Track C 44/44 真机验证过）

| 资产 | 源（origin/flywheel-FLY-1182） | B 段用法 |
|---|---|---|
| parseModelCap tri-state（capped/clear/unknown；字符预算归一化非行数；spinner/窄终端反例回归） | account-heal/model-cap.ts + 单测 37 | 移植进 daemon 包，pane 扫描的模型级判定核心。unknown 语义 = 不动它但不沉默（R8 结构性结论：销毁性判断必须三态） |
| 通用句式判别（reached your <MODEL> limit + 必带 switch models with /model 标记，不写死 Fable，排除账号级/Context limit） | model-cap.ts | classifier 扩展的判别规则 |
| 有界 TTL bench（BASE 30min → 失败翻倍 → MAX 4h；永不永久停用、不 thrash）+ per-(账号,模型) modelCaps | account-store.ts 增量 | daemon 侧模型级 bench：usage API 验不了目标账号的模型级余量（切过去才知道）→ bench 是防 thrash 的唯一机制；全 bench → no_account 告警 |
| 事故当晚逐字 pane fixtures | evidence/track-c-*.log + fixtures | B 段单测/e2e 直接复用 |
| post-switch observer（受影响清单 + 复确认）设计 | commit 80abf56d8 一带 | Annie 两条硬验收的产品面参考（清单 + 5-10min 复查帖） |

### R.5 B 段开放风险（plan 里显式处理）

1. **选择题 pane 的自动恢复动作有付费误触风险**（选项 2=买 credits，3=升 Team）——
   v1 立场：**检测 + 告警点名（受影响清单里标出），绝不自动按键**；切号后该 pane 的恢复
   动作（Esc / 1 / continue 的真实按键行为）由 QA 段真机确定后才可考虑自动化。fail-closed。
2. 选择题 pane 的**可信 fixture 缺失**（FLY-1038 事故 pane 未逐字留档）—— 没有真实
   capture 就不进 classifier（拿标签当事实的教训）；QA 段安排真机复现/捕获。
3. 台账失真下的 daemon 切换 CAS（R.2#5）—— 实现时单测锁定：机器真值≠台账时切换必须
   仍正确（对账成机器真值或 fail-closed 告警，绝不静默丢弃）。
4. daemon 的模型级检测扫描与 reviveScan 的关系：reviveEpoch 只在切换后授权 send-keys；
   模型级**检测**（触发切换）must 独立于 epoch（切换前就要能看见）。实现放
   pollOnce 的 pane 扫描段，与 usage 触发同权重、同 minSwitchIntervalMinutes 节流。

### R.6 分支 / PR 处置操作序列（Tadashi 已批）

1. gh pr close 562 --comment（说明被 FLY-1256 架构性取代 + evidence 已随新分支进 main + 资产移植去向）。
2. git push origin :flywheel-FLY-1182（删远端旧分支；#562 的 86 commits 在 PR 页面永久可见）。
3. git push -u origin flywheel-FLY-1182（本分支接管同名，含前任 docs + 本次设计修订）。
4. 此后 implement phase 照常同分支接力；本单 PR 开在该分支。

## 1. 引擎全链（代码事实，实现 runner 照此定位）

### 1.1 检测层（谁发现封顶）

- **Lead 侧**：`LeadWatchdog`（`packages/teamlead/src/LeadWatchdog.ts`）30s pane 扫描 →
  `isTransientThrottlePane()` 先短路（529/瞬时限流 = 原地重试**绝不切**，FLY-218/220 守卫
  不许碰）→ `parseUsageGauge(pane, now, tz)`（`account-heal/usage-gauge.ts`）只在 gauge
  明确 100% 才给 scope（5h/weekly/both，绝对 ISO resetAt）→ flag-gated 给 alert 附
  `accountLimit` metadata（`derive-account-limit.ts`，含 provider/observedAccount/
  observedGeneration）。parse 失败 → null → needs_human，不切。
- **Runner 侧**：`RunnerIdleWatchdog` 加 optional `runnerQuotaScan` dep（`bridge/
  runner-quota-scan.ts`，`makeRunnerQuotaScan`），同 poll 采集上对 Claude runner pane 跑
  `detectRunnerQuotaCap`（`account-heal/runner-quota-detector.ts`）→ 命中真 cap emit
  usage_limit alert（带 runner 身份，eventId=`runner-quota:<exec>:<generation>`）。
- 检测 fixtures（轨A 直接复用）：`packages/teamlead/src/__tests__/fixtures/lead-panes/
  usage-limit-real.txt`（5h=100%）、`usage-limit-weekly.txt`、`usage-limit-both.txt`、
  `usage-gauge-ambiguous.txt`。

### 1.2 决策/排队层

- `AutoRepairBot.canAttempt(payload)`：account-cap → **pending/assigned**（不即时切）→
  `accountSwitch.enqueue` 写 durable pending 记录。
- **pending 记录**（`account-heal/pending-store.ts`）：文件
  `~/.flywheel/account-switch-pending.json`（可 `FLYWHEEL_ACCOUNT_PENDING_PATH` 覆盖），
  schema = `{key, provider:"claude", sourceAlertId, observedAccount, observedGeneration,
  scope, resetAt, deadlineAt, createdAt, claimedBy?}`，key=`sourceAlertId|account|generation`。
  读改写**必须持共享 flock**（`mkdir-lock.ts` 协议：mkdir + holder{pid,at} + 120s stale）。

### 1.3 执行层（谁切、怎么切）

- 两条执行路径共用一个 executor：
  1. **Codex Infra Bot claim**：POST `/api/account-switch`（`bridge/account-switch-route.ts`，
     token 必需否则 503、server-side 拒 actorBackend===provider、MVP 仅 claude）；
  2. **Bridge watchdog 兜底**：`account-heal/account-switch-watchdog.ts`
     `accountSwitchWatchdogTick` piggyback 30s poll（plugin.ts `onPollComplete`）→
     `duePending`（过 deadline 且未 claim）→ `executeSwitch`。默认 deadline ~20s ⇒ 无 bot
     时 watchdog 一个 poll 周期内切。**重启安全**：pending 落盘，重启后下个 tick 接着跑。
- `switchAccount` executor（`account-heal/switch-executor.ts`）：flock → CAS
  （active===observedAccount 且 generation 匹配，否则 no-op 不重复切）→
  `selectNextAccount`（`account-store.ts`：5h 挑已回，weekly/both 挑 weeklyResetAt 最近，
  全废 → null+最早 reset → needs_human）→ `flywheel-claude-profile use <next>` →
  原子更 `~/.flywheel/claude-accounts.json`（旧账号标 quotaExhaustedUntil、generation+1，
  可 `FLYWHEEL_CLAUDE_ACCOUNTS_PATH` 覆盖）。失败/锁超时/verify 不过 → fail-closed，
  state 不变，needs_human。
- **Keychain 写**（`packages/claude-runner/bin/flywheel-claude-profile`）：
  `security -i` 整条命令走 stdin ⇒ **argv 零凭据**；verify-before-commit 读回精确比对才写
  `.active`，mismatch → 回滚快照 + 非零；FLY-865 同步把目标账号 oauthAccount 写
  `~/.claude.json`（新 claude `/status` 显示新账号）；**freshness 闸**（`freshness.ts`）：
  目标凭据不新鲜/helper 不可用 → exit 31 fail-closed 拒切（`FLYWHEEL_CLAUDE_FRESHNESS_BIN`
  可指定，`FLYWHEEL_CLAUDE_FRESHNESS_BYPASS=1` 仅应急）。
- D1 语义：机器级 Keychain swap —— **新 spawn 读新账号，活 session 保持内存 token 等
  reset，绝不热换**。

### 1.4 通知层

- `postSwitchResult`（plugin.ts:6012-6045 一带）：成功（真 switched）→ #flywheel-alerts
  🔧 记录 + **#flywheel-notify 🟡 digest**（P-identity 谓词 = CLAUDE_INFRA_BOT_TOKEN +
  FLYWHEEL_NOTIFY_CHANNEL，均已设）；needs_human → owner-bot assignment（mention
  `FLYWHEEL_INFRA_BOT_USER_ID`，**无**立即 founder 升级）。account_switch **不 resolve**
  原 alert 线程（pane 恢复才算完）。
- 切换成功后 `onSwitchSuccess` → FLY-871 rescue sweep（救「卡在 login prompt」的
  session —— 注意这不是救 quota-stuck session）。
- Codex 侧增量：`flywheel-comm account-rotation-notify` → Bridge `/events`
  `account_rotation` 分支 → 同 postToThread 路径（§8 #12 的验证对象）。

### 1.5 装配条件（生产 live 的判据）

plugin.ts:5988：`accountSwitchRepair = FLYWHEEL_ACCOUNT_SELF_HEAL==="1" ?
makeAccountSwitchRepair(...) : undefined`；:6015 `if (accountSwitchRepair &&
unifiedAlertChannelId)` 才接通知/路由/watchdog。flag 是 **Bridge boot 时读**（FLY-1091
registry 有登记但无热切换）⇒ 关闭 = 删 env + 重启。

## 2. 生产现状审计（2026-07-11 实测）

| 项 | 状态 |
|---|---|
| `~/.flywheel/.env` | SELF_HEAL=1 / PROFILE_BIN=主仓 bin / AUTO_REPAIR=1 / NOTIFY_CHANNEL=1521630422918758472 / DIGEST_EXPECT=1 / ALERT_ROUTING=1 / ALERT_TICKETS=1 / 双 bot token+id 全齐 |
| 活 Bridge | PID 10469，Jul 11 06:06 启动，**进程 env 实测含上述全套** ⇒ 引擎已装配 |
| 账号池 | 4 账号（business/personal/school/shopping），`.active`=business，0700/0600 |
| accounts.json | generation=1，activeAccount=business，全员未标 exhausted（零切换史） |
| pending 文件 | 无积压记录 |

## 3. 既有 QA 覆盖 vs 缺口

| 来源 | 已覆盖 | 没覆盖（= 本单 §8 缺口） |
|---|---|---|
| FLY-696 单测/集成（195+）| parser 全分支、selectNextAccount、CAS/flock、状态机、byte-compat sentinel | 真机链路 |
| FLY-696 开发侧冒烟 QA-1~6 | scratch keychain + dummy service：真 swap 精确 roundtrip、argv 924 采样零泄露、脏写拒+回滚、活锁 fail-closed、并发双触发串行 | 是**开发者自证**且非生产装配实例 |
| FLY-929 QA | 字节兼容 + 纯函数 + 日期契约 | 「真发 Discord / 真封顶注入」明确留给 enable 窗（报告 §5） |
| FLY-1071 收尾窗 | 双 bot 上线 + 探针 3/3 + 演练①（工单注入） | 明确不做 步6②③（账号封顶/全封顶演练） |
| **缺口 = 本单** | — | §8 M1（1-13、16）真机：真切换 E2E、登录不坏、通知真落、529 不误切、双触发、重启恢复、byte-compat 等 |

## 4. 隔离旋钮（轨A 全部现成，零代码改动）

| env | 作用 | 默认 |
|---|---|---|
| `FLYWHEEL_CLAUDE_PROFILES_DIR` | 池目录 | ~/.flywheel/claude-profiles |
| `FLYWHEEL_CLAUDE_ACCOUNTS_PATH` | 账号状态 json | ~/.flywheel/claude-accounts.json |
| `FLYWHEEL_ACCOUNT_PENDING_PATH` | pending 记录 | ~/.flywheel/account-switch-pending.json |
| `FLYWHEEL_CLAUDE_ACCOUNTS_LOCK` | flock 目录 | ~/.flywheel/claude-accounts.lock |
| `FLYWHEEL_CLAUDE_KEYCHAIN` | keychain 路径（scratch） | 默认搜索链 |
| `FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE` | item service 名（dummy） | Claude Code-credentials |
| `FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT` | item account | $USER |
| `FLYWHEEL_CLAUDE_JSON` | 显示身份 json（FLY-865） | ~/.claude.json |
| `FLYWHEEL_CLAUDE_SECURITY_BIN` | security 工具 | /usr/bin/security（轨A 用真的） |
| `FLYWHEEL_CLAUDE_FRESHNESS_BIN` | freshness helper | 脚本旁解析 |

529 Room（FLY-529，`scripts/test-deploy.sh` + `packages/qa-framework/`）提供隔离 slot
Bridge + 隔离频道 + `FLYWHEEL_ALERT_QUEUE_DIR`/`FLYWHEEL_CLAIMS_DB` 隔离；slot Bridge 的
进程 env 可携带上表全部旋钮。模块驱动先例（真 dist 函数 + 真 Discord 隔离频道）：
`scripts/qa-fly-1082-fleet-alerts-e2e.mjs`、`qa-fly-863-codex-hold-signal-e2e.mjs`、
`qa-fly-529-alert-smoke.sh`。

## 5. 轨B（生产演练）的注入面确认

- 写一条 due pending 记录（持 flock，模块驱动用 dist 的 `pending-store` + `mkdir-lock`）
  → 生产 Bridge 30s 内 `accountSwitchWatchdogTick` 真执行。构造要点：
  `observedAccount=business`（当前 active）、`observedGeneration=1`（当前 generation）、
  `scope="5h"`、`resetAt=now+5min`（兜底：即使复原步骤失手，business 5 分钟后自动回池）、
  `deadlineAt=now`（立即 due）、`sourceAlertId="fly1182-drill-<ts>"`。
- CAS 语义保证：若窗口内真实封顶恰好先切了（generation 变）→ 演练记录变 no-op，安全。
- 预期可观察结果：Keychain item 变 next 账号 + `~/.claude.json` 显示身份变（FLY-865）+
  accounts.json generation=2、business 标 exhausted(+5min) + #flywheel-alerts 🔧 +
  #flywheel-notify 🟡 digest + rescue sweep 日志（健康 fleet 应 0 目标）。
- 复原（**注意：不是一条 use 命令 —— use 只恢复 Keychain/`.active`/显示身份，不写
  accounts store**）：必须走 plan Task 3.4 的分阶段 CAS 事务 —— 单一 Node driver 持
  `withMkdirLock` 经 `makeClaudeProfileSwitchDeps().applyProfile("business")`（委托锁，
  禁止持锁裸调 CLI 否则自锁）+ CAS 三条件（generation=基线+1、active=next、business
  cooldown === drillResetAt）+ 同锁原子改写 store（active=business、只清 drill
  cooldown、generation=基线+2 单调）+ **第四道守卫**（restore 前比对基线 incident
  集合：窗口内有新增非 drill 的 active usage_limit incident → 禁止切回已封顶的
  business,保留 next、升级 Tadashi —— 拦「drill 先赢、真实 cap 后 no-op 被 resolve」
  的交错,Codex R3#1）；未执行的超时中止则持 pending flock 按 key 删 drill 记录。
- 风险面：窗口内新 spawn 的 session 会用 next 账号（D1 语义，功能无损，只是额度记账走了
  另一个号）；活 session 零影响。

## 5.5 交叉互救（bot-claim）路径的接线事实（scope 更新 ② 的 QA 对象）

- 路由存在且 fail-closed：`bridge/account-switch-route.ts` —— token 必需否则 503、
  server-side 拒 `actorBackend===provider`（Claude cap 只有 Codex 身份能调）、MVP 仅
  claude、幂等 + audit。bot 调用形态 = `POST /api/account-switch` 带
  `actorBackend:"codex"`（persona §2 写明）。
- **竞态事实**：pending deadline 默认 **20s**（`account-switch-repair.ts:93`），Bridge
  watchdog 30s poll 兜底 ⇒ 生产里 LLM bot 几乎必输给 watchdog。
- **通知接线事实（Codex R1#6 纠正初稿）**：成功 enqueue 路径**有** assignment
  mention —— `AlertChannelHub.ts:496-508` 对 `repair.action==="account_switch"` 明确
  用 `FLYWHEEL_INFRA_BOT_USER_ID` @ Codex bot；`resolveAccountCapOwnerId`
  （plugin.ts:6030 一带）的 mention 是**执行结果** needs_human 时的第二处。⇒ 真偏差
  = **20s claim 窗对 LLM bot 过紧**,不是「成功路径没人点名」。**QA 任务**：Task 0.4
  同时审计 enqueue path 与 post-result path 两处接线,finding 按实测条件化书写;轨A
  用加长 deadlineAt 的注入让 bot 真跑一次 claim→route→switch。
- **actor 身份 trust assumption（Codex R1#5）**：`/api/account-switch` 的
  `actorBackend/actorBotId` 来自请求 body,HTTP 层只校验共享 `TEAMLEAD_API_TOKEN`
  ⇒ 「只有 Codex actor 能调」是**协议约定不是密码学绑定**。本单接受该 trust
  assumption（拿共享 token 的都是本机受管 agent）并写入 qa-report;结构性身份绑定
  （per-bot credential → server 端从认证上下文推导 backend）= follow-up。推论:轨A
  2.9 的交叉互救验证必须由**真 Codex InfraBot session** 端到端执行（mention→claim→
  route→rescue）,QA driver 伪造 body 字段不算数。

## 6. Annie 三问 — 代码事实版底稿（qa-report 人话版据此写）

1. **到期怎么 detect**：Bridge 每 30s 扫 Lead/Runner 的 tmux pane → 先排除 529/瞬时限流
   （绝不因它切号）→ 只认 usage gauge 明确 100% 的真封顶，解析出 5h 还是 weekly、几点回
   （绝对时间带时区）；看不清就标 needs_human 绝不瞎切。
2. **谁执行切换、怎么切**：Bridge 自己（Node 进程内，不烧额度、常驻）。流程 = 排队记录落
   盘 → Codex Infra Bot 可先认领，20 秒没人认领 Bridge 兜底 → 上锁 + 二次确认没被别人切过
   → 挑下一个可用账号（weekly 挑最快回血的）→ 用 security 工具把 Keychain 凭据换成新账号
   （凭据不过命令行、写完读回校验、失败自动回滚）→ 同步显示身份 → 记账 + 发通知
   （#flywheel-alerts 🔧 + #flywheel-notify 🟡）。新开的 session 用新账号。
3. **卡在 quota 的旧 runner 怎么恢复**（按 scope 更新 ① 重写，D2 已被 Annie 撤销）：
   换号成功后，**Codex InfraBot 自动逐个翻活**卡在 quota 的 session —— 新 session 本来
   就自动用新账号；旧 session 由 bot 逐个判断：能原地续的注入恢复，不能的 runner 走
   close + redispatch（进度靠 progress ledger 断点续）、lead 走原地重启,全部带证据帖 +
   救不动才 @Annie。（机制 = 本单新建,见 §8;bot 挂了的退化行为 = 等 reset。）

## 7. 风险与开放项

- **QA 前已 live 的窗口期**：Jul 11 06:06 起真实封顶会触发未经本机 E2E 验证的切换。
  缓解：开发冒烟+Codex review 已过、freshness/verify/CAS 全 fail-closed、观察至今零切换。
  GO 卡如实披露（Tadashi 已拍）。
- **轨B 演练时的真实封顶竞态**：CAS/generation 使两者只成一个，另一个 no-op —— 设计
  内。但「drill 先赢、真实 cap 后 no-op 被 resolve」会让回滚三条件误判 —— 由第四道
  守卫（基线 incident 集合比对）拦截,见 plan Task 3.1/3.4(b)。
- **freshness 闸**：池内凭据是 Jul 4 capture 的，若已 stale，`use` 会 exit 31 拒切
  （fail-closed，这是**保护不是 bug**）。轨B 前置检查里先跑 status/freshness 探测；真
  stale → 重新 capture 是 founder 动作（Annie 在场逐账号登录）→ 报 Tadashi 调度，不算 QA FAIL。
- **529 Room 占用**：任务 #78 等场景可能占房 → 实现 runner 用房前先与 Tadashi 确认。
- lint/CI：本单含代码 PR（scope 更新后），全仓 lint + 测试前置。

## 8. 交付 6（quota-stuck 翻活）—— 现有机器审计 + 建设面

**现状**（FLY-871 rescue 机制，全部 login-only）：

- `bridge/rescue.ts`：守卫 `findPending*Alert` **只认** `login_expired` /
  `runner_login_expired` 的 confirmed alert 行（rescue.ts:85-107）；`rescueLead` =
  launchctl kickstart 原地重启（成功判据只是「重启后 pane 在且不在 resume menu」，
  **不证明** cap 已消失）；`rescueRunner` = terminate→close→start 三步（**非原子**：
  start 失败后旧 session 已关、二次调用被 status 非 running 拒 ⇒ 部分失败不可重试，
  是本单 Task 1.2 要修的缝）+ audit reason `login_expired_rescue`；
  `postSwitchRescueSweep` = 换号成功后扫**全部**未决 login 类 alert 逐个救
  （onSwitchSuccess 钩子已在 watchdog tick 接好）。**quota 扩展不能直接镜像**：
  revalidation kind-aware 化 + 部分失败 op state + 1.1 账本绑定是前置（plan Task 1）。
- `bridge/rescue-route.ts`：bot 调救援的现成 fail-closed HTTP 入口（token 门禁,
  与 account-switch-route 同风格）。
- 治理：`founder-only-authority` 的 **R3 carve-out 只豁免 login 救援**（仅未决
  confirmed alert、restart-in-place、证据先行、1 retry then @Annie）。
- Codex InfraBot persona（.lead/codex-infra-bot-lead/identity.md）「救」一节只写
  login 场景;quota-stuck 不在其职责文本内。
- **quota-stuck 目标的识别源已存在**：lead 侧 usage_limit alert 行 + runner 侧
  RunnerQuotaDetector 的 usage_limit alert（eventId 带 exec 身份 + generation）,
  与 login 类 alert 同一 `alert_threads` 存储 —— sweep 枚举模式可直接镜像。

**建设面（实现 phase 写代码,估中等体量）**：

> **Scope 更新（lead-instruction flag-removal）**：本节原设想的独立
> `FLYWHEEL_QUOTA_STUCK_RESCUE` 开关已取消 —— 翻活与切换共用
> `FLYWHEEL_ACCOUNT_SELF_HEAL` 同一 enable 路径,merge + Bridge 重启直接生效,
> GO 卡即批准点;单独关翻活的杠杆不存在,缺陷时 revert PR（Annie 已接受该权衡）。

1. rescue 守卫/原语扩 **quota_stuck 类别**：接受 usage_limit 类 confirmed alert;
   runner = close（新 audit reason `quota_stuck_rescue`）+ resumed-successor;lead =
   kickstart。**不是简单复用**（Codex R2#3 修正）：revalidation 要 kind-aware（quota
   目标有自己的 live 复核判据）、close→start 部分失败要 op state 可重试不双开、准入
   要 1.1 账本绑定 —— 详见 plan Task 1.1/1.2。
2. rescue-route 扩同类别（bot 的调用面）;server 端同样谁都不救自己语义（Claude 侧
   quota-stuck 只有 codex actor 能调）。
3. founder-only-authority 增 **R3b carve-out**（quota-stuck 翻活,结构护栏与 R3 同款:
   仅未决 confirmed usage_limit alert、事故窗口内、证据先行、1 retry then @Annie）。
   依据 = Annie 直令（lead-instruction a861ef01）撤销 D2。
4. Codex InfraBot persona「救」一节扩 quota-stuck 职责(换号成功 → 识别清单 → 逐个
   判断 nudge / close+redispatch / kickstart → 证据帖)。
5. 「注入恢复」实测：QA 阶段验证 claude 活 session 在 token refresh 时是否重读
   Keychain(决定 nudge 是否可用;不可用则 bot 判断树里只留 close+redispatch 路)。
6. 测试：守卫准入矩阵(quota_stuck 可救 / suspicious 拒 / login 路径零回归)+
   route 门禁 + sweep 幂等 + byte-compat(self-heal off 全 dormant —— 单 flag)。

**刻意不做（v1）**：Bridge 自动 sweep quota-stuck（owner = bot,Annie 点名;bot 挂了
退化为现状等 reset）;5h 选号策略调优（scope ③ 只记录:5h 封顶也优先切「reset 最近且
有余量」——现行为 = 5h 挑任一已恢复,weekly 才挑 reset 最近;调优等 v1 跑通后单独立单）。
