# FLY-871 Codex Infra Bot — C6 部署 runbook

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-04(§5.5/§5.6/§7 windowed bring-up 增补 2026-07-06)
基于: plan.md §C6 + §12 W1/W2/W3 + lead-instruction dedef290(权限 + 头像)

> **前置**:整套 R2/R3 在 `FLYWHEEL_ACCOUNT_SELF_HEAL` 翻开前**全程休眠**。本 runbook
> 的步骤只在 Annie 拍板的 **enable window** 执行(真机 QA §8 全绿后)。仓库里已交付的
> 代码物料:launcher `run-codex-infra-bot-tui.sh`、plist 模板
> `templates/com.flywheel.lead.flywheel-codex-infra-bot-lead.tui.plist`、persona
> `.lead/codex-infra-bot-lead/identity.md`。

## 1. Discord bot(Annie 建)+ 权限角色(dedef290 已批)

1. 在 Discord Developer Portal 新建应用 **Codex Infra Bot**,拿到 bot token + bot user id。
2. 建一个**可复用的 `infra-bot` 角色**(两个 infra bot —— Codex 现在、将来的 Claude ——
   都挂它),按 dedef290 **只**勾:
   - **Manage Channels** + **Manage Threads** + **Manage Webhooks**
   - 基础套装:Send Messages / Embed Links / Attach Files / Add Reactions / Read Message History
   - **明确不给**:Manage Roles / Manage Server / Administrator。
   (对照 696 `engineering/doc/FLY-696-account-self-heal/discord-permissions.md` 的 ✅ 组。)
3. 建私有频道 **#codex-infra-bot**(Annie 直接指挥/调试用),把 bot 加进去 + 加进 **Alerts** 频道。

## 2. 头像(dedef290)

Codex Infra Bot 用 OpenAI/Codex 官方 logo(内部用,Annie 确认无版权顾虑;将来的 Claude
Infra Bot 用 Claude/Anthropic logo)。用 bot 自己的 token 经 API 设:

```bash
# avatar.png = 官方 logo(≤256KB);base64 内联进 data URI。
IMG_B64=$(base64 -i avatar.png)
curl -sS -X PATCH https://discord.com/api/v10/users/@me \
  -H "Authorization: Bot ${CODEX_INFRA_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"avatar\":\"data:image/png;base64,${IMG_B64}\"}"
```

## 3. `~/.flywheel/.env`(token + id,不进 plist —— FLY-250 纪律)

```sh
export CODEX_INFRA_BOT_TOKEN="<bot token>"
export FLYWHEEL_INFRA_BOT_USER_ID="<bot user id>"          # assignment 帖 mention 用(见 §6)
export FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID="<#codex-infra-bot 频道 id>"
# FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID 已存在(Alerts 频道)。
```

## 4. `~/.flywheel/projects.json` —— flywheel 项目下加 infra bot lead 条目

在 `flywheel` 项目的 `roles.leads`(或等价 lead 列表)加(字段对齐 Mufasa 的 codex lead 条目):

```jsonc
{
  "agentId": "codex-infra-bot-lead",
  "chatChannel": "<#codex-infra-bot 频道 id>",
  "botTokenEnv": "CODEX_INFRA_BOT_TOKEN",
  "alertChannel": "<Alerts 频道 id — 同 FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID>",  // ← 必填,见下
  "backend": "codex-app-server",     // windowed TUI 由 launcher/plist 决定(FLY-398)
  "codexProfile": "full-access",
  "canSpawnRunners": false,          // infra bot 不开 runner
  "department": "infra"
}
```
> **`alertChannel` 必填(W2 依赖)**:W2 的 `tui_window_lost` 经 `scripts/lead-alert.sh`
> 发,而 `lead-alert.sh` **只从 projects.json 的 `alertChannel`**(缺省再退 `generalChannel`,
> 需 `alertFallbackToCore:true`)解析目标频道 —— **不读** launcher 的
> `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`。漏 `alertChannel` = 告警 dead-letter
> `reason=no-channel`(静默丢)。token 缺 `alertBotTokenEnv` 时自动退回 `botTokenEnv`
> (= `CODEX_INFRA_BOT_TOKEN`),无需单列。
> cross-dept(Alerts)的**入站**唤醒(assignment @)仍走 launcher 的
> `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`(= `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`),同 Mufasa
> —— 那条 env 管**收**,`alertChannel` 管 lead-alert.sh 的**发**,两者都要。

## 5. Wrapper + launchd 收编

1. 建 wrapper `~/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh`(同 Mufasa 款:
   `source ~/.flywheel/.env` 拿 token/id → exec 主 dist 的 `run-codex-infra-bot-tui.sh`)。
2. 装 plist:copy 模板到 `~/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist`
   → `launchctl bootstrap gui/$UID <plist>`(KeepAlive 1s 自起)。
3. 隔离 `CODEX_HOME=~/.codex-infra-bot`(独立 Codex 账号 auth,与 Claude 账号体系无关)。
4. ship 纪律遵循 `doc/engineer/implementation/companion-lead-ship-discipline.md`。

> **W2 自动接线(无需手动步骤)**:launcher `run-codex-infra-bot-tui.sh` 已 export
> `FLYWHEEL_ROOT`(让 dist runtime 定位 `scripts/lead-alert.sh`)+ `FLYWHEEL_TUI_WINDOW_ALERT=1`
> —— 「静默无 pane」守卫因此**只对本 bot 开**(共享 TUI runtime 默认 OFF,其它 Lead 字节
> 兼容)。窗连续 ~3 分钟建不起来/建了即死 → 经 lead-alert.sh 往 Alerts 发**一条**
> `tui_window_lost`(episode-latch,恢复后新 episode 可再报)。

## 5.5 逐层验证(W1 bring-up 证据门 —— 装完 plist **必跑**)

`bootstrap` 之后,`~30s` 让 daemon+窗起来,然后跑只读探针脚本(它**不** bootstrap、不开窗、
不杀进程,可反复跑):

```bash
packages/teamlead/scripts/verify-windowed-lead.sh flywheel codex-infra-bot-lead \
  --codex-home ~/.codex-infra-bot \
  --log /tmp/flywheel-lead-flywheel-codex-infra-bot-lead.log   # --log 可选,只进诊断层
                                                               # 路径 = plist 的 Standard{Out,Error}Path
```

逐层期望(退出码 0 = 1–5 层全绿;非零 = `10 + 第一个失败层`):

| 层 | 校验 | 期望 |
|---|---|---|
| 1 | launchd job loaded 且 running | `layer 1 PASS … running (pid N)` |
| 2 | 该 pid 是 TUI runtime(`node …/codex-lead-tui-runtime.js`) | `layer 2 PASS …`(**绝不**按 launcher 路径判,argv 已被 `exec node` 替换) |
| 3 | daemon socket `~/.codex-infra-bot/app-server-control/app-server-control.sock` | `layer 3 PASS` |
| 4 | tmux 窗 `flywheel-codex-infra-bot-lead` 活(identity-echo) | `layer 4 PASS` |
| 5 | pane 真跑 codex(非裸 zsh/bash 壳) | `layer 5 PASS` |
| 6 | 诊断层,**不计退出码** | 打 launchd log 尾部;「无近期 real-TUI-up 行」**不是失败**(健康 20s liveness 不打绿 tick) |

失败层直接指向问题链节:1 失败=job 没起(bootstrap 漏了?);2=进程不是 runtime;3=daemon
sock 没就绪(可能窗先于 sock 起,见 §7 note);4=窗死/被 stale-kill;5=TUI 掉成壳。

**最后一层人眼确认**:在 cmux 里看到名为 `flywheel-codex-infra-bot-lead` 的 tab 真出现
(Annie 目视或截图)—— 消灭「装了但没人证明看得见」。

## 5.6 post-bootout / reboot 恢复纪律

- `bootout` **不跨 login 持久**,但也**不会自己回来**:本次 login 之后被 bootout 的 job,要等
  **下次 login** 才被 `RunAtLoad` 兜回(Mufasa Jun-29 事故正是这个缺口 —— 被 bootout 后无人
  bootstrap、无巡检发现)。
- 恢复动作:`launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist`
  → 再跑 §5.5 `verify-windowed-lead.sh` 全绿。
- **巡检信号**:窗连续建不起来时,W2 守卫会在 Alerts 发 `tui_window_lost`;若整个 bot job 不在
  launchd 里(bootout 后没回来),W2 守卫也随之缺席 —— 此时的可见信号是**每日摘要缺席**
  (§C7b),需人工 `launchctl print` 复核 job 是否 loaded。
  (Mufasa 自身的具体恢复归 task-114 执行,本 runbook 只落通用纪律。)

## 6. CODE 接线(R2/R3 已落地;enable 前必须在)

- **W6 assignment 帖 mention**(✅ 已接):cap 触发的 pending switch 的 Alerts 帖显式带
  `mentionUserId=FLYWHEEL_INFRA_BOT_USER_ID`(否则 mention-gate 唤不醒 bot);env 未设 =
  现状帖子,byte-compat。落点 = `AlertChannelHub.handle` 的 "attempted" 分支,仅当
  `repair.action === "account_switch"` 且 env 是合法 snowflake 才 ping。
- **W3 rescue 触发口**(✅ 已接):bot 接到 assignment 后,用本机 CLI 或直调 endpoint 触发救援 ——
  - **lead 救援**:`flywheel-rescue-lead --project <p> --lead <id> [--alert-id <a>]`
    (env `BRIDGE_URL` + `TEAMLEAD_API_TOKEN` 已在 Lead pane;exit 0=已救 / 1=未救(无未决
    alert 或已恢复)/ 2=用法 / 3=传输)。
  - **底层 endpoint**:`POST /api/rescue`(Bearer,非 `/actions`) body
    `{route:"lead"|"runner", projectName?, leadId?, executionId?, alertId?}`。self-heal off ⇒
    409 needs_human(byte-compat)。runner 救援(close+resumed-successor)也走这个口。
  - 结构护栏在 Bridge 侧:只对**仍未决且 CONFIRMED** 的 `login_expired`/`runner_login_expired`
    alert 动手;runner 侧动手前**重 capture pane + classifyDetection 复验**(Lead ②),
    recovered/suspicious 不救只报;restart-in-place;证据先贴 Alerts;一次重试后 @Annie。
- **W5 换号后 sweep**(✅ 已接):账号切换成功(route + watchdog 两条路)→ `postSwitchRescueSweep`
  把 incident-window 内所有卡登录的 session 逐个救(Annie 4945ebf9)。
- **C7 看的行为**:bot persona 已定义(identity.md);每日摘要读 account-ledger +
  `claude-accounts.json`(C7 summary builder)。

## 7. Enable 序(§8 QA 全绿 + Annie 拍板后)

1. 确认 pool 4 账号 capture 新鲜。
2. 装 launchd 起 bot → **跑 §5.5 `verify-windowed-lead.sh` 逐层全绿 + cmux 目视 tab**(bring-up
   证据门,W4)→ 验 bot 在 #codex-infra-bot / Alerts 出摘要、能被 @ 唤醒。
   - **R-10.4-4 待复证(bring-up 时观察)**:若窗**先于** daemon sock 起 → 可能短暂 dead-pane
     循环;runtime 的 20s liveness probe 应自愈(重建窗)。若观察到**持续**循环(非短暂),
     不硬等 —— W2 守卫会在 ~3 分钟后发 `tui_window_lost`,按告警排查(sock 时序 / codex 二进制
     版本漂移,见 §12 风险)。健康态下 verify 脚本 3 层(sock)与 4/5 层(窗/pane)应同时绿。
3. 设 `FLYWHEEL_ACCOUNT_SELF_HEAL=1`(+ `FLYWHEEL_CLAUDE_PROFILE_BIN`)→ **重启 Bridge**
   (config/env 在 boot 时读 —— 攒批纪律;补装 config 后必再重启一次,LEARN-20 教训)。
4. 注入一次演练确认(cap → assignment → claim → 切;login_expired → 救)→ Annie 验收。
5. `FLYWHEEL_ACCOUNT_KEEPFRESH` 保持 off(C4b,R1 fast-follow FLY-875,R3 上线后才启用)。

## C6 自身失联兜底(C7b)

- launchd KeepAlive 拉起(bot 进程死 → 1s 重启,thread 记忆经 state dir 延续)。
- bot 以 lead 注册 + TUI pane 在 cmux → LeadWatchdog 30s 扫描天然覆盖(frozen/crash/auth
  分类照常在 Alerts 告警,Annie 与别的 Lead 都看得到)。
- 功能兜底不依赖 bot:切换有 watchdog deadline 兜底(bot 死照样切);每日摘要缺席本身是可见信号。
- 交叉互看终态:将来 Claude Infra Bot 反向监控 Codex Infra Bot(696 完整形态,follow-up)。

## C6.1 Bridge 外部心跳探针(FLY-1082,随本 bot 的 launchd 域部署)

2026-07-09 事故的静默洞:检测面全活在 Bridge 进程里,Bridge 自己死了整个平面一起死。
「死了且没活过来」由本 bot 侧的**确定性探针脚本**兜住(不是 LLM loop —— 心跳不能指望
对话循环记得做):

- 脚本:`scripts/bridge-liveness-probe.sh`(每分钟 curl Bridge `/health`;连续 down
  ≥ `FLYWHEEL_BRIDGE_DOWN_ESCALATE_MIN`(默认 5)分钟 → 用本 bot 的 token Discord
  直发 @Annie;恢复后单发一条解除;每个 down episode 只 page 一次,状态文件
  `~/.flywheel/state/bridge-liveness-probe.json` 防重复)。
- plist 模板:`scripts/launchd/com.flywheel.bridge-liveness-probe.plist`
  (StartInterval 60s;token 经 wrapper source `~/.flywheel/.env`,绝不进 plist)。
- 安装(enable 窗,与 §7 同批):模板头部注释里有逐步命令(拷进
  `~/Library/LaunchAgents/`、核对 EnvironmentVariables、bootstrap 进 gui 域)。
- 验证:对隔离 QA bridge 注入宕机(或临时把 BRIDGE_URL 指向空端口)→ 等 N 分钟 →
  Alerts 见 @Annie page;恢复 → 见解除消息。见 FLY-1082 QA 注入矩阵。
- 判据出处:PRD §4.3 进程外兜底(「Bridge 自身死亡的检测腿不得塞回 Bridge 进程内」)。
