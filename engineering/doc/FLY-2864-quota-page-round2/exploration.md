# FLY-2864 额度页第二轮四条 — 探索
Issue: FLY-2864 (https://linear.app/geoforge3d/issue/FLY-2864/额度页第二轮-founder-看了上线页后的四条删-token-状态列claude-充值卡读出真数据business-档位读成)
日期: 2026-09-24
基于: 无（上游是 FLY-2803 / FLY-2807 已合入的设计与代码）

## 1. founder 点名的四条，以及每条的真实病因

| # | founder 说的 | 现在页面 | 病因（已在本机只读核实） |
|---|---|---|---|
| 1 | 不需要 token 状态 | Codex 表有「token 状态」列，每行「正常」 | 2803 E10 为保列而保留；Claude 表本来就没有这一列 |
| 2 | Claude 充值卡读不出来 | Claude 行「明细未提供」/「0 张」 | 2807 读的是 `prepaid/credits` 的 `tranches`（预付费美元额度），不是「额度重置卡」。真正的卡在 `GET /api/oauth/usage?cedar_ember=1` 的 `cedar_ember.grants[]`，每张带 `resets_left` 和 `ends_at`；而且服务端只对 Claude Code CLI 的 User-Agent 返回（其它 UA 回 `ineligible_reason:"surface"`，旧版本回 `"cli_version"`） |
| 3 | business 是 20x 却读成 5x | 「机器读数 5x / 你说 20x，待你确认」 | 档位读自池内 `.credentials.json` 的 `claudeAiOauth.rateLimitTier`，这是登录那一刻写下的缓存，升档后不会更新（business 文件里仍是 `default_claude_max_5x`）。实时 `GET /api/oauth/profile` 的 `organization.rate_limit_tier` 是 `default_claude_max_20x`。`/api/capacity` 读的是同一份，所以也错 |
| 4 | 要每个号的「下次扣费日」 | 「订阅到期」几乎全是「未知」 | 2803 只有手填入口，生产没有任何手填记录。Codex 有机器来源 `GET chatgpt.com/backend-api/subscriptions?account_id=` 的 `entitlement.renews_at / cancels_at`（6/6 号实测有值）；Claude 唯一带续费日的 `subscription_details` 明确拒绝 OAuth token |

## 2. 约束（issue + Epic 2792 + Lead 裁定）

- 只动这四条；分组、排序、在用号染绿、进度条、5h 列等一律不动。
- 档位修好后仍不参与分组、排序或任何自动决策。
- 不用余额冒充充值卡；不把 20x 写死；Claude 扣费日不推算、不写死。
- Lead 2026-09-24 裁定（question `0114f3f7`）：
  - Codex 用 subscriptions 的真日期；Claude 这一格写「读不到（Anthropic 接口不给）」这类带原因的文字。
  - founder 2026-09-24 已选 A：Claude 扣费日写「读不到」+原因；B（claude.ai 网页 cookie）/ C（读收据邮件）都不做。
  - 档位要在存储/探针层修，`/api/capacity` 和页面都显示 20x，不能只改页面。
  - personal 的池内 token 已被吊销，这一行写「读不到（token 已失效，需重登）」即可，重登不在本单。

## 3. 方案取舍

### 充值卡来源
- **选：** 在已有的 Claude 明细探针里把现有的 `/api/oauth/usage` 调用换成 `?cedar_ember=1&skip_spend=1`，带 `claude-cli/<本机版本> (external, cli)` UA，解析 `cedar_ember`。一次请求同时拿用量状态和卡，不增加请求数。
- **否：** 继续用 `prepaid/credits`（那是美元额度，不是卡，founder 已否决余额类替代）；手填（有机器来源就不手填）。
- 代价：UA 必须声明为 Claude Code CLI，否则服务端不给数据。这是我们自己的 Claude Code 账号、只读 GET，版本号取自本机实际安装的 `claude --version`，不写死。永远不调用领卡的 `POST /api/organizations/{org}/reset_rate_limits`。

### 档位来源
- **选：** 同一个明细探针里本来就在调 `/api/oauth/profile`，把 `organization_type` + `rate_limit_tier` 存进明细 store；容量快照（页面与 `/api/capacity` 共用）优先用这份实时档位，没有时才退回凭据文件缓存。
- **否：** 改写凭据文件（会碰凭据，风险大）；只在页面层改（Lead 明确否决）。

### 下次扣费日
- **Codex 选：** 新增只读 reader 读 `backend-api/subscriptions`，独立小 store，接在 Codex 刷新之后。必须用 `node:https` + 明确 UA；实测 Node 内置 `fetch` 会被 Cloudflare 挑战页 403（`cf-mitigated: challenge`），`node:https` + `flywheel-accounts-page/1` UA 为 200。
- **Claude：** 没有 OAuth 可读的来源 → 「读不到（Anthropic 接口不给）」；已取消的号写「已取消」，手填有日期时写「已取消 · MM/DD 周X 到期」。
- **否：** 按开通日推算（Codex 实例证明锚点会漂：business active_start 08/19，renews_at 10/23）。

## 4. 开放问题

- 「充值卡 = cedar_ember 额度重置卡」是依据 issue 字面「充值卡 / 额度重置卡」、2792 E20「每张卡一行各写到期日」和实测数据（3 个号各 1 张 10/22 到期）的判断；founder HTML 里明确写出来请她确认。旧的 `prepaid tranches`（美元预付额度，目前全是 null/[]）不再显示，数据仍保存在 store 里。
