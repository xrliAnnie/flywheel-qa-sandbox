# FLY-2897 Claude 扣费日读收据 — 探索
Issue: FLY-2897 (https://linear.app/geoforge3d/issue/FLY-2897/额度页claude-扣费日-定时读各号-gmail-里-anthropic-的-stripe-收据-额度页显示下次扣费日取消邮件则显示已取消)
日期: 2026-09-25
基于: 无（上游为 FLY-2894 `research.md` / `plan.md`，在 FLY-2894 分支 PR #1335）

## 1. 要解决什么

额度页 Claude 行的「下次扣费日」现在一律显示「读不到（Anthropic 接口不给）」（`account-quota-view.ts` `claudeNextChargeCell`）。
FLY-2894 调研结论：Anthropic 扣费后发到各号邮箱的 Stripe 收据里的「本期结束日」就是下次扣费日；
之后如果收到取消邮件、且没有再收到确认/重订邮件，就是「已取消，本期结束日到期」。
founder 9-25 16:14 PDT 同意程序定时读这几个邮箱里 Anthropic 的收据邮件（只取发件人、主题、日期、金额、计费周期），并已本人给 gog 重新授权。

## 2. 现状（代码）

| 位置 | 现状 |
|---|---|
| `bridge/account-quota-view.ts` `claudeNextChargeCell` | 只认两种：founder 手填的取消确认、OAuth profile 的 `subscription=canceled`；其余「读不到（Anthropic 接口不给）」|
| `bridge/account-quota-page.ts`（FLY-2830 分支）| 每格有「切号后尚未刷新」标记，Claude 的 `nextCharge` 格映射到 `detail` 数据源；身份格显示「用量读于 · 卡读于」|
| `bridge/switch-refresh-trigger.ts`（FLY-2830 分支）| 任一 vendor 切号 → 两条腿：quota-monitor 全量扫 Claude + Bridge 重读 Codex/Claude 卡 |
| `codex-quota/reading-scheduler.ts` | 搭 GatePoller tick 的定时模式（不新开 timer）|
| `claude-quota/account-detail-store.ts` | Claude 明细存储：`~/.flywheel/claude-quota/account-details.json`，含 `tier.subscriptionType`（personal1 = `free`）|
| `~/.flywheel/claude-accounts.json` | 每个号的 `identity.email`（即要读的邮箱）|

FLY-2830（PR #1330）尚未合并。本单依赖它的切号刷新和「读于 / 切号标记」展示，按 Lead 裁定叠在 `origin/flywheel-FLY-2830` 上做，PR base 仍是 main，合并顺序 #1330 → 本单。

## 3. 要回答的问题

1. gog 的输出长什么样、失败时怎么区分「未授权 / invalid_grant / 其他」？
2. 真实收据正文里「付款日 / 本期起止 / 金额」的确切写法？
3. 取消 / 确认 / 重订邮件的发件人与主题的确切写法？
4. 放在哪个进程、怎么接每天一次 + 切号刷新？
5. 页面怎么显示，才能和 FLY-2830 的「读于 / 切号标记」一致？

实测与答案见 `research.md`，方案见 `plan.md`。

## 4. 硬约束（来自 issue 与 founder）

- 只检索 Anthropic 的收据 / 取消 / 确认邮件（精确发件人 + 主题过滤），不读无关邮件。
- 不存邮件正文；落盘和日志只有字段（日期、金额、周期、状态码）。
- 读不到就写真实原因（未授权 / invalid_grant / 没找到收据 / 格式没认出 …），不猜。
- 本机只跑相关测试。
