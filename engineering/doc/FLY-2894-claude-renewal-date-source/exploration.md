# FLY-2894 Claude 下次扣费日来源 — 探索
Issue: FLY-2894 (https://linear.app/geoforge3d/issue/FLY-2894/调研-claude-账号下次扣费日从哪里能稳定读到邮件收据-claudeai-网页账单-stripe-门户逐个号实测给出可接进额度页的来源)
日期: 2026-09-25
基于: 无（上游为 FLY-2830 `research.md` §5，在 FLY-2830 分支）

## 1. 问题

额度页 Claude 行的「下次扣费日」一直是「读不到」。founder 9-25 15:30 PDT 要求再调研：到底从哪里能稳定读到这个日期。

## 2. 已经排除的（FLY-2830 research §5，本单不重复）

| 来源 | 为什么排除 |
|---|---|
| OAuth `/api/oauth/profile` | 只有 `subscription_created_at` / `billing_type` / `subscription_status`，没有续费日 |
| OAuth `/api/oauth/usage`（cedar_ember） | `billing_period` 只给 monthly / annual / unknown |
| OAuth 组织接口 `prepaid/*`、`payment_method`、`overage_*` | 没有续费日 |
| Claude Code 2.1.282 程序内接口串 | 没有相关接口 / 字段名 |
| 本机 `.credentials.json`、`oauthAccount` | 只有 `subscriptionCreatedAt` |
| 开通日 + 月周期推算 | founder 禁止，并且有反例 |
| 社区工具 | 只读用量 |
| claude.ai `subscription_details`（cookie） | 有这个字段，但会违反 Anthropic 条款，founder 9-24 已否决 |
| Stripe 收据邮件 | research 表里写「founder 9-24 已否决」，但当时**没有实测** |

## 3. 本单要回答的

对每个 Claude 号（business / personal / school / shopping / personal1）逐一实测：

1. **收据 / 续费邮件**：邮件里有没有下一次扣费日，或者能直接得出它的字段。
2. **claude.ai 网页账单页背后的接口**：返回什么，靠什么凭据，能不能无人值守。
3. **Stripe 客户门户 / Apple / Google 应用内订阅**：哪个号走这些渠道，能不能读。

每个来源要回答四件事：能不能拿到、要什么凭据、稳不稳、能不能定时读。

## 4. 硬约束

- 只读。不改生产配置。
- 不登录，也不在任何表单里输入凭据。遇到要重新登录的地方（Google 密码页、claude.ai 登录）就停下，记为「未实测」。
- 记录里不写 token、卡号、完整邮件正文。邮件只取发件人、主题、日期、金额和周期这几行。

## 5. 初步假设（实测前）

- 收据邮件由 Stripe 生成，通常会写「本期起止」。如果订阅继续有效，本期结束日就是下次扣费日。
- 取消、重订、升级都会让「最后一封收据」过期，所以只看收据不够，还要看取消 / 确认类邮件。
- 这些账号都是 claude.ai 网页订阅（Stripe），不是应用内订阅。要用 `billing_type` 核实。

实测结果和推荐方案见 `research.md` 与 `plan.md`。
