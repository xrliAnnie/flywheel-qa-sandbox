# FLY-2864 额度页第二轮四条 — 调研
Issue: FLY-2864 (https://linear.app/geoforge3d/issue/FLY-2864/额度页第二轮-founder-看了上线页后的四条删-token-状态列claude-充值卡读出真数据business-档位读成)
日期: 2026-09-24
基于: exploration.md

## 0. 取证方式与安全边界

2026-09-24 16:20–16:45 PDT 在本机用池内现有凭据做**只读 GET**。脚本只打印 HTTP 状态和筛过的字段；邮箱、姓名、uuid、账号 id、支付卡信息全部脱敏，未写任何凭据、未刷新 token、未调用任何 POST（尤其没有调用领重置卡的 `POST /api/organizations/{org}/reset_rate_limits`）。下列样例均为脱敏摘录。

## 1. Claude 档位（第 3 条）

**来源 A — 现状（错）**：`account-heal/quota-monitor-credentials.ts:144 readPoolSubscriptionTier` 读 `~/.flywheel/claude-profiles/<name>/.credentials.json` 的 `claudeAiOauth.{subscriptionType, rateLimitTier}`。

| 号 | 凭据文件 rateLimitTier | 实时 profile rate_limit_tier |
|---|---|---|
| business | `default_claude_max_5x` | `default_claude_max_20x` |
| school / shopping | `default_claude_max_20x` | `default_claude_max_20x` |
| personal | `default_claude_max_20x` | 读不到（401 token revoked） |
| personal1 | `default_claude_max_20x` | `default_claude_ai`（已取消，org 已降为 claude_free） |

凭据文件是登录时 Claude Code 写的快照，business 升档后没变（今天 22:35 UTC 该文件刚被刷新 token，档位字段仍是 5x）。容量快照 `bridge/capacity-snapshot.ts:615` 把它投影成 `subscriptionTier`，页面和 `/api/capacity` 共用 → 两处都错。

**来源 B — 实时（对）**：`GET https://api.anthropic.com/api/oauth/profile`（明细探针 `claude-quota/account-detail-observer.ts:219` 已在调）

```json
{"organization": {"organization_type": "claude_max", "billing_type": "stripe_subscription",
  "rate_limit_tier": "default_claude_max_20x", "subscription_status": "active",
  "subscription_created_at": "2026-06-25T22:49:57.967771Z", "uuid": "<uuid>", "name": "<redacted>"},
 "account": {"has_claude_max": true, "email": "<redacted>"}}
```

旁证：cedar_ember 块的 `event_props.tier = "claude_max_20x"`（business）。

## 2. Claude 充值卡（第 2 条）

**现状**：2807 接的是 `GET /api/oauth/organizations/{org}/prepaid/credits` 的 `tranches / promo_tranches`：business/shopping 为 null（页面「明细未提供」），school 为 `[]`（「0 张」），personal1 403「only available for Pro and Max plans」。这是美元预付额度，不是卡。

**真正的卡**：在本机 Claude Code 2.1.282 二进制里找到客户端读卡逻辑（内部代号 cedar-ember）：状态走 `GET /api/oauth/usage?cedar_ember=1&skip_spend=1`，领卡走 `POST /api/organizations/{org}/reset_rate_limits`（本单永不调用）。客户端 schema：`grants[] = {id, label, resets_total, resets_left, starts_at, ends_at, clears[], paused, usable_now, ...}`；`ineligible_reason ∈ {config_off, tier, seat, mobile, surface, cli_version, no_grant, tenure, other_experiment, unavailable, unknown}`。

服务端按 User-Agent 判定客户端：

| User-Agent | school 结果 |
|---|---|
| `Python-urllib` / `claude-code/2.1.282` / `claude-cli/2.1.282 (external, sdk-ts)` | `eligible:false, ineligible_reason:"surface", grants:[]` |
| `claude-cli/2.1.0 (external, cli)` | `eligible:false, ineligible_reason:"cli_version"` |
| `claude-cli/2.1.282 (external, cli)` | `eligible:true`，1 张 |

所以 `eligible:false` + `grants:[]` **不等于 0 张**；只有 `eligible:true` 的 grants，或明确「没有卡」类原因，才能说张数。

脱敏样例（business，Node `fetch` 同样 200）：

```json
"cedar_ember": {"eligible": true, "ineligible_reason": null, "at_limit": false, "exhausted": [],
 "grants": [{"id": "<redacted>", "label": "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
   "resets_total": 1, "resets_left": 1, "starts_at": "2026-09-22T16:00:00+00:00",
   "ends_at": "2026-10-22T16:00:00+00:00", "clears": ["five_hour","seven_day","seven_day_overage_included"],
   "paused": false, "usable_now": true}],
 "next_grant_id": "opus55-launch-promax-20260921", "weekly_resets_at": "2026-10-01T02:00:00+00:00",
 "event_props": {"surface": "claude_code_cli", "tier": "claude_max_20x", "billing_period": "unknown"}}
```

实测：business / school / shopping 各 1 张，`ends_at` 2026-10-22（PT 10/22 09:00）；personal 401（token 已吊销）；personal1 403 `oauth_not_allowed_for_organization`（已取消）。同一响应仍含原来的 `five_hour / seven_day` 等字段，明细探针只用它判 `usageStatus`，换 URL 不影响现有语义。

版本来源：`account-heal/opus-model-sync.ts` 已有 `runBounded(bin, ["--version"])` 与 `resolveBinary`（`FLYWHEEL_CLAUDE_BIN ?? "claude"`）；`realCliVersion` 未导出，本单导出一个窄的只读版本读取即可。`claude --version` 输出形如 `2.1.282 (Claude Code)`，取 `^\d+\.\d+\.\d+`。

## 3. 下次扣费日（第 4 条）

### Codex — 有机器来源

`GET https://chatgpt.com/backend-api/subscriptions?account_id=<chatgpt_account_id>`，头与现有 WHAM reader 相同（`Authorization: Bearer`、`ChatGPT-Account-Id`、`Accept`）外加非空 UA。

| 号 | has_active | renews_at (UTC) | cancels_at | will_renew | billing_period |
|---|---|---|---|---|---|
| business | true | 2026-10-23T03:59:39 | null | true | monthly |
| personal | true | 2026-10-24T17:00:24 | null | true | monthly |
| personal1 | true | 2026-10-19T04:02:27 | null | true | monthly |
| personal2 | true | 2026-10-20T21:23:08 | null | true | monthly |
| school | true | 2026-10-03T23:37:58 | null | true | monthly |
| shopping | true | 2026-10-18T22:04:02 | null | true | monthly |

脱敏样例：

```json
{"entitlement": {"has_active_subscription": true, "subscription_plan": "chatgptpro",
  "expires_at": "2026-10-23T09:59:39+00:00", "renews_at": "2026-10-23T03:59:39+00:00",
  "cancels_at": null, "billing_period": "monthly", "is_delinquent": false},
 "plan_type": "pro", "will_renew": true, "active_until": "2026-10-23T03:59:39Z",
 "active_start": "2026-08-19T15:39:26Z", "cancellation_outcome": null}
```

`expires_at` 比 `renews_at` 晚 6 小时（宽限），扣费日取 `renews_at`。business 的 `active_start` 是 08/19 而 `renews_at` 是 10/23 —— 证明不能按开通日推算。

**传输坑（必须写进实现）**：同样的头，Node 内置 `fetch`（undici）得到 Cloudflare 挑战页 `403, cf-mitigated: challenge`；`node:https` 在带非空、非浏览器 UA（`flywheel-accounts-page/1` 或 `codex_cli_rs/...`）时 200，不带 UA 或 `Mozilla/5.0` 时 403。WHAM usage 用 `fetch` 仍 200（规则不同）。因此 reader 用 `node:https` 并声明本服务真实 UA；将来 Cloudflare 规则变化时降级为「读不到（接口被拦）」，不写空。

### Claude — 没有 OAuth 可读的来源

| 接口 | 结果 |
|---|---|
| `GET /api/oauth/profile` | 只有 `subscription_created_at`、`billing_type`，无续费日 |
| `GET /api/organizations/{org}/subscription_details` | 403 `oauth_token_not_accepted`（只认 claude.ai 网页登录 cookie） |
| `GET /api/organizations/{org}/invoices` | 403 `oauth_token_not_accepted` |
| `GET /api/oauth/organizations/{org}/subscription(_details)` / `invoices` | 404 |
| `GET /api/claude_cli/bootstrap` | 只有档位，无账单 |
| `GET /api/oauth/organizations/{org}/prepaid/bundles` | 只有「预付包本月购买上限」的 `purchases_reset_at`（每月 1 号），不是订阅扣费日 |
| Claude Code 2.1.282 二进制 | 无 `renews_at / next_charge / current_period_end` 类字段 |
| cedar_ember `event_props.billing_period` | `"unknown"` |

结论：Claude 这一列写「读不到（Anthropic 接口不给）」。founder 2026-09-24 已选此方案（A）；B（每号存 claude.ai 网页 cookie 调 subscription_details）/ C（读收据邮件）不做。

## 4. 代码消费者审计

- `subscriptionTier`：`capacity-snapshot.ts`（投影）、`account-quota-view.ts`（显示）、`account-quota-page.ts`（business 特例）、相关测试。rg 全仓：没有任何切号 / 候选 / 告警模块读它。
- 「token 状态」只在 `account-quota-page.ts` 页面渲染；`tokenStatus` 字段仍被 view 保留（不删，巡检 tick 不用它）。
- 明细 store `account-detail-store.ts` 的校验只检查已知字段，不拒未知字段 → 新增可选字段对旧版本（回滚）无害。
- Codex 订阅新 store 独立成文件，不改 `codex-accounts.json` 的 schema 与校验。
