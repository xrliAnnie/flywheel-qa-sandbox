# FLY-929 Profile 自动切换启用 + 通知迁移 — 探索

Issue: FLY-929 (https://linear.app/geoforge3d/issue/FLY-929/profile-自动切换-通知迁移-claude-infra-bot-fly-915)
日期: 2026-07-07
基于: product/doc/FLY-915-infra-alerts-pipeline/prd.md(§6 / §7 / §10.0 CMP-3 / CMP-4)、engineering/doc/FLY-696-account-self-heal/plan.md

---

## 1. 问题定义

FLY-915 PRD 拆出的 eng issue ③,两个 workstream:

- **W6 · 启用 Claude 额度自动切换**:FLY-696 M1 切换机器(检测 → 排队 → flock+CAS 切 Keychain → 通知)已 merged(PR #439),但 **dormant** —— flag 未开、账号池未 provision。本 issue = 真正启用 + 把通知体验对齐 PRD(成功静默进通知频道、失败进告警频道工单)。
- **W3b · 通知迁移**:token report / 系统重启 / 账号轮转三类全局通知,现在由 Simba(或任意 lead token)发、落点混乱(core 频道 / alerts 频道)。全部改由 **Claude Infra Bot** 发、进 **#flywheel-notify**;Simba 退出所有 Flywheel 全局发送;加自我健康检查治「静默失败」。

**Non-goals**:FLY-925 的 env quick-fix(FLYWHEEL_BRIDGE_URL / STANDUP_PROJECT_NAME,单独 issue 先行);FLY-927 的工单状态机 / @-target 门禁 / 速率兜底;FLY-928 的两 bot 部署本身;卡住 session 自动搬账号(D2,v1 不做,follow-up);FLY-727 daily completion digest 频道(独立机制,不属 PRD 列举的 3 sender)。

## 2. 现状审计摘要(细节见 research.md)

| # | 现状 | 问题 |
|---|---|---|
| self-heal 机器 | FLY-696 M1 全部 merged,`FLYWHEEL_ACCOUNT_SELF_HEAL` / `FLYWHEEL_CLAUDE_PROFILE_BIN` 生产未设,`~/.flywheel/claude-profiles/` 池未 provision | dormant,Annie 仍手动切 |
| Codex Infra Bot | FLY-871 代码 merged,Discord 身份已配(`CODEX_INFRA_BOT_TOKEN` 等在 .env),launchd **未装**(未跑) | 部署 = FLY-928 W4,不在本 issue |
| 切换/轮转通知 | 成功、失败、Codex 轮转全部贴 **alerts 频道**(`alertDiscordOps.postToThread(unifiedAlertChannelId, …)`) | PRD 要成功 → notify 频道(不 @) |
| ① token report | launchd 00:30 → `token-usage-daily.sh` → Bridge `/api/reports`,sender = `DISCORD_BOT_TOKEN`(=Simba) | sender 要换;实际发出还依赖 FLY-925 补 `FLYWHEEL_BRIDGE_URL` |
| ② 重启通知 | `restart-services.sh` + `update-flywheel.sh` 的 `NOTIFY_BOT_TOKEN=SIMBA_BOT_TOKEN` → **core 频道** | sender + 落点都要换 |
| ③ standup | Bridge `StandupService`,sender = 任一非-CoS lead token(FLY-71 约束:发送方 ≠ Simba,Simba 才能收到 MESSAGE_CREATE 触发 triage) | sender 换 Claude Infra Bot(天然非-CoS,约束保留);频道不变 |
| 静默失败 | token report publish 失败只进 /tmp/*.err;standup 404 | 需自我健康检查 |

## 3. 方案选型

### 3.1 迁移形态:env-keyed 字节兼容 dormant merge(选定)

**A(选定)· env-keyed**:新增两个 env 契约 —— `CLAUDE_INFRA_BOT_TOKEN`(Claude Infra Bot 的 Discord token,FLY-928 W5 provision 后填入)+ `FLYWHEEL_NOTIFY_CHANNEL`(= `1521630422918758472`,A2 已定复用 token-usage 频道)。**env 未设 = 逐字现状**(reverse-compat sentinel 可测);设了 = 新 sender / 新落点。929 代码可先 merge、dormant 等 enable 窗,不被 FLY-928 排期阻塞。

**B(否)· 硬切换**:直接把 sender 换掉。缺点:merge 即生效,928 未 land 时 token 不存在 → 通知全断;违背项目 byte-compat 惯例。

**C(否)· 等 928 land 再开工**:串行浪费;929 的代码面(路由、receipt、脚本)与 bot 是否存在无关。

**无 Simba 静默回落**:env 设了之后发送失败 → fail-loud(由自我健康检查兜),**不**回落 Simba —— 静默回落会掩盖「Simba 绝不再发」铁律被破坏。env 没设(迁移前)= 现状,是显式的迁移前状态而非回落。

### 3.2 通知节奏(B3 解释,Tadashi 已拍)

token report 保持每日 00:30;**轮转 / 重启通知事件驱动即时发**(不 @、天然低频),不建聚合队列。「严格全攒一条日报」= 过度工程 + 信息延迟;§9 B3 的「每日 1 次」指例行汇总类(token report)的节奏,「真紧急项不走 digest」的对仗对象是告警工单。

### 3.3 W6 成功通知 = 纯增量双落点

切换成功 / 轮转成功:**现有 alerts 贴帖 100% 不动**(它是 CH-1 工单生命周期的「处理记录」,927 会把它演进成结构化状态更新)+ **新增**一条 digest 到 #flywheel-notify(Claude Infra Bot 发、不 @)。纯增量 → 零回归风险,同时满足 CMP-3「成功 = notify digest」与 CH-1「安静 resolve 留处理记录」。

### 3.4 W6 失败路径 = 落 alerts + @ 对 owner,不重建工单状态机

失败 / 全封顶:现有 needs_human 贴帖继续落 alerts;env 设了之后帖子文本**追加 `<@FLYWHEEL_INFRA_BOT_USER_ID>` mention**(交叉规则:Claude 账号问题 @ Codex bot)——这个 mention 就是唤醒 Codex Infra Bot 进 ARC 的功能性触发(FLY-871 的 mention-gated 入站)。T2(修不掉判定 2 次/5 分)判定与工单状态机属 FLY-927 + bot playbook;927 未 land 时失败路径 = 现状 needs_human alert(可接受降级,Tadashi 拍)。

### 3.5 自我健康检查:两层

- **(a) 就地 fail-loud**:`token-usage-daily.sh` 聚合/publish 失败 → 经 `lead-alert.sh`(FLY-368 shell 兜底路径,带 claims 去重)发一条告警工单。治「跑了但发挂了」。
- **(b) Bridge 侧期望回执**:`/api/reports` 成功投递时写回执;Bridge piggyback 现有 poll cadence(零新 timer)检查「到点(默认 01:00 本地)当日 token report 无回执」→ 发一条告警(claims 去重,每日至多一条)。治「根本没跑 / 00:30 时 Bridge 或机器不在」。opt-in env `FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`,enable 窗才开。

### 3.6 severe_alert 路径不动(Tadashi 点 4 的引申)

`flywheel-bridge-wrapper.sh` 的 Bridge 死机 🚨 **不碰**(Tadashi:最后防线必须走最久经考验路径,新 token 配错 = 死机告警静默失败 = 最糟形态;927 统一发送方门禁时带 fallback 再换)。同理引申:`restart-services.sh` / `update-flywheel.sh` 的 `severe_alert()`(部署失败要人救)也保留现有 token/落点,只迁移**例行**重启/部署通知。

## 4. Tadashi 拍板记录(brainstorm gate,2026-07-07)

1. B3 解释 ✅(§3.2)。
2. **929 定契约(`CLAUDE_INFRA_BOT_TOKEN` 名)、928 照用;enable 窗归 929 一次执行**(一个 enable 窗、一次 founder 打扰);928 只交付 bot 可部署/部署。
3. T2 归 927 工单生命周期;929 只保证失败落 alerts + @ 对 owner;927 未 land 时 needs_human 降级可接受(927 同期在跑,接缝正确)。
4. bridge-wrapper 🚨 **留给 927 统一治,不顺手换**。

## 5. 依赖与边界

- **W3b 生效依赖 FLY-928 W5**(Claude Infra Bot 存在、token 进 .env)——代码可先 merge(dormant),enable 窗在 928 之后。
- **token report 真发出去依赖 FLY-925**(`FLYWHEEL_BRIDGE_URL`);929 不重做。
- **W6 enable 依赖 FLY-928 W4**(Codex Infra Bot 部署,失败工单才有人 ARC)——但 flag 翻转 + FLY-696 §8 真机 QA 归 929 的 enable 窗一次执行。
- **enable 窗 = founder-gated 运维窗**:provision 账号池(Annie 逐账号登录 + capture)→ 设 env → 重启 Bridge(按 batch 惯例)→ §8 真机 QA(红线:绝不弄坏 claude 登录)→ 注入演练 → Annie GO。
- 卡住 session 不自动搬(D2)= 已知边界,列 follow-up。
