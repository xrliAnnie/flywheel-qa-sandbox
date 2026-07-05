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
