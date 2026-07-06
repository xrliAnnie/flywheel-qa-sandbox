# FLY-871 Codex Infra Bot — C6 部署 runbook

Issue: FLY-871 (https://linear.app/geoforge3d/issue/FLY-871/infraresilience-codex-救援-bot-账号体系外的看切救696-交叉自愈架构的-codex-半边token)
日期: 2026-07-04
基于: plan.md §C6 + lead-instruction dedef290(权限 + 头像)

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
  "backend": "codex-app-server",     // windowed TUI 由 launcher/plist 决定(FLY-398)
  "codexProfile": "full-access",
  "canSpawnRunners": false,          // infra bot 不开 runner
  "department": "infra"
}
```
> cross-dept(Alerts)频道**不在** projects.json —— 它是 launcher 的 env
> `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`(= `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`),同 Mufasa。

## 5. Wrapper + launchd 收编

1. 建 wrapper `~/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh`(同 Mufasa 款:
   `source ~/.flywheel/.env` 拿 token/id → exec 主 dist 的 `run-codex-infra-bot-tui.sh`)。
2. 装 plist:copy 模板到 `~/Library/LaunchAgents/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist`
   → `launchctl bootstrap gui/$UID <plist>`(KeepAlive 1s 自起)。
3. 隔离 `CODEX_HOME=~/.codex-infra-bot`(独立 Codex 账号 auth,与 Claude 账号体系无关)。
4. ship 纪律遵循 `doc/engineer/implementation/companion-lead-ship-discipline.md`。

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
2. 装 launchd 起 bot → 验 bot 在 #codex-infra-bot / Alerts 出摘要、能被 @ 唤醒。
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
