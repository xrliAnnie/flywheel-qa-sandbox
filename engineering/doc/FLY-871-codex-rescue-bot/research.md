# FLY-871 Codex 救援 Bot — 调研

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-04
基于: exploration.md

---

## R-1 token 保鲜:唯一 choke point = `flywheel-claude-profile use`

**事实**:所有 Keychain 写(自动切换 + 人工 `use`/`next`)都收敛到 bash 脚本 `packages/claude-runner/bin/flywheel-claude-profile` 的 `use_profile()`(Node 侧 `switchAccount` 经 `claude-profile-cli.ts` 的 `applyProfile` 调它;`execFile` arg-array 无 shell)。锁协议 bash/Node 字节兼容(mkdir + holder JSON + 120s stale),且已有 **delegated-lock 模式**(`FLYWHEEL_CLAUDE_LOCK_DELEGATED`,FLY-852:Node 持锁时 child bash 不重复拿锁)。

→ **守卫放在 bash `use_profile` 内**(acquire_lock 之后、kc_write 之前),自动/人工两条路径同时被保护。OAuth refresh 这类 HTTP+JSON 逻辑 bash 不适合 → `use` 在锁内 shell out 到一个小 **Node freshness helper**(同 delegated 模式,凭据经文件/stdin 传递,**绝不进 argv** —— 沿用 696 红线)。

**回捕(capture-back)插入点**:`use_profile` 中 `backup=$(kc_read …)` 已经读了当前值 —— 回捕 = 把这个 backup 原子写进 `pool/<.active>/.credentials.json`(temp+rename,0600,拒 symlink;`.active` 为空或 == 目标时跳过)。几乎零新机制。

## R-2 OAuth refresh 端点(D1 第 2 层)— 实现期 spike 必验

训练知识(社区工具广泛使用,与 Claude Code 同款,**实现期必须真机 spike 验证,不可直接照抄**):
- `POST https://console.anthropic.com/v1/oauth/token`,body `{grant_type:"refresh_token", refresh_token:<pool 值>, client_id:<Claude Code public client_id>}`。
- 响应含新 `access_token` + 新 `refresh_token` + `expires_in` → **旧 refresh token 作废(轮转)** → 成功后必须先原子写回 pool 再用,否则守卫自己制造 stale(exploration §3 D1 已列)。
- client_id 是公开常量(Claude Code 二进制内嵌);token 端点无需 client_secret(public client + PKCE 只在首次授权,refresh 不需要)。
- **spike 验收**:对一个非活跃测试账号 refresh 成功 + 旧 refresh token 确认失效 + 新凭据能通过只读探针;端点/字段与假设不符 → 停,按实际调整。

**expiresAt 语义**:pool 凭据 `claudeAiOauth.expiresAt`(epoch ms)= access token 过期时刻。未过期 ≠ refresh token 一定活着,但未过期的 access token 可以直接用(claude 启动后自己会 refresh 并写 Keychain)。**过期** → 必须 probe-refresh 才知道 refresh token 死活。因此判定序:未过期→放行(记 freshness=static-ok);过期→probe-refresh(成功→写回+放行;失败→authExpired+换候选)。

**残余风险(诚实边界)**:expiresAt 未过期但 refresh token 已被外部轮转(如 Annie 手工在别处登录同账号)的凭据,静态判定会放行 —— claude 首次 refresh 时才失败。
> **[已被 design review 收紧取代]** Codex R1#1 判定:事故类别正是 refresh family 失效,红线路径不接受此残余 → 最终设计 = **非 active 目标切前一律 probe-refresh,无 static-ok 放行态**(expiresAt 仅 telemetry)。注意(Codex R2#2):"非 active" ≠ "无人在用"(切走账号的 live session 拿内存 token 等 reset)—— 切前 refresh 可接受(目标随即成为 active,Keychain 持其最新 family,滞留 session 可恢复);**后台 keep-fresh 的 probe-refresh 无此恢复性质** → 独立开关默认 off、R3 救援上线后才启用。见 plan C2/C4。

## R-3 authExpired 信号回传:`use` → `switchAccount` 候选重试

**现状**:`applyProfile` 非零即 throw → `switchAccount` 返回 `outcome:"failed"`,state 不动,**不换候选**。`account-store.ts` 的 `authExpired`/`refreshTokenInvalid`/`profileVerifyFailed` 字段已定义、`selectNextAccount` 已会跳过,但**无人写入**。

**需要建**:
1. bash `use` 用**结构化退出码**区分失败类:目标凭据 stale/refresh 失败(守卫拦下,Keychain 未动)= 专用退出码(如 30)+ stderr 标记;其他失败(锁超时/verify 失败/回滚)维持现状语义。
2. `switchAccount` 捕到"目标 stale"→ 持锁内标记该账号 `authExpired:true` → `selectNextAccount` 重选 → 重试 apply(候选循环,上限 = 池大小)→ 全废 → `no_account` + needs_human(带最早 reset + authExpired 名单)。
3. **Tadashi 硬要求**:「active 账号绝不从 pool 侧 refresh」写成**测试断言**(freshness helper 拒绝对 `.active` 账号执行 probe-refresh 的显式单测 + helper 内部 fail-closed 检查),不只是设计文字。

## R-4 Codex-Bot 部署面(R2 段)

**模板 = Mufasa windowed TUI full-access**(`packages/teamlead/scripts/run-codex-lead-mufasa-tui-fullaccess.sh`,FLY-398 硬规则:生产 Codex lead 必须 windowed TUI,绝不 headless app-server):
- env 面:`FLYWHEEL_LEAD_ID` / `FLYWHEEL_PROJECT_NAME` / `FLYWHEEL_LEAD_BOT_USER_ID` / `FLYWHEEL_LEAD_CHAT_CHANNEL_ID` / `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` / `FLYWHEEL_CODEX_LEAD_STATE_DIR`(hard-pin,thread 记忆延续)/ 隔离 `CODEX_HOME` / standalone codex bin。
- launchd 收编 `com.flywheel.lead.<project>-<leadId>`(wrapper source `~/.flywheel/.env`,token 不进 plist —— FLY-250 纪律)+ ship 纪律 = companion-lead-ship-discipline.md。
- **Alerts channel 接入方式**:Alerts channel(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`)是共享频道,Bridge 的告警帖是 **bot-authored** —— FLY-267 mention-gate 的名字正则**只对非 bot 作者**生效(防 bot 回环),但**显式 `<@botId>` mention 放行**。→ 触发协议:Bridge 的 bot-assignment 帖里带显式 `<@CodexBotUserId>` mention = 干净的结构化触发;bot 的日常巡检(状态摘要/keep-fresh 读数)走**本机文件直读**(`~/.flywheel/claude-accounts.json` + pending store,bot 就在这台机器上),不依赖 Discord 爬帖。696 C8d 的 loop 防护(不回自己/Bridge 状态帖、dedup)照搬。
- Codex 账号:bot 跑在 ChatGPT 账号池上(codex-profile 5 账号),与被救的 Claude 账号体系**完全无关** = "账号体系外"成立。

## R-5 C8b `/account-switch` 路由(未建,按 696 已批设计补)

- 前例:`/api/founder-consent/*`(plugin.ts:1340+)= 专用路由、token 必需否则 503(tokenless-503 pattern);`/api/runs` 用 `tokenAuthMiddleware(config.apiToken)`。新路由照此:**不挂 `/actions`**、`TEAMLEAD_API_TOKEN` 必需、server-side gating 拒 `actorBackend===provider`、MVP 仅 `provider:"claude"`、idempotency key = pendingKey、前后 audit。
- `pending-store.ts` 的 `claimPending(key, botId)` 已就位(key = `pendingKey(sourceAlertId, observedAccount, observedGeneration)`;持锁、不可抢);路由内部落 M1 `switchAccount`(含新 R-3 候选循环)。watchdog 兜底不动(deadline 后接管 unclaimed)。

## R-6 救援手段(R3 段)— 修正 exploration 的一处假设

- **lead**:launchd job 实测在跑(`launchctl list` 见 `com.flywheel.lead.*` 全 fleet)→ `launchctl kickstart -k gui/$UID/<label>`。**已知坑**(memory 有案):重启后可能卡 "Resume from summary?" 确认框 → playbook 后置步骤 = 检测确认框 pane → 发 Enter 解卡 → 再验证健康。
- **runner(修正)**:TmuxAdapter **interactive 模式无原地 resume**(`TmuxAdapter.ts:773` 明注 "no resume in interactive tmux mode")。FLY-795 的恢复路径 = **RetryDispatcher 起新 execution + `$FLYWHEEL_PROGRESS_PATH` 从 progress.md 续跑**(`TmuxAdapter.ts:419`)。→ runner 救援 = 走现成 retry(新 execution 续 progress),不是 tmux respawn 原 pane(issue 原文的 "tmux respawn+resume" 语义上即此:重启后从断点继续)。旧 pane 由现成 lifecycle 清理。
- **FLY-175 founder-only-authority 交叉**:retry/close-runner 属保留动作。FLY-871 issue 原文(Annie 拍)已明示授权"发现被踢 → 自动重启 → 救不动才 @"这条**窄自愈路径** → plan 里把 carve-out 写进 `founder-only-authority.md`(限定:仅 login_expired 确认的 session、restart-in-place/retry-with-resume、证据先行贴 Alerts、失败即升级),并在 rescue 入口 server-side 校验目标确实处于 login_expired 状态(结构约束,不只靠 prompt)。
- **runner 侧 login-expired 检测(缺)**:`RunnerIdleWatchdog` 已有 `runnerQuotaScan?(session, pane)` optional seam(FLY-696 ③,不装=byte-compat)→ 同款加 `runnerAuthScan` 或把现有 scan 泛化为 quota+auth 双判(复用 LeadWatchdog `login_expired` tokens:`/login.*expired/i`、`/reauth/i`)。lead 侧现成(severe 级)。

## R-7 "看"的数据源与边界

- 现成:`claude-accounts.json`(quota/reset/auth 态,R-3 起 authExpired 有人写了)+ `account_switch_pending` + Alerts 结构化事件 + keep-fresh 巡检产出(新增 per-account `lastVerifiedAt`/`freshness`)。
- **spike(不阻塞)**:Claude Code `/usage` 背后是否有可查询的 per-account usage HTTP 端点 —— 有 → 非活跃账号也能主动看额度(拿有效 access token 查);没有/不稳 → 维持事件学习。列为 R2 的可选增强,失败不影响验收。
- 摘要频率:事件驱动 + 每日 1 次(FLY-220 教训:少而准,绝不刷屏;错误场景有 episode-latch 前例)。

## R-8 风险表

| 风险 | 缓解 |
|---|---|
| OAuth refresh 端点契约非公开 | 实现期 spike 先验;fail-closed(失败=不切+告警,Keychain 零写);端点变更最坏退化为现状 |
| probe-refresh 误伤 active 账号 token family | 结构禁止:helper 对 `.active` 账号 fail-closed 拒执行 + 显式测试断言(Tadashi 要求) |
| 回捕把坏值写进 pool(Keychain 里已是死 token) | 回捕只在 kc_read 成功且值为合法 JSON 时执行;回捕值同样带 expiresAt,下次切回时守卫照常验 |
| bot 在共享 Alerts 频道刷屏/回环 | C8d loop 防护 + 显式 mention 触发 + 每日 1 次摘要 + bot-authored 过滤 |
| 救援误杀健康 session | rescue 入口 server-side 校验 login_expired 态;carve-out 文字限定;QA 演练含"健康 session 绝不被碰"断言 |
| kickstart 后 resume 确认框卡死 | playbook 内置检测+Enter 解卡步骤(memory 有案的已知坑) |
| bot 自身 Codex 额度耗尽 | watchdog 兜底继续切(bot 非单点);Codex 侧有 5 账号 fallback 轮转;bot 掉线本身会被 LeadWatchdog 看到 |

## R-9 结论(喂给 plan)

1. R1 守卫 = bash choke point 内三层(回捕 + expiresAt 判定 + Node freshness helper probe-refresh)+ 结构化退出码 + `switchAccount` 候选循环 + active-不-refresh 测试断言。纯 Bridge/bash,不依赖 bot,可先行 ship。
2. R2 bot = Mufasa TUI full-access 模板复制(新 leadId/bot token/隔离 CODEX_HOME;**channel 结构以 plan C6 为准:私有 #codex-infra-bot 作 chat,Alerts 作 cross-dept mention-gated** —— design review 修正,chat channel 无 mention gate 不能直挂 Alerts)+ C8b 路由 + claimPending 接线 + 显式 mention 触发协议 + 每日摘要。
3. R3 救 = lead kickstart(+确认框解卡)/ runner retry+progress-resume(修正后的机制)+ runner auth 检测 seam + founder-authority carve-out + server-side login_expired 校验。
4. QA 真机 gate 按 exploration §5,追加:active-不-refresh 断言、健康 session 不被碰断言。

---

## 附录 A — Quota 准确源调研(R2,lead-instruction 47cff318② bounded research,2026-07-04)

**问题**:C7 账号状态账本要准确的 5h/weekly 余额 + reset 时间,尤其解决「闲置(非 active)账号余额盲区」;并验证:若有只读用量接口,用池里闲置账号 access token 查询是否安全(不触发 refresh 轮转 = 不碰 R1 红线)。**Bounded ~30min,查不到就退回界面解析 + 滞后标注。**

### A.1 现状源:CLI status-bar gauge(仅 active 账号)
`parseUsageGauge`(`usage-gauge.ts`)正则解析渲染出的状态栏(`5h ██ 100% reset today 21:30 | 7d ██ 82% reset Mon 09:00`)。准确但 ① 仅 active 账号(要有可 capture 的 pane)② 渲染文本正则,CLI 改格式即碎(= 47cff318① 顾虑)。

### A.2 更优源(新发现,推荐 primary):Claude Code statusLine `rate_limits` 结构化字段
自定义 statusLine 脚本从 stdin 收到的 JSON payload **含结构化 rate_limits**(官方 contract,非渲染文本):
- `rate_limits.five_hour.used_percentage` / `rate_limits.seven_day.used_percentage`(0–100)
- `rate_limits.five_hour.resets_at` / `rate_limits.seven_day.resets_at`(**Unix epoch 秒**)
- caveat:仅 Pro/Max 订阅、session 首个 API response 之后才出现;每 window 可能独立缺失(`jq -r '.rate_limits.five_hour.used_percentage // empty'` 优雅处理)。要求 Claude Code v2.1.x+。
→ **准确 + 抗格式变化的 active-账号源**(直接回应 47cff318① 的 quota 解析顾虑)。harvest = 配自定义 statusLine 脚本把 rate_limits(+账号身份)写到 per-account ledger 文件,账本读之。账本 parser **同时接受** statusLine rate_limits(primary)与 gauge 文本(fallback,兼容旧 CLI / 首 response 前)。

### A.3 闲置账号盲区:无安全只读用量接口
- **无官方订阅用量只读端点**:`claude usage` / `GET /v1/organizations/.../usage/subscription` 是**未实现的 feature request**(anthropics/claude-code#44328,closed-as-duplicate,无端点)。`claude auth status --json` 只给订阅类型、无用量。`~/.claude/stats-cache.json` 是本地客户端统计(dailyActivity/modelUsage/…),**无 rate limit / reset**(本机实测 has rateLimit=false)。
- **ccusage / claude-monitor** 读本地 `~/.claude` JSONL 日志算 token/成本(per-account-with-local-logs),非权威 remaining%,只覆盖本机有日志的账号 → 解不了闲置盲区。
- 权威 %/reset 在 claude.ai Settings > Usage 网页(OAuth web session 后),无干净 API,只能浏览器自动化取(不适合无人值守常驻)。

### A.4 OAuth 安全结论(R1 红线)
一次**只读 resource GET** 带 `Authorization: Bearer <access_token>` **不**轮转 refresh-token family —— 轮转**只**发生在 `POST /oauth/token grant_type=refresh_token`。所以**若**将来有只读用量端点:用闲置账号**未过期** access token 查询 = **R1-安全**;但若 access token 已过期,查询需先 refresh = **R1 红线**,**绝不允许「为查余额 refresh 闲置账号」**。当下无端点 → v1 moot,存档给 v2。

### A.5 v1 账本数据源决策(= 47cff318② fallback「界面解析 + 滞后标注」+ 抗格式升级)
1. **active 账号**:primary = statusLine `rate_limits`(结构化,抗格式);fallback = `parseUsageGauge`(渲染文本)。
2. **闲置账号**:**last-known snapshot + 滞后标注**(记每次该账号 active 时读数 + 时间戳;闲置时展示上次快照 + age/「stale since」)。**不做**闲置账号 live 查询(无安全源)。
3. **撞限事件 / auth 健康**:发生即记(来自 R2 检测层 + R1 freshness probe)。
4. **v2 hook**:若出 `claude usage --json` 或用量端点,账本 `refreshAccountBalance(account)` seam 采纳之(A.4 安全前提);selection 函数已按账本 rank 留口。

**Sources**: statusLine `rate_limits` fields — code.claude.com/docs/en/statusline · feature request #44328 (无端点) — github.com/anthropics/claude-code/issues/44328 · Claude Code usage limits 2026 — morphllm.com / truefoundry.com · Rate limits — platform.claude.com/docs/en/api/rate-limits

---

## R-10 windowed-TUI 显示:取证 + 机制审计(re-plan 回炉,2026-07-05,基于 task-115)

> 背景:R2/R3 merge 后的部署尝试中,前任 runner 报告「launchd 链跑的是 headless codex
> app-server(无 TTY),可见 pane 是另一个没自动化的东西」,而 Annie 记得 TUI 以前 work
> 过。本节 = Fable runner 对整条 windowed 链路的独立真机取证(所有结论均可复现验证)。

### R-10.1 pane 自动化在代码里已存在且机制健全(驳「pane 没自动化」)

- `packages/teamlead/src/lead-backends/codex/tui-window.ts`(FLY-259 PR-C):
  `ensureTuiWindow()` 在 tmux session **`flywheel`** 里开名为 `<project>-<leadId>` 的窗口,
  跑真 `codex resume --remote unix://$CODEX_HOME/app-server-control/app-server-control.sock`
  (`-C <cwd>` 杀 cwd 菜单;full-access 时带 `-s workspace-write`;`approval_policy="never"`
  命令行 pin)。窗名 = FLY-169 MANAGED-title 硬契约。
- `codex-lead-tui-runtime.ts`:thread id 确定后 ensure 窗口;每 20s(`TUI_LIVENESS_INTERVAL_MS`)
  liveness probe(identity-echo 防 tmux 目标解析漂移),确认死窗才重建;generation stop /
  shutdown 时 `killTuiWindow` 收尾,不留孤儿 pane。
- **headless daemon 是架构的一半而非缺陷**:`codex remote-control` daemon 由 node runtime
  spawn,无 TTY、也不需要;pane 的 pty 由 **tmux 提供**(`new-window` 内起 TUI 客户端 attach
  同一 daemon)。launchd 环境无 TTY **不构成障碍**。
- session `flywheel` = 所有 cmux Lead 视图共享的 **session group** 基座(真机核实:
  `tmux ls` 显示 `flywheel: 15 windows (group flywheel)`,`cmux-flywheel-<lead>` 等视图
  session 全挂同一 group;15 窗 = zsh + 14 个 Claude lead 窗,窗名同款 `<project>-<leadId>`
  形态)。group 里新增窗口对所有 cmux 视图可见 → **开进 session `flywheel` = cmux 可见**。
- socket 无分裂风险(本机核实):主 tmux server 在默认 socket
  `/private/tmp/tmux-501/default`,`TMUX_TMPDIR` 未设;launchd 起的 `tmux`(同 uid、无
  TMUX_TMPDIR 覆盖)命中**同一** server。InfraBot plist 模板无任何 env 覆盖(已读)。

### R-10.2 「TUI worked before」属实(真机证据)

- Mufasa 生产 plist(`com.flywheel.lead.growth-mufasa-lead.plist`,mtime Jun 22 00:50 =
  FLY-398 TUI flip)ProgramArguments 指向 **windowed wrapper**
  `flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh` → `run-codex-lead-mufasa-tui-fullaccess.sh`
  → 同一 TUI runtime。内容正确,不存在「plist 指错 headless launcher」的问题。
- `~/.flywheel/state/codex-lead/mufasa-lead/` 最后活动 **Jun 29 13:39**,晚于本次 boot
  (Jun 28 17:17)→ Mufasa windowed TUI 在 launchd 下**这次 boot 里真跑过**。

### R-10.3 真正的 regression:OPS 层,不是代码层

- `launchctl list` 真机核实:**growth-mufasa-lead 是唯一缺席的 lead job**(其余十几个
  `com.flywheel.lead.*` 全 loaded);`launchctl print-disabled gui/501` 为**空** → 不是被
  disable,是 **Jun 29 前后被 bootout 后再没 bootstrap 回来**(时间与 task-114「June-28
  63-CPU-hr stale growth-Mufasa orphan」清理动作吻合;bootout 不跨 login 持久,但本次
  login 之后发生的 bootout 要等下次 login 才会被 RunAtLoad 兜回)。
- 自那以后**没有任何进程再走过 TUI 开窗路径**;Jul 1 cmux/tmux session 重建(sessions
  created Jul 1 22:48)把旧 pane 也清了。「看起来坏了」实为「唯一参照物下线了」。
- InfraBot 侧:`~/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh` ✅、
  `~/.codex-infra-bot/`(auth.json + standalone codex)✅、plist **模板** ✅(repo
  `packages/teamlead/scripts/templates/`),但 plist **从未装进** `~/Library/LaunchAgents/`、
  state dir `~/.flywheel/state/codex-lead/codex-infra-bot-lead` **不存在**、launchd log
  不存在 → **InfraBot 的 TUI runtime 从未真正跑过**。R2/R3 QA 报告明文「C6 部署物料……
  不在本次测试范围」→ windowed 显示对 InfraBot 是「设计了但从未被真机证明」。
- 前任「launchd 链跑 headless codex app-server」观察的最可能来源:把 Claude Code
  codex-companion 的十几个常驻 `app-server-broker.mjs` 进程(真机现在就有)或 FLY-350
  时代的 headless launcher(`run-codex-lead-mufasa-fullaccess.sh`,仍保留作 rollback 资产)
  误当成了 InfraBot/Mufasa 的生产链;实际生产 plist 均指向 TUI wrapper。

### R-10.4 残余薄弱点(re-plan 要治的)

1. **静默无 pane 洞**:`ensureTuiWindow` 特意 fail-open(可见性损失不伤 Lead 服务),失败
   只写 launchd log —— 对普通 Lead 合理,但对「founder 必须看得见」的 Infra Bot,静默
   无 pane 正是本次事故形态。runtime 目前**零**告警接线(已 grep 核实)。
   → 接 `scripts/lead-alert.sh`(FLY-83;Bridge-down 也能发、claims.db 去重、有界)。
2. **bootstrap 纪律缺口**:bootout 后无人负责 bootstrap 回来、无巡检发现「该 loaded 的
   lead job 不在 launchd 里」;C6 runbook 只有 install 步、没有 verify/recovery 步。
3. **bring-up 无证据门**:C6 enable 序里「装 launchd 起 bot」一步没有逐层验证协议
   (loaded → runtime → daemon sock → 窗活 → pane cmd=codex → cmux 目视),失败模式全靠
   事后人肉扒 —— 前任 runner 的误诊正是这个缺口的产物。
4. **待真机复证项**(implement 期,Annie 解锁后):`codex resume --remote` 在当前 codex
   版本下 attach 行为、daemon sock 就绪时序(窗比 sock 先起会不会 dead-pane 循环)——
   机制 6 月在 Mufasa 上被证明过,但 codex 二进制/环境自那以后有升级,需按协议重证。

**Sources**: 全部一手真机取证(tmux ls / launchctl list + print-disabled / plist plutil -p /
state-dir mtime / wrapper+launcher+template 源码 / tui-window.ts + codex-lead-tui-runtime.ts
/ qa-report-r2r3.md §范围)。
