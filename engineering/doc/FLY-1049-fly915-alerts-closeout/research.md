# FLY-1049 FLY-915 alerts 收尾 — 调研

Issue: FLY-1049 (https://linear.app/geoforge3d/issue/FLY-1049/build-fly-915-alerts-收尾先确认-925928-剩余排除已-ship-的-927929)
日期: 2026-07-09
基于: exploration.md

> Tadashi brainstorm gate 已拍(2026-07-09):Q1 统一 enable 窗归 1049,done 定义 = 915 pipeline 生产真跑起来;Q2 **不动 bot 池**(voice QA 在用 + 常驻身份不该 squat 临时池),请 Annie 新建 dedicated bot app,列为 founder 前置项、找她的时机 Tadashi 排;Q3 925/928 fold 进 1049,落地时标 absorbed→关闭;Q4 不走 CASS_BOT_TOKEN 过渡态,等 W5 一步到位。本调研为 plan 提供技术细节。

## 1. 生产现状矩阵(2026-07-09 审计)

### 1.1 launchd job

| Job | 状态 | 证据 |
|---|---|---|
| com.flywheel.token-usage-daily(每日 00:30) | **每晚失败,退出码 1** | `/tmp/flywheel-token-usage-daily.log`:聚合+渲染成功 → publish 报 `FLYWHEEL_BRIDGE_URL (or BRIDGE_URL) environment variable is required`,`delivered:false`,连续多晚含 2026-07-09 |
| com.flywheel.daily-standup(每日 03:00) | **每晚失败,退出码 22** | `/tmp/flywheel-standup.log`:`curl exit 22`(HTTP ≥400)打 `http://localhost:9876/api/standup/trigger`,连续多晚 |
| Codex Infra Bot(任何形态) | **不存在** | launchctl 无 job、LaunchAgents 无 plist、ps/tmux 双向查无进程 |

### 1.2 env 开关(`~/.flywheel/.env`,Bridge wrapper 与两个 job 脚本都 source 它)

| env | 现状 | 归属 | 代码锚点(默认值) |
|---|---|---|---|
| FLYWHEEL_BRIDGE_URL | ❌ 未设 | 925 | `flywheel-comm publish-report` 硬性要求(token report publish 步) |
| STANDUP_PROJECT_NAME | ❌ 未设 | 925 | `plugin.ts:3057-3073`:多项目 setup 未设 → 启动即「Standup disabled」→ trigger 4xx |
| FLYWHEEL_ALERT_ROUTING | ❌ 未设 | 927 启用窗 | `infra-alert-wiring.ts:58`:unset ⇒ pure passthrough |
| FLYWHEEL_ALERT_TICKETS | ❌ 未设 | 927 启用窗 | `infra-alert-wiring.ts:155`:`=== "1"` 才开 |
| FLYWHEEL_ALERT_RATE_PER_MIN | ❌ 未设 | 927 启用窗 | `alert-rate-limiter.ts:70-76`:unset ⇒ 不限流 |
| FLYWHEEL_ALERT_SENDER_TOKEN_ENV | ❌ 未设 | 927 启用窗 | `LeadAlertNotifier.ts:642,861`:unset ⇒ legacy 归因链 |
| FLYWHEEL_CHECKPOINT_WATCHDOG | ❌ 未设 | 927 启用窗 | `gate-poller.ts:1452`:`=== "1"` 才开(配套 `FLYWHEEL_CHECKPOINT_STUCK_MS`,gate-poller.ts:1457,默认 1h) |
| FLYWHEEL_ACCOUNT_SELF_HEAL | ❌ 未设(.env 只有注释头) | 928 W4 / 929 W6 | 整套 871 R2/R3 + 切换机器休眠 |
| FLYWHEEL_CLAUDE_PROFILE_BIN | ❌ 未设 | 929 W6 | enable-runbook 步 2 |
| CLAUDE_INFRA_BOT_TOKEN | ❌ 未设 | 928 W5 产出 | `infra-notify.ts:33`(P-identity 半边) |
| FLYWHEEL_NOTIFY_CHANNEL | ❌ 未设 | 929 enable 窗 | P-identity 另半边;值 = `1521630422918758472`(A2 复用 token-usage 频道) |
| FLYWHEEL_NOTIFY_DIGEST_EXPECT | ❌ 未设 | 929 enable 窗 | P-expect,自我健康检查 |
| FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID | ❌ 未设 | 928 W5 产出 | `ticket-owner-map.ts:28,43`(见 §4.1) |
| CODEX_INFRA_BOT_TOKEN / FLYWHEEL_INFRA_BOT_USER_ID / FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID | ✅ 已设 | 871/W4 身份面 | user id = pool-03 `1523219324561522831` |
| FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID / STANDUP_CHANNEL / STANDUP_LEAD_ID | ✅ 已设 | 现状 | STANDUP_LEAD_ID=`cos-lead` |

### 1.3 bot 池(`~/.flywheel/discord-bot-pool/pool.json`)

6 槽全占:pool-01 Honey Lemon、pool-02 anna、pool-03 codex-infra-bot-lead、pool-04 huddle-note-taker、pool-05 fly545-qa-speaker、pool-06 huddle-orchestrator。→ Tadashi 已拍:**不动池**,Claude Infra Bot 用 Annie 新建的 dedicated bot app。

## 2. FLY-925 修复机制(缺口 A)

### 2.1 token report(FLYWHEEL_BRIDGE_URL)

- `scripts/token-usage-daily.sh` 每次运行都 source `~/.flywheel/.env`(process env wins 语义,脚本头注释 + Codex R1 HIGH 修正);plist 只设 FLYWHEEL_REPO / FLYWHEEL_TOKEN_USAGE_CHANNEL / PATH。
- 修复 = `.env` 追加 `FLYWHEEL_BRIDGE_URL=http://localhost:9876`(Bridge 端口 9876,standup 日志/health 探测同值)。**不需要 Bridge 重启**——下一个 00:30 运行即生效。
- 已验证聚合/渲染/Supabase 持久化全程健康,唯 publish 一步死于缺 env → 单 env 即根治。

### 2.2 standup(STANDUP_PROJECT_NAME)

- `plugin.ts:3057`:`STANDUP_PROJECT_NAME` 必须精确匹配某个 `projects.json` 的 `projectName`;多项目 setup(现有 7 个项目)未设 → Bridge 启动即 disabled,trigger 恒 4xx。
- 正确取值 = **`geoforge3d`**:standup 的 lead 绑定 `STANDUP_LEAD_ID=cos-lead`,而 `cos-lead` 只存在于 geoforge3d 项目(projects.json 实测:geoforge3d -> product-lead/ops-lead/cos-lead);standup 语义(FLY-71)= Simba 触发 GeoForge3D triage。
- **需要一次 Bridge 重启**(启动时 resolve)→ 归入统一 enable 窗的那次重启,不单独重启。
- 929 已 merge 的 standup sender 迁移(P-identity 齐才换 Claude Infra Bot 发送,保留非-CoS 约束)与本修复正交:925 只补 env 让 standup 活过来,当下仍由现 sender 发;W5 上线后同一窗自动切。

### 2.3 验证(issue 原文要求「确认次日真的发出来了」)

- token report:次日 00:30 后查 `/tmp/flywheel-token-usage-daily.log` 出现 `delivered:true` + 频道 `1521630422918758472` 有当日消息。
- standup:enable 窗重启后的次日 03:00 查 `/tmp/flywheel-standup.log` 无 exit 22 + STANDUP_CHANNEL 有消息。
- P-expect 开启后,「该发没发」本身会告警(929 自我健康检查),形成长效防复发。

## 3. FLY-927 启用窗(缺口 E,927 plan §5 步 2-5 原文对齐)

一次性 env 翻转(与其它项同窗、先改 env 再重启,launchd KeepAlive 教训 FLY-193):

```bash
FLYWHEEL_ALERT_ROUTING=1
FLYWHEEL_ALERT_TICKETS=1
FLYWHEEL_ALERT_RATE_PER_MIN=20            # T1 已锁
FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN   # 专用 dispatcher(Q4 跳过 CASS 过渡态;design R1 修正:sender 绝不用 owner bot token,作者≠owner)
FLYWHEEL_CHECKPOINT_WATCHDOG=1            # Watchdog v2(1h 默认阈值)
```

- owner @-target 生效还需 §4.1 的两个 user-id env(缺则 owner 渲染无 ping、不武装 T2 兜底 —— `ticket-owner-map.ts` 头注释,纯配置翻转零回归)。
- ops 项(927 plan 步 3):告警频道 Discord 权限收紧(只给 infra bot + 发送身份 Send)= founder/Lead 动作,写进统一 runbook。
- 927 plan 步 4/5:独立真机 QA(529 Room 注入工单)+ Annie 早报确认项(D1/D2 裁定、runner_stuck founder page 改 T2 后才页)→ 併入统一窗的 QA/GO 清单。

## 4. FLY-928 W5:Claude Infra Bot(缺口 C)

### 4.1 Bridge 侧接缝已就绪(927/929 已 merge,零新代码)

- **owner @-target**:`ticket-owner-map.ts:43` 读 `FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID`(snowflake 校验,unset ⇒ null ⇒ 不 ping);Codex 侧读 `FLYWHEEL_INFRA_BOT_USER_ID`(已设)。铁律已在代码:单 owner、交叉救援、provider 无关默认 Claude bot。
- **通知面(P-identity)**:`infra-notify.ts:33` + `plugin.ts:2606`:`CLAUDE_INFRA_BOT_TOKEN` 与 `FLYWHEEL_NOTIFY_CHANNEL` 齐 → Bridge /api/reports、token report sender 切换;`restart-services.sh:117-126`:notify_routine(✅/🔄/⏳ 例行)走 Claude Infra Bot → #flywheel-notify,⚠️/🚨 人救信号**无条件**留 legacy 链(929 exploration §3.6 决定)。
- **标准 resident Claude lead 启动链**(与 belle 同型):launchd plist → `~/.flywheel/bin/flywheel-lead-wrapper.sh` → `~/.flywheel/manifests/<lead>.json`(字段:leadId/projectDir/projectName/botTokenEnv/model/effort/leadBackend.backendId=claude-code)。manifest 的 `botTokenEnv` 必须指 dedicated env 名(身份顶包教训:掉档到通用 DISCORD_BOT_TOKEN 会冒 Simba 身份)。

### 4.2 要新造的物料(实现阶段交付)

1. **persona** `.lead/claude-infra-bot-lead/identity.md`——镜像 `.lead/codex-infra-bot-lead/identity.md` 的结构(三件事/回帖纪律/边界),职责按 PRD CMP-2:默认主力 owner + Codex 侧账号/auth 交叉救援 + provider 无关问题(runner 卡死/超时/529)+ 唯一发 #flywheel-notify;回帖纪律同款(只回 @自己 的工单 + 私有频道直令;绝不回自己/别人帖;低频)。
2. **projects.json 条目**(flywheel 项目 leads 列表,仿 codex-infra-bot-lead:canSpawnRunners=false、department=infra、alertChannel=统一告警频道、botTokenEnv=CLAUDE_INFRA_BOT_TOKEN)——机器态,写法进 runbook。
3. **launchd 接入**:走 /setup-discord-lead + 标准 lead 安装流(生成 manifest + plist);**access.json allowlist 必配**(教训:bot online 但不回话 = 频道不在 groups)。FLY-398 硬规则:windowed 形态,Annie 能在 cmux 看到。
4. **T3 命名**:占位「Claude Infra Bot」,Annie 定名后 rename(不 block)。

### 4.3 founder 前置项(Tadashi 排时机,runbook 置顶列出)

- Annie 在 Developer Portal **新建 dedicated bot app**(≈1 分钟):拿 token + bot user id;头像用 Claude logo(C6 §2 同例);挂 C6 §1 的可复用 `infra-bot` 角色(Manage Channels/Threads/Webhooks + 基础套装,明确不给 Manage Roles/Server/Admin);邀进 server;加进 #flywheel-alerts、#flywheel-notify(=token-usage 频道)、STANDUP_CHANNEL、自己的私有频道。
- (929 enable 窗)provision Claude 账号池:逐账号浏览器登录 + `flywheel-claude-profile capture`(现状 status 只有 active profile,无池)——需 Annie 在场。
- T3 命名。

## 5. FLY-928 W4:部署 Codex Infra Bot(缺口 B)

物料全在(launcher `packages/teamlead/scripts/run-codex-infra-bot-tui.sh`、plist 模板 `packages/teamlead/scripts/templates/com.flywheel.lead.flywheel-codex-infra-bot-lead.tui.plist`、persona、wrapper `~/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh`、.env 身份三件、projects.json 条目)。剩余 = 照 C6 runbook 执行:装 launchd → `verify-windowed-lead` → 开 self-heal(同窗)→ 注入演练 → Annie GO。零新代码。

## 6. 统一 enable 窗的构成(三份既有 runbook 收敛)

| 来源 | 覆盖 | 状态 |
|---|---|---|
| FLY-871 `C6-infra-bot-deployment.md` | W4 部署步骤 + Discord 权限角色 + 头像 | 已写好,未执行 |
| FLY-929 `enable-runbook.md` | W6 self-heal + W3b 通知迁移 + 探活 + FLY-696 §8 真机 QA + 次日观察 | 已写好,未执行(步 0 前置=925+928) |
| FLY-927 plan §5 步 2-5 | 5 个 alert env + 频道权限收紧 + 529 Room QA + Annie 早报确认 | 未执行 |

收敛原则:**一次 Bridge 重启**吃下全部 env(先改 .env 再重启;重启由 Tadashi 凑批调度);founder 动作前置集中列出;验证探活 fail-loud;回滚 = 移除新 env + 重启 = 逐字现状(全部开关都是 byte-compat 设计)。

## 7. 风险与既有护栏

| 风险 | 护栏 |
|---|---|
| 弄坏 claude 登录(self-heal) | FLY-696 红线机制:Keychain fail-closed + verify-before-commit + 回滚;FLY-865 身份修已 merge |
| 新 sender token 配错静默失活 | 929:⚠️/🚨 无条件走 legacy 链;P-expect 自我健康检查;927:sender fail 路径 = dead-letter + meta-alert |
| Bridge 重启踩 FLY-176 multi-PID bug | 精准杀(FLY-239 已 merge);先改 env 再杀(KeepAlive 教训) |
| 重启把活 issue 线程 archive+lock | 已知 bug(task #117)——runbook 注明重启后检查 |
| 双 bot 抢工单 | 927 mention-gate + 单 owner map 已在代码;persona 回帖纪律镜像 Codex bot |
| 部署效果自证 | 独立 QA 验部署效果(feedback 红线),529 Room + 次日观察清单,不由执行者自报 |

## 8. 待实现阶段确认的小项(不 block plan)

- `FLYWHEEL_NOTIFY_CHANNEL` 与现 plist 的 `FLYWHEEL_TOKEN_USAGE_CHANNEL` 同值(A2 复用)——迁移后频道定位/命名(重命名为 #flywheel-notify)是 Discord 侧 founder 动作。
- Claude Infra Bot 的 model/effort 档位(belle 用 sonnet/high;infra bot 低频运维,sonnet 档即可,实现时随 fleet 惯例定)。
- 925 的两个 env 是否同步写进 `fleet/example` / SETUP.md 之类模板文档(防新机器复发)——实现时顺手。
