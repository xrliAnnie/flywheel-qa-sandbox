# FLY-696 账号自愈 — Infra Bot Discord 权限清单(给 Annie 勾)

Issue: FLY-696 (https://linear.app/geoforge3d/issue/FLY-696/infraresilience-账号自愈-跨-provider-bot-自动切账号quota-用完时-手动-login-兜底)
日期: 2026-07-03
基于: plan.md

---

## 这份清单是干嘛的

FLY-696 的自动切账号 + 通知本身**不需要新 Discord 权限**(切账号是 Bridge 本地操作,通知复用现成 Flywheel Alerts channel = FLY-368 已有的 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`)。

这份清单是为**之后 iterate 的 Infra Bot**(issue 描述的"两个常驻高权限 Infra Bot,接管所有 infra")提前列一份「有用 + 安全」的 Discord 权限,**由你(Annie)在 Discord server 设置里勾**。原则:**先给能安全做事的最小集,危险的默认不开**。Lead / Runner **不替你改 server 权限**。

> ⚠️ MVP(本 issue)不依赖下面任何权限。这是为 follow-up("Infra Bot 接管 infra")准备的授权菜单,你可以现在勾、也可以等 follow-up 再勾。

## ✅ 建议开(有用 + 低风险)

| 权限 | 用途 | 风险 |
|---|---|---|
| **View Channels** | 看到 Alerts / infra channel 才能读告警 | 极低 |
| **Send Messages** | 发切换/自愈通知、状态回报 | 低(会发消息) |
| **Read Message History** | 读线程上下文、去重、reconcile 恢复态 | 低 |
| **Create Public Threads** | 每个 infra 事件开一条线程(FLY-368 已用) | 低 |
| **Send Messages in Threads** | 在事件线程里贴进展 / ✅ 恢复 | 低 |
| **Manage Threads**(仅归档/改名自己开的线程) | 事件结束归档线程、加状态前缀 | 低-中(能改线程状态,不能删频道) |
| **Add Reactions** | 用 emoji 标状态(🔧/✅/🙋) | 极低 |
| **Embed Links** | 通知里带 hosted 报告链接可预览 | 极低 |

## ⚠️ 慎开(危险,默认不开,除非有明确需求 + 你逐个确认)

| 权限 | 为什么危险 | 建议 |
|---|---|---|
| **Manage Channels**(建/删/改 channel) | 能**删频道**、改频道设置 —— 一次误操作不可逆 | **默认不开**。若真要 Infra Bot 自动"开 channel",单独开**只在指定 category** 生效的受限角色,且删频道能力另议 |
| **Manage Roles / Permissions** | 能改别人权限、给自己提权 | **不开** |
| **Administrator** | 全权,等于把 server 交出去 | **绝不开** |
| **Kick / Ban Members** | 踢人 | **不开** |
| **Manage Webhooks** | 建/删 webhook(可外泄) | **不开** |
| **Mention @everyone / @here** | 可刷屏 @所有人 | **不开**(通知只 @ 你本人,用 `allowed_mentions` 限定) |

## 落地建议

1. **现在**:MVP 不需要动权限 —— 直接用 FLY-368 现成 Alerts channel + bot。
2. **follow-up 起 Infra Bot 时**:给它一个**专用角色**,只勾上面 ✅ 那一组;需要"自动开 channel"时,再单独评估**受限的** Manage Channels(限 category、禁删),不无脑给 Administrator。
3. **需要你在 server 设置做的那一步**(建角色 / 勾权限 / 给 bot 授角色)= 你的动作;Lead 会把要勾的清单(就是上面这张表)给你,不替你改。

## 对照:issue 原话

> **Discord 权限**:Infra Bot 走 Discord API 做操作(开 channel 等)—— **先做能做的**;需要 founder 在 server 设置里授权那步来找 Annie(Lead 不替她改权限)。列一份「有用 + 安全」权限清单给她勾(开 channel OK;删 channel / 改权限这种慎),不无脑拉满。

→ 本清单即此:开 channel 归入"慎"里的**受限**方案(限 category、禁删),改权限/Administrator 明确不开。
