# FLY-929 Profile 自动切换启用 + 通知迁移 — 实施计划

Issue: FLY-929 (https://linear.app/geoforge3d/issue/FLY-929/profile-自动切换-通知迁移-claude-infra-bot-fly-915)
日期: 2026-07-07
基于: research.md

> 版本:v1.5x(暂定,ship 取空号,PR 时按当时 doc/VERSION 定)。Rev 2(Codex design review R1 五项全采纳)。
> 形态:**env-keyed 字节兼容 dormant merge**,两个显式激活谓词(缺一即 dormant,逐字现状):
> - **P-identity(W3b/W6 通知面)**:`CLAUDE_INFRA_BOT_TOKEN` **与** `FLYWHEEL_NOTIFY_CHANNEL` **同时**存在。只设 token(FLY-928 可能先写入 .env)或只设 channel 都 = dormant —— `FLYWHEEL_NOTIFY_CHANNEL` 只在 §6 enable 窗写入,是 W3b 的实际开关。
> - **P-expect(自我健康检查面)**:`FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`。回执写入、期望检查、token-usage-daily.sh fail-loud **全部**挂在它之下(未设 = 零新文件、零新告警、脚本失败行为逐字现状)。
> Tadashi brainstorm gate 4 点拍板见 exploration.md §4;T2 判定 / 工单状态机 / 发送方门禁 = FLY-927,bot 部署 = FLY-928,env quick-fix = FLY-925,均不在本 PR。

---

## 1. 目标(验收即此)

1. **W3b**:P-identity 满足时 —— ① `/api/reports` 投递 sender = Claude Infra Bot;② `restart-services.sh` **例行**通知(✅/🔄/⏳ 类)sender = Claude Infra Bot、落 #flywheel-notify(⚠️/🚨/severe_alert 不动;`update-flywheel.sh` 无例行调用点,零改动);③ standup sender = Claude Infra Bot(FLY-71 非-CoS 约束保留,频道不变)。Simba 从这三处全局发送退出。
2. **W6 通知体验**:切换/轮转**真成功** → 追发一条 digest 到 #flywheel-notify(Claude Infra Bot 发、不 @;alerts 处理记录不动);**失败/全封顶**(accountLimit 类 needs_human)→ 由「立即 founder 升级」改为 **owner-bot assignment mention**(`<@FLYWHEEL_INFRA_BOT_USER_ID>` 交叉 owner + T2 提示文本),bot playbook 承接最终 @Annie 升级(至 927 接管)。
3. **自我健康检查**(P-expect 之下):(a) `token-usage-daily.sh` 失败就地经 `lead-alert.sh` 发 `notify_digest_failed` 告警;(b) Bridge 期望回执检查 —— 到点无当日回执 → 每期望日至多一条告警。
4. **W6 enable**:交付 enable 运维 runbook(§6)+ FLY-696 §8 真机 QA 执行清单;flag 翻转本身发生在 enable 窗,不在 merge。

## 2. 工作分解(TDD,RED → GREEN → REFACTOR)

### M-A · Bridge 侧身份收口 + sender 迁移(TS)

**A1 · `resolveInfraNotifyIdentity()` helper(唯一激活谓词 P-identity)**
- 新文件 `packages/teamlead/src/bridge/infra-notify.ts`:
  - `resolveInfraNotifyIdentity(env = process.env): { botToken: string; notifyChannelId: string } | undefined` —— `CLAUDE_INFRA_BOT_TOKEN` 与 `FLYWHEEL_NOTIFY_CHANNEL` **两 env 齐才返回**,缺任一 → `undefined`(= dormant)。
  - **没有** token-only 的 sender helper(Codex R1#1):reports / standup / digest / mention 一律用同一个 P-identity 谓词,防「928 先写 token 进 .env → 迁移提前生效」。
- 单测:全排列(都设 / 只 token / 只 channel / 都缺),断言只有「都设」返回身份。

**A2 · ① reports sender**
- `plugin.ts:2559`:`discordBotToken: resolveInfraNotifyIdentity()?.botToken ?? opts?.globalBotToken`。
- P-identity 满足后**无 Simba 回落**语义由部署达成(token 常驻 .env);投递失败 → 502 照旧 + 由 P-expect 回执检查兜。
- 测:reports-route 现有测试加三条 —— P-identity 满足 → 用 infra token;只 token / 全不设 → 用 globalBotToken(reverse-compat)。

**A3 · ③ standup sender**
- `plugin.ts:3055`:`const standupBotToken = resolveInfraNotifyIdentity()?.botToken ?? standupSenderLead?.botToken ?? standupLead?.botToken;`
- 断言注释保留 FLY-71 理由(infra bot 非 CoS → Simba 仍收到 MESSAGE_CREATE)。
- 测:P-identity 满足 → infra token;只 token / 不设 → 原 fallback 链逐字不变。

**A4 · W6 成功 digest(纯增量)**
- `account-switch-repair.ts`:`RepairDisposition` 增可选 `notifySuccess?: { from?: string; to: string }` —— 仅 `SwitchResult.outcome === "switched"` 时填(noop / no_account / failed 不填)。
- **投递 seam(Codex R1#3 修正)**:notify digest 用现有 `postDiscordMessageToChannel()` helper(`discord-utils.ts`,`/api/reports` 同款),**不**给 `DiscordOps` 发明 `postToChannel`;token = `resolveInfraNotifyIdentity().botToken`。
- `plugin.ts` 三个贴帖位点(watchdog `post`、`/api/account-switch` `postResult`、`accountRotationPostHolder`)之后追加成功 digest:
  - 切换:P-identity 满足且 `notifySuccess` 存在 → 发「🟡 Claude 账号已切 X→Y(scope reset …);新 session 用新账号,当前卡住 session 等 reset(v1 不搬)」。**不含任何 @**。
  - 轮转:**`accountRotationPostHolder` 类型加宽**(Codex R1#3)—— `current?: (detail: string, rotation?: { provider; from?; to; reason?; resetAt? }) => Promise<void>`,event-route(`event-route.ts` `account_rotation` 分支)把结构化 payload 一并传入,digest 从结构化数据组文案(「🔁 Codex 账号轮转 from→to(reason,reset …)」),不反解析人类文本。现有只传 detail 的调用零破坏(第二参可选)。
  - notify 投递失败 → log + 不影响 alerts 记录(alerts 是权威处理记录;digest best-effort,token report 由 P-expect 兜,轮转/切换 digest 丢失可接受、有 alerts 记录)。
- 测:switched → alerts 原帖不变 + notify 收到 digest;noop → 无 digest;rotation → 结构化组文案;P-identity 缺 → 三位点逐字现状(sentinel)。

**A5 · W6 失败工单 → owner bot mention(Codex R1#2:现有代码 needs_human 直通 founder,必须显式改路由)**
- 现状(Codex 核实):`AutoRepairBot.canAttempt()` 对「切换不可用 / 无可用账号」返回 false(`AutoRepairBot.ts:119-123`),`usage_limit` 分支返回通用 `needs_human` 不 enqueue(`:139-156`);`AlertChannelHub` 把任何 `needs_human` 变成 **founder 升级**(`AlertChannelHub.ts:302-311`);已存在的 infra-bot assignment mention 只覆盖**成功 enqueue** 路径(`:314-326`)。
- 改动:`usage_limit` 且 `accountLimit` 元数据存在(= Claude 账号封顶类)的 needs-human 路由,在 **self-heal on + P-identity 满足 + `FLYWHEEL_INFRA_BOT_USER_ID` 存在** 时 → 产出 **owner-bot assignment/mention 帖**(复用 `:314-326` 的 assignment 措辞模式:`<@…> 请认领(ARC;修不掉判定 = 重试 2 次或 5 分钟,T2)`),**替代**立即 founder 升级;bot 自身 playbook(FLY-871:重试仍败 → @Annie 停手)承接向 founder 的最终升级,直至 FLY-927 的工单状态机接管 T2。
- 覆盖三个失败形态:executor `no_account`(全封顶)、executor `failed`(切换失败)、not-attemptable(pool/bin 不可用)。
- 任一前置 env 缺(含 self-heal off)→ **逐字现状**(founder 升级不变,byte-compat)。§6 enable 窗顺序保证 mention 出现时 Codex Infra Bot 已部署(928 W4 是步 0 前置)。
- 测:no_account / failed / not-attemptable 三形态 × env 齐(→ owner mention、无立即 founder 升级)× env 缺(→ 原 founder 升级);非 accountLimit 的 usage_limit / 其他 kind 的 needs_human 路由零变化。

### M-B · 回执 + 期望检查(TS)

**B1 · 回执写入(全部挂 P-expect 之下)**
- **日期契约(Codex R1#5)**:`token-report daily` CLI(`packages/token-usage/src/cli.ts:201-228`,按 `TOKEN_USAGE_TIMEZONE` 算「昨天」)是日期权威 —— `publish-report` 调用 `/api/reports/deliver` 时 body 增可选 `kind: "token_report"` + `expectedDate: "YYYY-MM-DD"`(由 CLI 侧按报告时区算好传入,Bridge **不**用自己的 env 重算,防 plist/进程 tz 漂移)。两字段可选 → 现有调用零破坏。
- `reports-route.ts`:投递 2xx 且 `kind === "token_report"` 且 **P-expect 满足**时,写 `~/.flywheel/notify-receipts.json`(路径 env `FLYWHEEL_NOTIFY_RECEIPTS_PATH` 可覆盖,测试用):`{ "token_report": { "date": expectedDate, "ts": ISO, "messageId": … } }`。temp+rename 原子写;写失败 log 不阻塞响应。P-expect 未设 → **零文件系统副作用**(Codex R1#1)。

**B2 · 期望检查 watchdog**
- 新 `packages/teamlead/src/bridge/notify-digest-expect.ts`:
  - 共享 `localDate(now, tz): "YYYY-MM-DD"` helper(检查侧与测试共用;CLI 侧日期语义以 §B1 传入值为准)。
  - `notifyDigestExpectTick({ now, tz, receiptsPath, alert })` —— 纯函数决策 + 注入副作用,`FLYWHEEL_NOTIFY_DIGEST_EXPECT === "1"` 才活;本地(报告时区)时间 ≥ 01:00 且回执里 `token_report.date !== localDate(now, tz)` 前一日应发日期 → `alert(…)` 一次。**注**:00:30 发的是「昨天」的报告,到点检查的期望日期 = 回执 date 是否等于「今天以报告时区算的昨天」;边界用测试锁死。
- **告警身份契约(Codex R1#5)**:`project = flywheel`、`lead = codex-infra-bot-lead`、`kind = notify_digest_failed`、`eventId = notify_digest_failed:<期望日期>` —— 经 LeadAlertNotifier claims 表去重(与 lead-alert.sh 同表)→ 每期望日至多一条,重复 tick 不重发。
- 接线:piggyback 现有 `onPollComplete`(与 FLY-696 account-switch watchdog 同位点,**零新 timer**)。
- 读回执失败(损坏/缺失)按「无回执」处理(宁可多一条经去重的告警)。
- 测:回执在(日期对)→ 安静;无回执/日期不对 + 到点 → 恰一条(重复 tick 不重复);< 01:00 → 安静;P-expect 不设 → 完全不跑 + 零副作用(sentinel);UTC-vs-LA 跨日边界(23:xx UTC ≠ 本地新一天)两向。

### M-C · 脚本迁移(bash)

**C1 · `restart-services.sh` call-site 分类迁移(Codex R1#4);`update-flywheel.sh` 零改动**
- **机械分类规则**:消息前缀 ✅ / 🔄 / ⏳(纯进度/结果,无需人介入)= `notify_routine` → P-identity 满足时发 infra token → `FLYWHEEL_NOTIFY_CHANNEL`,否则逐字现状;前缀 ⚠️ / 🚨 及一切经 `severe_alert()` 的 = `legacy_alert` → **一字不动**(Simba → core;Tadashi 点 4 引申:要人看/要人救的信号不换新 token)。
- **restart-services.sh call-site 表**(实现时照此逐条改,新增 `notify_routine()` helper,`notify_discord()` 本体不动):

| 行(现状) | 消息 | 分类 |
|---|---|---|
| :570 | ⏳ 等待 active session idle 进度 | routine |
| :1109 | 🔄 开始更新 X→Y | routine |
| :1190 | ✅ 已更新到 X,重启了 … | routine |
| :1200 | 🔄 Lead 重启中 | routine |
| :1223 | ✅ Lead 重启完成 | routine |
| :185/:192(plugin 更新失败)、:585(idle 超时强制)、:818/:831/:882(lead 重启失败类)、:1051/:1060/:1098/:1119(🚨 手动介入)、:1095/:1170/:1179/:1212/:1220(⚠️ 部分失败/回滚结果)、:604+:1076/:1093(severe_alert) | 全部 ⚠️/🚨 | **legacy,不动** |

- **`update-flywheel.sh` 零改动**(审计:其 notify_discord 调用点只有 severe_alert(:140/:157),无例行通知 → 无迁移对象;记录在案防实现者误扩)。
- 测:`scripts/__tests__/` bash harness —— routine 位点 env 齐/不齐两态的 token+channel 选择(至少覆盖 :570 进度、:1190 成功两类);legacy 位点(lead 重启失败、回滚失败、severe)两态下逐字不变。

**C2 · `token-usage-daily.sh` fail-loud(挂 P-expect 之下,Codex R1#1)**
- **仅当 `FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`**(脚本已 source ~/.flywheel/.env,读得到):聚合或 publish 步骤失败(退出码非零)→ trap/显式分支调 `scripts/lead-alert.sh --lead codex-infra-bot-lead --project flywheel --kind notify_digest_failed --severity warning --title "token report 发送失败" --body "<步骤+退出码+日志路径>"`(best-effort,`|| true`,绝不吞原退出码)。P-expect 未设 → 失败行为逐字现状(退出+stderr)。
- `lead-alert.sh`:kind 白名单加 `notify_digest_failed`(一行);Bridge 侧 `LeadAlertNotifier` kind 枚举若为闭集则同步加(查实现,若开放字符串则免)。
- 测:lead-alert.sh 白名单单测(现有 shell 测试模式);token-usage-daily.sh 失败分支注入(fake COMM 非零)× P-expect 两态 → 设了断言 lead-alert 被调 + 原退出码保留;未设断言零 lead-alert 调用。

### M-D · 文档 + sentinel 收口

- **reverse-compat sentinel 测试**(单独文件,与 FLY-696 `account-selfheal-bytecompat.test.ts` 同款):覆盖 **全不设 / 只 token / 只 channel** 三态(Codex R1#1)→ reports sender / standup token / 三个贴帖位点 / needs_human founder 升级 / 脚本解析 / expect-tick+回执 全部逐字现状、零新文件副作用。
- enable runbook(§6)落 `engineering/doc/FLY-929-profile-autoswitch-notify-migration/enable-runbook.md`(实现阶段产出,含 §8 QA 清单映射)。
- 归档:merge 时本文件夹三文档按 doc-flow 随分支带走;CLAUDE.md 里程碑行 + MEMORY 更新按惯例在 ship 后。

### 2.1 实现期 caveat(Codex R2 随批注,非阻塞,实现时守住)

1. **expectedDate 交接要在代码里显式**:`token-report daily` 内部算 `reportDay`,`token-usage-daily.sh` 分两条命令调 token-report 与 publish-report —— 实现时加一条**有测试的 CLI/脚本 seam**(如 `publish-report --kind token_report --expected-date "$expectedDate"`,日期来自 token-report CLI 输出或共享 helper),Bridge 只消费传入日期、**绝不自算**。
2. **A5 保持窄**:needs_human 面很宽 —— 补**负向测试**:非 accountLimit 的 `usage_limit`、`rate_limit`、`login_expired`、通用 AutoRepairBot needs_human 的 founder 升级路径逐字不变。
3. code review 时验证 sentinel 真覆盖 all-unset / token-only / channel-only 三态;P-expect 未设时真·零回执文件 + 零 lead-alert 调用。

## 3. 契约与数据变更汇总

- 新 env:`CLAUDE_INFRA_BOT_TOKEN` + `FLYWHEEL_NOTIFY_CHANNEL`(合成 **P-identity**,两者齐才激活迁移面)、`FLYWHEEL_NOTIFY_DIGEST_EXPECT`(**P-expect**,健康检查面)、(测试用)`FLYWHEEL_NOTIFY_RECEIPTS_PATH`。**全部 opt-in,默认字节兼容;单设任一 = 仍 dormant。**
- `RepairDisposition` 增可选 `notifySuccess`(向后兼容,现有消费者忽略)。
- `accountRotationPostHolder.current` 类型加宽:第二可选参数带结构化 rotation payload(现有调用零破坏)。
- `usage_limit`+`accountLimit` 的 needs_human 路由:前置 env 齐时由 founder 升级改为 owner-bot assignment mention(A5;env 缺 = 现状)。
- publish-report → `/api/reports/deliver` body 增可选 `kind` + `expectedDate`(不传 = 现状零回执;日期由 token-report CLI 按 `TOKEN_USAGE_TIMEZONE` 算好传入)。
- 新文件:`~/.flywheel/notify-receipts.json`(Bridge 单写者,原子写,仅 P-expect 下产生)。
- `lead-alert.sh` kind 白名单 + `notify_digest_failed`。
- **不动**:`flywheel-bridge-wrapper.sh`、`update-flywheel.sh`、severe_alert 与一切 ⚠️/🚨 legacy 告警路径、`FLYWHEEL_TOKEN_USAGE_CHANNEL`、alerts 频道成功/记录类贴帖内容、FLY-696 切换机器核心(`switch-executor` / `usage-gauge` / 529 守卫零触碰)、`DiscordOps` 接口(不加 postToChannel,复用 `postDiscordMessageToChannel()`)。

## 4. 测试策略

- 单测/集成如 §2 各条;全部跑 `packages/teamlead/` 内(better-sqlite3 resolver 惯例)+ flywheel-comm 侧(publish-report kind 字段)。
- lint + tsc-strict 全仓;bash 测试走 `scripts/__tests__/` 现有 harness。
- **独立 QA(真机,gate ship;由独立 QA runner 执行,非本 runner)**:
  1. env 全不设 → 抓生产同款路径输出对照(byte-compat 铁证)。
  2. env 齐(隔离频道/QA Room)→ ①②③ sender 真发:reports 投递消息作者 = infra bot id;restart 例行通知落 notify 频道;standup 消息作者 = infra bot 且 Simba 侧可见(FLY-71 语义)。
  3. 注入 switched → notify 频道收到 digest 且 alerts 记录不变;注入 no_account/failed(env 齐)→ owner-bot mention 出现且**无**立即 founder 升级;同注入 env 缺 → 原 founder 升级(byte-compat 铁证)。
  4. 回执:正常日安静;删回执 + 拨时钟(注入 now)→ 恰一条告警,再 tick 不重复。
  5. **enable 窗 QA(§6 内,founder 在场)**:FLY-696 §8 M1 项(红线「绝不弄坏 claude 登录」、529 不误切、双触发幂等等 1-13、16)—— 这些验证的是已 merged 的 696 机器,929 只是执行窗。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| infra bot 对某频道无发言权限 → 静默失败 | enable 窗 verify 步骤真发探活消息(§6 步 4);投递失败 fail-loud 进 (a)/(b) 检查 |
| digest 与 alerts 双发被误读为重复 | digest 文案与 alerts 处理记录措辞区分(digest 面向 Annie 的结果句,alerts 面向 bot 的工单记录);927 落地后 alerts 侧转结构化状态 |
| 927/928 排期漂移 | 本 PR dormant merge 不依赖;enable 窗 checklist 显式列前置(§6 步 0) |
| noop/失败误发 digest | `notifySuccess` 只在真 switched 填,测试锁死 |
| 回执文件竞写 | 单写者 = Bridge 进程;temp+rename 原子写 |

## 6. Enable 运维窗(founder-gated,merge 后、独立于本 PR 的 ship)

前置(步 0):FLY-925 merged(BRIDGE_URL/STANDUP_PROJECT_NAME 已补)、FLY-928 W5 done(Claude Infra Bot 存在、token 到手)、FLY-928 W4 done(Codex Infra Bot launchd 已装,失败工单有人 ARC)、本 PR merged + 生产 git pull + build。

1. **provision 账号池**(Annie 在场):逐 Claude 账号浏览器登录 → `flywheel-claude-profile capture <name>`;`flywheel-claude-profile status` 核对池 + 活跃账号。
2. **写 env**(编辑在重启**之前** —— launchd KeepAlive 教训):`~/.flywheel/.env` 加 `FLYWHEEL_ACCOUNT_SELF_HEAL=1`、`FLYWHEEL_CLAUDE_PROFILE_BIN=<repo>/packages/claude-runner/bin/flywheel-claude-profile`、`CLAUDE_INFRA_BOT_TOKEN=…`(如 928 已写则核对)、`FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472`、`FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`。**注**:`FLYWHEEL_NOTIFY_CHANNEL` 是 W3b 的实际开关(P-identity 第二半),**只在本窗写入** —— 928 提前写 token 不会激活任何迁移面。
3. **重启 Bridge**(按 batch 惯例,与其他待 ship PR 攒一次)。
4. **verify 探活**:以 infra 身份向 notify / alerts / STANDUP_CHANNEL 各发一条探活(失败 = 权限缺,回 928 invite 清单补)。
5. **FLY-696 §8 真机 QA**(独立 QA runner + Annie 红线确认):注入 5h cap → 真切换 + Keychain verify + 登录不坏;529 → 不切;全封顶 → alerts 工单 + mention;成功 → notify digest。
6. **注入演练**(端到端一次):模拟封顶 → 观察 静默切换 → digest → 新 session 新账号。
7. **Annie GO** → 观察期(首个自然日核对 00:30 token report 由 infra bot 发出 + 回执落盘)。

回滚:任一步失败 → 移除 `FLYWHEEL_ACCOUNT_SELF_HEAL`(或全部新 env)→ 重启 Bridge = 逐字回到现状;Keychain 侧 fail-closed + verify-before-commit 保证登录不被写坏(FLY-696 红线机制)。

## 7. 交付物清单(实现阶段)

- [ ] M-A:`infra-notify.ts`(P-identity)+ reports/standup sender 接线 + 成功 digest 三位点(A4,含 rotation holder 加宽)+ 失败 owner 路由(A5,AutoRepairBot/AlertChannelHub)+ 单测
- [ ] M-B:kind/expectedDate 契约 + 回执写入 + `notify-digest-expect.ts`(localDate helper + 告警身份契约)+ onPollComplete 接线 + claims 去重 + 单测
- [ ] M-C:restart-services.sh call-site 表迁移(update-flywheel.sh 零改动)+ token-usage-daily fail-loud(P-expect 下)+ lead-alert kind + bash 测
- [ ] M-D:reverse-compat sentinel + enable-runbook.md
- [ ] Codex code review → PR(hold 等 batch,不 self-ship)→ 独立真机 QA(§4)→ founder-gated enable 窗(§6)
