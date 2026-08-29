# FLY-929 Enable 运维窗 Runbook — 启用 Claude 额度自动切换 + 通知迁移

Issue: FLY-929 (https://linear.app/geoforge3d/issue/FLY-929/profile-自动切换-通知迁移-claude-infra-bot-fly-915)
日期: 2026-07-07
基于: plan.md §6

> 本 runbook 是 **founder-gated 运维窗**的执行清单 —— 在 FLY-929 代码 merge 之后、独立于 PR ship 单独执行。
> merge 本身是 **dormant**:所有新行为挂在 env 之下,不设 env = 逐字现状。

## 激活谓词(两个,缺一即 dormant)

| 谓词 | env | 控制面 |
|---|---|---|
| **P-identity** | `CLAUDE_INFRA_BOT_TOKEN` **且** `FLYWHEEL_NOTIFY_CHANNEL` 同时存在 | W3b 通知迁移(reports/restart/standup sender)+ W6 digest + A5 owner mention(还需 self-heal on + `FLYWHEEL_INFRA_BOT_USER_ID`) |
| **P-expect** | `FLYWHEEL_NOTIFY_DIGEST_EXPECT=1` | 自我健康检查(回执写入 + 期望检查 + token-usage-daily fail-loud) |

只设 token(FLY-928 可能先写入)或只设 channel 都 = dormant。`FLYWHEEL_NOTIFY_CHANNEL` **只在本窗写入**,是 W3b 的实际开关。

## 步 0 · 前置(全部确认后才开窗)

- [ ] FLY-925 merged(`FLYWHEEL_BRIDGE_URL` / `STANDUP_PROJECT_NAME` 已补)
- [ ] FLY-928 W5 done(Claude Infra Bot 存在,token 到手,已被邀进 server)
- [ ] FLY-928 W4 done(Codex Infra Bot launchd 已装 —— 失败工单有人 ARC)
- [ ] 本 PR merged + 生产 `git pull` + `pnpm -r build`

## 步 1 · provision 账号池(Annie 在场)

逐 Claude 账号:浏览器登录 → `flywheel-claude-profile capture <name>`。
核对:`flywheel-claude-profile status`(池 + 活跃账号)。

## 步 2 · 写 env(**编辑在重启之前** —— launchd KeepAlive 教训,FLY-193)

`~/.flywheel/.env` 加:

```bash
FLYWHEEL_ACCOUNT_SELF_HEAL=1
FLYWHEEL_CLAUDE_PROFILE_BIN=<repo>/packages/claude-runner/bin/flywheel-claude-profile
CLAUDE_INFRA_BOT_TOKEN=<928 W5 产出;如已写则核对>
FLYWHEEL_NOTIFY_CHANNEL=1521630422918758472
FLYWHEEL_NOTIFY_DIGEST_EXPECT=1
```

已有(核对不改):`FLYWHEEL_INFRA_BOT_USER_ID=1523219324561522831`、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`、`TOKEN_USAGE_TIMEZONE`(未设 = America/Los_Angeles)。

## 步 3 · 重启 Bridge

按 batch 惯例(与其他待 ship PR 攒一次重启;协调其他 agent,勿在 QA hot-deploy 窗内)。

## 步 4 · verify 探活(fail-loud,不静默)

以 Claude Infra Bot 身份向三个频道各发一条探活消息:

```bash
for ch in "$FLYWHEEL_NOTIFY_CHANNEL" "$FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID" "$STANDUP_CHANNEL"; do
  curl -sf -X POST "https://discord.com/api/v10/channels/${ch}/messages" \
    -H "Authorization: Bot ${CLAUDE_INFRA_BOT_TOKEN}" -H "Content-Type: application/json" \
    -d '{"content":"🔧 FLY-929 enable 窗探活(可删)"}' || echo "FAIL: channel $ch — 回 FLY-928 invite 清单补权限"
done
```

任一失败 = bot 对该频道无发言权限 → 回 FLY-928 invite/权限清单补齐后重试。

## 步 5 · FLY-696 §8 真机 QA(独立 QA runner + Annie 红线确认)

执行 FLY-696 §8 清单 M1 项(1-13、16),红线:

- [ ] **绝不弄坏 claude 登录**(Keychain fail-closed + verify-before-commit)
- [ ] 注入 5h cap → 真切换 + Keychain verify + 登录不坏
- [ ] 529 瞬时 → **不**切
- [ ] 双触发幂等(CAS 只切一次)
- [ ] 全封顶 → alerts 工单 + `<@FLYWHEEL_INFRA_BOT_USER_ID>` owner mention(**无**立即 founder 升级)
- [ ] 成功 → #flywheel-notify 收到 digest(🟡,不 @)且 alerts 处理记录不变

## 步 6 · 注入演练(端到端一次)

模拟封顶 → 观察:静默切换 → notify digest → 新 session 用新账号(当前卡住 session 等 reset,v1 不搬 —— D2 已知边界)。

## 步 7 · Annie GO → 观察期

首个自然日核对:

- [ ] 00:30 token report 由 Claude Infra Bot 发出(消息作者 = infra bot)
- [ ] `~/.flywheel/notify-receipts.json` 回执落盘(date = 报告日)
- [ ] 01:00 后 Bridge expect tick 安静(无 `notify_digest_failed` 告警)
- [ ] standup 消息作者 = Claude Infra Bot 且 Simba 侧仍触发 triage(FLY-71 语义)

## 回滚

任一步失败 → 从 `~/.flywheel/.env` 移除 `FLYWHEEL_ACCOUNT_SELF_HEAL`(或全部新 env)→ 重启 Bridge = 逐字回到现状。
Keychain 侧 fail-closed + verify-before-commit 保证登录不被写坏(FLY-696 红线机制)。

## 已知边界(v1,follow-up)

- 卡住的 session 不自动搬账号(D2,Annie 已定)。
- T2 判定 / 工单状态机 / 发送方门禁 = FLY-927;`flywheel-bridge-wrapper.sh` 的死机 🚨 留给 927 统一治。
