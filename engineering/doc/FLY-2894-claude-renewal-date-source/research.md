# FLY-2894 Claude 下次扣费日来源 — 调研（逐号实测）
Issue: FLY-2894 (https://linear.app/geoforge3d/issue/FLY-2894/调研-claude-账号下次扣费日从哪里能稳定读到邮件收据-claudeai-网页账单-stripe-门户逐个号实测给出可接进额度页的来源)
日期: 2026-09-25
基于: exploration.md

实测时间：2026-09-25 约 15:15–15:40 PDT。所有操作都是只读的，没有登录，也没有输入凭据。
记录里不含 token、卡号或完整邮件正文。邮件只截取「Paid …」「本期起止」「金额 / 套餐」这几行。

## 1. 账号底表

| 号 | 邮箱 | OAuth profile `billing_type` / `subscription_status` / 套餐（本次只读调用，未刷新 token）|
|---|---|---|
| business | xrliannie.b@gmail.com | `stripe_subscription` / active / Max 20x |
| personal | xrliannie@gmail.com | `stripe_subscription` / active / Max 20x |
| school | xiaorongli2011@u.northwestern.edu | `stripe_subscription` / active / Max 20x |
| shopping | xrliannie.shopping@gmail.com | `stripe_subscription` / active / Max 20x |
| personal1 | xrliannie.1@gmail.com | `none` / canceled / free |

读法：用 `~/.flywheel/claude-profiles/<号>/.credentials.json` 里还没过期的 access token，单次 GET `api.anthropic.com/api/oauth/profile`。
token 快过期的号会直接跳过，不做刷新（刷新会轮换生产正在用的 token）。5 个号的 token 都还有效，都读到了。

**结论**：4 个付费号都是 claude.ai 网页的 Stripe 订阅，**没有 Apple / Google 应用内订阅**。personal1 是免费号，本来就没有扣费日。

## 2. 来源 A：Anthropic 收据邮件

### 2.1 读取通道

| 通道 | 结果 |
|---|---|
| `gog --account <alias> gmail messages search`（personal / school / shopping / business）| **4 个号全部失败**：`oauth2: "invalid_grant" "Bad Request"`。gog 授权时间分别是 03-08 / 03-08 / 04-03 / 08-29。原因没有查实，可能是：OAuth 应用处于 Testing 模式（7 天过期）、用户撤销授权、或改过密码。|
| `gws auth status` | `token_valid: false`，`token_error: "Bad Request"` |
| personal1 | gog 里没有这个号的授权 |
| **浏览器里已登录的 Gmail 网页会话**（只读检索，不登录）| personal（u/0）、business（u/2）、shopping（u/3）可以读。u/1 跳到 Google 密码页，**已停止**（推测是 school，没有核实）|

### 2.2 发件人与邮件种类（3 个可读号一致）

| 发件人 | 主题 | 含义 |
|---|---|---|
| `invoice+statements@mail.anthropic.com`（显示名 Anthropic, PBC）| `Your receipt from Anthropic, PBC #xxxx-xxxx-xxxx` | Stripe 收据。正文有 `Paid <日期>`、本期起止 `<Mon D>–<Mon D>, <YYYY>`、套餐行、金额。附件是 Invoice / Receipt PDF |
| `no-reply-*@mail.anthropic.com` | `Your Claude Max subscription was canceled` | 取消通知 |
| `no-reply-*@mail.anthropic.com` | `Your Max subscription is confirmed` / `Welcome to the Max plan` / `Welcome back to Claude Max` | 开通 / 重订通知 |

### 2.3 逐号记录（近 120 天，按时间排列）

**personal**（xrliannie@gmail.com）
| 日期 (PT) | 邮件 | 本期起止 | 金额 |
|---|---|---|---|
| 06-04 | 收据 | — | — |
| 07-04 | 收据 | — | — |
| 07-31 | 已取消 | | |
| 08-03 | Welcome back to Claude Max | | |
| 08-04 | 收据 | — | — |
| 09-04 | 收据 | **Sep 4–Oct 4, 2026** | $200.00，Max 20x |

→ 按邮件，**下次扣费日是 2026-10-04**。
这里有一个值得注意的现象：07-31 取消、08-03 重订后，扣费日没有变，仍是每月 4 日。可见取消后在本期内重订，周期是接着原来的走的。

**business**（xrliannie.b@gmail.com）
| 日期 (PT) | 邮件 | 本期起止 | 金额 |
|---|---|---|---|
| 06-25 | Welcome to the Max plan + 两张收据 | Jun 25–Jul 25 | $100.00（5x）+ $100.17（升 20x，扣掉 5x 剩余 $99.83）|
| 07-21 | 已取消 | | |
| 08-14 | Max 已确认 + 收据 | Aug 14–Sep 14 | $200.00，20x |
| 09-08 | 已取消 | | |
| 09-16 | Max 已确认 + 两张收据 | **Sep 16–Oct 16, 2026** | $100.00（5x）+ $100.01（升 20x，扣掉 5x 剩余 $99.99）|

→ 按邮件，**下次扣费日是 2026-10-16**（09-16 之后没有取消邮件）。
07-25 和 09-14 这两个日子都**没有收到收据**，因为本期结束前已经取消。之后是新开订阅，锚点跟着换了。

**shopping**（xrliannie.shopping@gmail.com）
| 日期 (PT) | 邮件 | 本期起止 | 金额 |
|---|---|---|---|
| 07-01 | Welcome to the Max plan + 两张收据 | — | — |
| 07-27 | 已取消 | | |
| 08-20 | Max 已确认 ×2 + 两张收据 | Aug 20–Sep 20 | $100.00（5x）+ $100.10（升 20x）|
| 09-20 | 收据 | **Sep 20–Oct 20, 2026** | $200.00，20x |

→ 按邮件，**下次扣费日是 2026-10-20**。

**school**：gog 返回 `invalid_grant`。浏览器 u/1 要求重新输入密码，按约束已停止。**未实测。**

**personal1**：gog 没有授权，浏览器也没有登录。**未实测**，而且是免费号，没有扣费日可读。

### 2.4 评估

| 问题 | 回答 |
|---|---|
| 能不能拿到 | **能，但要推一步**：收据里的「本期结束日」在订阅继续有效时就是下次扣费日。如果最后一封收据之后又收到取消邮件，就表示到期不再续费 |
| 准不准 | personal 已交叉核对：邮件本期结束 Oct 4 = claude.ai 接口 `next_charge_date` 2026-10-04 ✓（1/1）。business 和 shopping 没有接口可以对照，只能说与收据链一致 |
| 要什么凭据 | Gmail 读权限（gog / Gmail API，`gmail.readonly` 就够），每个邮箱各一份。**不碰任何 Claude 凭据** |
| 稳不稳 | 取决于 Google OAuth 授权能活多久。**目前 4 个授权全部失效**，这就是最大的稳定性风险。收据模板要是改版，解析会失败 |
| 能否无人值守 | 能，只要授权有效。Gmail API 是标准后台接口，不依赖浏览器会话 |
| 条款 | 读的是自己的邮箱，不涉及「收集 / 存储 claude.ai 凭据或会话」 |

## 3. 来源 B：claude.ai 网页账单页背后的接口

浏览器（唯一接入的 Chrome）里 claude.ai 已登录的是 **personal**（`/api/account` 返回的 email 为 xrliannie@gmail.com，`billing_type` 为 `stripe_subscription`）。
账单页文字写着「Your subscription will auto renew on Oct 4, 2026」，发票列表是 Sep 4 / Aug 4 / Jul 4，每张 $200。

在同一页里用 `fetch`（同源、带 cookie、只做 GET）逐个探测，结果如下：

| 接口 `/api/organizations/{org}/…` | HTTP | 有用字段 |
|---|---|---|
| `subscription_details` | 200 | **`next_charge_date: "2026-10-04"`，`next_charge_at: "2026-10-04T23:04:03Z"`**，`status: active`，`billing_interval: monthly`，`plan_ending_at: null`，`manual_pause_scheduled_at: null`，`trial_end_ts: null` |
| `payment_method` | 200 | 卡品牌 / 后四位（**未记录**）|
| `invoices` | 403 | — |
| `subscription_status` | 403 | — |
| `stripe/customer_portal` | 404 | — |
| `end_subscription_flow_config` | 404 | — |

其他 4 个号：claude.ai 一次只能登录一个号，要测就得登录，按约束**未实测**。
FLY-2864 已经实测过，同一个接口用 OAuth token 访问会得到 403 `oauth_token_not_accepted`，本单没有重复测。

| 问题 | 回答 |
|---|---|
| 能不能拿到 | **能，而且最准**：直接给出扣费日期和时刻。另有 `plan_ending_at` 字段，从名字看是取消后的到期时间，但 personal 没有取消，所以取消时它会不会有值**没有验证** |
| 要什么凭据 | 每个号一份 claude.ai 浏览器登录 cookie（`sessionKey`）|
| 稳不稳 | 靠网页会话。cookie 多久过期本次没有测。要让程序读，就得保存 5 份 cookie |
| 能否无人值守 | 技术上能，但得保存 cookie。**这正是 Anthropic 条款禁止的**（"may not collect, store, or intermediate Claude.ai credentials or session tokens"），founder 9-24 也已否决 |

## 4. 来源 C：Stripe 客户门户

- Anthropic 没有开放客户门户：`stripe/customer_portal` 返回 404。账单页只有「Update」付款方式按钮，它会进入付款表单，**本次没有点**。
- 如果直接去 `billing.stripe.com` 登录，要走邮箱验证码，这属于登录，**本次没有做**。而且门户属于 Anthropic 的 Stripe 账户，由商户决定开不开。
- 收据邮件里有 Stripe 托管的收据 / 发票链接，内容和邮件相同（付款日 + 本期起止），没有多出「下次扣费」字段。这类链接谁拿到都能打开，本次没有另外去访问。

→ 不是独立来源。它能提供的信息，收据邮件都已经有了。

## 5. 来源 D：Apple / Google 应用内订阅

4 个付费号的 `billing_type` 都是 `stripe_subscription`，personal1 是 `none`。**没有号走应用内订阅**，这个来源不适用。

## 6. 补充核实

- **Claude Code 2.1.283**（今天 14:49 更新的版本）：程序里搜不到 `next_charge*`、`subscription_details`、`renews_at`、`current_period_end`、`billing_cycle*`、`plan_ending_at` 这些字符串。和 2.1.282 一样。
- **「开通日推算」再次被证伪**：`subscription_created_at` 与邮件锚点对不上。

| 号 | `subscription_created_at` | 实际扣费锚点（收据）|
|---|---|---|
| business | 2026-06-25 | 每月 16 日（09-16 重订）|
| personal | 2026-03-31 | 每月 4 日 |
| shopping | 2026-07-01 | 每月 20 日（08-20 重订）|
| school | 2025-06-11 | 未知 |

  可以对照的 3 个号全部对不上，所以开通日不能用来推算扣费日。
- **与 FLY-2830 旧记录不一致**：FLY-2830 founder-design 页写的是「business 开通 8/19、实际 10/23 续费」。今天 business 的 profile 开通日是 06-25，收据周期是 Sep 16–Oct 16。两边对不上，原因没查（可能当时读的不是这个号，也可能把卡到期 10/22 当成了扣费日）。**本单不用那条旧记录下任何结论。**
- 卡上的 `resetGrants.endsAt`（4 个号都是 10-22 16:00Z）是**重置卡到期时间**，不是扣费日，不能拿来顶替。

## 7. 汇总矩阵

| 号 | 收据邮件 | claude.ai `subscription_details` | Stripe 门户 | 应用内 |
|---|---|---|---|---|
| business | ✅ 10-16（Sep 16–Oct 16）| 未实测（没登录）| 不开放 | 不适用 |
| personal | ✅ 10-04（Sep 4–Oct 4）| ✅ 2026-10-04，与邮件一致 | 不开放（404）| 不适用 |
| school | 未实测（gog 失效 + 要密码）| 未实测 | 不开放 | 不适用 |
| shopping | ✅ 10-20（Sep 20–Oct 20）| 未实测 | 不开放 | 不适用 |
| personal1 | 未实测（免费号）| 未实测 | — | 不适用（`billing_type: none`）|

「✅」表示实测读到了。「未实测」都注明了原因。gog 通道 4/4 失效，上表邮件数据全部来自浏览器里已登录的 Gmail 会话，**不是一条可以无人值守的通道**。
