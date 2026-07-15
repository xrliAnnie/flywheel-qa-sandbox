# FLY-871 Codex 救援 Bot(看/切/救 + token 保鲜)— 探索

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-04
基于: 无(上游语境 = engineering/doc/FLY-696-account-self-heal/plan.md + FLY-865)

---

## 1. 问题定义

FLY-696 定稿的交叉自愈架构:Alerts channel 常驻两个高权限 Infra Bot(Codex-Bot + Claude-Bot),谁都不自己修自己。本 issue = **Codex-Bot 半边**(看/切/救 Claude 侧)+ **token 新鲜度守卫**(2026-07-04 logout 事故的根治)。

**三件事**:
1. **看**:监控 4 个 Claude 账号(personal/school/business/shopping)的 5h/weekly 额度 + reset 日 + auth 健康;监控 live Claude session 活性(登录态/被踢)。
2. **切**:执行 696 的切换逻辑(只在真·cap 才切;5h 临时切走、weekly 切最近 reset;**切前必须验证目标池 token 新鲜可用**,验证失败不切+告警)。
3. **救**:发现被踢出登录的 session → 自动重启读新 Keychain 自愈(lead=launchd kickstart;runner=tmux respawn+resume);救不动才 @Annie。

**硬前置**:`FLYWHEEL_ACCOUNT_SELF_HEAL` 保持 OFF 直到本 bot + 保鲜守卫就位(Annie 拍板 enable)。

## 2. 代码库审计结论(先审计再设计)

### 2.1 已有的(FLY-696 M1 + FLY-865,均已 merge)
- **机械切换机器全套**(`packages/teamlead/src/account-heal/`,12 个模块):`parseUsageGauge`(5h/weekly 解析)、`selectNextAccount`(最大化 quota 选择)、`switchAccount` executor(flock+CAS+generation+fail-closed)、durable `account_switch_pending`(**含 `claimPending(botId)` 接口,为 bot 预留**)、watchdog 兜底(30s piggyback)、`RunnerQuotaDetector`(仅 quota)。
- **`flywheel-claude-profile` bash**(557 行):`use` = `security -i` 无 argv 泄密写 Keychain + 字节 roundtrip verify-before-commit + 回滚;`capture` 落 pool;FLY-865 的 oauthAccount 显示身份同步。
- **账号池已 provision**:`~/.flywheel/claude-profiles/{business,personal,school,shopping}`(今天 15:52-15:58 事故后 Annie 重建),凭据结构 `claudeAiOauth:{accessToken, expiresAt, rateLimitTier, refreshToken, scopes, subscriptionType}`。
- **account-store 的 authExpired 字段族已定义但无人写入**(M3 占位);`selectNextAccount` 已会跳过 auth-unusable 账号。
- **Alerts 基建**(FLY-368):`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` + AlertChannelHub 线程化;`LeadWatchdog` 已分类 `login_expired`(severe)。
- **Codex Lead 部署机制全套**(FLY-350/398/224):windowed TUI full-access launcher(Mufasa 模板 `run-codex-lead-mufasa-tui-fullaccess.sh`)、launchd 收编、隔离 CODEX_HOME、Discord RestPoll 入站 + direct 出站、founder-only-authority 合同。**FLY-398 硬规则:生产 Codex lead/runner 必须 windowed TUI,绝不 headless。**

### 2.2 缺的(= 本 issue 要建的)
- **C8b 专用 `/account-switch` 路由未建**(696 plan 设计了,M1 只建了 watchdog 直连路径)→ bot 没有认领切换的入口。
- **token 保鲜守卫完全缺失** —— 事故根因,见 §3。
- **runner 侧 login-expired 检测缺失**(`RunnerQuotaDetector` 只看 quota;lead 侧 `login_expired` 已有)。
- **救援编排完全缺失**:`login_expired` 今天只会 severe 告警等 Annie,没有自动 kickstart/respawn 路径。
- **Codex-Bot 本体不存在**。

### 2.3 事故根因(2026-07-04 logout,代码级)
`flywheel-claude-profile use` 的 verify 只是**字节 roundtrip**(写进 Keychain 的 = 读回来的),不验证凭据对 Anthropic 还活着。而 pool 凭据自 capture 后**静态不动**:
1. 活跃账号的 refresh token 被 live session 持续**轮转**(每次 refresh 旧 token 作废);
2. `use` 切走时**不回捕**当前 Keychain 值进 pool → 该账号的 pool copy 从切走那刻起就是死的;
3. 下次切回 → 把死 token 写进机器级 Keychain → **全机 session 被踢**,Annie 人肉逐个捞。

结构性缺口 = **pool 无保鲜机制 + 切换前无活性验证**。这不是 bot 能"看"出来的问题,必须在切换机器本身修。

## 3. 设计决策点与选项

### D1 — token 新鲜度守卫:放哪、怎么验(⭐ 事故根治核心)

**方案 A(推荐):Bridge/CLI 确定性三层守卫**(不依赖 bot,纯机械)
1. **切走回捕(capture-back-on-switch-away)**:`use` 在写入目标凭据前,先把当前 Keychain 值回捕进 `pool/<.active>/`(同一把 accounts lock 内)。保证被切走的账号 pool copy 新鲜到切换那一刻。
2. **切前活性验证(pre-switch freshness verify)**:对目标 pool 凭据 —— `expiresAt` 未过期 → 直接可用;已过期 → 用 pool 的 refresh token 走 **OAuth refresh**(Claude Code 同款 token 端点 + public client_id),成功 → 新 token **原子写回 pool 再切**(refresh 会轮转,不写回 = 守卫自己制造 stale);失败 → 标 `authExpired` → `selectNextAccount` 换下一个候选;全废 → 不切 + needs_human 告警。**这正是 issue 要求的"验证失败 → 不切 + 告警"。**
3. **定期保鲜巡检(keep-fresh sweep,可后置)**:每日对非活跃账号 probe-refresh 保鲜 + 对活跃账号从 Keychain 回捕。产出 per-account auth 健康信号(喂给"看")。

**核心不对称(事故教训的直接编码)**:**活跃账号绝不从 pool 侧 refresh**(会轮转掉 live session 正在用的 token family = 复刻事故),只允许 Keychain→pool 回捕;**只有非活跃账号**才允许 probe-refresh。

**方案 B**:bot 拉起隔离 CLAUDE_CONFIG_DIR 的 claude 验证目标账号 —— macOS 下 Keychain 优先级不可控、烧额度、慢、不确定。不推荐(研究阶段留验证备注)。

风险(A):OAuth refresh 端点非公开契约(但 = Claude Code 自己走的端点,社区工具广泛使用)。缓解:fail-closed —— refresh 失败只是"不切+告警",绝不写 Keychain;端点变更最坏退化为今天的行为。

### D2 — Codex-Bot 形态与部署

**方案 A(推荐):复用已 ship 的 windowed TUI full-access Codex Lead 机制**(Mufasa 模板)
- launchd 常驻 + `codex resume --remote` TUI pane in cmux(Annie 能看能驾驶,符合 FLY-398 硬规则)+ 隔离 CODEX_HOME + 持久 thread(记忆延续)。
- Discord:自有 bot token,常驻 **Alerts channel**(RestPoll 入站,direct 出站);persona = 精简 infra bot(非聊天 agent)。
- 治理 = founder-only-authority 合同 + main branch protection(与全体 Lead 同款信任模型,Annie 在 FLY-350 已拍 Codex=Claude-equal)。
- 建议命名 **Baymax**(Big Hero 6 医疗救援机器人,与 Tadashi/Aunt Cass/Hiro 同宇宙,职能完全对口)。Annie 定。

**方案 B**:696 plan C8a 原案(窄权 infra-bot profile + FLY-245 gateway/broker 收口)—— 结构更硬但机器 dormant、重;FLY-350 之后 fleet 已实际走 full-access contract-only 路线,C8a 已被时代超越。不推荐 MVP 用,若 Annie 要更硬的结构约束可作 follow-up 收紧。

### D3 — 切:bot 与 Bridge 分工

机械切换**留在 Bridge**(M1 已建、Node 不烧额度、CAS/flock 齐全)。本 issue 补:
- **C8b 专用 fail-closed `/account-switch` 路由**(按 696 plan 已批设计:`TEAMLEAD_API_TOKEN` 必需否则 503、不挂 `/actions`、server-side gating **拒 `actorBackend===provider`**(自修自)、MVP 仅 `provider:"claude"`、idempotency + audit)。
- bot 认领:Alerts 出现 cap 事件 → bot `claimPending` → 调路由执行 → 把过程/结果贴回事件线程。**watchdog 兜底保留**(bot 死了照样切,deadline 后接管)。
- bot 增量价值 = 可观测(Annie 看到谁在处理、进展如何)+ 账号体系外冗余(Claude 全倒时 bot 还活着,能诊断、能贴现场、能 @Annie 给准确情报)。

### D4 — 救:执行路径(需要拍板)

检测:lead = 现成 `login_expired` 分类;runner = 本 issue 补 login-expired pane 检测(扩展现有 runner 扫描,复用 lead 的 pattern);"bad switch 全机踢"= 多 session 同时 `login_expired` 的聚合识别(风暴场景,bot 按 playbook 批量救)。

手段(都是现成机制):
- lead → `launchctl kickstart -k gui/$UID/com.flywheel.lead.<project>-<lead>`;**已知坑**:重启后可能卡 "Resume from summary?" 确认框(memory 有案),救援 playbook 必须带"检测确认框 → 发 Enter 解卡"的后置步骤。
- runner → tmux respawn + FLY-795 restart-resilient resume(progress.md cursor,机制已 ship)。
- 每步:动作前把证据(pane 现场 + 分类结果)贴 Alerts 线程 → 执行 → **验证恢复**(pane 回到健康态)→ 失败重试 1 次 → 仍失败 @Annie。

**执行路径两个选项**:
- **方案 A(推荐):bot 直接执行**(tmux/launchctl,full-access 本来就有),配"证据先行 + 事后验证 + 全程 Alerts 可见"的审计纪律。理由:Annie 愿景原文就是 bot 自动重启;救援本质是需要判断力的 playbook(哪些被踢、什么顺序、有没有救活),路由化会把每种手段都变成一个 Bridge endpoint,重且慢。
- **方案 B:救援也路由化**(Bridge 加 `/rescue-restart`,server-side 校验目标确实 `login_expired` 才执行)—— 结构更硬(bot 永远无法重启健康 session),代价是 Bridge 面扩大 + playbook 灵活性受限。
- 权限边界(两方案共同):只救**确认被踢**的 session;restart-in-place 同身份;绝不 terminate-不-restart;绝不碰健康 session。与 founder-only-authority 的关系:issue 原文已明示授权这条窄自愈路径,合同里加一条 narrow carve-out 写明边界。

### D5 — 看:数据源与产出

- 数据源:`~/.flywheel/claude-accounts.json`(quota/reset/auth 态)+ pending store + Alerts 结构化事件 + keep-fresh 巡检结果 + pane 现场。
- 产出:**事件驱动为主**(cap/切换/被踢时在事件线程实时跟进)+ **每日 1 次状态摘要**(4 账号:active 标记、5h/weekly 态、reset 时间、auth 健康、pool 新鲜度)。刻意低频 —— FLY-220 教训,bot 发言少而准,绝不刷屏。
- reset 日追踪:weeklyResetAt 从 cap 事件学习(696 已做)+ bot 可人工 seed/修正。
- 研究项:Claude Code `/usage` 背后是否有可直接查询的 per-account usage 端点(有 → 非活跃账号也能主动看额度;没有 → 维持事件学习,不阻塞)。

### D6 — 分期(MVP 内部三段,均独立可 ship)

| 段 | 内容 | 为什么先 |
|---|---|---|
| **R1 保鲜守卫** | D1 三层(回捕 + 切前验证 + authExpired 写入;sweep 可并入或后置) | 事故根治;纯 Bridge/bash,不依赖 bot;696 flag 的硬前置之一 |
| **R2 Bot 上线(看+切)** | Codex-Bot 部署(TUI/launchd/Alerts 常驻)+ C8b 路由 + claim + 状态摘要 | flag 的另一半前置;上线后 Annie 实时可见 |
| **R3 救** | runner login-expired 检测 + 救援 playbook(kickstart/respawn+resume + 验证 + 升级) | 依赖 R2 的 bot 本体;单独真机 QA 演练 |

R1+R2 齐 → Annie 可拍板开 `FLYWHEEL_ACCOUNT_SELF_HEAL`。Claude-Bot 反向救 Codex、re-login(696 M3)、"接管所有 infra" = 后续 milestone,不在本 issue。

## 4. Discord 权限

696 已产出 `engineering/doc/FLY-696-account-self-heal/discord-permissions.md`(给 Annie 勾的 ✅ 组:View/Send/History/Threads/Reactions/Embed;慎开组默认不开)。本 issue 直接沿用:给 Codex-Bot 建专用角色,勾 ✅ 组即可,MVP 不需要任何"慎开"权限。

## 5. QA 门(真机,gate ship)

1. **红线:切换绝不写坏登录**(继承 696 §8 #2)+ **stale token 绝不落 Keychain**(新增:注入过期 pool 凭据 → 验证被拦 + 告警 + Keychain 未动)。
2. 回捕正确性:切走后 pool copy == 切走前 Keychain 值。
3. probe-refresh 原子性:refresh 成功 → pool 更新;失败 → pool 原样 + authExpired 标记。
4. bad-switch 演练(隔离 QA slot):注入死凭据场景 → bot 识别风暴 → 救援 playbook 跑通(kickstart + respawn + resume 确认框解卡)→ 恢复验证。
5. bot 真机:Alerts 认领 cap 事件 → 经路由切换 → 线程可见;bot 死 → watchdog 兜底照常。
6. byte-compat:flag off = 现状(696 sentinel 继续绿)。

## 6. 开放问题(gate 里问 Lead/Annie)

1. D4 救援执行路径:bot 直接执行(方案 A)还是路由化(方案 B)?
2. bot 命名 Baymax OK?
3. OAuth refresh 端点直调(D1 方案 A 第 2 层)接受吗?(fail-closed,失败只是不切)
4. R1(纯守卫,无 bot)是否先行单独 ship —— 让 696 flag 的启用条件早日凑齐一半?

## 7. 决策结果(2026-07-04,brainstorm gate 后 Annie 全拍,via flywheel-eng-lead)

1. 救援 = **bot 直接执行**(配合同边界:证据先行 + 全程 Alerts 可见 + 只碰被踢 session)。
2. 命名 = **Codex Infra Bot**(不用 Baymax;将来反向 = Claude Infra Bot —— 按背后模型命名,两个 bot 一目了然,对齐 696 原文 Infra Bot 叫法)。
3. OAuth refresh 端点直调 = 可以(fail-closed)。
4. R1 保鲜守卫**先单独 ship 且优先做**;R2 bot / R3 救随后。
+ Lead 硬要求:「active 账号绝不从 pool 侧 refresh」写成测试断言(→ plan C2)。
